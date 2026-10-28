/**
 * The firmware wizard as plain state: which board, which buttons, which
 * firmware, and what happened. The page only renders it, so the rules
 * (what resets what, when a step may open) are tested here.
 */
import type { BoxInfo, FirmwareFamily } from '../../core/firmware/bootlog';
import {
  FirmwareDownloadError,
  describeFlashError,
  downloadFirmwareFile,
  type FetchFn,
  type FirmwareBackup,
  type FlashProblem,
  type FlashStatus,
  type HostOs,
  type FlashSuccess,
} from '../../core/firmware/flash';
import { HexError, parseIntelHex, type HexImage } from '../../core/firmware/intelhex';
import {
  VARIANTS,
  askShutdown,
  getBoard,
  largestFirmware,
  readyMadeShutdownFits,
  usesCh340,
  type BoardId,
  type BoardInfo,
  type ButtonVariant,
  type Esp32Board,
  type ShutdownKind,
} from '../../core/firmware/variants';
import {
  baukastenFileName,
  buildId,
  choiceStatus,
  choiceSummary,
  isBaukastenBoard,
  isBaukastenButtons,
  isPlain,
  loadBuildImage,
  normalizeChoice,
  sourceText as baukastenSource,
  type BaukastenBoard,
  type BaukastenButtons,
  type BaukastenManifest,
  type ExtrasChoice,
  type LocalFetch,
} from '../../core/firmware/baukasten';
import type { FirmwareProfile } from '../../core/tonuino/card';
import { CHECKED_TNG, isChecked, knownStand, standTitle } from '../../core/firmware/tngstands';
import { tngStandOf } from '../../core/tonuino/firmwaredetect';
import type { ByteSource, SerialPortInfo } from '../../platform/types';
import { formatBytes, formatDuration } from '../../app/format';

/** `source`: „Firmware“, or „Extras“ for Classic and AiO (the Firmware-Baukasten), which then have „Verhalten“ before the upload. */
export type WizardStep = 'board' | 'variant' | 'source' | 'verhalten' | 'flash';

/** A build of the Firmware-Baukasten that came with the app (src/core/firmware/baukasten.ts). */
export interface BaukastenInfo {
  id: string;
  /** "Drehregler, Weitermachen"; empty for the build without extras (the ready-made firmware of Classic and AiO). */
  summary: string;
  /** "TonUINO TNG 3.3.3 vom 17.09.2026": the checked state of TNG the build is made from. */
  stand: string;
  /** Where it comes from (GPL): TNG version, commit, flags. */
  source: string;
  /** Classic: only fits a Nano with the new bootloader. */
  needsNewBootloader: boolean;
}

/** The firmware to flash: a ready-made build, a file of your own, or the firmware saved before the last upload. */
export type FirmwareChoice =
  | {
      kind: 'download';
      board: BoardId;
      variant: ButtonVariant;
      fileName: string;
      /** Where the official build was loaded from; for a Baukasten build the folder in the app. */
      url: string;
      /** Size of the .hex file (Baukasten: of the image). */
      fileBytes: number;
      image: HexImage;
      /**
       * Set for a build of the Firmware-Baukasten (in the app, from the checked TNG state), with or
       * without extras: Classic and AiO always get one. Unset for a download from tonuino.github.io.
       */
      baukasten?: BaukastenInfo;
      /**
       * A download from tonuino.github.io that is not the checked TNG state (CHECKED_TNG): the server
       * always has the newest main. What its version line says; {} when it has none. Goes on the box
       * only after the user said so (WizardState.uncheckedOk).
       */
      unchecked?: { version?: string; date?: string };
    }
  | { kind: 'file'; board: BoardId; fileName: string; fileBytes: number; image: HexImage }
  | { kind: 'backup'; board: BoardId; fileName: string; fileBytes: number; image: HexImage };

export interface WizardState {
  step: WizardStep;
  board?: BoardId;
  variant?: ButtonVariant;
  firmware?: FirmwareChoice;
  /** How the box switches off; asked before a ready-made build for the boards in askShutdown(). */
  shutdown?: ShutdownKind;
  /** Extras of the Firmware-Baukasten ticked under „Extras“ (Classic and AiO). */
  extras?: ExtrasChoice;
  /** The user wants the downloaded firmware although TonUINO Studio has not checked it (FirmwareChoice.unchecked). */
  uncheckedOk?: boolean;
}

export function initialWizard(): WizardState {
  return { step: 'board' };
}

/** Steps shown in the header. ESP32 boxes update over Wi-Fi, so their third step is the guide and there is no fourth. */
export function stepsFor(board: BoardInfo | undefined): { id: WizardStep; label: string }[] {
  if (board?.method === 'unsupported') return [{ id: 'board', label: 'Platine' }];
  // Classic and AiO: the Firmware-Baukasten, with „Verhalten“ (design/06-umbau/loetplan, entwurf-baukasten, entwurf-verhalten).
  // Without a board yet, the way of most boxes (Classic, AiO): the bar keeps its length when one is chosen (Prüfrunde 2, bastler 4).
  if (!board || isBaukastenBoard(board.id)) {
    return [
      { id: 'board', label: 'Platine' },
      { id: 'variant', label: 'Tasten' },
      { id: 'source', label: 'Extras' },
      { id: 'verhalten', label: 'Verhalten' },
      { id: 'flash', label: 'Aufspielen' },
    ];
  }
  if (board?.method === 'esp32') {
    return [
      { id: 'board', label: 'Platine' },
      { id: 'variant', label: 'Tasten' },
      { id: 'source', label: 'Update über WLAN' },
    ];
  }
  return [
    { id: 'board', label: 'Platine' },
    { id: 'variant', label: 'Tasten' },
    { id: 'source', label: 'Firmware' },
    { id: 'flash', label: 'Aufspielen' },
  ];
}

/**
 * Picking another board keeps the button variant when that board has it;
 * firmware for another board is dropped, and so is the answer how the box
 * switches off (it means something else on another board).
 */
export function chooseBoard(s: WizardState, board: BoardId): WizardState {
  const b = getBoard(board);
  const variant = s.variant && b.variants.includes(s.variant) ? s.variant : undefined;
  const firmware = s.firmware?.board === board && (s.firmware.kind !== 'download' || s.firmware.variant === variant) ? s.firmware : undefined;
  const next: WizardState = { step: s.step, board, variant, firmware };
  if (s.shutdown && s.board === board) next.shutdown = s.shutdown;
  if (s.extras) next.extras = s.extras;
  return keepMatching(next);
}

/** A downloaded build belongs to one variant; a file of your own stays. */
export function chooseVariant(s: WizardState, variant: ButtonVariant): WizardState {
  const firmware = s.firmware?.kind === 'download' && s.firmware.variant !== variant ? undefined : s.firmware;
  return keepMatching({ ...s, variant, firmware });
}

/** The extras ticked under „Extras“; a ready-made build that is no longer the right one is dropped. */
export function chooseExtras(s: WizardState, extras: ExtrasChoice): WizardState {
  return keepMatching({ ...s, extras });
}

export function chooseFirmware(s: WizardState, firmware: FirmwareChoice | undefined): WizardState {
  // A yes to unchecked firmware is for that one download only.
  const { uncheckedOk: _, ...rest } = s;
  return { ...rest, firmware };
}

/** The user says yes (or no) to a download TonUINO Studio has not checked. */
export function acceptUnchecked(s: WizardState, ok: boolean): WizardState {
  return { ...s, uncheckedOk: ok };
}

/** The answer how the box switches off. A ready-made build that does not fit that box is dropped; a file of your own stays. */
export function chooseShutdown(s: WizardState, shutdown: ShutdownKind): WizardState {
  const board = s.board ? getBoard(s.board) : undefined;
  const next = { ...s, shutdown };
  const firmware = s.firmware;
  if (firmware?.kind === 'download' && board && !firmware.baukasten && !readyMadeAllowed(board, shutdown) && !wantsBaukasten(next)) next.firmware = undefined;
  return keepMatching(next);
}

/* ------------------------------------------------------------ Baukasten */

/** Board, buttons and extras for the Firmware-Baukasten, when the chosen board and buttons have it. The shutdown answer „Trägerplatine“ is an extra there. */
export function baukastenChoice(s: WizardState): { board: BaukastenBoard; buttons: BaukastenButtons; choice: ExtrasChoice } | undefined {
  if (!isBaukastenBoard(s.board) || !isBaukastenButtons(s.variant)) return undefined;
  const choice = normalizeChoice(s.board, s.variant, { ...s.extras, traeger: s.shutdown === 'traeger' });
  return { board: s.board, buttons: s.variant, choice };
}

/** True when the box needs a build with extras (something ticked, or the carrier board). */
export function wantsBaukasten(s: WizardState): boolean {
  const b = baukastenChoice(s);
  return !!b && !isPlain(b.choice);
}

/**
 * The id of the Baukasten build the wizard wants. Classic and AiO always get
 * one: without extras the plain build ("classic-3"), the checked TNG state
 * that comes with the app instead of the newest main from tonuino.github.io
 * (tngstands.ts). Undefined for the other boards, which download.
 */
export function wantedBuildId(s: WizardState): string | undefined {
  const b = baukastenChoice(s);
  return b ? buildId(b.board, b.buttons, b.choice) : undefined;
}

/** A ready-made build that is not the one the choices ask for goes; a file of your own stays. */
function keepMatching(s: WizardState): WizardState {
  const f = s.firmware;
  if (f?.kind !== 'download') return s;
  return f.baukasten?.id === wantedBuildId(s) ? s : { ...s, firmware: undefined };
}

/** A Baukasten build that did not load: the files of the app are damaged or missing. */
export function baukastenProblem(e: unknown): FlashProblem {
  return {
    code: 'bad-image',
    title: 'Die Firmware mit Extras ließ sich nicht laden',
    explanation: 'Die Firmware mit Extras ist in TonUINO Studio eingebaut, aber die Datei fehlt oder ist beschädigt.',
    steps: ['Versuche es noch einmal.', 'Klappt es wieder nicht, lade TonUINO Studio neu oder installiere die Desktop-App neu.'],
    technical: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
  };
}

/** Loads the Baukasten build the wizard wants from the files that came with the app. */
export async function loadBaukasten(fetchFn: LocalFetch, base: string, manifest: BaukastenManifest, s: WizardState): Promise<FirmwareChoice> {
  const b = baukastenChoice(s);
  if (!b) throw new RangeError('no Baukasten build wanted');
  const status = choiceStatus(manifest, b.board, b.buttons, b.choice);
  if (status.kind !== 'ok') throw new RangeError(`Baukasten build ${buildId(b.board, b.buttons, b.choice)}: ${status.kind}`);
  const build = status.build;
  const image = await loadBuildImage(fetchFn, base, build);
  return {
    kind: 'download',
    board: b.board,
    variant: b.buttons,
    fileName: baukastenFileName(build),
    url: `${base}firmware/baukasten/${build.pack}`,
    fileBytes: build.bytes,
    image,
    baukasten: {
      id: build.id,
      summary: choiceSummary(b.choice),
      stand: build.writeCard && manifest.writeCardPreview ? `TonUINO TNG ${manifest.writeCardPreview.versionString.slice(1)}` : standTitle(manifestStand(manifest)),
      source: baukastenSource(manifest, build),
      needsNewBootloader: build.needsNewBootloader,
    },
  };
}

/** The TNG state of the Baukasten builds, from the manifest ("V3.3.3 17.09.26"). */
function manifestStand(manifest: BaukastenManifest): { version: string; date: string } {
  const m = /(\d{1,2})\.(\d{1,2})\.(\d{2})$/.exec(manifest.tng.versionString);
  const date = manifest.tng.date ?? (m ? `20${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : '');
  return { version: manifest.tng.version, date };
}

/**
 * Choosing „Fertige Firmware“: a file of your own picked before is dropped,
 * so it cannot be uploaded while the page shows the ready-made build.
 */
export function pickReadyMade(s: WizardState): WizardState {
  return s.firmware && s.firmware.kind !== 'download' ? chooseFirmware(s, undefined) : s;
}

/**
 * Whether the ready-made build may go on this box. Boards that are asked
 * need an answer first, and the answer must fit the build.
 */
export function readyMadeAllowed(board: BoardId | BoardInfo, shutdown: ShutdownKind | undefined): boolean {
  if (!askShutdown(board)) return true;
  if (!shutdown) return false;
  // The Firmware-Baukasten has builds with the shutdown the other way round (Classic).
  if (shutdown === 'traeger' && isBaukastenBoard(typeof board === 'string' ? board : board.id)) return true;
  return readyMadeShutdownFits(board, shutdown);
}

/** Next to a disabled download or „Weiter“ while the answer how the box switches off is missing. */
export const ASK_SHUTDOWN_FIRST = 'Sage zuerst oben, wie deine Box ausgeht.';

/**
 * Why „Weiter“ stays off in the source step, when it is the shutdown
 * question: no answer yet, or an answer the ready-made build does not fit.
 */
export function sourceBlocker(board: BoardInfo, source: 'download' | 'file' | null, shutdown: ShutdownKind | undefined): string | undefined {
  if (source !== 'download' || !askShutdown(board)) return undefined;
  if (!shutdown) return ASK_SHUTDOWN_FIRST;
  return readyMadeAllowed(board, shutdown) ? undefined : 'Nimm für deine Box „Eigene Datei“.';
}

/** Whether a step may open with what is chosen so far. */
export function canEnter(s: WizardState, step: WizardStep): boolean {
  const board = s.board ? getBoard(s.board) : undefined;
  switch (step) {
    case 'board':
      return true;
    case 'variant':
      return !!board && board.method !== 'unsupported';
    case 'source':
      return canEnter(s, 'variant') && !!s.variant && board!.variants.includes(s.variant);
    case 'verhalten':
      // A file of your own goes straight to the upload: what it does is in the file.
      return canEnter(s, 'source') && isBaukastenBoard(board!.id) && s.firmware?.kind !== 'file' && readyMadeAllowed(board!, s.shutdown);
    case 'flash':
      return (
        canEnter(s, 'source') &&
        board!.method === 'stk500' &&
        !!s.firmware &&
        s.firmware.board === board!.id &&
        (s.firmware.kind !== 'download' ||
          (readyMadeAllowed(board!, s.shutdown) && s.firmware.baukasten?.id === wantedBuildId(s) && (!s.firmware.unchecked || s.uncheckedOk === true)))
      );
  }
}

/** Whether the wizard passes „Verhalten“: not with a file of your own. */
function skipsVerhalten(s: WizardState): boolean {
  return s.firmware?.kind === 'file';
}

/** The step after this one, or null at the end. */
export function nextStep(s: WizardState): WizardStep | null {
  const steps = stepsFor(s.board ? getBoard(s.board) : undefined);
  const i = steps.findIndex((x) => x.id === s.step);
  let next = steps[i + 1];
  if (next?.id === 'verhalten' && skipsVerhalten(s)) next = steps[i + 2];
  return next && canEnter(s, next.id) ? next.id : null;
}

export function previousStep(s: WizardState): WizardStep | null {
  const steps = stepsFor(s.board ? getBoard(s.board) : undefined);
  const i = steps.findIndex((x) => x.id === s.step);
  if (i <= 0) return null;
  const prev = steps[i - 1].id;
  return prev === 'verhalten' && skipsVerhalten(s) ? steps[i - 2].id : prev;
}

/** Moves to `step` when it may open; otherwise stays. */
export function goTo(s: WizardState, step: WizardStep): WizardState {
  return canEnter(s, step) ? { ...s, step } : s;
}

/** The variants a board offers, in the order of VARIANTS. */
export function variantsFor(board: BoardInfo): { id: ButtonVariant; label: string; description: string }[] {
  return (Object.keys(VARIANTS) as ButtonVariant[]).filter((v) => board.variants.includes(v)).map((id) => ({ id, ...VARIANTS[id] }));
}

/* ------------------------------------------------------------ shutdown */

/** The answers to „Wie geht deine Box aus?“, in the order the page shows them. */
export const SHUTDOWN_CHOICES: readonly { id: ShutdownKind; label: string; description?: string }[] = [
  { id: 'switch', label: 'Mit Schalter oder Powerbank', description: 'Die Box hat keine Platine, die sie selbst ausschaltet.' },
  { id: 'pololu', label: 'Mit Pololu-Schalter', description: 'Kleine Zusatzplatine mit Taster. Sie schaltet die Box nach dem Ausschalt-Timer selbst aus.' },
  {
    id: 'traeger',
    label: 'Mit CubieKid- oder Trägerplatine',
    description: 'Wähle das nur, wenn deine Box eine CubieKid-Platine oder die Trägerplatine von Thomas Lehnert hat. Diese schalten die Box selbst ein und aus.',
  },
  { id: 'unknown', label: 'Weiß ich nicht', description: 'Im Zweifel weiß es, wer die Box gebaut hat.' },
];

export interface ShutdownAdvice {
  tone: 'warning' | 'neutral';
  text: string;
}

/**
 * What the page says under the answer: a warning when the ready-made build
 * would switch the box off the wrong way, a note on what to do when the
 * answer is „Weiß ich nicht“. USB boards can put the saved firmware back;
 * ESP32 boxes are updated over Wi-Fi, where the app keeps no backup.
 */
export function shutdownAdvice(board: BoardInfo, shutdown: ShutdownKind | undefined): ShutdownAdvice | undefined {
  if (!shutdown || !askShutdown(board)) return undefined;
  const esp32 = board.method === 'esp32';
  if (shutdown === 'traeger' && isBaukastenBoard(board.id)) {
    return {
      tone: 'neutral',
      text: 'Für deine Box nehm ich eine eigene Fassung der fertigen Firmware, bei der die Abschaltung andersherum arbeitet. Sie ist in der App dabei.',
    };
  }
  if (!readyMadeShutdownFits(board, shutdown)) {
    return {
      tone: 'warning',
      text: `Für deine Box gibt es keine fertige Firmware. Die Abschaltung würde verkehrt herum arbeiten: Meist geht die Box dann gleich nach dem Einschalten wieder aus. ${
        esp32
          ? 'Frage, wer die Box gebaut hat, nach der passenden Datei. Die Schritte unten zeigen, wie du sie aufspielst.'
          : 'Frage, wer die Box gebaut hat, nach der passenden Datei und nimm „Eigene Datei“.'
      }`,
    };
  }
  if (shutdown !== 'unknown') return undefined;
  return {
    tone: 'neutral',
    text: esp32
      ? 'Geht die Box nach dem Update gleich wieder aus, passt die Abschaltung nicht. Dann brauchst du eine passende Datei von dem, der die Box gebaut hat.'
      : 'Lasse „Alte Firmware vorher sichern“ an. Geht die Box nach dem Aufspielen ohne USB-Kabel gleich wieder aus, passt die Abschaltung nicht. Dann spielst du die Sicherung zurück.',
  };
}

/* ------------------------------------------------------------ firmware */

/** Room the firmware takes on the board: from the board's firmware start to the image's last byte (as the flasher counts). */
export function firmwareSize(image: HexImage, board: BoardInfo): number {
  const appStart = board.method === 'stk500' ? board.flash.appStart : 0;
  return Math.max(0, image.startAddress + image.data.length - appStart);
}

/** Says when a firmware is clearly too big for the board, before anything is sent. */
export function sizeProblem(image: HexImage, board: BoardInfo): FlashProblem | null {
  if (board.method !== 'stk500') return null;
  const size = firmwareSize(image, board);
  const max = largestFirmware(board.flash);
  if (size <= max) return null;
  return {
    code: 'too-large',
    title: 'Die Firmware ist zu groß für diese Platine',
    explanation: `Die Firmware braucht ${formatBytes(size)}, auf „${board.shortName}“ ist aber nur Platz für ${formatBytes(max)}. Wahrscheinlich ist die Datei für eine andere Platine gebaut.`,
    steps: ['Prüfe, ob die richtige Platine ausgewählt ist.', 'Nimm die fertige Firmware für diese Platine.'],
    technical: `image ends at 0x${(image.startAddress + image.data.length).toString(16)}, ${size} bytes, limit ${max}`,
  };
}

/**
 * Downloads the ready-made TonUINO-TNG build from tonuino.github.io and parses
 * it (boards without the Baukasten: AiO+). The server always has the newest
 * main; a build that is not the checked state comes back marked `unchecked`.
 * Rejects with FirmwareDownloadError, whose `problem` is ready for the page.
 */
export async function loadReadyMade(fetchFn: FetchFn, board: BoardInfo, variant: ButtonVariant, signal?: AbortSignal): Promise<FirmwareChoice> {
  const file = await downloadFirmwareFile(fetchFn, board, variant, signal);
  let image: HexImage;
  try {
    image = parseIntelHex(file.bytes);
  } catch (e) {
    const problem = describeFlashError(e, { board });
    throw new FirmwareDownloadError({
      ...problem,
      explanation: `Die heruntergeladene Datei ist beschädigt. ${problem.explanation}`,
      steps: ['Versuche den Download noch einmal.', `Klappt es wieder nicht, lade die Datei selbst von ${file.url} herunter und wähle sie als eigene Datei aus.`],
    });
  }
  const choice: FirmwareChoice = { kind: 'download', board: board.id, variant, fileName: file.fileName, url: file.url, fileBytes: file.bytes.length, image };
  const version = firmwareVersion(image);
  if (!isChecked(version)) choice.unchecked = version ? { ...(version.version ? { version: version.version } : {}), ...(version.date ? { date: version.date } : {}) } : {};
  return choice;
}

/**
 * What the page says about a download TonUINO Studio has not checked: which
 * state it is and what the user should know before saying yes.
 */
export function uncheckedText(unchecked: { version?: string; date?: string }): { title: string; text: string; confirm: string } {
  const named = unchecked.version ? `TonUINO TNG ${unchecked.version}${unchecked.date ? ` vom ${unchecked.date.split('-').reverse().join('.')}` : ''}` : 'eine Firmware ohne Versionsangabe';
  const layout = knownStand(unchecked)?.settingsLayout;
  return {
    title: 'Diese Firmware hat TonUINO Studio noch nicht geprüft',
    text:
      `Auf der Seite von TonUINO TNG liegt immer der neueste Entwicklungsstand, gerade ${named}. Geprüft ist bei TonUINO Studio ${standTitle(CHECKED_TNG)}. ` +
      'Meist klappt auch der neue Stand, aber er kann sich anders verhalten, als die App erwartet.' +
      (layout && layout > CHECKED_TNG.settingsLayout ? ' Er speichert die Einstellungen in neuer Form. Prüfe danach unter „Box einstellen“, ob alles stimmt.' : '') +
      ' Die alte Firmware sichere ich vorher, du kannst sie zurückspielen.',
    confirm: 'Ich möchte diese Firmware trotzdem aufspielen',
  };
}

/** A .hex file is text; a few hundred KB at most. Anything far bigger is not a firmware file. */
const MAX_HEX_FILE = 4 * 1024 * 1024;

/** Reads a .hex file the user picked. Returns the choice, or a problem that says what is wrong with the file. */
export async function readOwnFirmware(source: ByteSource, board: BoardInfo): Promise<{ firmware: FirmwareChoice } | { problem: FlashProblem }> {
  if (source.size > MAX_HEX_FILE) {
    return {
      problem: {
        code: 'bad-image',
        title: 'Die Firmware-Datei passt nicht',
        explanation: `Die Datei ist mit ${formatBytes(source.size)} viel zu groß für eine Firmware-Datei. Wähle die Datei mit der Endung .hex.`,
        steps: ['Wähle die Firmware-Datei (.hex) für deine Platine.'],
        technical: `${source.name}: ${source.size} bytes`,
      },
    };
  }
  let bytes: Uint8Array;
  try {
    bytes = await source.read(0, source.size);
  } catch (e) {
    return {
      problem: {
        code: 'bad-image',
        title: 'Die Datei ließ sich nicht lesen',
        explanation: 'Die Datei konnte nicht geöffnet werden. Vielleicht wurde sie verschoben oder gelöscht.',
        steps: ['Wähle die Datei noch einmal aus.'],
        technical: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
      },
    };
  }
  let image: HexImage;
  try {
    image = parseIntelHex(bytes);
  } catch (e) {
    const problem = describeFlashError(e, { board });
    const isBin = /\.bin$/i.test(source.name);
    // A file named .hex that holds no HEX at all: „Wähle eine Datei mit der Endung .hex“ sent one looking in the wrong place (Prüfrunde 1, bastler 4).
    const brokenHex = e instanceof HexError && e.reason === 'not-hex' && !e.message.includes('Webseite') && /\.hex$/i.test(source.name);
    return {
      problem: {
        ...problem,
        explanation: isBin
          ? `„${source.name}“ ist eine .bin-Datei. Für „${board.shortName}“ brauchst du die Firmware als .hex-Datei.`
          : brokenHex
            ? `„${source.name}“ ist keine gültige Firmware im HEX-Format. Ist die Datei vollständig heruntergeladen?`
            : `Mit „${source.name}“ stimmt etwas nicht. ${problem.explanation}`,
        steps: ['Lade die Firmware-Datei neu herunter.', 'Oder nimm die fertige Firmware von TonUINO TNG.'],
      },
    };
  }
  const tooBig = sizeProblem(image, board);
  if (tooBig) return { problem: tooBig };
  return { firmware: { kind: 'file', board: board.id, fileName: source.name, fileBytes: source.size, image } };
}

/** One line about the chosen firmware, e.g. "TonUINO_Classic_3.hex · 22 KB". */
export function firmwareLabel(firmware: FirmwareChoice): string {
  return `${firmware.fileName} · ${formatBytes(firmware.image.byteCount)}`;
}

/** The saved firmware as a choice for "Alte Firmware wieder aufspielen". */
export function backupChoice(backup: FirmwareBackup, board: BoardId, fileName: string): FirmwareChoice {
  return {
    kind: 'backup',
    board,
    fileName,
    fileBytes: backup.data.length,
    image: { data: backup.data, startAddress: backup.startAddress, byteCount: backup.data.length },
  };
}

/** "TonUINO-Sicherung-AiO+-2026-10-05-1540.hex" */
export function backupFileName(board: BoardInfo, at: number): string {
  const d = new Date(at);
  const two = (n: number) => String(n).padStart(2, '0');
  const name = board.shortName.replace(/[^\w+-]+/g, '-');
  return `TonUINO-Sicherung-${name}-${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}.hex`;
}

/* ------------------------------------------------------------ versions */

export interface FirmwareVersion {
  family: FirmwareFamily;
  /** "3.3.3", or "2.1" */
  version?: string;
  /** Build date as ISO date, "2026-09-17". */
  date?: string;
}

/**
 * The version a firmware announces at its start, read from its text: TNG
 * keeps "V3.3.3 17.09.26" in flash, TonUINO 2.1 its banner "TonUINO
 * Version 2.1". Undefined for builds that carry neither.
 */
export function firmwareVersion(image: { data: Uint8Array }): FirmwareVersion | undefined {
  let text = '';
  for (let i = 0; i < image.data.length; i += 8192) text += String.fromCharCode(...image.data.subarray(i, i + 8192));
  const tng = /(?:^|[^\w.])V(\d+\.\d+\.\d+) (\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})(?![\w.])/.exec(text);
  if (tng) {
    const year = tng[4].length === 2 ? `20${tng[4]}` : tng[4];
    return { family: 'tng', version: tng[1], date: `${year}-${tng[3].padStart(2, '0')}-${tng[2].padStart(2, '0')}` };
  }
  const banner = /TonUINO Version (\d+)\.(\w+)/.exec(text);
  if (!banner) return undefined;
  return Number(banner[1]) >= 3 ? { family: 'tng' } : { family: 'classic21', version: `${banner[1]}.${banner[2]}` };
}

/** "TonUINO TNG 3.3.3 vom 17.09.2026", "TonUINO 2.1" */
export function versionText(v: FirmwareVersion): string {
  if (v.family === 'classic21') return `TonUINO ${v.version ?? '2.1'}`;
  const date = v.date ? ` vom ${v.date.split('-').reverse().join('.')}` : '';
  return `TonUINO TNG${v.version ? ` ${v.version}` : ''}${date}${tngStandOf(v)?.preview ? ' (Testversion)' : ''}`;
}

function compareVersions(a: FirmwareVersion, b: FirmwareVersion): number | undefined {
  if (a.family !== b.family) return a.family === 'tng' ? 1 : -1;
  if (!a.version || !b.version) return undefined;
  const pa = a.version.split('.').map(Number);
  const pb = b.version.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return Math.sign(d);
  }
  if (a.date && b.date && a.date !== b.date) return a.date > b.date ? 1 : -1;
  return 0;
}

/** The version on the box, from its log (Box-Logbuch or "Box erkennen"). */
export function boxVersion(info: BoxInfo | undefined): FirmwareVersion | undefined {
  if (!info?.firmware) return undefined;
  if (info.firmware === 'classic21') return { family: 'classic21', version: '2.1' };
  const v: FirmwareVersion = { family: 'tng' };
  if (info.version) v.version = info.version;
  if (info.versionDate) v.date = info.versionDate;
  return v;
}

/** What the firmware step says about versions: which one comes, which one is there, and whether that is a step back. */
export function versionFacts(file: FirmwareVersion | undefined, box: FirmwareVersion | undefined): { facts: Fact[]; note?: string } {
  const facts: Fact[] = [];
  if (file) facts.push({ label: 'Diese Firmware', value: versionText(file) });
  if (box) facts.push({ label: 'Jetzt auf der Box', value: versionText(box) });
  const order = file && box ? compareVersions(file, box) : undefined;
  if (order === 0) return { facts, note: 'Diese Version ist schon auf der Box. Aufspielen schadet nicht, ändert aber nichts.' };
  // Back from a test build to the release before it is the way out the Logbuch suggests (TNG PR 352).
  if (order === -1 && box && tngStandOf(box)?.preview) return { facts, note: 'Auf der Box läuft eine Testversion. Diese hier ist älter, aber erprobt.' };
  if (order === -1) return { facts, note: 'Diese Version ist älter als die auf der Box.' };
  return { facts };
}

/**
 * What stays when new firmware comes: cards always (also from 2.1 to TNG),
 * settings too, since the bootloader writes only the program memory.
 */
export function keepsText(from?: FirmwareFamily): string {
  const base = 'Deine Karten funktionieren weiter, und die Einstellungen aus dem Admin-Menü bleiben erhalten. Die SD-Karte bleibt, wie sie ist.';
  return from === 'classic21' ? `${base} Kommt die Box von TonUINO 2.1, prüfe danach trotzdem die Einstellungen im Admin-Menü.` : base;
}

/** Factory reset of TNG boxes, for the rare box that misbehaves after an update. It also forgets where audiobooks stopped. */
export const RESET_GUIDE =
  'Halte beim Einschalten Play/Pause, Vor und Zurück gleichzeitig gedrückt, oder wähle im Admin-Menü „alle Einstellungen löschen“. Danach stellst du Lautstärke und Co. unter „Box einstellen“ neu ein, und Hörbücher fangen wieder vorn an. Karten und SD-Karte bleiben.';

/** The Werkstatt tool that walks through the admin menu. */
export const SETTINGS_LINK = { label: 'Box einstellen', href: '#/werkstatt/einstellen' } as const;

/* --------------------------------------------------------- recognition */

/** What a box's start tells the wizard. */
export interface BoxGuess {
  board?: BoardId;
  /** Only when the start decides it: "5" can also be "5 Tasten mit allen Extras". */
  variant?: ButtonVariant;
  /** Buttons as the box reports them. */
  buttons?: '3' | '5' | '3x3';
  version?: FirmwareVersion;
}

export function guessFromInfo(info: BoxInfo): BoxGuess {
  const guess: BoxGuess = {};
  if (info.board) guess.board = info.board;
  if (info.buttons) {
    guess.buttons = info.buttons;
    const extras = info.board ? getBoard(info.board).variants.includes('5f') : true;
    if (info.buttons !== '5' || !extras) guess.variant = info.buttons;
  }
  const version = boxVersion(info);
  if (version) guess.version = version;
  return guess;
}

/** "AiO+ mit 5 Tasten, TonUINO TNG 3.3.3 vom 17.09.2026" */
export function guessText(guess: BoxGuess): string {
  const parts: string[] = [];
  if (guess.board) parts.push(`${getBoard(guess.board).shortName}${guess.buttons ? ` mit ${VARIANTS[guess.buttons].label}` : ''}`);
  if (guess.version) parts.push(versionText(guess.version));
  return parts.join(', ');
}

/** Takes over what the box told; a choice the box cannot make (5 or 5 with extras) stays open. */
export function applyGuess(s: WizardState, guess: BoxGuess): WizardState {
  if (!guess.board) return s;
  let next = chooseBoard(s, guess.board);
  if (guess.variant && getBoard(guess.board).variants.includes(guess.variant)) next = chooseVariant(next, guess.variant);
  return next;
}

/** Help for the button step: how to tell "5 Tasten" from "5 Tasten mit allen Extras". */
export function variantAdvice(board: BoardInfo, reported?: '3' | '5' | '3x3'): string | undefined {
  if (!board.variants.includes('5f')) return undefined;
  const lead = reported === '5' ? 'Die Box meldet 5 Tasten, aber nicht, ob die Extras dabei sind. ' : '';
  return `${lead}Hat deine Box einen LED-Ring, oder spielst du Quiz und Memory? Dann nimm „${VARIANTS['5f'].label}“. Sonst, und im Zweifel, nimm „${VARIANTS['5'].label}“.`;
}

/* -------------------------------------------------------------- result */

export interface Fact {
  label: string;
  value: string;
}

/** What the success page lists. */
export function successFacts(result: FlashSuccess, board: BoardInfo, firmware: FirmwareChoice): Fact[] {
  const facts: Fact[] = [{ label: 'Platine', value: board.name }];
  const version = firmwareVersion(firmware.image);
  if (firmware.kind === 'download') {
    facts.push({ label: 'Tasten', value: VARIANTS[firmware.variant].label });
    facts.push({ label: 'Firmware', value: `${version ? versionText(version) : 'TonUINO TNG'}, ${firmware.fileName}` });
    if (firmware.baukasten?.summary) facts.push({ label: 'Extras', value: firmware.baukasten.summary });
  } else if (firmware.kind === 'backup') {
    facts.push({ label: 'Firmware', value: `die alte Firmware aus der Sicherung${version ? ` (${versionText(version)})` : ''}` });
  } else {
    facts.push({ label: 'Firmware', value: `eigene Datei, ${firmware.fileName}${version ? ` (${versionText(version)})` : ''}` });
  }
  // The size of the firmware, as the earlier steps showed it (the flasher pads the last page).
  facts.push({ label: 'Aufgespielt', value: formatBytes(firmware.image.byteCount) });
  facts.push({ label: 'Geprüft', value: result.verified ? 'Ja, alles stimmt' : 'Nein, die Prüfung war aus' });
  facts.push({ label: 'Dauer', value: formatDuration(Math.max(1, Math.round(result.durationMs / 1000)), { long: true }) });
  return facts;
}

/** Connection details for the forum, e.g. "115200 Baud · Bootloader 8.0 · Signatur 1e 95 0f · 22528 Bytes geschrieben". */
export function successTechnical(result: FlashSuccess): string {
  const parts = [`${result.baud} Baud`];
  if (result.bootloaderVersion) parts.push(`Bootloader ${result.bootloaderVersion}`);
  parts.push(`Signatur ${result.signature.map((b) => b.toString(16).padStart(2, '0')).join(' ')}`);
  parts.push(`${result.bytesWritten} Bytes geschrieben`);
  return parts.join(' · ');
}

export type NextStepId = 'release' | 'power' | 'sounds' | 'profile' | 'logbook' | 'einstellen' | 'reset';

export interface NextStep {
  id: NextStepId;
  title: string;
  text: string;
  /** A second paragraph, shown under the text. */
  note?: string;
  /** A page of the app that helps with this step. */
  link?: { label: string; href: string };
}

/**
 * Power the box off and on once: the microcontroller restarts after the
 * upload, the MP3 player does not, and then reports errors that have nothing
 * to do with the SD card (681#202). After a ready-made TNG build it also says
 * what holding Play/Pause in the pause does now (TNG commands.cpp: pauseLong
 * in idle or pause is "shutdown"; without shutdown hardware tonuino.cpp ends
 * in a sleep only a power cycle wakes).
 */
function powerStep(firmware: FirmwareChoice, { shutdown, backup }: AfterUpload): NextStep {
  const step: NextStep = {
    id: 'power',
    title: 'Einmal ganz aus- und einschalten',
    text: 'Schalte die Box einmal ganz aus und wieder ein, mit ein paar Sekunden Pause dazwischen. Ziehe dafür auch das USB-Kabel zum Computer ab. So startet auch der MP3-Player neu. Sonst meldet er manchmal Fehler, die nichts mit der SD-Karte zu tun haben.',
  };
  if (firmware.kind !== 'download' || !shutdown) return step;
  if (shutdown === 'pololu' || shutdown === 'traeger') {
    step.note =
      'Ob sich die Box von selbst ausschaltet, siehst du erst ohne USB-Kabel am Computer, denn über das Kabel bekommt sie weiter Strom. Sie schaltet sich aus, wenn der Ausschalt-Timer im Admin-Menü abläuft oder wenn du in der Pause Play/Pause lang drückst.';
  } else if (shutdown === 'switch') {
    step.note =
      'Ein langer Druck auf Play/Pause in der Pause legt deine Box schlafen. Sie reagiert dann erst wieder, wenn du sie aus- und einschaltest. Das passiert auch, wenn der Ausschalt-Timer abläuft.';
  } else {
    // Only without the USB cable a wrong shutdown pin cuts the power (the cable keeps the box on).
    const wrong = backup
      ? 'Geht die Box ohne USB-Kabel gleich nach dem Einschalten wieder aus, passt die Abschaltung nicht. Stecke sie dann wieder an und klicke oben auf „Alte Firmware wieder aufspielen“.'
      : isBaukastenBoard(firmware.board)
        ? 'Geht die Box ohne USB-Kabel gleich nach dem Einschalten wieder aus, passt die Abschaltung nicht. Dann spiele die Firmware noch einmal auf und antworte auf „Wie geht deine Box aus?“ mit „Mit CubieKid- oder Trägerplatine“.'
        : 'Geht die Box ohne USB-Kabel gleich nach dem Einschalten wieder aus, passt die Abschaltung nicht. Dann brauchst du eine passende Datei von dem, der die Box gebaut hat. Du spielst sie über „Eigene Datei“ auf.';
    step.note = `${wrong} Bei TonUINO TNG schaltet ein langer Druck auf Play/Pause in der Pause die Box aus. Ohne Abschalt-Platine legt sie sich dann nur schlafen und reagiert erst wieder, wenn du sie einmal aus- und einschaltest. Das passiert auch, wenn der Ausschalt-Timer abläuft.`;
  }
  return step;
}

/** What the done page knows besides the upload itself. */
export interface AfterUpload {
  /** The answer how the box switches off, when it was asked. */
  shutdown?: ShutdownKind;
  /** The old firmware was saved and can be put back from the done page. */
  backup?: boolean;
  /** What was chosen under „Verhalten“ for the admin menu („Karte wegnehmen = Pause“): set at the box next. */
  einstellen?: string[];
}

/** What to do after a successful upload, most important first. */
export function nextSteps(board: BoardInfo, firmware: FirmwareChoice, profile: FirmwareProfile, after: AfterUpload = {}): NextStep[] {
  const steps: NextStep[] = [];
  if (board.method === 'stk500' && board.holdPlayPause) {
    steps.push({ id: 'release', title: 'Play/Pause loslassen', text: 'Du kannst die Taste jetzt loslassen. Die Box startet mit der neuen Firmware.' });
  }
  const logbook: NextStep = { id: 'logbook', title: 'Start der Box ansehen', text: 'Im Box-Logbuch siehst du, ob Kartenleser und MP3-Player antworten.' };
  // The old firmware is back: its announcements and settings fit as before.
  if (firmware.kind === 'backup') return [...steps, logbook];
  steps.push(powerStep(firmware, after));
  steps.push({
    id: 'sounds',
    title: 'Ansagen passend zur Firmware',
    text:
      firmware.kind === 'download'
        ? 'Neue Firmware braucht oft neue Ansagen. Spiele die aktuellen Ansagen auf die SD-Karte, sonst sagt die Box Falsches an oder schweigt.'
        : 'Passen die Ansagen auf der SD-Karte nicht zu dieser Firmware, sagt die Box Falsches an oder schweigt.',
  });
  if (firmware.kind === 'download' && profile === 'classic21') {
    steps.push({
      id: 'profile',
      title: 'Auf TonUINO TNG umstellen',
      text: 'In TonUINO Studio ist noch die alte Firmware 2.1 eingestellt. Stelle auf TNG um, damit neue Karten und Ansagen zur Box passen.',
    });
  }
  // Chosen under „Verhalten“: the steps at the box come right after the upload, before anything else to check.
  if (after.einstellen?.length) {
    steps.push({
      id: 'einstellen',
      title: 'Jetzt an der Box einstellen',
      text: `Du hast unter „Verhalten“ gewählt: ${after.einstellen.join(', ')}. Die App zeigt dir Schritt für Schritt, welche Tasten du dafür drückst.`,
      link: { label: 'Jetzt an der Box einstellen', href: SETTINGS_LINK.href },
    });
  }
  steps.push(logbook);
  if (after.einstellen?.length) {
    steps.push({ id: 'reset', title: 'Nur wenn die Box spinnt: Einstellungen zurücksetzen', text: RESET_GUIDE, link: SETTINGS_LINK });
    return steps;
  }
  // Both firmwares ship with the Ausschalt-Timer off: an AiO then runs until the battery is empty.
  // An update keeps the settings, so this is a check, not a "set it again".
  steps.push({
    id: 'einstellen',
    title: 'Box einstellen',
    text: 'Bei einer neuen Box ist der Ausschalt-Timer aus. Ob er bei deiner Box an ist, siehst du im Box-Logbuch. Unter „Box einstellen“ stellst du ihn ein und begrenzt auf Wunsch die Lautstärke.',
    link: SETTINGS_LINK,
  });
  steps.push({ id: 'reset', title: 'Nur wenn die Box spinnt: Einstellungen zurücksetzen', text: RESET_GUIDE, link: SETTINGS_LINK });
  return steps;
}

/**
 * Hints shown before the upload. The Play/Pause hint of AiO boards gets its
 * own block on the page, driver hints do not apply to Linux, and the CH340
 * driver not to a box whose port has another USB chip (FTDI, CP210x).
 */
export function flashHints(board: BoardInfo, os: HostOs, port?: SerialPortInfo): string[] {
  if (board.method !== 'stk500') return [];
  const ch340 = usesCh340(port, board);
  return board.hints.filter(
    (h) => !(board.holdPlayPause && h.includes('Play/Pause')) && !(os === 'linux' && h.includes('Treiber')) && !(!ch340 && h.includes('CH340')),
  );
}

/**
 * After a failure: whether to remind of the Play/Pause key. Only when the
 * next button talks to the box again. A firmware that does not fit, or
 * another board, sends the user back to an earlier step first.
 */
export function holdAgainFits(board: BoardInfo, problem: FlashProblem): boolean {
  if (board.method !== 'stk500' || !board.holdPlayPause) return false;
  if (problem.action?.kind === 'flash-anyway') return true;
  return !['wrong-board', 'too-large', 'bad-image', 'unsupported'].includes(problem.code);
}

/**
 * After a failure: whether the box may have lost its old firmware. These
 * stops come before the first page is written (the check of the extras, a
 * firmware that does not fit, another board), so the box is as it was and
 * putting the saved firmware back would only rewrite what is there.
 */
export function boxMayBeChanged(problem: FlashProblem): boolean {
  return !['extras-lost', 'wrong-board', 'too-large', 'bad-image', 'unsupported'].includes(problem.code);
}

/* ------------------------------------------------------------ progress */

/** The parts of an upload the page shows; syncing counts as connecting, saving the old firmware only when asked for. */
export function flashPhases(backup: boolean): { id: string; label: string }[] {
  return [
    { id: 'connect', label: 'Verbinden' },
    ...(backup ? [{ id: 'backup', label: 'Sichern' }] : []),
    { id: 'write', label: 'Schreiben' },
    { id: 'verify', label: 'Prüfen' },
  ];
}

/** Index into flashPhases(backup); its length when all is done. */
export function phaseIndex(step: FlashStatus['step'], backup = false): number {
  const b = backup ? 1 : 0;
  switch (step) {
    case 'connect':
    case 'sync':
      return 0;
    case 'backup':
      return 1;
    case 'write':
      return 1 + b;
    case 'verify':
      return 2 + b;
    case 'done':
      return 3 + b;
  }
}

/** Whole percent for the big number; 100 only when done. */
export function percent(status: FlashStatus): number {
  const p = Math.round(Math.min(1, Math.max(0, status.progress)) * 100);
  return status.step === 'done' ? 100 : Math.min(p, 99);
}

/* ---------------------------------------------------------- ESP32 boxes */

export interface GuideStep {
  text: string;
  /** A page to open, e.g. the box's update page. */
  link?: { label: string; url: string };
  /** A command to paste into a terminal. */
  command?: string;
}

export interface Esp32Guide {
  /** Numbered steps of the update over Wi-Fi. */
  steps: GuideStep[];
  /** Help for special cases. */
  notes: GuideStep[];
}

/**
 * The Wi-Fi update of an ESP32 box with the real file name (the download is
 * saved as e.g. "TonUINO_Esp32_5.bin", not "firmware.bin") and the box's
 * address when one was saved for writing cards over Wi-Fi.
 */
/**
 * The steps for an update over Wi-Fi. `fileName` is the ready-made build;
 * null when it does not fit the box and the user needs a file from whoever
 * built it.
 */
export function esp32Guide(board: Esp32Board, fileName: string | null, boxAddress?: string | null): Esp32Guide {
  const u = board.update;
  const apPage = `${u.apUrl}${u.otaPath}`;
  const steps: GuideStep[] = [
    { text: fileName ? `Lade die Firmware herunter. Die Datei heißt „${fileName}“.` : 'Hole dir die passende Firmware-Datei von dem, der die Box gebaut hat.' },
  ];
  if (boxAddress) {
    const page = `${boxAddress}${u.otaPath}`;
    steps.push({ text: `Öffne die Update-Seite deiner Box: ${page}`, link: { label: 'Update-Seite öffnen', url: page } });
    steps.push({ text: `Geht die Seite nicht auf, ist die Box gerade nicht in deinem WLAN. Dann öffnet sie ihr eigenes WLAN „${u.apSsid}“. Verbinde dich damit und öffne ${apPage}.` });
  } else {
    steps.push({ text: `Öffne die Update-Seite der Box. Ist die Box in deinem WLAN, findest du ihre Adresse in deinem Router und hängst ${u.otaPath} an.` });
    steps.push({ text: `Ist sie nicht in deinem WLAN, öffnet sie ihr eigenes WLAN „${u.apSsid}“. Verbinde dich damit und öffne ${apPage}.` });
  }
  steps.push({
    text:
      u.otaUser === u.otaPassword
        ? `Melde dich an. Benutzername und Passwort sind beide „${u.otaUser}“.`
        : `Melde dich an: Benutzername „${u.otaUser}“, Passwort „${u.otaPassword}“.`,
  });
  steps.push({
    text: fileName
      ? `Wähle die Datei „${fileName}“ aus und starte das Update. Die Box startet danach von selbst neu.`
      : 'Wähle die Datei aus, die du bekommen hast, und starte das Update. Die Box startet danach von selbst neu.',
  });

  const notes: GuideStep[] = [
    // The box serves its pages over plain HTTP (TNG webservice.cpp).
    { text: 'Dein Browser zeigt bei der Webseite der Box „Nicht sicher“, weil die Box kein HTTPS kann. Das ist hier in Ordnung.' },
    { text: `Passwort für das Box-WLAN vergessen? Halte beim Einschalten die Taste „Vor“ gedrückt. Dann öffnet die Box ihr WLAN „${u.apSsid}“ ohne Passwort.` },
  ];
  if (u.dfu) {
    const hex = (n: number) => n.toString(16).padStart(4, '0');
    const file = fileName ?? 'deine-datei.bin';
    notes.push({
      text: `Ohne WLAN geht es per USB-Kabel: ${u.dfu.hint} Spiele die Datei dann mit dem Programm dfu-util auf${fileName ? '' : `. Setze statt „${file}“ den Namen deiner Datei ein`}:`,
      command: `dfu-util --device ${hex(u.dfu.vendorId)}:${hex(u.dfu.productId)} -D ${file}`,
    });
  } else {
    notes.push({ text: 'Ist noch keine TonUINO-Firmware auf der Box, spielst du sie einmalig mit PlatformIO oder der Arduino IDE auf. Danach geht jedes Update über WLAN.' });
  }
  return { steps, notes };
}
