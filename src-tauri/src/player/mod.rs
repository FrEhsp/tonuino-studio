//! "Anhören" in the desktop app plays here, not in the WebView's <audio>:
//! WebKitGTK started late (a quarter of a second and more after the click),
//! landed jumps elsewhere than the bar said and now and then fell silent
//! with its clock standing still. symphonia decodes (as for the analysis),
//! cpal brings the sound to the system's output. The Android app and the
//! web app keep the browser's player.
//!
//!   player_warm        opens the output early (a page with tracks shows)
//!   player_load        a file: new voice, first packets decoded, plays at once with `play`
//!   player_load_data   the same for data in memory (raw body; x-name, x-at, x-play, x-volume)
//!   player_queue       the next file, played gapless after the voice's track
//!   player_play / _pause / _seek / _volume / _close / _close_all
//!
//! Short commands run off the main thread too (async), so the window never
//! waits for the sound.
//!
//! The page hears what happens through the event "player" (engine::PlayerEvent):
//! started, ended, seeked, paused, pos (four times a second while playing),
//! duration (the exact length, once known), error and device.

mod engine;
mod mixer;
mod mp3index;
mod output;
mod track;

use crate::access::Access;
use crate::error::{blocking, CmdError, CmdResult};
use crate::util::{body_bytes, header, optional_header};
use crate::SharedState;
use engine::{Engine, EventSink, LoadOptions, Loaded, PlayerEvent};
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use tauri::ipc::Request;
use tauri::{AppHandle, Emitter, State};
use track::{Media, Track};

pub const EVENT_PLAYER: &str = "player";

/// Events go to the app's window.
struct WindowSink(AppHandle);

impl EventSink for WindowSink {
    fn emit(&self, event: PlayerEvent) {
        let _ = self.0.emit(EVENT_PLAYER, event);
    }
}

/// The player, made at its first use: an app that never plays opens no output.
#[derive(Default)]
pub struct PlayerState {
    engine: OnceLock<Engine>,
}

impl PlayerState {
    fn engine(&self, app: &AppHandle) -> &Engine {
        self.engine.get_or_init(|| Engine::new(Box::new(output::CpalOutputs), Arc::new(WindowSink(app.clone()))))
    }

    /// The page is loaded anew or the window closes: nothing plays on unheard.
    pub fn close_all(&self) {
        if let Some(e) = self.engine.get() {
            e.close_all();
        }
    }

    pub fn shutdown(&self) {
        if let Some(e) = self.engine.get() {
            e.shutdown();
        }
    }
}

fn options(at: Option<f64>, play: Option<bool>, volume: Option<f32>) -> LoadOptions {
    LoadOptions { at: at.filter(|a| a.is_finite()).unwrap_or(0.0), play: play.unwrap_or(true), volume: volume.filter(|v| v.is_finite()).unwrap_or(1.0) }
}

#[tauri::command]
pub async fn player_warm(app: AppHandle, state: State<'_, SharedState>) -> CmdResult<()> {
    let st = state.inner().clone();
    blocking(move || st.player.engine(&app).warm()).await
}

#[tauri::command]
pub async fn player_load(app: AppHandle, state: State<'_, SharedState>, path: String, at: Option<f64>, play: Option<bool>, volume: Option<f32>) -> CmdResult<Loaded> {
    let st = state.inner().clone();
    blocking(move || {
        let p = st.access.check(&path, Access::Read)?;
        let track = Track::open(Media::File(p))?;
        st.player.engine(&app).load(Box::new(track), options(at, play, volume))
    })
    .await
}

/// Data the page holds in memory. Headers: x-name (for the type), x-at, x-play, x-volume.
#[tauri::command]
pub async fn player_load_data(app: AppHandle, state: State<'_, SharedState>, request: Request<'_>) -> CmdResult<Loaded> {
    let st = state.inner().clone();
    let name = header(&request, "x-name")?;
    let number = |key: &str| -> CmdResult<Option<f64>> { optional_header(&request, key)?.map(|v| v.parse::<f64>().map_err(|_| CmdError::invalid(format!("{key} is not a number")))).transpose() };
    let (at, volume) = (number("x-at")?, number("x-volume")?);
    let play = optional_header(&request, "x-play")?.map(|v| v == "1" || v == "true");
    let data: Arc<[u8]> = body_bytes(&request)?.into();
    // Only the extension of the name counts; it never names a file that is read.
    let name = PathBuf::from(format!("data.{}", name.rsplit('.').next().filter(|e| !e.is_empty() && e.len() <= 8 && e.chars().all(|c| c.is_ascii_alphanumeric())).unwrap_or("mp3")));
    blocking(move || {
        let track = Track::open(Media::Memory { data, name })?;
        st.player.engine(&app).load(Box::new(track), options(at, play, volume.map(|v| v as f32)))
    })
    .await
}

/// Plays `path` right after the voice's track, without a gap; returns the new track's number.
#[tauri::command]
pub async fn player_queue(app: AppHandle, state: State<'_, SharedState>, voice: u32, path: String) -> CmdResult<u32> {
    let st = state.inner().clone();
    blocking(move || {
        let p = st.access.check(&path, Access::Read)?;
        let track = Track::open(Media::File(p))?;
        st.player.engine(&app).queue(voice, Box::new(track))
    })
    .await
}

#[tauri::command]
pub async fn player_play(app: AppHandle, state: State<'_, SharedState>, voice: u32) -> CmdResult<()> {
    let st = state.inner().clone();
    blocking(move || st.player.engine(&app).play(voice)).await
}

#[tauri::command]
pub async fn player_pause(app: AppHandle, state: State<'_, SharedState>, voice: u32) -> CmdResult<()> {
    state.player.engine(&app).pause(voice)
}

#[tauri::command]
pub async fn player_seek(app: AppHandle, state: State<'_, SharedState>, voice: u32, sec: f64) -> CmdResult<()> {
    state.player.engine(&app).seek(voice, sec)
}

#[tauri::command]
pub async fn player_volume(app: AppHandle, state: State<'_, SharedState>, voice: u32, volume: f32) -> CmdResult<()> {
    state.player.engine(&app).set_volume(voice, volume)
}

#[tauri::command]
pub async fn player_close(app: AppHandle, state: State<'_, SharedState>, voice: u32) -> CmdResult<()> {
    state.player.engine(&app).close(voice);
    Ok(())
}

#[tauri::command]
pub async fn player_close_all(state: State<'_, SharedState>) -> CmdResult<()> {
    state.player.close_all();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use std::time::{Duration, Instant};

    #[derive(Default)]
    struct Collect(Mutex<Vec<(Instant, PlayerEvent)>>);
    impl EventSink for Collect {
        fn emit(&self, event: PlayerEvent) {
            self.0.lock().unwrap().push((Instant::now(), event));
        }
    }

    fn wait_for(events: &Collect, kind: &str, max: Duration) -> Option<(Instant, PlayerEvent)> {
        let until = Instant::now() + max;
        while Instant::now() < until {
            if let Some(e) = events.0.lock().unwrap().iter().find(|(_, e)| e.kind == kind) {
                return Some(e.clone());
            }
            std::thread::sleep(Duration::from_millis(1));
        }
        None
    }

    /// Plays a real file through the system's output (cpal): how soon the
    /// first sound reaches the output, and that a jump arrives. Needs a sound
    /// output, so it runs only on request:
    ///   cargo test --lib player::tests -- --ignored --nocapture
    /// Without any output it must fail cleanly with "no-device" or
    /// "output-failed", never hang.
    #[test]
    #[ignore]
    fn plays_through_the_system_output() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/library/vbr-no-xing.mp3");
        let events = Arc::new(Collect::default());
        let engine = Engine::new(Box::new(output::CpalOutputs), events.clone());
        let t0 = Instant::now();
        match engine.warm() {
            Ok(()) => println!("output open after {:.1} ms", t0.elapsed().as_secs_f64() * 1000.0),
            Err(e) => {
                println!("no output here: {} ({}), after {:.1} ms", e.code, e.detail, t0.elapsed().as_secs_f64() * 1000.0);
                assert!(["no-device", "output-failed"].contains(&e.code));
                return;
            }
        }
        let click = Instant::now();
        let track = Track::open(Media::File(path)).unwrap();
        let loaded = engine.load(Box::new(track), LoadOptions { at: 0.0, play: true, volume: 0.5 }).unwrap();
        let returned = click.elapsed();
        let (at, started) = wait_for(&events, "started", Duration::from_secs(3)).expect("no sound started");
        println!(
            "load returned after {:.1} ms; first frame taken by the output after {:.1} ms (backend says {:.1} ms)",
            returned.as_secs_f64() * 1000.0,
            (at - click).as_secs_f64() * 1000.0,
            started.start_ms.unwrap_or(-1.0)
        );
        std::thread::sleep(Duration::from_millis(500));
        let s0 = Instant::now();
        engine.seek(loaded.voice, 1.0).unwrap();
        let (at, seeked) = wait_for(&events, "seeked", Duration::from_secs(3)).expect("jump not done");
        println!("jump to {:.3} s heard after {:.1} ms", seeked.pos_sec, (at - s0).as_secs_f64() * 1000.0);
        let pos: Vec<f64> = events.0.lock().unwrap().iter().filter(|(_, e)| e.kind == "pos").map(|(_, e)| e.pos_sec).collect();
        println!("positions reported: {pos:?}");
        engine.shutdown();
    }
}
