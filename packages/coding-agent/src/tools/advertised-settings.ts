import type { Settings } from "../config/settings";
import { cfgIdaAvailable } from "../ida/install";
import { cfgTaskMaxRecursionDepth } from "../task/settings";
import { type EvalBackendsAllowance, resolveEvalBackends } from "./eval-backends";
import { cfgLaunchEnabled } from "./settings";

/**
 * Tool-gate settings that change the provider-visible definition of a tool that stays
 * active (its description or schema). Managed sessions freeze them at each system-prompt
 * rebuild, so a gate change on a prefix-bound session that keeps its cached prompt leaves
 * the already-sent definitions byte-stable. Execution always reads live settings.
 */
export interface AdvertisedToolSettings {
	/** `ida.*` found an install: `read` advertises executable views. */
	binaryViews: boolean;
	/** `eval.py` / `eval.js`: the `eval` language enum and description. */
	evalBackends: EvalBackendsAllowance;
	/** `launch.enabled`: the `bash` service fields and description. */
	launchEnabled: boolean;
	/** `task.maxRecursionDepth`: whether `eval` describes spawning agents. */
	taskMaxRecursionDepth: number;
}

/** {@link AdvertisedToolSettings} read from live settings. */
export function liveAdvertisedToolSettings(settings: Settings): AdvertisedToolSettings {
	return {
		binaryViews: cfgIdaAvailable.get(settings),
		evalBackends: resolveEvalBackends({ settings }),
		launchEnabled: cfgLaunchEnabled.get(settings) === true,
		taskMaxRecursionDepth: cfgTaskMaxRecursionDepth.get(settings),
	};
}

/**
 * The values a tool definition renders: the session's frozen snapshot, or live settings
 * for a session without the rebuild lifecycle (a bare SDK `ToolSession`).
 */
export function resolveAdvertisedToolSettings(session: {
	settings: Settings;
	getAdvertisedToolSettings?: () => AdvertisedToolSettings | undefined;
}): AdvertisedToolSettings {
	return session.getAdvertisedToolSettings?.() ?? liveAdvertisedToolSettings(session.settings);
}
