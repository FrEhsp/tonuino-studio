/**
 * Messages between the page and the analysis worker, and the worker's side
 * of the conversation. Free of DOM-only APIs, so the tests run the handler
 * and the client in Node over a MessageChannel.
 *
 * Files reach the worker as a Blob (cheap to clone, the worker reads it in
 * slices) or, for sources without a Blob, through a MessagePort over which
 * the worker asks the page for byte ranges.
 */
import type { AudioAnalysis, ByteSource } from '../../platform/types';
import { analyzeAudio, openAudio, type DecodeEnv, type OpenedAudio } from './decode';
import { AudioError, deserializeError, serializeError, type SerializedError } from './errors';
import { fileSource, transferList } from './source';

export interface SourceRef {
  name: string;
  size: number;
  blob?: Blob;
  port?: MessagePort;
}

export type AnalysisRequest =
  | { type: 'analyze'; id: number; source: SourceRef; windowSec?: number }
  | { type: 'open'; id: number; source: SourceRef; targetSampleRate?: number }
  | { type: 'read'; id: number; maxFrames: number }
  | { type: 'close'; id: number };

export type AnalysisResponse =
  | { type: 'progress'; id: number; fraction: number }
  | { type: 'analysis'; id: number; analysis: AudioAnalysis }
  | { type: 'opened'; id: number; sampleRate: number; channels: number; durationSec: number; codec?: string }
  | { type: 'chunk'; id: number; channels: Float32Array[] | null; progress: number }
  | { type: 'closed'; id: number }
  | { type: 'error'; id: number; error: SerializedError };

/* ------------------------------------------------------------ byte ranges over a port */

interface RangeRequest {
  id: number;
  start: number;
  length: number;
}

interface RangeReply {
  id: number;
  bytes?: Uint8Array;
  error?: SerializedError;
}

/** Page side: answers byte range requests for `source` on the returned port (transfer it to the worker). */
export function serveSource(source: ByteSource): { port: MessagePort; close(): void } {
  const channel = new MessageChannel();
  const port = channel.port1;
  port.onmessage = (e: MessageEvent<RangeRequest>) => {
    const { id, start, length } = e.data;
    source.read(start, length).then(
      (bytes) => {
        const copy = bytes.slice();
        port.postMessage({ id, bytes: copy } satisfies RangeReply, [copy.buffer]);
      },
      (err: unknown) => port.postMessage({ id, error: serializeError(err) } satisfies RangeReply),
    );
  };
  return {
    port: channel.port2,
    close: () => port.close(),
  };
}

/** Worker side: a ByteSource whose reads go to the page over `port`. */
export function portSource(name: string, size: number, port: MessagePort): ByteSource {
  let nextId = 1;
  const pending = new Map<number, { resolve: (b: Uint8Array) => void; reject: (e: Error) => void }>();
  port.onmessage = (e: MessageEvent<RangeReply>) => {
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    if (e.data.bytes) p.resolve(e.data.bytes);
    else p.reject(e.data.error ? deserializeError(e.data.error) : new AudioError('read-failed'));
  };
  return {
    name,
    size,
    read(start: number, length: number): Promise<Uint8Array> {
      return new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        port.postMessage({ id, start, length } satisfies RangeRequest);
      });
    },
  };
}

/** Worker side: turns a SourceRef back into a ByteSource. */
export function sourceFromRef(ref: SourceRef): ByteSource {
  if (ref.blob) return fileSource(ref.blob, ref.name);
  if (ref.port) return portSource(ref.name, ref.size, ref.port);
  throw new AudioError('read-failed');
}

/** Page side: describes a source for the worker; `close` ends a port connection. */
export function sourceRef(source: ByteSource): { ref: SourceRef; transfer: Transferable[]; close(): void } {
  if (source.blob && source.blob.size === source.size) {
    return { ref: { name: source.name, size: source.size, blob: source.blob }, transfer: [], close: () => undefined };
  }
  const served = serveSource(source);
  return { ref: { name: source.name, size: source.size, port: served.port }, transfer: [served.port], close: served.close };
}

/* ------------------------------------------------------------ worker side */

export type PostResponse = (msg: AnalysisResponse, transfer?: Transferable[]) => void;

/**
 * The analysis worker's message handler. One worker can serve several jobs;
 * the page normally uses one worker per job and terminates it afterwards.
 */
export function createAnalysisWorkerHandler(post: PostResponse, env?: DecodeEnv): (msg: AnalysisRequest) => void {
  const readers = new Map<number, { opened: OpenedAudio; busy: Promise<unknown> }>();
  const fail = (id: number, err: unknown) => post({ type: 'error', id, error: serializeError(err) });

  return (msg) => {
    switch (msg.type) {
      case 'analyze': {
        void (async () => {
          try {
            const source = sourceFromRef(msg.source);
            let last = -1;
            const analysis = await analyzeAudio(source, {
              windowSec: msg.windowSec,
              env,
              onProgress: (fraction) => {
                if (fraction - last >= 0.005 || fraction >= 1) {
                  last = fraction;
                  post({ type: 'progress', id: msg.id, fraction });
                }
              },
            });
            post({ type: 'analysis', id: msg.id, analysis }, transferList([analysis.power]));
          } catch (err) {
            fail(msg.id, err);
          }
        })();
        break;
      }
      case 'open': {
        void (async () => {
          try {
            const opened = await openAudio(sourceFromRef(msg.source), { env, targetSampleRate: msg.targetSampleRate });
            readers.set(msg.id, { opened, busy: Promise.resolve() });
            const r = opened.reader;
            post({ type: 'opened', id: msg.id, sampleRate: r.sampleRate, channels: r.channels, durationSec: r.durationSec, codec: opened.codec });
          } catch (err) {
            fail(msg.id, err);
          }
        })();
        break;
      }
      case 'read': {
        const entry = readers.get(msg.id);
        if (!entry) {
          fail(msg.id, new AudioError('read-failed'));
          break;
        }
        entry.busy = entry.busy.then(async () => {
          try {
            const chunk = await entry.opened.reader.next(msg.maxFrames);
            const channels = chunk ? chunk.channels : null;
            post({ type: 'chunk', id: msg.id, channels, progress: entry.opened.progress() }, channels ? transferList(channels) : []);
          } catch (err) {
            fail(msg.id, err);
          }
        });
        break;
      }
      case 'close': {
        const entry = readers.get(msg.id);
        readers.delete(msg.id);
        void (async () => {
          await entry?.busy;
          await entry?.opened.reader.close().catch(() => undefined);
          post({ type: 'closed', id: msg.id });
        })();
        break;
      }
    }
  };
}
