/**
 * Session-file persistence of the OAuth account that served a session.
 *
 * Provider prompt caches are account-scoped (Anthropic bills a full cache
 * re-write after an account flip), and the auth store's session-sticky routing
 * is process-local when a remote auth broker is configured — the broker
 * store's KV cache is in-memory, so sticky rows die with the CLI process.
 * Resuming a session in a fresh process then re-ranks accounts by usage
 * headroom, which is biased *away* from the account that just served the
 * session (it has the highest recent burn), cold-missing the entire prefix.
 *
 * These helpers close the loop through the session file itself: after each
 * assistant turn the serving account is recorded as a `credential_pin` entry,
 * and on session adoption the pin is matched against the stored accounts and
 * seeded back into the auth store with the session's effective last-use
 * timestamp, so the provider's warm-window semantics still decide whether to
 * stick or re-rank.
 */

import { logger } from "@oh-my-pi/pi-utils";
import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import type { AuthStorage } from "./auth-storage";
import type { SessionManager } from "./session-manager";

/** Account fields shared by `OAuthAccountIdentity`, `OAuthAccountSummary`, and `AuthAccountSummary`. */
interface CredentialPinIdentity {
	accountId?: string;
	email?: string;
	projectId?: string;
	orgId?: string;
	/** Set for a stored API key; the digest then covers only the provider and fingerprint. */
	keyFingerprint?: string;
}

/**
 * Stable identifier for a provider account within its billing scope. The
 * digest covers the full scope tuple — the same account in two orgs (Anthropic
 * multi-subscription) or projects (Gemini) is two distinct cache domains and
 * must produce two distinct pins. The digest input is the persisted contract
 * for `CredentialPinEntry.hash` — changing it orphans every recorded pin.
 *
 * Hashing avoids embedding raw emails/uuids in session files, but an unsalted
 * digest of a guessable email is still linkable — treat exported sessions
 * accordingly.
 *
 * Returns `undefined` when the identity carries no account key at all.
 */
export function credentialPinHash(provider: string, identity: CredentialPinIdentity): string | undefined {
	if (identity.keyFingerprint) {
		return new Bun.CryptoHasher("sha256")
			.update([provider, "api_key", identity.keyFingerprint].join("\0"))
			.digest("hex");
	}
	if (!identity.accountId && !identity.email) return undefined;
	const key = [
		provider,
		identity.accountId ?? "",
		identity.email ?? "",
		identity.orgId ?? "",
		identity.projectId ?? "",
	].join("\0");
	return new Bun.CryptoHasher("sha256").update(key).digest("hex");
}

/** `sessionId\0provider` whose recorded user pin a restriction already overrode and logged. */
const ignoredPinWarnings = new LRUCache<string, true>({ max: 256 });

/**
 * Record the account that served the latest assistant turn for `provider`.
 * Appends a `credential_pin` entry only when the account differs from the
 * branch's latest pin, so steady-state sessions add a single entry; the
 * effective last-use time is derived from later assistant turns on read
 * (see `SessionManager.getCredentialPins`). Never appends a `credential_pin`
 * while the branch's latest pin is a user pin, so an automatic entry never
 * replaces it on resume, including one an account restriction ignores: a later
 * unrestricted resume restores it. When a restriction ignores the user pin
 * (the session is restricted and its active account differs from the pinned
 * one), the active pool account is recorded as a `credential_affinity` entry
 * instead, again only when it differs from the branch's latest affinity.
 */
export function recordCredentialPin(
	authStorage: AuthStorage,
	sessionManager: SessionManager,
	sessionId: string,
	provider: string,
): void {
	const pin = sessionManager.getCredentialPins().get(provider);
	if (pin?.exclusive) {
		recordCredentialAffinity(authStorage, sessionManager, sessionId, provider, pin.hash);
		return;
	}
	const identity = authStorage.oauth.identity(provider, sessionId);
	if (!identity) return;
	const hash = credentialPinHash(provider, identity);
	if (!hash || sessionManager.getCredentialPins().get(provider)?.hash === hash) return;
	sessionManager.appendCredentialPin(provider, hash);
}

/** Record the restricted session's active pool account when it is not the user-pinned account `pinHash`. */
function recordCredentialAffinity(
	authStorage: AuthStorage,
	sessionManager: SessionManager,
	sessionId: string,
	provider: string,
	pinHash: string,
): void {
	if (!authStorage.sessions.isRestricted(provider, sessionId)) return;
	// Restriction-filtered and session-active only: no fallback to an account outside the pool.
	const serving = authStorage.oauth.accounts(provider, sessionId).find(account => account.active);
	const hash = serving ? credentialPinHash(provider, serving) : undefined;
	if (!hash || hash === pinHash || sessionManager.getCredentialAffinities().get(provider)?.hash === hash) return;
	sessionManager.appendCredentialAffinity(provider, hash);
}

/**
 * Record a user pin (`/session pin`) of the stored credential `credentialId`
 * so resume restores it as the session's only account for `provider`, or with
 * `exclusive: false` record that the user removed it. Returns false, recording
 * nothing, when the credential is gone or carries no identity to hash.
 */
export function recordExclusiveCredentialPin(
	authStorage: AuthStorage,
	sessionManager: SessionManager,
	provider: string,
	credentialId: number,
	exclusive: boolean,
): boolean {
	const account = authStorage.sessions.accounts(provider).find(entry => entry.credentialId === credentialId);
	const hash = account ? credentialPinHash(provider, account) : undefined;
	if (!hash) return false;
	sessionManager.appendCredentialPin(provider, hash, exclusive);
	return true;
}

/**
 * Re-pin the accounts recorded in the session file onto the auth store's
 * session stickiness.
 *
 * A user pin is restored as the session's exclusive pin and overwrites any
 * live sticky. When its account is no longer stored, or the pin is refused
 * (a key override is active), the session fails closed for that provider and
 * the provider is returned so the caller can tell the user. A session
 * restricted to an account pool instead ignores a user pin it cannot apply
 * (outside its pool, or an account no longer stored, which cannot be shown to
 * be inside it): nothing is persisted and selection stays inside the pool.
 * After the pins, such a restricted session, or a restricted one with no pin
 * for the provider, is seeded like an automatic pin from its latest
 * `credential_affinity` entry, only when that account is stored and allowed.
 *
 * An automatic pin is a no-op when the account is gone (logged out) or when a
 * live sticky for another account exists (same-process branch/session switches
 * must not clobber fresher routing). A sticky for the same account whose last
 * use predates the pin is advanced to the pin's time: the persisted sticky is
 * written lazily, so the session file can be newer. It seeds with the
 * session's effective last-use time so stale resumes still fall through to
 * usage ranking. `options.exclusiveOnly` restores only user pins, no automatic
 * pins or affinities, for a fresh provider session id that wants new automatic
 * routing but keeps the user's pins.
 * `options.onIgnored` receives each provider whose user pin a restriction
 * overrides; the override is logged once per session and provider.
 */
export function seedCredentialPins(
	authStorage: AuthStorage,
	sessionManager: SessionManager,
	sessionId: string,
	options?: { exclusiveOnly?: boolean; onIgnored?: (provider: string) => void },
): string[] {
	const unavailable: string[] = [];
	const ignored = new Set<string>();
	const pins = sessionManager.getCredentialPins();
	for (const [provider, pin] of pins) {
		if (pin.exclusive) {
			const pinned = authStorage.sessions
				.accounts(provider, sessionId)
				.find(account => credentialPinHash(provider, account) === pin.hash);
			if (pinned && authStorage.sessions.pin(provider, sessionId, pinned.credentialId)) continue;
			if (authStorage.sessions.isRestricted(provider, sessionId)) {
				const warnKey = `${sessionId}\0${provider}`;
				if (!ignoredPinWarnings.has(warnKey)) {
					ignoredPinWarnings.set(warnKey, true);
					logger.warn("Session account restriction overrides the pinned account of the resumed session", {
						provider,
					});
				}
				options?.onIgnored?.(provider);
				ignored.add(provider);
				continue;
			}
			authStorage.sessions.pinMissing(provider, sessionId);
			logger.warn("Pinned account of the resumed session is unavailable", { provider });
			unavailable.push(provider);
			continue;
		}
		if (options?.exclusiveOnly) continue;
		restoreAutomaticAffinity(authStorage, sessionId, provider, pin);
	}
	if (options?.exclusiveOnly) return unavailable;
	for (const [provider, affinity] of sessionManager.getCredentialAffinities()) {
		if (pins.has(provider) && !ignored.has(provider)) continue;
		if (!authStorage.sessions.isRestricted(provider, sessionId)) continue;
		restoreAutomaticAffinity(authStorage, sessionId, provider, affinity);
	}
	return unavailable;
}

/**
 * Seed the stored account whose hash is `recorded.hash` as the session's
 * sticky, backdated to `recorded.lastUsedAt`. A no-op when that account is not
 * listed for the session (logged out, or outside its restriction) or a live
 * sticky for another account, or a newer one for the same account, exists.
 */
function restoreAutomaticAffinity(
	authStorage: AuthStorage,
	sessionId: string,
	provider: string,
	recorded: { hash: string; lastUsedAt: number },
): void {
	const accounts = authStorage.oauth.accounts(provider, sessionId);
	const match = accounts.find(account => credentialPinHash(provider, account) === recorded.hash);
	if (!match) return;
	const active = accounts.find(account => account.active);
	if (active && (active !== match || (active.lastUsedAtMs ?? 0) >= recorded.lastUsedAt)) return;
	authStorage.sessions.pin(provider, sessionId, match.credentialId, {
		restoredAtMs: recorded.lastUsedAt,
	});
}
