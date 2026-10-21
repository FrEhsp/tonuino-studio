//! USB serial ports (Arduino Nano with CH340, LKP AiO with HT42B534, …):
//! listing, open/read/write, DTR/RTS control and Linux diagnostics.

use crate::error::{blocking, CmdError, CmdResult};
use crate::util::{body_bytes, header_u64};
use crate::SharedState;
use serde::Serialize;
use serialport::{ClearBuffer, SerialPort, SerialPortType};
use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::ipc::{Request, Response};
use tauri::State;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PortDto {
    pub id: String,
    pub label: String,
    pub path: String,
    pub usb_vendor_id: Option<u16>,
    pub usb_product_id: Option<u16>,
    pub manufacturer: Option<String>,
    pub product: Option<String>,
    pub serial_number: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedPort {
    pub handle: u32,
    pub path: String,
    pub baud_rate: u32,
}

/// One hint of `serial_diagnose`; `id` is stable, the bridge words it in German.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Hint {
    pub id: &'static str,
    /// Extra facts for the message, e.g. the group name or device path.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// A command the user can paste into a terminal to fix it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
}

type Port = Arc<Mutex<Box<dyn SerialPort>>>;

#[derive(Default)]
pub struct SerialPorts {
    next: AtomicU32,
    open: Mutex<HashMap<u32, Port>>,
}

impl SerialPorts {
    fn get(&self, handle: u32) -> CmdResult<Port> {
        self.open
            .lock()
            .ok()
            .and_then(|m| m.get(&handle).cloned())
            .ok_or_else(|| CmdError::new("closed", format!("serial handle {handle} is not open")))
    }
}

/// Friendly chip name for well-known USB serial adapters.
pub fn chip_name(vid: u16, pid: u16) -> Option<&'static str> {
    Some(match (vid, pid) {
        (0x1a86, 0x7523) => "CH340",
        (0x1a86, 0x5523) => "CH341",
        (0x1a86, 0x55d4) => "CH9102",
        (0x04d9, 0xb534) => "HT42B534 (LKP AiO)",
        (0x0403, 0x6001) => "FTDI FT232R",
        (0x0403, 0x6015) => "FTDI FT231X",
        (0x10c4, 0xea60) => "CP210x",
        (0x2341, _) | (0x2a03, _) => "Arduino",
        (0x303a, _) => "ESP32",
        _ => return None,
    })
}

fn base_name(path: &str) -> &str {
    path.rsplit(['/', '\\']).next().unwrap_or(path)
}

pub fn label_for(path: &str, vid: Option<u16>, pid: Option<u16>, product: Option<&str>, manufacturer: Option<&str>) -> String {
    let chip = match (vid, pid) {
        (Some(v), Some(p)) => chip_name(v, p).map(str::to_string),
        _ => None,
    };
    let name = chip
        .or_else(|| product.filter(|s| !s.trim().is_empty()).map(str::to_string))
        .or_else(|| manufacturer.filter(|s| !s.trim().is_empty()).map(str::to_string))
        .unwrap_or_else(|| "Serieller Anschluss".to_string());
    if vid.is_some() {
        format!("USB-Serial {name} ({})", base_name(path))
    } else {
        format!("{name} ({})", base_name(path))
    }
}

/// Keep USB ports; drop the dozens of legacy ttyS* ports on Linux and the
/// tty.* twins of cu.* devices on macOS.
fn keep_port(path: &str, usb: bool) -> bool {
    if cfg!(target_os = "macos") {
        return path.starts_with("/dev/cu.") && (usb || !path.contains("Bluetooth"));
    }
    if cfg!(windows) {
        return true;
    }
    usb
}

pub fn list_ports() -> CmdResult<Vec<PortDto>> {
    let ports = serialport::available_ports().map_err(|e| CmdError::other(format!("listing serial ports: {e}")))?;
    let mut out: Vec<PortDto> = ports
        .into_iter()
        .filter_map(|p| {
            let (usb, vid, pid, manufacturer, product, serial) = match &p.port_type {
                SerialPortType::UsbPort(u) => (true, Some(u.vid), Some(u.pid), u.manufacturer.clone(), u.product.clone(), u.serial_number.clone()),
                _ => (false, None, None, None, None, None),
            };
            if !keep_port(&p.port_name, usb) {
                return None;
            }
            Some(PortDto {
                id: p.port_name.clone(),
                label: label_for(&p.port_name, vid, pid, product.as_deref(), manufacturer.as_deref()),
                path: p.port_name,
                usb_vendor_id: vid,
                usb_product_id: pid,
                manufacturer,
                product,
                serial_number: serial,
            })
        })
        .collect();
    out.sort_by(|a, b| crate::util::natural_cmp(&a.path, &b.path));
    Ok(out)
}

fn map_serial_error(e: &serialport::Error, path: &str) -> CmdError {
    let code = match e.kind() {
        serialport::ErrorKind::NoDevice => {
            // Windows reports "access denied" (= in use) and "not found" alike.
            let present = serialport::available_ports().map(|l| l.iter().any(|p| p.port_name == path)).unwrap_or(true);
            if present { "busy" } else { "not-found" }
        }
        serialport::ErrorKind::Io(io::ErrorKind::PermissionDenied) => "permission",
        serialport::ErrorKind::Io(io::ErrorKind::NotFound) => "not-found",
        serialport::ErrorKind::InvalidInput => "invalid-argument",
        _ => "other",
    };
    CmdError::new(code, format!("{path}: {e}"))
}

fn map_io_error(e: &io::Error, path: &str) -> CmdError {
    let code = match e.kind() {
        io::ErrorKind::PermissionDenied => "permission",
        io::ErrorKind::NotFound | io::ErrorKind::BrokenPipe | io::ErrorKind::NotConnected => "disconnected",
        _ => match e.raw_os_error() {
            #[cfg(unix)]
            Some(libc::EIO) | Some(libc::ENXIO) | Some(libc::ENODEV) => "disconnected",
            #[cfg(windows)]
            Some(22) | Some(1167) | Some(995) => "disconnected", // BAD_COMMAND, DEVICE_NOT_CONNECTED, OPERATION_ABORTED
            _ => "other",
        },
    };
    CmdError::new(code, format!("{path}: {e}"))
}

fn port_name(port: &dyn SerialPort) -> String {
    port.name().unwrap_or_else(|| "serial".into())
}

/// Reads what arrives within `timeout`: returns as soon as data is there,
/// plus whatever is already buffered behind it. Empty on timeout.
/// The lock is taken in short slices so writes from another call can interleave.
fn read_with_timeout(port: &Port, timeout: Duration, max_bytes: usize) -> CmdResult<Vec<u8>> {
    const SLICE: Duration = Duration::from_millis(20);
    let deadline = Instant::now() + timeout;
    let mut buf = vec![0u8; max_bytes.max(1)];
    loop {
        {
            let mut p = port.lock().map_err(|_| CmdError::other("serial lock poisoned"))?;
            let name = port_name(p.as_ref());
            let remaining = deadline.saturating_duration_since(Instant::now());
            let slice = remaining.min(SLICE).max(Duration::from_millis(1));
            p.set_timeout(slice).map_err(|e| map_serial_error(&e, &name))?;
            match p.read(&mut buf) {
                Ok(0) => {}
                Ok(mut n) => {
                    while n < buf.len() {
                        let available = p.bytes_to_read().unwrap_or(0) as usize;
                        if available == 0 {
                            break;
                        }
                        let want = available.min(buf.len() - n);
                        match p.read(&mut buf[n..n + want]) {
                            Ok(0) => break,
                            Ok(m) => n += m,
                            Err(e) if matches!(e.kind(), io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted) => break,
                            Err(e) => return Err(map_io_error(&e, &name)),
                        }
                    }
                    buf.truncate(n);
                    return Ok(buf);
                }
                Err(e) if matches!(e.kind(), io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted) => {}
                Err(e) => return Err(map_io_error(&e, &name)),
            }
        }
        if Instant::now() >= deadline {
            return Ok(Vec::new());
        }
    }
}

/* ------------------------------------------------------------ commands */

#[tauri::command]
pub async fn serial_list() -> CmdResult<Vec<PortDto>> {
    blocking(list_ports).await
}

#[tauri::command]
pub async fn serial_open(state: State<'_, SharedState>, path: String, baud: u32) -> CmdResult<OpenedPort> {
    let st = state.inner().clone();
    blocking(move || {
        if !(300..=4_000_000).contains(&baud) {
            return Err(CmdError::invalid(format!("unsupported baud rate {baud}")));
        }
        // Only open real serial ports, not arbitrary device files.
        let known = serialport::available_ports()
            .map(|l| l.iter().any(|p| p.port_name == path))
            .unwrap_or(false);
        if !known {
            return Err(CmdError::new("not-found", format!("{path} is not a serial port")));
        }
        let port = serialport::new(&path, baud)
            .timeout(Duration::from_millis(100))
            .open()
            .map_err(|e| map_serial_error(&e, &path))?;
        let handle = st.serial.next.fetch_add(1, Ordering::Relaxed) + 1;
        st.serial
            .open
            .lock()
            .map_err(|_| CmdError::other("serial table poisoned"))?
            .insert(handle, Arc::new(Mutex::new(port)));
        Ok(OpenedPort { handle, path, baud_rate: baud })
    })
    .await
}

/// Raw body = bytes to send; header `x-handle`.
#[tauri::command]
pub async fn serial_write(state: State<'_, SharedState>, request: Request<'_>) -> CmdResult<()> {
    let st = state.inner().clone();
    let handle = header_u64(&request, "x-handle")? as u32;
    let data = body_bytes(&request)?;
    blocking(move || {
        let port = st.serial.get(handle)?;
        let mut p = port.lock().map_err(|_| CmdError::other("serial lock poisoned"))?;
        let name = port_name(p.as_ref());
        // Generous timeout: 10 bits per byte plus slack.
        let ms = 500 + (data.len() as u64 * 10_000) / p.baud_rate().unwrap_or(9600).max(1) as u64;
        p.set_timeout(Duration::from_millis(ms)).map_err(|e| map_serial_error(&e, &name))?;
        p.write_all(&data).map_err(|e| map_io_error(&e, &name))
    })
    .await
}

/// Raw bytes received within `timeout_ms` (at most `max_bytes`); empty on timeout.
#[tauri::command]
pub async fn serial_read(state: State<'_, SharedState>, handle: u32, timeout_ms: u64, max_bytes: Option<u32>) -> CmdResult<Response> {
    let st = state.inner().clone();
    blocking(move || {
        let port = st.serial.get(handle)?;
        let max = max_bytes.unwrap_or(4096).clamp(1, 1 << 20) as usize;
        let data = read_with_timeout(&port, Duration::from_millis(timeout_ms.min(600_000)), max)?;
        Ok(Response::new(data))
    })
    .await
}

#[tauri::command]
pub async fn serial_set_signals(state: State<'_, SharedState>, handle: u32, dtr: Option<bool>, rts: Option<bool>) -> CmdResult<()> {
    let st = state.inner().clone();
    blocking(move || {
        let port = st.serial.get(handle)?;
        let mut p = port.lock().map_err(|_| CmdError::other("serial lock poisoned"))?;
        let name = port_name(p.as_ref());
        if let Some(v) = dtr {
            p.write_data_terminal_ready(v).map_err(|e| map_serial_error(&e, &name))?;
        }
        if let Some(v) = rts {
            p.write_request_to_send(v).map_err(|e| map_serial_error(&e, &name))?;
        }
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn serial_discard(state: State<'_, SharedState>, handle: u32) -> CmdResult<()> {
    let st = state.inner().clone();
    blocking(move || {
        let port = st.serial.get(handle)?;
        let p = port.lock().map_err(|_| CmdError::other("serial lock poisoned"))?;
        let name = port_name(p.as_ref());
        p.clear(ClearBuffer::Input).map_err(|e| map_serial_error(&e, &name))
    })
    .await
}

#[tauri::command]
pub async fn serial_close(state: State<'_, SharedState>, handle: u32) -> CmdResult<()> {
    let st = state.inner().clone();
    blocking(move || {
        let port = st.serial.open.lock().map_err(|_| CmdError::other("serial table poisoned"))?.remove(&handle);
        drop(port);
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn serial_diagnose() -> CmdResult<Vec<Hint>> {
    blocking(|| Ok(diagnose::run())).await
}

/// Installs the udev rules (Linux, one-time USB setup for AppImage users).
/// Asks for the admin password through pkexec.
#[tauri::command]
pub async fn serial_setup_access() -> CmdResult<()> {
    blocking(diagnose::install_udev_rules).await
}

/* --------------------------------------------------------- diagnostics */

pub mod diagnose {
    // The checks only run on Linux; the decision logic is tested everywhere.
    #![cfg_attr(not(target_os = "linux"), allow(dead_code))]
    use super::*;
    use crate::util::Distro;
    use std::process::{Command, Output, Stdio};

    pub const UDEV_RULES: &str = include_str!("../linux/60-tonuino-studio.rules");
    pub const RULES_NAME: &str = "60-tonuino-studio.rules";

    /// Pure decision logic, fed with facts gathered from the system.
    #[derive(Debug, Default, Clone)]
    pub struct Facts {
        pub user: String,
        /// The group that owns serial ports ("dialout" on Debian/Ubuntu, "uucp" on Arch).
        pub serial_group: Option<String>,
        pub in_serial_group: bool,
        pub rules_installed: bool,
        /// tty nodes of USB adapters that exist but cannot be opened for writing.
        pub inaccessible_ttys: Vec<String>,
        /// A CH340 is plugged in but has no tty node.
        pub ch340_without_tty: bool,
        pub brltty_installed: bool,
        pub modem_manager_running: bool,
        /// Package family, for the command that takes brltty away (apt when unknown).
        pub distro: Option<Distro>,
    }

    /// The command that keeps brltty off the CH340. Pop!_OS cannot remove
    /// the package without its desktop, so there its udev rules are masked.
    pub fn brltty_command(distro: Option<Distro>) -> &'static str {
        match distro {
            Some(Distro::Fedora) => "sudo dnf remove brltty",
            Some(Distro::Arch) => "sudo pacman -R brltty",
            Some(Distro::Suse) => "sudo zypper remove brltty",
            Some(Distro::PopOs) => {
                "for f in /usr/lib/udev/rules.d/*brltty*.rules; do sudo ln -sf /dev/null \"/etc/udev/rules.d/$(basename \"$f\")\"; done; sudo udevadm control --reload-rules"
            }
            Some(Distro::Debian) | None => "sudo apt remove brltty",
        }
    }

    pub fn hints(f: &Facts) -> Vec<Hint> {
        let mut out = Vec::new();
        if f.ch340_without_tty && f.brltty_installed {
            out.push(Hint {
                id: "linux-brltty",
                detail: None,
                command: Some(brltty_command(f.distro).into()),
            });
        }
        let no_access = !f.inaccessible_ttys.is_empty() || (!f.in_serial_group && !f.rules_installed);
        if no_access {
            let group = f.serial_group.clone().unwrap_or_else(|| "dialout".into());
            out.push(Hint {
                id: "linux-serial-permission",
                detail: Some(if f.inaccessible_ttys.is_empty() { group.clone() } else { f.inaccessible_ttys.join(", ") }),
                command: Some(format!("sudo usermod -aG {group} {}", if f.user.is_empty() { "$USER" } else { &f.user })),
            });
        }
        if f.modem_manager_running && !f.rules_installed {
            out.push(Hint { id: "linux-modemmanager", detail: None, command: None });
        }
        out
    }

    #[cfg(target_os = "linux")]
    fn gather() -> Facts {
        use std::fs;
        use std::path::Path;

        let mut f = Facts { user: std::env::var("USER").unwrap_or_default(), ..Default::default() };

        // Group membership: compare our supplementary groups with /etc/group.
        let groups_file = fs::read_to_string("/etc/group").unwrap_or_default();
        let mut gid_of = HashMap::new();
        for line in groups_file.lines() {
            let parts: Vec<&str> = line.split(':').collect();
            if parts.len() >= 3 {
                if let Ok(gid) = parts[2].parse::<u32>() {
                    gid_of.insert(parts[0].to_string(), gid);
                }
            }
        }
        f.serial_group = ["dialout", "uucp"].iter().find(|g| gid_of.contains_key(**g)).map(|g| g.to_string());
        // SAFETY: getgroups with a correctly sized buffer.
        let my_groups: Vec<u32> = unsafe {
            let n = libc::getgroups(0, std::ptr::null_mut());
            let mut buf = vec![0 as libc::gid_t; n.max(0) as usize];
            let m = libc::getgroups(n, buf.as_mut_ptr());
            buf.truncate(m.max(0) as usize);
            buf.push(libc::getegid());
            buf.into_iter().collect()
        };
        f.in_serial_group = f
            .serial_group
            .as_ref()
            .and_then(|g| gid_of.get(g))
            .map(|gid| my_groups.contains(gid))
            .unwrap_or(false);

        f.rules_installed = [
            "/etc/udev/rules.d",
            "/usr/lib/udev/rules.d",
            "/lib/udev/rules.d",
        ]
        .iter()
        .any(|d| Path::new(d).join(RULES_NAME).exists());

        // USB serial tty nodes we cannot open.
        if let Ok(ports) = serialport::available_ports() {
            for p in ports {
                if matches!(p.port_type, SerialPortType::UsbPort(_)) {
                    let c = std::ffi::CString::new(p.port_name.clone()).unwrap_or_default();
                    // SAFETY: access() on a NUL-terminated path.
                    if unsafe { libc::access(c.as_ptr(), libc::R_OK | libc::W_OK) } != 0 {
                        f.inaccessible_ttys.push(p.port_name);
                    }
                }
            }
        }

        // CH340 present without a tty (brltty claimed it).
        if let Ok(devices) = fs::read_dir("/sys/bus/usb/devices") {
            for dev in devices.flatten() {
                let p = dev.path();
                let vid = fs::read_to_string(p.join("idVendor")).unwrap_or_default();
                let pid = fs::read_to_string(p.join("idProduct")).unwrap_or_default();
                if vid.trim() == "1a86" && pid.trim() == "7523" && !has_tty_child(&p) {
                    f.ch340_without_tty = true;
                }
            }
        }
        f.brltty_installed = ["/usr/bin/brltty", "/bin/brltty", "/usr/lib/udev/rules.d/85-brltty.rules", "/lib/udev/rules.d/85-brltty.rules"]
            .iter()
            .any(|p| Path::new(p).exists());
        f.modem_manager_running = process_running("ModemManager");
        f.distro = crate::util::linux_distro();
        f
    }

    #[cfg(target_os = "linux")]
    fn has_tty_child(usb_device: &std::path::Path) -> bool {
        // Interfaces are subdirectories like "1-2:1.0"; a bound ch341 driver creates "ttyUSB0" inside.
        let Ok(entries) = std::fs::read_dir(usb_device) else { return false };
        entries.flatten().any(|iface| {
            iface.file_name().to_string_lossy().contains(':')
                && std::fs::read_dir(iface.path())
                    .map(|inner| inner.flatten().any(|e| e.file_name().to_string_lossy().starts_with("tty")))
                    .unwrap_or(false)
        })
    }

    #[cfg(target_os = "linux")]
    fn process_running(name: &str) -> bool {
        std::fs::read_dir("/proc")
            .map(|rd| {
                rd.flatten().any(|e| {
                    e.file_name().to_string_lossy().chars().all(|c| c.is_ascii_digit())
                        && std::fs::read_to_string(e.path().join("comm")).map(|c| c.trim() == name).unwrap_or(false)
                })
            })
            .unwrap_or(false)
    }

    #[cfg(target_os = "linux")]
    pub fn run() -> Vec<Hint> {
        hints(&gather())
    }

    #[cfg(not(target_os = "linux"))]
    pub fn run() -> Vec<Hint> {
        Vec::new()
    }

    /// Where the one-time USB setup puts the rules.
    pub const RULES_TARGET: &str = "/etc/udev/rules.d/60-tonuino-studio.rules";

    /// Runs as root: installs the rules that arrive on stdin as `$1`, then
    /// lets udev apply them. The rules travel on stdin, never as a file: a
    /// copy in the shared temp folder could be swapped by another account
    /// while the password dialog is open, and root would install that copy.
    pub const INSTALL_SCRIPT: &str = r#"set -e
trap 'rm -f "$1.new"' EXIT
cat > "$1.new"
chmod 0644 "$1.new"
mv -f "$1.new" "$1"
udevadm control --reload-rules
udevadm trigger --action=add --subsystem-match=tty
udevadm trigger --action=add --subsystem-match=usb
"#;

    /// The install command for `target`: through `launcher` (pkexec), or
    /// the shell itself without one.
    pub fn install_command(launcher: Option<&str>, target: &str) -> Command {
        let shell = ["/bin/sh", "-c", INSTALL_SCRIPT, "sh", target];
        let mut cmd = match launcher {
            Some(l) => Command::new(l),
            None => Command::new(shell[0]),
        };
        cmd.args(if launcher.is_some() { &shell[..] } else { &shell[1..] })
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        cmd
    }

    /// Starts the install command and hands it the rules on stdin.
    pub fn run_with_rules(mut cmd: Command) -> io::Result<Output> {
        let mut child = cmd.spawn()?;
        if let Some(mut stdin) = child.stdin.take() {
            // When the password dialog is dismissed, pkexec ends without
            // reading; its exit code tells why, not this write.
            let _ = stdin.write_all(UDEV_RULES.as_bytes());
        }
        child.wait_with_output()
    }

    #[cfg(target_os = "linux")]
    pub fn install_udev_rules() -> CmdResult<()> {
        let out = run_with_rules(install_command(Some("pkexec"), RULES_TARGET)).map_err(|e| CmdError::new("unsupported", format!("pkexec: {e}")))?;
        match out.status.code() {
            Some(0) => Ok(()),
            // 126: the user dismissed the password dialog, 127: not authorized.
            Some(126) | Some(127) => Err(CmdError::new("cancelled", String::from_utf8_lossy(&out.stderr).trim().to_string())),
            _ => Err(CmdError::other(String::from_utf8_lossy(&out.stderr).trim().to_string())),
        }
    }

    #[cfg(not(target_os = "linux"))]
    pub fn install_udev_rules() -> CmdResult<()> {
        Err(CmdError::new("unsupported", "only needed on Linux"))
    }
}

#[cfg(test)]
mod tests {
    use super::diagnose::*;
    use super::*;

    #[test]
    fn labels_known_adapters() {
        assert_eq!(label_for("/dev/ttyUSB0", Some(0x1a86), Some(0x7523), Some("USB Serial"), None), "USB-Serial CH340 (ttyUSB0)");
        assert_eq!(label_for("COM3", Some(0x04d9), Some(0xb534), None, None), "USB-Serial HT42B534 (LKP AiO) (COM3)");
        assert_eq!(label_for("/dev/ttyACM0", Some(0x1234), Some(0x1), Some("Gadget"), None), "USB-Serial Gadget (ttyACM0)");
        assert_eq!(label_for("COM1", None, None, None, None), "Serieller Anschluss (COM1)");
    }

    #[test]
    fn brltty_hint_needs_both_facts() {
        let mut f = Facts { in_serial_group: true, rules_installed: true, ..Default::default() };
        assert!(hints(&f).is_empty());
        f.ch340_without_tty = true;
        assert!(hints(&f).is_empty(), "brltty not installed: no hint");
        f.brltty_installed = true;
        let h = hints(&f);
        assert_eq!(h.len(), 1);
        assert_eq!(h[0].id, "linux-brltty");
        assert_eq!(h[0].command.as_deref(), Some("sudo apt remove brltty"));
        f.distro = Some(crate::util::Distro::Fedora);
        assert_eq!(hints(&f)[0].command.as_deref(), Some("sudo dnf remove brltty"));
        // Pop!_OS keeps the package (its desktop depends on it) and masks the rules.
        f.distro = Some(crate::util::Distro::PopOs);
        let pop = hints(&f)[0].command.clone().unwrap();
        assert!(pop.contains("/dev/null") && !pop.contains("remove"), "{pop}");
    }

    #[test]
    fn permission_hint_without_group_or_rule() {
        let f = Facts { user: "anna".into(), serial_group: Some("dialout".into()), ..Default::default() };
        let h = hints(&f);
        assert_eq!(h[0].id, "linux-serial-permission");
        assert_eq!(h[0].command.as_deref(), Some("sudo usermod -aG dialout anna"));
        // The uaccess rule alone is enough.
        let f = Facts { rules_installed: true, ..f };
        assert!(hints(&f).is_empty());
        // ...unless a node is still inaccessible.
        let f = Facts { inaccessible_ttys: vec!["/dev/ttyUSB0".into()], ..f };
        assert_eq!(hints(&f)[0].detail.as_deref(), Some("/dev/ttyUSB0"));
    }

    #[test]
    fn modemmanager_hint_only_without_rules() {
        let f = Facts { in_serial_group: true, modem_manager_running: true, ..Default::default() };
        assert_eq!(hints(&f).iter().map(|h| h.id).collect::<Vec<_>>(), ["linux-modemmanager"]);
        let f = Facts { rules_installed: true, ..f };
        assert!(hints(&f).is_empty());
    }

    #[test]
    fn udev_rules_cover_all_adapters() {
        for id in ["1a86\", ATTRS{idProduct}==\"7523", "1a86\", ATTRS{idProduct}==\"55d4", "04d9\", ATTRS{idProduct}==\"b534", "0403\", ATTRS{idProduct}==\"6001", "10c4\", ATTRS{idProduct}==\"ea60", "072f\", ATTRS{idProduct}==\"2200"] {
            assert!(UDEV_RULES.contains(id), "missing {id}");
        }
        assert!(UDEV_RULES.contains("ATTRS{idVendor}==\"2341\""));
        assert!(UDEV_RULES.contains("ID_MM_DEVICE_IGNORE"));
    }

    #[test]
    fn privileged_step_reads_no_file_another_account_could_swap() {
        let cmd = install_command(Some("pkexec"), RULES_TARGET);
        assert_eq!(cmd.get_program(), "pkexec");
        let args: Vec<String> = cmd.get_args().map(|a| a.to_string_lossy().into_owned()).collect();
        // Only the script and where the rules go; the rules themselves come on stdin.
        assert_eq!(args, ["/bin/sh", "-c", INSTALL_SCRIPT, "sh", RULES_TARGET]);
        assert!(RULES_TARGET.ends_with(RULES_NAME));
    }

    /// The read loop and the port settings the app uses (serial_open), on a
    /// pseudo terminal: /dev/pts/N on Linux, /dev/ttysN on macOS.
    #[cfg(unix)]
    #[test]
    fn reads_and_writes_over_a_pty() {
        use serialport::TTYPort;
        let (mut master, slave) = TTYPort::pair().expect("pty pair");
        // Linux: open it again as serial_open does (the pair holds it exclusively).
        // macOS sets every baud rate with the IOSSIOSPEED ioctl, which a pty
        // refuses (ENOTTY, "Not a typewriter"); a real /dev/cu.* port takes it.
        // There the pair's own end, already raw, stands in.
        #[cfg(not(target_os = "macos"))]
        let opened = {
            let name = slave.name().expect("pty name");
            drop(slave);
            serialport::new(&name, 115_200).timeout(Duration::from_millis(100)).open().expect("open pty like serial_open")
        };
        #[cfg(target_os = "macos")]
        let opened: Box<dyn SerialPort> = Box::new(slave);
        let port: Port = Arc::new(Mutex::new(opened));

        master.write_all(b"TonUINO TNG\r\n").unwrap();
        let mut got = Vec::new();
        let start = Instant::now();
        while got.len() < 13 && start.elapsed() < Duration::from_secs(3) {
            got.extend(read_with_timeout(&port, Duration::from_millis(500), 64).unwrap());
        }
        assert_eq!(got, b"TonUINO TNG\r\n");

        // Nothing more: empty after the timeout, not before.
        let t = Instant::now();
        assert!(read_with_timeout(&port, Duration::from_millis(200), 64).unwrap().is_empty());
        assert!(t.elapsed() >= Duration::from_millis(180), "{:?}", t.elapsed());

        // At most max_bytes per call, the rest stays for the next one.
        master.write_all(&[b'x'; 100]).unwrap();
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(read_with_timeout(&port, Duration::from_millis(500), 30).unwrap().len(), 30);
        let mut rest = 0;
        while rest < 70 {
            let n = read_with_timeout(&port, Duration::from_millis(500), 1000).unwrap().len();
            assert!(n > 0, "lost bytes after {rest}");
            rest += n;
        }
        assert_eq!(rest, 70);

        // The other way round.
        port.lock().unwrap().write_all(b"ping").unwrap();
        master.set_timeout(Duration::from_millis(1000)).unwrap();
        let mut buf = [0u8; 4];
        master.read_exact(&mut buf).unwrap();
        assert_eq!(&buf, b"ping");
    }

    #[cfg(unix)]
    #[test]
    fn install_script_writes_exactly_the_embedded_rules() {
        use std::os::unix::fs::PermissionsExt;
        struct Scratch(std::path::PathBuf);
        impl Drop for Scratch {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let dir = Scratch(std::env::temp_dir().join(format!("tonuino-udev-{}", std::process::id())));
        let _ = std::fs::remove_dir_all(&dir.0);
        std::fs::create_dir_all(dir.0.join("bin")).unwrap();
        // Stand-in for udevadm that only notes its calls.
        let log = dir.0.join("udevadm.log");
        let udevadm = dir.0.join("bin/udevadm");
        std::fs::write(&udevadm, format!("#!/bin/sh\necho \"$*\" >> '{}'\n", log.display())).unwrap();
        std::fs::set_permissions(&udevadm, std::fs::Permissions::from_mode(0o755)).unwrap();
        let target = dir.0.join(RULES_NAME);
        std::fs::write(&target, "# older rules\n").unwrap();

        let mut cmd = install_command(None, target.to_str().unwrap());
        cmd.env("PATH", format!("{}:/usr/bin:/bin", dir.0.join("bin").display()));
        let out = run_with_rules(cmd).unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        assert_eq!(std::fs::read_to_string(&target).unwrap(), UDEV_RULES);
        assert_eq!(std::fs::metadata(&target).unwrap().permissions().mode() & 0o777, 0o644);
        assert!(!dir.0.join(format!("{RULES_NAME}.new")).exists(), "no half-written copy stays behind");
        assert_eq!(std::fs::read_to_string(&log).unwrap().lines().collect::<Vec<_>>(), ["control --reload-rules", "trigger --action=add --subsystem-match=tty", "trigger --action=add --subsystem-match=usb"]);
    }
}
