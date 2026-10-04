// oxlint-disable no-template-curly-in-string -- literal `${VAR}` is MCP config syntax under test
/**
 * `package` launch specs on stdio MCP servers: the project's installed npm package is
 * preferred, otherwise the runner fetches `name@version`, as the policy allows. The spec
 * must survive discovery into the transport config and resolve to a concrete command at
 * the manager's pre-connect step, which every connect path (including `/mcp test`) uses.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { validateJsonSchemaValue } from "@oh-my-pi/pi-ai/utils/schema/json-schema-validator";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { loadAllMCPConfigs, validateServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/config";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import {
	DEFAULT_MCP_PACKAGE_LAUNCH,
	DEFAULT_MCP_PACKAGE_RUNTIME,
	MCPPackageLaunchError,
	resolvePackageLaunch,
} from "@oh-my-pi/pi-coding-agent/mcp/package-launch";
import { cfgMcpPackageRunner, mcpPackageLaunchDefaults } from "@oh-my-pi/pi-coding-agent/mcp/settings";
import type { MCPPackageLaunch, MCPStdioServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { getAgentDir, logger, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import mcpSchema from "../../src/config/mcp-schema.json" with { type: "json" };

const PACKAGE = "@scope/lint-mcp";

let projectDir = "";
let homeDir = "";
let agentDir = "";
let originalAgentDir = "";

beforeEach(async () => {
	originalAgentDir = getAgentDir();
	projectDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-pkg-project-")));
	homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-pkg-home-"));
	agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-pkg-agent-"));
	await fs.mkdir(path.join(projectDir, ".git"));
	setAgentDir(agentDir);
	clearFsCache();
});

afterEach(async () => {
	vi.restoreAllMocks();
	setAgentDir(originalAgentDir);
	clearFsCache();
	await removeWithRetries(projectDir);
	await removeWithRetries(homeDir);
	await removeWithRetries(agentDir);
});

/** Installs the fixture package under `root/node_modules` and returns its bin entry's path. */
async function installPackage(root: string, bin = "cli.js"): Promise<string> {
	const pkgDir = path.join(root, "node_modules", PACKAGE);
	await Bun.write(
		path.join(pkgDir, "package.json"),
		JSON.stringify({ name: PACKAGE, version: "1.2.3", bin: { "lint-mcp": bin } }),
	);
	await Bun.write(path.join(pkgDir, "cli.js"), "");
	return path.join(pkgDir, "cli.js");
}

function resolve(spec: MCPPackageLaunch, cwd = projectDir) {
	const config: MCPStdioServerConfig & { package: MCPPackageLaunch } = {
		type: "stdio",
		package: spec,
		args: ["--stdio"],
	};
	return resolvePackageLaunch(config, { cwd, home: homeDir, defaults: DEFAULT_MCP_PACKAGE_LAUNCH });
}

describe("resolvePackageLaunch", () => {
	test("local-first runs the installed bin from a subdirectory, else the runner with name@version", async () => {
		const nested = path.join(projectDir, "packages", "app");
		await fs.mkdir(nested, { recursive: true });

		const fallback = await resolve({ name: PACKAGE, version: "^1.2" }, nested);
		expect(fallback.command).toBe("bunx");
		expect(fallback.args).toEqual([`${PACKAGE}@^1.2`, "--stdio"]);
		expect(fallback.package).toBeUndefined();

		const entry = await installPackage(projectDir);
		const local = await resolve({ name: PACKAGE, runtime: ["node"] }, nested);
		expect(local.command).toBe("node");
		expect(local.args).toEqual([entry, "--stdio"]);
	});

	test("fallback-only skips an installed package; local-only rejects a missing one", async () => {
		await installPackage(projectDir);
		const fallback = await resolve({ name: PACKAGE, policy: "fallback-only", runner: ["aubx"] });
		expect(fallback.command).toBe("aubx");
		expect(fallback.args).toEqual([`${PACKAGE}@latest`, "--stdio"]);

		await expect(resolve({ name: "docs-mcp", policy: "local-only" })).rejects.toBeInstanceOf(MCPPackageLaunchError);
	});

	test("a bin entry outside the package or a shim without its package is rejected, not run", async () => {
		await Bun.write(path.join(projectDir, "outside.js"), "");
		await installPackage(projectDir, "../../../outside.js");
		await expect(resolve({ name: PACKAGE })).rejects.toThrow(/escapes/);

		await Bun.write(path.join(projectDir, "node_modules", ".bin", "docs-mcp"), "");
		await expect(resolve({ name: "docs-mcp" })).rejects.toThrow(/shim exists without docs-mcp/);
	});
});

test("project settings cannot choose the package runner, runtime, or policy", async () => {
	await Bun.write(path.join(agentDir, "config.yml"), YAML.stringify({ mcp: { packageRunner: ["aubx"] } }));
	await Bun.write(
		path.join(projectDir, ".omp", "config.yml"),
		YAML.stringify({ mcp: { packageRunner: ["evil"], packageRuntime: ["evil-rt"], packagePolicy: "local-only" } }),
	);
	const settings = await Settings.loadReadOnly({ cwd: projectDir, agentDir });
	expect(cfgMcpPackageRunner.provenance(settings)).toBe("project");

	const defaults = mcpPackageLaunchDefaults(settings);
	expect(defaults).toEqual({ runner: ["aubx"], runtime: DEFAULT_MCP_PACKAGE_RUNTIME, policy: "local-first" });

	const manager = new MCPManager(projectDir);
	manager.setPackageLaunchDefaults(() => mcpPackageLaunchDefaults(settings));
	const resolved = await manager.prepareConfig({ type: "stdio", package: { name: PACKAGE } });
	expect(resolved).toMatchObject({ command: "aubx", args: [`${PACKAGE}@latest`] });
});

test("discovery keeps a package spec, separates differing versions, and drops an invalid spec", async () => {
	const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
	await Bun.write(
		path.join(projectDir, ".omp", "mcp.json"),
		JSON.stringify({
			mcpServers: {
				pinned: { package: { name: PACKAGE, version: "1.2.3" }, args: ["--stdio"] },
				latest: { package: { name: PACKAGE }, args: ["--stdio"] },
				typo: { package: { name: PACKAGE, policy: "remote-first" } },
				envName: { package: { name: "${LINT_MCP_PACKAGE}" } },
				envRunner: { package: { name: "env-runner-mcp", runner: ["${HOME}/bin/aubx"] } },
				withUrl: { package: { name: "url-mcp" }, url: "https://example.com/mcp" },
			},
		}),
	);

	const { configs } = await loadAllMCPConfigs(projectDir);
	// `${VAR}` never picks the package; it only expands inside the runner/runtime argv.
	expect(Object.keys(configs).sort()).toEqual(["envRunner", "latest", "pinned"]);
	expect((configs.envRunner as MCPStdioServerConfig).package?.runner).toEqual([`${process.env.HOME}/bin/aubx`]);
	expect(configs.pinned).toMatchObject({ type: "stdio", package: { name: PACKAGE, version: "1.2.3" } });
	expect((configs.pinned as MCPStdioServerConfig).command).toBeUndefined();
	expect(warn.mock.calls.some(args => String(args[0]).includes('"typo": invalid package'))).toBe(true);
	expect(warn.mock.calls.some(args => String(args[0]).includes('"envName": invalid package'))).toBe(true);
});

test("validation and schema accept package without command and reject both or a bad policy", () => {
	const valid = { type: "stdio" as const, package: { name: PACKAGE } };
	const both = { ...valid, command: "npx" };
	const badPolicy = { type: "stdio" as const, package: { name: PACKAGE, policy: "remote-first" as "local-only" } };
	const withUrl = { ...valid, url: "https://example.com/mcp" };

	expect(validateServerConfig("x", valid)).toEqual([]);
	expect(validateServerConfig("x", both)).toHaveLength(1);
	expect(validateServerConfig("x", badPolicy)).toHaveLength(1);
	expect(validateServerConfig("x", withUrl).some(error => error.includes('both "package" and "url"'))).toBe(true);

	expect(validateJsonSchemaValue(mcpSchema, { mcpServers: { x: valid } }).success).toBe(true);
	expect(validateJsonSchemaValue(mcpSchema, { mcpServers: { x: both } }).success).toBe(false);
	expect(validateJsonSchemaValue(mcpSchema, { mcpServers: { x: badPolicy } }).success).toBe(false);
});
