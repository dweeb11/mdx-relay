// Runs inside a real Node worker thread. Provides the DedicatedWorkerGlobalScope
// surface the built artifact expects, then loads dist/processing.worker.js
// unmodified. This is an adapter for the worker *scope* only: no codec, message
// handler, or plan logic is stubbed, and nothing here is on the parent's side of
// the message boundary.
import { createRequire } from "node:module";
import { parentPort, workerData } from "node:worker_threads";

if (!parentPort) throw new Error("bundle worker bootstrap needs a parentPort");
const port = parentPort;

const listeners = [];
globalThis.self = {
  addEventListener(type, listener) {
    if (type === "message") listeners.push(listener);
  },
  postMessage(message, transfer) {
    port.postMessage(message, transfer);
  },
};

// Loading the built artifact compiles the embedded codec WASM and registers the
// worker's message handler. This is the worker starting up for real.
createRequire(import.meta.url)(workerData.workerPath);

if (listeners.length === 0) {
  throw new Error("built worker did not register a message handler");
}

// Structured-cloned data arrives here having genuinely crossed threads.
port.on("message", (data) => {
  for (const listener of listeners) listener({ data });
});

port.postMessage({ type: "bootstrap-ready" });
