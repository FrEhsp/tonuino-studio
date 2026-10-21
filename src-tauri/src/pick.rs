//! Native file dialogs and file drops. Everything the user picks or drops is
//! registered in the allow-list, so the WebView can read it afterwards.

use crate::error::{blocking, CmdError, CmdResult};
use crate::util::natural_cmp;
use crate::SharedState;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::{DialogExt, FileDialogBuilder, FilePath};

/// Safety net against dropping a whole home folder.
const MAX_FILES: usize = 20_000;
const MAX_DEPTH: usize = 16;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PickedFile {
    pub path: String,
    pub name: String,
    pub size: u64,
    /// Path inside the picked or dropped folder, starting with that folder's
    /// own name ("Hörspiel/CD1/01.mp3"), always with "/".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub relative_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickedFolder {
    pub path: String,
    pub name: String,
    /// Files inside (recursively) for import folders.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub files: Option<Vec<PickedFile>>,
}

/// Names operating systems leave behind; never offered for import.
fn is_junk(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    n.starts_with('.')
        || matches!(n.as_str(), "thumbs.db" | "desktop.ini" | "system volume information" | "$recycle.bin" | "recycler")
}

fn matches_ext(name: &str, extensions: &[String]) -> bool {
    if extensions.is_empty() {
        return true;
    }
    match Path::new(name).extension().and_then(|e| e.to_str()) {
        Some(ext) => extensions.iter().any(|x| x.eq_ignore_ascii_case(ext)),
        None => false,
    }
}

/// Lists all files below `root` (no symlinked folders, no junk), sorted
/// naturally by relative path. Like the browser's `webkitRelativePath`, the
/// relative path starts with the folder's own name ("Hörspiel/CD1/01.mp3"),
/// so album grouping sees the same paths on every platform.
pub fn walk(root: &Path, extensions: &[String]) -> CmdResult<Vec<PickedFile>> {
    let mut out = Vec::new();
    let top = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let mut stack: Vec<(PathBuf, String, usize)> = vec![(root.to_path_buf(), top, 0)];
    while let Some((dir, prefix, depth)) = stack.pop() {
        let rd = fs::read_dir(&dir).map_err(|e| CmdError::io(&e, dir.display()))?;
        for entry in rd.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if is_junk(&name) {
                continue;
            }
            let Ok(ft) = entry.file_type() else { continue };
            let rel = if prefix.is_empty() { name.clone() } else { format!("{prefix}/{name}") };
            if ft.is_dir() {
                if depth < MAX_DEPTH {
                    stack.push((entry.path(), rel, depth + 1));
                }
                continue;
            }
            // Regular files and symlinks to files.
            let Ok(meta) = fs::metadata(entry.path()) else { continue };
            if !meta.is_file() || !matches_ext(&name, extensions) {
                continue;
            }
            if out.len() >= MAX_FILES {
                return Err(CmdError::new("too-many-files", format!("more than {MAX_FILES} files in {}", root.display())));
            }
            out.push(PickedFile {
                path: entry.path().to_string_lossy().into_owned(),
                name,
                size: meta.len(),
                relative_path: Some(rel),
            });
        }
    }
    out.sort_by(|a, b| {
        natural_cmp(a.relative_path.as_deref().unwrap_or(""), b.relative_path.as_deref().unwrap_or(""))
    });
    Ok(out)
}

fn picked_file(path: &Path) -> CmdResult<PickedFile> {
    let meta = fs::metadata(path).map_err(|e| CmdError::io(&e, path.display()))?;
    Ok(PickedFile {
        path: path.to_string_lossy().into_owned(),
        name: path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        size: meta.len(),
        relative_path: None,
    })
}

fn into_path(fp: FilePath) -> CmdResult<PathBuf> {
    fp.into_path().map_err(|e| CmdError::other(format!("dialog returned no local path: {e}")))
}

fn dialog(app: &AppHandle, title: Option<String>) -> FileDialogBuilder<tauri::Wry> {
    let mut builder = app.dialog().file();
    if let Some(window) = app.get_webview_window("main") {
        builder = builder.set_parent(&window);
    }
    if let Some(t) = title {
        builder = builder.set_title(t);
    }
    builder
}

fn with_filter(builder: FileDialogBuilder<tauri::Wry>, extensions: &[String]) -> FileDialogBuilder<tauri::Wry> {
    if extensions.is_empty() {
        return builder;
    }
    // GTK matches patterns case-sensitively: offer both spellings.
    let mut all: Vec<String> = Vec::new();
    for e in extensions {
        let e = e.trim_start_matches('.');
        for v in [e.to_ascii_lowercase(), e.to_ascii_uppercase()] {
            if !all.contains(&v) {
                all.push(v);
            }
        }
    }
    let refs: Vec<&str> = all.iter().map(String::as_str).collect();
    let label = extensions.iter().map(|e| e.trim_start_matches('.').to_ascii_uppercase()).collect::<Vec<_>>().join(", ");
    builder.add_filter(label, &refs)
}

#[tauri::command]
pub async fn dialog_pick_files(
    app: AppHandle,
    state: State<'_, SharedState>,
    multiple: Option<bool>,
    extensions: Option<Vec<String>>,
    title: Option<String>,
) -> CmdResult<Vec<PickedFile>> {
    let st = state.inner().clone();
    blocking(move || {
        let builder = with_filter(dialog(&app, title), &extensions.unwrap_or_default());
        let picked: Vec<FilePath> = if multiple.unwrap_or(false) {
            builder.blocking_pick_files().unwrap_or_default()
        } else {
            builder.blocking_pick_file().into_iter().collect()
        };
        let mut out = Vec::new();
        for fp in picked {
            let path = into_path(fp)?;
            st.access.grant_file(&path, false)?;
            out.push(picked_file(&path)?);
        }
        Ok(out)
    })
    .await
}

/// `purpose`: "card" (read/write, the app manages this folder like an SD
/// card) or "import" (read-only; the files inside are listed recursively).
#[tauri::command]
pub async fn dialog_pick_folder(
    app: AppHandle,
    state: State<'_, SharedState>,
    purpose: String,
    extensions: Option<Vec<String>>,
    title: Option<String>,
) -> CmdResult<Option<PickedFolder>> {
    let st = state.inner().clone();
    blocking(move || {
        let write = match purpose.as_str() {
            "card" => true,
            "import" => false,
            other => return Err(CmdError::invalid(format!("unknown purpose {other}"))),
        };
        let Some(fp) = dialog(&app, title).blocking_pick_folder() else { return Ok(None) };
        let path = into_path(fp)?;
        st.access.grant_tree(&path, write)?;
        let files = if write { None } else { Some(walk(&path, &extensions.unwrap_or_default())?) };
        Ok(Some(PickedFolder {
            name: path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.to_string_lossy().into_owned()),
            path: path.to_string_lossy().into_owned(),
            files,
        }))
    })
    .await
}

/// Save dialog. Returns the chosen path (write access granted) or null.
#[tauri::command]
pub async fn dialog_save(
    app: AppHandle,
    state: State<'_, SharedState>,
    suggested_name: String,
    title: Option<String>,
) -> CmdResult<Option<String>> {
    let st = state.inner().clone();
    blocking(move || {
        let mut builder = dialog(&app, title).set_file_name(&suggested_name);
        if let Some(ext) = Path::new(&suggested_name).extension().and_then(|e| e.to_str()) {
            builder = with_filter(builder, &[ext.to_string()]);
        }
        let Some(fp) = builder.blocking_save_file() else { return Ok(None) };
        let path = into_path(fp)?;
        st.access.grant_new_file(&path)?;
        Ok(Some(path.to_string_lossy().into_owned()))
    })
    .await
}

fn resolve_dropped(st: &crate::AppState, raw: &str, extensions: &[String]) -> CmdResult<Vec<PickedFile>> {
    let path = PathBuf::from(raw);
    // The window event that records the drop may run a moment later.
    let mut dropped = st.access.was_dropped(&path);
    for _ in 0..10 {
        if dropped {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(30));
        dropped = st.access.was_dropped(&path);
    }
    if !dropped {
        return Err(CmdError::not_allowed(format!("{raw} was not dropped onto the window")));
    }
    let meta = fs::metadata(&path).map_err(|e| CmdError::io(&e, raw))?;
    if meta.is_dir() {
        st.access.grant_tree(&path, false)?;
        walk(&path, extensions)
    } else {
        st.access.grant_file(&path, false)?;
        Ok(vec![picked_file(&path)?])
    }
}

/// Turns natively dropped paths into readable files. Only paths that really
/// arrived through a native drop are accepted. Folders are expanded like in
/// `walk`. Unreadable items are skipped; the call fails only when nothing
/// could be read.
#[tauri::command]
pub async fn drop_resolve(
    state: State<'_, SharedState>,
    paths: Vec<String>,
    extensions: Option<Vec<String>>,
) -> CmdResult<Vec<PickedFile>> {
    let st = state.inner().clone();
    blocking(move || {
        let extensions = extensions.unwrap_or_default();
        let mut out = Vec::new();
        let mut first_error = None;
        for raw in &paths {
            match resolve_dropped(&st, raw, &extensions) {
                Ok(files) => out.extend(files),
                Err(e) => {
                    log::warn!("drop of {raw} ignored: {e}");
                    first_error.get_or_insert(e);
                }
            }
        }
        match first_error {
            Some(e) if out.is_empty() => Err(e),
            _ => Ok(out),
        }
    })
    .await
}

/// Most files `downloads_recent` lists, newest first.
const MAX_RECENT: usize = 20;
/// Endings of files a browser is still writing; the finished file gets the real name.
const PARTIAL: &[&str] = &["part", "crdownload", "download", "partial", "opdownload", "tmp"];

/// A file in the user's download folder.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecentFile {
    pub path: String,
    pub name: String,
    pub size: u64,
    /// Last change, milliseconds since 1970.
    pub modified_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentDownloads {
    /// The download folder, None when the system names none.
    pub folder: Option<String>,
    pub files: Vec<RecentFile>,
}

/// Files directly in `dir` (no subfolders) with one of `extensions`, changed
/// at or after `since_ms`, not empty and not still being written (Firefox
/// keeps "x.mp3.part" beside an empty "x.mp3" until it is done). Newest
/// first, at most MAX_RECENT.
pub fn recent_in(dir: &Path, since_ms: u64, extensions: &[String]) -> Vec<RecentFile> {
    let Ok(rd) = fs::read_dir(dir) else { return Vec::new() };
    let mut out = Vec::new();
    for entry in rd.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if is_junk(&name) || extensions.is_empty() || !matches_ext(&name, extensions) {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() || meta.len() == 0 {
            continue;
        }
        let modified_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        if modified_ms < since_ms {
            continue;
        }
        if PARTIAL.iter().any(|p| dir.join(format!("{name}.{p}")).exists()) {
            continue;
        }
        out.push(RecentFile { path: entry.path().to_string_lossy().into_owned(), name, size: meta.len(), modified_ms });
    }
    out.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms).then_with(|| natural_cmp(&a.name, &b.name)));
    out.truncate(MAX_RECENT);
    out
}

/// Audio files that arrived in the user's download folder since `since_ms`
/// ("Entdecken": the episode the user just saved on the publisher's page).
/// Only files with the given extensions are listed, and only those may be
/// read afterwards; nothing else in the folder is opened.
#[tauri::command]
pub async fn downloads_recent(
    app: AppHandle,
    state: State<'_, SharedState>,
    since_ms: u64,
    extensions: Vec<String>,
) -> CmdResult<RecentDownloads> {
    let st = state.inner().clone();
    let dir = app.path().download_dir().ok();
    blocking(move || {
        let Some(dir) = dir else { return Ok(RecentDownloads { folder: None, files: Vec::new() }) };
        let mut files = Vec::new();
        for f in recent_in(&dir, since_ms, &extensions) {
            if st.access.grant_file(Path::new(&f.path), false).is_ok() {
                files.push(f);
            }
        }
        Ok(RecentDownloads { folder: Some(dir.to_string_lossy().into_owned()), files })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_only_new_finished_audio_files_of_the_download_folder() {
        let root = std::env::temp_dir().join(format!("tonuino-downloads-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("Ordner")).unwrap();
        for (f, body) in [
            ("folge.mp3", &b"abc"[..]),
            ("FOLGE2.MP3", b"abcd"),
            ("halb.mp3", b""),
            ("halb.mp3.part", b"xx"),
            ("chrome.mp3.crdownload", b"xx"),
            ("bild.jpg", b"x"),
            ("leer.mp3", b""),
            ("Ordner/innen.mp3", b"x"),
        ] {
            fs::write(root.join(f), body).unwrap();
        }
        // Firefox: the final name exists with content while ".part" is still there.
        fs::write(root.join("noch.mp3"), b"xyz").unwrap();
        fs::write(root.join("noch.mp3.part"), b"x").unwrap();
        let ext = vec!["mp3".to_string(), "m4a".to_string()];
        let mut names: Vec<String> = recent_in(&root, 0, &ext).into_iter().map(|f| f.name).collect();
        names.sort();
        assert_eq!(names, ["FOLGE2.MP3", "folge.mp3"]);
        // Nothing older than the moment the user went to the publisher's page.
        let later = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64 + 60_000;
        assert!(recent_in(&root, later, &ext).is_empty());
        // No extensions, no listing; a folder that is not there, nothing.
        assert!(recent_in(&root, 0, &[]).is_empty());
        assert!(recent_in(&root.join("fehlt"), 0, &ext).is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn walks_recursively_in_natural_order_without_junk() {
        let root = std::env::temp_dir().join(format!("tonuino-walk-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("CD2")).unwrap();
        fs::create_dir_all(root.join("CD1")).unwrap();
        fs::create_dir_all(root.join(".hidden")).unwrap();
        for f in ["CD1/10 Ende.mp3", "CD1/2 Mitte.MP3", "CD1/1 Intro.mp3", "CD2/1 Weiter.mp3", "cover.jpg", "._cover.jpg", "Thumbs.db", ".hidden/x.mp3"] {
            fs::write(root.join(f), b"x").unwrap();
        }
        let all = walk(&root, &[]).unwrap();
        let top = root.file_name().unwrap().to_string_lossy().into_owned();
        let rel: Vec<String> = all
            .iter()
            .map(|f| f.relative_path.as_deref().unwrap().strip_prefix(&format!("{top}/")).unwrap().to_string())
            .collect();
        assert_eq!(rel, ["CD1/1 Intro.mp3", "CD1/2 Mitte.MP3", "CD1/10 Ende.mp3", "CD2/1 Weiter.mp3", "cover.jpg"]);
        let mp3 = walk(&root, &["mp3".to_string()]).unwrap();
        assert_eq!(mp3.len(), 4);
        assert_eq!(mp3[0].name, "1 Intro.mp3");
        assert_eq!(mp3[0].size, 1);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn only_really_dropped_paths_are_resolved_and_granted() {
        let root = std::env::temp_dir().join(format!("tonuino-drop-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let album = root.join("Bibi Blocksberg");
        fs::create_dir_all(album.join("CD 1")).unwrap();
        fs::write(album.join("CD 1/01 Intro.mp3"), b"x").unwrap();
        fs::write(root.join("single.mp3"), b"yy").unwrap();
        let st = crate::AppState::default();
        let s = |p: &Path| p.to_str().unwrap().to_string();

        assert_eq!(resolve_dropped(&st, &s(&album), &[]).unwrap_err().code, "not-allowed");
        st.access.note_dropped(&[album.clone(), root.join("single.mp3")]);
        let files = resolve_dropped(&st, &s(&album), &[]).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].relative_path.as_deref(), Some("Bibi Blocksberg/CD 1/01 Intro.mp3"));
        // Read access to the dropped folder, but no write access.
        assert!(st.access.check(&files[0].path, crate::access::Access::Read).is_ok());
        assert!(st.access.check(&files[0].path, crate::access::Access::Write).is_err());
        let single = resolve_dropped(&st, &s(&root.join("single.mp3")), &[]).unwrap();
        assert_eq!((single[0].name.as_str(), single[0].size, single[0].relative_path.clone()), ("single.mp3", 2, None));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn extension_matching_is_case_insensitive() {
        assert!(matches_ext("a.MP3", &["mp3".into()]));
        assert!(!matches_ext("a.mp3.txt", &["mp3".into()]));
        assert!(matches_ext("anything", &[]));
        assert!(is_junk("._x.mp3") && is_junk("desktop.ini") && !is_junk("001.mp3"));
    }
}
