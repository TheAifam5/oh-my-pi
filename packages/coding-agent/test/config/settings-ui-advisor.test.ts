import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { cfgAdvisorAggregationJudgeTimeoutMs, cfgAdvisorEnabled } from "@oh-my-pi/pi-coding-agent/advisor/settings";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createSettingsHost } from "@oh-my-pi/pi-coding-agent/config/settings-ui";
import { createPluginSettingsHost } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/settings-host";
import { getSettingsForTab, type SettingDef } from "@oh-my-pi/pi-tui/overlays/settings-defs";
import { SettingsSelectorComponent } from "@oh-my-pi/pi-tui/overlays/settings-selector";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

beforeAll(async () => {
	await initTheme();
});

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterEach(() => {
	resetSettingsForTest();
});

function find(defs: readonly SettingDef[], path: string): SettingDef {
	const def = defs.find(candidate => candidate.path === path);
	if (!def) throw new Error(`${path} has no settings row`);
	return def;
}

function optionValues(def: SettingDef): string[] | undefined {
	return def.type === "submenu" ? def.options.map(option => option.value) : undefined;
}

describe("settings panel advisor rows", () => {
	it("shows advisor rows while the session's advisor is enabled, even with advisor.enabled off", () => {
		let sessionEnabled = false;
		const session = { isAdvisorEnabled: () => sessionEnabled };
		const withSession = find(
			getSettingsForTab(createSettingsHost(session).entries, "model"),
			"advisor.maxNotesPerUpdate",
		);
		const persistedOnly = find(getSettingsForTab(createSettingsHost().entries, "model"), "advisor.maxNotesPerUpdate");
		expect(withSession.condition?.()).toBe(false);

		sessionEnabled = true;
		expect(withSession.condition?.()).toBe(true);
		expect(persistedOnly.condition?.()).toBe(false);

		sessionEnabled = false;
		cfgAdvisorEnabled.set(Settings.instance, true);
		expect(withSession.condition?.()).toBe(true);
		expect(persistedOnly.condition?.()).toBe(true);
	});

	it("offers the findings judge model and timeout and extended advisor quick picks", () => {
		const defs = getSettingsForTab(createSettingsHost().entries, "model");
		expect(optionValues(find(defs, "advisor.aggregation.judge.timeoutMs"))).toEqual([
			"5000",
			"10000",
			"20000",
			"30000",
			"60000",
		]);
		expect(optionValues(find(defs, "advisor.aggregation.judge.model"))).toEqual(["@judge"]);
		expect(optionValues(find(defs, "advisor.maxNotesPerUpdate"))).toEqual([
			"1",
			"2",
			"3",
			"4",
			"5",
			"6",
			"8",
			"10",
			"12",
			"16",
			"24",
			"32",
		]);
		expect(optionValues(find(defs, "advisor.immuneTurns"))).toEqual([
			"0",
			"1",
			"2",
			"3",
			"4",
			"5",
			"8",
			"10",
			"15",
			"20",
		]);
		expect(optionValues(find(defs, "advisor.reviewInterval"))).toEqual([
			"1",
			"2",
			"3",
			"4",
			"5",
			"8",
			"10",
			"15",
			"20",
		]);
		for (const path of ["advisor.aggregation.judge.timeoutMs", "advisor.aggregation.judge.model"]) {
			expect(find(defs, path).condition?.()).toBe(false);
		}
	});

	it("shows allowProjectMeteredPools as a Model tab toggle that writes the user config", () => {
		const host = createSettingsHost();
		const def = find(getSettingsForTab(host.entries, "model"), "allowProjectMeteredPools");
		expect([def.type, def.group, def.condition]).toEqual(["boolean", "Retry & Fallback", undefined]);
		host.set("allowProjectMeteredPools", true);
		expect(Settings.instance.getGlobalSettings().allowProjectMeteredPools).toBe(true);
	});

	it("keeps every advisor label within the settings list's 30-column label column", () => {
		const advisorDefs = getSettingsForTab(createSettingsHost().entries, "model").filter(
			def => def.group === "Advisor",
		);
		expect(advisorDefs.filter(def => def.label.length > 30).map(def => def.label)).toEqual([]);
	});

	it("shows the judge timeout row in seconds and picks from its stored value", async () => {
		cfgAdvisorEnabled.set(Settings.instance, true);
		const selector = new SettingsSelectorComponent(
			{
				availableThinkingLevels: [],
				thinkingLevel: undefined,
				availableThemes: ["dark"],
				providers: [],
				settings: createSettingsHost(),
				plugins: createPluginSettingsHost(process.cwd()),
			},
			{ onChange: () => {}, onCancel: () => {} },
		);
		await selector.ready;
		for (const char of "judge timeout") selector.handleInput(char);
		const row = () =>
			selector
				.render(120)
				.map(line => stripVTControlCharacters(line))
				.find(line => line.includes("Advisor Findings Judge Timeout")) ?? "";
		expect(row()).toMatch(/Timeout\s+10 seconds/);
		expect(row()).not.toContain("10000");
		selector.handleInput("\r"); // Picker opens on the stored 10 seconds.
		selector.handleInput("\x1b[B");
		selector.handleInput("\r"); // 20 seconds.
		await selector.pendingWrite;
		expect(cfgAdvisorAggregationJudgeTimeoutMs.get(Settings.instance)).toBe(20_000);
		expect(row()).toMatch(/Timeout\s+20 seconds/);
	});
});
