/**
 * Virtual printers for the test bench (TODO #69, #85): a CUPS of its own,
 * started for the test and stopped afterwards, with no effect on the
 * computer's printers. Its printers are inkjets as PPD files describe them
 * (paper A4 or Letter, a printable area with the usual margins, or
 * borderless) and write the PDF the printer would get into a file:
 *
 * - "file" printers: CUPS's own filters (cups-filters 2: universal/pdftopdf)
 *   and the file: device. What comes out is exactly what CUPS made of the
 *   job: scaled, turned, cut or not.
 * - "cups-pdf": the printer-driver package printer-driver-cups-pdf, as people
 *   install it to "print to PDF". It goes through PostScript and Ghostscript
 *   and writes into its own spool folder. Its backend runs only as root.
 *
 * The jobs are sent with the real `lp`, so the options the app gives
 * (print.rs) meet the real option parser and filters.
 */
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { has, sleep } from '../labor';

const run = promisify(execFile);

export interface Margins {
  /** Unprintable edges in mm. */
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface VirtualPrinter {
  name: string;
  kind: 'file' | 'cups-pdf';
  paper: 'A4' | 'Letter';
  margins: Margins;
}

const PAPER = { A4: [595.28, 841.89], Letter: [612, 792] } as const;
const PT = 72 / 25.4;

/** A PPD of an inkjet that takes PDF, with the printable area of `m`. */
export function inkjetPpd(name: string, paper: 'A4' | 'Letter', m: Margins): string {
  const f = (v: number) => v.toFixed(2);
  const area = (p: 'A4' | 'Letter') => {
    const [w, h] = PAPER[p];
    return `"${f(m.left * PT)} ${f(m.bottom * PT)} ${f(w - m.right * PT)} ${f(h - m.top * PT)}"`;
  };
  return `*PPD-Adobe: "4.3"
*FormatVersion: "4.3"
*FileVersion: "1.0"
*LanguageVersion: English
*LanguageEncoding: ISOLatin1
*PCFileName: "LABOR.PPD"
*Manufacturer: "Testlabor"
*Product: "(Tintenstrahl)"
*ModelName: "${name}"
*ShortNickName: "${name}"
*NickName: "${name} (Testlabor)"
*PSVersion: "(3010.000) 0"
*LanguageLevel: "3"
*ColorDevice: True
*DefaultColorSpace: RGB
*FileSystem: False
*Throughput: "1"
*LandscapeOrientation: Plus90
*TTRasterizer: Type42
*cupsVersion: 2.4
*cupsFilter2: "application/vnd.cups-pdf application/pdf 0 -"
*HWMargins: ${f(m.left * PT)} ${f(m.bottom * PT)} ${f(m.right * PT)} ${f(m.top * PT)}
*OpenUI *PageSize/Media Size: PickOne
*OrderDependency: 10 AnySetup *PageSize
*DefaultPageSize: ${paper}
*PageSize A4/A4: "<</PageSize[595 842]/ImagingBBox null>>setpagedevice"
*PageSize Letter/US Letter: "<</PageSize[612 792]/ImagingBBox null>>setpagedevice"
*CloseUI: *PageSize
*OpenUI *PageRegion: PickOne
*OrderDependency: 10 AnySetup *PageRegion
*DefaultPageRegion: ${paper}
*PageRegion A4/A4: "<</PageSize[595 842]/ImagingBBox null>>setpagedevice"
*PageRegion Letter/US Letter: "<</PageSize[612 792]/ImagingBBox null>>setpagedevice"
*CloseUI: *PageRegion
*DefaultImageableArea: ${paper}
*ImageableArea A4/A4: ${area('A4')}
*ImageableArea Letter/US Letter: ${area('Letter')}
*DefaultPaperDimension: ${paper}
*PaperDimension A4/A4: "595 842"
*PaperDimension Letter/US Letter: "612 792"
*OpenUI *Duplex/2-Sided Printing: PickOne
*OrderDependency: 10 AnySetup *Duplex
*DefaultDuplex: None
*Duplex None/Off: "<</Duplex false>>setpagedevice"
*Duplex DuplexNoTumble/Long Edge: "<</Duplex true/Tumble false>>setpagedevice"
*Duplex DuplexTumble/Short Edge: "<</Duplex true/Tumble true>>setpagedevice"
*CloseUI: *Duplex
*DefaultFont: Courier
*Font Courier: Standard "(002.004S)" Standard ROM
`;
}

const CUPS_PDF_BACKEND = '/usr/lib/cups/backend/cups-pdf';
const CUPS_PDF_PPD = '/usr/share/ppd/cups-pdf/CUPS-PDF_noopt.ppd';

/** The PPD of cups-pdf with the printable area of an inkjet. */
function cupsPdfPpd(paper: 'A4' | 'Letter', m: Margins): string {
  const f = (v: number) => v.toFixed(2);
  let ppd = readFileSync(CUPS_PDF_PPD, 'latin1');
  ppd = ppd.replace(/^\*HWMargins:.*$/m, `*HWMargins: ${f(m.left * PT)} ${f(m.bottom * PT)} ${f(m.right * PT)} ${f(m.top * PT)}`);
  for (const p of ['A4', 'Letter'] as const) {
    const [w, h] = PAPER[p];
    const re = new RegExp(`^\\*ImageableArea ${p}/[^:]*:.*$`, 'm');
    ppd = ppd.replace(re, (line) => `${line.slice(0, line.indexOf(':'))}: "${f(m.left * PT)} ${f(m.bottom * PT)} ${f(w - m.right * PT)} ${f(h - m.top * PT)}"`);
  }
  return ppd.replace(/^\*DefaultPageSize:.*$/m, `*DefaultPageSize: ${paper}`).replace(/^\*DefaultPageRegion:.*$/m, `*DefaultPageRegion: ${paper}`);
}

/** Why there is no CUPS for the bench here, or null when there is. */
export function cupsMissing(): string | null {
  for (const p of ['cupsd', 'lp', 'lpadmin', 'lpstat']) {
    const found = ['/usr/sbin', '/usr/bin', '/sbin', '/bin'].some((d) => existsSync(join(d, p)));
    if (!found && !has(p, ['-h'])) return `${p} fehlt (apt-get install cups cups-client cups-filters)`;
  }
  if (!existsSync('/usr/lib/cups/filter/pdftopdf') && !existsSync('/usr/lib/cups/filter/universal')) return 'CUPS-Filter fehlen (apt-get install cups-filters)';
  return null;
}

/** Why cups-pdf cannot be used here, or null. */
export function cupsPdfMissing(): string | null {
  if (!existsSync(CUPS_PDF_BACKEND) || !existsSync(CUPS_PDF_PPD)) return 'CUPS-PDF fehlt (apt-get install printer-driver-cups-pdf)';
  if (process.getuid?.() !== 0) return 'CUPS-PDF: das Backend läuft nur, wenn CUPS als root läuft (Testlabor als root starten oder Teil überspringen)';
  return null;
}

export class PrivateCups {
  private daemon: ChildProcess | null = null;
  private readonly env: NodeJS.ProcessEnv;
  private readonly printers = new Map<string, VirtualPrinter>();
  /** Every lp call: the printer and the arguments. */
  readonly jobs: { printer: string; args: string[] }[] = [];

  private constructor(readonly dir: string) {
    this.env = { ...process.env, CUPS_SERVER: join(dir, 'cups.sock'), LC_ALL: 'C' };
  }

  /**
   * Starts a CUPS of its own in a fresh folder. As root its filters run as
   * the user lp, so the folder lies where lp can reach it.
   */
  static async start(): Promise<PrivateCups> {
    const root = process.getuid?.() === 0 ? '/tmp' : (process.env.LABOR_TMP ?? process.env.TMPDIR ?? '/tmp');
    const dir = mkdtempSync(join(root, 'tonuino-labor-cups-'));
    chmodSync(dir, 0o755);
    for (const d of ['etc/ppd', 'spool/tmp', 'state', 'cache', 'log', 'out', 'jobs']) mkdirSync(join(dir, d), { recursive: true });
    chmodSync(join(dir, 'out'), 0o777);
    chmodSync(join(dir, 'jobs'), 0o755);
    chmodSync(join(dir, 'spool/tmp'), 0o1777);
    writeFileSync(
      join(dir, 'etc/cupsd.conf'),
      [
        `Listen ${join(dir, 'cups.sock')}`,
        'LogLevel info',
        'WebInterface No',
        'DefaultAuthType None',
        'Browsing No',
        '<Location />',
        '  Order allow,deny',
        '  Allow all',
        '</Location>',
        '<Policy default>',
        '  JobPrivateAccess all',
        '  JobPrivateValues none',
        '  SubscriptionPrivateAccess all',
        '  SubscriptionPrivateValues none',
        '  <Limit All>',
        '    Order deny,allow',
        '  </Limit>',
        '</Policy>',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(dir, 'etc/cups-files.conf'),
      [
        `ServerRoot ${join(dir, 'etc')}`,
        `RequestRoot ${join(dir, 'spool')}`,
        `TempDir ${join(dir, 'spool/tmp')}`,
        `StateDir ${join(dir, 'state')}`,
        `CacheDir ${join(dir, 'cache')}`,
        `AccessLog ${join(dir, 'log/access_log')}`,
        `ErrorLog ${join(dir, 'log/error_log')}`,
        `PageLog ${join(dir, 'log/page_log')}`,
        'FileDevice Yes',
        'ServerBin /usr/lib/cups',
        'DataDir /usr/share/cups',
        'Sandboxing Relaxed',
        `SystemGroup ${process.getuid?.() === 0 ? 'root' : groupName()}`,
        '',
      ].join('\n'),
    );
    const cups = new PrivateCups(dir);
    const cupsd = ['/usr/sbin/cupsd', '/sbin/cupsd'].find((p) => existsSync(p)) ?? 'cupsd';
    cups.daemon = spawn(cupsd, ['-f', '-c', join(dir, 'etc/cupsd.conf'), '-s', join(dir, 'etc/cups-files.conf')], { stdio: 'ignore', env: cups.env });
    const end = Date.now() + 15_000;
    for (;;) {
      try {
        await run('lpstat', ['-r'], { env: cups.env });
        break;
      } catch {
        if (Date.now() > end || cups.daemon.exitCode !== null) {
          const log = cups.log();
          await cups.stop();
          throw new Error(`CUPS startet nicht: ${log}`);
        }
        await sleep(100);
      }
    }
    return cups;
  }

  /** The last lines of CUPS's log, for a failing test. */
  log(lines = 15): string {
    try {
      return readFileSync(join(this.dir, 'log/error_log'), 'utf8').trim().split('\n').slice(-lines).join('\n');
    } catch {
      return '(kein Protokoll)';
    }
  }

  async add(p: VirtualPrinter): Promise<void> {
    const ppd = join(this.dir, `${p.name}.ppd`);
    writeFileSync(ppd, p.kind === 'cups-pdf' ? cupsPdfPpd(p.paper, p.margins) : inkjetPpd(p.name, p.paper, p.margins), 'latin1');
    const device = p.kind === 'cups-pdf' ? 'cups-pdf:/' : `file://${this.outFile(p.name)}`;
    await run('lpadmin', ['-p', p.name, '-E', '-v', device, '-P', ppd, '-o', `PageSize=${p.paper}`, '-o', 'printer-error-policy=abort-job'], { env: this.env });
    this.printers.set(p.name, p);
  }

  private outFile(printer: string): string {
    return join(this.dir, 'out', `${printer}.pdf`);
  }

  /** Where cups-pdf puts its files (its spool folder for the user, or ~/PDF). */
  private cupsPdfFolders(): string[] {
    const user = process.env.USER ?? 'root';
    return [`/var/spool/cups-pdf/${user}`, '/var/spool/cups-pdf/ANONYMOUS', join(process.env.HOME ?? '/root', 'PDF')];
  }

  private pdfsIn(folders: string[]): Map<string, number> {
    const seen = new Map<string, number>();
    for (const d of folders) {
      try {
        for (const f of readdirSync(d)) if (f.endsWith('.pdf')) seen.set(join(d, f), statSync(join(d, f)).mtimeMs);
      } catch {
        // not there (yet)
      }
    }
    return seen;
  }

  /**
   * Prints `pdf` with `lp` and these arguments (the file comes last, as in
   * print.rs; `{file}` stands for it) and returns what the printer got.
   */
  async print(printer: string, pdf: Uint8Array, args: (file: string) => string[]): Promise<Uint8Array> {
    const p = this.printers.get(printer);
    if (!p) throw new Error(`kein Drucker ${printer}`);
    const file = join(this.dir, 'jobs', `job-${this.jobs.length + 1}.pdf`);
    writeFileSync(file, pdf);
    chmodSync(file, 0o644);
    const out = this.outFile(printer);
    // The file device writes into a file that must be there and is not cut short: a new empty one per job.
    rmSync(out, { force: true });
    writeFileSync(out, '');
    chmodSync(out, 0o666);
    const before = p.kind === 'cups-pdf' ? this.pdfsIn(this.cupsPdfFolders()) : null;
    const a = args(file);
    this.jobs.push({ printer, args: a });
    const { stdout } = await run('lp', a, { env: this.env });
    const id = /request id is (\S+)/.exec(stdout)?.[1];
    if (!id) throw new Error(`lp ohne Auftrag: ${stdout}`);
    const end = Date.now() + 90_000;
    for (;;) {
      const { stdout: open } = await run('lpstat', ['-W', 'not-completed', '-o'], { env: this.env });
      if (!open.split('\n').some((l) => l.startsWith(`${id} `))) break;
      if (Date.now() > end) throw new Error(`Druckauftrag ${id} hängt:\n${this.log()}`);
      await sleep(150);
    }
    if (p.kind === 'file') {
      const bytes = new Uint8Array(readFileSync(out));
      if (bytes.length < 8 || new TextDecoder().decode(bytes.subarray(0, 5)) !== '%PDF-') throw new Error(`Drucker ${printer} bekam kein PDF:\n${this.log()}`);
      return bytes;
    }
    // cups-pdf: the file that is new or newer since the job was sent.
    for (let i = 0; i < 40; i++) {
      const now = this.pdfsIn(this.cupsPdfFolders());
      const fresh = [...now].filter(([f, t]) => (before!.get(f) ?? -1) < t).map(([f]) => f);
      if (fresh.length) {
        await sleep(100);
        const bytes = new Uint8Array(readFileSync(fresh[0]));
        rmSync(fresh[0], { force: true });
        return bytes;
      }
      await sleep(150);
    }
    throw new Error(`CUPS-PDF schrieb keine Datei (${this.cupsPdfFolders().join(', ')}):\n${this.log()}`);
  }

  async stop(): Promise<void> {
    const d = this.daemon;
    if (d && d.exitCode === null) {
      const gone = new Promise((r) => d.once('exit', r));
      d.kill('SIGTERM');
      await Promise.race([gone, sleep(5000)]);
      if (d.exitCode === null) d.kill('SIGKILL');
    }
    this.daemon = null;
    rmSync(this.dir, { recursive: true, force: true });
  }
}

function groupName(): string {
  try {
    return execFileSync('id', ['-gn'], { encoding: 'utf8' }).trim();
  } catch {
    return 'lpadmin';
  }
}
