//! Lets the Linux window draw as often as the screen does (120 Hz and more).
//!
//! Two things keep WebKitGTK at 60 frames per second on a fast screen under
//! X11, and neither is a setting:
//!
//! - WebKit paces the page by the screen's vblank. It finds the screen's DRM
//!   connector by comparing the physical size GDK reports with the size the
//!   kernel reports, in whole millimetres. They can differ by a few mm on
//!   laptops (measured: GDK 344 × 215, DRM 340 × 220), then WebKit logs "no
//!   drm node with CRTC found" and falls back to a 60 Hz timer. The app
//!   defines `gdk_monitor_get_width_mm`/`_height_mm` itself (the executable's
//!   symbols come first) and answers with the kernel's size when exactly one
//!   connected screen is that close.
//! - GTK 3 under X11 paints at most every 16667 µs unless the compositor
//!   sends frame timings; xfwm4 and others do not. After each paint the app
//!   writes the screen's interval into the frame's timings, which is where
//!   GTK takes the next interval from. The write is checked against GTK's own
//!   getter and dropped for good if it does not match.
//!
//! TONUINO_60FPS=1 turns both off, for comparing.

use std::ffi::{c_char, c_int, c_void, CStr};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

/// Physical size difference (mm, each side) still counted as the same screen.
const MM_SLACK: u32 = 10;
/// GTK's own interval without frame timings; slower screens keep it.
const GTK_INTERVAL_US: i64 = 16_667;
/// Offset of `refresh_interval` in GdkFrameTimings (GTK 3, 64-bit).
const REFRESH_INTERVAL_OFFSET: usize = 56;

static BROKEN: AtomicBool = AtomicBool::new(false);

pub fn disabled() -> bool {
    static OFF: OnceLock<bool> = OnceLock::new();
    *OFF.get_or_init(|| std::env::var_os("TONUINO_60FPS").is_some_and(|v| !v.is_empty() && v != "0"))
}

unsafe fn sym(name: &CStr) -> *mut c_void {
    libc::dlsym(libc::RTLD_DEFAULT, name.as_ptr())
}

// --- Physical size -------------------------------------------------------

#[repr(C)]
struct DrmRes {
    count_fbs: c_int,
    fbs: *mut u32,
    count_crtcs: c_int,
    crtcs: *mut u32,
    count_connectors: c_int,
    connectors: *mut u32,
}

#[repr(C)]
struct DrmConnector {
    connector_id: u32,
    encoder_id: u32,
    connector_type: u32,
    connector_type_id: u32,
    connection: c_int,
    mm_width: u32,
    mm_height: u32,
}

/// Physical sizes of the connected screens, as the kernel reports them.
fn drm_sizes() -> &'static [(u32, u32)] {
    static SIZES: OnceLock<Vec<(u32, u32)>> = OnceLock::new();
    SIZES.get_or_init(|| {
        type GetRes = unsafe extern "C" fn(c_int) -> *mut DrmRes;
        type FreeRes = unsafe extern "C" fn(*mut DrmRes);
        type GetConn = unsafe extern "C" fn(c_int, u32) -> *mut DrmConnector;
        type FreeConn = unsafe extern "C" fn(*mut DrmConnector);
        let mut out = Vec::new();
        // SAFETY: libdrm is loaded with WebKit; the symbols have these
        // signatures, and only the leading fields of its structs (laid out
        // as above) are read before they are freed with libdrm's own calls.
        unsafe {
            let (gr, fr, gc, fc) = (
                sym(c"drmModeGetResources"),
                sym(c"drmModeFreeResources"),
                sym(c"drmModeGetConnector"),
                sym(c"drmModeFreeConnector"),
            );
            if [gr, fr, gc, fc].iter().any(|p| p.is_null()) {
                return out;
            }
            let (gr, fr) = (std::mem::transmute::<*mut c_void, GetRes>(gr), std::mem::transmute::<*mut c_void, FreeRes>(fr));
            let (gc, fc) = (std::mem::transmute::<*mut c_void, GetConn>(gc), std::mem::transmute::<*mut c_void, FreeConn>(fc));
            let Ok(dir) = std::fs::read_dir("/dev/dri") else { return out };
            for entry in dir.flatten() {
                let name = entry.file_name();
                let Some(name) = name.to_str() else { continue };
                if !name.starts_with("card") {
                    continue;
                }
                let Ok(path) = std::ffi::CString::new(format!("/dev/dri/{name}")) else { continue };
                let fd = libc::open(path.as_ptr(), libc::O_RDONLY | libc::O_CLOEXEC);
                if fd < 0 {
                    continue;
                }
                let res = gr(fd);
                if !res.is_null() {
                    let n = (*res).count_connectors.max(0) as usize;
                    for i in 0..n {
                        let c = gc(fd, *(*res).connectors.add(i));
                        if c.is_null() {
                            continue;
                        }
                        // 1 = DRM_MODE_CONNECTED
                        if (*c).connection == 1 && (*c).mm_width > 0 && (*c).mm_height > 0 {
                            out.push(((*c).mm_width, (*c).mm_height));
                        }
                        fc(c);
                    }
                    fr(res);
                }
                libc::close(fd);
            }
        }
        out
    })
}

/// The kernel's size for a screen GDK reports as `gdk`, if exactly one
/// connected screen is that close and none matches exactly.
fn kernel_size(gdk: (u32, u32), sizes: &[(u32, u32)]) -> Option<(u32, u32)> {
    if gdk.0 == 0 || gdk.1 == 0 || sizes.contains(&gdk) {
        return None;
    }
    let mut near = sizes.iter().filter(|s| s.0.abs_diff(gdk.0) <= MM_SLACK && s.1.abs_diff(gdk.1) <= MM_SLACK);
    match (near.next(), near.next()) {
        (Some(s), None) => Some(*s),
        _ => None,
    }
}

type MonitorMm = unsafe extern "C" fn(*mut c_void) -> c_int;

fn real_mm() -> Option<(MonitorMm, MonitorMm)> {
    static REAL: OnceLock<Option<(MonitorMm, MonitorMm)>> = OnceLock::new();
    *REAL.get_or_init(|| {
        // SAFETY: RTLD_NEXT finds GDK's own functions behind the ones below.
        unsafe {
            let w = libc::dlsym(libc::RTLD_NEXT, c"gdk_monitor_get_width_mm".as_ptr());
            let h = libc::dlsym(libc::RTLD_NEXT, c"gdk_monitor_get_height_mm".as_ptr());
            if w.is_null() || h.is_null() {
                return None;
            }
            Some((std::mem::transmute::<*mut c_void, MonitorMm>(w), std::mem::transmute::<*mut c_void, MonitorMm>(h)))
        }
    })
}

unsafe fn monitor_mm(monitor: *mut c_void) -> (c_int, c_int) {
    let Some((w, h)) = real_mm() else { return (0, 0) };
    let gdk = (w(monitor), h(monitor));
    if disabled() || gdk.0 <= 0 || gdk.1 <= 0 {
        return gdk;
    }
    match kernel_size((gdk.0 as u32, gdk.1 as u32), drm_sizes()) {
        Some((kw, kh)) => (kw as c_int, kh as c_int),
        None => gdk,
    }
}

/// GDK's function of the same name, with the kernel's size where they differ
/// slightly (see the top of this file).
///
/// # Safety
/// Called by GTK and WebKit with a GdkMonitor, like the original.
#[no_mangle]
pub unsafe extern "C" fn gdk_monitor_get_width_mm(monitor: *mut c_void) -> c_int {
    monitor_mm(monitor).0
}

/// See [`gdk_monitor_get_width_mm`].
///
/// # Safety
/// Called by GTK and WebKit with a GdkMonitor, like the original.
#[no_mangle]
pub unsafe extern "C" fn gdk_monitor_get_height_mm(monitor: *mut c_void) -> c_int {
    monitor_mm(monitor).1
}

// --- GTK's paint interval ------------------------------------------------

struct Gtk {
    realized: unsafe extern "C" fn(*mut c_void) -> c_int,
    frame_clock: unsafe extern "C" fn(*mut c_void) -> *mut c_void,
    window: unsafe extern "C" fn(*mut c_void) -> *mut c_void,
    display: unsafe extern "C" fn(*mut c_void) -> *mut c_void,
    monitor_at: unsafe extern "C" fn(*mut c_void, *mut c_void) -> *mut c_void,
    refresh_rate: unsafe extern "C" fn(*mut c_void) -> c_int,
    timings: unsafe extern "C" fn(*mut c_void) -> *mut c_void,
    interval: unsafe extern "C" fn(*mut c_void) -> i64,
    connect_data: unsafe extern "C" fn(*mut c_void, *const c_char, *mut c_void, *mut c_void, *mut c_void, c_int) -> u64,
    connect_object: unsafe extern "C" fn(*mut c_void, *const c_char, *mut c_void, *mut c_void, c_int) -> u64,
}

fn gtk() -> Option<&'static Gtk> {
    static GTK: OnceLock<Option<Gtk>> = OnceLock::new();
    GTK.get_or_init(|| {
        // SAFETY: GTK 3, GDK 3 and GObject are loaded with the window; each
        // symbol is cast to the signature of its public API.
        unsafe {
            let names: [&CStr; 10] = [
                c"gtk_widget_get_realized",
                c"gtk_widget_get_frame_clock",
                c"gtk_widget_get_window",
                c"gdk_window_get_display",
                c"gdk_display_get_monitor_at_window",
                c"gdk_monitor_get_refresh_rate",
                c"gdk_frame_clock_get_current_timings",
                c"gdk_frame_timings_get_refresh_interval",
                c"g_signal_connect_data",
                c"g_signal_connect_object",
            ];
            let p: Vec<*mut c_void> = names.iter().map(|n| sym(n)).collect();
            if p.iter().any(|p| p.is_null()) {
                return None;
            }
            use std::mem::transmute as t;
            #[allow(clippy::missing_transmute_annotations)] // the field types say it
            Some(Gtk {
                realized: t(p[0]),
                frame_clock: t(p[1]),
                window: t(p[2]),
                display: t(p[3]),
                monitor_at: t(p[4]),
                refresh_rate: t(p[5]),
                timings: t(p[6]),
                interval: t(p[7]),
                connect_data: t(p[8]),
                connect_object: t(p[9]),
            })
        }
    })
    .as_ref()
}

/// The paint interval of the screen `widget` is on, in µs, if it is faster
/// than GTK's own 60 Hz.
unsafe fn screen_interval_us(g: &Gtk, widget: *mut c_void) -> Option<i64> {
    let win = (g.window)(widget);
    if win.is_null() {
        return None;
    }
    let monitor = (g.monitor_at)((g.display)(win), win);
    if monitor.is_null() {
        return None;
    }
    let mhz = i64::from((g.refresh_rate)(monitor));
    if mhz <= 0 {
        return None;
    }
    let us = (1_000_000_000 + mhz / 2) / mhz;
    (us < GTK_INTERVAL_US - 500).then(|| paint_gap_us().unwrap_or(us))
}

/// For measuring only (TONUINO_GTK_US): another shortest gap between two paints, in µs.
fn paint_gap_us() -> Option<i64> {
    static GAP: OnceLock<Option<i64>> = OnceLock::new();
    *GAP.get_or_init(|| std::env::var("TONUINO_GTK_US").ok()?.trim().parse().ok().filter(|us: &i64| (1_000..GTK_INTERVAL_US).contains(us)))
}

unsafe extern "C" fn after_paint(clock: *mut c_void, widget: *mut c_void) {
    let Some(g) = gtk() else { return };
    if BROKEN.load(Ordering::Relaxed) {
        return;
    }
    let t = (g.timings)(clock);
    // A compositor that sends frame timings fills the interval itself.
    if t.is_null() || (g.interval)(t) != 0 {
        return;
    }
    let Some(want) = screen_interval_us(g, widget) else { return };
    let field = t.cast::<u8>().add(REFRESH_INTERVAL_OFFSET).cast::<i64>();
    if field.read_unaligned() != 0 {
        BROKEN.store(true, Ordering::Relaxed);
        return;
    }
    field.write_unaligned(want);
    if (g.interval)(t) != want {
        field.write_unaligned(0);
        BROKEN.store(true, Ordering::Relaxed);
    }
}

unsafe fn hook_clock(g: &Gtk, widget: *mut c_void) {
    let clock = (g.frame_clock)(widget);
    if clock.is_null() {
        return;
    }
    // Disconnected by GObject when the widget goes away.
    (g.connect_object)(clock, c"after-paint".as_ptr(), after_paint as *mut c_void, widget, 0);
}

unsafe extern "C" fn on_realize(widget: *mut c_void, _data: *mut c_void) {
    if let Some(g) = gtk() {
        hook_clock(g, widget);
    }
}

/// Makes GTK paint `widget`'s window as often as its screen refreshes.
///
/// # Safety
/// `widget` is a live GtkWidget; called on the GTK main thread.
pub unsafe fn follow_screen(widget: *mut c_void) {
    // Keeps the two GDK functions above in the executable for the linker.
    std::hint::black_box((gdk_monitor_get_width_mm as *const () as usize, gdk_monitor_get_height_mm as *const () as usize));
    if disabled() || widget.is_null() {
        return;
    }
    let Some(g) = gtk() else { return };
    // A realized widget keeps its toplevel's frame clock; a new one gets it
    // on "realize".
    if (g.realized)(widget) != 0 {
        hook_clock(g, widget);
    }
    (g.connect_data)(widget, c"realize".as_ptr(), on_realize as *mut c_void, std::ptr::null_mut(), std::ptr::null_mut(), 0);
}

#[cfg(test)]
mod tests {
    use super::kernel_size;

    #[test]
    fn a_laptop_panel_maps_to_the_kernel_size() {
        assert_eq!(kernel_size((344, 215), &[(340, 220)]), Some((340, 220)));
    }

    #[test]
    fn exact_matches_and_far_or_unclear_screens_stay() {
        assert_eq!(kernel_size((340, 220), &[(340, 220)]), None);
        assert_eq!(kernel_size((600, 340), &[(340, 220)]), None);
        assert_eq!(kernel_size((344, 215), &[(340, 220), (346, 212)]), None);
        assert_eq!(kernel_size((0, 0), &[(340, 220)]), None);
        assert_eq!(kernel_size((344, 215), &[]), None);
    }
}
