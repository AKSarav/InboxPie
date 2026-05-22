// background.js — Mail Audit Extension v2
// Fetches all messages, supports safe batched delete (move to trash)

// Open dashboard in a full content tab when toolbar button is clicked
browser.browserAction.onClicked.addListener(() => {
  browser.tabs.create({
    url: browser.runtime.getURL("dashboard/popup.html")
  });
});

browser.runtime.onMessage.addListener(async (message, sender) => {
  if (message.action === "fetchAllMail") {
    return await fetchAllMail(message.options || {});
  }
  if (message.action === "deleteMessages") {
    return await deleteMessages(message.messageIds);
  }
  if (message.action === "moveMessagesToFolder") {
    return await moveMessagesToFolder(message.messageIds, message.accountId, message.folderPath);
  }
  if (message.action === "listFolders") {
    return await listFoldersFlat(message.accountId);
  }
  if (message.action === "listFoldersForScan") {
    return await listFoldersForScan(message.accountId);
  }
  if (message.action === "getAccounts") {
    return await browser.accounts.list();
  }
  if (message.action === "getTrashFolder") {
    return await getTrashFolder(message.accountId);
  }
  if (message.action === "openMessage") {
    return await openMessageInTab(message.messageId);
  }
});

async function fetchAllMail(options) {
  const { accountId, folderTypes, folderSelections } = options;
  const accounts = await browser.accounts.list();
  const targetAccounts = accountId
    ? accounts.filter(a => a.id === accountId)
    : accounts;

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
        let page = await browser.messages.list(folder);
        allMessages.push(...page.messages.map(m => extractMessageData(m, account, folder)));
        totalProcessed += page.messages.length;

        while (page.id) {
          page = await browser.messages.continueList(page.id);
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
  const senderMatch = (msg.author || "").match(/(?:"?([^"<]*)"?\s*)?<?([^>]*)>?/);
  const senderName = senderMatch ? (senderMatch[1] || "").trim() : "";
  const senderEmail = senderMatch ? (senderMatch[2] || "").trim().toLowerCase() : (msg.author || "").toLowerCase();
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

  const accounts = await browser.accounts.list();
  const account = accounts.find((a) => a.id === accountId);
  if (!account) {
    return { success: false, error: "Account not found" };
  }

  const destFolder = findFolderByPath(account.folders, folderPath);
  if (!destFolder) {
    return { success: false, error: "Folder not found" };
  }

  const BATCH_SIZE = 100;
  let moved = 0;
  const movedIds = [];
  const errors = [];

  for (let i = 0; i < messageIds.length; i += BATCH_SIZE) {
    const batch = messageIds.slice(i, i + BATCH_SIZE);
    try {
      await browser.messages.move(batch, destFolder);
      moved += batch.length;
      movedIds.push(...batch);
      browser.runtime.sendMessage({
        action: "moveProgress",
        moved,
        total: messageIds.length,
      }).catch(() => {});
    } catch (e) {
      errors.push(`Batch ${Math.floor(i / BATCH_SIZE) + 1}: ${e.message}`);
    }
  }

  return {
    success: moved > 0,
    count: moved,
    total: messageIds.length,
    movedIds,
    error: moved > 0 ? undefined : (errors[0] || "No messages were moved"),
    errors: errors.length > 0 ? errors : undefined,
  };
}

// Safe batched delete — moves to trash in batches of 100
async function deleteMessages(messageIds) {
  if (!messageIds || messageIds.length === 0) return { success: false, error: "No messages selected" };

  const BATCH_SIZE = 100;
  let moved = 0;
  const movedIds = [];
  let errors = [];

  for (let i = 0; i < messageIds.length; i += BATCH_SIZE) {
    const batch = messageIds.slice(i, i + BATCH_SIZE);
    try {
      // Primary: use messages.delete with skipTrash=false (moves to trash)
      await browser.messages.delete(batch, false);
      moved += batch.length;
      movedIds.push(...batch);

      // Report progress
      browser.runtime.sendMessage({
        action: "deleteProgress",
        moved: moved,
        total: messageIds.length
      }).catch(() => {});
    } catch (e) {
      // Fallback: try messages.move to trash folder
      try {
        // Get the first message to find its account
        const msg = await browser.messages.get(batch[0]);
        if (msg) {
          const trashFolder = await getTrashFolder(msg.folder.accountId);
          if (trashFolder) {
            await browser.messages.move(batch, trashFolder);
            moved += batch.length;
            movedIds.push(...batch);
          } else {
            errors.push(`Batch ${Math.floor(i/BATCH_SIZE)+1}: No trash folder found`);
          }
        } else {
          errors.push(`Batch ${Math.floor(i/BATCH_SIZE)+1}: Could not read message for trash fallback after delete failed: ${e.message}`);
        }
      } catch (e2) {
        errors.push(`Batch ${Math.floor(i/BATCH_SIZE)+1}: Delete failed (${e.message}); trash fallback failed (${e2.message})`);
      }
    }
  }

  return {
    success: moved > 0,
    count: moved,
    total: messageIds.length,
    movedIds,
    error: moved > 0 ? undefined : (errors[0] || "No messages were moved to Trash"),
    errors: errors.length > 0 ? errors : undefined
  };
}
