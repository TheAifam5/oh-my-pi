import { logger } from "@oh-my-pi/pi-utils";
import * as AIError from "../error";
import { getOAuthApiKey, getOAuthProvider } from "../registry/oauth";
import type { OAuthCredentials, OAuthProvider } from "../registry/oauth/types";
import type { Provider } from "../types";
import type { CredentialRankingContext, CredentialRankingStrategy, PlanGate, UsageReport } from "../usage";
import { type BillingSnapshot, type BillingSource, type DecimalQuantity } from "../usage/billing";
import { type AccountEvidenceLimit, isAccountEvidenceLimit, type LocalLimit } from "../usage/limits";
import type { RankingStrategyResolver } from "../usage/registry";
import type { SessionAffinity } from "./affinity";
import {
	AUTH_BLOCK_SCOPE,
	credentialBlockScopesForRequest,
	DEFAULT_BLOCK_MS,
	providerTypeKey,
	type CredentialBlocks,
} from "./blocks";
import {
	type DrainedState,
	drainStateExpiresAtSec,
	drainStateKey,
	drainStateTtlMs,
	parseDrainedState,
	SPEND_CLASS_MODES,
	serializeDrainedState,
} from "./drain-state";
import { type AccountPolicies, accountUsageKey, apiKeyFingerprint } from "./policy";
import { authCredentialEquals, type CredentialPool } from "./pool";
import {
	orderUsageRankedCandidates,
	planPriority,
	type ApiKeyCandidate,
	type ApiKeySelection,
	type OAuthCandidate,
	type OAuthSelection,
	type RankedApiKeyCandidate,
	type RankedOAuthCandidate,
	type UsageRankingResult,
} from "./rank";
import { mergeRefreshedCredential, OAUTH_REFRESH_SKEW_MS, type OAuthRefresher } from "./refresh";
import type { AuthCredentialStore } from "./store";
import {
	type AccountLimitRefusal,
	type ApiKeyCredential,
	type AuthAccountPolicy,
	type AuthApiKeyOptions,
	type AuthCredential,
	DEFAULT_DRAIN_RETURN_COOLDOWN_MS,
	DEFAULT_DRAIN_RETURN_MARGIN_PCT,
	type DrainReturnTrigger,
	type DrainSpendClass,
	type OAuthCredential,
	type StoredAuthCredential,
} from "./types";
import type { UsageService } from "./usage";
import {
	isUsageLimitReached,
	normalizeUsageFraction,
	remainingUsageFraction,
	usedUsageFraction,
	scopedUsageLimits,
	usageResetAtMs,
	windowRequiredDrain,
} from "./usage-report";

/** Temporary block after a transient OAuth refresh failure. */
export const OAUTH_REFRESH_FAILURE_BACKOFF_MS = 5 * 60 * 1000;

/** OAuth bearer and credential chosen for a request, with its durable row id when available. */
export type OAuthResolutionResult = { apiKey: string; credential: OAuthCredential; credentialId?: number };

/** Options for CredentialSelector.tryOAuth when evaluating one OAuth credential. */
export type TryOAuthOptions = {
	checkUsage: boolean;
	allowBlocked: boolean;
	prefetchedUsage?: UsageReport | null;
	usagePrechecked?: boolean;
	planGate?: PlanGate;
	enforcePlanRequirement?: boolean;
	strategy?: CredentialRankingStrategy;
	rankingContext?: CredentialRankingContext;
	blockScope?: string;
	blockScopes?: readonly string[];
	/** When false, a definitive failure of THIS credential returns undefined instead of falling back to the ranked/round-robin selector (target-only resolution). */
	allowFallback?: boolean;
	/** Receives a non-definitive refresh failure that left this credential unusable; the caller filters for retryable ones. */
	onTransientRefreshFailure?: (error: unknown) => void;
	/** The drain target's spent plan is funded by an opted-in spend class: a reached usage limit in its report does not reject it. */
	fundedOverage?: boolean;
};

/** The account a session drains first, with what it may spend and its return hysteresis and triggers. */
type DrainTarget = {
	provider: string;
	index: number;
	credentialId: number;
	returnFraction: number;
	cooldownMs: number;
	spend: readonly DrainSpendClass[];
	returnWhen: readonly DrainReturnTrigger[];
};

/** Billing evidence of a drain target's usage report, or why there is none. */
type DrainBilling = { snapshot?: BillingSnapshot; unavailable?: string };

/**
 * A drain state this process last read or wrote: `persisted` once the store
 * returned it, `misses` consecutive reads that found no row since, and
 * `writtenAtMs` when this process last wrote it.
 */
type CachedDrainState = { state: DrainedState; persisted: boolean; misses: number; writtenAtMs?: number };

/** Consecutive missed reads after which a stored drain state counts as returned or expired, not a transient failure. */
const DRAIN_STATE_DROP_MISSES = 2;

function sourcesOf(snapshot: BillingSnapshot | undefined, spendClass: keyof typeof SPEND_CLASS_MODES): BillingSource[] {
	return snapshot?.sources.filter(source => SPEND_CLASS_MODES[spendClass].includes(source.mode)) ?? [];
}

function classAvailable(snapshot: BillingSnapshot | undefined, spendClass: keyof typeof SPEND_CLASS_MODES): boolean {
	return sourcesOf(snapshot, spendClass).some(source => source.state === "available");
}

/** Whether `snapshot` reports the class exhausted or disabled; `unknown` is no verdict. */
function classSpent(snapshot: BillingSnapshot, spendClass: keyof typeof SPEND_CLASS_MODES): boolean {
	const sources = sourcesOf(snapshot, spendClass);
	return (
		!sources.some(source => source.state === "available") &&
		sources.some(source => source.state === "exhausted" || source.state === "disabled")
	);
}

/**
 * Verdict of a `credits` or `extra-usd` limit on an account spending past its plan allowance:
 * `reached` at the floor or cap, `unreadable` without the evidence to tell.
 */
function evidenceVerdict(
	limit: AccountEvidenceLimit,
	snapshot: BillingSnapshot | undefined,
): AccountLimitRefusal | undefined {
	if (!snapshot) return "unreadable";
	const cap = scaledDecimal(String(limit.max));
	if (limit.metric === "credits") {
		const sources = sourcesOf(snapshot, "credits");
		const balances = creditBalances(snapshot);
		if (balances.length === 0) {
			return sources.some(source => source.state === "exhausted") ? "reached" : "unreadable";
		}
		const exponent = Math.max(cap.exponent, ...balances.map(balance => balance.exponent));
		const scale = (coefficient: bigint, from: number) => coefficient * 10n ** BigInt(exponent - from);
		const total = balances.reduce((sum, balance) => sum + scale(BigInt(balance.amountMinor), balance.exponent), 0n);
		return total < scale(cap.coefficient, cap.exponent) ? "reached" : undefined;
	}
	const sources = sourcesOf(snapshot, "money");
	const used = sources.flatMap(source =>
		source.allowance?.kind === "money" && source.allowance.used?.currency === "USD" ? [source.allowance.used] : [],
	);
	if (used.length === 0) {
		return sources.some(source => source.state === "exhausted" || source.state === "disabled")
			? "reached"
			: "unreadable";
	}
	// USD minor units are cents.
	const total = used.reduce((sum, amount) => sum + BigInt(amount.amountMinor), 0n) * 10n ** BigInt(cap.exponent);
	return total >= cap.coefficient * 100n ? "reached" : undefined;
}

/** A quoted decimal amount as an exact coefficient at its own number of decimal places. */
function scaledDecimal(text: string): { coefficient: bigint; exponent: number } {
	const [integer = "0", fraction = ""] = text.split(".");
	return { coefficient: BigInt(integer + fraction), exponent: fraction.length };
}

/** Reported remaining prepaid credit balances in `snapshot`. */
function creditBalances(snapshot: BillingSnapshot): DecimalQuantity[] {
	return sourcesOf(snapshot, "credits").flatMap(source =>
		source.allowance?.kind === "credits" && source.allowance.remaining ? [source.allowance.remaining] : [],
	);
}

/** Whether `current` shows prepaid credits added since `baseline`: a larger balance, or spent credits available again. */
function creditsAdded(baseline: BillingSnapshot, current: BillingSnapshot): boolean {
	if (!classAvailable(current, "credits")) return false;
	if (classSpent(baseline, "credits")) return true;
	if (!classAvailable(baseline, "credits")) return false;
	const before = creditBalances(baseline);
	const after = creditBalances(current);
	if (before.length === 0 || after.length === 0) return false;
	const exponent = Math.max(...[...before, ...after].map(quantity => quantity.exponent));
	const total = (quantities: DecimalQuantity[]) =>
		quantities.reduce(
			(sum, quantity) => sum + BigInt(quantity.amountMinor) * 10n ** BigInt(exponent - quantity.exponent),
			0n,
		);
	return total(after) > total(before);
}

/** Account limit verdicts by stored row id, shared by every step of one credential resolution. */
export type AccountRefusals = Map<number, Promise<AccountLimitRefusal | undefined>>;

/** Services consulted by CredentialSelector for policy, usage, blocks, refresh, and session affinity. */
export interface CredentialSelectorDeps {
	store: AuthCredentialStore;
	pool: CredentialPool;
	policies: AccountPolicies;
	blocks: CredentialBlocks;
	affinity: SessionAffinity;
	usage: UsageService;
	refresher: OAuthRefresher;
	strategies: RankingStrategyResolver;
}

/** Picks which stored credential serves a request: ordering, usage ranking, OAuth refresh ladder. */
export class CredentialSelector {
	/** Tracks next credential index per provider:type key for round-robin distribution (non-session use). */
	#providerRoundRobinIndex: Map<string, number> = new Map();
	/** Write-through copy of the persisted drain state rows, by {@link drainStateKey}; cleared once the target returns. */
	#drainedSince: Map<string, CachedDrainState> = new Map();
	/** Reached `warn` evidence limits already logged, by `provider\0rowId\0metric`; cleared once they clear. */
	#warnedEvidenceLimits = new Set<string>();
	/** Drain billing warnings already logged, by `provider\0kind`. */
	#warnedNoBilling = new Set<string>();
	#deps: CredentialSelectorDeps;

	constructor(deps: CredentialSelectorDeps) {
		this.#deps = deps;
	}

	/** Restart round-robin assignments after a provider's credential set changes. */
	resetRoundRobin(provider: string): void {
		for (const key of this.#providerRoundRobinIndex.keys()) {
			if (key.startsWith(`${provider}:`)) {
				this.#providerRoundRobinIndex.delete(key);
			}
		}
	}

	/**
	 * Returns next index in round-robin sequence for load distribution.
	 * Increments stored counter and wraps at total.
	 */
	#getNextRoundRobinIndex(providerKey: string, total: number): number {
		if (total <= 1) return 0;
		const current = this.#providerRoundRobinIndex.get(providerKey) ?? -1;
		const next = (current + 1) % total;
		this.#providerRoundRobinIndex.set(providerKey, next);
		return next;
	}

	/**
	 * FNV-1a hash for deterministic session-to-credential mapping.
	 * Ensures the same session always starts with the same credential.
	 */
	#getHashedIndex(sessionId: string, total: number): number {
		if (total <= 1) return 0;
		return Bun.hash.xxHash32(sessionId) % total;
	}

	/**
	 * Returns credential indices in priority order for selection.
	 * With sessionId: starts from hashed index (consistent per session).
	 * Without sessionId: starts from round-robin index (load balancing).
	 * Order wraps around so all credentials are tried if earlier ones are blocked.
	 */
	#getCredentialOrder(providerKey: string, sessionId: string | undefined, total: number): number[] {
		if (total <= 1) return [0];
		const start = sessionId
			? this.#getHashedIndex(sessionId, total)
			: this.#getNextRoundRobinIndex(providerKey, total);
		const order: number[] = [];
		for (let i = 0; i < total; i++) {
			order.push((start + i) % total);
		}
		return order;
	}

	/**
	 * Selects a credential of the specified type for a provider.
	 * Returns both the credential and its index in the original array (for updates/removal).
	 * Uses deterministic hashing for session stickiness and skips blocked credentials when possible.
	 */
	selectByType<T extends AuthCredential["type"]>(
		provider: string,
		type: T,
		sessionId?: string,
		filter?: (credential: AuthCredential) => boolean,
	): { credential: Extract<AuthCredential, { type: T }>; index: number } | undefined {
		const credentials = this.#deps.pool
			.credentials(provider)
			.map((credential, index) => ({ credential, index }))
			.filter(
				(
					entry,
				): entry is {
					credential: Extract<AuthCredential, { type: T }>;
					index: number;
				} => {
					if (entry.credential.type !== type) return false;
					return filter?.(entry.credential) ?? true;
				},
			);

		if (credentials.length === 0) return undefined;
		if (credentials.length === 1) return credentials[0];

		const providerKey = providerTypeKey(provider, type);
		const order = this.#getCredentialOrder(providerKey, sessionId, credentials.length);
		const fallback = credentials[order[0]];

		for (const idx of order) {
			const candidate = credentials[idx];
			if (!this.#deps.blocks.isBlocked(provider, providerKey, candidate.index)) {
				return candidate;
			}
		}

		return fallback;
	}

	async #rankApiKeySelections(args: {
		providerKey: string;
		provider: string;
		order: number[];
		credentials: ApiKeySelection[];
		options?: AuthApiKeyOptions;
		strategy: CredentialRankingStrategy;
		rankingContext: CredentialRankingContext;
		blockScope?: string;
		/** Scopes a block may live under for this request; reads honour all of them. */
		blockScopes?: readonly string[];
	}): Promise<ApiKeyCandidate[]> {
		const nowMs = Date.now();
		const { strategy } = args;
		const ranked: RankedApiKeyCandidate[] = [];
		const usageTimeout = Math.max(5000, this.#deps.usage.requestTimeoutMs * 1.5);
		const usagePromise: Promise<Array<UsageRankingResult<ApiKeyCredential> | null>> = Promise.all(
			args.order.map(async idx => {
				const selection = args.credentials[idx];
				if (!selection) return null;
				const blockedUntil = this.#deps.blocks.blockedUntil(
					args.provider,
					args.providerKey,
					selection.index,
					args.blockScopes ?? args.blockScope,
				);
				if (blockedUntil !== undefined) {
					return { selection, usage: null, usageChecked: false, blockedUntil };
				}
				const usage = await this.#deps.usage.report(args.provider, selection.credential, {
					...args.options,
					timeoutMs: this.#deps.usage.requestTimeoutMs,
				});
				return {
					selection,
					usage,
					usageChecked: true,
					blockedUntil: undefined,
				};
			}),
		);
		const timeoutSignal = Promise.withResolvers<null>();
		const timer = setTimeout(() => timeoutSignal.resolve(null), usageTimeout);
		timer.unref?.();
		const usageResults = await Promise.race([usagePromise, timeoutSignal.promise]).then(result => {
			clearTimeout(timer);
			if (result) return result;
			return args.order.map(idx => {
				const selection = args.credentials[idx];
				if (!selection) return null;
				const blockedUntil = this.#deps.blocks.blockedUntil(
					args.provider,
					args.providerKey,
					selection.index,
					args.blockScopes ?? args.blockScope,
				);
				return { selection, usage: null, usageChecked: false, blockedUntil };
			});
		});

		for (let orderPos = 0; orderPos < usageResults.length; orderPos += 1) {
			const result = usageResults[orderPos];
			if (!result) continue;
			const { selection, usage, usageChecked } = result;
			let { blockedUntil } = result;
			let blocked = blockedUntil !== undefined;
			const scopedLimits = usage ? scopedUsageLimits(strategy, usage, args.rankingContext) : undefined;
			if (!blocked && scopedLimits && isUsageLimitReached(scopedLimits)) {
				const resetAtMs = usageResetAtMs(scopedLimits, nowMs);
				blockedUntil = resetAtMs ?? Date.now() + DEFAULT_BLOCK_MS;
				this.#deps.blocks.mark(
					args.provider,
					args.providerKey,
					selection.index,
					blockedUntil,
					args.blockScope,
					resetAtMs !== undefined,
				);
				blocked = true;
			}
			const windows = usage ? strategy.findWindowLimits(usage, args.rankingContext) : undefined;
			const primary = windows?.primary;
			const secondary = windows?.secondary;
			const usageMeasured = primary !== undefined || secondary !== undefined;
			const primaryUncapped = primary === undefined && secondary !== undefined;
			ranked.push({
				selection,
				usage,
				usageChecked,
				blocked,
				blockedUntil,
				inReserve: false,
				accountPriority: 0,
				drainTarget: false,
				allowanceSpent: remainingUsageFraction(strategy, usage, args.rankingContext, nowMs) === 0,
				usageMeasured,
				hasPriorityBoost: strategy.hasPriorityBoost?.(primary, primaryUncapped, args.rankingContext) ?? false,
				planPriority: 0,
				secondaryUsed: normalizeUsageFraction(secondary),
				secondaryRequiredDrain: windowRequiredDrain(secondary, nowMs, strategy.windowDefaults.secondaryMs),
				primaryUsed: normalizeUsageFraction(primary),
				primaryRequiredDrain: windowRequiredDrain(primary, nowMs, strategy.windowDefaults.primaryMs),
				orderPos,
			});
		}
		return orderUsageRankedCandidates(ranked, false);
	}

	/**
	 * Why a `skip` limit of the stored credential's account policy refuses another call, as the
	 * installed {@link AccountLimitSource} reports; never without a source or limits, nor for a
	 * {@link AuthApiKeyOptions.committedSpend} call.
	 */
	accountLimit(
		provider: string,
		index: number,
		options: AuthApiKeyOptions | undefined,
	): AccountLimitRefusal | undefined {
		if (options?.committedSpend) return undefined;
		const source = this.#deps.usage.limitSource;
		const credential = this.#deps.pool.credentials(provider)[index];
		if (!source || !credential) return undefined;
		const policy = this.#deps.policies.forStored(provider, credential);
		const limits = policy?.limits?.filter((limit): limit is LocalLimit => !isAccountEvidenceLimit(limit)) ?? [];
		if (limits.length === 0) return undefined;
		const account = accountUsageKey(
			credential.type === "api_key"
				? { keyFingerprint: apiKeyFingerprint(credential.key) }
				: { email: credential.email, accountId: credential.accountId, projectId: credential.projectId },
		);
		return account === undefined ? undefined : source.refuses(provider, account, limits, Date.now());
	}

	/**
	 * {@link accountLimit}, then the account policy's limits on provider evidence for an OAuth
	 * account ({@link #evidenceRefusal}), reading its usage report.
	 */
	async accountRefusal(
		provider: string,
		index: number,
		options: AuthApiKeyOptions | undefined,
		memo?: AccountRefusals,
	): Promise<AccountLimitRefusal | undefined> {
		const rowId = this.#deps.pool.entries(provider)[index]?.id;
		const compute = async () =>
			this.accountLimit(provider, index, options) ?? (await this.#evidenceRefusal(provider, index, options));
		if (!memo || rowId === undefined) return compute();
		let verdict = memo.get(rowId);
		if (!verdict) {
			verdict = compute();
			memo.set(rowId, verdict);
		}
		return verdict;
	}

	/**
	 * The refusal of the stored OAuth account's `usage`, `credits`, and `extra-usd` limits. `usage`
	 * holds the account back once its used fraction reaches the cap; unmeasured usage never does.
	 * `credits` and `extra-usd` only gate an account whose plan allowance is spent, as it would then
	 * spend that class: a known balance under the floor or reported extra usage at the cap refuses
	 * with `reached`, missing evidence with `unreadable`. An account whose usage report cannot be
	 * read is never held back by these limits. A reached `warn` limit is logged once until it clears.
	 * A {@link AuthApiKeyOptions.committedSpend} call is never refused.
	 */
	async #evidenceRefusal(
		provider: string,
		index: number,
		options: AuthApiKeyOptions | undefined,
	): Promise<AccountLimitRefusal | undefined> {
		if (options?.committedSpend) return undefined;
		const credential = this.#deps.pool.credentials(provider)[index];
		if (credential?.type !== "oauth") return undefined;
		const limits = this.#deps.policies.forStored(provider, credential)?.limits?.filter(isAccountEvidenceLimit) ?? [];
		if (limits.length === 0) return undefined;
		const account = accountUsageKey(credential) ?? `#${index}`;
		const report = await this.#deps.usage.report(provider, credential, {
			...options,
			timeoutMs: this.#deps.usage.requestTimeoutMs,
		});
		const used = usedUsageFraction(
			this.#deps.strategies(provider),
			report,
			{ modelId: options?.modelId },
			Date.now(),
		);
		const planSpent = used !== undefined && used >= 1;
		const billing = planSpent && report ? this.#deps.usage.billing(provider, report) : undefined;
		const snapshot = billing?.status === "known" ? billing.snapshot : undefined;
		const verdicts = limits.map(limit => {
			let verdict: AccountLimitRefusal | undefined;
			if (limit.metric === "usage") {
				verdict = used !== undefined && used >= Number(limit.max) ? "reached" : undefined;
			} else if (planSpent) {
				verdict = evidenceVerdict(limit, snapshot);
			}
			const key = `${provider}\0${account}\0${options?.modelId ?? ""}\0${limit.metric}`;
			if (limit.onLimit === "warn") {
				if (verdict === "reached" && !this.#warnedEvidenceLimits.has(key)) {
					this.#warnedEvidenceLimits.add(key);
					logger.warn("Local account limit reached", { provider, metric: limit.metric, max: limit.max });
				} else if (verdict === undefined) {
					this.#warnedEvidenceLimits.delete(key);
				}
				return undefined;
			}
			return verdict;
		});
		return verdicts.includes("reached") ? "reached" : verdicts.includes("unreadable") ? "unreadable" : undefined;
	}

	/**
	 * Fails when every stored account of `provider` the session may use is over a local limit, so the request never
	 * falls back to an environment or fallback key; a limited drain target is recorded as drained.
	 *
	 * @throws AIError.AccountLimitError naming only the provider.
	 */
	async refuseIfAllLimited(
		provider: string,
		sessionId: string | undefined,
		options: AuthApiKeyOptions | undefined,
		memo?: AccountRefusals,
	): Promise<void> {
		// A restricted session only weighs the accounts its restriction allows.
		const indices = this.#deps.pool
			.credentials(provider)
			.flatMap((credential, index) => (this.#deps.affinity.allows(provider, sessionId, credential) ? [index] : []));
		if (indices.length === 0) return;
		const refusals = await Promise.all(indices.map(index => this.accountRefusal(provider, index, options, memo)));
		if (refusals.some(refusal => refusal === undefined)) return;
		this.#noteLimitedDrain(provider, sessionId, options?.modelId, new Set(indices));
		throw new AIError.AccountLimitError(provider, refusals.includes("unreadable") ? "unreadable" : "reached");
	}

	/** Records the drain target as drained when it is among `limited`, so its return waits out the cooldown. */
	#noteLimitedDrain(
		provider: string,
		sessionId: string | undefined,
		modelId: string | undefined,
		limited: ReadonlySet<number>,
	): boolean {
		if (limited.size === 0) return false;
		const drain = this.#drainTarget(provider, sessionId, modelId);
		if (!drain || !limited.has(drain.index)) return false;
		const blockScope = this.#deps.strategies(provider)?.blockScope?.({ modelId });
		this.#drainServing(drain, blockScope, true, undefined, Date.now(), undefined);
		return true;
	}

	async selectApiKey(
		provider: string,
		sessionId: string | undefined,
		options: AuthApiKeyOptions | undefined,
		filter?: (credential: ApiKeyCredential) => boolean,
	): Promise<ApiKeySelection | undefined> {
		const credentials = this.#deps.pool
			.credentials(provider)
			.map((credential, index) => ({ credential, index }))
			.filter((entry): entry is ApiKeySelection => {
				if (entry.credential.type !== "api_key") return false;
				if (!(filter?.(entry.credential) ?? true)) return false;
				return this.accountLimit(provider, entry.index, options) === undefined;
			});

		if (credentials.length === 0) return undefined;
		if (credentials.length === 1) return credentials[0];

		const providerKey = providerTypeKey(provider, "api_key");
		const order = this.#getCredentialOrder(providerKey, sessionId, credentials.length);
		const fallback = credentials[order[0]];
		const strategy = this.#deps.strategies(provider);
		if (!strategy) {
			for (const idx of order) {
				const candidate = credentials[idx];
				if (!this.#deps.blocks.isBlocked(provider, providerKey, candidate.index)) {
					return candidate;
				}
			}
			return fallback;
		}

		const rankingContext: CredentialRankingContext = {
			modelId: options?.modelId,
		};
		const blockScope = strategy.blockScope?.(rankingContext);
		const blockScopes = credentialBlockScopesForRequest(provider, strategy, rankingContext, blockScope);
		const candidates = await this.#rankApiKeySelections({
			providerKey,
			provider,
			order,
			credentials,
			options,
			strategy,
			rankingContext,
			blockScope,
			blockScopes,
		});
		return candidates[0]?.selection ?? fallback;
	}

	async #rankOAuthSelections(args: {
		providerKey: string;
		provider: string;
		order: number[];
		planGate: PlanGate | undefined;
		credentials: OAuthSelection[];
		options?: AuthApiKeyOptions;
		strategy?: CredentialRankingStrategy;
		defaultReservePct?: number;
		drain?: DrainTarget;
		rankingContext: CredentialRankingContext;
		blockScope?: string;
		/** Scopes a block may live under for this request; reads honour all of them. */
		blockScopes?: readonly string[];
	}): Promise<OAuthCandidate[]> {
		const nowMs = Date.now();
		const { strategy } = args;
		const ranked: RankedOAuthCandidate[] = [];
		// Pre-fetch usage reports in parallel for non-blocked credentials.
		// Wrap with a timeout so slow/429'd fetches don't indefinitely block
		// credential selection — better to pick a credential without usage data
		// than to hang the agent waiting for rate-limited usage endpoints.
		const usageTimeout = Math.max(5000, this.#deps.usage.requestTimeoutMs * 1.5);
		const usagePromise = Promise.all(
			args.order.map(async idx => {
				const selection = args.credentials[idx];
				if (!selection) return null;
				let blockedUntil = this.#deps.blocks.blockedUntil(
					args.provider,
					args.providerKey,
					selection.index,
					args.blockScopes ?? args.blockScope,
				);
				let usage: UsageReport | null = null;
				let usageChecked = false;
				if (
					blockedUntil !== undefined &&
					this.#deps.blocks.canHeal(
						args.provider,
						args.providerKey,
						selection.index,
						args.blockScopes ?? args.blockScope,
					)
				) {
					usage = await this.#deps.usage.report(args.provider, selection.credential, {
						...args.options,
						timeoutMs: this.#deps.usage.requestTimeoutMs,
					});
					usageChecked = true;
					blockedUntil = this.#deps.blocks.blockedUntil(
						args.provider,
						args.providerKey,
						selection.index,
						args.blockScopes ?? args.blockScope,
					);
				}
				if (blockedUntil !== undefined) return { selection, usage, usageChecked, blockedUntil };
				if (!usageChecked) {
					usage = await this.#deps.usage.report(args.provider, selection.credential, {
						...args.options,
						timeoutMs: this.#deps.usage.requestTimeoutMs,
					});
					usageChecked = true;
				}
				return {
					selection,
					usage,
					usageChecked,
					blockedUntil: undefined as number | undefined,
				};
			}),
		);
		const timeoutSignal = Promise.withResolvers<null>();
		// `Bun.sleep` keeps the event loop alive even after Promise.race resolves,
		// which leaks a 7.5–15s timer per credential-selection call. Use an unref'd
		// timer so the timeout doesn't pin the process and clear it on the happy
		// path so memory drops immediately.
		const timer = setTimeout(() => timeoutSignal.resolve(null), usageTimeout);
		timer.unref?.();
		const usageResults = await Promise.race([usagePromise, timeoutSignal.promise]).then(result => {
			clearTimeout(timer);
			return (
				result ??
				args.order.map(idx => {
					const selection = args.credentials[idx];
					return selection
						? {
								selection,
								usage: null,
								usageChecked: false,
								blockedUntil: undefined,
							}
						: null;
				})
			);
		});

		for (let orderPos = 0; orderPos < usageResults.length; orderPos += 1) {
			const result = usageResults[orderPos];
			if (!result) continue;
			const { selection, usage, usageChecked } = result;
			let { blockedUntil } = result;
			let blocked = blockedUntil !== undefined;
			const isDrainTarget = args.drain?.index === selection.index;
			const billing = isDrainTarget && args.drain ? this.#drainBilling(args.provider, args.drain, usage) : undefined;
			// The plan exhaustion an opted-in spend class still pays for is not a block; stored blocks (429s) still are.
			const fundedOverage =
				args.drain?.spend.some(
					spendClass => spendClass !== "plan" && classAvailable(billing?.snapshot, spendClass),
				) ?? false;
			const scopedLimits = usage && strategy ? scopedUsageLimits(strategy, usage, args.rankingContext) : undefined;
			if (!blocked && !fundedOverage && scopedLimits && isUsageLimitReached(scopedLimits)) {
				const resetAtMs = usageResetAtMs(scopedLimits, nowMs);
				blockedUntil = resetAtMs ?? Date.now() + DEFAULT_BLOCK_MS;
				this.#deps.blocks.mark(
					args.provider,
					args.providerKey,
					selection.index,
					blockedUntil,
					args.blockScope,
					resetAtMs !== undefined,
				);
				blocked = true;
			}
			const windows = usage && strategy ? strategy.findWindowLimits(usage, args.rankingContext) : undefined;
			const primary = windows?.primary;
			const secondary = windows?.secondary;
			const remainingFraction = remainingUsageFraction(strategy, usage, args.rankingContext, nowMs);
			const usageMeasured =
				strategy === undefined ? remainingFraction !== undefined : primary !== undefined || secondary !== undefined;
			const primaryUncapped = primary === undefined && secondary !== undefined;
			const policy = this.#deps.policies.forCredential(args.provider, selection.credential);
			let drainTarget = false;
			if (isDrainTarget && args.drain) {
				drainTarget = this.#drainServing(
					args.drain,
					args.blockScope,
					this.#usageBlocked(
						args.provider,
						args.providerKey,
						selection.index,
						args.blockScopes ?? (args.blockScope ? [args.blockScope] : []),
					) ||
						(remainingFraction === 0 && !fundedOverage),
					remainingFraction,
					nowMs,
					billing,
				);
			}
			const reservePct = drainTarget ? undefined : (policy?.reservePct ?? args.defaultReservePct);
			const reserveFraction =
				reservePct === undefined || !Number.isFinite(reservePct)
					? undefined
					: Math.max(0, Math.min(1, reservePct / 100));
			ranked.push({
				selection,
				usage,
				usageChecked,
				blocked,
				blockedUntil,
				inReserve:
					reserveFraction !== undefined && remainingFraction !== undefined && remainingFraction <= reserveFraction,
				reserveMeasured: reserveFraction !== undefined && remainingFraction !== undefined,
				accountPriority: policy?.priority === undefined || !Number.isFinite(policy.priority) ? 0 : policy.priority,
				drainTarget,
				...(fundedOverage ? { fundedOverage } : {}),
				allowanceSpent: remainingFraction === 0,
				usageMeasured,
				hasPriorityBoost: strategy?.hasPriorityBoost?.(primary, primaryUncapped, args.rankingContext) ?? false,
				planPriority: planPriority(args.planGate, usage),
				secondaryUsed: strategy ? normalizeUsageFraction(secondary) : 0,
				secondaryRequiredDrain:
					strategy === undefined ? 0 : windowRequiredDrain(secondary, nowMs, strategy.windowDefaults.secondaryMs),
				primaryUsed: strategy ? normalizeUsageFraction(primary) : 0,
				primaryRequiredDrain:
					strategy === undefined ? 0 : windowRequiredDrain(primary, nowMs, strategy.windowDefaults.primaryMs),
				orderPos,
			});
		}
		return orderUsageRankedCandidates(ranked, args.planGate !== undefined);
	}

	/** The OAuth account `sessionId` drains first for `provider`: the session override, else the account policy. */
	#drainTarget(provider: string, sessionId: string | undefined, modelId: string | undefined): DrainTarget | undefined {
		const override = this.#deps.affinity.drainOverride(provider, sessionId);
		if (override === null) return undefined;
		const entries = this.#deps.pool.entries(provider);
		const routing = this.#deps.affinity.accountRouting(provider, sessionId, modelId);
		let index = override === undefined ? -1 : entries.findIndex(entry => entry.id === override);
		let policy: AuthAccountPolicy | undefined;
		const overridden = entries[index]?.credential;
		if (overridden?.type === "oauth") {
			policy = this.#deps.policies.forCredential(provider, overridden);
		} else {
			// An override whose account is gone falls back to the pool's drain target, then the account policy.
			if (override !== undefined && sessionId) this.#deps.affinity.drain(provider, sessionId, undefined);
			const named =
				routing?.drain === undefined ? undefined : this.#deps.affinity.namedAccount(provider, routing.drain);
			if (named?.credential.type === "oauth") {
				index = named.index;
				policy = this.#deps.policies.forCredential(provider, named.credential);
			} else {
				const found = this.#deps.policies.drainTarget(
					provider,
					entries.map(entry => entry.credential),
				);
				if (!found) return undefined;
				({ index, policy } = found);
			}
		}
		const policyFunding = policy?.drain ? policy : undefined;
		return {
			index,
			credentialId: entries[index]!.id,
			returnFraction: (policy?.returnMargin ?? DEFAULT_DRAIN_RETURN_MARGIN_PCT) / 100,
			cooldownMs: policy?.returnCooldownMs ?? DEFAULT_DRAIN_RETURN_COOLDOWN_MS,
			provider,
			spend: routing?.spend ?? policyFunding?.spend ?? [],
			returnWhen: routing?.returnWhen ?? (policyFunding?.returnWhen ? [policyFunding.returnWhen].flat() : ["reset"]),
		};
	}

	/**
	 * Billing evidence of the drain target's usage `report`, read only when it
	 * may spend credits or money (which every billing return trigger requires);
	 * `undefined` when it may not. Warns once per provider without a billing reader.
	 */
	#drainBilling(provider: string, target: DrainTarget, report: UsageReport | null): DrainBilling | undefined {
		if (target.spend.every(spendClass => spendClass === "plan")) return undefined;
		if (!report) return { unavailable: "no-report" };
		const result = this.#deps.usage.billing(provider, report);
		if (result.status === "known") return { snapshot: result.snapshot };
		if (result.reason === "no-reader") {
			this.#warnOnce(
				`${provider}\0no-reader`,
				"Drain spend and return triggers need billing evidence this provider does not report; only plan and reset apply",
				{ provider },
			);
		}
		return { unavailable: result.reason };
	}

	#warnOnce(key: string, message: string, meta: Record<string, unknown>): void {
		if (this.#warnedNoBilling.has(key)) return;
		this.#warnedNoBilling.add(key);
		logger.warn(message, meta);
	}

	/**
	 * Whether the drain target serves first now. A drained target (any window
	 * exhausted, or plan allowance spent with no opted-in `spend` class
	 * available) stays behind its siblings until `cooldownMs` has passed since
	 * it drained and a `returnWhen` trigger holds: `reset` when, if measured, at
	 * least `returnFraction` of its quota is left again; `credits-added` or
	 * `money-available` against the billing evidence first seen after it drained.
	 * Until a listed trigger holds it stays behind; a billing trigger without
	 * evidence to compare is logged once per provider. The state persists in the
	 * store cache, so it survives a restart and a return in one process is seen
	 * by every process sharing the store.
	 */
	#drainServing(
		target: DrainTarget,
		blockScope: string | undefined,
		drained: boolean,
		remainingFraction: number | undefined,
		nowMs: number,
		billing: DrainBilling | undefined,
	): boolean {
		const snapshot = billing?.snapshot;
		// Pool and policy funding of one account drain and return independently.
		const funding = `${[...target.spend].sort().join(",")}/${[...target.returnWhen].sort().join(",")}`;
		const key = drainStateKey(target.provider, target.credentialId, blockScope, funding);
		let state = this.#loadDrainState(key);
		if (state !== undefined) {
			// A clock that stepped back restarts the cooldown instead of ending it early or never.
			const since = Math.min(state.since, nowMs);
			const baseline = state.baseline ?? snapshot;
			const cached = this.#drainedSince.get(key);
			// Rewrite an unsaved copy, and refresh the row well before it expires so a target
			// waiting for its trigger never returns by expiry; a missed row may be another process's return.
			const stale =
				cached !== undefined &&
				cached.misses === 0 &&
				(!cached.persisted ||
					cached.writtenAtMs === undefined ||
					nowMs - cached.writtenAtMs >= drainStateTtlMs(target.cooldownMs) / 4);
			if (since !== state.since || baseline !== state.baseline || stale) {
				state = { since, baseline };
				if (cached === undefined || cached.misses === 0) this.#saveDrainState(key, state, target.cooldownMs, nowMs);
				else cached.state = state;
			}
		}
		if (drained) {
			if (state === undefined)
				this.#saveDrainState(key, { since: nowMs, baseline: snapshot }, target.cooldownMs, nowMs);
			return false;
		}
		if (state === undefined) return true;
		if (nowMs - state.since < target.cooldownMs) return false;
		const { baseline } = state;
		if (!snapshot && target.returnWhen.some(trigger => trigger !== "reset")) {
			this.#warnOnce(
				`${target.provider}\0unevaluated`,
				"Drained account stays behind until a return trigger holds; billing evidence to evaluate it is missing",
				{ provider: target.provider, reason: billing?.unavailable ?? "no-report" },
			);
		}
		const returned = target.returnWhen.some(trigger => {
			switch (trigger) {
				case "reset":
					return remainingFraction === undefined || remainingFraction >= target.returnFraction;
				case "credits-added":
					return baseline !== undefined && snapshot !== undefined && creditsAdded(baseline, snapshot);
				case "money-available":
					return (
						baseline !== undefined &&
						snapshot !== undefined &&
						classSpent(baseline, "money") &&
						classAvailable(snapshot, "money")
					);
			}
		});
		if (!returned) return false;
		this.#drainedSince.delete(key);
		try {
			this.#deps.store.setCache(key, "", 0);
		} catch (err) {
			logger.debug("Failed to clear drain state from persistent store cache", { err });
		}
		return true;
	}

	/**
	 * The drain state under `key`: the stored row, else this process's copy. A
	 * copy the store once returned and then misses on {@link DRAIN_STATE_DROP_MISSES}
	 * consecutive reads was returned by another process or expired, so it is
	 * dropped; one never seen stored (the write failed) stays in effect.
	 */
	#loadDrainState(key: string): DrainedState | undefined {
		const cached = this.#drainedSince.get(key);
		let raw: string | null;
		try {
			raw = this.#deps.store.getCache(key);
		} catch (err) {
			logger.debug("Failed to read drain state from persistent store cache", { err });
			return cached?.state;
		}
		const stored = raw ? parseDrainedState(raw) : undefined;
		if (stored) {
			this.#drainedSince.set(key, {
				state: stored,
				persisted: true,
				misses: 0,
				writtenAtMs: cached?.writtenAtMs,
			});
			return stored;
		}
		if (cached?.persisted) {
			cached.misses += 1;
			if (cached.misses >= DRAIN_STATE_DROP_MISSES) {
				this.#drainedSince.delete(key);
				return undefined;
			}
		}
		return cached?.state;
	}

	/** Writes `state` under `key`, expiring {@link drainStateExpiresAtSec} after `nowMs`; `persisted` once read back intact. */
	#saveDrainState(key: string, state: DrainedState, cooldownMs: number, nowMs: number): void {
		const value = serializeDrainedState(state);
		let persisted = false;
		try {
			this.#deps.store.setCache(key, value, drainStateExpiresAtSec(nowMs, cooldownMs));
			persisted = this.#deps.store.getCache(key) === value;
		} catch (err) {
			logger.debug("Failed to write drain state to persistent store cache", { err });
		}
		this.#drainedSince.set(key, { state, persisted, misses: 0, writtenAtMs: nowMs });
	}

	/** Whether a usage-limit block (not an auth or policy block) holds the credential for this request. */
	#usageBlocked(provider: string, providerKey: string, index: number, blockScopes: readonly string[]): boolean {
		return (
			this.#deps.blocks.blockedUntil(provider, providerKey, index, blockScopes, { usageOnly: true }) !== undefined
		);
	}

	/**
	 * Resolves an OAuth credential, trying credentials in priority order.
	 *
	 * Resolution ladder — a request in hand always beats "no API key":
	 * 1. strict: unblocked credentials only, usage limits respected, plan
	 *    filter enforced (when any account is confirmed eligible);
	 * 2. plan-fitting last resort: same plan filter, but blocked/exhausted
	 *    accounts are allowed (blocked candidates rank earliest-unblocking
	 *    first) so the caller gets real usage-limit semantics from the wire
	 *    instead of a missing key;
	 * 3. unfiltered last resort: the plan filter matched nothing usable —
	 *    skip it and try every account once; the server is the final arbiter
	 *    of model access.
	 *
	 * Returns both the API key bytes for outbound requests AND the refreshed
	 * {@link OAuthCredential} so callers needing identity metadata (account id,
	 * project id, etc.) do not have to dereference the snapshot themselves.
	 */
	async resolveOAuth(
		provider: string,
		sessionId?: string,
		options?: AuthApiKeyOptions,
		memo?: AccountRefusals,
	): Promise<OAuthResolutionResult | undefined> {
		await this.#deps.pool.adoptExternalChanges();
		const stored = this.#deps.pool
			.credentials(provider)
			.map((credential, index) => ({ credential, index }))
			.filter((entry): entry is { credential: OAuthCredential; index: number } => entry.credential.type === "oauth");
		this.#deps.policies.validateFor(
			provider,
			stored.map(entry => entry.credential),
		);
		// A session restriction drops every other account before limits, ranking,
		// pins, and the fallback passes below, so none of them can route back to it
		// or spend a usage read on it.
		const allowed = stored.filter(entry => this.#deps.affinity.allows(provider, sessionId, entry.credential));
		// An account over a local limit is never selected, not even as a last resort.
		const refusals = await Promise.all(
			allowed.map(entry => this.accountRefusal(provider, entry.index, options, memo)),
		);
		const limited = new Set(allowed.filter((_entry, at) => refusals[at] !== undefined).map(entry => entry.index));
		const credentials = allowed.filter(entry => !limited.has(entry.index));
		const limitedDrain = this.#noteLimitedDrain(provider, sessionId, options?.modelId, limited);

		if (credentials.length === 0) return undefined;
		this.#deps.policies.validateUsageCapability(provider, this.#deps.usage.canFetchOAuthUsage(provider));

		const providerKey = providerTypeKey(provider, "oauth");
		const order = this.#getCredentialOrder(providerKey, sessionId, credentials.length);
		const strategy = this.#deps.strategies(provider);
		const rankingContext: CredentialRankingContext = {
			modelId: options?.modelId,
		};
		const blockScope = strategy?.blockScope?.(rankingContext);
		// Reads honour every scope that applies; the scalar above is for args that persist.
		const blockScopes = credentialBlockScopesForRequest(provider, strategy, rankingContext, blockScope);
		const planGate = strategy?.planGate?.(rankingContext);
		const hasPlanRequirement = planGate !== undefined;
		const accountIds = options?.accountIds?.length ? new Set(options.accountIds) : undefined;
		const enforceAccounts =
			accountIds !== undefined &&
			credentials.some(
				({ credential }) => credential.accountId !== undefined && accountIds.has(credential.accountId),
			);
		const hasAccountPolicy = credentials.some(
			({ credential }) => this.#deps.policies.forCredential(provider, credential) !== undefined,
		);
		const hasPriorityPolicy = credentials.some(
			({ credential }) => this.#deps.policies.forCredential(provider, credential)?.priority !== undefined,
		);
		const canFetchPolicyUsage = strategy !== undefined || this.#deps.usage.canFetchOAuthUsage(provider);
		const policyReserveEnabled = hasAccountPolicy && canFetchPolicyUsage;
		const checkUsage =
			(strategy !== undefined || policyReserveEnabled) && (credentials.length > 1 || hasPlanRequirement);
		const drain =
			credentials.length > 1 && !limitedDrain ? this.#drainTarget(provider, sessionId, options?.modelId) : undefined;
		const sessionCredential = this.#deps.affinity.get(provider, sessionId);
		const sessionPreferredIndex = sessionCredential?.type === "oauth" ? sessionCredential.index : undefined;
		const sessionPreferredCredential =
			sessionPreferredIndex !== undefined
				? credentials.find(entry => entry.index === sessionPreferredIndex)?.credential
				: undefined;
		const sessionPreferredCanRefreshOrUse =
			sessionPreferredCredential !== undefined &&
			(sessionPreferredCredential.refresh.trim().length > 0 ||
				Date.now() + OAUTH_REFRESH_SKEW_MS < sessionPreferredCredential.expires);
		// Skip ranking when the session already has a working preferred credential and its prompt
		// cache may still be warm. Providers without a verified idle boundary retain indefinite
		// stickiness rather than risk switching while their prompt cache remains warm. New sessions
		// (no preference), blocked pins, and sessions idle past the provider's sticky window still
		// rank. Legacy pins predating `lastUsedAtMs` count as warm until the next resolve rewrites the row.
		const sessionPreferredLastUsedAtMs =
			sessionCredential?.type === "oauth" ? sessionCredential.lastUsedAtMs : undefined;
		const sessionPreferredIsWarm =
			strategy?.stickyWarmMs === undefined ||
			sessionPreferredLastUsedAtMs === undefined ||
			Date.now() - sessionPreferredLastUsedAtMs < strategy.stickyWarmMs;
		const sessionPreferredIsAvailable =
			sessionPreferredIndex !== undefined &&
			sessionPreferredCanRefreshOrUse &&
			!this.#deps.blocks.isBlocked(provider, providerKey, sessionPreferredIndex, blockScopes);
		const sessionPinIsExplicit = sessionCredential?.type === "oauth" && sessionCredential.explicit === true;
		const rankDespitePin =
			!sessionPreferredIsAvailable ||
			!sessionPreferredIsWarm ||
			hasPlanRequirement ||
			drain !== undefined ||
			(policyReserveEnabled && !sessionPinIsExplicit);
		// A warm automatic pin whose allowance is spent keeps serving on paid overage
		// (Codex credits) and is never blocked, so check it and rank when spent: a
		// sibling with renewable allowance left must take over (#13889). tryOAuth
		// reads this same report for the pin, so it is handed on below.
		const sessionPreferredUsage =
			checkUsage && !rankDespitePin && !sessionPinIsExplicit && sessionPreferredCredential
				? await this.#deps.usage.report(provider, sessionPreferredCredential, {
						...options,
						timeoutMs: this.#deps.usage.requestTimeoutMs,
					})
				: undefined;
		const shouldRank =
			checkUsage &&
			(rankDespitePin ||
				(sessionPreferredUsage !== undefined &&
					remainingUsageFraction(strategy, sessionPreferredUsage, rankingContext, Date.now()) === 0));
		// When ranking, seed the pinned credential first in the evaluation order so it wins genuine
		// ties (the ranked comparator falls back to `orderPos`) without overriding a strictly-better
		// sibling — this respects the residual value of a same-account shared static prefix that other
		// workspace traffic may have kept warm, while still rotating away from a clearly-worse account.
		const baseRankingOrder = credentials.map((_credential, index) => index);
		const policyOrder = hasPriorityPolicy
			? [...baseRankingOrder].sort((leftIndex, rightIndex) => {
					const leftPriority =
						this.#deps.policies.forCredential(provider, credentials[leftIndex]!.credential)?.priority ?? 0;
					const rightPriority =
						this.#deps.policies.forCredential(provider, credentials[rightIndex]!.credential)?.priority ?? 0;
					return rightPriority - leftPriority || leftIndex - rightIndex;
				})
			: order;
		let rankingOrder = shouldRank && sessionId ? baseRankingOrder : policyOrder;
		const sessionPreferredRankingPos =
			shouldRank && sessionId && sessionPreferredIndex !== undefined && !hasPlanRequirement
				? credentials.findIndex(entry => entry.index === sessionPreferredIndex)
				: -1;
		if (sessionPreferredRankingPos > 0) {
			rankingOrder = [
				sessionPreferredRankingPos,
				...baseRankingOrder.filter(index => index !== sessionPreferredRankingPos),
			];
		}
		const candidates: OAuthCandidate[] = shouldRank
			? await this.#rankOAuthSelections({
					providerKey,
					provider,
					planGate,
					order: rankingOrder,
					credentials,
					options,
					strategy,
					defaultReservePct: policyReserveEnabled ? this.#deps.policies.defaultReservePct : undefined,
					drain,
					rankingContext,
					blockScope,
					blockScopes,
				})
			: policyOrder
					.map(idx => credentials[idx])
					.filter((selection): selection is { credential: OAuthCredential; index: number } => Boolean(selection))
					.map(selection =>
						selection.index === sessionPreferredIndex && sessionPreferredUsage !== undefined
							? { selection, usage: sessionPreferredUsage, usageChecked: true }
							: { selection, usage: null, usageChecked: false },
					);
		// Without usage ranking, only a block can drain the target.
		const drainIndex = shouldRank
			? candidates.find(candidate => candidate.drainTarget)?.selection.index
			: drain &&
				  this.#drainServing(
						drain,
						blockScope,
						this.#usageBlocked(provider, providerKey, drain.index, blockScopes),
						undefined,
						Date.now(),
						{ unavailable: "unranked" },
				  )
				? drain.index
				: undefined;
		if (!shouldRank && drainIndex !== undefined) {
			const drainPosition = candidates.findIndex(candidate => candidate.selection.index === drainIndex);
			if (drainPosition > 0) candidates.unshift(...candidates.splice(drainPosition, 1));
		}
		const preflightFailures = new Set<OAuthCandidate>();
		// The last retryable refresh error (network, timeout, 5xx) that removed a candidate.
		// When no candidate resolves, it is rethrown so callers retry instead of reporting
		// a missing key. Refresher outcomes after a dead grant (row disabled, CAS lost) are
		// classified auth failures and keep resolving to undefined.
		let transientRefreshFailure: unknown;
		const recordTransientRefreshFailure = (error: unknown): void => {
			if (AIError.retriable(AIError.classify(error))) transientRefreshFailure = error;
		};

		const sessionPreferredCandidate = candidates.findIndex(
			candidate =>
				!this.#deps.blocks.isBlocked(provider, providerKey, candidate.selection.index, blockScopes) &&
				candidate.selection.index === sessionPreferredIndex,
		);
		const preferredCandidate = sessionPreferredCandidate === -1 ? undefined : candidates[sessionPreferredCandidate];
		// A warm automatic pin normally wins. Two policies may evict it, each only
		// while a sibling is confirmed better: reserve (sibling measured outside
		// reserve) and spent allowance (unblocked sibling with allowance left).
		const automaticPinWouldBeEvicted = (excludePreflightFailures: boolean): boolean =>
			!sessionPinIsExplicit &&
			preferredCandidate !== undefined &&
			candidates.some(candidate => {
				if (candidate === preferredCandidate) return false;
				if (excludePreflightFailures && preflightFailures.has(candidate)) return false;
				if (candidate.selection.index === drainIndex) return true;
				if (
					preferredCandidate.inReserve === true &&
					candidate.reserveMeasured === true &&
					candidate.inReserve === false
				) {
					return true;
				}
				return (
					preferredCandidate.allowanceSpent === true &&
					candidate.usage !== null &&
					candidate.allowanceSpent === false &&
					!this.#deps.blocks.isBlocked(provider, providerKey, candidate.selection.index, blockScopes)
				);
			});
		const pinEvictedBeforePreflight = automaticPinWouldBeEvicted(false);
		if (
			!hasPlanRequirement &&
			sessionPreferredCandidate > 0 &&
			((!shouldRank && !pinEvictedBeforePreflight) ||
				sessionPinIsExplicit ||
				(sessionPreferredIsWarm && !pinEvictedBeforePreflight))
		) {
			const [preferred] = candidates.splice(sessionPreferredCandidate, 1);
			candidates.unshift(preferred);
		}
		// Step (b) of the auth-retry policy: when `forceRefresh` is set, re-mint
		// the session-preferred credential (or the first candidate when no
		// session preference exists yet) even if its cached token still looks
		// valid — a peer/broker may have rotated it out from under us.
		const forceRefreshIndex = options?.forceRefresh
			? (sessionPreferredIndex ?? candidates[0]?.selection.index)
			: undefined;
		// Each candidate's synchronous prefix below runs back to back inside `map`,
		// before any await, so one provider re-list serves every initial rebind.
		// Resyncs after an await (refresh, disable) re-read the store.
		let preflightRows: StoredAuthCredential[] | undefined;
		await Promise.all(
			candidates.map(async candidate => {
				const force = forceRefreshIndex !== undefined && candidate.selection.index === forceRefreshIndex;
				const initialCredentialId = this.#deps.pool.entries(provider)[candidate.selection.index]?.id;
				let syncedPeerCredential = false;
				if (initialCredentialId !== undefined) {
					const beforeSync = candidate.selection.credential;
					preflightRows ??= this.#reloadProviderRows(provider);
					if (!this.#rebindOAuthSelection(preflightRows, candidate.selection, initialCredentialId)) return;
					syncedPeerCredential = !authCredentialEquals(beforeSync, candidate.selection.credential);
				}
				const hasFreshAccess = Date.now() + OAUTH_REFRESH_SKEW_MS < candidate.selection.credential.expires;
				if ((!force || syncedPeerCredential) && hasFreshAccess) return;
				const latestCredential = this.#deps.pool.credentials(provider)[candidate.selection.index];
				if (
					!force &&
					latestCredential?.type === "oauth" &&
					Date.now() + OAUTH_REFRESH_SKEW_MS < latestCredential.expires
				) {
					candidate.selection.credential = latestCredential;
					return;
				}
				const credentialId = this.#deps.pool.entries(provider)[candidate.selection.index]?.id;
				try {
					// Hand the refresher a stale clone (expires:0) so its
					// not-yet-expired short-circuit doesn't suppress the forced
					// re-mint; an in-flight peer refresh is still awaited via the
					// per-credential single-flight.
					const refreshTarget = force
						? { ...candidate.selection.credential, expires: 0 }
						: candidate.selection.credential;
					const refreshedCredentials = await this.#deps.refresher.refresh(
						provider,
						refreshTarget,
						credentialId,
						options?.signal,
						force ? options?.refreshReason : undefined,
					);
					const beforeRefresh = candidate.selection.credential;
					const updated = mergeRefreshedCredential(beforeRefresh, refreshedCredentials);
					if (credentialId !== undefined && authCredentialEquals(beforeRefresh, updated)) {
						// The await may have allowed a peer to replace/remove this row or
						// compact its index. Rebind by id without writing the cached result.
						if (!this.#syncOAuthSelectionFromStore(provider, candidate.selection, credentialId)) {
							preflightFailures.add(candidate);
						}
						return;
					}
					candidate.selection.credential = updated;
					if (credentialId !== undefined) {
						const idx = this.#deps.pool.replaceById(provider, credentialId, updated);
						if (idx !== -1) candidate.selection.index = idx;
					} else {
						const rowId = this.#deps.pool.entries(provider)[candidate.selection.index]?.id;
						if (rowId !== undefined) this.#deps.pool.replaceById(provider, rowId, updated);
					}
				} catch (error) {
					// A failed preflight already exercised the provider refresh path.
					// Do not replay the same refresh token in the final candidate pass.
					const errorMsg = String(error);
					const isDefinitiveFailure = AIError.isDefinitiveOAuthFailure(errorMsg);
					logger.debug("OAuth preflight refresh failed", {
						provider,
						index: candidate.selection.index,
						error: errorMsg,
						isDefinitiveFailure,
					});
					if (isDefinitiveFailure) {
						// A dead grant discovered during preflight must be disabled here too —
						// the final candidate pass below skips every `preflightFailures` entry,
						// so if this branch only blocked the row (like the transient case), the
						// definitive failure would never reach `tryOAuth`'s own
						// disable logic and the row would be retried forever instead of torn down.
						const outcome = await this.#deps.refresher.disableDefinitiveFailure(
							provider,
							credentialId,
							candidate.selection.credential,
							candidate.selection.index,
							errorMsg,
						);
						if (
							outcome !== "disabled" &&
							credentialId !== undefined &&
							this.#syncOAuthSelectionFromStore(provider, candidate.selection, credentialId)
						) {
							// A peer rotated this row (or won the disable CAS) between our
							// snapshot and the refresh; the helper reloaded storage and the row
							// still exists, so it now holds a valid, freshly rotated credential.
							// Re-sync the candidate onto it and leave it eligible so the final
							// pass retries with the live token instead of stranding it (mirrors
							// tryOAuth's peer-rotated re-resolve). If the peer instead
							// deleted/disabled the row, the re-sync fails and we fall through to
							// preflightFailures — leaving a stale index could rebind the candidate
							// to a sibling account with the wrong prefetched usage/plan.
							return;
						}
					} else {
						recordTransientRefreshFailure(error);
						if (credentialId !== undefined) {
							const latestIndex = this.#deps.pool
								.entries(provider)
								.findIndex(entry => entry.id === credentialId);
							if (latestIndex !== -1) {
								this.#deps.blocks.mark(
									provider,
									providerKey,
									latestIndex,
									Date.now() + OAUTH_REFRESH_FAILURE_BACKOFF_MS,
									AUTH_BLOCK_SCOPE,
								);
							}
						}
					}
					preflightFailures.add(candidate);
				}
			}),
		);

		const pinEvictedAfterPreflight = automaticPinWouldBeEvicted(true);
		if (
			!hasPlanRequirement &&
			preferredCandidate !== undefined &&
			!preflightFailures.has(preferredCandidate) &&
			sessionPreferredIsWarm &&
			!sessionPinIsExplicit &&
			!pinEvictedAfterPreflight
		) {
			const preferredIndex = candidates.indexOf(preferredCandidate);
			if (preferredIndex > 0) {
				candidates.splice(preferredIndex, 1);
				candidates.unshift(preferredCandidate);
			}
		}

		// Enforce a tier only when at least one account is confirmed eligible. If
		// every report is unknown or ineligible, preserve trial/grandfathered access
		// by allowing the normal candidate fallback to attempt the request.
		const enforcePlanRequirement =
			hasPlanRequirement && candidates.some(candidate => planGate?.(candidate.usage) === true);

		// Plan-gated models rank on every resolve to re-verify account tiers,
		// so the drain-urgency order can flip between two eligible accounts as their
		// usage headroom shifts. Promote the session-preferred credential back to the
		// front while it is unblocked and still plan-eligible (or the requirement is
		// unenforced and the pin is not known-ineligible) so an active session never
		// silently migrates accounts mid-conversation; blocked, exhausted, or
		// known-ineligible pins still fall through to the ranked sibling.
		if (hasPlanRequirement && sessionPreferredCandidate > 0 && !pinEvictedAfterPreflight) {
			const preferred = candidates[sessionPreferredCandidate]!;
			const planEligibility = planGate?.(preferred.usage);
			if (planEligibility === true || (!enforcePlanRequirement && planEligibility !== false)) {
				candidates.splice(sessionPreferredCandidate, 1);
				candidates.unshift(preferred);
			}
		}

		const passes: Array<{
			allowBlocked: boolean;
			enforcePlanRequirement: boolean;
			enforceAccounts: boolean;
		}> = [
			{ allowBlocked: false, enforcePlanRequirement, enforceAccounts },
			{ allowBlocked: true, enforcePlanRequirement, enforceAccounts },
		];
		if (enforcePlanRequirement) passes.push({ allowBlocked: true, enforcePlanRequirement: false, enforceAccounts });
		if (enforceAccounts) passes.push({ allowBlocked: true, enforcePlanRequirement: false, enforceAccounts: false });

		for (const pass of passes) {
			for (const candidate of candidates) {
				if (preflightFailures.has(candidate)) continue;
				const candidateAccountId = candidate.selection.credential.accountId;
				if (pass.enforceAccounts && (candidateAccountId === undefined || !accountIds?.has(candidateAccountId)))
					continue;
				const resolved = await this.tryOAuth(provider, candidate.selection, providerKey, sessionId, options, {
					checkUsage,
					allowBlocked: pass.allowBlocked,
					prefetchedUsage: candidate.usage,
					usagePrechecked: candidate.usageChecked,
					planGate,
					enforcePlanRequirement: pass.enforcePlanRequirement,
					strategy,
					rankingContext,
					blockScope,
					blockScopes,
					onTransientRefreshFailure: recordTransientRefreshFailure,
					fundedOverage: candidate.fundedOverage,
				});
				if (resolved) return resolved;
			}
		}

		if (transientRefreshFailure !== undefined) {
			throw new AIError.OAuthRefreshUnavailableError(provider, transientRefreshFailure);
		}
		return undefined;
	}

	/**
	 * Resolve one stored OAuth credential and never a sibling.
	 *
	 * `exclusive` (a pin): local blocks, usage limits, and plan gates do not stop
	 * the request, so a blocked account reaches the provider and its own
	 * usage-limit error surfaces. Otherwise (a preference): a blocked, exhausted,
	 * or plan-ineligible account yields `undefined` so normal selection proceeds.
	 * An account the session's restriction does not allow yields `undefined`.
	 * `options.forceRefresh` re-mints this credential's token first.
	 *
	 * @throws AIError.OAuthRefreshUnavailableError when `exclusive` and a retryable refresh failure left the account unusable.
	 */
	async resolveOneOAuth(
		provider: string,
		index: number,
		sessionId: string | undefined,
		options: AuthApiKeyOptions | undefined,
		exclusive: boolean,
		memo?: AccountRefusals,
	): Promise<OAuthResolutionResult | undefined> {
		const credential = this.#deps.pool.credentials(provider)[index];
		if (credential?.type !== "oauth" || !this.#deps.affinity.allows(provider, sessionId, credential))
			return undefined;
		const refusal = await this.accountRefusal(provider, index, options, memo);
		if (refusal) {
			if (exclusive) {
				throw new AIError.AccountLimitError(
					provider,
					refusal,
					this.#deps.policies.forStored(provider, credential)?.name,
				);
			}
			return undefined;
		}
		const selection: OAuthSelection = { credential, index };
		if (options?.forceRefresh) {
			const credentialId = this.#deps.pool.entries(provider)[index]?.id;
			try {
				const refreshed = await this.#deps.refresher.refresh(
					provider,
					{ ...credential, expires: 0 },
					credentialId,
					options.signal,
					options.refreshReason,
				);
				const updated = mergeRefreshedCredential(credential, refreshed);
				selection.credential = updated;
				if (credentialId !== undefined) {
					const updatedIndex = this.#deps.pool.replaceById(provider, credentialId, updated);
					if (updatedIndex !== -1) selection.index = updatedIndex;
				}
			} catch (error) {
				// tryOAuth below reports a dead grant; a still-valid token keeps serving.
				logger.debug("Forced refresh of a single OAuth account failed", { provider, index, error: String(error) });
			}
		}
		const providerKey = providerTypeKey(provider, "oauth");
		const strategy = this.#deps.strategies(provider);
		const rankingContext: CredentialRankingContext = { modelId: options?.modelId };
		const blockScope = strategy?.blockScope?.(rankingContext);
		const blockScopes = credentialBlockScopesForRequest(provider, strategy, rankingContext, blockScope);
		let transientRefreshFailure: unknown;
		const resolved = await this.tryOAuth(provider, selection, providerKey, sessionId, options, {
			checkUsage: !exclusive && strategy !== undefined,
			allowBlocked: exclusive,
			...(exclusive ? { enforcePlanRequirement: false } : {}),
			strategy,
			rankingContext,
			blockScope,
			blockScopes,
			allowFallback: false,
			onTransientRefreshFailure: error => {
				if (AIError.retriable(AIError.classify(error))) transientRefreshFailure = error;
			},
		});
		// A pinned account has no sibling to fall back to, so a retryable refresh failure surfaces as retryable.
		if (!resolved && exclusive && transientRefreshFailure !== undefined) {
			throw new AIError.OAuthRefreshUnavailableError(provider, transientRefreshFailure);
		}
		return resolved;
	}

	/** Whether a stored credential is free of local blocks for a request to `options.modelId`. */
	isUnblocked(provider: string, type: AuthCredential["type"], index: number, options?: AuthApiKeyOptions): boolean {
		const strategy = this.#deps.strategies(provider);
		const rankingContext: CredentialRankingContext = { modelId: options?.modelId };
		const blockScope = strategy?.blockScope?.(rankingContext);
		const blockScopes = credentialBlockScopesForRequest(provider, strategy, rankingContext, blockScope);
		return !this.#deps.blocks.isBlocked(provider, providerTypeKey(provider, type), index, blockScopes);
	}

	#syncOAuthSelectionFromStore(
		provider: string,
		selection: { credential: OAuthCredential; index: number },
		credentialId: number,
	): boolean {
		return this.#rebindOAuthSelection(this.#reloadProviderRows(provider), selection, credentialId);
	}

	/** Re-list one provider's active rows and adopt them in the pool. */
	#reloadProviderRows(provider: string): StoredAuthCredential[] {
		const latestRows = this.#deps.store.listAuthCredentials(provider);
		this.#deps.pool.replace(
			provider,
			latestRows.map(row => ({ id: row.id, credential: row.credential })),
		);
		return latestRows;
	}

	/** Point `selection` at row `credentialId` in `latestRows`; false when it is gone or no longer OAuth. */
	#rebindOAuthSelection(
		latestRows: readonly StoredAuthCredential[],
		selection: { credential: OAuthCredential; index: number },
		credentialId: number,
	): boolean {
		const latestIndex = latestRows.findIndex(row => row.id === credentialId);
		if (latestIndex === -1) return false;
		const latest = latestRows[latestIndex];
		if (latest?.credential.type !== "oauth") return false;
		selection.index = latestIndex;
		selection.credential = latest.credential;
		return true;
	}

	async #prepareOAuthCredentialForRequest(
		provider: string,
		selection: { credential: OAuthCredential; index: number },
		options: AuthApiKeyOptions | undefined,
	): Promise<boolean> {
		const stored = this.#deps.pool.entries(provider);
		const selected = stored[selection.index];
		if (selected?.credential.type !== "oauth") return false;

		const prepare = this.#deps.store.prepareForRequest?.bind(this.#deps.store);
		if (prepare) {
			await prepare(selected.id, { signal: options?.signal });
		}
		return this.#syncOAuthSelectionFromStore(provider, selection, selected.id);
	}

	/** Attempts to use a single OAuth credential, checking usage and refreshing token. */
	async tryOAuth(
		provider: Provider,
		selection: OAuthSelection,
		providerKey: string,
		sessionId: string | undefined,
		options: AuthApiKeyOptions | undefined,
		usageOptions: TryOAuthOptions,
	): Promise<OAuthResolutionResult | undefined> {
		const {
			checkUsage,
			allowBlocked,
			prefetchedUsage = null,
			usagePrechecked = false,
			planGate: providedPlanGate,
			enforcePlanRequirement,
			strategy,
			rankingContext,
			blockScope,
			blockScopes,
			allowFallback = true,
			fundedOverage = false,
		} = usageOptions;
		if (
			!allowBlocked &&
			this.#deps.blocks.isBlocked(provider, providerKey, selection.index, blockScopes ?? blockScope)
		) {
			return undefined;
		}

		if (!(await this.#prepareOAuthCredentialForRequest(provider, selection, options))) {
			return undefined;
		}
		// Capture the row id once, immediately after #prepareOAuthCredentialForRequest
		// resynced selection.index from the store. A concurrent disable during the
		// usage/refresh awaits below can shift positional indices, so every later
		// refresh / persist / CAS-disable addresses the row by this stable id.
		const credentialId = this.#deps.pool.entries(provider)[selection.index]?.id;

		const planGate = providedPlanGate ?? this.#deps.strategies(provider)?.planGate?.({ modelId: options?.modelId });
		const hasPlanRequirement = planGate !== undefined;
		const applyPlanFilter = enforcePlanRequirement ?? hasPlanRequirement;
		let usage: UsageReport | null = null;
		let usageChecked = false;

		if ((checkUsage && !allowBlocked) || hasPlanRequirement) {
			if (usagePrechecked) {
				usage = prefetchedUsage;
				usageChecked = true;
			} else {
				usage = await this.#deps.usage.report(provider, selection.credential, {
					...options,
					timeoutMs: this.#deps.usage.requestTimeoutMs,
				});
				usageChecked = true;
			}
			if (applyPlanFilter && planGate?.(usage) !== true) {
				return undefined;
			}
			if (checkUsage && !allowBlocked && !fundedOverage && usage && strategy && rankingContext) {
				const scopedLimits = scopedUsageLimits(strategy, usage, rankingContext);
				if (isUsageLimitReached(scopedLimits)) {
					const resetAtMs = usageResetAtMs(scopedLimits, Date.now());
					this.#deps.blocks.mark(
						provider,
						providerKey,
						selection.index,
						resetAtMs ?? Date.now() + DEFAULT_BLOCK_MS,
						blockScope,
						resetAtMs !== undefined,
					);
					return undefined;
				}
			}
		}

		try {
			let result: { newCredentials: OAuthCredentials; apiKey: string } | null;
			const customProvider = getOAuthProvider(provider);
			if (customProvider) {
				const refreshedCredentials = await this.#deps.refresher.refresh(
					provider,
					selection.credential,
					credentialId,
					options?.signal,
				);
				const apiKey = customProvider.getApiKey
					? customProvider.getApiKey(refreshedCredentials)
					: refreshedCredentials.access;
				result = { newCredentials: refreshedCredentials, apiKey };
			} else {
				// Refresh first through the broker-aware single-flighted machinery
				// so transient failures surface as network errors (5-min temp block)
				// instead of `getOAuthApiKey`'s "expired" precondition error, which
				// the definitive-failure regex below would otherwise classify as
				// auth failure and soft-disable a still-valid credential.
				const refreshedCredentials = await this.#deps.refresher.refresh(
					provider,
					selection.credential,
					credentialId,
					options?.signal,
				);
				const oauthCreds: Record<string, OAuthCredentials> = {
					[provider]: refreshedCredentials,
				};
				result = await getOAuthApiKey(provider as OAuthProvider, oauthCreds);
			}
			if (!result) return undefined;
			const updated = mergeRefreshedCredential(selection.credential, result.newCredentials);
			if (credentialId !== undefined) {
				const idx = this.#deps.pool.replaceById(provider, credentialId, updated);
				if (idx !== -1) selection.index = idx;
			} else {
				const rowId = this.#deps.pool.entries(provider)[selection.index]?.id;
				if (rowId !== undefined) this.#deps.pool.replaceById(provider, rowId, updated);
			}
			if ((checkUsage && !allowBlocked) || hasPlanRequirement) {
				const sameAccount = selection.credential.accountId === updated.accountId;
				if (!usageChecked || !sameAccount) {
					usage = await this.#deps.usage.report(provider, updated, {
						...options,
						timeoutMs: this.#deps.usage.requestTimeoutMs,
					});
					usageChecked = true;
				}
				if (applyPlanFilter && planGate?.(usage) !== true) {
					return undefined;
				}
				if (checkUsage && !allowBlocked && !fundedOverage && usage && strategy && rankingContext) {
					const scopedLimits = scopedUsageLimits(strategy, usage, rankingContext);
					if (isUsageLimitReached(scopedLimits)) {
						const resetAtMs = usageResetAtMs(scopedLimits, Date.now());
						this.#deps.blocks.mark(
							provider,
							providerKey,
							selection.index,
							resetAtMs ?? Date.now() + DEFAULT_BLOCK_MS,
							blockScope,
							resetAtMs !== undefined,
						);
						return undefined;
					}
				}
			}
			this.#deps.pool.noteBearer(provider, result.apiKey, credentialId);
			if (options?.recordAffinity !== false) {
				this.#deps.affinity.record(provider, sessionId, "oauth", selection.index);
			}
			return { apiKey: result.apiKey, credential: updated, credentialId };
		} catch (error) {
			const errorMsg = String(error);
			// Only remove credentials for definitive auth failures
			// Keep credentials for transient errors (network, 5xx) and block temporarily
			const isDefinitiveFailure = AIError.isDefinitiveOAuthFailure(errorMsg);

			logger.warn("OAuth token refresh failed", {
				provider,
				index: selection.index,
				error: errorMsg,
				isDefinitiveFailure,
			});

			if (isDefinitiveFailure) {
				const outcome = await this.#deps.refresher.disableDefinitiveFailure(
					provider,
					credentialId,
					selection.credential,
					selection.index,
					errorMsg,
				);
				if (outcome === "peer-rotated") {
					if (allowFallback) return this.resolveOAuth(provider, sessionId, options);
					return undefined;
				}
				if (outcome === "cas-lost") return undefined;
				if (this.#deps.pool.credentials(provider).some(credential => credential.type === "oauth")) {
					if (allowFallback) return this.resolveOAuth(provider, sessionId, options);
				}
			} else {
				usageOptions.onTransientRefreshFailure?.(error);
				// Block temporarily for transient failures (5 minutes)
				this.#deps.blocks.mark(
					provider,
					providerKey,
					selection.index,
					Date.now() + OAUTH_REFRESH_FAILURE_BACKOFF_MS,
					AUTH_BLOCK_SCOPE,
				);
			}
		}

		return undefined;
	}
}
