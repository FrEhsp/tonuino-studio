//! Error type shared by all commands.
//!
//! Commands never return free text to the UI. They return a stable `code`
//! (the TypeScript bridge turns it into a German message), a technical
//! `detail` for logs and support, and optional `hints` (stable ids for
//! follow-up advice, e.g. "linux-install-pcscd").

use serde::Serialize;
use std::io;

#[derive(Debug, Clone, Serialize, thiserror::Error)]
#[error("{code}: {detail}")]
pub struct CmdError {
    pub code: &'static str,
    pub detail: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub hints: Vec<String>,
}

pub type CmdResult<T> = Result<T, CmdError>;

impl CmdError {
    pub fn new(code: &'static str, detail: impl Into<String>) -> Self {
        CmdError { code, detail: detail.into(), hints: Vec::new() }
    }

    pub fn with_hints(mut self, hints: impl IntoIterator<Item = String>) -> Self {
        self.hints.extend(hints);
        self
    }

    pub fn other(detail: impl Into<String>) -> Self {
        Self::new("other", detail)
    }

    pub fn not_allowed(detail: impl Into<String>) -> Self {
        Self::new("not-allowed", detail)
    }

    pub fn invalid(detail: impl Into<String>) -> Self {
        Self::new("invalid-argument", detail)
    }

    /// Maps an I/O error to a stable code. `context` names the operation and path.
    pub fn io(e: &io::Error, context: impl std::fmt::Display) -> Self {
        Self::new(io_code(e), format!("{context}: {e}"))
    }
}

/// Stable code for an I/O error: not-found, permission, busy, no-space,
/// read-only, exists, not-empty, invalid-name, not-a-file, cross-device,
/// io (device error), other.
pub fn io_code(e: &io::Error) -> &'static str {
    if let Some(raw) = e.raw_os_error() {
        if let Some(code) = os_code(raw) {
            return code;
        }
    }
    match e.kind() {
        io::ErrorKind::NotFound => "not-found",
        io::ErrorKind::PermissionDenied => "permission",
        io::ErrorKind::AlreadyExists => "exists",
        io::ErrorKind::WouldBlock => "busy",
        io::ErrorKind::InvalidInput => "invalid-name",
        io::ErrorKind::UnexpectedEof => "io",
        _ => "other",
    }
}

#[cfg(unix)]
fn os_code(raw: i32) -> Option<&'static str> {
    Some(match raw {
        libc::ENOENT | libc::ENOTDIR => "not-found",
        libc::EACCES | libc::EPERM => "permission",
        libc::EBUSY | libc::ETXTBSY => "busy",
        libc::ENOSPC | libc::EDQUOT | libc::EFBIG => "no-space",
        libc::EROFS => "read-only",
        libc::EEXIST => "exists",
        libc::ENOTEMPTY => "not-empty",
        libc::EINVAL | libc::ENAMETOOLONG | libc::EILSEQ => "invalid-name",
        libc::EIO | libc::ENXIO | libc::ENODEV | libc::ESHUTDOWN => "io",
        libc::EISDIR => "not-a-file",
        libc::EXDEV => "cross-device",
        _ => return None,
    })
}

#[cfg(windows)]
fn os_code(raw: i32) -> Option<&'static str> {
    // https://learn.microsoft.com/en-us/windows/win32/debug/system-error-codes--0-499-
    Some(match raw {
        2 | 3 | 15 | 21 => "not-found", // FILE_NOT_FOUND, PATH_NOT_FOUND, INVALID_DRIVE, NOT_READY
        5 => "permission",              // ACCESS_DENIED
        32 | 33 | 170 => "busy",        // SHARING_VIOLATION, LOCK_VIOLATION, BUSY
        39 | 112 => "no-space",         // HANDLE_DISK_FULL, DISK_FULL
        19 => "read-only",              // WRITE_PROTECT
        80 | 183 => "exists",           // FILE_EXISTS, ALREADY_EXISTS
        145 => "not-empty",             // DIR_NOT_EMPTY
        123 | 206 => "invalid-name",    // INVALID_NAME, FILENAME_EXCED_RANGE
        23 | 1117 | 1167 => "io",       // CRC, IO_DEVICE, DEVICE_NOT_CONNECTED
        17 => "cross-device",           // NOT_SAME_DEVICE
        _ => return None,
    })
}

#[cfg(not(any(unix, windows)))]
fn os_code(_raw: i32) -> Option<&'static str> {
    None
}

/// Runs blocking work on Tauri's blocking thread pool, so slow SD cards,
/// serial timeouts or PC/SC waits never stall the main thread.
pub async fn blocking<T, F>(f: F) -> CmdResult<T>
where
    F: FnOnce() -> CmdResult<T> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| CmdError::other(format!("worker failed: {e}")))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_common_io_errors() {
        assert_eq!(io_code(&io::Error::from(io::ErrorKind::NotFound)), "not-found");
        assert_eq!(io_code(&io::Error::from(io::ErrorKind::PermissionDenied)), "permission");
        #[cfg(unix)]
        {
            assert_eq!(io_code(&io::Error::from_raw_os_error(libc::ENOSPC)), "no-space");
            assert_eq!(io_code(&io::Error::from_raw_os_error(libc::EROFS)), "read-only");
            assert_eq!(io_code(&io::Error::from_raw_os_error(libc::EBUSY)), "busy");
            assert_eq!(io_code(&io::Error::from_raw_os_error(libc::EACCES)), "permission");
        }
    }

    #[test]
    fn serializes_without_empty_hints() {
        let json = serde_json::to_string(&CmdError::new("busy", "x")).unwrap();
        assert_eq!(json, r#"{"code":"busy","detail":"x"}"#);
        let json = serde_json::to_string(&CmdError::new("busy", "x").with_hints(["a".to_string()])).unwrap();
        assert_eq!(json, r#"{"code":"busy","detail":"x","hints":["a"]}"#);
    }
}
