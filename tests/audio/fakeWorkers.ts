/** Fake Web Workers for Node: the real worker handlers behind a MessageChannel. */
import type { WorkerLike } from '../../src/core/audio/browserBackend';
import type { DecodeEnv } from '../../src/core/audio/decode';
import { createAnalysisWorkerHandler, type AnalysisRequest } from '../../src/core/audio/workerProtocol';

export interface FakeWorker extends WorkerLike {
  terminated: boolean;
}

/**
 * Stands in for analyze.worker.ts: the real worker handler, run in this
 * thread behind a MessageChannel (structured cloning and transfers included).
 */
export function workers(env: DecodeEnv = { webCodecs: null }, opts: { crash?: boolean } = {}) {
  const created: FakeWorker[] = [];
  let active = 0;
  let maxActive = 0;
  const create = (): WorkerLike => {
    const channel = new MessageChannel();
    const handle = createAnalysisWorkerHandler((msg, transfer) => channel.port2.postMessage(msg, transfer ?? []), env);
    channel.port2.onmessage = (e: MessageEvent<AnalysisRequest>) => handle(e.data);
    const errorListeners: ((e: Event) => void)[] = [];
    active++;
    maxActive = Math.max(maxActive, active);
    const w = {
      terminated: false,
      postMessage(m: unknown, t: Transferable[]) {
        if (opts.crash) setTimeout(() => errorListeners.forEach((l) => l(new Event('error'))), 1);
        else channel.port1.postMessage(m, t);
      },
      addEventListener(type: string, l: (e: MessageEvent) => void) {
        if (type === 'error') errorListeners.push(l as unknown as (e: Event) => void);
        else {
          channel.port1.addEventListener('message', l);
          channel.port1.start();
        }
      },
      terminate() {
        if (w.terminated) return;
        w.terminated = true;
        active--;
        channel.port1.close();
      },
    };
    created.push(w as FakeWorker);
    return w as FakeWorker;
  };
  return {
    create,
    created,
    get maxActive() {
      return maxActive;
    },
  };
}
