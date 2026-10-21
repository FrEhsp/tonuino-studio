/**
 * "Box erkennen": opens the box's port, lets the box start and reads its
 * start until it names its board and buttons ("A+ 5"). Opening the port
 * restarts most boxes; a box that stays quiet gets one restart over DTR.
 * The port is closed again either way.
 */
import { BootLogParser, type BoxInfo } from '../../core/firmware/bootlog';
import type { SerialAccess, SerialPortInfo } from '../../platform/types';
import { openMonitor, type MonitorOptions } from './monitor';

export interface ProbeOptions {
  /** Longest wait for the board line (default 6 s). */
  timeoutMs?: number;
  /** Silence after which the box is restarted once (default 1.5 s). */
  quietMs?: number;
  signal?: AbortSignal;
  monitor?: MonitorOptions;
}

export interface ProbeResult {
  info: BoxInfo;
  /** Something came over the cable, even if it named no board (e.g. another firmware, wrong speed). */
  heard: boolean;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Rejects only when the port does not open (with the platform's error). */
export async function probeBox(serial: SerialAccess, port: SerialPortInfo, opts: ProbeOptions = {}): Promise<ProbeResult> {
  const timeoutMs = opts.timeoutMs ?? 6000;
  const quietMs = opts.quietMs ?? 1500;
  const parser = new BootLogParser({ infoEvents: false });
  let heard = false;
  let named = false;
  let ended = false;
  const monitor = await openMonitor(
    serial,
    port,
    {
      onData: (bytes) => {
        heard = true;
        for (const e of parser.push(bytes)) if (e.type === 'line' && e.record?.kind === 'hardware') named = true;
      },
      onEnd: () => {
        ended = true;
      },
    },
    opts.monitor,
  );
  const started = Date.now();
  let restarted = false;
  try {
    while (!named && !ended && !opts.signal?.aborted && Date.now() - started < timeoutMs) {
      if (!heard && !restarted && Date.now() - started >= quietMs) {
        restarted = true;
        await monitor.restartBox().catch(() => undefined);
      }
      await sleep(20);
    }
  } finally {
    await monitor.stop();
  }
  parser.flush();
  return { info: parser.info, heard };
}
