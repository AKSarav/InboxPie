/**
 * Embedding worker — runs in a dedicated worker_thread so ONNX inference never
 * touches the Electron main process event loop.
 *
 * Protocol (main → worker):
 *   { type: "embed", id: number, texts: string[], isQuery: boolean }
 *
 * Protocol (worker → main):
 *   { type: "ready" }
 *   { type: "result", id: number, vectors: number[][] }
 *   { type: "error",  id: number, message: string }
 */

import { parentPort } from "worker_threads";
import os   from "node:os";
import path from "node:path";

// Cap ONNX thread pool — must happen before transformers loads onnxruntime.
// The worker_threads environment inherits process.env so the env-hint values
// set in the main process carry over, but we set them here defensively too.
const cores = os.cpus()?.length ?? 4;
const CAP   = Math.max(1, Math.min(2, Math.floor(cores / 4)));
if (!process.env["OMP_NUM_THREADS"])       process.env["OMP_NUM_THREADS"]       = String(CAP);
if (!process.env["ORT_NUM_THREADS"])       process.env["ORT_NUM_THREADS"]       = String(CAP);
if (!process.env["VECLIB_MAXIMUM_THREADS"]) process.env["VECLIB_MAXIMUM_THREADS"] = String(CAP);

import { pipeline, env } from "@xenova/transformers";

const MODEL_CACHE = path.join(os.homedir(), ".inboxpie", "models");
env.cacheDir = MODEL_CACHE;

// Keep in sync with embeddings.ts constants.
const MODEL_NAME   = "Xenova/bge-base-en-v1.5";
const QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";
const MAX_CHARS    = 2000;

let _pipe: Awaited<ReturnType<typeof pipeline>> | null = null;

async function getPipeline() {
  if (!_pipe) {
    _pipe = await pipeline("feature-extraction", MODEL_NAME, { quantized: true });
  }
  return _pipe;
}

parentPort?.on("message", async (msg: { type: string; id: number; texts: string[]; isQuery: boolean }) => {
  if (msg.type !== "embed") return;
  try {
    const pipe = await getPipeline();
    const vectors: number[][] = [];

    for (const raw of msg.texts) {
      const text = (msg.isQuery ? QUERY_PREFIX : "") + String(raw ?? "").slice(0, MAX_CHARS);
      const out  = await (pipe as any)(text, { pooling: "mean", normalize: true, truncation: true });
      vectors.push(Array.from(out.data as Float32Array));
    }

    parentPort?.postMessage({ type: "result", id: msg.id, vectors });
  } catch (e) {
    parentPort?.postMessage({ type: "error", id: msg.id, message: (e as Error).message });
  }
});

// Signal that the worker event loop is up. The pipeline itself loads lazily on
// the first embed request (or eagerly via a prewarm embed from the main process).
parentPort?.postMessage({ type: "ready" });
