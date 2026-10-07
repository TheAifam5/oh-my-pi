import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgTtsrEnabled } from "@oh-my-pi/pi-coding-agent/export/ttsr-settings";
import { cfgDisabledExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/settings";
import { createAgentSession, type CreateAgentSessionOptions } from "@oh-my-pi/pi-coding-agent/sdk";
import { cfgSecretsEnabled } from "@oh-my-pi/pi-coding-agent/secrets/settings";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { cfgPersonality } from "@oh-my-pi/pi-coding-agent/session/settings";
import { cfgAsyncEnabled } from "@oh-my-pi/pi-coding-agent/tools/settings";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

// A system-prompt rebuild with unchanged inputs must reproduce the startup bytes, and a
// settings change must not rewrite the cached prefix of a prefix-binding model mid-conversation.
describe("system prompt stability across rebuilds", () => {
	let registryDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const sessions: AgentSession[] = [];

	beforeAll(async () => {
		registryDir = path.join(os.tmpdir(), `pi-settings-prompt-rebuild-${Snowflake.next()}`);
		fs.mkdirSync(registryDir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(registryDir, "auth.db"));
		modelRegistry = new ModelRegistry(authStorage, path.join(registryDir, "models.yml"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const session of sessions.splice(0)) await session.dispose().catch(() => {});
		authStorage.keys.removeRuntime("anthropic");
		authStorage.keys.removeRuntime("openai");
	});

	afterAll(() => {
		authStorage.close();
		if (fs.existsSync(registryDir)) removeSyncWithRetries(registryDir);
	});

	async function startSession(
		settings: Settings,
		model = getBundledModel("openai", "gpt-4o-mini"),
		overrides: Partial<CreateAgentSessionOptions> = {},
	): Promise<AgentSession> {
		const { session } = await createAgentSession({
			cwd: registryDir,
			agentDir: registryDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(overrides.cwd ?? registryDir),
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
			...overrides,
		});
		sessions.push(session);
		return session;
	}

	interface RecordedRequest {
		systemPrompt: string[];
		bashDescription: string | undefined;
	}

	/** Records each provider request's system prompt and `bash` description, answering "ok". */
	function recordRequests(session: AgentSession): RecordedRequest[] {
		const requests: RecordedRequest[] = [];
		const mock = createMockModel({
			handler: context => {
				requests.push({
					systemPrompt: [...(context.systemPrompt ?? [])],
					bashDescription: context.tools?.find(tool => tool.name === "bash")?.description,
				});
				return { content: ["ok"] };
			},
		});
		session.agent.streamFn = mock.stream;
		return requests;
	}

	function collectNotices(session: AgentSession): string[] {
		const notices: string[] = [];
		session.subscribe(event => {
			if (event.type === "notice" && event.source === "settings") notices.push(event.message);
		});
		return notices;
	}

	/** Lets the coalesced watch fire, then waits for the rebuild it queued on the registry lock. */
	async function settle(session: AgentSession): Promise<void> {
		await Promise.resolve();
		await session.runToolRegistryMutation(async () => {});
	}

	async function startPrefixBoundSession(
		settings: Settings,
		overrides: Partial<CreateAgentSessionOptions> = {},
	): Promise<AgentSession> {
		authStorage.keys.setRuntime("anthropic", "test-key");
		const session = await startSession(settings, getBundledModel("anthropic", "claude-sonnet-5-5"), overrides);
		expect(session.model?.thinking?.prefixBinding).toBe(true);
		return session;
	}

	/** A prefix-bound session after one turn whose `personality` change is pending. */
	async function startWithDeferredPersonality(settings: Settings, overrides: Partial<CreateAgentSessionOptions> = {}) {
		const session = await startPrefixBoundSession(settings, overrides);
		const requests = recordRequests(session);
		const notices = collectNotices(session);
		await session.prompt("first");
		cfgPersonality.set(settings, "pragmatic");
		await settle(session);
		await session.prompt("second");
		expect(requests[1].systemPrompt).toEqual(requests[0].systemPrompt);
		expect(notices).toHaveLength(1);
		return { session, requests, notices };
	}

	it("renders mounted memory tools in the startup prompt exactly as a rebuild does", async () => {
		const settings = Settings.isolated({
			"memory.backend": "mnemopi",
			"mnemopi.dbPath": path.join(registryDir, `memory-${Snowflake.next()}.db`),
			"mnemopi.scoping": "global",
			"mnemopi.noEmbeddings": true,
			"mnemopi.llmMode": "none",
			"mnemopi.autoRetain": false,
			"mnemopi.autoRecall": false,
		});
		const session = await startSession(settings);
		// The memory tools are reachable only as `xd://` devices, so the prompt must name them that way.
		expect(session.getActiveToolNames()).not.toContain("recall");
		expect(session.getMountedXdevToolNames()).toEqual(expect.arrayContaining(["recall", "retain", "reflect"]));
		const startupPrompt = [...session.systemPrompt];
		const text = startupPrompt.join("\n");
		for (const name of ["recall", "retain", "reflect"]) {
			expect(text).toContain(`\`xd://${name}\``);
			expect(text).not.toContain(`\`${name}\``);
		}

		await session.refreshBaseSystemPrompt();
		expect(session.systemPrompt).toEqual(startupPrompt);
	});

	describe("on a prefix-bound session after a turn", () => {
		it("defers a prompt-only settings change to the next forced rebuild with one notice", async () => {
			const { session, requests } = await startWithDeferredPersonality(Settings.isolated({}));

			await session.refreshBaseSystemPrompt();
			await session.prompt("third");
			expect(requests[2].systemPrompt[0]).not.toBe(requests[0].systemPrompt[0]);
		});

		it("lands a pending deferral at the next model switch", async () => {
			const { session, requests } = await startWithDeferredPersonality(
				Settings.isolated({ includeModelInPrompt: false }),
			);

			await session.setModel(getBundledModel("anthropic", "claude-opus-5-5"));
			await session.prompt("third");
			expect(requests[2].systemPrompt[0]).not.toBe(requests[0].systemPrompt[0]);
		});

		it("keeps the prompt across a model switch when nothing is pending", async () => {
			const session = await startPrefixBoundSession(Settings.isolated({ includeModelInPrompt: false }));
			const requests = recordRequests(session);
			await session.prompt("first");

			const committed = session.systemPrompt;
			await session.setModel(getBundledModel("anthropic", "claude-opus-5-5"));
			expect(session.systemPrompt).toBe(committed);
			await session.prompt("second");
			expect(requests[1].systemPrompt).toEqual(requests[0].systemPrompt);
		});

		it("clears the pending deferral on a forced rebuild, so a later model switch keeps the prompt", async () => {
			const { session } = await startWithDeferredPersonality(Settings.isolated({ includeModelInPrompt: false }));
			await session.refreshBaseSystemPrompt();
			// A rebuild publishes a new prompt array even when its bytes are unchanged.
			const committed = session.systemPrompt;

			await session.setModel(getBundledModel("anthropic", "claude-opus-5-5"));
			expect(session.systemPrompt).toBe(committed);
		});

		it("rebuilds immediately when a TTSR setting changes", async () => {
			const settings = Settings.isolated({});
			const { session, requests, notices } = await startWithDeferredPersonality(settings);

			cfgTtsrEnabled.set(settings, false);
			await settle(session);
			await session.prompt("third");
			expect(requests[2].systemPrompt[0]).not.toBe(requests[0].systemPrompt[0]);
			expect(notices).toHaveLength(1);
		});

		it("rebuilds the prompt together with the tool schema when async.enabled changes", async () => {
			const settings = Settings.isolated({});
			const { session, requests, notices } = await startWithDeferredPersonality(settings);

			cfgAsyncEnabled.set(settings, false);
			await settle(session);
			await session.prompt("third");
			expect(requests[2].bashDescription).not.toBe(requests[0].bashDescription);
			expect(notices).toHaveLength(1);

			// A session built with the new settings is the agreement reference for both halves.
			const fresh = await startPrefixBoundSession(
				Settings.isolated({ "async.enabled": false, personality: "pragmatic" }),
			);
			expect(requests[2].bashDescription).toBe(fresh.getToolByName("bash")?.description);
			expect(requests[2].systemPrompt).toEqual(fresh.systemPrompt);
		});

		it("rebuilds at once, without a notice, when a deferrable and an immediate input change together", async () => {
			const settings = Settings.isolated({});
			const session = await startPrefixBoundSession(settings);
			const requests = recordRequests(session);
			const notices = collectNotices(session);
			await session.prompt("first");

			cfgPersonality.set(settings, "pragmatic");
			cfgAsyncEnabled.set(settings, false);
			await settle(session);
			await session.prompt("second");
			expect(requests[1].systemPrompt[0]).not.toBe(requests[0].systemPrompt[0]);
			expect(notices).toEqual([]);
		});

		it("notices again for a deferral after a forced rebuild", async () => {
			const settings = Settings.isolated({});
			const { session, notices } = await startWithDeferredPersonality(settings);
			await session.refreshBaseSystemPrompt();

			cfgPersonality.set(settings, "friendly");
			await settle(session);
			expect(notices).toHaveLength(2);
		});

		it("switches secret obfuscation on and rebuilds the prompt in the same request", async () => {
			const settings = Settings.isolated({});
			const session = await startPrefixBoundSession(settings);
			const requests = recordRequests(session);
			const notices = collectNotices(session);
			await session.prompt("first");
			expect(session.obfuscator?.obfuscates() === true).toBe(false);
			const setSystemPrompt = vi.spyOn(session.agent, "setSystemPrompt");

			try {
				cfgSecretsEnabled.set(settings, true);
				// The listener builds the obfuscator before it queues the rebuild.
				const deadline = Date.now() + 5_000;
				while (session.obfuscator?.obfuscates() !== true && Date.now() < deadline) await Bun.sleep(5);
				await session.runToolRegistryMutation(async () => {});
				expect(session.obfuscator?.obfuscates()).toBe(true);
				expect(setSystemPrompt).toHaveBeenCalledTimes(1);

				await session.prompt("second");
				expect(requests[0].systemPrompt.join("\n")).not.toContain("$$HASH$$");
				expect(requests[1].systemPrompt.join("\n")).toContain("$$HASH$$");
				expect(notices).toEqual([]);
			} finally {
				// The session drives process-wide credential redaction; hand it back switched off.
				cfgSecretsEnabled.set(settings, false);
				await Promise.resolve();
			}
		});

		it("skips the rebuild and adds no notice when disabledExtensions changes no rendered skill", async () => {
			const settings = Settings.isolated({});
			const { session, requests } = await startWithDeferredPersonality(settings);
			const notices = collectNotices(session);

			const refreshed = Promise.withResolvers<void>();
			const unsubscribe = session.subscribeCommandMetadataChanged(() => refreshed.resolve());
			cfgDisabledExtensions.set(settings, ["extension-module:absent"]);
			await refreshed.promise;
			unsubscribe();

			await session.prompt("third");
			expect(requests[2].systemPrompt).toEqual(requests[0].systemPrompt);
			expect(notices).toEqual([]);
		});

		it("defers a disabledExtensions change that hides skills, noticing once", async () => {
			const projectDir = path.join(registryDir, `skills-${Snowflake.next()}`);
			for (const name of ["alpha-skill", "beta-skill"]) {
				const skillDir = path.join(projectDir, ".omp", "skills", name);
				fs.mkdirSync(skillDir, { recursive: true });
				fs.writeFileSync(
					path.join(skillDir, "SKILL.md"),
					`---\nname: ${name}\ndescription: Skill ${name} for the deferral test.\n---\nbody\n`,
				);
			}
			const settings = Settings.isolated({
				"skills.enabled": true,
				"skills.enableCodexUser": false,
				"skills.enableClaudeUser": false,
				"skills.enableClaudeProject": false,
				"skills.enablePiUser": false,
				"skills.enablePiProject": true,
			});
			const session = await startPrefixBoundSession(settings, {
				cwd: projectDir,
				agentDir: projectDir,
				skills: undefined,
			});
			expect(session.skills.map(skill => skill.name)).toEqual(expect.arrayContaining(["alpha-skill", "beta-skill"]));
			const requests = recordRequests(session);
			const notices = collectNotices(session);
			await session.prompt("first");

			for (const disabled of [["skill:alpha-skill"], ["skill:alpha-skill", "skill:beta-skill"]]) {
				const refreshed = Promise.withResolvers<void>();
				const unsubscribe = session.subscribeCommandMetadataChanged(() => refreshed.resolve());
				cfgDisabledExtensions.set(settings, disabled);
				await refreshed.promise;
				unsubscribe();
			}
			expect(session.skills.map(skill => skill.name)).not.toContain("beta-skill");

			await session.prompt("second");
			expect(requests[1].systemPrompt).toEqual(requests[0].systemPrompt);
			expect(notices).toHaveLength(1);
		});
	});

	describe("rebuilds immediately", () => {
		it("on a prefix-bound session before its first turn", async () => {
			const settings = Settings.isolated({});
			const session = await startPrefixBoundSession(settings);
			const notices = collectNotices(session);
			const before = [...session.systemPrompt];

			cfgPersonality.set(settings, "pragmatic");
			await settle(session);
			expect(session.systemPrompt[0]).not.toBe(before[0]);
			expect(notices).toEqual([]);
		});

		it("on a model without prefix binding after a turn", async () => {
			const settings = Settings.isolated({});
			authStorage.keys.setRuntime("openai", "test-key");
			const session = await startSession(settings);
			expect(session.model?.thinking?.prefixBinding).not.toBe(true);
			const requests = recordRequests(session);
			const notices = collectNotices(session);
			await session.prompt("first");

			cfgPersonality.set(settings, "pragmatic");
			await settle(session);
			await session.prompt("second");
			expect(requests[1].systemPrompt[0]).not.toBe(requests[0].systemPrompt[0]);
			expect(notices).toEqual([]);
		});
	});
});
