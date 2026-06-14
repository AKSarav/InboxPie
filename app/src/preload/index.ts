import { contextBridge, ipcRenderer } from "electron";

import type {
  FolderInfo,
  FolderSelection,
  MailAccount,
  ProgressEvent,
  RpcAction,
} from "../../shared/message-record";

type RuntimeListener = (message: ProgressEvent) => void;

const runtimeListeners: RuntimeListener[] = [];

ipcRenderer.on("inboxpie:event", (_event, message: ProgressEvent) => {
  for (const listener of runtimeListeners) listener(message);
});

// Folder/account selections set by shell.js during step 3 (folder picker).
// Injected into the very next fetchAllMail call that dashboard.js makes when
// the user clicks the scan button — cleared immediately after use.
let pendingScanOverride: {
  accountId?: string | null;
  folderSelections?: FolderSelection[];
} | null = null;

/**
 * Drop-in replacement for Thunderbird's browser.runtime API used by dashboard.js.
 * This lets the existing extension UI run in Electron without rewriting 2,600 lines.
 */
const browserRuntime = {
  sendMessage: (message: RpcAction) => {
    // Intercept the first fetchAllMail after shell setup to inject folder selections
    if (message.action === "fetchAllMail" && pendingScanOverride !== null) {
      const override = pendingScanOverride;
      pendingScanOverride = null;
      message = {
        ...message,
        options: {
          ...(message.options ?? {}),
          ...(override.accountId !== undefined ? { accountId: override.accountId } : {}),
          ...(override.folderSelections !== undefined
            ? { folderSelections: override.folderSelections }
            : {}),
        },
      };
    }
    return ipcRenderer.invoke("inboxpie:rpc", message);
  },
  onMessage: {
    addListener(listener: RuntimeListener) {
      runtimeListeners.push(listener);
    },
    removeListener(listener: RuntimeListener) {
      const index = runtimeListeners.indexOf(listener);
      if (index >= 0) runtimeListeners.splice(index, 1);
    },
  },
};

contextBridge.exposeInMainWorld("browser", {
  runtime: browserRuntime,
});

contextBridge.exposeInMainWorld("inboxpie", {
  // Thunderbird browser.runtime compatibility surface (used by dashboard.js)
  invoke: browserRuntime.sendMessage,
  openPrivacySettings: () => ipcRenderer.invoke("inboxpie:openPrivacySettings"),

  // Provider registry (used by shell.js for account selection)
  getProviders: (): Promise<Array<{ id: string; name: string }>> =>
    ipcRenderer.invoke("inboxpie:getProviders"),

  setActiveProvider: (providerId: string): Promise<{ success: boolean }> =>
    ipcRenderer.invoke("inboxpie:rpc", { action: "setActiveProvider", providerId }),

  getAccountsForProvider: (providerId: string): Promise<MailAccount[]> =>
    ipcRenderer.invoke("inboxpie:rpc", { action: "getAccountsForProvider", providerId }),

  getFoldersForAccount: (
    providerId: string,
    accountId?: string | null,
  ): Promise<FolderInfo[]> =>
    ipcRenderer.invoke("inboxpie:rpc", { action: "getFoldersForAccount", providerId, accountId }),

  // Called by shell.js after folder selection (step 3) — overrides the
  // account + folder selections for the next scan dashboard.js triggers.
  setScanOverride: (opts: {
    accountId?: string | null;
    folderSelections?: FolderSelection[];
  }): void => {
    pendingScanOverride = opts;
  },
});

declare global {
  interface Window {
    browser: {
      runtime: typeof browserRuntime;
    };
    inboxpie: {
      invoke: typeof browserRuntime.sendMessage;
      openPrivacySettings: () => Promise<void>;
      getProviders: () => Promise<Array<{ id: string; name: string }>>;
      setActiveProvider: (providerId: string) => Promise<{ success: boolean }>;
      getAccountsForProvider: (providerId: string) => Promise<MailAccount[]>;
      getFoldersForAccount: (
        providerId: string,
        accountId?: string | null,
      ) => Promise<FolderInfo[]>;
      setScanOverride: (opts: {
        accountId?: string | null;
        folderSelections?: FolderSelection[];
      }) => void;
    };
  }
}
