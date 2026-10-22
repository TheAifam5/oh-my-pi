import { replaceTabs, TERMINAL } from "@oh-my-pi/pi-tui";
import { shortenPath } from "@oh-my-pi/pi-tui/render/render-utils";
import { isNativeRendering } from "@oh-my-pi/pi-tui/native/state";
import {
	SETTING_TABS,
	type SettingsDisplayEntry,
	type SettingsHost,
	type SettingsTarget,
} from "@oh-my-pi/pi-tui/overlays/settings-defs";
import { isSettingsInitialized, Settings, settings } from "./settings";
import { orderedSettings } from "./all-settings";
import { type AnySetting, lookup } from "./registry";

import { cfgPlanAutosave, cfgPlanEnabled } from "../plan-mode/settings";
import {
	cfgRetryUsageAwareFallback,
	cfgDefaultThinkingLevel,
	normalizeProviderMaxInFlightRequests,
	validateProviderMaxInFlightRequests,
} from "../session/settings";
import { cfgAutolearnEnabled } from "../autolearn/settings";
import { cfgMemoryBackend } from "../memory-backend/settings";
import { cfgTuiVimMode } from "../modes/settings";
import { cfgAdvisorEnabled } from "../advisor/settings";
import { cfgContextFilesExtra } from "../session/context-settings";

/** Condition over the global settings; hidden (false) until they are initialized. */
function whenSettings(test: (settings: Settings) => boolean): () => boolean {
	return () => isSettingsInitialized() && test(Settings.instance);
}

const CONDITIONS: Record<string, () => boolean> = {
	macOS: () => process.platform === "darwin",
	hasImageProtocol: () => !!TERMINAL.imageProtocol,
	nativeRendering: () => isNativeRendering(),
	advisorEnabled: whenSettings(s => cfgAdvisorEnabled.get(s) === true),
	vimModeEnabled: whenSettings(s => cfgTuiVimMode.get(s) === true),
	hindsightActive: whenSettings(s => cfgMemoryBackend.get(s) === "hindsight"),
	mnemopiActive: whenSettings(s => cfgMemoryBackend.get(s) === "mnemopi"),
	autolearnActive: whenSettings(s => cfgAutolearnEnabled.get(s) === true),
	autoThinkingActive: whenSettings(s => cfgDefaultThinkingLevel.get(s) === "auto"),
	usageAwareFallbackEnabled: whenSettings(s => cfgRetryUsageAwareFallback.get(s) === true),
	planModeEnabled: whenSettings(s => cfgPlanEnabled.get(s)),
	planAutosaveEnabled: whenSettings(s => cfgPlanEnabled.get(s) && cfgPlanAutosave.get(s)),
	// Project-provided context-file lists are hidden from the settings editor.
	contextFilesExtraNotProject: whenSettings(s => cfgContextFilesExtra.provenance(s) !== "project"),
};

/** Description suffix telling the panel user that an environment variable is in play. */
function envNote(setting: AnySetting): string {
	if (!setting.envName || setting.envValue() === undefined) return "";
	return setting.envFallback
		? ` Unset, it falls back to $${setting.envName}.`
		: ` $${setting.envName} overrides this setting while it is set.`;
}

/** Session state the panel's visibility conditions read alongside the settings. */
export interface SettingsHostSession {
	/** Whether advisors are enabled for the current session (persisted or toggled by `/advisor`). */
	isAdvisorEnabled(): boolean;
}

/**
 * Adapt the application schema and settings store to the terminal overlay. The panel shows and
 * edits the value of the settings layers, never an environment-supplied one (so an env credential
 * is never pre-filled or written to config); descriptions note an active environment variable.
 * With `session`, advisor rows are also shown while the session's advisor is enabled.
 */
export function createSettingsHost(session?: SettingsHostSession): SettingsHost {
	const conditions: Record<string, () => boolean> = session
		? { ...CONDITIONS, advisorEnabled: () => session.isAdvisorEnabled() || CONDITIONS.advisorEnabled() }
		: CONDITIONS;
	const entries: SettingsDisplayEntry[] = [];
	for (const tab of SETTING_TABS) {
		for (const setting of orderedSettings()) {
			const ui = setting.ui;
			if (ui?.tab !== tab) continue;
			const note = envNote(setting);
			entries.push({
				path: setting.id,
				type: setting.type,
				defaultValue: setting.default,
				ui: note ? { ...ui, description: `${ui.description}${note}` } : ui,
				enumValues: setting.enumValues,
				credential: setting.isCredential,
				condition: ui.condition ? conditions[ui.condition] : undefined,
			});
		}
	}
	const resolve = (path: string): AnySetting => {
		const setting = lookup(path);
		if (!setting) throw new Error(`Unknown setting: ${path}`);
		return setting;
	};
	const targets: SettingsTarget[] = [{ id: "global", label: "Global" }];
	let target = "global";
	const ready = settings.listDirectoryLayerTargets().then(layers => {
		for (const [index, layer] of layers.entries()) {
			const label =
				index === 0
					? "This directory"
					: layer.label === "root"
						? "Root (/)"
						: layer.label === "home"
							? "Home (~)"
							: layer.label === "tmp"
								? "Temp"
								: replaceTabs(shortenPath(layer.dir));
			targets.push({
				id: layer.dir,
				label,
				note:
					layer.label === "root" || layer.label === "home"
						? "Applies to every directory below and overrides project config."
						: undefined,
			});
		}
		if (layers[0]?.exists) target = layers[0].dir;
	});
	ready.catch(() => undefined);
	const provenance = (path: string): string | undefined => {
		const source = resolve(path).provenance(settings);
		if (source === "global" || source === "default") return undefined;
		if (source === "directory") {
			return `directory ${replaceTabs(shortenPath(settings.getProvenanceDirectory(resolve(path)) ?? ""))}`;
		}
		return source;
	};
	return {
		entries,
		get: path => lookup(path)?.layered(settings),
		set: (path, value) =>
			target === "global"
				? resolve(path).set(settings, value)
				: settings.setDirectoryValue(target, resolve(path), value),
		unset: path =>
			target === "global" ? resolve(path).unset(settings) : settings.unsetDirectoryValue(target, resolve(path)),
		ready,
		targets,
		get target() {
			return target;
		},
		selectTarget: id => {
			if (!targets.some(candidate => candidate.id === id)) throw new Error(`Unknown settings target: ${id}`);
			target = id;
		},
		provenance,
		shadowWarning: path => {
			const source = provenance(path);
			if (!source) return undefined;
			if (target !== "global") {
				const sourceDir = settings.getProvenanceDirectory(resolve(path));
				const higher =
					["overlay", "runtime", "env"].includes(source) ||
					(sourceDir !== undefined &&
						sourceDir !== target &&
						sourceDir.startsWith(`${target.replace(/\/$/, "")}/`));
				if (!higher) return undefined;
			}
			return `This setting is set in the ${source} layer.`;
		},
		normalizeProviderLimits: normalizeProviderMaxInFlightRequests,
		validateProviderLimits: validateProviderMaxInFlightRequests,
	};
}
