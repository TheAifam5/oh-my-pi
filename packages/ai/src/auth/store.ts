import type { OAuthCredentials } from "../registry/oauth/types";
import type { Provider } from "../types";
import type {
	AccountUsageFilter,
	AccountUsageTotal,
	ClientUsageIdentity,
	ClientUsageReport,
	ClientUsageSummary,
	ObservedUsageEntry,
	UsageHistoryEntry,
	UsageHistoryQuery,
	UsageReport,
} from "../usage";
import type {
	AuthCredential,
	DisabledCredentialSummary,
	OAuthCredential,
	OAuthRefreshReason,
	StoredAuthCredential,
	StoredCredentialBlock,
} from "./types";

/** Owner and timestamp that fence a durable credential refresh lease. */
export interface CredentialRefreshLeaseFence {
	owner: string;
	nowMs: number;
}

/** Persisted credential rows and their transactional writes. */
export interface CredentialRowStore {
	close(): void;
	/**
	 * Stateful probe for commits made by another process to the backing store.
	 * Returns true once per observed change.
	 */
	pollExternalChanges?(): boolean;
	/** Record the current auth revision after a local mutation already notified consumers. */
	acknowledgeLocalChanges?(): void;
	listAuthCredentials(provider?: string): StoredAuthCredential[];
	/**
	 * Optional store hook to re-hydrate the credential snapshot from its
	 * backing source. Remote broker stores re-fetch `GET /v1/snapshot` so a
	 * disk-cached snapshot (up to an hour stale) cannot be paired with live
	 * per-credential data; local SQLite stores omit it — their reads are
	 * always current.
	 */
	refreshSnapshot?(): Promise<unknown>;
	/**
	 * Disabled credential tombstones (see {@link DisabledCredentialSummary}).
	 * Optional: remote stores forward to the broker's
	 * `GET /v1/credentials/disabled` (empty list when the broker predates the
	 * endpoint); stores without tombstones omit it.
	 */
	listDisabledCredentials?(provider?: string, signal?: AbortSignal): Promise<DisabledCredentialSummary[]>;
	updateAuthCredential(id: number, credential: AuthCredential): void;
	/**
	 * Disable one active row; return false if it was already absent or disabled.
	 * Remote stores await broker persistence before updating their snapshot.
	 */
	deleteAuthCredential(id: number, disabledCause: string): Promise<boolean>;
	tryDisableAuthCredentialIfMatches(
		id: number,
		expectedData: string,
		disabledCause: string,
		lease?: CredentialRefreshLeaseFence,
	): boolean;
	tryUpdateAuthCredentialIfMatches?(
		id: number,
		expectedData: string,
		credential: AuthCredential,
		lease?: CredentialRefreshLeaseFence,
	): boolean;
	/**
	 * Replace all active rows for a provider (e.g. API-key login replacing an
	 * older key). Remote stores forward the writes to the broker rather than
	 * mutating broker state locally. Update the local snapshot before returning.
	 */
	replaceAuthCredentials(provider: string, credentials: AuthCredential[]): Promise<StoredAuthCredential[]>;
	/**
	 * Upsert a credential through the authoritative writer and return the
	 * provider's active rows. Remote stores send `POST /v1/credential` to the
	 * broker. Implementations MUST update their local snapshot before returning
	 * so subsequent reads see the persisted result.
	 */
	upsertAuthCredential(provider: string, credential: AuthCredential): Promise<StoredAuthCredential[]>;
	/** Disable all active rows for a provider (logout), forwarding remote writes to the broker before returning. */
	deleteAuthCredentials(provider: string, disabledCause: string): Promise<void>;
}

/** One live row of the credential cache. */
export interface StoredCacheRow {
	key: string;
	value: string;
	/** Expiry in epoch seconds; the row is live while this is in the future. */
	expiresAtSec: number;
}

/** Persistent key/value cache shared by credential services. */
export interface CredentialCacheStore {
	getCache(key: string, options?: { includeExpired?: boolean }): string | null;
	setCache(key: string, value: string, expiresAtSec: number): void;
	/** Drop all cache rows whose keys start with the supplied prefix. */
	deleteCachePrefix?(prefix: string): void;
	cleanExpiredCache(): void;
	/**
	 * Live rows whose keys start with `prefix`, in key order, at most `limit`.
	 * Optional: the auth-broker server needs it to serve shared cache rows;
	 * stores without it make those routes answer 501.
	 */
	listCacheRows?(prefix: string, limit: number): StoredCacheRow[];
	/** Number of live rows whose keys start with `prefix`; present together with {@link listCacheRows}. */
	countCacheRows?(prefix: string): number;
	/** Remove the row under `key`, live or expired, if present. */
	deleteCache?(key: string): void;
	/** Remove the expired rows whose keys start with `prefix`. */
	deleteExpiredCacheRows?(prefix: string): void;
	/**
	 * Drop this process's copy of the row under `key` without telling any
	 * other process. Optional: stores whose copy is shared with other clients
	 * (the broker remote store) implement it; elsewhere callers clear the row
	 * with an expired {@link setCache}.
	 */
	forgetCache?(key: string): void;
}

/** Credential cache rows the auth-broker server shares with its clients (server seam over the store). */
export interface CacheApi {
	/** Live rows whose keys start with `prefix`, in key order, at most `limit`; undefined when the store cannot list. */
	list(prefix: string, limit: number): StoredCacheRow[] | undefined;
	/** Number of live rows whose keys start with `prefix`; undefined when the store cannot count. */
	count(prefix: string): number | undefined;
	/** The live value under `key`, or null. */
	get(key: string): string | null;
	/** Write one row; an `expiresAtSec` in the past removes it from every live read. */
	set(key: string, value: string, expiresAtSec: number): void;
	/** Remove the row under `key` without leaving an expired row behind; falls back to an expired write. */
	delete(key: string): void;
	/** Drop every row whose key starts with `prefix`. */
	deletePrefix(prefix: string): void;
	/** Remove every expired row. */
	cleanExpired(): void;
	/** Remove the expired rows whose keys start with `prefix`. */
	cleanExpiredPrefix(prefix: string): void;
}

/** Durable rate-limit blocks, present together when supported by the store. */
export interface CredentialBlockStore {
	/** Non-expired block for one (credential, providerKey, scope) key, or undefined. */
	getCredentialBlock(credentialId: number, providerKey: string, blockScope: string): number | undefined;
	/**
	 * Non-expired blocks for one credential and providerKey, keyed by block
	 * scope (`""` is unscoped), in one read. Optional: selectors fall back to
	 * {@link CredentialBlockStore.getCredentialBlock} per scope when absent.
	 */
	getCredentialBlockScopes?(credentialId: number, providerKey: string): ReadonlyMap<string, number>;
	/** Earliest time a shared-store block should be eligible for live-usage reconciliation. */
	getCredentialBlockReconcileAfter(credentialId: number, providerKey: string, blockScope: string): number | undefined;
	/** Upsert with MAX semantics: keep the later blockedUntilMs on conflict. */
	upsertCredentialBlock(block: StoredCredentialBlock): void;
	/** Drop one block row for a credential/provider/scope key. */
	deleteCredentialBlock(credentialId: number, providerKey: string, blockScope: string): void;
	/** Drop every block row for a credential (all providerKeys/scopes). */
	deleteCredentialBlocks(credentialId: number): void;
	/** Prune rows with blocked_until_ms <= nowMs. */
	cleanExpiredCredentialBlocks(nowMs: number): void;
	/** List non-expired blocks for broker snapshots. */
	listCredentialBlocks(credentialIds: readonly number[]): StoredCredentialBlock[];
}

/** Durable fencing for a single OAuth refresh owner. */
export interface CredentialRefreshLeaseStore {
	tryAcquireCredentialRefreshLease(credentialId: number, owner: string, expiresAtMs: number): boolean;
	getCredentialRefreshLeaseExpiresAt(credentialId: number): number | undefined;
	releaseCredentialRefreshLease(credentialId: number, owner: string): void;
	renewCredentialRefreshLease(credentialId: number, owner: string, expiresAtMs: number): boolean;
}

/** Usage history and client-observed request accounting. */
export interface UsageLedgerStore {
	/**
	 * Append usage-limit snapshots for trend history. Optional: stores without
	 * durable storage (e.g. the broker remote store) omit it and recording is
	 * skipped — the broker host records into its own database instead.
	 */
	recordUsageSnapshots(entries: UsageHistoryEntry[]): void;
	/** Read recorded usage-limit snapshots, oldest first. */
	listUsageHistory(query?: UsageHistoryQuery): UsageHistoryEntry[];
	/**
	 * Client hook: forward locally observed request usage. Remote broker stores
	 * batch these to the broker so it can attribute token burn per install;
	 * local stores omit it and observation is skipped.
	 * `client` overrides the reporting identity (gateway requests attribute to
	 * the originating client, not the gateway host).
	 */
	recordObservedUsage(entries: ObservedUsageEntry[], client?: ClientUsageIdentity): void;
	/** Broker host: persist one client's observed-usage report. */
	recordClientUsage(report: ClientUsageReport): void;
	/** Broker host: aggregate recorded per-client usage since a timestamp. */
	getClientUsageSummary(sinceMs: number): ClientUsageSummary;
	/**
	 * Broker host: usage every client attributed to an account, per
	 * (provider, account), over requests stamped after `sinceMs` (epoch ms),
	 * at most `limit` rows, highest cost first; `filter` keeps only the listed
	 * providers and accounts.
	 */
	getClientAccountUsage(sinceMs: number, limit: number, filter?: AccountUsageFilter): AccountUsageTotal[];
	/**
	 * Client hook: the fleet-wide usage of `account` on `provider` after
	 * `sinceMs`, from the latest broker totals, or undefined when none recent
	 * enough is known. Synchronous; remote stores refresh the totals in the
	 * background.
	 */
	accountUsageTotals(provider: string, account: string, sinceMs: number, nowMs: number): AccountUsageTotal | undefined;
}

/** Broker-delegated OAuth refresh and usage-report operations. */
export interface CredentialUpstream {
	/** Optional hook to notify the underlying store that usage reports (one provider's, when given) are stale. */
	invalidateUsageCache(provider?: string, signal?: AbortSignal): Promise<void>;
	/**
	 * Optional store-supplied OAuth refresh. When present, `AuthStorage` uses
	 * it before the per-provider local refresh path. `RemoteAuthCredentialStore`
	 * implements this against the broker; SQLite stores leave it undefined.
	 *
	 * Precedence: `AuthStorageOptions.refreshOAuthCredential` > this hook > local.
	 *
	 * `signal` propagates the agent's cancel (ESC, request abort, …) all the
	 * way to the broker fetch so a hung connection can't strand the caller
	 * for `timeoutMs * (maxRetries + 1)`.
	 * `reason` distinguishes provider-auth recovery from generic/MCP refreshes
	 * that must always mint a new access token.
	 */
	refreshOAuthCredential(
		provider: Provider,
		credentialId: number,
		credential: OAuthCredential,
		signal?: AbortSignal,
		reason?: OAuthRefreshReason,
	): Promise<OAuthCredentials>;
	/**
	 * Optional async pre-read hook invoked after AuthStorage selects a stored
	 * credential but before it returns that credential for an outbound request.
	 * Remote broker stores use this to wait out imminent rotations and refresh
	 * their local snapshot before the caller sees a stale access token.
	 */
	prepareForRequest(credentialId: number, opts?: { signal?: AbortSignal }): Promise<boolean | undefined>;
	/**
	 * Optional store-supplied aggregate usage fetch. When present, `AuthStorage`
	 * routes `fetchUsageReports()` here instead of fanning out per-credential.
	 * `RemoteAuthCredentialStore` proxies to the broker (whose datacenter IP
	 * isn't rate-limited like a heavy residential client).
	 *
	 * Precedence: `AuthStorageOptions.fetchUsageReports` > this hook > local fan-out.
	 *
	 * `signal` propagates the agent's cancel down to the broker fetch.
	 */
	fetchUsageReports(signal?: AbortSignal): Promise<UsageReport[] | null>;
	/**
	 * Optional store-supplied per-credential usage report lookup. When present,
	 * `AuthStorage` consults this before its own per-credential upstream fetch
	 * (`UsageService.report`). `RemoteAuthCredentialStore` implements this against
	 * the broker's aggregate `/v1/usage` (one coalesced round-trip shared across
	 * all callers) so multi-credential ranking on the client never hits the
	 * upstream provider's rate-limited usage endpoint from the laptop IP.
	 *
	 * Returning `null` is authoritative — `AuthStorage` does NOT fall back to
	 * the local fetch path. The store hook owns the decision, since falling
	 * back would re-introduce the per-IP rate-limit problem the broker exists
	 * to avoid.
	 *
	 * `signal` propagates the agent's cancel down to the broker fetch.
	 */
	getUsageReport(provider: Provider, credential: OAuthCredential, signal?: AbortSignal): Promise<UsageReport | null>;
	/**
	 * Optional store hook to ingest a parsed provider usage report for one OAuth
	 * credential. Remote broker stores use this to overlay header-derived limits
	 * onto their cached aggregate `/v1/usage` response without mutating broker
	 * state.
	 */
	ingestUsageReport(provider: Provider, credential: OAuthCredential, report: UsageReport): boolean;
	/**
	 * Optional store hook to invalidate a specific credential after the upstream
	 * provider returned 401 on a supposedly-fresh key. Remote stores force the
	 * broker to re-issue the row; local stores can leave it undefined and let
	 * {@link AuthStorage.limits.invalidateMatching} fall back to `reload()`.
	 */
	markCredentialSuspect(credentialId: number, opts?: { signal?: AbortSignal }): Promise<void>;
}

/**
 * Persistence abstraction consumed by {@link AuthStorage}. Core credential rows
 * and cache are always available; each other concern is supported independently.
 * Concrete implementations are {@link SqliteAuthCredentialStore} and the broker's
 * `RemoteAuthCredentialStore`.
 */
export interface AuthCredentialStore
	extends
		CredentialRowStore,
		CredentialCacheStore,
		Partial<CredentialBlockStore>,
		Partial<CredentialRefreshLeaseStore>,
		Partial<UsageLedgerStore>,
		Partial<CredentialUpstream> {}

/** Narrow stores that implement the complete durable refresh-lease concern. */
export function hasRefreshLeases(
	store: AuthCredentialStore,
): store is AuthCredentialStore & CredentialRefreshLeaseStore {
	return (
		typeof store.tryAcquireCredentialRefreshLease === "function" &&
		typeof store.getCredentialRefreshLeaseExpiresAt === "function" &&
		typeof store.releaseCredentialRefreshLease === "function" &&
		typeof store.renewCredentialRefreshLease === "function"
	);
}
