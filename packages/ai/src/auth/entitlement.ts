import { logger } from "@oh-my-pi/pi-utils";
import { type CredentialBlocks, modelEntitlementBlockScope as scopeForModelKey, providerTypeKey } from "./blocks";
import type { CredentialPool } from "./pool";
import { oauthAccountKey } from "./types";

/** How long a learned model-entitlement denial excludes a credential from that model. */
export const MODEL_ENTITLEMENT_DENIAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How long an unconfirmed model-not-found refusal keeps a credential off that model, and how
 * long a refusal by every candidate suspends further holds for it. In memory only.
 */
export const MODEL_NOT_FOUND_HOLD_TTL_MS = 10 * 60_000;

const MODEL_ENTITLEMENT_MODEL_ID_MAX_LENGTH = 256;

/** Provider-agnostic identity of a requested model: the bare, lower-cased id after any `vendor/` prefix. */
function entitlementModelKey(modelId: string | undefined): string | undefined {
	if (typeof modelId !== "string") return undefined;
	const separator = modelId.lastIndexOf("/");
	const bare = (separator === -1 ? modelId : modelId.slice(separator + 1)).trim().toLowerCase();
	if (!bare || bare.length > MODEL_ENTITLEMENT_MODEL_ID_MAX_LENGTH || bare.includes("\0")) return undefined;
	return bare;
}

/** Persisted block scope recording that a credential is not entitled to `modelId`. */
export function modelEntitlementBlockScope(modelId: string | undefined): string | undefined {
	const key = entitlementModelKey(modelId);
	return key === undefined ? undefined : scopeForModelKey(key);
}

/** Dependencies for model-entitlement checks. */
export interface ModelEntitlementsDeps {
	pool: CredentialPool;
	blocks: CredentialBlocks;
}

/**
 * Which stored credentials may serve a model.
 *
 * A credential is excluded when the model's discovered account access names
 * at least one stored OAuth account of the provider and not this one, when
 * a model-entitlement denial was recorded for it and has not expired, or while
 * it holds an unconfirmed model-not-found refusal of the model. Every
 * selection pass, rotation sibling check, and model health read applies the
 * same verdict.
 */
export class ModelEntitlements {
	readonly #deps: ModelEntitlementsDeps;
	readonly #accountAccess: Map<string, ReadonlySet<string>>;
	/** `provider\0modelKey` → credential row id → hold expiry (epoch ms) of unconfirmed model-not-found refusals. */
	readonly #holds = new Map<string, Map<number, number>>();
	/** `provider\0modelKey` → expiry (epoch ms) of "every candidate refused this model". */
	readonly #exhausted = new Map<string, number>();

	constructor(deps: ModelEntitlementsDeps, accountAccess = new Map<string, ReadonlySet<string>>()) {
		this.#deps = deps;
		this.#accountAccess = accountAccess;
	}

	/**
	 * Remember the account keys known to serve `modelId`. An empty list forgets the record (the
	 * catalog no longer restricts the model); an absent list leaves it unchanged.
	 */
	noteAccountAccess(provider: string, modelId: string | undefined, accountIds: readonly string[] | undefined): void {
		const key = entitlementModelKey(modelId);
		if (key === undefined || accountIds === undefined) return;
		if (accountIds.length === 0) this.#accountAccess.delete(`${provider}\0${key}`);
		else this.#accountAccess.set(`${provider}\0${key}`, new Set(accountIds));
	}

	/**
	 * Predicate over current pool indices of `provider`: whether that credential
	 * may serve `modelId`. Explicit `accountIds` win over the remembered access
	 * list. A credential with a live model-not-found hold for `modelId` is not
	 * entitled. Without a model id every credential is entitled.
	 */
	entitled(
		provider: string,
		modelId: string | undefined,
		accountIds?: readonly string[],
	): (credentialIndex: number) => boolean {
		const key = entitlementModelKey(modelId);
		if (key === undefined) return () => true;
		const scope = scopeForModelKey(key);
		const access =
			accountIds === undefined
				? this.#accountAccess.get(`${provider}\0${key}`)
				: accountIds.length > 0
					? new Set(accountIds)
					: undefined;
		const entries = this.#deps.pool.entries(provider);
		const enforceAccess =
			access !== undefined &&
			entries.some(({ credential }) => {
				if (credential.type !== "oauth") return false;
				const accountKey = oauthAccountKey(credential);
				return accountKey !== undefined && access.has(accountKey);
			});
		const holds = this.#liveHolds(`${provider}\0${key}`);
		return credentialIndex => {
			const entry = entries[credentialIndex];
			if (!entry) return false;
			const credential = entry.credential;
			if (holds?.has(entry.id)) return false;
			if (enforceAccess && credential.type === "oauth") {
				const accountKey = oauthAccountKey(credential);
				if (accountKey === undefined || !access.has(accountKey)) return false;
			}
			return (
				this.#deps.blocks.scopeBlockedUntil(
					provider,
					providerTypeKey(provider, credential.type),
					credentialIndex,
					scope,
				) === undefined
			);
		};
	}

	/**
	 * Hold the credential at `credentialIndex` off `modelId` after it refused the model as not
	 * found, pending confirmation by {@link confirmServed}. Returns false, holding nothing, when
	 * the model id or credential cannot be identified or every candidate recently refused it.
	 */
	holdModelNotFound(provider: string, credentialIndex: number, modelId: string | undefined): boolean {
		const key = entitlementModelKey(modelId);
		const entry = this.#deps.pool.entries(provider)[credentialIndex];
		if (key === undefined || !entry) return false;
		const holdKey = `${provider}\0${key}`;
		const nowMs = Date.now();
		const exhaustedUntil = this.#exhausted.get(holdKey);
		if (exhaustedUntil !== undefined) {
			if (exhaustedUntil > nowMs) return false;
			this.#exhausted.delete(holdKey);
		}
		let holds = this.#holds.get(holdKey);
		if (!holds) {
			holds = new Map();
			this.#holds.set(holdKey, holds);
		}
		holds.set(entry.id, nowMs + MODEL_NOT_FOUND_HOLD_TTL_MS);
		return true;
	}

	/**
	 * Forget every model-not-found hold for `modelId` without recording a denial: every candidate
	 * refused the model, so the refusals say nothing about any one account. Further holds for the
	 * model are refused until {@link MODEL_NOT_FOUND_HOLD_TTL_MS} passes or a request is served.
	 */
	releaseModelNotFound(provider: string, modelId: string | undefined): void {
		const key = entitlementModelKey(modelId);
		if (key === undefined) return;
		const holdKey = `${provider}\0${key}`;
		this.#holds.delete(holdKey);
		this.#exhausted.set(holdKey, Date.now() + MODEL_NOT_FOUND_HOLD_TTL_MS);
	}

	/**
	 * The stored credential `credentialId` served `modelId`: every other credential holding an
	 * unconfirmed model-not-found refusal of it is account-specifically denied, so a denial is
	 * recorded for each and all holds for the model are dropped. Returns how many denials were
	 * recorded.
	 */
	confirmServed(provider: string, credentialId: number, modelId: string | undefined): number {
		const key = entitlementModelKey(modelId);
		if (key === undefined) return 0;
		const holdKey = `${provider}\0${key}`;
		this.#exhausted.delete(holdKey);
		const holds = this.#liveHolds(holdKey);
		if (!holds) return 0;
		this.#holds.delete(holdKey);
		const entries = this.#deps.pool.entries(provider);
		let recorded = 0;
		for (const heldId of holds) {
			if (heldId === credentialId) continue;
			const index = entries.findIndex(entry => entry.id === heldId);
			if (index !== -1 && this.recordDenial(provider, index, modelId)) recorded++;
		}
		return recorded;
	}

	/** Unexpired held credential ids under `holdKey`; drops expired holds. */
	#liveHolds(holdKey: string): ReadonlySet<number> | undefined {
		const holds = this.#holds.get(holdKey);
		if (!holds) return undefined;
		const nowMs = Date.now();
		const live = new Set<number>();
		for (const [credentialId, untilMs] of holds) {
			if (untilMs > nowMs) live.add(credentialId);
			else holds.delete(credentialId);
		}
		if (holds.size === 0) this.#holds.delete(holdKey);
		return live.size > 0 ? live : undefined;
	}

	/**
	 * Record that the credential at `credentialIndex` is not entitled to
	 * `modelId` until `ttlMs` from now, persisted with the credential's blocks.
	 * Returns false when the model id or credential cannot be identified.
	 */
	recordDenial(
		provider: string,
		credentialIndex: number,
		modelId: string | undefined,
		ttlMs = MODEL_ENTITLEMENT_DENIAL_TTL_MS,
	): boolean {
		const scope = modelEntitlementBlockScope(modelId);
		const entry = this.#deps.pool.entries(provider)[credentialIndex];
		if (scope === undefined || !entry || !(ttlMs > 0)) return false;
		const until = Date.now() + ttlMs;
		this.#deps.blocks.mark(
			provider,
			providerTypeKey(provider, entry.credential.type),
			credentialIndex,
			until,
			scope,
			true,
		);
		logger.info("Recorded model entitlement denial", {
			provider,
			credentialId: entry.id,
			modelId,
			untilMs: until,
		});
		return true;
	}
}
