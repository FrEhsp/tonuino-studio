/**
 * The app's symbols under German names. Version 0.4 drew its own symbols
 * here, with a patch of colour behind each; 0.4.1 goes back to the plain
 * symbols of 0.3.1 (lucide), because a second colour next to lilac made
 * pages restless. The names stay so the pages that use them read the same.
 * The menu keeps its own button caps (caps.tsx).
 */
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  CardSim,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  CircleCheck,
  Compass,
  Copy,
  Download,
  Eject,
  Ellipsis,
  ExternalLink,
  FolderOpen,
  GripVertical,
  ImagePlus,
  LibraryBig,
  LifeBuoy,
  ListMusic,
  MessagesSquare,
  Mic,
  Nfc,
  Pause as LucidePause,
  Pencil,
  Play as LucidePlay,
  Plus as LucidePlus,
  Printer,
  RotateCcw,
  Scissors,
  Search,
  Settings,
  Square,
  StickyNote,
  Trash2,
  Wrench,
  X,
} from 'lucide-preact';
import type { LucideIcon, LucideProps } from 'lucide-preact';

export type Icon = LucideIcon;
/** What the button caps of the menu take (caps.tsx); `plain` is theirs. */
export type IconProps = LucideProps & { plain?: boolean };

/** Meine Box. */
export const Regal: Icon = LibraryBig;
/** Hinzufügen. */
export const PlusZettel: Icon = LucidePlus;
/** Sticker drucken. */
export const Stickerbogen: Icon = StickyNote;
/** Karten beschreiben. */
export const StiftKarte: Icon = Nfc;
/** Werkstatt. */
export const Werkzeug: Icon = Wrench;
/** Hilfe. */
export const Rettungsring: Icon = LifeBuoy;
/** Einstellungen. */
export const Zahnrad: Icon = Settings;
/** Suchen. */
export const Lupe: Icon = Search;
/** The SD card. */
export const SdKarte: Icon = CardSim;
/** Auswerfen. */
export const SdAuswerfen: Icon = Eject;
/** Zurück. */
export const Zurueck: Icon = ArrowLeft;
/** Löschen. */
export const Muelleimer: Icon = Trash2;
/** Abspielen. */
export const Play: Icon = LucidePlay;
/** Anhalten. */
export const Pause: Icon = LucidePause;
/** Drucken. */
export const Drucker: Icon = Printer;
/** Entdecken. */
export const Karte: Icon = Compass;
/** The TonUINO forum. */
export const Forum: Icon = MessagesSquare;
/** Schließen. */
export const Kreuz: Icon = X;
/** Umbenennen. */
export const Stift: Icon = Pencil;
/** Mehr. */
export const Mehr: Icon = Ellipsis;
/** A plain plus. */
export const Plus: Icon = LucidePlus;
/** Done or chosen. */
export const Haken: Icon = CircleCheck;
/** Something to look at. */
export const Hinweis: Icon = CircleAlert;
/** A folder, for "Ordner auswählen". */
export const Ordner: Icon = FolderOpen;
/** Selbst aufnehmen. */
export const Mikrofon: Icon = Mic;
/** A track list. */
export const Liste: Icon = ListMusic;
/** A picture: Cover ändern, Bilder hinzufügen. */
export const Bild: Icon = ImagePlus;
/** A grip to drag a row by. */
export const Griff: Icon = GripVertical;
/** Weiter. */
export const Weiter: Icon = ArrowRight;
/** Fold out. */
export const Winkel: Icon = ChevronDown;
/** A link that leaves the app. */
export const Raus: Icon = ExternalLink;
/** Speichern, Herunterladen. */
export const Speichern: Icon = Download;
/** Anhalten (a recording). */
export const Stopp: Icon = Square;
/** Nochmal, neu laden, rückgängig. */
export const Nochmal: Icon = RotateCcw;
/** Schneiden, teilen. */
export const Schere: Icon = Scissors;
/** Kopieren. */
export const Kopieren: Icon = Copy;
/** Nach oben. */
export const Hoch: Icon = ArrowUp;
/** Nach unten. */
export const Runter: Icon = ArrowDown;
/** Fold in. */
export const WinkelHoch: Icon = ChevronUp;
/** Back, as a straight arrow to the left (the pager of the sticker sheet). */
export const Links: Icon = ArrowLeft;
