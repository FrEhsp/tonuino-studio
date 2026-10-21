//! HTTPS for the list of "Entdecken" (cargo feature "quellen", on by default).
//!
//! The desktop app builds the list on the user's computer with the same
//! code as the daily job (src/core/sources/collect.ts), at most once a day.
//! The WebView cannot read the broadcasters' feeds or the pages of series
//! without a feed (no CORS), so it asks here. Only GET, only https on port 443, only the
//! hosts in ALLOWED_HOSTS (never an address in the local network), at most
//! MAX_BODY bytes and TIMEOUT per request, a fixed User-Agent, and no
//! redirects: a redirect comes back to the caller, which asks again for the
//! new address (and this allowlist decides again).
//!
//! The same way loads the files of a source whose terms allow saving but
//! whose server sends no CORS header (OHRKA, on a host of this list), in
//! pieces: the caller asks for one byte range at a time (rangedFetch in
//! src/core/sources/download.ts), each below MAX_BODY.
//!
//! The built list is kept in one file in the app's local data folder
//! (sources_cache_read, sources_cache_write).
//!
//! Commands: sources_fetch, sources_cache_read, sources_cache_write.

use crate::error::{blocking, CmdError, CmdResult};
use crate::framing::frame;
use crate::http::{build_request_for, connect, is_local_address, net_error, parse_response_limited, resolve, DeadlineStream, HttpResponse, Url};
use rustls::pki_types::ServerName;
use rustls::{ClientConfig, ClientConnection, RootCertStore, StreamOwned};
use std::collections::HashMap;
use std::io::{BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};
use tauri::ipc::Response;
use tauri::{AppHandle, Manager};

/// Hosts the list builder may ask, and whether hosts below them count too.
/// Derived from what collect.ts fetches for the active entries of
/// sources/catalog.json (a test checks the catalogue against this list):
pub const ALLOWED_HOSTS: &[(&str, bool)] = &[
    // feedUrl of the active podcasts (Deutschlandfunk Kultur). The ARD shows
    // are read from their pages on ARD Sounds, not from the broadcasters' feeds.
    ("www.kakadu.de", false),
    // series.urls of the active link entries and their title pages (src/core/sources/pages.ts).
    ("www.ardsounds.de", false),
    ("www.ohrka.de", false),
];

/// Polite and recognisable, like the daily job (scripts/sources/build-index.ts).
pub const USER_AGENT: &str = "TonUINO-Studio-Quellen/1.0 (Desktop-App)";
/// Per request, connection and TLS handshake included.
pub const TIMEOUT: Duration = Duration::from_secs(20);
/// Largest answer: a feed or one page of a series.
pub const MAX_BODY: usize = 10 * 1024 * 1024;
/// Request headers the caller may set; everything else is dropped.
const PASSED_HEADERS: [&str; 4] = ["if-none-match", "if-modified-since", "origin", "range"];
/// Largest list file kept on disk.
const MAX_CACHE: usize = 4 * 1024 * 1024;

/// Whether the list builder may ask `host` (lower case, no port).
pub fn host_allowed(host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    ALLOWED_HOSTS.iter().any(|(allowed, below)| host == *allowed || (*below && host.strip_suffix(allowed).is_some_and(|rest| rest.ends_with('.') && rest.len() > 1)))
}

/// An https URL on port 443 with a host name (no IP address, no user info).
pub fn parse_https_url(url: &str) -> CmdResult<Url> {
    let rest = url
        .get(..8)
        .filter(|s| s.eq_ignore_ascii_case("https://"))
        .map(|_| &url[8..])
        .ok_or_else(|| CmdError::not_allowed(format!("only https:// URLs are allowed: {url}")))?;
    let rest = rest.split('#').next().unwrap_or("");
    let split = rest.find(['/', '?']).unwrap_or(rest.len());
    let (authority, target) = rest.split_at(split);
    if authority.is_empty() || authority.contains('@') || authority.starts_with('[') {
        return Err(CmdError::invalid(format!("bad host in {url}")));
    }
    let host = match authority.rsplit_once(':') {
        Some((h, "443")) => h,
        Some(_) => return Err(CmdError::not_allowed(format!("only port 443: {url}"))),
        None => authority,
    }
    .trim_end_matches('.')
    .to_ascii_lowercase();
    if host.is_empty() || !host.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'.') || host.parse::<std::net::IpAddr>().is_ok() {
        return Err(CmdError::invalid(format!("bad host in {url}")));
    }
    let target = if target.is_empty() {
        "/".to_string()
    } else if target.starts_with('?') {
        format!("/{target}")
    } else {
        target.to_string()
    };
    if target.bytes().any(|b| b <= b' ' || b >= 0x7f) {
        return Err(CmdError::invalid(format!("URL must be encoded: {url}")));
    }
    Ok(Url { host, port: 443, target })
}

/// A Range header for one piece of a file: "bytes=<first>-<last>", no more
/// than MAX_BODY bytes (a larger answer would be refused anyway).
fn range_ok(value: &str) -> bool {
    let Some((first, last)) = value.strip_prefix("bytes=").and_then(|r| r.split_once('-')) else {
        return false;
    };
    let number = |t: &str| (!t.is_empty() && t.len() <= 15 && t.bytes().all(|b| b.is_ascii_digit())).then(|| t.parse::<u64>().ok()).flatten();
    matches!((number(first), number(last)), (Some(a), Some(b)) if b >= a && b - a < MAX_BODY as u64)
}

/// The caller's headers that may pass, plus the fixed ones.
pub fn request_headers(from_caller: &[(String, String)]) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = from_caller
        .iter()
        .filter(|(k, _)| PASSED_HEADERS.contains(&k.to_ascii_lowercase().as_str()))
        .filter(|(k, v)| !k.eq_ignore_ascii_case("range") || range_ok(v))
        .map(|(k, v)| (k.to_ascii_lowercase(), v.clone()))
        .collect();
    out.push(("User-Agent".into(), USER_AGENT.into()));
    // No compression: the answer is read as it comes.
    out.push(("Accept-Encoding".into(), "identity".into()));
    out
}

fn tls_config() -> CmdResult<Arc<ClientConfig>> {
    static CONFIG: OnceLock<Arc<ClientConfig>> = OnceLock::new();
    if let Some(c) = CONFIG.get() {
        return Ok(c.clone());
    }
    let roots = RootCertStore { roots: webpki_roots::TLS_SERVER_ROOTS.to_vec() };
    let config = ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_safe_default_protocol_versions()
        .map_err(|e| CmdError::other(format!("TLS: {e}")))?
        .with_root_certificates(roots)
        .with_no_client_auth();
    Ok(CONFIG.get_or_init(|| Arc::new(config)).clone())
}

/// One GET. Without `with_body` only the status line and the headers are
/// read (the file check of a media host); the connection closes after them.
pub fn fetch(url_text: &str, headers: &[(String, String)], with_body: bool) -> CmdResult<HttpResponse> {
    let url = parse_https_url(url_text)?;
    if !host_allowed(&url.host) {
        return Err(CmdError::not_allowed(format!("{} is not a source of the list", url.host)));
    }
    let deadline = Instant::now() + TIMEOUT;
    let addrs = resolve(&url.host, url.port)?;
    if let Some(local) = addrs.iter().find(|a| is_local_address(&a.ip())) {
        return Err(CmdError::not_allowed(format!("{} points into the local network ({})", url.host, local.ip())));
    }
    let wire = build_request_for("GET", &url, 443, &request_headers(headers), &[])?;
    let stream = connect(&addrs, deadline)?;
    let name = ServerName::try_from(url.host.clone()).map_err(|e| CmdError::invalid(format!("{}: {e}", url.host)))?;
    let conn = ClientConnection::new(tls_config()?, name).map_err(|e| CmdError::other(format!("TLS: {e}")))?;
    let mut tls = StreamOwned::new(conn, DeadlineStream { stream, deadline });
    tls.write_all(&wire).map_err(net_error)?;
    tls.flush().map_err(net_error)?;
    parse_response_limited(&mut BufReader::new(tls), !with_body, MAX_BODY)
}

/// Args: `url`, `headers` (only If-None-Match, If-Modified-Since, Origin and
/// one byte range pass), `body` (false: status and headers only). Returns a TSB1 frame with
/// {status, statusText, headers} and the body as payload, like http_plain.
#[tauri::command]
pub async fn sources_fetch(url: String, headers: Option<HashMap<String, String>>, body: Option<bool>) -> CmdResult<Response> {
    let headers: Vec<(String, String)> = headers.unwrap_or_default().into_iter().collect();
    let with_body = body.unwrap_or(true);
    blocking(move || {
        let resp = fetch(&url, &headers, with_body)?;
        Ok(Response::new(frame(&resp.head, &resp.body)))
    })
    .await
}

fn cache_file(app: &AppHandle) -> CmdResult<PathBuf> {
    let dir = app.path().app_local_data_dir().map_err(|e| CmdError::other(format!("app data folder: {e}")))?;
    Ok(dir.join("entdecken").join("liste.json"))
}

pub fn read_cache(path: &Path) -> CmdResult<Option<String>> {
    match std::fs::metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(CmdError::io(&e, path.display())),
        Ok(m) if m.len() > MAX_CACHE as u64 => return Ok(None),
        Ok(_) => {}
    }
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        // A damaged file is like none: the list is built again.
        Err(e) if e.kind() == std::io::ErrorKind::InvalidData => Ok(None),
        Err(e) => Err(CmdError::io(&e, path.display())),
    }
}

/// Writes next to the file and renames, so a crash never leaves half a list.
pub fn write_cache(path: &Path, text: &str) -> CmdResult<()> {
    if text.len() > MAX_CACHE {
        return Err(CmdError::invalid(format!("list too large ({} bytes)", text.len())));
    }
    let dir = path.parent().ok_or_else(|| CmdError::other("no folder for the list"))?;
    std::fs::create_dir_all(dir).map_err(|e| CmdError::io(&e, dir.display()))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| CmdError::io(&e, tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| CmdError::io(&e, path.display()))
}

/// The kept list, or nothing.
#[tauri::command]
pub async fn sources_cache_read(app: AppHandle) -> CmdResult<Option<String>> {
    let path = cache_file(&app)?;
    blocking(move || read_cache(&path)).await
}

/// Keeps the list for the next start.
#[tauri::command]
pub async fn sources_cache_write(app: AppHandle, text: String) -> CmdResult<()> {
    let path = cache_file(&app)?;
    blocking(move || write_cache(&path, &text)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_only_the_sources_of_the_list() {
        for host in ["www.kakadu.de", "www.ardsounds.de", "www.ohrka.de", "WWW.OHRKA.DE", "www.ohrka.de."] {
            assert!(host_allowed(host), "{host}");
        }
        for host in [
            "",
            "librivox.org",
            "archive.org",
            "evil.www.ohrka.de",
            "www.ohrka.de.evil.com",
            "ohrka.de",
            "wdr.de",
            "www.wdr.de",
            // The broadcasters' feeds of the ARD shows: read from ARD Sounds since 0.4.
            "www1.wdr.de",
            "kinder.wdr.de",
            "www.ndr.de",
            "www.antennebrandenburg.de",
            "ndr.de",
            "gitlab.com",
            "dts.podtrac.com",
            "wdrmedien-a.akamaihd.net",
            "ardsounds.de",
            "api.ardaudiothek.de",
            "localhost",
            "127.0.0.1",
        ] {
            assert!(!host_allowed(host), "{host}");
        }
    }

    #[test]
    fn takes_only_https_on_port_443_with_a_host_name() {
        let u = parse_https_url("https://www.ohrka.de/hoeren/tierisch-spannend?x=1#y").unwrap();
        assert_eq!(u, Url { host: "www.ohrka.de".into(), port: 443, target: "/hoeren/tierisch-spannend?x=1".into() });
        assert_eq!(parse_https_url("HTTPS://Www.Ohrka.de:443").unwrap().target, "/");
        assert_eq!(parse_https_url("https://www.ohrka.de?x").unwrap().target, "/?x");
        assert_eq!(parse_https_url("http://www.ohrka.de/").unwrap_err().code, "not-allowed");
        assert_eq!(parse_https_url("ftp://www.ohrka.de/").unwrap_err().code, "not-allowed");
        assert_eq!(parse_https_url("https://www.ohrka.de:8443/").unwrap_err().code, "not-allowed");
        assert_eq!(parse_https_url("https://user@www.ohrka.de/").unwrap_err().code, "invalid-argument");
        assert_eq!(parse_https_url("https://93.184.216.34/").unwrap_err().code, "invalid-argument");
        assert_eq!(parse_https_url("https://[::1]/").unwrap_err().code, "invalid-argument");
        assert_eq!(parse_https_url("https://www.ohrka.de/a b").unwrap_err().code, "invalid-argument");
        assert_eq!(parse_https_url("https://www.ohrka.de/ä").unwrap_err().code, "invalid-argument");
    }

    #[test]
    fn refuses_other_hosts_before_any_network() {
        for url in ["https://example.org/feed.xml", "https://gitlab.com/api/v4/projects/1", "https://librivox.org/", "https://archive.org/metadata/x", "http://www.ohrka.de/"] {
            assert_eq!(fetch(url, &[], true).unwrap_err().code, "not-allowed", "{url}");
        }
    }

    #[test]
    fn sends_a_fixed_user_agent_and_only_the_known_headers() {
        let headers = request_headers(&[
            ("If-None-Match".into(), "\"v1\"".into()),
            ("Origin".into(), "tauri://localhost".into()),
            ("User-Agent".into(), "Mozilla".into()),
            ("Cookie".into(), "a=b".into()),
            ("Authorization".into(), "x".into()),
            ("Range".into(), "bytes=0-1".into()),
        ]);
        let names: Vec<&str> = headers.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(names, ["if-none-match", "origin", "range", "User-Agent", "Accept-Encoding"]);
        assert_eq!(headers[3].1, USER_AGENT);
        // Only one closed piece of a file, no larger than an answer may be.
        for bad in ["bytes=0-", "bytes=-500", "bytes=0-1,5-9", "bytes=5-1", "items=0-1", "bytes=0-10485760", "bytes= 0-1", "bytes=0x1-2"] {
            let h = request_headers(&[("Range".into(), bad.into())]);
            assert!(h.iter().all(|(k, _)| k != "range"), "{bad}");
        }
        assert!(range_ok("bytes=4194304-8388607"));
        assert!(range_ok("bytes=0-10485759"));
        let wire = build_request_for("GET", &parse_https_url("https://www.ohrka.de/hoeren/x").unwrap(), 443, &headers, &[]).unwrap();
        let text = String::from_utf8(wire).unwrap();
        assert!(text.starts_with("GET /hoeren/x HTTP/1.1\r\nHost: www.ohrka.de\r\nConnection: close\r\n"), "{text}");
        assert!(!text.contains("Mozilla") && !text.contains("Cookie"));
    }

    /// Every host collect.ts asks for an active entry of the catalogue must be allowed here, and nothing more.
    #[test]
    fn allowlist_matches_the_active_entries_of_the_catalogue() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../sources/catalog.json");
        let catalog: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let host_of = |u: &str| parse_https_url(u).unwrap().host;
        let mut needed = std::collections::BTreeSet::new();
        for e in catalog["entries"].as_array().unwrap() {
            if e["status"] != "active" || catalog["blocked"].as_array().unwrap().contains(&e["id"]) {
                continue;
            }
            match e["type"].as_str().unwrap() {
                "podcast" => {
                    needed.insert(host_of(e["feedUrl"].as_str().unwrap()));
                    // Files offered for direct download get the file check (checkHosts).
                    if e["delivery"] == "direct" {
                        for h in e["mediaHosts"].as_array().unwrap() {
                            needed.insert(h.as_str().unwrap().to_string());
                        }
                    }
                }
                "archive-album" => {
                    needed.insert("archive.org".to_string());
                }
                "link" => {
                    // A series read from its official pages (src/core/sources/pages.ts).
                    for u in e["series"]["urls"].as_array().into_iter().flatten() {
                        needed.insert(host_of(u.as_str().unwrap()));
                    }
                }
                other => panic!("{}: type {other} needs hosts that are not allowed here", e["id"]),
            }
        }
        for h in &needed {
            assert!(host_allowed(h), "{h} is needed by the catalogue but not allowed");
        }
        for (h, _) in ALLOWED_HOSTS {
            assert!(needed.contains(*h), "{h} is allowed but no active entry needs it");
        }
    }

    #[test]
    fn keeps_the_list_in_one_file() {
        let dir = std::env::temp_dir().join(format!("ts-entdecken-{}", std::process::id()));
        let path = dir.join("entdecken").join("liste.json");
        assert_eq!(read_cache(&path).unwrap(), None);
        write_cache(&path, "{\"format\":1}").unwrap();
        assert_eq!(read_cache(&path).unwrap().as_deref(), Some("{\"format\":1}"));
        write_cache(&path, "{\"format\":2}").unwrap();
        assert_eq!(read_cache(&path).unwrap().as_deref(), Some("{\"format\":2}"));
        assert!(!path.with_extension("json.tmp").exists());
        assert_eq!(write_cache(&path, &"x".repeat(MAX_CACHE + 1)).unwrap_err().code, "invalid-argument");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn talks_tls_and_refuses_a_server_without_a_valid_certificate() {
        // A local server that is no TLS server at all: the handshake fails, nothing is read as an answer.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let _ = s.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
        });
        let stream = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        let conn = ClientConnection::new(tls_config().unwrap(), ServerName::try_from("www.ohrka.de").unwrap()).unwrap();
        let mut tls = StreamOwned::new(conn, DeadlineStream { stream, deadline: Instant::now() + Duration::from_secs(5) });
        let wire = build_request_for("GET", &parse_https_url("https://www.ohrka.de/").unwrap(), 443, &request_headers(&[]), &[]).unwrap();
        let sent = tls.write_all(&wire).and_then(|_| tls.flush());
        let answer = sent.map_err(net_error).and_then(|_| parse_response_limited(&mut BufReader::new(tls), false, MAX_BODY));
        assert!(answer.is_err());
        server.join().unwrap();
    }
}
