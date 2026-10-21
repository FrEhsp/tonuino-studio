//! The computer's own voice for spoken track titles ("Titelansagen", an
//! extra of the settings page). No speech engine comes with the app: it uses
//! the voice the system already has and never installs one.
//!
//! - Windows: the SAPI voices through Windows PowerShell (System.Speech), a
//!   fixed script. The text comes from a file; the paths of that file and of
//!   the WAV, and the voice, come in environment variables.
//! - macOS: /usr/bin/say, the text from a file (`-f`).
//! - Linux: pico2wave (when its German voice is there), espeak-ng or espeak,
//!   found in fixed folders, not through PATH. espeak reads the text from a
//!   file (`-f`). pico2wave takes text only as an argument: it comes last,
//!   behind "--", so it is never read as an option.
//!
//! Programs start with fixed paths and arguments, never through a shell. The
//! WAV lands in the app's private temp folder, goes to the page as bytes and
//! is removed, as is the text file.

use crate::error::{blocking, CmdError, CmdResult};
use serde::Serialize;
use std::ffi::OsString;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::ipc::Response;

/// Longest text spoken at once; a title is far shorter.
pub const MAX_CHARS: usize = 300;
/// A voice that has not finished by then hangs.
const TIMEOUT: Duration = Duration::from_secs(60);
/// Words per minute for espeak: a little slower than its 175, for children.
const ESPEAK_SPEED: &str = "150";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
// Each system builds only its own engines; the tests use all of them.
#[allow(dead_code)]
pub enum Engine {
    Sapi,
    Say,
    Pico,
    EspeakNg,
    Espeak,
}

impl Engine {
    pub fn id(self) -> &'static str {
        match self {
            Engine::Sapi => "sapi",
            Engine::Say => "say",
            Engine::Pico => "pico2wave",
            Engine::EspeakNg => "espeak-ng",
            Engine::Espeak => "espeak",
        }
    }
}

/// A voice the computer has.
#[derive(Clone, Debug, PartialEq)]
pub struct Voice {
    pub engine: Engine,
    pub program: PathBuf,
    /// The voice to pick by name (SAPI, say); None: the engine's default.
    pub name: Option<String>,
    /// It speaks German.
    pub german: bool,
}

/// What the page learns about the voice.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VoiceDto {
    /// None: the computer has no voice the app can use.
    pub engine: Option<&'static str>,
    pub voice: Option<String>,
    pub german: bool,
}

/* ------------------------------------------------------------ text */

/// The text as it is spoken: one line, no control characters, at most
/// MAX_CHARS characters. None when nothing is left.
pub fn clean_text(text: &str) -> Option<String> {
    let mut out = String::new();
    for word in text.split(|c: char| c.is_whitespace() || c.is_control()) {
        if word.is_empty() {
            continue;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(word);
    }
    let out: String = out.chars().take(MAX_CHARS).collect();
    let out = out.trim().to_string();
    (!out.is_empty()).then_some(out)
}

/* ------------------------------------------------------------ finding a voice */

/// Folders searched for the Linux programs, in this order.
#[cfg_attr(not(all(unix, not(target_os = "macos"))), allow(dead_code))]
pub const LINUX_DIRS: &[&str] = &["/usr/bin", "/usr/local/bin", "/bin", "/run/current-system/sw/bin"];
/// pico2wave reads its voices from here (compiled in).
#[cfg_attr(not(all(unix, not(target_os = "macos"))), allow(dead_code))]
const PICO_LANG_DIR: &str = "/usr/share/pico/lang";
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const SAY: &str = "/usr/bin/say";

/// The first of `dirs` that holds an executable file `name`.
pub fn find_program(dirs: &[&Path], name: &str) -> Option<PathBuf> {
    dirs.iter().map(|d| d.join(name)).find(|p| is_executable(p))
}

fn is_executable(p: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(p) else { return false };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    true
}

/// The German voice of `say -v ?`: lines like "Anna   de_DE    # Hallo, ich heiße Anna."
/// (names may hold spaces: "Eddy (Deutsch (Deutschland))").
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn german_say_voice(listing: &str) -> Option<String> {
    listing.lines().find_map(|line| {
        let left = line.split('#').next()?.trim_end();
        let (name, locale) = left.rsplit_once(char::is_whitespace)?;
        let name = name.trim();
        (!name.is_empty() && is_german(locale)).then(|| name.to_string())
    })
}

/// The German voice of the SAPI listing: one "name<TAB>culture" per line.
/// Prefers a voice from Germany over one from Austria or Switzerland.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn german_sapi_voice(listing: &str) -> Option<String> {
    let voices: Vec<(&str, &str)> = listing.lines().filter_map(|l| l.trim_end_matches('\r').split_once('\t')).map(|(n, c)| (n.trim(), c.trim())).filter(|(n, _)| !n.is_empty()).collect();
    voices
        .iter()
        .find(|(_, c)| c.eq_ignore_ascii_case("de-DE"))
        .or_else(|| voices.iter().find(|(_, c)| is_german(c)))
        .map(|(n, _)| n.to_string())
}

/// Whether `espeak-ng --voices=de` (or espeak's) lists a German voice:
/// "Pty Language Age/Gender VoiceName File Other Languages", then one line per voice.
pub fn espeak_lists_german(listing: &str) -> bool {
    listing.lines().skip(1).any(|line| line.split_whitespace().nth(1).is_some_and(is_german))
}

fn is_german(locale: &str) -> bool {
    let l = locale.to_ascii_lowercase();
    l == "de" || l.starts_with("de_") || l.starts_with("de-")
}

/// The voices of this computer, best first; `run` asks a program and gives its standard output.
#[cfg_attr(not(all(unix, not(target_os = "macos"))), allow(dead_code))]
pub fn linux_voices(dirs: &[&Path], pico_lang: &Path, run: &dyn Fn(&Path, &[&str]) -> Option<String>) -> Vec<Voice> {
    let mut out = Vec::new();
    // pico sounds clearer than espeak, but only with its German voice files.
    if let Some(program) = find_program(dirs, "pico2wave") {
        if pico_lang.join("de-DE_ta.bin").is_file() {
            out.push(Voice { engine: Engine::Pico, program, name: None, german: true });
        }
    }
    for (engine, name) in [(Engine::EspeakNg, "espeak-ng"), (Engine::Espeak, "espeak")] {
        if let Some(program) = find_program(dirs, name) {
            let german = run(&program, &["--voices=de"]).is_some_and(|l| espeak_lists_german(&l));
            out.push(Voice { engine, program, name: None, german });
        }
    }
    // A German voice before one that would read German titles in English.
    out.sort_by_key(|v| !v.german);
    out
}

/// Standard output of a program that ran without a shell, or None.
fn output_of(program: &Path, args: &[&str]) -> Option<String> {
    let mut cmd = Command::new(program);
    cmd.args(args).stdin(Stdio::null()).stderr(Stdio::null());
    prepare(&mut cmd);
    let out = run_with_timeout(cmd, Duration::from_secs(20)).ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

#[cfg(windows)]
fn powershell() -> PathBuf {
    let root = std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    root.join("System32").join("WindowsPowerShell").join("v1.0").join("powershell.exe")
}

/// Lists the SAPI voices, one "name<TAB>culture" per line.
#[cfg_attr(not(windows), allow(dead_code))]
const SAPI_LIST: &str = "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Add-Type -AssemblyName System.Speech; $s=New-Object System.Speech.Synthesis.SpeechSynthesizer; foreach ($v in $s.GetInstalledVoices()) { if ($v.Enabled) { $v.VoiceInfo.Name + [char]9 + $v.VoiceInfo.Culture.Name } }; $s.Dispose()";

/// Speaks the text file into the WAV file. Text, paths and voice come from
/// the environment, so the script never changes.
#[cfg_attr(not(windows), allow(dead_code))]
const SAPI_SPEAK: &str = "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Speech; $s=New-Object System.Speech.Synthesis.SpeechSynthesizer; if ($env:TONUINO_SPEECH_VOICE) { $s.SelectVoice($env:TONUINO_SPEECH_VOICE) }; $t=[IO.File]::ReadAllText($env:TONUINO_SPEECH_TEXT, [Text.Encoding]::UTF8); $s.SetOutputToWaveFile($env:TONUINO_SPEECH_OUT); $s.Speak($t); $s.Dispose()";

#[cfg_attr(not(windows), allow(dead_code))]
const POWERSHELL_ARGS: &[&str] = &["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"];

fn detect_voices() -> Vec<Voice> {
    #[cfg(windows)]
    {
        let ps = powershell();
        if !ps.is_file() {
            return Vec::new();
        }
        let mut args: Vec<&str> = POWERSHELL_ARGS.to_vec();
        args.push(SAPI_LIST);
        let Some(listing) = output_of(&ps, &args) else { return Vec::new() };
        if !listing.lines().any(|l| l.contains('\t')) {
            return Vec::new();
        }
        let name = german_sapi_voice(&listing);
        vec![Voice { engine: Engine::Sapi, program: ps, german: name.is_some(), name }]
    }
    #[cfg(target_os = "macos")]
    {
        let say = PathBuf::from(SAY);
        if !is_executable(&say) {
            return Vec::new();
        }
        let name = output_of(&say, &["-v", "?"]).and_then(|l| german_say_voice(&l));
        vec![Voice { engine: Engine::Say, program: say, german: name.is_some(), name }]
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let dirs: Vec<&Path> = LINUX_DIRS.iter().map(Path::new).collect();
        linux_voices(&dirs, Path::new(PICO_LANG_DIR), &|p, a| output_of(p, a))
    }
    #[cfg(not(any(windows, unix)))]
    Vec::new()
}

/* ------------------------------------------------------------ speaking */

/// Arguments for `voice`: text from `text_file` (pico2wave: `text` itself, last), WAV to `out`.
pub fn args_for(voice: &Voice, text_file: &Path, out: &Path, text: &str) -> Vec<OsString> {
    let mut a: Vec<OsString> = Vec::new();
    match voice.engine {
        Engine::Sapi => {
            a.extend(POWERSHELL_ARGS.iter().map(OsString::from));
            a.push(SAPI_SPEAK.into());
        }
        Engine::Say => {
            if let Some(name) = &voice.name {
                a.push("-v".into());
                a.push(name.into());
            }
            a.push("-o".into());
            a.push(out.into());
            a.push("--file-format=WAVE".into());
            a.push("--data-format=LEI16@22050".into());
            a.push("-f".into());
            a.push(text_file.into());
        }
        Engine::Pico => {
            a.push("-l".into());
            a.push("de-DE".into());
            a.push("-w".into());
            a.push(out.into());
            a.push("--".into());
            a.push(text.into());
        }
        Engine::EspeakNg | Engine::Espeak => {
            if voice.german {
                a.push("-v".into());
                a.push("de".into());
            }
            a.push("-s".into());
            a.push(ESPEAK_SPEED.into());
            // The text file is UTF-8.
            a.push("-b".into());
            a.push("1".into());
            a.push("-w".into());
            a.push(out.into());
            a.push("-f".into());
            a.push(text_file.into());
        }
    }
    a
}

/// Environment for `voice` (only the SAPI script reads any).
pub fn env_for(voice: &Voice, text_file: &Path, out: &Path) -> Vec<(&'static str, OsString)> {
    match voice.engine {
        Engine::Sapi => vec![
            ("TONUINO_SPEECH_TEXT", text_file.into()),
            ("TONUINO_SPEECH_OUT", out.into()),
            ("TONUINO_SPEECH_VOICE", voice.name.clone().unwrap_or_default().into()),
        ],
        _ => Vec::new(),
    }
}

/// The text as written to the text file. `say` would read "[[ … ]]" as a command.
pub fn file_text(engine: Engine, text: &str) -> String {
    match engine {
        Engine::Say => text.replace("[[", "[ [").replace("]]", "] ]"),
        _ => text.to_string(),
    }
}

/// No console window on Windows; no AppImage libraries for the system's programs on Linux.
pub(crate) fn prepare(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(target_os = "linux")]
    if let (Some(appdir), Some(_)) = (std::env::var_os("APPDIR"), std::env::var_os("APPIMAGE")) {
        for (key, value) in crate::util::appimage_env(&appdir.to_string_lossy(), std::env::vars_os()) {
            match value {
                Some(v) => cmd.env(key, v),
                None => cmd.env_remove(key),
            };
        }
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    let _ = cmd;
}

/// Runs `cmd` with piped output; kills it after `timeout`. Standard error
/// is read too where the caller piped it.
pub(crate) fn run_with_timeout(mut cmd: Command, timeout: Duration) -> std::io::Result<std::process::Output> {
    cmd.stdout(Stdio::piped());
    let mut child = cmd.spawn()?;
    // Read while it runs, so a full pipe never stops it.
    fn drain(mut from: Option<impl Read + Send + 'static>) -> std::thread::JoinHandle<Vec<u8>> {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(s) = from.as_mut() {
                let _ = s.read_to_end(&mut buf);
            }
            buf
        })
    }
    let reader = drain(child.stdout.take());
    let errors = drain(child.stderr.take());
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if started.elapsed() > timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "voice took too long"));
        }
        std::thread::sleep(Duration::from_millis(30));
    };
    let stdout = reader.join().unwrap_or_default();
    let stderr = errors.join().unwrap_or_default();
    Ok(std::process::Output { status, stdout, stderr })
}

/// Removes the files of one job however it ends.
struct TempFiles(Vec<PathBuf>);
impl Drop for TempFiles {
    fn drop(&mut self) {
        for p in &self.0 {
            let _ = std::fs::remove_file(p);
        }
    }
}

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// Speaks `text` with `voice` into WAV bytes.
fn speak_with(voice: &Voice, text: &str) -> CmdResult<Vec<u8>> {
    let dir = crate::fsops::private_temp_dir()?;
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let stem = format!("speech-{}-{nanos}-{}", std::process::id(), COUNTER.fetch_add(1, Ordering::Relaxed));
    let text_file = dir.join(format!("{stem}.txt"));
    let out = dir.join(format!("{stem}.wav"));
    let _cleanup = TempFiles(vec![text_file.clone(), out.clone()]);
    std::fs::write(&text_file, file_text(voice.engine, text)).map_err(|e| CmdError::io(&e, text_file.display()))?;
    let mut cmd = Command::new(&voice.program);
    cmd.args(args_for(voice, &text_file, &out, text)).stdin(Stdio::null()).stderr(Stdio::null());
    for (k, v) in env_for(voice, &text_file, &out) {
        cmd.env(k, v);
    }
    prepare(&mut cmd);
    let result = run_with_timeout(cmd, TIMEOUT).map_err(|e| {
        if e.kind() == std::io::ErrorKind::TimedOut {
            CmdError::new("timeout", format!("{}: {e}", voice.engine.id()))
        } else {
            CmdError::new("failed", format!("{}: {e}", voice.engine.id()))
        }
    })?;
    if !result.status.success() {
        return Err(CmdError::new("failed", format!("{} ended with {}", voice.engine.id(), result.status)));
    }
    let wav = std::fs::read(&out).map_err(|e| CmdError::new("failed", format!("{}: no WAV: {e}", voice.engine.id())))?;
    if wav.len() <= 44 || &wav[..4] != b"RIFF" {
        return Err(CmdError::new("failed", format!("{} wrote no sound ({} bytes)", voice.engine.id(), wav.len())));
    }
    Ok(wav)
}

static VOICES: Mutex<Option<Vec<Voice>>> = Mutex::new(None);

/// The voices of this computer, looked for once (again with `refresh`).
fn voices(refresh: bool) -> Vec<Voice> {
    let mut g = VOICES.lock().unwrap_or_else(|p| p.into_inner());
    if refresh || g.is_none() {
        *g = Some(detect_voices());
    }
    g.clone().unwrap_or_default()
}

/// Which voice the app would use; `engine: null` when there is none.
#[tauri::command]
pub async fn speech_voice(refresh: Option<bool>) -> CmdResult<VoiceDto> {
    blocking(move || {
        let found = voices(refresh.unwrap_or(false));
        Ok(match found.first() {
            Some(v) => VoiceDto { engine: Some(v.engine.id()), voice: v.name.clone(), german: v.german },
            None => VoiceDto { engine: None, voice: None, german: false },
        })
    })
    .await
}

/// Speaks `text` with the computer's voice. Answers the WAV file's bytes.
/// Error codes: no-voice, invalid-argument (empty text), timeout, failed.
#[tauri::command]
pub async fn speech_say(text: String) -> CmdResult<Response> {
    blocking(move || {
        let text = clean_text(&text).ok_or_else(|| CmdError::invalid("nothing to say"))?;
        let found = voices(false);
        if found.is_empty() {
            return Err(CmdError::new("no-voice", "no speech program found"));
        }
        // The next voice when one fails (pico2wave without its files, a broken espeak).
        let mut last = None;
        for v in &found {
            match speak_with(v, &text) {
                Ok(wav) => return Ok(Response::new(wav)),
                Err(e) => last = Some(e),
            }
        }
        Err(last.unwrap_or_else(|| CmdError::new("failed", "no voice answered")))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn voice(engine: Engine, german: bool, name: Option<&str>) -> Voice {
        Voice { engine, program: PathBuf::from("/usr/bin/x"), name: name.map(str::to_string), german }
    }

    fn strings(a: &[OsString]) -> Vec<String> {
        a.iter().map(|s| s.to_string_lossy().into_owned()).collect()
    }

    struct Scratch(PathBuf);
    impl Scratch {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("tonuino-speech-{tag}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Scratch(dir)
        }
        fn program(&self, sub: &str, name: &str) -> PathBuf {
            let d = self.0.join(sub);
            std::fs::create_dir_all(&d).unwrap();
            let p = d.join(name);
            std::fs::write(&p, "#!/bin/sh\n").unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
            }
            p
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn text_becomes_one_short_line() {
        assert_eq!(clean_text("  Der\tHund\nund  die Katze\u{7} ").as_deref(), Some("Der Hund und die Katze"));
        assert_eq!(clean_text(" \n\t "), None);
        assert_eq!(clean_text(&"ä".repeat(400)).unwrap().chars().count(), MAX_CHARS);
    }

    #[test]
    fn espeak_reads_the_text_from_its_file() {
        let a = strings(&args_for(&voice(Engine::EspeakNg, true, None), Path::new("/t/a.txt"), Path::new("/t/a.wav"), "-x; rm -rf /"));
        assert_eq!(a, ["-v", "de", "-s", "150", "-b", "1", "-w", "/t/a.wav", "-f", "/t/a.txt"]);
        // Without a German voice the default one speaks.
        let a = strings(&args_for(&voice(Engine::Espeak, false, None), Path::new("/t/a.txt"), Path::new("/t/a.wav"), "x"));
        assert_eq!(a, ["-s", "150", "-b", "1", "-w", "/t/a.wav", "-f", "/t/a.txt"]);
    }

    #[test]
    fn pico_gets_the_text_last_behind_the_end_of_options() {
        let a = strings(&args_for(&voice(Engine::Pico, true, None), Path::new("/t/a.txt"), Path::new("/t/a.wav"), "-w /etc/passwd"));
        assert_eq!(a, ["-l", "de-DE", "-w", "/t/a.wav", "--", "-w /etc/passwd"]);
    }

    #[test]
    fn say_picks_the_voice_and_writes_wave() {
        let a = strings(&args_for(&voice(Engine::Say, true, Some("Anna")), Path::new("/t/a.txt"), Path::new("/t/a.wav"), "x"));
        assert_eq!(a, ["-v", "Anna", "-o", "/t/a.wav", "--file-format=WAVE", "--data-format=LEI16@22050", "-f", "/t/a.txt"]);
        assert_eq!(file_text(Engine::Say, "[[rate 400]] Hallo"), "[ [rate 400] ] Hallo");
        assert_eq!(file_text(Engine::EspeakNg, "[[x]]"), "[[x]]");
    }

    #[test]
    fn sapi_runs_a_fixed_script_and_gets_the_rest_from_the_environment() {
        let v = voice(Engine::Sapi, true, Some("Microsoft Hedda Desktop"));
        let a = strings(&args_for(&v, Path::new(r"C:\t\a.txt"), Path::new(r"C:\t\a.wav"), "'; Remove-Item C:\\ #"));
        assert_eq!(&a[..5], ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"]);
        assert_eq!(a[5], SAPI_SPEAK);
        assert_eq!(a.len(), 6, "the text never is an argument");
        let env: Vec<(&str, String)> = env_for(&v, Path::new(r"C:\t\a.txt"), Path::new(r"C:\t\a.wav")).into_iter().map(|(k, v)| (k, v.to_string_lossy().into_owned())).collect();
        assert_eq!(
            env,
            [("TONUINO_SPEECH_TEXT", r"C:\t\a.txt".to_string()), ("TONUINO_SPEECH_OUT", r"C:\t\a.wav".to_string()), ("TONUINO_SPEECH_VOICE", "Microsoft Hedda Desktop".to_string())]
        );
        assert!(env_for(&voice(Engine::EspeakNg, true, None), Path::new("/a"), Path::new("/b")).is_empty());
    }

    #[test]
    fn finds_the_german_voice_of_say() {
        let listing = "Albert              en_US    # Hello! My name is Albert.\nAnna                de_DE    # Hallo, ich heiße Anna.\nEddy (Deutsch (Deutschland)) de_DE    # Hallo! Ich heiße Eddy.\n";
        assert_eq!(german_say_voice(listing).as_deref(), Some("Anna"));
        assert_eq!(german_say_voice("Eddy (Deutsch (Deutschland)) de_DE    # Hallo!").as_deref(), Some("Eddy (Deutsch (Deutschland))"));
        assert_eq!(german_say_voice("Albert   en_US  # Hello"), None);
        assert_eq!(german_say_voice(""), None);
    }

    #[test]
    fn finds_the_german_sapi_voice() {
        let listing = "Microsoft Zira Desktop\ten-US\r\nMicrosoft Karsten Desktop\tde-CH\r\nMicrosoft Hedda Desktop\tde-DE\r\n";
        assert_eq!(german_sapi_voice(listing).as_deref(), Some("Microsoft Hedda Desktop"));
        assert_eq!(german_sapi_voice("Microsoft Karsten Desktop\tde-CH").as_deref(), Some("Microsoft Karsten Desktop"));
        assert_eq!(german_sapi_voice("Microsoft Zira Desktop\ten-US"), None);
        assert_eq!(german_sapi_voice("garbage"), None);
    }

    #[test]
    fn reads_the_voice_list_of_espeak() {
        let ng = "Pty Language       Age/Gender VoiceName          File                 Other Languages\n 5  de              --/M      German             gmw/de\n";
        assert!(espeak_lists_german(ng));
        let none = "Pty Language       Age/Gender VoiceName          File                 Other Languages\n";
        assert!(!espeak_lists_german(none));
        // The header alone has "Language" in the second column.
        assert!(!espeak_lists_german("Pty de Age/Gender\n"));
        assert!(espeak_lists_german("Pty Language Age/Gender VoiceName File\n 5  de-ch  --/M  Swiss  gmw/de-CH\n"));
    }

    #[cfg(unix)]
    #[test]
    fn programs_are_found_only_in_the_given_folders() {
        let s = Scratch::new("find");
        let espeak = s.program("b", "espeak-ng");
        // Not executable: does not count.
        std::fs::create_dir_all(s.0.join("a")).unwrap();
        std::fs::write(s.0.join("a").join("espeak-ng"), "x").unwrap();
        let dirs = [s.0.join("a"), s.0.join("b")];
        let dirs: Vec<&Path> = dirs.iter().map(PathBuf::as_path).collect();
        assert_eq!(find_program(&dirs, "espeak-ng"), Some(espeak));
        assert_eq!(find_program(&dirs, "pico2wave"), None);
        assert_eq!(find_program(&[], "espeak-ng"), None);
    }

    #[cfg(unix)]
    #[test]
    fn linux_prefers_a_german_voice() {
        let s = Scratch::new("linux");
        let pico = s.program("bin", "pico2wave");
        let ng = s.program("bin", "espeak-ng");
        let old = s.program("bin", "espeak");
        let lang = s.0.join("lang");
        std::fs::create_dir_all(&lang).unwrap();
        let bin = s.0.join("bin");
        let dirs = [bin.as_path()];
        let listing = |german: bool| {
            let mut l = "Pty Language Age/Gender VoiceName File Other\n".to_string();
            if german {
                l.push_str(" 5  de  --/M  German  gmw/de\n");
            }
            l
        };
        // No German voice files for pico: espeak-ng with German first, the old espeak without German after it.
        let run = |p: &Path, args: &[&str]| -> Option<String> {
            assert_eq!(args, ["--voices=de"]);
            Some(listing(p.ends_with("espeak-ng")))
        };
        let found = linux_voices(&dirs, &lang, &run);
        assert_eq!(found.iter().map(|v| (v.engine, v.german)).collect::<Vec<_>>(), [(Engine::EspeakNg, true), (Engine::Espeak, false)]);
        assert_eq!(found[0].program, ng);
        assert_eq!(found[1].program, old);
        // With pico's German files, pico comes first.
        std::fs::write(lang.join("de-DE_ta.bin"), "x").unwrap();
        let found = linux_voices(&dirs, &lang, &run);
        assert_eq!(found[0].engine, Engine::Pico);
        assert_eq!(found[0].program, pico);
        // A program that does not answer still counts, without German.
        let found = linux_voices(&dirs, Path::new("/nonexistent"), &|_, _| None);
        assert_eq!(found.iter().map(|v| (v.engine, v.german)).collect::<Vec<_>>(), [(Engine::EspeakNg, false), (Engine::Espeak, false)]);
        // Nothing installed: no voice.
        assert!(linux_voices(&[Path::new("/nonexistent")], &lang, &run).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn a_voice_that_hangs_is_stopped() {
        let mut cmd = Command::new("/bin/sh");
        cmd.args(["-c", "sleep 5"]);
        let started = Instant::now();
        let err = run_with_timeout(cmd, Duration::from_millis(200)).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::TimedOut);
        assert!(started.elapsed() < Duration::from_secs(3));
    }
}
