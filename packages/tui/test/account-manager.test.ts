/**
 * Contracts of the fullscreen /account manager: accounts listed per provider
 * with their details, edits applied by action id through the host, a refused
 * edit shown with nothing else changed, and read-only fields never applied.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { type TUI, visibleWidth } from "../src/index";
import type { KeyId } from "../src/keys";
import type { TspPickerProps, TspPrefsProps } from "@oh-my-pi/pi-wire";
import {
	type AccountManagerAccount,
	AccountManagerComponent,
	type AccountManagerResult,
} from "../src/overlays/account-manager";
import { initTheme } from "../src/theme";

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const ENTER = "\r";

const nativeContext = { cols: 140, reduceMotion: false, dark: true, supports: () => true, feature: () => true };
function prefs(manager: AccountManagerComponent): TspPrefsProps {
	const root = manager.describe(nativeContext);
	expect(root.k).toBe("prefs");
	return root.p as TspPrefsProps;
}
function change(manager: AccountManagerComponent, item: string, value: string | number | boolean): void {
	manager.handleNativeEvent({ type: "change", key: "", item, value });
}
// Narrow TUI stub: the manager only reads terminal rows and requests renders.
const tuiStub = { requestRender: () => {}, terminal: { rows: 30 } } as unknown as TUI;

function account(id: string, provider: string, overrides: Partial<AccountManagerAccount> = {}): AccountManagerAccount {
	return {
		id,
		provider,
		identity: `${id}@example.com`,
		badges: [],
		details: [{ label: "billing", value: "5h 75% left · resets in 2h10m" }],
		fields: [
			{ id: "priority", label: "priority", key: "p", value: "default", input: { initial: "", hint: "a number" } },
			{ id: "drain", label: "drain", key: "d", value: "off", on: false },
		],
		...overrides,
	};
}

function createManager(
	accounts: AccountManagerAccount[],
	result: AccountManagerResult = { message: "saved" },
): { manager: AccountManagerComponent; screen: () => string; applied: [string, string, string | undefined][] } {
	const applied: [string, string, string | undefined][] = [];
	const manager = new AccountManagerComponent(
		tuiStub,
		{
			load: () => accounts,
			apply: async (accountId, actionId, value) => {
				applied.push([accountId, actionId, value]);
				return result;
			},
		},
		{ onCancel: () => {} },
	);
	return { manager, screen: () => manager.render(140).join("\n").replace(ANSI_PATTERN, ""), applied };
}

async function settle(): Promise<void> {
	await Bun.sleep(0);
}

beforeAll(async () => {
	await initTheme(false);
});

describe("AccountManager", () => {
	test("lists every account under its provider with the selected account's details", () => {
		const { screen } = createManager([
			account("a", "anthropic", {
				name: "work",
				badges: ["priority 10", "session pin", "5h 75% left · resets in 2h10m"],
			}),
			account("b", "openai"),
		]);
		const text = screen();
		expect(text).toContain("All accounts");
		expect(text).toMatch(/anthropic\s+1/);
		expect(text).toMatch(/openai\s+1/);
		expect(text).toMatch(/work\s+anthropic\s+a@example\.com.*priority 10 · session pin/);
		expect(text).toContain("(unnamed)");
		expect(text).toContain("5h 75% left · resets in 2h10m");
	});

	test("clicking an account row edits that account, including after scrolling", async () => {
		const { manager, applied } = createManager(
			Array.from({ length: 30 }, (_, i) => account(`account-${i}`, "anthropic", { name: `name-${i}` })),
		);
		const clickRow = (id: number) => {
			const lines = manager.render(140).map(line => Bun.stripANSI(line));
			const row = lines.findIndex(line => line.includes(`account-${id}@example.com`));
			expect(row).toBeGreaterThan(0);
			manager.handleInput(`\x1b[<0;70;${row + 1}M`);
		};
		clickRow(0);
		change(manager, "drain", true);
		await settle();
		expect(applied.at(-1)?.[0]).toBe("account-0");
		manager.handleInput("\x1b");
		clickRow(1);
		manager.handleInput("d");
		manager.handleInput(ENTER);
		await settle();
		expect(applied.at(-1)?.[0]).toBe("account-1");
		manager.handleInput("\x1b");
		for (let i = 0; i < 25; i++) manager.handleInput("\x1b[B");
		manager.render(140);
		clickRow(25);
		manager.handleInput("d");
		manager.handleInput(ENTER);
		await settle();
		expect(applied.at(-1)?.[0]).toBe("account-25");
		manager.handleInput("\x1b");
		clickRow(25);
		change(manager, "drain", true);
		await settle();
		expect(applied.at(-1)?.[0]).toBe("account-25");
	});

	test("applies an input field through the host with the typed value", async () => {
		const { manager, screen, applied } = createManager([account("a", "anthropic")], { message: "Set priority 7." });
		manager.handleInput("p");
		manager.handleInput("7");
		manager.handleInput(ENTER);
		await settle();
		expect(applied).toEqual([["a", "priority", "7"]]);
		manager.handleInput("\x1b");
		expect(screen()).toContain("Set priority 7.");
	});

	test("shows a refused edit's message", async () => {
		const { manager, screen, applied } = createManager([account("a", "anthropic")], {
			error: "auth.accountPolicies[0].drain applies to OAuth accounts only",
		});
		manager.handleInput(ENTER);
		manager.handleInput("\x1b[B");
		manager.handleInput(ENTER);
		await settle();
		expect(applied).toEqual([["a", "drain", "on"]]);
		expect(screen()).toContain("drain applies to OAuth accounts only");
	});

	test("refuses a read-only field without calling the host", async () => {
		const readOnly = account("a", "anthropic", {
			fields: [
				{
					id: "priority",
					label: "priority",
					key: "p",
					value: "3",
					input: { initial: "3", hint: "a number" },
					readOnly: "auth.accountPolicies is set in the overlay layer",
				},
			],
		});
		const { manager, screen, applied } = createManager([readOnly]);
		manager.handleInput("p");
		await settle();
		expect(applied).toEqual([]);
		expect(screen()).toContain("auth.accountPolicies is set in the overlay layer");
	});

	test("ignores field shortcuts while the provider sidebar has focus", async () => {
		const { manager, applied } = createManager([account("a", "anthropic")]);
		manager.handleInput("\x1b[D"); // focus the sidebar
		manager.handleInput("d");
		await settle();
		expect(applied).toEqual([]);
	});

	test("renders host strings with control sequences as single plain lines", async () => {
		const hostile = "\x1b]0;owned\x07\x1b[2Jevil\nline";
		const { manager } = createManager(
			[
				account("a", "anthropic", {
					identity: hostile,
					badges: [hostile],
					details: [{ label: "billing", value: hostile }],
				}),
			],
			{ error: hostile },
		);
		manager.handleInput("d");
		manager.handleInput(ENTER);
		await settle();
		const raw = manager.render(140);
		const text = raw.join("\n");
		expect(text).not.toContain("\x07");
		expect(text).not.toContain("\x1b]");
		expect(text).not.toContain("\x1b[2J");
		expect(text.replace(ANSI_PATTERN, "")).toContain("evil line");
		expect(prefs(manager).sections?.[0]?.rows.find(row => row.id === "drain")?.warning).toContain("evil line");
	});

	test("lists host pages after the providers and applies a page row's field by row id", async () => {
		const applied: [string, string, string | undefined][] = [];
		const limit = account("limits:*", "", {
			name: "*",
			identity: "every call",
			badges: ["1 limit"],
			details: [{ label: "limit", value: "0.00 / 20 USD per month" }],
			fields: [{ id: "limit:add", label: "add", key: "a", value: "", input: { initial: "", hint: "a limit" } }],
		});
		const addScope = account("limits:new", "", { name: "(add scope)", identity: "limits for a scope" });
		const manager = new AccountManagerComponent(
			tuiStub,
			{
				load: () => [account("a", "anthropic")],
				pages: () => [
					{ id: "limits", label: "Global limits", empty: "No global limits.", rows: [limit, addScope], count: 1 },
					{ id: "pins", label: "Project \x1b[2Jpins", empty: "No project pins.", rows: [] },
				],
				apply: async (rowId, actionId, value) => {
					applied.push([rowId, actionId, value]);
					return { message: "* has 2 limits." };
				},
			},
			{ onCancel: () => {} },
		);
		const screen = () => manager.render(140).join("\n").replace(ANSI_PATTERN, "");
		expect(screen()).toMatch(/Global limits\s+1/);
		expect(screen()).toMatch(/Project pins\s+0/);
		expect(screen()).not.toContain("every call");

		manager.handleInput("\x1b[D"); // focus the sidebar
		manager.handleInput("\x1b[B"); // anthropic
		manager.handleInput("\x1b[B"); // Global limits, past the separator
		expect(screen()).toContain("Global limits · 1");
		expect(screen()).toMatch(/\*\s+every call\s+.*1 limit/);
		expect(screen()).toContain("0.00 / 20 USD per month");

		manager.handleInput("\x1b[C"); // focus the rows
		manager.handleInput("a");
		for (const key of "usd 5 day") manager.handleInput(key);
		manager.handleInput(ENTER);
		await settle();
		expect(applied).toEqual([["limits:*", "limit:add", "usd 5 day"]]);
		manager.handleInput("\x1b");
		expect(screen()).toContain("* has 2 limits.");

		manager.handleInput("\x1b[D");
		manager.handleInput("\x1b[B"); // Project pins
		expect(screen()).toContain("No project pins.");
		expect(screen()).not.toContain("No stored accounts");
	});

	describe("at 80 columns", () => {
		const narrow = (manager: AccountManagerComponent) =>
			manager.render(80).map(line => line.replace(ANSI_PATTERN, ""));
		const footer = (lines: readonly string[]) => lines[lines.length - 2] ?? "";
		/** Body column text (right of the sidebar) joined into one whitespace-normalized string. */
		const flat = (lines: readonly string[]) =>
			lines
				.map(line => line.split("│")[2] ?? "")
				.join(" ")
				.replace(/\s+/g, " ");
		const keyed = (key: KeyId, label: string) => ({ id: label, label, key, value: "off", on: false });
		const manyFields = [
			keyed("n", "name"),
			keyed("p", "priority"),
			keyed("r", "reserve"),
			keyed("d", "drain"),
			keyed("f", "spend"),
			keyed("t", "return"),
			keyed("w", "resets on"),
			keyed("a", "auto-redeem"),
			keyed("s", "session pin"),
			keyed("j", "project pin"),
			keyed("l", "limits"),
		];

		test("pages field shortcuts behind ? so every key and close stay visible", () => {
			const { manager } = createManager([account("a", "anthropic", { fields: manyFields })]);
			const seen: string[] = [];
			for (let page = 0; page < 4; page++) {
				const lines = narrow(manager);
				for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(80);
				expect(footer(lines)).toContain("? more keys");
				expect(footer(lines)).not.toContain("…");
				seen.push(footer(lines));
				manager.handleInput("?");
			}
			const all = seen.join(" ");
			for (const field of manyFields) expect(all).toContain(`${field.key} ${field.label}`);
			expect(all).toContain("Close");
			expect(all).toContain("Reload");
		});

		test("keeps every selected field visible while scrolling a preference sheet", () => {
			const fields = Array.from({ length: 30 }, (_, index) => keyed("d", `field-${index}`));
			const { manager } = createManager([account("a", "anthropic", { name: "a".repeat(120), fields })]);
			manager.handleInput(ENTER);
			for (const field of fields) {
				const lines = narrow(manager);
				for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(80);
				expect(lines.join(" ")).toContain(field.label);
				expect(prefs(manager).focus).toBe(field.id);
				manager.handleInput("\x1b[B");
			}
		});

		test("wraps a long notice and detail value instead of cutting them", async () => {
			const reason =
				"auth.accountPolicies is set in the project layer (.omp/config.yml); edit it there or remove it to name accounts here";
			const { manager } = createManager([
				account("a", "anthropic", {
					details: [{ label: "policy", value: reason }],
					fields: [{ id: "limits", label: "limits", key: "l", value: "0", readOnly: reason }],
				}),
			]);
			expect(flat(narrow(manager))).toContain(`policy ${reason}`);
			manager.handleInput("l");
			await settle();
			const lines = narrow(manager);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(80);
			expect(lines.join(" ").replace(/\s+/g, " ")).toContain(reason);
		});

		test("native notices wrap without truncating sanitized refusal reasons", async () => {
			const reason = "A long account policy refusal with\tunsafe\nspacing. ".repeat(6);
			const { manager } = createManager([
				account("a", "anthropic", {
					fields: [{ id: "limits", label: "limits", key: "l", value: "0", readOnly: reason }],
				}),
			]);
			manager.handleInput("l");
			await settle();
			const rows = prefs(manager).sections?.[0]?.rows ?? [];
			const disabled = rows.find(row => row.id === "limits")?.disabled;
			expect(disabled?.replace(/\s+/g, " ")).toContain("A long account policy refusal with unsafe spacing.");
			expect(disabled?.match(/A long account policy refusal/g)).toHaveLength(6);
			expect(disabled).not.toContain("\t");
			expect(disabled).not.toContain("\n");
		});

		test("wraps an empty page's guidance", () => {
			const empty = "No project pins. Pin the current project from an account (j).";
			const manager = new AccountManagerComponent(
				tuiStub,
				{
					load: () => [account("a", "anthropic")],
					pages: () => [{ id: "pins", label: "Project pins", empty, rows: [] }],
					apply: async () => ({}),
				},
				{ onCancel: () => {} },
			);
			manager.handleInput("\x1b[D"); // focus the sidebar
			manager.handleInput("\x1b[B"); // anthropic
			manager.handleInput("\x1b[B"); // Project pins, past the separator
			const lines = narrow(manager);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(80);
			expect(flat(lines)).toContain(empty);
		});

		test("shows an input field's syntax hint beside the input", () => {
			const { manager } = createManager([
				account("a", "anthropic", {
					fields: [
						{
							id: "limit:add",
							label: "add",
							key: "a",
							value: "limit",
							input: { initial: "", hint: "<usd|requests> <max> <day|week>" },
						},
					],
				}),
			]);
			manager.handleInput("a");
			expect(narrow(manager).join(" ")).toContain("<usd|requests> <max> <day|week>");
		});
	});

	describe("Tern picker table", () => {
		const withPicker = { cols: 140, reduceMotion: false, dark: true, supports: () => true, feature: () => true };
		const columns = [
			{ id: "billing", head: "Billing", priority: 3 },
			{ id: "state", head: "State", priority: 2 },
			{ id: "limits", head: "Limits", priority: 1 },
		];
		function pickerManager(rows: AccountManagerAccount[]) {
			const applied: [string, string, string | undefined][] = [];
			const closed: boolean[] = [];
			const manager = new AccountManagerComponent(
				tuiStub,
				{
					load: () => rows,
					accountColumns: columns,
					apply: async (accountId, actionId, value) => {
						applied.push([accountId, actionId, value]);
						return { message: "saved" };
					},
				},
				{
					onCancel: () => {
						closed.push(true);
					},
				},
			);
			const props = () => {
				const root = manager.describe(withPicker);
				expect(root.k).toBe("picker");
				return root.p as TspPickerProps;
			};
			return { manager, props, applied, closed };
		}

		test("rows carry one cell per declared column some row fills, grouped by provider under All accounts", () => {
			const { props } = pickerManager([
				account("a", "anthropic", { name: "work", facts: { billing: "5h 75% left", state: "enabled" } }),
				account("b", "openai", { facts: { state: "disabled", limits: "" } }),
			]);
			const p = props();
			// `limits` is declared but no row fills it, so the table drops it.
			expect(p.columns?.map(column => column.id)).toEqual(["billing", "state"]);
			expect(p.items?.find(item => item.id === "account:a")?.facts).toEqual({
				billing: "5h 75% left",
				state: "enabled",
			});
			expect(p.items?.find(item => item.id === "account:b")).toMatchObject({ label: "(unnamed)", tone: "muted" });
			expect((p.order ?? []).map(entry => (typeof entry === "string" ? entry : `# ${String(entry.label)}`))).toEqual(
				["# anthropic", "account:a", "# openai", "account:b"],
			);
		});

		test("field actions open typed preferences and changes apply through the host", async () => {
			const { manager, props, applied, closed } = pickerManager([
				account("a", "anthropic", { facts: { state: "enabled" } }),
			]);
			expect(props().actions?.map(action => action.id)).toEqual([
				"edit",
				"field:priority",
				"field:drain",
				"search",
				"reload",
				"close",
			]);
			manager.handleNativeEvent({ type: "action", key: "", act: "field:drain", mods: [] });
			expect(prefs(manager).focus).toBe("drain");
			expect(applied).toEqual([]);
			change(manager, "drain", true);
			await settle();
			expect(applied).toEqual([["a", "drain", "on"]]);
			manager.handleNativeEvent({ type: "action", key: "", act: "close", mods: [] });
			expect(closed).toEqual([]);
			expect(props().selected).toBe("account:a");
			manager.handleNativeEvent({ type: "action", key: "", act: "edit", mods: [] });
			expect(prefs(manager).sections?.[0]?.rows.map(row => row.id)).toEqual(["priority", "drain"]);
		});

		test("search matches account name, identity and provider, preserves selection and highlights labels", () => {
			const { manager, props, applied, closed } = pickerManager([
				account("a", "anthropic", { name: "work" }),
				account("b", "openai", { name: "backup" }),
			]);
			manager.handleNativeEvent({ type: "select", key: "", item: "account:b" });
			manager.handleNativeEvent({ type: "action", key: "", act: "search", mods: [] });
			for (const char of "back") manager.handleInput(char);
			expect(props().items?.map(item => item.id)).toEqual(["account:b"]);
			expect(props().items?.[0]?.hits).toEqual([[0, 4]]);
			expect(props().selected).toBe("account:b");
			expect(Bun.stripANSI(manager.render(180).join("\n"))).toContain("Search: back");
			manager.handleInput("\x1b");
			expect(props().items).toHaveLength(2);
			expect(props().selected).toBe("account:b");
			expect(closed).toEqual([]);
			for (const query of ["b@example.com", "openai"]) {
				manager.handleInput("/");
				for (const char of query) manager.handleInput(char);
				expect(props().items?.map(item => item.id)).toEqual(["account:b"]);
				manager.handleInput("\x1b");
			}
			expect(applied).toEqual([]);
		});

		test("search empty results and load errors have explicit picker and TUI states", () => {
			const { manager, props } = pickerManager([account("a", "anthropic")]);
			manager.handleInput("/");
			for (const char of "missing") manager.handleInput(char);
			expect(props()).toMatchObject({ state: "ready", empty: "No accounts match your search.", items: [] });
			expect(Bun.stripANSI(manager.render(180).join("\n"))).toContain("No accounts match your search.");
			const failed = new AccountManagerComponent(
				tuiStub,
				{
					load: () => {
						throw new Error("Cannot load accounts");
					},
					apply: async () => ({}),
				},
				{ onCancel: () => {} },
			);
			const root = failed.describe(withPicker);
			expect(root.p).toMatchObject({ state: "error", message: "Cannot load accounts" });
			expect(Bun.stripANSI(failed.render(180).join("\n"))).toContain("Cannot load accounts");
		});

		test("status badges use host facts, and disabled action reasons share the footer", () => {
			const { manager, props } = pickerManager([
				account("a", "anthropic", {
					name: "work",
					badges: ["disabled", "drain", "session pin", "project pin", "plan exhausted"],
					fields: [{ id: "priority", label: "priority", key: "p", value: "4", readOnly: "set in another layer" }],
				}),
				account("b", "openai", { name: "backup" }),
			]);
			expect(props().items?.[0]?.badges?.map(badge => badge.text)).toEqual([
				"disabled",
				"drain",
				"session pin",
				"project pin",
				"plan exhausted",
			]);
			expect(props().items?.[1]?.badges).toEqual([]);
			expect(props().actions?.find(action => action.id === "field:priority")?.disabled).toBe("set in another layer");
			const screen = Bun.stripANSI(manager.render(1000).join("\n"));
			for (const action of props().actions ?? []) expect(screen).toContain(action.label);
			expect(screen).toContain("set in another layer");
		});

		test("destructive actions require confirmation in native and plain renderers; cancel writes nothing", async () => {
			const { manager, props, applied } = pickerManager([
				account("a", "anthropic", {
					name: "work",
					fields: [
						{ id: "enabled", label: "enabled", key: "e", value: "on", on: true, confirm: "Disable account?" },
					],
				}),
			]);
			expect(props().actions?.find(action => action.id === "field:enabled")?.danger).toBe(true);
			manager.handleNativeEvent({ type: "action", key: "", act: "field:enabled", mods: [] });
			change(manager, "enabled", false);
			expect(props().confirm?.text).toContain("work (a@example.com)");
			expect(applied).toEqual([]);
			manager.handleNativeEvent({ type: "action", key: "", act: "close", mods: [] });
			expect(applied).toEqual([]);
			manager.handleInput("e");
			manager.handleInput(ENTER);
			expect(Bun.stripANSI(manager.render(220).join("\n"))).toContain("Disable account? — work (a@example.com)");
			manager.handleInput("\x1b");
			expect(applied).toEqual([]);
			manager.handleInput("e");
			manager.handleInput(ENTER);
			manager.handleInput(ENTER);
			await settle();
			expect(applied).toEqual([["a", "enabled", "off"]]);
		});
	});
});

test("account save exposes loading state until the host completes", async () => {
	const pending = Promise.withResolvers<AccountManagerResult>();
	const manager = new AccountManagerComponent(
		tuiStub,
		{
			load: () => [account("a", "anthropic")],
			apply: () => pending.promise,
		},
		{ onCancel: () => {} },
	);
	manager.handleInput("d");
	manager.handleInput(ENTER);
	expect(prefs(manager).sections?.[0]?.rows.every(row => row.disabled === "Saving…")).toBe(true);
	pending.resolve({ message: "Saved" });
	await settle();
	expect(prefs(manager).sections?.[0]?.rows.some(row => row.disabled === "Saving…")).toBe(false);
});

test("pasted C1 controls are removed from the account terminal query line", () => {
	const { manager } = createManager([account("a", "anthropic")]);
	manager.handleInput("/");
	manager.handleInput("\x1b[200~query\u0085text\x1b[201~");
	const screen = manager.render(180).join("\n");
	expect(screen).not.toMatch(/[\u0080-\u009f]/);
	expect(Bun.stripANSI(screen)).toContain("Search: querytext");
});
