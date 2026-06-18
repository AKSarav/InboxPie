/**
 * Vector index builder.
 *
 * Converts MessageRecord objects to text, calls the local embedding model,
 * and upserts into LanceDB in batches.
 *
 * Mode "metadata" embeds: subject + sender name + domain (no disk reads).
 * Mode "content"   embeds: same + email body (requires .emlx, future).
 */

import { lanceStore }              from "../db/lance-store";
import { embedBatch }              from "./embeddings";
import type { LanceEmailRecord }   from "../db/lance-store";

export interface IndexProgress {
  done:    number;
  total:   number;
  indexed: number;
  errors:  number;
  folder?: string;
}

// bge-large takes ~200-500ms per embedding; keep chunks tiny so the event loop breathes.
const BATCH_SIZE = 4;

// ── Helpers ────────────────────────────────────────────────────────────────────

function buildText(msg: Record<string, unknown>, mode: "metadata" | "content"): string {
  const subject    = String(msg["subject"]    ?? "").trim();
  const senderName = String(msg["senderName"] ?? msg["sender_name"] ?? "").trim();
  const email      = String(msg["senderEmail"] ?? msg["sender_email"] ?? msg["email"] ?? "").trim();
  const domain     = String(msg["domain"]     ?? "").trim();

  let text = `subject: ${subject || "(no subject)"}\nfrom: ${senderName || email} <${email}>\ndomain: ${domain}`;

  if (mode === "content") {
    const body = String((msg as any)["body"] ?? (msg as any)["body_preview"] ?? "").trim();
    if (body) text += `\n\n${body}`;
  }
  return text;
}

function buildRecord(msg: Record<string, unknown>, text: string, vector: number[]): LanceEmailRecord {
  const dateStr  = String(msg["date"] ?? msg["date_received"] ?? "");
  const dateMs   = dateStr ? new Date(dateStr).getTime() : 0;
  const dateUnix = Math.floor(dateMs / 1000);
  const dateObj  = new Date(dateMs);

  const email  = String(msg["senderEmail"] ?? msg["sender_email"] ?? msg["email"] ?? "");
  const domain = String(msg["domain"] ?? (email.includes("@") ? email.split("@")[1] : ""));
  const folder = String(msg["folder"] ?? msg["mailbox"] ?? "");

  let folder_type = "custom";
  const fl = folder.toLowerCase();
  if (fl.includes("inbox"))                      folder_type = "inbox";
  else if (fl.includes("sent"))                  folder_type = "sent";
  else if (fl.includes("trash"))                 folder_type = "trash";
  else if (fl.includes("junk") || fl.includes("spam")) folder_type = "junk";
  else if (fl.includes("draft"))                 folder_type = "drafts";

  return {
    id:           String(msg["id"] ?? msg["message_id"] ?? `${email}-${dateUnix}`),
    vector,
    subject:      String(msg["subject"] ?? "").trim(),
    sender_email: email,
    sender_name:  String(msg["senderName"] ?? msg["sender_name"] ?? ""),
    domain,
    folder,
    folder_type,
    date_unix:    dateUnix,
    year:         dateObj.getFullYear()  || new Date().getFullYear(),
    is_read:      msg["read"] ? 1 : 0,
    size:         Number(msg["size"] ?? 0),
    text_indexed: text,
  };
}

// ── Main indexer ───────────────────────────────────────────────────────────────

export async function buildVectorIndex(
  messages: Record<string, unknown>[],
  mode: "metadata" | "content",
  onProgress: (progress: IndexProgress) => void,
  shouldCancel?: () => boolean,
): Promise<{ indexed: number; errors: number; indexedIds: string[]; errorIds: string[] }> {
  if (!messages.length) return { indexed: 0, errors: 0, indexedIds: [], errorIds: [] };

  const alreadyIndexed = await lanceStore.indexedIds();
  const toIndex = messages.filter((m) => {
    const id = String(m["id"] ?? m["message_id"] ?? "");
    return id && !alreadyIndexed.has(id);
  });

  const total = toIndex.length;
  let indexed = 0;
  let errors  = 0;
  const indexedIds: string[] = [];
  const errorIds:   string[] = [];

  onProgress({ done: 0, total, indexed: alreadyIndexed.size, errors: 0 });
  if (total === 0) return { indexed: 0, errors: 0, indexedIds: [], errorIds: [] };

  for (let start = 0; start < total; start += BATCH_SIZE) {
    if (shouldCancel?.()) break;  // app reload / quit / new job superseded this one
    const chunk   = toIndex.slice(start, start + BATCH_SIZE);
    const texts   = chunk.map((m) => buildText(m, mode));
    const folder  = String(chunk[0]?.["folder"] ?? "");
    const chunkIds = chunk.map((m) => String(m["id"] ?? m["message_id"] ?? ""));

    let vecs: number[][];
    try {
      vecs = await embedBatch(texts, (embedDone) => {
        onProgress({ done: start + embedDone, total, indexed: alreadyIndexed.size + indexed, errors, folder });
      });
    } catch (e) {
      errors += chunk.length;
      errorIds.push(...chunkIds);
      onProgress({ done: start + chunk.length, total, indexed: alreadyIndexed.size + indexed, errors, folder });
      continue;
    }

    const records = chunk.map((m, i) => buildRecord(m, texts[i]!, vecs[i]!));

    try {
      await lanceStore.upsertBatch(records);
      indexed += records.length;
      indexedIds.push(...chunkIds);
    } catch (e) {
      errors += records.length;
      errorIds.push(...chunkIds);
    }

    onProgress({ done: start + chunk.length, total, indexed: alreadyIndexed.size + indexed, errors, folder });

    // Rest between chunks: gives Electron's IPC queue and renderer a guaranteed
    // ~15 ms breath so the UI stays responsive during a long reindex.
    await new Promise((r) => setTimeout(r, 15));
  }

  return { indexed, errors, indexedIds, errorIds };
}
