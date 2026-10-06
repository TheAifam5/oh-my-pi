import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

import { cfgBashEnabled } from "@oh-my-pi/pi-coding-agent/exec/settings";
import {
	cfgFindEnabled,
	cfgGithubEnabled,
	cfgGrepEnabled,
	cfgToolsXdev,
} from "@oh-my-pi/pi-coding-agent/tools/settings";

// Tool-gating settings (`grep.enabled`, `*.enabled`, ...) must reconcile a live
// session's tools and prompt instead of waiting for the next session.
describe("settings-gated tools in a live session", () => {
	let registryDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const sessions: AgentSession[] = [];

	beforeAll(async () => {
		registryDir = path.join(os.tmpdir(), `pi-settings-gated-tools-${Snowflake.next()}`);
		fs.mkdirSync(registryDir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(registryDir, "auth.db"));
		modelRegistry = new ModelRegistry(authStorage, path.join(registryDir, "models.yml"));
	});

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose().catch(() => {});
	});

	afterAll(() => {
		authStorage.close();
		if (fs.existsSync(registryDir)) removeSyncWithRetries(registryDir);
	});

	async function startSession(
		settings: Settings,
		toolNames?: string[],
		model = getBundledModel("openai", "gpt-4o-mini"),
	): Promise<AgentSession> {
		const { session } = await createAgentSession({
			cwd: registryDir,
			agentDir: registryDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings,
			model,
			disableExtensionDiscovery: true,
			enableMCP: false,
			enableLsp: false,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			rules: [],
			workspaceTree: { rootPath: registryDir, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
			toolNames,
		});
		sessions.push(session);
		return session;
	}

	/** Lets the coalesced watch fire, then waits for the reconcile it queued on the registry lock. */
	async function settle(session: AgentSession): Promise<void> {
		await Promise.resolve();
		await session.runToolRegistryMutation(async () => {});
	}

	const GREP_POLICY = "NEVER shell `grep`/`rg`/`awk`";

	it("removes and restores grep in the request tools and system prompt", async () => {
		const settings = Settings.isolated({});
		const session = await startSession(settings);
		expect(session.getActiveToolNames()).toContain("grep");
		expect(session.systemPrompt.join("\n")).toContain(GREP_POLICY);

		cfgGrepEnabled.set(settings, false);
		await settle(session);
		expect(session.getActiveToolNames()).not.toContain("grep");
		expect(session.getToolByName("grep")).toBeUndefined();
		expect(session.systemPrompt.join("\n")).not.toContain(GREP_POLICY);
		expect(session.getActiveToolNames()).toContain("read");

		cfgGrepEnabled.set(settings, true);
		await settle(session);
		expect(session.getActiveToolNames()).toContain("grep");
		expect(session.systemPrompt.join("\n")).toContain(GREP_POLICY);
	});

	describe("on a prefix-bound session after a turn", () => {
		interface RecordedRequest {
			systemPrompt: string[];
			toolNames: string[];
			descriptions: Map<string, string>;
		}

		afterEach(() => {
			authStorage.keys.removeRuntime("anthropic");
		});

		/** Starts a prefix-binding session whose provider requests are recorded, and runs one turn. */
		async function startPrefixBoundSession(
			settings: Settings,
		): Promise<{ session: AgentSession; requests: RecordedRequest[] }> {
			authStorage.keys.setRuntime("anthropic", "test-key");
			const session = await startSession(settings, undefined, getBundledModel("anthropic", "claude-sonnet-5-5"));
			expect(session.model?.thinking?.prefixBinding).toBe(true);
			const requests: RecordedRequest[] = [];
			const mock = createMockModel({
				handler: context => {
					const tools = context.tools ?? [];
					requests.push({
						systemPrompt: [...(context.systemPrompt ?? [])],
						toolNames: tools.map(tool => tool.name),
						descriptions: new Map(tools.map(tool => [tool.name, tool.description])),
					});
					return { content: ["ok"] };
				},
			});
			session.agent.streamFn = mock.stream;
			await session.prompt("first");
			return { session, requests };
		}

		function rosterNotices(session: AgentSession): unknown[] {
			return session.agent.state.messages.filter(
				message => message.role === "custom" && message.customType === "tool-roster-notice",
			);
		}

		function expectSiblingDescriptionsUnchanged(before: RecordedRequest, after: RecordedRequest): void {
			expect(after.systemPrompt).toEqual(before.systemPrompt);
			expect(before.toolNames).toEqual(expect.arrayContaining(["bash", "grep", "glob"]));
			for (const name of ["bash", "grep", "glob"]) {
				expect(after.descriptions.get(name)).toBe(before.descriptions.get(name));
			}
		}

		it("keeps the request prefix byte-stable when a gated tool turns on", async () => {
			const settings = Settings.isolated({ "find.enabled": "off" });
			const { session, requests } = await startPrefixBoundSession(settings);
			expect(session.getActiveToolNames()).not.toContain("find");

			cfgFindEnabled.override(settings, "on");
			await settle(session);
			expect(session.getActiveToolNames()).toContain("find");
			await session.prompt("second");

			const [before, after] = requests;
			expectSiblingDescriptionsUnchanged(before, after);
			expect(after.toolNames).toContain("find");
			const notices = rosterNotices(session);
			expect(notices).toHaveLength(1);
			expect(notices[0]).toMatchObject({ details: { added: ["find"], removed: [] } });
		});

		it("keeps the request prefix byte-stable when a gated tool turns off", async () => {
			const settings = Settings.isolated({ "find.enabled": "on" });
			const { session, requests } = await startPrefixBoundSession(settings);
			expect(session.getActiveToolNames()).toContain("find");

			cfgFindEnabled.override(settings, "off");
			await settle(session);
			await session.prompt("second");

			const [before, after] = requests;
			expectSiblingDescriptionsUnchanged(before, after);
			// The active list loses `find` in place; the provider keeps declaring the sent definition.
			expect(after.toolNames).toEqual(before.toolNames.filter(name => name !== "find"));
			const notices = rosterNotices(session);
			expect(notices).toHaveLength(1);
			expect(notices[0]).toMatchObject({ details: { added: [], removed: ["find"] } });
		});

		it("sends no roster notice when a gated tool turns on and back off between turns", async () => {
			const settings = Settings.isolated({ "find.enabled": "off" });
			const { session, requests } = await startPrefixBoundSession(settings);

			cfgFindEnabled.override(settings, "on");
			await settle(session);
			cfgFindEnabled.override(settings, "off");
			await settle(session);
			await session.prompt("second");

			const [before, after] = requests;
			expectSiblingDescriptionsUnchanged(before, after);
			expect(after.toolNames).toEqual(before.toolNames);
			expect(rosterNotices(session)).toHaveLength(0);
		});

		it("rebuilds the prompt when tools.xdev changes how tools are mounted", async () => {
			const settings = Settings.isolated({});
			const { session, requests } = await startPrefixBoundSession(settings);

			cfgToolsXdev.set(settings, false);
			await settle(session);
			await session.prompt("second");

			const [before, after] = requests;
			expect(after.systemPrompt).not.toEqual(before.systemPrompt);
			expect(rosterNotices(session)).toHaveLength(0);
		});
	});

	it("never widens an explicit tool list", async () => {
		const settings = Settings.isolated({ "grep.enabled": false, "github.enabled": false });
		const session = await startSession(settings, ["read", "bash"]);
		const before = session.getActiveToolNames();
		expect(before).not.toContain("grep");

		cfgGrepEnabled.set(settings, true);
		cfgGithubEnabled.set(settings, true);
		await settle(session);
		expect(session.getActiveToolNames()).toEqual(before);
		expect(session.getToolByName("grep")).toBeUndefined();

		cfgBashEnabled.set(settings, false);
		await settle(session);
		expect(session.getActiveToolNames()).not.toContain("bash");
		expect(session.getActiveToolNames()).toContain("read");
	});
});
