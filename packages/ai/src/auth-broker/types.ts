/**
 * Wire types shared between the auth-broker server and clients.
 *
 * The broker holds OAuth refresh tokens and exposes a redacted snapshot;
 * clients use `access` tokens directly and call back to the broker when a
 * credential expires or a 401 surfaces on a supposedly-fresh credential.
 */

import type {
	AuthCredential,
	AuthCredentialSnapshot,
	AuthCredentialSnapshotEntry,
	DisabledCredentialSummary,
	StoredCredentialBlock,
} from "../auth-storage";
import type {
	AccountUsageTotal,
	ClientUsageClientSummary,
	ClientUsageReport,
	UsageHistoryEntry,
	UsageReport,
} from "../usage";

/** GET /v1/healthz response body. */
export interface HealthzResponse {
	ok: boolean;
	version?: string;
}

export interface RefresherSchedule {
	enabled: boolean;
	intervalMs: number;
	skewMs: number;
	nextSweepInMs: number;
}

export type CredentialBlockSnapshot = Omit<StoredCredentialBlock, "credentialId">;

export type SnapshotEntry = AuthCredentialSnapshotEntry & {
	rotatesInMs: number | null;
	blocks?: CredentialBlockSnapshot[];
};

/** GET /v1/snapshot response body. */
export interface SnapshotResponse extends Omit<AuthCredentialSnapshot, "credentials"> {
	serverNowMs: number;
	refresher: RefresherSchedule;
	credentials: SnapshotEntry[];
}

/** GET /v1/usage response body — matches the local `AuthStorage.usage.reports` shape. */
export interface UsageResponse {
	generatedAt: number;
	reports: UsageReport[];
}

/**
 * GET /v1/usage/history response body. Entries come from the broker host's
 * durable `usage_history` — the broker performs every upstream usage fetch in
 * broker deployments, so this is the only complete utilization record.
 */
export interface UsageHistoryResponse {
	generatedAt: number;
	entries: UsageHistoryEntry[];
}

/** POST /v1/usage/observed request body — one client's batched observed usage. */
export type ClientUsageReportRequest = ClientUsageReport;

/** POST /v1/usage/observed response body. */
export interface ClientUsageReportResponse {
	ok: boolean;
}

/** GET /v1/usage/clients response body — per-client token burn aggregates. */
export interface ClientUsageSummaryResponse {
	generatedAt: number;
	clients: ClientUsageClientSummary[];
}

/** GET /v1/usage/accounts?sinceMs= response body — account-attributed usage of every client. */
export interface AccountUsageResponse {
	generatedAt: number;
	/** The window start the totals count after (exclusive), as requested. */
	sinceMs: number;
	accounts: AccountUsageTotal[];
	/** True when more (provider, account) pairs had usage than the response carries. */
	truncated: boolean;
}

/** POST /v1/credential/:id/refresh response body. */
export interface CredentialRefreshResponse {
	entry: AuthCredentialSnapshotEntry;
}

/** POST /v1/credential/:id/disable request body. */
export interface CredentialDisableRequest {
	cause: string;
}

/** POST /v1/credential/:id/disable response body. */
export interface CredentialDisableResponse {
	ok: boolean;
}

/** POST /v1/credential/:id/enabled request body. */
export interface CredentialEnabledRequest {
	enabled: boolean;
}

/** POST /v1/credential/:id/enabled response body. */
export interface CredentialEnabledResponse {
	ok: boolean;
}

/** GET /v1/credentials/disabled response body — tombstones of auto-disabled rows. */
export interface DisabledCredentialsResponse {
	generatedAt: number;
	disabled: DisabledCredentialSummary[];
}

/** POST /v1/credential/:id/block request body. */
export type CredentialBlockRequest = CredentialBlockSnapshot;

/** DELETE /v1/credential/:id/block request body; empty scope targets only the global row. */
export type CredentialBlockDeleteRequest = Pick<CredentialBlockSnapshot, "providerKey" | "blockScope">;

/** POST /v1/credential/:id/block response body. */
export interface CredentialBlockResponse {
	ok: boolean;
}

/** DELETE /v1/credential/:id/block or /blocks response body. */
export interface CredentialBlocksDeleteResponse {
	ok: boolean;
}

/** POST /v1/usage/stale response body. */
export interface UsageStaleResponse {
	ok: boolean;
}

/** One live shared cache row. */
export interface SharedCacheRow {
	key: string;
	value: string;
	/** Expiry in epoch seconds. */
	expiresAtSec: number;
}

/** GET /v1/cache?prefix= response body. */
export interface SharedCacheListResponse {
	generatedAt: number;
	rows: SharedCacheRow[];
	/** True when more live rows exist under the prefix than the response carries. */
	truncated: boolean;
}

/**
 * PUT /v1/cache/:key request body. An `expiresAtSec` at or before the
 * broker's clock, or an empty `value`, deletes the row.
 */
export interface SharedCachePutRequest {
	value: string;
	expiresAtSec: number;
}

/** PUT /v1/cache/:key or DELETE /v1/cache?prefix= response body. */
export interface SharedCacheWriteResponse {
	ok: boolean;
}

/**
 * POST /v1/credential request body. The OAuth `refresh` must be the *real*
 * refresh token (not the sentinel) — the broker is the canonical writer.
 */
export interface CredentialUploadRequest {
	provider: string;
	credential: AuthCredential;
}

/** POST /v1/credential response body — redacted snapshot of the provider's rows after upsert. */
export interface CredentialUploadResponse {
	entries: AuthCredentialSnapshotEntry[];
}

/**
 * SSE event kinds emitted on `GET /v1/snapshot/stream`. The same value is set
 * as the SSE `event:` name (load-bearing for clients) **and** embedded as a
 * `kind` field inside the JSON body so a Zod discriminated union can validate
 * the payload without consulting the line metadata.
 */
export type SnapshotStreamEventKind = "snapshot" | "entry" | "removed";

/** Initial frame emitted on connect — the full {@link SnapshotResponse}. */
export interface SnapshotStreamSnapshotEvent extends SnapshotResponse {
	kind: "snapshot";
}

/** Single credential added/changed (upsert or refresh). */
export interface SnapshotStreamEntryEvent {
	kind: "entry";
	generation: number;
	serverNowMs: number;
	refresher: RefresherSchedule;
	entry: SnapshotEntry;
}

/** Single credential disabled/deleted. */
export interface SnapshotStreamRemovedEvent {
	kind: "removed";
	generation: number;
	serverNowMs: number;
	refresher: RefresherSchedule;
	id: number;
}

/** Discriminated union of every event the snapshot stream emits. */
export type SnapshotStreamEvent = SnapshotStreamSnapshotEvent | SnapshotStreamEntryEvent | SnapshotStreamRemovedEvent;

/**
 * Default bearer-protected route prefix. The broker exposes `/v1/healthz`
 * unauthenticated for liveness probes; everything else requires a bearer.
 */
export const AUTH_BROKER_API_PREFIX = "/v1";

/** Request header used by clients to advertise optional auth-broker protocol features. */
export const AUTH_BROKER_CAPABILITIES_HEADER = "OMP-Auth-Broker-Capabilities";

/** Client understands independent Codex `chat` and `spark` credential-block scopes. */
export const AUTH_BROKER_CAPABILITY_CODEX_METER_BLOCK_SCOPES = "codex-meter-block-scopes";

/**
 * Client speaks the shared cache routes (`/v1/cache`). Advisory: brokers
 * without the routes answer 404, which clients treat as local-only caching.
 */
export const AUTH_BROKER_CAPABILITY_SHARED_CACHE = "shared-cache";

/**
 * Client reads user-disabled credentials: snapshot entries carry
 * `userDisabledAtMs`. Brokers omit user-disabled rows from clients that do not
 * announce it, so older clients never select them.
 */
export const AUTH_BROKER_CAPABILITY_USER_DISABLED_CREDENTIALS = "user-disabled-credentials";

/**
 * Client reads fleet account totals (`GET /v1/usage/accounts`). Advisory:
 * brokers without the route answer 404, which clients treat as local-only limits.
 */
export const AUTH_BROKER_CAPABILITY_ACCOUNT_USAGE = "account-usage";

/** Most account and provider filters one `GET /v1/usage/accounts` may carry, each. */
export const ACCOUNT_USAGE_MAX_FILTERS = 64;

/**
 * Most (provider, account) pairs one `GET /v1/usage/accounts` response
 * carries: every pair the largest filter can name, so a filtered answer is
 * never truncated.
 */
export const ACCOUNT_USAGE_MAX_ROWS = ACCOUNT_USAGE_MAX_FILTERS * ACCOUNT_USAGE_MAX_FILTERS;

/** Most entries one `POST /v1/usage/observed` report may carry. */
export const OBSERVED_USAGE_MAX_ENTRIES = 1000;

/** Longest install id, hostname, app, provider, or model one observed-usage report may carry. */
export const OBSERVED_USAGE_MAX_FIELD_LENGTH = 256;

/** Longest account usage key an observed-usage entry may carry. */
export const OBSERVED_USAGE_MAX_ACCOUNT_LENGTH = 256;

/** Largest request count one observed-usage entry may carry. */
export const OBSERVED_USAGE_MAX_REQUESTS = 1_000_000;

/** Largest token count of each kind one observed-usage entry may carry. */
export const OBSERVED_USAGE_MAX_TOKENS = 1_000_000_000_000;

/** Largest USD cost one observed-usage entry may carry. */
export const OBSERVED_USAGE_MAX_COST_USD = 1_000_000;

/**
 * How far an entry's `at` may lie ahead of the broker's clock; a later one is
 * recorded at the broker's now, so it cannot sit in future windows.
 */
export const OBSERVED_USAGE_MAX_FUTURE_SKEW_MS = 5 * 60_000;

/**
 * Longest window account usage is kept and totalled over (35 days, past any
 * calendar month): older attributed rows are pruned, an older `sinceMs` is
 * raised to it, and an attributed entry older than it is dropped.
 */
export const ACCOUNT_USAGE_HORIZON_MS = 35 * 24 * 60 * 60_000;

// C0 and C1 control characters, which no account usage key contains.
const ACCOUNT_CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;

/** Whether `value` is an acceptable account usage key on the wire: 1–256 characters, no control characters. */
export function isObservedUsageAccount(value: string): boolean {
	return (
		value.length > 0 && value.length <= OBSERVED_USAGE_MAX_ACCOUNT_LENGTH && !ACCOUNT_CONTROL_CHARACTER.test(value)
	);
}

/** Default port when none is configured. Loopback-only, no external exposure. */
export const DEFAULT_AUTH_BROKER_BIND = "127.0.0.1:8765";

/** Default broker→provider refresh skew. Refresh credentials this close to expiry. */
export const DEFAULT_REFRESH_SKEW_MS = 5 * 60_000;

/** Default broker refresh-loop cadence. */
export const DEFAULT_REFRESH_INTERVAL_MS = 60_000;

/** Default freshness window for the encrypted local broker snapshot cache. */
export const DEFAULT_SNAPSHOT_CACHE_TTL_MS = 60 * 60_000;

/** Keepalive cadence for `GET /v1/snapshot/stream` SSE comments. */
export const DEFAULT_STREAM_KEEPALIVE_MS = 20_000;

/**
 * Bun.serve `idleTimeout` (seconds) used by the broker. Default Bun idle
 * timeout (10s) would close long-lived SSE connections between keepalives.
 */
export const DEFAULT_SERVER_IDLE_TIMEOUT_S = 255;
