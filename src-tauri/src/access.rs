//! Allow-list for file access from the WebView.
//!
//! The UI may only touch
//! - the mount paths of the volumes the watcher currently lists (read/write),
//! - folders the user picked in a native dialog (read/write for "card" folders,
//!   read-only for import folders),
//! - single files the user picked, dropped or chose in the save dialog.
//!
//! Every path is canonicalized before the check (symlinks resolved), `..`
//! components are rejected outright, and paths must be absolute.

use crate::error::{CmdError, CmdResult};
use std::ffi::OsString;
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, RwLock};
use std::time::{Duration, Instant};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Access {
    Read,
    Write,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Scope {
    /// The path and everything below it.
    Tree,
    /// Exactly this file.
    File,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Grant {
    path: PathBuf,
    scope: Scope,
    write: bool,
}

/// How long natively dropped paths stay claimable by the WebView.
const DROP_TTL: Duration = Duration::from_secs(120);

#[derive(Default)]
pub struct AccessControl {
    grants: RwLock<Vec<Grant>>,
    volume_roots: RwLock<Vec<PathBuf>>,
    dropped: Mutex<Vec<(PathBuf, Instant)>>,
}

/// Validates an absolute path coming from the UI and returns its canonical form.
///
/// Existing paths are canonicalized (symlinks resolved). For a path that does
/// not exist yet, the deepest existing ancestor is canonicalized and the
/// missing components are appended, so "create" operations can be checked too.
pub fn resolve(raw: &str) -> CmdResult<PathBuf> {
    if raw.is_empty() || raw.contains('\0') {
        return Err(CmdError::not_allowed("empty or invalid path"));
    }
    let path = Path::new(raw);
    if !path.is_absolute() {
        return Err(CmdError::not_allowed(format!("not an absolute path: {raw}")));
    }
    if path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(CmdError::not_allowed(format!("path contains '..': {raw}")));
    }

    let mut existing = path.to_path_buf();
    let mut missing: Vec<OsString> = Vec::new();
    loop {
        match fs::symlink_metadata(&existing) {
            Ok(_) => break,
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                let name = existing
                    .file_name()
                    .ok_or_else(|| CmdError::new("not-found", format!("no existing ancestor: {raw}")))?
                    .to_owned();
                missing.push(name);
                if !existing.pop() {
                    return Err(CmdError::new("not-found", format!("no existing ancestor: {raw}")));
                }
            }
            Err(e) => return Err(CmdError::io(&e, raw)),
        }
    }
    let mut canonical = fs::canonicalize(&existing).map_err(|e| {
        // A dangling symlink exists (symlink_metadata succeeded) but cannot be resolved.
        if e.kind() == io::ErrorKind::NotFound {
            CmdError::not_allowed(format!("unresolvable link: {raw}"))
        } else {
            CmdError::io(&e, raw)
        }
    })?;
    for name in missing.iter().rev() {
        canonical.push(name);
    }
    Ok(canonical)
}

fn canonical_or_none(path: &Path) -> Option<PathBuf> {
    fs::canonicalize(path).ok()
}

impl AccessControl {
    /// Replaces the set of volume roots (called by the volume watcher).
    pub fn set_volume_roots<I: IntoIterator<Item = PathBuf>>(&self, roots: I) {
        let roots: Vec<PathBuf> = roots.into_iter().filter_map(|p| canonical_or_none(&p)).collect();
        if let Ok(mut guard) = self.volume_roots.write() {
            *guard = roots;
        }
    }

    fn add(&self, path: &Path, scope: Scope, write: bool) -> CmdResult<PathBuf> {
        let canonical = fs::canonicalize(path).map_err(|e| CmdError::io(&e, path.display()))?;
        let grant = Grant { path: canonical.clone(), scope, write };
        let mut grants = self.grants.write().map_err(|_| CmdError::other("grant list poisoned"))?;
        if !grants.contains(&grant) {
            grants.push(grant);
        }
        Ok(canonical)
    }

    /// Grants access to a folder and everything inside it.
    pub fn grant_tree(&self, path: &Path, write: bool) -> CmdResult<PathBuf> {
        self.add(path, Scope::Tree, write)
    }

    /// Takes back every grant for this folder and what lies inside it (the
    /// folder may already be gone, so `path` is used as given; pass the
    /// canonical path that was granted).
    pub fn revoke_tree(&self, path: &Path) {
        let canonical = canonical_or_none(path);
        if let Ok(mut grants) = self.grants.write() {
            grants.retain(|g| !g.path.starts_with(path) && !canonical.as_ref().is_some_and(|c| g.path.starts_with(c)));
        }
    }

    /// Grants access to one existing file.
    pub fn grant_file(&self, path: &Path, write: bool) -> CmdResult<PathBuf> {
        self.add(path, Scope::File, write)
    }

    /// Grants write access to a file that may not exist yet (save dialog target).
    pub fn grant_new_file(&self, path: &Path) -> CmdResult<PathBuf> {
        let raw = path.to_str().ok_or_else(|| CmdError::invalid("path is not UTF-8"))?;
        let canonical = resolve(raw)?;
        let grant = Grant { path: canonical.clone(), scope: Scope::File, write: true };
        let mut grants = self.grants.write().map_err(|_| CmdError::other("grant list poisoned"))?;
        if !grants.contains(&grant) {
            grants.push(grant);
        }
        Ok(canonical)
    }

    /// Checks a path from the UI and returns its canonical form.
    pub fn check(&self, raw: &str, access: Access) -> CmdResult<PathBuf> {
        let path = resolve(raw)?;
        if self.allows(&path, access) {
            Ok(path)
        } else {
            Err(CmdError::not_allowed(format!("outside of the allowed folders: {raw}")))
        }
    }

    fn allows(&self, path: &Path, access: Access) -> bool {
        if let Ok(roots) = self.volume_roots.read() {
            if roots.iter().any(|root| path.starts_with(root)) {
                return true;
            }
        }
        let Ok(grants) = self.grants.read() else { return false };
        grants.iter().any(|g| {
            let covers = match g.scope {
                Scope::Tree => path.starts_with(&g.path),
                Scope::File => path == g.path,
            };
            covers && (access == Access::Read || g.write)
        })
    }

    /// True for the mount point of a volume or the root of a granted folder.
    /// Those may never be removed or renamed through the UI.
    pub fn is_protected_root(&self, path: &Path) -> bool {
        let is_volume = self.volume_roots.read().map(|r| r.iter().any(|p| p == path)).unwrap_or(true);
        let is_grant_root = self
            .grants
            .read()
            .map(|g| g.iter().any(|g| g.scope == Scope::Tree && g.path == path))
            .unwrap_or(true);
        is_volume || is_grant_root
    }

    /// Remembers paths of a native drop (called from the window event handler).
    pub fn note_dropped(&self, paths: &[PathBuf]) {
        let Ok(mut dropped) = self.dropped.lock() else { return };
        let now = Instant::now();
        dropped.retain(|(_, t)| now.duration_since(*t) < DROP_TTL);
        for p in paths {
            if let Some(c) = canonical_or_none(p) {
                dropped.push((c, now));
            }
        }
    }

    /// True when the path was part of a recent native drop.
    pub fn was_dropped(&self, path: &Path) -> bool {
        let Some(canonical) = canonical_or_none(path) else { return false };
        let Ok(dropped) = self.dropped.lock() else { return false };
        let now = Instant::now();
        dropped.iter().any(|(p, t)| *p == canonical && now.duration_since(*t) < DROP_TTL)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(PathBuf);
    impl TempDir {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("tonuino-access-{tag}-{}", std::process::id()));
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

    fn s(p: &Path) -> &str {
        p.to_str().unwrap()
    }

    #[test]
    fn rejects_relative_dotdot_and_empty_paths() {
        assert_eq!(resolve("").unwrap_err().code, "not-allowed");
        assert_eq!(resolve("relative/file.mp3").unwrap_err().code, "not-allowed");
        let tmp = TempDir::new("dotdot");
        let sneaky = format!("{}/../etc/passwd", s(&tmp.0));
        assert_eq!(resolve(&sneaky).unwrap_err().code, "not-allowed");
        assert_eq!(resolve("/tmp/a\0b").unwrap_err().code, "not-allowed");
    }

    #[test]
    fn volume_roots_allow_read_and_write_inside_only() {
        let tmp = TempDir::new("volume");
        let card = tmp.0.join("card");
        let card2 = tmp.0.join("card2");
        fs::create_dir_all(card.join("01")).unwrap();
        fs::create_dir_all(&card2).unwrap();
        fs::write(card.join("01/001.mp3"), b"x").unwrap();

        let ac = AccessControl::default();
        assert!(ac.check(s(&card.join("01/001.mp3")), Access::Read).is_err());
        ac.set_volume_roots([card.clone()]);
        assert!(ac.check(s(&card.join("01/001.mp3")), Access::Read).is_ok());
        assert!(ac.check(s(&card.join("01/002.mp3")), Access::Write).is_ok(), "new files below a root are fine");
        assert!(ac.check(s(&card.join("02/sub/001.mp3")), Access::Write).is_ok(), "new folders too");
        // Same string prefix, different folder.
        assert_eq!(ac.check(s(&card2), Access::Read).unwrap_err().code, "not-allowed");
        assert_eq!(ac.check(s(&tmp.0), Access::Read).unwrap_err().code, "not-allowed");
        assert!(ac.is_protected_root(&card));
        assert!(!ac.is_protected_root(&card.join("01")));
        ac.set_volume_roots(Vec::new());
        assert!(ac.check(s(&card.join("01/001.mp3")), Access::Read).is_err(), "ejected volumes lose access");
    }

    #[test]
    fn file_grants_are_exact_and_read_only() {
        let tmp = TempDir::new("files");
        let a = tmp.0.join("a.mp3");
        let b = tmp.0.join("b.mp3");
        fs::write(&a, b"a").unwrap();
        fs::write(&b, b"b").unwrap();
        let ac = AccessControl::default();
        ac.grant_file(&a, false).unwrap();
        assert!(ac.check(s(&a), Access::Read).is_ok());
        assert!(ac.check(s(&a), Access::Write).is_err());
        assert!(ac.check(s(&b), Access::Read).is_err());

        let target = tmp.0.join("export.pdf");
        ac.grant_new_file(&target).unwrap();
        assert!(ac.check(s(&target), Access::Write).is_ok());
        assert!(ac.check(s(&tmp.0.join("other.pdf")), Access::Write).is_err());
    }

    #[test]
    fn revoking_a_tree_drops_its_grants_only() {
        let tmp = TempDir::new("revoke");
        let work = tmp.0.join("work");
        let work2 = tmp.0.join("work2");
        fs::create_dir_all(&work).unwrap();
        fs::create_dir_all(&work2).unwrap();
        fs::write(work.join("1-a.m4a"), b"a").unwrap();
        fs::write(work2.join("1-b.m4a"), b"b").unwrap();
        let ac = AccessControl::default();
        ac.grant_tree(&work, false).unwrap();
        ac.grant_file(&work.join("1-a.m4a"), false).unwrap();
        ac.grant_tree(&work2, false).unwrap();
        ac.revoke_tree(&work);
        assert!(ac.check(s(&work.join("1-a.m4a")), Access::Read).is_err());
        assert!(ac.check(s(&work2.join("1-b.m4a")), Access::Read).is_ok(), "a folder with the same prefix keeps its grant");
        // Works when the folder is already gone, too.
        fs::remove_dir_all(&work2).unwrap();
        ac.revoke_tree(&work2);
        assert!(!ac.is_protected_root(&work2));
    }

    #[test]
    fn tree_grants_respect_write_flag() {
        let tmp = TempDir::new("tree");
        let import = tmp.0.join("import");
        fs::create_dir_all(import.join("CD1")).unwrap();
        fs::write(import.join("CD1/01.mp3"), b"x").unwrap();
        let ac = AccessControl::default();
        ac.grant_tree(&import, false).unwrap();
        assert!(ac.check(s(&import.join("CD1/01.mp3")), Access::Read).is_ok());
        assert!(ac.check(s(&import.join("CD1/01.mp3")), Access::Write).is_err());
        ac.grant_tree(&import, true).unwrap();
        assert!(ac.check(s(&import.join("CD1/01.mp3")), Access::Write).is_ok());
        assert!(ac.is_protected_root(&import));
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_cannot_escape_a_root() {
        let tmp = TempDir::new("symlink");
        let card = tmp.0.join("card");
        let outside = tmp.0.join("outside");
        fs::create_dir_all(&card).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret.txt"), b"s").unwrap();
        std::os::unix::fs::symlink(&outside, card.join("link")).unwrap();
        std::os::unix::fs::symlink(tmp.0.join("nowhere"), card.join("dangling")).unwrap();
        let ac = AccessControl::default();
        ac.set_volume_roots([card.clone()]);
        assert_eq!(ac.check(s(&card.join("link/secret.txt")), Access::Read).unwrap_err().code, "not-allowed");
        assert_eq!(ac.check(s(&card.join("link/new.txt")), Access::Write).unwrap_err().code, "not-allowed");
        assert_eq!(ac.check(s(&card.join("dangling")), Access::Write).unwrap_err().code, "not-allowed");
    }

    #[test]
    fn dropped_paths_are_remembered() {
        let tmp = TempDir::new("drop");
        let f = tmp.0.join("drop.mp3");
        fs::write(&f, b"x").unwrap();
        let ac = AccessControl::default();
        assert!(!ac.was_dropped(&f));
        ac.note_dropped(std::slice::from_ref(&f));
        assert!(ac.was_dropped(&f));
        assert!(!ac.was_dropped(&tmp.0));
    }
}
