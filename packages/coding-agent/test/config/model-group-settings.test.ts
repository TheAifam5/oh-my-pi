import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ModelGroupConfigError, ReservedModelRoleError } from "@oh-my-pi/pi-coding-agent/config/model-groups";
import { cfgModelGroups, cfgModelRoles } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import {
	getRetryFallbackChains,
	getRetryFallbackRole,
	installRetryFallbackRole,
} from "@oh-my-pi/pi-coding-agent/session/retry-fallback-chains";
import { cfgRetryFallbackChains } from "@oh-my-pi/pi-coding-agent/session/settings";
import { getProjectAgentDir, logger, removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";

const OPUS = "anthropic/claude-opus-5-5";
const SONNET = "anthropic/claude-sonnet-5-5";
const ASTRA = "openai-codex/gpt-6-astra";

let testDir: string;
let agentDir: string;
let projectDir: string;
let overlayPath: string;

beforeEach(() => {
	resetSettingsForTest();
	testDir = path.join(os.tmpdir(), "test-model-group-settings", Snowflake.next());
	agentDir = path.join(testDir, "agent");
	projectDir = path.join(testDir, "project");
	overlayPath = path.join(testDir, "overlay.yml");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.mkdirSync(getProjectAgentDir(projectDir), { recursive: true });
});

afterEach(() => {
	vi.restoreAllMocks();
	resetSettingsForTest();
	AgentStorage.close();
	if (fs.existsSync(testDir)) removeSyncWithRetries(testDir);
});

function writeGlobal(config: unknown): void {
	fs.writeFileSync(path.join(agentDir, "config.yml"), YAML.stringify(config));
}

function writeProject(config: unknown): void {
	fs.writeFileSync(path.join(getProjectAgentDir(projectDir), "config.yml"), YAML.stringify(config));
}

function writeOverlay(config: unknown): void {
	fs.writeFileSync(overlayPath, YAML.stringify(config));
}

function load(options: { overlay?: boolean } = {}): Promise<Settings> {
	return Settings.loadIsolated({ cwd: projectDir, agentDir, configFiles: options.overlay ? [overlayPath] : [] });
}

async function readGlobalFile(): Promise<Record<string, unknown>> {
	return YAML.parse(await Bun.file(path.join(agentDir, "config.yml")).text()) as Record<string, unknown>;
}

function pool(models: Record<string, string>, extra: Record<string, unknown> = {}): Record<string, unknown> {
	const entries: Record<string, unknown> = {};
	for (const [alias, model] of Object.entries(models)) entries[alias] = { model };
	return { strategy: "random", models: entries, ...extra };
}

function warnedPaths(warn: { mock: { calls: unknown[][] } }): string[] {
	return warn.mock.calls
		.map(call => (call[1] as { setting?: string } | undefined)?.setting)
		.filter((setting): setting is string => setting !== undefined);
}

function warnedFor(warn: { mock: { calls: unknown[][] } }, setting: string): { setting?: string; layer?: string }[] {
	return warn.mock.calls
		.map(call => call[1] as { setting?: string; layer?: string } | undefined)
		.filter((fields): fields is { setting?: string; layer?: string } => fields?.setting === setting);
}

describe("model group layering", () => {
	it("replaces a pool entry whole instead of merging members across layers", async () => {
		writeGlobal({
			modelRoles: { engineer: pool({ a: OPUS, b: SONNET }) },
			retry: { fallbackChains: { default: pool({ a: OPUS, b: SONNET }) } },
			modelGroups: { fast: pool({ a: OPUS, b: SONNET }) },
		});
		writeProject({
			modelRoles: { engineer: pool({ c: ASTRA }) },
			retry: { fallbackChains: { default: pool({ c: ASTRA }) } },
		});
		writeOverlay({ modelGroups: { fast: pool({ c: ASTRA }) } });
		const settings = await load({ overlay: true });

		expect(cfgModelRoles.get(settings).engineer).toEqual(pool({ c: ASTRA }) as never);
		expect(cfgRetryFallbackChains.get(settings).default).toEqual(pool({ c: ASTRA }) as never);
		expect(cfgModelGroups.get(settings).fast).toEqual(pool({ c: ASTRA }));
		expect(settings.getModelGroup("fast")?.models.map(member => member.alias)).toEqual(["c"]);
		expect(settings.getModelRole("engineer")).toBe(ASTRA);
	});

	it("lets a project null fall back to the global entry", async () => {
		writeGlobal({
			retry: { fallbackChains: { default: pool({ a: OPUS }) } },
			modelGroups: { fast: pool({ a: OPUS }) },
		});
		writeProject({ retry: { fallbackChains: { default: null } }, modelGroups: { fast: null } });
		const settings = await load();

		expect(cfgRetryFallbackChains.get(settings).default).toEqual(pool({ a: OPUS }) as never);
		expect(cfgModelGroups.get(settings).fast).toEqual(pool({ a: OPUS }));
	});

	it("lets a --config null hide the global entry", async () => {
		writeGlobal({ modelGroups: { fast: pool({ a: OPUS }) } });
		writeOverlay({ modelGroups: { fast: null } });
		const settings = await load({ overlay: true });

		expect(settings.getModelGroup("fast")).toBeUndefined();
	});

	it("drops an invalid pool with one warning and shows the lower layer", async () => {
		const warn = vi.spyOn(logger, "warn");
		writeGlobal({ modelRoles: { engineer: pool({ a: OPUS }) } });
		writeProject({ modelRoles: { engineer: { strategy: "fastest", models: { b: { model: SONNET } } } } });
		const settings = await load();

		expect(settings.getModelRole("engineer")).toBe(OPUS);
		expect(settings.getModelRoleProvenance("engineer")).toBe("global");
		settings.setModelRole("smol", SONNET);
		settings.setModelRole("smol", OPUS);
		expect(warnedPaths(warn).filter(setting => setting === "modelRoles.engineer")).toHaveLength(1);
		settings.cancelPendingSaves();
	});

	it("lets a project reference a group defined globally", async () => {
		writeGlobal({
			modelGroups: {
				shared: {
					strategy: "priority",
					strategyOptions: { order: ["second", "first"] },
					models: { first: { model: OPUS }, second: { model: SONNET, defaultEffort: "high" } },
					profiles: { deep: { first: { effort: "xhigh" } } },
				},
			},
		});
		writeProject({ modelRoles: { engineer: { use: "shared" }, smol: "+shared@deep" } });
		const settings = await load();

		expect(settings.getModelRoleSpec("engineer")).toEqual({ kind: "ref", ref: { use: "shared" }, shorthand: false });
		expect(settings.getModelRole("engineer")).toBe(`${SONNET}:high,${OPUS}`);
		expect(settings.getModelRole("smol")).toBe(`${SONNET}:high,${OPUS}:xhigh`);
		expect(settings.getModelRoles().engineer).toBe(`${SONNET}:high,${OPUS}`);
	});
});

describe("model group writes", () => {
	it("persists a pool role with its models and order while untouched roles stay verbatim", async () => {
		writeGlobal({ modelRoles: { smol: [OPUS, SONNET], slow: OPUS } });
		const settings = await load();
		const engineer = {
			strategy: "priority",
			strategyOptions: { order: ["b", "a"] },
			models: { a: { model: OPUS }, b: { model: SONNET, defaultEffort: "low" } },
		};

		settings.setModelRoleSpec("engineer", engineer);
		settings.setModelRole("slow", SONNET);
		await settings.flush();

		expect((await readGlobalFile()).modelRoles).toEqual({ smol: [OPUS, SONNET], slow: SONNET, engineer });
		const reloaded = await load();
		expect(reloaded.getModelRoleSpec("engineer")?.kind).toBe("group");
		expect(reloaded.getModelRole("engineer")).toBe(`${SONNET}:low,${OPUS}`);
	});

	it("refuses an invalid pool with a typed error and writes nothing", () => {
		const settings = Settings.isolated();
		let error: unknown;
		try {
			settings.setModelRoleSpec("engineer", { strategy: "random", models: {} });
		} catch (caught) {
			error = caught;
		}

		expect(error).toBeInstanceOf(ModelGroupConfigError);
		expect((error as ModelGroupConfigError).issues.map(issue => issue.path)).toContain("modelRoles.engineer.models");
		expect(settings.getModelRoleSpec("engineer")).toBeUndefined();
		expect(() => settings.setModelGroup("Bad Name", pool({ a: OPUS }))).toThrow(ModelGroupConfigError);
		expect(() => settings.setFallbackChainSpec("default", { use: "+nope" })).toThrow(ModelGroupConfigError);
		expect(() => settings.setModelRoleSpec("web", pool({ a: OPUS }))).toThrow(ModelGroupConfigError);
	});
});

describe("project layer hardening", () => {
	it("ignores project records that are not mappings", async () => {
		const warn = vi.spyOn(logger, "warn");
		writeGlobal({
			modelRoles: { engineer: "+shared" },
			retry: { fallbackChains: { default: [SONNET] } },
			modelGroups: { shared: pool({ a: OPUS }) },
		});
		// Empty YAML keys (`modelGroups:`) parse as null and are ignored without a warning.
		fs.writeFileSync(
			path.join(getProjectAgentDir(projectDir), "config.yml"),
			`modelGroups:\nretry:\n  fallbackChains:\nmodelRoles:\n  - ${OPUS}\n`,
		);
		const settings = await load();

		expect(cfgModelGroups.get(settings).shared).toEqual(pool({ a: OPUS }));
		expect(cfgRetryFallbackChains.get(settings).default).toEqual([SONNET]);
		expect(settings.getModelRole("engineer")).toBe(OPUS);
		expect(warnedPaths(warn)).toContain("modelRoles");
		expect(warnedPaths(warn)).not.toContain("modelGroups");
		expect(warnedPaths(warn)).not.toContain("retry.fallbackChains");
	});

	it("leaves a null field inside a project group to group validation", async () => {
		const warn = vi.spyOn(logger, "warn");
		writeGlobal({ modelGroups: { shared: pool({ a: OPUS }) } });
		writeProject({
			modelGroups: { mine: { strategy: "random", models: { b: { model: SONNET, defaultEffort: null } } } },
		});
		const settings = await load();

		// The generic project-null strip does not reach inside group entries, so the entry fails
		// validation as written (not stripped into a valid group) and the null is not reported generically.
		expect(Object.keys(cfgModelGroups.get(settings))).toEqual(["shared"]);
		const invalid = warn.mock.calls.filter(([message]) => message === "Settings: ignoring invalid model group value");
		expect(
			invalid.map(([, meta]) => (meta as { issues: { path: string }[] }).issues.map(issue => issue.path)),
		).toEqual([["modelGroups.mine.models.b.defaultEffort"]]);
		expect(
			warn.mock.calls.some(([message]) => String(message).startsWith("Settings: ignoring project null value")),
		).toBe(false);
	});
});

describe("model-group fallback chains in selector-only consumers", () => {
	it("treats a pool at a role key as unset so the role inherits the default chain, logging the key once", () => {
		const warn = vi.spyOn(logger, "warn");
		const settings = Settings.isolated({
			modelRoles: { smol: OPUS },
			"retry.fallbackChains": { default: [SONNET], smol: pool({ a: ASTRA }) },
		});

		expect(getRetryFallbackChains(settings).smol).toEqual([SONNET]);
		expect(getRetryFallbackRole(settings, "smol")).toBeUndefined();
		getRetryFallbackChains(settings);
		expect(warnedFor(warn, "retry.fallbackChains.smol")).toHaveLength(1);
	});
});

describe("reserved model role names", () => {
	const RESERVED = ["__proto__", "constructor", "prototype"];
	const reservedRolesYaml = `modelRoles:\n  __proto__: ${OPUS}\n  constructor: ${OPUS}\n  prototype: ${OPUS}\n  smol: ${SONNET}\n`;

	it("refuses every role write naming a reserved role with a typed error and writes nothing", async () => {
		writeGlobal({ modelRoles: { smol: SONNET } });
		const settings = await load();

		for (const role of RESERVED) {
			const writes: (() => void)[] = [
				() => settings.setModelRole(role, OPUS),
				() => settings.setModelRole(role, undefined),
				() => settings.setModelRoleSpec(role, pool({ a: OPUS })),
				() => settings.setProjectModelRole(role, OPUS),
				() => settings.clearProjectModelRole(role),
				() => settings.overrideModelRoles({ [role]: OPUS }),
				() => cfgModelRoles.setEntry(settings, role, OPUS),
				() => cfgModelRoles.set(settings, { smol: SONNET, [role]: OPUS }),
				() => cfgModelRoles.override(settings, { [role]: OPUS }),
				() => installRetryFallbackRole(settings, role, { primary: OPUS, chain: [SONNET] }),
				() => Settings.isolated({ modelRoles: { [role]: OPUS } }),
			];
			for (const write of writes) {
				let error: unknown;
				try {
					write();
				} catch (caught) {
					error = caught;
				}
				expect(error).toBeInstanceOf(ReservedModelRoleError);
				expect(error).toBeInstanceOf(ModelGroupConfigError);
				expect((error as ReservedModelRoleError).role).toBe(role);
				expect((error as ReservedModelRoleError).issues).toEqual([
					{ path: `modelRoles.${role}`, message: "is a reserved key (__proto__, constructor, prototype)" },
				]);
			}
		}
		await settings.flush();

		expect(settings.getModelRoles()).toEqual({ smol: SONNET });
		expect((await readGlobalFile()).modelRoles).toEqual({ smol: SONNET });
		expect(fs.existsSync(path.join(getProjectAgentDir(projectDir), "config.yml"))).toBe(false);
	});

	it("loads the other global roles and warns once per reserved role", async () => {
		const warn = vi.spyOn(logger, "warn");
		fs.writeFileSync(path.join(agentDir, "config.yml"), reservedRolesYaml);
		const settings = await load();
		const roles = cfgModelRoles.get(settings);

		expect(Object.getPrototypeOf(roles)).toBe(Object.prototype);
		expect(Object.keys(roles)).toEqual(["smol"]);
		expect(settings.getModelRoles()).toEqual({ smol: SONNET });
		expect(settings.getLayerValues(cfgModelRoles)).toEqual([{ source: "global", value: { smol: SONNET } }]);
		for (const role of RESERVED) {
			expect(settings.getModelRole(role)).toBeUndefined();
			expect(settings.getGlobalModelRole(role)).toBeUndefined();
			expect(settings.getModelRoleProvenance(role)).toBe("default");
		}

		settings.setModelRole("default", OPUS);
		await settings.flush();

		expect(settings.getModelRoles()).toEqual({ default: OPUS, smol: SONNET });
		expect(Object.keys((await readGlobalFile()).modelRoles as Record<string, unknown>)).toEqual([
			"__proto__",
			"constructor",
			"prototype",
			"smol",
			"default",
		]);

		for (const role of RESERVED) {
			expect(warnedFor(warn, `modelRoles.${role}`).map(fields => fields.layer)).toEqual(["global"]);
		}
	});
});
