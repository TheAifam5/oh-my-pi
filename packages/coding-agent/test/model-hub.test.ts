import { billingSummary, createModelBrowserSource, writeModelHubPool } from "../src/modes/model-browser-source";
import { afterEach, beforeAll, describe, expect, type Mock, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import type { UsageReport } from "@oh-my-pi/pi-ai/usage";
import { knownBilling } from "@oh-my-pi/pi-ai/usage/billing";
import { parseClaudeUsagePayload } from "@oh-my-pi/pi-ai/usage/claude";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { ModelKind } from "@oh-my-pi/pi-catalog/types";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	type ModelHubCallbacks,
	ModelHubComponent,
	type ModelHubOptions,
	resetProviderAutoRefreshGuard,
} from "@oh-my-pi/pi-tui/overlays/model-hub";
import { getThemeByName, setThemeInstance, theme } from "@oh-my-pi/pi-tui/theme";
import { AUTO_THINKING } from "@oh-my-pi/pi-tui/thinking";
import { type TUI, visibleWidth } from "@oh-my-pi/pi-tui";
import type { DescribeContext } from "@oh-my-pi/pi-tui/native/node";
import type { TspPickerProps } from "@oh-my-pi/pi-wire";

import {
	cfgAuthAccountPolicies,
	cfgCycleOrder,
	cfgModelPresets,
} from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { cfgRetryFallbackChains } from "@oh-my-pi/pi-coding-agent/session/settings";
import { retryFallbackBillingRegistry } from "@oh-my-pi/pi-coding-agent/session/retry-fallback-groups";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

function normalize(lines: readonly string[]): string {
	return stripVTControlCharacters(lines.join("\n")).replace(/\s+/g, " ").trim();
}

/** The footer row (hint line or an active chip strip) of a rendered frame. */
function footerLine(lines: readonly string[]): string {
	return stripVTControlCharacters(lines[lines.length - 2] ?? "");
}

const PICKER_CX: DescribeContext = {
	cols: 160,
	reduceMotion: false,
	dark: true,
	supports: () => true,
	feature: () => true,
};

/** The hub described as the data-first picker. */
function pickerProps(hub: ModelHubComponent): TspPickerProps {
	const root = hub.describe(PICKER_CX);
	if (root.k !== "picker" || !root.p) throw new Error(`expected a picker root, got ${root.k}`);
	return root.p as TspPickerProps;
}

function makeModel(
	provider: string,
	id: string,
	contextWindow = 128_000,
	cost?: Model["cost"],
	kind?: Model["kind"],
): Model {
	return buildModel({
		id,
		name: id,
		api: kind === "image" ? "openai-images" : "ollama-chat",
		...(kind ? { kind } : {}),
		provider,
		baseUrl: "https://example.com",
		reasoning: false,
		input: ["text"],
		cost: cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: 1024,
	});
}

let testTheme = await getThemeByName("dark");

function installTestTheme(): void {
	if (!testTheme) {
		throw new Error("Failed to load dark theme for ModelHub tests");
	}
	setThemeInstance(testTheme);
}

interface RegistryOverrides {
	refresh?: (mode: string) => Promise<void>;
	refreshProvider?: ModelRegistry["refreshProvider"];
	getAvailable?: (kind?: ModelKind | "all") => Model[];
	getAll?: () => Model[];
	getDiscoverableProviders?: () => string[];
	getProviderDiscoveryState?: (providerId: string) => unknown;
	find?: (provider: string, id: string) => Model | undefined;
}

function makeRegistry(models: () => Model[], overrides: RegistryOverrides = {}): ModelRegistry {
	const getAll = overrides.getAll ?? models;
	return {
		refresh: overrides.refresh ?? (async () => { }),
		refreshProvider: overrides.refreshProvider ?? (async () => { }),
		getError: () => undefined,
		getAvailable: overrides.getAvailable ?? models,
		getAll,
		// Mirrors the production lookup's case-insensitivity (alias/variant
		// tables live in the real resolver and need no mock here).
		find:
			overrides.find ??
			((provider: string, id: string) =>
				getAll().find(
					model =>
						model.provider.toLowerCase() === provider.toLowerCase() &&
						model.id.toLowerCase() === id.toLowerCase(),
				)),
		getDiscoverableProviders: overrides.getDiscoverableProviders ?? (() => []),
		getProviderDiscoveryState: overrides.getProviderDiscoveryState ?? (() => undefined),
		authStorage: { keys: { source: () => undefined } },
	} as unknown as ModelRegistry;
}

interface HubHarness {
	hub: ModelHubComponent;
	onAssign: ReturnType<typeof vi.fn>;
	onUnassign: ReturnType<typeof vi.fn>;
	onLoginRequest: ReturnType<typeof vi.fn>;
	onCancel: ReturnType<typeof vi.fn>;
	onFallbackChainChange: Mock<(role: string, chain: string[]) => void>;
}

const openHubs: ModelHubComponent[] = [];

function createHub(options: {
	models: Model[] | (() => Model[]);
	scoped?: boolean;
	settings?: Settings;
	registry?: RegistryOverrides;
	hub?: ModelHubOptions;
	callbacks?: Partial<ModelHubCallbacks>;
	terminalRows?: number;
	/** Usage reports the session holds; omitted means the host wires no billing. */
	usageReports?: () => readonly UsageReport[] | undefined;
}): HubHarness {
	installTestTheme();
	const modelsFn = typeof options.models === "function" ? options.models : () => options.models as Model[];
	const settings = options.settings ?? Settings.isolated({});
	const registry = makeRegistry(modelsFn, options.registry);
	const ui = { requestRender: vi.fn(), terminal: { rows: options.terminalRows ?? 40 } } as unknown as TUI;
	const onAssign = vi.fn();
	const onUnassign = vi.fn();
	const onLoginRequest = vi.fn();
	const onCancel = vi.fn();
	// Mirror the controller: persist chain edits so the hub's re-read sees them.
	const onFallbackChainChange = vi.fn((role: string, chain: string[]) => {
		const chains = { ...cfgRetryFallbackChains.get(settings) };
		if (chain.length === 0) {
			delete chains[role];
		} else {
			chains[role] = chain;
		}
		cfgRetryFallbackChains.override(settings, chains);
	});
	const hub = new ModelHubComponent(
		ui,
		createModelBrowserSource(settings, undefined, options.usageReports ? { usageReports: options.usageReports } : {}),
		registry,
		options.scoped ? modelsFn().map(model => ({ model })) : [],
		{
			onAssign: options.callbacks?.onAssign ?? onAssign,
			onUnassign: options.callbacks?.onUnassign ?? onUnassign,
			onLoginRequest: options.callbacks?.onLoginRequest ?? onLoginRequest,
			onCycleOrderChange: options.callbacks?.onCycleOrderChange,
			onSavePreset: options.callbacks?.onSavePreset,
			onSwitchPreset: options.callbacks?.onSwitchPreset,
			onFallbackChainChange: options.callbacks?.onFallbackChainChange ?? onFallbackChainChange,
			onPoolChange:
				options.callbacks?.onPoolChange ?? ((target, value) => writeModelHubPool(settings, target, value)),
			onCancel: options.callbacks?.onCancel ?? onCancel,
		},
		options.hub,
	);
	openHubs.push(hub);
	return { hub, onAssign, onUnassign, onLoginRequest, onCancel, onFallbackChainChange };
}

const DOWN = "\x1b[B";
const UP = "\x1b[A";
const LEFT = "\x1b[D";
const ALT_RIGHT = "\x1b[1;3C";
/** What macOS terminals (ghostty, Terminal.app, iTerm) emit for Option+→. */
const OPTION_RIGHT_MAC = "\x1bf";
const CTRL_LEFT = "\x1b[1;5D";
const CTRL_RIGHT = "\x1b[1;5C";
const ESC = "\x1b";

describe("ModelHub", () => {
	beforeAll(async () => {
		testTheme = await getThemeByName("dark");
		if (!testTheme) {
			throw new Error("Failed to load dark theme for ModelHub tests");
		}
	});

	afterEach(() => {
		resetProviderAutoRefreshGuard();
		for (const hub of openHubs.splice(0)) {
			hub.dispose();
		}
	});

	describe("responsive layout", () => {
		test("keeps model scopes and names visible at phone-sized widths", () => {
			const { hub } = createHub({ models: [makeModel("test", "phone-model")] });
			const lines = hub.render(36).map(line => stripVTControlCharacters(line));

			expect(lines.some(line => line.includes("Models"))).toBe(true);
			expect(lines.some(line => line.includes("All models"))).toBe(true);
			expect(lines.some(line => line.includes("test/ph"))).toBe(true);
		});

		test("shrinks a wide provider sidebar so model rows stay readable", () => {
			const { hub } = createHub({ models: [makeModel("github-copilot-enterprise", "phone-model")] });
			const lines = hub.render(36).map(line => stripVTControlCharacters(line));

			expect(lines[0]).toStartWith("╭─ Models ───────────┬");
			// Body row (not the sidebar's "● github-…" entry) keeps the provider-qualified name.
			expect(lines.some(line => /│ {2,}github-/.test(line))).toBe(true);
		});
	});

	describe("role chips and roles view", () => {
		test("separates chat and kind roles and filters role tabs", () => {
			const chat = makeModel("test", "chat-model");
			const image = makeModel("test", "image-model", 128_000, undefined, "image");
			const settings = Settings.isolated({
				modelRoles: {
					default: "test/chat-model",
					image: "test/image-model",
				},
			});
			const { hub } = createHub({ models: [chat, image], scoped: true, settings });

			hub.handleInput(UP);
			let lines = hub.render(220).map(line => stripVTControlCharacters(line));
			const chatIndex = lines.findIndex(line => line.includes("DEFAULT"));
			const kindIndex = lines.findIndex(line => line.includes("IMAGE"));
			expect(chatIndex).toBeGreaterThan(-1);
			expect(kindIndex).toBeGreaterThan(chatIndex);
			expect(lines.slice(chatIndex + 1, kindIndex).some(line => line.includes("─"))).toBe(true);

			hub.handleInput(ALT_RIGHT);
			lines = hub.render(220).map(line => stripVTControlCharacters(line));
			expect(lines.some(line => line.includes("DEFAULT"))).toBe(true);
			expect(lines.some(line => line.includes("IMAGE"))).toBe(false);

			hub.handleInput(OPTION_RIGHT_MAC);
			lines = hub.render(220).map(line => stripVTControlCharacters(line));
			expect(lines.some(line => line.includes("DEFAULT"))).toBe(false);
			expect(lines.some(line => line.includes("IMAGE"))).toBe(true);
		});

		test("role assignment candidates honor the role's accepted model kinds", () => {
			const chat = makeModel("test", "chat-model");
			const image = makeModel("test", "image-model", 128_000, undefined, "image");
			const { hub } = createHub({ models: [chat, image], scoped: true });

			hub.handleInput(UP);
			hub.handleInput(ALT_RIGHT);
			hub.handleInput(ALT_RIGHT);
			hub.handleInput("\n");
			hub.handleInput("\n");

			const rendered = normalize(hub.render(220));
			expect(rendered).toContain("Assigning IMAGE");
			expect(rendered).toContain("image-model");
			expect(rendered).not.toContain("chat-model");
		});

		test("a chat-only --models scope keeps non-chat runners and their role assignments (#14016)", () => {
			// The startup scope only ever holds chat models; judge/search/image
			// runners must still be browsable and assignable from the catalog.
			const chat = makeModel("test", "chat-model");
			const judge = makeModel("openrouter", "~typesafe/jev-latest", 128_000, undefined, "judge");
			const settings = Settings.isolated({ modelRoles: { judge: "openrouter/~typesafe/jev-latest" } });
			const { hub } = createHub({
				models: [chat],
				scoped: true,
				settings,
				registry: { getAvailable: kind => (kind === "all" ? [chat, judge] : [chat]) },
			});

			hub.handleInput(UP); // All models → Roles.
			hub.handleInput(OPTION_RIGHT_MAC);
			hub.handleInput(OPTION_RIGHT_MAC); // Kind roles tab.
			const judgeRow = hub
				.render(220)
				.map(line => stripVTControlCharacters(line))
				.find(line => line.includes("JUDGE"));
			expect(judgeRow).toContain("~typesafe/jev-latest");

			hub.handleInput(DOWN); // Roles → All models.
			for (const ch of "jev") hub.handleInput(ch);
			const rendered = normalize(hub.render(220));
			expect(rendered).not.toContain("No matching models");
			expect(rendered).toContain("● judge");
		});

		test("tags the selected model's roles in the detail line, including custom roles", () => {
			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected bundled model anthropic/claude-sonnet-4-5");
			const settings = Settings.isolated({
				cycleOrder: ["smol", "custom-fast", "default"],
				modelRoles: {
					default: `${model.provider}/${model.id}`,
					"custom-fast": `${model.provider}/${model.id}:low`,
					smol: `${model.provider}/${model.id}`,
				},
			});
			const { hub } = createHub({ models: [model], scoped: true, settings });
			installTestTheme();

			const rendered = normalize(hub.render(220));
			expect(rendered).toContain("● default");
			expect(rendered).toContain("● custom-fast");
			// Explicit :low suffix surfaces as the low thinking glyph on the chip.
			expect(rendered).toContain("◔");
			expect(rendered).toContain("● smol");
		});

		test("list rows carry no role chips; only the selected model's detail line is tagged", () => {
			const settings = Settings.isolated({});
			const haiku = makeModel("test", "claude-haiku-4.5");
			const codex = makeModel("test", "gpt-5.1-codex");
			const { hub } = createHub({ models: [codex, haiku], scoped: true, settings });
			installTestTheme();

			const rendered = normalize(hub.render(220));
			// Auto-selection tags smol → haiku and slow → codex, but only the
			// selected model's chips render (in the detail line). With row
			// chips both would appear at once.
			const hollow = ["○ smol", "○ slow"].filter(chip => rendered.includes(chip));
			expect(hollow).toHaveLength(1);
			expect(rendered).not.toContain("● smol");
		});

		test("roles view reflects auto thinking from defaultThinkingLevel and :auto suffixes", () => {
			const model = getBundledModel("openai", "gpt-5.5");
			if (!model) throw new Error("Expected bundled model openai/gpt-5.5");
			const settings = Settings.isolated({
				defaultThinkingLevel: AUTO_THINKING,
				modelRoles: {
					default: `${model.provider}/${model.id}`,
					smol: `${model.provider}/${model.id}:auto`,
				},
			});
			const { hub } = createHub({ models: [model], scoped: true, settings });
			installTestTheme();

			hub.handleInput(UP); // All models → Roles (since Recent is removed)
			const lines = hub.render(220).map(line => stripVTControlCharacters(line));
			const defaultRow = lines.find(line => line.includes("DEFAULT"));
			const smolRow = lines.find(line => line.includes("SMOL"));
			expect(defaultRow).toContain("auto");
			expect(defaultRow).not.toContain("inherit");
			expect(smolRow).toContain("auto");
		});
		test("thinking-only edits preserve the model and scope from the persisted role layer", () => {
			// Reasoning models: `t` only opens a strip where a level can apply.
			const storedModel = getBundledModel("openai", "gpt-5.5");
			const effectiveModel = getBundledModel("openai", "gpt-5.6");
			if (!storedModel || !effectiveModel) throw new Error("Expected bundled OpenAI models");
			const settings = Settings.isolated({ modelRoleStorage: "project" });
			settings.setModelRole("default", `${storedModel.provider}/${storedModel.id}`);
			settings.overrideModelRoles({ default: `${effectiveModel.provider}/${effectiveModel.id}` });
			const { hub, onAssign } = createHub({ models: [storedModel, effectiveModel], scoped: true, settings });

			hub.handleInput(UP); // All models → Roles.
			hub.handleInput("\n"); // Dive into role rows on DEFAULT.
			hub.handleInput("t");
			hub.handleInput("\x1b[C"); // Inherit → off.
			hub.handleInput("\n");

			expect(onAssign.mock.calls[0]?.[0]).toBe(storedModel);
			expect(onAssign.mock.calls[0]?.[1]).toBe("default");
			expect(onAssign.mock.calls[0]?.[4]).toBe("global");
		});

		test("x clears a configured role back to auto-selection", () => {
			const model = makeModel("test", "worker-model");
			const settings = Settings.isolated({
				modelRoles: { smol: "test/worker-model" },
			});
			const { hub } = createHub({
				models: [model],
				scoped: true,
				settings,
				callbacks: {
					// Emulate the controller: clearing deletes the persisted role.
					onUnassign: role => settings.setModelRole(role, undefined),
				},
			});
			installTestTheme();

			hub.handleInput(UP); // All models → Roles (top of the sidebar)
			hub.handleInput("\n"); // dive into the role rows
			hub.handleInput(DOWN); // default → smol row
			hub.handleInput("x");

			expect(settings.getModelRole("smol")).toBeUndefined();
			const lines = hub.render(220).map(line => stripVTControlCharacters(line));
			const smolRow = lines.find(line => line.includes("SMOL"));
			// No auto candidate resolves for this synthetic model, so the row
			// reads as unassigned instead of keeping the cleared value.
			expect(smolRow).not.toContain("worker-model");
			expect(smolRow).toContain("—");
		});
	});

	describe("model kind tabs", () => {
		test("filters the browser to the selected catalog kind", () => {
			const chat = makeModel("test", "chat-model");
			const image = makeModel("test", "image-model", 128_000, undefined, "image");
			const { hub } = createHub({ models: [chat, image], scoped: true });

			const initial = normalize(hub.render(220));
			expect(initial).toContain("Kind:");
			expect(initial).toContain("all");
			expect(initial).toContain("chat");
			expect(initial).toContain("image");
			hub.handleInput(ALT_RIGHT);
			hub.handleInput(ALT_RIGHT);
			hub.handleInput(ALT_RIGHT);

			const rendered = normalize(hub.render(220));
			expect(rendered).toContain("image-model");
			expect(rendered).not.toContain("chat-model");
		});
	});

	describe("hop focus stability", () => {
		test("hopping onto Roles keeps provider navigation instead of capturing the arrows", () => {
			const model = makeModel("prov-a", "model-a");
			const { hub } = createHub({ models: [model] });
			installTestTheme();

			hub.handleInput(UP); // All models → Roles (since Recent is removed)
			// The roles view shows as a preview, but arrows keep hopping.
			hub.handleInput(DOWN); // continues to All models — not a role row
			expect(normalize(hub.render(220))).toContain("All available models");
		});

		test("while searching, the hop skips Roles", () => {
			const model = makeModel("prov-a", "target-model");
			const { hub } = createHub({ models: [model] });
			installTestTheme();

			for (const ch of "target") hub.handleInput(ch);
			hub.handleInput(LEFT); // switch focus to sidebar
			hub.handleInput(UP); // skips Roles → wraps to prov-a
			expect(normalize(hub.render(220))).toContain("prov-a ·");
		});

		test("provider sidebar counts agree with the free keyword", () => {
			// Regression: the sidebar counts come from the hub's own filter, so
			// if only the browser learned the cost keyword a free provider would
			// render 0, gray out, and drop out of the scope hop while its rows
			// were still listed.
			const { hub } = createHub({
				models: [
					makeModel("nvidia", "nemotron-3-nano"),
					makeModel("anthropic", "claude-sonnet-4-5", 128_000, {
						input: 3,
						output: 15,
						cacheRead: 0.3,
						cacheWrite: 3.75,
					}),
				],
			});
			installTestTheme();

			for (const ch of "free") hub.handleInput(ch);

			const rendered = normalize(hub.render(220));
			expect(rendered).toContain("All models 1");
			expect(rendered).toContain("nvidia 1");
			expect(rendered).toContain("anthropic 0");
		});
	});

	describe("sidebar rebuild during navigation", () => {
		test("keeps focus on a surviving provider when the focused entry vanishes on refresh", async () => {
			vi.useFakeTimers();
			try {
				const models = [makeModel("alpha", "m"), makeModel("beta", "m"), makeModel("gamma", "m")];
				// A keyless discoverable local endpoint: starts visible (discovery
				// "empty"), then its on-focus refresh finds it unreachable and it
				// flips to hidden (optional + "unavailable"), vanishing from the list.
				let localStatus = "empty";
				const { hub } = createHub({
					models,
					registry: {
						getDiscoverableProviders: () => ["delta-local"],
						getProviderDiscoveryState: providerId =>
							providerId === "delta-local" ? { optional: true, status: localStatus } : undefined,
						refreshProvider: async providerId => {
							if (providerId === "delta-local") localStatus = "unavailable";
						},
					},
				});
				installTestTheme();

				// Sidebar order: Roles, All models, [sep], alpha, beta, delta-local, gamma.
				// Hop down onto the keyless provider, which schedules its refresh.
				hub.handleInput(DOWN); // all → alpha
				hub.handleInput(DOWN); // alpha → beta
				hub.handleInput(DOWN); // beta → delta-local
				expect(normalize(hub.render(220))).toContain("delta-local ·");

				// Fire the debounced on-focus refresh, then flush the async rebuild
				// (refreshProvider resolves on a microtask before #syncFromRegistryState).
				vi.advanceTimersByTime(200);
				await Promise.resolve();
				await Promise.resolve();

				// delta-local is gone; focus must land on the neighbouring provider,
				// not snap back to "All models" at the top.
				const rendered = normalize(hub.render(220));
				expect(rendered).not.toContain("All available models");
				expect(rendered).toContain("gamma ·");
			} finally {
				vi.useRealTimers();
			}
		});
	});

	describe("typing focus", () => {
		test("typing on All models switches focus to model list and navigates results with arrows", () => {
			const modelA = makeModel("test", "model-a");
			const modelB = makeModel("test", "model-b");
			const { hub, onAssign } = createHub({ models: [modelA, modelB], scoped: true });
			installTestTheme();

			// Type to search; focus moves from the sidebar to the model list.
			for (const ch of "model") hub.handleInput(ch);

			// Down arrow navigates within the model list (from model-a to model-b)
			hub.handleInput(DOWN);
			hub.handleInput("\n"); // open role strip for model-b
			expect(footerLine(hub.render(220))).toContain("model-b →");

			hub.handleInput("\n"); // assign to default
			expect(onAssign.mock.calls[0]?.[0]).toBe(modelB);
		});

		test("typing while on Roles in scope focus switches to All models and focuses model list", () => {
			const model = makeModel("prov-a", "target-model");
			const { hub } = createHub({ models: [model] });
			installTestTheme();

			hub.handleInput(UP); // All models → Roles (scope focus)

			// Typing a search character switches away from Roles to All models and focuses list
			hub.handleInput("t");
			expect(normalize(hub.render(220))).toContain("All available models");
		});

		test("typing while on a locked provider in scope focus switches to All models and focuses model list", () => {
			const model = makeModel("anthropic", "claude-locked-test");
			const { hub } = createHub({
				models: [model],
				registry: { getAvailable: () => [] },
			});
			installTestTheme();

			hub.handleInput(DOWN); // All models → locked anthropic
			expect(normalize(hub.render(220))).toContain("anthropic has no credentials configured");

			// Typing a search character switches to All models and focuses list
			hub.handleInput("t");
			expect(normalize(hub.render(220))).toContain("All available models");
		});
	});

	describe("quick-switch cycle and custom roles", () => {
		test("c toggles cycle membership, [ reorders, and the preview tracks the order", () => {
			const model = makeModel("test", "cycle-model");
			const settings = Settings.isolated({});
			const changes: string[][] = [];
			const { hub } = createHub({
				models: [model],
				scoped: true,
				settings,
				callbacks: {
					onCycleOrderChange: order => {
						changes.push([...order]);
						cfgCycleOrder.set(settings, order);
					},
				},
			});
			installTestTheme();

			hub.handleInput(UP); // All models → Roles (since Recent is removed)
			hub.handleInput("\n"); // dive into rows; cursor on DEFAULT

			// Default cycle is [smol, default, slow]: c removes default…
			hub.handleInput("c");
			expect(changes[0]).toEqual(["smol", "slow"]);
			// …c again re-appends it at the end…
			hub.handleInput("c");
			expect(changes[1]).toEqual(["smol", "slow", "default"]);
			// …and [ moves it one slot earlier.
			hub.handleInput("[");
			expect(changes[2]).toEqual(["smol", "default", "slow"]);

			// The preview line renders the resulting ctrl+p track in order.
			const preview = hub
				.render(220)
				.map(line => stripVTControlCharacters(line))
				.find(line => line.includes("cycle:"));
			expect(preview).toBeDefined();
			const previewText = preview ?? "";
			expect(previewText.indexOf("smol")).toBeGreaterThan(-1);
			expect(previewText.indexOf("smol")).toBeLessThan(previewText.indexOf("default"));
			expect(previewText.indexOf("default")).toBeLessThan(previewText.indexOf("slow"));
		});

		test("separates the quick-cycle icon from its ordinal", () => {
			const model = makeModel("test", "cycle-model");
			const settings = Settings.isolated({
				cycleOrder: ["default"],
				modelRoles: { default: `${model.provider}/${model.id}` },
			});
			const { hub } = createHub({ models: [model], scoped: true, settings });

			hub.handleInput(UP); // All models → Roles.
			const defaultRow = hub
				.render(220)
				.map(line => stripVTControlCharacters(line))
				.find(line => line.includes("DEFAULT"));

			expect(defaultRow).toContain(`${theme.icon.loop} 1`);
		});

		test("the + New role row names a custom role and jumps into assigning it", () => {
			const model = makeModel("test", "reviewer-model");
			const { hub, onAssign } = createHub({ models: [model], scoped: true });
			installTestTheme();

			hub.handleInput(UP); // All models → Roles (since Recent is removed)
			hub.handleInput("\n"); // dive into rows
			hub.handleInput(UP); // wraps to the trailing "+ New fallback…" row
			hub.handleInput(UP); // skips the section divider up to "+ New role…"
			hub.handleInput("\n");
			expect(footerLine(hub.render(220))).toContain("New role name:");

			for (const ch of "reviewer") hub.handleInput(ch);
			hub.handleInput("\n");
			expect(normalize(hub.render(220))).toContain("Assigning reviewer");

			hub.handleInput("\n"); // focus already on the model rows: pick the sole model
			expect(onAssign).toHaveBeenCalledTimes(1);
			const call = onAssign.mock.calls[0];
			expect(call?.[1]).toBe("reviewer");
			expect(call?.[3]).toBe("test/reviewer-model");
		});

		test("s saves the current setup as a named model preset", () => {
			const model = makeModel("test", "preset-model");
			const onSavePreset = vi.fn();
			const { hub } = createHub({ models: [model], scoped: true, callbacks: { onSavePreset } });
			installTestTheme();

			hub.handleInput(UP); // All models → Roles (since Recent is removed)
			hub.handleInput("\n"); // dive into rows
			expect(footerLine(hub.render(220))).toContain("save preset");

			hub.handleInput("s");
			expect(footerLine(hub.render(220))).toContain("Preset name:");

			for (const ch of "work-setup") hub.handleInput(ch);
			hub.handleInput("\n");
			expect(onSavePreset).toHaveBeenCalledTimes(1);
			expect(onSavePreset).toHaveBeenCalledWith("work-setup");

			hub.handleInput("s");
			for (const ch of "1bad") hub.handleInput(ch);
			hub.handleInput("\n");
			expect(onSavePreset).toHaveBeenCalledTimes(1);
			expect(footerLine(hub.render(220))).toContain("Preset name:");

			const { hub: bareHub } = createHub({ models: [model], scoped: true });
			bareHub.handleInput(UP); // All models → Roles (since Recent is removed)
			bareHub.handleInput("\n"); // dive into rows
			expect(footerLine(bareHub.render(220))).not.toContain("save preset");

			bareHub.handleInput("s");
			expect(footerLine(bareHub.render(220))).not.toContain("Preset name:");
		});

		test("ctrl+←/→ and p/P switch between saved model presets from the Roles view", () => {
			const a = makeModel("test", "model-a");
			const b = makeModel("test", "model-b");
			const c = makeModel("test", "model-c");
			const settings = Settings.isolated({ modelRoles: { default: "test/model-a" } });
			cfgModelPresets.setEntry(settings, "alpha", { modelRoles: { default: "test/model-a" } });
			cfgModelPresets.setEntry(settings, "beta", { modelRoles: { default: "test/model-b" } });
			cfgModelPresets.setEntry(settings, "gamma", { modelRoles: { default: "test/model-c" } });
			// Mirror the controller: applying a preset writes its roles; "beta" is refused and writes nothing.
			const onSwitchPreset = vi.fn((name: string) => {
				if (name === "beta") return;
				settings.setModelRole("default", name === "alpha" ? "test/model-a" : "test/model-c");
			});
			const { hub } = createHub({ models: [a, b, c], scoped: true, settings, callbacks: { onSwitchPreset } });

			hub.handleInput(UP); // All models → Roles
			expect(normalize(hub.render(220))).toContain("Preset: alpha");

			hub.handleInput(CTRL_RIGHT); // alpha → beta (refused: nothing written)
			expect(onSwitchPreset).toHaveBeenLastCalledWith("beta");
			expect(normalize(hub.render(220))).toContain("Preset: alpha");

			hub.handleInput(CTRL_RIGHT); // steps past the refused preset
			expect(onSwitchPreset).toHaveBeenLastCalledWith("gamma");
			expect(normalize(hub.render(220))).toContain("Preset: gamma");
			expect(settings.getModelRole("default")).toBe("test/model-c");

			hub.handleInput(CTRL_RIGHT); // wraps to the first preset
			expect(onSwitchPreset).toHaveBeenLastCalledWith("alpha");
			expect(normalize(hub.render(220))).toContain("Preset: alpha");

			hub.handleInput(CTRL_LEFT); // wraps back to the last preset
			expect(onSwitchPreset).toHaveBeenLastCalledWith("gamma");

			// The letter twins (macOS reserves ctrl+←/→) work on the role rows.
			hub.handleInput("\n"); // dive into the rows
			hub.handleInput("p"); // gamma → alpha
			expect(onSwitchPreset).toHaveBeenLastCalledWith("alpha");
			hub.handleInput("P"); // alpha → gamma
			expect(onSwitchPreset).toHaveBeenLastCalledWith("gamma");

			// Outside the Roles view the keys never switch presets.
			hub.handleInput(LEFT); // back to the sidebar
			hub.handleInput(DOWN); // Roles → All models
			hub.handleInput(CTRL_RIGHT);
			expect(onSwitchPreset).toHaveBeenCalledTimes(6);
		});

		test("picking a role lands the arrows on the model rows, keeping the assignment flow", () => {
			const a = makeModel("test", "model-a");
			const b = makeModel("test", "model-b");
			const { hub, onAssign } = createHub({ models: [a, b], scoped: true });

			hub.handleInput(UP); // All models → Roles
			hub.handleInput("\n"); // dive into the rows
			hub.handleInput("\n"); // pick a model for DEFAULT
			expect(normalize(hub.render(220))).toContain("Assigning DEFAULT");

			hub.handleInput(DOWN); // moves through the models, not the sidebar
			hub.handleInput("\n");
			expect(onAssign).toHaveBeenCalledTimes(1);
			expect(onAssign.mock.calls[0]?.[1]).toBe("default");
			expect(onAssign.mock.calls[0]?.[3]).toBe("test/model-b");
		});
	});

	describe("assignment strips", () => {
		test("Enter opens the role strip; assigning fires onAssign and opens the thinking strip", () => {
			const model = getBundledModel("openai", "gpt-5.5");
			if (!model) throw new Error("Expected bundled model openai/gpt-5.5");
			const { hub, onAssign } = createHub({ models: [model], scoped: true });
			installTestTheme();

			hub.handleInput("\n"); // sidebar → model list
			hub.handleInput("\n");
			const strip = footerLine(hub.render(220));
			expect(strip).toContain("default");
			expect(strip).toContain("retry-fallback");
			expect(strip).not.toContain("project default");
			expect(strip).not.toContain("global default");

			hub.handleInput("\n"); // assign to default (first chip)
			expect(onAssign).toHaveBeenCalledTimes(1);
			const call = onAssign.mock.calls[0];
			expect(call?.[0]).toBe(model);
			expect(call?.[1]).toBe("default");
			expect(call?.[2]).toBe(ThinkingLevel.Inherit);
			expect(call?.[3]).toBe("openai/gpt-5.5");
			expect(call?.[4]).toBe("global");

			// The thinking strip follows immediately, scoped to the model's
			// real ladder: gpt-5.5 tops out at xhigh — no invented max tier.
			const thinking = footerLine(hub.render(220));
			expect(thinking).toContain("inherit");
			expect(thinking).toContain("xhigh");
			expect(thinking).not.toContain("max");
		});
		test("a model with no reasoning surface is assigned without a thinking strip", () => {
			// inherit/off/auto are all no-ops for an STT/TTS/image model, so the
			// assignment completes instead of parking on a dead strip (#13111).
			const model = makeModel("local", "parakeet-tdt-0.6b-v3", 128_000, undefined, "stt");
			const { hub, onAssign } = createHub({ models: [model], scoped: true });
			installTestTheme();

			hub.handleInput("\n"); // Sidebar → model list.
			hub.handleInput("\n");
			expect(footerLine(hub.render(220))).toContain("dictation");

			hub.handleInput("\n"); // assign to dictation (first chip)
			expect(onAssign).toHaveBeenCalledTimes(1);
			expect(onAssign.mock.calls[0]?.[1]).toBe("dictation");
			expect(onAssign.mock.calls[0]?.[2]).toBe(ThinkingLevel.Inherit);
			const footer = footerLine(hub.render(220));
			expect(footer).not.toContain("inherit");
			expect(footer).not.toContain("auto");
		});
		test("t and its hint stay inert on a role row whose model cannot reason", () => {
			const model = makeModel("local", "parakeet-tdt-0.6b-v3", 128_000, undefined, "stt");
			const settings = Settings.isolated({ modelRoles: { dictation: "local/parakeet-tdt-0.6b-v3" } });
			const { hub } = createHub({ models: [model], scoped: true, settings });
			installTestTheme();

			hub.handleInput(UP); // All models → Roles.
			hub.handleInput("\n"); // Dive into the role rows.
			const selected = () =>
				hub
					.render(220)
					.map(line => stripVTControlCharacters(line))
					.find(line => line.includes("❯")) ?? "";
			for (let step = 0; step < 20 && !selected().includes("DICTATION"); step++) hub.handleInput(DOWN);
			expect(selected()).toContain("DICTATION");

			expect(footerLine(hub.render(220))).not.toContain("t thinking");
			hub.handleInput("t");
			expect(footerLine(hub.render(220))).not.toContain("inherit");
		});
		test("a reasoner without an effort ladder keeps the always-on levels", () => {
			// `thinking: undefined` means "no dial", not "no thinking": off and
			// auto still change what the model does, so the strip must open.
			const model = getBundledModel("xai", "grok-code-fast-1");
			if (!model) throw new Error("Expected bundled model xai/grok-code-fast-1");
			const { hub } = createHub({ models: [model], scoped: true });
			installTestTheme();

			hub.handleInput("\n"); // Sidebar → model list.
			hub.handleInput("\n");
			hub.handleInput("\n"); // assign to default (first chip)
			const thinking = footerLine(hub.render(220));
			expect(thinking).toContain("inherit");
			expect(thinking).toContain("off");
			expect(thinking).toContain("auto");
			expect(thinking).not.toContain("high");
		});
		test("awaits an async default assignment and does not recommit its preselected thinking", async () => {
			const model = getBundledModel("openai", "gpt-5.5");
			if (!model) throw new Error("Expected bundled model openai/gpt-5.5");
			const assignment = Promise.withResolvers<boolean>();
			const onAssign = vi.fn(() => assignment.promise);
			const { hub } = createHub({ models: [model], scoped: true, callbacks: { onAssign } });

			hub.handleInput("\n"); // Sidebar → model list.
			hub.handleInput("\n"); // Open role strip.
			hub.handleInput("\n"); // Assign default.
			expect(onAssign).toHaveBeenCalledTimes(1);
			expect(normalize(hub.render(220))).toContain("Applying model");

			hub.handleInput("\n"); // A repeated Enter while persistence is pending is ignored.
			expect(onAssign).toHaveBeenCalledTimes(1);

			assignment.resolve(true);
			await assignment.promise;
			await Promise.resolve();
			expect(footerLine(hub.render(220))).toContain("inherit");

			hub.handleInput("\n"); // Confirming unchanged thinking only closes the strip.
			expect(onAssign).toHaveBeenCalledTimes(1);
		});
		test("does not open thinking controls when an async assignment is rejected", async () => {
			const model = getBundledModel("openai", "gpt-5.5");
			if (!model) throw new Error("Expected bundled model openai/gpt-5.5");
			const assignment = Promise.withResolvers<boolean>();
			const onAssign = vi.fn(() => assignment.promise);
			const { hub } = createHub({ models: [model], scoped: true, callbacks: { onAssign } });

			hub.handleInput("\n"); // Sidebar → model list.
			hub.handleInput("\n");
			hub.handleInput("\n");
			assignment.resolve(false);
			await assignment.promise;
			await Promise.resolve();

			expect(onAssign).toHaveBeenCalledTimes(1);
			expect(footerLine(hub.render(220))).not.toContain("inherit");
		});
		test("hides thinking chips while a changed level is being applied", async () => {
			const model = getBundledModel("openai", "gpt-5.5");
			if (!model) throw new Error("Expected bundled model openai/gpt-5.5");
			const thinking = Promise.withResolvers<boolean>();
			let assignments = 0;
			const onAssign = vi.fn(() => (++assignments === 1 ? true : thinking.promise));
			const { hub } = createHub({ models: [model], scoped: true, callbacks: { onAssign } });

			hub.handleInput("\n"); // Sidebar → model list.
			hub.handleInput("\n");
			hub.handleInput("\n");
			hub.handleInput("\x1b[C"); // Inherit → off.
			hub.handleInput("\n");

			expect(normalize(hub.render(220))).toContain("Applying model");
			expect(footerLine(hub.render(220))).not.toContain("inherit");

			thinking.resolve(true);
			await thinking.promise;
			await Promise.resolve();
			expect(onAssign).toHaveBeenCalledTimes(2);
		});
		test("project storage exposes project and global role actions with callback scopes", () => {
			const model = makeModel("test", "scoped-role-model");
			const settings = Settings.isolated({ modelRoleStorage: "project" });
			const projectHarness = createHub({ models: [model], scoped: true, settings });

			projectHarness.hub.handleInput("\n"); // Sidebar → model list.
			projectHarness.hub.handleInput("\n");
			const projectStrip = footerLine(projectHarness.hub.render(220));
			expect(projectStrip).toContain("project default");
			expect(projectStrip).toContain("global default");
			projectHarness.hub.handleInput("\n");
			expect(projectHarness.onAssign.mock.calls[0]?.[4]).toBe("project");

			const globalHarness = createHub({ models: [model], scoped: true, settings });
			globalHarness.hub.handleInput("\n"); // Sidebar → model list.
			globalHarness.hub.handleInput("\n");
			globalHarness.hub.handleInput(DOWN);
			globalHarness.hub.handleInput("\n");
			expect(globalHarness.onAssign.mock.calls[0]?.[4]).toBe("global");
		});
		test("shadowed global assignments unassign from the global chip", () => {
			const globalModel = makeModel("test", "a-global-role-model");
			const projectModel = makeModel("test", "z-project-role-model");
			const settings = Settings.isolated({ modelRoleStorage: "project" });
			settings.setModelRole("default", `${globalModel.provider}/${globalModel.id}`);
			settings.setProjectModelRole("default", `${projectModel.provider}/${projectModel.id}`);
			const { hub, onAssign, onUnassign } = createHub({
				models: [globalModel, projectModel],
				scoped: true,
				settings,
			});

			hub.handleInput("\t"); // Sidebar → model list.
			hub.handleInput(DOWN); // Effective project model → shadowed global model.
			hub.handleInput("\n");
			hub.handleInput(DOWN); // Project default → global default.
			hub.handleInput("\n");

			expect(onUnassign).toHaveBeenCalledWith("default", "global");
			expect(onAssign).not.toHaveBeenCalled();
		});
		test("overlay tombstones do not hide stored scoped default assignments", async () => {
			const model = makeModel("test", "claude-haiku-4.5");
			const selector = `${model.provider}/${model.id}`;
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-model-hub-"));
			const cwd = path.join(root, "project");
			const agentDir = path.join(root, "agent");
			const overlayPath = path.join(root, "overlay.yml");

			try {
				await Bun.write(
					path.join(agentDir, "config.yml"),
					`modelRoleStorage: project\nmodelRoles:\n  default: ${selector}\n  smol: ${selector}\n`,
				);
				await Bun.write(
					path.join(cwd, ".omp", "config.yml"),
					`modelRoles:\n  default: ${selector}\n  smol: ${selector}\n`,
				);
				await Bun.write(overlayPath, "modelRoles:\n  default: null\n  smol: null\n");
				const settings = await Settings.loadReadOnly({ cwd, agentDir, configFiles: [overlayPath] });
				expect(settings.getModelRole("default")).toBeUndefined();
				expect(settings.getGlobalModelRole("default")).toBe(selector);
				expect(settings.getProjectModelRole("default")).toBe(selector);

				const projectDefault = createHub({ models: [model], scoped: true, settings });
				expect(normalize(projectDefault.hub.render(220))).toContain("○ smol");
				projectDefault.hub.handleInput("\n"); // Sidebar → model list.
				projectDefault.hub.handleInput("\n");
				projectDefault.hub.handleInput("\n");
				expect(projectDefault.onUnassign).toHaveBeenCalledWith("default", "project");
				expect(projectDefault.onAssign).not.toHaveBeenCalled();

				const globalDefault = createHub({ models: [model], scoped: true, settings });
				globalDefault.hub.handleInput("\n"); // Sidebar → model list.
				globalDefault.hub.handleInput("\n");
				globalDefault.hub.handleInput(DOWN);
				globalDefault.hub.handleInput("\n");
				expect(globalDefault.onUnassign).toHaveBeenCalledWith("default", "global");
				expect(globalDefault.onAssign).not.toHaveBeenCalled();

				const projectAutoSelected = createHub({ models: [model], scoped: true, settings });
				projectAutoSelected.hub.handleInput("\n"); // Sidebar → model list.
				projectAutoSelected.hub.handleInput("\n");
				projectAutoSelected.hub.handleInput(DOWN);
				projectAutoSelected.hub.handleInput(DOWN);
				projectAutoSelected.hub.handleInput("\n");
				expect(projectAutoSelected.onUnassign).toHaveBeenCalledWith("smol", "project");
				expect(projectAutoSelected.onAssign).not.toHaveBeenCalled();

				const globalAutoSelected = createHub({ models: [model], scoped: true, settings });
				globalAutoSelected.hub.handleInput("\n"); // Sidebar → model list.
				globalAutoSelected.hub.handleInput("\n");
				globalAutoSelected.hub.handleInput(DOWN);
				globalAutoSelected.hub.handleInput(DOWN);
				globalAutoSelected.hub.handleInput(DOWN);
				globalAutoSelected.hub.handleInput("\n");
				expect(globalAutoSelected.onUnassign).toHaveBeenCalledWith("smol", "global");
				expect(globalAutoSelected.onAssign).not.toHaveBeenCalled();
			} finally {
				await fs.rm(root, { recursive: true, force: true });
			}
		});

		test("auto-selected roles remain assignable when the selected scope has no stored role", () => {
			const model = makeModel("test", "claude-haiku-4.5");
			const settings = Settings.isolated({ modelRoleStorage: "project" });
			const { hub, onAssign, onUnassign } = createHub({ models: [model], scoped: true, settings });
			expect(normalize(hub.render(220))).toContain("○ smol");

			hub.handleInput("\n"); // Sidebar → model list.
			hub.handleInput("\n");
			hub.handleInput(DOWN);
			hub.handleInput(DOWN);
			hub.handleInput("\n");

			expect(onAssign.mock.calls[0]?.[1]).toBe("smol");
			expect(onAssign.mock.calls[0]?.[4]).toBe("project");
			expect(onUnassign).not.toHaveBeenCalled();
		});

		test("global assignments preserve thinking from the global role instead of the project override", () => {
			const configuredModel = getBundledModel("openai", "gpt-5.5");
			const targetModel = getBundledModel("openai", "gpt-5.6");
			if (!configuredModel || !targetModel) {
				throw new Error("Expected bundled OpenAI models for scoped thinking test");
			}
			const selector = `${configuredModel.provider}/${configuredModel.id}`;
			const settings = Settings.isolated({ modelRoleStorage: "project" });
			settings.setModelRole("smol", `${selector}:low,missing/unavailable:high`);
			settings.setModelRole("default", "@smol");
			settings.setProjectModelRole("smol", `${selector}:high`);
			settings.setProjectModelRole("default", "@smol");
			const { hub, onAssign } = createHub({ models: [configuredModel, targetModel], scoped: true, settings });

			hub.handleInput("\t"); // Sidebar → model list.
			hub.handleInput(DOWN); // Effective configured model → assignment target.
			hub.handleInput("\n");
			hub.handleInput(DOWN); // Project default → global default.
			hub.handleInput("\n");

			expect(onAssign.mock.calls[0]?.[2]).toBe(ThinkingLevel.Low);
			expect(onAssign.mock.calls[0]?.[4]).toBe("global");
			hub.handleInput("\n"); // Confirm the already committed thinking level.
			expect(onAssign).toHaveBeenCalledTimes(1);
		});
		test("project-scope alias falls back to the global role when the project role is absent", () => {
			const configuredModel = getBundledModel("openai", "gpt-5.5");
			const targetModel = getBundledModel("openai", "gpt-5.6");
			if (!configuredModel || !targetModel) {
				throw new Error("Expected bundled OpenAI models for project alias fallback test");
			}
			const selector = `${configuredModel.provider}/${configuredModel.id}`;
			const settings = Settings.isolated({ modelRoleStorage: "project" });
			// Global smol selects a concrete model with :low plus an unavailable
			// fallback — the alias must resolve to this, not built-in priority.
			settings.setModelRole("smol", `${selector}:low,missing/unavailable:high`);
			// Global default also points at @smol — another project/effective
			// conflict that would expose merged-resolution contamination if the
			// alias lookup consulted merged settings instead of project-first.
			settings.setModelRole("default", "@smol");
			// Project default is @smol; project smol is absent — the alias must
			// fall back to the global smol, not built-in priority defaults.
			settings.setProjectModelRole("default", "@smol");

			// Assignment thinking: the preserved level comes from the global
			// smol fallback (:low), not built-in priority defaults (Inherit).
			const assignHub = createHub({ models: [configuredModel, targetModel], scoped: true, settings });
			assignHub.hub.handleInput("\t"); // Sidebar → model list.
			assignHub.hub.handleInput(DOWN); // gpt-5.5 → gpt-5.6.
			assignHub.hub.handleInput("\n"); // Open the role strip for gpt-5.6.
			assignHub.hub.handleInput("\n"); // Assign to "project default" (first chip).
			expect(assignHub.onAssign).toHaveBeenCalledTimes(1);
			expect(assignHub.onAssign.mock.calls[0]?.[1]).toBe("default");
			expect(assignHub.onAssign.mock.calls[0]?.[2]).toBe(ThinkingLevel.Low);
			expect(assignHub.onAssign.mock.calls[0]?.[4]).toBe("project");

			// Chip classification: on gpt-5.5, the project default chip is
			// "assigned here" because @smol falls back to global smol → gpt-5.5.
			const classifyHub = createHub({ models: [configuredModel, targetModel], scoped: true, settings });
			classifyHub.hub.handleInput("\t"); // Sidebar → model list.
			classifyHub.hub.handleInput("\n"); // Open the role strip for gpt-5.5.
			classifyHub.hub.handleInput("\n"); // Select "project default" (first chip).
			expect(classifyHub.onUnassign).toHaveBeenCalledWith("default", "project");
			expect(classifyHub.onAssign).not.toHaveBeenCalled();
		});

		test("renders max as a real final tier on max-capable models (gpt-5.6)", () => {
			const model = getBundledModel("openai", "gpt-5.6");
			if (!model) throw new Error("Expected bundled model openai/gpt-5.6");
			const { hub } = createHub({ models: [model], scoped: true });
			installTestTheme();

			hub.handleInput("\n"); // Sidebar → model list.
			hub.handleInput("\n");
			hub.handleInput("\n");
			const thinking = footerLine(hub.render(220));
			expect(thinking).toContain("xhigh");
			expect(thinking).toContain("max");
		});

		test("Enter on a chip already holding this model unassigns it", () => {
			const model = makeModel("test", "toggled-model");
			const settings = Settings.isolated({ modelRoles: { smol: "test/toggled-model" } });
			const { hub, onAssign, onUnassign } = createHub({ models: [model], scoped: true, settings });
			installTestTheme();

			hub.handleInput("\n"); // Sidebar → model list.
			hub.handleInput("\n"); // role strip
			hub.handleInput(DOWN); // default → smol chip (down moves right)
			hub.handleInput("\n");

			expect(onUnassign).toHaveBeenCalledWith("smol");
			expect(onAssign).not.toHaveBeenCalled();
			// Toggle closes the strip without a thinking step.
			expect(footerLine(hub.render(220))).not.toContain("inherit");
		});

		test("role strip offers only roles the model can fill", () => {
			const chat = makeModel("test", "chat-model");
			const search = makeModel("web", "perplexity", 128_000, undefined, "search");
			const { hub } = createHub({ models: [chat, search], scoped: true });
			hub.handleInput("\t");

			for (const ch of "chat-model") hub.handleInput(ch);
			hub.handleInput("\n");
			const chatStrip = footerLine(hub.render(400));
			expect(chatStrip).toContain("default");
			expect(chatStrip).toContain("smol");
			expect(chatStrip).toContain("judge");
			expect(chatStrip).toContain("retry-fallback");
			expect(chatStrip).not.toContain("image");
			expect(chatStrip).not.toContain("web");
			expect(chatStrip).not.toContain("speech");
			expect(chatStrip).not.toContain("dictation");
			hub.handleInput(ESC);

			hub.handleInput(ESC); // clear query
			for (const ch of "perplexity") hub.handleInput(ch);
			hub.handleInput("\n");
			const searchStrip = footerLine(hub.render(400));
			expect(searchStrip).toContain("web");
			expect(searchStrip).toContain("fallbacks:perplexity");
			expect(searchStrip).not.toContain("default");
			expect(searchStrip).not.toContain("smol");
			expect(searchStrip).not.toContain("judge");
			expect(searchStrip).not.toContain("retry-fallback");
		});

		test("retry-fallback chip appends the model to the default chain without a thinking strip", () => {
			const model = makeModel("test", "retry-fallback-model");
			const { hub, onAssign, onFallbackChainChange } = createHub({ models: [model], scoped: true });
			installTestTheme();

			hub.handleInput("\n"); // Sidebar → model list.
			hub.handleInput("\n");
			hub.handleInput(LEFT); // wraps to the trailing retry-fallback chip
			hub.handleInput("\n");

			expect(onFallbackChainChange).toHaveBeenCalledWith("default", ["test/retry-fallback-model"]);
			expect(onAssign).not.toHaveBeenCalled();
			expect(footerLine(hub.render(220))).not.toContain("inherit");

			// A second registration of the same model is a no-op, not a duplicate.
			hub.handleInput("\n");
			hub.handleInput(LEFT);
			hub.handleInput("\n");
			expect(onFallbackChainChange).toHaveBeenCalledTimes(1);
		});

		test("overflowing role strip scrolls left so the selected chip stays visible", () => {
			const model = makeModel("test", "narrow-strip-model");
			const { hub } = createHub({ models: [model], scoped: true });
			installTestTheme();

			hub.handleInput("\n"); // Sidebar → model list.
			hub.handleInput("\n"); // open the role strip
			// At full width every chip fits and no left ellipsis appears.
			expect(footerLine(hub.render(220))).not.toContain("…");

			hub.handleInput(LEFT); // wrap to the trailing retry-fallback chip
			const narrow = footerLine(hub.render(80));
			expect(narrow).toContain("[ retry-fallback ]");
			expect(narrow).toContain("…");

			// Back on the first chip the window resets — no leading ellipsis.
			hub.handleInput("\x1b[C"); // wrap right back to the first chip
			const reset = footerLine(hub.render(80));
			expect(reset).toContain("[ default");
			expect(reset.trimStart().startsWith("…")).toBe(false);
		});
	});

	describe("fallback chains in the roles view", () => {
		/** Hop to the Roles sidebar entry and dive into its rows. */
		function enterRolesView(hub: ModelHubComponent): void {
			hub.handleInput(UP); // All models → Roles
			hub.handleInput("\n"); // dive into the rows
		}

		test("renders configured chain entries as indented rows under their role", () => {
			const a = makeModel("test", "model-a");
			const b = makeModel("test", "model-b");
			const settings = Settings.isolated({
				"retry.fallbackChains": { default: ["test/model-a", "test/model-b"] },
			});
			const { hub } = createHub({ models: [a, b], scoped: true, settings });

			enterRolesView(hub);
			const rendered = normalize(hub.render(220));
			expect(rendered).toContain("↳ test/model-a");
			expect(rendered).toContain("↳ test/model-b");
		});

		test("f on a role opens fallback assignment and Enter appends the picked model", () => {
			const a = makeModel("test", "model-a");
			const settings = Settings.isolated({});
			const { hub, onFallbackChainChange, onAssign } = createHub({ models: [a], scoped: true, settings });

			enterRolesView(hub);
			hub.handleInput("f"); // add a fallback for the first role (default)
			expect(normalize(hub.render(220))).toContain("Adding fallback for");

			hub.handleInput("\n"); // focus already on the model rows: pick the only model
			expect(onFallbackChainChange).toHaveBeenCalledWith("default", ["test/model-a"]);
			expect(onAssign).not.toHaveBeenCalled(); // no role assignment, no thinking strip
			expect(normalize(hub.render(220))).toContain("↳ test/model-a");
		});

		test("x removes a chain entry and Enter on an entry replaces it", () => {
			const a = makeModel("test", "model-a");
			const b = makeModel("test", "model-b");
			const settings = Settings.isolated({
				"retry.fallbackChains": { default: ["test/model-a", "test/model-b"] },
			});
			const { hub, onFallbackChainChange } = createHub({ models: [a, b], scoped: true, settings });

			enterRolesView(hub);
			hub.handleInput(DOWN); // default → its first chain entry (model-a)
			hub.handleInput("\n"); // replace this entry
			expect(normalize(hub.render(220))).toContain("Replacing fallback of");
			for (const ch of "model-b") hub.handleInput(ch); // search: arrows hop scopes in assign mode
			hub.handleInput("\n");
			expect(onFallbackChainChange).toHaveBeenLastCalledWith("default", ["test/model-b"]);

			hub.handleInput("x"); // cursor landed on the replaced entry — remove it
			expect(onFallbackChainChange).toHaveBeenLastCalledWith("default", []);
			expect(normalize(hub.render(220))).not.toContain("↳");
		});

		test("] moves a chain entry later and the cursor follows it", () => {
			const a = makeModel("test", "model-a");
			const b = makeModel("test", "model-b");
			const settings = Settings.isolated({
				"retry.fallbackChains": { default: ["test/model-a", "test/model-b"] },
			});
			const { hub, onFallbackChainChange } = createHub({ models: [a, b], scoped: true, settings });

			enterRolesView(hub);
			hub.handleInput(DOWN); // first chain entry (model-a)
			hub.handleInput("]");
			expect(onFallbackChainChange).toHaveBeenLastCalledWith("default", ["test/model-b", "test/model-a"]);

			// Cursor followed the moved entry: x removes model-a, not model-b.
			hub.handleInput("x");
			expect(onFallbackChainChange).toHaveBeenLastCalledWith("default", ["test/model-b"]);
		});

		/** `smol` holds a global weighted-random pool: `a` weighted, `b` with an effort, funded from included plans. */
		function pooledSettings(models: Record<string, Record<string, unknown>> | undefined = undefined): Settings {
			const settings = Settings.isolated();
			settings.setModelRoleSpec("smol", {
				strategy: "weighted-random",
				models: models ?? {
					a: { model: "test/model-a", weight: 2 },
					b: { model: "test/model-b", defaultEffort: "high" },
				},
				routing: { funding: { order: ["included"] } },
			});
			return settings;
		}

		function smolGroup(settings: Settings) {
			const spec = settings.getModelRoleSpec("smol");
			if (spec?.kind !== "group") throw new Error(`smol is not a pool: ${spec?.kind}`);
			return spec.group;
		}

		/** A Charm Hyper prepaid balance report fetched at `fetchedAt`. */
		function hyperReport(remaining: number, unit: "usd" | "credits", fetchedAt: number): UsageReport {
			return {
				provider: "charm-hyper",
				fetchedAt,
				limits: [
					{
						id: "charm-hyper:credits",
						label: "Credit balance",
						scope: { provider: "charm-hyper", windowId: "balance", shared: true },
						amount: { remaining, unit },
					},
				],
			};
		}

		test("the billing summary names each source state, remaining amount, and unknown reason", () => {
			const now = 10_000_000;
			const copilot: UsageReport = {
				provider: "github-copilot",
				fetchedAt: now,
				limits: [],
				metadata: { plan: "individual", premiumOveragePermitted: true },
			};
			expect(billingSummary("charm-hyper", [hyperReport(12.3, "usd", now)], now)).toBe(
				"prepaid-credits available $12.30",
			);
			expect(billingSummary("charm-hyper", [hyperReport(0, "credits", now)], now)).toBe(
				"prepaid-credits exhausted 0 credits",
			);
			expect(billingSummary("charm-hyper", [hyperReport(0.05, "usd", now)], now)).toBe(
				"prepaid-credits available $0.05",
			);
			expect(billingSummary("github-copilot", [copilot], now)).toBe(
				"subscription-included unknown, paid-extra-usage available",
			);
			// Two accounts reporting the same balance show it once.
			expect(
				billingSummary(
					"charm-hyper",
					[hyperReport(489.25, "credits", now), hyperReport(489.25, "credits", now)],
					now,
				),
			).toBe("prepaid-credits available 489.25 credits");
			expect(billingSummary("charm-hyper", [], now)).toBe("unknown (no-report)");
			expect(billingSummary("charm-hyper", undefined, now)).toBe("unknown (no-report)");
			expect(billingSummary("test", [], now)).toBeUndefined();
			expect(billingSummary("charm-hyper", [hyperReport(5, "usd", now - 16 * 60_000)], now)).toBe("unknown (stale)");
		});

		test("the billing summary formats amounts exactly per currency, sign, and cap", () => {
			const now = 10_000_000;
			const window = { five_hour: { utilization: 12, resets_at: "2099-01-01T00:00:00Z" } };
			const claude = (spend: Record<string, unknown>) => {
				const report = parseClaudeUsagePayload(
					{ ...window, spend: { enabled: true, ...spend } },
					{},
					undefined,
					now,
				);
				if (!report) throw new Error("fixture did not parse");
				return billingSummary("anthropic", [report], now);
			};
			expect(claude({ used: { amount_minor: 4200, exponent: 2, currency: "USD" }, limit: null })).toBe(
				"subscription-included available, paid-extra-usage available uncapped",
			);
			expect(billingSummary("charm-hyper", [hyperReport(-0.5, "usd", now)], now)).toBe(
				"prepaid-credits exhausted -$0.50",
			);
			// No bundled reader reports a non-USD balance, so a test reader supplies one per currency.
			const moneyIn = (amountMinor: number, currency: string) => {
				const unregister = retryFallbackBillingRegistry.register({
					id: "test",
					readBilling: report =>
						knownBilling(report, [
							{
								mode: "prepaid-credits",
								state: "available",
								allowance: { kind: "money", remaining: { amountMinor, currency } },
							},
						]),
				});
				try {
					return billingSummary("test", [{ provider: "test", fetchedAt: now, limits: [] }], now);
				} finally {
					unregister();
				}
			};
			expect(moneyIn(1000, "JPY")).toBe("prepaid-credits available 1000 JPY");
			expect(moneyIn(3766, "BHD")).toBe("prepaid-credits available 3.766 BHD");
			expect(moneyIn(-50, "EUR")).toBe("prepaid-credits available -0.50 EUR");
			expect(moneyIn(1234, "ZZZ")).toBe("prepaid-credits available 1234 ZZZ minor units");
		});

		test("the billing summary lists each account's balance and counts accounts without evidence", () => {
			const now = 10_000_000;
			expect(billingSummary("charm-hyper", [hyperReport(12.3, "usd", now), hyperReport(5, "usd", now)], now)).toBe(
				"prepaid-credits available $12.30, prepaid-credits available $5.00",
			);
			expect(
				billingSummary(
					"charm-hyper",
					[hyperReport(12.3, "usd", now), hyperReport(5, "usd", now - 16 * 60_000)],
					now,
				),
			).toBe("prepaid-credits available $12.30 (+1 unknown)");
		});

		test("the source reads billing from held reports only, and shows none without them", () => {
			const fetchSpy = vi.spyOn(globalThis, "fetch");
			try {
				const settings = Settings.isolated();
				let reads = 0;
				const source = createModelBrowserSource(settings, undefined, {
					usageReports: () => {
						reads++;
						return [hyperReport(12.3, "usd", Date.now())];
					},
				});
				expect(source.billingFor?.("charm-hyper/model-a")).toBe("prepaid-credits available $12.30");
				expect(reads).toBe(1);
				expect(fetchSpy).not.toHaveBeenCalled();
				// The revision follows the held reports, so a hub left open re-reads after a poll.
				let held: UsageReport[] = [hyperReport(1, "usd", Date.now())];
				const polled = createModelBrowserSource(settings, undefined, { usageReports: () => held });
				const before = polled.billingRevision;
				expect(polled.billingRevision).toBe(before);
				held = [hyperReport(2, "usd", Date.now())];
				expect(polled.billingRevision).not.toBe(before);
				expect(createModelBrowserSource(settings).billingFor).toBeUndefined();
			} finally {
				fetchSpy.mockRestore();
			}
		});

		test("the source reads a self-hosted model's billing from its resolved endpoint", () => {
			const endpoints: Record<string, string> = {
				"vllm/on-box": "http://127.0.0.1:8000/v1",
				"vllm/lan-box": "http://192.168.1.20:8000/v1",
			};
			const source = createModelBrowserSource(Settings.isolated(), undefined, {
				usageReports: () => [],
				modelBaseUrl: (provider, id) => endpoints[`${provider}/${id}`],
			});
			expect(source.billingFor?.("vllm/on-box")).toBe("free available uncapped");
			expect(source.billingFor?.("vllm/lan-box")).toBe("unknown (no-evidence)");
			expect(source.billingFor?.("vllm/unresolved")).toBe("unknown (no-report)");
		});

		test("a pool member row shows the member's billing from held reports", () => {
			const settings = pooledSettings({ a: { model: "charm-hyper/model-a" } });
			const { hub } = createHub({
				models: [makeModel("charm-hyper", "model-a")],
				scoped: true,
				settings,
				usageReports: () => [hyperReport(12.3, "usd", Date.now())],
			});
			enterRolesView(hub);
			hub.handleInput(DOWN); // SMOL
			hub.handleInput(DOWN); // its only member
			expect(normalize(hub.render(220))).toContain("a charm-hyper/model-a billing prepaid-credits available $12.30");
		});

		test("a narrow role row drops its billing before the thinking label", () => {
			const settings = Settings.isolated();
			settings.setModelRole("smol", "charm-hyper/model-a:high");
			const { hub } = createHub({
				models: [makeModel("charm-hyper", "model-a")],
				scoped: true,
				settings,
				usageReports: () => [hyperReport(12.3, "usd", Date.now())],
			});
			enterRolesView(hub);
			const smolRow = (width: number) =>
				hub
					.render(width)
					.map(line => stripVTControlCharacters(line))
					.find(line => line.includes("SMOL")) ?? "";
			expect(smolRow(220)).toContain("billing prepaid-credits available $12.30");
			expect(smolRow(80)).toContain("high");
			expect(smolRow(80)).not.toContain("billing");
			// At no width does billing stay while the thinking label goes.
			for (let width = 60; width <= 220; width++) {
				const row = smolRow(width);
				if (row.includes("billing")) expect(row).toContain("high");
			}
		});

		test("g cycles a pool through every strategy, including quota, and back to priority", () => {
			const settings = pooledSettings();
			const { hub } = createHub({
				models: [makeModel("test", "model-a"), makeModel("test", "model-b")],
				scoped: true,
				settings,
			});
			enterRolesView(hub);
			hub.handleInput(DOWN); // SMOL
			const seen: string[] = [];
			for (let i = 0; i < 10; i++) {
				hub.handleInput("g");
				seen.push(smolGroup(settings).strategy.name);
			}
			expect(seen).toEqual([
				"random",
				"quota",
				"cheapest",
				"least-used",
				"least-loaded",
				"p2c",
				"shuffle-bag",
				"priority",
				"round-robin",
				"weighted-random",
			]);
		});

		test("g moves a pool with a spending policy into and out of quota, keeping its routing", () => {
			const settings = Settings.isolated();
			const routing = {
				funding: { order: ["included", "metered"] },
				spending: { policy: "provider-managed" },
			};
			settings.setModelRoleSpec("smol", {
				strategy: "random",
				models: { a: { model: "test/model-a" }, b: { model: "test/model-b" } },
				routing,
			});
			const { hub } = createHub({
				models: [makeModel("test", "model-a"), makeModel("test", "model-b")],
				scoped: true,
				settings,
			});
			enterRolesView(hub);
			hub.handleInput(DOWN); // SMOL
			hub.handleInput("g");
			expect(settings.getModelRoleEntries().smol).toEqual({
				strategy: "quota",
				models: { a: { model: "test/model-a" }, b: { model: "test/model-b" } },
				routing,
			});
			expect(normalize(hub.render(220))).toContain("SMOL pool · 2 models · quota");
			hub.handleInput("g");
			expect(settings.getModelRoleEntries().smol).toMatchObject({ strategy: "cheapest", routing });
		});

		test("g leaves quota for cheapest without the quota-only tolerance", () => {
			const settings = Settings.isolated();
			settings.setModelRoleSpec("smol", {
				strategy: "quota",
				strategyOptions: { tolerance: 0.1 },
				models: { a: { model: "test/model-a" }, b: { model: "test/model-b" } },
			});
			const { hub } = createHub({
				models: [makeModel("test", "model-a"), makeModel("test", "model-b")],
				scoped: true,
				settings,
			});
			enterRolesView(hub);
			hub.handleInput(DOWN); // SMOL
			hub.handleInput("g");
			expect(smolGroup(settings).strategy).toEqual({ name: "cheapest" });
			expect(settings.getModelRoleEntries().smol).not.toHaveProperty("strategyOptions");
		});

		test("g keeps the cursor on its member when the new strategy lists members in another order", () => {
			const settings = Settings.isolated();
			settings.setModelRoleSpec("smol", {
				strategy: "round-robin",
				strategyOptions: { order: ["b", "a"] },
				models: { a: { model: "test/model-a" }, b: { model: "test/model-b" } },
			});
			const { hub } = createHub({
				models: [makeModel("test", "model-a"), makeModel("test", "model-b")],
				scoped: true,
				settings,
			});
			enterRolesView(hub);
			hub.handleInput(DOWN); // SMOL
			hub.handleInput(DOWN); // member b, first in round-robin order
			hub.handleInput("g"); // weighted-random lists members in alias order
			hub.handleInput("w");
			expect(settings.getModelRoleEntries().smol).toMatchObject({
				strategy: "weighted-random",
				models: { a: { model: "test/model-a" }, b: { model: "test/model-b", weight: 1 } },
			});
		});

		/** Settings backed by a global config.yml in a temp agent dir holding `config`. */
		async function fileSettings(tmp: TempDir, config: string): Promise<Settings> {
			const agentDir = tmp.join("agent");
			await fs.mkdir(agentDir, { recursive: true });
			await fs.writeFile(path.join(agentDir, "config.yml"), config);
			return Settings.loadIsolated({ cwd: tmp.path(), agentDir });
		}

		test("the account order editor offers trusted-layer account names, never project-only ones", async () => {
			const tmp = TempDir.createSync("@pi-model-hub-account-names-");
			try {
				await fs.mkdir(tmp.join(".omp"), { recursive: true });
				await fs.writeFile(
					tmp.join(".omp", "config.yml"),
					"auth:\n  accountPolicies:\n    - provider: test\n      name: projonly\n      account: { email: p@example.com }\n",
				);
				const settings = await fileSettings(
					tmp,
					[
						"auth:",
						"  accountPolicies:",
						"    - provider: test",
						"      name: work",
						"      account: { email: w@example.com }",
						"modelRoles:",
						"  default: test/model-a",
						"  smol:",
						"    strategy: random",
						"    models:",
						"      a: { model: test/model-a }",
					].join("\n"),
				);
				expect(createModelBrowserSource(settings).accountNames).toEqual(["work"]);

				const { hub } = createHub({ models: [makeModel("test", "model-a")], scoped: true, settings });
				enterRolesView(hub);
				hub.handleInput(DOWN); // SMOL
				hub.handleInput("e");
				hub.handleInput("\n"); // account order
				const strip = footerLine(hub.render(220));
				expect(strip).toContain("work");
				expect(strip).not.toContain("projonly");
				hub.handleInput("\n"); // toggle work
				const roles = settings.getGlobalSettings().modelRoles as Record<string, { routing?: unknown }>;
				expect(roles.smol?.routing).toEqual({ accounts: { order: ["work"] } });
			} finally {
				AgentStorage.close();
				tmp.removeSync();
			}
		});

		for (const kind of ["role", "chain", "group"] as const) {
			test(`the ${kind} pool writer refuses project-only account order and drain without changing global config`, async () => {
				const tmp = TempDir.createSync("@pi-model-hub-account-writer-");
				try {
					await Bun.write(
						tmp.join(".omp", "config.yml"),
						"auth:\n  accountPolicies:\n    - provider: test\n      name: projonly\n      account: { email: p@example.com }\n",
					);
					const settings = await fileSettings(
						tmp,
						"auth:\n  accountPolicies:\n    - provider: test\n      name: work\n      account: { email: w@example.com }\n",
					);
					const config = Bun.file(tmp.join("agent", "config.yml"));
					const before = await config.text();
					const globalBefore = structuredClone(settings.getGlobalSettings());
					const revision = settings.revision;
					const target = { kind, key: "smol" };
					const pool = { strategy: "random", models: { a: { model: "test/model-a" } } };
					for (const accounts of [{ order: ["work", "projonly"] }, { order: ["work"], drain: "projonly" }]) {
						const refused = writeModelHubPool(settings, target, { ...pool, routing: { accounts } });
						expect(refused).toContain("routing.accounts.");
						expect(refused).toContain("projonly");
						expect(refused).toContain("trusted auth.accountPolicies");
						expect(settings.getGlobalSettings()).toEqual(globalBefore);
						expect(settings.revision).toBe(revision);
						await settings.flush();
						expect(await config.text()).toBe(before);
					}
					const accepted = {
						...pool,
						routing: { accounts: { order: ["work"], drain: "work" } },
					};
					expect(writeModelHubPool(settings, target, accepted)).toBeUndefined();
					await settings.flush();
					expect(Bun.YAML.parse(await config.text())).toMatchObject(
						kind === "role"
							? { modelRoles: { smol: accepted } }
							: kind === "chain"
								? { retry: { fallbackChains: { smol: accepted } } }
								: { modelGroups: { smol: accepted } },
					);
					expect(writeModelHubPool(settings, target, undefined)).toBeUndefined();
					await settings.flush();
					expect(await config.text()).not.toContain("drain:");
				} finally {
					AgentStorage.close();
					tmp.removeSync();
				}
			});

			test(`the ${kind} pool writer keeps stored unknown account names on unrelated edits`, async () => {
				const tmp = TempDir.createSync("@pi-model-hub-account-stale-");
				try {
					const section =
						kind === "role"
							? "modelRoles:\n  smol:\n"
							: kind === "chain"
								? "retry:\n  fallbackChains:\n    smol:\n"
								: "modelGroups:\n  smol:\n";
					const indent = kind === "chain" ? "      " : "    ";
					const storedPool = [
						"strategy: random",
						"models:",
						"  a: { model: test/model-a }",
						"routing:",
						"  accounts: { order: [gone], drain: gone }",
					]
						.map(line => `${indent}${line}\n`)
						.join("");
					const settings = await fileSettings(
						tmp,
						`auth:\n  accountPolicies:\n    - provider: test\n      name: work\n      account: { email: w@example.com }\n${section}${storedPool}`,
					);
					const target = { kind, key: "smol" };
					const edited = {
						strategy: "cheapest",
						models: { a: { model: "test/model-a" } },
						routing: { accounts: { order: ["gone"], drain: "gone" } },
					};
					expect(writeModelHubPool(settings, target, edited)).toBeUndefined();
					const refused = writeModelHubPool(settings, target, {
						...edited,
						routing: { accounts: { order: ["gone", "other"], drain: "gone" } },
					});
					expect(refused).toContain("other");
				} finally {
					AgentStorage.close();
					tmp.removeSync();
				}
			});
		}

		test("the drain editor surfaces a writer refusal when a name loses trust before submission", () => {
			const settings = Settings.isolated();
			cfgAuthAccountPolicies.set(settings, [
				{ provider: "test", name: "work", account: { email: "w@example.com" } },
			]);
			settings.setModelRoleSpec("smol", {
				strategy: "random",
				models: { a: { model: "test/model-a" } },
			});
			const { hub } = createHub({ models: [makeModel("test", "model-a")], scoped: true, settings });
			enterRolesView(hub);
			hub.handleInput(DOWN);
			hub.handleInput("e");
			hub.handleInput("\x1b[C");
			hub.handleInput("\n");
			hub.handleInput("\x1b[C");
			cfgAuthAccountPolicies.set(settings, []);
			const before = structuredClone(settings.getGlobalSettings());
			hub.handleInput("\n");
			const rendered = normalize(hub.render(220));
			expect(rendered).toContain("routing.accounts.drain");
			expect(rendered).toContain("work");
			expect(rendered).toContain("trusted auth.accountPolicies");
			expect(settings.getGlobalSettings()).toEqual(before);
		});

		const INVALID_SMOL_POOL = [
			"modelRoles:",
			"  default: test/model-a",
			"  smol:",
			"    strategy: priority",
			"    models:",
			"      a: { model: test/model-a }",
			"",
		].join("\n");

		/** `modelRoles` as written to the temp agent dir's config.yml after pending saves land. */
		async function savedRoles(settings: Settings, tmp: TempDir): Promise<unknown> {
			await settings.flush();
			const saved: unknown = Bun.YAML.parse(await fs.readFile(path.join(tmp.join("agent"), "config.yml"), "utf8"));
			return saved && typeof saved === "object" && "modelRoles" in saved ? saved.modelRoles : undefined;
		}

		test("an invalid global pool shows the validator's problem, and x removes it", async () => {
			const tmp = TempDir.createSync("@pi-hub-invalid-pool-");
			try {
				const settings = await fileSettings(tmp, INVALID_SMOL_POOL);
				expect(createModelBrowserSource(settings).getPool?.({ kind: "role", key: "smol" })?.invalid).toBe(
					"modelRoles.smol.strategyOptions: priority requires order listing every member alias exactly once",
				);
				const { hub } = createHub({
					models: [makeModel("test", "model-a")],
					scoped: true,
					settings,
					callbacks: { onUnassign: role => settings.setModelRole(role, undefined) },
				});
				enterRolesView(hub);
				hub.handleInput(DOWN); // SMOL
				expect(normalize(hub.render(220))).toContain(
					"SMOL invalid pool · skipped · modelRoles.smol.strategyOptions",
				);
				expect(footerLine(hub.render(220))).toContain("x clear");
				hub.handleInput("x");
				expect(await savedRoles(settings, tmp)).toEqual({ default: "test/model-a" });
				expect(normalize(hub.render(220))).not.toContain("invalid pool");
			} finally {
				AgentStorage.close();
				tmp.removeSync();
			}
		});

		test("Enter on an invalid global pool assigns one model in its place", async () => {
			const tmp = TempDir.createSync("@pi-hub-invalid-pool-");
			try {
				const settings = await fileSettings(tmp, INVALID_SMOL_POOL);
				const { hub } = createHub({
					models: [makeModel("test", "model-a"), makeModel("test", "model-b")],
					scoped: true,
					settings,
					callbacks: { onAssign: (_model, role, _level, selector) => settings.setModelRole(role, selector) },
				});
				enterRolesView(hub);
				hub.handleInput(DOWN); // SMOL
				expect(footerLine(hub.render(220))).toContain("⏎ replace");
				hub.handleInput("\n");
				for (const ch of "model-b") hub.handleInput(ch);
				hub.handleInput("\n");
				expect(await savedRoles(settings, tmp)).toEqual({ default: "test/model-a", smol: "test/model-b" });
			} finally {
				AgentStorage.close();
				tmp.removeSync();
			}
		});

		test("g leaves a strategy list as configured, which the pool row shows in order", () => {
			for (const strategy of [["cheapest", "random"], ["cheapest"]]) {
				const settings = Settings.isolated();
				settings.setModelRoleSpec("smol", {
					strategy,
					models: { a: { model: "test/model-a" }, b: { model: "test/model-b" } },
				});
				const { hub } = createHub({
					models: [makeModel("test", "model-a"), makeModel("test", "model-b")],
					scoped: true,
					settings,
				});
				enterRolesView(hub);
				hub.handleInput(DOWN); // SMOL
				expect(normalize(hub.render(220))).toContain(strategy.join(" → "));
				hub.handleInput("g");
				expect(settings.getModelRoleEntries().smol).toMatchObject({ strategy });
				expect(normalize(hub.render(220))).toContain("change it with e");
			}
		});

		test("member edits keep the order of a strategy list that ends in priority", () => {
			const settings = Settings.isolated();
			settings.setModelRoleSpec("smol", {
				strategy: ["cheapest", "priority"],
				strategyOptions: { order: ["a", "b"] },
				models: { a: { model: "test/model-a" }, b: { model: "test/model-b" } },
			});
			const { hub } = createHub({
				models: [makeModel("test", "model-a"), makeModel("test", "model-b"), makeModel("test", "model-c")],
				scoped: true,
				settings,
			});
			const smol = () => settings.getModelRoleEntries().smol as Record<string, unknown>;
			enterRolesView(hub);
			hub.handleInput(DOWN); // SMOL
			hub.handleInput("\n"); // add a member
			for (const ch of "model-c") hub.handleInput(ch);
			hub.handleInput("\n");
			expect(smol()).toMatchObject({
				strategy: ["cheapest", "priority"],
				strategyOptions: { order: ["a", "b", "model-c"] },
			});
			hub.handleInput("x"); // the cursor landed on the new member
			expect(smol()).toMatchObject({ strategy: ["cheapest", "priority"], strategyOptions: { order: ["a", "b"] } });
			hub.handleInput(UP);
			hub.handleInput(UP); // member a
			hub.handleInput("]");
			expect(smol()).toMatchObject({ strategy: ["cheapest", "priority"], strategyOptions: { order: ["b", "a"] } });
		});

		test("g drops a least-used window when cycling past it", () => {
			const settings = Settings.isolated();
			settings.setModelRoleSpec("smol", {
				strategy: "least-used",
				strategyOptions: { window: { type: "rolling", durationMs: 3_600_000 } },
				models: { a: { model: "test/model-a" }, b: { model: "test/model-b" } },
			});
			const { hub } = createHub({
				models: [makeModel("test", "model-a"), makeModel("test", "model-b")],
				scoped: true,
				settings,
			});
			enterRolesView(hub);
			hub.handleInput(DOWN); // SMOL
			hub.handleInput("g");
			expect(smolGroup(settings).strategy).toEqual({ name: "least-loaded" });
			expect(settings.getModelRoleEntries().smol).not.toHaveProperty("strategyOptions");
		});

		test("the source summarises a pool's local limits", () => {
			const settings = Settings.isolated({
				modelRoles: {
					smol: {
						strategy: "random",
						routing: {
							limits: [{ metric: "requests", max: 4, window: { type: "rolling", durationMs: 3_600_000 } }],
						},
						models: { a: { model: "test/model-a" } },
					},
				},
			});
			expect(createModelBrowserSource(settings).getPool?.({ kind: "role", key: "smol" })?.limits).toBe(
				"1 limit, closest ? / 4 requests per 1h · rolling",
			);
		});

		test("the source counts a pool's recorded calls in its limits summary", async () => {
			const tmp = TempDir.createSync("@pi-hub-limits-");
			try {
				const storage = await AgentStorage.open(tmp.join("agent.db"));
				const settings = Settings.isolated(
					{
						modelRoles: {
							smol: {
								strategy: "random",
								routing: {
									limits: [{ metric: "requests", max: 4, window: { type: "rolling", durationMs: 3_600_000 } }],
								},
								models: { a: { model: "test/model-a" } },
							},
						},
					},
					{ storage },
				);
				storage.usageLedger.record({
					atMs: Date.now(),
					provider: "test",
					model: "model-a",
					pool: "role:smol",
					costNanos: 0,
					inputTokens: 1,
					outputTokens: 1,
				});
				expect(createModelBrowserSource(settings).getPool?.({ kind: "role", key: "smol" })?.limits).toBe(
					"1 limit, closest 1 / 4 requests per 1h · rolling",
				);
			} finally {
				AgentStorage.close();
				tmp.removeSync();
			}
		});

		test("the source maps pools to scheduling-ordered members with routing text, and gates writes by layer", () => {
			const settings = Settings.isolated({ modelRoles: { slow: "+fast@deep" } });
			settings.setModelRoleSpec("smol", {
				strategy: "priority",
				strategyOptions: { order: ["z", "a"] },
				models: { a: { model: "test/model-a" }, z: { model: "test/model-z", defaultEffort: "low" } },
				profile: "quick",
				profiles: { quick: { a: { effort: "minimal" } } },
				routing: {
					funding: { order: ["free", "metered"] },
					spending: { policy: "provider-managed" },
				},
			});
			settings.setModelGroup("fast", {
				strategy: "random",
				models: { m: { model: "test/model-m" } },
				profiles: { deep: { m: { effort: "high" } } },
			});
			settings.setModelRole("default", "test/model-a");
			const source = createModelBrowserSource(settings);

			const pool = source.getPool?.({ kind: "role", key: "smol" });
			expect(pool).toMatchObject({
				source: { kind: "inline" },
				strategy: "priority",
				members: [
					{ alias: "z", model: "test/model-z", effort: "low" },
					{ alias: "a", model: "test/model-a", effort: "minimal" },
				],
				funding: ["free", "metered"],
				spending: "provider-managed",
			});
			expect(pool?.readOnly).toBeUndefined();
			expect(pool?.limits).toBeUndefined();
			expect(pool?.raw).toEqual(settings.getModelRoleEntries().smol as Record<string, unknown>);

			// A reference shows the shared group through its profile; edits replace the global group definition.
			const ref = source.getPool?.({ kind: "role", key: "slow" });
			expect(ref).toMatchObject({
				source: { kind: "ref", group: "fast", profile: "deep" },
				members: [{ alias: "m", model: "test/model-m", effort: "high" }],
			});
			expect(ref?.readOnly).toBeUndefined();
			expect(ref?.raw).toEqual({
				strategy: "random",
				models: { m: { model: "test/model-m" } },
				profiles: { deep: { m: { effort: "high" } } },
			});
			// A runtime-layer value would shadow a global write.
			expect(source.poolWriteBlocker?.({ kind: "role", key: "slow" })).toBe("set in the runtime layer");
			expect(source.poolWriteBlocker?.({ kind: "role", key: "smol" })).toBeUndefined();
			expect(source.getPool?.({ kind: "role", key: "default" })).toBeUndefined();
		});

		test("m turns a legacy role into a priority pool that keeps its order and efforts", () => {
			const settings = Settings.isolated();
			settings.setModelRole("smol", "test/model-b:high,test/model-a");
			const { hub } = createHub({ models: [makeModel("test", "model-a"), makeModel("test", "model-b")], settings });

			enterRolesView(hub);
			hub.handleInput(DOWN); // DEFAULT → SMOL
			expect(footerLine(hub.render(220))).toContain("m pool");
			hub.handleInput("m");

			const group = smolGroup(settings);
			expect(group.strategy).toEqual({ name: "priority", order: ["model-b", "model-a"] });
			expect(group.models as readonly unknown[]).toEqual([
				{ kind: "model", alias: "model-a", model: "test/model-a" },
				{ kind: "model", alias: "model-b", model: "test/model-b", defaultEffort: "high" },
			]);
			expect(normalize(hub.render(220))).toContain("SMOL pool · 2 models · priority");
		});

		test("a refused pool edit shows the validator's message and writes nothing", () => {
			const settings = pooledSettings({ a: { model: "test/model-a" } });
			const { hub } = createHub({ models: [makeModel("test", "model-a")], scoped: true, settings });

			enterRolesView(hub);
			hub.handleInput(DOWN); // SMOL
			hub.handleInput(DOWN); // its only member
			hub.handleInput("x");

			expect(normalize(hub.render(220))).toContain("modelRoles.smol.models: must define at least one model");
			expect(smolGroup(settings).models.map(member => member.alias)).toEqual(["a"]);
			hub.handleInput(UP);
			expect(normalize(hub.render(220))).not.toContain("must define at least one model");
		});

		test("windows the roles list so model-keyed chains past the panel height stay reachable", () => {
			const settings = Settings.isolated({
				// Model-keyed chains sort alphabetically; the unique tail key lands last.
				"retry.fallbackChains": {
					"aa-provider/head-chain": ["x/y"],
					"mm-provider/mid-chain": ["x/y"],
					"zz-provider/tail-chain-marker": ["x/y"],
				},
			});
			// A short terminal makes the built-in roles alone fill the panel, so the
			// model-keyed chains that follow the separator land below the fold. The
			// chain keys are not available models, so no role auto-assignment leaks
			// their names into the visible role rows.
			const { hub } = createHub({ models: [makeModel("test", "solo")], settings, terminalRows: 16 });

			enterRolesView(hub);
			const top = normalize(hub.render(120));
			// The alphabetically last model-keyed chain is clipped, but the panel
			// now advertises the hidden rows instead of dropping them silently.
			expect(top).not.toContain("tail-chain-marker");
			expect(top).toContain("more");

			// Wrapping up from the top row lands on the trailing "+ New fallback…"
			// row; the window scrolls to the bottom and reveals the clipped chain.
			hub.handleInput(UP);
			const bottom = normalize(hub.render(120));
			expect(bottom).toContain("tail-chain-marker");
		});

		test("clicking a roles row hits the row under the pointer", () => {
			const a = makeModel("test", "model-a");
			const { hub } = createHub({ models: [a], scoped: true });

			hub.handleInput(UP); // All models → Roles
			// Derive the pointer row from the frame itself: the fullscreen
			// overlay paints from screen row 0, so frame index == screen row.
			const frame = hub.render(220).map(line => stripVTControlCharacters(line));
			const screenRow = frame.findIndex(line => line.includes("DEFAULT"));
			expect(screenRow).toBeGreaterThan(0);
			const sgr = `\x1b[<0;61;${screenRow + 1}M`; // SGR reports are 1-based
			hub.handleInput(sgr); // select (dive into rows)
			hub.handleInput(sgr); // click-again activates
			expect(normalize(hub.render(220))).toContain("Assigning DEFAULT");
		});

		test("fallbacks chip keys a new chain by the selected model", () => {
			const a = makeModel("test", "model-a");
			const b = makeModel("test", "model-b");
			const { hub, onFallbackChainChange } = createHub({ models: [a, b], scoped: true });

			for (const ch of "model-a") hub.handleInput(ch);
			hub.handleInput("\n"); // open the strip for model-a
			hub.handleInput(LEFT); // retry-fallback
			hub.handleInput(LEFT); // fallbacks:test/*
			hub.handleInput(LEFT); // fallbacks:model-a
			hub.handleInput("\n");
			expect(normalize(hub.render(220))).toContain("Adding fallback for test/model-a");

			for (const ch of "model-b") hub.handleInput(ch);
			hub.handleInput("\n");
			expect(onFallbackChainChange).toHaveBeenLastCalledWith("test/model-a", ["test/model-b"]);
			const rendered = normalize(hub.render(220));
			expect(rendered).toContain("test/model-a");
			expect(rendered).toContain("↳ test/model-b");
		});

		test("provider chip keys the chain by provider/*", () => {
			const a = makeModel("test", "model-a");
			const b = makeModel("test", "model-b");
			const { hub, onFallbackChainChange } = createHub({ models: [a, b], scoped: true });

			for (const ch of "model-a") hub.handleInput(ch);
			hub.handleInput("\n");
			hub.handleInput(LEFT); // retry-fallback
			hub.handleInput(LEFT); // fallbacks:test/*
			hub.handleInput("\n");
			expect(normalize(hub.render(220))).toContain("Adding fallback for test/*");

			for (const ch of "model-b") hub.handleInput(ch);
			hub.handleInput("\n");
			expect(onFallbackChainChange).toHaveBeenLastCalledWith("test/*", ["test/model-b"]);
		});

		test("+ New fallback… picks the protected model, then keys the chain via the strip", () => {
			const a = makeModel("test", "model-a");
			const b = makeModel("test", "model-b");
			const { hub, onFallbackChainChange } = createHub({ models: [a, b], scoped: true });

			enterRolesView(hub);
			hub.handleInput(UP); // wrap to the trailing "+ New fallback…"
			hub.handleInput("\n");
			expect(normalize(hub.render(220))).toContain("New fallback chain");

			for (const ch of "model-a") hub.handleInput(ch);
			hub.handleInput("\n"); // pick the protected model
			const strip = footerLine(hub.render(220));
			expect(strip).toContain("for test/model-a");
			expect(strip).toContain("for test/*");

			hub.handleInput("\n"); // key by the exact model
			expect(normalize(hub.render(220))).toContain("Adding fallback for test/model-a");
			for (const ch of "model-b") hub.handleInput(ch);
			hub.handleInput("\n");
			expect(onFallbackChainChange).toHaveBeenLastCalledWith("test/model-a", ["test/model-b"]);
		});

		test("model-keyed chains render below the separator and x clears the whole chain", () => {
			const a = makeModel("test", "model-a");
			const settings = Settings.isolated({
				"retry.fallbackChains": { "test/*": ["test/model-a"] },
			});
			const { hub, onFallbackChainChange } = createHub({ models: [a], scoped: true, settings });

			enterRolesView(hub);
			const rendered = normalize(hub.render(220));
			expect(rendered).toContain("test/*");
			expect(rendered).toContain("↳ test/model-a");
			expect(rendered).toContain("+ New fallback…");
			expect(rendered).toMatch(/─{10,}/); // the roles/fallbacks divider

			hub.handleInput(UP); // + New fallback…
			hub.handleInput(UP); // ↳ test/model-a
			hub.handleInput(UP); // test/* header (separator is skipped)
			hub.handleInput("x");
			expect(onFallbackChainChange).toHaveBeenLastCalledWith("test/*", []);
			expect(normalize(hub.render(220))).not.toContain("↳ test/model-a");
		});

		test("t on a fallback entry sets an explicit effort suffix", () => {
			const model = getBundledModel("openai", "gpt-5.5");
			if (!model) throw new Error("Expected bundled model openai/gpt-5.5");
			const selector = `${model.provider}/${model.id}`;
			const settings = Settings.isolated({ "retry.fallbackChains": { default: [selector] } });
			const { hub, onFallbackChainChange } = createHub({ models: [model], scoped: true, settings });

			enterRolesView(hub);
			hub.handleInput(DOWN); // default → its fallback entry
			expect(footerLine(hub.render(220))).toContain("t thinking");

			hub.handleInput("t");
			const strip = footerLine(hub.render(220));
			expect(strip).toContain("inherit");
			expect(strip).toContain("off");
			expect(strip).not.toContain("auto");

			hub.handleInput("\x1b[C"); // inherit → off
			hub.handleInput("\n");
			expect(onFallbackChainChange).toHaveBeenLastCalledWith("default", [`${selector}:off`]);
			expect(normalize(hub.render(220))).toContain(`↳ ${selector}:off`);
		});

		test("t on a suffixed fallback entry clears back to inherit", () => {
			const model = getBundledModel("openai", "gpt-5.5");
			if (!model) throw new Error("Expected bundled model openai/gpt-5.5");
			const selector = `${model.provider}/${model.id}`;
			const settings = Settings.isolated({ "retry.fallbackChains": { default: [`${selector}:off`] } });
			const { hub, onFallbackChainChange } = createHub({ models: [model], scoped: true, settings });

			enterRolesView(hub);
			hub.handleInput(DOWN); // default → its fallback entry
			expect(normalize(hub.render(220))).toContain(`↳ ${selector}:off`);

			hub.handleInput("t");
			hub.handleInput(LEFT); // off → inherit
			hub.handleInput("\n");
			expect(onFallbackChainChange).toHaveBeenLastCalledWith("default", [selector]);
			expect(normalize(hub.render(220))).not.toContain(`${selector}:off`);
		});

		test("t on a routed fallback entry preserves @upstream when setting effort", () => {
			const model = makeModel("openrouter", "z-ai/glm-4.7");
			const routed = `${model.provider}/${model.id}@fireworks`;
			const settings = Settings.isolated({ "retry.fallbackChains": { default: [routed] } });
			const { hub, onFallbackChainChange } = createHub({ models: [model], scoped: true, settings });

			enterRolesView(hub);
			hub.handleInput(DOWN); // default → its fallback entry
			expect(normalize(hub.render(220))).toContain(`↳ ${routed}`);

			hub.handleInput("t");
			hub.handleInput("\x1b[C"); // inherit → off
			hub.handleInput("\n");
			expect(onFallbackChainChange).toHaveBeenLastCalledWith("default", [`${routed}:off`]);
			expect(normalize(hub.render(220))).toContain(`↳ ${routed}:off`);
		});

		test("t on a routed+suffixed entry clears back to the bare route", () => {
			const model = makeModel("openrouter", "z-ai/glm-4.7");
			const routed = `${model.provider}/${model.id}@fireworks`;
			const settings = Settings.isolated({ "retry.fallbackChains": { default: [`${routed}:off`] } });
			const { hub, onFallbackChainChange } = createHub({ models: [model], scoped: true, settings });

			enterRolesView(hub);
			hub.handleInput(DOWN); // default → its fallback entry
			hub.handleInput("t");
			hub.handleInput(LEFT); // off → inherit
			hub.handleInput("\n");
			expect(onFallbackChainChange).toHaveBeenLastCalledWith("default", [routed]);
			expect(normalize(hub.render(220))).not.toContain(`${routed}:off`);
		});

		test("wildcard fallback rows hide the thinking hint and ignore t", () => {
			const a = makeModel("test", "model-a");
			const settings = Settings.isolated({ "retry.fallbackChains": { default: ["test/*"] } });
			const { hub, onFallbackChainChange } = createHub({ models: [a], scoped: true, settings });

			enterRolesView(hub);
			hub.handleInput(DOWN); // default → its wildcard entry
			expect(normalize(hub.render(220))).toContain("↳ test/*");
			expect(footerLine(hub.render(220))).not.toContain("t thinking");

			hub.handleInput("t"); // inert: no strip, no chain write
			expect(onFallbackChainChange).not.toHaveBeenCalled();
			expect(footerLine(hub.render(220))).not.toContain("inherit");
		});

		test("t on a literal @-suffixed id does not strip it as routing", () => {
			const model = makeModel("test", "model@default");
			const selector = `${model.provider}/${model.id}`;
			const settings = Settings.isolated({ "retry.fallbackChains": { default: [selector] } });
			const { hub, onFallbackChainChange } = createHub({ models: [model], scoped: true, settings });

			enterRolesView(hub);
			hub.handleInput(DOWN); // default → its fallback entry
			expect(normalize(hub.render(220))).toContain(`↳ ${selector}`);

			hub.handleInput("t");
			hub.handleInput("\x1b[C"); // inherit → off
			hub.handleInput("\n");
			expect(onFallbackChainChange).toHaveBeenLastCalledWith("default", [`${selector}:off`]);
		});

		test("t on a locked fallback entry resolves the ladder from the catalog", () => {
			const available = makeModel("test", "model-a");
			const locked = makeModel("locked", "model-x");
			const selector = `${locked.provider}/${locked.id}`;
			const settings = Settings.isolated({ "retry.fallbackChains": { default: [selector] } });
			const { hub, onFallbackChainChange } = createHub({
				models: [available],
				scoped: true,
				settings,
				registry: { getAvailable: () => [available], getAll: () => [available, locked] },
			});

			enterRolesView(hub);
			hub.handleInput(DOWN); // default → its fallback entry
			expect(footerLine(hub.render(220))).toContain("t thinking");

			hub.handleInput("t");
			hub.handleInput("\x1b[C"); // inherit → off
			hub.handleInput("\n");
			expect(onFallbackChainChange).toHaveBeenLastCalledWith("default", [`${selector}:off`]);
		});

		test("t on a case-variant entry resolves through the registry and saves canonically", () => {
			const model = getBundledModel("openai", "gpt-5.5");
			if (!model) throw new Error("Expected bundled model openai/gpt-5.5");
			const selector = `${model.provider}/${model.id}`;
			const settings = Settings.isolated({ "retry.fallbackChains": { default: ["OpenAI/GPT-5.5"] } });
			const { hub, onFallbackChainChange } = createHub({ models: [model], scoped: true, settings });

			enterRolesView(hub);
			hub.handleInput(DOWN); // default → its fallback entry
			expect(normalize(hub.render(220))).toContain("↳ OpenAI/GPT-5.5");
			expect(footerLine(hub.render(220))).toContain("t thinking");

			hub.handleInput("t");
			hub.handleInput("\x1b[C"); // inherit → off
			hub.handleInput("\n");
			expect(onFallbackChainChange).toHaveBeenLastCalledWith("default", [`${selector}:off`]);
		});

		describe("pool routing editors", () => {
			const RIGHT = "\x1b[C";
			const BACKSPACE = "\x7f";
			const NAMED_ACCOUNTS = [
				{ provider: "anthropic", name: "work", account: { email: "work@example.com" } },
				{ provider: "anthropic", name: "home", account: { email: "home@example.com" } },
			];

			function type(hub: ModelHubComponent, text: string): void {
				for (const ch of text) hub.handleInput(ch);
			}

			/** Open the `e` routing menu on the selected row and run its `index`-th editor. */
			function openRoutingEditor(hub: ModelHubComponent, index: number): void {
				hub.handleInput("e");
				for (let i = 0; i < index; i++) hub.handleInput(RIGHT);
				hub.handleInput("\n");
			}

			function smolRouting(settings: Settings): Record<string, unknown> | undefined {
				const entry = settings.getModelRoleEntries().smol as Record<string, unknown>;
				return entry.routing as Record<string, unknown> | undefined;
			}

			function twoModels(): Model[] {
				return [makeModel("test", "model-a"), makeModel("test", "model-b")];
			}

			test("the source and the roles view show a pool's quota, accounts, and cache routing", () => {
				const settings = Settings.isolated();
				settings.setModelRoleSpec("smol", {
					strategy: "quota",
					models: { a: { model: "test/model-a" } },
					routing: {
						quota: { reserveFraction: 0.1, maxObservationAgeMs: 900_000, unknown: "exclude" },
						accounts: { order: ["work", "home"], drain: "work", spend: ["plan", "credits"], returnWhen: "reset" },
						cache: { affinity: true, pricing: false },
						funding: { order: ["included", "metered"] },
						spending: {
							policy: "local-hard-budget",
							budget: {
								id: "daily",
								currency: "USD",
								perRequestMax: "0.50",
								window: { type: "rolling", durationMs: 86_400_000, maxSpend: "5.00" },
							},
						},
					},
				});
				expect(createModelBrowserSource(settings).getPool?.({ kind: "role", key: "smol" })).toMatchObject({
					quota: "reserve 0.1, max age 15m, unknown exclude",
					accounts: "order work → home, drain work, spend plan+credits, return reset",
					cache: "affinity, pricing off",
					spending: "local-hard-budget daily: $5.00 per 1d, $0.50 per request",
				});
				const { hub } = createHub({ models: [makeModel("test", "model-a")], scoped: true, settings });
				enterRolesView(hub);
				hub.handleInput(DOWN); // SMOL
				const rendered = normalize(hub.render(400));
				expect(rendered).toContain("SMOL pool · 1 model · quota · quota accounts cache metered");
				expect(rendered).toContain("Quota reserve 0.1, max age 15m, unknown exclude");
				expect(rendered).toContain("Accounts order work → home, drain work, spend plan+credits, return reset");
				expect(rendered).toContain("Cache affinity, pricing off");
			});

			test("a pooled row stays compact and the selected pool's routing shows in full below the rows", () => {
				const settings = Settings.isolated();
				settings.setModelRoleSpec("smol", {
					strategy: ["quota", "priority"],
					strategyOptions: { order: ["a", "b", "c"] },
					models: {
						a: { model: "test/model-a" },
						b: { model: "test/model-b" },
						c: { model: "test/model-a" },
					},
					routing: {
						quota: { reserveFraction: 0.1, unknown: "allow" },
						accounts: { order: ["work", "home"], drain: "work", spend: ["plan"], returnWhen: "reset" },
						cache: { affinity: true, pricing: true },
					},
				});
				const { hub } = createHub({ models: twoModels(), scoped: true, settings });
				enterRolesView(hub);
				hub.handleInput(DOWN); // SMOL
				const wide = hub.render(140).map(line => stripVTControlCharacters(line));
				const row = wide.find(line => line.includes("SMOL")) ?? "";
				expect(row).toContain("pool · 3 models · quota → priority · quota accounts cache");
				expect(row).not.toContain("…");
				const text = normalize(wide);
				expect(text).toContain("Quota reserve 0.1, unknown allow");
				expect(text).toContain("Accounts order work → home, drain work, spend plan, return reset");
				expect(text).toContain("Cache affinity, pricing");
			});

			test("at 80 columns the pool row's footer pages its keys with ?", () => {
				const settings = pooledSettings();
				const { hub } = createHub({ models: twoModels(), scoped: true, settings });
				enterRolesView(hub);
				hub.handleInput(DOWN); // SMOL
				const before = structuredClone(smolGroup(settings));
				const pages: string[] = [];
				for (let i = 0; i < 6; i++) {
					pages.push(footerLine(hub.render(80)));
					hub.handleInput("?");
				}
				for (const page of pages) expect(page).toContain("? more keys");
				const all = pages.join(" ");
				for (const hint of ["u quota unknown", "r quota reserve", "e routing", "a cache affinity"]) {
					expect(all).toContain(hint);
				}
				expect(smolGroup(settings)).toEqual(before);
			});

			test("a and h toggle cache affinity and pricing; u and r cycle the quota unknown handling and reserve", () => {
				const settings = pooledSettings();
				const { hub } = createHub({ models: twoModels(), scoped: true, settings });
				enterRolesView(hub);
				hub.handleInput(DOWN); // SMOL
				expect(footerLine(hub.render(400))).toContain("a cache affinity");

				hub.handleInput("a");
				expect(smolRouting(settings)?.cache).toEqual({ affinity: true });
				hub.handleInput("h");
				expect(smolRouting(settings)?.cache).toEqual({ affinity: true, pricing: true });
				hub.handleInput("a");
				hub.handleInput("h");
				expect(smolRouting(settings)).not.toHaveProperty("cache");

				const unknown: unknown[] = [];
				for (let i = 0; i < 3; i++) {
					hub.handleInput("u");
					unknown.push(smolGroup(settings).routing?.quota?.unknown);
				}
				expect(unknown).toEqual(["exclude", "allow", undefined]);
				const reserve: unknown[] = [];
				for (let i = 0; i < 5; i++) {
					hub.handleInput("r");
					reserve.push(smolGroup(settings).routing?.quota?.reserveFraction);
				}
				expect(reserve).toEqual([0.05, 0.1, 0.2, 0.3, undefined]);
				expect(smolRouting(settings)).toEqual({ funding: { order: ["included"] } });
			});

			test("e edits routing.accounts from the named accounts, and a refused trigger writes nothing", () => {
				const settings = pooledSettings();
				cfgAuthAccountPolicies.set(settings, NAMED_ACCOUNTS);
				const { hub } = createHub({ models: twoModels(), scoped: true, settings });
				enterRolesView(hub);
				hub.handleInput(DOWN); // SMOL

				openRoutingEditor(hub, 0); // account order
				expect(footerLine(hub.render(220))).toContain("Account order →");
				hub.handleInput("\n"); // work
				hub.handleInput(RIGHT);
				hub.handleInput("\n"); // home
				hub.handleInput(ESC);
				expect(smolGroup(settings).routing?.accounts).toEqual({ order: ["work", "home"] });

				openRoutingEditor(hub, 1); // drain: none, work, home
				hub.handleInput(RIGHT);
				hub.handleInput(RIGHT);
				hub.handleInput("\n");
				openRoutingEditor(hub, 2); // drain spend
				hub.handleInput("\n"); // plan
				hub.handleInput(ESC);
				expect(smolGroup(settings).routing?.accounts).toEqual({
					order: ["work", "home"],
					drain: "home",
					spend: ["plan"],
				});

				openRoutingEditor(hub, 3); // return when
				hub.handleInput(RIGHT);
				hub.handleInput("\n"); // credits-added needs spend credits
				expect(normalize(hub.render(220))).toContain("credits-added requires spend to include credits");
				expect(smolGroup(settings).routing?.accounts?.returnWhen).toBeUndefined();
				hub.handleInput(LEFT);
				hub.handleInput("\n"); // reset
				hub.handleInput(ESC);
				expect(smolGroup(settings).routing?.accounts?.returnWhen).toEqual(["reset"]);

				openRoutingEditor(hub, 0);
				hub.handleInput("\n"); // work out
				hub.handleInput("\n"); // home out
				hub.handleInput(ESC);
				expect(smolGroup(settings).routing?.accounts).toEqual({
					drain: "home",
					spend: ["plan"],
					returnWhen: ["reset"],
				});
			});

			test("e authorizes metered funding with a spending policy, and turning it off removes both", () => {
				const settings = pooledSettings();
				const { hub } = createHub({ models: twoModels(), scoped: true, settings });
				enterRolesView(hub);
				hub.handleInput(DOWN); // SMOL

				openRoutingEditor(hub, 4); // metered
				hub.handleInput("\n"); // provider-managed
				expect(smolRouting(settings)).toEqual({
					funding: { order: ["included", "metered"] },
					spending: { policy: "provider-managed" },
				});

				openRoutingEditor(hub, 4);
				hub.handleInput(RIGHT);
				hub.handleInput("\n"); // local hard budget…
				type(hub, "daily 9.00 5.00 1d");
				hub.handleInput("\n");
				expect(footerLine(hub.render(220))).toContain("perRequestMax exceeds window.maxSpend");
				expect(smolGroup(settings).routing?.spending).toEqual({ policy: "provider-managed" });
				for (let i = 0; i < 18; i++) hub.handleInput(BACKSPACE);
				type(hub, "daily $0.50 5.00 1d");
				hub.handleInput("\n");
				expect(smolGroup(settings).routing?.spending).toEqual({
					policy: "local-hard-budget",
					budget: {
						id: "daily",
						currency: "USD",
						perRequestMax: "0.50",
						window: { type: "rolling", durationMs: 86_400_000, maxSpend: "5.00" },
					},
				});

				openRoutingEditor(hub, 4);
				hub.handleInput(RIGHT);
				hub.handleInput(RIGHT);
				hub.handleInput("\n"); // off
				expect(smolRouting(settings)).toEqual({ funding: { order: ["included"] } });
			});

			test("turning metered off where it is the only funding class is refused by the validator", () => {
				const settings = Settings.isolated();
				settings.setModelRoleSpec("smol", {
					strategy: "random",
					models: { a: { model: "test/model-a" } },
					routing: { funding: { order: ["metered"] }, spending: { policy: "provider-managed" } },
				});
				const { hub } = createHub({ models: twoModels(), scoped: true, settings });
				enterRolesView(hub);
				hub.handleInput(DOWN); // SMOL
				openRoutingEditor(hub, 4);
				hub.handleInput(RIGHT);
				hub.handleInput(RIGHT);
				hub.handleInput("\n"); // off
				expect(normalize(hub.render(220))).toContain(
					"modelRoles.smol.routing.funding.order: must list billing classes",
				);
				expect(smolGroup(settings).routing?.spending).toEqual({ policy: "provider-managed" });
			});

			test("e adds pool limits in the /account limit syntax and removes them", () => {
				const settings = pooledSettings();
				const { hub } = createHub({ models: twoModels(), scoped: true, settings });
				enterRolesView(hub);
				hub.handleInput(DOWN); // SMOL

				openRoutingEditor(hub, 5); // limits: add…
				hub.handleInput("\n");
				type(hub, "requests 100 1h warn");
				hub.handleInput("\n");
				expect(smolGroup(settings).routing?.limits).toEqual([
					{ metric: "requests", max: 100, window: { type: "rolling", durationMs: 3_600_000 }, onLimit: "warn" },
				]);

				openRoutingEditor(hub, 5);
				expect(footerLine(hub.render(220))).toContain("remove requests 100 1h warn");
				hub.handleInput(RIGHT);
				hub.handleInput("\n"); // add…
				type(hub, "usage 0.5");
				hub.handleInput("\n");
				expect(footerLine(hub.render(220))).toContain("usage is only allowed on auth.accountPolicies limits");
				for (let i = 0; i < 9; i++) hub.handleInput(BACKSPACE);
				type(hub, "bogus");
				hub.handleInput("\n");
				expect(footerLine(hub.render(220))).toContain("Limit: <usd|requests|tokens>");
				hub.handleInput(ESC);
				expect(smolGroup(settings).routing?.limits).toHaveLength(1);

				openRoutingEditor(hub, 5);
				hub.handleInput("\n"); // remove the limit
				hub.handleInput(ESC);
				expect(smolRouting(settings)).toEqual({ funding: { order: ["included"] } });
			});

			test("e builds a strategy list and sets its quota tolerance within (0, 0.5]", () => {
				const settings = Settings.isolated();
				settings.setModelRoleSpec("smol", {
					strategy: "cheapest",
					models: { a: { model: "test/model-a" }, b: { model: "test/model-b" } },
				});
				const { hub } = createHub({ models: twoModels(), scoped: true, settings });
				const smol = () => settings.getModelRoleEntries().smol as Record<string, unknown>;
				enterRolesView(hub);
				hub.handleInput(DOWN); // SMOL

				openRoutingEditor(hub, 6); // strategies, in the order g cycles them
				for (let i = 0; i < 4; i++) hub.handleInput(RIGHT);
				hub.handleInput("\n"); // quota
				expect(smol().strategy).toEqual(["cheapest", "quota"]);
				hub.handleInput(RIGHT);
				hub.handleInput("\n"); // cheapest out
				expect(smol().strategy).toBe("quota");
				for (let i = 0; i < 5; i++) hub.handleInput(LEFT);
				hub.handleInput("\n"); // priority
				hub.handleInput(ESC);
				expect(smol()).toMatchObject({ strategy: ["quota", "priority"], strategyOptions: { order: ["a", "b"] } });

				openRoutingEditor(hub, 7); // quota tolerance
				type(hub, "0.2");
				hub.handleInput("\n");
				expect(smol().strategyOptions).toEqual({ order: ["a", "b"], tolerance: 0.2 });

				openRoutingEditor(hub, 7);
				for (let i = 0; i < 3; i++) hub.handleInput(BACKSPACE);
				type(hub, "0.9");
				hub.handleInput("\n");
				expect(footerLine(hub.render(220))).toContain("must be a number in (0, 0.5]");
				expect(smol().strategyOptions).toEqual({ order: ["a", "b"], tolerance: 0.2 });
				const body = hub
					.render(140)
					.slice(0, -2)
					.map(line => stripVTControlCharacters(line))
					.join("\n");
				expect(body).toContain("must be a number in (0, 0.5]");
			});

			test("a pool field keeps its hint and error readable at 80 columns", () => {
				const settings = Settings.isolated();
				settings.setModelRoleSpec("smol", {
					strategy: "quota",
					models: { a: { model: "test/model-a" }, b: { model: "test/model-b" } },
				});
				const { hub } = createHub({ models: twoModels(), scoped: true, settings });
				enterRolesView(hub);
				hub.handleInput(DOWN); // SMOL

				openRoutingEditor(hub, 7); // quota tolerance
				const hint = footerLine(hub.render(80));
				expect(hint).toContain("Quota tolerance:");
				expect(hint).toContain("a number in (0, 0.5] · empty removes");
				type(hub, "abc");
				hub.handleInput("\n");
				const error = hub.render(80);
				expect(footerLine(error)).toContain("Tolerance must be a number in (0, 0.5]");
				for (const line of error) expect(visibleWidth(line)).toBeLessThanOrEqual(80);
			});

			test("the picker shows a pool editor as its strip with toggle actions", () => {
				const settings = pooledSettings();
				const { hub } = createHub({ models: twoModels(), scoped: true, settings });
				enterRolesView(hub);
				hub.handleInput(DOWN); // SMOL
				openRoutingEditor(hub, 6); // strategies
				const props = pickerProps(hub);
				expect(props.strip?.label).toEqual([{ t: "Strategies", s: "muted" }]);
				expect(props.strip?.items.find(item => item.on)?.label).toBe("1 weighted-random");
				expect(props.actions?.map(action => action.label)).toEqual(["Toggle", "Done"]);
			});

			test("a pool that references a model group edits the global group, unless another layer defines it", () => {
				const settings = Settings.isolated();
				settings.setModelGroup("fast", { strategy: "random", models: { a: { model: "test/model-a" } } });
				settings.setModelRoleSpec("smol", { use: "fast" });
				const { hub } = createHub({ models: twoModels(), scoped: true, settings });
				enterRolesView(hub);
				hub.handleInput(DOWN); // SMOL
				expect(normalize(hub.render(220))).toContain("SMOL pool +fast · 1 model · random");

				hub.handleInput("a");
				hub.handleInput("\n"); // add a member
				type(hub, "model-b");
				hub.handleInput("\n");
				expect(settings.getGlobalSettings().modelGroups).toEqual({
					fast: {
						strategy: "random",
						models: { a: { model: "test/model-a" }, "model-b": { model: "test/model-b" } },
						routing: { cache: { affinity: true } },
					},
				});
				expect(settings.getModelRoleEntries().smol).toEqual({ use: "fast" });

				const runtime = Settings.isolated({
					modelGroups: { fast: { strategy: "random", models: { a: { model: "test/model-a" } } } },
				});
				runtime.setModelRoleSpec("smol", { use: "fast" });
				const pool = createModelBrowserSource(runtime).getPool?.({ kind: "role", key: "smol" });
				expect(pool?.readOnly).toBe("modelGroups.fast is set in the runtime layer");
				expect(pool?.raw).toBeUndefined();
			});

			test("G declines renaming or deleting a group a shadowed global entry still references", () => {
				const settings = Settings.isolated();
				settings.setModelGroup("shared", { strategy: "random", models: { a: { model: "test/model-a" } } });
				settings.setModelRoleSpec("smol", { use: "shared" });
				settings.setFallbackChainSpec("smol", { use: "shared" });
				cfgRetryFallbackChains.override(settings, { smol: ["test/model-b"] });
				expect(createModelBrowserSource(settings).modelGroupReferences?.("shared")).toEqual([
					{ kind: "role", key: "smol" },
					{ kind: "chain", key: "smol" },
				]);
				const { hub } = createHub({ models: twoModels(), scoped: true, settings });
				enterRolesView(hub);
				hub.handleInput(DOWN); // SMOL
				hub.handleInput("G");
				hub.handleInput(RIGHT);
				hub.handleInput("\n"); // delete +shared
				expect(normalize(hub.render(220))).toContain("+shared is still used by retry.fallbackChains.smol");
				hub.handleInput("G");
				hub.handleInput("\n"); // rename +shared…
				type(hub, "-2");
				hub.handleInput("\n");
				expect(footerLine(hub.render(220))).toContain(
					"retry.fallbackChains.smol uses +shared and is set in the runtime layer",
				);
				expect(Object.keys(settings.getGlobalSettings().modelGroups as object)).toEqual(["shared"]);
			});

			test("G turns a pool into a model group, points a chain at it, renames it, and deletes it", () => {
				const settings = pooledSettings();
				settings.setFallbackChainSpec("smol", ["test/model-b"]);
				const smolRaw = settings.getModelRoleEntries().smol;
				const { hub } = createHub({ models: twoModels(), scoped: true, settings });
				const groups = () => settings.getGlobalSettings().modelGroups;
				const chain = () => cfgRetryFallbackChains.get(settings).smol as unknown;
				enterRolesView(hub);
				hub.handleInput(DOWN); // SMOL
				expect(footerLine(hub.render(400))).toContain("⇧G group");

				hub.handleInput("G");
				hub.handleInput("\n"); // new group…
				type(hub, "shared");
				hub.handleInput("\n");
				expect(groups()).toEqual({ shared: smolRaw });
				expect(settings.getModelRoleEntries().smol).toEqual({ use: "shared" });

				for (let i = 0; i < 3; i++) hub.handleInput(DOWN); // members a, b, then the chain entry
				hub.handleInput("G");
				hub.handleInput("\n"); // use +shared
				expect(chain()).toEqual({ use: "shared" });

				for (let i = 0; i < 3; i++) hub.handleInput(UP); // back to SMOL
				hub.handleInput("G");
				hub.handleInput("\n"); // rename +shared…
				for (let i = 0; i < "shared".length; i++) hub.handleInput(BACKSPACE);
				type(hub, "team");
				hub.handleInput("\n");
				expect(groups()).toEqual({ team: smolRaw });
				expect(settings.getModelRoleEntries().smol).toEqual({ use: "team" });
				expect(chain()).toEqual({ use: "team" });

				hub.handleInput("G");
				hub.handleInput(RIGHT);
				hub.handleInput("\n"); // delete +team, still used by the chain
				expect(normalize(hub.render(220))).toContain("+team is still used by retry.fallbackChains.smol");
				expect(groups()).toEqual({ team: smolRaw });

				settings.setFallbackChainSpec("smol", undefined);
				hub.refreshAfterExternalMutation();
				hub.handleInput("G");
				hub.handleInput(RIGHT);
				hub.handleInput("\n"); // delete +team: SMOL keeps the pool inline
				expect(groups() ?? {}).toEqual({});
				expect(settings.getModelRoleEntries().smol).toEqual(smolRaw);
			});
		});
	});

	describe("mouse wheel", () => {
		// SGR wheel reports: button 64 = up, 65 = down. Column 100 lands in the
		// body pane, column 3 in the sidebar; row 10 is inside the content rows.
		const WHEEL_UP_BODY = "\x1b[<64;100;10M";
		const WHEEL_DOWN_BODY = "\x1b[<65;100;10M";
		const WHEEL_UP_SIDEBAR = "\x1b[<64;3;10M";
		const WHEEL_DOWN_SIDEBAR = "\x1b[<65;3;10M";

		test("wheel pans the model list without moving the selection and clamps at the ends", () => {
			const models = Array.from({ length: 40 }, (_, i) => makeModel("test", `model-${String(i).padStart(2, "0")}`));
			const { hub } = createHub({ models, scoped: true });

			hub.handleInput("\n"); // Sidebar → model list.
			const before = normalize(hub.render(220)); // establishes mouse geometry
			// Enter opens the role strip for the selected model — its footer
			// (`<model-id> → …`) identifies the selection.
			hub.handleInput("\n");
			const initialStrip = footerLine(hub.render(220));
			expect(initialStrip).toContain("→");
			hub.handleInput(ESC); // close the strip

			// Panning reveals rows that were below the fold...
			for (let i = 0; i < 8; i++) hub.handleInput(WHEEL_DOWN_BODY);
			const panned = normalize(hub.render(220));
			const modelIdsIn = (frame: string) => new Set(Array.from(frame.matchAll(/model-\d\d/g), match => match[0]));
			const beforeIds = modelIdsIn(before);
			const revealed = [...modelIdsIn(panned)].filter(id => !beforeIds.has(id));
			expect(revealed.length).toBeGreaterThan(0);

			// ...but never moves the selection: Enter still opens the same model's strip.
			hub.handleInput("\n");
			expect(footerLine(hub.render(220))).toBe(initialStrip);
			hub.handleInput(ESC);

			// The window clamps at the bottom instead of wrapping back to the top...
			for (let i = 0; i < 500; i++) hub.handleInput(WHEEL_DOWN_BODY);
			const saturated = normalize(hub.render(220));
			hub.handleInput(WHEEL_DOWN_BODY);
			expect(normalize(hub.render(220))).toBe(saturated);

			// ...and scrolling back up restores the original window exactly.
			for (let i = 0; i < 500; i++) hub.handleInput(WHEEL_UP_BODY);
			expect(normalize(hub.render(220))).toBe(before);
		});

		test("wheel over the sidebar never changes the active scope or schedules refreshes", () => {
			vi.useFakeTimers();
			try {
				const refreshProvider = vi.fn(async () => { });
				const { hub } = createHub({
					models: [makeModel("prov-a", "model-a"), makeModel("prov-b", "model-b")],
					registry: { refreshProvider },
				});

				expect(normalize(hub.render(220))).toContain("All available models");

				// Two hops under the old wheel-selects behavior would land on a
				// provider scope; the viewport pan must leave the scope alone.
				for (let i = 0; i < 2; i++) hub.handleInput(WHEEL_DOWN_SIDEBAR);
				expect(normalize(hub.render(220))).toContain("All available models");
				for (let i = 0; i < 2; i++) hub.handleInput(WHEEL_UP_SIDEBAR);
				expect(normalize(hub.render(220))).toContain("All available models");

				// No scope change means no provider auto-refresh either.
				vi.advanceTimersByTime(200); // past the 120ms provider-refresh debounce
				expect(refreshProvider).not.toHaveBeenCalled();
			} finally {
				vi.useRealTimers();
			}
		});

		test("wheel in the roles view clamps at the top instead of wrapping to the bottom rows", () => {
			const { hub } = createHub({ models: [makeModel("test", "model-a")], scoped: true });

			hub.handleInput(UP); // All models → Roles
			hub.render(220); // establish mouse geometry
			for (let i = 0; i < 4; i++) hub.handleInput(WHEEL_UP_BODY); // cursor stays on the first role
			hub.handleInput("\n"); // dive into the rows
			hub.handleInput("\n"); // activate the cursor row
			expect(normalize(hub.render(220))).toContain("Assigning DEFAULT");
		});
	});

	describe("provider scopes and search", () => {
		test("search inside a provider scope keeps that provider's model (#4522)", () => {
			const openrouterGlm = makeModel("openrouter", "z-ai/glm-5.2");
			const customGlm = makeModel("custom-provider", "glm-5.2");
			const { hub } = createHub({ models: [openrouterGlm, customGlm] });
			installTestTheme();

			// Scope-hop: All models → custom-provider → openrouter.
			hub.handleInput(DOWN);
			hub.handleInput(DOWN);
			expect(normalize(hub.render(220))).toContain("openrouter ·");

			for (const ch of "glm-5.2") hub.handleInput(ch);
			hub.handleInput("\n");

			// The role strip opened for the provider-scoped match, not the
			// identically named custom-provider model.
			expect(footerLine(hub.render(220))).toContain("z-ai/glm-5.2 →");
		});

		test("search on All models spans every provider", () => {
			const openrouterGlm = makeModel("openrouter", "z-ai/glm-5.2");
			const customGlm = makeModel("custom-provider", "glm-5.2");
			const { hub } = createHub({ models: [openrouterGlm, customGlm] });
			installTestTheme();

			for (const ch of "glm") hub.handleInput(ch);
			const rendered = normalize(hub.render(220));
			expect(rendered).toContain("openrouter/z-ai/glm-5.2");
			expect(rendered).toContain("custom-provider/glm-5.2");
		});

		test("a provider scope that loses every match falls back to All models", () => {
			const openrouterGlm = makeModel("openrouter", "z-ai/glm-5.2");
			const customGlm = makeModel("custom-provider", "glm-5.2");
			const { hub } = createHub({ models: [openrouterGlm, customGlm] });
			installTestTheme();

			hub.handleInput(DOWN);
			hub.handleInput(DOWN); // openrouter scope
			for (const ch of "does-not-exist") hub.handleInput(ch);

			const rendered = normalize(hub.render(220));
			expect(rendered).toContain("All available models");
			expect(rendered).toContain("No matching models");
		});

		test("scope hop skips providers without matches while searching", () => {
			const openrouterGlm = makeModel("openrouter", "z-ai/glm-5.2");
			const customOther = makeModel("custom-provider", "different-model");
			const { hub } = createHub({ models: [openrouterGlm, customOther] });
			installTestTheme();

			for (const ch of "z-ai") hub.handleInput(ch);
			hub.handleInput(LEFT); // switch focus to sidebar
			hub.handleInput(DOWN); // skips custom-provider (0 matches), lands on openrouter
			expect(normalize(hub.render(220))).toContain("openrouter ·");
		});
		test("providers with matches float to the top of the sidebar while searching", () => {
			const noMatch = makeModel("aaa-provider", "different-model");
			const withMatch = makeModel("zzz-provider", "target-model");
			const { hub } = createHub({ models: [noMatch, withMatch] });
			installTestTheme();

			// Sidebar cell = the first `│`-delimited column of each split row;
			// body rows may also mention provider names, so scope the check.
			const sidebarIndexOf = (provider: string): number =>
				hub
					.render(220)
					.map(line => stripVTControlCharacters(line).split("│")[1] ?? "")
					.findIndex(cell => cell.includes(provider));

			expect(sidebarIndexOf("aaa-provider")).toBeLessThan(sidebarIndexOf("zzz-provider"));

			for (const ch of "target") hub.handleInput(ch);
			expect(sidebarIndexOf("zzz-provider")).toBeLessThan(sidebarIndexOf("aaa-provider"));

			// Clearing the query restores the alphabetical order.
			hub.handleInput("\x1b");
			expect(sidebarIndexOf("aaa-provider")).toBeLessThan(sidebarIndexOf("zzz-provider"));
		});

		test("Escape clears an active query before closing the hub", () => {
			const model = makeModel("test", "escape-model");
			const { hub, onCancel } = createHub({ models: [model] });
			installTestTheme();

			for (const ch of "esc") hub.handleInput(ch);
			hub.handleInput("\x1b");
			expect(onCancel).not.toHaveBeenCalled();
			hub.handleInput("\x1b");
			expect(onCancel).toHaveBeenCalledTimes(1);
		});

		test("left/right arrows switch between the sidebar and the model list", () => {
			const modelA = makeModel("prov-a", "model-a");
			const modelB = makeModel("prov-b", "model-b");
			const { hub } = createHub({ models: [modelA, modelB] });
			installTestTheme();

			// Right enters list mode: Down now moves the model selection, the
			// scope stays on All models.
			hub.handleInput("\x1b[C");
			hub.handleInput(DOWN);
			expect(normalize(hub.render(220))).toContain("All available models");

			// Left returns to the sidebar: Down hops to the first provider.
			hub.handleInput(LEFT);
			hub.handleInput(DOWN);
			expect(normalize(hub.render(220))).toContain("prov-a ·");
		});
	});

	describe("provider refresh lifecycle", () => {
		test("auto-refreshes a provider once per process; F5 forces a re-fetch", async () => {
			const model = makeModel("prov-a", "model-a");
			const refreshProvider = vi.fn<ModelRegistry["refreshProvider"]>(async () => { });
			const { hub } = createHub({
				models: [model],
				registry: { refreshProvider },
			});
			installTestTheme();

			// Real waits: the hub debounces provider refreshes with a real
			// 120ms setTimeout (no injection seam), and the fetch completion is
			// a promise chain — fake timers cannot drive the mixed path.
			hub.handleInput(DOWN); // All models → prov-a, schedules the refresh
			await Bun.sleep(140);
			expect(refreshProvider).toHaveBeenCalledTimes(1);
			expect(refreshProvider).toHaveBeenCalledWith("prov-a", "online");
			expect(refreshProvider.mock.calls[0]?.[2]).toBeUndefined();

			hub.handleInput(UP); // back to All models
			hub.handleInput(DOWN); // revisit prov-a
			await Bun.sleep(140);
			// Lifetime guard: revisiting must not re-fetch.
			expect(refreshProvider).toHaveBeenCalledTimes(1);

			hub.handleInput("\x1b[15~"); // F5
			await Bun.sleep(140);
			expect(refreshProvider).toHaveBeenCalledTimes(2);
			expect(refreshProvider).toHaveBeenCalledWith("prov-a", "online", { refreshCommandCredentials: true });
		});

		test("F5 during the hover debounce upgrades the pending catalog refresh", async () => {
			const model = makeModel("prov-a", "model-a");
			const refreshProvider = vi.fn(async () => { });
			const { hub } = createHub({
				models: [model],
				registry: { refreshProvider },
			});
			installTestTheme();

			hub.handleInput(DOWN); // schedules catalog-only refresh
			hub.handleInput("\x1b[15~"); // F5 before the 120ms debounce fires
			await Bun.sleep(40);
			expect(refreshProvider).toHaveBeenCalledTimes(1);
			expect(refreshProvider).toHaveBeenCalledWith("prov-a", "online", { refreshCommandCredentials: true });
			await Bun.sleep(140);
			expect(refreshProvider).toHaveBeenCalledTimes(1);
		});

		test("F5 while a catalog refresh is in flight queues a credential re-mint", async () => {
			const model = makeModel("prov-a", "model-a");
			const gate = Promise.withResolvers<void>();
			const refreshProvider = vi.fn<ModelRegistry["refreshProvider"]>(() => gate.promise);
			const { hub } = createHub({
				models: [model],
				registry: { refreshProvider },
			});
			installTestTheme();

			hub.handleInput(DOWN);
			await Bun.sleep(140);
			expect(refreshProvider).toHaveBeenCalledTimes(1);
			expect(refreshProvider.mock.calls[0]?.[2]).toBeUndefined();

			hub.handleInput("\x1b[15~");
			expect(refreshProvider).toHaveBeenCalledTimes(1);

			gate.resolve();
			await Bun.sleep(0);
			expect(refreshProvider).toHaveBeenCalledTimes(2);
			expect(refreshProvider).toHaveBeenLastCalledWith("prov-a", "online", { refreshCommandCredentials: true });
		});

		test("F5 still re-mints credentials after navigating away mid-fetch", async () => {
			const modelA = makeModel("prov-a", "model-a");
			const modelB = makeModel("prov-b", "model-b");
			const gate = Promise.withResolvers<void>();
			const refreshProvider = vi.fn<ModelRegistry["refreshProvider"]>(() => gate.promise);
			const { hub } = createHub({
				models: [modelA, modelB],
				registry: { refreshProvider },
			});
			installTestTheme();

			hub.handleInput(DOWN); // All models → prov-a
			await Bun.sleep(140);
			expect(refreshProvider).toHaveBeenCalledTimes(1);
			expect(refreshProvider.mock.calls[0]?.[2]).toBeUndefined();

			hub.handleInput("\x1b[15~"); // queue credential refresh behind the in-flight catalog fetch
			hub.handleInput(UP); // All models — must not drop the F5
			expect(refreshProvider).toHaveBeenCalledTimes(1);

			gate.resolve();
			await Bun.sleep(0);
			expect(refreshProvider).toHaveBeenCalledTimes(2);
			expect(refreshProvider).toHaveBeenLastCalledWith("prov-a", "online", { refreshCommandCredentials: true });
		});

		test("shows a refreshing status while the provider fetch is in flight", async () => {
			const model = makeModel("prov-b", "model-b");
			const gate = Promise.withResolvers<void>();
			const { hub } = createHub({
				models: [model],
				registry: { refreshProvider: () => gate.promise },
			});
			installTestTheme();

			hub.handleInput(DOWN);
			await Bun.sleep(140);
			expect(normalize(hub.render(220))).toContain("refreshing model list");

			gate.resolve();
			await Bun.sleep(0);
			expect(normalize(hub.render(220))).not.toContain("refreshing model list");
		});
	});

	describe("locked providers", () => {
		test("catalog providers without credentials appear locked and forward to login", () => {
			const anthropicModel = makeModel("anthropic", "claude-locked-test");
			const { hub, onLoginRequest } = createHub({
				models: [anthropicModel],
				registry: { getAvailable: () => [] },
			});
			installTestTheme();

			hub.handleInput(DOWN); // All models → locked anthropic (separator skipped)
			const rendered = normalize(hub.render(220));
			expect(rendered).toContain("anthropic has no credentials configured");
			expect(rendered).toContain("claude-locked-test");

			hub.handleInput("\n");
			expect(onLoginRequest).toHaveBeenCalledWith("anthropic");
		});
	});
});
