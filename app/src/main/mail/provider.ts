import type {
  FetchMailOptions,
  FetchMailResult,
  FolderInfo,
  MailAccount,
  MoveDeleteResult,
} from "../../../shared/message-record";

/**
 * Contract every mail provider must implement.
 *
 * Split into two conceptual groups:
 *   Discovery  — called during account/folder selection, before any scan
 *   Operations — scan, delete, move, open
 */
export interface MailProvider {
  readonly id: string;
  readonly name: string;

  // ── Discovery ──────────────────────────────────────────────────────────────

  /** List all accounts known to this provider. */
  getAccounts(): Promise<MailAccount[]>;

  /**
   * List folders belonging to an account (or all accounts when accountId is
   * null/undefined). Returns a flat list; depth field encodes nesting level.
   */
  getFolders(accountId?: string | null): Promise<FolderInfo[]>;

  // ── Scan ───────────────────────────────────────────────────────────────────

  fetchMessages(
    options: FetchMailOptions,
    onProgress?: (count: number) => void,
  ): Promise<FetchMailResult>;

  // ── Actions (may return success:false for unimplemented providers) ─────────

  deleteMessages(messageIds: Array<string | number>): Promise<MoveDeleteResult>;
  moveMessagesToFolder(
    messageIds: Array<string | number>,
    accountId: string,
    folderPath: string,
    onProgress?: (moved: number, total: number) => void,
  ): Promise<MoveDeleteResult>;
  openMessage(messageId: string | number): Promise<{ success: boolean; error?: string }>;
}

export interface MailProviderRegistry {
  /** All registered providers. */
  list(): ReadonlyArray<{ id: string; name: string }>;

  /** Look up a provider by id — returns undefined for unknown ids. */
  get(id: string): MailProvider | undefined;

  /** The currently-selected provider (defaults to the first registered). */
  getActive(): MailProvider;

  /** Persist a provider selection for the lifetime of this process. */
  setActive(id: string): void;
}
