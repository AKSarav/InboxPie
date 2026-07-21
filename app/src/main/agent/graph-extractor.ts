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
};

function mapType(raw: string): string {
  return TYPE_MAP[raw.toLowerCase().trim()] ?? "TOPIC";
}

// ── Batch extraction ───────────────────────────────────────────────────────────

const EXTRACTION_PROMPT = (emailLines: string) => `\
Extract a knowledge graph as SPO (Subject-Predicate-Object) triplets from these emails.
Return ONLY a valid JSON array — no markdown, no explanation.

Emails:
${emailLines}

Rules:
- Use IS_A to declare entity types: {"subject":"ET Money","predicate":"IS_A","object":"Organization"}
- Valid types for IS_A: Organization, Person, Product, Topic, Place, Event
- Use meaningful predicates for facts: WORKS_FOR, SENDS, PROCESSES, OFFERS, RELATED_TO, PROVIDES, MANAGES
- Keep subject and object labels short (1-4 words). Skip generic words like "email", "message", "notification", "update", "new", "dear".
- All triplets in a single flat JSON array.

Example output:
[
  {"subject":"ET Money","predicate":"IS_A","object":"Organization"},
  {"subject":"NPS","predicate":"IS_A","object":"Product"},
  {"subject":"ET Money","predicate":"PROCESSES","object":"NPS"},
  {"subject":"HDFC Bank","predicate":"IS_A","object":"Organization"},
  {"subject":"HDFC Bank","predicate":"SENDS","object":"Credit Card Statement"}
]`;

async function extractBatch(mails: PendingMail[], llm: BaseChatModel): Promise<Triplet[]> {
  const emailLines = mails
    .map((m, i) => `${i + 1}. From: "${m.sender || "unknown"}" | Subject: "${m.subject || "(no subject)"}"`)
    .join("\n");

  try {
    const response = await llm.invoke(EXTRACTION_PROMPT(emailLines));
    const text =
      typeof response.content === "string"
        ? response.content
        : Array.isArray(response.content)
          ? response.content.map((c: any) => (typeof c === "string" ? c : c?.text ?? "")).join("")
          : String(response.content);

    // Tolerate markdown fences and leading prose
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return [];
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (t: unknown): t is Triplet =>
        !!t &&
        typeof (t as any).subject === "string" &&
        typeof (t as any).predicate === "string" &&
        typeof (t as any).object === "string" &&
        (t as any).subject.trim().length > 0 &&
        (t as any).object.trim().length > 0,
    );
  } catch {
    return [];
  }
}

// ── Triplet → graph tables ─────────────────────────────────────────────────────

function processTriplets(triplets: Triplet[]): string[] {
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
      const sType = nodeTypes[sLabel.toLowerCase()] ?? "Entity";
      const oType = nodeTypes[oLabel.toLowerCase()] ?? "Entity";
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

    let nodeIds: string[] = [];
    let tripletCount = 0;
    try {
      const triplets = await extractBatch(batch, llm);
      tripletCount = triplets.length;
      nodeIds = triplets.length ? processTriplets(triplets) : [];
      console.log(`[InboxPie Graph] Batch ${batchIdx}/${batchCount}: ${tripletCount} triplets → ${nodeIds.length} entities`);
    } catch (err) {
      // LLM error — reset all batch mails back to todo
      console.warn(`[InboxPie Graph] Batch ${batchIdx}/${batchCount}: LLM error — ${(err as Error)?.message ?? String(err)}`);
      for (const mail of batch) inboxPieDb.markMailGraphFailed(mail.id);
      done += batch.length;
      onProgress?.({ done, total });
      await new Promise((r) => setTimeout(r, 200));
      continue;
    }

    // Mark each mail complete — all batch-level nodeIds linked to all mails in the batch
    for (const mail of batch) {
      inboxPieDb.markMailGraphComplete(mail.id, nodeIds, mail.folderId, mail.mailboxId);
    }

    done += batch.length;
    onProgress?.({ done, total });

    // Yield the event loop so Electron's renderer stays responsive
    await new Promise((r) => setTimeout(r, 50));
  }

  console.log(`[InboxPie Graph] Done: ${done}/${total} mails processed`);
}
