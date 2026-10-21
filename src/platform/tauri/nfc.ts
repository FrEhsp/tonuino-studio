/**
 * NfcAccess for PC/SC readers (ACR122U) through the nfc commands. The
 * backend reads and writes the 16 TonUINO bytes (MIFARE Classic block 4,
 * Ultralight/NTAG pages 8–11) and verifies every write by reading it back.
 */
import type { NfcAccess, NfcCardInfo, NfcCardType, NfcReadResult } from '../types';
import type { Bridge } from './bridge';
import { hintInfo, platformError, type HintInfo } from './errors';

interface CardDto {
  uid: string;
  cardType: NfcCardType;
  /** Hex bytes separated by spaces. */
  atr: string;
}

interface ReadDto extends CardDto {
  data: number[];
}

/** Longest wait the backend accepts (10 minutes). */
const MAX_WAIT_MS = 10 * 60_000;

export function toCardInfo(dto: CardDto): NfcCardInfo {
  const info: NfcCardInfo = { uid: dto.uid, type: dto.cardType };
  if (dto.atr) info.details = `ATR ${dto.atr}`;
  return info;
}

export class TauriNfc implements NfcAccess {
  readonly supported = true;

  constructor(private readonly bridge: Bridge) {}

  listReaders(): Promise<string[]> {
    return this.bridge.call<string[]>('nfc', 'nfc_list_readers');
  }

  async waitForCard(reader: string, timeoutMs: number): Promise<NfcCardInfo | null> {
    const timeout = Math.max(0, Math.min(MAX_WAIT_MS, Math.floor(timeoutMs)));
    const card = await this.bridge.call<CardDto | null>('nfc', 'nfc_wait_card', { reader, timeoutMs: timeout });
    return card ? toCardInfo(card) : null;
  }

  async read(reader: string): Promise<NfcReadResult> {
    const dto = await this.bridge.call<ReadDto>('nfc', 'nfc_read', { reader });
    return { ...toCardInfo(dto), data: Uint8Array.from(dto.data) };
  }

  async write(reader: string, data: Uint8Array): Promise<void> {
    if (data.length !== 16) {
      throw platformError('invalid-argument', 'nfc', `expected 16 bytes, got ${data.length}`);
    }
    await this.bridge.call<CardDto>('nfc', 'nfc_write', { reader, data: Array.from(data) });
  }

  /** Desktop extra: setup problems of the reader (Linux: pcscd, driver, pn533). */
  async diagnose(): Promise<HintInfo[]> {
    const hints = await this.bridge.call<{ id: string; detail?: string; command?: string }[]>('nfc', 'nfc_diagnose');
    return hints.map(hintInfo);
  }
}
