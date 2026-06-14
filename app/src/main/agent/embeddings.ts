/**
 * Embedding client — Xenova/all-MiniLM-L6-v2 (quantized, ~23MB).
 *
 * Runs fully offline via @xenova/transformers + onnxruntime-node.
 * Model is downloaded from HuggingFace on first call and cached locally.
 * No Ollama or Python dependency required.
 */

import "./ort-env";   // caps ONNX thread pool — must run before transformers/onnxruntime loads
import { pipeline, env } from "@xenova/transformers";
import os   from "node:os";
import path from "node:path";
import fs   from "node:fs";

// Cache models alongside other InboxPie data
const MODEL_CACHE = path.join(os.homedir(), ".inboxpie", "models");
env.cacheDir = MODEL_CACHE;

// bge-small-en-v1.5: 384-dim (same schema as MiniLM), stronger retrieval quality.
// BGE retrieval works best with an instruction prefix on the QUERY only (documents get none).
const MODEL_NAME = "Xenova/bge-small-en-v1.5";
const QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";
const YIELD_EVERY = 16;     // yield to the event loop every N embeddings
const MAX_CHARS   = 2000;   // hard cap per text (~500 tokens) — bge max is 512 tokens

let _pipeline: Awaited<ReturnType<typeof pipeline>> | null = null;

async function getPipeline() {
  if (!_pipeline) {
    _pipeline = await pipeline("feature-extraction", MODEL_NAME, { quantized: true });
  }
  return _pipeline;
}

// ── Model status ───────────────────────────────────────────────────────────────

export interface EmbeddingStatus {
  available: boolean;
  model:     string;
  cached:    boolean;
  error?:    string;
}

export async function checkEmbeddingModel(): Promise<EmbeddingStatus> {
  const modelSlug = MODEL_NAME.replace("/", "--");
  const cacheDir  = path.join(MODEL_CACHE, `models--${modelSlug}`);
  const cached    = fs.existsSync(cacheDir);
  return { available: true, model: MODEL_NAME, cached };
}

// ── Single embedding ───────────────────────────────────────────────────────────

export async function embedText(text: string): Promise<number[]> {
  const pipe   = await getPipeline();
  // Query embedding → prepend the BGE retrieval instruction.
  const output = await (pipe as any)(QUERY_PREFIX + String(text).slice(0, MAX_CHARS), {
    pooling: "mean", normalize: true, truncation: true,
  });
  return Array.from(output.data as Float32Array);
}

// ── Batch embedding ────────────────────────────────────────────────────────────
//
// Embeds SEQUENTIALLY, one text at a time. This is deliberate:
//   • A single batched call of N long texts pads to the longest sequence and makes
//     onnxruntime allocate one huge tensor — with content-mode bodies that OOM'd and
//     crashed the process (BFCArena::Extend in the crash log).
//   • Promise.all over N texts saturated the CPU and exploded the ORT thread pool.
// One-at-a-time keeps peak memory tiny and CPU bounded; we just yield periodically.

export async function embedBatch(
  texts: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<number[][]> {
  const pipe    = await getPipeline();
  const results = new Array<number[]>(texts.length);

  for (let i = 0; i < texts.length; i++) {
    const text = String(texts[i] ?? "").slice(0, MAX_CHARS);
    const out  = await (pipe as any)(text, { pooling: "mean", normalize: true, truncation: true });
    results[i] = Array.from(out.data as Float32Array);

    if ((i + 1) % YIELD_EVERY === 0 || i === texts.length - 1) {
      onProgress?.(i + 1, texts.length);
      await new Promise((r) => setImmediate(r));   // keep IPC/UI responsive
    }
  }
  return results;
}
