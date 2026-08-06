/**
 * Cross-encoder reranker worker — runs in a dedicated worker_thread so ONNX
 * inference never touches the Electron main process event loop.
 *
 * Model: Xenova/bge-reranker-base — unlike the bi-encoder embedding model (which
 * scores query and document independently, then compares vectors), a cross-encoder
 * reads the (query, document) pair TOGETHER in one forward pass. Much more accurate
 * relevance judgment, at the cost of being unable to precompute anything offline —
 * every candidate has to be scored at query time, so callers should pre-filter to a
 * reasonably small candidate pool (e.g. via the existing hybrid vector+BM25 search)
 * before handing it to this worker.
 *
 * NOTE: BAAI/bge-reranker-v2-m3 was tried first (better/multilingual, per the user's
 * request) but has no ONNX weights published — transformers.js can only load ONNX,
 * not the raw PyTorch/safetensors checkpoint. Xenova/bge-reranker-base is the v1
 * generation, English-focused, but has a working ONNX conversion.
 *
 * Protocol (main → worker):
 *   { type: "rerank", id: number, query: string, documents: string[] }
 *
 * Protocol (worker → main):
 *   { type: "ready" }
 *   { type: "result", id: number, scores: number[] }   // sigmoid'd, 0..1, same order as documents
 *   { type: "error",  id: number, message: string }
 */

import { parentPort } from "worker_threads";
import os   from "node:os";
import path from "node:path";

// Cap ONNX thread pool — must happen before transformers loads onnxruntime.
// Mirrors embedding-worker.ts; the reranker model is considerably larger, so
// staying conservative here matters even more for CPU/thermal behavior.
const cores = os.cpus()?.length ?? 4;
const CAP   = Math.max(1, Math.min(2, Math.floor(cores / 4)));
if (!process.env["OMP_NUM_THREADS"])        process.env["OMP_NUM_THREADS"]        = String(CAP);
if (!process.env["ORT_NUM_THREADS"])        process.env["ORT_NUM_THREADS"]        = String(CAP);
if (!process.env["VECLIB_MAXIMUM_THREADS"]) process.env["VECLIB_MAXIMUM_THREADS"] = String(CAP);

import { AutoTokenizer, AutoModelForSequenceClassification, env } from "@xenova/transformers";

const MODEL_CACHE = path.join(os.homedir(), ".inboxpie", "models");
env.cacheDir = MODEL_CACHE;

// Keep in sync with reranker.ts.
const MODEL_NAME = "Xenova/bge-reranker-base";
const MAX_CHARS  = 1000; // per document — keeps the tokenized (query+doc) sequence within the model's window
const BATCH_SIZE = 8;    // pairs per forward pass — base model is much smaller, can afford a bigger batch

let _tokenizer: Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>> | null = null;
let _model:     Awaited<ReturnType<typeof AutoModelForSequenceClassification.from_pretrained>> | null = null;

async function getModel() {
  if (!_tokenizer || !_model) {
    _tokenizer = await AutoTokenizer.from_pretrained(MODEL_NAME);
    _model     = await AutoModelForSequenceClassification.from_pretrained(MODEL_NAME, { quantized: true });
  }
  return { tokenizer: _tokenizer, model: _model };
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

parentPort?.on("message", async (msg: { type: string; id: number; query: string; documents: string[] }) => {
  if (msg.type !== "rerank") return;
  try {
    const { tokenizer, model } = await getModel();
    const scores: number[] = [];

    for (let start = 0; start < msg.documents.length; start += BATCH_SIZE) {
      const chunk   = msg.documents.slice(start, start + BATCH_SIZE).map((d) => String(d ?? "").slice(0, MAX_CHARS));
      const queries = chunk.map(() => msg.query);
      const inputs  = (tokenizer as any)(queries, { text_pair: chunk, padding: true, truncation: true });
      const output  = await (model as any)(inputs);
      const logits  = output.logits.data as Float32Array; // shape [chunk.length, 1] -> flat array of chunk.length
      for (let i = 0; i < chunk.length; i++) scores.push(sigmoid(logits[i]!));
    }

    parentPort?.postMessage({ type: "result", id: msg.id, scores });
  } catch (e) {
    parentPort?.postMessage({ type: "error", id: msg.id, message: (e as Error).message });
  }
});

// Signal that the worker event loop is up. The model itself loads lazily on the
// first rerank request — loading bge-reranker-base (~300MB quantized) takes a bit
// longer than the small embedding model, so the first query after app start will
// have a one-time delay.
parentPort?.postMessage({ type: "ready" });
