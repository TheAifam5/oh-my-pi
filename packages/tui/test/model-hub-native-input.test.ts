import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { TspPickerProps } from "@oh-my-pi/pi-wire";
import type { DescribeContext, NativeNode } from "../src/native/node";
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
function props(root: NativeNode): TspPickerProps {
	expect(root.k).toBe("picker");
	return root.p as TspPickerProps;
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

	function field(hub: ModelHubComponent): { key: string; node: NativeNode } {
		function find(root: NativeNode, path: string): { key: string; node: NativeNode } | undefined {
			if (root.k === "input") return { key: path, node: root };
			for (const [index, child] of (root.c ?? []).entries()) {
				if (!("k" in child)) continue;
				const found = find(child, [path, child.key ?? String(index)].filter(Boolean).join("/"));
				if (found) return found;
			}
			return undefined;
		}
		const result = find(hub.describe(withPicker), "");
		expect(result).toBeDefined();
		return result!;
	}

	function edit(hub: ModelHubComponent, text: string): void {
		const current = field(hub);
		const value = String(current.node.p && Reflect.get(current.node.p, "text"));
		hub.handleNativeEvent({
			type: "edit",
			key: current.key,
			from: 0,
			to: value.length,
			len: value.length,
			text,
			cursor: text.length,
		});
	}

	function openTolerance(hub: ModelHubComponent): void {
		action(hub, "roles:routing");
		const index = props(hub.describe(withPicker)).strip?.items.findIndex(item => item.label === "quota tolerance");
		expect(index).toBeGreaterThanOrEqual(0);
		action(hub, "strip", String(index));
	}

	test("native quota edits and undo share the ANSI field and Save writer", () => {
		const { hub, writes } = editableHub();
		openTolerance(hub);
		expect(field(hub).node.p).toMatchObject({ text: "0.1", cursor: 3 });
		edit(hub, "0.25");
		expect(field(hub).node.p).toMatchObject({ text: "0.25", cursor: 4 });
		expect(Bun.stripANSI(hub.render(160).join("\n"))).toContain("0.25");
		hub.handleNativeEvent({ type: "undo", key: field(hub).key });
		expect(field(hub).node.p).toMatchObject({ text: "0.1" });
		edit(hub, "0.3");
		action(hub, "poolField");
		expect(writes).toEqual([
			{
				target: { kind: "role", key: "default" },
				value: expect.objectContaining({ strategyOptions: { tolerance: 0.3 } }),
			},
		]);
		expect(props(hub.describe(withPicker)).strip).toBeNull();
	});

	test("invalid native quota edits show an error without writing and can be corrected", () => {
		const { hub, writes } = editableHub();
		openTolerance(hub);
		edit(hub, "not-a-number");
		action(hub, "poolField");
		expect(writes).toEqual([]);
		expect(JSON.stringify(hub.describe(withPicker))).toContain("Tolerance must be a number");
		expect(Bun.stripANSI(hub.render(160).join("\n"))).toContain("Tolerance must be a number");
		edit(hub, "0.2");
		expect(JSON.stringify(hub.describe(withPicker))).not.toContain("Tolerance must be a number");
		hub.handleNativeEvent({ type: "action", key: field(hub).key, act: "submit", mods: [] });
		expect(writes).toHaveLength(1);
	});

	test("native new-group edits persist the definition and reference through the pool writer", () => {
		const { hub, writes, pool } = editableHub();
		action(hub, "roles:groups");
		action(hub, "strip", "0");
		expect(field(hub).node.p).toMatchObject({ text: "", cursor: 0 });
		edit(hub, "shared");
		action(hub, "poolField");
		expect(writes).toEqual([
			{ target: { kind: "group", key: "shared" }, value: pool.raw },
			{ target: { kind: "role", key: "default" }, value: { use: "shared" } },
		]);
	});

	test("ANSI typing and submission keep using the same field writer", () => {
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
