import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseLimitsSetting } from "@oh-my-pi/pi-coding-agent/config/local-limits";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { evaluateLimits, limitTargets } from "@oh-my-pi/pi-coding-agent/session/local-limits";
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
});
