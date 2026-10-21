//! Plain HTTP/1.1 to an ESP32 TonUINO box on the local network.
//!
//! The WebView cannot call http:// devices from the app origin (mixed content,
//! CORS), so the desktop app does it natively. Only http:// URLs whose host
//! resolves exclusively to private, link-local or loopback addresses are
//! allowed; HTTPS goes through the WebView's own fetch.

use crate::error::{blocking, CmdError, CmdResult};
use crate::framing::frame;
use crate::util::{body_bytes, header, optional_header};
use serde::Serialize;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{IpAddr, SocketAddr, TcpStream, ToSocketAddrs};
use std::time::{Duration, Instant};
use tauri::ipc::{Request, Response};

const MAX_BODY: usize = 64 * 1024 * 1024;
const MAX_HEADER_LINE: usize = 16 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Url {
    pub host: String,
    pub port: u16,
    /// Path and query, at least "/".
    pub target: String,
}

pub fn parse_url(url: &str) -> CmdResult<Url> {
    let rest = url
        .get(..7)
        .filter(|s| s.eq_ignore_ascii_case("http://"))
        .map(|_| &url[7..])
        .ok_or_else(|| CmdError::not_allowed(format!("only http:// URLs are allowed: {url}")))?;
    let rest = rest.split('#').next().unwrap_or("");
    let split = rest.find(['/', '?']).unwrap_or(rest.len());
    let (authority, target) = rest.split_at(split);
    if authority.is_empty() || authority.contains('@') {
        return Err(CmdError::invalid(format!("bad host in {url}")));
    }
    let (host, port) = if let Some(v6) = authority.strip_prefix('[') {
        let end = v6.find(']').ok_or_else(|| CmdError::invalid(format!("bad IPv6 host in {url}")))?;
        let port = v6[end + 1..].strip_prefix(':').map(str::to_string);
        (v6[..end].to_string(), port)
    } else {
        match authority.rsplit_once(':') {
            Some((h, p)) => (h.to_string(), Some(p.to_string())),
            None => (authority.to_string(), None),
        }
    };
    let port = match port {
        Some(p) => p.parse::<u16>().map_err(|_| CmdError::invalid(format!("bad port in {url}")))?,
        None => 80,
    };
    if host.is_empty() {
        return Err(CmdError::invalid(format!("bad host in {url}")));
    }
    let target = if target.is_empty() {
        "/".to_string()
    } else if target.starts_with('?') {
        format!("/{target}")
    } else {
        target.to_string()
    };
    if target.bytes().any(|b| b <= b' ' || b == 0x7f) {
        return Err(CmdError::invalid(format!("URL must be encoded: {url}")));
    }
    Ok(Url { host, port, target })
}

/// Private (RFC 1918), link-local, loopback or IPv6 unique-local addresses.
pub fn is_local_address(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_private() || v4.is_link_local() || v4.is_loopback(),
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_local_address(&IpAddr::V4(v4));
            }
            let first = v6.segments()[0];
            v6.is_loopback() || (first & 0xfe00) == 0xfc00 || (first & 0xffc0) == 0xfe80
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpHead {
    pub status: u16,
    pub status_text: String,
    pub headers: Vec<(String, String)>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpResponse {
    pub head: HttpHead,
    pub body: Vec<u8>,
}

fn bad(detail: impl Into<String>) -> CmdError {
    CmdError::new("bad-response", detail)
}

fn read_line<R: BufRead>(r: &mut R) -> CmdResult<String> {
    let mut line = Vec::new();
    let n = r.by_ref().take(MAX_HEADER_LINE as u64).read_until(b'\n', &mut line).map_err(net_error)?;
    if n == 0 {
        return Err(bad("connection closed before the response was complete"));
    }
    if line.last() != Some(&b'\n') {
        return Err(bad("header line too long"));
    }
    while matches!(line.last(), Some(b'\n' | b'\r')) {
        line.pop();
    }
    Ok(String::from_utf8_lossy(&line).into_owned())
}

/// Parses an HTTP/1.x response: status line, headers, and a body with
/// Content-Length, chunked transfer encoding, or up to the end of the stream.
pub fn parse_response<R: BufRead>(r: &mut R, head_request: bool) -> CmdResult<HttpResponse> {
    parse_response_limited(r, head_request, MAX_BODY)
}

/// `parse_response` with a smaller limit for the body (`max_body` bytes; a
/// larger body is an error, not a cut). Without a body (`head_request`) only
/// the status line and the headers are read.
pub fn parse_response_limited<R: BufRead>(r: &mut R, head_request: bool, max_body: usize) -> CmdResult<HttpResponse> {
    let max_body = max_body.min(MAX_BODY);
    let mut status_line = read_line(r)?;
    let mut status: u16;
    let mut status_text: String;
    let mut headers: Vec<(String, String)>;
    loop {
        let mut parts = status_line.splitn(3, ' ');
        let version = parts.next().unwrap_or("");
        if !version.starts_with("HTTP/1.") {
            return Err(bad(format!("not an HTTP/1.x response: {status_line}")));
        }
        status = parts.next().and_then(|s| s.parse().ok()).ok_or_else(|| bad(format!("bad status line: {status_line}")))?;
        status_text = parts.next().unwrap_or("").to_string();
        headers = Vec::new();
        loop {
            let line = read_line(r)?;
            if line.is_empty() {
                break;
            }
            if let Some((name, value)) = line.split_once(':') {
                headers.push((name.trim().to_string(), value.trim().to_string()));
            }
            if headers.len() > 200 {
                return Err(bad("too many headers"));
            }
        }
        // Skip interim responses like "100 Continue".
        if (100..200).contains(&status) && status != 101 {
            status_line = read_line(r)?;
            continue;
        }
        break;
    }
    let get = |name: &str| headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str());
    let no_body = head_request || status == 204 || status == 304 || (100..200).contains(&status);
    let mut body = Vec::new();
    if !no_body {
        let chunked = get("transfer-encoding").map(|v| v.to_ascii_lowercase().contains("chunked")).unwrap_or(false);
        if chunked {
            loop {
                let size_line = read_line(r)?;
                let size_hex = size_line.split(';').next().unwrap_or("").trim();
                let size = usize::from_str_radix(size_hex, 16).map_err(|_| bad(format!("bad chunk size: {size_line}")))?;
                if size == 0 {
                    // Trailers until the empty line.
                    while !read_line(r)?.is_empty() {}
                    break;
                }
                // The size comes from the other side: compare without adding,
                // so a size near usize::MAX cannot wrap around the limit.
                if size > max_body - body.len() {
                    return Err(bad("response too large"));
                }
                let start = body.len();
                body.resize(start + size, 0);
                r.read_exact(&mut body[start..]).map_err(net_error)?;
                let crlf = read_line(r)?;
                if !crlf.is_empty() {
                    return Err(bad("missing CRLF after chunk"));
                }
            }
        } else if let Some(len) = get("content-length") {
            let len: usize = len.parse().map_err(|_| bad(format!("bad Content-Length: {len}")))?;
            if len > max_body {
                return Err(bad("response too large"));
            }
            body.resize(len, 0);
            r.read_exact(&mut body).map_err(net_error)?;
        } else {
            r.by_ref().take(max_body as u64 + 1).read_to_end(&mut body).map_err(net_error)?;
            if body.len() > max_body {
                return Err(bad("response too large"));
            }
        }
    }
    Ok(HttpResponse { head: HttpHead { status, status_text, headers }, body })
}

pub(crate) fn net_error(e: std::io::Error) -> CmdError {
    use std::io::ErrorKind as K;
    let code = match e.kind() {
        K::TimedOut | K::WouldBlock => "timeout",
        K::ConnectionRefused | K::ConnectionReset | K::ConnectionAborted | K::NotConnected | K::AddrNotAvailable => "unreachable",
        K::UnexpectedEof => "bad-response",
        _ => "other",
    };
    CmdError::new(code, e.to_string())
}

/// Sets the socket timeout to what is left before every read and write.
pub(crate) struct DeadlineStream {
    pub(crate) stream: TcpStream,
    pub(crate) deadline: Instant,
}

impl DeadlineStream {
    fn left(&self) -> std::io::Result<Duration> {
        let left = self.deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "timeout"));
        }
        Ok(left)
    }
}

impl Read for DeadlineStream {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let left = self.left()?;
        self.stream.set_read_timeout(Some(left))?;
        self.stream.read(buf)
    }
}

impl Write for DeadlineStream {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let left = self.left()?;
        self.stream.set_write_timeout(Some(left))?;
        self.stream.write(buf)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.stream.flush()
    }
}

fn valid_token(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b))
}

pub fn build_request(method: &str, url: &Url, headers: &[(String, String)], body: &[u8]) -> CmdResult<Vec<u8>> {
    build_request_for(method, url, 80, headers, body)
}

/// `build_request` for a scheme whose default port is `default_port` (443 for https):
/// the Host header names the port only when it differs.
pub fn build_request_for(method: &str, url: &Url, default_port: u16, headers: &[(String, String)], body: &[u8]) -> CmdResult<Vec<u8>> {
    if !valid_token(method) {
        return Err(CmdError::invalid(format!("bad method {method}")));
    }
    let host = if url.host.contains(':') { format!("[{}]", url.host) } else { url.host.clone() };
    let host = if url.port == default_port { host } else { format!("{host}:{}", url.port) };
    let mut head = format!("{method} {} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n", url.target);
    let mut has_ua = false;
    let mut has_accept = false;
    for (k, v) in headers {
        if !valid_token(k) || v.contains(['\r', '\n']) {
            return Err(CmdError::invalid(format!("bad header {k}")));
        }
        let lower = k.to_ascii_lowercase();
        if matches!(lower.as_str(), "host" | "connection" | "content-length" | "transfer-encoding" | "keep-alive" | "upgrade") {
            continue;
        }
        has_ua |= lower == "user-agent";
        has_accept |= lower == "accept";
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    if !has_ua {
        head.push_str("User-Agent: TonUINO-Studio\r\n");
    }
    if !has_accept {
        head.push_str("Accept: */*\r\n");
    }
    if !body.is_empty() || matches!(method, "POST" | "PUT" | "PATCH") {
        head.push_str(&format!("Content-Length: {}\r\n", body.len()));
    }
    head.push_str("\r\n");
    let mut out = head.into_bytes();
    out.extend_from_slice(body);
    Ok(out)
}

/// The addresses of `host`; an error when it has none.
pub(crate) fn resolve(host: &str, port: u16) -> CmdResult<Vec<SocketAddr>> {
    let addrs: Vec<SocketAddr> = (host, port).to_socket_addrs().map_err(|e| CmdError::new("unreachable", format!("{host}: {e}")))?.collect();
    if addrs.is_empty() {
        return Err(CmdError::new("unreachable", format!("{host} has no address")));
    }
    Ok(addrs)
}

/// Connects to the first address that answers before `deadline`.
pub(crate) fn connect(addrs: &[SocketAddr], deadline: Instant) -> CmdResult<TcpStream> {
    let mut last_err = None;
    for addr in addrs {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            break;
        }
        match TcpStream::connect_timeout(addr, left) {
            Ok(s) => return Ok(s),
            Err(e) => last_err = Some(e),
        }
    }
    Err(last_err.map(net_error).unwrap_or_else(|| CmdError::new("timeout", "connect timed out")))
}

pub fn request(method: &str, url_text: &str, headers: &[(String, String)], body: &[u8], timeout: Duration) -> CmdResult<HttpResponse> {
    let url = parse_url(url_text)?;
    let deadline = Instant::now() + timeout;
    let addrs = resolve(&url.host, url.port)?;
    if let Some(public) = addrs.iter().find(|a| !is_local_address(&a.ip())) {
        return Err(CmdError::not_allowed(format!("{} is not in the local network ({})", url.host, public.ip())));
    }
    let wire = build_request(method, &url, headers, body)?;
    let mut stream = connect(&addrs, deadline)?;
    let left = deadline.saturating_duration_since(Instant::now()).max(Duration::from_millis(1));
    stream.set_write_timeout(Some(left)).map_err(net_error)?;
    stream.write_all(&wire).map_err(net_error)?;
    let mut reader = BufReader::new(DeadlineStream { stream, deadline });
    parse_response(&mut reader, method.eq_ignore_ascii_case("HEAD"))
}

/// Raw body = request body. Headers: `x-method`, `x-url`, `x-timeout` (ms,
/// whole request, at most one hour), optional `x-headers` (URI-encoded JSON object). Returns a TSB1 frame with
/// {status, statusText, headers} and the response body as payload.
#[tauri::command]
pub async fn http_plain(req: Request<'_>) -> CmdResult<Response> {
    let method = header(&req, "x-method")?.to_ascii_uppercase();
    let url = header(&req, "x-url")?;
    let timeout_ms: u64 = header(&req, "x-timeout")?.parse().unwrap_or(10_000);
    let headers: Vec<(String, String)> = match optional_header(&req, "x-headers")? {
        Some(json) => {
            let map: serde_json::Map<String, serde_json::Value> =
                serde_json::from_str(&json).map_err(|e| CmdError::invalid(format!("x-headers: {e}")))?;
            map.into_iter().map(|(k, v)| (k, v.as_str().map(str::to_string).unwrap_or_else(|| v.to_string()))).collect()
        }
        None => Vec::new(),
    };
    let body = body_bytes(&req)?;
    blocking(move || {
        let resp = request(&method, &url, &headers, &body, Duration::from_millis(timeout_ms.clamp(100, 3_600_000)))?;
        Ok(Response::new(frame(&resp.head, &resp.body)))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use std::net::{Ipv4Addr, Ipv6Addr, TcpListener};

    fn parse(raw: &[u8]) -> CmdResult<HttpResponse> {
        parse_response(&mut Cursor::new(raw.to_vec()), false)
    }

    #[test]
    fn parses_content_length_response() {
        let r = parse(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\n\r\n{\"vol\": 15}trailing").unwrap();
        assert_eq!(r.head.status, 200);
        assert_eq!(r.head.status_text, "OK");
        assert_eq!(r.head.headers[0], ("Content-Type".to_string(), "application/json".to_string()));
        assert_eq!(r.body, b"{\"vol\": 15}");
    }

    #[test]
    fn parses_chunked_response_with_extensions_and_trailers() {
        let raw = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4;name=x\r\nWiki\r\n5\r\npedia\r\nE\r\n in\r\n\r\nchunks.\r\n0\r\nX-Trailer: 1\r\n\r\n";
        assert_eq!(parse(raw).unwrap().body, b"Wikipedia in\r\n\r\nchunks.");
    }

    #[test]
    fn parses_http10_body_until_eof_and_skips_100_continue() {
        let r = parse(b"HTTP/1.0 200 OK\nServer: ESP32\n\nhello box").unwrap();
        assert_eq!((r.head.status, r.body.as_slice()), (200, b"hello box".as_slice()));
        let r = parse(b"HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 201 Created\r\nContent-Length: 2\r\n\r\nok").unwrap();
        assert_eq!((r.head.status, r.body.as_slice()), (201, b"ok".as_slice()));
        let r = parse(b"HTTP/1.1 204 No Content\r\n\r\n").unwrap();
        assert!(r.body.is_empty());
    }

    #[test]
    fn rejects_garbage_and_truncated_bodies() {
        assert_eq!(parse(b"SSH-2.0-OpenSSH\r\n").unwrap_err().code, "bad-response");
        assert_eq!(parse(b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nshort").unwrap_err().code, "bad-response");
        assert_eq!(parse(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\n").unwrap_err().code, "bad-response");
        assert_eq!(parse(b"").unwrap_err().code, "bad-response");
    }

    #[test]
    fn rejects_chunk_sizes_beyond_the_limit_without_overflow() {
        // A size near usize::MAX must not wrap the running total below the
        // limit: that cut the buffer short and panicked (an abort in release).
        let raw = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nok\r\nfffffffffffffffe\r\nx\r\n0\r\n\r\n";
        assert_eq!(parse(raw).unwrap_err().code, "bad-response");
        let raw = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1\r\na\r\nffffffffffffffff\r\nx\r\n0\r\n\r\n";
        assert_eq!(parse(raw).unwrap_err().code, "bad-response");
        let raw = format!("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n{:x}\r\nx\r\n0\r\n\r\n", MAX_BODY + 1);
        assert_eq!(parse(raw.as_bytes()).unwrap_err().code, "bad-response");
    }

    #[test]
    fn parses_urls() {
        assert_eq!(parse_url("http://192.168.1.50/api/status?x=1#top").unwrap(), Url { host: "192.168.1.50".into(), port: 80, target: "/api/status?x=1".into() });
        assert_eq!(parse_url("HTTP://tonuino.local:8080").unwrap(), Url { host: "tonuino.local".into(), port: 8080, target: "/".into() });
        assert_eq!(parse_url("http://[fe80::1]:81/a").unwrap(), Url { host: "fe80::1".into(), port: 81, target: "/a".into() });
        assert_eq!(parse_url("http://10.0.0.2?q").unwrap().target, "/?q");
        assert_eq!(parse_url("https://192.168.1.50/").unwrap_err().code, "not-allowed");
        assert_eq!(parse_url("ftp://x/").unwrap_err().code, "not-allowed");
        assert_eq!(parse_url("http://user@10.0.0.1/").unwrap_err().code, "invalid-argument");
        assert_eq!(parse_url("http://10.0.0.1:99999/").unwrap_err().code, "invalid-argument");
        assert_eq!(parse_url("http://10.0.0.1/a b").unwrap_err().code, "invalid-argument");
    }

    #[test]
    fn only_local_addresses() {
        for ip in ["192.168.0.10", "10.1.2.3", "172.16.0.1", "172.31.255.255", "169.254.1.1", "127.0.0.1"] {
            assert!(is_local_address(&ip.parse::<Ipv4Addr>().unwrap().into()), "{ip}");
        }
        for ip in ["8.8.8.8", "172.32.0.1", "100.64.0.1", "1.1.1.1"] {
            assert!(!is_local_address(&ip.parse::<Ipv4Addr>().unwrap().into()), "{ip}");
        }
        for ip in ["::1", "fd00::1", "fe80::1", "::ffff:192.168.1.1"] {
            assert!(is_local_address(&ip.parse::<Ipv6Addr>().unwrap().into()), "{ip}");
        }
        for ip in ["2001:db8::1", "::ffff:8.8.8.8"] {
            assert!(!is_local_address(&ip.parse::<Ipv6Addr>().unwrap().into()), "{ip}");
        }
        assert_eq!(request("GET", "http://8.8.8.8/", &[], &[], Duration::from_secs(1)).unwrap_err().code, "not-allowed");
    }

    #[test]
    fn builds_requests() {
        let url = parse_url("http://192.168.1.5:8080/cmd").unwrap();
        let wire = build_request("POST", &url, &[("Content-Type".into(), "application/json".into()), ("Host".into(), "evil".into())], b"{}").unwrap();
        let text = String::from_utf8(wire).unwrap();
        assert!(text.starts_with("POST /cmd HTTP/1.1\r\nHost: 192.168.1.5:8080\r\nConnection: close\r\n"));
        assert!(text.contains("Content-Type: application/json\r\n"));
        assert!(!text.contains("evil"));
        assert!(text.ends_with("Content-Length: 2\r\n\r\n{}"));
        assert!(build_request("GET X", &url, &[], &[]).is_err());
        assert!(build_request("GET", &url, &[("X".into(), "a\r\nB: c".into())], &[]).is_err());
    }

    #[test]
    fn talks_to_a_local_server() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let mut buf = [0u8; 1024];
            let n = s.read(&mut buf).unwrap();
            let req = String::from_utf8_lossy(&buf[..n]).into_owned();
            s.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\npong").unwrap();
            req
        });
        let resp = request("GET", &format!("http://127.0.0.1:{port}/ping"), &[], &[], Duration::from_secs(5)).unwrap();
        assert_eq!(resp.body, b"pong");
        let req = server.join().unwrap();
        assert!(req.starts_with("GET /ping HTTP/1.1\r\n"));
    }
}
