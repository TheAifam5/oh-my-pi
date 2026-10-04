import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Api, ApiKey, Model } from "@oh-my-pi/pi-ai";
import type { ApiKeyResolverRegistry } from "../config/api-key-resolver";
import {
	getModelMatchPreferences,
	type ModelLookupRegistry,
	parseModelPattern,
	resolveModelRoleValue,
} from "../config/model-resolver";
import { CHAT_MODEL_ROLE_IDS } from "../config/model-roles";
import type { Settings } from "../config/settings";
import MODEL_PRIO from "../priority.json" with { type: "json" };
import { notePoolPickApplied, RolePoolUnavailableError, rolePoolTarget } from "../session/pool-selection";
import {
	type RolePoolCall,
	type RolePoolRegistry,
	resolveRoleSelectionAsync,
	rolePoolPickCandidates,
} from "../session/role-pool-resolution";
import { concreteThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import { logger } from "@oh-my-pi/pi-utils";

export interface ResolvedCommitModel {
	model: Model<Api>;
	/**
	 * Resolver for the model's bearer: re-resolves on 401 / usage-limit so the
	 * whole commit pipeline (analysis, map/reduce, changelog) inherits the
	 * central force-refresh + account-rotation policy.
	 */
	apiKey: ApiKey;
	/**
	 * Commit-time inference is stateless: session-level auto classification
	 * isn't available, so an explicit `:auto` selector collapses to "no
	 * override" and the model's own default level fills in.
	 */
	thinkingLevel?: ThinkingLevel;
}

type CommitModelRegistry = ModelLookupRegistry & ApiKeyResolverRegistry & RolePoolRegistry;

/**
 * The model commit generation runs on: `override`, else the first of `commit`, `smol`, and the chat
 * roles that resolves (a blocked pool role is skipped). `call` shares pool picks with
 * {@link resolveSmolModel} in the same run.
 */
export async function resolvePrimaryModel(
	override: string | undefined,
	settings: Settings,
	modelRegistry: CommitModelRegistry,
	call?: RolePoolCall,
): Promise<ResolvedCommitModel> {
	const available = modelRegistry.getAvailable();
	const matchPreferences = getModelMatchPreferences(settings);
	const resolved = override
		? resolveModelRoleValue(override, available, { settings, matchPreferences })
		: await resolveRoleSelectionAsync(
				["commit", "smol", ...CHAT_MODEL_ROLE_IDS],
				settings,
				available,
				{ modelRegistry },
				call,
			);
	const model = resolved?.model;
	if (!model) {
		throw new Error("No model available for commit generation");
	}
	const apiKey = await modelRegistry.getApiKey(model);
	if (!apiKey) {
		throw new Error(`No API key available for model ${model.provider}/${model.id}`);
	}
	if (resolved && "pick" in resolved && resolved.pick) notePoolPickApplied(resolved.pick);
	return {
		model,
		apiKey: modelRegistry.resolver(model),
		thinkingLevel: concreteThinkingLevel(resolved?.thinkingLevel),
	};
}

/**
 * The model for commit-message drafting: the `smol` role, its built-in candidates, then the primary
 * model. A `smol` pool (or an alias of one) never uses the built-in candidates: a pick without a
 * resolvable key gives way to the pool's other eligible members, then the primary model, and a
 * blocked pool falls to the primary model. `call` reuses the run's `smol` pick.
 */
export async function resolveSmolModel(
	settings: Settings,
	modelRegistry: CommitModelRegistry,
	fallbackModel: Model<Api>,
	fallbackApiKey: ApiKey,
	call?: RolePoolCall,
): Promise<ResolvedCommitModel> {
	const available = modelRegistry.getAvailable();
	const resolvedSmol = await resolveRoleSelectionAsync(["smol"], settings, available, { modelRegistry }, call).catch(
		(error: unknown) => {
			if (!(error instanceof RolePoolUnavailableError)) throw error;
			logger.info("Commit smol pool unavailable; using the primary model", { error: error.message });
			return null;
		},
	);
	// A blocked smol pool is skipped like an unavailable smol role, without its built-in substitutes.
	if (resolvedSmol === null) return { model: fallbackModel, apiKey: fallbackApiKey };
	if (resolvedSmol?.model) {
		const apiKey = await modelRegistry.getApiKey(resolvedSmol.model);
		if (apiKey) {
			if (resolvedSmol.pick) notePoolPickApplied(resolvedSmol.pick);
			return {
				model: resolvedSmol.model,
				apiKey: modelRegistry.resolver(resolvedSmol.model),
				thinkingLevel: concreteThinkingLevel(resolvedSmol.thinkingLevel),
			};
		}
	}
	if (rolePoolTarget(settings, "smol")) {
		// Built-in substitutes could include a member the pool's funding policy excluded.
		const rest = resolvedSmol?.pick ? rolePoolPickCandidates(resolvedSmol.pick, settings, available).slice(1) : [];
		for (const candidate of rest) {
			if (!(await modelRegistry.getApiKey(candidate.model))) continue;
			return {
				model: candidate.model,
				apiKey: modelRegistry.resolver(candidate.model),
				thinkingLevel: concreteThinkingLevel(candidate.thinkingLevel),
			};
		}
		return { model: fallbackModel, apiKey: fallbackApiKey };
	}

	const matchPreferences = getModelMatchPreferences(settings);
	for (const pattern of MODEL_PRIO.smol) {
		const candidate = parseModelPattern(pattern, available, matchPreferences).model;
		if (!candidate) continue;
		const apiKey = await modelRegistry.getApiKey(candidate);
		if (apiKey) {
			return {
				model: candidate,
				apiKey: modelRegistry.resolver(candidate),
			};
		}
	}

	return { model: fallbackModel, apiKey: fallbackApiKey };
}
