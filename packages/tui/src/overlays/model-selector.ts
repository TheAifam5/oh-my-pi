import { ThinkingLevel } from "@oh-my-pi/pi-agent-core/thinking";
import { type ConfiguredThinkingLevel, type ThinkingSuffixOptions, splitThinkingSuffix } from "../thinking";

export {
	MAX_THINKING_SUFFIX_OPTIONS,
	parseThinkingSuffix,
	splitThinkingSuffix,
	type ThinkingSuffixOptions,
} from "../thinking";

/** Selector parsing options with authoritative literal-model lookup. */
export interface ModelStringParseOptions extends ThinkingSuffixOptions {
	isLiteralModelId?: (provider: string, id: string) => boolean;
}

/**
 * Parse a model string in "provider/modelId" format.
 * Returns undefined if the format is invalid.
 */
export function parseModelString(
	modelStr: string,
	options?: ModelStringParseOptions,
): { provider: string; id: string; thinkingLevel?: ConfiguredThinkingLevel } | undefined {
	const slashIdx = modelStr.indexOf("/");
	if (slashIdx <= 0) return undefined;
	const id = modelStr.slice(slashIdx + 1);
	const provider = modelStr.slice(0, slashIdx);
	// Strip strict thinking level suffixes first (e.g. "claude-sonnet-4-6:high" -> id "claude-sonnet-4-6", thinkingLevel "high").
	const strict = splitThinkingSuffix(id);
	if (strict.level) return { provider, id: strict.base, thinkingLevel: strict.level };
	// `max` is a real thinking level, but real model IDs can also end in
	// `:max`. Context-aware callers pass a literal lookup so those models win.
	const maxAlias = splitThinkingSuffix(id, -1, options);
	if (maxAlias.level) {
		return options?.isLiteralModelId?.(provider, id) === true
			? { provider, id }
			: { provider, id: maxAlias.base, thinkingLevel: maxAlias.level };
	}
	return { provider, id };
}

export function formatModelSelectorValue(selector: string, thinkingLevel: ConfiguredThinkingLevel | undefined): string {
	return thinkingLevel && thinkingLevel !== ThinkingLevel.Inherit ? `${selector}:${thinkingLevel}` : selector;
}

/** Bare slug (`cerebras`) or tiered/regional slug (`google-ai-studio/priority`, `google-vertex/global/flex`). */
const UPSTREAM_ROUTING_SLUG = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/i;

/**
 * Split a trailing `@<upstream>` provider-routing selector off a model pattern.
 *
 * `openrouter/z-ai/glm-4.7@cerebras` -> base `openrouter/z-ai/glm-4.7`, upstream
 * `cerebras`. Tiered upstreams keep their path (`...@google-ai-studio/priority`).
 * A `:thinking` suffix after the slug is kept on the base
 * (`...@cerebras:high` -> base `...:high`). Returns undefined when there is no
 * `@` or the suffix is not a bare provider slug, so model ids that legitimately
 * contain `@` (`claude-opus-4-8@default`, `workers-ai/@cf/...`) are never split.
 */
export function splitUpstreamRouting(pattern: string): { base: string; upstream: string } | undefined {
	const at = pattern.lastIndexOf("@");
	if (at <= 0) return undefined;
	const rest = pattern.slice(at + 1);
	const colon = rest.indexOf(":");
	const upstream = colon === -1 ? rest : rest.slice(0, colon);
	if (!UPSTREAM_ROUTING_SLUG.test(upstream)) return undefined;
	const trailing = colon === -1 ? "" : rest.slice(colon);
	return { base: pattern.slice(0, at) + trailing, upstream };
}
