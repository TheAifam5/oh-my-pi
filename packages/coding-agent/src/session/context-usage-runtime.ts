import { type CompactionSettings, resolveThresholdTokens } from "@oh-my-pi/pi-agent-core/compaction";
import type { Model } from "@oh-my-pi/pi-ai";
import {
	computeCompactionBoundaries,
	computeContextBreakdown,
	type CompactionBoundaries,
	type ContextBreakdown,
	type ContextSavingsEstimate,
} from "@oh-my-pi/pi-tui/status-line/context-usage";
import type { ScopeLike } from "../config/registry";
import type { AgentSession } from "./agent-session";
import { resolveSpeculationMethod } from "./compaction-methods";
import { estimateInlineSavings } from "./snapcompact-inline";
import { resolveSpeculationLeadTokens } from "./speculation-lead";

import { cfgSkillful } from "./settings";
import {
	cfgSnapcompactShape,
	cfgSnapcompactSystemPrompt,
	cfgSnapcompactToolResults,
	resolveCompactionSettings,
} from "./context-settings";

/** Resolve session policy before handing pure boundary arithmetic to the UI. */
export function getSessionCompactionBoundaries(
	settings: ScopeLike,
	contextWindow: number,
	model?: Model | null,
): CompactionBoundaries | null {
	if (!(contextWindow > 0)) return null;
	// The caller's window clamps the per-model overrides, so they agree with the arithmetic below.
	const configured = resolveCompactionSettings(
		settings,
		model ? { provider: model.provider, id: model.id, contextWindow } : undefined,
	);
	const compaction: CompactionSettings = configured;
	if (!compaction.enabled || compaction.strategy === "off") return null;
	const threshold = resolveThresholdTokens(contextWindow, compaction);
	if (!(threshold > 0) || threshold > contextWindow) return null;
	const speculates = configured.asyncEnabled !== false && resolveSpeculationMethod(model, configured) !== undefined;
	return computeCompactionBoundaries(
		compaction,
		contextWindow,
		speculates ? resolveSpeculationLeadTokens(threshold) : undefined,
	);
}

/** Read host settings and optionally run the provider's inline-image planner. */
export function computeSessionContextBreakdown(
	session: AgentSession,
	options?: { snapcompactSavings?: boolean },
): ContextBreakdown {
	let snapcompact: ContextSavingsEstimate | undefined;
	if (options?.snapcompactSavings) {
		const renderSystemPrompt = cfgSnapcompactSystemPrompt.get(session.settings);
		const renderToolResults = cfgSnapcompactToolResults.get(session.settings);
		if (renderSystemPrompt !== "none" || renderToolResults) {
			snapcompact = estimateInlineSavings({
				options: { renderSystemPrompt, renderToolResults, shape: cfgSnapcompactShape.get(session.settings) },
				model: session.model,
				systemPrompt: session.systemPrompt ?? [],
				messages: session.messages ?? [],
			});
		}
	}
	return computeContextBreakdown(session, {
		compaction: resolveCompactionSettings(session.settings, session.model),
		sourceRevision: session.settings.revision,
		skillful: cfgSkillful.get(session.settings),
		snapcompact,
	});
}
