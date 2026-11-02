import type { Sql } from "./index.js";
import { kernels } from "../cljs-kernels.js";

type SqlExecutor = Pick<Sql, "unsafe">;

export type FederationPeerAuthMode = "admin_key" | "at_did";
export type FederationProjectedAccountState = "descriptor" | "remote_route" | "imported";

export interface FederationPeerRecord {
  readonly id: string;
  readonly ownerSubject: string;
  readonly peerDid?: string;
  readonly label: string;
  readonly baseUrl: string;
  readonly controlBaseUrl?: string;
  readonly authMode: FederationPeerAuthMode;
  readonly auth: Record<string, unknown>;
  readonly status: string;
  readonly capabilities: Record<string, unknown>;
  readonly lastSeenAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface FederationDiffEventRecord {
  readonly seq: number;
  readonly ownerSubject: string;
  readonly entityType: string;
  readonly entityKey: string;
  readonly op: string;
  readonly payload: Record<string, unknown>;
  readonly createdAt: string;
}

export interface FederationProjectedAccountRecord {
  readonly sourcePeerId: string;
  readonly ownerSubject: string;
  readonly providerId: string;
  readonly accountId: string;
  readonly accountSubject?: string;
  readonly chatgptAccountId?: string;
  readonly email?: string;
  readonly planType?: string;
  readonly availabilityState: FederationProjectedAccountState;
  readonly warmRequestCount: number;
  readonly lastRoutedAt?: string;
  readonly importedAt?: string;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface FederationPeerSyncStateRecord {
  readonly peerId: string;
  readonly lastPulledSeq: number;
  readonly lastPushedSeq: number;
  readonly lastPullAt?: string;
  readonly lastPushAt?: string;
  readonly lastError?: string;
  readonly updatedAt: string;
}

export const WARM_IMPORT_REQUEST_THRESHOLD = kernels.federationWarmImportThreshold(
  process.env.FEDERATION_WARM_IMPORT_REQUEST_THRESHOLD,
);

export function shouldWarmImportProjectedAccount(warmRequestCount: number, threshold = WARM_IMPORT_REQUEST_THRESHOLD): boolean {
  return kernels.federationShouldWarmImport(warmRequestCount, threshold);
}

interface SqlFederationStoreKernel {
  init(): Promise<void>;
  upsertPeer(input: PeerUpsertInput): Promise<FederationPeerRecord>;
  listPeers(ownerSubject?: string): Promise<FederationPeerRecord[]>;
  getPeer(id: string, executor?: SqlExecutor): Promise<FederationPeerRecord | undefined>;
  appendDiffEvent(input: DiffEventInput): Promise<FederationDiffEventRecord>;
  listDiffEvents(input: { readonly ownerSubject: string; readonly afterSeq?: number; readonly limit?: number }): Promise<FederationDiffEventRecord[]>;
  upsertProjectedAccount(input: ProjectedAccountUpsertInput): Promise<FederationProjectedAccountRecord>;
  getProjectedAccount(input: ProjectedAccountKey, executor?: SqlExecutor): Promise<FederationProjectedAccountRecord | undefined>;
  withProjectedAccountImportLock<T>(input: ProjectedAccountKey, fn: (tx: SqlExecutor) => Promise<T>): Promise<T | undefined>;
  noteProjectedAccountRouted(input: ProjectedAccountKey): Promise<FederationProjectedAccountRecord | undefined>;
  markProjectedAccountImported(input: ProjectedAccountKey, executor?: SqlExecutor): Promise<FederationProjectedAccountRecord | undefined>;
  getProjectedAccountsForOwner(ownerSubject: string): Promise<FederationProjectedAccountRecord[]>;
  listProjectedAccounts(ownerSubject?: string): Promise<FederationProjectedAccountRecord[]>;
  getSyncState(peerId: string): Promise<FederationPeerSyncStateRecord | undefined>;
  upsertSyncState(input: SyncStateInput): Promise<FederationPeerSyncStateRecord>;
}

interface PeerUpsertInput {
  readonly id?: string;
  readonly ownerCredential: string;
  readonly peerDid?: string;
  readonly label: string;
  readonly baseUrl: string;
  readonly controlBaseUrl?: string;
  readonly auth?: Record<string, unknown>;
  readonly capabilities?: Record<string, unknown>;
  readonly status?: string;
}

interface DiffEventInput {
  readonly ownerSubject: string;
  readonly entityType: string;
  readonly entityKey: string;
  readonly op: string;
  readonly payload?: Record<string, unknown>;
}

interface ProjectedAccountKey {
  readonly sourcePeerId: string;
  readonly providerId: string;
  readonly accountId: string;
}

interface ProjectedAccountUpsertInput extends ProjectedAccountKey {
  readonly ownerSubject: string;
  readonly accountSubject?: string;
  readonly chatgptAccountId?: string;
  readonly email?: string;
  readonly planType?: string;
  readonly availabilityState?: FederationProjectedAccountState;
  readonly metadata?: Record<string, unknown>;
}

interface SyncStateInput {
  readonly peerId: string;
  readonly lastPulledSeq?: number;
  readonly lastPushedSeq?: number;
  readonly lastPullAt?: boolean;
  readonly lastPushAt?: boolean;
  readonly lastError?: string | null;
}

/**
 * Federation peers, diff events, projected accounts and sync state in Postgres.
 * Statement texts and parameter decisions are proxx.credentials.federation-sql;
 * proxx.runtime.federation-store runs them. This class keeps the names and
 * types callers already use.
 */
export class SqlFederationStore {
  private readonly impl: SqlFederationStoreKernel;

  public constructor(sql: Sql) {
    this.impl = kernels.createSqlFederationStore(sql) as SqlFederationStoreKernel;
  }

  public init(): Promise<void> {
    return this.impl.init();
  }

  public upsertPeer(input: PeerUpsertInput): Promise<FederationPeerRecord> {
    return this.impl.upsertPeer(input);
  }

  public listPeers(ownerSubject?: string): Promise<FederationPeerRecord[]> {
    return this.impl.listPeers(ownerSubject);
  }

  public getPeer(id: string, executor?: SqlExecutor): Promise<FederationPeerRecord | undefined> {
    return this.impl.getPeer(id, executor);
  }

  public appendDiffEvent(input: DiffEventInput): Promise<FederationDiffEventRecord> {
    return this.impl.appendDiffEvent(input);
  }

  public listDiffEvents(input: {
    readonly ownerSubject: string;
    readonly afterSeq?: number;
    readonly limit?: number;
  }): Promise<FederationDiffEventRecord[]> {
    return this.impl.listDiffEvents(input);
  }

  public upsertProjectedAccount(input: ProjectedAccountUpsertInput): Promise<FederationProjectedAccountRecord> {
    return this.impl.upsertProjectedAccount(input);
  }

  public getProjectedAccount(input: ProjectedAccountKey, executor?: SqlExecutor): Promise<FederationProjectedAccountRecord | undefined> {
    return this.impl.getProjectedAccount(input, executor);
  }

  public withProjectedAccountImportLock<T>(
    input: ProjectedAccountKey,
    fn: (tx: SqlExecutor) => Promise<T>,
  ): Promise<T | undefined> {
    return this.impl.withProjectedAccountImportLock(input, fn);
  }

  public noteProjectedAccountRouted(input: ProjectedAccountKey): Promise<FederationProjectedAccountRecord | undefined> {
    return this.impl.noteProjectedAccountRouted(input);
  }

  public markProjectedAccountImported(
    input: ProjectedAccountKey,
    executor?: SqlExecutor,
  ): Promise<FederationProjectedAccountRecord | undefined> {
    return this.impl.markProjectedAccountImported(input, executor);
  }

  public getProjectedAccountsForOwner(ownerSubject: string): Promise<FederationProjectedAccountRecord[]> {
    return this.impl.getProjectedAccountsForOwner(ownerSubject);
  }

  public listProjectedAccounts(ownerSubject?: string): Promise<FederationProjectedAccountRecord[]> {
    return this.impl.listProjectedAccounts(ownerSubject);
  }

  public getSyncState(peerId: string): Promise<FederationPeerSyncStateRecord | undefined> {
    return this.impl.getSyncState(peerId);
  }

  public upsertSyncState(input: SyncStateInput): Promise<FederationPeerSyncStateRecord> {
    return this.impl.upsertSyncState(input);
  }
}
