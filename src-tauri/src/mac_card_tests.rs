//! Real SD cards on macOS (.github/workflows/mac-test.yml): disk images that
//! macOS formatted itself (FAT32, exFAT), attached with hdiutil so they mount
//! under /Volumes like a card in a reader, one of them read-only (lock
//! slider). The app's own volume and file code runs against them.
//!
//! Ignored unless asked for, with the cards the workflow attached:
//!   TONUINO_MAC_CARDS=/Volumes/TSFAT32:rw,/Volumes/TSRO:ro \
//!     cargo test --lib mac_card_ -- --ignored --test-threads 1
//! `mac_card_check` reads and writes, `mac_card_eject` ejects them all.

use crate::fsops::{list_dir, read_range, rename_no_clobber, write_whole, DirEntryDto, OPEN_SUFFIX, PARTIAL_SUFFIX};
use crate::volumes::platform;
use crate::volumes::VolumeDto;
use std::path::{Path, PathBuf};
use std::process::Command;

struct Card {
    mount: String,
    read_only: bool,
}

fn cards() -> Vec<Card> {
    let spec = std::env::var("TONUINO_MAC_CARDS").expect("TONUINO_MAC_CARDS=/Volumes/X:rw,/Volumes/Y:ro");
    spec.split(',')
        .filter(|s| !s.trim().is_empty())
        .map(|s| {
            let (mount, mode) = s.trim().rsplit_once(':').expect("path:rw or path:ro");
            Card { mount: mount.to_string(), read_only: mode == "ro" }
        })
        .collect()
}

/// One line of `diskutil info`, e.g. "Removable Media" -> "Removable".
fn diskutil(mount: &str, key: &str) -> Option<String> {
    let out = Command::new("diskutil").args(["info", mount]).output().ok()?;
    String::from_utf8_lossy(&out.stdout).lines().find_map(|l| {
        let (k, v) = l.split_once(':')?;
        (k.trim() == key).then(|| v.trim().to_string())
    })
}

fn listed(mount: &str) -> Option<VolumeDto> {
    platform::list_volumes().into_iter().find(|v| v.mount_path == mount)
}

fn names(entries: &[DirEntryDto]) -> Vec<&str> {
    entries.iter().map(|e| e.name.as_str()).collect()
}

fn pattern(len: usize, seed: u8) -> Vec<u8> {
    (0..len).map(|i| (i as u8).wrapping_mul(31).wrapping_add(seed)).collect()
}

#[test]
#[ignore = "needs cards attached by .github/workflows/mac-test.yml"]
fn mac_card_check() {
    let all = platform::list_volumes();
    eprintln!("volumes the app lists:");
    for v in &all {
        eprintln!("  {} fs={:?} cluster={:?} total={:?} removable={} ro={} eject={}", v.mount_path, v.fs_type, v.cluster_size, v.total_bytes, v.removable, v.read_only, v.can_eject);
    }
    for card in cards() {
        let mount = card.mount.as_str();
        let root = Path::new(mount);
        let v = listed(mount).unwrap_or_else(|| panic!("{mount} is not in the app's volume list"));

        // What macOS says about the same volume.
        let removable_os = diskutil(mount, "Removable Media");
        let ejectable_os = diskutil(mount, "Ejectable");
        let ro_os = diskutil(mount, "Volume Read-Only").or_else(|| diskutil(mount, "Read-Only Volume"));
        let block_os = diskutil(mount, "Allocation Block Size");
        eprintln!("{mount}: diskutil removable={removable_os:?} ejectable={ejectable_os:?} read-only={ro_os:?} block={block_os:?}");

        let fs = v.fs_type.as_deref().unwrap_or("").to_ascii_lowercase();
        assert!(fs == "msdos" || fs == "exfat", "{mount}: fs type {fs:?}");
        assert!(v.can_eject, "{mount}: offered no eject");
        assert_eq!(v.read_only, card.read_only, "{mount}: read-only");
        assert_eq!(v.writable, !card.read_only, "{mount}: writable");
        if let Some(ro) = &ro_os {
            assert_eq!(v.read_only, ro.starts_with("Yes"), "{mount}: read-only differs from diskutil ({ro})");
        }
        // An attached image is removable media to macOS, as a card in a reader is.
        let removable = removable_os.as_deref().map(|r| r.starts_with("Removable")).unwrap_or(false) || ejectable_os.as_deref() == Some("Yes");
        assert_eq!(v.removable, removable, "{mount}: removable differs from diskutil");
        let cluster = v.cluster_size.expect("cluster size");
        assert!(cluster >= 512 && cluster.is_power_of_two(), "{mount}: cluster {cluster}");
        if let Some(b) = block_os.as_deref().and_then(|b| b.split_whitespace().next()).and_then(|n| n.parse::<u64>().ok()) {
            assert_eq!(cluster, b, "{mount}: cluster size differs from diskutil");
        }
        assert!(v.total_bytes.unwrap_or(0) > 100 << 20, "{mount}: size {:?}", v.total_bytes);

        let info = platform::info_for_path(root);
        assert_eq!(info.mount_path.as_deref(), Some(mount));
        assert!(info.can_eject && info.read_only == card.read_only && info.removable == v.removable, "{mount}: info {info:?}");
        let sub = platform::info_for_path(&root.join("01"));
        assert!(!sub.can_eject, "{mount}/01 must not be ejectable itself");
        assert_eq!(sub.read_only, card.read_only);

        // The TonUINO layout the workflow put on the card.
        let top = list_dir(root).expect("list top level");
        eprintln!("{mount}: top level {:?}", names(&top));
        for want in ["mp3", "advert", "01", "02"] {
            assert!(top.iter().any(|e| e.name == want && e.kind == "directory"), "{mount}: no folder {want}");
        }
        let folder = list_dir(&root.join("01")).expect("list 01");
        eprintln!("{mount}: 01 {:?}", names(&folder));
        let first = folder.iter().find(|e| e.name == "001.mp3").expect("01/001.mp3");
        assert_eq!(first.size, Some(3000));
        assert_eq!(read_range(&root.join("01/001.mp3"), 0, 10_000).unwrap(), vec![b'A'; 3000]);
        assert_eq!(read_range(&root.join("01/001.mp3"), 2990, 100).unwrap().len(), 10);
        assert!(list_dir(&root.join("mp3")).unwrap().iter().any(|e| e.name == "0001.mp3"));
        assert!(list_dir(&root.join("advert")).unwrap().iter().any(|e| e.name == "0001.mp3"));

        let new_track = root.join("01/002.mp3");
        if card.read_only {
            let err = write_whole(&new_track, b"x").expect_err("write on a read-only card");
            assert_eq!(err.code, "read-only", "{mount}: {err}");
            assert!(!new_track.exists());
            continue;
        }

        // A new file: written in place, no marker or AppleDouble twin stays.
        let a = pattern(200_000, 7);
        write_whole(&new_track, &a).expect("write 01/002.mp3");
        assert_eq!(read_range(&new_track, 0, 1 << 20).unwrap(), a);
        let after = list_dir(&root.join("01")).unwrap();
        let n = names(&after);
        eprintln!("{mount}: 01 after writing 002 {n:?}");
        assert!(!n.iter().any(|x| x.ends_with(OPEN_SUFFIX) || x.ends_with(PARTIAL_SUFFIX)), "{mount}: leftovers {n:?}");
        assert!(!n.contains(&"._002.mp3"), "{mount}: the app's write made an AppleDouble twin");

        // An existing file: replaced through the partial file, keeps its place in the order.
        let order_before: Vec<String> = after.iter().map(|e| e.name.clone()).filter(|x| !x.starts_with('.')).collect();
        let b = pattern(150_000, 99);
        write_whole(&root.join("01/001.mp3"), &b).expect("replace 01/001.mp3");
        assert_eq!(read_range(&root.join("01/001.mp3"), 0, 1 << 20).unwrap(), b);
        let replaced = list_dir(&root.join("01")).unwrap();
        let order_after: Vec<String> = replaced.iter().map(|e| e.name.clone()).filter(|x| !x.starts_with('.')).collect();
        eprintln!("{mount}: 01 order before replacing 001 {order_before:?}, after {order_after:?}");
        assert!(!names(&replaced).iter().any(|x| x.ends_with(PARTIAL_SUFFIX)), "{mount}: partial file left");
        assert_eq!(order_after, order_before, "{mount}: replacing 001.mp3 changed the order in the folder");

        // Folders and renames as the app makes them (fs_mkdir, fs_rename).
        std::fs::create_dir_all(root.join("03")).expect("mkdir 03");
        write_whole(&root.join("03/tmp.mp3"), b"abc").unwrap();
        rename_no_clobber(&root.join("03/tmp.mp3"), &root.join("03/001.mp3")).expect("rename");
        let err = rename_no_clobber(&root.join("01/002.mp3"), &root.join("01/001.mp3")).expect_err("rename onto another file");
        assert_eq!(err.code, "exists");
        // A case-only rename on a case-insensitive card is the same file, not a clash.
        rename_no_clobber(&root.join("03/001.mp3"), &root.join("03/001.MP3")).expect("case-only rename");
        assert!(list_dir(&root.join("03")).unwrap().iter().any(|e| e.name == "001.MP3"));
        rename_no_clobber(&root.join("03/001.MP3"), &root.join("03/001.mp3")).unwrap();

        // The catalog the app keeps at the top level.
        let catalog = root.join("tonuino-studio.json");
        write_whole(&catalog, br#"{"version":1}"#).unwrap();
        write_whole(&catalog, br#"{"version":2}"#).unwrap();
        assert_eq!(std::fs::read(&catalog).unwrap(), br#"{"version":2}"#);
    }
}

#[test]
#[ignore = "needs cards attached by .github/workflows/mac-test.yml"]
fn mac_card_eject() {
    for card in cards() {
        let v = listed(&card.mount).unwrap_or_else(|| panic!("{} is not listed", card.mount));
        platform::eject(&v).unwrap_or_else(|e| panic!("eject {}: {e}", card.mount));
        let gone = (0..20).any(|_| {
            if listed(&card.mount).is_none() && !PathBuf::from(&card.mount).exists() {
                return true;
            }
            std::thread::sleep(std::time::Duration::from_millis(250));
            false
        });
        assert!(gone, "{} still mounted after eject", card.mount);
    }
}
