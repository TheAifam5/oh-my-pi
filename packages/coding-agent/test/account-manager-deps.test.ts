import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAccountManagerDeps } from "@oh-my-pi/pi-coding-agent/modes/account-manager-deps";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { loadEffectiveAuthAccountPolicyConfig } from "@oh-my-pi/pi-coding-agent/session/auth-broker-config";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { UsageReport } from "@oh-my-pi/pi-ai/usage";
import { retryFallbackBillingRegistry } from "@oh-my-pi/pi-coding-agent/session/retry-fallback-groups";
import { YAML } from "bun";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";
import { AccountManagerComponent, type AccountManagerResult } from "@oh-my-pi/pi-tui/overlays/account-manager";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { TUI } from "@oh-my-pi/pi-tui";
import type { TspPrefsProps } from "@oh-my-pi/pi-wire";

const workPolicy = { provider: "anthropic", name: "work", account: { email: "a@example.com" } };

describe("account manager deps", () => {
	let state: SettingsTestState | undefined;
	let tempDir: TempDir;
	let agentDir: string;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		state = beginSettingsTest();
		tempDir = TempDir.createSync("@pi-account-manager-");
		agentDir = tempDir.join("agent");
		fs.mkdirSync(agentDir, { recursive: true });
		authStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
		await authStorage.credentials.set("anthropic", [
			{
				type: "oauth",
				access: "access-a",
				refresh: "refresh-a",
				expires: Date.now() + 3_600_000,
				accountId: "acc-a",
				email: "a@example.com",
			},
		]);
		await authStorage.credentials.set("openai", [{ type: "api_key", key: "sk-test-secret" }]);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		authStorage.close();
		restoreSettingsTestState(state);
		state = undefined;
		AgentStorage.close();
		tempDir.removeSync();
	});

	async function open(
		config: Record<string, unknown>,
		overrides?: Record<string, unknown>,
		usageReports?: () => readonly UsageReport[],
	) {
		fs.writeFileSync(path.join(agentDir, "config.yml"), YAML.stringify(config));
		const settings = await Settings.loadIsolated({ cwd: tempDir.path(), agentDir, overrides });
		authStorage.setAccountPolicies(await loadEffectiveAuthAccountPolicyConfig({ settings }));
		const deps = createAccountManagerDeps({ settings, authStorage, cwd: () => tempDir.path(), usageReports });
		const ids = Object.fromEntries(deps.load().map(account => [account.provider, account.id]));
		return { settings, deps, ids };
	}

	it("writes an edit through the validated policy write and refuses an invalid one without writing", async () => {
		const { settings, deps, ids } = await open({ auth: { accountPolicies: [workPolicy] } });

		expect(await deps.apply(ids.anthropic!, "priority", "7")).toEqual({ message: "Set priority 7 for work." });
		expect(settings.getGlobalSettings().auth).toEqual({ accountPolicies: [{ ...workPolicy, priority: 7 }] });

		const refused = await deps.apply(ids.openai!, "limit:add", "usage 0.5");
		expect(refused.error).toContain("applies to OAuth accounts only");
		expect(settings.getGlobalSettings().auth).toEqual({ accountPolicies: [{ ...workPolicy, priority: 7 }] });

		const openai = deps.load().find(account => account.provider === "openai")!;
		expect(openai.identity).toMatch(/^API key [0-9a-f]{16}$/);
		expect(JSON.stringify(openai)).not.toContain("sk-test-secret");
	});

	it("typed account preferences persist through the validated host and retain refused drafts", async () => {
		await initTheme(false);
		const { settings, deps } = await open({ auth: { accountPolicies: [workPolicy] } });
		vi.spyOn(authStorage.usage, "canFetchOAuthUsage").mockReturnValue(true);
		let pending: Promise<AccountManagerResult> | undefined;
		const manager = new AccountManagerComponent(
			{ requestRender: () => {}, terminal: { rows: 40 } } as unknown as TUI,
			{
				...deps,
				apply: (id, action, value, expected) => {
					pending = deps.apply(id, action, value, expected);
					return pending;
				},
			},
			{ onCancel: () => {} },
		);
		const context = { cols: 120, reduceMotion: false, dark: true, supports: () => true, feature: () => true };
		const prefs = () => manager.describe(context).p as TspPrefsProps;
		manager.handleInput("\r");
		const save = async (item: string, value: string | number | boolean) => {
			pending = undefined;
			manager.handleNativeEvent({ type: "change", key: "", item, value });
			expect(pending).toBeDefined();
			await pending;
			await Promise.resolve();
			await Promise.resolve();
		};
		await save("priority", 7);
		await save("reserve", 20);
		await save("drain", true);
		await save("return:margin", 10);
		await save("return:cooldown", 2);
		await save("auto-redeem", "auto-redeem:no");
		expect(settings.getGlobalSettings().auth).toMatchObject({
			accountPolicies: [
				{
					...workPolicy,
					priority: 7,
					drain: true,
					reservePct: 20,
					returnMargin: 10,
					returnCooldownMs: 120000,
					autoRedeem: "no",
				},
			],
		});
		const before = structuredClone(settings.getGlobalSettings());
		await save("name", "invalid name");
		expect(prefs().editing).toMatchObject({ row: "name", draft: "invalid name", cursor: 12 });
		expect(prefs().sections?.[0]?.rows.find(row => row.id === "name")?.warning).toBeTruthy();
		expect(settings.getGlobalSettings()).toEqual(before);
		await save("name", "renamed");
		expect(prefs().editing).toBeNull();
		expect(prefs().sections?.[0]?.rows.find(row => row.id === "name")?.warning).toBeUndefined();
		expect(settings.getGlobalSettings().auth).toMatchObject({ accountPolicies: [{ name: "renamed" }] });
	});

	it("shows the warning of a reserve whose usage only the broker reports", async () => {
		const { deps, ids } = await open({ auth: { accountPolicies: [workPolicy] } });
		vi.spyOn(authStorage.usage, "providerFor").mockReturnValue(undefined);
		vi.spyOn(authStorage.usage, "canFetchOAuthUsage").mockReturnValue(true);

		expect((await deps.apply(ids.anthropic!, "reserve", "20")).warning).toContain("no protection");
	});

	it("shows policies from a runtime layer read-only and refuses their edits", async () => {
		const { settings, deps, ids } = await open({}, { "auth.accountPolicies": [workPolicy] });

		const anthropic = deps.load().find(account => account.provider === "anthropic")!;
		expect(anthropic.fields.find(field => field.id === "priority")?.readOnly).toBe(
			"auth.accountPolicies is set in the runtime layer",
		);
		expect((await deps.apply(ids.anthropic!, "priority", "7")).error).toContain("runtime layer");
		expect(settings.getGlobalSettings().auth).toBeUndefined();
	});

	it("sets and clears a pool member's preferred account in the user config", async () => {
		const pool = { strategy: "random", models: { opus: { model: "anthropic/claude-opus-4-5" } } };
		const { settings, deps, ids } = await open({
			auth: { accountPolicies: [workPolicy] },
			modelRoles: { default: pool },
		});

		const field = deps
			.load()
			.find(account => account.provider === "anthropic")!
			.fields.find(f => f.id === "pool")!;
		expect(field.choices?.map(choice => choice.label)).toEqual([
			"modelRoles.default.models.opus (anthropic/claude-opus-4-5)",
		]);

		const action = field.choices![0]!.id;
		expect((await deps.apply(ids.anthropic!, action, "on")).message).toBe(
			"modelRoles.default.models.opus tries work first.",
		);
		expect(settings.getGlobalSettings().modelRoles).toEqual({
			default: { ...pool, models: { opus: { model: "anthropic/claude-opus-4-5", account: "work" } } },
		});
		await deps.apply(ids.anthropic!, action, "off");
		expect(settings.getGlobalSettings().modelRoles).toEqual({ default: pool });
	});

	it("warns about pins and pool members a rename leaves dangling, and keeps name-based pins on the policy layer", async () => {
		const pool = { strategy: "random", models: { opus: { model: "anthropic/claude-opus-4-5", account: "work" } } };
		const project = tempDir.path();
		const { settings, deps, ids } = await open({
			auth: { accountPolicies: [workPolicy], accountPins: { [project]: { anthropic: "work" } } },
			modelRoles: { default: pool },
		});
		const renamed = await deps.apply(ids.anthropic!, "name", "home");
		expect(renamed.warning).toContain(
			`auth.accountPins["${project}"], modelRoles.default.models.opus still name "work"`,
		);
		expect(settings.getGlobalSettings().modelRoles).toEqual({ default: pool });

		const blocked = await open({ modelRoles: { default: pool } }, { "auth.accountPolicies": [workPolicy] });
		const member = blocked.deps.load()[0]!.fields.find(field => field.id === "pool")!.choices![0]!.id;
		expect((await blocked.deps.apply(blocked.ids.anthropic!, member, "off")).error).toContain("runtime layer");
		expect((await blocked.deps.apply(blocked.ids.anthropic!, "pin-project", "on")).error).toContain("runtime layer");
		expect(blocked.settings.getGlobalSettings().modelRoles).toEqual({ default: pool });
		expect(blocked.settings.getGlobalSettings().auth).toBeUndefined();
	});

	it("rejects malformed and stale limit actions and applies toggles to their target state", async () => {
		const limited = {
			...workPolicy,
			limits: [{ metric: "requests", max: 10, window: { type: "calendar", period: "day" } }],
		};
		const { settings, deps, ids } = await open({ auth: { accountPolicies: [limited] } });
		const policies = () => settings.getGlobalSettings().auth;
		const before = policies();
		for (const action of [
			"limit:remove:1",
			"limit:remove:x",
			"limit:edit",
			"limit:add:0",
			"limit:drop:0",
			"limit:remove:00",
			"limit:remove:0x",
		]) {
			expect(
				(await deps.apply(ids.anthropic!, action, "requests 5 day", "requests 10 day skip")).error,
			).toBeDefined();
		}
		expect((await deps.apply(ids.anthropic!, "limit:remove:0", "", "usd 5 day skip")).error).toContain("changed");
		expect((await deps.apply(ids.anthropic!, "spend:credits", "on")).error).toBe("Drain work first.");
		expect((await deps.apply(ids.anthropic!, "drain")).error).toBe("A toggle needs its target state (on or off).");
		expect(policies()).toEqual(before);

		await deps.apply(ids.anthropic!, "drain", "on");
		expect((await deps.apply(ids.anthropic!, "drain", "on")).message).toBe("work is already drained first.");
		expect(policies()).toEqual({ accountPolicies: [{ ...limited, drain: true }] });
		expect((await deps.apply(ids.anthropic!, "limit:remove:0", "", "requests 10 day skip")).error).toBeUndefined();
		expect(policies()).toEqual({ accountPolicies: [{ ...workPolicy, drain: true }] });
	});

	it("toggles an account's enabled state with the e field and shows a disabled account", async () => {
		const { deps, ids } = await open({ auth: { accountPolicies: [workPolicy] } });
		const field = deps
			.load()
			.find(account => account.id === ids.anthropic)
			?.fields.find(entry => entry.id === "enabled");
		expect([field?.key, field?.on]).toEqual(["e", true]);

		expect(await deps.apply(ids.anthropic!, "enabled", "off")).toEqual({
			message: "work is disabled; no request uses it.",
		});
		expect(authStorage.credentials.list("anthropic")).toEqual([]);
		const disabled = deps.load().find(account => account.id === ids.anthropic);
		expect(disabled?.badges).toContain("disabled");
		expect(disabled?.fields.find(entry => entry.id === "enabled")?.on).toBe(false);
		expect((await deps.apply(ids.anthropic!, "enabled", "off")).message).toBe("work is already disabled.");

		expect(await deps.apply(ids.anthropic!, "enabled", "on")).toEqual({ message: "work is enabled." });
		expect(authStorage.credentials.list("anthropic")).toHaveLength(1);
	});

	it("attributes billing evidence only to the OAuth account a report names", async () => {
		const unregister = retryFallbackBillingRegistry.register({
			id: "acme",
			readBilling: report => ({
				status: "known",
				snapshot: {
					provider: "acme",
					fetchedAt: report.fetchedAt,
					sources: [{ mode: "paid-extra-usage", state: "disabled" }],
				},
			}),
		});
		try {
			const oauth = (suffix: string) => ({
				type: "oauth" as const,
				access: `access-${suffix}`,
				refresh: `refresh-${suffix}`,
				expires: Date.now() + 3_600_000,
				email: `${suffix}@acme.test`,
			});
			await authStorage.credentials.set("acme", [oauth("x"), oauth("y")]);
			let reports: UsageReport[] = [{ provider: "acme", fetchedAt: Date.now(), limits: [] }];
			const { deps } = await open({}, undefined, () => reports);
			const billing = () =>
				deps
					.load()
					.filter(account => account.provider === "acme")
					.map(account => account.details.find(detail => detail.label === "billing")?.value);
			expect(billing()).toEqual(["unknown (no-report)", "unknown (no-report)"]);
			reports = [
				{
					provider: "acme",
					fetchedAt: Date.now(),
					metadata: { email: "x@acme.test" },
					limits: [
						{
							id: "balance",
							label: "Balance",
							scope: { provider: "acme", shared: true },
							amount: { unit: "credits", remaining: 20 },
						},
					],
				},
			];
			expect(billing()).toEqual(["Balance 20 credits left, extra usage disabled", "unknown (no-report)"]);
		} finally {
			unregister();
		}
	});

	it("shows account windows, exhaustion, saved resets and stale ages without model windows in rows", async () => {
		const now = 1_800_000_000_000;
		vi.spyOn(Date, "now").mockReturnValue(now);
		const reports: UsageReport[] = [
			{
				provider: "anthropic",
				fetchedAt: now - 3_600_000,
				metadata: { email: "a@example.com" },
				resetCredits: { availableCount: 2 },
				limits: [
					{
						id: "5h",
						label: "5h",
						scope: { provider: "anthropic", shared: true, sharedGroup: "5h" },
						window: { id: "5h", label: "5h", resetsAt: now + 7_800_000 },
						amount: { unit: "percent", usedFraction: 0.25 },
					},
					{
						id: "copy",
						label: "copy",
						scope: { provider: "anthropic", shared: true, sharedGroup: "5h", modelId: "copy" },
						amount: { unit: "percent", usedFraction: 0.25 },
					},
					{
						id: "7d",
						label: "7d",
						scope: { provider: "anthropic", shared: true },
						window: { id: "7d", label: "7d", resetsAt: now + 86_400_000 },
						amount: { unit: "percent", usedFraction: 1 },
						status: "exhausted",
					},
					{
						id: "model",
						label: "Model weekly",
						scope: { provider: "anthropic", shared: true, modelId: "model-only" },
						amount: { unit: "percent", remainingFraction: 0.4 },
					},
					{
						id: "tier",
						label: "Tier weekly",
						scope: { provider: "anthropic", tier: "fable" },
						window: { id: "tier", label: "7d" },
						amount: { unit: "percent", remainingFraction: 0.6 },
					},
				],
			},
		];
		const { deps } = await open({}, undefined, () => reports);
		const account = deps.load().find(account => account.provider === "anthropic")!;
		const summary = account.badges.join(" · ");
		expect(summary).toContain("5h 75% left · resets in 2h10m");
		expect(summary).toContain("7d exhausted · resets in 1d");
		expect(summary).toContain("2 saved resets");
		expect(summary).toContain("fetched 1h ago");
		expect(summary).not.toContain("copy");
		expect(summary).not.toContain("model-only");
		expect(summary).not.toContain("fable");
		expect(summary).not.toMatch(/included|available/);
		expect(account.details.find(detail => detail.label === "model usage")?.value).toContain(
			"model-only · Model weekly 40% left",
		);
		expect(
			account.details
				.filter(detail => detail.label === "model usage")
				.map(detail => detail.value)
				.join("\n"),
		).toContain("fable · 7d 60% left");
	});

	it("shows prepaid amounts with spending projections and count limits as remaining over limit", async () => {
		const now = 1_800_000_000_000;
		vi.spyOn(Date, "now").mockReturnValue(now);
		const reports: UsageReport[] = [
			{
				provider: "openai",
				fetchedAt: now,
				limits: [
					{
						id: "balance",
						label: "Balance",
						scope: { provider: "openai", shared: true },
						amount: { unit: "usd", remaining: 12.5, spendingRatePerDay: 2.5 },
						projectedExhaustAt: now + 432_000_000,
					},
					{
						id: "requests",
						label: "Requests",
						scope: { provider: "openai", shared: true },
						amount: { unit: "requests", limit: 100, used: 25 },
					},
				],
			},
		];
		const { deps } = await open({}, undefined, () => reports);
		const account = deps.load().find(account => account.provider === "openai")!;
		const billing = account.details.find(detail => detail.label === "billing")?.value;
		expect(billing).toContain("Balance $12.50 left · $2.50/day · runs out in 5d");
		expect(billing).toContain("Requests 75/100 requests left");
	});

	it("sets an OAuth account's saved-reset windows and auto-redeem, and refuses them for an API key", async () => {
		const { settings, deps, ids } = await open({ auth: { accountPolicies: [workPolicy] } });
		const auth = () => settings.getGlobalSettings().auth;
		const fields = () => deps.load().find(account => account.id === ids.anthropic)!.fields;
		const resetOn = fields().find(field => field.id === "reset-on")!;
		expect([resetOn.key, resetOn.value, resetOn.readOnly]).toEqual(["w", "any", undefined]);
		expect(resetOn.choices?.map(choice => [choice.id, choice.on])).toEqual([
			["reset-on:5h", false],
			["reset-on:7d", false],
			["reset-on:any", true],
		]);

		expect((await deps.apply(ids.anthropic!, "reset-on:7d", "on")).message).toBe("work resets on 7d.");
		expect((await deps.apply(ids.anthropic!, "reset-on:5h", "on")).message).toBe("work resets on 5h, 7d.");
		expect(auth()).toEqual({ accountPolicies: [{ ...workPolicy, resetOn: ["5h", "7d"] }] });
		expect((await deps.apply(ids.anthropic!, "reset-on:any", "off")).error).toContain("Choose 5h or 7d");
		expect((await deps.apply(ids.anthropic!, "reset-on:any", "on")).message).toBe("work resets on any window.");
		expect(auth()).toEqual({ accountPolicies: [workPolicy] });

		const autoRedeem = fields().find(field => field.id === "auto-redeem")!;
		expect([autoRedeem.key, autoRedeem.value]).toEqual(["a", "inherit"]);
		expect(autoRedeem.choices?.map(choice => choice.label)).toEqual(["yes", "no", "unset", "inherit"]);
		expect((await deps.apply(ids.anthropic!, "auto-redeem:yes", "on", "inherit")).message).toBe(
			"work auto-redeem: yes.",
		);
		expect(auth()).toEqual({ accountPolicies: [{ ...workPolicy, autoRedeem: "yes" }] });
		expect((await deps.apply(ids.anthropic!, "auto-redeem:no", "on", "inherit")).error).toContain("changed");
		expect((await deps.apply(ids.anthropic!, "auto-redeem:inherit", "on", "yes")).message).toBe(
			"work auto-redeem: inherit.",
		);
		expect(auth()).toEqual({ accountPolicies: [workPolicy] });

		const openai = deps.load().find(account => account.provider === "openai")!;
		for (const id of ["reset-on", "auto-redeem"]) {
			expect(openai.fields.find(field => field.id === id)?.readOnly).toBe("applies to OAuth accounts only");
		}
		expect((await deps.apply(ids.openai!, "auto-redeem:yes", "on", "inherit")).error).toContain(
			"OAuth accounts only",
		);
		expect((await deps.apply(ids.openai!, "reset-on:5h", "on")).error).toContain("OAuth accounts only");
		expect(auth()).toEqual({ accountPolicies: [workPolicy] });
	});

	it("lists global limits and adds, edits, and removes them in the account limit grammar", async () => {
		const monthly = { id: "all", metric: "usd", max: "20", window: { type: "calendar", period: "month" } };
		const daily = { metric: "requests", max: 100, window: { type: "calendar", period: "day" } };
		const { settings, deps } = await open({ limits: { "*": [monthly] } }, { limits: { openai: [daily] } });
		const limits = () => settings.getGlobalSettings().limits;
		const page = () => deps.pages!().find(candidate => candidate.id === "limits")!;
		expect(page().rows.map(row => [row.name, row.identity])).toEqual([
			["*", "every call"],
			["openai", "calls to this provider"],
			["(add scope)", "limits for a provider/model, a provider, or * (every call)"],
		]);
		expect(page().count).toBe(2);
		const [all, openai, add] = page().rows;
		expect(openai!.fields[0]!.readOnly).toBe('limits["openai"] is set in the runtime layer');
		expect((await deps.apply(openai!.id, "limit:add", "usd 1 day")).error).toContain("runtime layer");

		const edit = all!.fields[0]!.choices!.find(choice => choice.id === "limit:edit:0")!;
		expect([edit.label, edit.expect]).toEqual(["edit usd 20 month skip (id all)", "usd 20 month skip"]);
		expect((await deps.apply(all!.id, edit.id, "usd 30 week warn", edit.expect)).message).toBe("* has 1 limit.");
		expect(limits()).toEqual({
			"*": [{ id: "all", metric: "usd", max: "30", window: { type: "calendar", period: "week" }, onLimit: "warn" }],
		});

		const refused = await deps.apply(add!.id, "limit:add", "anthropic usage 80");
		expect(refused.error).toContain("only allowed on auth.accountPolicies limits");
		expect((await deps.apply(add!.id, "limit:add", "role:default usd 1 day")).error).toContain(
			"must be provider/model-id, provider, or *",
		);
		expect((await deps.apply(add!.id, "limit:add", "anthropic")).error).toContain(
			"Enter <provider/model|provider|*>",
		);
		expect((await deps.apply(add!.id, "limit:add", "anthropic/claude-opus-4-5 tokens 1000 1h")).message).toBe(
			"anthropic/claude-opus-4-5 has 1 limit.",
		);
		expect(limits()).toMatchObject({
			"anthropic/claude-opus-4-5": [
				{ metric: "tokens", max: 1000, window: { type: "rolling", durationMs: 3_600_000 } },
			],
		});
		const opus = page().rows.find(row => row.name === "anthropic/claude-opus-4-5")!;
		expect(opus.identity).toBe("calls to this model");
		expect(opus.details.find(detail => detail.label === "limit")?.value).toContain("1000 tokens per 1h");

		expect((await deps.apply(opus.id, "limit:remove:0", "", "tokens 1000 1h skip")).message).toBe(
			"anthropic/claude-opus-4-5 has 0 limits.",
		);
		expect(Object.keys(limits() as object)).toEqual(["*"]);
	});

	it("shortens the home prefix in project pin directory details", async () => {
		const project = path.join(os.homedir(), "projects", "pin-display");
		const { deps } = await open({
			auth: { accountPolicies: [workPolicy], accountPins: { [project]: { anthropic: "work" } } },
		});
		const pin = deps.pages!().find(page => page.id === "pins")!.rows[0]!;
		expect(pin.details.find(detail => detail.label === "directory")?.value).toBe("~/projects/pin-display");
		expect(JSON.stringify({ name: pin.name, details: pin.details })).not.toContain(os.homedir());
	});

	it("lists project pins of every directory and changes or removes one without touching the others", async () => {
		await authStorage.credentials.set("anthropic", [
			{ type: "oauth", access: "a", refresh: "r", expires: Date.now() + 3_600_000, email: "a@example.com" },
			{ type: "oauth", access: "b", refresh: "s", expires: Date.now() + 3_600_000, email: "b@example.com" },
		]);
		const homePolicy = { provider: "anthropic", name: "home", account: { email: "b@example.com" } };
		const project = fs.realpathSync(tempDir.path());
		const elsewhere = path.join(project, "elsewhere");
		const overlaid = path.join(project, "overlaid");
		fs.mkdirSync(elsewhere);
		fs.mkdirSync(overlaid);
		const { settings, deps } = await open(
			{
				auth: {
					accountPolicies: [workPolicy, homePolicy],
					accountPins: { [project]: { anthropic: "work" }, [elsewhere]: { anthropic: "work", openai: "spare" } },
				},
			},
			{ "auth.accountPins": { [overlaid]: { anthropic: "home" } } },
		);
		const pins = () => (settings.getGlobalSettings().auth as { accountPins?: unknown } | undefined)?.accountPins;
		const page = () => deps.pages!().find(candidate => candidate.id === "pins")!;
		const rows = page().rows;
		expect(rows.map(row => [row.provider, row.identity, row.badges])).toEqual([
			["anthropic", "work", ["this directory"]],
			["anthropic", "work", []],
			["openai", "spare", ["no stored account"]],
			["anthropic", "home", ["runtime"]],
		]);
		const [, elsewhereAnthropic, elsewhereOpenai, runtime] = rows;
		expect(runtime!.fields.every(field => field.readOnly === "set in the runtime layer")).toBe(true);
		expect((await deps.apply(runtime!.id, "pin:remove", "", "home")).error).toContain("runtime layer");

		const account = elsewhereAnthropic!.fields.find(field => field.id === "pin:account")!;
		expect(account.choices?.map(choice => [choice.label, choice.on])).toEqual([
			["home", false],
			["work", true],
		]);
		expect((await deps.apply(elsewhereAnthropic!.id, "pin:account:home", "on", "work")).message).toContain(
			'Pinned anthropic to "home"',
		);
		expect((await deps.apply(elsewhereAnthropic!.id, "pin:account:work", "on", "work")).error).toContain("changed");
		expect((await deps.apply(elsewhereOpenai!.id, "pin:remove", "", "spare")).message).toContain(
			"Removed the openai pin",
		);
		expect(pins()).toEqual({ [project]: { anthropic: "work" }, [elsewhere]: { anthropic: "home" } });
		expect((await deps.apply(elsewhereAnthropic!.id, "pin:account:nobody", "on", "home")).error).toContain(
			'No anthropic account is named "nobody"',
		);
		expect(pins()).toEqual({ [project]: { anthropic: "work" }, [elsewhere]: { anthropic: "home" } });
	});
});
