/**
 * Tools registered with upstream Pi's orchestration fields (`exposure`, `defaultActive`,
 * `executionMode`, `namespace`, `annotations`) reach the model the way the fields say,
 * report them through `getAllTools()`, never gain approval from the hints, and fail
 * registration when they contradict the OMP field they map onto.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadExtensionFromFactory, loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { createAgentSession, discoverAuthStorage, type ExtensionFactory } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { resolveApproval } from "@oh-my-pi/pi-coding-agent/tools/approval";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

const okResult = async () => ({ content: [{ type: "text" as const, text: "ok" }] });

const piToolsExtension: ExtensionFactory = pi => {
	pi.registerTool({
		name: "pi_direct",
		label: "Pi Direct",
		description: "Declared top-level through Pi exposure.",
		parameters: type({}),
		exposure: "direct",
		executionMode: "sequential",
		namespace: { name: "mcp__docs", description: "Docs server" },
		annotations: { readOnlyHint: true, openWorldHint: false },
		execute: okResult,
	});
	pi.registerTool({
		name: "pi_deferred",
		label: "Pi Deferred",
		description: "Reached through discovery only.",
		parameters: type({}),
		exposure: "deferred",
		execute: okResult,
	});
	pi.registerTool({
		name: "pi_inactive",
		label: "Pi Inactive",
		description: "Registered outside the initial active set.",
		parameters: type({}),
		exposure: "direct",
		defaultActive: false,
		execute: okResult,
	});
	pi.registerTool({
		name: "pi_hidden",
		label: "Pi Hidden",
		description: "Registered but excluded.",
		parameters: type({}),
		exposure: "hidden",
		execute: okResult,
	});
};

describe("Pi-parity tool orchestration metadata", () => {
	const tempDirs: string[] = [];
	let modelRegistry!: ModelRegistry;
	let registryAuthDir: string;
	let session: AgentSession | undefined;

	const makeTempDir = (): string => {
		const tempDir = path.join(os.tmpdir(), `omp-pi-tool-metadata-${Snowflake.next()}`);
		tempDirs.push(tempDir);
		fs.mkdirSync(tempDir, { recursive: true });
		return tempDir;
	};

	beforeAll(async () => {
		registryAuthDir = path.join(os.tmpdir(), `omp-pi-tool-metadata-auth-${Snowflake.next()}`);
		fs.mkdirSync(registryAuthDir, { recursive: true });
		modelRegistry = new ModelRegistry(await discoverAuthStorage(registryAuthDir));
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		for (const tempDir of tempDirs.splice(0)) removeSyncWithRetries(tempDir);
	});

	afterAll(() => {
		removeSyncWithRetries(registryAuthDir);
	});

	async function startSession(): Promise<AgentSession> {
		const tempDir = makeTempDir();
		const created = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			rules: [],
			workspaceTree: { rootPath: tempDir, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
			extensions: [piToolsExtension],
		});
		expect(created.extensionsResult.errors).toEqual([]);
		session = created.session;
		return created.session;
	}

	it("presents each exposure and defaultActive as Pi declares it", async () => {
		const active = await startSession();

		const activeNames = active.getActiveToolNames();
		const deviceNames = active.getXdevToolEntries().map(entry => entry.name);
		// direct: a top-level tool, not an xd:// device.
		expect(activeNames).toContain("pi_direct");
		expect(deviceNames).not.toContain("pi_direct");
		// deferred: off the top-level schema, reachable through discovery.
		expect(activeNames).not.toContain("pi_deferred");
		expect(deviceNames).toContain("pi_deferred");
		// defaultActive false and hidden: registered but unreachable until selected.
		for (const name of ["pi_inactive", "pi_hidden"]) {
			expect(active.getAllToolNames()).toContain(name);
			expect(activeNames).not.toContain(name);
			expect(deviceNames).not.toContain(name);
		}
		// executionMode sequential schedules the call alone.
		expect(active.getToolByName("pi_direct")?.concurrency).toBe("exclusive");

		const infos = new Map(active.getAllToolInfos().map(info => [info.name, info]));
		expect(infos.get("pi_direct")).toMatchObject({
			exposure: "direct",
			namespace: { name: "mcp__docs", description: "Docs server" },
			annotations: { readOnlyHint: true, openWorldHint: false },
		});
		expect(infos.get("pi_deferred")?.exposure).toBe("deferred");
		expect(infos.get("pi_hidden")?.exposure).toBe("hidden");
		// Tools without Pi metadata report an exposure derived from their presentation.
		expect(infos.get("read")?.exposure).toBe("direct");
		expect(infos.get("pi_deferred")?.annotations).toBeUndefined();
	});

	it("keeps the exec approval tier and the tool-name policy key despite read-only hints and a namespace", async () => {
		const active = await startSession();
		const tool = active.getToolByName("pi_direct");
		if (!tool) throw new Error("pi_direct was not registered");

		const resolved = resolveApproval(tool, {}, "write");
		expect(resolved.tier).toBe("exec");
		expect(resolved.policy).toBe("prompt");
		// A user grant on the namespace name is not a grant on the tool.
		expect(resolveApproval(tool, {}, "write", { mcp__docs: "allow" }).policy).toBe("prompt");
		expect(resolveApproval(tool, {}, "write", { pi_direct: "deny" }).policy).toBe("deny");
	});

	it("rejects Pi fields that contradict the OMP field they map onto", async () => {
		const cwd = makeTempDir();
		const bus = new EventBus();
		const { runtime } = await loadExtensions([], cwd, bus);
		const register = (fields: Record<string, unknown>) =>
			loadExtensionFromFactory(
				pi => {
					pi.registerTool({
						name: "conflicted",
						label: "Conflicted",
						description: "Conflicting metadata.",
						parameters: type({}),
						execute: okResult,
						...fields,
					});
				},
				cwd,
				bus,
				runtime,
			);

		await expect(register({ exposure: "hidden", hidden: false })).rejects.toThrow(
			/exposure "hidden" conflicts with hidden/,
		);
		await expect(register({ exposure: "direct", loadMode: "discoverable" })).rejects.toThrow(
			/conflicts with loadMode "discoverable"/,
		);
		await expect(register({ defaultActive: true, defaultInactive: true })).rejects.toThrow(
			/defaultActive conflicts with defaultInactive/,
		);
		await expect(register({ exposure: "everywhere" })).rejects.toThrow(/unknown exposure "everywhere"/);
		await expect(register({ namespace: { description: "no name" } })).rejects.toThrow(/namespace must be an object/);
		// Agreeing declarations register.
		await expect(
			register({ exposure: "hidden", hidden: true, defaultActive: false, defaultInactive: true }),
		).resolves.toBeDefined();
	});
});
