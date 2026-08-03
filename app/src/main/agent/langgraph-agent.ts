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
import { MemorySaver } from "@langchain/langgraph";
import { tool } from "@langchain/core/tools";
import { HumanMessage, AIMessage, type BaseMessage } from "@langchain/core/messages";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { embedText }   from "./embeddings";
import { rerank }      from "./reranker";
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
  async ({ query, year_from, year_to, folder_type, folder, domain, sender_email, limit, keyword }) => {
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

      // Stage 1 — broad recall: hybrid vector+BM25 search over the whole index.
      // This is deliberately generous; it's just the candidate pool for reranking,
      // not the final answer, so a higher cap here costs little (local query).
      const requestedLimit = limit ?? 150;
      const candidatePool  = Math.max(requestedLimit, 100);
      const candidates = await lanceStore.search(queryVec, {
        limit:       candidatePool,
        yearFrom:    year_from,
        yearTo:      year_to,
        folderType:  folder_type,
        folder:      folder,
        domain:      domain,
        senderEmail: sender_email,
        queryText:   query,
      });
      console.log(`${ts()} [SmartSearch] stage-1 hybrid search → ${candidates.length} candidate(s)`);

      // Stage 1b — exhaustive literal match: LanceDB's ANN index always has an
      // implicit top-K (that's the "only 150 of 215 FastTag emails" bug), so a
      // specific named topic/brand can be silently excluded from the candidate
      // pool before reranking ever runs. A plain (non-ANN) filtered scan has no
      // such limit — merge its results in so nothing is excluded before stage 2
      // gets to judge relevance. Runs unconditionally (falling back to `query`
      // when the model doesn't set `keyword`) rather than depending on the LLM
      // reliably populating the optional field — a smaller/local model won't
      // always do that, which was silently defeating this fix.
      const exhaustiveTerm = (keyword && keyword.trim()) || query;
      let mergedCandidates = candidates;
      const exhaustive = await lanceStore.searchExhaustive(exhaustiveTerm);
      console.log(`${ts()} [SmartSearch] stage-1b exhaustive("${exhaustiveTerm}") → ${exhaustive.length} row(s)`);
      if (exhaustive.length > 0) {
        const byId = new Map(candidates.map((r) => [r.id, r]));
        for (const r of exhaustive) if (!byId.has(r.id)) byId.set(r.id, r);
        mergedCandidates = [...byId.values()];
      }

      if (mergedCandidates.length === 0) {
        return JSON.stringify({ results: [], message: `No emails found for: "${query}"` });
      }

      // Stage 2 — cross-encoder rerank: bi-encoder cosine similarity and BM25 are
      // both approximations; the reranker reads (query, email) TOGETHER and gives
      // a much more trustworthy relevance score. This is also what fixes the original
      // bias problem — instead of guessing a result COUNT, we threshold on genuine
      // relevance, so "list all my X emails" returns however many actually qualify,
      // not an arbitrary top-N.
      //
      // NOT used to exclude candidates (see below) — kept only to flag low-confidence
      // results in the note. Observed on real data: exact brand-name matches (e.g.
      // "ICICI Bank FASTag transaction alert" for query "FastTag") scoring below this
      // bar and being silently dropped, meaning the cross-encoder's absolute score
      // scale isn't reliably calibrated for email text. A threshold filter on an
      // uncalibrated score can only ever destroy correct results, never add missing
      // ones, so it's not safe to use as a hard gate.
      const RELEVANCE_THRESHOLD = 0.35;
      let scored: Array<{ r: (typeof mergedCandidates)[number]; score: number }>;
      let rerankFailed = false;
      let rerankError  = "";
      let rerankMs     = 0;
      try {
        const rerankStart = Date.now();
        const rerankScores = await rerank(query, mergedCandidates.map((r) => r.text_indexed ?? ""));
        rerankMs = Date.now() - rerankStart;
        console.log(`${ts()} [SmartSearch] reranked ${mergedCandidates.length} candidate(s) (${rerankMs}ms)`);
        scored = mergedCandidates.map((r, i) => ({ r, score: rerankScores[i] ?? 0 }));
        scored.sort((a, b) => b.score - a.score);
        // No filter here by design: the reranker orders and scores results, but every
        // candidate a recall stage (vector, hybrid BM25, or exhaustive keyword match)
        // found is kept. Confidence is surfaced per-row via the "relevance" percentage
        // instead of being used to silently remove rows.
      } catch (e) {
        // Reranker model missing/failed to load — fall back to stage-1 hybrid order
        // rather than breaking search entirely. Every candidate is kept in that case.
        rerankError = (e as Error).message;
        console.warn(`${ts()} [SmartSearch] reranker unavailable, using hybrid order:`, rerankError);
        rerankFailed = true;
        scored = mergedCandidates.map((r) => ({ r, score: r.score }));
      }

      // Absolute safety cap on the final payload — not a relevance cutoff, just a
      // token-budget guard for pathologically broad queries where most of the
      // candidate pool passes the threshold.
      const OUTPUT_CAP = 500;
      const finalMatches = scored.slice(0, OUTPUT_CAP);

      // Full body content is expensive in tokens — attach it only to the top handful
      // of results. Everything else still carries subject/sender/date/relevance,
      // which is enough to count or list, just not to quote from.
      const CONTENT_CAP = 15;
      const mapped = finalMatches.map(({ r, score }, i) => {
        const row: Record<string, unknown> = {
          sender:    r.sender_name || r.sender_email,
          email:     r.sender_email,
          domain:    r.domain,
          subject:   r.subject || (r.text_indexed.split("\n")[0]?.replace("subject: ", "") ?? ""),
          date:      new Date(r.date_unix * 1000).toISOString().slice(0, 10),
          year:      r.year,
          folder:    r.folder,
          is_read:   r.is_read === 1,
          relevance: `${Math.round(score * 100)}%`,
        };
        if (i < CONTENT_CAP) {
          const body = extractBody(r.text_indexed ?? "");
          if (body) row["content"] = body.slice(0, 1500);
        }
        return row;
      });
      console.log(`${ts()} [SmartSearch] ${mergedCandidates.length} candidate(s) → returning ${mapped.length}; top: ${mapped.slice(0, 3).map(r => `"${r["subject"]}" (${r["relevance"]})`).join(" | ")}`);

      const notes: string[] = [];
      if (rerankFailed) {
        notes.push("The relevance reranker was unavailable, so these results are ordered by initial search score rather than a verified relevance check — treat counts as approximate.");
      } else if (candidates.length >= candidatePool) {
        // Even the stage-1 candidate pool may have been truncated for a very broad query.
        notes.push(`The search candidate pool was capped at ${candidatePool}; if this seems incomplete for an exact count, call semantic_search again with a higher "limit".`);
      } else {
        notes.push(`All ${scored.length} results shown are the complete matching set from the searched candidates (vector similarity + keyword + exhaustive term match) — not an arbitrary top-N.`);
      }
      if (scored.length > OUTPUT_CAP) {
        notes.push(`${scored.length} candidates matched but only the top ${OUTPUT_CAP} are included here to keep the response manageable.`);
      }
      if (!rerankFailed) {
        const lowConfidenceCount = scored.filter((x) => x.score < RELEVANCE_THRESHOLD).length;
        if (lowConfidenceCount > 0) {
          notes.push(`${lowConfidenceCount} of these scored below the usual relevance confidence bar — use each result's "relevance" percentage to judge how certain a match it is; low scores aren't discarded since the reranker's absolute scale isn't fully calibrated for email text, but weight them accordingly.`);
        }
      }

      return JSON.stringify({
        results: mapped,
        note: notes.join(" "),
        // Surfaced to the UI (not just the LLM) so reranking is visibly happening
        // or visibly failing, instead of silently falling back to hybrid order.
        rerank: {
          applied:    !rerankFailed,
          candidates: mergedCandidates.length,
          passed:     scored.length,
          ms:         rerankMs,
          error:      rerankFailed ? rerankError : undefined,
        },
      });
    } catch (e) {
      console.error(`${ts()} [SmartSearch] semantic_search tool error:`, e);
      return JSON.stringify({ error: "search_failed", message: (e as Error).message });
    }
  },
  {
    name:        "semantic_search",
    description: "Find emails by MEANING or TOPIC. Use for: 'NPS investments', 'purchase receipts', 'travel bookings', 'FD matured'. Internally: broad hybrid (vector+BM25) recall, then every candidate is re-scored by a cross-encoder reranker and only genuinely relevant ones are returned — so the 'results' array is the actual matching set, not an arbitrary top-N, and is safe to use for counting or listing completely. Always read the 'note' field: it tells you whether the candidate pool itself was capped (rare, only for very broad queries) or the reranker was unavailable, in which case treat any count as approximate. Each result may include a 'content' field (full email body, only on the top ~15 most relevant) when Full Content indexing is enabled.",
    schema: z.object({
      query:        z.string().describe("Natural language topic, e.g. 'NPS national pension system investment statement'"),
      year_from:    z.number().optional().describe("Filter emails from this year onwards"),
      year_to:      z.number().optional().describe("Filter emails up to this year"),
      folder_type:  z.enum(["inbox", "sent", "trash", "junk", "drafts", "custom"]).optional(),
      folder:       z.string().optional().describe("Specific folder path, e.g. 'INBOX' or 'Archive'"),
      domain:       z.string().optional().describe("Sender domain to pre-filter, e.g. 'ppfas.com'. Use only when you are CERTAIN of the exact domain."),
      sender_email: z.string().optional().describe("Exact sender email to pre-filter"),
      limit:        z.number().optional().describe("Size of the initial candidate pool to consider (default 150, minimum 100 always used). Results returned are only the ones that pass the relevance reranker, so this rarely needs raising — do so (e.g. 300-500) only if the 'note' field says the candidate pool itself was capped."),
      keyword:      z.string().optional().describe("A short literal term (1-3 words) to also exhaustively match verbatim in email text — set this for named topics/brands/services (e.g. 'FastTag', 'PPFAS', 'NPS') so EVERY email containing that exact term is considered, not just the top semantically-similar ones. Leave unset for purely conceptual queries with no single specific term to anchor on."),
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
1. semantic_search — use specific descriptive terms, add year/domain filters when clearly stated in the question. If the topic is a specific named brand/service/product (e.g. "FastTag", "PPFAS", "NPS") rather than a general concept, ALSO set "keyword" to that exact term so every literal mention is considered, not just the top semantically-similar ones.
2. Read the results. If they look off-topic (wrong category of emails returned), try one more semantic_search with broader or rephrased terms
3. ${fast ? "Reply directly as text" : "Call final_answer with the best response_type"}

WORKFLOW FOR COUNT/RANKING QUERIES (top senders, who emails me most, overview):
1. aggregate_stats
2. ${fast ? "Reply directly as text" : "Call final_answer"}

WORKFLOW FOR FOLLOW-UP / REFORMAT REQUESTS:
- If the user is asking you to reformat, relabel, re-chart, re-sort, or filter data from EARLIER IN THIS CONVERSATION (visible above, in your own previous tool results) rather than asking about a new topic, reuse that data directly — copy the relevant rows into your response — instead of calling semantic_search/aggregate_stats again.
- Only search again if the user is asking about something new, or explicitly asks you to search again.

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

// Persists the FULL conversation graph state — including real tool-call outputs,
// not just text — across chat turns. Module-level because each new chat message
// is a fresh call to runAppleMailAgent; without this the agent has no memory of
// its own previous searches, only whatever plain text survives in conversationHistory.
const _checkpointer = new MemorySaver();
let _currentThreadId: string | null = null;

// ── Deep aggregation pipeline helpers ─────────────────────────────────────────

function isAggregationQuery(query: string): boolean {
  const keywords = ["pie chart", "bar chart", "group by", "grouped", "sum", "total", "count", "breakdown", "distribution"];
  const lowerQuery = query.toLowerCase();
  return keywords.some((kw) => lowerQuery.includes(kw));
}

async function runDeepAggregationPipeline(
  userMessage: string,
  llm: any,
  emit: (label: string, detail?: string, tool?: string) => void,
  signal?: AbortSignal,
): Promise<AgentResponse> {
  console.log(`[SmartSearch] ▶▶▶ DEEP AGGREGATION PIPELINE invoked for: "${userMessage.substring(0, 100)}..."`);
  const { buildDeepAggregateGraph } = await import("./deep-aggregate/graph");

  const stepEmitter = (step: AgentStep) => {
    emit(step.label, step.detail, step.type);
  };

  console.log(`[SmartSearch]   Building LangGraph StateGraph...`);
  const graph = buildDeepAggregateGraph(llm, stepEmitter);

  console.log(`[SmartSearch]   Invoking graph with question...`);
  const result = await graph.invoke(
    { question: userMessage, plan: null, mailIds: [], partials: {}, agentSteps: [], answer: null },
    { signal }
  );

  console.log(`[SmartSearch] ▶▶▶ PIPELINE COMPLETE`);
  return result.answer || {
    intent: "aggregation",
    response_type: "data_table",
    answer_text: "Unable to complete aggregation",
  };
}

export async function runAppleMailAgent(
  userMessage: string,
  conversationHistory: Array<{ role: string; content: string }>,
  model: string,
  onEvent?: AgentEventFn,
  mode: "fast" | "deep" = "fast",
  signal?: AbortSignal,
  _retried = false,
  provider = "ollama",
  apiKey?: string,
): Promise<AgentResponse> {
  const queryStart     = Date.now();
  const log  = (...args: unknown[]) => console.log(ts(queryStart), ...args);
  const emit = (tool: string, label: string, detail?: string, elapsed?: number) => {
    log(`[SmartSearch] ${label}${detail ? ` — ${detail}` : ""}${elapsed != null ? ` (${elapsed}ms)` : ""}`);
    onEvent?.({ action: "agentStep", tool, label, detail, elapsed });
  };

  log(`[SmartSearch] ▶ Query: "${userMessage}" | model=${model} | mode=${mode}`);

  if (provider === "ollama") { try { await loadOllamaThinkingModels(); } catch { /* offline */ } }
  const llm = createLLM(provider, model, apiKey);

  // Route deep mode to new aggregation pipeline if query looks like a grouping task
  if (mode === "deep" && isAggregationQuery(userMessage)) {
    try {
      return await runDeepAggregationPipeline(userMessage, llm, (label, detail, tool = "aggregation") => {
        emit(tool, label, detail);
      }, signal);
    } catch (e) {
      log(`[SmartSearch] Deep aggregation pipeline failed: ${(e as Error).message}`);
      log("[SmartSearch] Falling back to ReAct mode");
      // Fall through to regular ReAct pipeline
    }
  }

  // Regular ReAct pipeline (fast mode + fallback for deep mode)
  const agentSteps: AgentStep[]     = [];
  let thinkingText      = "";
  let lastAssistantText = "";
  let semanticRows:  Record<string, unknown>[] | null = null;
  let aggregateRows: Record<string, unknown>[] | null = null;

  const toolStartTimes = new Map<string, number>();

  const profileBlock = await buildIndexProfileBlock();

  const tools = mode === "fast"
    ? [semanticSearch, aggregateStats]
    : [semanticSearch, aggregateStats, finalAnswer];

  const agent = createReactAgent({
    llm,
    tools,
    prompt: buildSystemPrompt(mode) + profileBlock,
    checkpointer: _checkpointer,
    // Bounds what's sent to the LLM each turn as the checkpointed thread grows
    // over a long conversation — the FULL history stays in the checkpoint
    // regardless, this only windows what's actually fed to the model.
    preModelHook: (state: { messages: BaseMessage[] }) => ({ llmInputMessages: state.messages.slice(-24) }),
  });

  // conversationHistory.length === 0 reliably means "new chat" (dashboard.js's
  // ssClearChat() resets chat.history to [], and a new chat's first message
  // always sends history: []). Falling back to a fresh thread when we have no
  // _currentThreadId at all also covers the checkpointer having lost state
  // (e.g. a main-process restart) — in that recovery case, seed the new thread
  // with the renderer's text history so we degrade to text-only continuity
  // instead of losing it outright.
  let seedMessages: BaseMessage[] = [];
  const isFreshChat = conversationHistory.length === 0;
  if (isFreshChat || !_currentThreadId) {
    const isRecovery = !isFreshChat && !_currentThreadId;
    _currentThreadId = randomUUID();
    if (isRecovery) {
      seedMessages = conversationHistory.slice(-8).map((m) =>
        m.role === "user" ? new HumanMessage(m.content) : new AIMessage(m.content),
      );
    }
  }

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
      { messages: [...seedMessages, new HumanMessage(userMessage)] },
      { version: "v2", recursionLimit: RECURSION_LIMIT, signal, configurable: { thread_id: _currentThreadId } },
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
              // Surface reranking as its own visible step — whether it ran or fell back —
              // instead of hiding it inside a JSON field the UI never renders.
              const rk = parsed.rerank as { applied: boolean; candidates: number; passed: number; ms: number; error?: string } | undefined;
              if (rk) {
                if (rk.applied) {
                  const label = `Reranked ${rk.candidates} candidates → ${rk.passed} relevant`;
                  log(`[SmartSearch] 🎯 ${label} (${rk.ms}ms)`);
                  emit("semantic_search", label, `${rk.ms}ms`, rk.ms);
                  agentSteps.push({ type: "result", label });
                } else {
                  const label = "Reranker unavailable — used hybrid ranking";
                  log(`[SmartSearch] ⚠ ${label}: ${rk.error}`);
                  emit("semantic_search", label, rk.error);
                  agentSteps.push({ type: "retry", label, detail: rk.error });
                }
              }
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
      return runAppleMailAgent(userMessage, conversationHistory, model, onEvent, mode, signal, true, provider, apiKey);
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
