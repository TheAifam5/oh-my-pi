import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseLimitsSetting } from "@oh-my-pi/pi-coding-agent/config/local-limits";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import {
	configuredLimitStatuses,
	createAccountLimitSource,
	evaluateLimits,
	formatLimitStatus,
	limitTargets,
	poolLimitsSummary,
} from "@oh-my-pi/pi-coding-agent/session/local-limits";
import { cfgAuthAccountPolicies } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import type { LocalLimit } from "@oh-my-pi/pi-ai/usage/limits";
import type { AuthAccountPolicies } from "@oh-my-pi/pi-ai/auth-storage";
import { AccountPolicies } from "@oh-my-pi/pi-ai/auth/policy";
import { getProjectAgentDir, logger, TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

const DAY = { type: "calendar", period: "day" };

describe("local limits setting", () => {
	let state: SettingsTestState | undefined;
	let tempDir: TempDir;
	let agentDir: string;
	let project: string;

	beforeEach(() => {
		state = beginSettingsTest();
		tempDir = TempDir.createSync("@pi-local-limits-");
		agentDir = tempDir.join("agent");
		project = tempDir.join("project");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(getProjectAgentDir(project), { recursive: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		restoreSettingsTestState(state);
		state = undefined;
		AgentStorage.close();
		tempDir.removeSync();
	});

	it("ignores limits in project settings and applies the same limits from user config", async () => {
		const limits = { openai: [{ metric: "requests", max: 5, window: DAY }] };
		const projectSettings = path.join(getProjectAgentDir(project), "settings.json");
		fs.writeFileSync(projectSettings, JSON.stringify({ limits }));
		const fromProject = await Settings.loadIsolated({ cwd: project, agentDir });
		expect(limitTargets(fromProject, "openai", "gpt-4o-mini")).toEqual([]);

		fs.rmSync(projectSettings);
		fs.writeFileSync(path.join(agentDir, "config.yml"), YAML.stringify({ limits }));
		const fromUser = await Settings.loadIsolated({ cwd: project, agentDir });
		expect(limitTargets(fromUser, "openai", "gpt-4o-mini").map(target => target.label)).toEqual([
			"openai: 5 requests per day",
		]);
	});

	it("counts limits sharing an id against every scope that declares it", async () => {
		const storage = await AgentStorage.open(path.join(tempDir.path(), "agent.db"));
		const shared = { id: "frontier", metric: "requests", max: 2, window: DAY };
		const settings = Settings.isolated(
			{ limits: { "openai/gpt-4o": [shared], "anthropic/claude-opus-4-5": [shared] } },
			{ storage },
		);
		const now = Date.now();
		storage.usageLedger.record({
			atMs: now,
			provider: "openai",
			model: "gpt-4o",
			costNanos: 0,
			inputTokens: 1,
			outputTokens: 1,
		});
		const targets = limitTargets(settings, "anthropic", "claude-opus-4-5");
		expect(evaluateLimits(storage.usageLedger, targets, now).refused).toEqual([]);

		storage.usageLedger.record({
			atMs: now,
			provider: "anthropic",
			model: "claude-opus-4-5",
			costNanos: 0,
			inputTokens: 1,
			outputTokens: 1,
		});
		expect(evaluateLimits(storage.usageLedger, targets, now).refused.map(entry => entry.reason)).toEqual(["reached"]);
		expect(evaluateLimits(undefined, targets, now).refused.map(entry => entry.reason)).toEqual(["unreadable"]);
	});

	it("rejects a malformed key", () => {
		expect(() => parseLimitsSetting({ "/gpt": [{ metric: "requests", max: 1, window: DAY }] })).toThrow(
			'limits key "/gpt" must be provider/model-id, provider, or *',
		);
	});

	it("drops a key from a later layer whose shared id differs, with one warning", async () => {
		fs.writeFileSync(
			path.join(agentDir, "config.yml"),
			YAML.stringify({ limits: { openai: [{ id: "cap", metric: "requests", max: 1, window: DAY }] } }),
		);
		const settings = await Settings.loadIsolated({
			cwd: project,
			agentDir,
			overrides: { limits: { anthropic: [{ id: "cap", metric: "requests", max: 2, window: DAY }] } },
		});
		const warn = vi.spyOn(logger, "warn");

		expect(limitTargets(settings, "openai", "gpt-4o").map(target => target.label)).toEqual(["cap"]);
		expect(limitTargets(settings, "anthropic", "claude-opus-4-5")).toEqual([]);
		expect(
			warn.mock.calls.filter(([message]) => String(message).startsWith("Ignoring a limit whose shared id")),
		).toHaveLength(1);
	});

	it("counts a shared id once across a top-level key and a pool", async () => {
		const storage = await AgentStorage.open(path.join(tempDir.path(), "agent.db"));
		const shared = { id: "frontier", metric: "requests", max: 2, window: DAY };
		const settings = Settings.isolated(
			{
				limits: { "openai/gpt-4o": [shared] },
				modelRoles: {
					engineer: {
						strategy: "random",
						routing: { limits: [shared] },
						models: { opus: { model: "anthropic/claude-opus-4-5" } },
					},
				},
			},
			{ storage },
		);
		const now = Date.now();
		const targets = limitTargets(settings, "anthropic", "claude-opus-4-5", "role:engineer");
		expect(targets.map(target => target.label)).toEqual(["frontier"]);
		storage.usageLedger.record({
			atMs: now,
			provider: "openai",
			model: "gpt-4o",
			costNanos: 0,
			inputTokens: 1,
			outputTokens: 1,
		});
		storage.usageLedger.record({
			atMs: now,
			provider: "anthropic",
			model: "claude-opus-4-5",
			pool: "role:engineer",
			costNanos: 0,
			inputTokens: 1,
			outputTokens: 1,
		});
		expect(evaluateLimits(storage.usageLedger, targets, now).refused.map(entry => entry.reason)).toEqual(["reached"]);
		expect(limitTargets(settings, "anthropic", "claude-opus-4-5")).toEqual([]);
	});

	it("lets project settings only add to a global pool's limits", async () => {
		const requests = (max: number) => ({ metric: "requests", max, window: DAY });
		const pool = (limits?: unknown[]) => ({
			strategy: "random",
			...(limits ? { routing: { limits } } : {}),
			models: { opus: { model: "anthropic/claude-opus-4-5" } },
		});
		fs.writeFileSync(
			path.join(agentDir, "config.yml"),
			YAML.stringify({
				modelRoles: { engineer: pool([requests(5)]), reviewer: pool([requests(3)]) },
				modelGroups: { other: pool() },
			}),
		);
		fs.writeFileSync(
			path.join(getProjectAgentDir(project), "settings.json"),
			JSON.stringify({
				modelRoles: {
					engineer: pool([requests(10), { ...requests(1), id: "mine" }]),
					reviewer: "+other",
				},
			}),
		);
		const settings = await Settings.loadIsolated({ cwd: project, agentDir });

		expect(
			limitTargets(settings, "anthropic", "claude-opus-4-5", "role:engineer").map(target => target.label),
		).toEqual(["role:engineer: 5 requests per day", "role:engineer: 10 requests per day"]);
		expect(
			limitTargets(settings, "anthropic", "claude-opus-4-5", "role:reviewer").map(target => target.label),
		).toEqual(["role:reviewer: 3 requests per day"]);
	});

	it("ignores a project selector or list that would replace a limited pool, also under an overlay parent", async () => {
		const limited = {
			strategy: "random",
			routing: { limits: [{ metric: "requests", max: 5, window: DAY }] },
			models: { opus: { model: "anthropic/claude-opus-4-5" } },
		};
		fs.writeFileSync(
			path.join(agentDir, "config.yml"),
			YAML.stringify({ modelRoles: { engineer: limited }, retry: { fallbackChains: { default: limited } } }),
		);
		fs.writeFileSync(
			path.join(getProjectAgentDir(project), "settings.json"),
			JSON.stringify({
				modelRoles: { engineer: "openai/gpt-4o-mini" },
				retry: { fallbackChains: { default: ["openai/gpt-4o-mini"] } },
			}),
		);
		const warn = vi.spyOn(logger, "warn");
		const settings = await Settings.loadIsolated({ cwd: project, agentDir });
		const labels = (target: Settings, pool: string) =>
			limitTargets(target, "anthropic", "claude-opus-4-5", pool).map(entry => entry.label);

		expect(labels(settings, "role:engineer")).toEqual(["role:engineer: 5 requests per day"]);
		expect(labels(settings, "chain:default")).toEqual(["chain:default: 5 requests per day"]);
		expect(warn.mock.calls.filter(([message]) => String(message).includes("would replace a pool"))).toHaveLength(2);

		fs.rmSync(path.join(getProjectAgentDir(project), "settings.json"));
		const parent = await Settings.loadIsolated({ cwd: project, agentDir });
		const child = parent.overlay();
		child.setProjectModelRole("engineer", "openai/gpt-4o-mini");
		expect(labels(child, "role:engineer")).toEqual(["role:engineer: 5 requests per day"]);
	});

	it("counts an account limit against that account's calls to the provider and logs a warn limit once", async () => {
		const storage = await AgentStorage.open(path.join(tempDir.path(), "agent.db"));
		const source = createAccountLimitSource(() => storage.usageLedger);
		const now = Date.now();
		const call = (provider: string, account: string) =>
			storage.usageLedger.record({
				atMs: now,
				provider,
				model: "m",
				account,
				costNanos: 0,
				inputTokens: 1,
				outputTokens: 1,
			});
		const skip: LocalLimit[] = [
			{ metric: "requests", max: 1, window: { type: "calendar", period: "day" }, onLimit: "skip" },
		];
		call("openai", "home");
		call("anthropic", "work");
		expect(source.refuses("openai", "work", skip, now)).toBeUndefined();

		call("openai", "work");
		expect(source.refuses("openai", "work", skip, now)).toBe("reached");
		expect(createAccountLimitSource(() => undefined).refuses("openai", "work", skip, now)).toBe("unreadable");
		const busy = vi.spyOn(storage.usageLedger, "totals").mockImplementationOnce(() => {
			throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
		});
		expect(source.refuses("openai", "work", skip, now)).toBe("reached");
		expect(busy).toHaveBeenCalledTimes(2);

		const warn = vi.spyOn(logger, "warn");
		const warnOnly: LocalLimit[] = [{ ...skip[0]!, onLimit: "warn" }];
		expect(source.refuses("openai", "work", warnOnly, now)).toBeUndefined();
		expect(source.refuses("openai", "work", warnOnly, now)).toBeUndefined();
		expect(warn.mock.calls.filter(([message]) => message === "Local account limit reached")).toHaveLength(1);
	});

	it("keeps global account limits when project account policies replace the global ones", async () => {
		const limits = [{ metric: "requests", max: 1, window: DAY }];
		fs.writeFileSync(
			path.join(agentDir, "config.yml"),
			YAML.stringify({
				auth: {
					accountPolicies: [
						{ provider: "openai", name: "work", account: { email: "w@example.com" }, limits },
						{ provider: "openai", account: { email: "h@example.com" }, limits },
					],
				},
			}),
		);
		const projectSettings = path.join(getProjectAgentDir(project), "settings.json");
		const policies = async (projectPolicies: unknown[]) => {
			fs.writeFileSync(projectSettings, JSON.stringify({ auth: { accountPolicies: projectPolicies } }));
			// Raw policies as configured; AccountPolicies fills in `onLimit` when it loads them.
			const merged: unknown = cfgAuthAccountPolicies.get(await Settings.loadIsolated({ cwd: project, agentDir }));
			return merged;
		};
		const warn = vi.spyOn(logger, "warn");

		expect(await policies([])).toEqual([
			{ provider: "openai", account: { email: "w@example.com" }, limits },
			{ provider: "openai", account: { email: "h@example.com" }, limits },
		]);
		expect(
			await policies([{ provider: "openai", name: "work", account: { email: "w@example.com" }, priority: 5 }]),
		).toEqual([
			{ provider: "openai", name: "work", account: { email: "w@example.com" }, priority: 5, limits },
			{ provider: "openai", account: { email: "h@example.com" }, limits },
		]);
		expect(warn.mock.calls.some(([message]) => String(message).includes("their account limits are kept"))).toBe(true);
	});

	it("matches project account policies to global ones by selector only and keeps the merged list valid", async () => {
		const limits = [{ metric: "requests", max: 1, window: DAY }];
		fs.writeFileSync(
			path.join(agentDir, "config.yml"),
			YAML.stringify({
				auth: {
					accountPolicies: [
						{ provider: "openai", name: "work", account: { email: "w@example.com" }, drain: true, limits },
					],
				},
			}),
		);
		const projectSettings = path.join(getProjectAgentDir(project), "settings.json");
		const policies = async (projectPolicies: unknown[]) => {
			fs.writeFileSync(projectSettings, JSON.stringify({ auth: { accountPolicies: projectPolicies } }));
			const merged: unknown = cfgAuthAccountPolicies.get(await Settings.loadIsolated({ cwd: project, agentDir }));
			expect(() => new AccountPolicies(merged as AuthAccountPolicies, undefined)).not.toThrow();
			return merged;
		};
		const appended = { provider: "openai", account: { email: "w@example.com" }, limits };

		// Same name, other selector: no limits inherited, and the name or drain cannot collide.
		expect(
			await policies([{ provider: "openai", name: "work", account: { accountId: "acc-w" }, drain: true }]),
		).toEqual([{ provider: "openai", name: "work", account: { accountId: "acc-w" }, drain: true }, appended]);
		// The same account under other identity fields stays a separate entry.
		expect(await policies([{ provider: "openai", account: { accountId: "acc-w" }, priority: 2 }])).toEqual([
			{ provider: "openai", account: { accountId: "acc-w" }, priority: 2 },
			appended,
		]);
	});

	it("strips limits from project account policies and keeps the rest of each entry", async () => {
		const limits = [{ metric: "requests", max: 1, window: DAY }];
		fs.writeFileSync(
			path.join(getProjectAgentDir(project), "settings.json"),
			JSON.stringify({
				auth: {
					accountPolicies: [{ provider: "openai", name: "work", account: { email: "w@example.com" }, limits }],
				},
			}),
		);
		const warn = vi.spyOn(logger, "warn");
		const settings = await Settings.loadIsolated({ cwd: project, agentDir });

		expect(cfgAuthAccountPolicies.get(settings)).toEqual([
			{ provider: "openai", name: "work", account: { email: "w@example.com" } },
		]);
		expect(warn.mock.calls.some(([message]) => String(message).includes("accountPolicies[0].limits"))).toBe(true);
	});

	it("reports configured limits with counted usage, reset, and the pool limit closest to its cap", async () => {
		const storage = await AgentStorage.open(path.join(tempDir.path(), "agent.db"));
		const now = new Date(2026, 9, 7, 15, 0).getTime();
		const settings = Settings.isolated(
			{
				limits: { "*": [{ metric: "usd", max: "5.00", window: DAY }] },
				modelRoles: {
					engineer: {
						strategy: "random",
						routing: {
							limits: [
								{ metric: "requests", max: 4, window: { type: "rolling", durationMs: 3_600_000 } },
								{ metric: "tokens", max: 100, window: DAY, onLimit: "warn" },
							],
						},
						models: { opus: { model: "anthropic/claude-opus-4-5" } },
					},
				},
			},
			{ storage },
		);
		storage.usageLedger.record({
			atMs: now - 60_000,
			provider: "anthropic",
			model: "claude-opus-4-5",
			pool: "role:engineer",
			costNanos: 1_250_000_000,
			inputTokens: 10,
			outputTokens: 5,
		});

		expect(
			configuredLimitStatuses(settings, storage.usageLedger, now).map(status => formatLimitStatus(status, now)),
		).toEqual([
			"*: 1.25 / 5.00 USD per day · resets in 9h",
			"role:engineer: 1 / 4 requests per 1h · rolling",
			"role:engineer: 15 / 100 tokens per day · resets in 9h · warn only",
		]);
		expect(poolLimitsSummary(settings, "role:engineer", storage.usageLedger, now)).toBe(
			"2 limits, closest 1 / 4 requests per 1h · rolling",
		);
		expect(poolLimitsSummary(settings, "role:engineer", undefined, now)).toBe(
			"2 limits, closest ? / 4 requests per 1h · rolling",
		);
	});

	it("prints USD usage exactly at its boundaries and lists a shared id once across a key and a pool", async () => {
		const storage = await AgentStorage.open(path.join(tempDir.path(), "agent.db"));
		const now = Date.now();
		const shared = { id: "frontier", metric: "usd", max: "9.00", window: DAY };
		const settings = Settings.isolated(
			{
				limits: { "openai/gpt-4o": [shared] },
				modelRoles: {
					engineer: {
						strategy: "random",
						routing: { limits: [shared] },
						models: { opus: { model: "anthropic/claude-opus-4-5" } },
					},
				},
			},
			{ storage },
		);
		const used = () =>
			configuredLimitStatuses(settings, storage.usageLedger, now).map(status => [status.name, status.used]);
		const spend = (costNanos: number) =>
			storage.usageLedger.record({
				atMs: now,
				provider: "openai",
				model: "gpt-4o",
				costNanos,
				inputTokens: 1,
				outputTokens: 0,
			});

		expect(used()).toEqual([["frontier", "0.00"]]);
		spend(1);
		expect(used()).toEqual([["frontier", "0.000000001"]]);
		spend(999_999_999);
		expect(used()).toEqual([["frontier", "1.00"]]);
		spend(1_234_000_000);
		expect(used()).toEqual([["frontier", "2.234"]]);
	});
});
