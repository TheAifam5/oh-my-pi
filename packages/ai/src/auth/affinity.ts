import { logger } from "@oh-my-pi/pi-utils";
import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import { getEnvApiKey } from "../env-api-key";
import * as AIError from "../error";
import type {
	AccountPinSource,
	AccountRouting,
	AuthAccountSummary,
	AuthCredential,
	OAuthCredential,
	SessionRestrictionLease,
	SessionsApi,
} from "./types";
import type { AuthCredentialStore } from "./store";
import type { CredentialPool } from "./pool";
import type { KeyOverrides } from "./cascade";
import { resolveCredentialIdentityKey } from "./sqlite-credential-store";
import { type AccountPolicies, apiKeyFingerprint } from "./policy";
import { parseSessionDrain, serializeSessionDrain, sessionDrainKey } from "./drain-state";

/** Prefix for persisted session-to-credential affinity. */
export const SESSION_STICKY_CACHE_PREFIX = "session:sticky:";
/** Prefix for persisted exclusive session pins; kept apart from stickies so routing resets never drop a pin. */
export const SESSION_PIN_CACHE_PREFIX = "session:pin:";
/** Persisted sticky rows live this long past their last use. */
const SESSION_STICKY_TTL_SEC = 30 * 24 * 60 * 60;
/**
 * Same-credential re-records rewrite the persisted row at most this often. The
 * in-memory sticky stays exact; only the copy other processes resume from lags.
 */
const SESSION_STICKY_PERSIST_INTERVAL_MS = 60_000;
/**
 * In-memory pins kept per provider. Long-lived gateways mint a session id per
 * conversation; evicted sessions resume from their persisted sticky row.
 */
const SESSION_AFFINITY_MAX_SESSIONS_PER_PROVIDER = 256;
/**
 * How long a store miss for a session's pin, drain override, or sticky row is
 * trusted before that row is read again. A write through this affinity
 * invalidates the miss at once; a row another process writes for the same
 * session is seen at most this late.
 */
const SESSION_ROW_MISS_TTL_MS = 1_500;
/** Store misses remembered at once, across providers and row kinds. */
const SESSION_ROW_MISSES_MAX = 1_024;

/** What this process last wrote (or read) for one persisted sticky row. */
type PersistedSticky = {
	type: AuthCredential["type"];
	credentialId: number;
	explicit: boolean;
	lastUsedAtMs: number;
};

/** A session's pinned credential (resolved index + durable row id). */
export type SessionCredential = {
	type: AuthCredential["type"];
	index: number;
	credentialId?: number;
	lastUsedAtMs?: number;
	/** Set only by the public user-facing pin API, which makes the pin exclusive; automatic warm affinity leaves it absent. */
	explicit?: true;
};

/**
 * How long a retired session restriction ({@link SessionAffinity.retire}) keeps
 * denying accounts outside its allowlist, measured on a monotonic clock from the
 * moment it was retired. It must exceed the longest deferred lookup (scan job,
 * side request) an ended session leaves behind, because a lookup after expiry
 * runs unrestricted. Reads do not extend it.
 */
export const SESSION_RESTRICTION_TOMBSTONE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Memory guard on the retired restrictions kept at once, across providers.
 * Past it the earliest retired ones are evicted first, and their session ids
 * are unrestricted again before their TTL ends.
 */
export const SESSION_RESTRICTION_TOMBSTONES_HARD_CAP = 65_536;

/** Minimum time between two full sweeps of expired retired restrictions. */
const SESSION_RESTRICTION_SWEEP_INTERVAL_MS = 60_000;

/**
 * A monotonic clock in milliseconds: it never moves backwards and wall-clock
 * changes (NTP steps, manual changes) do not move it. Only differences between
 * two readings are meaningful.
 */
export type MonotonicClock = () => number;

const monotonicNow: MonotonicClock = () => performance.now();

/**
 * One installed restriction: {@link identityHash} digests of the allowed OAuth
 * identity keys, so no email or account id is retained, and the lease that lifts it.
 */
type SessionRestriction = { readonly allowedHashes: ReadonlySet<string>; readonly lease: SessionRestrictionLease };

/**
 * A retired restriction: it keeps denying accounts outside its allowlist until
 * replaced, lifted, expired ({@link SESSION_RESTRICTION_TOMBSTONE_TTL_MS} after
 * `retiredAtMs`), or evicted by the safety cap.
 */
type RestrictionTombstone = SessionRestriction & {
	readonly provider: string;
	readonly sessionId: string;
	/** {@link MonotonicClock} reading when it was retired. */
	readonly retiredAtMs: number;
};

/** Minimum time between two eviction warnings of one `AuthStorage`; evictions in between are counted. */
export const SESSION_RESTRICTION_EVICTION_LOG_INTERVAL_MS = 60_000;

/** Minimum time between two expiry debug records of one `AuthStorage`; expiries in between are counted. */
export const SESSION_RESTRICTION_EXPIRY_LOG_INTERVAL_MS = 60_000;

/**
 * Retired session restrictions of one `AuthStorage`, keyed by {@link tombstoneKey}.
 *
 * Expiry is evaluated on every read, so an expired entry is never returned,
 * and a full sweep runs at most once per {@link SESSION_RESTRICTION_SWEEP_INTERVAL_MS}
 * when an entry is added or a restriction installed, so memory stays bounded
 * by the TTL times the retire rate. Ages, intervals, and rate limits are read
 * from the {@link MonotonicClock} given at construction, so a wall-clock step
 * neither expires an entry early nor keeps it longer. A clock reading earlier
 * than an entry's `retiredAtMs`, which a monotonic clock does not produce,
 * reads as not expired: the restriction stays rather than lifting early.
 *
 * Every expired entry dropped is counted, and a debug record with the provider
 * and the expiries since the previous record is logged at most once per
 * {@link SESSION_RESTRICTION_EXPIRY_LOG_INTERVAL_MS}; expiries after the last
 * record are reported with the next one. No session id is logged.
 *
 * Past {@link SESSION_RESTRICTION_TOMBSTONES_HARD_CAP} entries the earliest
 * retired is evicted. An eviction logs a warning with the provider, the cap,
 * and the evictions since the previous warning, at most once per
 * {@link SESSION_RESTRICTION_EVICTION_LOG_INTERVAL_MS}; evictions after the
 * last warning are reported with the next one. No session id is logged.
 */
export class RetiredRestrictions {
	/** Insertion order is retirement order: an entry is deleted before it is set again. */
	readonly #entries = new Map<string, RestrictionTombstone>();
	readonly #now: MonotonicClock;
	#lastSweepAtMs: number | undefined;
	#evictedSinceWarning = 0;
	#lastWarningAtMs: number | undefined;
	#expiredSinceRecord = 0;
	#lastExpiryRecordAtMs: number | undefined;

	/** `now` ages the entries; it defaults to `performance.now()`. */
	constructor(now: MonotonicClock = monotonicNow) {
		this.#now = now;
	}

	/** The unexpired retired restriction under `key`; an expired one is dropped. */
	get(key: string): RestrictionTombstone | undefined {
		const tombstone = this.#entries.get(key);
		if (tombstone === undefined) return undefined;
		const nowMs = this.#now();
		if (!RetiredRestrictions.#expired(tombstone, nowMs)) return tombstone;
		this.#dropExpired(key, tombstone, nowMs);
		return undefined;
	}

	/** Every unexpired retired restriction, earliest retired first; expired ones are dropped. */
	values(): RestrictionTombstone[] {
		const nowMs = this.#now();
		const values: RestrictionTombstone[] = [];
		for (const [key, tombstone] of this.#entries) {
			if (RetiredRestrictions.#expired(tombstone, nowMs)) this.#dropExpired(key, tombstone, nowMs);
			else values.push(tombstone);
		}
		return values;
	}

	delete(key: string): void {
		this.#entries.delete(key);
	}

	/** Retire `restriction` for `provider`/`sessionId` now, replacing any entry under its key. */
	add(provider: string, sessionId: string, restriction: SessionRestriction): void {
		const nowMs = this.#now();
		this.sweep(nowMs);
		const key = tombstoneKey(provider, sessionId);
		this.#entries.delete(key);
		this.#entries.set(key, { ...restriction, provider, sessionId, retiredAtMs: nowMs });
		while (this.#entries.size > SESSION_RESTRICTION_TOMBSTONES_HARD_CAP) {
			const earliest = this.#entries.entries().next().value;
			if (earliest === undefined) break;
			this.#entries.delete(earliest[0]);
			this.#noteEviction(earliest[1].provider, nowMs);
		}
	}

	/** Drop every expired entry, unless a sweep ran within {@link SESSION_RESTRICTION_SWEEP_INTERVAL_MS}. */
	sweep(nowMs = this.#now()): void {
		const elapsedMs = this.#lastSweepAtMs === undefined ? undefined : nowMs - this.#lastSweepAtMs;
		// A clock reading that went backwards counts as elapsed, so it cannot postpone sweeps.
		if (elapsedMs !== undefined && elapsedMs >= 0 && elapsedMs < SESSION_RESTRICTION_SWEEP_INTERVAL_MS) return;
		this.#lastSweepAtMs = nowMs;
		for (const [key, tombstone] of this.#entries) {
			if (RetiredRestrictions.#expired(tombstone, nowMs)) this.#dropExpired(key, tombstone, nowMs);
		}
	}

	static #expired(tombstone: RestrictionTombstone, nowMs: number): boolean {
		const ageMs = nowMs - tombstone.retiredAtMs;
		// A negative age (a clock reading below the retirement stamp) fails closed: the restriction stays.
		return ageMs >= SESSION_RESTRICTION_TOMBSTONE_TTL_MS;
	}

	#dropExpired(key: string, tombstone: RestrictionTombstone, nowMs: number): void {
		this.#entries.delete(key);
		this.#expiredSinceRecord += 1;
		const elapsedMs = this.#lastExpiryRecordAtMs === undefined ? undefined : nowMs - this.#lastExpiryRecordAtMs;
		// A clock reading that went backwards counts as elapsed, so it cannot silence records.
		if (elapsedMs !== undefined && elapsedMs >= 0 && elapsedMs < SESSION_RESTRICTION_EXPIRY_LOG_INTERVAL_MS) return;
		logger.debug("Retired session account restrictions expired; their session ids are unrestricted again", {
			provider: tombstone.provider,
			expired: this.#expiredSinceRecord,
		});
		this.#expiredSinceRecord = 0;
		this.#lastExpiryRecordAtMs = nowMs;
	}

	#noteEviction(provider: string, nowMs: number): void {
		this.#evictedSinceWarning += 1;
		const elapsedMs = this.#lastWarningAtMs === undefined ? undefined : nowMs - this.#lastWarningAtMs;
		// A clock reading that went backwards counts as elapsed, so it cannot silence warnings.
		if (elapsedMs !== undefined && elapsedMs >= 0 && elapsedMs < SESSION_RESTRICTION_EVICTION_LOG_INTERVAL_MS) return;
		logger.warn(
			"Evicted retired session account restrictions past the safety cap; their session ids are unrestricted again",
			{
				provider,
				limit: SESSION_RESTRICTION_TOMBSTONES_HARD_CAP,
				evicted: this.#evictedSinceWarning,
			},
		);
		this.#evictedSinceWarning = 0;
		this.#lastWarningAtMs = nowMs;
	}
}

/**
 * Session account restrictions. Owned by `AuthStorage` so they outlive store
 * replacement, which rebuilds every store-bound module (pins included) around
 * the same identities.
 */
export type SessionRestrictions = {
	/** Provider → session id → live restriction. Never evicted: that would widen a live session. */
	readonly live: Map<string, Map<string, SessionRestriction>>;
	/** Retired restrictions, kept until their TTL ends ({@link RetiredRestrictions}). */
	readonly retired: RetiredRestrictions;
};

/** Empty restriction state for one `AuthStorage`; `now` ages retired restrictions ({@link RetiredRestrictions}). */
export function createSessionRestrictions(now?: MonotonicClock): SessionRestrictions {
	return { live: new Map(), retired: new RetiredRestrictions(now) };
}

function tombstoneKey(provider: string, sessionId: string): string {
	return `${provider}\0${sessionId}`;
}

/** An exclusive session pin of one session and provider. */
type SessionPin = {
	/** The pinned row id, or `null` for an account no longer stored. */
	credentialId: number | null;
	/**
	 * {@link identityHash} of the pinned account's OAuth identity key, when known. A
	 * restricted session fails closed on a pin whose account is gone only when an
	 * allowed key has this hash; otherwise the pin cannot be shown to be inside
	 * its allowlist and is ignored.
	 */
	identityHash?: string;
	/**
	 * Set on a copy {@link SessionAffinity.forgetInherited} may drop once persisted:
	 * one {@link SessionAffinity.inherit} wrote, or one read back from the store.
	 */
	releasable?: true;
	/** False when writing the persisted row failed, so this in-memory copy is the only one. */
	persisted: boolean;
};

/** A session drain override: a row id, or `null` for no drain target. */
type DrainOverride = { credentialId: number | null; releasable?: true; persisted: boolean };

/**
 * One-way digest of an OAuth identity key, so persisted pin rows never hold an
 * email or account id. Pins persisted with a plaintext `identityKey` field read
 * as identity unknown.
 */
export function identityHash(identityKey: string): string {
	return Bun.SHA256.hash(identityKey, "hex");
}

/** Value of `sessionId`/`provider` in a session-keyed map of provider maps. */
function nestedGet<V>(map: Map<string, Map<string, V>>, sessionId: string, provider: string): V | undefined {
	return map.get(sessionId)?.get(provider);
}

/** Set (or with `undefined`, delete) the value of `sessionId`/`provider`, dropping an emptied session map. */
function nestedSet<V>(
	map: Map<string, Map<string, V>>,
	sessionId: string,
	provider: string,
	value: V | undefined,
): void {
	let providers = map.get(sessionId);
	if (value === undefined) {
		providers?.delete(provider);
		if (providers?.size === 0) map.delete(sessionId);
		return;
	}
	if (!providers) {
		providers = new Map();
		map.set(sessionId, providers);
	}
	providers.set(provider, value);
}

/** Drop the releasable, persisted entries of `sessionId`, keeping its own and any whose row failed to persist. */
function dropReleasable<V extends { releasable?: true; persisted: boolean }>(
	map: Map<string, Map<string, V>>,
	sessionId: string,
): void {
	const providers = map.get(sessionId);
	if (!providers) return;
	for (const [provider, value] of providers) {
		if (value.releasable && value.persisted) providers.delete(provider);
	}
	if (providers.size === 0) map.delete(sessionId);
}

/** Whether two stored credentials are the same account: same API key, or same OAuth identity and scope. */
function sameAccount(left: AuthCredential, right: AuthCredential): boolean {
	if (left.type === "api_key" || right.type === "api_key") {
		return left.type === "api_key" && right.type === "api_key" && left.key === right.key;
	}
	return (
		(left.accountId !== undefined || left.email !== undefined) &&
		left.accountId === right.accountId &&
		left.email === right.email &&
		left.orgId === right.orgId &&
		left.projectId === right.projectId
	);
}

/** One stored credential a pin or preference resolved to. */
export type AccountTarget = { index: number; credential: AuthCredential };

/** Session → credential affinity (pins), persisted in the store cache. */
export class SessionAffinity implements SessionsApi {
	/** Tracks the last used credential per provider for a session (used for rate-limit switching). */
	#sessionLastCredential: Map<string, LRUCache<string, SessionCredential>> = new Map();
	/** Persisted sticky rows per provider, keyed by session id, so unchanged re-records skip the write. */
	#persistedSticky: Map<string, LRUCache<string, PersistedSticky>> = new Map();
	/**
	 * Exclusive session pins by session id, then provider.
	 * Not LRU-bounded: entries exist only for pinned sessions, and an entry whose row failed to persist
	 * is the only copy, so evicting one would let a pinned session route to a different account. Copies
	 * {@link inherit} wrote leave memory through {@link forgetInherited} when the session ends.
	 */
	#exclusivePins: Map<string, Map<string, SessionPin>> = new Map();
	#pinSource: AccountPinSource | undefined;
	/** `provider\0sessionId` whose pin a restriction overrode and was already logged; one bounded LRU. */
	#restrictedPinWarnings = new LRUCache<string, true>({ max: SESSION_AFFINITY_MAX_SESSIONS_PER_PROVIDER });
	/** Session drain overrides by session id, then provider, persisted in the store cache. */
	#drainOverrides: Map<string, Map<string, DrainOverride>> = new Map();
	/**
	 * Store cache keys of pin, drain, and sticky rows last read as absent, with the
	 * `Date.now()` until which that miss is trusted ({@link SESSION_ROW_MISS_TTL_MS}).
	 * Every write of a row through this affinity deletes its key.
	 */
	#rowMisses = new LRUCache<string, number>({ max: SESSION_ROW_MISSES_MAX });
	#store: AuthCredentialStore;
	#pool: CredentialPool;
	#overrides: KeyOverrides;
	#restrictions: SessionRestrictions;
	#policies: AccountPolicies;

	constructor(
		store: AuthCredentialStore,
		pool: CredentialPool,
		overrides: KeyOverrides,
		restrictions: SessionRestrictions,
		policies: AccountPolicies,
	) {
		this.#store = store;
		this.#pool = pool;
		this.#overrides = overrides;
		this.#restrictions = restrictions;
		this.#policies = policies;
	}

	restrict(provider: string, sessionId: string, identityKeys: readonly string[]): SessionRestrictionLease {
		if (!provider || !sessionId) throw new Error("sessions.restrict requires a provider and a session id");
		return this.#install(provider, sessionId, new Set(identityKeys.map(identityHash)));
	}

	/** Install a live restriction of `allowedHashes`, replacing a live or retired one; returns its new lease. */
	#install(provider: string, sessionId: string, allowedHashes: ReadonlySet<string>): SessionRestrictionLease {
		const lease = Symbol("sessions.restrict");
		const sessions = this.#restrictions.live.get(provider) ?? new Map<string, SessionRestriction>();
		sessions.set(sessionId, { allowedHashes, lease });
		this.#restrictions.live.set(provider, sessions);
		this.#restrictions.retired.delete(tombstoneKey(provider, sessionId));
		this.#restrictions.retired.sweep();
		return lease;
	}

	/** Remove the live restriction of `sessionId` when `lease` installed it; returns it, or `undefined`. */
	#takeLive(provider: string, sessionId: string, lease: SessionRestrictionLease): SessionRestriction | undefined {
		const sessions = this.#restrictions.live.get(provider);
		const restriction = sessions?.get(sessionId);
		if (!sessions || restriction?.lease !== lease) return undefined;
		sessions.delete(sessionId);
		if (sessions.size === 0) this.#restrictions.live.delete(provider);
		return restriction;
	}

	unrestrict(provider: string, sessionId: string, lease: SessionRestrictionLease): void {
		if (this.#takeLive(provider, sessionId, lease)) return;
		const key = tombstoneKey(provider, sessionId);
		if (this.#restrictions.retired.get(key)?.lease === lease) this.#restrictions.retired.delete(key);
	}

	retire(provider: string, sessionId: string, lease: SessionRestrictionLease): void {
		const restriction = this.#takeLive(provider, sessionId, lease);
		if (!restriction) return;
		this.#restrictions.retired.add(provider, sessionId, restriction);
	}

	restrictLike(sourceSessionId: string, targetSessionId: string): ReadonlyMap<string, SessionRestrictionLease> {
		if (!sourceSessionId || !targetSessionId) {
			throw new Error("sessions.restrictLike requires a source and a target session id");
		}
		const copies = new Map<string, ReadonlySet<string>>();
		for (const tombstone of this.#restrictions.retired.values()) {
			if (tombstone.sessionId === sourceSessionId) copies.set(tombstone.provider, tombstone.allowedHashes);
		}
		for (const [provider, sessions] of this.#restrictions.live) {
			const source = sessions.get(sourceSessionId);
			if (source) copies.set(provider, source.allowedHashes);
		}
		const leases = new Map<string, SessionRestrictionLease>();
		for (const [provider, allowedHashes] of copies) {
			leases.set(provider, this.#install(provider, targetSessionId, allowedHashes));
		}
		return leases;
	}

	/**
	 * Digests of the identity keys `sessionId` may use for `provider`: its live
	 * restriction, else its unexpired retired one, else `undefined` for an
	 * unrestricted session.
	 */
	#allowedHashes(provider: string, sessionId: string | undefined): ReadonlySet<string> | undefined {
		if (sessionId === undefined) return undefined;
		return (
			this.#restrictions.live.get(provider)?.get(sessionId)?.allowedHashes ??
			this.#restrictions.retired.get(tombstoneKey(provider, sessionId))?.allowedHashes
		);
	}

	/** True when `sessionId` is restricted for `provider` only by a retired restriction (see {@link retire}). */
	restrictionRetired(provider: string, sessionId: string | undefined): boolean {
		return (
			sessionId !== undefined &&
			this.#restrictions.live.get(provider)?.has(sessionId) !== true &&
			this.#restrictions.retired.get(tombstoneKey(provider, sessionId)) !== undefined
		);
	}

	/** Whether the store row `key` was read as absent within {@link SESSION_ROW_MISS_TTL_MS}. */
	#recentlyMissed(key: string): boolean {
		const until = this.#rowMisses.get(key);
		if (until === undefined) return false;
		const remainingMs = until - Date.now();
		// A wall clock stepped backwards (NTP, resume) would otherwise extend the miss by the step.
		if (remainingMs > 0 && remainingMs <= SESSION_ROW_MISS_TTL_MS) return true;
		this.#rowMisses.delete(key);
		return false;
	}

	#noteMiss(key: string): void {
		this.#rowMisses.set(key, Date.now() + SESSION_ROW_MISS_TTL_MS);
	}

	/** True when a live or retired restriction ({@link restrict}, {@link retire}) limits `sessionId` for `provider`. */
	isRestricted(provider: string, sessionId: string | undefined): boolean {
		return this.#allowedHashes(provider, sessionId) !== undefined;
	}

	/**
	 * True when `credential` may serve `sessionId`: always for an unrestricted
	 * session, otherwise only an OAuth credential whose identity key is allowed.
	 */
	allows(provider: string, sessionId: string | undefined, credential: AuthCredential): boolean {
		const allowedHashes = this.#allowedHashes(provider, sessionId);
		if (allowedHashes === undefined) return true;
		if (credential.type !== "oauth") return false;
		const identityKey = resolveCredentialIdentityKey(provider, credential);
		return identityKey !== null && allowedHashes.has(identityHash(identityKey));
	}

	/** Whether the stored row at `index` may serve `sessionId` (see {@link allows}). */
	#permits(provider: string, sessionId: string, index: number): boolean {
		if (!this.isRestricted(provider, sessionId)) return true;
		const credential = this.#pool.credentials(provider)[index];
		return credential !== undefined && this.allows(provider, sessionId, credential);
	}

	permits(provider: string, sessionId: string, credentialId: number): boolean {
		if (!this.isRestricted(provider, sessionId)) return true;
		const entry = this.#pool.entries(provider).find(candidate => candidate.id === credentialId);
		return entry !== undefined && this.allows(provider, sessionId, entry.credential);
	}

	admits(provider: string, sessionId: string | undefined, credentialId: number): boolean {
		return sessionId === undefined || this.permits(provider, sessionId, credentialId);
	}

	/** Whether an identity key in the allowlist of the restricted `sessionId` has the digest `hash`. */
	#allowsIdentity(provider: string, sessionId: string, hash: string | undefined): boolean {
		return hash !== undefined && this.#allowedHashes(provider, sessionId)?.has(hash) === true;
	}

	/** Bounded per-provider session map, created on first use. */
	static #sessionsFor<V>(maps: Map<string, LRUCache<string, V>>, provider: string): LRUCache<string, V> {
		let sessions = maps.get(provider);
		if (!sessions) {
			sessions = new LRUCache<string, V>({ max: SESSION_AFFINITY_MAX_SESSIONS_PER_PROVIDER });
			maps.set(provider, sessions);
		}
		return sessions;
	}

	setAccountPinSource(source: AccountPinSource | undefined): void {
		this.#pinSource = source;
	}

	/**
	 * Take over the pin source, the exclusive pins, and the session drain
	 * overrides of the affinity this one replaces (credential store swap). Row
	 * ids are store-specific, so each moves to the stored credential with the
	 * same identity (OAuth account or API key fingerprint); a pin with no such
	 * credential fails closed, a drain override falls back to the account policy.
	 *
	 * The persisted pins and overrides of every session this process holds
	 * state for are read from the previous store first, so one another process
	 * wrote and this process never read carries over too. The rows of a session
	 * this process holds nothing for stay behind: the store cannot list them.
	 */
	adoptPins(previous: SessionAffinity): void {
		this.#pinSource = previous.#pinSource;
		// Read every row afresh: a cached miss would drop a pin another process wrote just now.
		previous.#rowMisses.clear();
		const providers = previous.#pool.providers();
		for (const sessionId of previous.#knownSessionIds()) {
			for (const provider of providers) {
				previous.#sessionPin(provider, sessionId);
				previous.drainOverride(provider, sessionId);
			}
		}
		for (const [sessionId, pins] of previous.#exclusivePins) {
			for (const [provider, pin] of pins) {
				const credential =
					pin.credentialId === null
						? undefined
						: previous.#pool.entries(provider).find(entry => entry.id === pin.credentialId)?.credential;
				const match = credential
					? this.#pool.entries(provider).find(entry => sameAccount(entry.credential, credential))
					: undefined;
				this.#writeSessionPin(provider, sessionId, {
					credentialId: match?.id ?? null,
					identityHash: pin.identityHash,
					releasable: pin.releasable,
				});
			}
		}
		for (const [sessionId, overrides] of previous.#drainOverrides) {
			for (const [provider, override] of overrides) {
				if (override.credentialId === null) {
					this.#writeDrainOverride(provider, sessionId, null, override.releasable);
					continue;
				}
				const credentialId = override.credentialId;
				const credential = previous.#pool.entries(provider).find(entry => entry.id === credentialId)?.credential;
				const match = credential
					? this.#pool.entries(provider).find(entry => sameAccount(entry.credential, credential))
					: undefined;
				// A drain target missing from the new store falls back to the account policy.
				this.#writeDrainOverride(provider, sessionId, match?.id, override.releasable);
			}
		}
	}

	/** Session ids this affinity holds a pin, override, sticky, or restriction for. */
	#knownSessionIds(): Set<string> {
		const sessionIds = new Set([...this.#exclusivePins.keys(), ...this.#drainOverrides.keys()]);
		for (const sessions of this.#sessionLastCredential.values()) {
			for (const sessionId of sessions.keys()) sessionIds.add(sessionId);
		}
		for (const sessions of this.#restrictions.live.values()) {
			for (const sessionId of sessions.keys()) sessionIds.add(sessionId);
		}
		for (const tombstone of this.#restrictions.retired.values()) sessionIds.add(tombstone.sessionId);
		return sessionIds;
	}

	#pinKey(provider: string, sessionId: string): string {
		return `${SESSION_PIN_CACHE_PREFIX}${provider}:${sessionId}`;
	}

	/**
	 * The session's exclusive pin for `provider`, or `undefined` without one. A
	 * miss is cached for {@link SESSION_ROW_MISS_TTL_MS}, so a pin another process
	 * writes for this session applies at most that late.
	 */
	#sessionPin(provider: string, sessionId: string): SessionPin | undefined {
		const live = nestedGet(this.#exclusivePins, sessionId, provider);
		if (live) return live;
		const key = this.#pinKey(provider, sessionId);
		if (this.#recentlyMissed(key)) return undefined;
		try {
			const raw = this.#store.getCache(key);
			if (!raw) {
				this.#noteMiss(key);
				return undefined;
			}
			const value = JSON.parse(raw) as { credentialId?: unknown; identityHash?: unknown };
			const pin: SessionPin = {
				credentialId: typeof value.credentialId === "number" ? value.credentialId : null,
				...(typeof value.identityHash === "string" ? { identityHash: value.identityHash } : {}),
				// The row stays authoritative, so this copy is released like an inherited one.
				releasable: true,
				persisted: true,
			};
			nestedSet(this.#exclusivePins, sessionId, provider, pin);
			return pin;
		} catch (err) {
			logger.debug("Failed to read exclusive session pin from persistent store cache", { err });
			return undefined;
		}
	}

	#writeSessionPin(provider: string, sessionId: string, pin: Omit<SessionPin, "persisted"> | undefined): void {
		const key = this.#pinKey(provider, sessionId);
		this.#rowMisses.delete(key);
		let persisted = false;
		try {
			if (pin === undefined) this.#store.setCache(key, "", 0);
			else
				this.#store.setCache(
					key,
					JSON.stringify({
						credentialId: pin.credentialId,
						...(pin.identityHash !== undefined ? { identityHash: pin.identityHash } : {}),
					}),
					Math.floor(Date.now() / 1000) + SESSION_STICKY_TTL_SEC,
				);
			persisted = true;
		} catch (err) {
			logger.debug("Failed to write exclusive session pin to persistent store cache", { err });
		}
		nestedSet(
			this.#exclusivePins,
			sessionId,
			provider,
			pin === undefined
				? undefined
				: {
						credentialId: pin.credentialId,
						...(pin.identityHash !== undefined ? { identityHash: pin.identityHash } : {}),
						...(pin.releasable ? { releasable: true as const } : {}),
						persisted,
					},
		);
	}

	drain(provider: string, sessionId: string, credentialId: number | null | undefined): boolean {
		if (!sessionId) return false;
		if (typeof credentialId === "number") {
			const target = this.#pool.entries(provider).find(entry => entry.id === credentialId);
			// A restricted session may drain only an account of its allowlist.
			if (target?.credential.type !== "oauth" || !this.allows(provider, sessionId, target.credential)) return false;
		}
		this.#writeDrainOverride(provider, sessionId, credentialId);
		return true;
	}

	/**
	 * Stop following the session's drain override in this process because its
	 * account is not among the accounts this process sees, without clearing
	 * the persisted row for other processes that share it through a broker.
	 * Against a local store the row is cleared, as for {@link drain}.
	 */
	forgetDrainOverride(provider: string, sessionId: string): void {
		const cacheKey = sessionDrainKey(provider, sessionId);
		if (!this.#store.forgetCache) {
			this.#writeDrainOverride(provider, sessionId, undefined);
			return;
		}
		try {
			this.#store.forgetCache(cacheKey);
		} catch (err) {
			logger.debug("Failed to drop session drain override from the store cache", { err });
		}
		nestedSet(this.#drainOverrides, sessionId, provider, undefined);
		this.#noteMiss(cacheKey);
	}

	/**
	 * The session's drain override: a row id, `null` for no drain target,
	 * `undefined` to follow account policy. A miss is cached like
	 * {@link #sessionPin}'s, so an override another process writes applies at most
	 * {@link SESSION_ROW_MISS_TTL_MS} late.
	 */
	drainOverride(provider: string, sessionId: string | undefined): number | null | undefined {
		if (!sessionId) return undefined;
		const live = nestedGet(this.#drainOverrides, sessionId, provider);
		if (live) return live.credentialId;
		const key = sessionDrainKey(provider, sessionId);
		if (this.#recentlyMissed(key)) return undefined;
		try {
			const raw = this.#store.getCache(key);
			const credentialId = raw ? parseSessionDrain(raw) : undefined;
			if (credentialId !== undefined) {
				nestedSet(this.#drainOverrides, sessionId, provider, { credentialId, releasable: true, persisted: true });
			} else {
				this.#noteMiss(key);
			}
			return credentialId;
		} catch (err) {
			logger.debug("Failed to read session drain override from persistent store cache", { err });
			return undefined;
		}
	}

	#writeDrainOverride(
		provider: string,
		sessionId: string,
		credentialId: number | null | undefined,
		releasable?: true,
	): void {
		let persisted = false;
		const cacheKey = sessionDrainKey(provider, sessionId);
		this.#rowMisses.delete(cacheKey);
		try {
			if (credentialId === undefined) this.#store.setCache(cacheKey, "", 0);
			else
				this.#store.setCache(
					cacheKey,
					serializeSessionDrain(credentialId),
					Math.floor(Date.now() / 1000) + SESSION_STICKY_TTL_SEC,
				);
			persisted = true;
		} catch (err) {
			logger.debug("Failed to write session drain override to persistent store cache", { err });
		}
		nestedSet(
			this.#drainOverrides,
			sessionId,
			provider,
			credentialId === undefined ? undefined : { credentialId, ...(releasable ? { releasable } : {}), persisted },
		);
	}

	/** Whether a session or project pin exists for `provider`, ignoring key overrides. */
	hasPin(provider: string, sessionId: string | undefined): boolean {
		if (!sessionId) return false;
		return (
			this.#sessionPin(provider, sessionId) !== undefined ||
			this.#pinSource?.project?.(provider, sessionId) !== undefined
		);
	}

	/** Whether {@link exclusivePin} applies a pin (session or project) for `provider`, resolvable or not. */
	hasExclusivePin(provider: string, sessionId: string | undefined): boolean {
		try {
			return this.exclusivePin(provider, sessionId) !== undefined;
		} catch (error) {
			if (error instanceof AIError.AccountUnavailableError) return true;
			throw error;
		}
	}

	/** Whether a key override replaces pins and preferences for the session, as it replaces OAuth (see {@link KeyOverrides.suppressesOAuth}). */
	#pinsSuppressed(provider: string, sessionId: string | undefined): boolean {
		return this.#overrides.suppressesOAuth(provider, this.isRestricted(provider, sessionId));
	}

	/**
	 * The session's exclusive pin for `provider`: the session pin, else the
	 * project pin. Key overrides suppress both as they suppress OAuth. A pinned
	 * account that is no longer stored fails closed instead of falling back.
	 *
	 * A session account restriction ({@link restrict}) is the narrower grant: a
	 * pinned account outside its allowlist (inherited from a parent or pinned
	 * before the restriction) does not apply while the restriction holds, and
	 * selection stays inside the allowlist, the same way the restriction
	 * replaces stickies. A restricted session also ignores a pinned account that
	 * is no longer stored, or a project pin naming no stored account, unless the
	 * pin records an identity in its allowlist: only then is the account known
	 * to be one it may use. Each such override is logged once per session.
	 *
	 * @throws AIError.AccountUnavailableError when the pinned account is not
	 * stored and the session is unrestricted or the pin's identity is allowed.
	 */
	exclusivePin(provider: string, sessionId: string | undefined): AccountTarget | undefined {
		if (!sessionId || this.#pinsSuppressed(provider, sessionId)) return undefined;
		const pin = this.#sessionPin(provider, sessionId);
		const restricted = this.isRestricted(provider, sessionId);
		let target: AccountTarget | undefined;
		if (pin !== undefined) {
			const pinnedId = pin.credentialId;
			const index = pinnedId === null ? -1 : this.#pool.entries(provider).findIndex(entry => entry.id === pinnedId);
			const credential = this.#pool.credentials(provider)[index];
			if (credential) target = { index, credential };
			else if (!restricted || this.#allowsIdentity(provider, sessionId, pin.identityHash)) {
				throw new AIError.AccountUnavailableError(provider);
			}
		} else {
			const name = this.#pinSource?.project?.(provider, sessionId);
			if (name === undefined) return undefined;
			target = this.#named(provider, name);
			if (!target && !restricted) throw new AIError.AccountUnavailableError(provider, name);
		}
		if (target && this.allows(provider, sessionId, target.credential)) return target;
		const warnKey = `${provider}\0${sessionId}`;
		if (!this.#restrictedPinWarnings.has(warnKey)) {
			this.#restrictedPinWarnings.set(warnKey, true);
			logger.warn("Session account restriction overrides an account pin it cannot show inside its allowlist", {
				provider,
			});
		}
		return undefined;
	}

	/**
	 * The stored account the pool member serving `provider`/`modelId` prefers.
	 * An unresolvable name is logged (see {@link AccountPolicies.warnUnresolved}) and ignored;
	 * an account the session's restriction does not allow is ignored.
	 */
	preferredAccount(
		provider: string,
		sessionId: string | undefined,
		modelId: string | undefined,
	): AccountTarget | undefined {
		if (!sessionId || this.#pinsSuppressed(provider, sessionId)) return undefined;
		const name = this.#pinSource?.member?.(provider, sessionId, modelId);
		const target = name === undefined ? undefined : this.namedAccount(provider, name);
		return target && this.allows(provider, sessionId, target.credential) ? target : undefined;
	}

	/** Pool account routing for `provider`/`modelId`; key overrides suppress it like pins. */
	accountRouting(
		provider: string,
		sessionId: string | undefined,
		modelId: string | undefined,
	): AccountRouting | undefined {
		if (!sessionId || this.#pinsSuppressed(provider, sessionId)) return undefined;
		return this.#pinSource?.routing?.(provider, sessionId, modelId);
	}

	/**
	 * Stored accounts of the pool's `routing.accounts.order`, in order; unresolvable names are logged and skipped,
	 * and accounts the session's restriction does not allow are skipped.
	 */
	orderedAccounts(provider: string, sessionId: string | undefined, modelId: string | undefined): AccountTarget[] {
		return (this.accountRouting(provider, sessionId, modelId)?.order ?? []).flatMap(name => {
			const target = this.namedAccount(provider, name);
			return target && this.allows(provider, sessionId, target.credential) ? [target] : [];
		});
	}

	/** The stored account `name` names for `provider`; a miss is logged once and yields `undefined`. */
	namedAccount(provider: string, name: string): AccountTarget | undefined {
		const target = this.#named(provider, name);
		if (!target) this.#policies.warnUnresolved(provider, name);
		return target;
	}

	#named(provider: string, name: string): AccountTarget | undefined {
		const credentials = this.#pool.credentials(provider);
		const index = this.#policies.indexOfNamed(provider, name, credentials);
		const credential = credentials[index];
		return credential ? { index, credential } : undefined;
	}

	accounts(provider: string, sessionId?: string): AuthAccountSummary[] {
		const session = this.get(provider, sessionId);
		let pinnedIndex: number | undefined;
		try {
			pinnedIndex = this.exclusivePin(provider, sessionId)?.index;
		} catch (error) {
			if (!(error instanceof AIError.AccountUnavailableError)) throw error;
		}
		return this.#pool.entries(provider).flatMap((entry, index): AuthAccountSummary[] => {
			const credential = entry.credential;
			// A restricted session lists only its allowlist; without a session id every row is listed.
			if (sessionId !== undefined && !this.allows(provider, sessionId, credential)) return [];
			const name = this.#policies.forStored(provider, credential)?.name;
			const summary: AuthAccountSummary = {
				credentialId: entry.id,
				type: credential.type,
				active: session?.index === index && session.type === credential.type,
				pinned: pinnedIndex === index,
				...(name !== undefined ? { name } : {}),
			};
			if (credential.type === "api_key") return [{ ...summary, keyFingerprint: apiKeyFingerprint(credential.key) }];
			return [
				{
					...summary,
					accountId: credential.accountId,
					email: credential.email,
					projectId: credential.projectId,
					enterpriseUrl: credential.enterpriseUrl,
					orgId: credential.orgId,
					orgName: credential.orgName,
				},
			];
		});
	}

	/** Drop every sticky for a provider, in memory and in the persisted cache; exclusive pins stay. */
	clearProvider(provider: string): void {
		this.#sessionLastCredential.delete(provider);
		this.#persistedSticky.delete(provider);
		const prefix = `${SESSION_STICKY_CACHE_PREFIX}${provider}:`;
		try {
			this.#store.deleteCachePrefix?.(prefix);
		} catch (err) {
			logger.debug("Failed to clear provider session sticky credentials from persistent store cache", { err });
		}
	}

	/** Drop only this in-memory session pin after OAuth selection falls through. */
	forget(provider: string, sessionId: string): void {
		this.#sessionLastCredential.get(provider)?.delete(sessionId);
	}

	/**
	 * Records which credential was used for a session (for rate-limit switching).
	 * `lastUsedAtMs` backdates the sticky (session-file pin restores on resume);
	 * it defaults to now for live selections. Automatic re-recording of the same
	 * durable row preserves an explicit user pin.
	 *
	 * The in-memory sticky is always exact. The persisted row is rewritten only
	 * when the credential, its type, or explicitness changes, or when the stored
	 * last-use drifts by {@link SESSION_STICKY_PERSIST_INTERVAL_MS} — per-request
	 * rewrites were pure database churn.
	 */
	record(
		provider: string,
		sessionId: string | undefined,
		type: AuthCredential["type"],
		index: number,
		lastUsedAtMs?: number,
		explicit = false,
	): void {
		if (!sessionId || !this.#permits(provider, sessionId, index)) return;
		const nowMs = lastUsedAtMs ?? Date.now();
		const credentialId = this.#pool.entries(provider)[index]?.id;
		const sessionMap = SessionAffinity.#sessionsFor(this.#sessionLastCredential, provider);
		const previous = sessionMap.get(sessionId);
		const sameCredential =
			previous?.type === type &&
			(credentialId !== undefined ? previous.credentialId === credentialId : previous.index === index);
		const isExplicit = explicit || (sameCredential && previous?.explicit === true);
		const sessionCredential: SessionCredential = {
			type,
			index,
			credentialId,
			lastUsedAtMs: nowMs,
			...(isExplicit ? { explicit: true as const } : {}),
		};
		sessionMap.set(sessionId, sessionCredential);

		if (credentialId === undefined) return;
		const cacheKey = `${SESSION_STICKY_CACHE_PREFIX}${provider}:${sessionId}`;
		this.#rowMisses.delete(cacheKey);
		const expiresAtSec = Math.floor(nowMs / 1000) + SESSION_STICKY_TTL_SEC;
		const persistedSessions = SessionAffinity.#sessionsFor(this.#persistedSticky, provider);
		const persisted = persistedSessions.get(sessionId);
		if (
			persisted &&
			persisted.type === type &&
			persisted.credentialId === credentialId &&
			persisted.explicit === isExplicit &&
			Math.abs(nowMs - persisted.lastUsedAtMs) < SESSION_STICKY_PERSIST_INTERVAL_MS
		) {
			return;
		}
		try {
			this.#store.setCache(cacheKey, JSON.stringify(sessionCredential), expiresAtSec);
			persistedSessions.set(sessionId, {
				type,
				credentialId,
				explicit: isExplicit,
				lastUsedAtMs: nowMs,
			});
		} catch (err) {
			persistedSessions.delete(sessionId);
			logger.debug("Failed to write session sticky credential to persistent store cache", { err });
		}
	}

	/**
	 * Retrieves the last credential used by a session. A restricted session
	 * never sees a pin outside its allowlist — inherited, restored, or recorded
	 * before the restriction — so it re-ranks inside the allowlist instead.
	 */
	get(provider: string, sessionId: string | undefined): SessionCredential | undefined {
		if (!sessionId) return undefined;
		const credential = this.#lookup(provider, sessionId);
		return credential && this.#permits(provider, sessionId, credential.index) ? credential : undefined;
	}

	#lookup(provider: string, sessionId: string): SessionCredential | undefined {
		const live = this.#sessionLastCredential.get(provider)?.get(sessionId);
		if (live) {
			// Another process can add or drop rows mid-session and the pool is an
			// index-ordered snapshot, so re-resolve the pin through its durable row
			// id: a compacted array must not point the session at a different
			// account, and a deleted account must not hand its slot to a sibling.
			if (live.credentialId === undefined) return live;
			const stored = this.#pool.entries(provider);
			const actualIndex = stored.findIndex(entry => entry.id === live.credentialId);
			if (actualIndex === -1 || stored[actualIndex]?.credential.type !== live.type) {
				this.#sessionLastCredential.get(provider)?.delete(sessionId);
				return undefined;
			}
			live.index = actualIndex;
			return live;
		}
		const cacheKey = `${SESSION_STICKY_CACHE_PREFIX}${provider}:${sessionId}`;
		// A sticky another process records for this session is adopted at most SESSION_ROW_MISS_TTL_MS late.
		if (this.#recentlyMissed(cacheKey)) return undefined;
		try {
			const raw = this.#store.getCache(cacheKey);
			if (!raw) this.#noteMiss(cacheKey);
			if (raw) {
				const val = JSON.parse(raw) as SessionCredential;

				if (val.credentialId !== undefined) {
					const stored = this.#pool.entries(provider);
					const actualIndex = stored.findIndex(entry => entry.id === val.credentialId);
					if (actualIndex === -1 || stored[actualIndex]?.credential.type !== val.type) {
						this.#persistedSticky.get(provider)?.delete(sessionId);
						this.#store.setCache(cacheKey, "", 0);
						return undefined;
					}
					val.index = actualIndex;
				} else {
					// Fallback: drop unsafe index-only cache rows to prevent wrong-account routing
					this.#persistedSticky.get(provider)?.delete(sessionId);
					this.#store.setCache(cacheKey, "", 0);
					return undefined;
				}

				const sessionVal: SessionCredential = {
					type: val.type,
					index: val.index,
					credentialId: val.credentialId,
					lastUsedAtMs: val.lastUsedAtMs,
					...(val.explicit === true ? { explicit: true } : {}),
				};
				if (typeof val.lastUsedAtMs === "number") {
					SessionAffinity.#sessionsFor(this.#persistedSticky, provider).set(sessionId, {
						type: val.type,
						credentialId: val.credentialId,
						explicit: val.explicit === true,
						lastUsedAtMs: val.lastUsedAtMs,
					});
				}
				SessionAffinity.#sessionsFor(this.#sessionLastCredential, provider).set(sessionId, sessionVal);
				return sessionVal;
			}
		} catch (err) {
			logger.debug("Failed to read session sticky credential from persistent store cache", { err });
		}
		return undefined;
	}

	/** Clears the last credential used by a session for a provider. */
	clear(provider: string, sessionId: string | undefined): void {
		if (!sessionId) return;
		const sessionMap = this.#sessionLastCredential.get(provider);
		if (sessionMap) {
			sessionMap.delete(sessionId);
			if (sessionMap.size === 0) {
				this.#sessionLastCredential.delete(provider);
			}
		}
		const cacheKey = `${SESSION_STICKY_CACHE_PREFIX}${provider}:${sessionId}`;
		this.#persistedSticky.get(provider)?.delete(sessionId);
		this.#rowMisses.delete(cacheKey);
		try {
			this.#store.setCache(cacheKey, "", 0);
		} catch (err) {
			logger.debug("Failed to clear session sticky credential from persistent store cache", { err });
		}
	}

	activeOAuth(provider: string, sessionId?: string): OAuthCredential | undefined {
		const allCredentials = this.#pool.credentials(provider);
		const oauthCredentials = allCredentials.filter(
			(c): c is OAuthCredential => c.type === "oauth" && this.allows(provider, sessionId, c),
		);
		if (oauthCredentials.length === 0) return undefined;

		// Runtime / config overrides bypass OAuth account_uuid attribution — the
		// caller is authenticating with an explicit key, not the broker's OAuth.
		// A restricted session skips a runtime key, and a config key fails it
		// closed (see `KeyCascade.get`).
		const restricted = this.isRestricted(provider, sessionId);
		if (this.#overrides.suppressesOAuth(provider, restricted)) return undefined;

		// Prefer the session-sticky credential when available.
		const sessionPref = this.get(provider, sessionId);
		// If the session has been routed to a stored API key, do not inject OAuth account_uuid.
		if (sessionPref !== undefined && sessionPref.type !== "oauth") return undefined;

		// When no session-sticky credential is recorded yet (first call before any getApiKey,
		// or all stored credentials are unavailable), the request falls through to the env-key
		// path in getApiKey(), which is not OAuth-authenticated, so account_uuid injection
		// would misattribute traffic. Only apply this guard when sessionPref is absent; a
		// recorded OAuth sticky (sessionPref.type === "oauth") must NOT be blocked even if an
		// env key also happens to exist.
		if (!restricted && !sessionPref && getEnvApiKey(provider)) return undefined;
		// Resolve the sticky index against the full credential list — the index is
		// recorded against the unfiltered provider array (by record /
		// CredentialSelector.tryOAuth), not the OAuth-only subset, so dereferencing it into the
		// filtered array would be off-by-N when any non-OAuth credential precedes the
		// OAuth ones (e.g. [api_key, oauth_A, oauth_B] stored order).
		const stickyCredential = sessionPref?.type === "oauth" ? allCredentials[sessionPref.index] : undefined;
		return stickyCredential?.type === "oauth" ? stickyCredential : oauthCredentials[0];
	}

	/**
	 * Pin one stored account (OAuth or API key) as this session's only
	 * credential for `provider`; see {@link SessionsApi.pin}.
	 *
	 * `options.restoredAtMs` instead restores an automatic affinity recorded by a
	 * persisted session, backdated to its last use, so it keeps the provider's
	 * warm-window semantics: a resume inside the prompt-cache TTL reuses the
	 * account, a stale resume re-ranks.
	 */
	pin(provider: string, sessionId: string, credentialId: number, options?: { restoredAtMs?: number }): boolean {
		if (!sessionId || this.#overrides.suppressesOAuth(provider, this.isRestricted(provider, sessionId))) {
			return false;
		}
		const stored = this.#pool.entries(provider);
		const index = stored.findIndex(entry => entry.id === credentialId);
		const target = stored[index];
		if (!target || !this.allows(provider, sessionId, target.credential)) return false;
		const restoredAtMs = options?.restoredAtMs;
		if (restoredAtMs === undefined) {
			const identityKey =
				target.credential.type === "oauth" ? resolveCredentialIdentityKey(provider, target.credential) : null;
			this.#writeSessionPin(provider, sessionId, {
				credentialId,
				...(identityKey ? { identityHash: identityHash(identityKey) } : {}),
			});
		}
		this.record(provider, sessionId, target.credential.type, index, restoredAtMs, restoredAtMs === undefined);
		return true;
	}

	pinMissing(provider: string, sessionId: string): void {
		if (!sessionId) return;
		this.#writeSessionPin(provider, sessionId, { credentialId: null });
		this.clear(provider, sessionId);
	}

	/**
	 * Copy stored credential affinities from one live session to another.
	 *
	 * The target receives its own sticky entries, so request resolution, usage
	 * blocking, credential rotation, metadata, and persisted pins all continue
	 * through the target session id without retaining a live dependency on the
	 * source session. `include` limits the copy to the providers it accepts,
	 * given whether the source's affinity is an explicit user pin.
	 */
	inherit(
		sourceSessionId: string,
		targetSessionId: string,
		include?: (provider: string, explicit: boolean) => boolean,
	): number {
		if (!sourceSessionId || !targetSessionId || sourceSessionId === targetSessionId) return 0;
		let inherited = 0;
		const providers = new Set([
			...this.#pool.providers(),
			...(this.#exclusivePins.get(sourceSessionId)?.keys() ?? []),
			...(this.#drainOverrides.get(sourceSessionId)?.keys() ?? []),
		]);
		for (const provider of providers) {
			const pin = this.#sessionPin(provider, sourceSessionId);
			if (pin) {
				this.#writeSessionPin(provider, targetSessionId, {
					credentialId: pin.credentialId,
					identityHash: pin.identityHash,
					releasable: true,
				});
			}
			const drain = this.drainOverride(provider, sourceSessionId);
			if (drain !== undefined) this.#writeDrainOverride(provider, targetSessionId, drain, true);
		}
		for (const provider of this.#pool.providers()) {
			const credential = this.get(provider, sourceSessionId);
			if (!credential || !this.#permits(provider, targetSessionId, credential.index)) continue;
			if (include && !include(provider, credential.explicit === true)) continue;
			this.record(
				provider,
				targetSessionId,
				credential.type,
				credential.index,
				credential.lastUsedAtMs,
				credential.explicit === true,
			);
			inherited += 1;
		}
		return inherited;
	}

	forgetInherited(sessionId: string): void {
		for (const provider of this.#exclusivePins.get(sessionId)?.keys() ?? []) {
			this.#rowMisses.delete(this.#pinKey(provider, sessionId));
		}
		for (const provider of this.#drainOverrides.get(sessionId)?.keys() ?? []) {
			this.#rowMisses.delete(sessionDrainKey(provider, sessionId));
		}
		dropReleasable(this.#exclusivePins, sessionId);
		dropReleasable(this.#drainOverrides, sessionId);
	}

	/**
	 * Release a session's sticky credential so its next `KeyCascade.get` call
	 * re-runs native pool ranking. This never blocks or penalizes the released
	 * account; usage-aware routing uses it when another sibling has more
	 * headroom, before considering a model/provider fallback.
	 */
	release(provider: string, sessionId: string): boolean {
		if (this.#sessionPin(provider, sessionId) !== undefined || !this.get(provider, sessionId)) return false;
		this.clear(provider, sessionId);
		return true;
	}

	unpin(provider: string, sessionId: string): boolean {
		if (this.#sessionPin(provider, sessionId) === undefined) return false;
		this.#writeSessionPin(provider, sessionId, undefined);
		this.clear(provider, sessionId);
		return true;
	}
}
