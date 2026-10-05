import { type Agent, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model, ProviderSessionState, ServiceTier, ServiceTierByFamily, ServiceTierFamily } from "@oh-my-pi/pi-ai";
import {
	Effort,
	realizesPriorityServiceTier,
	resolveModelServiceTier,
	serviceTierFamily,
	shouldSendServiceTier,
} from "@oh-my-pi/pi-ai";
import {
	clearAnthropicFastModeFallback,
	isAnthropicFastModeFallbackDisabled,
} from "@oh-my-pi/pi-ai/providers/anthropic-state";
import { isFireworksFastModelId } from "@oh-my-pi/pi-catalog/fireworks-model-id";
import { THINKING_EFFORTS } from "@oh-my-pi/pi-catalog/effort";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { modelsAreEqual } from "@oh-my-pi/pi-catalog/models";
import { logger } from "@oh-my-pi/pi-utils";
import { classifyDifficulty } from "../auto-thinking/classifier";
import type { ModelRegistry } from "../config/model-registry";
import type { ModelSelectSource } from "../extensibility/extensions/types";
import {
	filterAvailableModelsByEnabledPatterns,
	formatModelStringWithRouting,
	getModelMatchPreferences,
	type ResolvedModelRoleValue,
	resolveModelRoleValue,
} from "../config/model-resolver";
import { getKnownRoleIds } from "../config/model-roles";
import type { Settings } from "../config/settings";
import { containsMagicKeyword } from "@oh-my-pi/pi-tui/prompt/magic-keywords";
import type { MagicKeywordId } from "../modes/magic-keywords";
import {
	AUTO_THINKING,
	type ConfiguredThinkingLevel,
	clampAutoThinkingEffort,
	clampThinkingLevelToCeiling,
	resolveProvisionalAutoLevel,
	resolveThinkingLevelForModel,
	shouldDisableReasoning,
	toReasoningEffort,
} from "@oh-my-pi/pi-tui/thinking";
import type { EditMode } from "@oh-my-pi/pi-tui/tools/edit";
import type { AgentSessionEvent } from "./agent-session-events";
import type { ModelCycleResult, ResolvedRoleModel, RoleModelCycle, RoleModelCycleResult } from "./agent-session-types";
import {
	notePoolPickApplied,
	PoolSelection,
	type RolePoolPick,
	RolePoolUnavailableError,
	resolveRolePool,
	rolePoolPolicyBlocked,
	rolePoolTarget,
	warnRolePoolProjection,
} from "./pool-selection";
import { formatRoleModelValue, resolveRoleModelFull } from "./role-models";
import { EPHEMERAL_MODEL_CHANGE_ROLE } from "./session-entries";
import type { SessionManager } from "./session-manager";

import { cfgDefaultThinkingLevel, cfgProvidersFireworksTier } from "./settings";
import { cfgDisabledProviders, cfgEnabledModels } from "../config/model-settings";

/** Capabilities borrowed from the owning AgentSession. */
export interface ModelControlsHost {
	agent: Agent;
	settings: Settings;
	modelRegistry: ModelRegistry;
	sessionManager: SessionManager;
	providerSessionState: Map<string, ProviderSessionState>;
	model(): Model | undefined;
	sessionId(): string;
	promptGeneration(): number;
	resolveActiveEditMode(): EditMode;
	syncAfterModelChange(previousEditMode: EditMode): Promise<void>;
	setModelWithProviderSessionReset(
		model: Model,
		source?: ModelSelectSource,
		selection?: "explicit" | "automatic",
	): Promise<void>;
	/** Observes an effective thinking-level change; `previousLevel` is the level before it. */
	onThinkingLevelSelected?(level: ThinkingLevel, previousLevel: ThinkingLevel): void;
	clearActiveRetryFallback(): void;
	clearInheritedProviderPromptCacheKey(): void;
	/** Whether `model`'s prompt cache is warm for this session at `nowMs`; absent: never. */
	promptCacheWarm?(model: Model, nowMs: number): boolean;
	magicKeywordEnabled(keyword: MagicKeywordId): boolean;
	emit(event: AgentSessionEvent): void;
	emitSessionEvent(event: AgentSessionEvent): Promise<void>;
	emitNotice(level: "info" | "warning" | "error", message: string, source?: string): void;
}

/** Owns model selection, thinking effort, role cycling, and service tiers. */
export class ModelControls {
	readonly #host: ModelControlsHost;
	#scopedModels: Array<{ model: Model; thinkingLevel?: ThinkingLevel }>;
	#thinkingLevel: ThinkingLevel | undefined;
	/** Hard per-session effort ceiling (e.g. a task spawn's `task.maxEffort` cap); recovery paths re-clamp to it. */
	readonly #thinkingLevelCeiling: Effort | undefined;
	#autoThinking = false;
	#autoResolvedLevel: Effort | undefined;
	#serviceTierByFamily: ServiceTierByFamily;
	/**
	 * Pool-role picks of this session by role, valid while settings stay at `revision`; `recorded`
	 * once the pick's round-robin position has been recorded.
	 */
	readonly #rolePoolPicks = new Map<string, { revision: number; pick: RolePoolPick; recorded: boolean }>();
	readonly #poolSelection: PoolSelection;

	constructor(
		host: ModelControlsHost,
		options: {
			scopedModels?: Array<{ model: Model; thinkingLevel?: ThinkingLevel }>;
			thinkingLevel?: ConfiguredThinkingLevel;
			thinkingLevelCeiling?: Effort;
			serviceTierByFamily?: ServiceTierByFamily;
		},
	) {
		this.#host = host;
		this.#poolSelection = new PoolSelection({
			settings: host.settings,
			modelRegistry: host.modelRegistry,
			sessionId: () => host.sessionId(),
			emitNotice: async message => host.emitNotice("warning", message, "model-role"),
			promptCacheWarm: (model, nowMs) => host.promptCacheWarm?.(model, nowMs) ?? false,
		});
		this.#scopedModels = options.scopedModels ?? [];
		this.#serviceTierByFamily = options.serviceTierByFamily ?? {};
		this.#thinkingLevelCeiling = options.thinkingLevelCeiling;
		if (options.thinkingLevel === AUTO_THINKING) {
			// Keep auto pending until the first turn while exposing a valid wire effort.
			this.#autoThinking = true;
			this.#thinkingLevel = clampThinkingLevelToCeiling(
				this.#model,
				resolveProvisionalAutoLevel(this.#model),
				this.#thinkingLevelCeiling,
			);
		} else {
			this.#thinkingLevel = clampThinkingLevelToCeiling(
				this.#model,
				options.thinkingLevel,
				this.#thinkingLevelCeiling,
			);
		}
		this.#applyThinkingLevelToAgent(this.#thinkingLevel);
	}

	get #model(): Model | undefined {
		return this.#host.model();
	}

	/** Effective metadata-clamped thinking level applied to the agent. */
	get thinkingLevel(): ThinkingLevel | undefined {
		return this.#thinkingLevel;
	}

	/** Hard per-session effort ceiling every thinking-level change is clamped to. */
	get thinkingLevelCeiling(): Effort | undefined {
		return this.#thinkingLevelCeiling;
	}

	/** Configured selector, preserving `auto` while classification is active. */
	configuredThinkingLevel(): ConfiguredThinkingLevel | undefined {
		return this.#autoThinking ? AUTO_THINKING : this.#thinkingLevel;
	}

	/** Whether per-turn automatic thinking classification is enabled. */
	get isAutoThinking(): boolean {
		return this.#autoThinking;
	}

	/** Last concrete effort selected by automatic classification. */
	get autoResolvedThinkingLevel(): Effort | undefined {
		return this.#autoResolvedLevel;
	}

	/** Models explicitly scoped to the session's cycle command, minus currently disabled providers. */
	get scopedModels(): ReadonlyArray<{ model: Model; thinkingLevel?: ThinkingLevel }> {
		const disabledProviders = cfgDisabledProviders.get(this.#host.settings);
		if (disabledProviders.length === 0) return this.#scopedModels;
		return this.#scopedModels.filter(scoped => !disabledProviders.includes(scoped.model.provider));
	}

	/**
	 * Replace the Ctrl+P cycle scope. Startup resolves the scope before background
	 * provider discovery runs; the CLI re-pushes the fuller list here once discovery
	 * completes so a newly-discovered `enabledModels` model joins the cycle and the
	 * scoped `/models` picker (issue #9220).
	 */
	setScopedModels(scopedModels: Array<{ model: Model; thinkingLevel?: ThinkingLevel }>): void {
		this.#scopedModels = scopedModels;
	}

	/** Live per-provider-family service-tier selection. */
	get serviceTierByFamily(): ServiceTierByFamily {
		return this.#serviceTierByFamily;
	}

	/** Restores thinking state from a transcript without persisting a new entry. */
	restoreThinkingLevel(level: ConfiguredThinkingLevel | undefined): void {
		this.#autoThinking = level === AUTO_THINKING;
		this.#autoResolvedLevel = undefined;
		this.#thinkingLevel =
			level === AUTO_THINKING
				? clampThinkingLevelToCeiling(
						this.#model,
						resolveProvisionalAutoLevel(this.#model),
						this.#thinkingLevelCeiling,
					)
				: resolveThinkingLevelForModel(
						this.#model,
						clampThinkingLevelToCeiling(this.#model, level, this.#thinkingLevelCeiling),
					);
		this.#applyThinkingLevelToAgent(this.#thinkingLevel);
	}

	/** Restores an exact thinking snapshot after a failed session switch. */
	restoreThinkingSnapshot(level: ThinkingLevel | undefined, auto: boolean, resolved: Effort | undefined): void {
		this.#thinkingLevel = level;
		this.#autoThinking = auto;
		this.#autoResolvedLevel = resolved;
		this.#applyThinkingLevelToAgent(level);
	}

	/** Restores service tiers without persisting a duplicate transcript entry. */
	restoreServiceTiers(tiers: ServiceTierByFamily): void {
		this.#serviceTierByFamily = tiers;
	}
	resolveRoleModel(role: string): Model | undefined {
		return resolveRoleModelFull(this.#host.settings, role, this.#host.modelRegistry.getAvailable(), this.#model)
			.model;
	}

	resolveRoleModelWithThinking(role: string): ResolvedModelRoleValue {
		return resolveRoleModelFull(this.#host.settings, role, this.#host.modelRegistry.getAvailable(), this.#model);
	}

	/**
	 * {@link resolveRoleModelWithThinking} that applies a pool role's strategy and funding policy
	 * ({@link resolveRolePool}), also for a role whose value is an alias of a pool role
	 * ({@link rolePoolTarget}; its `:level` replaces the member's effort); a legacy role value, and
	 * a pool with no eligible member and no policy skip, resolve exactly as the sync variant does.
	 *
	 * A pool pick is kept for this session and returned again until settings change or the session
	 * switches models to something other than the pick ({@link setModel}, {@link setModelTemporary}).
	 * `options.availableModels` narrows the members and the legacy resolution to those models (a
	 * `--models` scope); a kept pick outside them is selected again.
	 *
	 * @throws RolePoolUnavailableError when no pool member is eligible and the funding or quota policy excluded one.
	 * @throws the abort reason when `options.signal` aborts.
	 */
	async resolveRoleModelAsync(
		role: string,
		options: { signal?: AbortSignal; availableModels?: Model[] } = {},
	): Promise<ResolvedModelRoleValue> {
		const settings = this.#host.settings;
		const scope = options.availableModels;
		const legacy = (): ResolvedModelRoleValue =>
			scope ? resolveRoleModelFull(settings, role, scope, this.#model) : this.resolveRoleModelWithThinking(role);
		const cached = this.#rolePoolPicks.get(role);
		if (
			cached &&
			cached.revision === settings.revision &&
			(!scope || scope.some(model => modelsAreEqual(model, cached.pick.model)))
		) {
			return rolePickResolution(cached.pick);
		}
		this.#rolePoolPicks.delete(role);
		const revision = settings.revision;
		const target = rolePoolTarget(settings, role);
		if (!target) return legacy();
		const resolution = await resolveRolePool(
			target.role,
			{
				settings,
				modelRegistry: this.#host.modelRegistry,
				sessionId: () => this.#host.sessionId(),
				emitNotice: async message => this.#host.emitNotice("warning", message, "model-role"),
				availableModels: () => scope ?? this.#host.modelRegistry.getAvailable(),
				selection: this.#poolSelection,
			},
			{ signal: options.signal },
		);
		if (resolution?.kind === "aborted") options.signal?.throwIfAborted();
		if (resolution?.kind === "none" && rolePoolPolicyBlocked(resolution.skipped)) {
			throw new RolePoolUnavailableError(target.role, resolution.skipped);
		}
		if (resolution?.kind !== "picked") return legacy();
		const pick =
			target.thinkingLevel === undefined
				? resolution.pick
				: { ...resolution.pick, thinkingLevel: target.thinkingLevel, explicitThinkingLevel: true };
		if (settings.revision === revision) this.#rolePoolPicks.set(role, { revision, pick, recorded: false });
		return rolePickResolution(pick);
	}

	/**
	 * Keeps `pick`, already applied, as this session's pick for `role` until settings change or the
	 * model is switched elsewhere, as {@link resolveRoleModelAsync} keeps its own. `revision` is the
	 * settings revision the pick was made at; a pick made before a later settings change is not kept.
	 * Returns whether it was kept.
	 */
	adoptRolePoolPick(role: string, pick: RolePoolPick, revision: number): boolean {
		if (revision !== this.#host.settings.revision) return false;
		this.#rolePoolPicks.set(role, { revision, pick, recorded: true });
		return true;
	}

	/**
	 * Records the round-robin position of `role`'s pool pick, kept by {@link resolveRoleModelAsync},
	 * when `model` is that pick. A consumer that sends requests to the pick without switching the
	 * session to it (local memory consolidation) calls this when it uses the pick. A kept pick is
	 * recorded once, so reusing it later never moves a position other consumers advanced since.
	 */
	noteRolePoolPickUsed(role: string, model: Model): void {
		const cached = this.#rolePoolPicks.get(role);
		if (!cached || cached.recorded || !modelsAreEqual(cached.pick.model, model)) return;
		cached.recorded = true;
		notePoolPickApplied(cached.pick);
	}

	/**
	 * Records the round-robin position of `role`'s cached pool pick, once, when `model` is that pick,
	 * and forgets every cached pick otherwise.
	 */
	#noteModelSwitch(model: Model, role: string | undefined): void {
		const cached = role === undefined ? undefined : this.#rolePoolPicks.get(role);
		if (role !== undefined && cached && modelsAreEqual(cached.pick.model, model)) {
			this.noteRolePoolPickUsed(role, model);
			return;
		}
		this.#rolePoolPicks.clear();
	}

	resolveTemporaryModelThinkingLevel(model: Model): ConfiguredThinkingLevel | undefined {
		const availableModels = this.#host.modelRegistry.getAvailable();
		if (availableModels.length === 0) return undefined;

		const matchPreferences = getModelMatchPreferences(this.#host.settings);
		for (const role of getKnownRoleIds(this.#host.settings)) {
			const roleValue = this.#host.settings.getModelRole(role);
			if (!roleValue) continue;

			const resolved = resolveModelRoleValue(roleValue, availableModels, {
				settings: this.#host.settings,
				matchPreferences,
			});
			if (!resolved.explicitThinkingLevel || resolved.thinkingLevel === undefined || !resolved.model) continue;
			if (modelsAreEqual(resolved.model, model)) return resolved.thinkingLevel;
		}

		return undefined;
	}

	async setModel(
		model: Model,
		role: string = "default",
		options?: {
			selector?: string;
			thinkingLevel?: ThinkingLevel;
			persist?: boolean;
		},
	): Promise<{ switched: boolean }> {
		const previousEditMode = this.#host.resolveActiveEditMode();
		if (!this.#host.modelRegistry.hasConfiguredAuth(model)) {
			throw new Error(`No API key for ${model.provider}/${model.id}`);
		}

		const targetModel = await this.#host.modelRegistry.refreshSelectedModelMetadata(model);

		this.#host.modelRegistry.clearSuppressedSelector(formatModelStringWithRouting(targetModel));
		this.#host.clearActiveRetryFallback();
		await this.#host.setModelWithProviderSessionReset(targetModel);
		this.#noteModelSwitch(targetModel, role);
		this.#host.sessionManager.appendModelChange(`${targetModel.provider}/${targetModel.id}`, role);
		if (options?.persist) {
			this.#host.settings.setModelRole(
				role,
				formatRoleModelValue(
					this.#host.settings,
					this.#host.modelRegistry,
					role,
					targetModel,
					options.selector,
					options.thinkingLevel,
				),
			);
		}
		this.#host.settings.getStorage()?.recordModelUsage(`${targetModel.provider}/${targetModel.id}`);

		// Re-apply thinking for the newly selected model. Prefer the model's
		// configured defaultLevel; otherwise preserve the current level (or auto).
		this.#reapplyThinkingLevel(targetModel.thinking?.defaultLevel);
		await this.#host.syncAfterModelChange(previousEditMode);
		return { switched: true };
	}

	/**
	 * Set model temporarily (for this session only).
	 * Validates that a credential source is configured (synchronously, without
	 * refreshing OAuth or running command-backed key programs), saves to session
	 * log but NOT to settings. `options.poolRole` names the role whose pool pick
	 * ({@link resolveRoleModelAsync}) this switch applies: when `model` is that pick
	 * it is kept and its round-robin position recorded; otherwise every cached pick is forgotten.
	 * @throws Error if no API key available for the model
	 */
	async setModelTemporary(
		model: Model,
		thinkingLevel?: ConfiguredThinkingLevel,
		options?: { ephemeral?: boolean; poolRole?: string },
		selection: "explicit" | "automatic" = "explicit",
	): Promise<void> {
		const previousEditMode = this.#host.resolveActiveEditMode();
		if (!this.#host.modelRegistry.hasConfiguredAuth(model)) {
			throw new Error(`No API key for ${model.provider}/${model.id}`);
		}

		const targetModel = await this.#host.modelRegistry.refreshSelectedModelMetadata(model);

		this.#host.modelRegistry.clearSuppressedSelector(formatModelStringWithRouting(targetModel));
		this.#host.clearActiveRetryFallback();
		await this.#host.setModelWithProviderSessionReset(targetModel, undefined, selection);
		this.#noteModelSwitch(targetModel, options?.poolRole);
		this.#host.sessionManager.appendModelChange(
			`${targetModel.provider}/${targetModel.id}`,
			options?.ephemeral ? EPHEMERAL_MODEL_CHANGE_ROLE : "temporary",
		);
		this.#host.settings.getStorage()?.recordModelUsage(`${targetModel.provider}/${targetModel.id}`);

		// Apply explicit thinking level if given; otherwise prefer the model's
		// configured defaultLevel; otherwise re-clamp the current level (or auto).
		if (thinkingLevel !== undefined) {
			this.setThinkingLevel(thinkingLevel);
		} else {
			this.#reapplyThinkingLevel(targetModel.thinking?.defaultLevel);
		}
		await this.#host.syncAfterModelChange(previousEditMode);
	}

	/**
	 * Cycle to next/previous model.
	 * Uses scoped models (from --models flag) if available, otherwise all available models.
	 * @param direction - "forward" (default) or "backward"
	 * @returns The new model info, or undefined if only one model available
	 */
	async cycleModel(direction: "forward" | "backward" = "forward"): Promise<ModelCycleResult | undefined> {
		if (this.scopedModels.length > 0) {
			return this.#cycleScopedModel(direction);
		}
		return this.#cycleAvailableModel(direction);
	}

	/**
	 * Resolve the configured role models in the given order plus the index of
	 * the currently active one. Roles that have no configured model, or whose
	 * configured model is not currently available, are skipped. The `default`
	 * role falls back to the active model when no explicit assignment exists.
	 * A pool role lists this session's pick ({@link resolveRoleModelAsync}) once
	 * it has one, and its first available member in configured order before.
	 *
	 * Returns `undefined` only when there is no current model or no available
	 * models at all; an empty `models` array is never returned (callers should
	 * still guard on `models.length`).
	 */
	getRoleModelCycle(roleOrder: readonly string[]): RoleModelCycle | undefined {
		const availableModels = this.#host.modelRegistry.getAvailable();
		if (availableModels.length === 0) return undefined;

		const currentModel = this.#model;
		if (!currentModel) return undefined;
		const matchPreferences = getModelMatchPreferences(this.#host.settings);
		const models: ResolvedRoleModel[] = [];

		for (const role of roleOrder) {
			const cached = this.#rolePoolPicks.get(role);
			if (cached && cached.revision === this.#host.settings.revision) {
				const { pick } = cached;
				models.push({
					role,
					model: pick.model,
					thinkingLevel: pick.thinkingLevel,
					explicitThinkingLevel: pick.explicitThinkingLevel,
				});
				continue;
			}
			warnRolePoolProjection(this.#host.settings, role);
			const roleModelStr =
				role === "default"
					? (this.#host.settings.getModelRole("default") ?? `${currentModel.provider}/${currentModel.id}`)
					: this.#host.settings.getModelRole(role);
			if (!roleModelStr) continue;

			const resolved = resolveModelRoleValue(roleModelStr, availableModels, {
				settings: this.#host.settings,
				matchPreferences,
			});
			if (!resolved.model) continue;

			models.push({
				role,
				model: resolved.model,
				thinkingLevel: resolved.thinkingLevel,
				explicitThinkingLevel: resolved.explicitThinkingLevel,
			});
		}

		if (models.length === 0) return undefined;

		// Trust the recorded role only while its resolved model still IS the
		// active model. A model switch through another surface (alt+m, retry
		// fallback, /model) or a role re-configuration leaves the recorded role
		// pointing at a model the session no longer runs; cycling from that
		// stale slot lands on the wrong neighbor and reads as a skipped entry.
		const lastRole = this.#host.sessionManager.getLastModelChangeRole();
		let currentIndex = lastRole ? models.findIndex(entry => entry.role === lastRole) : -1;
		if (currentIndex !== -1 && !modelsAreEqual(models[currentIndex].model, currentModel)) {
			currentIndex = -1;
		}
		if (currentIndex === -1) {
			currentIndex = models.findIndex(entry => modelsAreEqual(entry.model, currentModel));
		}
		if (currentIndex === -1) currentIndex = 0;

		return { models, currentIndex };
	}

	/**
	 * Apply a resolved role model as the active model without changing global
	 * settings. Shared with role cycling and the plan-approval model slider.
	 * A pool role's entry is replaced by the pool's pick for this session
	 * ({@link resolveRoleModelAsync}); returns the entry actually applied.
	 *
	 * @throws RolePoolUnavailableError when `entry.role` is a pool its policy blocks.
	 */
	async applyRoleModel(entry: ResolvedRoleModel): Promise<ResolvedRoleModel> {
		let applied = entry;
		if (rolePoolTarget(this.#host.settings, entry.role)) {
			const resolved = await this.resolveRoleModelAsync(entry.role);
			if (resolved.model) {
				applied = {
					role: entry.role,
					model: resolved.model,
					thinkingLevel: resolved.thinkingLevel,
					explicitThinkingLevel: resolved.explicitThinkingLevel,
				};
			}
		}
		await this.setModel(applied.model, applied.role);
		if (applied.explicitThinkingLevel && applied.thinkingLevel !== undefined) {
			this.setThinkingLevel(applied.thinkingLevel);
		}
		return applied;
	}

	/**
	 * Cycle through configured role models in a fixed order.
	 * Skips missing roles and changes only the active session model. Switching to a
	 * pool role applies its strategy and funding policy ({@link resolveRoleModelAsync}).
	 * @throws RolePoolUnavailableError when the next role is a pool its policy blocks.
	 * @param roleOrder - Order of roles to cycle through (e.g., ["slow", "default", "smol"])
	 * @param direction - "forward" (default) or "backward"
	 */
	async cycleRoleModels(
		roleOrder: readonly string[],
		direction: "forward" | "backward" = "forward",
	): Promise<RoleModelCycleResult | undefined> {
		const cycle = this.getRoleModelCycle(roleOrder);
		if (!cycle || cycle.models.length <= 1) return undefined;

		const step = direction === "backward" ? -1 : 1;
		const next = cycle.models[(cycle.currentIndex + step + cycle.models.length) % cycle.models.length];

		const applied = await this.applyRoleModel(next);

		return { model: applied.model, thinkingLevel: this.thinkingLevel, role: applied.role };
	}

	async #getScopedModelsWithApiKey(): Promise<Array<{ model: Model; thinkingLevel?: ThinkingLevel }>> {
		const apiKeysByProvider = new Map<string, string | undefined>();
		const result: Array<{ model: Model; thinkingLevel?: ThinkingLevel }> = [];

		for (const scoped of this.scopedModels) {
			const provider = scoped.model.provider;
			let apiKey: string | undefined;
			if (apiKeysByProvider.has(provider)) {
				apiKey = apiKeysByProvider.get(provider);
			} else {
				apiKey = await this.#host.modelRegistry.getApiKeyForProvider(provider, this.#host.sessionId());
				apiKeysByProvider.set(provider, apiKey);
			}

			if (apiKey) {
				result.push(scoped);
			}
		}

		return result;
	}

	async #cycleScopedModel(direction: "forward" | "backward"): Promise<ModelCycleResult | undefined> {
		const previousEditMode = this.#host.resolveActiveEditMode();
		const scopedModels = await this.#getScopedModelsWithApiKey();
		if (scopedModels.length <= 1) return undefined;

		const currentModel = this.#model;
		let currentIndex = scopedModels.findIndex(sm => modelsAreEqual(sm.model, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = scopedModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const next = scopedModels[nextIndex];

		// Apply model
		this.#host.modelRegistry.clearSuppressedSelector(formatModelStringWithRouting(next.model));
		this.#host.clearActiveRetryFallback();
		await this.#host.setModelWithProviderSessionReset(next.model, "cycle");
		this.#host.sessionManager.appendModelChange(`${next.model.provider}/${next.model.id}`);
		this.#host.settings.getStorage()?.recordModelUsage(`${next.model.provider}/${next.model.id}`);

		// Apply the scoped model's configured thinking level, preserving auto.
		this.setThinkingLevel(this.#autoThinking ? AUTO_THINKING : next.thinkingLevel);
		await this.#host.syncAfterModelChange(previousEditMode);

		return { model: next.model, thinkingLevel: this.thinkingLevel, isScoped: true };
	}

	async #cycleAvailableModel(direction: "forward" | "backward"): Promise<ModelCycleResult | undefined> {
		const previousEditMode = this.#host.resolveActiveEditMode();
		const availableModels = this.#host.modelRegistry.getAvailable();
		if (availableModels.length <= 1) return undefined;

		const currentModel = this.#model;
		let currentIndex = availableModels.findIndex(m => modelsAreEqual(m, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = availableModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const nextModel = availableModels[nextIndex];

		const apiKey = await this.#host.modelRegistry.getApiKey(nextModel, this.#host.sessionId());
		if (!apiKey) {
			throw new Error(`No API key for ${nextModel.provider}/${nextModel.id}`);
		}

		this.#host.modelRegistry.clearSuppressedSelector(formatModelStringWithRouting(nextModel));
		this.#host.clearActiveRetryFallback();
		await this.#host.setModelWithProviderSessionReset(nextModel, "cycle");
		this.#host.sessionManager.appendModelChange(`${nextModel.provider}/${nextModel.id}`);
		this.#host.settings.getStorage()?.recordModelUsage(`${nextModel.provider}/${nextModel.id}`);
		// Re-apply the current thinking level (or auto) for the newly selected model
		this.#reapplyThinkingLevel();
		await this.#host.syncAfterModelChange(previousEditMode);

		return { model: nextModel, thinkingLevel: this.thinkingLevel, isScoped: false };
	}

	/**
	 * Get all available models with valid API keys, filtered by `enabledModels` when configured.
	 * See {@link filterAvailableModelsByEnabledPatterns} for supported pattern forms and limitations.
	 */
	getAvailableModels(): Model[] {
		const all = this.#host.modelRegistry.getAvailable();
		const patterns = cfgEnabledModels.get(this.#host.settings);
		if (!patterns || patterns.length === 0) return all;
		return filterAvailableModelsByEnabledPatterns(all, patterns, this.#host.settings);
	}

	// =========================================================================
	// Thinking Level Management
	// =========================================================================

	#applyThinkingLevelToAgent(level: ThinkingLevel | undefined): void {
		this.#host.agent.setThinkingLevel(toReasoningEffort(level));
		this.#host.agent.setDisableReasoning(shouldDisableReasoning(level));
	}

	/**
	 * Set the thinking level. `auto` enables per-turn classification. Entering
	 * auto writes its provisional level plus `configured: "auto"` immediately,
	 * giving external readers an authoritative selection receipt before the next
	 * user turn. Later classifications persist only changed concrete resolutions.
	 */
	setThinkingLevel(level: ConfiguredThinkingLevel | undefined, persist: boolean = false): void {
		if (level === AUTO_THINKING) {
			const provisional = clampThinkingLevelToCeiling(
				this.#model,
				resolveProvisionalAutoLevel(this.#model),
				this.#thinkingLevelCeiling,
			);
			const wasAuto = this.#autoThinking;
			const previousLevel = this.#thinkingLevel;
			this.#autoThinking = true;
			this.#autoResolvedLevel = undefined;
			this.#thinkingLevel = provisional;
			if (!wasAuto) {
				this.#host.clearInheritedProviderPromptCacheKey();
			}
			this.#applyThinkingLevelToAgent(provisional);
			if (persist) {
				cfgDefaultThinkingLevel.set(this.#host.settings, AUTO_THINKING);
			}
			const isChanging = !wasAuto || previousLevel !== provisional;
			if (isChanging) {
				this.#host.sessionManager.appendThinkingLevelChange(provisional, AUTO_THINKING);
				this.#host.emit({ type: "thinking_level_changed", thinkingLevel: provisional, configured: AUTO_THINKING });
				this.#notifyThinkingLevelSelected(provisional, previousLevel);
			}
			return;
		}

		const wasAuto = this.#autoThinking;
		this.#autoThinking = false;
		this.#autoResolvedLevel = undefined;
		const effectiveLevel = resolveThinkingLevelForModel(
			this.#model,
			clampThinkingLevelToCeiling(this.#model, level, this.#thinkingLevelCeiling),
		);
		// Leaving auto must persist even when the resolved effort is unchanged (e.g.
		// auto resolved to medium, then the user pins medium): otherwise the latest
		// session entry keeps `configured: "auto"` and resume re-enables auto.
		const isChanging = wasAuto || effectiveLevel !== this.#thinkingLevel;
		const previousLevel = this.#thinkingLevel;

		this.#thinkingLevel = effectiveLevel;
		this.#applyThinkingLevelToAgent(effectiveLevel);

		if (isChanging) {
			this.#host.clearInheritedProviderPromptCacheKey();
			this.#host.sessionManager.appendThinkingLevelChange(effectiveLevel, effectiveLevel);
			if (persist && effectiveLevel !== undefined && effectiveLevel !== ThinkingLevel.Off) {
				cfgDefaultThinkingLevel.set(this.#host.settings, effectiveLevel);
			}
			this.#host.emit({ type: "thinking_level_changed", thinkingLevel: effectiveLevel });
			this.#notifyThinkingLevelSelected(effectiveLevel, previousLevel);
		}
	}

	#notifyThinkingLevelSelected(level: ThinkingLevel | undefined, previousLevel: ThinkingLevel | undefined): void {
		if (level === previousLevel) return;
		this.#host.onThinkingLevelSelected?.(level ?? ThinkingLevel.Off, previousLevel ?? ThinkingLevel.Off);
	}

	/**
	 * Re-apply the active thinking selection after a model change. Preserves `auto`
	 * (re-clamping the provisional level to the new model); otherwise re-applies the
	 * preferred default or the current effective level.
	 */
	#reapplyThinkingLevel(preferredDefault?: ThinkingLevel): void {
		this.setThinkingLevel(this.#autoThinking ? AUTO_THINKING : (preferredDefault ?? this.#thinkingLevel));
	}

	/** All selectable effort selectors for the active model, in cycle order. */
	getAvailableEffortSelectors(): ConfiguredThinkingLevel[] {
		if (!this.#model?.reasoning) return [];
		const efforts = this.getAvailableThinkingLevels();
		const ceiling = this.#thinkingLevelCeiling;
		const selectable =
			ceiling === undefined
				? efforts
				: efforts.filter(level => THINKING_EFFORTS.indexOf(level) <= THINKING_EFFORTS.indexOf(ceiling));
		return [ThinkingLevel.Off, AUTO_THINKING, ...selectable];
	}

	/**
	 * Cycle to next thinking level: off → auto → minimal..max → off.
	 * @returns New selector, or undefined if model doesn't support thinking
	 */
	cycleThinkingLevel(): ConfiguredThinkingLevel | undefined {
		const levels = this.getAvailableEffortSelectors();
		if (levels.length === 0) return undefined;
		const configured = this.configuredThinkingLevel();
		const currentLevel = configured === ThinkingLevel.Inherit ? ThinkingLevel.Off : configured;
		const currentIndex = currentLevel ? levels.indexOf(currentLevel) : -1;
		const nextIndex = (currentIndex + 1) % levels.length;
		const nextLevel = levels[nextIndex];
		if (!nextLevel) return undefined;

		this.setThinkingLevel(nextLevel);
		return nextLevel;
	}

	/** Timeout (ms) for per-turn auto-thinking classification before falling back. */
	static readonly #AUTO_THINKING_TIMEOUT_MS = 4000;

	/**
	 * Classify the current user turn and set the effective thinking level for it.
	 * `solutionSpace` is a delegator's open-endedness description (task-spawned turns
	 * only); when non-blank it is classified instead of `promptText`.
	 * Bounded by a timeout + abort; on failure it preserves the last classified
	 * level, or uses the provisional concrete level before the first resolution.
	 * Never throws into the turn, and never clears `#autoThinking`.
	 */
	async applyAutoThinkingLevel(promptText: string, generation: number, solutionSpace?: string): Promise<void> {
		const model = this.#model;
		if (!model?.reasoning) return;
		// Models with reasoning but no controllable effort surface (devin-agent
		// Cascade routes effort via sibling model ids, not a wire param) have
		// nothing to pick — skip classification rather than discard its result.
		if (getSupportedEfforts(model).length === 0) return;

		let resolved: Effort | undefined;
		if (this.#host.magicKeywordEnabled("ultrathink") && containsMagicKeyword(promptText, "ultrathink")) {
			// The user explicitly asked for maximum thinking; bypass the classifier
			// (and the `providers.autoThinkingMaxEffort` ceiling) and jump straight
			// to the highest supported level for this model.
			resolved = clampAutoThinkingEffort(model, Effort.Max);
		} else {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), ModelControls.#AUTO_THINKING_TIMEOUT_MS);
			const usageOwner = {
				sessionId: this.#host.sessionManager.getSessionId(),
				parentId: this.#host.sessionManager.getLeafId(),
			};
			try {
				resolved = await classifyDifficulty(
					{ request: promptText, solutionSpace },
					{
						settings: this.#host.settings,
						registry: this.#host.modelRegistry,
						model,
						sessionId: this.#host.sessionId(),
						signal: controller.signal,
						metadataResolver: provider => this.#host.agent.metadataForProvider(provider),
						onUsage: usage => {
							const entryId = this.#host.sessionManager.appendModelUsage(usage, usageOwner);
							if (entryId) usageOwner.parentId = entryId;
						},
						telemetry: this.#host.agent.telemetry,
					},
				);
			} catch (error) {
				logger.debug("auto-thinking: classification failed; using fallback level", {
					error: error instanceof Error ? error.message : String(error),
				});
			} finally {
				clearTimeout(timer);
			}
		}

		// Drop the result if the turn was aborted/superseded while classifying.
		if (this.#host.promptGeneration() !== generation || !this.#autoThinking) return;

		const effort = clampThinkingLevelToCeiling(
			model,
			resolved ?? this.#autoResolvedLevel ?? resolveProvisionalAutoLevel(model),
			this.#thinkingLevelCeiling,
		);
		if (effort === undefined) return;
		const shouldPersistResolution = this.#thinkingLevel !== effort;
		const previousLevel = this.#thinkingLevel;
		this.#autoResolvedLevel = effort;
		this.#thinkingLevel = effort;
		this.#applyThinkingLevelToAgent(effort);
		if (shouldPersistResolution) {
			this.#host.sessionManager.appendThinkingLevelChange(effort, AUTO_THINKING);
		}
		this.#host.emit({
			type: "thinking_level_changed",
			thinkingLevel: effort,
			configured: AUTO_THINKING,
			resolved: effort,
		});
		this.#notifyThinkingLevelSelected(effort, previousLevel);
	}

	/**
	 * True when the currently selected model's family is set to a fast tier —
	 * `priority`, or `ultrafast` on the OpenAI family — the `/fast` on/off state
	 * for the active model. Returns false when no model is selected or the
	 * model exposes no service-tier family (e.g. Fireworks, which has its own
	 * Providers › Fireworks Tier toggle).
	 *
	 * For "is a fast tier actually applied to the next request?" use
	 * {@link isFastModeActive} instead.
	 */
	isFastModeEnabled(): boolean {
		const family = this.#model ? serviceTierFamily(this.#model) : undefined;
		const tier = family ? this.#serviceTierByFamily[family] : undefined;
		return tier === "priority" || tier === "ultrafast";
	}

	/** True when the active model's OpenAI family is set to `ultrafast` (`/fast ultra`). */
	isUltrafastModeEnabled(): boolean {
		const model = this.#model;
		return (
			model !== undefined &&
			serviceTierFamily(model) === "openai" &&
			this.#serviceTierByFamily.openai === "ultrafast"
		);
	}

	/**
	 * True when a fast tier is actually realized on the wire for the currently
	 * selected model: `priority` (OpenAI/Google `service_tier`, direct Anthropic
	 * fast mode, or Fireworks priority), or `ultrafast` where the model offers
	 * it. Returns false for tiers the active model can't realize and when no
	 * model is selected.
	 */
	isFastModeActive(): boolean {
		const model = this.#model;
		if (!model) return false;
		const tier = this.effectiveServiceTier(model);
		if (tier === "ultrafast") return shouldSendServiceTier(tier, model);
		if (!realizesPriorityServiceTier(tier, model)) return false;
		if (model.provider === "anthropic") {
			return !isAnthropicFastModeFallbackDisabled(this.#host.providerSessionState, model);
		}
		return true;
	}

	/**
	 * Effective wire service-tier for a request to `model`. Fireworks models take
	 * the Priority serving path only when the Providers › Fireworks Tier setting
	 * is `"priority"` (and never for `-fast` variants, whose Fast serving path is
	 * mutually exclusive with Priority). Every other model resolves the live
	 * per-family tier map down to the entry for its family.
	 */
	effectiveServiceTier(model: Model | undefined = this.#model): ServiceTier | undefined {
		if (model?.provider === "fireworks") {
			return cfgProvidersFireworksTier.get(this.#host.settings) === "priority" && !isFireworksFastModelId(model.id)
				? "priority"
				: undefined;
		}
		if (!model) return undefined;
		return resolveModelServiceTier(this.#serviceTierByFamily, model);
	}

	/** The live per-family tier map, or `null` when empty (for session persistence). */
	serviceTierEntry(): ServiceTierByFamily | null {
		return Object.keys(this.#serviceTierByFamily).length > 0 ? this.#serviceTierByFamily : null;
	}

	/** Set one family's tier (or clear it with `undefined`); persists the change. */
	setServiceTierFamily(family: ServiceTierFamily, tier: ServiceTier | undefined): void {
		if (this.#serviceTierByFamily[family] === tier) return;
		const next: ServiceTierByFamily = { ...this.#serviceTierByFamily };
		if (tier) next[family] = tier;
		else delete next[family];
		this.#applyServiceTierByFamily(next);
	}

	/** Replace the whole per-family tier map; persists + re-arms Anthropic fast mode. */
	#applyServiceTierByFamily(next: ServiceTierByFamily): void {
		// Re-arming Anthropic priority clears the per-session fast-mode auto-disable
		// so the next request actually carries `speed: "fast"` again.
		if (next.anthropic === "priority" && this.#serviceTierByFamily.anthropic !== "priority") {
			clearAnthropicFastModeFallback(this.#host.providerSessionState);
		}
		this.#serviceTierByFamily = next;
		this.#host.sessionManager.appendServiceTierChange(this.serviceTierEntry());
	}

	/**
	 * `/fast on|off` targets the family of the currently selected model: it sets
	 * (or clears) that family's `priority` tier. `off` also clears `ultrafast`.
	 * Returns `false` when the model has no service-tier family, or when it is an
	 * OpenAI-family model that cannot take `priority` (a Codex model whose
	 * discovered tier list omits it), so callers can report that fast mode is
	 * unavailable instead of claiming success.
	 */
	setFastMode(enabled: boolean): boolean {
		const model = this.#model;
		const family = model ? serviceTierFamily(model) : undefined;
		if (!model || !family) {
			this.#host.emitNotice(
				"info",
				"The current model has no service-tier control for /fast to toggle.",
				"priority",
			);
			return false;
		}
		if (!enabled) {
			const tier = this.#serviceTierByFamily[family];
			if (tier === "priority" || tier === "ultrafast") this.setServiceTierFamily(family, undefined);
			return true;
		}
		if (family === "openai" && !shouldSendServiceTier("priority", model)) {
			this.#host.emitNotice(
				"info",
				"The current model does not offer the priority (Fast) service tier.",
				"priority",
			);
			return false;
		}
		if (family === "anthropic" && this.#serviceTierByFamily.anthropic === "priority") {
			clearAnthropicFastModeFallback(this.#host.providerSessionState);
		}
		this.setServiceTierFamily(family, "priority");
		return true;
	}

	/**
	 * `/fast ultra` sets the OpenAI family to `ultrafast`. Enabling requires the
	 * active model to realize it (first-party OpenAI, or a Codex model whose
	 * discovery advertises the tier); otherwise the tier is left unchanged and
	 * `false` is returned. Disabling clears only an `ultrafast` selection.
	 */
	setUltrafastMode(enabled: boolean): boolean {
		const model = this.#model;
		if (!enabled) {
			if (this.#serviceTierByFamily.openai === "ultrafast") this.setServiceTierFamily("openai", undefined);
			return true;
		}
		if (!model || serviceTierFamily(model) !== "openai" || !shouldSendServiceTier("ultrafast", model)) {
			this.#host.emitNotice("info", "The current model does not offer the Ultrafast service tier.", "priority");
			return false;
		}
		this.setServiceTierFamily("openai", "ultrafast");
		return true;
	}

	toggleFastMode(): boolean {
		if (!this.setFastMode(!this.isFastModeEnabled())) return false;
		return this.isFastModeEnabled();
	}

	/**
	 * Get available thinking levels for current model.
	 */
	getAvailableThinkingLevels(): ReadonlyArray<Effort> {
		if (!this.#model) return [];
		return getSupportedEfforts(this.#model);
	}
}

function rolePickResolution(pick: RolePoolPick): ResolvedModelRoleValue {
	return {
		model: pick.model,
		thinkingLevel: pick.thinkingLevel,
		explicitThinkingLevel: pick.explicitThinkingLevel,
		warning: undefined,
	};
}
