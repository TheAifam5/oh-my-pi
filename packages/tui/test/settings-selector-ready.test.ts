import { beforeAll, describe, expect, it } from "bun:test";
import type { PluginSettingsHost } from "@oh-my-pi/pi-tui/overlays/plugin-settings";
import type { SettingsDisplayEntry, SettingsHost } from "@oh-my-pi/pi-tui/overlays/settings-defs";
import { SettingsSelectorComponent } from "@oh-my-pi/pi-tui/overlays/settings-selector";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-tui/theme";

const ESCAPE = "\x1b";

const ENTRIES: SettingsDisplayEntry[] = [
	{
		path: "display.colorBlind",
		type: "boolean",
		defaultValue: false,
		ui: { tab: "appearance", group: "Theme", label: "Color-blind mode", description: "Blue additions" },
	},
];

const PLUGINS: PluginSettingsHost = {
	manager: {
		list: async () => [],
		getPlugin: async () => undefined,
		getPluginSettings: async () => ({}),
		setEnabled: async () => {},
		getEnabledFeatures: async () => null,
		setEnabledFeatures: async () => {},
		setPluginSetting: async () => {},
	},
	createMarketplaceManager: async () => ({
		listInstalledPlugins: async () => [],
		setPluginEnabled: async () => {},
	}),
	parsePluginId: () => null,
};

interface Harness {
	selector: SettingsSelectorComponent;
	listing: PromiseWithResolvers<void>;
	state: { failReads: boolean; readsAfterSettle: number; settled: boolean; renders: number; cancels: number };
}

function harness(): Harness {
	const listing = Promise.withResolvers<void>();
	const state = { failReads: false, readsAfterSettle: 0, settled: false, renders: 0, cancels: 0 };
	const settings: SettingsHost = {
		entries: ENTRIES,
		get: path => {
			if (state.settled) state.readsAfterSettle++;
			if (state.failReads) throw new Error("Settings not initialized");
			return ENTRIES.find(entry => entry.path === path)?.defaultValue;
		},
		set: () => {},
		unset: () => {},
		ready: listing.promise,
		targets: [{ id: "global", label: "Global" }],
		target: "global",
		selectTarget: () => {},
		normalizeProviderLimits: () => ({}),
		validateProviderLimits: () => ({}),
	};
	const selector = new SettingsSelectorComponent(
		{
			settings,
			plugins: PLUGINS,
			availableThinkingLevels: [],
			thinkingLevel: undefined,
			availableThemes: ["dark"],
			providers: [],
			requestRender: () => void state.renders++,
		},
		{
			onChange: () => {},
			onCancel: () => void state.cancels++,
		},
	);
	return { selector, listing, state };
}

describe("settings selector scope loading", () => {
	beforeAll(async () => {
		const dark = await getThemeByName("dark");
		if (!dark) throw new Error("Failed to load dark theme");
		setThemeInstance(dark);
	});

	it("skips the refresh when the panel closes before the scopes load", async () => {
		const { selector, listing, state } = harness();
		selector.handleInput(ESCAPE);
		expect(state.cancels).toBe(1);

		state.settled = true;
		listing.resolve();
		await expect(selector.ready).resolves.toBeUndefined();
		expect(state.readsAfterSettle).toBe(0);
		expect(state.renders).toBe(0);
	});

	it("skips the refresh when the panel closes before the scope listing fails", async () => {
		const { selector, listing, state } = harness();
		selector.handleInput(ESCAPE);

		state.settled = true;
		listing.reject(new Error("listing failed"));
		await expect(selector.ready).resolves.toBeUndefined();
		expect(state.readsAfterSettle).toBe(0);
		expect(state.renders).toBe(0);
	});

	it("resolves ready when the refresh after loading throws", async () => {
		const { selector, listing, state } = harness();
		state.failReads = true;
		state.settled = true;
		listing.resolve();
		await expect(selector.ready).resolves.toBeUndefined();
		expect(state.readsAfterSettle).toBeGreaterThan(0);
		expect(state.renders).toBe(0);
	});

	it("resolves ready when the listing fails and the refresh throws", async () => {
		const { selector, listing, state } = harness();
		state.failReads = true;
		state.settled = true;
		listing.reject(new Error("listing failed"));
		await expect(selector.ready).resolves.toBeUndefined();
		expect(state.readsAfterSettle).toBeGreaterThan(0);
	});

	it("refreshes and renders once the scopes load while open", async () => {
		const { selector, listing, state } = harness();
		state.settled = true;
		listing.resolve();
		await selector.ready;
		expect(state.readsAfterSettle).toBeGreaterThan(0);
		expect(state.renders).toBe(1);
		expect(state.cancels).toBe(0);
	});
});
