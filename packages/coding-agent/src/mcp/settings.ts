/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { isRecord } from "@oh-my-pi/pi-utils";
import { setMcpRenderMarkdownResults } from "@oh-my-pi/pi-tui/tools/mcp";
import { effect, register } from "../config/registry";
import type { Settings } from "../config/settings";
import {
	checkArgvPrefix,
	DEFAULT_MCP_PACKAGE_POLICY,
	DEFAULT_MCP_PACKAGE_RUNNER,
	DEFAULT_MCP_PACKAGE_RUNTIME,
	MCP_PACKAGE_POLICIES,
	type MCPPackageLaunchDefaults,
} from "./package-launch";
import type { MCPPackagePolicy } from "./types";

// MCP
export const cfgMcpEnableProjectConfig = register({
	id: "mcp.enableProjectConfig",
	type: "boolean",
	default: true,
	ui: {
		tab: "tools",
		group: "Discovery & MCP",
		label: "MCP Project Config",
		description: "Load .mcp.json/mcp.json from project root",
	},
});

export const cfgMcpStartupTimeoutMs = register({
	id: "mcp.startupTimeoutMs",
	type: "number",
	default: 250,
	ui: {
		tab: "tools",
		group: "Discovery & MCP",
		label: "MCP Startup Window",
		description: "Wait this many milliseconds for initial MCP tool discovery; 0 waits until connections settle",
	},
});

export const cfgMcpRenderMarkdownResults = register({
	id: "mcp.renderMarkdownResults",
	type: "boolean",
	default: true,
	ui: {
		tab: "tools",
		group: "Discovery & MCP",
		label: "MCP Markdown Results",
		description: "Render non-JSON MCP text results as Markdown in the transcript",
	},
});
effect(cfgMcpRenderMarkdownResults, setMcpRenderMarkdownResults);

export const cfgMcpNotifications = register({
	id: "mcp.notifications",
	type: "boolean",
	default: false,
	ui: {
		tab: "tools",
		group: "Discovery & MCP",
		label: "MCP Update Injection",
		description: "Inject MCP resource updates into the agent conversation",
	},
});

export const cfgMcpNotificationDebounceMs = register({
	id: "mcp.notificationDebounceMs",
	type: "number",
	default: 500,
	ui: {
		tab: "tools",
		group: "Discovery & MCP",
		label: "MCP Notification Debounce",
		description:
			"Debounce window in milliseconds for MCP resource updates before injecting them into the conversation",
	},
});

function argvPrefixValidator(id: string): (raw: unknown) => void {
	return raw => {
		if (raw === undefined) return;
		const problem = checkArgvPrefix(raw, id);
		if (problem) throw new Error(problem);
	};
}

export const cfgMcpPackageRunner = register({
	id: "mcp.packageRunner",
	type: "array",
	default: DEFAULT_MCP_PACKAGE_RUNNER,
	validate: argvPrefixValidator("mcp.packageRunner"),
});

export const cfgMcpPackageRuntime = register({
	id: "mcp.packageRuntime",
	type: "array",
	default: DEFAULT_MCP_PACKAGE_RUNTIME,
	validate: argvPrefixValidator("mcp.packageRuntime"),
});

export const cfgMcpPackagePolicy = register({
	id: "mcp.packagePolicy",
	type: "enum",
	values: MCP_PACKAGE_POLICIES,
	default: DEFAULT_MCP_PACKAGE_POLICY,
	ui: {
		tab: "tools",
		group: "Discovery & MCP",
		label: "MCP Package Policy",
		description: "Default launch policy for stdio MCP servers configured with a package",
		options: [
			{
				value: "local-first",
				label: "Local first",
				description: "Run the project's installed package, else the runner",
			},
			{ value: "local-only", label: "Local only", description: "Run only the project's installed package" },
			{ value: "fallback-only", label: "Runner only", description: "Always run the package through the runner" },
		],
	},
});

/**
 * The global-layer value of `id`, or `fallback` when the global layer leaves it unset or invalid.
 * An overlay settings object reports its parent's global layer under its own.
 */
function globalLayerValue<T>(settings: Settings, id: string, fallback: T, accept: (raw: unknown) => boolean): T {
	let value: unknown = settings.getGlobalSettings();
	for (const segment of id.split(".")) {
		value = isRecord(value) ? value[segment] : undefined;
	}
	return value !== undefined && accept(value) ? (value as T) : fallback;
}

/**
 * Package launch defaults for an MCP manager, read from `settings`.
 *
 * A project settings layer cannot choose what OMP executes: when one of these settings comes
 * from the project (a checked-out repository's config), the global layer or the default applies.
 */
export function mcpPackageLaunchDefaults(settings: Settings): MCPPackageLaunchDefaults {
	const isArgvPrefix = (raw: unknown): boolean => checkArgvPrefix(raw, "") === undefined;
	const isPolicy = (raw: unknown): boolean => MCP_PACKAGE_POLICIES.includes(raw as MCPPackagePolicy);
	return {
		runner:
			cfgMcpPackageRunner.provenance(settings) === "project"
				? globalLayerValue(settings, cfgMcpPackageRunner.id, DEFAULT_MCP_PACKAGE_RUNNER, isArgvPrefix)
				: cfgMcpPackageRunner.get(settings),
		runtime:
			cfgMcpPackageRuntime.provenance(settings) === "project"
				? globalLayerValue(settings, cfgMcpPackageRuntime.id, DEFAULT_MCP_PACKAGE_RUNTIME, isArgvPrefix)
				: cfgMcpPackageRuntime.get(settings),
		policy:
			cfgMcpPackagePolicy.provenance(settings) === "project"
				? globalLayerValue(settings, cfgMcpPackagePolicy.id, DEFAULT_MCP_PACKAGE_POLICY, isPolicy)
				: cfgMcpPackagePolicy.get(settings),
	};
}
