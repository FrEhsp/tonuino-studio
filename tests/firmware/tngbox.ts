/**
 * A pretend TonUINO TNG box behind a fake serial port, for writing cards
 * over USB (TODO #93). It answers WRITECARD the way TNG branch issue_345
 * does with -D SerialWriteCard (serial_input.cpp:16-104, state_machine.cpp:
 * 483-528 and 690-740, commands.cpp:66-67), checked against the real build
 * in simavr (scripts/firmware/simbox.c "serial", docs/FIRMWARE-BAUKASTEN.md):
 * - bad parameters: "WRITECARD: ERR" at once, in any state;
 * - CANCEL without a write running: "WRITECARD: ERR" (only in idle and pause);
 * - a valid command in idle or pause without a card: "enter WriteC", the
 *   „Karte auflegen“ announcement, then it waits for a card without limit;
 * - card laid on: "Writing: …" (Classic; the AiO keeps its card log quiet)
 *   or "Auth  failed"/"MIFARE_Write  failed", then "WRITECARD: OK" only once
 *   the card is off again, also after a failure;
 * - while playing, or with a card on the reader: no answer at all.
 * The parser here is written out on its own, not taken from writecard.ts.
 */
import type { SerialAccess, SerialConnection, SerialPortInfo } from '../../src/platform/types';
import { CH340_PORT, FakeConnection } from '../workshop/fakes';

export interface TngBoxOptions {
  /** Built with SerialWriteCard (default true). */
  writeCard?: boolean;
  /** AiO: card_log at warning, so no "Writing:" and no "CardData:" lines. */
  quietCardLog?: boolean;
  /** Prints its start when the port opens (Classic and AiO reset on DTR; default true). */
  bootOnOpen?: boolean;
}

type State = 'Idle' | 'Play' | 'Pause' | 'WriteC';

const hex = (bytes: number[]) => bytes.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ') + ' ';

export class TngBox implements SerialAccess {
  readonly supported = true;
  state: State = 'Idle';
  /** What lies on the reader. */
  cardOn = false;
  /** The next write fails like this. */
  failNext: 'auth' | 'write' | undefined;
  /** The 9 bytes on the card on the reader. */
  card: number[] = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  /** Every line the box got. */
  readonly received: string[] = [];
  conn: BoxConnection | undefined;
  private pending: number[] | null = null;
  private written = false;
  private readonly opts: Required<TngBoxOptions>;

  constructor(opts: TngBoxOptions = {}) {
    this.opts = { writeCard: true, quietCardLog: false, bootOnOpen: true, ...opts };
  }

  async list(): Promise<SerialPortInfo[]> {
    return [CH340_PORT];
  }

  async open(port: SerialPortInfo, baudRate: number): Promise<SerialConnection> {
    const conn = new BoxConnection(port, baudRate, this);
    this.conn = conn;
    if (this.opts.bootOnOpen) {
      this.state = 'Idle';
      setTimeout(() => this.say('TonUINO Version 3.x - refactored by Boerge1', this.opts.writeCard ? 'V3.3.3 08.10.26' : 'V3.3.3 17.09.26', 'C 3', 'Ver:2', 'MFRC522:146', 'enter Idle', 'play mp3 262'), 5);
    }
    return conn;
  }

  say(...lines: string[]): void {
    this.conn?.send(lines.map((l) => `${l}\r\n`).join(''));
  }

  /** A line from the computer. */
  input(line: string): void {
    this.received.push(line);
    if (!this.opts.writeCard || !line.startsWith('WRITECARD ')) return;
    const arg = line.slice('WRITECARD '.length);
    if (arg === 'CANCEL') {
      if (this.state === 'WriteC' && this.pending) {
        this.say('btn/cmd: w_c_c_ser/w_c_c_ser', 'btn/cmd: pauseLong/adm_end', 'SM abort', 'WRITECARD: ERR');
        this.pending = null;
        this.state = 'Idle';
      } else if (this.state === 'Idle' || this.state === 'Pause') {
        this.say('btn/cmd: w_c_c_ser/w_c_c_ser', 'WRITECARD: ERR');
      }
      return;
    }
    const nums = arg.split(',').map((n) => Number.parseInt(n, 10) || 0);
    const mode = nums[0] & 0xff;
    let folder = 0;
    let special = 0;
    let special2 = 0;
    if (mode === 11 || mode === 14) {
      // no parameters
    } else if (mode === 4 || mode === 10) {
      [folder, special] = [nums[1] ?? 0, nums[2] ?? 0];
    } else if ([7, 8, 9, 12, 16].includes(mode)) {
      [folder, special, special2] = [nums[1] ?? 0, nums[2] ?? 0, nums[3] ?? 0];
    } else {
      folder = nums[1] ?? 0;
    }
    folder &= 0xff;
    let ok = mode !== 0;
    if (mode === 4 && special < 1) ok = false;
    if ([7, 8, 9, 16].includes(mode) && (special < 1 || special > special2)) ok = false;
    if (mode === 10 && special >= 30) ok = false;
    if (mode === 12 && (![0, 2, 4].includes(special) || ![0, 1].includes(special2))) ok = false;
    if (mode === 11 || mode === 14) folder = 0xff;
    if (!ok) {
      this.say('WRITECARD: ERR');
      return;
    }
    // Only idle and pause take the command; with a card on the reader it is dropped.
    if ((this.state !== 'Idle' && this.state !== 'Pause') || this.cardOn) return;
    this.say('btn/cmd: w_c_ser/w_c_ser', 'enter WriteC', 'play mp3 800');
    this.state = 'WriteC';
    this.pending = [0x13, 0x37, 0xb3, 0x47, 0x02, folder, mode, special & 0xff, special2 & 0xff];
    this.written = false;
  }

  /** A card laid on the reader. */
  layCard(): void {
    this.cardOn = true;
    if (this.state === 'WriteC' && this.pending && !this.written) {
      this.written = true;
      const fail = this.failNext;
      this.failNext = undefined;
      if (fail === 'auth') this.say('Auth  failed: 3', 'play mp3 401');
      else if (fail === 'write') this.say('MIFARE_Write  failed: 3', 'play mp3 401');
      else {
        this.card = this.pending;
        this.say(...(this.opts.quietCardLog ? [] : [`Writing: ${hex(this.pending)}`]), 'play mp3 400');
      }
      return;
    }
    if (this.state === 'Idle' || this.state === 'Pause' || this.state === 'Play') {
      if (!this.opts.quietCardLog) this.say('Card Ins', `CardData: ${hex(this.card)}`);
      this.say('enter Play', `play ${this.card[5]}-1`);
      this.state = 'Play';
    }
  }

  removeCard(): void {
    this.cardOn = false;
    if (this.state === 'WriteC' && this.written) {
      this.say('WriteC -> finished', 'WRITECARD: OK');
      this.pending = null;
      this.state = 'Idle';
    }
  }

  pause(): void {
    if (this.state === 'Play') {
      this.state = 'Pause';
      this.say('enter Pause');
    }
  }

  /** Something plays, e.g. a card from before. */
  play(): void {
    this.state = 'Play';
    this.say('enter Play', 'play 3-1');
  }
}

class BoxConnection extends FakeConnection {
  private buffer = '';

  constructor(
    port: SerialPortInfo,
    baudRate: number,
    private readonly box: TngBox,
  ) {
    super(port, baudRate);
  }

  override async write(data?: Uint8Array): Promise<void> {
    await super.write();
    this.buffer += new TextDecoder().decode(data);
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).replace(/\r$/, '');
      this.buffer = this.buffer.slice(nl + 1);
      // The box answers a few ms later (simavr: about 45 ms for parseInt).
      setTimeout(() => this.box.input(line), 2);
    }
  }
}
