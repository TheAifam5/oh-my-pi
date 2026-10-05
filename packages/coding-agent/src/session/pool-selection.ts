import type { Model, ModelUsageHealth, UsageReport } from "@oh-my-pi/pi-ai";
import { logger, untilAborted } from "@oh-my-pi/pi-utils";
import type { BillingClass } from "../config/model-groups";
import type { ModelRegistry } from "../config/model-registry";
import {
	formatModelStringWithRouting,
	type ResolvedModelRoleValue,
	resolveConfiguredModelPatterns,
	resolveExplicitModelRole,
	resolveModelRoleValue,
	splitRoleAliasThinkingSuffix,
} from "../config/model-resolver";
import type { Settings } from "../config/settings";
import { sanitizeNoticeLine } from "../utils/notice-text";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import {
	getRetryFallbackRoundRobinPosition,
	orderRetryFallbackCandidates,
	parseRetryFallbackSelector,
	recordRetryFallbackRoundRobinPosition,
	type RetryFallbackHealthLookups,
	type RetryFallbackSelector,
	type RetryFallbackStrategy,
	retryFallbackQuotaEvidence,
} from "./retry-fallback-chains";
import {
	DEFAULT_GROUP_OBSERVATION_MAX_AGE_MS,
	describeFundingSkip,
	type FundingSkipReason,
	fundingVerdict,
	type GroupFallbackChain,
	ledgerBudgetSpend,
	providerBillingResults,
	resolveRolePoolGroup,
} from "./retry-fallback-groups";
import { cfgRetryUsageReservePct } from "./settings";
import { evaluateLimits, hasLocalLimits, limitTargets } from "./local-limits";

/**
 * Longest the `quota` strategy waits for usage health before keeping configured order, and the
 * longest a funding filter waits for usage reports before treating billing as unavailable.
 */
export const QUOTA_ORDERING_DEADLINE_MS = 1_500;

/** Which consumer a selection serves; it names the consumer in logs and notices. */
export type PoolSelectionPurpose = "retry-fallback" | "model-role";

const PURPOSE_SUBJECT: Record<PoolSelectionPurpose, string> = {
	"retry-fallback": "Retry fallback",
	"model-role": "Model role pool",
};

const QUOTA_ORDERING_SUBJECT: Record<PoolSelectionPurpose, string> = {
	"retry-fallback": "Quota fallback ordering",
	"model-role": "Model role pool quota ordering",
};

/** Capabilities a {@link PoolSelection} borrows from its owner. */
export interface PoolSelectionHost {
	settings: Settings;
	modelRegistry: Pick<ModelRegistry, "authStorage" | "hasConfiguredAuth" | "isSelectorSuppressed">;
	/** Session that usage-health lookups are attributed to; `undefined` before a session exists. */
	sessionId(): string | undefined;
	/** Delivers a user-facing warning notice for `purpose`. */
	emitNotice(message: string, purpose: PoolSelectionPurpose): Promise<void>;
	/** Current epoch ms; read at each use. Default `Date.now`. */
	now?(): number;
	/** Uniform source in [0, 1) for `random` and `weighted-random`; read at each use. Default `Math.random`. */
	random?(): number;
	/** Usage reports funding filters read; default `modelRegistry.authStorage.usage.reports`. */
	usageReports?(options: { signal: AbortSignal }): Promise<UsageReport[] | null>;
}

/** Inputs of one {@link PoolSelection.order} call. */
export interface PoolOrderOptions {
	purpose: PoolSelectionPurpose;
	/** Model a candidate resolves to; candidates resolving to none are not probed for quota. */
	resolveCandidate(selector: RetryFallbackSelector): Model | undefined;
	/** Full list whose positions `round-robin` reads and records. Read only by `round-robin`. */
	chain(): readonly RetryFallbackSelector[];
	/** Whether a walk is under way; `round-robin` then keeps the given order. */
	walkActive: boolean;
	signal?: AbortSignal;
	lookups?: RetryFallbackHealthLookups;
}

/** A candidate a funding policy left out, and why. */
export interface FundingSkip {
	selector: string;
	reason: FundingSkipReason;
}

/** Outcome of {@link PoolSelection.filterFunding}. */
export interface FundingFilterResult {
	/** Authorized candidates in funding-stage order, given order within a stage. */
	funded: RetryFallbackSelector[];
	/** Candidates left out, in given order; cooled-down candidates only with `includeSuppressed`. */
	skipped: FundingSkip[];
	/** Notice text naming `skipped`, when any were skipped. */
	notice?: string;
	/** Whether the caller's signal aborted; `funded` is then empty. */
	aborted: boolean;
}

/**
 * Orders and funding-filters the members of a model group by its strategy and routing policy.
 * Shared by retry fallback and model-role pools; holds only the per-owner notice dedupe.
 */
export class PoolSelection {
	readonly #host: PoolSelectionHost;
	/** Last funding-skip notice per purpose and key, so a repeated ordering does not repeat it. */
	#fundingSkipNotices = new Map<string, string>();

	constructor(host: PoolSelectionHost) {
		this.#host = host;
	}

	#now(): number {
		return this.#host.now?.() ?? Date.now();
	}

	/** Ordering of a walk governed by `policy`: its group strategy, `priority` without a group. */
	strategy(policy: GroupFallbackChain | undefined): RetryFallbackStrategy {
		return policy ? policy.group.strategy.name : "priority";
	}

	/**
	 * `candidates` ordered by `strategy`.
	 *
	 * `round-robin` starts a new walk (`walkActive` false) after the entry last recorded for
	 * `options.chain()`; a walk under way keeps the given order. `random` and `weighted-random` draw a
	 * fresh order per call, `weighted-random` by each member's `weight`. `quota` reads usage health
	 * for each unsuppressed candidate with configured auth, concurrently, sharing one lookup per
	 * routed model through `lookups`, and ages evidence by the group's
	 * `routing.quota.maxObservationAgeMs`. When the lookups outlast {@link QUOTA_ORDERING_DEADLINE_MS}
	 * or `signal` aborts, the candidates keep given order (none remain under
	 * `routing.quota.unknown: exclude`) and `health` is empty. Otherwise `health` holds the answered
	 * lookups keyed by selector; a failed lookup leaves no entry.
	 */
	async order(
		label: string,
		candidates: RetryFallbackSelector[],
		strategy: RetryFallbackStrategy,
		policy: GroupFallbackChain | undefined,
		options: PoolOrderOptions,
	): Promise<{ candidates: RetryFallbackSelector[]; health: Map<string, ModelUsageHealth> }> {
		const quotaPolicy = policy?.group.routing?.quota;
		const excludeUnknown = strategy === "quota" && quotaPolicy?.unknown === "exclude";
		if (strategy === "priority" || (candidates.length <= 1 && !excludeUnknown)) {
			return { candidates, health: new Map() };
		}
		const nowMs = this.#now();
		const maxAgeMs = quotaPolicy?.maxObservationAgeMs ?? DEFAULT_GROUP_OBSERVATION_MAX_AGE_MS;
		const host = this.#host;
		const random = host.random ? () => host.random?.() ?? Math.random() : undefined;
		if (strategy === "random" || strategy === "weighted-random") {
			const members = new Map(policy?.members.map(entry => [entry.selector.trim(), entry.member]));
			return {
				candidates: orderRetryFallbackCandidates(candidates, strategy, {
					nowMs,
					maxAgeMs,
					random,
					weight: candidate => {
						const member = members.get(candidate.raw);
						return member?.kind === "model" ? member.weight : undefined;
					},
				}),
				health: new Map(),
			};
		}
		if (strategy === "round-robin") {
			const chain = options.chain();
			const positions = new Map(chain.map((selector, index) => [selector.raw, index]));
			return {
				candidates: orderRetryFallbackCandidates(candidates, strategy, {
					nowMs,
					maxAgeMs,
					chainPosition: candidate => positions.get(candidate.raw),
					chainLength: chain.length,
					lastAppliedPosition: options.walkActive ? undefined : getRetryFallbackRoundRobinPosition(chain),
				}),
				health: new Map(),
			};
		}
		const subject = QUOTA_ORDERING_SUBJECT[options.purpose];
		const deadline = AbortSignal.timeout(QUOTA_ORDERING_DEADLINE_MS);
		const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
		const lookups = options.lookups ?? new Map<string, Promise<ModelUsageHealth | undefined>>();
		const reserveFraction = quotaPolicy?.reserveFraction ?? cfgRetryUsageReservePct.get(this.#host.settings) / 100;
		const health = new Map<string, ModelUsageHealth>();
		const pending: Promise<void>[] = [];
		for (const candidate of candidates) {
			if (this.#host.modelRegistry.isSelectorSuppressed(candidate.raw)) continue;
			const model = options.resolveCandidate(candidate);
			if (!model || !this.#host.modelRegistry.hasConfiguredAuth(model)) continue;
			// The reserve share decides the answer, so lookups under different groups' reserves stay apart.
			const key = `${formatModelStringWithRouting(model)} ${model.baseUrl ?? ""} ${reserveFraction}`;
			let lookup = lookups.get(key);
			if (!lookup) {
				const started: Promise<ModelUsageHealth | undefined> = this.#host.modelRegistry.authStorage.health
					.model(model.provider, {
						modelId: model.id,
						sessionId: this.#host.sessionId(),
						baseUrl: model.baseUrl,
						reserveFraction,
						signal,
					})
					.catch((error: unknown) => {
						// A failed or aborted lookup is not an answer; a later ordering in the walk retries it.
						if (lookups.get(key) === started) lookups.delete(key);
						logger.debug(`${subject} could not read usage health`, {
							selector: candidate.raw,
							error: String(error),
						});
						return undefined;
					});
				lookup = started;
				lookups.set(key, lookup);
			}
			pending.push(
				lookup.then(result => {
					if (result) health.set(candidate.raw, result);
				}),
			);
		}
		try {
			await untilAborted(signal, Promise.all(pending));
		} catch {
			logger.debug(`${subject} kept configured order`, {
				role: label,
				reason: options.signal?.aborted ? "aborted" : "deadline",
				deadlineMs: QUOTA_ORDERING_DEADLINE_MS,
			});
			return { candidates: excludeUnknown ? [] : candidates, health: new Map() };
		}
		return {
			candidates: orderRetryFallbackCandidates(candidates, strategy, {
				evidence: candidate => retryFallbackQuotaEvidence(health.get(candidate.raw), nowMs),
				nowMs,
				maxAgeMs,
				excludeUnknown,
			}),
			health,
		};
	}

	/**
	 * Candidates of `policy`'s group that their provider's billing evidence authorizes
	 * ({@link fundingVerdict}), in funding-stage order and given order within a stage. Usage reports
	 * are read once per call, bounded by {@link QUOTA_ORDERING_DEADLINE_MS}; reports that do not
	 * arrive in time leave every candidate's billing unavailable, so none is authorized. Returns no
	 * candidates when `signal` aborts. Emits one notice naming the skipped candidates, unless it
	 * repeats the last one for `purpose` and `label`.
	 */
	async filterFunding(
		label: string,
		candidates: readonly RetryFallbackSelector[],
		policy: GroupFallbackChain,
		funding: readonly BillingClass[],
		options: {
			purpose: PoolSelectionPurpose;
			resolveCandidate(selector: RetryFallbackSelector): Model | undefined;
			signal?: AbortSignal;
			/** Also list cooled-down candidates in `skipped`; the notice still leaves them out. */
			includeSuppressed?: boolean;
		},
	): Promise<FundingFilterResult> {
		const { purpose, signal } = options;
		const subject = PURPOSE_SUBJECT[purpose];
		const routing = policy.group.routing;
		const deadline = AbortSignal.timeout(QUOTA_ORDERING_DEADLINE_MS);
		const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;
		let reports: UsageReport[] | undefined;
		try {
			reports =
				(await untilAborted(
					bounded,
					this.#host.usageReports?.({ signal: bounded }) ??
						this.#host.modelRegistry.authStorage.usage.reports({ signal: bounded }),
				)) ?? undefined;
		} catch (error) {
			if (signal?.aborted) return { funded: [], skipped: [], aborted: true };
			logger.debug(`${subject} funding filter could not read usage reports`, {
				role: label,
				reason: deadline.aborted ? "deadline" : String(error),
				deadlineMs: QUOTA_ORDERING_DEADLINE_MS,
			});
		}
		const nowMs = this.#now();
		const maxAgeMs = routing?.quota?.maxObservationAgeMs ?? DEFAULT_GROUP_OBSERVATION_MAX_AGE_MS;
		const budgetSpend = ledgerBudgetSpend(this.#host.settings.getStorage()?.spendLedger, nowMs);
		const funded: { candidate: RetryFallbackSelector; stage: number; index: number }[] = [];
		const skipped: FundingSkip[] = [];
		const noticed: FundingSkip[] = [];
		for (const [index, candidate] of candidates.entries()) {
			const provider = options.resolveCandidate(candidate)?.provider ?? candidate.provider;
			const verdict = fundingVerdict(
				funding,
				providerBillingResults(provider, reports, nowMs, maxAgeMs),
				routing?.spending,
				budgetSpend,
			);
			if (verdict.kind === "funded") {
				funded.push({ candidate, stage: verdict.stage, index });
			} else if (!this.#host.modelRegistry.isSelectorSuppressed(candidate.raw)) {
				noticed.push({ selector: candidate.raw, reason: verdict.reason });
				skipped.push({ selector: candidate.raw, reason: verdict.reason });
			} else if (options.includeSuppressed) {
				// A cooled-down candidate is skipped by the walk regardless, so it is not worth a notice.
				skipped.push({ selector: candidate.raw, reason: verdict.reason });
			}
		}
		const notice = await this.#noteFundingSkips(label, noticed, purpose);
		return {
			funded: funded.sort((a, b) => a.stage - b.stage || a.index - b.index).map(entry => entry.candidate),
			skipped,
			...(notice !== undefined ? { notice } : {}),
			aborted: false,
		};
	}

	/**
	 * Emits a warning notice naming funding-skipped candidates, unless it repeats the last one for
	 * `purpose` and `label`. Returns the notice text whenever any candidate was skipped.
	 */
	async #noteFundingSkips(
		label: string,
		skipped: readonly FundingSkip[],
		purpose: PoolSelectionPurpose,
	): Promise<string | undefined> {
		const dedupeKey = `${purpose}\n${label}`;
		if (skipped.length === 0) {
			this.#fundingSkipNotices.delete(dedupeKey);
			return undefined;
		}
		const subject = PURPOSE_SUBJECT[purpose];
		const listed = skipped.map(entry => `${entry.selector} (${describeFundingSkip(entry.reason)})`).join(", ");
		// Selectors and chain keys are configured text, so they are flattened to one safe line.
		const message = sanitizeNoticeLine(`${subject} skipped ${listed} for ${label}`);
		if (this.#fundingSkipNotices.get(dedupeKey) === message) return message;
		this.#fundingSkipNotices.set(dedupeKey, message);
		logger.info(`${subject} skipped candidates for funding`, {
			role: label,
			skipped: skipped.map(entry => ({ selector: entry.selector, reason: entry.reason.kind })),
		});
		await this.#host.emitNotice(message, purpose);
		return message;
	}
}

// ----- model-role pools ------------------------------------------------------

/** Capabilities {@link resolveRolePool} needs. */
export interface RolePoolDeps extends PoolSelectionHost {
	modelRegistry: PoolSelectionHost["modelRegistry"] & Pick<ModelRegistry, "find">;
	/** Models a member may resolve to, already narrowed by `enabledModels` and disabled providers. */
	availableModels(): Model[];
	/** Whether `model` has usable credentials; default `modelRegistry.hasConfiguredAuth`. */
	hasUsableAuth?(model: Model): boolean | Promise<boolean>;
	/** Selection whose notice dedupe the pick shares; a fresh one when omitted. */
	selection?: PoolSelection;
}

/** Why {@link resolveRolePool} passed over a member. */
export type RolePoolSkipReason =
	| FundingSkipReason
	/** The member names no available model. */
	| { kind: "unavailable" }
	/** The member's model has no usable credentials. */
	| { kind: "no-auth" }
	/** The member is cooling down after a failure. */
	| { kind: "cooldown" }
	/** The `quota` strategy dropped the member under `routing.quota.unknown: exclude`. */
	| { kind: "quota-unknown" }
	/** A local limit on the member's model refuses another call (`limits`). */
	| { kind: "limit-reached"; limit: string }
	/** The usage counted by a local limit on the member's model could not be read. */
	| { kind: "limit-unreadable"; limit: string };

/** A member {@link resolveRolePool} passed over, and why. */
export interface RolePoolSkip {
	selector: string;
	reason: RolePoolSkipReason;
}

/** The member a pool role resolves to. */
export interface RolePoolPick {
	role: string;
	/** The member as configured, effort suffix included. */
	selector: RetryFallbackSelector;
	model: Model;
	thinkingLevel?: ConfiguredThinkingLevel;
	explicitThinkingLevel: boolean;
	/** Eligible members after the pick, in strategy and funding order. */
	rest: RetryFallbackSelector[];
	strategy: RetryFallbackStrategy;
	/** Every parsed member in configured order; the list round-robin positions refer to. */
	members: RetryFallbackSelector[];
}

/**
 * Outcome of {@link resolveRolePool} for a pool role: a pick, no eligible member (with why each
 * was passed over), or `aborted` when the caller's signal aborted before a pick.
 */
export type RolePoolResolution =
	| { kind: "picked"; pick: RolePoolPick; notice?: string }
	| { kind: "none"; role: string; skipped: RolePoolSkip[]; notice?: string }
	| { kind: "aborted"; role: string };

/**
 * Whether `reason` comes from the pool's own policy (its funding order, or a `quota` pool's
 * `routing.quota.unknown: exclude`) rather than availability, credentials, or cooldown.
 */
export function isPolicySkipReason(reason: RolePoolSkipReason): boolean {
	switch (reason.kind) {
		case "quota-unknown":
		case "unknown-evidence":
		case "exhausted":
		case "disabled":
		case "unauthorized":
		case "budget-exhausted":
		case "budget-unreadable":
		case "limit-reached":
		case "limit-unreadable":
			return true;
		default:
			return false;
	}
}

/**
 * Whether `skipped` holds a policy skip ({@link isPolicySkipReason}). Callers fail on such a pool
 * instead of falling back to its ordered member list, which would run a member the policy
 * excluded; a pool with no policy skip keeps the legacy resolution and its fallbacks.
 */
export function rolePoolPolicyBlocked(skipped: readonly RolePoolSkip[]): boolean {
	return skipped.some(entry => isPolicySkipReason(entry.reason));
}

/**
 * Guidance for a pool whose members were skipped for missing billing evidence, or `undefined` when
 * none was. It names the providers that have no billing reader, says when evidence was missing or
 * could not be read, and names `--model <provider/model>` as the way to choose a model directly.
 */
export function rolePoolEvidenceHint(skipped: readonly RolePoolSkip[]): string | undefined {
	const noReader = new Set<string>();
	let unread = false;
	for (const entry of skipped) {
		if (entry.reason.kind !== "unknown-evidence") continue;
		if (entry.reason.reason === "no-reader") {
			noReader.add(parseRetryFallbackSelector(entry.selector)?.provider ?? entry.selector);
		} else {
			unread = true;
		}
	}
	if (noReader.size === 0 && !unread) return undefined;
	const causes: string[] = [];
	if (unread)
		causes.push("Billing evidence was missing or could not be read (offline, usage reports unavailable, or stale)");
	if (noReader.size > 0) {
		causes.push(`${unread ? "no" : "No"} billing reader exists for ${[...noReader].join(", ")}`);
	}
	return `${causes.join("; ")}; start with --model <provider/model> to choose a model directly`;
}

/** Short user-facing description of a {@link RolePoolSkipReason}. */
export function describeRolePoolSkip(reason: RolePoolSkipReason): string {
	switch (reason.kind) {
		case "unavailable":
			return "model unavailable";
		case "no-auth":
			return "no credentials";
		case "cooldown":
			return "cooling down";
		case "quota-unknown":
			return "usage unknown";
		case "limit-reached":
			return `local limit reached (${reason.limit})`;
		case "limit-unreadable":
			return `local limit usage unreadable (${reason.limit})`;
		default:
			return describeFundingSkip(reason);
	}
}

/** No member of a pool role is eligible, and its funding or quota policy excluded at least one. */
export class RolePoolUnavailableError extends Error {
	readonly role: string;
	readonly skipped: readonly RolePoolSkip[];

	/** `hint`, when given, follows the skip list as guidance for the reader. */
	constructor(role: string, skipped: readonly RolePoolSkip[], hint?: string) {
		const listed =
			skipped.length > 0
				? skipped.map(entry => `${entry.selector} (${describeRolePoolSkip(entry.reason)})`).join(", ")
				: "no member names a model";
		const message = `No member of the model role pool "${role}" is eligible: ${listed}`;
		super(sanitizeNoticeLine(hint ? `${message}. ${hint}` : message));
		this.name = "RolePoolUnavailableError";
		this.role = role;
		this.skipped = skipped;
	}
}

/**
 * The member `role`'s pool resolves to, or `undefined` when `modelRoles.<role>` is not a pool (an
 * inline pool or a group reference), so the caller keeps resolving the legacy value as before.
 *
 * Members are ordered by the pool's strategy ({@link PoolSelection.order}; `round-robin` starts
 * after the member last recorded by {@link notePoolPickApplied} or retry fallback for the same
 * members). Members that resolve to no model exactly in `deps.availableModels()` or lack usable
 * credentials are passed over first; the rest are ordered, filtered by the pool's
 * `routing.funding` ({@link PoolSelection.filterFunding}, cooled-down members included), and the
 * first funded member that is not cooling down is picked with its effort. A member that does not parse as a `provider/model` selector is not a
 * candidate. Missing billing evidence never funds a member. Returns `aborted`, never rejects, when
 * `options.signal` aborts.
 */
export async function resolveRolePool(
	role: string,
	deps: RolePoolDeps,
	options: { signal?: AbortSignal } = {},
): Promise<RolePoolResolution | undefined> {
	const policy = resolveRolePoolGroup(deps.settings, role);
	if (!policy) return undefined;
	const { signal } = options;
	const aborted: RolePoolResolution = { kind: "aborted", role };
	if (signal?.aborted) return aborted;
	const selection = deps.selection ?? new PoolSelection(deps);
	const members: RetryFallbackSelector[] = [];
	const skipped: RolePoolSkip[] = [];
	for (const entry of policy.members) {
		const parsed = parseRetryFallbackSelector(entry.selector, deps.modelRegistry);
		if (!parsed) {
			skipped.push({ selector: entry.selector, reason: { kind: "unavailable" } });
			continue;
		}
		if (!members.some(member => member.raw === parsed.raw)) members.push(parsed);
	}
	const available = deps.availableModels();
	const resolved = new Map<string, ResolvedModelRoleValue>();
	const resolve = (selector: RetryFallbackSelector): ResolvedModelRoleValue => {
		let result = resolved.get(selector.raw);
		if (!result) {
			result = resolveModelRoleValue(selector.raw, available, { settings: deps.settings, exact: true });
			resolved.set(selector.raw, result);
		}
		return result;
	};
	// Members that cannot be called are passed over before any policy, so an install without
	// credentials never reads as a funding or quota exclusion.
	const hasUsableAuth = deps.hasUsableAuth ?? ((model: Model) => deps.modelRegistry.hasConfiguredAuth(model));
	const callable: RetryFallbackSelector[] = [];
	for (const member of members) {
		const model = resolve(member).model;
		if (!model) {
			skipped.push({ selector: member.raw, reason: { kind: "unavailable" } });
			continue;
		}
		let usable: boolean;
		try {
			usable = await hasUsableAuth(model);
		} catch (error) {
			logger.debug("Model role pool could not check member credentials", {
				selector: member.raw,
				error: String(error),
			});
			usable = false;
		}
		if (signal?.aborted) return aborted;
		if (!usable) {
			skipped.push({ selector: member.raw, reason: { kind: "no-auth" } });
			continue;
		}
		callable.push(member);
	}
	const isSuppressed = (selector: RetryFallbackSelector) => deps.modelRegistry.isSelectorSuppressed(selector.raw);
	const strategy = selection.strategy(policy);
	const ordered = await selection.order(role, callable, strategy, policy, {
		purpose: "model-role",
		resolveCandidate: selector => resolve(selector).model,
		chain: () => members,
		walkActive: false,
		signal,
	});
	if (signal?.aborted) return aborted;
	const funding = policy.group.routing?.funding;
	const kept = new Set(ordered.candidates.map(candidate => candidate.raw));
	// The quota ordering never probes a cooled-down member, so its exclusion is the cooldown's; with
	// funding configured the member is judged for funding below and passed over as cooling down after.
	const droppedCooledDown: RetryFallbackSelector[] = [];
	for (const member of callable) {
		if (kept.has(member.raw)) continue;
		if (!isSuppressed(member)) skipped.push({ selector: member.raw, reason: { kind: "quota-unknown" } });
		else if (funding) droppedCooledDown.push(member);
		else skipped.push({ selector: member.raw, reason: { kind: "cooldown" } });
	}
	let eligible = [...ordered.candidates, ...droppedCooledDown];
	let notice: string | undefined;
	if (funding && eligible.length > 0) {
		// Cooled-down members are judged too: a member the funding policy forbids counts as an exclusion.
		const filtered = await selection.filterFunding(role, eligible, policy, funding, {
			purpose: "model-role",
			resolveCandidate: selector => resolve(selector).model,
			signal,
			includeSuppressed: true,
		});
		if (filtered.aborted || signal?.aborted) return aborted;
		eligible = filtered.funded;
		skipped.push(...filtered.skipped);
		notice = filtered.notice;
	}
	if (hasLocalLimits(deps.settings)) {
		const ledger = deps.settings.getStorage()?.usageLedger;
		const nowMs = Date.now();
		eligible = eligible.filter(candidate => {
			const model = resolve(candidate).model;
			if (!model) return true;
			const [refusal] = evaluateLimits(ledger, limitTargets(deps.settings, model.provider, model.id), nowMs).refused;
			if (!refusal) return true;
			const kind = refusal.reason === "reached" ? "limit-reached" : "limit-unreadable";
			skipped.push({ selector: candidate.raw, reason: { kind, limit: refusal.target.label } });
			return false;
		});
	}
	for (const candidate of eligible.filter(isSuppressed)) {
		skipped.push({ selector: candidate.raw, reason: { kind: "cooldown" } });
	}
	eligible = eligible.filter(candidate => !isSuppressed(candidate));
	const [first, ...rest] = eligible;
	const match = first ? resolve(first) : undefined;
	if (first && match?.model) {
		const pick: RolePoolPick = {
			role,
			selector: first,
			model: match.model,
			explicitThinkingLevel: match.explicitThinkingLevel,
			rest,
			strategy,
			members,
		};
		if (match.thinkingLevel !== undefined) pick.thinkingLevel = match.thinkingLevel;
		return { kind: "picked", pick, ...(notice !== undefined ? { notice } : {}) };
	}
	logger.warn("Model role pool has no eligible member", {
		role,
		skipped: skipped.map(entry => ({ selector: entry.selector, reason: entry.reason.kind })),
	});
	return { kind: "none", role, skipped, ...(notice !== undefined ? { notice } : {}) };
}

/**
 * Records that `pick` was applied, advancing its pool's round-robin position; other strategies
 * ignore it. Retry fallback walking the same members reads and moves the same position.
 */
export function notePoolPickApplied(pick: RolePoolPick): void {
	if (pick.strategy === "round-robin") recordRetryFallbackRoundRobinPosition(pick.members, pick.selector);
}

/** The pool role a selection resolves through, and the effort a role-alias suffix asks for. */
export interface RolePoolTarget {
	role: string;
	/** Effort of a `:level` suffix on the alias; it replaces the picked member's effort. */
	thinkingLevel?: ConfiguredThinkingLevel;
}

/**
 * The pool role `selector` names as a whole: a role alias (`@role`, `pi/role`) of a pool role,
 * optionally with a `:level` suffix, whose expansion is that role's whole value. `undefined` for
 * anything else, including a comma list, a legacy role, and `@default:level`, which names the
 * session's model rather than the `default` role.
 */
export function rolePoolAliasTarget(selector: string, settings: Settings): RolePoolTarget | undefined {
	const { base, level } = splitRoleAliasThinkingSuffix(selector.trim());
	const role = resolveExplicitModelRole(base, settings);
	if (role === undefined || (level !== undefined && role === "default")) return undefined;
	if (!resolveRolePoolGroup(settings, role)) return undefined;
	const requested = resolveConfiguredModelPatterns(base, settings);
	const rolePatterns = resolveConfiguredModelPatterns(settings.getModelRole(role), settings);
	if (requested.length !== rolePatterns.length) return undefined;
	if (!requested.every((pattern, index) => pattern === rolePatterns[index])) return undefined;
	return level !== undefined ? { role, thinkingLevel: level } : { role };
}

/**
 * The pool `role` resolves through: itself when `modelRoles.<role>` is a pool, the aliased pool
 * role when its value is a role alias of one ({@link rolePoolAliasTarget}), else `undefined`.
 */
export function rolePoolTarget(settings: Settings, role: string): RolePoolTarget | undefined {
	if (resolveRolePoolGroup(settings, role)) return { role };
	const value = settings.getModelRole(role);
	const target = value ? rolePoolAliasTarget(value, settings) : undefined;
	return target && target.role !== role ? target : undefined;
}

/** Pool roles already warned about for a consumer that reads only their ordered member list. */
const projectionWarnings = new Set<string>();

/**
 * Logs once per process and role when `role` is a pool, or an alias of one ({@link rolePoolTarget}),
 * whose funding or `quota` policy a consumer that resolves only the ordered member list does not apply.
 */
export function warnRolePoolProjection(settings: Settings, role: string): void {
	if (projectionWarnings.has(role)) return;
	const target = rolePoolTarget(settings, role);
	const policy = target ? resolveRolePoolGroup(settings, target.role) : undefined;
	if (!policy) return;
	const funding = policy.group.routing?.funding !== undefined;
	const quota = policy.group.strategy.name === "quota" || policy.group.routing?.quota !== undefined;
	if (!funding && !quota) return;
	projectionWarnings.add(role);
	logger.warn("Model role pool resolved in configured order without its funding or quota policy", {
		role,
		funding,
		quota,
	});
}
