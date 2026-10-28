//! Removable volumes (SD cards, USB sticks): listing, change events, details, eject.
//!
//! A background thread polls every 1.5 s and emits `volumes-changed` with the
//! full list when the set of volumes changes (free space alone does not count).

use crate::error::{blocking, CmdError, CmdResult};
use crate::SharedState;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

pub const EVENT_VOLUMES_CHANGED: &str = "volumes-changed";
const POLL_INTERVAL: Duration = Duration::from_millis(1500);

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VolumeDto {
    /// Mount path, stable while the card is mounted.
    pub id: String,
    pub label: String,
    pub mount_path: String,
    pub fs_type: Option<String>,
    pub cluster_size: Option<u64>,
    pub total_bytes: Option<u64>,
    pub free_bytes: Option<u64>,
    pub removable: bool,
    pub device: Option<String>,
    pub can_eject: bool,
    /// The app may create, change and delete files at the mount path.
    pub writable: bool,
    /// Mounted read-only (lock slider on the card or adapter, or `ro`).
    pub read_only: bool,
    /// The mount belongs to another user account (Linux: root or another uid).
    pub foreign_owner: bool,
    /// The app can mount the card again for this user ("Schreibrechte holen", Linux only).
    pub can_fix_access: bool,
    /// Read-only although the card itself is not locked: the system mounted it so,
    /// usually after the connection broke off while writing (Linux only).
    pub read_only_by_system: bool,
}

/// Filesystem details of any folder (used for picked folders).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VolumeInfoDto {
    pub fs_type: Option<String>,
    pub cluster_size: Option<u64>,
    pub total_bytes: Option<u64>,
    pub free_bytes: Option<u64>,
    pub removable: bool,
    pub device: Option<String>,
    /// Mount point of the filesystem the folder lives on.
    pub mount_path: Option<String>,
    /// True when the folder is the mount point of an ejectable volume.
    pub can_eject: bool,
    pub writable: bool,
    pub read_only: bool,
    pub foreign_owner: bool,
    pub can_fix_access: bool,
    pub read_only_by_system: bool,
}

/// Whether the app may change files on a volume, and whether it can fix that.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WriteAccess {
    pub writable: bool,
    pub read_only: bool,
    pub foreign_owner: bool,
    pub can_fix: bool,
}

impl Default for WriteAccess {
    /// What the app assumes where it cannot tell: writable, as before.
    fn default() -> Self {
        WriteAccess { writable: true, read_only: false, foreign_owner: false, can_fix: false }
    }
}

impl Default for VolumeInfoDto {
    fn default() -> Self {
        let mut dto = VolumeInfoDto {
            fs_type: None,
            cluster_size: None,
            total_bytes: None,
            free_bytes: None,
            removable: false,
            device: None,
            mount_path: None,
            can_eject: false,
            writable: true,
            read_only: false,
            foreign_owner: false,
            can_fix_access: false,
            read_only_by_system: false,
        };
        dto.set_access(WriteAccess::default());
        dto
    }
}

impl VolumeInfoDto {
    fn set_access(&mut self, a: WriteAccess) {
        self.writable = a.writable;
        self.read_only = a.read_only;
        self.foreign_owner = a.foreign_owner;
        self.can_fix_access = a.can_fix;
    }
}

/// Everything but the free space: a change here is worth an event.
fn same_set(a: &[VolumeDto], b: &[VolumeDto]) -> bool {
    a.len() == b.len()
        && a.iter().zip(b).all(|(x, y)| {
            x.id == y.id
                && x.label == y.label
                && x.fs_type == y.fs_type
                && x.total_bytes == y.total_bytes
                && x.device == y.device
                && x.removable == y.removable
                && x.cluster_size == y.cluster_size
                && x.writable == y.writable
                && x.read_only == y.read_only
                && x.can_fix_access == y.can_fix_access
                && x.read_only_by_system == y.read_only_by_system
        })
}

/// Re-reads the volume list, updates the cache and the allow-list, and emits
/// `volumes-changed` when the set changed (or `force` is set).
pub fn refresh(app: &AppHandle, force: bool) -> Vec<VolumeDto> {
    let list = platform::list_volumes();
    let state = app.state::<SharedState>();
    let changed = {
        let mut current = match state.volumes.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        let changed = !same_set(&current, &list);
        *current = list.clone();
        changed
    };
    // Cheap (one realpath per volume) and robust against mounts that were not
    // resolvable at the moment they first appeared.
    state.access.set_volume_roots(list.iter().map(|v| PathBuf::from(&v.mount_path)));
    if changed || force {
        let _ = app.emit(EVENT_VOLUMES_CHANGED, &list);
    }
    list
}

pub fn start_watcher(app: AppHandle) {
    let _ = std::thread::Builder::new().name("volume-watcher".into()).spawn(move || loop {
        refresh(&app, false);
        std::thread::sleep(POLL_INTERVAL);
    });
}

#[tauri::command]
pub async fn volumes_list(app: AppHandle) -> CmdResult<Vec<VolumeDto>> {
    blocking(move || Ok(refresh(&app, false))).await
}

#[tauri::command]
pub async fn volumes_refresh(app: AppHandle) -> CmdResult<Vec<VolumeDto>> {
    blocking(move || Ok(refresh(&app, true))).await
}

#[tauri::command]
pub async fn volume_info(state: State<'_, SharedState>, path: String) -> CmdResult<VolumeInfoDto> {
    let st = state.inner().clone();
    blocking(move || {
        let canonical = st.access.check(&path, crate::access::Access::Read)?;
        Ok(platform::info_for_path(&canonical))
    })
    .await
}

#[tauri::command]
pub async fn volume_eject(app: AppHandle, state: State<'_, SharedState>, mount_path: String) -> CmdResult<()> {
    let st = state.inner().clone();
    blocking(move || {
        let volume = {
            let list = match st.volumes.lock() {
                Ok(g) => g.clone(),
                Err(p) => p.into_inner().clone(),
            };
            list.into_iter().find(|v| v.mount_path == mount_path)
        };
        let volume = match volume {
            Some(v) => v,
            None => refresh(&app, false)
                .into_iter()
                .find(|v| v.mount_path == mount_path)
                .ok_or_else(|| CmdError::new("not-found", format!("no volume mounted at {mount_path}")))?,
        };
        if !volume.can_eject {
            return Err(CmdError::new("unsupported", format!("{mount_path} cannot be ejected")));
        }
        // Release our own open files on the card first.
        let root = PathBuf::from(&volume.mount_path);
        st.writes.close_under(&root);
        st.audio.close_under(&root);
        let result = platform::eject(&volume);
        refresh(&app, true);
        result
    })
    .await
}

/// "Schreibrechte holen": mounts the card again so this user may write to it,
/// then answers with the card as it is mounted now (possibly at a new path).
#[tauri::command]
pub async fn volume_fix_access(app: AppHandle, state: State<'_, SharedState>, mount_path: String) -> CmdResult<VolumeDto> {
    let st = state.inner().clone();
    blocking(move || {
        let volume = refresh(&app, false)
            .into_iter()
            .find(|v| v.mount_path == mount_path)
            .ok_or_else(|| CmdError::new("not-found", format!("no volume mounted at {mount_path}")))?;
        if volume.writable {
            return Ok(volume);
        }
        if volume.read_only {
            return Err(CmdError::new("read-only", format!("{mount_path} is mounted read-only")));
        }
        if !volume.can_fix_access {
            return Err(CmdError::new("unsupported", format!("{mount_path} cannot be mounted again by the app")));
        }
        let device = volume.device.clone().ok_or_else(|| CmdError::new("unsupported", "no block device"))?;
        // Release our own open files on the card first.
        let root = PathBuf::from(&volume.mount_path);
        st.writes.close_under(&root);
        st.audio.close_under(&root);
        let result = platform::remount_for_user(&volume);
        let list = refresh(&app, true);
        result?;
        let now = list
            .into_iter()
            .find(|v| v.device.as_deref() == Some(device.as_str()))
            .ok_or_else(|| CmdError::new("not-found", format!("{device} is not mounted any more")))?;
        if now.read_only {
            return Err(CmdError::new("read-only", format!("{device} came back read-only at {}", now.mount_path)));
        }
        if !now.writable {
            return Err(CmdError::new("unchanged", format!("{device} is still not writable at {}", now.mount_path)));
        }
        Ok(now)
    })
    .await
}

/* ------------------------------------------------------------- statvfs */

#[cfg(unix)]
pub(crate) struct FsStats {
    pub total: u64,
    pub free: u64,
    pub cluster: u64,
    /// Mounted read-only (ST_RDONLY).
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub read_only: bool,
}

#[cfg(unix)]
pub(crate) fn statvfs(path: &Path) -> Option<FsStats> {
    use std::os::unix::ffi::OsStrExt;
    let c = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
    // SAFETY: statvfs fills the zeroed struct; we only read it on success.
    let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
    let rc = unsafe { libc::statvfs(c.as_ptr(), &mut st) };
    if rc != 0 {
        return None;
    }
    #[allow(clippy::unnecessary_cast)]
    let (bsize, frsize, blocks, bavail) = (st.f_bsize as u64, st.f_frsize as u64, st.f_blocks as u64, st.f_bavail as u64);
    let unit = if frsize > 0 { frsize } else { bsize };
    // Linux (vfat, exfat) reports the cluster size in f_bsize. On macOS
    // statvfs maps f_bsize to the preferred I/O size and f_frsize to the
    // filesystem block (= cluster) size.
    let cluster = if cfg!(target_os = "macos") { unit } else { bsize };
    #[allow(clippy::unnecessary_cast)]
    let read_only = st.f_flag as u64 & libc::ST_RDONLY as u64 != 0;
    Some(FsStats { total: blocks.saturating_mul(unit), free: bavail.saturating_mul(unit), cluster, read_only })
}

/* --------------------------------------------------------------- Linux */

#[cfg(target_os = "linux")]
pub(crate) mod platform {
    use super::*;
    use std::collections::HashSet;
    use std::fs;
    use std::process::Command;

    #[derive(Debug, Clone, PartialEq, Eq, Default)]
    pub struct MountEntry {
        pub mount_point: String,
        pub fs_type: String,
        pub source: String,
        /// Per-mount options, e.g. "rw,nosuid,nodev,relatime".
        pub mount_options: String,
        /// Options of the filesystem, e.g. "rw,uid=1000,gid=1000,fmask=0022".
        pub super_options: String,
    }

    /// Unescapes the octal sequences (\040 for space, …) used in /proc mount tables.
    fn unescape_octal(s: &str) -> String {
        let b = s.as_bytes();
        let mut out = Vec::with_capacity(b.len());
        let mut i = 0;
        while i < b.len() {
            if b[i] == b'\\' && i + 4 <= b.len() && b[i + 1..i + 4].iter().all(|c| (b'0'..=b'7').contains(c)) {
                let v = (b[i + 1] - b'0') as u32 * 64 + (b[i + 2] - b'0') as u32 * 8 + (b[i + 3] - b'0') as u32;
                out.push(v as u8);
                i += 4;
            } else {
                out.push(b[i]);
                i += 1;
            }
        }
        String::from_utf8_lossy(&out).into_owned()
    }

    /// Parses /proc/self/mountinfo.
    pub fn parse_mountinfo(content: &str) -> Vec<MountEntry> {
        content
            .lines()
            .filter_map(|line| {
                let fields: Vec<&str> = line.split(' ').collect();
                let sep = fields.iter().position(|f| *f == "-")?;
                if sep < 6 || fields.len() < sep + 3 {
                    return None;
                }
                Some(MountEntry {
                    mount_point: unescape_octal(fields[4]),
                    fs_type: fields[sep + 1].to_string(),
                    source: unescape_octal(fields[sep + 2]),
                    mount_options: fields[5].to_string(),
                    super_options: fields.get(sep + 3).map(|o| o.to_string()).unwrap_or_default(),
                })
            })
            .collect()
    }

    const PSEUDO_FS: &[&str] = &[
        "proc", "sysfs", "devtmpfs", "devpts", "tmpfs", "ramfs", "cgroup", "cgroup2", "securityfs",
        "pstore", "debugfs", "tracefs", "configfs", "fusectl", "mqueue", "hugetlbfs", "bpf",
        "autofs", "binfmt_misc", "rpc_pipefs", "nsfs", "overlay", "squashfs", "efivarfs",
        "selinuxfs", "fuse.portal", "fuse.gvfsd-fuse", "fuse.snapfuse", "nfs", "nfs4", "cifs",
        "smb3", "iso9660", "udf",
    ];

    fn is_system_mount(mp: &str) -> bool {
        const EXACT: &[&str] = &[
            "/", "/boot", "/efi", "/home", "/usr", "/var", "/tmp", "/opt", "/srv", "/root", "/nix",
            "/recovery", "/run", "/media", "/mnt",
        ];
        const PREFIXES: &[&str] = &[
            "/boot/", "/efi/", "/snap/", "/var/", "/usr/", "/proc/", "/sys/", "/dev/", "/nix/",
            "/sysroot/", "/gnu/", "/home/",
        ];
        if EXACT.contains(&mp) || PREFIXES.iter().any(|p| mp.starts_with(p)) {
            return true;
        }
        mp.starts_with("/run/") && !mp.starts_with("/run/media/")
    }

    /// Decides whether a mount is a card/stick the app should offer.
    /// `removable` comes from sysfs (removable flag, USB or MMC bus).
    pub fn is_candidate(e: &MountEntry, removable: bool) -> bool {
        if PSEUDO_FS.contains(&e.fs_type.as_str()) {
            return false;
        }
        let Some(dev) = e.source.strip_prefix("/dev/") else { return false };
        if ["loop", "zram", "ram", "nbd", "sr"].iter().any(|p| dev.starts_with(p)) {
            return false;
        }
        if is_system_mount(&e.mount_point) {
            return false;
        }
        let under_media = e.mount_point.starts_with("/media/") || e.mount_point.starts_with("/run/media/");
        under_media || removable
    }

    #[derive(Debug, Default, Clone)]
    pub struct BlockInfo {
        pub removable: bool,
        /// Kernel name of the whole disk, e.g. "sdb" for /dev/sdb1.
        pub disk: Option<String>,
    }

    /// Removable when the kernel says so, or when the disk sits on USB or MMC.
    pub fn removable_from_sysfs(sys_path: &str, removable_flag: bool, name: &str) -> bool {
        removable_flag || sys_path.contains("/usb") || sys_path.contains("/mmc") || name.starts_with("mmcblk")
    }

    pub fn block_info(source: &str) -> BlockInfo {
        let dev = fs::canonicalize(source).unwrap_or_else(|_| PathBuf::from(source));
        let Some(name) = dev.file_name().and_then(|n| n.to_str()).map(str::to_string) else {
            return BlockInfo::default();
        };
        let class = Path::new("/sys/class/block").join(&name);
        let Ok(sys) = fs::canonicalize(&class) else { return BlockInfo::default() };
        let disk_dir = if class.join("partition").exists() { sys.parent().map(Path::to_path_buf) } else { Some(sys.clone()) };
        let disk = disk_dir.as_ref().and_then(|d| d.file_name()).and_then(|n| n.to_str()).map(str::to_string);
        let removable_flag = disk_dir
            .as_ref()
            .and_then(|d| fs::read_to_string(d.join("removable")).ok())
            .map(|s| s.trim() == "1")
            .unwrap_or(false);
        BlockInfo {
            removable: removable_from_sysfs(&sys.to_string_lossy(), removable_flag, &name),
            disk,
        }
    }

    /// The kernel's own read-only flag of a block device (/sys/class/block/<name>/ro):
    /// set by the lock slider of the card or adapter, not by a read-only mount.
    pub fn block_read_only(source: &str) -> Option<bool> {
        let dev = fs::canonicalize(source).unwrap_or_else(|_| PathBuf::from(source));
        let name = dev.file_name()?.to_str()?;
        let flag = fs::read_to_string(Path::new("/sys/class/block").join(name).join("ro")).ok()?;
        Some(flag.trim() == "1")
    }

    /// Decodes the \xNN escapes udev uses in /dev/disk/by-label names.
    pub fn decode_udev_escapes(s: &str) -> String {
        let b = s.as_bytes();
        let mut out = Vec::with_capacity(b.len());
        let mut i = 0;
        while i < b.len() {
            if b[i] == b'\\' && i + 4 <= b.len() && b[i + 1] == b'x' {
                let hi = (b[i + 2] as char).to_digit(16);
                let lo = (b[i + 3] as char).to_digit(16);
                if let (Some(hi), Some(lo)) = (hi, lo) {
                    out.push((hi * 16 + lo) as u8);
                    i += 4;
                    continue;
                }
            }
            out.push(b[i]);
            i += 1;
        }
        String::from_utf8_lossy(&out).into_owned()
    }

    fn label_for(source: &str, mount_point: &str) -> String {
        let dev = fs::canonicalize(source).ok();
        if let (Some(dev), Ok(entries)) = (dev, fs::read_dir("/dev/disk/by-label")) {
            for entry in entries.flatten() {
                if fs::canonicalize(entry.path()).ok().as_ref() == Some(&dev) {
                    return decode_udev_escapes(&entry.file_name().to_string_lossy());
                }
            }
        }
        Path::new(mount_point)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| mount_point.to_string())
    }

    fn mounts() -> Vec<MountEntry> {
        fs::read_to_string("/proc/self/mountinfo").map(|c| parse_mountinfo(&c)).unwrap_or_default()
    }

    pub fn list_volumes() -> Vec<VolumeDto> {
        let mut seen = HashSet::new();
        let mut out = Vec::new();
        for m in mounts() {
            if !m.source.starts_with("/dev/") || PSEUDO_FS.contains(&m.fs_type.as_str()) {
                continue;
            }
            let info = block_info(&m.source);
            if !is_candidate(&m, info.removable) || !seen.insert(m.source.clone()) {
                continue;
            }
            let stats = statvfs(Path::new(&m.mount_point));
            let access = write_access_of(&m, Path::new(&m.mount_point));
            out.push(VolumeDto {
                id: m.mount_point.clone(),
                label: label_for(&m.source, &m.mount_point),
                mount_path: m.mount_point.clone(),
                fs_type: Some(m.fs_type.clone()),
                cluster_size: stats.as_ref().map(|s| s.cluster),
                total_bytes: stats.as_ref().map(|s| s.total),
                free_bytes: stats.as_ref().map(|s| s.free),
                removable: info.removable,
                device: Some(m.source.clone()),
                can_eject: info.removable,
                writable: access.writable,
                read_only: access.read_only,
                foreign_owner: access.foreign_owner,
                can_fix_access: access.can_fix,
                read_only_by_system: access.read_only && block_read_only(&m.source) == Some(false),
            });
        }
        out
    }

    pub fn info_for_path(path: &Path) -> VolumeInfoDto {
        // The mount with the longest mount point that contains the path.
        let best = mounts()
            .into_iter()
            .filter(|m| path.starts_with(&m.mount_point))
            .max_by_key(|m| m.mount_point.len());
        let stats = statvfs(path);
        let mut dto = VolumeInfoDto {
            cluster_size: stats.as_ref().map(|s| s.cluster),
            total_bytes: stats.as_ref().map(|s| s.total),
            free_bytes: stats.as_ref().map(|s| s.free),
            ..Default::default()
        };
        if let Some(m) = best {
            let info = if m.source.starts_with("/dev/") { block_info(&m.source) } else { BlockInfo::default() };
            dto.fs_type = Some(m.fs_type.clone());
            dto.removable = info.removable;
            dto.device = Some(m.source.clone());
            dto.can_eject = info.removable && path == Path::new(&m.mount_point);
            let mut access = write_access_of(&m, path);
            // Mounting again only helps the card itself, not a folder picked on it.
            access.can_fix &= path == Path::new(&m.mount_point);
            dto.set_access(access);
            dto.read_only_by_system = access.read_only && m.source.starts_with("/dev/") && block_read_only(&m.source) == Some(false);
            dto.mount_path = Some(m.mount_point);
        }
        dto
    }

    /* ---------------------------------------------- write access and remount */

    fn has_option(options: &str, name: &str) -> bool {
        options.split(',').any(|o| o == name)
    }

    fn option_value<'a>(options: &'a str, name: &str) -> Option<&'a str> {
        options.split(',').find_map(|o| o.strip_prefix(name)?.strip_prefix('='))
    }

    /// Mounted read-only: `ro` in the mount's or the filesystem's options.
    pub fn is_read_only(e: &MountEntry) -> bool {
        has_option(&e.mount_options, "ro") || has_option(&e.super_options, "ro")
    }

    /// The owner the filesystem gives every file (`uid=` of vfat, exfat, ntfs3).
    pub fn mount_uid(e: &MountEntry) -> Option<u32> {
        option_value(&e.super_options, "uid")?.parse().ok()
    }

    /// Filesystems without owners of their own: the owner comes from `uid=`.
    const UID_FS: &[&str] = &["vfat", "msdos", "exfat", "ntfs3"];

    /// Mounted by udisks (the desktop's automount) under /media/<user> or /run/media/<user>.
    pub fn is_udisks_mount(mount_point: &str) -> bool {
        let rest = mount_point.strip_prefix("/media/").or_else(|| mount_point.strip_prefix("/run/media/"));
        rest.is_some_and(|r| r.split('/').filter(|p| !p.is_empty()).count() >= 2)
    }

    /// How "Schreibrechte holen" mounts the card again.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum FixMethod {
        /// udisksctl unmount and mount as the user (automounted cards).
        Udisks,
        /// pkexec: the same device at the same mount point with the user's uid
        /// (cards with a fixed entry in /etc/fstab, e.g. made with "Laufwerke").
        Pkexec,
    }

    /// Facts the decision needs besides the mount table.
    #[derive(Debug, Clone, Copy)]
    pub struct AccessFacts {
        /// access(W_OK) on the path: Ok, or the errno it failed with.
        pub access: Result<(), i32>,
        /// Owner of the mount root (stat).
        pub root_owner: Option<u32>,
        pub my_uid: u32,
        pub has_udisksctl: bool,
        pub has_pkexec: bool,
    }

    /// Which way of mounting again can help, if any.
    pub fn fix_method(e: &MountEntry, f: &AccessFacts) -> Option<FixMethod> {
        if !e.source.starts_with("/dev/") {
            return None;
        }
        if is_udisks_mount(&e.mount_point) {
            return f.has_udisksctl.then_some(FixMethod::Udisks);
        }
        // Only filesystems that take uid= can be handed to the user by mounting them again.
        (f.has_pkexec && UID_FS.contains(&e.fs_type.as_str())).then_some(FixMethod::Pkexec)
    }

    /// Decides what the app may do on a mount: the pure part of `write_access_of`.
    pub fn decide_access(e: &MountEntry, f: &AccessFacts) -> WriteAccess {
        let read_only = is_read_only(e) || f.access == Err(libc::EROFS);
        let owner = mount_uid(e).or(f.root_owner);
        let foreign_owner = owner.is_some_and(|o| o != f.my_uid);
        let writable = f.access.is_ok() && !read_only;
        let can_fix = !writable && !read_only && fix_method(e, f).is_some();
        WriteAccess { writable, read_only, foreign_owner, can_fix }
    }

    fn access_w(path: &Path) -> Result<(), i32> {
        use std::os::unix::ffi::OsStrExt;
        let Ok(c) = std::ffi::CString::new(path.as_os_str().as_bytes()) else { return Err(libc::EINVAL) };
        // SAFETY: plain syscall with a valid NUL-terminated path.
        if unsafe { libc::access(c.as_ptr(), libc::W_OK) } == 0 {
            Ok(())
        } else {
            Err(std::io::Error::last_os_error().raw_os_error().unwrap_or(libc::EACCES))
        }
    }

    fn my_uid() -> u32 {
        // SAFETY: getuid never fails.
        unsafe { libc::getuid() }
    }

    fn my_gid() -> u32 {
        // SAFETY: getgid never fails.
        unsafe { libc::getgid() }
    }

    /// Absolute path of a program in PATH or in the usual system folders.
    fn find_program(name: &str) -> Option<PathBuf> {
        let path = std::env::var_os("PATH").unwrap_or_default();
        std::env::split_paths(&path)
            .chain(["/usr/bin", "/bin", "/usr/sbin", "/sbin"].map(PathBuf::from))
            .map(|dir| dir.join(name))
            .find(|p| p.is_file())
    }

    /// Write access of `path` on mount `e`. Looks for udisksctl and pkexec
    /// only when the path is not writable, so the poll stays cheap.
    pub fn write_access_of(e: &MountEntry, path: &Path) -> WriteAccess {
        use std::os::unix::fs::MetadataExt;
        let access = access_w(path);
        let mut facts = AccessFacts {
            access,
            root_owner: fs::metadata(path).ok().map(|m| m.uid()),
            my_uid: my_uid(),
            has_udisksctl: false,
            has_pkexec: false,
        };
        if access.is_err() {
            facts.has_udisksctl = find_program("udisksctl").is_some();
            facts.has_pkexec = find_program("pkexec").is_some();
        }
        decide_access(e, &facts)
    }

    /// One step of mounting again with udisksctl: Ok when it went through or
    /// had nothing to do, else the error code.
    pub fn udisks_step_result(mount: bool, success: bool, stderr: &str) -> Result<(), &'static str> {
        if success {
            return Ok(());
        }
        let s = stderr.to_ascii_lowercase();
        if s.contains("dismissed") {
            // The user closed the password dialog.
            return Err("cancelled");
        }
        if mount && s.contains("alreadymounted") {
            return Ok(());
        }
        match udisks_error_code(stderr) {
            None if !mount => Ok(()), // not mounted any more: fine before mounting
            None => Err("other"),
            Some(code) => Err(code),
        }
    }

    /// Error code for a failed pkexec run of REMOUNT_SCRIPT.
    pub fn pkexec_error_code(status: Option<i32>, stderr: &str) -> &'static str {
        let s = stderr.to_ascii_lowercase();
        match status {
            // pkexec: 126 = the password dialog was closed, 127 = not authorized.
            Some(126) => "cancelled",
            Some(127) => "permission",
            _ if s.contains("busy") => "busy",
            _ => "other",
        }
    }

    /// Mount options that hand every file to the user.
    pub fn user_mount_options(fs_type: &str, uid: u32, gid: u32) -> String {
        let mut o = format!("uid={uid},gid={gid},umask=022");
        if fs_type == "vfat" || fs_type == "msdos" {
            o.push_str(",utf8,shortname=mixed");
        }
        o
    }

    /// Device and mount point safe to hand to mount(8): plain absolute paths
    /// without option-like or odd characters.
    pub fn safe_mount_args(device: &str, mount_point: &str) -> bool {
        let plain = |p: &str| {
            p.starts_with('/')
                && !p.contains("/../")
                && !p.ends_with("/..")
                && p.chars().all(|c| !c.is_control() && c != ',' && c != '\\')
        };
        device.starts_with("/dev/")
            && device[5..].chars().all(|c| c.is_ascii_alphanumeric() || "_-:./".contains(c))
            && plain(device)
            && plain(mount_point)
            && mount_point != "/"
            && !is_system_mount(mount_point)
    }

    /// Runs as root through pkexec. A fixed script: the values come in as
    /// arguments ($1 mount point, $2 type, $3 options, $4 device), never as text
    /// inside it. Should mounting fail, it puts the card back as before (fstab).
    const REMOUNT_SCRIPT: &str = "umount -- \"$1\" || exit 10; mount -t \"$2\" -o \"$3\" -- \"$4\" \"$1\" || { mount -- \"$1\"; exit 11; }";

    fn remount_with_pkexec(entry: &MountEntry) -> CmdResult<()> {
        if !safe_mount_args(&entry.source, &entry.mount_point) || !UID_FS.contains(&entry.fs_type.as_str()) {
            return Err(CmdError::new("unsupported", format!("will not remount {} at {}", entry.source, entry.mount_point)));
        }
        let pkexec = find_program("pkexec").ok_or_else(|| CmdError::new("unsupported", "pkexec not found"))?;
        let options = user_mount_options(&entry.fs_type, my_uid(), my_gid());
        let out = Command::new(pkexec)
            .args(["/bin/sh", "-c", REMOUNT_SCRIPT, "sh", &entry.mount_point, &entry.fs_type, &options, &entry.source])
            .stdin(std::process::Stdio::null())
            .output()
            .map_err(|e| CmdError::new("unsupported", format!("pkexec: {e}")))?;
        if out.status.success() {
            return Ok(());
        }
        let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
        Err(CmdError::new(pkexec_error_code(out.status.code(), &stderr), format!("pkexec remount: {}", stderr.trim())))
    }

    fn remount_with_udisks(device: &str) -> CmdResult<()> {
        for (mount, verb) in [(false, "unmount"), (true, "mount")] {
            let out = match Command::new("udisksctl").args([verb, "-b", device]).stdin(std::process::Stdio::null()).output() {
                Ok(out) => out,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(CmdError::new("unsupported", "udisksctl not found")),
                Err(e) => return Err(CmdError::other(format!("udisksctl: {e}"))),
            };
            let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
            udisks_step_result(mount, out.status.success(), &stderr).map_err(|code| CmdError::new(code, format!("udisksctl {verb}: {}", stderr.trim())))?;
        }
        Ok(())
    }

    /// Mounts the card again so the user may write to it (see FixMethod).
    pub fn remount_for_user(volume: &VolumeDto) -> CmdResult<()> {
        // Taken from the mount table now, not from what the UI sent.
        let entry = mounts()
            .into_iter()
            .find(|m| m.mount_point == volume.mount_path && Some(&m.source) == volume.device.as_ref())
            .ok_or_else(|| CmdError::new("not-found", format!("{} is not mounted any more", volume.mount_path)))?;
        syncfs(Path::new(&entry.mount_point));
        let facts = AccessFacts {
            access: access_w(Path::new(&entry.mount_point)),
            root_owner: None,
            my_uid: my_uid(),
            has_udisksctl: find_program("udisksctl").is_some(),
            has_pkexec: find_program("pkexec").is_some(),
        };
        match fix_method(&entry, &facts) {
            Some(FixMethod::Udisks) => remount_with_udisks(&entry.source),
            Some(FixMethod::Pkexec) => remount_with_pkexec(&entry),
            None => Err(CmdError::new("unsupported", format!("no way to remount {}", entry.source))),
        }
    }

    fn syncfs(path: &Path) {
        if let Ok(dir) = fs::File::open(path) {
            use std::os::unix::io::AsRawFd;
            // SAFETY: plain syscall on a valid descriptor.
            unsafe {
                libc::syncfs(dir.as_raw_fd());
            }
        }
    }

    /// Maps udisksctl's error output to a code.
    pub fn udisks_error_code(stderr: &str) -> Option<&'static str> {
        let s = stderr.to_ascii_lowercase();
        if s.contains("notmounted") || s.contains("not mounted") {
            None
        } else if s.contains("devicebusy") || s.contains("target is busy") || s.contains("busy") {
            Some("busy")
        } else if s.contains("notauthorized") || s.contains("not authorized") {
            Some("permission")
        } else if s.contains("error looking up object") || s.contains("no such file") {
            Some("not-found")
        } else {
            Some("other")
        }
    }

    pub fn eject(volume: &VolumeDto) -> CmdResult<()> {
        let mount = Path::new(&volume.mount_path);
        syncfs(mount);
        let device = volume.device.clone().ok_or_else(|| CmdError::new("unsupported", "no block device"))?;
        match Command::new("udisksctl").args(["unmount", "-b", &device]).output() {
            Ok(out) if out.status.success() => {}
            Ok(out) => {
                let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
                if let Some(code) = udisks_error_code(&stderr) {
                    return Err(CmdError::new(code, stderr.trim().to_string()));
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                // No udisks: try a plain unmount (works for user mounts).
                let out = Command::new("umount")
                    .arg(mount)
                    .output()
                    .map_err(|e| CmdError::new("unsupported", format!("umount: {e}")))?;
                if !out.status.success() {
                    let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
                    let code = if stderr.contains("busy") { "busy" } else { "unsupported" };
                    return Err(CmdError::new(code, stderr.trim().to_string()));
                }
                return Ok(());
            }
            Err(e) => return Err(CmdError::other(format!("udisksctl: {e}"))),
        }
        // Power off the whole disk so the card reader LED goes out. Built-in
        // readers and disks with other mounted partitions refuse: not an error.
        if let Some(disk) = block_info(&device).disk {
            let _ = Command::new("udisksctl")
                .args(["power-off", "-b", &format!("/dev/{disk}"), "--no-user-interaction"])
                .output();
        }
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn the_lock_flag_of_a_device_nobody_knows_is_unknown() {
            // Unknown: never taken for "the system made it read-only".
            assert_eq!(block_read_only("/dev/tonuino-test-no-such-device"), None);
            assert_eq!(block_read_only("server:/share"), None);
        }

        const MOUNTINFO: &str = "\
22 1 259:2 / / rw,relatime shared:1 - ext4 /dev/nvme0n1p2 rw,errors=remount-ro
23 22 259:1 / /boot/efi rw,relatime shared:2 - vfat /dev/nvme0n1p1 rw,fmask=0077
24 22 0:5 / /dev rw,nosuid shared:3 - devtmpfs udev rw,size=8000000k
25 22 0:22 / /proc rw,nosuid shared:4 - proc proc rw
30 22 7:0 / /snap/core22/1380 ro,nodev shared:9 - squashfs /dev/loop0 ro
31 22 0:30 / /run/user/1000 rw,nosuid shared:10 - tmpfs tmpfs rw,size=1600000k
40 22 8:17 / /media/anna/TONUINO rw,nosuid,nodev,relatime shared:20 - vfat /dev/sdb1 rw,fmask=0022,dmask=0022,codepage=437,iocharset=iso8859-1,shortname=mixed,showexec,utf8,flush,errors=remount-ro
41 22 179:1 / /run/media/ben/SD\\040KARTE rw,nosuid shared:21 - exfat /dev/mmcblk0p1 rw
42 22 8:33 / /mnt/usb rw,relatime shared:22 - vfat /dev/sdc1 rw
43 22 8:2 / /data rw,relatime shared:23 - ext4 /dev/sda2 rw
44 22 0:45 / /run/user/1000/doc rw,nosuid shared:24 - fuse.portal portal rw
45 22 8:3 / /home rw,relatime shared:25 - ext4 /dev/sda3 rw
";

        #[test]
        fn parses_and_unescapes_mountinfo() {
            let m = parse_mountinfo(MOUNTINFO);
            assert_eq!(m.len(), 12);
            assert_eq!(m[6].mount_point, "/media/anna/TONUINO");
            assert_eq!((m[6].fs_type.as_str(), m[6].source.as_str()), ("vfat", "/dev/sdb1"));
            assert_eq!(m[6].mount_options, "rw,nosuid,nodev,relatime");
            assert!(m[6].super_options.starts_with("rw,fmask=0022,dmask=0022"));
            assert_eq!(m[7].mount_point, "/run/media/ben/SD KARTE");
            assert_eq!(m[7].fs_type, "exfat");
        }

        #[test]
        fn filters_system_and_keeps_cards() {
            let removable_devices = ["/dev/sdb1", "/dev/mmcblk0p1", "/dev/sdc1"];
            let kept: Vec<String> = parse_mountinfo(MOUNTINFO)
                .into_iter()
                .filter(|m| is_candidate(m, removable_devices.contains(&m.source.as_str())))
                .map(|m| m.mount_point)
                .collect();
            assert_eq!(kept, ["/media/anna/TONUINO", "/run/media/ben/SD KARTE", "/mnt/usb"]);
        }

        #[test]
        fn never_offers_root_boot_snap_or_loop_even_if_removable() {
            for line in MOUNTINFO.lines() {
                let m = &parse_mountinfo(line)[0];
                if ["/", "/boot/efi", "/home"].contains(&m.mount_point.as_str()) || m.source.starts_with("/dev/loop") {
                    assert!(!is_candidate(m, true), "{} must be excluded", m.mount_point);
                }
            }
            // A non-removable internal disk under /media is offered (user mounted it there).
            let internal = MountEntry { mount_point: "/media/anna/Daten".into(), fs_type: "ext4".into(), source: "/dev/sda5".into(), ..Default::default() };
            assert!(is_candidate(&internal, false));
            // A removable disk at an unusual place is offered, an internal one is not.
            let other = MountEntry { mount_point: "/data".into(), fs_type: "ext4".into(), source: "/dev/sda2".into(), ..Default::default() };
            assert!(!is_candidate(&other, false));
        }

        #[test]
        fn removable_detection_from_sysfs_paths() {
            let usb = "/sys/devices/pci0000:00/0000:00:14.0/usb2/2-1/2-1:1.0/host6/target6:0:0/6:0:0:0/block/sdb/sdb1";
            assert!(removable_from_sysfs(usb, false, "sdb1"));
            let mmc = "/sys/devices/pci0000:00/0000:00:1c.0/0000:02:00.0/mmc_host/mmc0/mmc0:aaaa/block/mmcblk0/mmcblk0p1";
            assert!(removable_from_sysfs(mmc, false, "mmcblk0p1"));
            let sata = "/sys/devices/pci0000:00/0000:00:17.0/ata1/host0/target0:0:0/0:0:0:0/block/sda/sda2";
            assert!(!removable_from_sysfs(sata, false, "sda2"));
            assert!(removable_from_sysfs(sata, true, "sda2"));
        }

        /// A card with its own line in /etc/fstab (as "Laufwerke" writes it,
        /// keyed by /dev/disk/by-id), mounted by root without uid=: the root
        /// folder belongs to root with mode 755.
        const FSTAB_CARD: &str = "50 22 8:17 / /mnt/usb-Generic_STORAGE_DEVICE_000000000819-0:0-part1 rw,relatime shared:30 - vfat /dev/sdb1 rw,fmask=0022,dmask=0022,codepage=437,iocharset=iso8859-1,shortname=mixed,errors=remount-ro";
        const USER_CARD: &str = "40 22 8:17 / /media/ben/TONUINO rw,nosuid,nodev,relatime shared:20 - vfat /dev/sdb1 rw,uid=1000,gid=1000,fmask=0022,dmask=0022,codepage=437,iocharset=iso8859-1,shortname=mixed,showexec,utf8,flush,errors=remount-ro";
        const ROOT_UDISKS_CARD: &str = "40 22 8:17 / /media/root/TONUINO rw,nosuid,nodev,relatime shared:20 - vfat /dev/sdb1 rw,uid=0,gid=0,fmask=0022,dmask=0022";
        const LOCKED_CARD: &str = "40 22 8:17 / /media/ben/TONUINO ro,nosuid,nodev,relatime shared:20 - vfat /dev/sdb1 ro,uid=1000,gid=1000,fmask=0022,dmask=0022";

        fn entry(line: &str) -> MountEntry {
            parse_mountinfo(line).remove(0)
        }

        fn facts(access: Result<(), i32>, root_owner: Option<u32>) -> AccessFacts {
            AccessFacts { access, root_owner, my_uid: 1000, has_udisksctl: true, has_pkexec: true }
        }

        #[test]
        fn fstab_card_owned_by_root_is_foreign_and_fixed_with_pkexec() {
            let e = entry(FSTAB_CARD);
            assert_eq!(e.mount_point, "/mnt/usb-Generic_STORAGE_DEVICE_000000000819-0:0-part1");
            assert!(is_candidate(&e, true));
            assert!(!is_read_only(&e));
            assert_eq!(mount_uid(&e), None);
            assert!(!is_udisks_mount(&e.mount_point));
            let f = facts(Err(libc::EACCES), Some(0));
            assert_eq!(decide_access(&e, &f), WriteAccess { writable: false, read_only: false, foreign_owner: true, can_fix: true });
            assert_eq!(fix_method(&e, &f), Some(FixMethod::Pkexec));
            assert!(safe_mount_args(&e.source, &e.mount_point));
            // Without pkexec there is nothing the app can do.
            let none = AccessFacts { has_pkexec: false, ..f };
            assert!(!decide_access(&e, &none).can_fix);
        }

        #[test]
        fn own_udisks_card_is_writable() {
            let e = entry(USER_CARD);
            assert_eq!(mount_uid(&e), Some(1000));
            assert!(is_udisks_mount(&e.mount_point));
            let a = decide_access(&e, &facts(Ok(()), Some(1000)));
            assert_eq!(a, WriteAccess { writable: true, read_only: false, foreign_owner: false, can_fix: false });
        }

        #[test]
        fn card_automounted_for_root_is_fixed_with_udisks() {
            let e = entry(ROOT_UDISKS_CARD);
            // uid= wins over the owner stat reports.
            let f = facts(Err(libc::EACCES), Some(1000));
            assert_eq!(decide_access(&e, &f), WriteAccess { writable: false, read_only: false, foreign_owner: true, can_fix: true });
            assert_eq!(fix_method(&e, &f), Some(FixMethod::Udisks));
            assert_eq!(fix_method(&e, &AccessFacts { has_udisksctl: false, ..f }), None);
        }

        #[test]
        fn locked_card_is_read_only_and_offers_no_fix() {
            let e = entry(LOCKED_CARD);
            assert!(is_read_only(&e));
            let a = decide_access(&e, &facts(Err(libc::EROFS), Some(1000)));
            assert_eq!(a, WriteAccess { writable: false, read_only: true, foreign_owner: false, can_fix: false });
            // EROFS alone says so too, whatever the table says.
            let rw = entry(USER_CARD);
            assert!(decide_access(&rw, &facts(Err(libc::EROFS), Some(1000))).read_only);
        }

        #[test]
        fn ext4_outside_media_cannot_be_handed_over() {
            let e = MountEntry { mount_point: "/mnt/data".into(), fs_type: "ext4".into(), source: "/dev/sdc1".into(), mount_options: "rw".into(), super_options: "rw".into() };
            let a = decide_access(&e, &facts(Err(libc::EACCES), Some(0)));
            assert!(!a.writable && a.foreign_owner && !a.can_fix);
        }

        #[test]
        fn mount_options_for_the_user() {
            assert_eq!(user_mount_options("vfat", 1000, 1000), "uid=1000,gid=1000,umask=022,utf8,shortname=mixed");
            assert_eq!(user_mount_options("exfat", 1001, 100), "uid=1001,gid=100,umask=022");
        }

        #[test]
        fn refuses_odd_device_and_mount_paths() {
            assert!(safe_mount_args("/dev/mmcblk0p1", "/media/ben/SD KARTE"));
            assert!(!safe_mount_args("/dev/sdb1", "/"));
            assert!(!safe_mount_args("/dev/sdb1", "/home"));
            assert!(!safe_mount_args("/dev/sdb1", "relative/path"));
            assert!(!safe_mount_args("/dev/sdb1", "/mnt/a,uid=0"));
            assert!(!safe_mount_args("/dev/sdb1", "/mnt/x/../etc"));
            assert!(!safe_mount_args("/dev/sdb1", "/mnt/a\nb"));
            assert!(!safe_mount_args("-o/dev/sdb1", "/mnt/a"));
            assert!(!safe_mount_args("/dev/sd b1", "/mnt/a"));
            assert!(!safe_mount_args("/tmp/x", "/mnt/a"));
        }

        #[test]
        fn remount_errors_map_to_codes() {
            // udisksctl unmount
            assert_eq!(udisks_step_result(false, true, ""), Ok(()));
            assert_eq!(udisks_step_result(false, false, "GDBus.Error:org.freedesktop.UDisks2.Error.NotMounted: Device `/dev/sdb1' is not mounted"), Ok(()));
            assert_eq!(
                udisks_step_result(false, false, "Error unmounting /dev/sdb1: GDBus.Error:org.freedesktop.UDisks2.Error.DeviceBusy: Error unmounting /dev/sdb1: target is busy"),
                Err("busy")
            );
            assert_eq!(udisks_step_result(false, false, "GDBus.Error:org.freedesktop.UDisks2.Error.NotAuthorizedDismissed: Not authorized to perform operation"), Err("cancelled"));
            assert_eq!(udisks_step_result(false, false, "GDBus.Error:org.freedesktop.UDisks2.Error.NotAuthorized: Not authorized to perform operation"), Err("permission"));
            assert_eq!(udisks_step_result(false, false, "Error looking up object for device /dev/sdb1"), Err("not-found"));
            // udisksctl mount
            assert_eq!(
                udisks_step_result(true, false, "Error mounting /dev/sdb1: GDBus.Error:org.freedesktop.UDisks2.Error.AlreadyMounted: Device /dev/sdb1 is already mounted at `/media/ben/TONUINO'."),
                Ok(())
            );
            assert_eq!(udisks_step_result(true, false, "Error mounting /dev/sdb1: GDBus.Error:org.freedesktop.UDisks2.Error.Failed: wrong fs type"), Err("other"));
            assert_eq!(udisks_step_result(true, false, "Device `/dev/sdb1' is not mounted"), Err("other"));
            // pkexec
            assert_eq!(pkexec_error_code(Some(126), "Error executing command as another user: Request dismissed"), "cancelled");
            assert_eq!(pkexec_error_code(Some(127), "Error executing command as another user: Not authorized"), "permission");
            assert_eq!(pkexec_error_code(Some(10), "umount: /mnt/usb-x: target is busy."), "busy");
            assert_eq!(pkexec_error_code(Some(11), "mount: wrong fs type"), "other");
        }

        #[test]
        fn udev_label_escapes_and_udisks_errors() {
            assert_eq!(decode_udev_escapes("SD\\x20KARTE"), "SD KARTE");
            assert_eq!(decode_udev_escapes("TONUINO"), "TONUINO");
            assert_eq!(
                udisks_error_code("Error unmounting /dev/sdb1: GDBus.Error:org.freedesktop.UDisks2.Error.DeviceBusy: Error unmounting /dev/sdb1: target is busy"),
                Some("busy")
            );
            assert_eq!(udisks_error_code("GDBus.Error:org.freedesktop.UDisks2.Error.NotMounted: Device `/dev/sdb1' is not mounted"), None);
            assert_eq!(udisks_error_code("GDBus.Error:org.freedesktop.UDisks2.Error.NotAuthorizedDismissed: Not authorized"), Some("permission"));
        }
    }
}

/* --------------------------------------------------------------- macOS */

#[cfg(target_os = "macos")]
pub(crate) mod platform {
    use super::*;
    use std::process::Command;
    use sysinfo::{DiskRefreshKind, Disks};

    fn is_candidate(mount: &str, removable: bool) -> bool {
        if mount == "/" || mount.starts_with("/System/") || mount.starts_with("/private/") {
            return false;
        }
        mount.starts_with("/Volumes/") || removable
    }

    /// Opened disk images (the app's own .dmg) and CDs are mounted read-only
    /// with HFS+ or APFS; a locked card keeps its FAT or exFAT and stays.
    fn is_disk_image(fs: &str, read_only: bool) -> bool {
        read_only && !matches!(fs.to_ascii_lowercase().as_str(), "msdos" | "exfat")
    }

    pub fn list_volumes() -> Vec<VolumeDto> {
        let disks = Disks::new_with_refreshed_list_specifics(DiskRefreshKind::nothing().with_storage());
        disks
            .list()
            .iter()
            .filter(|d| is_candidate(&d.mount_point().to_string_lossy(), d.is_removable()))
            .filter(|d| !is_disk_image(&d.file_system().to_string_lossy(), d.is_read_only()))
            .map(|d| {
                let mount = d.mount_point().to_string_lossy().into_owned();
                let stats = statvfs(d.mount_point());
                let name = d.name().to_string_lossy().into_owned();
                let label = if name.is_empty() {
                    d.mount_point().file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| mount.clone())
                } else {
                    name
                };
                VolumeDto {
                    id: mount.clone(),
                    label,
                    mount_path: mount,
                    fs_type: Some(d.file_system().to_string_lossy().into_owned()),
                    cluster_size: stats.as_ref().map(|s| s.cluster),
                    total_bytes: Some(d.total_space()),
                    free_bytes: Some(d.available_space()),
                    removable: d.is_removable(),
                    device: None,
                    can_eject: true,
                    // The lock slider of the card or its adapter mounts it read-only.
                    writable: !d.is_read_only(),
                    read_only: d.is_read_only(),
                    foreign_owner: false,
                    can_fix_access: false,
                    read_only_by_system: false,
                }
            })
            .collect()
    }

    pub fn info_for_path(path: &Path) -> VolumeInfoDto {
        let disks = Disks::new_with_refreshed_list_specifics(DiskRefreshKind::nothing().with_storage());
        let best = disks.list().iter().filter(|d| path.starts_with(d.mount_point())).max_by_key(|d| d.mount_point().as_os_str().len());
        let stats = statvfs(path);
        let mut dto = VolumeInfoDto {
            cluster_size: stats.as_ref().map(|s| s.cluster),
            total_bytes: stats.as_ref().map(|s| s.total),
            free_bytes: stats.as_ref().map(|s| s.free),
            ..Default::default()
        };
        if let Some(d) = best {
            dto.fs_type = Some(d.file_system().to_string_lossy().into_owned());
            dto.removable = d.is_removable();
            dto.can_eject = path == d.mount_point() && is_candidate(&d.mount_point().to_string_lossy(), d.is_removable());
            dto.mount_path = Some(d.mount_point().to_string_lossy().into_owned());
        }
        // Asked of the path itself: a folder in the home folder lies on the
        // writable data volume, although "/" (read-only system) is the
        // longest mount point above it that the list names.
        if stats.as_ref().is_some_and(|s| s.read_only) {
            dto.read_only = true;
            dto.writable = false;
        }
        dto
    }

    pub fn eject(volume: &VolumeDto) -> CmdResult<()> {
        // SAFETY: plain syscall.
        unsafe { libc::sync() };
        let out = Command::new("diskutil")
            .args(["eject", &volume.mount_path])
            .output()
            .map_err(|e| CmdError::new("unsupported", format!("diskutil: {e}")))?;
        if out.status.success() {
            return Ok(());
        }
        let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
        let code = if text.contains("dissent") || text.contains("busy") || text.contains("in use") { "busy" } else { "other" };
        Err(CmdError::new(code, text.trim().to_string()))
    }

    pub fn remount_for_user(_volume: &VolumeDto) -> CmdResult<()> {
        Err(CmdError::new("unsupported", "mounting again is only offered on Linux"))
    }
}

/* ------------------------------------------------------------- Windows */

#[cfg(windows)]
pub(crate) mod platform {
    use super::*;
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    use sysinfo::{DiskRefreshKind, Disks};
    use windows_sys::Win32::Storage::FileSystem::{GetDiskFreeSpaceW, GetDriveTypeW, GetVolumeInformationW};

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const DRIVE_REMOVABLE: u32 = 2;
    const DRIVE_NO_ROOT_DIR: u32 = 1;

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn root_of(mount: &str) -> String {
        let mut r = mount.to_string();
        if !r.ends_with('\\') {
            r.push('\\');
        }
        r
    }

    /// (label, filesystem name) via GetVolumeInformationW.
    fn volume_information(root: &str) -> Option<(String, String)> {
        let w = wide(root);
        let mut label = [0u16; 261];
        let mut fs = [0u16; 261];
        // SAFETY: buffers are valid for the given lengths.
        let ok = unsafe {
            GetVolumeInformationW(
                w.as_ptr(),
                label.as_mut_ptr(),
                label.len() as u32,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                fs.as_mut_ptr(),
                fs.len() as u32,
            )
        };
        if ok == 0 {
            return None;
        }
        let s = |b: &[u16]| String::from_utf16_lossy(&b[..b.iter().position(|c| *c == 0).unwrap_or(b.len())]);
        Some((s(&label), s(&fs)))
    }

    /// Cluster size via GetDiskFreeSpaceW.
    fn cluster_size(root: &str) -> Option<u64> {
        let w = wide(root);
        let (mut spc, mut bps, mut free, mut total) = (0u32, 0u32, 0u32, 0u32);
        // SAFETY: out-pointers are valid.
        let ok = unsafe { GetDiskFreeSpaceW(w.as_ptr(), &mut spc, &mut bps, &mut free, &mut total) };
        (ok != 0).then(|| spc as u64 * bps as u64)
    }

    fn drive_type(root: &str) -> u32 {
        let w = wide(root);
        // SAFETY: valid NUL-terminated string.
        unsafe { GetDriveTypeW(w.as_ptr()) }
    }

    pub fn list_volumes() -> Vec<VolumeDto> {
        let disks = Disks::new_with_refreshed_list_specifics(DiskRefreshKind::nothing().with_storage());
        disks
            .list()
            .iter()
            .filter(|d| d.is_removable())
            .map(|d| {
                let mount = d.mount_point().to_string_lossy().into_owned();
                let root = root_of(&mount);
                let (label, fs) = volume_information(&root).unwrap_or_default();
                let drive = mount.trim_end_matches('\\').to_string();
                VolumeDto {
                    id: mount.clone(),
                    label: if label.is_empty() { format!("Wechseldatenträger ({drive})") } else { label },
                    mount_path: mount,
                    fs_type: Some(if fs.is_empty() { d.file_system().to_string_lossy().into_owned() } else { fs }),
                    cluster_size: cluster_size(&root),
                    total_bytes: Some(d.total_space()),
                    free_bytes: Some(d.available_space()),
                    removable: true,
                    device: Some(drive),
                    can_eject: true,
                    // The lock slider of the card or its adapter: Windows
                    // reports the volume read-only (FILE_READ_ONLY_VOLUME).
                    writable: !d.is_read_only(),
                    read_only: d.is_read_only(),
                    foreign_owner: false,
                    can_fix_access: false,
                    read_only_by_system: false,
                }
            })
            .collect()
    }

    pub fn info_for_path(path: &Path) -> VolumeInfoDto {
        // Canonical paths look like \\?\E:\folder; the drive root is the first three characters after the prefix.
        let text = path.to_string_lossy();
        let plain = text.strip_prefix(r"\\?\").unwrap_or(&text);
        let mut dto = VolumeInfoDto::default();
        if plain.len() >= 2 && plain.as_bytes()[1] == b':' {
            let root = format!("{}\\", &plain[..2]);
            let disks = Disks::new_with_refreshed_list_specifics(DiskRefreshKind::nothing().with_storage());
            if let Some(d) = disks.list().iter().find(|d| d.mount_point().to_string_lossy().eq_ignore_ascii_case(&root)) {
                dto.total_bytes = Some(d.total_space());
                dto.free_bytes = Some(d.available_space());
                if d.is_read_only() {
                    dto.read_only = true;
                    dto.writable = false;
                }
            }
            dto.fs_type = volume_information(&root).map(|(_, fs)| fs);
            dto.cluster_size = cluster_size(&root);
            dto.removable = drive_type(&root) == DRIVE_REMOVABLE;
            dto.device = Some(plain[..2].to_string());
            dto.can_eject = dto.removable && plain.trim_end_matches('\\').len() == 2;
            dto.mount_path = Some(root);
        }
        dto
    }

    pub fn eject(volume: &VolumeDto) -> CmdResult<()> {
        let drive = volume.device.clone().unwrap_or_else(|| volume.mount_path.trim_end_matches('\\').to_string());
        if drive.len() != 2 || !drive.ends_with(':') {
            return Err(CmdError::new("unsupported", format!("not a drive letter: {drive}")));
        }
        // Explorer's "Auswerfen": flushes and safely removes the medium.
        let script = format!(
            "$ErrorActionPreference='Stop'; $i=(New-Object -ComObject Shell.Application).Namespace(17).ParseName('{drive}'); if ($null -eq $i) {{ exit 3 }}; $i.InvokeVerb('Eject')"
        );
        let out = Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", &script])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|e| CmdError::new("unsupported", format!("powershell: {e}")))?;
        if out.status.code() == Some(3) {
            return Err(CmdError::new("not-found", format!("drive {drive} not found")));
        }
        // The verb works asynchronously: wait until the drive is gone.
        let root = root_of(&drive);
        for _ in 0..40 {
            let t = drive_type(&root);
            if t == DRIVE_NO_ROOT_DIR || volume_information(&root).is_none() {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(150));
        }
        Err(CmdError::new("busy", format!("{drive} is still in use: {}", String::from_utf8_lossy(&out.stderr).trim())))
    }

    pub fn remount_for_user(_volume: &VolumeDto) -> CmdResult<()> {
        Err(CmdError::new("unsupported", "mounting again is only offered on Linux"))
    }
}

/* --------------------------------------------------------------- other */

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
pub(crate) mod platform {
    use super::*;
    pub fn list_volumes() -> Vec<VolumeDto> {
        Vec::new()
    }
    pub fn info_for_path(_path: &Path) -> VolumeInfoDto {
        VolumeInfoDto::default()
    }
    pub fn eject(_volume: &VolumeDto) -> CmdResult<()> {
        Err(CmdError::new("unsupported", "eject is not supported on this system"))
    }

    pub fn remount_for_user(_volume: &VolumeDto) -> CmdResult<()> {
        Err(CmdError::new("unsupported", "mounting again is only offered on Linux"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vol(id: &str, free: u64) -> VolumeDto {
        VolumeDto {
            id: id.into(),
            label: "TONUINO".into(),
            mount_path: id.into(),
            fs_type: Some("vfat".into()),
            cluster_size: Some(32768),
            total_bytes: Some(1 << 33),
            free_bytes: Some(free),
            removable: true,
            device: Some("/dev/sdb1".into()),
            can_eject: true,
            writable: true,
            read_only: false,
            foreign_owner: false,
            can_fix_access: false,
            read_only_by_system: false,
        }
    }

    #[test]
    fn free_space_changes_do_not_count_as_a_new_set() {
        assert!(same_set(&[vol("/media/a", 1)], &[vol("/media/a", 2)]));
        assert!(!same_set(&[vol("/media/a", 1)], &[vol("/media/b", 1)]));
        assert!(!same_set(&[vol("/media/a", 1)], &[]));
    }

    #[test]
    fn serializes_camel_case() {
        let json = serde_json::to_value(vol("/media/a", 5)).unwrap();
        assert_eq!(json["mountPath"], "/media/a");
        assert_eq!(json["clusterSize"], 32768);
        assert_eq!(json["canEject"], true);
        assert_eq!(json["writable"], true);
        assert_eq!(json["readOnly"], false);
        assert_eq!(json["foreignOwner"], false);
        assert_eq!(json["canFixAccess"], false);
    }

    #[cfg(unix)]
    #[test]
    fn statvfs_reports_sizes() {
        let s = statvfs(Path::new("/")).expect("statvfs on /");
        assert!(s.total > 0 && s.cluster > 0);
    }
}

#[cfg(all(test, target_os = "macos"))]
#[path = "mac_card_tests.rs"]
mod mac_card_tests;
