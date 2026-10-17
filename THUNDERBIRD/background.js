// background.js — Mail Audit Extension v2
// Fetches all messages, supports safe batched delete (move to trash)

// Open dashboard in a full content tab when toolbar button is clicked
browser.browserAction.onClicked.addListener(() => {
  browser.tabs.create({
    url: browser.runtime.getURL("dashboard/popup.html")
  });
});

// The listener itself must stay synchronous: an `async` listener always
// returns a Promise, even for message types it doesn't recognize, which
// breaks the "return nothing so another listener can respond" contract.
// Returning the handler's own Promise directly for recognized messages
// still resolves the response asynchronously.
browser.runtime.onMessage.addListener((message, sender) => {
  if (message.action === "fetchAllMail") {
    return fetchAllMail(message.options || {});
  }
  if (message.action === "deleteMessages") {
    return deleteMessages(message.messageIds);
  }
  if (message.action === "moveMessagesToFolder") {
    return moveMessagesToFolder(message.messageIds, message.accountId, message.folderPath);
  }
  if (message.action === "listFolders") {
    return listFoldersFlat(message.accountId);
  }
  if (message.action === "listFoldersForScan") {
    return listFoldersForScan(message.accountId);
  }
  if (message.action === "getAccounts") {
    return browser.accounts.list();
  }
  if (message.action === "getTrashFolder") {
    return getTrashFolder(message.accountId);
  }
  if (message.action === "openMessage") {
    return openMessageInTab(message.messageId);
  }
});

async function fetchAllMail(options) {
  const { accountId, folderTypes, folderSelections, dateFrom, dateTo } = options;
  const accounts = await browser.accounts.list();
  const targetAccounts = accountId
    ? accounts.filter(a => a.id === accountId)
    : accounts;

  const hasDateRange = dateFrom != null || dateTo != null;

  const allMessages = [];
  let totalProcessed = 0;

  for (const account of targetAccounts) {
    let foldersToScan = [];
    if (folderSelections && folderSelections.length > 0) {
      const accountSelections = folderSelections.filter((s) => s.accountId === account.id);
      foldersToScan = accountSelections
        .map((s) => findFolderByPath(account.folders, s.path))
        .filter(Boolean);
    } else {
      foldersToScan = flattenFolders(account.folders, folderTypes);
    }

    for (const folder of foldersToScan) {
      try {
        // When a scan range is set, ask Thunderbird's own message store to filter by
        // date (messages.query) instead of fetching every header over the WebExtension
        // boundary and discarding out-of-range ones in JS — genuinely less work, not
        // just a smaller kept set.
        let page = hasDateRange
          ? await browser.messages.query({
              folder,
              fromDate: dateFrom != null ? new Date(dateFrom) : undefined,
              toDate: dateTo != null ? new Date(dateTo) : undefined,
              autoPaginationTimeout: 0,
            })
          : await browser.messages.list(folder);
        allMessages.push(...page.messages.map(m => extractMessageData(m, account, folder)));
        totalProcessed += page.messages.length;

        while (page.id) {
          page = await browser.messages.continueList(page.id);
          // Date filtering already happened server-side via messages.query() above when
          // hasDateRange is true (continueList just pages through that same query's
          // results) -- no client-side filter needed or correct to apply here. This used
          // to call a since-removed inDateRange() helper, which threw a ReferenceError on
          // the very first continueList() call and silently truncated every scan to one
          // page (~100 messages), caught by the catch block below as a console warning.
          allMessages.push(...page.messages.map(m => extractMessageData(m, account, folder)));
          totalProcessed += page.messages.length;

          browser.runtime.sendMessage({
            action: "progress",
            count: totalProcessed
          }).catch(() => {});
        }
      } catch (e) {
        console.warn(`Skipping folder ${folder.path}: ${e.message}`);
      }
    }
  }

  return {
    messages: allMessages,
    total: allMessages.length,
    accounts: targetAccounts.map(a => ({ id: a.id, name: a.name, type: a.type }))
  };
}

function flattenFolders(folders, filterTypes) {
  const result = [];
  const defaultTypes = ["inbox", "sent", "junk", "trash", "archives", "drafts"];
  const types = filterTypes && filterTypes.length > 0 ? filterTypes : defaultTypes;

  for (const folder of folders) {
    if (types.includes(folder.type) || types.includes("all")) {
      result.push(folder);
    }
    if (folder.subFolders && folder.subFolders.length > 0) {
      result.push(...flattenFolders(folder.subFolders, filterTypes));
    }
  }
  return result;
}

function extractMessageData(msg, account, folder) {
  const date = new Date(msg.date);
  // Requires <...> to capture a display-name/email split; a bare address with no angle
  // brackets (msg.author === "john@example.com", no quoting) falls through to treating the
  // whole trimmed string as the email. The old regex made both <...> and the email capture
  // optional, so a bare address matched with an EMPTY email capture — the string landed in
  // senderName instead, leaving senderEmail empty and domain stuck at "unknown".
  const author = (msg.author || "").trim();
  const senderMatch = author.match(/^\s*(?:"?([^"<]*)"?\s*)?<([^>]+)>\s*$/);
  const senderName = senderMatch ? (senderMatch[1] || "").trim() : "";
  const senderEmail = senderMatch ? senderMatch[2].trim().toLowerCase() : author.toLowerCase();
  const domain = senderEmail.includes("@") ? senderEmail.split("@")[1] : "unknown";

  return {
    id: msg.id,
    subject: msg.subject || "(No Subject)",
    author: msg.author || "Unknown",
    senderName: senderName || senderEmail.split("@")[0],
    senderEmail: senderEmail,
    domain: domain,
    date: msg.date,
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    monthName: date.toLocaleString("default", { month: "short" }),
    read: msg.read,
    flagged: msg.flagged,
    folder: folder.path,
    folderType: folder.type,
    account: account.name,
    accountId: account.id,
    tags: msg.tags || [],
    size: msg.size || 0
  };
}

// Find trash folder for an account
async function getTrashFolder(accountId) {
  const accounts = await browser.accounts.list();
  const account = accounts.find(a => a.id === accountId);
  if (!account) return null;
  return findFolderByType(account.folders, "trash");
}

async function openMessageInTab(messageId) {
  if (messageId == null || messageId === "") {
    return { success: false, error: "No message selected" };
  }
  const id = typeof messageId === "number" ? messageId : parseInt(String(messageId), 10);
  if (Number.isNaN(id)) {
    return { success: false, error: "Invalid message id" };
  }
  try {
    await browser.messageDisplay.open({
      messageId: id,
      active: true,
      location: "tab",
    });
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message || "Could not open message" };
  }
}

function findFolderByType(folders, type) {
  for (const folder of folders) {
    if (folder.type === type) return folder;
    if (folder.subFolders) {
      const found = findFolderByType(folder.subFolders, type);
      if (found) return found;
    }
  }
  return null;
}

function findFolderByPath(folders, targetPath) {
  for (const folder of folders) {
    if (folder.path === targetPath) return folder;
    if (folder.subFolders && folder.subFolders.length > 0) {
      const found = findFolderByPath(folder.subFolders, targetPath);
      if (found) return found;
    }
  }
  return null;
}

async function listFoldersFlat(accountId) {
  const accounts = await browser.accounts.list();
  const account = accounts.find((a) => a.id === accountId);
  if (!account) return [];
  const folders = flattenFolders(account.folders, ["all"]);
  const label = account.name || accountId;
  return folders
    .map((f) => ({
      path: f.path,
      name: f.name,
      accountId,
      displayPath: `${label} — ${f.path}`,
    }))
    .sort((a, b) => a.displayPath.localeCompare(b.displayPath));
}

async function listFoldersForScan(accountId) {
  const accounts = await browser.accounts.list();
  const targetAccounts = accountId ? accounts.filter((a) => a.id === accountId) : accounts;
  const result = [];
  for (const account of targetAccounts) {
    collectFoldersForScan(account.folders, account.id, account.name || account.id, 0, result);
  }
  return result.sort((a, b) => {
    const acct = a.accountName.localeCompare(b.accountName);
    return acct !== 0 ? acct : a.path.localeCompare(b.path);
  });
}

function collectFoldersForScan(folders, accountId, accountName, depth, result) {
  for (const folder of folders) {
    result.push({
      path: folder.path,
      name: folder.name,
      type: folder.type || "",
      accountId,
      accountName,
      depth,
    });
    if (folder.subFolders && folder.subFolders.length > 0) {
      collectFoldersForScan(folder.subFolders, accountId, accountName, depth + 1, result);
    }
  }
}

async function moveMessagesToFolder(messageIds, accountId, folderPath) {
  if (!messageIds || messageIds.length === 0) {
    return { success: false, error: "No messages selected" };
  }
  if (!accountId || !folderPath) {
    return { success: false, error: "Missing destination folder" };
  }

  // Fetched fresh right here (not reused from whatever populated the folder dropdown when
  // the modal opened), so this itself can't go stale — but the dropdown selection the user
  // is acting on WAS read earlier, and the account/folder it names can genuinely have been
  // removed or renamed in Thunderbird in the time the modal was open. Give an actionable
  // message pointing at that, since "Folder not found" alone doesn't tell the user the
  // selection itself (not their messages) is what's gone, or what to do about it —
  // reopening Move to Folder re-fetches this same list fresh.
  const accounts = await browser.accounts.list();
  const account = accounts.find((a) => a.id === accountId);
  if (!account) {
    return { success: false, error: "That account is no longer available. Close this and reopen Move to Folder to pick again." };
  }

  const destFolder = findFolderByPath(account.folders, folderPath);
  if (!destFolder) {
    return { success: false, error: "That destination folder no longer exists — it may have been renamed or deleted. Close this and reopen Move to Folder to pick again." };
  }

  // Same batch-size reasoning as deleteMessages() below — larger batches cut the number
  // of sequential round-trips, which is the real overhead for a local/offline-synced
  // account.
  const BATCH_SIZE = 500;
  let moved = 0;
  let skipped = 0;
  const movedIds = [];
  const errors = [];
  const isNotFound = (err) => /not found/i.test(err?.message || "");

  // browser.messages.move() is all-or-nothing for the whole batch it's given. If a message
  // was moved or deleted outside InboxPie (another client, manually in Thunderbird) since
  // the search that produced this ID list ran, that ONE stale ID fails the entire batch —
  // with a 500-message batch that meant losing up to 500 messages' worth of progress over
  // one already-gone message, with no way to continue short of re-scanning. On failure,
  // bisect instead of giving up: split the batch and retry each half, recursing until the
  // stale ID(s) are isolated to a batch of 1. A lone message that's genuinely gone is
  // treated as already-handled (skipped), not an error — the end state the user wanted
  // (it's not in this folder anymore) is already true.
  async function processBatch(batch) {
    try {
      await browser.messages.move(batch, destFolder);
      moved += batch.length;
      movedIds.push(...batch);
      browser.runtime.sendMessage({
        action: "moveProgress",
        moved: moved + skipped,
        total: messageIds.length,
      }).catch(() => {});
      return;
    } catch (e) {
      if (batch.length > 1) {
        const mid = Math.floor(batch.length / 2);
        await processBatch(batch.slice(0, mid));
        await processBatch(batch.slice(mid));
        return;
      }
      if (isNotFound(e)) {
        skipped++;
        movedIds.push(batch[0]);
        return;
      }
      errors.push(`Message ${batch[0]}: ${e.message}`);
    }
  }

  for (let i = 0; i < messageIds.length; i += BATCH_SIZE) {
    await processBatch(messageIds.slice(i, i + BATCH_SIZE));
  }

  return {
    success: moved > 0 || skipped > 0,
    count: moved,
    skipped,
    total: messageIds.length,
    movedIds,
    error: (moved === 0 && skipped === 0) ? (errors[0] || "No messages were moved") : undefined,
    errors: errors.length > 0 ? errors : undefined,
  };
}

// Safe batched delete — moves to trash in batches. No documented hard limit on
// browser.messages.delete()'s batch size, and the bottleneck for a local/offline-synced
// account (e.g. Gmail via Thunderbird's local cache) is the per-call round-trip overhead
// across the WebExtension boundary, not JS compute — so fewer, larger batches is the
// lever, not concurrency (no documented guarantee concurrent calls on the same folder are
// safe, and it's a destructive op, so not worth the risk). 500 is a first experimental
// bump from 100; raise further if batches keep succeeding cleanly (watch `errors`).
async function deleteMessages(messageIds) {
  if (!messageIds || messageIds.length === 0) return { success: false, error: "No messages selected" };

  const BATCH_SIZE = 500;
  let moved = 0;
  let skipped = 0;
  const movedIds = [];
  const errors = [];
  const isNotFound = (err) => /not found/i.test(err?.message || "");

  // Same all-or-nothing-batch problem as moveMessagesToFolder() above: one message moved
  // or deleted outside InboxPie since the search ran fails messages.delete() for the WHOLE
  // batch, and the old fallback retried messages.move() on that same full batch — so it
  // failed identically, losing the whole batch's progress with no way to continue short of
  // a full re-scan (the exact customer-reported bug). Bisect on failure instead: split and
  // retry each half, recursing until the stale ID(s) are isolated to a batch of 1. A lone
  // message that's genuinely gone is skipped (already-handled), not an error.
  async function processBatch(batch) {
    try {
      // Primary: use messages.delete with skipTrash=false (moves to trash)
      await browser.messages.delete(batch, false);
      moved += batch.length;
      movedIds.push(...batch);
      browser.runtime.sendMessage({
        action: "deleteProgress",
        moved: moved + skipped,
        total: messageIds.length,
      }).catch(() => {});
      return;
    } catch (e) {
      if (batch.length > 1) {
        const mid = Math.floor(batch.length / 2);
        await processBatch(batch.slice(0, mid));
        await processBatch(batch.slice(mid));
        return;
      }
      if (isNotFound(e)) {
        skipped++;
        movedIds.push(batch[0]);
        browser.runtime.sendMessage({
          action: "deleteProgress",
          moved: moved + skipped,
          total: messageIds.length,
        }).catch(() => {});
        return;
      }
      // Genuine single-message failure (not "already gone") — try the trash-folder
      // fallback before giving up on just this one message.
      try {
        const msg = await browser.messages.get(batch[0]);
        const trashFolder = msg ? await getTrashFolder(msg.folder.accountId) : null;
        if (trashFolder) {
          await browser.messages.move(batch, trashFolder);
          moved++;
          movedIds.push(batch[0]);
          return;
        }
        errors.push(`Message ${batch[0]}: ${msg ? "no trash folder found" : `could not read message after delete failed (${e.message})`}`);
      } catch (e2) {
        if (isNotFound(e2)) {
          skipped++;
          movedIds.push(batch[0]);
          return;
        }
        errors.push(`Message ${batch[0]}: delete failed (${e.message}); trash fallback failed (${e2.message})`);
      }
    }
  }

  for (let i = 0; i < messageIds.length; i += BATCH_SIZE) {
    await processBatch(messageIds.slice(i, i + BATCH_SIZE));
  }

  return {
    success: moved > 0 || skipped > 0,
    count: moved,
    skipped,
    total: messageIds.length,
    movedIds,
    error: (moved === 0 && skipped === 0) ? (errors[0] || "No messages were moved to Trash") : undefined,
    errors: errors.length > 0 ? errors : undefined,
  };
}
