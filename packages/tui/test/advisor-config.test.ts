import { beforeAll, describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import type { TUI } from "../src/index";
import type { DescribeContext } from "../src/native/node";
import {
	AdvisorConfigOverlayComponent,
	type AdvisorConfigDeps,
	type WatchdogConfigDoc,
} from "../src/overlays/advisor-config";
import { getThemeByName, setThemeInstance } from "../src/theme";

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

describe("advisor review mode picker", () => {
	beforeAll(async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("theme unavailable");
		setThemeInstance(theme);
	});

	it("preserves configured mode when accepting current selection and saving", async () => {
		let saved: WatchdogConfigDoc | undefined;
		const overlay = new AdvisorConfigOverlayComponent(
			{} as TUI,
			deps,
			"project",
			{ advisors: [{ name: "Reviewer", reviewMode: "agent-end", reviewInterval: 3 }] },
			{
				loadDoc: async () => ({ advisors: [] }),
				save: async (_scope, doc) => {
					saved = structuredClone(doc);
				},
				close: () => {},
				requestRender: () => {},
				notify: () => {},
			},
		);

		overlay.handleInput("\r"); // Advisor detail.
		for (let i = 0; i < 3; i++) overlay.handleInput("\x1b[B");
		overlay.handleInput("\r"); // Review mode.
		overlay.handleInput("\r"); // Accept current mode without navigating.
		overlay.handleInput("\x1b"); // Back to roster.
		for (let i = 0; i < 6; i++) overlay.handleInput("\x1b[B");
		overlay.handleInput("\r"); // Save & apply.
		await Promise.resolve();

		expect(saved?.advisors).toEqual([{ name: "Reviewer", reviewMode: "agent-end", reviewInterval: 3 }]);
	});
});

describe("advisor sync backlog picker", () => {
	beforeAll(async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("theme unavailable");
		setThemeInstance(theme);
	});

	const buildOverlay = (doc: WatchdogConfigDoc, onSave: (doc: WatchdogConfigDoc) => void) =>
		new AdvisorConfigOverlayComponent({} as TUI, deps, "project", doc, {
			loadDoc: async () => ({ advisors: [] }),
			save: async (_scope, doc) => onSave(doc),
			close: () => {},
			requestRender: () => {},
			notify: () => {},
		});

	it("applies an explicit strict override through the picker and saves it", async () => {
		let saved: WatchdogConfigDoc | undefined;
		const overlay = buildOverlay({ advisors: [{ name: "Reviewer" }] }, doc => {
			saved = structuredClone(doc);
		});

		overlay.handleInput("\r"); // Advisor detail.
		for (let i = 0; i < 5; i++) overlay.handleInput("\x1b[B");
		overlay.handleInput("\r"); // Sync backlog picker (inherit selected).
		for (let i = 0; i < 5; i++) overlay.handleInput("\x1b[B");
		overlay.handleInput("\r"); // Pick strict.
		overlay.handleInput("\x1b"); // Back to roster.
		for (let i = 0; i < 6; i++) overlay.handleInput("\x1b[B");
		overlay.handleInput("\r"); // Save & apply.
		await Promise.resolve();

		expect(saved?.advisors).toEqual([{ name: "Reviewer", syncBacklog: "strict" }]);
	});

	it("clears an explicit override back to inherit", async () => {
		let saved: WatchdogConfigDoc | undefined;
		const overlay = buildOverlay({ advisors: [{ name: "Reviewer", syncBacklog: "off" }] }, doc => {
			saved = structuredClone(doc);
		});

		overlay.handleInput("\r"); // Advisor detail.
		for (let i = 0; i < 5; i++) overlay.handleInput("\x1b[B");
		overlay.handleInput("\r"); // Sync backlog picker (off selected).
		overlay.handleInput("\x1b[A"); // Up to inherit.
		overlay.handleInput("\r"); // Pick inherit.
		overlay.handleInput("\x1b"); // Back to roster.
		for (let i = 0; i < 6; i++) overlay.handleInput("\x1b[B");
		overlay.handleInput("\r"); // Save & apply.
		await Promise.resolve();

		expect(saved?.advisors).toEqual([{ name: "Reviewer" }]);
	});

	it("keeps a sync backlog edit on the seeded default row instead of discarding the roster", async () => {
		let saved: WatchdogConfigDoc | undefined;
		const overlay = buildOverlay({ advisors: [] }, doc => {
			saved = structuredClone(doc);
		});

		overlay.handleInput("\r"); // Seeded "default" advisor detail.
		for (let i = 0; i < 5; i++) overlay.handleInput("\x1b[B");
		overlay.handleInput("\r"); // Sync backlog picker (inherit selected).
		for (let i = 0; i < 5; i++) overlay.handleInput("\x1b[B");
		overlay.handleInput("\r"); // Pick strict.
		overlay.handleInput("\x1b"); // Back to roster.
		for (let i = 0; i < 6; i++) overlay.handleInput("\x1b[B");
		overlay.handleInput("\r"); // Save & apply.
		await Promise.resolve();

		// A real edit must survive: the seeded row is no longer synthetic, so the
		// save must not collapse the roster to empty (which would delete the file).
		expect(saved?.advisors).toEqual([{ name: "default", syncBacklog: "strict" }]);
	});

	it("edits cadence from the native prefs page, saving defaults and inherit as omitted fields", async () => {
		let saved: WatchdogConfigDoc | undefined;
		const overlay = buildOverlay({ advisors: [{ name: "Reviewer", syncBacklog: "off" }] }, doc => {
			saved = structuredClone(doc);
		});
		const change = (item: string, value: string | number | null) =>
			overlay.handleNativeEvent({ type: "change", key: "", item, value });

		overlay.handleNativeEvent({ type: "action", key: "", act: "page", value: "advisor:0", mods: [] });
		change("reviewMode", "agent-end");
		change("reviewInterval", 3);
		change("reviewInterval", null); // Reset to the default interval.
		change("syncBacklog", "inherit");
		overlay.handleNativeEvent({ type: "action", key: "", act: "save", mods: [] });
		await Promise.resolve();

		expect(saved?.advisors).toEqual([{ name: "Reviewer", reviewMode: "agent-end" }]);
	});

	it("docks as a side sheet like /settings only where the terminal draws prefs with aside", () => {
		const overlay = buildOverlay({ advisors: [] }, () => {});
		const cx: DescribeContext = {
			cols: 120,
			reduceMotion: false,
			dark: true,
			supports: () => true,
			feature: () => true,
		};
		expect(overlay.nativeSheet(cx)).toBe(true);
		expect(overlay.nativeSheet({ ...cx, feature: name => name !== "aside" })).toBe(false);
		expect(overlay.nativeSheet({ ...cx, supports: kind => kind !== "prefs" })).toBe(false);
	});

	it("still drops the untouched seeded default row on save", async () => {
		let saved: WatchdogConfigDoc | undefined;
		const overlay = buildOverlay({ advisors: [] }, doc => {
			saved = structuredClone(doc);
		});

		for (let i = 0; i < 6; i++) overlay.handleInput("\x1b[B");
		overlay.handleInput("\r"); // Save & apply without touching the seeded row.
		await Promise.resolve();

		expect(saved?.advisors).toEqual([]);
	});

	it("preserves a real default advisor carrying only maxNotesPerUpdate on save", async () => {
		let saved: WatchdogConfigDoc | undefined;
		const overlay = buildOverlay({ advisors: [{ name: "default", maxNotesPerUpdate: 2 }] }, doc => {
			saved = structuredClone(doc);
		});

		for (let i = 0; i < 6; i++) overlay.handleInput("\x1b[B");
		overlay.handleInput("\r"); // Save & apply without touching the row.
		await Promise.resolve();

		// The row is a real roster entry carrying a per-advisor budget, not the
		// synthetic seed: save must not collapse the roster to empty, which
		// would silently delete the entry from the file.
		expect(saved?.advisors).toEqual([{ name: "default", maxNotesPerUpdate: 2 }]);
	});

	it("surfaces the newly active file's warnings on scope switch, and only there", async () => {
		const warnings: string[] = [];
		let pendingLoad: Promise<WatchdogConfigDoc> | undefined;
		const overlay = new AdvisorConfigOverlayComponent(
			{} as TUI,
			deps,
			"project",
			{ advisors: [{ name: "Reviewer" }] },
			{
				loadDoc: () => {
					pendingLoad = Promise.resolve({
						advisors: [],
						warnings: [
							`${path.join(os.homedir(), ".omp", "WATCHDOG.yml")}: advisor "\x1b[31mBad\tName\x1b[0m" dropped — boom`,
						],
					});
					return pendingLoad;
				},
				save: async () => {},
				close: () => {},
				requestRender: () => {},
				notify: () => {},
				warn: message => warnings.push(message),
			},
		);

		// Opening the project file shows nothing — the host owns initial warnings.
		expect(warnings).toEqual([]);

		for (let i = 0; i < 5; i++) overlay.handleInput("\x1b[B");
		overlay.handleInput("\r"); // Switch scope to user.
		// The overlay awaits the same promise; awaiting it here runs after its continuation.
		await pendingLoad;

		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain('advisor "Bad   Name" dropped');
		expect(warnings[0]).toContain("~/.omp/WATCHDOG.yml");
		expect(warnings[0]).not.toContain(path.join(os.homedir(), ".omp", "WATCHDOG.yml"));
		// The toast is chat-mounted behind the fullscreen overlay, so the warning
		// must also render inside the editor itself.
		const frame = overlay.render(100).join("\n");
		expect(frame).toContain('advisor "Bad   Name" dropped');
	});

	it("renders the opening file's warnings inside the overlay without re-notifying", () => {
		const warnings: string[] = [];
		const overlay = new AdvisorConfigOverlayComponent(
			{} as TUI,
			deps,
			"project",
			{ advisors: [{ name: "Good" }], warnings: ['/repo/WATCHDOG.yml: advisor "Bad" dropped — boom'] },
			{
				loadDoc: async () => ({ advisors: [] }),
				save: async () => {},
				close: () => {},
				requestRender: () => {},
				notify: () => {},
				warn: message => warnings.push(message),
			},
		);

		const frame = overlay.render(100).join("\n");
		expect(frame).toContain('advisor "Bad" dropped');
		expect(warnings).toEqual([]);
	});
});

describe("advisor taxonomy and notes budget editing", () => {
	beforeAll(async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("theme unavailable");
		setThemeInstance(theme);
	});

	const taxonomyDeps: AdvisorConfigDeps = {
		...deps,
		maxNotesPerUpdate: 4,
		defaultCategories: [
			{ id: "logic", description: "Logic.", owner: "Correctness" },
			{ id: "security", description: "Sec.", owner: "Security", precedence: 1 },
		],
	};

	const open = (
		doc: WatchdogConfigDoc,
		sink: { saved?: WatchdogConfigDoc; notices: string[]; warnings: string[] },
		extra?: Partial<AdvisorConfigDeps>,
	) =>
		new AdvisorConfigOverlayComponent({} as TUI, { ...taxonomyDeps, ...extra }, "project", doc, {
			loadDoc: async () => ({ advisors: [] }),
			save: async (_scope, saved) => {
				sink.saved = structuredClone(saved);
			},
			close: () => {},
			requestRender: () => {},
			notify: message => sink.notices.push(message),
			warn: message => sink.warnings.push(message),
		});

	const press = (overlay: AdvisorConfigOverlayComponent, key: string, times = 1) => {
		for (let i = 0; i < times; i++) overlay.handleInput(key);
	};
	const type = (overlay: AdvisorConfigOverlayComponent, value: string, erase = 0) => {
		press(overlay, "\x7f", erase);
		for (const char of value) overlay.handleInput(char);
	};
	const down = "\x1b[B";

	it("edits budgets, owns, and categories from the keyboard and saves only valid categories", async () => {
		const sink = { notices: [] as string[], warnings: [] as string[] } as {
			saved?: WatchdogConfigDoc;
			notices: string[];
			warnings: string[];
		};
		const overlay = open({ advisors: [{ name: "Security" }, { name: "Speed" }] }, sink);

		// Roster: Security, Speed, add, shared, notes per update, categories, scope, save, close.
		press(overlay, down, 4);
		press(overlay, "\r"); // Shared notes per update ("inherit").
		type(overlay, "40", "inherit".length);
		press(overlay, "\r"); // Out of range: rejected, editor stays.
		type(overlay, "6", 2);
		press(overlay, "\r");

		press(overlay, down);
		press(overlay, "\r"); // Categories: logic (default), security (default), add, customize, back.
		press(overlay, down, 3);
		press(overlay, "\r"); // Customize the bundled defaults.
		press(overlay, down, 2);
		press(overlay, "\r"); // + Add category.
		type(overlay, "Hot Paths");
		press(overlay, "\r"); // Not lower-kebab: rejected.
		type(overlay, "perf-hot", "Hot Paths".length);
		press(overlay, "\r"); // Category detail: id, description, owner, precedence, remove, back.
		press(overlay, down);
		press(overlay, "\r");
		type(overlay, "Hot paths.");
		press(overlay, "\r");
		press(overlay, down, 2);
		press(overlay, "\r"); // Owner: none, Security, Speed.
		press(overlay, down, 2);
		press(overlay, "\r");
		press(overlay, down, 3);
		press(overlay, "\r"); // Precedence ("none").
		type(overlay, "3", "none".length);
		press(overlay, "\r");
		press(overlay, "\x1b"); // Categories list on perf-hot: logic, security, perf-hot, add, use defaults, back.
		press(overlay, down);
		press(overlay, "\r");
		type(overlay, "empty-one");
		press(overlay, "\r"); // Created without a description.
		press(overlay, "\x1b");
		press(overlay, "\x1b"); // Roster, on the categories row.

		press(overlay, "\x1b[A", 4);
		press(overlay, "\r"); // Speed detail.
		press(overlay, down, 6);
		press(overlay, "\r"); // Notes per update ("inherit").
		type(overlay, "2", "inherit".length);
		press(overlay, "\r");
		press(overlay, down); // Detail keeps Notes per update selected; Owns is next.
		press(overlay, "\r"); // Owns: logic, security, perf-hot, empty-one, Done.
		press(overlay, "\r"); // Toggle logic.
		press(overlay, down, 2);
		press(overlay, "\r"); // Toggle perf-hot.
		press(overlay, "\x1b"); // Apply.
		press(overlay, "\x1b"); // Roster.

		press(overlay, down, 7);
		press(overlay, "\r"); // Save & apply.
		await Promise.resolve();

		expect(sink.saved).toEqual({
			maxNotesPerUpdate: 6,
			categories: {
				logic: { description: "Logic." },
				security: { description: "Sec.", owner: "Security", precedence: 1 },
				"perf-hot": { description: "Hot paths.", owner: "Speed", precedence: 3 },
			},
			advisors: [{ name: "Security" }, { name: "Speed", maxNotesPerUpdate: 2, owns: ["logic", "perf-hot"] }],
		});
		expect(sink.notices).toEqual([
			"Notes per update must be an integer from 1 to 32, or inherit.",
			"Category ids are lower-kebab: a-z and 0-9 words joined by single hyphens.",
		]);
		expect(sink.warnings).toEqual(['WATCHDOG.yml: category "empty-one" dropped — empty id or description']);
	});

	it("edits the taxonomy from the native prefs page, renaming owns references and clearing with reset", async () => {
		const sink = { notices: [] as string[], warnings: [] as string[] } as {
			saved?: WatchdogConfigDoc;
			notices: string[];
			warnings: string[];
		};
		const overlay = open(
			{
				maxNotesPerUpdate: 5,
				categories: { logic: { description: "Logic." }, docs: { description: "Docs.", owner: "Ghost" } },
				advisors: [{ name: "Security", owns: ["docs"], maxNotesPerUpdate: 9 }],
			},
			sink,
		);
		const action = (act: string, value?: string) =>
			overlay.handleNativeEvent({ type: "action", key: "", act, value, mods: [] });
		const change = (item: string, value: string | number | string[] | null) =>
			overlay.handleNativeEvent({ type: "change", key: "", item, value });

		action("page", "advisor:0");
		change("maxNotesPerUpdate", 40);
		change("maxNotesPerUpdate", null);
		change("owns", ["docs", "logic"]);
		action("page", "categories");
		change("category:0:id", "Not Kebab");
		change("category:0:id", "docs");
		change("category:0:id", "correctness");
		change("category:0:precedence", 4);
		change("category:1:owner", "Security");
		action("add-category");
		for (const char of "api") overlay.handleInput(char);
		action("field-save");
		change("category:2:description", "Public API.");
		change("category:2:precedence", 7);
		change("category:2:precedence", null);
		action("delete", "category:1:delete");

		action("page", "shared");
		change("sharedMaxNotes", null);
		action("save");
		await Promise.resolve();

		expect(sink.saved).toEqual({
			categories: { correctness: { description: "Logic.", precedence: 4 }, api: { description: "Public API." } },
			advisors: [{ name: "Security", owns: ["correctness"] }],
		});
		expect(sink.notices).toEqual([
			"Category ids are lower-kebab: a-z and 0-9 words joined by single hyphens.",
			'Category "docs" already exists.',
		]);
	});

	it("keeps the bundled taxonomy when the first category is added to a file without categories", async () => {
		const sink = { notices: [] as string[], warnings: [] as string[] } as {
			saved?: WatchdogConfigDoc;
			notices: string[];
			warnings: string[];
		};
		const overlay = open({ advisors: [{ name: "Security" }] }, sink);
		const action = (act: string) => overlay.handleNativeEvent({ type: "action", key: "", act, mods: [] });

		action("add-category");
		for (const char of "logic") overlay.handleInput(char);
		action("field-save"); // A bundled id: rejected.
		for (let i = 0; i < "logic".length; i++) overlay.handleInput("\x7f");
		for (const char of "api") overlay.handleInput(char);
		action("field-save");
		overlay.handleNativeEvent({ type: "change", key: "", item: "category:2:description", value: "Public API." });
		action("save");
		await Promise.resolve();

		expect(sink.saved?.categories).toEqual({
			logic: { description: "Logic." },
			security: { description: "Sec.", owner: "Security", precedence: 1 },
			api: { description: "Public API." },
		});
		expect(sink.notices).toEqual(['Category "logic" already exists.']);
	});

	it("shows the bundled taxonomy with roster owners and the host's owner-resolution warnings on the categories page", () => {
		const overlay = open(
			{ advisors: [{ name: "Security", owns: ["nope"] }] },
			{ notices: [], warnings: [] },
			{
				resolveCategoryWarnings: doc =>
					doc.advisors.flatMap(advisor =>
						(advisor.owns ?? []).map(id => `advisor "${advisor.name}": owns unknown category "${id}" — ignored`),
					),
			},
		);
		overlay.handleNativeEvent({ type: "action", key: "", act: "page", value: "categories", mods: [] });
		const cx: DescribeContext = {
			cols: 120,
			reduceMotion: false,
			dark: true,
			supports: () => true,
			feature: () => true,
		};
		const props = overlay.describe(cx).p as {
			page: string;
			sections: { id: string; rows: { id: string; label: string; hint?: string; warning?: string }[] }[];
		};
		expect(props.page).toBe("categories");
		const defaults = props.sections.find(section => section.id === "defaults")?.rows;
		expect(defaults?.map(row => [row.label, row.hint])).toEqual([
			["logic", "owner none · Logic."],
			["security", "owner Security · precedence 1 · Sec."],
		]);
		expect(props.sections.find(section => section.id === "taxonomy-warnings")?.rows[0]?.warning).toBe(
			'advisor "Security": owns unknown category "nope" — ignored',
		);
	});

	const strip = (lines: readonly string[]): string => lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");

	it("keeps the edited field selected when the detail screen rebuilds", () => {
		const sink = { notices: [] as string[], warnings: [] as string[] };
		const overlay = open({ advisors: [{ name: "Reviewer" }] }, sink);
		press(overlay, "\r"); // Reviewer detail.
		press(overlay, down, 6);
		press(overlay, "\r"); // Notes per update.
		type(overlay, "6", "inherit".length);
		press(overlay, "\r");
		press(overlay, "\r"); // Notes per update again, not Name.
		expect(strip(overlay.render(120))).toContain('Notes per update · advisor "Reviewer"');
		press(overlay, "\x1b");
		press(overlay, down);
		press(overlay, "\r"); // Owns, the row after Notes per update.
		expect(strip(overlay.render(120))).toContain("[ ] logic");
	});

	it("titles the notes budget editors with the field and its scope", () => {
		const sink = { notices: [] as string[], warnings: [] as string[] };
		const overlay = open({ advisors: [{ name: "Reviewer" }] }, sink);
		press(overlay, down, 3);
		press(overlay, "\r"); // Shared notes per update.
		const text = strip(overlay.render(120));
		expect(text).toContain("Notes per update · file-level default · project WATCHDOG.yml");
		expect(text).toContain("blockers are exempt");
	});

	it("ellipsizes long category and owns descriptions at 80 columns", () => {
		const sink = { notices: [] as string[], warnings: [] as string[] };
		const description = "Trust boundaries, injection, secrets, permissions, and every other security concern.";
		const overlay = open({ categories: { security: { description } }, advisors: [{ name: "Reviewer" }] }, sink);
		press(overlay, down, 4);
		press(overlay, "\r"); // Categories.
		const categories = strip(overlay.render(80))
			.split("\n")
			.find(line => line.includes("security"));
		expect(categories).toContain("…");
		press(overlay, "\x1b");
		press(overlay, "\x1b[A", 4);
		press(overlay, "\r"); // Reviewer detail.
		press(overlay, down, 7);
		press(overlay, "\r"); // Owns.
		const owns = strip(overlay.render(80))
			.split("\n")
			.find(line => line.includes("[ ] security"));
		expect(owns).toContain("…");
	});
});
