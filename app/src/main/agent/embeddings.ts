/**
 * Embedding bridge — delegates all ONNX inference to a dedicated worker_thread
 * (embedding-worker.ts) so the Electron main process event loop is never blocked.
 *
 * Model: Xenova/bge-base-en-v1.5 — 768-dim, ~110MB, runs fully offline.
 *
 * Model progression (all Xenova quantized ONNX):
 *   bge-small-en-v1.5 — 384-dim, ~23MB,  fastest
 *   bge-base-en-v1.5  — 768-dim, ~110MB, better  ← current
 *   bge-large-en-v1.5 — 1024-dim, ~335MB, best retrieval quality
 */

import { Worker }        from "worker_threads";
import { fileURLToPath } from "node:url";
import fs   from "node:fs";
import os   from "node:os";
import path from "node:path";

export const MODEL_NAME    = "Xenova/bge-base-en-v1.5";
export const EMBEDDING_DIM = 768;

const MODEL_CACHE = path.join(os.homedir(), ".inboxpie", "models");
const __dirname   = path.dirname(fileURLToPath(import.meta.url));

// ── Worker lifecycle ───────────────────────────────────────────────────────────

let _worker:      Worker | null = null;
let _workerReady  = false;
let _readyWaiters: Array<() => void> = [];
let _idCounter    = 0;
const _pending    = new Map<number, { resolve: (v: number[][]) => void; reject: (e: Error) => void }>();

function spawnWorker(): Worker {
  // In both dev (out/main/) and production (app.asar/out/main/) the worker is
  // compiled to the same directory as this file by the electron-vite build.
  const workerPath = path.join(__dirname, "embedding-worker.js");
  const w = new Worker(workerPath);

  w.on("message", (msg: { type: string; id?: number; vectors?: number[][]; message?: string }) => {
    if (msg.type === "ready") {
      _workerReady = true;
      for (const fn of _readyWaiters) fn();
      _readyWaiters = [];
      return;
    }
    const call = msg.id !== undefined ? _pending.get(msg.id) : undefined;
    if (!call) return;
    _pending.delete(msg.id!);
    if (msg.type === "error") {
      call.reject(new Error(msg.message ?? "embedding worker error"));
    } else {
      call.resolve(msg.vectors ?? []);
    }
  });

  w.on("error", (err) => {
    console.error("[embeddings] worker error:", err);
    _worker      = null;
    _workerReady = false;
    for (const call of _pending.values()) call.reject(err);
    _pending.clear();
  });

  w.on("exit", (code) => {
    if (code !== 0) console.error("[embeddings] worker exited with code", code);
    _worker      = null;
    _workerReady = false;
  });

  return w;
}

function getWorker(): Worker {
  if (!_worker) {
    _worker = spawnWorker();
  }
  return _worker;
}

function waitForReady(): Promise<void> {
  if (_workerReady) return Promise.resolve();
  return new Promise((resolve) => {
    _readyWaiters.push(resolve);
    getWorker(); // ensure it's spawned
  });
}

function call(texts: string[], isQuery: boolean): Promise<number[][]> {
  return new Promise((resolve, reject) => {
    const id = ++_idCounter;
    _pending.set(id, { resolve, reject });
    getWorker().postMessage({ type: "embed", id, texts, isQuery });
  });
}

/** Terminate the worker on app quit so it doesn't linger as a zombie thread. */
export function terminateEmbeddingWorker(): void {
  _worker?.terminate();
  _worker      = null;
  _workerReady = false;
}

// ── Model status (file-system only — no ONNX in the main process) ─────────────

export interface EmbeddingStatus {
  available:    boolean;
  model:        string;
  dim:          number;
  cached:       boolean;
  downloadedMB: number;
  totalMB:      number;
  error?:       string;
}

export async function checkEmbeddingModel(): Promise<EmbeddingStatus> {
  const modelSlug = MODEL_NAME.replace("/", "--");
  const cacheDir  = path.join(MODEL_CACHE, `models--${modelSlug}`);
  const cached    = fs.existsSync(cacheDir);

  let downloadedMB = 0;
  if (cached) {
    try {
      const files = fs.readdirSync(cacheDir, { recursive: true }) as string[];
      let bytes = 0;
      for (const f of files) {
        try { bytes += fs.statSync(path.join(cacheDir, f)).size; } catch { /* skip */ }
      }
      downloadedMB = Math.round(bytes / 1_048_576);
    } catch { /* ignore */ }
  }

  return { available: true, model: MODEL_NAME, dim: EMBEDDING_DIM, cached, downloadedMB, totalMB: 110 };
}

// ── Prewarm ────────────────────────────────────────────────────────────────────
//
// Spawning the worker and loading the ONNX pipeline is done here at app startup
// so the first real embed request returns quickly rather than paying the ~5s
// model-load cost mid-indexing. The pipeline loads inside the worker thread,
// so prewarm itself is non-blocking for the main process.

let _prewarmPromise: Promise<void> | null = null;

export function prewarmEmbeddingModel(
  onProgress?: (status: { phase: "downloading" | "ready" | "error"; pct?: number; error?: string }) => void,
): Promise<void> {
  if (_prewarmPromise) return _prewarmPromise;
  _prewarmPromise = (async () => {
    try {
      onProgress?.({ phase: "downloading", pct: 0 });
      // Spawn the worker; it will load the ONNX pipeline and post "ready".
      // A dummy single-token embed ensures the pipeline is fully warmed up.
      await waitForReady();
      await call(["warmup"], false);
      onProgress?.({ phase: "ready", pct: 100 });
    } catch (e) {
      _prewarmPromise = null;
      onProgress?.({ phase: "error", error: (e as Error).message });
    }
  })();
  return _prewarmPromise;
}

/** True once the worker is alive and the pipeline is loaded. */
export function isEmbeddingReady(): boolean {
  return _workerReady;
}

// ── Public embedding API ───────────────────────────────────────────────────────

/** Embed a single query string (BGE query-prefix applied inside the worker). */
export async function embedText(text: string): Promise<number[]> {
  await waitForReady();
  const [vec] = await call([text], /* isQuery */ true);
  return vec!;
}

/**
 * Embed a batch of document texts (no query prefix).
 * Texts are processed sequentially inside the worker to avoid OOM — same
 * guarantee as the old in-process implementation, now without blocking the
 * main process event loop.
 */
export async function embedBatch(
  texts: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<number[][]> {
  if (!texts.length) return [];
  await waitForReady();
  // Delegate the whole chunk to the worker (BATCH_SIZE = 4 from indexer.ts).
  // Worker embeds them sequentially; we get all vectors back in one message.
  const vectors = await call(texts, /* isQuery */ false);
  onProgress?.(texts.length, texts.length);
  return vectors;
}
