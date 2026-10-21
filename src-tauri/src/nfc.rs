//! RFID cards through PC/SC readers (ACR122U and similar).
//!
//! TonUINO stores 16 bytes on the card: MIFARE Classic block 4 (sector 1,
//! key A FF FF FF FF FF FF), MIFARE Ultralight / NTAG21x pages 8–11.

use crate::error::{blocking, CmdError, CmdResult};
use crate::serial::Hint;
use crate::util::hex_upper;
use serde::Serialize;
use std::ffi::CString;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CardDto {
    pub uid: String,
    pub card_type: &'static str,
    pub atr: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReadDto {
    pub uid: String,
    pub card_type: &'static str,
    pub atr: String,
    pub data: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Family {
    Classic,
    Ultralight,
}

/* ------------------------------------------------------------------ ATR */

/// Card type from a PC/SC Part 3 ATR for contactless storage cards:
/// 3B 8F 80 01 80 4F 0C [A0 00 00 03 06] [SS] [C0 C1] 00 00 00 00 TCK.
pub fn card_type_from_atr(atr: &[u8]) -> &'static str {
    const RID: [u8; 5] = [0xA0, 0x00, 0x00, 0x03, 0x06];
    let Some(i) = atr.windows(5).position(|w| w == RID) else { return "unknown" };
    let (Some(&standard), Some(&c0), Some(&c1)) = (atr.get(i + 5), atr.get(i + 6), atr.get(i + 7)) else {
        return "unknown";
    };
    // Standard 03 = ISO 14443 A part 3 (11 = FeliCa, 07/0B = ISO 15693 …).
    if standard != 0x03 {
        return "unknown";
    }
    match (c0, c1) {
        (0x00, 0x01) => "mifare-classic-1k",
        (0x00, 0x02) => "mifare-classic-4k",
        (0x00, 0x03) => "mifare-ultralight", // also NTAG21x on most readers
        (0x00, 0x26) => "mifare-classic-mini",
        (0x00, 0x3A) | (0x00, 0x3D) => "mifare-ultralight", // Ultralight C, Ultralight EV1
        (0x00, 0x36) | (0x00, 0x38) => "mifare-classic-1k", // MIFARE Plus 2K in SL1/SL2 behaves like Classic
        (0x00, 0x37) | (0x00, 0x39) => "mifare-classic-4k", // MIFARE Plus 4K in SL1/SL2
        _ => "unknown",
    }
}

pub fn family(card_type: &str) -> Option<Family> {
    match card_type {
        "mifare-classic-1k" | "mifare-classic-4k" | "mifare-classic-mini" => Some(Family::Classic),
        "mifare-ultralight" | "ntag213" | "ntag215" | "ntag216" => Some(Family::Ultralight),
        _ => None,
    }
}

/// NTAG type from a GET_VERSION answer (8 bytes).
pub fn ntag_from_version(v: &[u8]) -> Option<&'static str> {
    if v.len() < 8 || v[1] != 0x04 {
        return None;
    }
    match (v[2], v[6]) {
        (0x04, 0x0F) => Some("ntag213"),
        (0x04, 0x11) => Some("ntag215"),
        (0x04, 0x13) => Some("ntag216"),
        (0x03, _) => Some("mifare-ultralight"),
        _ => None,
    }
}

/* ----------------------------------------------------------- transport */

pub trait Transport {
    fn transmit(&mut self, apdu: &[u8]) -> CmdResult<Vec<u8>>;
}

fn sw(resp: &[u8]) -> (&[u8], u16) {
    if resp.len() < 2 {
        return (&[], 0);
    }
    let n = resp.len() - 2;
    (&resp[..n], u16::from_be_bytes([resp[n], resp[n + 1]]))
}

const OK: u16 = 0x9000;
const CLASSIC_BLOCK: u8 = 4;
const UL_FIRST_PAGE: u8 = 8;
const DEFAULT_KEY: [u8; 6] = [0xFF; 6];
/// Key A many phone apps set when they "format" a card for NDEF.
const NDEF_KEY: [u8; 6] = [0xD3, 0xF7, 0xD3, 0xF7, 0xD3, 0xF7];

pub fn get_uid(t: &mut dyn Transport) -> CmdResult<Vec<u8>> {
    let resp = t.transmit(&[0xFF, 0xCA, 0x00, 0x00, 0x00])?;
    let (data, status) = sw(&resp);
    if status != OK || data.is_empty() {
        return Err(CmdError::new("read-failed", format!("GET UID failed: {status:04X}")));
    }
    Ok(data.to_vec())
}

fn load_key(t: &mut dyn Transport, key: &[u8; 6]) -> CmdResult<()> {
    let mut apdu = vec![0xFF, 0x82, 0x00, 0x00, 0x06];
    apdu.extend_from_slice(key);
    let resp = t.transmit(&apdu)?;
    match sw(&resp).1 {
        OK => Ok(()),
        s => Err(CmdError::other(format!("LOAD KEY failed: {s:04X}"))),
    }
}

fn authenticate(t: &mut dyn Transport, block: u8, key: &[u8; 6]) -> CmdResult<bool> {
    load_key(t, key)?;
    let resp = t.transmit(&[0xFF, 0x86, 0x00, 0x00, 0x05, 0x01, 0x00, block, 0x60, 0x00])?;
    Ok(sw(&resp).1 == OK)
}

fn read16(t: &mut dyn Transport, block_or_page: u8) -> CmdResult<[u8; 16]> {
    let resp = t.transmit(&[0xFF, 0xB0, 0x00, block_or_page, 0x10])?;
    let (data, status) = sw(&resp);
    if status != OK || data.len() < 16 {
        return Err(CmdError::new("read-failed", format!("READ {block_or_page} failed: {status:04X} ({} bytes)", data.len())));
    }
    let mut out = [0u8; 16];
    out.copy_from_slice(&data[..16]);
    Ok(out)
}

fn write_chunk(t: &mut dyn Transport, block_or_page: u8, data: &[u8]) -> CmdResult<()> {
    let mut apdu = vec![0xFF, 0xD6, 0x00, block_or_page, data.len() as u8];
    apdu.extend_from_slice(data);
    let resp = t.transmit(&apdu)?;
    match sw(&resp).1 {
        OK => Ok(()),
        s => Err(CmdError::new("write-failed", format!("UPDATE {block_or_page} failed: {s:04X}"))),
    }
}

/// Authenticates sector 1 with key A FF…FF, like the TonUINO firmware.
fn classic_login(t: &mut dyn Transport) -> CmdResult<()> {
    if authenticate(t, CLASSIC_BLOCK, &DEFAULT_KEY)? {
        Ok(())
    } else {
        Err(CmdError::new("auth-failed", "key A FF FF FF FF FF FF rejected for sector 1"))
    }
}

pub fn read_data(t: &mut dyn Transport, family: Family) -> CmdResult<[u8; 16]> {
    match family {
        Family::Classic => {
            classic_login(t)?;
            read16(t, CLASSIC_BLOCK)
        }
        Family::Ultralight => read16(t, UL_FIRST_PAGE),
    }
}

/// Writes the 16 TonUINO bytes and reads them back.
pub fn write_data(t: &mut dyn Transport, family: Family, data: &[u8; 16]) -> CmdResult<()> {
    match family {
        Family::Classic => {
            classic_login(t)?;
            write_chunk(t, CLASSIC_BLOCK, data)?;
        }
        Family::Ultralight => {
            for (i, page) in data.chunks(4).enumerate() {
                write_chunk(t, UL_FIRST_PAGE + i as u8, page)?;
            }
        }
    }
    let back = match family {
        Family::Classic => read16(t, CLASSIC_BLOCK),
        Family::Ultralight => read16(t, UL_FIRST_PAGE),
    }
    .map_err(|e| CmdError::new("verify-failed", e.detail))?;
    if &back != data {
        return Err(CmdError::new(
            "verify-failed",
            format!("wrote {} but read {}", hex_upper(data, " "), hex_upper(&back, " ")),
        ));
    }
    Ok(())
}

/// GET_VERSION through the ACR122U's PN532 (InCommunicateThru).
fn acr122_get_version(t: &mut dyn Transport) -> Option<Vec<u8>> {
    let resp = t.transmit(&[0xFF, 0x00, 0x00, 0x00, 0x03, 0xD4, 0x42, 0x60]).ok()?;
    let (data, status) = sw(&resp);
    if status != OK || data.len() < 11 || data[0] != 0xD5 || data[1] != 0x43 || data[2] != 0x00 {
        return None;
    }
    Some(data[3..11].to_vec())
}

/* ---------------------------------------------------------------- PC/SC */

fn linux_hints() -> Vec<String> {
    #[cfg_attr(not(target_os = "linux"), allow(unused_mut))]
    let mut hints = Vec::new();
    #[cfg(target_os = "linux")]
    {
        use std::path::Path;
        let pcscd = ["/usr/sbin/pcscd", "/usr/bin/pcscd", "/sbin/pcscd"].iter().any(|p| Path::new(p).exists());
        if !pcscd {
            hints.push("linux-install-pcscd".to_string());
        }
        if acr122_plugged_in() {
            if Path::new("/sys/module/pn533_usb").exists() || Path::new("/sys/module/pn533").exists() {
                hints.push("linux-blacklist-pn533".to_string());
            }
            // Fedora and openSUSE keep the drivers under lib64.
            let drivers = ["/usr/lib/pcsc/drivers", "/usr/lib64/pcsc/drivers", "/usr/local/lib/pcsc/drivers"]
                .iter()
                .filter_map(|dir| std::fs::read_dir(dir).ok())
                .flat_map(|rd| rd.flatten().map(|e| e.file_name().to_string_lossy().to_lowercase()))
                .collect::<Vec<_>>();
            if pcscd && !drivers.iter().any(|d| d.contains("ccid")) {
                hints.push("linux-install-ccid".to_string());
            }
        }
    }
    hints
}

#[cfg(target_os = "linux")]
fn acr122_plugged_in() -> bool {
    std::fs::read_dir("/sys/bus/usb/devices")
        .map(|rd| {
            rd.flatten().any(|d| {
                let read = |f: &str| std::fs::read_to_string(d.path().join(f)).unwrap_or_default().trim().to_string();
                read("idVendor") == "072f" && read("idProduct") == "2200"
            })
        })
        .unwrap_or(false)
}

fn pcsc_unavailable(detail: impl Into<String>) -> CmdError {
    CmdError::new("pcsc-unavailable", detail).with_hints(linux_hints())
}

fn map_pcsc(e: pcsc::Error, what: &str) -> CmdError {
    use pcsc::Error as E;
    let code = match e {
        // Windows stops its smart card service while no reader is plugged in.
        E::NoService | E::ServiceStopped if cfg!(windows) => "no-reader",
        E::NoService | E::ServiceStopped => return pcsc_unavailable(format!("{what}: {e}")),
        E::NoReadersAvailable | E::UnknownReader | E::ReaderUnavailable => "no-reader",
        E::NoSmartcard | E::RemovedCard | E::UnpoweredCard | E::UnresponsiveCard | E::ResetCard | E::Timeout => "no-card",
        E::SharingViolation => "busy",
        E::UnsupportedCard | E::CardUnsupported => "unsupported-card",
        _ => "other",
    };
    CmdError::new(code, format!("{what}: {e}"))
}

fn context() -> CmdResult<pcsc::Context> {
    pcsc::Context::establish(pcsc::Scope::User).map_err(|e| map_pcsc(e, "context"))
}

struct CardTransport<'a>(&'a pcsc::Card);

impl Transport for CardTransport<'_> {
    fn transmit(&mut self, apdu: &[u8]) -> CmdResult<Vec<u8>> {
        let mut buf = [0u8; pcsc::MAX_BUFFER_SIZE];
        self.0.transmit(apdu, &mut buf).map(<[u8]>::to_vec).map_err(|e| map_pcsc(e, "transmit"))
    }
}

fn reader_name(reader: &str) -> CmdResult<CString> {
    CString::new(reader).map_err(|_| CmdError::invalid("reader name contains NUL"))
}

fn list_readers() -> CmdResult<Vec<String>> {
    let ctx = match context() {
        Ok(ctx) => ctx,
        Err(e) if e.code == "no-reader" => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    match ctx.list_readers_owned() {
        Ok(names) => Ok(names.into_iter().map(|n| n.to_string_lossy().into_owned()).collect()),
        Err(pcsc::Error::NoReadersAvailable) => Ok(Vec::new()),
        Err(e) => Err(map_pcsc(e, "list readers")),
    }
}

struct Connected {
    card: pcsc::Card,
    atr: Vec<u8>,
    uid: Vec<u8>,
    card_type: &'static str,
}

fn connect(ctx: &pcsc::Context, reader: &str) -> CmdResult<Connected> {
    let name = reader_name(reader)?;
    let card = ctx
        .connect(&name, pcsc::ShareMode::Shared, pcsc::Protocols::ANY)
        .map_err(|e| map_pcsc(e, "connect"))?;
    let atr = card.status2_owned().map(|s| s.atr().to_vec()).unwrap_or_default();
    let uid = get_uid(&mut CardTransport(&card))?;
    let card_type = card_type_from_atr(&atr);
    Ok(Connected { card, atr, uid, card_type })
}

/// Refines "mifare-ultralight" to NTAG213/215/216 on ACR122U readers.
/// An original Ultralight does not know GET_VERSION and halts, so the card is
/// reset afterwards in that case. Must be the last command of a session.
fn refine_and_disconnect(c: Connected, reader: &str) -> &'static str {
    let mut card_type = c.card_type;
    let mut disposition = pcsc::Disposition::LeaveCard;
    if card_type == "mifare-ultralight" && reader.to_ascii_uppercase().contains("ACR122") {
        match acr122_get_version(&mut CardTransport(&c.card)).as_deref().and_then(ntag_from_version) {
            Some(t) => card_type = t,
            None => disposition = pcsc::Disposition::ResetCard,
        }
    }
    let _ = c.card.disconnect(disposition);
    card_type
}

fn dto(uid: &[u8], card_type: &'static str, atr: &[u8]) -> CardDto {
    CardDto { uid: hex_upper(uid, ":"), card_type, atr: hex_upper(atr, " ") }
}

fn wait_card(reader: &str, timeout: Duration) -> CmdResult<Option<CardDto>> {
    let ctx = context()?;
    let name = reader_name(reader)?;
    let mut states = [pcsc::ReaderState::new(name, pcsc::State::UNAWARE)];
    let deadline = Instant::now() + timeout;
    let mut first = true;
    let mut saw_mute = false;
    loop {
        let wait = if first { Duration::ZERO } else { deadline.saturating_duration_since(Instant::now()) };
        first = false;
        match ctx.get_status_change(wait, &mut states) {
            Ok(()) => {}
            Err(pcsc::Error::Timeout) => {
                if Instant::now() >= deadline {
                    return if saw_mute { Err(CmdError::new("unsupported-card", "the card does not answer")) } else { Ok(None) };
                }
            }
            Err(e) => return Err(map_pcsc(e, "wait")),
        }
        let ev = states[0].event_state();
        if ev.intersects(pcsc::State::UNKNOWN | pcsc::State::UNAVAILABLE) {
            return Err(CmdError::new("no-reader", format!("reader {reader} is not available")));
        }
        if ev.contains(pcsc::State::PRESENT) {
            if ev.contains(pcsc::State::MUTE) {
                saw_mute = true;
            } else {
                match connect(&ctx, reader) {
                    Ok(c) => {
                        let (uid, atr) = (c.uid.clone(), c.atr.clone());
                        let card_type = refine_and_disconnect(c, reader);
                        return Ok(Some(dto(&uid, card_type, &atr)));
                    }
                    // Card lifted again while connecting: keep waiting.
                    Err(e) if e.code == "no-card" => {}
                    Err(e) => return Err(e),
                }
            }
        }
        if Instant::now() >= deadline {
            return Ok(None);
        }
        states[0].sync_current_state();
    }
}

fn read_card(reader: &str) -> CmdResult<ReadDto> {
    let ctx = context()?;
    let c = connect(&ctx, reader)?;
    let fam = family(c.card_type)
        .ok_or_else(|| CmdError::new("unsupported-card", format!("ATR {}", hex_upper(&c.atr, " "))))?;
    let result = read_data(&mut CardTransport(&c.card), fam);
    let data = match result {
        Ok(d) => d,
        Err(e) if e.code == "auth-failed" => return Err(explain_auth_failure(c, reader, e)),
        Err(e) => return Err(e),
    };
    let (uid, atr) = (c.uid.clone(), c.atr.clone());
    let card_type = refine_and_disconnect(c, reader);
    Ok(ReadDto { uid: hex_upper(&uid, ":"), card_type, atr: hex_upper(&atr, " "), data: data.to_vec() })
}

fn write_card(reader: &str, data: &[u8; 16]) -> CmdResult<CardDto> {
    let ctx = context()?;
    let c = connect(&ctx, reader)?;
    let fam = family(c.card_type)
        .ok_or_else(|| CmdError::new("unsupported-card", format!("ATR {}", hex_upper(&c.atr, " "))))?;
    match write_data(&mut CardTransport(&c.card), fam, data) {
        Ok(()) => {}
        Err(e) if e.code == "auth-failed" => return Err(explain_auth_failure(c, reader, e)),
        Err(e) => return Err(e),
    }
    let (uid, atr) = (c.uid.clone(), c.atr.clone());
    let card_type = refine_and_disconnect(c, reader);
    Ok(dto(&uid, card_type, &atr))
}

/// After a failed login, checks whether the card was "formatted" by a phone
/// app (NDEF key D3 F7 …) to give a precise hint.
fn explain_auth_failure(c: Connected, reader: &str, err: CmdError) -> CmdError {
    let _ = c.card.disconnect(pcsc::Disposition::ResetCard);
    let ndef = (|| -> CmdResult<bool> {
        let ctx = context()?;
        let c2 = connect(&ctx, reader)?;
        let ok = authenticate(&mut CardTransport(&c2.card), CLASSIC_BLOCK, &NDEF_KEY)?;
        let _ = c2.card.disconnect(pcsc::Disposition::ResetCard);
        Ok(ok)
    })()
    .unwrap_or(false);
    if ndef {
        err.with_hints(["card-ndef-formatted".to_string()])
    } else {
        err.with_hints(["card-keys-changed".to_string()])
    }
}

/* ------------------------------------------------------------ commands */

#[tauri::command]
pub async fn nfc_list_readers() -> CmdResult<Vec<String>> {
    blocking(list_readers).await
}

/// Waits for a card; null on timeout.
#[tauri::command]
pub async fn nfc_wait_card(reader: String, timeout_ms: u64) -> CmdResult<Option<CardDto>> {
    blocking(move || wait_card(&reader, Duration::from_millis(timeout_ms.min(10 * 60_000)))).await
}

#[tauri::command]
pub async fn nfc_read(reader: String) -> CmdResult<ReadDto> {
    blocking(move || read_card(&reader)).await
}

#[tauri::command]
pub async fn nfc_write(reader: String, data: Vec<u8>) -> CmdResult<CardDto> {
    blocking(move || {
        let data: [u8; 16] = data.try_into().map_err(|_| CmdError::invalid("exactly 16 bytes expected"))?;
        write_card(&reader, &data)
    })
    .await
}

/// The terminal command for a setup hint, in the package manager of the
/// system (apt where it is not known). apt starts pcscd itself; the other
/// systems install it switched off.
fn hint_command(id: &str, distro: Option<crate::util::Distro>) -> (&'static str, &'static str) {
    use crate::util::Distro::{Arch, Fedora, Suse};
    match (id, distro) {
        ("linux-install-pcscd", Some(Fedora)) => ("linux-install-pcscd", "sudo dnf install pcsc-lite pcsc-lite-ccid && sudo systemctl enable --now pcscd.socket"),
        ("linux-install-pcscd", Some(Arch)) => ("linux-install-pcscd", "sudo pacman -S --needed pcsclite ccid && sudo systemctl enable --now pcscd.socket"),
        ("linux-install-pcscd", Some(Suse)) => ("linux-install-pcscd", "sudo zypper install pcsc-lite pcsc-ccid && sudo systemctl enable --now pcscd.socket"),
        ("linux-install-pcscd", _) => ("linux-install-pcscd", "sudo apt install pcscd libacsccid1"),
        ("linux-blacklist-pn533", _) => (
            "linux-blacklist-pn533",
            "printf 'blacklist pn533_usb\\nblacklist pn533\\nblacklist nfc\\n' | sudo tee /etc/modprobe.d/blacklist-acr122u.conf && sudo modprobe -r pn533_usb pn533 nfc; sudo systemctl restart pcscd",
        ),
        ("linux-install-ccid", Some(Fedora)) => ("linux-install-ccid", "sudo dnf install pcsc-lite-ccid"),
        ("linux-install-ccid", Some(Arch)) => ("linux-install-ccid", "sudo pacman -S --needed ccid"),
        ("linux-install-ccid", Some(Suse)) => ("linux-install-ccid", "sudo zypper install pcsc-ccid"),
        ("linux-install-ccid", _) => ("linux-install-ccid", "sudo apt install libacsccid1"),
        _ => ("linux-start-pcscd", "sudo systemctl enable --now pcscd.socket"),
    }
}

/// Setup problems of the NFC reader (Linux: pcscd missing, pn533 kernel driver
/// grabbing the ACR122U, CCID driver missing).
#[tauri::command]
pub async fn nfc_diagnose() -> CmdResult<Vec<Hint>> {
    blocking(|| {
        #[cfg_attr(not(target_os = "linux"), allow(unused_mut))]
        let mut ids = linux_hints();
        #[cfg(target_os = "linux")]
        if ids.is_empty() && context().is_err() {
            ids.push("linux-start-pcscd".to_string());
        }
        #[cfg(target_os = "linux")]
        let distro = crate::util::linux_distro();
        #[cfg(not(target_os = "linux"))]
        let distro = None;
        Ok(ids
            .into_iter()
            .map(|id| {
                let (id, command) = hint_command(&id, distro);
                Hint { id, detail: None, command: Some(command.to_string()) }
            })
            .collect())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn atr(name: [u8; 2]) -> Vec<u8> {
        let mut a = vec![0x3B, 0x8F, 0x80, 0x01, 0x80, 0x4F, 0x0C, 0xA0, 0x00, 0x00, 0x03, 0x06, 0x03];
        a.extend_from_slice(&name);
        a.extend_from_slice(&[0x00, 0x00, 0x00, 0x00]);
        let tck = a[1..].iter().fold(0u8, |x, b| x ^ b);
        a.push(tck);
        a
    }

    #[test]
    fn setup_commands_follow_the_package_manager() {
        use crate::util::Distro;
        assert_eq!(hint_command("linux-install-pcscd", None).1, "sudo apt install pcscd libacsccid1");
        assert_eq!(hint_command("linux-install-pcscd", Some(Distro::Debian)).1, "sudo apt install pcscd libacsccid1");
        assert!(hint_command("linux-install-pcscd", Some(Distro::Fedora)).1.starts_with("sudo dnf install pcsc-lite pcsc-lite-ccid && sudo systemctl enable"));
        assert!(hint_command("linux-install-pcscd", Some(Distro::Arch)).1.starts_with("sudo pacman -S --needed pcsclite ccid"));
        assert_eq!(hint_command("linux-install-ccid", Some(Distro::Fedora)), ("linux-install-ccid", "sudo dnf install pcsc-lite-ccid"));
        assert_eq!(hint_command("linux-install-ccid", Some(Distro::PopOs)).1, "sudo apt install libacsccid1");
        assert_eq!(hint_command("linux-blacklist-pn533", Some(Distro::Arch)).0, "linux-blacklist-pn533");
        assert_eq!(hint_command("anything", None), ("linux-start-pcscd", "sudo systemctl enable --now pcscd.socket"));
    }

    #[test]
    fn parses_part3_atrs() {
        assert_eq!(card_type_from_atr(&atr([0x00, 0x01])), "mifare-classic-1k");
        assert_eq!(card_type_from_atr(&atr([0x00, 0x02])), "mifare-classic-4k");
        assert_eq!(card_type_from_atr(&atr([0x00, 0x03])), "mifare-ultralight");
        assert_eq!(card_type_from_atr(&atr([0x00, 0x26])), "mifare-classic-mini");
        assert_eq!(card_type_from_atr(&atr([0x00, 0x3A])), "mifare-ultralight");
        assert_eq!(card_type_from_atr(&atr([0xF0, 0x04])), "unknown");
        // Real ACR122U ATR of a MIFARE Classic 1K.
        let real = [0x3B, 0x8F, 0x80, 0x01, 0x80, 0x4F, 0x0C, 0xA0, 0x00, 0x00, 0x03, 0x06, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x6A];
        assert_eq!(card_type_from_atr(&real), "mifare-classic-1k");
        assert_eq!(real[19], atr([0x00, 0x01])[19], "test helper computes the same TCK");
        // DESFire (ISO 14443-4) and FeliCa are not storage cards for TonUINO.
        assert_eq!(card_type_from_atr(&[0x3B, 0x81, 0x80, 0x01, 0x80, 0x80]), "unknown");
        let mut felica = atr([0xF0, 0x11]);
        felica[12] = 0x11;
        assert_eq!(card_type_from_atr(&felica), "unknown");
        assert_eq!(card_type_from_atr(&[]), "unknown");
        assert_eq!(card_type_from_atr(&[0xA0, 0x00, 0x00, 0x03, 0x06, 0x03]), "unknown");
    }

    #[test]
    fn parses_ntag_versions() {
        assert_eq!(ntag_from_version(&[0x00, 0x04, 0x04, 0x02, 0x01, 0x00, 0x0F, 0x03]), Some("ntag213"));
        assert_eq!(ntag_from_version(&[0x00, 0x04, 0x04, 0x02, 0x01, 0x00, 0x11, 0x03]), Some("ntag215"));
        assert_eq!(ntag_from_version(&[0x00, 0x04, 0x04, 0x02, 0x01, 0x00, 0x13, 0x03]), Some("ntag216"));
        assert_eq!(ntag_from_version(&[0x00, 0x04, 0x03, 0x01, 0x01, 0x00, 0x0B, 0x03]), Some("mifare-ultralight"));
        assert_eq!(ntag_from_version(&[0x00]), None);
    }

    /// A simulated ACR122U with one card.
    struct FakeCard {
        classic: bool,
        memory: [u8; 64],
        key_ok: bool,
        loaded_key: Option<[u8; 6]>,
        authed: bool,
        /// Simulates a card that silently ignores writes.
        drop_writes: bool,
        log: Vec<Vec<u8>>,
    }

    impl FakeCard {
        fn new(classic: bool) -> Self {
            FakeCard { classic, memory: [0; 64], key_ok: true, loaded_key: None, authed: false, drop_writes: false, log: Vec::new() }
        }
        fn ok(mut data: Vec<u8>) -> Vec<u8> {
            data.extend_from_slice(&[0x90, 0x00]);
            data
        }
    }

    impl Transport for FakeCard {
        fn transmit(&mut self, apdu: &[u8]) -> CmdResult<Vec<u8>> {
            self.log.push(apdu.to_vec());
            Ok(match apdu {
                [0xFF, 0xCA, 0x00, 0x00, 0x00] => Self::ok(vec![0x04, 0xA2, 0x3B, 0x12]),
                [0xFF, 0x82, 0x00, 0x00, 0x06, key @ ..] => {
                    self.loaded_key = Some(key.try_into().unwrap());
                    Self::ok(vec![])
                }
                [0xFF, 0x86, 0x00, 0x00, 0x05, 0x01, 0x00, 0x04, 0x60, 0x00] => {
                    self.authed = self.classic && self.key_ok && self.loaded_key == Some([0xFF; 6]);
                    if self.authed { Self::ok(vec![]) } else { vec![0x63, 0x00] }
                }
                [0xFF, 0xB0, 0x00, addr, 0x10] => {
                    if self.classic && (!self.authed || *addr != 4) {
                        vec![0x63, 0x00]
                    } else {
                        let start = if self.classic { 0 } else { (*addr as usize - 8) * 4 };
                        Self::ok(self.memory[start..start + 16].to_vec())
                    }
                }
                [0xFF, 0xD6, 0x00, addr, len, data @ ..] if *len as usize == data.len() => {
                    if self.classic && (!self.authed || *addr != 4 || *len != 16) {
                        return Ok(vec![0x63, 0x00]);
                    }
                    if !self.classic && *len != 4 {
                        return Ok(vec![0x63, 0x00]);
                    }
                    if !self.drop_writes {
                        let start = if self.classic { 0 } else { (*addr as usize - 8) * 4 };
                        self.memory[start..start + data.len()].copy_from_slice(data);
                    }
                    Self::ok(vec![])
                }
                _ => vec![0x6A, 0x81],
            })
        }
    }

    const TONUINO: [u8; 16] = [0x13, 0x37, 0xB3, 0x47, 0x02, 0x05, 0x01, 0, 0, 0, 0, 0, 0, 0, 0, 0];

    #[test]
    fn classic_write_read_roundtrip() {
        let mut card = FakeCard::new(true);
        write_data(&mut card, Family::Classic, &TONUINO).unwrap();
        assert_eq!(read_data(&mut card, Family::Classic).unwrap(), TONUINO);
        assert_eq!(card.log[0], vec![0xFF, 0x82, 0x00, 0x00, 0x06, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]);
        assert_eq!(card.log[1], vec![0xFF, 0x86, 0x00, 0x00, 0x05, 0x01, 0x00, 0x04, 0x60, 0x00]);
        assert_eq!(&card.log[2][..5], &[0xFF, 0xD6, 0x00, 0x04, 0x10]);
        assert_eq!(get_uid(&mut card).unwrap(), vec![0x04, 0xA2, 0x3B, 0x12]);
    }

    #[test]
    fn ultralight_writes_pages_8_to_11() {
        let mut card = FakeCard::new(false);
        write_data(&mut card, Family::Ultralight, &TONUINO).unwrap();
        let writes: Vec<&Vec<u8>> = card.log.iter().filter(|a| a[1] == 0xD6).collect();
        assert_eq!(writes.len(), 4);
        for (i, w) in writes.iter().enumerate() {
            assert_eq!(&w[..5], &[0xFF, 0xD6, 0x00, 8 + i as u8, 0x04]);
            assert_eq!(&w[5..], &TONUINO[i * 4..i * 4 + 4]);
        }
        assert_eq!(read_data(&mut card, Family::Ultralight).unwrap(), TONUINO);
        assert_eq!(card.log.last().unwrap(), &vec![0xFF, 0xB0, 0x00, 0x08, 0x10]);
    }

    #[test]
    fn reports_auth_and_verify_failures() {
        let mut card = FakeCard::new(true);
        card.key_ok = false;
        assert_eq!(read_data(&mut card, Family::Classic).unwrap_err().code, "auth-failed");
        assert_eq!(write_data(&mut card, Family::Classic, &TONUINO).unwrap_err().code, "auth-failed");

        let mut card = FakeCard::new(false);
        card.drop_writes = true;
        assert_eq!(write_data(&mut card, Family::Ultralight, &TONUINO).unwrap_err().code, "verify-failed");

        // A Classic card treated as Ultralight refuses the 4-byte writes.
        let mut card = FakeCard::new(true);
        card.authed = true;
        assert_eq!(write_data(&mut card, Family::Ultralight, &TONUINO).unwrap_err().code, "write-failed");
    }

    #[test]
    fn families() {
        assert_eq!(family("ntag215"), Some(Family::Ultralight));
        assert_eq!(family("mifare-classic-mini"), Some(Family::Classic));
        assert_eq!(family("unknown"), None);
    }
}
