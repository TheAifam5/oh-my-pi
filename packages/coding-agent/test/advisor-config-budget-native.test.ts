import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { TUI } from "../../tui/src/index";
import type { DescribeContext } from "../../tui/src/native/node";
import {
	AdvisorConfigOverlayComponent,
	type AdvisorConfigDeps,
	type WatchdogConfigDoc,
} from "../../tui/src/overlays/advisor-config";
import { getThemeByName, setThemeInstance } from "../../tui/src/theme";
import { loadWatchdogConfigFile, saveWatchdogConfigFile } from "../src/advisor/config";

const deps: AdvisorConfigDeps = {
	getAvailableModels: () => [],
	browserSource: {
		revision: 0,
		defaultThinkingLevel: "high",
		modelProviderOrder: [],
		knownRoleIds: [],
		mruOrder: [],
		modelPerf: new Map(),
		getModelRole: () => undefined,
		getRoleInfo: role => ({ name: role, section: "chat", accepts: () => true }),
		defaultRoleChain: () => [],
		resolveRoleValue: () => ({ model: undefined, explicitThinkingLevel: false }),
	},
	defaultToolNames: new Set(["read", "grep", "glob"]),
	scopedModels: [],
	availableToolNames: [],
};
const cx: DescribeContext = {
	cols: 120,
	reduceMotion: false,
	dark: true,
	supports: () => true,
	feature: () => true,
};

describe("advisor quota reserve editing", () => {
	const dirs: TempDir[] = [];
	beforeAll(async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("theme unavailable");
		setThemeInstance(theme);
	});
	afterEach(async () => {
		for (const dir of dirs.splice(0)) await dir.remove();
	});

	const open = (doc: WatchdogConfigDoc) => {
		const dir = TempDir.createSync("advisor-budget-editor-");
		dirs.push(dir);
		const file = dir.join("WATCHDOG.yml");
		const notices: string[] = [];
		let pending: Promise<void> = Promise.resolve();
		const overlay = new AdvisorConfigOverlayComponent({} as TUI, deps, "project", doc, {
			loadDoc: async () => ({ advisors: [] }),
			save: (_scope, saved) => {
				pending = saveWatchdogConfigFile(file, saved);
				return pending;
			},
			close: () => {},
			requestRender: () => {},
			notify: message => notices.push(message),
		});
		return {
			overlay,
			notices,
			change: (item: string, value: string | number | null) =>
				overlay.handleNativeEvent({ type: "change", key: "", item, value }),
			save: async () => {
				overlay.handleNativeEvent({ type: "action", key: "", act: "save", mods: [] });
				await pending;
				return loadWatchdogConfigFile(file);
			},
		};
	};

	it("describes current overrides and persists native changes through the WATCHDOG writer", async () => {
		const editor = open({ advisors: [{ name: "Security", budget: { reservePct: 25, whenReserved: "skip" } }] });
		const tree = JSON.stringify(editor.overlay.describe(cx));
		expect(tree).toContain('"id":"reservePct"');
		expect(tree).toContain('"value":"25"');
		expect(tree).toContain('"id":"whenReserved"');
		expect(tree).toContain('"value":"skip"');
		editor.change("reservePct", "12.5");
		editor.change("whenReserved", "fallback");
		expect((await editor.save()).advisors[0].budget).toEqual({ reservePct: 12.5, whenReserved: "fallback" });
	});

	it("removes overrides independently and removes the empty budget", async () => {
		const editor = open({ advisors: [{ name: "Security", budget: { reservePct: 25, whenReserved: "skip" } }] });
		editor.change("reservePct", "inherit");
		expect((await editor.save()).advisors[0].budget).toEqual({ whenReserved: "skip" });
		editor.change("whenReserved", null);
		expect((await editor.save()).advisors[0]).not.toHaveProperty("budget");
	});

	it("rejects invalid native values without changing valid overrides", async () => {
		const budget = { reservePct: 25, whenReserved: "skip" as const };
		const editor = open({ advisors: [{ name: "Security", budget }] });
		for (const value of [-1, 101, Number.NaN, Number.POSITIVE_INFINITY, "oops"]) editor.change("reservePct", value);
		editor.change("whenReserved", "oops");
		expect(editor.notices).toHaveLength(6);
		expect((await editor.save()).advisors[0].budget).toEqual(budget);
	});

	it("accepts boundary percentages", async () => {
		const editor = open({ advisors: [{ name: "Security" }] });
		for (const value of [0, 100]) {
			editor.change("reservePct", value);
			expect((await editor.save()).advisors[0].budget).toEqual({ reservePct: value });
		}
	});

	it("edits and clears quota overrides using ANSI inputs and choices", async () => {
		const editor = open({ advisors: [{ name: "Security" }] });
		const press = (key: string, times = 1) => {
			for (let i = 0; i < times; i++) editor.overlay.handleInput(key);
		};
		const replace = (value: string, length: number) => {
			press("\x7f", length);
			for (const char of value) press(char);
			press("\r");
		};
		press("\r");
		press("\x1b[B", 8);
		press("\r");
		replace("101", 7);
		expect(editor.notices).toHaveLength(1);
		replace("30", 3);
		press("\x1b[B");
		press("\r");
		press("\x1b[B", 2);
		press("\r");
		expect((await editor.save()).advisors[0].budget).toEqual({ reservePct: 30, whenReserved: "skip" });
		press("\r");
		press("\x1b[B", 8);
		press("\r");
		replace("", 2);
		expect((await editor.save()).advisors[0].budget).toEqual({ whenReserved: "skip" });
		press("\r");
		press("\x1b[B", 9);
		press("\r");
		press("\x1b[A", 2);
		press("\r");
		expect((await editor.save()).advisors[0]).not.toHaveProperty("budget");
	});
});
