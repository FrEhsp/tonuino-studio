//! HTTPS for the cover search (TODO #110, #134), on the desktop with the
//! cargo feature "quellen" (on by default).
//!
//! The WebView cannot read Deezer's answers (no CORS header) and cannot set
//! a User-Agent, which MusicBrainz asks every program to send
//! (https://musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting). So the
//! search and the pictures go through here: only GET, only https on port
//! 443, only the hosts of the services in COVER_HOSTS (never an address in
//! the local network), at most MAX_BODY bytes and TIMEOUT per request, with
//! the app's own User-Agent. A redirect comes back to the caller, which asks
//! again for the new address (and this allowlist decides again).
//!
//! The pace of the requests (one a second at MusicBrainz) is kept by the
//! caller's queues (src/core/covers/net.ts), shared by the whole app.
//!
//! Command: cover_fetch.

use crate::error::{blocking, CmdError, CmdResult};
use crate::framing::frame;
use crate::http::HttpResponse;
use crate::sources_net::{https_get, parse_https_url};
use std::time::Duration;
use tauri::ipc::Response;

/// The services' hosts, and whether hosts below them count too. The same
/// list as SERVICE_HOSTS in src/core/covers/net.ts (a test there and one
/// here keep them alike); it is also what a web filter must let through.
pub const COVER_HOSTS: &[(&str, bool)] = &[
    // iTunes Search API and Apple's picture servers (is1-ssl … is5-ssl).
    ("itunes.apple.com", false),
    ("mzstatic.com", true),
    // Deezer's search and its picture servers.
    ("api.deezer.com", false),
    ("dzcdn.net", true),
    // MusicBrainz' search and the Cover Art Archive, whose pictures lie on archive.org.
    ("musicbrainz.org", false),
    ("coverartarchive.org", false),
    ("archive.org", false),
    ("archive.org", true),
];

/// Who asks, with a way to reach the maker, as MusicBrainz asks for.
pub fn user_agent() -> String {
    format!("TonUINO-Studio/{} ( https://github.com/FrEhsp/tonuino-studio )", env!("CARGO_PKG_VERSION"))
}

/// Per request, connection and TLS handshake included (the caller has its own, shorter limit).
pub const TIMEOUT: Duration = Duration::from_secs(20);
/// Largest answer: a cover in print size or a page of search results.
pub const MAX_BODY: usize = 15 * 1024 * 1024;

/// Whether the cover search may ask `host` (lower case, no port).
pub fn host_allowed(host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    COVER_HOSTS.iter().any(|(allowed, below)| {
        if *below {
            host.strip_suffix(allowed).is_some_and(|rest| rest.ends_with('.') && rest.len() > 1)
        } else {
            host == *allowed
        }
    })
}

/// The request headers: only what a search or a picture needs, and who asks.
pub fn request_headers(accept_json: bool) -> Vec<(String, String)> {
    vec![
        ("User-Agent".into(), user_agent()),
        ("Accept".into(), if accept_json { "application/json".into() } else { "image/*,*/*;q=0.5".into() }),
        // No compression: the answer is read as it comes.
        ("Accept-Encoding".into(), "identity".into()),
    ]
}

/// One GET of a search answer or a picture.
pub fn fetch(url_text: &str, accept_json: bool) -> CmdResult<HttpResponse> {
    let url = parse_https_url(url_text)?;
    if !host_allowed(&url.host) {
        return Err(CmdError::not_allowed(format!("{} is not a cover service", url.host)));
    }
    https_get(&url, &request_headers(accept_json), true, MAX_BODY, TIMEOUT)
}

/// Args: `url`, `json` (true for a search: asks for JSON). Returns a TSB1
/// frame with {status, statusText, headers} and the body as payload, like
/// sources_fetch.
#[tauri::command]
pub async fn cover_fetch(url: String, json: Option<bool>) -> CmdResult<Response> {
    let accept_json = json.unwrap_or(false);
    blocking(move || {
        let resp = fetch(&url, accept_json)?;
        Ok(Response::new(frame(&resp.head, &resp.body)))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_only_the_cover_services() {
        for host in [
            "itunes.apple.com",
            "is1-ssl.mzstatic.com",
            "is5-ssl.mzstatic.com",
            "api.deezer.com",
            "cdn-images.dzcdn.net",
            "e-cdns-images.dzcdn.net",
            "musicbrainz.org",
            "coverartarchive.org",
            "archive.org",
            "ia800300.us.archive.org",
            "MUSICBRAINZ.ORG",
            "api.deezer.com.",
        ] {
            assert!(host_allowed(host), "{host}");
        }
        for host in [
            "",
            "apple.com",
            "deezer.com",
            "www.deezer.com",
            "mzstatic.com",
            "dzcdn.net",
            "evilmzstatic.com",
            "mzstatic.com.evil.org",
            "musicbrainz.org.evil.org",
            "beta.musicbrainz.org",
            "www.ohrka.de",
            "localhost",
            "127.0.0.1",
        ] {
            assert!(!host_allowed(host), "{host}");
        }
    }

    #[test]
    fn names_the_app_and_where_to_reach_its_maker() {
        let ua = user_agent();
        assert!(ua.starts_with("TonUINO-Studio/"), "{ua}");
        assert!(ua.contains(env!("CARGO_PKG_VERSION")), "{ua}");
        assert!(ua.ends_with("( https://github.com/FrEhsp/tonuino-studio )"), "{ua}");
        // No address of a person in it.
        assert!(!ua.contains('@'), "{ua}");
        let headers = request_headers(true);
        assert!(headers.iter().any(|(k, v)| k == "User-Agent" && *v == ua));
        assert!(headers.iter().any(|(k, v)| k == "Accept" && v == "application/json"));
        assert!(request_headers(false).iter().any(|(k, v)| k == "Accept" && v.starts_with("image/")));
    }

    #[test]
    fn refuses_other_hosts_plain_http_and_other_ports_before_any_connection() {
        for url in [
            "https://example.org/x",
            "http://itunes.apple.com/search?term=x",
            "https://itunes.apple.com:8443/search",
            "https://user@musicbrainz.org/ws/2/",
            "https://192.168.1.10/cover.jpg",
            "https://www.ohrka.de/",
        ] {
            assert!(fetch(url, true).is_err(), "{url}");
        }
    }
}
