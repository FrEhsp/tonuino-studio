//! "Drucken" in the desktop app (TODO #85): the PDF of the sheets goes to the
//! system in its real size, not through the WebView.
//!
//! WebKitGTK's print (the Linux app until 0.4.1) ignores `@page { margin: 0 }`:
//! it shrinks the page to the printable width of the printer (about 94 % with
//! GTK's 6.35 mm margins) and adds an empty page after every sheet; on Letter
//! the sheet is cut over two pages (scripts/bench/druck.py shows it).
//!
//! - Linux and macOS: CUPS's own `lp`, found in fixed folders, with the
//!   options that keep the size: `print-scaling=none` (CUPS 2.3 and IPP
//!   printers), `fit-to-page=false` and `fitplot=false` (older filters).
//!   Without them CUPS's "auto" scales a page that is larger than the
//!   printable area down to fit it, which a full sheet always is.
//!   `lpstat` names the printers and the default one.
//! - Windows, or no CUPS: the PDF opens in the computer's PDF program; the
//!   page tells the user to print with "Tatsächliche Größe" there. A silent
//!   print through the PDF program's "print" verb cannot be kept at 100 %.
//!
//! Programs start with fixed paths and arguments, never through a shell. The
//! PDF comes as a file the page wrote into the app's private temp folder
//! (fs_temp_file); `lp` hands a copy to the spooler before it returns, so the
//! file goes again afterwards.

// Windows opens the PDF only: the CUPS half is built and tested on Linux and macOS.
#![cfg_attr(not(unix), allow(dead_code))]

use crate::error::{blocking, CmdError, CmdResult};
use crate::SharedState;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;
use tauri::State;

/// A spooler that has not answered by then hangs.
const TIMEOUT: Duration = Duration::from_secs(60);

/// Folders searched for lp and lpstat, in this order (macOS has them in /usr/bin).
pub const CUPS_DIRS: &[&str] = &["/usr/bin", "/usr/local/bin", "/bin", "/run/current-system/sw/bin"];

/// How this computer prints a PDF.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PrintersDto {
    /// "system": lp with one of `printers`; "open": the PDF opens in its program.
    pub way: &'static str,
    pub printers: Vec<String>,
    pub default: Option<String>,
}

/* ------------------------------------------------------------ pure parts */

/// Printer names as `lpstat -e` lists them, one per line.
pub fn parse_printers(listing: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for line in listing.lines() {
        // `lpstat -a` (older CUPS): "NAME accepting requests since ...".
        let Some(name) = line.split_whitespace().next() else { continue };
        if valid_printer(name) && !out.iter().any(|n| n == name) {
            out.push(name.to_string());
        }
    }
    out
}

/// The default printer of `LC_ALL=C lpstat -d`: "system default destination: NAME".
pub fn parse_default(listing: &str) -> Option<String> {
    let line = listing.lines().find(|l| l.contains("default destination:"))?;
    let name = line.rsplit_once(':')?.1.trim();
    valid_printer(name).then(|| name.to_string())
}

/// A CUPS printer name: printable, no spaces, "/" or "#", and never read as an option.
pub fn valid_printer(name: &str) -> bool {
    !name.is_empty() && name.len() <= 127 && !name.starts_with('-') && name.chars().all(|c| !c.is_whitespace() && !c.is_control() && c != '/' && c != '#')
}

fn near(a: f64, b: f64) -> bool {
    (a - b).abs() < 0.6
}

fn mm(v: f64) -> String {
    let r = (v * 10.0).round() / 10.0;
    if r.fract() == 0.0 {
        format!("{}", r as i64)
    } else {
        format!("{r}")
    }
}

/// The paper for CUPS: the common names, otherwise a custom size (always
/// portrait; CUPS turns a landscape page onto it).
pub fn media_for(width_mm: f64, height_mm: f64) -> String {
    let (a, b) = if width_mm <= height_mm { (width_mm, height_mm) } else { (height_mm, width_mm) };
    let named = [(210.0, 297.0, "A4"), (215.9, 279.4, "Letter"), (148.0, 210.0, "A5"), (105.0, 148.0, "A6"), (215.9, 355.6, "Legal")];
    for (w, h, name) in named {
        if near(a, w) && near(b, h) {
            return name.to_string();
        }
    }
    format!("Custom.{}x{}mm", mm(a), mm(b))
}

/// What the PDF is printed with.
#[derive(Debug, Clone, PartialEq)]
pub struct Job {
    pub title: String,
    pub printer: Option<String>,
    pub width_mm: f64,
    pub height_mm: f64,
    /// Sheets of back sides follow their fronts: both sides, turned over the long edge.
    pub two_sided: bool,
}

/// The arguments of `lp` for `file`: real size, one copy, the paper of the PDF.
pub fn lp_args(job: &Job, file: &Path) -> Vec<String> {
    let mut args = Vec::new();
    if let Some(p) = &job.printer {
        args.push("-d".to_string());
        args.push(p.clone());
    }
    let title: String = job.title.chars().filter(|c| !c.is_control()).take(120).collect();
    args.extend(["-t".to_string(), if title.trim().is_empty() { "TonUINO Studio".to_string() } else { title }]);
    args.extend(["-n", "1"].map(String::from));
    for option in [
        format!("media={}", media_for(job.width_mm, job.height_mm)),
        "print-scaling=none".to_string(),
        "fit-to-page=false".to_string(),
        "fitplot=false".to_string(),
        format!("sides={}", if job.two_sided { "two-sided-long-edge" } else { "one-sided" }),
    ] {
        args.push("-o".to_string());
        args.push(option);
    }
    args.push(file.to_string_lossy().into_owned());
    args
}

/// The job id from lp's answer "request id is NAME-12 (1 file(s))".
pub fn parse_job(answer: &str) -> Option<String> {
    let rest = answer.split("request id is ").nth(1)?;
    rest.split_whitespace().next().map(str::to_string)
}

/// A file name for the PDF that opens in its program: the given name without
/// characters a file system refuses, ending in ".pdf".
pub fn pdf_file_name(name: &str) -> String {
    let stem = name.trim().trim_end_matches(".pdf").trim_end_matches(".PDF");
    let clean: String = stem.chars().map(|c| if c.is_control() || "\\/:*?\"<>|".contains(c) { ' ' } else { c }).collect();
    let clean = clean.trim().trim_matches('.').trim();
    let clean: String = clean.chars().take(100).collect();
    format!("{}.pdf", if clean.is_empty() { "TonUINO Studio" } else { &clean })
}

/* ------------------------------------------------------------ the system */

fn c_locale(cmd: &mut Command) {
    // lpstat's words are translated; the parsing reads the English ones.
    cmd.env("LC_ALL", "C").env("LANG", "C");
}

/// lp and lpstat of this computer, when CUPS is there.
#[cfg(unix)]
fn cups(dirs: &[&Path]) -> Option<(PathBuf, PathBuf)> {
    Some((crate::speech::find_program(dirs, "lp")?, crate::speech::find_program(dirs, "lpstat")?))
}

fn output(program: &Path, args: &[&str]) -> Option<String> {
    let mut cmd = Command::new(program);
    cmd.args(args).stdin(Stdio::null()).stderr(Stdio::null());
    crate::speech::prepare(&mut cmd);
    c_locale(&mut cmd);
    let out = crate::speech::run_with_timeout(cmd, Duration::from_secs(20)).ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

/// The printers through `lpstat` in `dirs`; None without CUPS.
pub fn system_printers(dirs: &[&Path]) -> Option<PrintersDto> {
    #[cfg(unix)]
    {
        let (_, lpstat) = cups(dirs)?;
        // -e also names printers found on the network that CUPS sets up when used; -a for CUPS before 2.2.
        let listing = output(&lpstat, &["-e"]).or_else(|| output(&lpstat, &["-a"])).unwrap_or_default();
        let printers = parse_printers(&listing);
        let default = output(&lpstat, &["-d"]).and_then(|l| parse_default(&l)).filter(|d| printers.contains(d));
        Some(PrintersDto { way: "system", printers, default })
    }
    #[cfg(not(unix))]
    {
        let _ = dirs;
        None
    }
}

/// Sends `file` to `lp` in `dirs`. Answers the job id where lp names one.
pub fn send_to_lp(dirs: &[&Path], job: &Job, file: &Path) -> CmdResult<Option<String>> {
    #[cfg(unix)]
    {
        let (lp, _) = cups(dirs).ok_or_else(|| CmdError::new("no-printer", "lp not found"))?;
        let mut cmd = Command::new(&lp);
        cmd.args(lp_args(job, file)).stdin(Stdio::null()).stderr(Stdio::piped());
        crate::speech::prepare(&mut cmd);
        c_locale(&mut cmd);
        let out = crate::speech::run_with_timeout(cmd, TIMEOUT).map_err(|e| {
            if e.kind() == std::io::ErrorKind::TimedOut {
                CmdError::new("timeout", "lp did not answer")
            } else {
                CmdError::new("failed", format!("lp: {e}"))
            }
        })?;
        if !out.status.success() {
            let said = String::from_utf8_lossy(&out.stderr).trim().to_string();
            return Err(CmdError::new("failed", if said.is_empty() { format!("lp ended with {}", out.status) } else { said }));
        }
        Ok(parse_job(&String::from_utf8_lossy(&out.stdout)))
    }
    #[cfg(not(unix))]
    {
        let _ = (dirs, job, file);
        Err(CmdError::new("no-printer", "no CUPS on this system"))
    }
}

fn dirs() -> Vec<&'static Path> {
    CUPS_DIRS.iter().map(Path::new).collect()
}

/// Removes the file however the job ends.
struct Remove(PathBuf);
impl Drop for Remove {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// The page's temp PDF, checked: written by the page into the private temp folder.
fn temp_pdf(state: &SharedState, path: &str) -> CmdResult<PathBuf> {
    let p = state.access.check(path, crate::access::Access::Write)?;
    let dir = std::fs::canonicalize(crate::fsops::temp_dir()).map_err(|e| CmdError::io(&e, "temp dir"))?;
    if !p.starts_with(&dir) {
        return Err(CmdError::not_allowed("not a temp file"));
    }
    let head = std::fs::read(&p).map_err(|e| CmdError::io(&e, p.display()))?;
    if !head.starts_with(b"%PDF-") {
        return Err(CmdError::invalid("not a PDF"));
    }
    Ok(p)
}

/// How this computer prints: its printers (CUPS), or "open" the PDF in its program.
#[tauri::command]
pub async fn print_printers() -> CmdResult<PrintersDto> {
    blocking(move || Ok(system_printers(&dirs()).unwrap_or(PrintersDto { way: "open", printers: Vec::new(), default: None }))).await
}

/// What happened to the PDF.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PrintedDto {
    /// "sent": to the printer; "opened": in the PDF program.
    pub way: &'static str,
    pub job: Option<String>,
}

/// Prints the PDF at `path` (a file of fs_temp_file) in its real size with
/// `printer`, or opens it in the computer's PDF program (`open`, Windows,
/// no CUPS). Error codes: no-printer, failed, timeout, not-allowed.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn print_pdf(
    app: tauri::AppHandle,
    state: State<'_, SharedState>,
    path: String,
    name: String,
    printer: Option<String>,
    width_mm: f64,
    height_mm: f64,
    two_sided: bool,
    open: bool,
) -> CmdResult<PrintedDto> {
    let st = state.inner().clone();
    blocking(move || {
        let file = temp_pdf(&st, &path)?;
        let remove = Remove(file.clone());
        if !open && cfg!(unix) {
            if let Some(p) = &printer {
                if !valid_printer(p) {
                    return Err(CmdError::invalid(format!("no printer name: {p}")));
                }
            }
            if !(width_mm > 0.0 && height_mm > 0.0 && width_mm < 2000.0 && height_mm < 2000.0) {
                return Err(CmdError::invalid("paper size"));
            }
            let job = Job { title: name.clone(), printer, width_mm, height_mm, two_sided };
            let id = send_to_lp(&dirs(), &job, &file)?;
            return Ok(PrintedDto { way: "sent", job: id });
        }
        // The PDF program reads the file after this returns: it moves to a name of its own and stays.
        let dir = crate::fsops::private_temp_dir()?.join("drucken");
        std::fs::create_dir_all(&dir).map_err(|e| CmdError::io(&e, dir.display()))?;
        let target = dir.join(pdf_file_name(&name));
        std::fs::rename(&file, &target).or_else(|_| std::fs::copy(&file, &target).map(|_| ())).map_err(|e| CmdError::io(&e, target.display()))?;
        drop(remove);
        use tauri_plugin_opener::OpenerExt;
        app.opener().open_path(target.to_string_lossy(), None::<&str>).map_err(|e| CmdError::new("failed", e.to_string()))?;
        Ok(PrintedDto { way: "opened", job: None })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn job(printer: Option<&str>, w: f64, h: f64, two_sided: bool) -> Job {
        Job { title: "Sticker Meine Box".into(), printer: printer.map(String::from), width_mm: w, height_mm: h, two_sided }
    }

    #[test]
    fn lp_prints_in_real_size_on_the_paper_of_the_pdf() {
        let args = lp_args(&job(Some("Brother_MFC_J5320DW"), 210.0, 297.0, false), Path::new("/tmp/x/a.pdf"));
        assert_eq!(
            args,
            [
                "-d", "Brother_MFC_J5320DW", "-t", "Sticker Meine Box", "-n", "1", "-o", "media=A4", "-o", "print-scaling=none", "-o", "fit-to-page=false", "-o",
                "fitplot=false", "-o", "sides=one-sided", "/tmp/x/a.pdf"
            ]
        );
        // Without a printer: CUPS's default one.
        let args = lp_args(&job(None, 215.9, 279.4, true), Path::new("/tmp/b.pdf"));
        assert_eq!(args[0], "-t");
        assert!(args.contains(&"media=Letter".to_string()));
        assert!(args.contains(&"sides=two-sided-long-edge".to_string()));
    }

    #[test]
    fn names_the_paper() {
        assert_eq!(media_for(210.0, 297.0), "A4");
        assert_eq!(media_for(297.0, 210.0), "A4");
        assert_eq!(media_for(215.9, 279.4), "Letter");
        assert_eq!(media_for(148.0, 100.0), "Custom.100x148mm");
        assert_eq!(media_for(127.0, 177.8), "Custom.127x177.8mm");
    }

    #[test]
    fn reads_the_printers_of_lpstat() {
        assert_eq!(parse_printers("Brother_MFC_J5320DW\nPDF\n\nPDF\n"), ["Brother_MFC_J5320DW", "PDF"]);
        assert_eq!(parse_printers("Brother accepting requests since Mon 19 Oct 2026\n"), ["Brother"]);
        assert_eq!(parse_default("system default destination: Brother_MFC_J5320DW\n"), Some("Brother_MFC_J5320DW".into()));
        assert_eq!(parse_default("no system default destination\n"), None);
        assert_eq!(parse_job("request id is Brother-12 (1 file(s))\n"), Some("Brother-12".into()));
    }

    #[test]
    fn refuses_names_that_would_be_options() {
        assert!(valid_printer("HP_LaserJet@host"));
        assert!(!valid_printer("-oevil"));
        assert!(!valid_printer("two words"));
        assert!(!valid_printer(""));
    }

    #[test]
    fn opens_the_pdf_under_a_plain_name() {
        assert_eq!(pdf_file_name("Sticker Meine Box.pdf"), "Sticker Meine Box.pdf");
        assert_eq!(pdf_file_name("a/b:c?.pdf"), "a b c.pdf");
        assert_eq!(pdf_file_name("  "), "TonUINO Studio.pdf");
    }

    /// A made-up CUPS: lpstat names two printers, lp keeps a copy of what it
    /// gets and its arguments, like a virtual printer.
    #[cfg(unix)]
    #[test]
    fn hands_the_pdf_to_lp_and_reads_the_printers() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("tonuino-print-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let script = |name: &str, body: &str| {
            let p = dir.join(name);
            std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        };
        let out = dir.join("out");
        script(
            "lpstat",
            r#"case "$1" in -e) printf 'Brother_MFC_J5320DW\nPDF\n';; -d) echo "system default destination: PDF";; esac"#,
        );
        script(
            "lp",
            &format!(
                r#"for a in "$@"; do printf '%s\n' "$a"; done > {o}.args; for a in "$@"; do f="$a"; done; cp "$f" {o}.pdf; echo "request id is PDF-7 (1 file(s))""#,
                o = out.display()
            ),
        );
        let dirs = [dir.as_path()];
        let found = system_printers(&dirs).unwrap();
        assert_eq!(found, PrintersDto { way: "system", printers: vec!["Brother_MFC_J5320DW".into(), "PDF".into()], default: Some("PDF".into()) });
        let pdf = dir.join("in.pdf");
        std::fs::write(&pdf, b"%PDF-1.3 test").unwrap();
        let id = send_to_lp(&dirs, &job(Some("PDF"), 210.0, 297.0, false), &pdf).unwrap();
        assert_eq!(id.as_deref(), Some("PDF-7"));
        assert_eq!(std::fs::read(out.with_extension("pdf")).unwrap(), b"%PDF-1.3 test");
        let args = std::fs::read_to_string(out.with_extension("args")).unwrap();
        assert!(args.contains("print-scaling=none\n") && args.contains("media=A4\n"), "{args}");
        // A refused job says why.
        script("lp", "echo 'lp: The printer or class does not exist.' >&2; exit 1");
        let err = send_to_lp(&dirs, &job(Some("Gone"), 210.0, 297.0, false), &pdf).unwrap_err();
        assert_eq!(err.code, "failed");
        assert!(err.detail.contains("does not exist"), "{}", err.detail);
        // No CUPS: none of it.
        let empty = dir.join("empty");
        std::fs::create_dir_all(&empty).unwrap();
        assert!(system_printers(&[empty.as_path()]).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
