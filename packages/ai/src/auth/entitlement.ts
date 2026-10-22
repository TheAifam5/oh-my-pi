import { logger } from "@oh-my-pi/pi-utils";
import { type CredentialBlocks, modelEntitlementBlockScope as scopeForModelKey, providerTypeKey } from "./blocks";
import type { CredentialPool } from "./pool";
import { oauthAccountKey } from "./types";

/** How long a learned model-entitlement denial excludes a credential from that model. */
export const MODEL_ENTITLEMENT_DENIAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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
 * at least one stored OAuth account of the provider and not this one, or when
 * a model-entitlement denial was recorded for it and has not expired. Every
 * selection pass, rotation sibling check, and model health read applies the
 * same verdict.
 */
export class ModelEntitlements {
	readonly #deps: ModelEntitlementsDeps;
	readonly #accountAccess: Map<string, ReadonlySet<string>>;

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
	 * list. Without a model id every credential is entitled.
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
		const credentials = this.#deps.pool.credentials(provider);
		const enforceAccess =
			access !== undefined &&
			credentials.some(credential => {
				if (credential.type !== "oauth") return false;
				const accountKey = oauthAccountKey(credential);
				return accountKey !== undefined && access.has(accountKey);
			});
		return credentialIndex => {
			const credential = credentials[credentialIndex];
			if (!credential) return false;
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
