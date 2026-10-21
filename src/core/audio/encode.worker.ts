/**
 * Web Worker running lamejs for encodeFromReader / convertToMp3 in the
 * browser build. The logic is in mp3encoder.ts (testable in Node).
 */
import { createEncoderWorkerHandler, type EncoderRequest } from './mp3encoder';

const scope = self as unknown as DedicatedWorkerGlobalScope;

const handle = createEncoderWorkerHandler((msg, transfer) => scope.postMessage(msg, transfer));

scope.onmessage = (e: MessageEvent<EncoderRequest>) => handle(e.data);
