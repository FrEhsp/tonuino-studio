//! Small helpers shared by the command modules.

use crate::error::{CmdError, CmdResult};
use std::cmp::Ordering;
use std::collections::HashMap;
#[cfg(any(target_os = "linux", all(test, unix)))]
use std::ffi::OsString;
use std::sync::atomic::{self, AtomicBool};
use std::sync::{Arc, Mutex, MutexGuard};
use tauri::ipc::{InvokeBody, Request};

/// Cancellation flags of running jobs (copies, analyses), keyed by an id the
/// bridge chooses. The bridge may send the cancel while the job's own
/// request is still on its way, so an early cancel is remembered and the job
/// stops as soon as it registers.
#[derive(Default)]
pub struct CancelFlags(Mutex<HashMap<String, Arc<AtomicBool>>>);

impl CancelFlags {
    fn map(&self) -> MutexGuard<'_, HashMap<String, Arc<AtomicBool>>> {
        self.0.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Registers a job and returns its flag (already set after an early cancel).
    pub fn register(&self, id: &str) -> Arc<AtomicBool> {
        self.map().entry(id.to_string()).or_insert_with(|| Arc::new(AtomicBool::new(false))).clone()
    }

    pub fn finish(&self, id: &str) {
        self.map().remove(id);
    }

    pub fn cancel(&self, id: &str) {
        let mut map = self.map();
        // Cancels of jobs that never started would pile up forever; running
        // jobs keep their own reference to the flag, so dropping set flags is safe.
        if map.len() >= 256 {
            map.retain(|_, flag| !flag.load(atomic::Ordering::Relaxed));
        }
        map.entry(id.to_string())
            .or_insert_with(|| Arc::new(AtomicBool::new(false)))
            .store(true, atomic::Ordering::Relaxed);
    }
}

/// Decodes `encodeURIComponent` output (UTF-8 percent encoding).
pub fn percent_decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' => {
                let hex = bytes.get(i + 1..i + 3)?;
                let hi = (hex[0] as char).to_digit(16)?;
                let lo = (hex[1] as char).to_digit(16)?;
                out.push((hi * 16 + lo) as u8);
                i += 3;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8(out).ok()
}

/// Reads a header of a raw-body request. Values are URI-encoded by the bridge.
pub fn header(request: &Request<'_>, name: &str) -> CmdResult<String> {
    let value = request
        .headers()
        .get(name)
        .ok_or_else(|| CmdError::invalid(format!("missing header {name}")))?;
    let text = value.to_str().map_err(|_| CmdError::invalid(format!("header {name} is not ASCII")))?;
    percent_decode(text).ok_or_else(|| CmdError::invalid(format!("header {name} is not valid URI encoding")))
}

pub fn optional_header(request: &Request<'_>, name: &str) -> CmdResult<Option<String>> {
    if request.headers().contains_key(name) {
        header(request, name).map(Some)
    } else {
        Ok(None)
    }
}

pub fn header_u64(request: &Request<'_>, name: &str) -> CmdResult<u64> {
    header(request, name)?
        .parse()
        .map_err(|_| CmdError::invalid(format!("header {name} is not a number")))
}

/// The raw body of a request. Falls back to a JSON number array, which is what
/// Tauri sends when the custom IPC protocol is unavailable.
pub fn body_bytes(request: &Request<'_>) -> CmdResult<Vec<u8>> {
    match request.body() {
        InvokeBody::Raw(bytes) => Ok(bytes.clone()),
        InvokeBody::Json(serde_json::Value::Array(items)) => items
            .iter()
            .map(|v| v.as_u64().filter(|n| *n < 256).map(|n| n as u8))
            .collect::<Option<Vec<u8>>>()
            .ok_or_else(|| CmdError::invalid("body is not a byte array")),
        InvokeBody::Json(serde_json::Value::Null) => Ok(Vec::new()),
        InvokeBody::Json(_) => Err(CmdError::invalid("expected a binary body")),
    }
}

/// "Natural" order for file names: case-insensitive, digit runs compared by value,
/// so "Track 2" comes before "Track 10".
pub fn natural_cmp(a: &str, b: &str) -> Ordering {
    let mut ai = a.chars().peekable();
    let mut bi = b.chars().peekable();
    loop {
        match (ai.peek().copied(), bi.peek().copied()) {
            (None, None) => return a.cmp(b),
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(ca), Some(cb)) if ca.is_ascii_digit() && cb.is_ascii_digit() => {
                let mut da = String::new();
                while let Some(c) = ai.peek().copied().filter(char::is_ascii_digit) {
                    da.push(c);
                    ai.next();
                }
                let mut db = String::new();
                while let Some(c) = bi.peek().copied().filter(char::is_ascii_digit) {
                    db.push(c);
                    bi.next();
                }
                let ta = da.trim_start_matches('0');
                let tb = db.trim_start_matches('0');
                let ord = ta.len().cmp(&tb.len()).then_with(|| ta.cmp(tb));
                if ord != Ordering::Equal {
                    return ord;
                }
            }
            (Some(ca), Some(cb)) => {
                let la = ca.to_lowercase().next().unwrap_or(ca);
                let lb = cb.to_lowercase().next().unwrap_or(cb);
                if la != lb {
                    return la.cmp(&lb);
                }
                ai.next();
                bi.next();
            }
        }
    }
}

/// Changes to the environment of a program the app starts (the computer's
/// voice) when the app runs as an AppImage. Its start script
/// points variables such as LD_LIBRARY_PATH, PATH or XDG_DATA_DIRS into the
/// AppImage, for the app's own libraries; programs of the computer must not
/// load those. Entries inside the AppImage are dropped, and a variable left
/// empty is removed (None).
#[cfg(any(target_os = "linux", all(test, unix)))]
pub fn appimage_env(appdir: &str, vars: impl IntoIterator<Item = (OsString, OsString)>) -> Vec<(OsString, Option<OsString>)> {
    let appdir = appdir.trim_end_matches('/');
    if !appdir.starts_with('/') || appdir.len() < 2 {
        return Vec::new();
    }
    let inside = |entry: &str| entry == appdir || entry.strip_prefix(appdir).is_some_and(|rest| rest.starts_with('/'));
    let mut changes = Vec::new();
    for (key, value) in vars {
        let Some(text) = value.to_str() else { continue };
        let entries: Vec<&str> = text.split(':').collect();
        if !entries.iter().any(|e| inside(e)) {
            continue;
        }
        let kept: Vec<&str> = entries.into_iter().filter(|e| !e.is_empty() && !inside(e)).collect();
        changes.push((key, (!kept.is_empty()).then(|| OsString::from(kept.join(":")))));
    }
    changes
}

/// The package family of a Linux system, for terminal commands in hints
/// (`apt` on Ubuntu, Mint and Tuxedo OS, `dnf` on Fedora, `pacman` on Arch).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub enum Distro {
    Debian,
    /// Pop!_OS: an apt system whose desktop package depends on brltty.
    PopOs,
    Fedora,
    Arch,
    Suse,
}

/// The family from the text of /etc/os-release: ID first, then ID_LIKE.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn distro_from_os_release(text: &str) -> Option<Distro> {
    let value = |key: &str| {
        text.lines()
            .filter_map(|l| l.split_once('='))
            .find(|(k, _)| k.trim() == key)
            .map(|(_, v)| v.trim().trim_matches(|c| c == '"' || c == '\'').to_ascii_lowercase())
            .unwrap_or_default()
    };
    let ids = format!("{} {}", value("ID"), value("ID_LIKE"));
    ids.split_whitespace().find_map(|id| match id {
        "pop" => Some(Distro::PopOs),
        "debian" | "ubuntu" | "linuxmint" | "tuxedo" | "elementary" | "zorin" | "neon" | "raspbian" | "kali" => Some(Distro::Debian),
        "fedora" | "rhel" | "centos" | "rocky" | "almalinux" | "nobara" => Some(Distro::Fedora),
        "arch" | "manjaro" | "endeavouros" | "cachyos" | "garuda" => Some(Distro::Arch),
        "opensuse" | "suse" | "opensuse-tumbleweed" | "opensuse-leap" | "sles" => Some(Distro::Suse),
        _ => None,
    })
}

/// The family of the system the app runs on; None where it is not known.
#[cfg(target_os = "linux")]
pub fn linux_distro() -> Option<Distro> {
    ["/etc/os-release", "/usr/lib/os-release"]
        .iter()
        .find_map(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| distro_from_os_release(&t))
}

pub fn hex_upper(bytes: &[u8], sep: &str) -> String {
    bytes.iter().map(|b| format!("{b:02X}")).collect::<Vec<_>>().join(sep)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn early_cancel_reaches_the_job() {
        let flags = CancelFlags::default();
        flags.cancel("a");
        assert!(flags.register("a").load(atomic::Ordering::Relaxed), "cancel before start is kept");
        flags.finish("a");
        let b = flags.register("b");
        assert!(!b.load(atomic::Ordering::Relaxed));
        flags.cancel("b");
        assert!(b.load(atomic::Ordering::Relaxed));
        flags.finish("b");
        assert!(flags.map().is_empty());
    }

    #[test]
    fn decodes_uri_components() {
        assert_eq!(percent_decode("%2Fmedia%2Fanna%2FTONUINO%2001").unwrap(), "/media/anna/TONUINO 01");
        assert_eq!(percent_decode("H%C3%B6rbuch").unwrap(), "Hörbuch");
        assert_eq!(percent_decode("C%3A%5CMusik").unwrap(), "C:\\Musik");
        assert!(percent_decode("%zz").is_none());
        assert!(percent_decode("%4").is_none());
    }

    #[test]
    fn package_family_from_os_release() {
        let ubuntu = "NAME=\"Ubuntu\"\nID=ubuntu\nID_LIKE=debian\nVERSION_ID=\"24.04\"\n";
        assert_eq!(distro_from_os_release(ubuntu), Some(Distro::Debian));
        assert_eq!(distro_from_os_release("ID=linuxmint\nID_LIKE=\"ubuntu debian\"\n"), Some(Distro::Debian));
        assert_eq!(distro_from_os_release("ID=tuxedo\nID_LIKE=\"ubuntu debian\"\n"), Some(Distro::Debian));
        assert_eq!(distro_from_os_release("ID=pop\nID_LIKE=\"ubuntu debian\"\n"), Some(Distro::PopOs));
        assert_eq!(distro_from_os_release("ID=fedora\nVERSION_ID=41\n"), Some(Distro::Fedora));
        assert_eq!(distro_from_os_release("ID=endeavouros\nID_LIKE=arch\n"), Some(Distro::Arch));
        assert_eq!(distro_from_os_release("ID=\"opensuse-tumbleweed\"\nID_LIKE=\"opensuse suse\"\n"), Some(Distro::Suse));
        // Unknown: ID_LIKE decides, or nothing.
        assert_eq!(distro_from_os_release("ID=somethingnew\nID_LIKE=ubuntu\n"), Some(Distro::Debian));
        assert_eq!(distro_from_os_release("ID=nixos\n"), None);
        assert_eq!(distro_from_os_release(""), None);
    }

    #[test]
    fn natural_order() {
        let mut v = vec!["Track 10.mp3", "track 2.mp3", "Track 1.mp3", "a", "B"];
        v.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(v, ["a", "B", "Track 1.mp3", "track 2.mp3", "Track 10.mp3"]);
        // Equal by value, but still a total order.
        assert_ne!(natural_cmp("CD1/02", "CD1/002"), Ordering::Equal);
        assert_eq!(natural_cmp("x", "x"), Ordering::Equal);
    }
}
