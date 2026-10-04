import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Settings, type SettingsOptions } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { cfgCompactionEnabled } from "@oh-my-pi/pi-coding-agent/session/context-settings";
import {
	cfgModelToolCallLoopGuardExemptTools,
	cfgProvidersMaxInFlightRequests,
	cfgTemperature,
} from "@oh-my-pi/pi-coding-agent/session/settings";
import { cfgToolsApproval } from "@oh-my-pi/pi-coding-agent/tools/settings";
import { getProjectAgentDir, logger, TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

const IGNORED_NULL_WARNING = "Settings: ignoring project null value; lower layers apply";

describe("project-layer null values", () => {
	let state: SettingsTestState | undefined;
	let tempDir: TempDir;
	let agentDir: string;
	let project: string;

	beforeEach(() => {
		state = beginSettingsTest();
		tempDir = TempDir.createSync("@pi-settings-project-nulls-");
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

	const writeGlobal = (settings: Record<string, unknown>) =>
		fs.writeFileSync(path.join(agentDir, "config.yml"), YAML.stringify(settings));
	const writeProjectJson = (text: string) =>
		fs.writeFileSync(path.join(getProjectAgentDir(project), "settings.json"), text);
	const load = (options: SettingsOptions = {}) => Settings.loadIsolated({ cwd: project, agentDir, ...options });

	it("keeps lower-layer values under project nulls at any depth and warns once per path", async () => {
		writeGlobal({
			compaction: { enabled: false },
			tools: { approval: { bash: "deny" } },
			providers: { maxInFlightRequests: { openai: 2 } },
		});
		writeProjectJson(
			JSON.stringify({
				compaction: { enabled: null },
				tools: { approval: null },
				providers: { maxInFlightRequests: { openai: null, anthropic: 4 } },
				model: { toolCallLoopGuard: { exemptTools: ["read", null] } },
			}),
		);
		const warn = spyOn(logger, "warn");
		const settings = await load();

		expect(cfgCompactionEnabled.get(settings)).toBe(false);
		expect(settings.getProvenance(cfgCompactionEnabled)).toBe("global");
		expect(cfgToolsApproval.get(settings)).toEqual({ bash: "deny" });
		expect(cfgProvidersMaxInFlightRequests.get(settings)).toEqual({ openai: 2, anthropic: 4 });
		// Array items are not record keys: they stay as configured.
		expect(settings.getLayerValues(cfgModelToolCallLoopGuardExemptTools)).toEqual([
			{ source: "project", value: ["read", null] },
		]);
		const paths = warn.mock.calls
			.filter(([message]) => message === IGNORED_NULL_WARNING)
			.map(([, meta]) => (meta as { path: unknown }).path);
		expect(paths.toSorted()).toEqual([
			'"compaction.enabled"',
			'"providers.maxInFlightRequests.openai"',
			'"tools.approval"',
		]);
	});

	it("treats a key left without a value in the project config.yml as no opinion", async () => {
		writeGlobal({ temperature: 0.5, tools: { approval: { bash: "deny" } } });
		fs.writeFileSync(path.join(getProjectAgentDir(project), "config.yml"), "temperature:\ntools:\n");
		const settings = await load();

		expect(cfgTemperature.get(settings)).toBe(0.5);
		expect(cfgToolsApproval.get(settings)).toEqual({ bash: "deny" });
	});

	it("still clears lower layers through --config overlay and runtime nulls", async () => {
		writeGlobal({ temperature: 0.5, tools: { approval: { bash: "deny" } } });
		const overlayPath = tempDir.join("overlay.yml");
		fs.writeFileSync(overlayPath, "tools:\n  approval:\n");
		const settings = await load({ configFiles: [overlayPath], overrides: { temperature: null } });

		expect(cfgToolsApproval.get(settings)).toEqual({});
		expect(cfgTemperature.get(settings)).toBe(-1);
	});

	it("never changes a merged prototype through a project __proto__ key", async () => {
		writeGlobal({ temperature: 0.5, tools: { approval: { read: "allow" } } });
		writeProjectJson('{"__proto__":{"temperature":0.9},"tools":{"approval":{"__proto__":{"bash":"deny"}}}}');
		const settings = await load();
		const approval: Record<string, unknown> = cfgToolsApproval.get(settings);

		expect(cfgTemperature.get(settings)).toBe(0.5);
		expect(Object.getPrototypeOf(approval)).toBe(Object.prototype);
		expect(Object.hasOwn(approval, "__proto__")).toBe(true);
		expect(approval.read).toBe("allow");
		expect(approval.bash).toBeUndefined();
	});

	it("keeps a __proto__ key of a project config.yml an own entry", async () => {
		writeGlobal({ temperature: 0.5, tools: { approval: { read: "allow" } } });
		fs.writeFileSync(
			path.join(getProjectAgentDir(project), "config.yml"),
			"__proto__:\n  temperature: 0.9\ntools:\n  approval:\n    __proto__:\n      bash: deny\n",
		);
		const settings = await load();
		const approval: Record<string, unknown> = cfgToolsApproval.get(settings);

		expect(cfgTemperature.get(settings)).toBe(0.5);
		expect(Object.getPrototypeOf(approval)).toBe(Object.prototype);
		expect(Object.hasOwn(approval, "__proto__")).toBe(true);
		expect(approval.bash).toBeUndefined();
	});

	it("rejects constructor override keys with a __proto__, constructor, or prototype segment", () => {
		for (const key of ["__proto__.polluted", "tools.constructor.x", "prototype"]) {
			expect(() => Settings.isolated({ [key]: 1 })).toThrow("are not allowed as path segments");
		}
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
	});

	it("reads and writes only own entries along a settings path", () => {
		const settings = Settings.isolated();
		cfgToolsApproval.setEntry(settings, "__proto__", "deny");

		expect(cfgToolsApproval.get(settings)).toEqual(JSON.parse('{"__proto__":"deny"}'));
		expect(Object.getPrototypeOf(cfgToolsApproval.get(settings))).toBe(Object.prototype);
		expect(({} as Record<string, unknown>).deny).toBeUndefined();
	});
});
