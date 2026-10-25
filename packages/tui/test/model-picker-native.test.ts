import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { TspPickerGroup, TspPickerProps, TspPrefsProps } from "@oh-my-pi/pi-wire";
import type { DescribeContext, NativeChild, NativeNode } from "../src/native/node";
import {
	ModelHubComponent,
	type ModelHubPool,
	type ModelHubGroupReference,
	type ModelHubRegistry,
	type ModelHubSource,
} from "../src/overlays/model-hub";
import { ModelPickerComponent } from "../src/overlays/model-picker";
import { initTheme } from "../src/theme";
import type { TUI } from "../src/tui";

function prefs(hub: ModelHubComponent): TspPrefsProps {
	const root = hub.describe(withPicker);
	expect(root.k).toBe("prefs");
	return root.p as TspPrefsProps;
}

function changePref(hub: ModelHubComponent, item: string, value: string | readonly string[]): void {
	hub.handleNativeEvent({ type: "change", key: "", item, value });
}

const withPicker: DescribeContext = {
	cols: 120,
	reduceMotion: false,
	dark: true,
	supports: () => true,
	feature: () => true,
};
const withoutPicker: DescribeContext = { ...withPicker, supports: kind => kind !== "picker" };

beforeAll(async () => {
	await initTheme(false);
});

function model(provider: string, id: string, extra: Partial<Model> = {}): Model {
	return buildModel({
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: "http://127.0.0.1/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8192,
		...extra,
	} as Parameters<typeof buildModel>[0]);
}

const MODELS = [
	model("anthropic", "claude-sonnet-5-5", { int: 60 }),
	model("anthropic", "claude-opus-5"),
	model("demo", "demo"),
	model("openai", "gpt-5.6"),
	model("openai", "gpt-5.6-mini", { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
];

function source(
	roles: Record<string, string>,
	mru: string[],
	pools: {
		roles?: Record<string, ModelHubPool>;
		chains?: Record<string, ModelHubPool>;
		groups?: Record<string, ModelHubPool>;
		groupUsers?: Record<string, ModelHubGroupReference[]>;
	} = {},
): ModelHubSource {
	return {
		revision: 0,
		defaultThinkingLevel: "off",
		modelProviderOrder: [],
		knownRoleIds: ["default", "smol"],
		mruOrder: mru,
		modelPerf: new Map(),
		getRoleInfo: role => ({ tag: role, name: `${role} role`, section: "chat", accepts: () => true }),
		defaultRoleChain: () => [],
		resolveRoleValue: (value, models) => ({
			model: models.find(candidate => `${candidate.provider}/${candidate.id}` === value),
			explicitThinkingLevel: false,
		}),
		getModelRole: role => roles[role],
		disabledProviders: [],
		fallbackChains: { default: ["openai/gpt-5.6"] },
		fallbackChainGroupKeys: Object.keys(pools.chains ?? {}),
		modelRoleStorage: "global",
		cycleOrder: [],
		getProjectModelRole: () => undefined,
		getGlobalModelRole: role => roles[role],
		getModelRoleSource: () => "global",
		getPool: target =>
			(target.kind === "role" ? pools.roles : target.kind === "chain" ? pools.chains : pools.groups)?.[target.key],
		modelGroupNames: Object.keys(pools.groups ?? {}),
		modelGroupReferences: name => pools.groupUsers?.[name] ?? [],
		roleAcceptsPools: () => true,
		poolWriteBlocker: () => undefined,
	};
}

function registry(models: Model[]): ModelHubRegistry {
	return {
		getError: () => undefined,
		getAvailable: () => models,
		getAll: () => models,
		authStorage: { keys: { source: () => "env" } },
		getDiscoverableProviders: () => [],
		getProviderDiscoveryState: () => undefined,
		find: (provider: string, id: string) =>
			models.find(candidate => candidate.provider === provider && candidate.id === id),
		refresh: async () => {},
		refreshProvider: async () => {},
	} as unknown as ModelHubRegistry;
}

const ui = { requestRender: () => {}, terminal: { rows: 40 } } as unknown as TUI;
const hubs: ModelHubComponent[] = [];
afterEach(() => {
	for (const hub of hubs.splice(0)) hub.dispose();
});

function openHub(calls: { assign: string[]; cancel: number }, models: Model[] = MODELS): ModelHubComponent {
	const hub = new ModelHubComponent(
		ui,
		source({ default: "demo/demo" }, ["demo/demo"]),
		registry(models),
		// A `--models` scope skips the background online refresh.
		models.map(entry => ({ model: entry })),
		{
			onAssign: (_model, role, _level, selector) => {
				calls.assign.push(`${role}=${selector}`);
			},
			onUnassign: () => {},
			onCancel: () => {
				calls.cancel++;
			},
		},
		{ currentSelector: "demo/demo" },
	);
	hubs.push(hub);
	return hub;
}

function props(root: NativeNode): TspPickerProps {
	expect(root.k).toBe("picker");
	return root.p as TspPickerProps;
}

function groups(p: TspPickerProps): string[] {
	return (p.order ?? [])
		.filter((entry): entry is TspPickerGroup => typeof entry !== "string")
		.map(g => String(g.label));
}

/** A described child's prop, when the child is a node carrying it. */
function prop(child: NativeChild, name: string): unknown {
	return "k" in child && child.p ? Reflect.get(child.p, name) : undefined;
}

function titleOf(children: readonly NativeChild[] | undefined): unknown {
	const title = children?.find(child => prop(child, "role") === "omp.picker.title");
	return title ? prop(title, "text") : undefined;
}

test("the model hub describes a data-first picker when the terminal has the kind, else its generic frame", () => {
	const hub = openHub({ assign: [], cancel: 0 });
	expect(hub.nativeSheet(withPicker)).toBe(true);
	expect(hub.nativeSheet(withoutPicker)).toBe(false);
	expect(hub.describe(withoutPicker).k).not.toBe("picker");

	const root = hub.describe(withPicker);
	const p = props(root);
	expect(p).toMatchObject({ size: "lg", layout: "rows", preview: "side", icon: "cpu", title: "Models", scope: "all" });
	expect(p.scopes?.map(scope => [scope.id, scope.count, scope.group])).toEqual([
		["roles", 2, undefined],
		["groups", 0, undefined],
		["all", 5, undefined],
		["provider:anthropic", 2, "Providers"],
		["provider:demo", 1, "Providers"],
		["provider:openai", 2, "Providers"],
	]);
	expect(p.scopes?.find(scope => scope.id === "provider:anthropic")?.mark).toEqual({
		text: "An",
		seed: "anthropic",
		icon: "provider:anthropic",
	});
	// The recent/role block, then one group per provider.
	expect(groups(p)).toEqual(["Recent", "anthropic", "openai"]);
	expect(p.current).toEqual(["demo/demo"]);
	expect(p.total).toBe(5);
	const demo = p.items?.find(entry => entry.id === "demo/demo");
	// Model rows lead with their provider's mark too.
	expect(demo?.mark).toEqual({ text: "De", seed: "demo", icon: "provider:demo" });
	// The default role runs with thinking off (`defaultThinkingLevel`): its chip carries that level's dot.
	expect(demo?.chips).toEqual([{ text: "default", on: true, dot: "thinkingOff" }]);
	expect(p.items?.find(entry => entry.id === "anthropic/claude-sonnet-5-5")?.facts?.int).toBe("60");
	expect(p.items?.find(entry => entry.id === "openai/gpt-5.6-mini")?.badges).toEqual([
		{ text: "free", tone: "success" },
	]);
	expect(titleOf(root.c)).toBe("demo");
	// Unchanged state keeps the node.
	expect(hub.describe(withPicker)).toBe(root);
});

test("Factory Droid rows carry the base credit rate and a credit-only model is never free", () => {
	const priced = { ...model("factory-droid", "claude-opus-5"), factoryDroidCredits: 2 };
	const creditOnly = {
		...model("factory-droid", "preview-credit-model", { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
		factoryDroidCredits: 0.5,
	};
	const hub = openHub({ assign: [], cancel: 0 }, [...MODELS, priced, creditOnly]);
	const items = props(hub.describe(withPicker)).items ?? [];
	const row = (id: string) => items.find(entry => entry.id === `factory-droid/${id}`);
	expect(row("claude-opus-5")?.facts?.price).toBe("$3·15 2×");
	expect(row("preview-credit-model")?.facts?.price).toBe("0.5×");
	expect(row("preview-credit-model")?.badges ?? []).not.toContainEqual({ text: "free", tone: "success" });
});

test("typing changes the order, hits, counts and head total but never the catalogue", () => {
	const hub = openHub({ assign: [], cancel: 0 });
	const before = props(hub.describe(withPicker));
	for (const ch of "sonnet") hub.handleInput(ch);
	const after = props(hub.describe(withPicker));
	expect(after.items).toBe(before.items);
	expect(after.query).toBe("sonnet");
	expect(after.order).toEqual(["anthropic/claude-sonnet-5-5"]);
	expect(after.hits?.["anthropic/claude-sonnet-5-5"]).toEqual([[17, 23]]);
	expect(after.total).toBe(5);
	expect(after.scopes?.find(scope => scope.id === "all")?.count).toBe(1);
	expect(after.scopes?.find(scope => scope.id === "provider:openai")?.count).toBe(0);
	expect(after.selected).toBe("anthropic/claude-sonnet-5-5");
});

test("a re-sync that moves a role patches the catalogue instead of resending it", () => {
	const models = [...MODELS, ...Array.from({ length: 30 }, (_, i) => model("bulk", `m-${i}`))];
	const roles: Record<string, string> = { default: "demo/demo" };
	const hub = new ModelHubComponent(
		ui,
		source(roles, []),
		registry(models),
		models.map(entry => ({ model: entry })),
		{
			onAssign: () => {},
			onUnassign: () => {},
			onCancel: () => {},
		},
	);
	hubs.push(hub);
	const first = props(hub.describe(withPicker));
	expect(first.itemsAdd).toBeUndefined();

	roles.default = "openai/gpt-5.6";
	hub.refreshAfterExternalMutation();
	const moved = props(hub.describe(withPicker));
	expect(moved.items).toBe(first.items);
	expect(moved.itemsAdd?.map(row => [row.id, row.chips?.map(chip => chip.text)]).sort()).toEqual([
		["demo/demo", undefined],
		["openai/gpt-5.6", ["default"]],
	]);

	// Back to the original: the terminal kept the patch, so the reverted rows are still sent.
	roles.default = "demo/demo";
	hub.refreshAfterExternalMutation();
	const reverted = props(hub.describe(withPicker));
	expect(reverted.items).toBe(first.items);
	expect(reverted.itemsAdd?.map(row => [row.id, row.chips?.map(chip => chip.text)]).sort()).toEqual([
		["demo/demo", ["default"]],
		["openai/gpt-5.6", undefined],
	]);
});

test("pointer events drive the hub through the same paths as its keys", () => {
	const calls = { assign: [] as string[], cancel: 0 };
	const hub = openHub(calls);
	const act = (act: string, value?: string) =>
		hub.handleNativeEvent({ type: "action", key: "", act, value, mods: [] });

	hub.handleNativeEvent({ type: "select", key: "", item: "openai/gpt-5.6" });
	let p = props(hub.describe(withPicker));
	expect(p.selected).toBe("openai/gpt-5.6");
	expect(p.focus).toBe("list");
	expect(titleOf(hub.describe(withPicker).c)).toBe("gpt-5.6");

	// Activate = Enter: the role-assignment strip opens and takes the focus.
	hub.handleNativeEvent({ type: "activate", key: "", item: "openai/gpt-5.6" });
	p = props(hub.describe(withPicker));
	expect(p.focus).toBe("strip");
	expect(p.strip?.items.map(chip => chip.label).slice(0, 2)).toEqual(["default", "smol"]);
	act("strip", "1");
	expect(calls.assign).toEqual(["smol=openai/gpt-5.6"]);

	// The kind tab and scope clicks land where alt+→ and the sidebar do.
	act("close");
	act("tab", "image");
	expect(props(hub.describe(withPicker)).tab).toBe("image");
	act("tab", "all");
	act("scope", "provider:openai");
	p = props(hub.describe(withPicker));
	expect(p.scope).toBe("provider:openai");
	expect(p.order?.filter(entry => typeof entry === "string")).toEqual(["openai/gpt-5.6", "openai/gpt-5.6-mini"]);
	expect(p.actions?.map(action => action.id)).toContain("refresh");

	// Roles scope: roles with their fallback chain one level deep.
	act("scope", "roles");
	p = props(hub.describe(withPicker));
	expect(p.items?.find(entry => entry.id === "fallback:default:0")).toMatchObject({
		label: "fallback 1",
		facts: { model: "openai/gpt-5.6" },
		depth: 1,
	});
	expect(p.items?.find(entry => entry.id === "role:default")?.facts).toEqual({ model: "demo/demo", thinking: "off" });
	expect(groups(p)).toContain("Model fallback chains");
	// The head's total counts the rows Tern counts as shown (fallbacks, chains, "New …" rows), so All reads no "N of M".
	expect(p.total).toBe(p.order?.filter(entry => typeof entry === "string").length);

	// Esc ladder: close leaves the hub only when nothing else is open.
	act("scope", "all");
	hub.handleInput("x");
	act("close");
	expect(props(hub.describe(withPicker)).query).toBe("");
	expect(calls.cancel).toBe(0);
	act("close");
	expect(calls.cancel).toBe(1);
});

test("the Roles view picker names the active preset and ctrl+←/→ switches it", () => {
	const presets = { names: ["fast", "slow"], active: "fast" as string | undefined };
	let revision = 0;
	const switched: string[] = [];
	const base = source({ default: "demo/demo" }, []);
	const hub = new ModelHubComponent(
		ui,
		Object.defineProperty({ ...base, getModelPresets: () => presets }, "revision", { get: () => revision }),
		registry(MODELS),
		MODELS.map(entry => ({ model: entry })),
		{
			onAssign: () => {},
			onUnassign: () => {},
			onCancel: () => {},
			onSwitchPreset: name => {
				switched.push(name);
				presets.active = name;
				revision++;
			},
		},
	);
	hubs.push(hub);
	const subtitleText = () => {
		const subtitle = props(hub.describe(withPicker)).subtitle;
		return Array.isArray(subtitle) ? subtitle.map(part => part.t).join("") : subtitle;
	};

	hub.handleInput("\x1b[A"); // All models → Groups
	hub.handleInput("\x1b[A"); // Groups → Roles
	expect(subtitleText()).toStartWith("Preset fast");
	hub.handleInput("\x1b[1;5C");
	expect(switched).toEqual(["slow"]);
	expect(subtitleText()).toStartWith("Preset slow");
	hub.handleInput("\x1b[1;5D");
	expect(switched).toEqual(["slow", "fast"]);
});

describe("Groups view", () => {
	const fastRaw = { strategy: "priority", models: { mini: { model: "openai/gpt-5.6-mini" } } };
	const groupPools = {
		groups: {
			fast: {
				source: { kind: "inline" },
				strategy: "priority",
				members: [{ alias: "mini", model: "openai/gpt-5.6-mini", effort: "low" }],
				funding: ["included"],
				raw: fastRaw,
			},
			spare: {
				source: { kind: "inline" },
				strategy: "random",
				members: [{ alias: "opus", model: "anthropic/claude-opus-5" }],
				funding: [],
				raw: { strategy: "random", models: { opus: { model: "anthropic/claude-opus-5" } } },
			},
		},
		groupUsers: { fast: [{ kind: "role", key: "smol" }] },
	} satisfies Parameters<typeof source>[2];

	function groupsHub() {
		const writes: unknown[] = [];
		const hub = new ModelHubComponent(
			ui,
			source({ default: "demo/demo", smol: "+fast" }, [], groupPools),
			registry(MODELS),
			MODELS.map(entry => ({ model: entry })),
			{
				onAssign: () => {},
				onUnassign: () => {},
				onCancel: () => {},
				onPoolChange: (target, value) => {
					writes.push([target, value]);
					return undefined;
				},
			},
		);
		hubs.push(hub);
		hub.handleNativeEvent({ type: "action", key: "", act: "scope", value: "groups", mods: [] });
		return { hub, writes };
	}

	test("lists every modelGroups entry with who uses it, its members and columns, then New group", () => {
		const { hub } = groupsHub();
		const p = props(hub.describe(withPicker));
		expect(p.scopes?.map(scope => scope.id).slice(0, 3)).toEqual(["roles", "groups", "all"]);
		expect(p.tabs).toBeUndefined();
		expect(p.order?.filter(entry => typeof entry === "string")).toEqual([
			"group:fast",
			"member:group:fast:mini",
			"group:spare",
			"member:group:spare:opus",
			"newGroup",
		]);
		const item = (id: string) => p.items?.find(entry => entry.id === id);
		expect(item("group:fast")).toMatchObject({
			label: "+fast",
			detail: "used by modelRoles.smol",
			facts: { model: "1 model", billing: "included", routing: "priority" },
		});
		// An unreferenced group still shows, muted and marked unused.
		expect(item("group:spare")).toMatchObject({ detail: "unused", tone: "muted" });
		expect(item("member:group:fast:mini")?.facts).toMatchObject({ model: "openai/gpt-5.6-mini", thinking: "low" });
	});

	test("searches group names, member aliases and models while preserving a matching selection", () => {
		const { hub } = groupsHub();
		hub.handleNativeEvent({ type: "select", key: "", item: "member:group:fast:mini" });
		hub.handleInput("/");
		for (const ch of "mini") hub.handleInput(ch);
		let p = props(hub.describe(withPicker));
		expect(p.scope).toBe("groups");
		expect(p.selected).toBe("member:group:fast:mini");
		expect(p.items?.map(item => item.id)).toEqual(["member:group:fast:mini"]);
		expect(p.hits?.["member:group:fast:mini"]).toEqual([[0, 4]]);
		hub.handleInput("\x1b");
		hub.handleInput("/");
		for (const ch of "openai") hub.handleInput(ch);
		p = props(hub.describe(withPicker));
		expect(p.items?.map(item => item.id)).toEqual(["member:group:fast:mini"]);
		expect(p.selected).toBe("member:group:fast:mini");
		expect(Bun.stripANSI(hub.render(180).join("\n"))).toContain("Search: openai");
		hub.handleInput("\x1b");
		hub.handleInput("/");
		for (const ch of "spare") hub.handleInput(ch);
		expect(props(hub.describe(withPicker)).items?.map(item => item.id)).toEqual([
			"group:spare",
			"member:group:spare:opus",
		]);
	});

	test("unused badges and disabled destructive actions reflect references, and footers share action labels", () => {
		const { hub } = groupsHub();
		let p = props(hub.describe(withPicker));
		expect(p.items?.find(item => item.id === "group:spare")?.badges).toContainEqual({
			text: "unused",
			tone: "muted",
		});
		expect(p.items?.find(item => item.id === "group:fast")?.badges).toBeUndefined();
		hub.handleNativeEvent({ type: "select", key: "", item: "group:fast" });
		p = props(hub.describe(withPicker));
		expect(p.actions?.find(action => action.id === "roles:clear")).toMatchObject({
			danger: true,
			disabled: expect.stringContaining("used by"),
		});
		const screen = Bun.stripANSI(hub.render(1200).join("\n"));
		for (const action of p.actions ?? []) expect(screen).toContain(action.label);
		expect(screen).toContain("used by");
	});

	test("a new group's name is checked before the model browse, and a read-only group says why it cannot be edited", () => {
		const { hub, writes } = groupsHub();
		hub.handleNativeEvent({ type: "activate", key: "", item: "newGroup" });
		for (const char of "Bad Name") hub.handleInput(char);
		hub.handleInput("\r");
		// Still naming: the refusal shows in the field and no browse started.
		expect(prefs(hub).editing).toMatchObject({ row: "value", draft: "Bad Name" });
		expect(JSON.stringify(hub.describe(withPicker))).toContain("lowercase letters, digits, - and _, starting with");
		expect(writes).toEqual([]);

		const locked = new ModelHubComponent(
			ui,
			source({ default: "demo/demo" }, [], {
				groups: {
					shared: {
						source: { kind: "inline" },
						strategy: "random",
						members: [{ alias: "opus", model: "anthropic/claude-opus-5" }],
						funding: [],
						readOnly: "set in the project layer",
					},
				},
			}),
			registry(MODELS),
			MODELS.map(entry => ({ model: entry })),
			{ onAssign: () => {}, onUnassign: () => {}, onCancel: () => {}, onPoolChange: () => undefined },
		);
		hubs.push(locked);
		locked.handleNativeEvent({ type: "action", key: "", act: "scope", value: "groups", mods: [] });
		locked.handleNativeEvent({ type: "activate", key: "", item: "group:shared" });
		const subtitle = JSON.stringify(props(locked.describe(withPicker)).subtitle);
		expect(subtitle).toContain("modelGroups.shared is set in the project layer");
		locked.handleInput("f");
		expect(JSON.stringify(props(locked.describe(withPicker)).subtitle)).toBe(subtitle);
	});

	test("x deletes only an unused group; a used one is refused with its users", () => {
		const { hub, writes } = groupsHub();
		const act = (act: string) => hub.handleNativeEvent({ type: "action", key: "", act, mods: [] });
		hub.handleNativeEvent({ type: "select", key: "", item: "group:fast" });
		act("roles:clear");
		expect(writes).toEqual([]);
		expect(JSON.stringify(props(hub.describe(withPicker)).subtitle)).toContain("used by modelRoles.smol");

		hub.handleNativeEvent({ type: "select", key: "", item: "group:spare" });
		act("roles:clear");
		expect(writes).toEqual([]);
		expect(props(hub.describe(withPicker)).confirm?.text).toContain("+spare");
		act("close");
		expect(writes).toEqual([]);
		expect(props(hub.describe(withPicker)).confirm).toBeNull();
		act("roles:clear");
		act("confirm");
		expect(writes).toEqual([[{ kind: "group", key: "spare" }, undefined]]);
	});

	test("Groups ignores role tabs and preserves its selected group across a member-pick refresh", () => {
		const { hub } = groupsHub();
		hub.handleNativeEvent({ type: "select", key: "", item: "group:spare" });
		const before = props(hub.describe(withPicker));
		hub.handleNativeEvent({ type: "action", key: "", act: "tab", value: "kind", mods: [] });
		hub.handleNativeEvent({ type: "select", key: "roleTabs", item: "kind" });
		const after = props(hub.describe(withPicker));
		expect(after.selected).toBe(before.selected);
		expect(after.items).toEqual(before.items);
		expect(after.tabs).toBeUndefined();
		expect(JSON.stringify(after.subtitle)).not.toMatch(/Preset|Cleared roles/);
		hub.handleNativeEvent({ type: "activate", key: "", item: "group:spare" });
		hub.refreshAfterExternalMutation();
		hub.handleInput("\x1b");
		const returned = props(hub.describe(withPicker));
		expect(returned.scope).toBe("groups");
		expect(returned.selected).toBe("group:spare");
	});

	test("a group's member edits write the modelGroups entry, and New group writes its first member", () => {
		const { hub, writes } = groupsHub();
		hub.handleNativeEvent({ type: "select", key: "", item: "group:fast" });
		hub.handleInput("g"); // strategy: priority → round-robin
		expect(writes).toEqual([]);
		changePref(hub, "strategy", ["round-robin"]);
		expect(writes.at(-1)).toMatchObject([{ kind: "group", key: "fast" }, { strategy: "round-robin" }]);
		hub.handleInput("\x1b");

		hub.handleNativeEvent({ type: "select", key: "", item: "newGroup" });
		hub.handleNativeEvent({ type: "activate", key: "", item: "newGroup" });
		for (const char of "fresh") hub.handleInput(char);
		hub.handleInput("\r");
		expect(props(hub.describe(withPicker)).subtitle).toBe("New group +fresh — pick its first model");
		hub.handleNativeEvent({ type: "activate", key: "", item: "openai/gpt-5.6" });
		expect(writes.at(-1)).toEqual([
			{ kind: "group", key: "fresh" },
			{
				strategy: "priority",
				strategyOptions: { order: ["gpt-5-6"] },
				models: { "gpt-5-6": { model: "openai/gpt-5.6" } },
			},
		]);
		expect(props(hub.describe(withPicker)).scope).toBe("groups");
	});
});

describe("Group profiles", () => {
	const fastRaw = {
		strategy: "priority",
		strategyOptions: { order: ["mini"] },
		models: { mini: { model: "openai/gpt-5.6-mini", defaultEffort: "high" } },
		profiles: { low: { mini: { effort: "low" } }, spare: {} },
	};
	const fastMembers = [{ alias: "mini", model: "openai/gpt-5.6-mini", effort: "high" }];
	const profiles: NonNullable<ModelHubPool["profiles"]> = [
		{ name: "low", efforts: { mini: "low" } },
		{ name: "spare", efforts: {} },
	];
	const fixture = {
		groups: {
			fast: {
				source: { kind: "inline" },
				strategy: "priority",
				members: fastMembers,
				funding: [],
				profiles,
				raw: fastRaw,
			},
		},
		// `smol` runs `+fast@low`, so it sees the profile's effort.
		roles: {
			smol: {
				source: { kind: "ref", group: "fast", profile: "low" },
				strategy: "priority",
				members: [{ alias: "mini", model: "openai/gpt-5.6-mini", effort: "low" }],
				funding: [],
				profiles,
				raw: fastRaw,
			},
		},
		groupUsers: { fast: [{ kind: "role", key: "smol", profile: "low" }] },
	} satisfies Parameters<typeof source>[2];

	function profilesHub(scope: "roles" | "groups") {
		const writes: [unknown, Record<string, unknown> | undefined][] = [];
		const hub = new ModelHubComponent(
			ui,
			source({ default: "demo/demo", smol: "+fast@low" }, [], fixture),
			registry(MODELS),
			MODELS.map(entry => ({ model: entry })),
			{
				onAssign: () => {},
				onUnassign: () => {},
				onCancel: () => {},
				onPoolChange: (target, value) => {
					writes.push([target, value as Record<string, unknown> | undefined]);
					return undefined;
				},
			},
		);
		hubs.push(hub);
		hub.handleNativeEvent({ type: "action", key: "", act: "scope", value: scope, mods: [] });
		const act = (id: string, value?: string) =>
			hub.handleNativeEvent({ type: "action", key: "", act: id, ...(value ? { value } : {}), mods: [] });
		const select = (item: string) => hub.handleNativeEvent({ type: "select", key: "", item });
		return { hub, writes, act, select };
	}

	test("each profile lists under its group with its overrides and who uses it", () => {
		const { hub } = profilesHub("groups");
		const p = props(hub.describe(withPicker));
		expect(p.order?.filter(entry => typeof entry === "string")).toEqual([
			"group:fast",
			"member:group:fast:mini",
			"profile:fast:low",
			"profile:fast:spare",
			"newGroup",
		]);
		const item = (id: string) => p.items?.find(entry => entry.id === id);
		expect(item("profile:fast:low")).toMatchObject({
			label: "@low",
			facts: { thinking: "mini low", routing: "used by modelRoles.smol" },
		});
		expect(item("profile:fast:spare")).toMatchObject({
			tone: "muted",
			facts: { thinking: "no overrides", routing: "unused" },
		});
		expect(item("profile:fast:spare")?.badges).toContainEqual({ text: "unused", tone: "muted" });
		expect(item("profile:fast:low")?.badges).toBeUndefined();
	});

	test("profile search preserves the selected profile and highlights its name", () => {
		const { hub, select } = profilesHub("groups");
		select("profile:fast:spare");
		hub.handleInput("/");
		for (const char of "spare") hub.handleInput(char);
		const p = props(hub.describe(withPicker));
		expect(p.items?.map(item => item.id)).toEqual(["profile:fast:spare"]);
		expect(p.selected).toBe("profile:fast:spare");
		expect(p.hits?.["profile:fast:spare"]).toEqual([[1, 6]]);
	});

	test("x deletes only an unused profile; @ adds one", () => {
		const { hub, writes, act, select } = profilesHub("groups");
		select("profile:fast:low");
		act("roles:clear");
		expect(writes).toEqual([]);
		select("profile:fast:spare");
		act("roles:clear");
		expect(writes).toEqual([]);
		expect(props(hub.describe(withPicker)).confirm?.text).toContain("+fast@spare");
		act("close");
		expect(writes).toEqual([]);
		act("roles:clear");
		act("confirm");
		expect(writes.at(-1)?.[1]?.profiles).toEqual({ low: { mini: { effort: "low" } } });

		act("roles:newProfile");
		for (const char of "deep") hub.handleInput(char);
		hub.handleInput("\r");
		expect(writes.at(-1)).toEqual([
			{ kind: "group", key: "fast" },
			{ ...fastRaw, profiles: { ...fastRaw.profiles, deep: {} } },
		]);
	});

	test("t on a member of a role using +fast@low sets the low profile's override, not the group default", () => {
		const { hub, writes, select } = profilesHub("roles");
		select("member:role:smol:mini");
		hub.handleInput("t");
		expect(prefs(hub).focus).toBe("effort:mini");
		const effort = prefs(hub).sections?.[0]?.rows.find(row => row.id === "effort:mini");
		expect(effort?.control).toMatchObject({ k: "choice", value: "low" });
		changePref(hub, "effort:mini", "");
		const [target, value] = writes.at(-1) ?? [];
		expect(target).toEqual({ kind: "group", key: "fast" });
		// Inherit removes the profile's override; the member keeps its default.
		expect(value?.profiles).toEqual({ low: {}, spare: {} });
		expect(value?.models).toEqual(fastRaw.models);
	});

	test("G offers each group's profiles, leaving out the one the role already uses", () => {
		const { hub, writes, act, select } = profilesHub("roles");
		select("role:smol");
		act("roles:groups");
		const rows = prefs(hub).sections?.[0]?.rows ?? [];
		const labels = rows.map(row => row.label);
		expect(labels.some(label => label.includes("use +fast@spare"))).toBe(true);
		expect(labels.some(label => label.includes("use +fast@low"))).toBe(false);
		const plain = rows.find(row => row.label === "use +fast");
		expect(plain).toBeDefined();
		if (plain?.control.k !== "action") throw new Error("Missing group action");
		act(plain.control.act);
		expect(writes.at(-1)).toEqual([{ kind: "role", key: "smol" }, { use: "fast" }]);
	});
});

test("pools render inside the roles picker and their actions edit only what the pool allows", () => {
	const raw = {
		strategy: "priority",
		strategyOptions: { order: ["opus", "gpt"] },
		routing: { funding: { order: ["included", "metered"] }, spending: { policy: "provider-managed" } },
		models: { opus: { model: "anthropic/claude-opus-5", defaultEffort: "high" }, gpt: { model: "openai/gpt-5.6" } },
	};
	const pools = {
		roles: {
			smol: {
				source: { kind: "inline" },
				strategy: "priority",
				members: [
					{ alias: "opus", model: "anthropic/claude-opus-5", effort: "high" },
					{ alias: "gpt", model: "openai/gpt-5.6" },
				],
				funding: ["included", "metered"],
				spending: "provider-managed",
				raw,
			},
		},
		chains: {
			default: {
				source: { kind: "ref", group: "fast" },
				strategy: "random",
				members: [{ alias: "mini", model: "openai/gpt-5.6-mini" }],
				funding: [],
				readOnly: "edit modelGroups.fast in config",
			},
		},
	} satisfies { roles: Record<string, ModelHubPool>; chains: Record<string, ModelHubPool> };
	const writes: unknown[] = [];
	const hub = new ModelHubComponent(
		ui,
		source({ default: "demo/demo", smol: "anthropic/claude-opus-5:high,openai/gpt-5.6" }, [], pools),
		registry(MODELS),
		MODELS.map(entry => ({ model: entry })),
		{
			onAssign: () => {},
			onUnassign: () => {},
			onCancel: () => {},
			onPoolChange: (target, value) => {
				writes.push([target, value]);
				return undefined;
			},
		},
	);
	hubs.push(hub);
	const act = (act: string) => hub.handleNativeEvent({ type: "action", key: "", act, mods: [] });
	const select = (item: string) => hub.handleNativeEvent({ type: "select", key: "", item });

	hub.handleNativeEvent({ type: "action", key: "", act: "scope", value: "roles", mods: [] });
	let p = props(hub.describe(withPicker));
	const item = (id: string) => p.items?.find(entry => entry.id === id);
	expect(item("role:smol")?.facts).toMatchObject({ model: "pool · 2 models", routing: "priority · metered" });
	expect(item("member:role:smol:opus")).toMatchObject({ label: "opus", depth: 1 });
	expect(item("member:role:smol:opus")?.facts).toMatchObject({ model: "anthropic/claude-opus-5", thinking: "high" });
	expect(item("pooled:default")?.facts?.routing).toContain("read-only: edit modelGroups.fast in config");
	expect(item("pooled:default")?.badges).toContainEqual({ text: "read-only", tone: "warning" });
	expect(item("role:smol")?.badges?.some(badge => badge.text === "read-only")).toBeFalsy();
	expect(item("member:chain:default:mini")).toMatchObject({ depth: 2 });
	expect(p.total).toBe(p.order?.filter(entry => typeof entry === "string").length);
	// The generic native frame lists the same pool rows.
	const frame = JSON.stringify(hub.describe(withoutPicker));
	expect(frame).toContain("member:role:smol:opus");

	// A role whose fallback chain is a read-only pool offers no fallback action, and no list edit reaches it.
	select("role:default");
	p = props(hub.describe(withPicker));
	expect(p.actions?.map(action => action.id)).not.toContain("roles:fallback");
	select("member:chain:default:mini");
	p = props(hub.describe(withPicker));
	expect(p.actions?.find(action => action.id === "roles:pick")?.disabled).toBe("edit modelGroups.fast in config");
	expect(p.actions?.map(action => action.id)).toEqual(["roles:pick", "search", "close"]);

	select("role:smol");
	p = props(hub.describe(withPicker));
	expect(p.actions?.find(action => action.id === "roles:pick")?.label).toBe("Add member");
	expect(p.actions?.map(action => action.id)).toContain("roles:funding");
	act("roles:strategy");
	expect(writes).toEqual([]);
	changePref(hub, "strategy", ["round-robin"]);
	expect(writes).toEqual([
		[
			{ kind: "role", key: "smol" },
			{ ...raw, strategy: "round-robin", strategyOptions: { order: ["opus", "gpt"] } },
		],
	]);
});

test("the quick picker is an md sheet with the summary below and a task-model toggle", () => {
	const picked: string[] = [];
	const picker = new ModelPickerComponent(
		ui,
		source({ default: "demo/demo" }, ["demo/demo"]),
		{ ...registry(MODELS), refreshIfStale: async () => false },
		MODELS.map(entry => ({ model: entry })),
		{
			onPick: (_model, selector) => picked.push(`session:${selector}`),
			onPickTask: (_model, selector) => picked.push(`task:${selector}`),
			onCancel: () => {},
		},
		{ currentSelector: "demo/demo", taskModeKeys: ["alt+p"] },
	);
	expect(picker.describe(withoutPicker).k).not.toBe("picker");
	let root = picker.describe(withPicker);
	let p = props(root);
	expect(p).toMatchObject({ size: "md", preview: "below", title: "Switch model", selected: "demo/demo" });
	expect(p.scopes).toBeUndefined();
	expect(groups(p)).toEqual(["Recent", "All"]);
	expect(root.c?.some(child => prop(child, "layout") === "inline")).toBe(true);

	picker.handleNativeEvent({ type: "action", key: "", act: "task", mods: [] });
	root = picker.describe(withPicker);
	p = props(root);
	expect(p.title).toBe("Switch task model");
	expect(p.actions?.find(action => action.id === "task")?.on).toBe(true);
	picker.handleNativeEvent({ type: "activate", key: "", item: "openai/gpt-5.6" });
	expect(picked).toEqual(["task:openai/gpt-5.6"]);
});

test("a select-only picker never marks models over the live context window", () => {
	const small = model("demo", "tiny", { contextWindow: 1_000 });
	const models = [...MODELS, small];
	const picks: { selector: string; overContext: boolean }[] = [];
	const picker = new ModelPickerComponent(
		ui,
		source({ default: "demo/demo" }, ["demo/demo"]),
		{ ...registry(models), refreshIfStale: async () => false },
		models.map(entry => ({ model: entry })),
		{
			onPick: (_model, selector, meta) => picks.push({ selector, overContext: meta.overContext }),
			onCancel: () => {},
		},
		{ currentSelector: "demo/tiny", currentContextTokens: 50_000, selectOnly: true },
	);
	const rendered = picker.render(120).join("\n");
	expect(rendered).not.toContain("context>");
	expect(rendered).not.toContain("compacts with");
	picker.handleNativeEvent({ type: "activate", key: "", item: "demo/tiny" });
	expect(picks).toEqual([{ selector: "demo/tiny", overContext: false }]);
});

test("shows a non-default service tier's own speed aggregate", () => {
	const perf = new Map([
		["openai/gpt-5.6", { samples: 4, tps: 25, ttftMs: 500 }],
		["openai/gpt-5.6@ultrafast", { samples: 2, tps: 300, ttftMs: 120 }],
		["anthropic/claude-opus-5", { samples: 3, tps: 40, ttftMs: 300 }],
		["openai/gpt-5.6-mini@priority", { samples: 1, tps: 90, ttftMs: 200 }],
	]);
	const hub = new ModelHubComponent(
		ui,
		{
			...source({ default: "demo/demo" }, ["demo/demo"]),
			modelPerf: perf,
			serviceTierFor: model => (model.provider === "openai" ? "ultrafast" : undefined),
		},
		registry(MODELS),
		MODELS.map(entry => ({ model: entry })),
		{ onAssign: () => {}, onUnassign: () => {}, onCancel: () => {} },
		{ currentSelector: "demo/demo" },
	);
	hubs.push(hub);
	const items = props(hub.describe(withPicker)).items ?? [];
	const speed = (id: string) => items.find(entry => entry.id === id)?.facts?.speed;
	// The tier the host would send wins over the standard aggregate.
	expect(speed("openai/gpt-5.6")).toBe("300 ultrafast");
	// No tier configured for the family: the standard aggregate, unlabeled.
	expect(speed("anthropic/claude-opus-5")).toBe("40");
	// Only a tier aggregate exists: show it rather than nothing.
	expect(speed("openai/gpt-5.6-mini")).toBe("90 priority");
});

describe("model hub billing", () => {
	const pools = {
		roles: {
			smol: {
				source: { kind: "inline" },
				strategy: "random",
				members: [{ alias: "gpt", model: "openai/gpt-5.6" }],
				funding: [],
			},
		},
	} satisfies { roles: Record<string, ModelHubPool> };

	/** A roles-scoped hub whose host answers billing through `billing`, recording each lookup. */
	function billingHub(billing: ((model: string) => string | undefined) | undefined, revision: { value: unknown }) {
		const asked: string[] = [];
		const hub = new ModelHubComponent(
			ui,
			{
				...source({ default: "demo/demo" }, [], pools),
				get billingRevision() {
					return revision.value;
				},
				billingFor: billing
					? model => {
							asked.push(model);
							return billing(model);
						}
					: undefined,
			},
			registry(MODELS),
			MODELS.map(entry => ({ model: entry })),
			{ onAssign: () => {}, onUnassign: () => {}, onCancel: () => {} },
		);
		hubs.push(hub);
		hub.handleNativeEvent({ type: "action", key: "", act: "scope", value: "roles", mods: [] });
		return { hub, asked };
	}

	const byProvider = (model: string) => (model.startsWith("openai/") ? "metered available\n$1.00" : "free unknown");

	test("role and fallback rows carry billing in a Billing column that only appears when a row has billing", () => {
		const { hub } = billingHub(byProvider, { value: 1 });
		const p = props(hub.describe(withPicker));
		const item = (id: string) => p.items?.find(entry => entry.id === id);
		expect(item("role:default")?.facts).toEqual({ model: "demo/demo", thinking: "off", billing: "free unknown" });
		// The host text is sanitized onto one line.
		expect(item("fallback:default:0")?.facts).toMatchObject({ billing: "metered available $1.00" });
		expect(p.columns?.map(column => column.id)).toEqual(["model", "thinking", "billing", "routing"]);

		// Without billing the column is dropped; the pool's strategy keeps Routing.
		const none = billingHub(() => undefined, { value: 1 }).hub;
		expect(props(none.describe(withPicker)).columns?.map(column => column.id)).toEqual([
			"model",
			"thinking",
			"routing",
		]);
	});

	test("a pool member row and the role preview show the member's and the role's billing", () => {
		const { hub } = billingHub(byProvider, { value: 1 });
		const root = hub.describe(withPicker);
		expect(props(root).items?.find(entry => entry.id === "member:role:smol:gpt")?.facts?.billing).toBe(
			"metered available $1.00",
		);
		// The selected role row is `default`; its preview lists a Billing row.
		const kvItems = (root.c ?? []).flatMap(child => (prop(child, "items") as { k: unknown; v: unknown }[]) ?? []);
		const billingRow = kvItems.find(entry => JSON.stringify(entry.k).includes("Billing"));
		expect(billingRow?.v).toBe("free unknown");
	});

	test("billing is read once per model until the rows rebuild or the billing revision changes", () => {
		const revision = { value: 1 as unknown };
		const { hub, asked } = billingHub(byProvider, revision);
		const gptLookups = () => asked.filter(model => model === "openai/gpt-5.6").length;
		hub.describe(withPicker);
		hub.handleNativeEvent({ type: "select", key: "", item: "member:role:smol:gpt" });
		hub.describe(withPicker);
		expect(gptLookups()).toBe(1);

		hub.handleNativeEvent({ type: "action", key: "", act: "tab", value: "chat", mods: [] });
		hub.describe(withPicker);
		expect(gptLookups()).toBe(2);

		// A new poll (revision) refreshes an open hub without any navigation.
		revision.value = 2;
		hub.describe(withPicker);
		expect(gptLookups()).toBe(3);
	});
});

test("session pool entries expand to named members with models and availability, then collapse", () => {
	const picked: string[] = [];
	const picker = new ModelPickerComponent(
		ui,
		source({}, []),
		{ ...registry(MODELS), refreshIfStale: async () => false },
		MODELS.map(entry => ({ model: entry })),
		{ onPick: (_model, selector) => picked.push(selector), onCancel: () => {} },
	);
	picker.setPoolMembers([
		{ parent: "@security", selector: "@security/mythos", model: MODELS[0]!, state: "usable" },
		{ parent: "@security", selector: "@security/blocked", model: MODELS[1]!, state: "blocked until 12:00:00" },
		{ parent: "@security", selector: "@security/spent", model: MODELS[2]!, state: "exhausted" },
		{ parent: "@security", selector: "@security/denied", model: MODELS[3]!, state: "no entitled account" },
		{ parent: "+grp", selector: "+grp/x", model: MODELS[0]!, state: "usable" },
	]);
	picker.handleInput("@");
	picker.handleInput("\x1b[C");
	const expanded = props(picker.describe(withPicker));
	expect(expanded.order).toEqual(["@security/mythos", "@security/blocked", "@security/spent", "@security/denied"]);
	const rendered = Bun.stripANSI(picker.render(220).join("\n"));
	expect(rendered).toContain("@security/mythos");
	expect(rendered).toContain("anthropic/claude-sonnet-5-5");
	expect(rendered).toContain("usable");
	expect(rendered).toContain("blocked until 12:00:00");
	expect(rendered).toContain("exhausted");
	expect(rendered).toContain("no entitled account");
	const narrowLines = picker.render(80).map(line => Bun.stripANSI(line));
	for (const [selector, state] of [
		["@security/mythos", "usable"],
		["@security/blocked", "blocked until 12:00:00"],
		["@security/spent", "exhausted"],
		["@security/denied", "no entitled account"],
	] as const) {
		expect(narrowLines.find(line => line.includes(selector))).toContain(state);
	}
	for (const line of narrowLines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(80);
	picker.handleNativeEvent({ type: "activate", key: "", item: "@security/mythos" });
	expect(picked).toEqual(["@security/mythos"]);
	picker.handleInput("\x1b[D");
	expect(props(picker.describe(withPicker)).order).toEqual(["@security"]);
});

test("a group/member search exposes group availability in the native picker", () => {
	const picker = new ModelPickerComponent(
		ui,
		source({}, []),
		{ ...registry(MODELS), refreshIfStale: async () => false },
		MODELS.map(entry => ({ model: entry })),
		{ onPick: () => {}, onCancel: () => {} },
	);
	picker.setPoolMembers([{ parent: "+grp", selector: "+grp/x", model: MODELS[0]!, state: "exhausted" }]);
	for (const char of "+grp/") picker.handleInput(char);
	const p = props(picker.describe(withPicker));
	expect(p.order).toEqual(["+grp/x"]);
	expect(JSON.stringify(p.items)).toContain("exhausted");
	for (const line of picker.render(40)) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(40);
});

test("application-cursor arrows expand and collapse session pools", () => {
	const picker = new ModelPickerComponent(
		ui,
		source({}, []),
		{ ...registry(MODELS), refreshIfStale: async () => false },
		MODELS.map(entry => ({ model: entry })),
		{ onPick: () => {}, onCancel: () => {} },
	);
	picker.setPoolMembers([{ parent: "@security", selector: "@security/member", model: MODELS[0]!, state: "usable" }]);
	picker.handleInput("@");
	picker.handleInput("\x1bOC");
	expect(props(picker.describe(withPicker)).order).toEqual(["@security/member"]);
	picker.handleInput("\x1bOD");
	expect(props(picker.describe(withPicker)).order).toEqual(["@security"]);
});

for (const state of ["blocked until 12:00:00", "exhausted", "no entitled account"]) {
	test(`unusable pool members (${state}) are disabled and refuse native and keyboard activation`, () => {
		const picked: string[] = [];
		const picker = new ModelPickerComponent(
			ui,
			source({}, []),
			{ ...registry(MODELS), refreshIfStale: async () => false },
			MODELS.map(entry => ({ model: entry })),
			{ onPick: (_model, selector) => picked.push(selector), onCancel: () => {} },
		);
		picker.setPoolMembers([
			{ parent: "@security", selector: "@security/blocked", model: MODELS[0]!, state },
			{ parent: "@security", selector: "@security/ready", model: MODELS[1]!, state: "usable" },
		]);
		picker.handleInput("@");
		picker.handleInput("\x1b[C");
		const items = props(picker.describe(withPicker)).items;
		expect(items?.find(item => item.id === "@security/blocked")).toMatchObject({ disabled: state, tone: "muted" });
		expect(items?.find(item => item.id === "@security/ready")?.disabled).toBeUndefined();
		picker.handleNativeEvent({ type: "activate", key: "", item: "@security/blocked" });
		expect(picked).toEqual([]);
		expect(JSON.stringify(props(picker.describe(withPicker)).subtitle)).toContain(`@security/blocked: ${state}`);
		expect(JSON.stringify(picker.describe(withoutPicker))).toContain(`@security/blocked: ${state}`);
		expect(Bun.stripANSI(picker.render(160).join("\n"))).toContain(`@security/blocked: ${state}`);
		picker.handleInput("\r");
		expect(picked).toEqual([]);
		expect(Bun.stripANSI(picker.render(160).join("\n"))).toContain(`@security/blocked: ${state}`);
		picker.handleNativeEvent({ type: "activate", key: "", item: "@security/ready" });
		picker.handleInput("\r");
		expect(picked).toEqual(["@security/ready", "@security/ready"]);
	});
}

test("pool availability refreshes native disabled state without changing the query or selection", () => {
	const picker = new ModelPickerComponent(
		ui,
		source({}, []),
		{ ...registry(MODELS), refreshIfStale: async () => false },
		MODELS.map(entry => ({ model: entry })),
		{ onPick: () => {}, onCancel: () => {} },
	);
	const member = { parent: "@security", selector: "@security/member", model: MODELS[0]! };
	picker.setPoolMembers([{ ...member, state: "usable" }]);
	picker.handleInput("@");
	picker.handleInput("\x1b[C");
	const initial = props(picker.describe(withPicker));
	expect(initial.items?.find(item => item.id === member.selector)?.disabled).toBeUndefined();
	picker.setPoolMembers([{ ...member, state: "exhausted" }]);
	const blocked = props(picker.describe(withPicker));
	expect(blocked.query).toBe(initial.query);
	expect(blocked.selected).toBe(initial.selected);
	expect(blocked.items?.find(item => item.id === member.selector)?.disabled).toBe("exhausted");
	picker.setPoolMembers([{ ...member, state: "usable" }]);
	const recovered = props(picker.describe(withPicker));
	expect(recovered.query).toBe(initial.query);
	expect(recovered.selected).toBe(initial.selected);
	expect(recovered.items?.find(item => item.id === member.selector)?.disabled).toBeUndefined();
});

test("Roles renders hostile labels, keys and fallback selectors as single-line display text", () => {
	const unsafe = "\x1b]0;title\x07\x1b[31m\t\r\n";
	const role = `custom${unsafe}`;
	const chain = `provider/${unsafe}model`;
	const selector = `demo/${unsafe}missing`;
	const assigned = model(`provider${unsafe}`, `assigned${unsafe}`);
	const hub = new ModelHubComponent(
		ui,
		{
			...source({ [role]: `${assigned.provider}/${assigned.id}` }, []),
			resolveRoleValue: () => ({ model: assigned, explicitThinkingLevel: false }),
			knownRoleIds: [role],
			getRoleInfo: () => ({ tag: `tag${unsafe}`, name: `name${unsafe}`, section: "chat", accepts: () => true }),
			fallbackChains: { [role]: [selector], [chain]: [selector] },
			cycleOrder: [role],
		},
		registry(MODELS),
		MODELS.map(entry => ({ model: entry })),
		{ onAssign: () => {}, onUnassign: () => {}, onCancel: () => {} },
	);
	hubs.push(hub);
	hub.handleNativeEvent({ type: "action", key: "", act: "scope", value: "roles", mods: [] });
	const control = /[\x00-\x1f\x7f]/;
	for (const line of hub.render(180)) expect(Bun.stripANSI(line)).not.toMatch(control);
	const displayed = (value: unknown): void => {
		if (typeof value === "string") {
			expect(value).not.toMatch(control);
		} else if (Array.isArray(value)) {
			for (const child of value) displayed(child);
		} else if (value && typeof value === "object") {
			for (const [key, child] of Object.entries(value)) {
				if (["id", "key", "selected", "order", "act", "actions"].includes(key)) continue;
				displayed(child);
			}
		}
	};
	for (const cx of [withPicker, withoutPicker]) {
		const described = hub.describe(cx);
		displayed(described);
	}
	hub.handleInput("\x1b[C");
	hub.handleInput("t");
	expect(props(hub.describe(withPicker)).strip).not.toBeNull();
	for (const cx of [withPicker, withoutPicker]) displayed(hub.describe(cx));
	for (const line of hub.render(180)) expect(Bun.stripANSI(line)).not.toMatch(control);
	hub.handleInput("\x1b");
	hub.handleInput("\x1b[B");
	displayed(hub.describe(withPicker));
});

test("role search matches names and assigned models, preserves selection, and shares action labels with the footer", () => {
	const hub = openHub({ assign: [], cancel: 0 });
	hub.handleNativeEvent({ type: "action", key: "", act: "scope", value: "roles", mods: [] });
	hub.handleNativeEvent({ type: "select", key: "", item: "role:default" });
	for (const query of ["default", "demo/demo"]) {
		hub.handleInput("/");
		for (const char of query) hub.handleInput(char);
		const p = props(hub.describe(withPicker));
		expect(p.items?.map(item => item.id)).toEqual(
			query === "default" ? ["role:default", "fallback:default:0"] : ["role:default"],
		);
		expect(p.selected).toBe("role:default");
		hub.handleInput("\x1b");
	}
	const p = props(hub.describe(withPicker));
	const screen = Bun.stripANSI(hub.render(1400).join("\n"));
	for (const action of p.actions ?? []) expect(screen).toContain(action.label);
	expect(p.actions?.find(action => action.id === "roles:clear")?.danger).toBe(true);
});

test("role status badges distinguish auto selection, invalid pools and verified exhausted billing", () => {
	const settings: ModelHubSource = {
		...source({ default: "demo/demo", broken: "+bad" }, [], {
			roles: {
				broken: { source: { kind: "inline" }, strategy: "", members: [], funding: [], invalid: "strategy missing" },
			},
		}),
		knownRoleIds: ["default", "smol", "broken"],
		resolveRoleValue: (value, models) => ({
			model: models.find(
				model => `${model.provider}/${model.id}` === (value === "pi/smol" ? "openai/gpt-5.6" : value),
			),
			explicitThinkingLevel: false,
		}),
		billingFor: selector => (selector === "demo/demo" ? "included exhausted" : "unknown"),
	};
	const hub = new ModelHubComponent(
		ui,
		settings,
		registry(MODELS),
		MODELS.map(model => ({ model })),
		{
			onAssign: () => {},
			onUnassign: () => {},
			onCancel: () => {},
		},
	);
	hubs.push(hub);
	hub.handleNativeEvent({ type: "action", key: "", act: "scope", value: "roles", mods: [] });
	const p = props(hub.describe(withPicker));
	expect(p.items?.find(item => item.id === "role:default")?.badges).toContainEqual({
		text: "exhausted",
		tone: "warning",
	});
	expect(
		p.items?.find(item => item.id === "role:default")?.badges?.some(badge => badge.text === "auto-selected"),
	).toBeFalsy();
	expect(p.items?.find(item => item.id === "role:smol")?.badges).toContainEqual({
		text: "auto-selected",
		tone: "muted",
	});
	expect(
		p.items?.find(item => item.id === "role:smol")?.badges?.some(badge => badge.text === "exhausted"),
	).toBeFalsy();
	expect(p.items?.find(item => item.id === "role:broken")?.badges).toContainEqual({
		text: "invalid pool",
		tone: "error",
	});
	const screen = Bun.stripANSI(hub.render(400).join("\n"));
	expect(screen).toContain("[auto-selected]");
	expect(screen).toContain("[invalid pool]");
	expect(screen).toContain("[exhausted]");
});

test("clearing roles, pools and whole fallback chains requires target-specific confirmation", () => {
	const writes: string[] = [];
	const settings: ModelHubSource = {
		...source({ default: "demo/demo", smol: "+pool" }, [], {
			roles: {
				smol: {
					source: { kind: "inline" },
					strategy: "random",
					members: [{ alias: "demo", model: "demo/demo" }],
					funding: [],
					raw: { strategy: "random", models: { demo: { model: "demo/demo" } } },
				},
			},
		}),
		fallbackChains: { "demo/demo": ["openai/gpt-5.6"] },
	};
	const hub = new ModelHubComponent(
		ui,
		settings,
		registry(MODELS),
		MODELS.map(model => ({ model })),
		{
			onAssign: () => {},
			onUnassign: role => {
				writes.push(role);
			},
			onFallbackChainChange: key => {
				writes.push(key);
			},
			onPoolChange: target => {
				writes.push(target.key);
				return undefined;
			},
			onCancel: () => {},
		},
	);
	hubs.push(hub);
	const act = (act: string) => hub.handleNativeEvent({ type: "action", key: "", act, mods: [] });
	hub.handleNativeEvent({ type: "action", key: "", act: "scope", value: "roles", mods: [] });
	for (const [index, item] of ["role:default", "role:smol", "chain:demo/demo"].entries()) {
		hub.handleNativeEvent({ type: "select", key: "", item });
		act("roles:clear");
		expect(writes).toHaveLength(index);
		expect(props(hub.describe(withPicker)).confirm?.text).toContain(item.slice(item.indexOf(":") + 1));
		act("close");
		expect(writes).toHaveLength(index);
		act("roles:clear");
		act("confirm");
		expect(writes).toHaveLength(index + 1);
	}
});

test("Roles surfaces configuration errors through picker state and the terminal status row", () => {
	const hub = new ModelHubComponent(
		ui,
		source({}, []),
		{
			...registry(MODELS),
			getError: () => "Cannot load models",
		},
		[],
		{ onAssign: () => {}, onUnassign: () => {}, onCancel: () => {} },
	);
	hubs.push(hub);
	hub.handleNativeEvent({ type: "action", key: "", act: "scope", value: "roles", mods: [] });
	expect(props(hub.describe(withPicker))).toMatchObject({ state: "error", message: "Cannot load models" });
	expect(Bun.stripANSI(hub.render(200).join("\n"))).toContain("Cannot load models");
});
