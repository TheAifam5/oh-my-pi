import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { TspPrefsProps } from "@oh-my-pi/pi-wire";
import type { DescribeContext } from "../src/native/node";
import {
	ModelHubComponent,
	type ModelHubPool,
	type ModelHubRegistry,
	type ModelHubSource,
} from "../src/overlays/model-hub";
import { initTheme } from "../src/theme";
import type { TUI } from "../src/tui";

const withPicker: DescribeContext = {
	cols: 120,
	reduceMotion: false,
	dark: true,
	supports: () => true,
	feature: () => true,
};
const MODELS = [
	buildModel({
		id: "demo",
		name: "Demo",
		provider: "demo",
		api: "openai-completions",
		baseUrl: "http://127.0.0.1/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 8192,
	}),
];
const ui = { requestRender: () => {}, terminal: { rows: 40 } } as unknown as TUI;
const hubs: ModelHubComponent[] = [];
beforeAll(async () => {
	await initTheme(false);
});
afterEach(() => {
	for (const hub of hubs.splice(0)) hub.dispose();
});
function source(
	roles: Record<string, string>,
	mru: string[],
	pools: { roles: Record<string, ModelHubPool> },
): ModelHubSource {
	return {
		revision: 0,
		defaultThinkingLevel: "off",
		modelProviderOrder: [],
		knownRoleIds: ["default"],
		mruOrder: mru,
		modelPerf: new Map(),
		getRoleInfo: role => ({ tag: role, name: role, section: "chat", accepts: () => true }),
		defaultRoleChain: () => [],
		resolveRoleValue: () => ({ model: MODELS[0], explicitThinkingLevel: false }),
		getModelRole: role => roles[role],
		disabledProviders: [],
		fallbackChains: {},
		modelRoleStorage: "global",
		cycleOrder: [],
		getProjectModelRole: () => undefined,
		getGlobalModelRole: role => roles[role],
		getModelRoleSource: () => "global",
		getPool: target => (target.kind === "role" ? pools.roles[target.key] : undefined),
		roleAcceptsPools: () => true,
		poolWriteBlocker: () => undefined,
	};
}
function registry(models: typeof MODELS): ModelHubRegistry {
	return {
		getError: () => undefined,
		getAvailable: () => models,
		getAll: () => models,
		authStorage: { keys: { source: () => "env" } },
		getDiscoverableProviders: () => [],
		getProviderDiscoveryState: () => undefined,
		find: (provider: string, id: string) => models.find(model => model.provider === provider && model.id === id),
		refresh: async () => {},
		refreshProvider: async () => {},
	} as unknown as ModelHubRegistry;
}
function prefs(hub: ModelHubComponent): TspPrefsProps {
	const root = hub.describe(withPicker);
	expect(root.k).toBe("prefs");
	return root.p as TspPrefsProps;
}

describe("model hub native field editors", () => {
	function editableHub() {
		const writes: { target: unknown; value: unknown }[] = [];
		const pool: ModelHubPool = {
			source: { kind: "inline" },
			strategy: "quota",
			members: [{ alias: "demo", model: "demo/demo" }],
			funding: [],
			raw: { strategy: "quota", strategyOptions: { tolerance: 0.1 }, models: { demo: "demo/demo" } },
		};
		const hub = new ModelHubComponent(
			ui,
			source({ default: "demo/demo" }, [], { roles: { default: pool } }),
			registry(MODELS),
			MODELS.map(entry => ({ model: entry })),
			{
				onAssign: () => {},
				onUnassign: () => {},
				onCancel: () => {},
				onPoolChange: (target, value) => {
					writes.push({ target, value });
				},
			},
		);
		hubs.push(hub);
		action(hub, "scope", "roles");
		hub.handleNativeEvent({ type: "select", key: "", item: "role:default" });
		return { hub, writes, pool };
	}

	function action(hub: ModelHubComponent, act: string, value?: string): void {
		hub.handleNativeEvent({ type: "action", key: "", act, value, mods: [] });
	}

	function openTolerance(hub: ModelHubComponent): void {
		action(hub, "roles:routing");
		action(hub, "edit", "tolerance");
	}

	function edit(hub: ModelHubComponent, text: string): void {
		const editing = prefs(hub).editing;
		expect(editing).toBeTruthy();
		hub.handleNativeEvent({
			type: "edit",
			key: "",
			from: 0,
			to: editing?.draft?.length ?? 0,
			len: editing?.draft?.length ?? 0,
			text,
			cursor: text.length,
		});
	}

	test("native quota drafts and undo share the ANSI editor and writer", () => {
		const { hub, writes } = editableHub();
		openTolerance(hub);
		expect(prefs(hub).editing).toMatchObject({ draft: "0.1", cursor: 3 });
		edit(hub, "0.25");
		expect(prefs(hub).editing).toMatchObject({ draft: "0.25", cursor: 4 });
		expect(Bun.stripANSI(hub.render(160).join("\n"))).toContain("0.25");
		hub.handleNativeEvent({ type: "undo", key: "" });
		expect(prefs(hub).editing).toMatchObject({ draft: "0.1" });
		hub.handleNativeEvent({ type: "change", key: "", item: "tolerance", value: "0.3" });
		expect(writes).toEqual([
			{
				target: { kind: "role", key: "default" },
				value: expect.objectContaining({ strategyOptions: { tolerance: 0.3 } }),
			},
		]);
		expect(prefs(hub).editing).toBeNull();
	});

	test("invalid numeric drafts retain their value, cursor, and field warning until correction", () => {
		const { hub, writes } = editableHub();
		openTolerance(hub);
		edit(hub, "not-a-number");
		hub.handleInput("\r");
		expect(writes).toEqual([]);
		expect(prefs(hub).editing).toMatchObject({ draft: "not-a-number", cursor: 12 });
		expect(JSON.stringify(prefs(hub))).toContain("Enter a finite number");
		expect(Bun.stripANSI(hub.render(160).join("\n"))).toContain("Enter a finite number");
		edit(hub, "0.2");
		hub.handleInput("\r");
		expect(writes).toHaveLength(1);
		expect(JSON.stringify(prefs(hub))).not.toContain("Enter a finite number");
	});

	test("native new-group edits persist the definition and reference through the pool writer", () => {
		const { hub, writes, pool } = editableHub();
		action(hub, "roles:groups");
		action(hub, "pool:0");
		expect(prefs(hub).editing).toMatchObject({ draft: "", cursor: 0 });
		hub.handleNativeEvent({ type: "change", key: "", item: "value", value: "shared" });
		expect(writes).toEqual([
			{ target: { kind: "group", key: "shared" }, value: pool.raw },
			{ target: { kind: "role", key: "default" }, value: { use: "shared" } },
		]);
	});

	test("ANSI typing and submission use the same field writer", () => {
		const { hub, writes } = editableHub();
		openTolerance(hub);
		hub.handleInput("\x01");
		hub.handleInput("\x0b");
		hub.handleInput("0.4");
		hub.handleInput("\r");
		expect(writes).toEqual([
			{
				target: { kind: "role", key: "default" },
				value: expect.objectContaining({ strategyOptions: { tolerance: 0.4 } }),
			},
		]);
	});
});
