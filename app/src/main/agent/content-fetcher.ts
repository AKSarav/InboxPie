/**
 * Content Fetcher — VirtualBox Deferred Content Reading
 *
 * During the VirtualBox indexing phase, this module orchestrates reading email body
 * content from each provider using their native identifiers, then persisting to SQLite.
 *
 * Flow:
 *   1. User confirms they want to index specific emails (VirtualBox selection)
 *   2. Indexer marks include_for_index='yes' for those emails
 *   3. During indexing, fetchContentForEmails() retrieves body_text from each provider
 *   4. Bodies are persisted to mails.body_text before entity extraction
 *   5. Graph indexer uses the full body for NER, improving entity quality
 *
 * Deferred Reading (key architectural decision):
 *   - We capture (provider, identifier_id) at scan time (VirtualBox add)
 *   - We defer actual body reads to indexing phase only (when user confirms)
 *   - This prevents unnecessary disk/file I/O at scan time and respects user privacy
 */

import { mailProviders } from "../mail";
import { inboxPieDb } from "../db/inboxpie-db";

interface ContentFetchTask {
  mailId: string;
  provider: string;
  identifier_id: string | null;
}

interface FetchedContent {
  mailId: string;
  body_text: string | null;
  error?: string;
}

/**
 * Fetch email body content for a list of mails during VirtualBox indexing.
 * For each mail, uses provider-native identifier to retrieve content, then persists.
 *
 * @param mailIds List of mail IDs to fetch content for
 * @param onProgress Optional callback for progress tracking (done, total)
 * @returns Array of fetched content; null body indicates fetch failed
 */
export async function fetchContentForEmails(
  mailIds: string[],
  onProgress?: (done: number, total: number) => void
): Promise<FetchedContent[]> {
  if (!mailIds.length) return [];

  const results: FetchedContent[] = [];
  const providerInfo = inboxPieDb.getMailsProviderInfo(mailIds);
  const tasksByProvider = new Map<string, ContentFetchTask[]>();

  // Group tasks by provider so we fetch from the right place
  for (const mailId of mailIds) {
    const info = providerInfo[mailId];
    if (!info) {
      results.push({ mailId, body_text: null, error: "Mail not found in DB" });
      continue;
    }

    const provider = info.provider || "apple-mail";
    if (!tasksByProvider.has(provider)) tasksByProvider.set(provider, []);
    tasksByProvider.get(provider)!.push({
      mailId,
      provider,
      identifier_id: info.identifier_id,
    });
  }

  let processed = 0;
  const total = mailIds.length;

  // For each provider, fetch content using its native API
  for (const [providerName, tasks] of tasksByProvider) {
    const mailProvider = mailProviders.get(providerName);
    if (!mailProvider) {
      // No provider implementation; mark as failed
      for (const task of tasks) {
        results.push({
          mailId: task.mailId,
          body_text: null,
          error: `Provider '${providerName}' not found`,
        });
        processed++;
        onProgress?.(processed, total);
      }
      continue;
    }

    // Fetch from each mail's native identifier
    for (const task of tasks) {
      try {
        if (!task.identifier_id) {
          results.push({
            mailId: task.mailId,
            body_text: null,
            error: "No identifier_id stored (mail may be from emlx fallback)",
          });
        } else {
          const bodyText = await mailProvider.fetchMessageBody(task.identifier_id);
          results.push({
            mailId: task.mailId,
            body_text: bodyText,
          });
        }
      } catch (err) {
        results.push({
          mailId: task.mailId,
          body_text: null,
          error: `Fetch failed: ${(err as Error).message}`,
        });
      }
      processed++;
      onProgress?.(processed, total);
    }
  }

  // Persist successfully fetched content
  const recordsToSave = results
    .filter((r) => r.body_text !== null)
    .map((r) => ({ id: r.mailId, body_text: r.body_text! }));
  if (recordsToSave.length) {
    inboxPieDb.saveBodyTexts(recordsToSave);
  }

  return results;
}

/**
 * Fetch content for mails in VirtualBox that haven't yet been indexed.
 * Loads inclusion rules from the database and fetches for marked emails.
 * Returns a summary of what was fetched.
 */
export async function fetchContentForVirtualBox(
  onProgress?: (done: number, total: number) => void
): Promise<{ fetched: number; failed: number; skipped: number }> {
  const mails = inboxPieDb.getVirtualBoxMails(10_000);
  if (!mails.length) return { fetched: 0, failed: 0, skipped: 0 };

  // Filter for mails that need content fetching (indexed_body != 'yes')
  const needsContent = mails.filter((m) => m.indexed_body !== "yes");
  if (!needsContent.length) return { fetched: 0, failed: 0, skipped: mails.length };

  const mailIds = needsContent.map((m) => m.id);
  const results = await fetchContentForEmails(mailIds, onProgress);

  let fetched = 0;
  let failed = 0;
  for (const result of results) {
    if (result.body_text) fetched++;
    else if (result.error) failed++;
  }

  return { fetched, failed, skipped: mails.length - needsContent.length };
}

/**
 * Get fetch status summary for VirtualBox mails.
 * Useful for UI display: how many mails are ready for indexing, how many still need content.
 */
export function getVirtualBoxContentStatus(): {
  total: number;
  contentReady: number;
  contentPending: number;
} {
  const mails = inboxPieDb.getVirtualBoxMails(10_000);
  if (!mails.length) return { total: 0, contentReady: 0, contentPending: 0 };

  const contentReady = mails.filter((m) => m.indexed_body === "yes").length;
  return {
    total: mails.length,
    contentReady,
    contentPending: mails.length - contentReady,
  };
}
