/**
 * Contracts of the fullscreen /account manager: accounts listed per provider
 * with their details, edits applied by action id through the host, a refused
 * edit shown with nothing else changed, and read-only fields never applied.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import type { TUI } from "../src/index";
import {
	type AccountManagerAccount,
	AccountManagerComponent,
	type AccountManagerResult,
} from "../src/overlays/account-manager";
import { initTheme } from "../src/theme";

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const ENTER = "\r";

// Narrow TUI stub: the manager only reads terminal rows and requests renders.
const tuiStub = { requestRender: () => {}, terminal: { rows: 30 } } as unknown as TUI;

function account(id: string, provider: string, overrides: Partial<AccountManagerAccount> = {}): AccountManagerAccount {
	return {
		id,
		provider,
		identity: `${id}@example.com`,
		badges: [],
		details: [{ label: "billing", value: "included available" }],
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
			account("a", "anthropic", { name: "work", badges: ["priority 10", "session pin"] }),
			account("b", "openai"),
		]);
		const text = screen();
		expect(text).toContain("All accounts");
		expect(text).toMatch(/anthropic\s+1/);
		expect(text).toMatch(/openai\s+1/);
		expect(text).toMatch(/work\s+anthropic\s+a@example\.com.*priority 10 · session pin/);
		expect(text).toContain("(unnamed)");
		expect(text).toContain("included available");
	});

	test("applies an input field through the host with the typed value", async () => {
		const { manager, screen, applied } = createManager([account("a", "anthropic")], { message: "Set priority 7." });
		manager.handleInput("p");
		manager.handleInput("7");
		manager.handleInput(ENTER);
		await settle();
		expect(applied).toEqual([["a", "priority", "7"]]);
		expect(screen()).toContain("Set priority 7.");
	});

	test("shows a refused edit's message", async () => {
		const { manager, screen, applied } = createManager([account("a", "anthropic")], {
			error: "auth.accountPolicies[0].drain applies to OAuth accounts only",
		});
		manager.handleInput(ENTER);
		manager.handleInput("\x1b[C"); // drain chip
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
		expect(screen()).toContain("priority: auth.accountPolicies is set in the overlay layer");
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
		const clean = createManager([account("a", "anthropic")]);
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
		await settle();
		const raw = manager.render(140);
		const text = raw.join("\n");
		expect(text).not.toContain("\x07");
		expect(text).not.toContain("\x1b]");
		expect(text).not.toContain("\x1b[2J");
		expect(text.replace(ANSI_PATTERN, "")).toContain("evil line");
		expect(text.split("\n").length).toBe(clean.manager.render(140).join("\n").split("\n").length);
	});
});
