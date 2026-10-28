//! TonUINO Studio desktop backend: the commands behind `src/platform/tauri`.
//!
//! The Android app (cfg `mobile`, set by tauri-build) has only the commands
//! that make sense on a phone: the box in the home network (`http_plain`) and
//! the app's own ones. SD cards, the box over USB, PC/SC card readers, the
//! computer's voice and the list of "Entdecken" built on the computer are
//! desktop only (cfg `desktop`); their crates are not even built for Android
//! (Cargo.toml). The phone writes cards with its own NFC through a small
//! Kotlin bridge in the WebView (src-tauri/android/TonuinoNfc.kt).

#[cfg(desktop)]
mod access;
#[cfg(desktop)]
mod audio;
#[cfg(desktop)]
mod chapters;
// Shared helpers: the Android app's few commands use only some of them.
#[cfg_attr(mobile, allow(dead_code))]
mod error;
mod framing;
#[cfg(desktop)]
mod fsops;
mod http;
#[cfg(desktop)]
mod loudness;
#[cfg(desktop)]
mod nfc;
#[cfg(desktop)]
mod pick;
// "Anhören": the computer's own player (symphonia and cpal), not the WebView's.
#[cfg(desktop)]
mod player;
// "Drucken": the PDF of the sheets to CUPS in its real size, or to the PDF program.
#[cfg(desktop)]
mod print;
#[cfg(desktop)]
mod resample;
#[cfg(target_os = "linux")]
mod screenrate;
#[cfg(desktop)]
mod serial;
// The computer's own voice for spoken track titles (an extra of the settings page).
#[cfg(desktop)]
mod speech;
// The list of "Entdecken" built on the user's computer: HTTPS to a fixed
// list of hosts (feature "quellen", on by default).
#[cfg(all(desktop, feature = "quellen"))]
mod sources_net;
// The cover search at iTunes, Deezer and MusicBrainz with the app's own
// User-Agent: HTTPS to the services' hosts only (same TLS as sources_net).
#[cfg(all(desktop, feature = "quellen"))]
mod cover_net;
#[cfg_attr(mobile, allow(dead_code))]
mod util;
#[cfg(desktop)]
mod volumes;

use std::sync::Arc;
#[cfg(desktop)]
use std::sync::Mutex;
use tauri::Manager;
#[cfg(desktop)]
use tauri::{DragDropEvent, WebviewEvent, WindowEvent};

/// State shared by all commands (on Android there is none).
#[derive(Default)]
pub struct AppState {
    #[cfg(desktop)]
    pub access: access::AccessControl,
    #[cfg(desktop)]
    pub volumes: Mutex<Vec<volumes::VolumeDto>>,
    #[cfg(desktop)]
    pub writes: fsops::WriteSessions,
    #[cfg(desktop)]
    pub copies: fsops::CopyJobs,
    #[cfg(desktop)]
    pub serial: serial::SerialPorts,
    #[cfg(desktop)]
    pub audio: audio::AudioState,
    #[cfg(desktop)]
    pub player: player::PlayerState,
}

pub type SharedState = Arc<AppState>;

#[cfg(desktop)]
fn note_drop<R: tauri::Runtime>(app: &tauri::AppHandle<R>, event: &DragDropEvent) {
    if let DragDropEvent::Drop { paths, .. } = event {
        app.state::<SharedState>().access.note_dropped(paths);
    }
}

/// Opens a link in the default browser (http, https and mailto only).
#[tauri::command]
fn open_external(app: tauri::AppHandle, url: String) -> error::CmdResult<()> {
    use tauri_plugin_opener::OpenerExt;
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("https://") || lower.starts_with("http://") || lower.starts_with("mailto:")) {
        return Err(error::CmdError::not_allowed(format!("refusing to open {url}")));
    }
    app.opener().open_url(url, None::<&str>).map_err(|e| error::CmdError::other(e.to_string()))
}

/// Measuring mode (TONUINO_MESSEN=1, see src/app/measure.ts): the file its result goes to.
fn measure_file(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    let on = std::env::var_os("TONUINO_MESSEN").is_some_and(|v| !v.is_empty() && v != "0");
    if !on {
        return None;
    }
    let dir = app.path().home_dir().or_else(|_| std::env::current_dir()).ok()?;
    Some(dir.join("TonUINO-Messung.json"))
}

/// Where the measuring mode writes its result; None when the app runs normally.
#[tauri::command]
fn measure_mode(app: tauri::AppHandle) -> Option<String> {
    measure_file(&app).map(|p| p.display().to_string())
}

/// The short measuring mode (TONUINO_MESSEN=kurz): only the shelf and the idle page.
#[tauri::command]
fn measure_short() -> bool {
    std::env::var("TONUINO_MESSEN").is_ok_and(|v| v == "kurz")
}

/// Prints a step of the measuring mode, so a run that hangs shows where.
#[tauri::command]
fn measure_step(app: tauri::AppHandle, text: String) {
    if measure_file(&app).is_some() {
        println!("Messschritt {text}");
    }
}

/// Writes the result of the measuring mode, says where, and quits.
#[tauri::command]
fn measure_done(app: tauri::AppHandle, report: String) -> error::CmdResult<()> {
    let Some(path) = measure_file(&app) else {
        return Err(error::CmdError::not_allowed("measuring mode is off".to_string()));
    };
    std::fs::write(&path, report).map_err(|e| error::CmdError::other(e.to_string()))?;
    println!("Messung gespeichert: {}", path.display());
    app.exit(0);
    Ok(())
}

/// The extra "Selbst aufnehmen" records from the microphone in the page.
/// The window may use it without asking (the user started the recording);
/// camera and everything else stay as the WebView decides.
fn permission_for(kind: tauri::webview::PermissionKind) -> tauri::webview::PermissionResponse {
    use tauri::webview::{PermissionKind, PermissionResponse};
    match kind {
        PermissionKind::Microphone => PermissionResponse::Allow,
        _ => PermissionResponse::Default,
    }
}

/// Two settings of WebKitGTK the app changes on Linux. The app has no
/// webkit2gtk crate of its own, so it calls the C functions of the library
/// the window already loaded. `view` is the webkit2gtk::WebView of the
/// window: a pointer to its GObject, nothing else.
///
/// - "enable-media-stream": getUserMedia stays off without it ("Selbst
///   aufnehmen").
/// - The feature "PreferPageRenderingUpdatesNear60FPS" (on by default): the
///   page draws at about 60 frames per second even on a 120 Hz screen, so
///   scrolling looks rougher there than in other programs. Off, it follows
///   the screen. TONUINO_60FPS=1 keeps WebKit's default, for comparing.
///
/// It also lets GTK paint as often as the screen does (see `screenrate`).
#[cfg(target_os = "linux")]
fn tune_webview<V>(view: V) {
    use std::ffi::{c_char, c_void, CStr};
    if std::mem::size_of::<V>() != std::mem::size_of::<*mut c_void>() {
        return;
    }
    type GetSettings = unsafe extern "C" fn(*mut c_void) -> *mut c_void;
    type SetBool = unsafe extern "C" fn(*mut c_void, i32);
    type AllFeatures = unsafe extern "C" fn() -> *mut c_void;
    type ListLength = unsafe extern "C" fn(*mut c_void) -> usize;
    type ListGet = unsafe extern "C" fn(*mut c_void, usize) -> *mut c_void;
    type ListUnref = unsafe extern "C" fn(*mut c_void);
    type Identifier = unsafe extern "C" fn(*mut c_void) -> *const c_char;
    type SetFeature = unsafe extern "C" fn(*mut c_void, *mut c_void, i32);
    let keep_60 = screenrate::disabled();
    // SAFETY: V is a GObject wrapper of pointer size (checked above), so its
    // bits are the WebKitWebView pointer; `view` keeps its reference until
    // the end. All symbols come from the loaded libwebkit2gtk with the
    // signatures of its API: webkit_web_view_get_settings returns a borrowed
    // WebKitSettings*, the setters take a gboolean, the feature list (since
    // 2.42; missing symbols skip the step) is owned until
    // webkit_feature_list_unref, and its features and identifiers are
    // borrowed from it.
    unsafe {
        let sym = |name: &CStr| libc::dlsym(libc::RTLD_DEFAULT, name.as_ptr());
        let widget: *mut c_void = std::mem::transmute_copy(&view);
        let get = sym(c"webkit_web_view_get_settings");
        if widget.is_null() || get.is_null() {
            return;
        }
        let settings = std::mem::transmute::<*mut c_void, GetSettings>(get)(widget);
        if settings.is_null() {
            return;
        }
        screenrate::follow_screen(widget);
        let media = sym(c"webkit_settings_set_enable_media_stream");
        if !media.is_null() {
            std::mem::transmute::<*mut c_void, SetBool>(media)(settings, 1);
        }
        let (all, len, item, unref, ident, set) = (
            sym(c"webkit_settings_get_all_features"),
            sym(c"webkit_feature_list_get_length"),
            sym(c"webkit_feature_list_get"),
            sym(c"webkit_feature_list_unref"),
            sym(c"webkit_feature_get_identifier"),
            sym(c"webkit_settings_set_feature_enabled"),
        );
        if keep_60 || [all, len, item, unref, ident, set].iter().any(|p| p.is_null()) {
            return;
        }
        let list = std::mem::transmute::<*mut c_void, AllFeatures>(all)();
        if list.is_null() {
            return;
        }
        for i in 0..std::mem::transmute::<*mut c_void, ListLength>(len)(list) {
            let feature = std::mem::transmute::<*mut c_void, ListGet>(item)(list, i);
            let id = if feature.is_null() { std::ptr::null() } else { std::mem::transmute::<*mut c_void, Identifier>(ident)(feature) };
            if !id.is_null() && CStr::from_ptr(id) == c"PreferPageRenderingUpdatesNear60FPS" {
                std::mem::transmute::<*mut c_void, SetFeature>(set)(settings, feature, 0);
                break;
            }
        }
        std::mem::transmute::<*mut c_void, ListUnref>(unref)(list);
    }
    drop(view);
}

/// All commands, plus `extra` (the ones of optional cargo features).
#[cfg(desktop)]
macro_rules! app_handlers {
    ($($extra:tt)*) => {
        tauri::generate_handler![
            open_external,
            measure_mode,
            measure_step,
            measure_short,
            measure_done,
            volumes::volumes_list,
            volumes::volumes_refresh,
            volumes::volume_info,
            volumes::volume_eject,
            volumes::volume_fix_access,
            fsops::fs_list,
            fsops::fs_read,
            fsops::fs_read_range,
            fsops::fs_write,
            fsops::fs_write_chunk,
            fsops::fs_write_finish,
            fsops::fs_write_abort,
            fsops::fs_mkdir,
            fsops::fs_remove,
            fsops::fs_rename,
            fsops::fs_exists,
            fsops::fs_stat,
            fsops::fs_make_writable,
            fsops::fs_copy,
            fsops::fs_copy_cancel,
            fsops::fs_temp_file,
            fsops::fs_temp_remove,
            pick::dialog_pick_files,
            pick::dialog_pick_folder,
            pick::dialog_save,
            pick::drop_resolve,
            pick::downloads_recent,
            serial::serial_list,
            serial::serial_open,
            serial::serial_write,
            serial::serial_read,
            serial::serial_set_signals,
            serial::serial_discard,
            serial::serial_close,
            serial::serial_diagnose,
            serial::serial_setup_access,
            nfc::nfc_list_readers,
            nfc::nfc_wait_card,
            nfc::nfc_read,
            nfc::nfc_write,
            nfc::nfc_diagnose,
            audio::audio_analyze,
            audio::audio_cancel,
            audio::audio_pcm_open,
            audio::audio_pcm_read,
            audio::audio_pcm_close,
            player::player_warm,
            player::player_load,
            player::player_load_data,
            player::player_queue,
            player::player_play,
            player::player_pause,
            player::player_seek,
            player::player_volume,
            player::player_close,
            player::player_close_all,
            http::http_plain,
            speech::speech_voice,
            speech::speech_say,
            print::print_printers,
            print::print_pdf,
            print::print_paper,
            $($extra)*
        ]
    };
}

/// The Android app: the box in the home network and the app's own commands.
/// Cards go through the phone's NFC in the WebView, not through Rust.
#[cfg(mobile)]
macro_rules! app_handlers {
    () => {
        tauri::generate_handler![open_external, measure_mode, measure_step,
            measure_short, measure_done, http::http_plain]
    };
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    type Handlers = Box<dyn Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync>;
    #[cfg(all(desktop, feature = "quellen"))]
    let handlers: Handlers = Box::new(app_handlers!(
        sources_net::sources_fetch,
        sources_net::sources_cache_read,
        sources_net::sources_cache_write,
        cover_net::cover_fetch,
    ));
    #[cfg(any(mobile, not(feature = "quellen")))]
    let handlers: Handlers = Box::new(app_handlers!());
    let state: SharedState = Arc::new(AppState::default());
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(state)
        .on_permission_request(|_, kind| permission_for(kind));
    #[cfg(desktop)]
    let builder = builder
        .on_window_event(|window, event| {
            match event {
                WindowEvent::DragDrop(e) => note_drop(window.app_handle(), e),
                // Nothing plays on once the window is gone.
                WindowEvent::Destroyed => window.app_handle().state::<SharedState>().player.close_all(),
                _ => {}
            }
        })
        // A page loaded anew (reload, measuring mode) has no player any more: its sound stops.
        .on_page_load(|webview, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Started {
                webview.app_handle().state::<SharedState>().player.close_all();
            }
        })
        .on_webview_event(|webview, event| {
            if let WebviewEvent::DragDrop(e) = event {
                note_drop(webview.app_handle(), e);
            }
        });
    builder
        .setup(|app| {
            #[cfg(desktop)]
            volumes::start_watcher(app.handle().clone());
            #[cfg(mobile)]
            let _ = app;
            #[cfg(target_os = "linux")]
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.with_webview(|w| tune_webview(w.inner()));
            }
            Ok(())
        })
        .invoke_handler(handlers)
        .build(tauri::generate_context!())
        .expect("error while running TonUINO Studio")
        .run(|app, event| {
            // The sound stops and the output closes with the app.
            #[cfg(desktop)]
            if let tauri::RunEvent::Exit = event {
                app.state::<SharedState>().player.shutdown();
            }
            #[cfg(mobile)]
            let _ = (app, event);
        });
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;
    use std::path::Path;

    fn read_json(path: &Path) -> serde_json::Value {
        let text = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        serde_json::from_str(&text).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
    }

    /// Permissions granted to the main window: by every file in `capabilities/`,
    /// unless tauri.conf.json picks its own list (app.security.capabilities).
    fn main_window_permissions() -> HashSet<String> {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let mut caps = Vec::new();
        for entry in std::fs::read_dir(root.join("capabilities")).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().and_then(|e| e.to_str()) == Some("json") {
                caps.push(read_json(&path));
            }
        }
        let conf = read_json(&root.join("tauri.conf.json"));
        if let Some(picked) = conf["app"]["security"]["capabilities"].as_array().filter(|list| !list.is_empty()) {
            // Each entry names a file's capability or writes one out in place.
            let named: HashSet<&str> = picked.iter().filter_map(|c| c.as_str()).collect();
            caps.retain(|c| c["identifier"].as_str().is_some_and(|id| named.contains(id)));
            caps.extend(picked.iter().filter(|c| c.is_object()).cloned());
        }
        let mut granted = HashSet::new();
        for cap in caps {
            let windows = cap["windows"].as_array().cloned().unwrap_or_default();
            if !windows.iter().any(|w| w == "main" || w == "*") {
                continue;
            }
            for p in cap["permissions"].as_array().unwrap() {
                let id = p.as_str().or_else(|| p["identifier"].as_str()).unwrap();
                granted.insert(id.to_string());
            }
        }
        granted
    }

    #[test]
    fn links_that_leave_the_app_may_open_the_browser() {
        // The opener plugin's script cancels every click on an <a target="_blank">
        // that the page does not handle itself (the store links under "Mit dem
        // Handy") and hands the URL to plugin:opener|open_url instead. Without
        // these permissions the ACL refuses that call, and the links silently do
        // nothing.
        let granted = main_window_permissions();
        let has = |p: &str| granted.contains(p) || granted.contains("opener:default");
        assert!(has("opener:allow-open-url"), "open_url is not allowed: {granted:?}");
        assert!(has("opener:allow-default-urls"), "no web address is in scope for open_url: {granted:?}");
    }
}
