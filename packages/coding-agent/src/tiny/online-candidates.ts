import type { Api, Model } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import { formatModelStringWithRouting, resolveModelOverride, resolveRoleSelection } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import {
	expandDefaultRetryFallbackChains,
	findRetryFallbackCandidates,
	type RetryFallbackChains,
	type RetryFallbackResolutionContext,
	resolveRetryFallbackChainKey,
} from "../session/retry-fallback-chains";
import { getSelectorFallbackChains } from "../session/retry-fallback-selector-chains";
import { type RolePoolPick, RolePoolUnavailableError } from "../session/pool-selection";
import {
	createRolePoolCall,
	pickRolePool,
	type RolePoolCall,
	type RolePoolContext,
	rolePoolPickCandidates,
} from "../session/role-pool-resolution";

import { cfgRetryModelFallback } from "../session/settings";

/** Role-resolved model used by online tiny tasks (auto-thinking, titles). */
export interface OnlineTinyCandidate {
	role: string;
	model: Model<Api>;
}

function modelKey(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

/** Dedup key that keeps distinct `@upstream` routes as separate candidates. */
function candidateKey(model: Model<Api>): string {
	return formatModelStringWithRouting(model);
}

function createFallbackContext(
	chains: RetryFallbackChains,
	settings: Settings,
	availableModels: Model<Api>[],
): RetryFallbackResolutionContext {
	return {
		chains,
		getModelRole: role => settings.getModelRole(role),
		modelLookup: {
			find: (provider, id) => availableModels.find(model => model.provider === provider && model.id === id),
			hasProvider: provider => availableModels.some(model => model.provider === provider),
		},
	};
}

type ExpandItem = {
	role: string;
	model: Model<Api>;
	/** Selector used to resolve which chain key applies. */
	selector: string;
	roleHint?: string;
};

/**
 * Transitively expand retry fallback candidates from seed models into `out`.
 * Callers choose whether `context.chains` already merged role defaults.
 */
function expandFallbackCandidates(
	seeds: ExpandItem[],
	context: RetryFallbackResolutionContext,
	settings: Settings,
	availableModels: Model<Api>[],
	seen: Set<string>,
	out: OnlineTinyCandidate[],
): void {
	const add = (role: string, model: Model<Api>): boolean => {
		const key = candidateKey(model);
		if (seen.has(key)) return false;
		seen.add(key);
		out.push({ role, model });
		return true;
	};

	const registryShim = { getAvailable: () => availableModels };
	const queue: ExpandItem[] = [...seeds];
	const expanded = new Set<string>();

	while (queue.length > 0) {
		const { role, model, selector, roleHint } = queue.shift()!;
		const chainKey = resolveRetryFallbackChainKey(context, selector, model, roleHint);
		if (!chainKey) continue;
		// Resolved provider/id is the chain primary: bare/fuzzy role selectors and
		// `@upstream` routing suffixes must not empty the chain or poison wildcards.
		const primarySelector = modelKey(model);
		const expandKey = `${chainKey}\0${candidateKey(model)}`;
		if (expanded.has(expandKey)) continue;
		expanded.add(expandKey);

		for (const candidate of findRetryFallbackCandidates(context, chainKey, primarySelector, model, {
			allowMissingPrimary: true,
		})) {
			// Resolve raw selectors (including `@upstream` / fuzzy) the same way
			// turn-recovery does, instead of exact (provider, id) lookup only.
			const resolved = resolveModelOverride([candidate.raw], registryShim, settings);
			const fallback = resolved.model ?? context.modelLookup.find(candidate.provider, candidate.id);
			if (!fallback) continue;
			if (!add(role, fallback)) continue;
			// After landing on this fallback, consult its own chain key so configs
			// like `tiny: [B]` + `B: [C]` reach C (session recovery does the same).
			queue.push({
				role,
				model: fallback,
				selector: formatModelStringWithRouting(fallback),
			});
		}
	}
}

/**
 * Collect unique online models for lightweight background tasks.
 *
 * Order: each requested role's primary, then canonical retry fallback chains
 * traversed transitively (so a hop onto B also consults B's own chain).
 * Disabling model fallback restricts attempts to the first resolvable primary,
 * unless `tryAllRoles` asks for the explicit role chain without configured
 * retry-chain expansion.
 */
export function collectOnlineTinyCandidates(
	roles: readonly string[],
	settings: Settings,
	availableModels: Model<Api>[],
	options?: {
		tryAllRoles?: boolean;
		/** Models a role resolves to instead of its configured value, primary first; empty skips the role. */
		resolvedRoles?: ReadonlyMap<string, readonly Model<Api>[]>;
	},
): OnlineTinyCandidate[] {
	const seen = new Set<string>();
	const out: OnlineTinyCandidate[] = [];
	const addPrimary = (role: string, model: Model<Api>): boolean => {
		const key = candidateKey(model);
		if (seen.has(key)) return false;
		seen.add(key);
		out.push({ role, model });
		return true;
	};

	// Retain every role even if primaries coincide: their fallback chains can differ.
	const fallbackEnabled = cfgRetryModelFallback.get(settings) !== false;
	const primaries: OnlineTinyCandidate[] = [];
	for (const role of roles) {
		const overridden = options?.resolvedRoles?.get(role);
		if (overridden?.length === 0) continue;
		const [picked, ...members] = overridden ?? [];
		const resolved = picked ? { role, model: picked } : resolveRoleSelection([role], settings, availableModels);
		if (!resolved?.model) continue;
		addPrimary(resolved.role, resolved.model);
		for (const member of members) addPrimary(role, member);
		if (!fallbackEnabled && !options?.tryAllRoles) return out;
		if (fallbackEnabled) primaries.push({ role: resolved.role, model: resolved.model });
	}
	if (!fallbackEnabled) return out;

	const context = createFallbackContext(
		expandDefaultRetryFallbackChains(getSelectorFallbackChains(settings), roles),
		settings,
		availableModels,
	);
	expandFallbackCandidates(
		primaries.map(({ role, model }) => ({
			role,
			model,
			selector: settings.getModelRole(role) ?? modelKey(model),
			roleHint: role,
		})),
		context,
		settings,
		availableModels,
		seen,
		out,
	);
	return out;
}

/**
 * {@link collectOnlineTinyCandidates} that resolves a pool role through {@link pickRolePool}: its
 * pick, then the pool's other eligible members, lead that role's candidates. A role whose pool its
 * policy blocks is skipped (and logged) while the other roles still contribute; legacy roles and
 * pool roles without a pick contribute exactly what the sync variant collects. All roles share
 * one funding read, and their picks are made in `call`; the consumer records a pick's position
 * with {@link noteRolePoolModelUsed} when it sends a request to that model.
 *
 * @throws RolePoolUnavailableError, the first blocked pool's, when no role contributes a candidate and one was blocked.
 * @throws the abort reason when `context.signal` aborts.
 */
export async function collectOnlineTinyCandidatesAsync(
	roles: readonly string[],
	settings: Settings,
	availableModels: Model<Api>[],
	context: RolePoolContext,
	options?: { tryAllRoles?: boolean },
	call: RolePoolCall = createRolePoolCall(settings, context),
): Promise<OnlineTinyCandidate[]> {
	const fallbackEnabled = cfgRetryModelFallback.get(settings) !== false;
	const stopAtFirst = !fallbackEnabled && !options?.tryAllRoles;
	const resolvedRoles = new Map<string, Model<Api>[]>();
	let blocked: RolePoolUnavailableError | undefined;
	for (const role of roles) {
		let pick: RolePoolPick | undefined;
		try {
			pick = await pickRolePool(role, settings, availableModels, context, call);
		} catch (error) {
			if (!(error instanceof RolePoolUnavailableError)) throw error;
			logger.info("Skipped a blocked model role pool for tiny-model candidates", { role, error: error.message });
			blocked ??= error;
			resolvedRoles.set(role, []);
			continue;
		}
		if (pick) {
			// The pool's other members are fallbacks, so disabling model fallback leaves only the pick.
			const candidates = rolePoolPickCandidates(pick, settings, availableModels, { includeRest: fallbackEnabled });
			resolvedRoles.set(
				role,
				candidates.map(candidate => candidate.model),
			);
		}
		// The sync collection stops after the first resolvable primary; later roles are never picked.
		if (stopAtFirst && (pick || resolveRoleSelection([role], settings, availableModels))) break;
	}
	const candidates = collectOnlineTinyCandidates(roles, settings, availableModels, { ...options, resolvedRoles });
	if (candidates.length === 0 && blocked) throw blocked;
	return candidates;
}

/**
 * Expand one model's own `retry.fallbackChains` transitively.
 *
 * Does not merge role/`default` chains into the seed via
 * `expandDefaultRetryFallbackChains` — title generation appends the active
 * session model separately from tiny/commit/smol role collection, so its
 * recovery path must consult only the configured model-keyed / wildcard /
 * matching-role keys that `resolveRetryFallbackChainKey` already selects.
 */
export function expandOnlineTinyModelFallbacks(
	model: Model<Api>,
	settings: Settings,
	availableModels: Model<Api>[],
): Model<Api>[] {
	const seen = new Set<string>([candidateKey(model)]);
	const out: OnlineTinyCandidate[] = [{ role: "current", model }];
	if (cfgRetryModelFallback.get(settings) === false) return [model];

	const context = createFallbackContext(getSelectorFallbackChains(settings), settings, availableModels);
	expandFallbackCandidates(
		[
			{
				role: "current",
				model,
				selector: formatModelStringWithRouting(model),
			},
		],
		context,
		settings,
		availableModels,
		seen,
		out,
	);
	return out.map(candidate => candidate.model);
}
