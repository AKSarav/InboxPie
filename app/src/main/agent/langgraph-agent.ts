/**
 * Agentic semantic email assistant — ADR 006 Phase 4 (validation loop)
 *
 * Tools:
 *   semantic_search   — vector similarity search over indexed emails
 *   validate_results  — CODE-SIDE relevance check (no extra LLM call); returns
 *                       verdict + refined query suggestion when results are poor
 *   aggregate_stats   — counts / rankings from indexed metadata
 *   final_answer      — structured response, ends the loop
 *
 * Flow: search → validate → [refine & search again] → final_answer
 * Max 2 semantic searches per turn; always terminates with final_answer.
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

/**
 * True when the vector index actually contains email body text (Full Content mode).
 * Checks the LanceDB index directly — the SQLite `mails` mirror can't be used because
 * the metadata scan (envelope index = Message-ID) and the content scan (emlx = file stem)
 * use different id schemes, so the per-mail flag may not match. LanceDB is the search
 * source of truth, so we read body presence straight from it.
 */
async function bodyIsIndexed(): Promise<boolean> {
  try {
    return await lanceStore.hasBodyContent();
  } catch {
    return false;
  }
}

// ── Timestamp helper ──────────────────────────────────────────────────────────
function ts(start?: number): string {
  const now  = new Date();
  const hh   = String(now.getHours()).padStart(2, "0");
  const mm   = String(now.getMinutes()).padStart(2, "0");
  const ss   = String(now.getSeconds()).padStart(2, "0");
  const ms   = String(now.getMilliseconds()).padStart(3, "0");
  const abs  = `[${hh}:${mm}:${ss}.${ms}]`;
  return start != null ? `${abs} [+${Date.now() - start}ms]` : abs;
}

// LangGraph may wrap tool outputs in a ToolMessage object.
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

const RECURSION_LIMIT = 16; // enough for 2 searches + 2 validations + final_answer

// ── Date context ──────────────────────────────────────────────────────────────

function dateContext(): string {
  const now = new Date();
  const y   = now.getFullYear();
  return [
    `TODAY: ${now.toISOString().slice(0, 10)}`,
    `"This year" = year ${y}`,
    `"Last year" = year ${y - 1}`,
  ].join("\n");
}

// ── Noise / relevance patterns ────────────────────────────────────────────────

const NOISE_PATTERNS = /\botp\b|one.time.pass|verif(ication|y)|security.code|login.alert|sign.in.attempt/i;
const AMOUNT_PATTERNS = /how much|total amount|invested|portfolio value|balance|net worth|returns|gain|profit|loss/i;

// Words that don't help keyword matching (stop words + common email words)
const STOP_WORDS = new Set([
  "what","when","where","which","have","that","this","with","from",
  "list","show","find","many","much","been","your","about","some",
  "emails","email","mail","sent","received","inbox","last","year",
  "give","all","the","and","for","not","you","are","was","but",
  "how","did","does","can","will","get","any","more","most",
]);

function queryKeywords(question: string): string[] {
  return question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 3 && !STOP_WORDS.has(w));
}

// ── Tool 1: semantic_search ───────────────────────────────────────────────────

const semanticSearch = tool(
  async ({ query, year_from, year_to, folder_type, folder, domain, sender_email, limit }) => {
    const stats = await lanceStore.getStats();
    if (stats.total === 0) {
      return JSON.stringify({
        error: "index_empty",
        message: "The semantic index has not been built yet. Tell the user to go to the Intelligence tab and index their folders.",
      });
    }
    try {
      console.log(`${ts()} [SmartSearch] embedText("${query}")`);
      const embedStart = Date.now();
      const queryVec = await embedText(query);
      console.log(`${ts()} [SmartSearch] embedding ready dim=${queryVec.length} (${Date.now() - embedStart}ms), searching…`);
      const results  = await lanceStore.search(queryVec, {
        limit:       limit ?? 25,
        yearFrom:    year_from,
        yearTo:      year_to,
        folderType:  folder_type,
        folder:      folder,
        domain:      domain,
        senderEmail: sender_email,
        queryText:   query,   // enables hybrid (vector + BM25 full-text) + RRF rerank
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
        // Include the indexed email body so the LLM can read amounts, details, etc.
        // (Only present when the folder was indexed in Full Content mode.)
        // HTML emails carry boilerplate before the real content, so keep enough.
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
    name: "semantic_search",
    description:
      "Find emails by MEANING or TOPIC. Use for: 'NPS investments', 'purchase receipts', " +
      "'travel bookings', 'FD matured'. Returns a JSON object with a 'results' array.",
    schema: z.object({
      query:        z.string().describe("Natural language topic, e.g. 'NPS national pension system investment statement'"),
      year_from:    z.number().optional().describe("Filter emails from this year onwards, e.g. 2024 for 'last year'"),
      year_to:      z.number().optional().describe("Filter emails up to this year, e.g. 2024 for 'last year'"),
      folder_type:  z.enum(["inbox", "sent", "trash", "junk", "drafts", "custom"]).optional(),
      folder:       z.string().optional().describe("Specific folder path, e.g. 'INBOX' or 'Archive'"),
      domain:       z.string().optional().describe("Sender domain to pre-filter, e.g. 'ppfas.com' or 'hdfcbank.com'. Extract from company names in the question."),
      sender_email: z.string().optional().describe("Exact sender email to pre-filter, e.g. 'statements@ppfas.com'"),
      limit:        z.number().optional(),
    }),
  },
);

// ── Tool 2: validate_results — pure code, no LLM call ────────────────────────

interface ValidateVerdict {
  verdict:    "proceed" | "refine" | "no_results" | "data_gap";
  quality:    "good" | "mixed" | "poor";
  reason:     string;
  refined_query?: string;
  data_gap_note?: string;
  relevant_count: number;
  noise_count:    number;
  total:          number;
}

const validateResults = tool(
  async ({ original_question, subjects, result_count }): Promise<string> => {
    const total   = result_count;
    const subjArr = (subjects as string[]).slice(0, 30);

    // ── No results at all ─────────────────────────────────────────────────────
    if (total === 0) {
      const qk = queryKeywords(original_question).join(" ");
      return JSON.stringify({
        verdict: "refine",
        quality: "poor",
        reason:  "No results found for this query.",
        refined_query: `${qk} notification update statement`,
        relevant_count: 0, noise_count: 0, total: 0,
      } satisfies ValidateVerdict);
    }

    // ── Data gap detection ────────────────────────────────────────────────────
    // Questions asking for amounts/balances need email BODY content, not just metadata.
    // Only flag a data gap when the index is metadata-only. If Full Content indexing
    // is active, the body text is in the search results — let the LLM read it and answer.
    if (AMOUNT_PATTERNS.test(original_question) && !(await bodyIsIndexed())) {
      const qk = queryKeywords(original_question).join(" ");
      return JSON.stringify({
        verdict: "data_gap",
        quality: "mixed",
        reason:
          "The question asks for monetary amounts or portfolio values. " +
          "This index was built in metadata-only mode (subjects, senders, domains) — " +
          "email bodies were not indexed, so amounts cannot be read. " +
          "InboxPie can show which organisations sent you investment emails, but cannot compute totals.",
        refined_query: `${qk} statement confirmation`,
        relevant_count: 0, noise_count: 0, total,
        data_gap_note:
          "To answer 'how much invested', re-scan with Full Content indexing enabled (AI Settings → " +
          "Indexing → Read full content), or use the Reindex button on the selected folders.",
      } satisfies ValidateVerdict);
    }

    // ── OTP / noise flood ─────────────────────────────────────────────────────
    const noiseCount   = subjArr.filter(s => NOISE_PATTERNS.test(s)).length;
    const noiseRate    = subjArr.length > 0 ? noiseCount / subjArr.length : 0;

    // ── Keyword relevance ─────────────────────────────────────────────────────
    const qKeywords     = queryKeywords(original_question);
    const relevantCount = subjArr.filter(s =>
      qKeywords.some(w => s.toLowerCase().includes(w)),
    ).length;
    const relevanceRate = subjArr.length > 0 ? relevantCount / subjArr.length : 0;

    // ── Verdict ───────────────────────────────────────────────────────────────
    if (noiseRate > 0.5) {
      const clean = queryKeywords(original_question).join(" ");
      return JSON.stringify({
        verdict:       "refine",
        quality:       "poor",
        reason:        `${Math.round(noiseRate * 100)}% of results are OTP / security emails — not what the user asked for.`,
        refined_query: `${clean} statement confirmation portfolio account`,
        relevant_count: relevantCount, noise_count: noiseCount, total,
      } satisfies ValidateVerdict);
    }

    if (relevanceRate < 0.15 && total > 5) {
      const clean = queryKeywords(original_question).join(" ");
      return JSON.stringify({
        verdict:       "refine",
        quality:       "poor",
        reason:        `Only ${Math.round(relevanceRate * 100)}% of results match the query keywords.`,
        refined_query: `${clean} notification update report`,
        relevant_count: relevantCount, noise_count: noiseCount, total,
      } satisfies ValidateVerdict);
    }

    const quality = noiseRate > 0.25 ? "mixed" : "good";
    return JSON.stringify({
      verdict:        "proceed",
      quality,
      reason:         quality === "good"
        ? `${Math.round(relevanceRate * 100)}% of results are directly relevant.`
        : `Results are partially relevant (${Math.round(noiseRate * 100)}% noise). Proceeding with best available.`,
      relevant_count: relevantCount, noise_count: noiseCount, total,
    } satisfies ValidateVerdict);
  },
  {
    name: "validate_results",
    description:
      "Check whether semantic_search results actually answer the user's question. " +
      "ALWAYS call this after semantic_search. Returns verdict: " +
      "'proceed' (results are good), 'refine' (search again with refined_query), " +
      "'no_results', or 'data_gap' (question needs email body content, not just metadata). " +
      "Pass the list of subject lines from the search results.",
    schema: z.object({
      original_question: z.string().describe("The user's original question verbatim"),
      subjects:          z.array(z.string()).describe("Subject lines from semantic_search results"),
      result_count:      z.number().describe("Number of results returned by semantic_search"),
    }),
  },
);

// ── Tool 3: aggregate_stats ───────────────────────────────────────────────────

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
    name: "aggregate_stats",
    description:
      "Get rankings and counts from indexed email metadata. " +
      "Use for: 'who emails me most', 'top domains', 'total emails', 'inbox overview'. " +
      "No validation needed — call final_answer directly after this.",
    schema: z.object({
      mode:      z.enum(["top_senders", "top_domains", "overview"]),
      year_from: z.number().optional(),
      year_to:   z.number().optional(),
      limit:     z.number().optional(),
    }),
  },
);

// ── Tool 4: final_answer ──────────────────────────────────────────────────────

const finalAnswer = tool(
  async (args) => JSON.stringify(args),
  {
    name: "final_answer",
    description:
      "Output the final structured response. Call ONLY after validate_results says 'proceed' or 'data_gap', " +
      "or after aggregate_stats. NEVER call before validating semantic_search results.",
    schema: z.object({
      intent:        z.string(),
      response_type: z.enum(["text", "stat_card", "bar_chart", "data_table", "html_widget"]),
      answer_text:   z.string().describe("1-3 sentence plain-English summary. If data_gap, explain what IS shown and what's missing."),
      rows:          z.array(z.record(z.string(), z.unknown())).optional(),
      widget_html:   z.string().optional().describe("Only when response_type='html_widget'. A self-contained HTML fragment that visually presents a comprehensive answer (see HTML WIDGETS rules)."),
      data_limitation: z.string().optional().describe("If results are incomplete, explain why and what the user can do."),
    }),
  },
);

// ── System prompt ─────────────────────────────────────────────────────────────

/**
 * A compact, factual snapshot of the live index (top sender domains, folders, years)
 * injected into the prompt. Grounds the agent's filter choices in what actually exists
 * so it stops inventing domains (the "mutual fund → icicibank.com" miss).
 */
async function buildIndexProfileBlock(): Promise<string> {
  try {
    const p = await lanceStore.getIndexProfile();
    if (!p.total) return "";
    const domains = p.domains.slice(0, 30).map((d) => `${d.domain}(${d.count})`).join(", ");
    const folders = p.folders.slice(0, 25).map((f) => `${f.folder}(${f.count})`).join(", ");
    const years   = p.years.length ? `${Math.min(...p.years)}–${Math.max(...p.years)}` : "n/a";
    return [
      "",
      "INDEX PROFILE (what is ACTUALLY indexed — use these REAL values; never invent a domain/folder):",
      `- Years present: ${years}`,
      `- Folders: ${folders}`,
      `- Top sender domains (with counts): ${domains}`,
      "When the user names a brand/product, pick the matching domain(s) FROM THIS LIST. If none match,",
      "leave domain unset and rely on semantic search. Never filter by a domain not in this list.",
      "",
    ].join("\n");
  } catch {
    return "";
  }
}

function buildSystemPrompt(mode: "fast" | "deep"): string {
  const fast = mode === "fast";

  const modeInstructions = fast
    ? `OUTPUT MODE: FAST (direct chat answer)
- After you have searched, REPLY DIRECTLY as a normal chat message. Do NOT call final_answer.
  Do NOT produce html_widget, data_table, bar_chart, stat_card, or rows — just write the answer.
- Concise, like a chat message (2–5 sentences). If "content" is present, read it and state the real
  figures/totals inline (e.g. "You invested ₹3,65,485 across 9 transactions in 2025."). Be quick.`
    : `OUTPUT MODE: DEEP (visual report)
- PREFER response_type="html_widget" for substantive answers — especially when you have email "content" to synthesise (amounts, dates, summaries, comparisons). Compose a comprehensive, visual answer (see HTML WIDGETS).
- Use "data_table" for plain email lists, "bar_chart" for rankings, "stat_card" for a single number, "text" only for short explanations.
- Always include rows with the supporting email data so the user can see the evidence.`;

  // The (slow) HTML-widget authoring guidance is included ONLY in deep mode.
  const widgetsSection = fast ? "" : `
HTML WIDGETS (response_type="html_widget"):
- Put your visual answer in "widget_html": a SELF-CONTAINED HTML fragment rendered in an isolated
  sandbox that ALREADY provides padding, fonts, theme colours and table styling.
- USE THE HOST CLASSES instead of inline font-sizes — the host caps sizes for a clean look:
    class="eyebrow"  → small uppercase label (e.g. "ICICI FDs · last 12 months")
    class="kpi"      → the one headline number (e.g. "₹36,51,485 total") — ONE per widget
    plain <h3>, <p>, <ul>, <table> for everything else.
- KEEP IT COMPACT: do NOT set font-size above ~16px inline. Prefer the classes above.
- ALLOWED: a single root <div>, semantic markup (h2/h3, p, ul/li, table, span), light inline
  style for colour only (use the var(--w-*) tokens). Build a compact card: eyebrow + kpi + table.
- FORBIDDEN: <html>/<head>/<body> tags, <script>, event handlers, fixed widths, and ANY external
  resource (no <img src=http>, <link>, fonts/CDNs, network). Inline data: images only.
- Colours: var(--w-fg) text, var(--w-muted) secondary, var(--w-accent) accent, var(--w-border).
- Always ALSO set answer_text to a 1-3 sentence plain summary, and include rows[] with the emails.
- Example widget_html (note: no inline font-size, lets the host style it):
  <div>
    <div class="eyebrow">ICICI Bank Fixed Deposits · last 12 months</div>
    <div class="kpi">₹36,51,485 total</div>
    <table>
      <tr><th>FD</th><th>Amount</th><th>Date</th></tr>
      <tr><td>XXXX3351</td><td>₹3,00,000</td><td>2025-01-02</td></tr>
    </table>
  </div>
`;

  return `You are InboxPie, a private on-device email AI assistant powered by a local semantic index.

${dateContext()}

${modeInstructions}

TOOLS:
- semantic_search  → find emails by topic/concept (requires index)
- validate_results → check if results are relevant — MANDATORY after every semantic_search
- aggregate_stats  → counts, rankings, totals from metadata
- final_answer     → output response — call ONLY after validate_results or aggregate_stats

READING EMAIL CONTENT:
- Each semantic_search result MAY include a "content" field — this is the actual email body text
  (present when the user enabled Full Content indexing).
- When "content" is present, READ IT to answer detailed questions: amounts, balances, dates,
  order numbers, confirmation details, etc. Quote/sum the real figures from the body.
- When "content" is ABSENT, you only have metadata (subject/sender/domain) — say so plainly and
  summarise what the subjects/senders DO tell you; never invent body details.
- Be comprehensive: synthesise across results into a real answer (totals, ranges, patterns,
  notable items) — do not just list emails.
${widgetsSection}
METADATA PRE-FILTERING (use these to narrow the search before semantic matching):
- domain:       ⚠️ USE SPARINGLY. Only set a domain when the user names a SPECIFIC sender AND you
                are certain of the exact domain. Do NOT guess a domain from a product/brand —
                financial statements very often come from THIRD-PARTY senders, not the brand's site:
                  • Mutual funds → registrars like camsonline.com / kfintech.com, or AMC domains
                    (icicipruamc.com, dspim.com) — NOT the bank's icicibank.com / hdfcbank.com.
                  • Card/loan statements → the issuer, which may differ from the brand.
                When in doubt, LEAVE DOMAIN UNSET and let semantic search match by meaning. A wrong
                domain filter silently hides the very emails the user wants (e.g. filtering
                "mutual fund" by icicibank.com returns only Fixed Deposit mails).
                If a domain-filtered search looks off-topic, RETRY with no domain.
- sender_email: use only when the user gives an exact email address.
- year_from / year_to: extract from time expressions.
                "last year"   → year_from=${new Date().getFullYear() - 1}, year_to=${new Date().getFullYear() - 1}
                "this year"   → year_from=${new Date().getFullYear()}, year_to=${new Date().getFullYear()}
                "2023"        → year_from=2023, year_to=2023
                "last 2 years"→ year_from=${new Date().getFullYear() - 2}, year_to=${new Date().getFullYear()}
                "recent"      → year_from=${new Date().getFullYear() - 1}
- month_from / month_to: similarly extract from expressions like "last month", "January 2024", etc.
- week_from / week_to: extract from expressions like "last week", "week of March 1", etc.                              

WORKFLOW FOR TOPIC QUERIES ("NPS investments", "purchase emails", "travel bookings"):
1. semantic_search — use specific terms AND pass domain/year filters if extractable from the question.
   Example: "PPFAS investments last year" → query="PPFAS mutual fund statement", domain="ppfas.com", year_from=2025, year_to=2025
2. validate_results — pass original question + all subject lines from step 1
3a. If verdict="proceed" or "data_gap" → call final_answer
3b. If verdict="refine" AND domain was set → retry WITHOUT domain filter (it may be wrong)
    If verdict="refine" AND domain was NOT set → retry with refined_query from validate_results
4.  validate_results again
5.  final_answer with whatever you have

WORKFLOW FOR COUNT/RANKING QUERIES ("top senders", "who emails me most"):
1. aggregate_stats
2. final_answer (no validation needed)

RULES:
- MAXIMUM 2 semantic_search calls per turn
- ALWAYS call validate_results after EACH semantic_search
- DEEP mode: ALWAYS end with final_answer. FAST mode: end with a direct text reply (no final_answer).
- Never leave the user without an answer
- If verdict="data_gap": explain what CAN be shown (email senders/subjects) and what CANNOT (amounts, balances) and why
- If index is empty: tell user to go to the Intelligence tab and index their emails first via final_answer

JSON FORMAT (CRITICAL):
- Use ONLY standard ASCII double-quote " (U+0022) in all tool call arguments
- NEVER use Unicode typographic or curly quote characters: “ ” ‘ ’ or any variants
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
  const agentSteps: AgentStep[]              = [];
  let thinkingText   = "";
  let lastToolOutput = "";
  let lastAssistantText = "";   // the model's final plain-text answer (local models often answer here instead of calling final_answer)
  let semanticRows:  Record<string, unknown>[] | null = null;
  let aggregateRows: Record<string, unknown>[] | null = null;

  const queryStart      = Date.now();
  const toolStartTimes  = new Map<string, number>();
  const log = (...args: unknown[]) => console.log(ts(queryStart), ...args);
  const emit = (tool: string, label: string, detail?: string, elapsed?: number) => {
    log(`[SmartSearch] ${label}${detail ? ` — ${detail}` : ""}${elapsed != null ? ` (${elapsed}ms)` : ""}`);
    onEvent?.({ action: "agentStep", tool, label, detail, elapsed });
  };

  log(`[SmartSearch] ▶ Query: "${userMessage}" | model=${model} | mode=${mode} | folders=${folders?.join(",") || "all"}`);

  // Learn which local models support a "thinking" stream so we can enable it safely.
  if (provider === "ollama") { try { await loadOllamaThinkingModels(); } catch { /* offline */ } }
  const llm = createLLM(provider, model, apiKey);

  const folderScope = folders && folders.length
    ? `\nFOLDER SCOPE: The user has scoped this query to: ${folders.map((f) => `"${f}"`).join(", ")}. Pass folder=<path> when calling semantic_search.\n`
    : "";

  // Ground the agent in what's ACTUALLY indexed so it picks real domain/folder filters
  // instead of guessing (e.g. sees camsonline.com/dspim.com for mutual funds).
  const profileBlock = await buildIndexProfileBlock();

  const agent = createReactAgent({
    llm,
    tools: [semanticSearch, validateResults, aggregateStats, finalAnswer],
    prompt: buildSystemPrompt(mode) + folderScope + profileBlock,
  });

  // Sliding-window memory: feed the last few turns so follow-ups ("…not fixed deposits",
  // "show only 2025") keep context. 8 messages ≈ 4 exchanges.
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
      // ── Tool START — capture input for thinking labels ────────────────────
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
            // Only show a detail when there's a real query or filter — avoid an empty “”.
            const detail = q ? `“${q}”${fbits.length ? "  ·  " + fbits.join(" · ") : ""}`
                             : (fbits.length ? fbits.join(" · ") : undefined);
            log(`[SmartSearch] 🔍 semantic_search: ${detail ?? "(broad)"}`);
            emit("semantic_search", "Searching emails", detail);
            agentSteps.push({ type: "intent", label: "Searching emails", detail });
            break;
          }
          case "validate_results": {
            log("[SmartSearch] ✔ validate_results");
            emit("validate_results", "Checking relevance");
            agentSteps.push({ type: "intent", label: "Validating results" });
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

      // ── Tool END — capture output for row fallback & thinking labels ───────
      if (event.event === "on_tool_end") {
        const name    = event.name as string;
        const output  = extractOutput(event.data?.output);
        const elapsed = Date.now() - (toolStartTimes.get(name) ?? Date.now());
        lastToolOutput = output;

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
              // Just the count — the verbose match list (with misleading 0% scores) was noise.
              emit("semantic_search", `Found ${parsed.results.length} matching emails`, undefined, elapsed);
              agentSteps.push({ type: "result", label: `Found ${parsed.results.length} matching emails` });
            } else {
              log("[SmartSearch] ⚠ No results");
              emit("semantic_search", "No matches found", undefined, elapsed);
              agentSteps.push({ type: "retry", label: "No semantic matches" });
            }
          } catch { /* */ }
        }

        if (name === "validate_results") {
          try {
            const v = JSON.parse(output) as ValidateVerdict;
            const icon =
              v.verdict === "proceed"    ? "result" :
              v.verdict === "data_gap"   ? "retry"  :
              v.verdict === "refine"     ? "retry"  : "error";
            log(`[SmartSearch] ✔ validate: ${v.verdict} — ${v.reason}`);
            emit("validate_results", `Validation: ${v.verdict}`, v.reason, elapsed);
            agentSteps.push({
              type:   icon,
              label:  `Validation: ${v.verdict}`,
              detail: v.reason,
            });
            // Surface data gap note as an extra step so it's visible to user
            if (v.data_gap_note) {
              agentSteps.push({ type: "retry", label: "Data gap", detail: v.data_gap_note });
            }
          } catch { /* */ }
        }

        if (name === "aggregate_stats") {
          try {
            const parsed = JSON.parse(output);
            if (Array.isArray(parsed.results)) {
              aggregateRows = parsed.results;
              agentSteps.push({ type: "result", label: "Stats", detail: `${parsed.results.length} rows` });
            }
          } catch { /* */ }
        }

        if (name === "aggregate_stats") {
          try {
            const parsed = JSON.parse(output);
            if (Array.isArray(parsed.results)) {
              aggregateRows = parsed.results;
              log(`[SmartSearch] 📊 aggregate_stats: ${parsed.results.length} rows in ${elapsed}ms`);
              emit("aggregate_stats", `Stats ready`, `${parsed.results.length} rows`, elapsed);
              agentSteps.push({ type: "result", label: "Stats", detail: `${parsed.results.length} rows` });
            }
          } catch { /* */ }
        }

        if (name === "final_answer") {
          try { finalArgs = JSON.parse(output); } catch { /* */ }
        }
      }

      // ── Stream tokens as the model generates — keeps the UI alive ─────────
      if (event.event === "on_chat_model_stream") {
        const chunk: any = (event.data as any)?.chunk;
        // Reasoning delta (thinking models) → muted live "reasoning" stream.
        const ak = chunk?.additional_kwargs ?? chunk?.kwargs?.additional_kwargs ?? {};
        const reason = ak?.reasoning_content ?? ak?.reasoning;
        if (typeof reason === "string" && reason) onEvent?.({ action: "agentReasoning", text: reason });
        // Answer delta → streamed answer.
        const c = chunk?.content ?? chunk?.kwargs?.content;
        let piece = "";
        if (typeof c === "string") piece = c;
        else if (Array.isArray(c)) piece = c.map((x: any) => (typeof x === "string" ? x : (x?.text ?? ""))).join("");
        if (piece) onEvent?.({ action: "agentToken", text: piece });
      }

      // ── Capture reasoning + the model's final answer ──────────────────────
      if (event.event === "on_chat_model_end") {
        const g0   = (event.data?.output?.generations as Array<Array<any>> | undefined)?.[0]?.[0];
        const msg  = g0?.message;
        // `.text` for thinking models = reasoning+content; the message CONTENT is the answer only.
        const rawContent = msg?.content;
        const contentStr = typeof rawContent === "string"
          ? rawContent
          : Array.isArray(rawContent) ? rawContent.map((x: any) => (typeof x === "string" ? x : (x?.text ?? ""))).join("") : "";
        const reasoning  = msg?.additional_kwargs?.reasoning_content ?? "";
        const fullText   = String(g0?.text ?? "");

        // Reasoning: prefer the structured field, else parse a <think> block.
        if (!thinkingText) {
          const m = fullText.match(/<think>([\s\S]*?)<\/think>/i);
          const r = (typeof reasoning === "string" && reasoning.trim()) ? reasoning.trim() : (m ? m[1].trim() : "");
          if (r) {
            thinkingText = r;
            agentSteps.push({ type: "think", label: "Model reasoning", detail: thinkingText });
          }
        }
        // Final answer = message content (answer only), or content-with-<think>-stripped fallback.
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
    // Ollama rejects tool-call JSON with curly/typographic quotes (Go's encoding/json is strict).
    // Retry once — the system prompt now explicitly requires ASCII quotes, and model output is stochastic.
    if (!_retried && msg.includes("error parsing tool call")) {
      log(`[SmartSearch] ⚠ Ollama tool-call JSON parse error — retrying once with stricter format guidance`);
      emit("think", "Retrying", "Model produced malformed JSON — trying again");
      return runAppleMailAgent(userMessage, conversationHistory, model, folders, onEvent, mode, signal, true, provider, apiKey);
    }
    log(`[SmartSearch] ❌ Agent error after ${Date.now() - queryStart}ms:`, msg);
    // Recursion exhausted — synthesize from best captured results
    if (semanticRows || aggregateRows) {
      const rows = semanticRows ?? aggregateRows ?? [];
      return {
        intent:        userMessage,
        response_type: aggregateRows ? "bar_chart" : "data_table",
        answer_text:   `Found ${rows.length} result(s). The agent reached its step limit — showing best available results.`,
        rows,
        thinking:  thinkingText,
        agentSteps,
      };
    }
    agentSteps.push({ type: "error", label: "Agent error", detail: msg });
    return {
      intent: "error", response_type: "text",
      answer_text: `Agent error: ${msg}`,
      error: msg, thinking: thinkingText, agentSteps,
    };
  }

  // ── No final_answer called ────────────────────────────────────────────────
  // Local models (gpt-oss, qwen, …) frequently answer in a plain text message instead of
  // calling the final_answer tool. Use that synthesised answer (it has the real totals/summary)
  // rather than discarding it and dumping the raw row list.
  if (!finalArgs) {
    const rows = semanticRows ?? aggregateRows;
    const answer = lastAssistantText.trim();
    if (answer) {
      log(`[SmartSearch] ⚠ No final_answer tool call — using the model's text answer (${answer.length} chars)`);
      // Fast mode → text only; deep mode → keep rows as supporting evidence under the text.
      const withRows = mode === "deep" && rows && rows.length > 0;
      return {
        intent:        userMessage,
        response_type: withRows ? "data_table" : "text",
        answer_text:   answer,
        rows:          withRows ? rows : undefined,
        thinking:  thinkingText,
        agentSteps,
      };
    }
    if (rows && rows.length > 0) {
      // Fast mode: never return a raw table — the model was supposed to write a text answer.
      // If we got here it means neither a text answer nor final_answer was captured.
      // Return a plain-text fallback so the user sees something useful, not a table dump.
      if (mode === "fast") {
        return {
          intent:        userMessage,
          response_type: "text" as const,
          answer_text:   `Found ${rows.length} relevant email(s). The model did not produce a text summary — try rephrasing your question, or switch to Deep mode for a detailed report.`,
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
      intent: "unknown", response_type: "text",
      answer_text: indexTotal === 0
        ? "Please go to the Intelligence tab and index your folders to enable AI Search."
        : "Could not find results for that query. Try rephrasing with more specific terms.",
      thinking: thinkingText, agentSteps,
    };
  }

  // ── FAST mode → always a plain text answer, no widget/table (this is the speed win) ──
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

  // ── DEEP mode: rich output (widget / table / chart) ───────────────────────
  const finalRows = (finalArgs.rows && finalArgs.rows.length > 0)
    ? finalArgs.rows
    : (semanticRows ?? aggregateRows ?? undefined);

  let finalType = finalArgs.response_type;
  const hasWidget = finalType === "html_widget" && !!finalArgs.widget_html?.trim();
  // Only auto-promote bare "text" to a table; never override an html_widget answer.
  if (!hasWidget && finalRows && finalRows.length > 0 && finalType === "text") {
    finalType = aggregateRows && !semanticRows ? "bar_chart" : "data_table";
  }
  // If the model claimed html_widget but produced no HTML, fall back to a table.
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
