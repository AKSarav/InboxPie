/**
 * LLM provider factory — supports Ollama (local) and cloud providers (OpenAI, Anthropic, Google).
 *
 * Only provider + model are passed from the renderer. API keys are decrypted in the
 * main process and injected here — they never travel to the renderer.
 */

import { ChatOllama } from "@langchain/ollama";
import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

const OLLAMA_BASE = "http://localhost:11434";

export type CloudProvider = "openai" | "anthropic" | "google";

// Which local models support a separate "thinking" stream. Cached; populated by
// loadOllamaThinkingModels(). think:true ERRORS on non-thinking models, so we must gate it.
let _thinkingModels: Set<string> | null = null;

export async function loadOllamaThinkingModels(): Promise<void> {
  if (_thinkingModels) return;
  const found = new Set<string>();
  try {
    const tags = await (await fetch(`${OLLAMA_BASE}/api/tags`, { signal: AbortSignal.timeout(3000) })).json() as { models?: Array<{ name: string }> };
    await Promise.all((tags.models ?? []).map(async (m) => {
      try {
        const show = await (await fetch(`${OLLAMA_BASE}/api/show`, {
          method: "POST", body: JSON.stringify({ model: m.name }), signal: AbortSignal.timeout(3000),
        })).json() as { capabilities?: string[] };
        if ((show.capabilities ?? []).includes("thinking")) found.add(m.name);
      } catch { /* skip this model */ }
    }));
  } catch { /* ollama offline */ }
  _thinkingModels = found;
}

function isThinkingModel(model: string): boolean {
  return _thinkingModels?.has(model) ?? false;
}

// Static curated model lists — users pick from these in the settings UI.
export const CLOUD_MODELS: Record<CloudProvider, string[]> = {
  openai:    ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "gpt-3.5-turbo"],
  anthropic: ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"],
  google:    ["gemini-2.0-flash", "gemini-1.5-pro", "gemini-1.5-flash"],
};

export function createLLM(
  provider: string,
  model: string,
  apiKey?: string,
): BaseChatModel {
  switch (provider) {
    case "openai":
      return new ChatOpenAI({ model, apiKey, temperature: 0 });
    case "anthropic":
      return new ChatAnthropic({ model, apiKey, temperature: 0 });
    case "google":
      return new ChatGoogleGenerativeAI({ model, apiKey: apiKey!, temperature: 0 });
    default:
      // Large context window: the agent feeds the model up to ~50 search results, each with
      // ~1.5k chars of email body. At numCtx=6144 Ollama silently truncated that, so local
      // models never saw the amounts and could only list senders. 32k fits content-rich
      // results so a capable model (e.g. gpt-oss) can actually read + sum. Modern models
      // (gpt-oss, llama3.x, qwen2.5) support this; needs adequate RAM for the KV cache.
      // think:true only for thinking-capable models (else Ollama errors). Lets us stream the
      // model's reasoning live so the UI isn't silent during the (long) reasoning phase.
      return new ChatOllama({ model, baseUrl: OLLAMA_BASE, temperature: 0, numCtx: 32768, think: isThinkingModel(model) });
  }
}

/**
 * Validate a cloud API key by making a lightweight API call.
 * Does NOT save anything — the caller decides whether to persist.
 */
export async function validateCloudKey(
  provider: CloudProvider,
  apiKey: string,
): Promise<{ valid: boolean; error?: string }> {
  try {
    switch (provider) {
      case "openai": {
        const res = await fetch("https://api.openai.com/v1/models", {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(8_000),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({})) as Record<string, unknown>;
          const msg = (body as { error?: { message?: string } }).error?.message ?? `HTTP ${res.status}`;
          return { valid: false, error: msg };
        }
        return { valid: true };
      }

      case "anthropic": {
        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 1,
            messages: [{ role: "user", content: "hi" }],
          }),
          signal: AbortSignal.timeout(12_000),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({})) as Record<string, unknown>;
          const msg = String((body as { error?: { message?: string } }).error?.message ?? `HTTP ${res.status}`);
          return { valid: false, error: msg };
        }
        return { valid: true };
      }

      case "google": {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
          { signal: AbortSignal.timeout(8_000) },
        );
        if (!res.ok) {
          const body = await res.json().catch(() => ({})) as Record<string, unknown>;
          const msg = String((body as { error?: { message?: string } }).error?.message ?? `HTTP ${res.status}`);
          return { valid: false, error: msg };
        }
        return { valid: true };
      }
    }
  } catch (e) {
    return { valid: false, error: (e as Error).message };
  }
}
