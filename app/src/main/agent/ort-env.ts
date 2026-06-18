/**
 * Caps onnxruntime-node's thread pool BEFORE @xenova/transformers loads.
 *
 * transformers.js 2.17 calls `InferenceSession.create(buffer, { executionProviders })`
 * with no thread options, so onnxruntime defaults its intra-op pool to the full CPU core
 * count — every embedding inference then fans out across all cores (the 400%+ CPU / huge
 * thread count). For a tiny MiniLM model that is pure waste, so we monkeypatch the shared
 * onnxruntime-node module to inject a small thread cap. Both this file and transformers.js
 * import the same cached module instance, and embeddings.ts imports this FIRST, so the patch
 * is in place before any session is created.
 */
import os from "node:os";
import * as ortNode from "onnxruntime-node";

const cores = os.cpus()?.length ?? 4;
const CAP   = Math.max(1, Math.min(2, Math.floor(cores / 4)));   // 1–2 threads is plenty

// Belt-and-suspenders env hints (some ORT builds read these).
if (!process.env["OMP_NUM_THREADS"]) process.env["OMP_NUM_THREADS"] = String(CAP);
if (!process.env["ORT_NUM_THREADS"]) process.env["ORT_NUM_THREADS"] = String(CAP);
// macOS Accelerate framework uses GCD internally and ignores intraOpNumThreads.
// VECLIB_MAXIMUM_THREADS is the only way to cap it.
if (!process.env["VECLIB_MAXIMUM_THREADS"]) process.env["VECLIB_MAXIMUM_THREADS"] = String(CAP);

try {
  // Resolve the same InferenceSession transformers.js uses (ONNX_NODE.default ?? ONNX_NODE).
  const ORT: any = (ortNode as any).default ?? ortNode;
  const IS: any = ORT?.InferenceSession;
  if (IS && typeof IS.create === "function" && !IS.__inboxpieThreadCapped) {
    const orig = IS.create.bind(IS);
    IS.create = function (model: unknown, options?: Record<string, unknown>) {
      const opts: Record<string, unknown> = options ? { ...options } : {};
      if (opts["intraOpNumThreads"] == null) opts["intraOpNumThreads"] = CAP;
      if (opts["interOpNumThreads"] == null) opts["interOpNumThreads"] = 1;
      if (opts["executionMode"] == null)     opts["executionMode"]     = "sequential";
      return orig(model, opts);
    };
    IS.__inboxpieThreadCapped = true;
    console.log(`[ort-env] onnxruntime intra-op threads capped to ${CAP}`);
  }
} catch (e) {
  console.warn("[ort-env] could not cap onnxruntime threads:", (e as Error)?.message ?? e);
}

export {};
