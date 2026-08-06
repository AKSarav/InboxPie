/**
 * Shared message schema — kept compatible with:
 * - THUNDERBIRD/background.js extractMessageData
 * - CLI/src/inboxpie_cli/models.py MessageRecord
 */
export interface MessageRecord {
  id: string | number;
  subject: string;
  author: string;
  senderName: string;
  senderEmail: string;
  domain: string;
  date: string;
  year: number;
  month: number;
  monthName: string;
  read: boolean;
  flagged: boolean;
  folder: string;
  folderType: string;
  account: string;
  accountId: string;
  tags: string[];
  size: number;
  body_preview?: string;
  body_display?: string;

  // NEW: Provider-native identifier for reliable content fetching
  provider?: string;        // 'apple-mail', 'thunderbird', 'gmail', 'o365'
  identifier_id?: string;   // Provider-native ID: ROWID (Apple), message key (TB), UID (Gmail), Item ID (O365)
}

export interface MailAccount {
  id: string;
  name: string;
  type: string;
}

export interface FolderInfo {
  path: string;
  name: string;
  type: string;
  accountId: string;
  accountName: string;
  depth: number;
  totalCount?: number;
  unreadCount?: number;
}

export interface FolderSelection {
  accountId: string;
  path: string;
}

export interface FetchMailOptions {
  accountId?: string | null;
  folderTypes?: string[];
  folderSelections?: FolderSelection[];
}

export interface FetchMailResult {
  messages: MessageRecord[];
  total: number;
  accounts: MailAccount[];
  envelopeIndexPath?: string;
}

export interface MoveDeleteResult {
  success: boolean;
  count?: number;
  total?: number;
  movedIds?: Array<string | number>;
  error?: string;
  errors?: string[];
}

export type RpcAction =
  | { action: "fetchAllMail"; options?: FetchMailOptions }
  | { action: "deleteMessages"; messageIds: Array<string | number> }
  | {
      action: "moveMessagesToFolder";
      messageIds: Array<string | number>;
      accountId: string;
      folderPath: string;
    }
  | { action: "listFolders"; accountId: string }
  | { action: "listFoldersForScan"; accountId?: string | null }
  | { action: "getAccounts" }
  | { action: "getTrashFolder"; accountId: string }
  | { action: "openMessage"; messageId: string | number }
  // Provider-scoped discovery
  | { action: "setActiveProvider"; providerId: string }
  | { action: "getAccountsForProvider"; providerId: string }
  | { action: "getFoldersForAccount"; providerId: string; accountId?: string | null }
  | { action: "debugAccountResolution" }
  // Enrichment
  | { action: "enrichMessages"; messages: MessageRecord[] }
  | { action: "searchSenders"; query: string; limit?: number }
  | { action: "topDomains"; limit?: number }
  // SmartSearch chat
  | { action: "checkOllama" }
  | { action: "chatQuery"; userMessage: string; history: Array<{ role: string; content: string }>; model?: string; provider?: string; mode?: "fast" | "deep" }
  | { action: "cancelChatQuery" }
  // AI provider settings (BYOK)
  | { action: "getAISettings" }
  | { action: "saveAISettings"; provider: string; model?: string; apiKey?: string }
  | { action: "clearProviderKey"; provider: string }
  | { action: "validateProviderKey"; provider: "openai" | "anthropic" | "google"; apiKey: string }
  // Preferences
  | { action: "getPreference"; key: string; defaultVal?: string }
  | { action: "setPreference"; key: string; value: string }
  // User-defined Intelligence categories
  | { action: "getCategories" }
  | { action: "saveCategory"; name: string; keywords: string[] }
  | { action: "deleteCategory"; name: string }
  // Intelligence Dashboard
  | { action: "getFolderStats" }
  | { action: "getIndexingStats" }
  | { action: "getFolderIndexBreakdown" }
  | { action: "getSemanticClusters" }
  | { action: "getClusterEmails"; label: string }
  | { action: "getCluster2D" }
  // Vector index / semantic RAG
  | { action: "checkEmbedding" }
  | { action: "checkReranker" }
  | { action: "getSetupStatus" }
  | { action: "markAppReady" }
  | { action: "getIndexingStatus" }
  | { action: "pauseIndexing" }
  | { action: "resumeIndexing" }
  | { action: "getVectorIndexStats" }
  | { action: "buildVectorIndex"; messages: MessageRecord[] }
  | { action: "reindexFolders"; folders: string[]; incremental?: boolean }
  | { action: "setFolderReadMode"; folder: string; mode: "metadata" | "content" }
  | { action: "setAllFoldersContentMode" }
  | { action: "deleteFolders"; folders: string[] }
  | { action: "resetVectorIndex" }
  | { action: "getSubscriptionStats" }
  | { action: "resetAllData" }
  // Knowledge Graph
  | { action: "getKnowledgeGraph" }
  | { action: "getEmailsForNode"; nodeId: string }
  | { action: "getGraphIndexStatus" }
  | { action: "rebuildGraphIndex" }
  | { action: "resetGraphIndex" }
  // Virtual Box — selective intelligence indexing
  | { action: "buildVirtualBoxIndex"; incremental?: boolean }
  | { action: "getIndexRunHistory" }
  | { action: "getVirtualBoxMails" }
  | { action: "getVirtualBoxStats" }
  | { action: "smartSearchVirtualBox"; query: string; limit?: number }
  | { action: "getInclusionRules" }
  | { action: "addInclusionDomain";  domain: string }
  | { action: "removeInclusionDomain"; domain: string }
  | { action: "addInclusionSender";  sender: string }
  | { action: "removeInclusionSender"; sender: string }
  | { action: "addInclusionMails";   mailIds: string[] }
  | { action: "removeInclusionMails"; mailIds: string[] }
  | { action: "clearAllInclusions" };

export type ProgressEvent =
  | { action: "progress"; count: number }
  | { action: "deleteProgress"; moved: number; total: number }
  | { action: "moveProgress"; moved: number; total: number }
  | { action: "enrichmentStarted"; total: number }
  | { action: "enrichmentDone"; senders: number; domains: number; edges: number; indexedMessages: number; totalMessages: number }
  | { action: "vectorIndexStarted"; total: number }
  | { action: "vectorIndexProgress"; done: number; total: number; indexed: number; errors: number; folder?: string }
  | { action: "vectorIndexComplete"; total: number; folders: string[]; domains: number; years: number[] }
  | { action: "vectorIndexError"; error: string }
  | { action: "agentStep"; tool: string; label: string; detail?: string; elapsed?: number }
  // Graph index progress events
  | { action: "graphIndexStarted";  total: number }
  | { action: "graphIndexProgress"; done: number; total: number }
  | { action: "graphIndexComplete"; indexed: number; total: number }
  | { action: "graphIndexSkipped";  reason: string }
  | { action: "graphIndexError";    error: string };
