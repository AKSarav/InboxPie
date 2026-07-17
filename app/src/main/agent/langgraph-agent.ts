/**
 * Agentic semantic email assistant
 *
 * Tools:
 *   semantic_search  — vector similarity search over indexed emails
 *   aggregate_stats  — counts / rankings from indexed metadata
 *   final_answer     — structured response (Deep mode only), ends the loop
 *
 * Fast mode:  search → LLM replies as plain text (no final_answer call)
 * Deep mode:  search/aggregate → final_answer with visual response type
 *
 * The LLM decides whether results are relevant and whether to retry with
 * different terms. No code-side keyword matching.
 */

import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { tool } from "@langchain/core/tools";
import { HumanMessage, AIMessage } from "@langchain/core/messages";
import { z } from "zod";

import { embedText }   from "./embeddings";
import { lanceStore }  from "../db/lance-store";
import { createLLM, loadOllamaThinkingModels } from "./llm-providers";
import type { AgentResponse, AgentStep } from "./nlp-agent";

/**
 * Split a `text_indexed` blob into its metadata header and email body.
 * buildText() writes "subject:…\nfrom:…\ndomain:…" then "\n\n<body>" in content mode.
 * Returns the body portion (everything after the first blank line), or "" for metadata-only.
 */
function extractBody(textIndexed: string): string {
  const idx = textIndexed.indexOf("\n\n");
  if (idx === -1) return "";
  return textIndexed.slice(idx + 2).trim();
}

async function bodyIsIndexed(): Promise<boolean> {
  try { return await lanceStore.hasBodyContent(); } catch { return false; }
}

function ts(start?: number): string {
  const now = new Date();
  const hh  = String(now.getHours()).padStart(2, "0");
  const mm  = String(now.getMinutes()).padStart(2, "0");
  const ss  = String(now.getSeconds()).padStart(2, "0");
  const ms  = String(now.getMilliseconds()).padStart(3, "0");
  const abs = `[${hh}:${mm}:${ss}.${ms}]`;
  return start != null ? `${abs} [+${Date.now() - start}ms]` : abs;
}

function extractOutput(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object") {
    const content = (raw as Record<string, unknown>).content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content.map((c: unknown) => {
        if (typeof c === "string") return c;
        if (c && typeof c === "object") return (c as Record<string, unknown>).text ?? JSON.stringify(c);
        return String(c);
      }).join("");
    }
    return JSON.stringify(raw);
  }
  return String(raw ?? "");
}

const RECURSION_LIMIT = 25;

function dateContext(): string {
  const now = new Date();
  const y   = now.getFullYear();
  return [
    `TODAY: ${now.toISOString().slice(0, 10)}`,
    `"This year" = year ${y}`,
    `"Last year" = year ${y - 1}`,
  ].join("\n");
}

// ── Tool 1: semantic_search ───────────────────────────────────────────────────

const semanticSearch = tool(
  async ({ query, year_from, year_to, folder_type, folder, domain, sender_email, limit }) => {
    const stats = await lanceStore.getStats();
    if (stats.total === 0) {
      return JSON.stringify({
        error:   "index_empty",
        message: "The semantic index has not been built yet. Tell the user to go to the Settings page and index their folders.",
      });
    }
    try {
      console.log(`${ts()} [SmartSearch] embedText("${query}")`);
      const embedStart = Date.now();
      const queryVec   = await embedText(query);
      console.log(`${ts()} [SmartSearch] embedding ready dim=${queryVec.length} (${Date.now() - embedStart}ms), searching…`);
      const results = await lanceStore.search(queryVec, {
        limit:       limit ?? 25,
        yearFrom:    year_from,
        yearTo:      year_to,
        folderType:  folder_type,
        folder:      folder,
        domain:      domain,
        senderEmail: sender_email,
        queryText:   query,
      });
      console.log(`${ts()} [SmartSearch] semantic_search("${query}") → ${results.length} result(s)`);
      if (results.length === 0) {
        return JSON.stringify({ results: [], message: `No emails found for: "${query}"` });
      }
      const mapped = results.map((r) => {
        const body = extractBody(r.text_indexed ?? "");
        const row: Record<string, unknown> = {
          sender:    r.sender_name || r.sender_email,
          email:     r.sender_email,
          domain:    r.domain,
          subject:   r.subject || (r.text_indexed.split("\n")[0]?.replace("subject: ", "") ?? ""),
          date:      new Date(r.date_unix * 1000).toISOString().slice(0, 10),
          year:      r.year,
          folder:    r.folder,
          is_read:   r.is_read === 1,
          relevance: `${Math.round(r.score * 100)}%`,
        };
        if (body) row["content"] = body.slice(0, 1500);
        return row;
      });
      console.log(`${ts()} [SmartSearch] top: ${mapped.slice(0, 3).map(r => `"${r.subject}" (${r.relevance})`).join(" | ")}`);
      return JSON.stringify({ results: mapped });
    } catch (e) {
      console.error(`${ts()} [SmartSearch] semantic_search tool error:`, e);
      return JSON.stringify({ error: "search_failed", message: (e as Error).message });
    }
  },
  {
    name:        "semantic_search",
    description: "Find emails by MEANING or TOPIC. Use for: 'NPS investments', 'purchase receipts', 'travel bookings', 'FD matured'. Returns a JSON object with a 'results' array. Each result may include a 'content' field (full email body) when Full Content indexing is enabled.",
    schema: z.object({
      query:        z.string().describe("Natural language topic, e.g. 'NPS national pension system investment statement'"),
      year_from:    z.number().optional().describe("Filter emails from this year onwards"),
      year_to:      z.number().optional().describe("Filter emails up to this year"),
      folder_type:  z.enum(["inbox", "sent", "trash", "junk", "drafts", "custom"]).optional(),
      folder:       z.string().optional().describe("Specific folder path, e.g. 'INBOX' or 'Archive'"),
      domain:       z.string().optional().describe("Sender domain to pre-filter, e.g. 'ppfas.com'. Use only when you are CERTAIN of the exact domain."),
      sender_email: z.string().optional().describe("Exact sender email to pre-filter"),
      limit:        z.number().optional(),
    }),
  },
);

// ── Tool 2: aggregate_stats ───────────────────────────────────────────────────

const aggregateStats = tool(
  async ({ mode, year_from, year_to, limit }) => {
    const stats = await lanceStore.getStats();
    if (stats.total === 0) {
      return JSON.stringify({ error: "index_empty", message: "Index not built yet." });
    }
    try {
      const opts = { limit: limit ?? 20, yearFrom: year_from, yearTo: year_to };
      if (mode === "top_senders") {
        const rows = await lanceStore.topSenders(opts);
        return JSON.stringify({ results: rows.map((r) => ({
          sender:      r.sender_name || r.sender_email,
          email:       r.sender_email,
          domain:      r.domain,
          email_count: r.email_count,
          unread:      r.unread_count,
          last_seen:   new Date(r.last_seen_unix * 1000).toISOString().slice(0, 10),
          size_kb:     Math.round(r.total_bytes / 1024),
        })) });
      }
      if (mode === "top_domains") {
        const rows = await lanceStore.topDomains(opts);
        return JSON.stringify({ results: rows.map((r) => ({
          domain:       r.domain,
          email_count:  r.email_count,
          sender_count: r.sender_count,
          unread:       r.unread_count,
          size_mb:      (r.total_bytes / 1048576).toFixed(1),
        })) });
      }
      if (mode === "overview") {
        return JSON.stringify({ results: [{ total_indexed: stats.total, unique_domains: stats.domains, years: stats.years.join(", ") }] });
      }
      return JSON.stringify({ error: `Unknown mode: ${mode}` });
    } catch (e) {
      return JSON.stringify({ error: (e as Error).message });
    }
  },
  {
    name:        "aggregate_stats",
    description: "Get rankings and counts from indexed email metadata. Use for: 'who emails me most', 'top domains', 'total emails', 'inbox overview'.",
    schema: z.object({
      mode:      z.enum(["top_senders", "top_domains", "overview"]),
      year_from: z.number().optional(),
      year_to:   z.number().optional(),
      limit:     z.number().optional(),
    }),
  },
);

// ── Tool 3: final_answer (Deep mode only) ────────────────────────────────────

const finalAnswer = tool(
  async (args) => JSON.stringify(args),
  {
    name:        "final_answer",
    description: "Output the final structured response. DEEP MODE ONLY — call after semantic_search or aggregate_stats. FAST mode never calls this; reply directly as text instead.",
    schema: z.object({
      intent:          z.string(),
      response_type:   z.enum(["text", "stat_card", "bar_chart", "pie_chart", "line_chart", "data_table", "html_widget"]),
      answer_text:     z.string().describe("1-3 sentence plain-English summary of the answer."),
      rows:            z.array(z.record(z.string(), z.unknown())).optional().describe("One object per data point. NUMERIC values must be plain numbers — NO currency symbols, NO commas (use 362797 not '₹3,62,797'). For bar_chart/pie_chart/line_chart: each row needs exactly one string label field and one numeric value field, e.g. [{\"month\":\"January\",\"amount\":56006}]. For data_table: one row per email."),
      widget_html:     z.string().optional().describe("Only when response_type='html_widget'. A self-contained HTML fragment (see HTML WIDGETS rules)."),
      data_limitation: z.string().optional().describe("If results are incomplete, explain why and what the user can do."),
    }),
  },
);

// ── System prompt ─────────────────────────────────────────────────────────────

async function buildIndexProfileBlock(): Promise<string> {
  try {
    const p = await lanceStore.getIndexProfile();
    if (!p.total) return "";
    const bodyIndexed = await bodyIsIndexed();
    const domains = p.domains.slice(0, 30).map((d) => `${d.domain}(${d.count})`).join(", ");
    const folders = p.folders.slice(0, 25).map((f) => `${f.folder}(${f.count})`).join(", ");
    const years   = p.years.length ? `${Math.min(...p.years)}–${Math.max(...p.years)}` : "n/a";
    return [
      "",
      "INDEX PROFILE (use these REAL values — never invent a domain or folder):",
      `- Years present: ${years}`,
      `- Folders: ${folders}`,
      `- Top sender domains (with counts): ${domains}`,
      `- Body content indexed: ${bodyIndexed ? "YES — email body text appears in results as the 'content' field. READ IT to answer amounts, dates, balances, order numbers." : "NO — only metadata (subject/sender/domain) is indexed. You cannot read email bodies or compute monetary amounts. If asked for totals/balances, explain this limitation and suggest re-indexing with Full Content mode."}`,
      "When the user names a brand/product, pick the matching domain(s) FROM THIS LIST.",
      "If none match, leave domain unset and rely on semantic search. Never filter by a domain not in this list.",
      "",
    ].join("\n");
  } catch {
    return "";
  }
}

function buildSystemPrompt(mode: "fast" | "deep"): string {
  const fast = mode === "fast";

  const modeInstructions = fast
    ? `OUTPUT MODE: FAST
- Search for emails, then REPLY DIRECTLY as a chat message. Do NOT call final_answer.
- Read the results carefully. If "content" is present, read it and quote real figures inline.
- If the first search results look clearly off-topic (wrong category of emails), try one more search with different or broader terms. Then answer with whatever you have.
- Keep it concise — 2–5 sentences. Be direct and helpful.`
    : `OUTPUT MODE: DEEP (visual report)
- Search for emails (and/or aggregate_stats for rankings), then call final_answer with the right response_type.
- PREFER visual chart types over plain tables whenever the user asks for a chart/graph/visualization.
- Choose response_type based on what the user asked:
    bar_chart   → monthly breakdowns, comparisons, rankings by amount or count
    pie_chart   → distribution/share across categories (e.g. "how is my spending split")
    line_chart  → trends over time (e.g. "show my investments over the months")
    data_table  → plain email list or when no chart type fits
    stat_card   → single headline number (e.g. "total invested this year")
    html_widget → rich custom layout combining KPI + table + prose
    text        → short explanations or error messages only
- If the first search results look off-topic, retry with different or broader terms before calling final_answer.
- Always include rows[] with the supporting email data.`;

  const widgetsSection = fast ? "" : `
HTML WIDGETS (response_type="html_widget"):
- Put your visual answer in "widget_html": a SELF-CONTAINED HTML fragment rendered in an isolated sandbox that ALREADY provides padding, fonts, theme colours and table styling.
- USE THE HOST CLASSES instead of inline font-sizes:
    class="eyebrow"  → small uppercase label (e.g. "ETMoney · 2026")
    class="kpi"      → the one headline number (e.g. "₹6,92,350 total") — ONE per widget
    plain <h3>, <p>, <ul>, <table> for everything else.
- ALLOWED: a single root <div>, semantic markup (h2/h3, p, ul/li, table, span), light inline style for colour only (use var(--w-*) tokens).
- FORBIDDEN: <html>/<head>/<body> tags, <script>, event handlers, fixed widths, external resources (no CDN, no <img src=http>).
- Colours: var(--w-fg) text, var(--w-muted) secondary, var(--w-accent) accent, var(--w-border).
- Always ALSO set answer_text to a 1-3 sentence plain summary, and include rows[] with the emails.
- Example:
  <div>
    <div class="eyebrow">ETMoney investments · 2026</div>
    <div class="kpi">₹6,92,350 total</div>
    <table>
      <tr><th>Date</th><th>Fund</th><th>Amount</th></tr>
      <tr><td>2026-01-15</td><td>PPFAS Flexi Cap</td><td>₹50,000</td></tr>
    </table>
  </div>
`;

  return `You are InboxPie, a private on-device email AI assistant powered by a local semantic index.

${dateContext()}

${modeInstructions}

TOOLS:
- semantic_search  → find emails by topic/concept
- aggregate_stats  → counts, rankings, totals from metadata
${fast ? "" : "- final_answer     → output the final structured response (DEEP mode only)\n"}
READING EMAIL CONTENT:
- Each semantic_search result MAY include a "content" field (email body text, present when Full Content indexing is enabled).
- When "content" is present, READ IT to answer detailed questions: amounts, balances, dates, order numbers.
- When "content" is ABSENT, summarise what subjects/senders tell you — never invent body details.
- Be comprehensive: synthesise across results (totals, ranges, patterns) — do not just list emails.
${widgetsSection}
METADATA PRE-FILTERING:
- domain: USE SPARINGLY. Only set when you are CERTAIN of the exact domain. Financial statements often come from third-party senders (registrars, processors) not the brand's main domain. When in doubt, leave unset. If a domain-filtered search returns off-topic results, retry without domain.
- sender_email: use only when the user gives an exact email address.
- year_from / year_to: extract from time expressions.
    "last year"    → year_from=${new Date().getFullYear() - 1}, year_to=${new Date().getFullYear() - 1}
    "this year"    → year_from=${new Date().getFullYear()}, year_to=${new Date().getFullYear()}
    "last 2 years" → year_from=${new Date().getFullYear() - 2}, year_to=${new Date().getFullYear()}

WORKFLOW FOR TOPIC QUERIES (investments, receipts, bookings, etc.):
1. semantic_search — use specific descriptive terms, add year/domain filters when clearly stated in the question
2. Read the results. If they look off-topic (wrong category of emails returned), try one more semantic_search with broader or rephrased terms
3. ${fast ? "Reply directly as text" : "Call final_answer with the best response_type"}

WORKFLOW FOR COUNT/RANKING QUERIES (top senders, who emails me most, overview):
1. aggregate_stats
2. ${fast ? "Reply directly as text" : "Call final_answer"}

RULES:
- Maximum 2 semantic_search calls per turn
- ${fast ? "FAST mode: NEVER call final_answer — reply directly as text" : "DEEP mode: ALWAYS end with final_answer"}
- Never leave the user without an answer — if search finds nothing useful, say so and suggest what to try
- If index is empty: tell the user to go to the Intelligence tab and index their folders first

JSON FORMAT (CRITICAL):
- Use ONLY standard ASCII double-quote " (U+0022) in all tool call arguments
- NEVER use Unicode typographic or curly quote characters: " " ' ' or any variants
- Malformed JSON causes a hard failure — no recovery is possible`;
}

// ── Agent runner ──────────────────────────────────────────────────────────────

type AgentEventFn = (ev: { action: string; tool?: string; label?: string; detail?: string; elapsed?: number; text?: string }) => void;

export async function runAppleMailAgent(
  userMessage: string,
  conversationHistory: Array<{ role: string; content: string }>,
  model: string,
  folders?: string[],
  onEvent?: AgentEventFn,
  mode: "fast" | "deep" = "fast",
  signal?: AbortSignal,
  _retried = false,
  provider = "ollama",
  apiKey?: string,
): Promise<AgentResponse> {
  const agentSteps: AgentStep[]     = [];
  let thinkingText      = "";
  let lastAssistantText = "";
  let semanticRows:  Record<string, unknown>[] | null = null;
  let aggregateRows: Record<string, unknown>[] | null = null;

  const queryStart     = Date.now();
  const toolStartTimes = new Map<string, number>();
  const log  = (...args: unknown[]) => console.log(ts(queryStart), ...args);
  const emit = (tool: string, label: string, detail?: string, elapsed?: number) => {
    log(`[SmartSearch] ${label}${detail ? ` — ${detail}` : ""}${elapsed != null ? ` (${elapsed}ms)` : ""}`);
    onEvent?.({ action: "agentStep", tool, label, detail, elapsed });
  };

  log(`[SmartSearch] ▶ Query: "${userMessage}" | model=${model} | mode=${mode} | folders=${folders?.join(",") || "all"}`);

  if (provider === "ollama") { try { await loadOllamaThinkingModels(); } catch { /* offline */ } }
  const llm = createLLM(provider, model, apiKey);

  const folderScope = folders && folders.length
    ? `\nFOLDER SCOPE: The user has scoped this query to: ${folders.map((f) => `"${f}"`).join(", ")}. Pass folder=<path> when calling semantic_search.\n`
    : "";

  const profileBlock = await buildIndexProfileBlock();

  const tools = mode === "fast"
    ? [semanticSearch, aggregateStats]
    : [semanticSearch, aggregateStats, finalAnswer];

  const agent = createReactAgent({
    llm,
    tools,
    prompt: buildSystemPrompt(mode) + folderScope + profileBlock,
  });

  const historyMessages = conversationHistory.slice(-8).map((m) =>
    m.role === "user" ? new HumanMessage(m.content) : new AIMessage(m.content),
  );

  let finalArgs: {
    intent: string;
    response_type: "text" | "stat_card" | "bar_chart" | "data_table" | "html_widget";
    answer_text: string;
    rows?: Record<string, unknown>[];
    widget_html?: string;
    data_limitation?: string;
  } | null = null;

  try {
    const stream = agent.streamEvents(
      { messages: [...historyMessages, new HumanMessage(userMessage)] },
      { version: "v2", recursionLimit: RECURSION_LIMIT, signal },
    );

    for await (const event of stream) {
      if (event.event === "on_tool_start") {
        const name  = event.name as string;
        const raw   = event.data?.input as Record<string, unknown> | undefined;
        const input = (raw?.input ?? raw) as Record<string, unknown> | undefined;
        toolStartTimes.set(name, Date.now());

        switch (name) {
          case "semantic_search": {
            const q = String(input?.query ?? "").trim();
            const fbits: string[] = [];
            if (input?.domain)       fbits.push(`domain=${input.domain}`);
            if (input?.sender_email) fbits.push(`from=${input.sender_email}`);
            if (input?.folder)       fbits.push(`folder=${input.folder}`);
            if (input?.year_from || input?.year_to) fbits.push(`years ${input?.year_from ?? "…"}–${input?.year_to ?? "…"}`);
            const detail = q
              ? `"${q}"${fbits.length ? "  ·  " + fbits.join(" · ") : ""}`
              : (fbits.length ? fbits.join(" · ") : undefined);
            log(`[SmartSearch] 🔍 semantic_search: ${detail ?? "(broad)"}`);
            emit("semantic_search", "Searching emails", detail);
            agentSteps.push({ type: "intent", label: "Searching emails", detail });
            break;
          }
          case "aggregate_stats": {
            const m = String(input?.mode ?? "").trim();
            log(`[SmartSearch] 📊 aggregate_stats: mode=${m}`);
            emit("aggregate_stats", "Computing stats", m);
            agentSteps.push({ type: "intent", label: "Aggregate stats", detail: m || undefined });
            break;
          }
          case "final_answer":
            log("[SmartSearch] 💬 final_answer");
            emit("final_answer", "Composing answer");
            agentSteps.push({ type: "result", label: "Composing answer" });
            break;
        }
      }

      if (event.event === "on_tool_end") {
        const name    = event.name as string;
        const output  = extractOutput(event.data?.output);
        const elapsed = Date.now() - (toolStartTimes.get(name) ?? Date.now());

        if (name === "semantic_search") {
          try {
            const parsed = JSON.parse(output);
            if (parsed.error === "index_empty") {
              log("[SmartSearch] ❌ Index empty");
              emit("semantic_search", "Index not built", parsed.message, elapsed);
              agentSteps.push({ type: "error", label: "Index not built", detail: parsed.message });
            } else if (Array.isArray(parsed.results)) {
              semanticRows = parsed.results;
              log(`[SmartSearch] ✅ ${parsed.results.length} results in ${elapsed}ms`);
              parsed.results.slice(0, 5).forEach((r: Record<string, unknown>, i: number) =>
                log(`  [${i + 1}] ${r.subject ?? r.sender} (${r.relevance ?? ""})`),
              );
              emit("semantic_search", `Found ${parsed.results.length} matching emails`, undefined, elapsed);
              agentSteps.push({ type: "result", label: `Found ${parsed.results.length} matching emails` });
            } else {
              log("[SmartSearch] ⚠ No results");
              emit("semantic_search", "No matches found", undefined, elapsed);
              agentSteps.push({ type: "retry", label: "No semantic matches" });
            }
          } catch { /* */ }
        }

        if (name === "aggregate_stats") {
          try {
            const parsed = JSON.parse(output);
            if (Array.isArray(parsed.results)) {
              aggregateRows = parsed.results;
              log(`[SmartSearch] 📊 aggregate_stats: ${parsed.results.length} rows in ${elapsed}ms`);
              emit("aggregate_stats", "Stats ready", `${parsed.results.length} rows`, elapsed);
              agentSteps.push({ type: "result", label: "Stats", detail: `${parsed.results.length} rows` });
            }
          } catch { /* */ }
        }

        if (name === "final_answer") {
          try { finalArgs = JSON.parse(output); } catch { /* */ }
        }
      }

      if (event.event === "on_chat_model_stream") {
        const chunk: any = (event.data as any)?.chunk;
        const ak     = chunk?.additional_kwargs ?? chunk?.kwargs?.additional_kwargs ?? {};
        const reason = ak?.reasoning_content ?? ak?.reasoning;
        if (typeof reason === "string" && reason) onEvent?.({ action: "agentReasoning", text: reason });
        const c = chunk?.content ?? chunk?.kwargs?.content;
        let piece = "";
        if (typeof c === "string") piece = c;
        else if (Array.isArray(c)) piece = c.map((x: any) => (typeof x === "string" ? x : (x?.text ?? ""))).join("");
        if (piece) onEvent?.({ action: "agentToken", text: piece });
      }

      if (event.event === "on_chat_model_end") {
        const g0         = (event.data?.output?.generations as Array<Array<any>> | undefined)?.[0]?.[0];
        const msg        = g0?.message;
        const rawContent = msg?.content;
        const contentStr = typeof rawContent === "string"
          ? rawContent
          : Array.isArray(rawContent) ? rawContent.map((x: any) => (typeof x === "string" ? x : (x?.text ?? ""))).join("") : "";
        const reasoning  = msg?.additional_kwargs?.reasoning_content ?? "";
        const fullText   = String(g0?.text ?? "");

        if (!thinkingText) {
          const m = fullText.match(/<think>([\s\S]*?)<\/think>/i);
          const r = (typeof reasoning === "string" && reasoning.trim()) ? reasoning.trim() : (m ? m[1].trim() : "");
          if (r) {
            thinkingText = r;
            agentSteps.push({ type: "think", label: "Model reasoning", detail: thinkingText });
          }
        }
        const visible = (contentStr.trim() || fullText.replace(/<think>[\s\S]*?<\/think>/gi, "").trim());
        if (visible) lastAssistantText = visible;
      }
    }
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    if (signal?.aborted || (e as Error).name === "AbortError") {
      log(`[SmartSearch] ⛔ Cancelled after ${Date.now() - queryStart}ms`);
      return { intent: "cancelled", response_type: "text", answer_text: "Query cancelled.", thinking: thinkingText, agentSteps };
    }
    if (!_retried && msg.includes("error parsing tool call")) {
      log(`[SmartSearch] ⚠ Ollama tool-call JSON parse error — retrying once`);
      emit("think", "Retrying", "Model produced malformed JSON — trying again");
      return runAppleMailAgent(userMessage, conversationHistory, model, folders, onEvent, mode, signal, true, provider, apiKey);
    }
    log(`[SmartSearch] ❌ Agent error after ${Date.now() - queryStart}ms:`, msg);
    if (semanticRows || aggregateRows) {
      const rows = semanticRows ?? aggregateRows ?? [];
      const fallbackType: AgentResponse["response_type"] = mode === "fast"
        ? "text"
        : aggregateRows ? "bar_chart" : "data_table";
      return {
        intent:        userMessage,
        response_type: fallbackType,
        answer_text:   `Found ${rows.length} result(s). The agent reached its step limit — showing best available results.`,
        rows:          mode === "deep" ? rows : undefined,
        thinking:      thinkingText,
        agentSteps,
      };
    }
    agentSteps.push({ type: "error", label: "Agent error", detail: msg });
    return { intent: "error", response_type: "text", answer_text: `Agent error: ${msg}`, error: msg, thinking: thinkingText, agentSteps };
  }

  // ── No final_answer called (common for Fast mode and many local models) ───
  if (!finalArgs) {
    const rows   = semanticRows ?? aggregateRows;
    const answer = lastAssistantText.trim();
    if (answer) {
      log(`[SmartSearch] ⚠ No final_answer — using model text answer (${answer.length} chars)`);
      const withRows = mode === "deep" && rows && rows.length > 0;
      return {
        intent:        userMessage,
        response_type: withRows ? "data_table" : "text",
        answer_text:   answer,
        rows:          withRows ? rows : undefined,
        thinking:      thinkingText,
        agentSteps,
      };
    }
    if (rows && rows.length > 0) {
      if (mode === "fast") {
        return {
          intent:        userMessage,
          response_type: "text" as const,
          answer_text:   `Found ${rows.length} relevant email(s). Try rephrasing your question for a better summary.`,
          thinking:      thinkingText,
          agentSteps,
        };
      }
      return {
        intent:        userMessage,
        response_type: aggregateRows ? "bar_chart" : "data_table",
        answer_text:   `Found ${rows.length} relevant result(s).`,
        rows,
        thinking:  thinkingText,
        agentSteps,
      };
    }
    const { total: indexTotal } = await lanceStore.getStats();
    return {
      intent:        "unknown",
      response_type: "text",
      answer_text:   indexTotal === 0
        ? "Please go to the Intelligence tab and index your folders to enable AI Search."
        : "Could not find results for that query. Try rephrasing with more specific terms.",
      thinking: thinkingText,
      agentSteps,
    };
  }

  // ── Fast mode → plain text only ──────────────────────────────────────────
  if (mode === "fast") {
    log(`[SmartSearch] ✅ Done (fast) in ${Date.now() - queryStart}ms`);
    return {
      intent:        finalArgs.intent,
      response_type: "text",
      answer_text:   finalArgs.answer_text || lastAssistantText || "—",
      thinking:      thinkingText,
      agentSteps,
    };
  }

  // ── Deep mode: rich output (widget / table / chart) ──────────────────────
  const finalRows = (finalArgs.rows && finalArgs.rows.length > 0)
    ? finalArgs.rows
    : (semanticRows ?? aggregateRows ?? undefined);

  let finalType  = finalArgs.response_type;
  const hasWidget = finalType === "html_widget" && !!finalArgs.widget_html?.trim();
  if (!hasWidget && finalRows && finalRows.length > 0 && finalType === "text") {
    finalType = aggregateRows && !semanticRows ? "bar_chart" : "data_table";
  }
  if (finalType === "html_widget" && !hasWidget) {
    finalType = finalRows && finalRows.length > 0 ? "data_table" : "text";
  }

  log(`[SmartSearch] ✅ Done in ${Date.now() - queryStart}ms | type=${finalType} | rows=${finalRows?.length ?? 0}`);
  return {
    intent:        finalArgs.intent,
    response_type: finalType,
    answer_text:   finalArgs.answer_text,
    rows:          finalRows,
    widget_html:   hasWidget ? finalArgs.widget_html : undefined,
    thinking:      thinkingText,
    agentSteps,
  };
}
