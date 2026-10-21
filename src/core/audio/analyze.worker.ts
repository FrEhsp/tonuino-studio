/**
 * Web Worker for analysis and decoding in the browser build. The logic lives
 * in workerProtocol.ts / decode.ts (testable in Node); this file only wires
 * it to the worker's message port. Started by browserBackend.ts.
 */
import { createAnalysisWorkerHandler, type AnalysisRequest } from './workerProtocol';

const scope = self as unknown as DedicatedWorkerGlobalScope;

const handle = createAnalysisWorkerHandler((msg, transfer) => scope.postMessage(msg, transfer ?? []));

scope.onmessage = (e: MessageEvent<AnalysisRequest>) => handle(e.data);
