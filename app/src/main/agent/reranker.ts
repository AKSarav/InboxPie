/**
 * Cross-encoder reranker bridge — delegates ONNX inference to a dedicated
 * worker_thread (reranker-worker.ts), mirroring embeddings.ts.
 *
 * Model: Xenova/bge-reranker-base — scores (query, document) pairs together, far
 * more accurate than bi-encoder cosine similarity for judging true relevance.
 * Used downstream to threshold "genuinely matching" results instead of guessing
 * an arbitrary result count (see semantic_search in langgraph-agent.ts).
 *
 * BAAI/bge-reranker-v2-m3 was the original choice but has no published ONNX
 * weights (transformers.js can only load ONNX). bge-reranker-base is the v1
 * generation — English-focused rather than multilingual — but has a working
 * ONNX conversion under the Xenova org.
 */

import { Worker }        from "worker_threads";
import { fileURLToPath } from "node:url";
import fs   from "node:fs";
import os   from "node:os";
import path from "node:path";

export const RERANKER_MODEL_NAME = "Xenova/bge-reranker-base";

const MODEL_CACHE = path.join(os.homedir(), ".inboxpie", "models");
const __dirname   = path.dirname(fileURLToPath(import.meta.url));

// ── Worker lifecycle (same shape as embeddings.ts) ─────────────────────────────

let _worker:      Worker | null = null;
let _workerReady  = false;
let _readyWaiters: Array<() => void> = [];
let _idCounter    = 0;
const _pending    = new Map<number, { resolve: (v: number[]) => void; reject: (e: Error) => void }>();

function spawnWorker(): Worker {
  const workerPath = path.join(__dirname, "reranker-worker.js");
  const w = new Worker(workerPath);

  w.on("message", (msg: { type: string; id?: number; scores?: number[]; message?: string }) => {
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
      call.reject(new Error(msg.message ?? "reranker worker error"));
    } else {
      call.resolve(msg.scores ?? []);
    }
  });

  w.on("error", (err) => {
    console.error("[reranker] worker error:", err);
    _worker      = null;
    _workerReady = false;
    for (const call of _pending.values()) call.reject(err);
    _pending.clear();
  });

  w.on("exit", (code) => {
    if (code !== 0) console.error("[reranker] worker exited with code", code);
    _worker      = null;
    _workerReady = false;
  });

  return w;
}

function getWorker(): Worker {
  if (!_worker) _worker = spawnWorker();
  return _worker;
}

function waitForReady(): Promise<void> {
  if (_workerReady) return Promise.resolve();
  return new Promise((resolve) => {
    _readyWaiters.push(resolve);
    getWorker(); // ensure it's spawned
  });
}

/** Terminate the worker on app quit so it doesn't linger as a zombie thread. */
export function terminateRerankerWorker(): void {
  _worker?.terminate();
  _worker      = null;
  _workerReady = false;
}

/** True once the worker thread is alive and reachable — NOT the same as the model
 *  having loaded successfully (the worker posts "ready" before it even attempts to
 *  load the ONNX model). Use isRerankerModelReady() to check actual model state. */
export function isRerankerReady(): boolean {
  return _workerReady;
}

// ── Model load state (distinct from worker-thread-alive) ──────────────────────
//
// _workerReady only tells us the worker_thread's event loop is up — the model
// itself loads lazily on first use and can fail (wrong repo, no ONNX weights,
// network error) well after the worker already reported "ready". Callers that
// want to know "is reranking actually going to work" need this, not isRerankerReady().

type ModelState = "unknown" | "loading" | "ready" | "error";
let _modelState: ModelState = "unknown";
let _modelError: string | null = null;

/** True only once the model has been confirmed to actually load (a rerank call succeeded). */
export function isRerankerModelReady(): boolean {
  return _modelState === "ready";
}

/** Non-null once the model has been confirmed to have failed to load. */
export function getRerankerModelError(): string | null {
  return _modelState === "error" ? _modelError : null;
}

// ── Public API ──────────────────────────────────────────────────────────────────

/**
 * Cross-encoder-scores each document against the query. Returns a 0..1 relevance
 * score per document, same order as input (higher = more relevant). Rejects if
 * the reranker model can't be loaded — callers should catch and fall back to the
 * first-stage retrieval order rather than let a missing/failed model break search.
 */
export async function rerank(query: string, documents: string[]): Promise<number[]> {
  if (!documents.length) return [];
  await waitForReady();
  try {
    const scores = await new Promise<number[]>((resolve, reject) => {
      const id = ++_idCounter;
      _pending.set(id, { resolve, reject });
      getWorker().postMessage({ type: "rerank", id, query, documents });
    });
    _modelState = "ready";
    return scores;
  } catch (e) {
    // Covers mid-session worker crashes too, not just the initial prewarm attempt.
    _modelState = "error";
    _modelError = (e as Error).message;
    throw e;
  }
}

// ── Model status (file-system only — no ONNX in the main process) ─────────────

export interface RerankerStatus {
  available:    boolean;
  model:        string;
  cached:       boolean;
  downloadedMB: number;
  totalMB:      number;
  error?:       string;
}

export async function checkRerankerModel(): Promise<RerankerStatus> {
  const modelSlug = RERANKER_MODEL_NAME.replace("/", "--");
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

  // Quantized bge-reranker-base is ~300MB — still bigger than the embedding model,
  // but nowhere near v2-m3's ~1.1GB. Approximate; not load-bearing beyond the
  // progress-bar percentage shown to the user.
  return { available: true, model: RERANKER_MODEL_NAME, cached, downloadedMB, totalMB: 300 };
}

// ── Prewarm ────────────────────────────────────────────────────────────────────
//
// Same rationale as embeddings.ts: download/load at app startup, not on the first
// real chat query — this model is still a few times the embedding model's size, so
// paying that cost mid-conversation would be a much worse experience than a
// background prewarm.

let _prewarmPromise: Promise<void> | null = null;

export function prewarmRerankerModel(
  onProgress?: (status: { phase: "downloading" | "ready" | "error"; pct?: number; error?: string }) => void,
): Promise<void> {
  if (_prewarmPromise) return _prewarmPromise;
  _modelState = "loading";
  _prewarmPromise = (async () => {
    try {
      onProgress?.({ phase: "downloading", pct: 0 });
      await waitForReady();
      // Forces the worker to actually load the tokenizer+model (waitForReady only
      // confirms the worker thread is alive, not that the ONNX model is loaded).
      await rerank("warmup", ["warmup"]);
      _modelState = "ready";
      onProgress?.({ phase: "ready", pct: 100 });
    } catch (e) {
      _prewarmPromise = null;
      _modelState = "error";
      _modelError = (e as Error).message;
      onProgress?.({ phase: "error", error: (e as Error).message });
    }
  })();
  return _prewarmPromise;
}
