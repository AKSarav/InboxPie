/**
 * Knowledge-graph extraction pipeline (Phase 2 of the index job).
 *
 * Reads mails where graph_indexed='todo', batches them to an LLM, extracts
 * SPO (Subject-Predicate-Object) triplets, and persists them in SQLite graph tables.
 *
 * Caller (handlers.ts) is responsible for:
 *   - Resolving the provider/model/apiKey from preferences + safeStorage
 *   - Passing those into buildGraphIndexJob
 */

import { createHash } from "node:crypto";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { createLLM } from "./llm-providers";
import { inboxPieDb, type Triplet, type PendingMail } from "../db/inboxpie-db";

// ── ID helpers ─────────────────────────────────────────────────────────────────

/** Node ID: keyed by normalised label only so the same entity merges across batches. */
export function nodeId(label: string): string {
  return createHash("sha1").update(label.toLowerCase().trim()).digest("hex").slice(0, 16);
}

/** Edge ID: keyed by subject+predicate+object triple. */
export function edgeId(subjectId: string, predicate: string, objectId: string): string {
  return createHash("sha1").update(`${subjectId}:${predicate}:${objectId}`).digest("hex").slice(0, 16);
}

// ── Entity type normalisation ──────────────────────────────────────────────────

const TYPE_MAP: Record<string, string> = {
  organization: "ORG", company: "ORG", bank: "ORG", brand: "ORG", org: "ORG",
  person: "PERSON", human: "PERSON", individual: "PERSON", contact: "PERSON",
  product: "PRODUCT", service: "PRODUCT", app: "PRODUCT", tool: "PRODUCT",
  topic: "TOPIC", concept: "TOPIC", category: "TOPIC", subject: "TOPIC",
  place: "PLACE", location: "PLACE", city: "PLACE", country: "PLACE", region: "PLACE",
  event: "EVENT", occasion: "EVENT", conference: "EVENT",
  date: "DATE", time: "DATE", deadline: "DATE", schedule: "DATE",
  amount: "AMOUNT", price: "AMOUNT", cost: "AMOUNT", total: "AMOUNT", value: "AMOUNT", money: "AMOUNT",
};

function mapType(raw: string): string {
  return TYPE_MAP[raw.toLowerCase().trim()] ?? "TOPIC";
}

// ── Regex safety net (used only if the classification LLM call fails) ─────────

const CURRENCY_AMOUNT_RE = /[₹$€£¥]\s?[\d,]+(\.\d+)?|\b(?:Rs\.?|INR|USD|EUR|GBP)\s?[\d,]+(\.\d+)?\b/i;
const DATE_RE = /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b|\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}\b/i;

function classifyLabelRegex(label: string): string {
  const trimmed = label.trim();
  if (CURRENCY_AMOUNT_RE.test(trimmed)) return "AMOUNT";
  if (DATE_RE.test(trimmed)) return "DATE";
  return "Entity";
}

// ── Prompt ─────────────────────────────────────────────────────────────────────

const EXTRACTION_PROMPT = (emailBlocks: string) => `\
Extract the Key entities and relationships from this content at a deeper level -
this is required for the Email Intelligence we are building and more entities and relationships the best.
First try to Summarize the email understand what it is and create meaningful entities and relationships plan and proceed with extraction.
The Email can be from any genre or domain relevancy - Just make sure to get the meaningful triplets with domain/context relevance -
this would be stored for the GraphRAG and Knowledge Engineering - Keep it in mind.

${emailBlocks}

Return ONLY a valid JSON object mapping each email's index (as a string key) to its triplets array.
No markdown, no explanation — just the JSON.

Example output (for 2 emails):
{
  "1": [
    {"subject":"ET Money","predicate":"IS_A","object":"Organization"},
    {"subject":"Investment Goal","predicate":"RELATED_TO","object":"My 1st crore"},
    {"subject":"Financial Activity","predicate":"MANAGES_FLOW","object":"SIP installment"}
  ],
  "2": [
    {"subject":"HDFC Bank","predicate":"IS_A","object":"Organization"},
    {"subject":"HDFC Bank","predicate":"SENDS","object":"Credit Card Statement"}
  ]
}`;

// ── Text parsing helpers ────────────────────────────────────────────────────────

function isValidTriplet(t: unknown): t is Triplet {
  return (
    !!t &&
    typeof (t as any).subject === "string" &&
    typeof (t as any).predicate === "string" &&
    typeof (t as any).object === "string" &&
    (t as any).subject.trim().length > 0 &&
    (t as any).object.trim().length > 0
  );
}

/** Finds the first balanced `{...}` block in text — handles prose, fences, and JS comments. */
function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0, inString = false, escape = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (escape)                  { escape = false; continue; }
    if (c === "\\" && inString)  { escape = true;  continue; }
    if (c === '"')               { inString = !inString; continue; }
    if (inString)                continue;
    if (c === "{")               depth++;
    else if (c === "}")          { if (--depth === 0) return text.slice(start, i + 1); }
  }
  return null;
}

/** Normalises a LangChain AIMessage's `content` (string | content-block array) to plain text. */
function extractResponseText(response: { content: unknown }): string {
  return typeof response.content === "string"
    ? response.content
    : Array.isArray(response.content)
      ? response.content.map((c: any) => (typeof c === "string" ? c : c?.text ?? "")).join("")
      : String(response.content);
}

// ── Per-mail batch extraction ──────────────────────────────────────────────────

/** Returns per-mail triplet arrays keyed by mail.id. */
async function extractBatch(mails: PendingMail[], llm: BaseChatModel): Promise<Map<string, Triplet[]>> {
  const mailsWithBody = mails
    .map((m, i) => ({ mail: m, idx: i + 1, body: (m.bodyText ?? "").trim() }))
    .filter((x) => x.body.length > 0);

  const result = new Map<string, Triplet[]>();
  if (!mailsWithBody.length) return result;

  const emailBlocks = mailsWithBody
    .map((x) => `Email ${x.idx}:\n${x.body.slice(0, 2000)}`)
    .join("\n\n---\n\n");

  try {
    const prompt = EXTRACTION_PROMPT(emailBlocks);
    const response = await llm.invoke(prompt);
    const text = extractResponseText(response);

    console.log("DEBUG extractBatch: raw LLM response", text);

    const jsonStr = extractFirstJsonObject(text);
    if (!jsonStr) {
      console.warn("DEBUG extractBatch: no JSON object found in response");
      return result;
    }

    // Strip JS-style single-line comments before parsing
    const cleaned = jsonStr.replace(/\/\/[^\n]*/g, "");
    const parsed = JSON.parse(cleaned);
    console.log("DEBUG extractBatch: parsed keys", Object.keys(parsed));

    for (const x of mailsWithBody) {
      const raw: unknown[] = parsed[String(x.idx)] ?? [];
      const triplets = raw.filter(isValidTriplet);
      console.log(`DEBUG extractBatch: mail idx=${x.idx} id=${x.mail.id} → ${triplets.length} triplets`);
      result.set(x.mail.id, triplets);
    }
  } catch (err) {
    console.error("DEBUG extractBatch: FAILED", (err as Error)?.message ?? String(err), err);
  }
  return result;
}

// ── Stage 2: entity classification ──────────────────────────────────────────────

const CLASSIFICATION_PROMPT = (labels: string[]) => `\
Classify each of the following entity labels into exactly one of these types:
ORG, PERSON, PRODUCT, TOPIC, PLACE, EVENT, DATE, AMOUNT

Guidelines:
- ORG: companies, banks, institutions, brands
- PERSON: names of individuals
- PRODUCT: named products, services, apps, financial instruments/funds
- PLACE: cities, countries, regions, addresses
- EVENT: occasions, conferences, scheduled happenings
- DATE: dates, times, deadlines
- AMOUNT: monetary values, quantities, prices
- TOPIC: anything else — concepts or subjects that don't fit the above

Labels:
${labels.map((l, i) => `${i + 1}. ${l}`).join("\n")}

Return ONLY a valid JSON object mapping each label's number (as a string key) to its type.
No markdown, no explanation — just the JSON.

Example output (for 3 labels):
{ "1": "ORG", "2": "AMOUNT", "3": "DATE" }`;

/** Stage 2: classifies entity labels that had no LLM-declared IS_A type. One call per batch. */
async function classifyEntities(labels: string[], llm: BaseChatModel): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (!labels.length) return result;

  try {
    const response = await llm.invoke(CLASSIFICATION_PROMPT(labels));
    const text = extractResponseText(response);
    console.log("DEBUG classifyEntities: raw LLM response", text);

    const jsonStr = extractFirstJsonObject(text);
    if (!jsonStr) {
      console.warn("DEBUG classifyEntities: no JSON object found in response");
      return result;
    }

    const cleaned = jsonStr.replace(/\/\/[^\n]*/g, "");
    const parsed = JSON.parse(cleaned);

    labels.forEach((label, i) => {
      const raw = parsed[String(i + 1)];
      if (typeof raw === "string") result.set(label.toLowerCase().trim(), mapType(raw));
    });
    console.log(`DEBUG classifyEntities: classified ${result.size}/${labels.length} labels`);
  } catch (err) {
    console.error("DEBUG classifyEntities: FAILED", (err as Error)?.message ?? String(err), err);
  }
  return result;
}

// ── Triplet → graph tables ─────────────────────────────────────────────────────

function processTriplets(triplets: Triplet[], classifiedTypes: Map<string, string>): string[] {
  // First pass: collect IS_A declarations to build a type map
  const nodeTypes: Record<string, string> = {};
  for (const t of triplets) {
    if (t.predicate === "IS_A") {
      nodeTypes[t.subject.toLowerCase().trim()] = mapType(t.object);
    }
  }

  const nodeIds = new Set<string>();

  for (const t of triplets) {
    const sLabel = t.subject.trim();
    const oLabel = t.object.trim();
    if (!sLabel || !oLabel) continue;

    if (t.predicate === "IS_A") {
      // IS_A → upsert subject as a typed node; object is just the type name, not a node itself
      const sId = nodeId(sLabel);
      inboxPieDb.upsertGraphNode(sId, sLabel, mapType(oLabel));
      nodeIds.add(sId);
    } else {
      const sId = nodeId(sLabel);
      const oId = nodeId(oLabel);
      // Priority: LLM's own IS_A declaration → stage-2 classification → regex safety net → Entity
      const sType = nodeTypes[sLabel.toLowerCase()] ?? classifiedTypes.get(sLabel.toLowerCase()) ?? classifyLabelRegex(sLabel);
      const oType = nodeTypes[oLabel.toLowerCase()] ?? classifiedTypes.get(oLabel.toLowerCase()) ?? classifyLabelRegex(oLabel);
      inboxPieDb.upsertGraphNode(sId, sLabel, sType);
      inboxPieDb.upsertGraphNode(oId, oLabel, oType);
      inboxPieDb.upsertGraphEdge(edgeId(sId, t.predicate, oId), sId, t.predicate, oId);
      nodeIds.add(sId);
      nodeIds.add(oId);
    }
  }

  return [...nodeIds];
}

// ── Main index job ─────────────────────────────────────────────────────────────

const BATCH_SIZE = 10;

export interface GraphIndexProgress {
  done:  number;
  total: number;
}

export async function buildGraphIndexJob(
  opts: { provider: string; model: string; apiKey?: string },
  onProgress?: (p: GraphIndexProgress) => void,
  shouldCancel?: () => boolean,
  folderIds?: number[],
  virtualBoxOnly = false,
): Promise<void> {
  const llm = createLLM(opts.provider, opts.model, opts.apiKey);

  const initialStats = inboxPieDb.getGraphIndexStats(folderIds, virtualBoxOnly);

  // Reset stale inprogress rows from a previous crashed job (scoped to the same folders)
  if (initialStats.inprogress > 0) {
    console.log(`[InboxPie Graph] Resetting ${initialStats.inprogress} stale in-progress mails`);
    try {
      const db = (inboxPieDb as any)["get"]();
      const vbClause = virtualBoxOnly ? " AND include_for_index='yes'" : "";
      if (folderIds && folderIds.length) {
        const ph = folderIds.map(() => "?").join(",");
        db.prepare(`UPDATE mails SET graph_indexed='todo' WHERE graph_indexed='inprogress' AND folder_id IN (${ph})${vbClause}`).run(...folderIds);
      } else {
        db.prepare(`UPDATE mails SET graph_indexed='todo' WHERE graph_indexed='inprogress'${vbClause}`).run();
      }
    } catch { /* non-fatal */ }
  }

  const total = initialStats.todo + initialStats.inprogress;
  const scopeLabel = virtualBoxOnly ? " [Virtual Box only]" : "";
  const folderLabel = folderIds?.length ? ` (folder IDs: ${folderIds.join(",")})` : " (all folders)";
  console.log(`[InboxPie Graph] Starting extraction: ${total} mails pending${folderLabel}${scopeLabel} — ${opts.provider}/${opts.model}`);

  let done = 0;
  let batchIdx = 0;
  const batchCount = Math.max(1, Math.ceil(total / BATCH_SIZE));

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (shouldCancel?.()) {
      console.log(`[InboxPie Graph] Cancelled after ${done}/${total} mails`);
      break;
    }

    const batch = inboxPieDb.getPendingGraphMails(BATCH_SIZE, folderIds, virtualBoxOnly);
    if (!batch.length) break;

    batchIdx++;
    console.log(`[InboxPie Graph] Batch ${batchIdx}/${batchCount}: extracting ${batch.length} mails...`);

    // Mark batch as in-progress so a cancel/crash doesn't re-process them immediately
    for (const mail of batch) inboxPieDb.markMailGraphIndexing(mail.id);

    // mailTriplets: mail.id → triplets extracted from that mail's body only
    let mailTriplets: Map<string, Triplet[]>;
    try {
      mailTriplets = await extractBatch(batch, llm);
      const totalTriplets = [...mailTriplets.values()].reduce((s, t) => s + t.length, 0);
      console.log(`[InboxPie Graph] Batch ${batchIdx}/${batchCount}: ${totalTriplets} triplets across ${mailTriplets.size} mails`);
    } catch (err) {
      console.warn(`[InboxPie Graph] Batch ${batchIdx}/${batchCount}: LLM error — ${(err as Error)?.message ?? String(err)}`);
      for (const mail of batch) inboxPieDb.markMailGraphFailed(mail.id);
      done += batch.length;
      onProgress?.({ done, total });
      await new Promise((r) => setTimeout(r, 200));
      continue;
    }

    // Stage 2: classify every non-IS_A-typed label across the whole batch in one call
    const allTriplets = [...mailTriplets.values()].flat();
    const isATyped = new Set(
      allTriplets.filter((t) => t.predicate === "IS_A").map((t) => t.subject.toLowerCase().trim()),
    );
    const untyped = new Set<string>();
    for (const t of allTriplets) {
      if (t.predicate === "IS_A") continue;
      const s = t.subject.trim();
      const o = t.object.trim();
      if (s && !isATyped.has(s.toLowerCase())) untyped.add(s);
      if (o && !isATyped.has(o.toLowerCase())) untyped.add(o);
    }
    const classifiedTypes = await classifyEntities([...untyped], llm);
    console.log(`[InboxPie Graph] Batch ${batchIdx}/${batchCount}: classified ${classifiedTypes.size}/${untyped.size} untyped entities`);

    // Mark each mail complete with only ITS OWN extracted nodes
    for (const mail of batch) {
      const triplets = mailTriplets.get(mail.id) ?? [];
      const mailNodeIds = triplets.length ? processTriplets(triplets, classifiedTypes) : [];
      inboxPieDb.markMailGraphComplete(mail.id, mailNodeIds, mail.folderId, mail.mailboxId);
    }

    done += batch.length;
    onProgress?.({ done, total });

    // Yield the event loop so Electron's renderer stays responsive
    await new Promise((r) => setTimeout(r, 50));
  }

  console.log(`[InboxPie Graph] Done: ${done}/${total} mails processed`);
}
