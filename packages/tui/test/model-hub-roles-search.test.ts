/** Roles and Groups search is explicit and independent of the model catalogue query. */
import { beforeAll, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { TspPickerProps } from "@oh-my-pi/pi-wire";
import type { DescribeContext } from "../src/native/node";
import {
	ModelHubComponent,
	type ModelHubCallbacks,
	type ModelHubRegistry,
	type ModelHubSource,
} from "../src/overlays/model-hub";
import { initTheme } from "../src/theme";
import type { TUI } from "../src/index";

const tuiStub = { requestRender: () => {}, terminal: { rows: 30 } } as unknown as TUI;

const pickerCx: DescribeContext = {
	cols: 120,
	reduceMotion: false,
	dark: true,
	supports: () => true,
	feature: () => true,
};

const sonnet = buildModel({
	id: "claude-sonnet",
	name: "claude-sonnet",
	api: "ollama-chat",
	provider: "anthropic",
	baseUrl: "https://example.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 1024,
});

const source: ModelHubSource = {
	revision: 0,
	disabledProviders: [],
	fallbackChains: {},
	modelRoleStorage: "global",
	cycleOrder: [],
	getProjectModelRole: () => undefined,
	getGlobalModelRole: () => undefined,
	getModelRoleSource: () => "default",
	defaultThinkingLevel: "high",
	modelProviderOrder: [],
	knownRoleIds: ["default"],
	mruOrder: [],
	modelPerf: new Map(),
	getModelRole: () => undefined,
	getRoleInfo: role => ({ name: role, section: "chat", accepts: () => true }),
	defaultRoleChain: () => [],
	resolveRoleValue: () => ({ model: undefined, explicitThinkingLevel: false }),
};

const registryStub: ModelHubRegistry = {
	getError: () => undefined,
	getAvailable: () => [],
	getAll: () => [],
	authStorage: { keys: { source: () => undefined } },
	getDiscoverableProviders: () => [],
	getProviderDiscoveryState: () => undefined,
	find: () => undefined,
	refresh: async () => {},
	refreshProvider: async () => {},
};

function createHub(): ModelHubComponent {
	const callbacks: ModelHubCallbacks = {
		onAssign: () => true,
		onUnassign: () => {},
		onCancel: () => {},
		onSavePreset: () => {},
	};
	return new ModelHubComponent(tuiStub, source, registryStub, [{ model: sonnet }], callbacks);
}

function pickerProps(hub: ModelHubComponent): TspPickerProps {
	const root = hub.describe(pickerCx);
	if (root.k !== "picker" || !root.p) throw new Error(`expected a picker root, got ${root.k}`);
	return root.p;
}

/** A click on the sidebar's Roles entry: a deliberate dive into the rows. */
const CLICK_ROLES = { type: "select", key: "scopes", item: "roles" } as const;

beforeAll(async () => {
	await initTheme(false);
});

test("with no query the Roles rows hide the search field and keep their letter commands", () => {
	const hub = createHub();
	hub.handleNativeEvent(CLICK_ROLES);
	expect(pickerProps(hub).query).toBeNull();

	hub.handleInput("s");
	expect(pickerProps(hub).strip).not.toBeNull();
});

test("Roles search filters its own rows, marks hits, and Escape clears before closing", () => {
	const hub = createHub();
	hub.handleNativeEvent(CLICK_ROLES);
	hub.handleInput("/");
	for (const ch of "def") hub.handleInput(ch);
	let props = pickerProps(hub);
	expect(props.scope).toBe("roles");
	expect(props.query).toBe("def");
	expect(props.items?.map(item => item.id)).toEqual(["role:default"]);
	expect(props.hits?.["role:default"]).toEqual([[0, 3]]);
	expect(Bun.stripANSI(hub.render(160).join("\n"))).toContain("Search: def");
	hub.handleInput("\x1b");
	props = pickerProps(hub);
	expect(props.query).toBeNull();
	expect(props.items?.some(item => item.id === "newRole")).toBe(true);
	hub.dispose();
});

test("Search action enters query mode without triggering letter commands and no matches has empty text", () => {
	const hub = createHub();
	hub.handleNativeEvent(CLICK_ROLES);
	hub.handleNativeEvent({ type: "action", key: "", act: "search", mods: [] });
	hub.handleInput("s");
	const props = pickerProps(hub);
	expect(props.strip).toBeNull();
	expect(props.query).toBe("s");
	expect(props.items).toEqual([]);
	expect(props.empty).toBe("No rows match your search.");
	expect(Bun.stripANSI(hub.render(160).join("\n"))).toContain("No rows match your search.");
	hub.dispose();
});

test("catalogue queries do not leak into Roles", () => {
	const hub = createHub();
	for (const ch of "son") hub.handleInput(ch);
	hub.handleNativeEvent(CLICK_ROLES);
	expect(pickerProps(hub).query).toBeNull();
	hub.dispose();
});

test("pasted C1 controls are removed from the terminal query line", () => {
	const hub = createHub();
	hub.handleNativeEvent(CLICK_ROLES);
	hub.handleInput("/");
	hub.handleInput("\x1b[200~query\u0085text\x1b[201~");
	const screen = hub.render(180).join("\n");
	expect(screen).not.toMatch(/[\u0080-\u009f]/);
	expect(Bun.stripANSI(screen)).toContain("Search: querytext");
	hub.dispose();
});

test("an empty Groups view uses the same no-query empty text in both renderers", () => {
	const hub = createHub();
	hub.handleNativeEvent({ type: "action", key: "", act: "scope", value: "groups", mods: [] });
	expect(pickerProps(hub).empty).toBe("No rows in this view.");
	expect(Bun.stripANSI(hub.render(180).join("\n"))).toContain("No rows in this view.");
	hub.dispose();
});
