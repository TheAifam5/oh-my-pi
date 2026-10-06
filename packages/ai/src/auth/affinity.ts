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

/** One installed restriction: the allowed OAuth identity keys and the lease that lifts it. */
type SessionRestriction = { readonly allowed: ReadonlySet<string>; readonly lease: SessionRestrictionLease };

/**
 * Provider → session id → installed restriction. Owned by `AuthStorage` so
 * restrictions outlive store replacement, which rebuilds every store-bound
 * module (pins included) around the same identities.
 */
export type SessionRestrictions = Map<string, Map<string, SessionRestriction>>;

/** An exclusive session pin: the pinned row id, or `null` for an account no longer stored. */
type SessionPin = { provider: string; sessionId: string; credentialId: number | null };

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
	 * Exclusive session pins by cache key: the pinned row id, or `null` for an account no longer stored.
	 * Not LRU-bounded: entries exist only for explicitly pinned sessions, and this map is the only copy
	 * {@link adoptPins} carries across a store swap and the only copy when the pin row failed to persist,
	 * so evicting one would let a pinned session route to a different account.
	 */
	#exclusivePins: Map<string, SessionPin> = new Map();
	#pinSource: AccountPinSource | undefined;
	/** `provider\0sessionId` whose pin a restriction overrode and was already logged; one bounded LRU. */
	#restrictedPinWarnings = new LRUCache<string, true>({ max: SESSION_AFFINITY_MAX_SESSIONS_PER_PROVIDER });
	/** Session drain overrides by `provider\0sessionId`, persisted in the store cache: the drained row id, or `null` for no drain target. */
	#drainOverrides: Map<string, number | null> = new Map();
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
		const lease = Symbol("sessions.restrict");
		const sessions = this.#restrictions.get(provider) ?? new Map<string, SessionRestriction>();
		sessions.set(sessionId, { allowed: new Set(identityKeys), lease });
		this.#restrictions.set(provider, sessions);
		return lease;
	}

	unrestrict(provider: string, sessionId: string, lease: SessionRestrictionLease): void {
		const sessions = this.#restrictions.get(provider);
		if (sessions?.get(sessionId)?.lease !== lease) return;
		sessions.delete(sessionId);
		if (sessions.size === 0) this.#restrictions.delete(provider);
	}

	/** True when {@link restrict} limits `sessionId` for `provider`. */
	isRestricted(provider: string, sessionId: string | undefined): boolean {
		return sessionId !== undefined && this.#restrictions.get(provider)?.has(sessionId) === true;
	}

	/**
	 * True when `credential` may serve `sessionId`: always for an unrestricted
	 * session, otherwise only an OAuth credential whose identity key is allowed.
	 */
	allows(provider: string, sessionId: string | undefined, credential: AuthCredential): boolean {
		const allowed = sessionId === undefined ? undefined : this.#restrictions.get(provider)?.get(sessionId)?.allowed;
		if (allowed === undefined) return true;
		if (credential.type !== "oauth") return false;
		const identityKey = resolveCredentialIdentityKey(provider, credential);
		return identityKey !== null && allowed.has(identityKey);
	}

	/** Whether the stored row at `index` may serve `sessionId` (see {@link allows}). */
	#permits(provider: string, sessionId: string, index: number): boolean {
		if (!this.isRestricted(provider, sessionId)) return true;
		const credential = this.#pool.credentials(provider)[index];
		return credential !== undefined && this.allows(provider, sessionId, credential);
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
	 * Take over the pin source, the live exclusive pins, and the session drain
	 * overrides of the affinity this one replaces (credential store swap). Row
	 * ids are store-specific, so each moves to the stored credential with the
	 * same identity (OAuth account or API key fingerprint); a pin with no such
	 * credential fails closed, a drain override falls back to the account policy.
	 */
	adoptPins(previous: SessionAffinity): void {
		this.#pinSource = previous.#pinSource;
		for (const pin of previous.#exclusivePins.values()) {
			const credential =
				pin.credentialId === null
					? undefined
					: previous.#pool.entries(pin.provider).find(entry => entry.id === pin.credentialId)?.credential;
			const match = credential
				? this.#pool.entries(pin.provider).find(entry => sameAccount(entry.credential, credential))
				: undefined;
			this.#writeSessionPin(pin.provider, pin.sessionId, match?.id ?? null);
		}
		for (const [key, credentialId] of previous.#drainOverrides) {
			const [provider = "", sessionId = ""] = key.split("\0");
			if (credentialId === null) {
				this.#writeDrainOverride(provider, sessionId, null);
				continue;
			}
			const credential = previous.#pool.entries(provider).find(entry => entry.id === credentialId)?.credential;
			const match = credential
				? this.#pool.entries(provider).find(entry => sameAccount(entry.credential, credential))
				: undefined;
			// A drain target missing from the new store falls back to the account policy.
			this.#writeDrainOverride(provider, sessionId, match?.id);
		}
	}

	#pinKey(provider: string, sessionId: string): string {
		return `${SESSION_PIN_CACHE_PREFIX}${provider}:${sessionId}`;
	}

	/** The session pin's row id, `null` for a pinned account no longer stored, `undefined` without a pin. */
	#sessionPin(provider: string, sessionId: string): number | null | undefined {
		const key = this.#pinKey(provider, sessionId);
		const live = this.#exclusivePins.get(key);
		if (live) return live.credentialId;
		try {
			const raw = this.#store.getCache(key);
			if (!raw) return undefined;
			const value = JSON.parse(raw) as { credentialId?: unknown };
			const credentialId = typeof value.credentialId === "number" ? value.credentialId : null;
			this.#exclusivePins.set(key, { provider, sessionId, credentialId });
			return credentialId;
		} catch (err) {
			logger.debug("Failed to read exclusive session pin from persistent store cache", { err });
			return undefined;
		}
	}

	#writeSessionPin(provider: string, sessionId: string, credentialId: number | null | undefined): void {
		const key = this.#pinKey(provider, sessionId);
		if (credentialId === undefined) this.#exclusivePins.delete(key);
		else this.#exclusivePins.set(key, { provider, sessionId, credentialId });
		try {
			if (credentialId === undefined) this.#store.setCache(key, "", 0);
			else
				this.#store.setCache(
					key,
					JSON.stringify({ credentialId }),
					Math.floor(Date.now() / 1000) + SESSION_STICKY_TTL_SEC,
				);
		} catch (err) {
			logger.debug("Failed to write exclusive session pin to persistent store cache", { err });
		}
	}

	drain(provider: string, sessionId: string, credentialId: number | null | undefined): boolean {
		if (!sessionId) return false;
		if (typeof credentialId === "number") {
			const target = this.#pool.entries(provider).find(entry => entry.id === credentialId);
			if (target?.credential.type !== "oauth") return false;
		}
		this.#writeDrainOverride(provider, sessionId, credentialId);
		return true;
	}

	/** The session's drain override: a row id, `null` for no drain target, `undefined` to follow account policy. */
	drainOverride(provider: string, sessionId: string | undefined): number | null | undefined {
		if (!sessionId) return undefined;
		const key = `${provider}\0${sessionId}`;
		if (this.#drainOverrides.has(key)) return this.#drainOverrides.get(key);
		// A miss is not cached, like #sessionPin: one primary-key lookup per selection picks up an override written later by another process.
		try {
			const raw = this.#store.getCache(sessionDrainKey(provider, sessionId));
			const credentialId = raw ? parseSessionDrain(raw) : undefined;
			if (credentialId !== undefined) this.#drainOverrides.set(key, credentialId);
			return credentialId;
		} catch (err) {
			logger.debug("Failed to read session drain override from persistent store cache", { err });
			return undefined;
		}
	}

	#writeDrainOverride(provider: string, sessionId: string, credentialId: number | null | undefined): void {
		const key = `${provider}\0${sessionId}`;
		if (credentialId === undefined) this.#drainOverrides.delete(key);
		else this.#drainOverrides.set(key, credentialId);
		try {
			const cacheKey = sessionDrainKey(provider, sessionId);
			if (credentialId === undefined) this.#store.setCache(cacheKey, "", 0);
			else
				this.#store.setCache(
					cacheKey,
					serializeSessionDrain(credentialId),
					Math.floor(Date.now() / 1000) + SESSION_STICKY_TTL_SEC,
				);
		} catch (err) {
			logger.debug("Failed to write session drain override to persistent store cache", { err });
		}
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
	 * stored pinned account outside its allowlist (inherited from a parent or
	 * pinned before the restriction) does not apply while the restriction
	 * holds, and selection stays inside the allowlist, the same way the
	 * restriction replaces stickies. Each such override is logged once per
	 * session.
	 *
	 * @throws AIError.AccountUnavailableError when the pinned account is not stored.
	 */
	exclusivePin(provider: string, sessionId: string | undefined): AccountTarget | undefined {
		if (!sessionId || this.#pinsSuppressed(provider, sessionId)) return undefined;
		const pinnedId = this.#sessionPin(provider, sessionId);
		let target: AccountTarget | undefined;
		if (pinnedId !== undefined) {
			const index = pinnedId === null ? -1 : this.#pool.entries(provider).findIndex(entry => entry.id === pinnedId);
			const credential = this.#pool.credentials(provider)[index];
			if (!credential) throw new AIError.AccountUnavailableError(provider);
			target = { index, credential };
		} else {
			const name = this.#pinSource?.project?.(provider, sessionId);
			if (name === undefined) return undefined;
			target = this.#named(provider, name);
			if (!target) throw new AIError.AccountUnavailableError(provider, name);
		}
		if (this.allows(provider, sessionId, target.credential)) return target;
		const warnKey = `${provider}\0${sessionId}`;
		if (!this.#restrictedPinWarnings.has(warnKey)) {
			this.#restrictedPinWarnings.set(warnKey, true);
			logger.warn("Session account restriction overrides an account pin outside its allowlist", { provider });
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
		return this.#pool.entries(provider).map((entry, index) => {
			const credential = entry.credential;
			const name = this.#policies.forStored(provider, credential)?.name;
			const summary: AuthAccountSummary = {
				credentialId: entry.id,
				type: credential.type,
				active: session?.index === index && session.type === credential.type,
				pinned: pinnedIndex === index,
				...(name !== undefined ? { name } : {}),
			};
			if (credential.type === "api_key") return { ...summary, keyFingerprint: apiKeyFingerprint(credential.key) };
			return {
				...summary,
				accountId: credential.accountId,
				email: credential.email,
				projectId: credential.projectId,
				enterpriseUrl: credential.enterpriseUrl,
				orgId: credential.orgId,
				orgName: credential.orgName,
			};
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
		try {
			const cacheKey = `${SESSION_STICKY_CACHE_PREFIX}${provider}:${sessionId}`;
			const raw = this.#store.getCache(cacheKey);
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
		if (restoredAtMs === undefined) this.#writeSessionPin(provider, sessionId, credentialId);
		this.record(provider, sessionId, target.credential.type, index, restoredAtMs, restoredAtMs === undefined);
		return true;
	}

	pinMissing(provider: string, sessionId: string): void {
		if (!sessionId) return;
		this.#writeSessionPin(provider, sessionId, null);
		this.clear(provider, sessionId);
	}

	/**
	 * Copy every stored credential affinity from one live session to another.
	 *
	 * The target receives its own sticky entries, so request resolution, usage
	 * blocking, credential rotation, metadata, and persisted pins all continue
	 * through the target session id without retaining a live dependency on the
	 * source session.
	 */
	inherit(sourceSessionId: string, targetSessionId: string): number {
		if (!sourceSessionId || !targetSessionId || sourceSessionId === targetSessionId) return 0;
		let inherited = 0;
		for (const provider of this.#pool.providers()) this.#sessionPin(provider, sourceSessionId);
		for (const pin of [...this.#exclusivePins.values()]) {
			if (pin.sessionId === sourceSessionId) this.#writeSessionPin(pin.provider, targetSessionId, pin.credentialId);
		}
		for (const provider of this.#pool.providers()) this.drainOverride(provider, sourceSessionId);
		for (const [key, credentialId] of [...this.#drainOverrides]) {
			const [provider = "", sessionId] = key.split("\0");
			if (sessionId === sourceSessionId) this.#writeDrainOverride(provider, targetSessionId, credentialId);
		}
		for (const provider of this.#pool.providers()) {
			const credential = this.get(provider, sourceSessionId);
			if (!credential || !this.#permits(provider, targetSessionId, credential.index)) continue;
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
