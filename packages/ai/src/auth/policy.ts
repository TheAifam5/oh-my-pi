import { logger } from "@oh-my-pi/pi-utils";
import * as AIError from "../error";
import type {
	AuthAccountPolicies,
	AuthAccountPolicy,
	AuthAccountSelector,
	AuthCredential,
	OAuthAccountIdentity,
	OAuthCredential,
} from "./types";
import {
	DEFAULT_USAGE_RESERVE_PCT,
	DRAIN_RETURN_TRIGGERS,
	DRAIN_SPEND_CLASSES,
	DRAIN_TRIGGER_SPEND_CLASS,
} from "./types";

/** Grammar of account names: lowercase only, so names never differ by case alone. */
export const ACCOUNT_NAME = /^[a-z0-9][a-z0-9_-]*$/;
/** Longest account name, in characters. */
export const MAX_ACCOUNT_NAME_LENGTH = 64;
const KEY_FINGERPRINT = /^[0-9a-f]{8}$/;

/**
 * Portable identifier of a stored API key: the first 8 hex digits of the
 * SHA-256 of the stored key value. Identifies the key across machines without
 * revealing it.
 */
export function apiKeyFingerprint(key: string): string {
	return new Bun.CryptoHasher("sha256").update(key).digest("hex").slice(0, 8);
}

/** Whether every identity field set on `selector` matches `identity`. */
export function matchesAuthAccountSelector(selector: AuthAccountSelector, identity: OAuthAccountIdentity): boolean {
	if (selector.keyFingerprint !== undefined) return false;
	return (
		(selector.email === undefined || selector.email === identity.email) &&
		(selector.accountId === undefined || selector.accountId === identity.accountId) &&
		(selector.projectId === undefined || selector.projectId === identity.projectId) &&
		(selector.orgId === undefined || selector.orgId === identity.orgId)
	);
}

/** Validated per-account routing policies (priority/reserve) plus the global reserve fallback. */
export class AccountPolicies {
	#accountPolicies: AuthAccountPolicies;
	#defaultReservePct: number;
	/** `provider\0name` pairs already reported as unresolvable under the current policies. */
	#warnedUnresolved = new Set<string>();

	constructor(policies: AuthAccountPolicies, defaultReservePct: number | undefined) {
		AccountPolicies.#validateAccountPolicyConfiguration(policies);
		this.#accountPolicies = policies;
		this.#defaultReservePct =
			typeof defaultReservePct === "number" && Number.isFinite(defaultReservePct)
				? Math.max(0, Math.min(100, defaultReservePct))
				: DEFAULT_USAGE_RESERVE_PCT;
	}

	/** Global usage reserve (0–100) for accounts without a per-account `reservePct`. */
	get defaultReservePct(): number {
		return this.#defaultReservePct;
	}

	/**
	 * Replace the policy set and global reserve in place (live settings change).
	 * Validates the configuration and every provider in `storedCredentials` before
	 * committing; on error the previous policies stay active.
	 */
	replace(
		policies: AuthAccountPolicies,
		defaultReservePct: number | undefined,
		storedCredentials: ReadonlyMap<string, readonly AuthCredential[]> = new Map(),
	): void {
		const next = new AccountPolicies(policies, defaultReservePct);
		for (const [provider, credentials] of storedCredentials) next.validateFor(provider, credentials);
		this.#accountPolicies = next.#accountPolicies;
		this.#defaultReservePct = next.#defaultReservePct;
		this.#warnedUnresolved.clear();
	}

	/** Log once per policy set that a soft account preference names no stored account. */
	warnUnresolved(provider: string, name: string): void {
		const key = `${provider}\0${name}`;
		if (this.#warnedUnresolved.has(key)) return;
		this.#warnedUnresolved.add(key);
		logger.warn("Preferred account is not stored; using normal account selection", { provider, account: name });
	}

	static #validateAccountPolicyConfiguration(accountPolicies: AuthAccountPolicies): void {
		const namesByProvider = new Map<string, Map<string, number>>();
		const fingerprintsByProvider = new Map<string, Map<string, number>>();
		const drainByProvider = new Map<string, number>();
		for (let index = 0; index < accountPolicies.length; index += 1) {
			const policy = accountPolicies[index]!;
			const path = `auth.accountPolicies[${index}]`;
			if (
				typeof policy.provider !== "string" ||
				policy.provider.length === 0 ||
				policy.provider.trim() !== policy.provider
			) {
				throw new AIError.ConfigurationError(
					`${path}.provider must be a non-empty string without surrounding whitespace`,
				);
			}
			if (policy.name !== undefined) {
				if (
					typeof policy.name !== "string" ||
					policy.name.length > MAX_ACCOUNT_NAME_LENGTH ||
					!ACCOUNT_NAME.test(policy.name)
				) {
					throw new AIError.ConfigurationError(
						`${path}.name must match ${ACCOUNT_NAME.source} and be at most ${MAX_ACCOUNT_NAME_LENGTH} characters`,
					);
				}
				const names = namesByProvider.get(policy.provider) ?? new Map<string, number>();
				const previousIndex = names.get(policy.name);
				if (previousIndex !== undefined) {
					throw new AIError.ConfigurationError(
						`auth.accountPolicies[${previousIndex}] and auth.accountPolicies[${index}] both name a ${policy.provider} account "${policy.name}"`,
					);
				}
				names.set(policy.name, index);
				namesByProvider.set(policy.provider, names);
			}
			if (!policy.account || typeof policy.account !== "object") {
				throw new AIError.ConfigurationError(`${path}.account must be an object`);
			}
			const baseIdentities = [policy.account.email, policy.account.accountId, policy.account.projectId];
			const hasOAuthIdentity = baseIdentities.some(value => typeof value === "string" && value.length > 0);
			if (policy.account.keyFingerprint !== undefined) {
				if (
					typeof policy.account.keyFingerprint !== "string" ||
					!KEY_FINGERPRINT.test(policy.account.keyFingerprint)
				) {
					throw new AIError.ConfigurationError(
						`${path}.account.keyFingerprint must be 8 lowercase hexadecimal digits`,
					);
				}
				if (hasOAuthIdentity || policy.account.orgId !== undefined) {
					throw new AIError.ConfigurationError(
						`${path}.account.keyFingerprint cannot be combined with email, accountId, projectId, or orgId`,
					);
				}
				const fingerprints = fingerprintsByProvider.get(policy.provider) ?? new Map<string, number>();
				const previousIndex = fingerprints.get(policy.account.keyFingerprint);
				if (previousIndex !== undefined) {
					throw new AIError.ConfigurationError(
						`auth.accountPolicies[${previousIndex}] and auth.accountPolicies[${index}] match the same ${policy.provider} API key`,
					);
				}
				fingerprints.set(policy.account.keyFingerprint, index);
				fingerprintsByProvider.set(policy.provider, fingerprints);
			} else if (!hasOAuthIdentity) {
				throw new AIError.ConfigurationError(
					`${path}.account must include at least one of email, accountId, projectId, or keyFingerprint`,
				);
			}
			for (const field of ["email", "accountId", "projectId", "orgId"] as const) {
				const value = policy.account[field];
				if (value !== undefined && (typeof value !== "string" || value.length === 0)) {
					throw new AIError.ConfigurationError(`${path}.account.${field} must be a non-empty string`);
				}
			}
			if (policy.priority !== undefined && !Number.isFinite(policy.priority)) {
				throw new AIError.ConfigurationError(`${path}.priority must be a finite number`);
			}
			if (
				policy.reservePct !== undefined &&
				(!Number.isFinite(policy.reservePct) || policy.reservePct < 0 || policy.reservePct > 100)
			) {
				throw new AIError.ConfigurationError(`${path}.reservePct must be a finite number between 0 and 100`);
			}
			if (policy.drain !== undefined && typeof policy.drain !== "boolean") {
				throw new AIError.ConfigurationError(`${path}.drain must be a boolean`);
			}
			if (policy.drain === true) {
				if (policy.account.keyFingerprint !== undefined) {
					throw new AIError.ConfigurationError(`${path}.drain applies to OAuth accounts only`);
				}
				const previousIndex = drainByProvider.get(policy.provider);
				if (previousIndex !== undefined) {
					throw new AIError.ConfigurationError(
						`auth.accountPolicies[${previousIndex}] and auth.accountPolicies[${index}] both drain a ${policy.provider} account; only one may`,
					);
				}
				drainByProvider.set(policy.provider, index);
			}
			if (
				policy.returnMargin !== undefined &&
				(!Number.isFinite(policy.returnMargin) || policy.returnMargin < 0 || policy.returnMargin > 100)
			) {
				throw new AIError.ConfigurationError(`${path}.returnMargin must be a finite number between 0 and 100`);
			}
			if (
				policy.returnCooldownMs !== undefined &&
				(!Number.isFinite(policy.returnCooldownMs) || policy.returnCooldownMs < 0)
			) {
				throw new AIError.ConfigurationError(`${path}.returnCooldownMs must be a non-negative number`);
			}
			if (policy.spend !== undefined || policy.returnWhen !== undefined) {
				AccountPolicies.#validateDrainFunding(policy, path);
			}
		}
	}

	static #validateDrainFunding(policy: AuthAccountPolicy, path: string): void {
		if (policy.drain !== true) {
			throw new AIError.ConfigurationError(`${path}.spend and ${path}.returnWhen require drain: true`);
		}
		const spend: unknown = policy.spend === undefined ? [] : policy.spend;
		if (!Array.isArray(spend) || spend.some(entry => !(DRAIN_SPEND_CLASSES as readonly unknown[]).includes(entry))) {
			throw new AIError.ConfigurationError(`${path}.spend must be a list of ${DRAIN_SPEND_CLASSES.join(", ")}`);
		}
		const triggers: readonly unknown[] =
			policy.returnWhen === undefined || Array.isArray(policy.returnWhen)
				? (policy.returnWhen ?? [])
				: [policy.returnWhen];
		if (
			(Array.isArray(policy.returnWhen) && policy.returnWhen.length === 0) ||
			triggers.some(entry => !(DRAIN_RETURN_TRIGGERS as readonly unknown[]).includes(entry))
		) {
			throw new AIError.ConfigurationError(
				`${path}.returnWhen must be one or a non-empty list of ${DRAIN_RETURN_TRIGGERS.join(", ")}`,
			);
		}
		for (const [trigger, spendClass] of Object.entries(DRAIN_TRIGGER_SPEND_CLASS)) {
			if (triggers.includes(trigger) && !spend.includes(spendClass)) {
				throw new AIError.ConfigurationError(
					`${path}.returnWhen ${trigger} requires spend to include ${spendClass}`,
				);
			}
		}
	}

	validateUsageCapability(provider: string, canFetchUsage: boolean): void {
		const policyIndex = this.#accountPolicies.findIndex(
			policy =>
				policy.provider === provider &&
				policy.account.keyFingerprint === undefined &&
				policy.reservePct !== undefined,
		);
		if (policyIndex !== -1 && !canFetchUsage) {
			throw new AIError.ConfigurationError(
				`auth.accountPolicies[${policyIndex}].reservePct requires a usage provider for ${provider}`,
			);
		}
	}

	validateFor(provider: string, credentials: readonly AuthCredential[]): void {
		const policies = this.#accountPolicies
			.map((policy, index) => ({ policy, index }))
			.filter(({ policy }) => policy.provider === provider && policy.account.keyFingerprint === undefined);
		if (policies.length === 0) return;
		const oauthCredentials = credentials.filter(
			(credential): credential is OAuthCredential => credential.type === "oauth",
		);
		if (oauthCredentials.length === 0) return;

		const claimedCredentials = new Map<number, number>();
		for (const { policy, index } of policies) {
			const matches: number[] = [];
			for (let credentialIndex = 0; credentialIndex < oauthCredentials.length; credentialIndex += 1) {
				if (matchesAuthAccountSelector(policy.account, oauthCredentials[credentialIndex]!)) {
					matches.push(credentialIndex);
				}
			}
			const path = `auth.accountPolicies[${index}].account`;
			if (matches.length === 0) {
				throw new AIError.ConfigurationError(`${path} matches no stored OAuth account for ${provider}`);
			}
			if (matches.length > 1) {
				throw new AIError.ConfigurationError(
					`${path} matches ${matches.length} stored OAuth accounts for ${provider}; add another identity field`,
				);
			}
			const credentialIndex = matches[0]!;
			const previousPolicyIndex = claimedCredentials.get(credentialIndex);
			if (previousPolicyIndex !== undefined) {
				throw new AIError.ConfigurationError(
					`auth.accountPolicies[${previousPolicyIndex}] and auth.accountPolicies[${index}] match the same stored OAuth account for ${provider}`,
				);
			}
			claimedCredentials.set(credentialIndex, index);
		}
	}

	static #matchesStored(policy: AuthAccountPolicy, credential: AuthCredential): boolean {
		if (credential.type === "oauth") return matchesAuthAccountSelector(policy.account, credential);
		return policy.account.keyFingerprint === apiKeyFingerprint(credential.key);
	}

	/** Return the policy matching a stored credential of either type (OAuth identity or API key fingerprint). */
	forStored(provider: string, credential: AuthCredential): AuthAccountPolicy | undefined {
		return this.#accountPolicies.find(
			policy => policy.provider === provider && AccountPolicies.#matchesStored(policy, credential),
		);
	}

	/** The OAuth credential in `credentials` an account policy drains for `provider`, with its index and policy. */
	drainTarget(
		provider: string,
		credentials: readonly AuthCredential[],
	): { index: number; policy: AuthAccountPolicy } | undefined {
		const policy = this.#accountPolicies.find(entry => entry.provider === provider && entry.drain === true);
		if (!policy) return undefined;
		const index = credentials.findIndex(
			credential => credential.type === "oauth" && AccountPolicies.#matchesStored(policy, credential),
		);
		return index === -1 ? undefined : { index, policy };
	}

	/**
	 * Index into `credentials` of the stored credential named `name` for
	 * `provider`, or -1 when no policy carries the name or no stored credential
	 * matches it.
	 */
	indexOfNamed(provider: string, name: string, credentials: readonly AuthCredential[]): number {
		const policy = this.#accountPolicies.find(entry => entry.provider === provider && entry.name === name);
		return policy ? credentials.findIndex(credential => AccountPolicies.#matchesStored(policy, credential)) : -1;
	}

	/**
	 * Return the configured account policy matching an OAuth identity.
	 *
	 * This is a read-only diagnostics surface: it performs the same conjunctive
	 * selector match as routing and never refreshes, ranks, or mutates credentials.
	 */
	find(provider: string, identity: OAuthAccountIdentity): AuthAccountPolicy | undefined {
		return this.#accountPolicies.find(
			policy => policy.provider === provider && matchesAuthAccountSelector(policy.account, identity),
		);
	}

	/** Return the configured policy for a stored OAuth credential. */
	forCredential(provider: string, credential: AuthCredential): AuthAccountPolicy | undefined {
		return credential.type === "oauth" ? this.find(provider, credential) : undefined;
	}
}
