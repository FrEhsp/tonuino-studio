//! File operations on the SD card and on picked folders.
//!
//! All paths are absolute and checked against the allow-list in `access.rs`.
//! Listings keep the order the OS returns: on FAT that is the on-disk
//! directory order, which is what the DFPlayer plays, so it is diagnostic
//! information and must not be sorted here.

use crate::access::Access;
use crate::error::{blocking, CmdError, CmdResult};
use crate::util::{body_bytes, header, header_u64, CancelFlags};
use crate::SharedState;
use serde::Serialize;
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::ipc::{Request, Response};
use tauri::{AppHandle, Emitter, State};

pub const EVENT_COPY_PROGRESS: &str = "copy-progress";
/// Upper bound for one read call; the bridge reads big files in chunks.
const MAX_READ: u64 = 256 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DirEntryDto {
    pub name: String,
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modified: Option<u64>,
    /// Set (true) only for write-protected entries: the FAT read-only attribute.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub read_only: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatDto {
    pub kind: &'static str,
    pub size: u64,
    pub modified: Option<u64>,
    pub read_only: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CopyProgress<'a> {
    copy_id: &'a str,
    copied: u64,
    total: u64,
}

/// Suffix of the file a replacement is written to before it takes the old
/// file's place. The app's health check treats leftovers as junk.
pub const PARTIAL_SUFFIX: &str = ".tonuino-tmp";

/// "<name>.tonuino-tmp" next to `path`.
fn partial_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    name.push(PARTIAL_SUFFIX);
    path.with_file_name(name)
}

/// Suffix of the empty marker next to a new file while it is written in
/// place. Left behind (card pulled), it tells the app's scan that the file
/// is cut off (src/core/tonuino/sd.ts OPEN_SUFFIX).
pub const OPEN_SUFFIX: &str = ".tonuino-open";

/// "<name>.tonuino-open" next to `path`.
fn open_marker(path: &Path) -> PathBuf {
    let mut name = path.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    name.push(OPEN_SUFFIX);
    path.with_file_name(name)
}

/// A file being written. A new file is written in place, so it keeps its spot
/// in the FAT directory order; an empty marker made right after it (so it
/// comes later in the order) says it is not complete yet. An existing file is
/// never truncated: the new content goes to a partial file next to it and
/// replaces it only once it is complete and flushed. A failed write (full
/// card, card pulled) therefore never costs the old content, e.g. the catalog
/// or all covers, and never leaves a cut-off file that looks complete.
pub struct Upload {
    file: File,
    target: PathBuf,
    partial: Option<PathBuf>,
    marker: Option<PathBuf>,
}

impl Upload {
    pub fn create(target: &Path) -> CmdResult<Upload> {
        let partial = target.is_file().then(|| partial_path(target));
        let path = partial.as_deref().unwrap_or(target);
        let file = File::create(path).map_err(|e| CmdError::io(&e, path.display()))?;
        // Best effort: without a marker the write still works, it is only not flagged when cut off.
        let marker = partial.is_none().then(|| open_marker(target)).filter(|m| File::create(m).is_ok());
        Ok(Upload { file, target: target.to_path_buf(), partial, marker })
    }

    fn written(&self) -> &Path {
        self.partial.as_deref().unwrap_or(&self.target)
    }

    pub fn write_all(&mut self, data: &[u8]) -> CmdResult<()> {
        self.file.write_all(data).map_err(|e| CmdError::io(&e, self.written().display()))
    }

    pub fn write_at(&mut self, offset: u64, data: &[u8]) -> CmdResult<()> {
        self.file.seek(SeekFrom::Start(offset)).map_err(|e| CmdError::io(&e, self.written().display()))?;
        self.write_all(data)
    }

    /// Flushes the data to the device, then puts a replacement in place.
    /// On failure nothing half written stays behind, and the old file is kept.
    pub fn finish(self) -> CmdResult<()> {
        let Upload { file, target, partial, marker } = self;
        let written = partial.clone().unwrap_or_else(|| target.clone());
        let synced = file.sync_all();
        drop(file);
        let result = synced.map_err(|e| CmdError::io(&e, written.display())).and_then(|()| match &partial {
            Some(p) => fs::rename(p, &target).map_err(|e| CmdError::io(&e, target.display())),
            None => Ok(()),
        });
        if result.is_err() {
            let _ = fs::remove_file(&written);
        }
        // Complete or gone: no marker either way. A file written anew also drops one an earlier, cut-off write left.
        let _ = fs::remove_file(marker.unwrap_or_else(|| open_marker(&target)));
        result
    }

    /// Gives up: removes what this upload wrote, never the old file.
    pub fn abort(self) {
        let written = self.written().to_path_buf();
        drop(self.file);
        let _ = fs::remove_file(written);
        if let Some(m) = self.marker {
            let _ = fs::remove_file(m);
        }
    }
}

type UploadSlot = Arc<Mutex<Option<Upload>>>;

/// Open chunked uploads, keyed by canonical path of the target.
#[derive(Default)]
pub struct WriteSessions {
    open: Mutex<HashMap<PathBuf, UploadSlot>>,
}

/// A chunk or a finish for an upload that is no longer open: it was ended
/// (card ejected, file removed or written again), so the rest must not land
/// in whatever file is there now.
fn upload_gone(path: &Path) -> CmdError {
    CmdError::new("io", format!("{}: the upload was interrupted", path.display()))
}

impl WriteSessions {
    fn take(&self, path: &Path) -> Option<Upload> {
        let slot = self.open.lock().ok()?.remove(path)?;
        let upload = slot.lock().ok()?.take();
        upload
    }

    fn get(&self, path: &Path) -> Option<UploadSlot> {
        self.open.lock().ok()?.get(path).cloned()
    }

    fn put(&self, path: PathBuf, upload: Upload) -> UploadSlot {
        let slot = Arc::new(Mutex::new(Some(upload)));
        if let Ok(mut open) = self.open.lock() {
            open.insert(path, slot.clone());
        }
        slot
    }

    /// One chunk. Offset 0 starts the file (see `Upload`); an upload started
    /// again at 0 drops what the earlier attempt wrote.
    pub fn chunk(&self, path: &Path, offset: u64, data: &[u8]) -> CmdResult<()> {
        let slot = if offset == 0 {
            self.discard(path);
            self.put(path.to_path_buf(), Upload::create(path)?)
        } else {
            self.get(path).ok_or_else(|| upload_gone(path))?
        };
        let mut guard = slot.lock().map_err(|_| CmdError::other("upload lock poisoned"))?;
        let upload = guard.as_mut().ok_or_else(|| upload_gone(path))?;
        upload.write_at(offset, data)
    }

    pub fn finish(&self, path: &Path) -> CmdResult<()> {
        self.take(path).ok_or_else(|| upload_gone(path))?.finish()
    }

    /// Ends an upload and removes what it wrote. True if there was one.
    pub fn discard(&self, path: &Path) -> bool {
        match self.take(path) {
            Some(upload) => {
                upload.abort();
                true
            }
            None => false,
        }
    }

    /// Like `discard`; without an open upload only a left-over partial file
    /// goes. The file itself is never touched: it may be the old content.
    pub fn abort(&self, path: &Path) {
        if !self.discard(path) {
            let _ = fs::remove_file(partial_path(path));
        }
    }

    /// Ends every upload below `root` (before ejecting a card). An upload cut
    /// off like this is incomplete, so it is dropped like a failed one.
    pub fn close_under(&self, root: &Path) {
        let root = fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
        let keys: Vec<PathBuf> = match self.open.lock() {
            Ok(open) => open.keys().filter(|k| k.starts_with(&root)).cloned().collect(),
            Err(_) => return,
        };
        for k in keys {
            self.discard(&k);
        }
    }
}

/// Cancel flags of running copies.
#[derive(Default)]
pub struct CopyJobs {
    jobs: CancelFlags,
}

fn millis(t: std::io::Result<SystemTime>) -> Option<u64> {
    t.ok()?.duration_since(UNIX_EPOCH).ok().map(|d| d.as_millis() as u64)
}

fn kind_of(meta: &fs::Metadata) -> Option<&'static str> {
    if meta.is_dir() {
        Some("directory")
    } else if meta.is_file() {
        Some("file")
    } else {
        None
    }
}

pub fn list_dir(dir: &Path) -> CmdResult<Vec<DirEntryDto>> {
    let rd = fs::read_dir(dir).map_err(|e| CmdError::io(&e, dir.display()))?;
    let mut out = Vec::new();
    for entry in rd {
        let entry = entry.map_err(|e| CmdError::io(&e, dir.display()))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let meta = match entry.file_type() {
            // Follow symlinks (picked folders on ext4); skip broken ones.
            Ok(ft) if ft.is_symlink() => match fs::metadata(entry.path()) {
                Ok(m) => m,
                Err(_) => continue,
            },
            _ => match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            },
        };
        let Some(kind) = kind_of(&meta) else { continue };
        out.push(DirEntryDto {
            name,
            kind,
            size: (kind == "file").then_some(meta.len()),
            modified: millis(meta.modified()),
            read_only: meta.permissions().readonly().then_some(true),
        });
    }
    Ok(out)
}

pub fn read_range(path: &Path, start: u64, length: u64) -> CmdResult<Vec<u8>> {
    if length > MAX_READ {
        return Err(CmdError::invalid(format!("read of {length} bytes is too large")));
    }
    let mut f = File::open(path).map_err(|e| CmdError::io(&e, path.display()))?;
    let size = f.metadata().map(|m| m.len()).unwrap_or(0);
    let length = length.min(size.saturating_sub(start));
    let mut buf = vec![0u8; length as usize];
    if length > 0 {
        f.seek(SeekFrom::Start(start)).map_err(|e| CmdError::io(&e, path.display()))?;
        f.read_exact(&mut buf).map_err(|e| CmdError::io(&e, path.display()))?;
    }
    Ok(buf)
}

/// Writes a whole file and flushes it; an existing file is replaced only by
/// complete new content (see `Upload`).
pub fn write_whole(path: &Path, data: &[u8]) -> CmdResult<()> {
    let mut upload = Upload::create(path)?;
    if let Err(e) = upload.write_all(data) {
        upload.abort();
        return Err(e);
    }
    upload.finish()
}

/// True when both paths name the same existing file (e.g. a case-only rename on FAT).
fn same_file(a: &Path, b: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        match (fs::metadata(a), fs::metadata(b)) {
            (Ok(x), Ok(y)) => x.dev() == y.dev() && x.ino() == y.ino(),
            _ => false,
        }
    }
    #[cfg(not(unix))]
    {
        a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase()
    }
}

/// Renames without ever replacing another file silently.
pub fn rename_no_clobber(from: &Path, to: &Path) -> CmdResult<()> {
    fs::symlink_metadata(from).map_err(|e| CmdError::io(&e, from.display()))?;
    if fs::symlink_metadata(to).is_ok() && !same_file(from, to) {
        return Err(CmdError::new("exists", format!("{} already exists", to.display())));
    }
    fs::rename(from, to).map_err(|e| CmdError::io(&e, format!("{} -> {}", from.display(), to.display())))
}

fn copy_file(
    from: &Path,
    to: &Path,
    cancel: &AtomicBool,
    mut progress: impl FnMut(u64, u64),
) -> CmdResult<u64> {
    let mut src = File::open(from).map_err(|e| CmdError::io(&e, from.display()))?;
    let total = src.metadata().map(|m| m.len()).unwrap_or(0);
    let mut dst = Upload::create(to)?;
    let result = (|| {
        let mut buf = vec![0u8; 1024 * 1024];
        let mut copied = 0u64;
        let mut last = Instant::now();
        loop {
            if cancel.load(Ordering::Relaxed) {
                return Err(CmdError::new("cancelled", "copy cancelled"));
            }
            let n = src.read(&mut buf).map_err(|e| CmdError::io(&e, from.display()))?;
            if n == 0 {
                break;
            }
            dst.write_all(&buf[..n])?;
            copied += n as u64;
            if last.elapsed() >= Duration::from_millis(100) {
                progress(copied, total);
                last = Instant::now();
            }
        }
        Ok(copied)
    })();
    // A cancelled or failed copy leaves nothing half written, and an older file stays as it was.
    let copied = match result {
        Ok(n) => n,
        Err(e) => {
            dst.abort();
            return Err(e);
        }
    };
    dst.finish()?;
    progress(copied, total);
    Ok(copied)
}

/* ------------------------------------------------------------ commands */

#[tauri::command]
pub async fn fs_list(state: State<'_, SharedState>, path: String) -> CmdResult<Vec<DirEntryDto>> {
    let st = state.inner().clone();
    blocking(move || list_dir(&st.access.check(&path, Access::Read)?)).await
}

#[tauri::command]
pub async fn fs_read(state: State<'_, SharedState>, path: String) -> CmdResult<Response> {
    let st = state.inner().clone();
    blocking(move || {
        let p = st.access.check(&path, Access::Read)?;
        let size = fs::metadata(&p).map_err(|e| CmdError::io(&e, &path))?.len();
        Ok(Response::new(read_range(&p, 0, size)?))
    })
    .await
}

#[tauri::command]
pub async fn fs_read_range(state: State<'_, SharedState>, path: String, start: u64, length: u64) -> CmdResult<Response> {
    let st = state.inner().clone();
    blocking(move || Ok(Response::new(read_range(&st.access.check(&path, Access::Read)?, start, length)?))).await
}

/// Raw body = file content; header `x-path` = URI-encoded absolute path.
/// Creates or replaces the file, writes it and flushes it to the device. An
/// existing file is only replaced by the complete new content.
#[tauri::command]
pub async fn fs_write(state: State<'_, SharedState>, request: Request<'_>) -> CmdResult<()> {
    let st = state.inner().clone();
    let path = header(&request, "x-path")?;
    let data = body_bytes(&request)?;
    blocking(move || {
        let p = st.access.check(&path, Access::Write)?;
        st.writes.discard(&p);
        write_whole(&p, &data)
    })
    .await
}

/// One chunk of a big upload. Headers: `x-path`, `x-offset`. Offset 0 starts
/// the upload; an existing file stays as it is until `fs_write_finish`.
#[tauri::command]
pub async fn fs_write_chunk(state: State<'_, SharedState>, request: Request<'_>) -> CmdResult<()> {
    let st = state.inner().clone();
    let path = header(&request, "x-path")?;
    let offset = header_u64(&request, "x-offset")?;
    let data = body_bytes(&request)?;
    blocking(move || st.writes.chunk(&st.access.check(&path, Access::Write)?, offset, &data)).await
}

/// Flushes a chunked upload and puts it in place of an older file.
#[tauri::command]
pub async fn fs_write_finish(state: State<'_, SharedState>, path: String) -> CmdResult<()> {
    let st = state.inner().clone();
    blocking(move || st.writes.finish(&st.access.check(&path, Access::Write)?)).await
}

/// Cancels a chunked upload and removes what it wrote. An older file at the
/// path stays untouched.
#[tauri::command]
pub async fn fs_write_abort(state: State<'_, SharedState>, path: String) -> CmdResult<()> {
    let st = state.inner().clone();
    blocking(move || {
        st.writes.abort(&st.access.check(&path, Access::Write)?);
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn fs_mkdir(state: State<'_, SharedState>, path: String, recursive: Option<bool>) -> CmdResult<()> {
    let st = state.inner().clone();
    blocking(move || {
        let p = st.access.check(&path, Access::Write)?;
        let result = if recursive.unwrap_or(false) { fs::create_dir_all(&p) } else { fs::create_dir(&p) };
        match result {
            Ok(()) => Ok(()),
            Err(_) if p.is_dir() => Ok(()),
            Err(_) if p.exists() => Err(CmdError::new("not-a-directory", format!("{path} is a file"))),
            Err(e) => Err(CmdError::io(&e, &path)),
        }
    })
    .await
}

#[tauri::command]
pub async fn fs_remove(state: State<'_, SharedState>, path: String, recursive: Option<bool>) -> CmdResult<()> {
    let st = state.inner().clone();
    blocking(move || {
        let p = st.access.check(&path, Access::Write)?;
        if st.access.is_protected_root(&p) {
            return Err(CmdError::not_allowed(format!("{path} is a card or a picked folder")));
        }
        let had_upload = st.writes.discard(&p);
        let meta = match fs::symlink_metadata(&p) {
            // The upload was a new file, and discarding it removed it already.
            Err(e) if had_upload && e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            meta => meta.map_err(|e| CmdError::io(&e, &path))?,
        };
        let result = if meta.is_dir() {
            if recursive.unwrap_or(false) { fs::remove_dir_all(&p) } else { fs::remove_dir(&p) }
        } else {
            fs::remove_file(&p)
        };
        result.map_err(|e| CmdError::io(&e, &path))
    })
    .await
}

#[tauri::command]
pub async fn fs_rename(state: State<'_, SharedState>, from: String, to: String) -> CmdResult<()> {
    let st = state.inner().clone();
    blocking(move || {
        let a = st.access.check(&from, Access::Write)?;
        let b = st.access.check(&to, Access::Write)?;
        if st.access.is_protected_root(&a) {
            return Err(CmdError::not_allowed(format!("{from} is a card or a picked folder")));
        }
        rename_no_clobber(&a, &b)
    })
    .await
}

#[tauri::command]
pub async fn fs_exists(state: State<'_, SharedState>, path: String) -> CmdResult<bool> {
    let st = state.inner().clone();
    blocking(move || Ok(fs::metadata(st.access.check(&path, Access::Read)?).is_ok())).await
}

#[tauri::command]
pub async fn fs_stat(state: State<'_, SharedState>, path: String) -> CmdResult<StatDto> {
    let st = state.inner().clone();
    blocking(move || {
        let p = st.access.check(&path, Access::Read)?;
        let meta = fs::metadata(&p).map_err(|e| CmdError::io(&e, &path))?;
        Ok(StatDto {
            kind: kind_of(&meta).unwrap_or("other"),
            size: meta.len(),
            modified: millis(meta.modified()),
            read_only: meta.permissions().readonly(),
        })
    })
    .await
}

/// Clears the write protection of one entry; true when it had one.
fn clear_read_only(path: &Path) -> CmdResult<bool> {
    let meta = fs::metadata(path).map_err(|e| CmdError::io(&e, path.display()))?;
    let mut perms = meta.permissions();
    if !perms.readonly() {
        return Ok(false);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // Owner write only: on FAT this clears the read-only attribute.
        perms.set_mode(perms.mode() | 0o200);
    }
    #[cfg(not(unix))]
    #[allow(clippy::permissions_set_readonly_false)]
    perms.set_readonly(false);
    fs::set_permissions(path, perms).map_err(|e| CmdError::io(&e, path.display()))?;
    Ok(true)
}

/// Clears write protection below `dir`, at most `depth` levels deep; counts what changed.
fn clear_read_only_below(dir: &Path, depth: u32, changed: &mut u32) -> CmdResult<()> {
    for entry in fs::read_dir(dir).map_err(|e| CmdError::io(&e, dir.display()))?.flatten() {
        let Ok(ft) = entry.file_type() else { continue };
        if ft.is_symlink() {
            continue;
        }
        let p = entry.path();
        if clear_read_only(&p)? {
            *changed += 1;
        }
        if ft.is_dir() && depth > 0 {
            clear_read_only_below(&p, depth - 1, changed)?;
        }
    }
    Ok(())
}

/// Removes the write protection (FAT read-only attribute) of the given
/// entries below a card, or of everything on it up to three levels deep when
/// `paths` is empty. Returns how many entries changed.
#[tauri::command]
pub async fn fs_make_writable(state: State<'_, SharedState>, root: String, paths: Vec<String>) -> CmdResult<u32> {
    let st = state.inner().clone();
    blocking(move || {
        let base = st.access.check(&root, Access::Write)?;
        let mut changed = 0;
        if paths.is_empty() {
            clear_read_only_below(&base, 3, &mut changed)?;
            return Ok(changed);
        }
        for rel in paths {
            if rel.split(['/', '\\']).any(|part| part.is_empty() || part == "." || part == "..") {
                return Err(CmdError::invalid(format!("bad path {rel}")));
            }
            let p = st.access.check(&base.join(&rel).to_string_lossy(), Access::Write)?;
            if clear_read_only(&p)? {
                changed += 1;
            }
        }
        Ok(changed)
    })
    .await
}

/// Copies a file natively (no bytes through the WebView), flushes it and
/// emits `copy-progress` {copyId, copied, total}. Returns the bytes copied.
#[tauri::command]
pub async fn fs_copy(
    app: AppHandle,
    state: State<'_, SharedState>,
    from: String,
    to: String,
    copy_id: Option<String>,
) -> CmdResult<u64> {
    let st = state.inner().clone();
    blocking(move || {
        let a = st.access.check(&from, Access::Read)?;
        let b = st.access.check(&to, Access::Write)?;
        if a == b {
            return Err(CmdError::invalid("source and target are the same file"));
        }
        let id = copy_id.unwrap_or_default();
        let cancel = if id.is_empty() { Arc::new(AtomicBool::new(false)) } else { st.copies.jobs.register(&id) };
        let result = copy_file(&a, &b, &cancel, |copied, total| {
            if !id.is_empty() {
                let _ = app.emit(EVENT_COPY_PROGRESS, CopyProgress { copy_id: &id, copied, total });
            }
        });
        if !id.is_empty() {
            st.copies.jobs.finish(&id);
        }
        result
    })
    .await
}

#[tauri::command]
pub fn fs_copy_cancel(state: State<'_, SharedState>, copy_id: String) {
    state.copies.jobs.cancel(&copy_id);
}

/* ---------------------------------------------------------- temp files */

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// The app's folder for temp files. On Unix every account shares the system
/// temp folder, so each user gets a folder of their own (`private_temp_dir`).
pub fn temp_dir() -> PathBuf {
    #[cfg(unix)]
    {
        // SAFETY: geteuid has no preconditions and cannot fail.
        let uid = unsafe { libc::geteuid() };
        std::env::temp_dir().join(format!("tonuino-studio-{uid}"))
    }
    #[cfg(not(unix))]
    std::env::temp_dir().join("tonuino-studio")
}

/// `temp_dir()`, created if needed and closed to other accounts. In the
/// shared temp folder another account could create the folder first and then
/// read or swap the files the app puts there.
pub(crate) fn private_temp_dir() -> CmdResult<PathBuf> {
    let dir = temp_dir();
    #[cfg(unix)]
    {
        // SAFETY: geteuid has no preconditions and cannot fail.
        make_private_dir(&dir, unsafe { libc::geteuid() })?;
    }
    #[cfg(not(unix))]
    fs::create_dir_all(&dir).map_err(|e| CmdError::io(&e, dir.display()))?;
    Ok(dir)
}

/// Creates `dir` with mode 0700. An existing one is used only when it is a
/// real folder (not a link) of `owner`, and is closed to everybody else.
#[cfg(unix)]
fn make_private_dir(dir: &Path, owner: u32) -> CmdResult<()> {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
    fs::DirBuilder::new().recursive(true).mode(0o700).create(dir).map_err(|e| CmdError::io(&e, dir.display()))?;
    let meta = fs::symlink_metadata(dir).map_err(|e| CmdError::io(&e, dir.display()))?;
    if !meta.is_dir() || meta.uid() != owner {
        return Err(CmdError::not_allowed(format!("{} belongs to another account", dir.display())));
    }
    if meta.mode() & 0o077 != 0 {
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700)).map_err(|e| CmdError::io(&e, dir.display()))?;
    }
    Ok(())
}

/// Creates an empty temp file (e.g. to analyse audio that only exists in
/// memory) and grants read/write access to it.
#[tauri::command]
pub async fn fs_temp_file(state: State<'_, SharedState>, extension: Option<String>) -> CmdResult<String> {
    let st = state.inner().clone();
    blocking(move || {
        let dir = private_temp_dir()?;
        let ext: String = extension.unwrap_or_default().chars().filter(|c| c.is_ascii_alphanumeric()).take(8).collect();
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let n = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let name = if ext.is_empty() {
            format!("tmp-{}-{nanos}-{n}", std::process::id())
        } else {
            format!("tmp-{}-{nanos}-{n}.{ext}", std::process::id())
        };
        let path = dir.join(name);
        File::create(&path).map_err(|e| CmdError::io(&e, path.display()))?;
        st.access.grant_file(&path, true)?;
        Ok(path.to_string_lossy().into_owned())
    })
    .await
}

#[tauri::command]
pub async fn fs_temp_remove(state: State<'_, SharedState>, path: String) -> CmdResult<()> {
    let st = state.inner().clone();
    blocking(move || {
        let p = st.access.check(&path, Access::Write)?;
        let dir = fs::canonicalize(temp_dir()).map_err(|e| CmdError::io(&e, "temp dir"))?;
        if !p.starts_with(&dir) {
            return Err(CmdError::not_allowed("not a temp file"));
        }
        st.audio.close_under(&p);
        fs::remove_file(&p).or_else(|e| if e.kind() == std::io::ErrorKind::NotFound { Ok(()) } else { Err(e) }).map_err(|e| CmdError::io(&e, &path))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(PathBuf);
    impl TempDir {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("tonuino-fsops-{tag}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            TempDir(fs::canonicalize(&dir).unwrap())
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[cfg(unix)]
    #[test]
    fn temp_folder_is_private_to_this_user() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        // SAFETY: geteuid has no preconditions.
        let me = unsafe { libc::geteuid() };
        assert!(temp_dir().ends_with(format!("tonuino-studio-{me}")), "one folder per account");
        let tmp = TempDir::new("private");
        let dir = tmp.0.join("tonuino-studio");
        make_private_dir(&dir, me).unwrap();
        assert_eq!(fs::metadata(&dir).unwrap().mode() & 0o777, 0o700);
        // A folder of this user that others may enter is closed first.
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o777)).unwrap();
        make_private_dir(&dir, me).unwrap();
        assert_eq!(fs::metadata(&dir).unwrap().mode() & 0o777, 0o700);
        // A folder another account made beforehand is not used, nor a link.
        assert_eq!(make_private_dir(&dir, me.wrapping_add(1)).unwrap_err().code, "not-allowed");
        let link = tmp.0.join("link");
        std::os::unix::fs::symlink(&dir, &link).unwrap();
        assert_eq!(make_private_dir(&link, me).unwrap_err().code, "not-allowed");
    }

    #[test]
    fn lists_without_sorting_and_with_kinds() {
        let tmp = TempDir::new("list");
        fs::create_dir(tmp.0.join("01")).unwrap();
        fs::write(tmp.0.join("tonuino-studio.json"), b"{}").unwrap();
        let entries = list_dir(&tmp.0).unwrap();
        // Same order as the OS returns it.
        let os_order: Vec<String> = fs::read_dir(&tmp.0).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(entries.iter().map(|e| e.name.clone()).collect::<Vec<_>>(), os_order);
        let dir = entries.iter().find(|e| e.name == "01").unwrap();
        assert_eq!(dir.kind, "directory");
        assert_eq!(dir.size, None);
        let file = entries.iter().find(|e| e.name == "tonuino-studio.json").unwrap();
        assert_eq!((file.kind, file.size), ("file", Some(2)));
        assert!(file.modified.unwrap() > 1_600_000_000_000);
    }

    #[test]
    fn reports_and_clears_write_protection() {
        let tmp = TempDir::new("ro");
        fs::create_dir(tmp.0.join("01")).unwrap();
        let f = tmp.0.join("01/001.mp3");
        fs::write(&f, b"x").unwrap();
        let mut p = fs::metadata(&f).unwrap().permissions();
        p.set_readonly(true);
        fs::set_permissions(&f, p).unwrap();
        let entries = list_dir(&tmp.0.join("01")).unwrap();
        assert_eq!(entries[0].read_only, Some(true));
        assert_eq!(list_dir(&tmp.0).unwrap()[0].read_only, None, "writable entries carry no flag");
        let mut changed = 0;
        clear_read_only_below(&tmp.0, 3, &mut changed).unwrap();
        assert_eq!(changed, 1);
        assert!(!fs::metadata(&f).unwrap().permissions().readonly());
        assert!(!clear_read_only(&f).unwrap(), "nothing left to clear");
    }

    #[test]
    fn reads_ranges_and_clamps_at_eof() {
        let tmp = TempDir::new("range");
        let p = tmp.0.join("a.bin");
        write_whole(&p, &(0u8..100).collect::<Vec<_>>()).unwrap();
        assert_eq!(read_range(&p, 10, 5).unwrap(), vec![10, 11, 12, 13, 14]);
        assert_eq!(read_range(&p, 95, 50).unwrap(), vec![95, 96, 97, 98, 99]);
        assert!(read_range(&p, 200, 10).unwrap().is_empty());
        assert_eq!(read_range(&tmp.0.join("missing"), 0, 1).unwrap_err().code, "not-found");
    }

    #[test]
    fn rename_never_clobbers() {
        let tmp = TempDir::new("rename");
        let a = tmp.0.join("001.mp3");
        let b = tmp.0.join("002.mp3");
        fs::write(&a, b"a").unwrap();
        fs::write(&b, b"b").unwrap();
        assert_eq!(rename_no_clobber(&a, &b).unwrap_err().code, "exists");
        assert_eq!(fs::read(&b).unwrap(), b"b");
        let c = tmp.0.join("003.mp3");
        rename_no_clobber(&a, &c).unwrap();
        assert!(!a.exists() && c.exists());
        assert_eq!(rename_no_clobber(&a, &tmp.0.join("x")).unwrap_err().code, "not-found");
    }

    #[test]
    fn copies_with_progress_and_cancel() {
        let tmp = TempDir::new("copy");
        let src = tmp.0.join("src.bin");
        let data: Vec<u8> = (0..3_000_000u32).map(|i| (i % 251) as u8).collect();
        fs::write(&src, &data).unwrap();
        let dst = tmp.0.join("dst.bin");
        let mut last = (0, 0);
        let n = copy_file(&src, &dst, &AtomicBool::new(false), |c, t| last = (c, t)).unwrap();
        assert_eq!(n, data.len() as u64);
        assert_eq!(last, (n, n));
        assert_eq!(fs::read(&dst).unwrap(), data);

        let dst2 = tmp.0.join("cancelled.bin");
        let err = copy_file(&src, &dst2, &AtomicBool::new(true), |_, _| {}).unwrap_err();
        assert_eq!(err.code, "cancelled");
        assert!(!dst2.exists(), "partial copies are removed");
    }

    #[test]
    fn write_sessions_close_under_root() {
        let tmp = TempDir::new("sessions");
        let p = tmp.0.join("big.mp3");
        let old = tmp.0.join("old.mp3");
        fs::write(&old, b"old").unwrap();
        let sessions = WriteSessions::default();
        sessions.chunk(&p, 0, b"abc").unwrap();
        sessions.chunk(&old, 0, b"new").unwrap();
        assert!(sessions.get(&p).is_some());
        sessions.close_under(&tmp.0);
        assert!(sessions.get(&p).is_none());
        // Cut off means incomplete: the new file goes, the old one stays as it was.
        assert!(!p.exists());
        assert_eq!(fs::read(&old).unwrap(), b"old");
        assert!(!partial_path(&old).exists());
    }

    #[test]
    fn replaces_a_file_only_with_complete_content() {
        let tmp = TempDir::new("replace");
        let p = tmp.0.join("tonuino-studio.json");
        fs::write(&p, b"old catalog").unwrap();
        let mut upload = Upload::create(&p).unwrap();
        upload.write_all(b"new").unwrap();
        // Until the new content is complete, the old file is untouched.
        assert_eq!(fs::read(&p).unwrap(), b"old catalog");
        upload.finish().unwrap();
        assert_eq!(fs::read(&p).unwrap(), b"new");
        assert!(!partial_path(&p).exists());

        write_whole(&p, b"newer").unwrap();
        assert_eq!(fs::read(&p).unwrap(), b"newer");
        assert_eq!(list_dir(&tmp.0).unwrap().len(), 1, "no partial file stays behind");
    }

    #[test]
    fn chunked_upload_replaces_on_finish() {
        let tmp = TempDir::new("chunks");
        let p = tmp.0.join("001.mp3");
        fs::write(&p, b"old").unwrap();
        let sessions = WriteSessions::default();
        sessions.chunk(&p, 0, b"abc").unwrap();
        sessions.chunk(&p, 3, b"def").unwrap();
        assert_eq!(fs::read(&p).unwrap(), b"old");
        sessions.finish(&p).unwrap();
        assert_eq!(fs::read(&p).unwrap(), b"abcdef");
        assert!(!partial_path(&p).exists());

        let n = tmp.0.join("002.mp3");
        sessions.chunk(&n, 0, b"abc").unwrap();
        sessions.chunk(&n, 3, b"def").unwrap();
        sessions.finish(&n).unwrap();
        assert_eq!(fs::read(&n).unwrap(), b"abcdef");
    }

    #[test]
    fn aborted_upload_keeps_the_old_file() {
        let tmp = TempDir::new("abort");
        let p = tmp.0.join("covers.json");
        fs::write(&p, b"all covers").unwrap();
        let sessions = WriteSessions::default();
        sessions.chunk(&p, 0, b"half").unwrap();
        sessions.abort(&p);
        assert_eq!(fs::read(&p).unwrap(), b"all covers");
        assert!(!partial_path(&p).exists());

        // The bridge also aborts when the very first chunk never arrived.
        sessions.abort(&p);
        assert_eq!(fs::read(&p).unwrap(), b"all covers");

        let n = tmp.0.join("new.mp3");
        sessions.chunk(&n, 0, b"half").unwrap();
        sessions.abort(&n);
        assert!(!n.exists(), "a new file that was not finished goes away");
    }

    #[test]
    fn marks_a_new_file_until_it_is_complete() {
        let tmp = TempDir::new("marker");
        let n = tmp.0.join("002.mp3");
        let sessions = WriteSessions::default();
        sessions.chunk(&n, 0, b"half").unwrap();
        assert!(open_marker(&n).exists(), "while it is written, the marker says so");
        sessions.finish(&n).unwrap();
        assert!(!open_marker(&n).exists());
        // A card pulled mid-write leaves file and marker; writing the file again clears the marker.
        fs::write(open_marker(&n), b"").unwrap();
        write_whole(&n, b"whole").unwrap();
        assert!(!open_marker(&n).exists());
        assert_eq!(list_dir(&tmp.0).unwrap().len(), 1);
        // Replacing goes through the partial file: no marker needed, none made.
        let upload = Upload::create(&n).unwrap();
        assert!(!open_marker(&n).exists());
        upload.abort();
        // A new file given up goes with its marker.
        let m = tmp.0.join("003.mp3");
        sessions.chunk(&m, 0, b"half").unwrap();
        sessions.abort(&m);
        assert!(!m.exists() && !open_marker(&m).exists());
    }

    #[test]
    fn interrupted_upload_does_not_write_into_the_old_file() {
        let tmp = TempDir::new("gone");
        let p = tmp.0.join("001.mp3");
        fs::write(&p, b"old content").unwrap();
        let sessions = WriteSessions::default();
        sessions.chunk(&p, 0, b"new").unwrap();
        sessions.close_under(&tmp.0);
        assert_eq!(sessions.chunk(&p, 3, b"xyz").unwrap_err().code, "io");
        assert_eq!(sessions.finish(&p).unwrap_err().code, "io");
        assert_eq!(fs::read(&p).unwrap(), b"old content");
        assert!(!partial_path(&p).exists());
    }

    #[test]
    fn cancelled_copy_keeps_an_existing_target() {
        let tmp = TempDir::new("copy-keep");
        let src = tmp.0.join("src.bin");
        fs::write(&src, vec![7u8; 3_000_000]).unwrap();
        let dst = tmp.0.join("dst.bin");
        fs::write(&dst, b"old").unwrap();
        let err = copy_file(&src, &dst, &AtomicBool::new(true), |_, _| {}).unwrap_err();
        assert_eq!(err.code, "cancelled");
        assert_eq!(fs::read(&dst).unwrap(), b"old");
        assert!(!partial_path(&dst).exists());
        copy_file(&src, &dst, &AtomicBool::new(false), |_, _| {}).unwrap();
        assert_eq!(fs::read(&dst).unwrap().len(), 3_000_000);
        assert!(!partial_path(&dst).exists());
    }
}
