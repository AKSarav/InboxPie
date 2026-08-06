/**
 * NLP Agent — ADR 006 SmartSearch
 *
 * Phase 3: LangGraph ReAct agent querying Apple Mail Envelope Index directly.
 * `runAgentQuery` delegates to langgraph-agent.ts.
 * This file is kept for: checkOllama(), shared types.
 */

const OLLAMA_BASE = "http://localhost:11434";
const DEFAULT_MODEL = "qwen3.5:27b";

// ── Shared types ──────────────────────────────────────────────────────────────

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface AgentStep {
  type: "think" | "intent" | "sql" | "result" | "retry" | "error";
  label: string;
  detail?: string;
}

export interface AgentResponse {
  intent: string;
  response_type: "text" | "stat_card" | "bar_chart" | "pie_chart" | "line_chart" | "data_table" | "html_widget";
  answer_text: string;
  rows?: Record<string, unknown>[];
  widget_html?: string;   // model-authored HTML fragment, rendered in a sandboxed iframe
  sql?: string;
  error?: string;
  thinking?: string;
  agentSteps?: AgentStep[];
}

// ── Ollama check ──────────────────────────────────────────────────────────────

export async function checkOllama(): Promise<{ available: boolean; models: string[] }> {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/tags`, {
      signal: AbortSignal.timeout(3_000),
    });
    if (!res.ok) return { available: false, models: [] };
    const data = (await res.json()) as { models?: Array<{ name: string }> };
    return {
      available: true,
      models: (data.models ?? []).map((m) => m.name),
    };
  } catch {
    return { available: false, models: [] };
  }
}

// ── Cloud provider validation ──────────────────────────────────────────────────

export async function checkCloudProvider(
  provider: "openai" | "anthropic" | "google",
  apiKey: string,
): Promise<{ valid: boolean; error?: string }> {
  const { validateCloudKey } = await import("./llm-providers");
  return validateCloudKey(provider, apiKey);
}

// ── Agent entry point ─────────────────────────────────────────────────────────

export async function runAgentQuery(
  userMessage: string,
  conversationHistory: ChatMessage[],
  model: string = DEFAULT_MODEL,
  onEvent?: (ev: Record<string, unknown>) => void,
  mode: "fast" | "deep" = "fast",
  signal?: AbortSignal,
  provider = "ollama",
  apiKey?: string,
): Promise<AgentResponse> {
  const { runAppleMailAgent } = await import("./langgraph-agent");
  return runAppleMailAgent(userMessage, conversationHistory, model, onEvent as any, mode, signal, false, provider, apiKey);
}
