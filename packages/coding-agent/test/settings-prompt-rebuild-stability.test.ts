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
import {
	cfgCommandsEnableClaudeUser,
	cfgDisabledExtensions,
	cfgSkillsEnablePiProject,
} from "@oh-my-pi/pi-coding-agent/extensibility/settings";
import { createAgentSession, type CreateAgentSessionOptions } from "@oh-my-pi/pi-coding-agent/sdk";
import type { HindsightApi, MentalModelListResponse } from "@oh-my-pi/pi-coding-agent/hindsight/client";
import { loadHindsightConfig } from "@oh-my-pi/pi-coding-agent/hindsight/config";
import { HindsightSessionState } from "@oh-my-pi/pi-coding-agent/hindsight/state";
import { cfgSecretsEnabled } from "@oh-my-pi/pi-coding-agent/secrets/settings";
import { cfgWorkspaceAdditionalDirectories } from "@oh-my-pi/pi-coding-agent/session/context-settings";
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

	/**
	 * Records each provider request's system prompt. The first request runs `duringFirst`
	 * while it is still open, then answers with a failing `read` call, so the loop sends a
	 * continuation request within the same prompt; later requests answer "ok".
	 */
	function recordRequestsAcrossToolCall(session: AgentSession, duringFirst: () => Promise<void>): string[][] {
		const requests: string[][] = [];
		const mock = createMockModel({
			handler: async context => {
				requests.push([...(context.systemPrompt ?? [])]);
				if (requests.length > 1) return { content: ["ok"] };
				await duringFirst();
				return {
					content: [{ type: "toolCall", name: "read", arguments: { path: path.join(registryDir, "absent.txt") } }],
				};
			},
		});
		session.agent.streamFn = mock.stream;
		return requests;
	}

	/**
	 * The workspace listener applies the roots before it queues the rebuild; a macrotask
	 * drains that in-memory chain, then the registry lock waits for the queued rebuild.
	 */
	async function settleWorkspaceRoots(session: AgentSession): Promise<void> {
		await Bun.sleep(0);
		await session.runToolRegistryMutation(async () => {});
	}

	/** Project-only skill discovery, so the listing holds exactly the skills a test writes. */
	const projectSkillSettings = {
		"skills.enabled": true,
		"skills.enableCodexUser": false,
		"skills.enableClaudeUser": false,
		"skills.enableClaudeProject": false,
		"skills.enablePiUser": false,
		"skills.enablePiProject": true,
	};

	/** Writes `.omp/skills/<name>/SKILL.md` for each name into a fresh project directory. */
	function writeProjectSkills(names: string[]): string {
		const projectDir = path.join(registryDir, `skills-${Snowflake.next()}`);
		for (const name of names) {
			const skillDir = path.join(projectDir, ".omp", "skills", name);
			fs.mkdirSync(skillDir, { recursive: true });
			fs.writeFileSync(
				path.join(skillDir, "SKILL.md"),
				`---\nname: ${name}\ndescription: Skill ${name} for the deferral test.\n---\nbody\n`,
			);
		}
		return projectDir;
	}

	function userEntryIds(session: AgentSession): string[] {
		return session.sessionManager
			.getEntries()
			.flatMap(entry => (entry.type === "message" && entry.message.role === "user" ? [entry.id] : []));
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

	describe("memory auto-recall on a prefix-bound session", () => {
		function recallSettings(dbPath: string, autoRecall = true): Settings {
			return Settings.isolated({
				"memory.backend": "mnemopi",
				"mnemopi.dbPath": dbPath,
				"mnemopi.scoping": "global",
				"mnemopi.noEmbeddings": true,
				"mnemopi.llmMode": "none",
				"mnemopi.autoRetain": false,
				"mnemopi.autoRecall": autoRecall,
			});
		}

		/** Records each request's system prompt and serialized messages, answering "ok". */
		function recordPromptAndMessages(session: AgentSession): { systemPrompt: string[]; messages: string }[] {
			const requests: { systemPrompt: string[]; messages: string }[] = [];
			session.agent.streamFn = createMockModel({
				handler: context => {
					requests.push({
						systemPrompt: [...(context.systemPrompt ?? [])],
						messages: JSON.stringify(context.messages),
					});
					return { content: ["ok"] };
				},
			}).stream;
			return requests;
		}

		async function rememberFact(session: AgentSession, fact: string): Promise<void> {
			for (let attempt = 0; !session.getMnemopiSessionState() && attempt < 100; attempt++) await Bun.sleep(10);
			const state = session.getMnemopiSessionState();
			if (!state) throw new Error("Expected a mnemopi session state");
			state.rememberInScope(fact);
		}

		it("keeps the prompt carrying a first-turn recall byte-stable on the next turn", async () => {
			const settings = recallSettings(path.join(registryDir, `recall-${Snowflake.next()}.db`));
			const session = await startPrefixBoundSession(settings);
			await rememberFact(session, "Zebra herds cross the Mara river every July.");
			const requests = recordPromptAndMessages(session);

			await session.prompt("When do zebra herds cross the Mara river?");
			await session.prompt("And the zebra herds afterwards?");
			expect(requests[0].systemPrompt.join("\n")).toContain("Mara river every July");
			expect(requests[1].systemPrompt).toEqual(requests[0].systemPrompt);
		});

		it("queues a background recall found during the first request for the next turn", async () => {
			const session = await startPrefixBoundSession(Settings.isolated({}));
			const requests: { systemPrompt: string[]; messages: string }[] = [];
			session.agent.streamFn = createMockModel({
				handler: async context => {
					requests.push({
						systemPrompt: [...(context.systemPrompt ?? [])],
						messages: JSON.stringify(context.messages),
					});
					if (requests.length > 1) return { content: ["ok"] };
					await session.publishBackgroundMemoryRecall("Background recall marker.");
					return {
						content: [
							{ type: "toolCall", name: "read", arguments: { path: path.join(registryDir, "absent.txt") } },
						],
					};
				},
			}).stream;

			await session.prompt("first");
			await session.prompt("second");
			expect(requests).toHaveLength(3);
			expect(requests[1].systemPrompt).toEqual(requests[0].systemPrompt);
			expect(requests[2].systemPrompt).toEqual(requests[0].systemPrompt);
			expect(requests[1].messages).not.toContain("Background recall marker.");
			expect(requests[2].messages).toContain("Background recall marker.");
		});

		it("delivers a background recall synchronously once its generation check passes", async () => {
			const session = await startPrefixBoundSession(Settings.isolated({}));
			recordPromptAndMessages(session);
			await session.prompt("first");
			const hasRecall = (text: string) =>
				session.agent.state.messages.some(
					message =>
						message.role === "custom" && message.customType === "memory-recall" && message.content === text,
				);

			const delivered = session.publishBackgroundMemoryRecall("Current recall.", () => true);
			// No await separates the check from the append, so a later generation bump cannot interleave.
			expect(hasRecall("Current recall.")).toBe(true);
			await delivered;

			await session.publishBackgroundMemoryRecall("Superseded recall.", () => false);
			expect(hasRecall("Superseded recall.")).toBe(false);
		});

		describe("Hindsight mental models after the prompt was sent", () => {
			async function startHindsightState(responses: Promise<MentalModelListResponse>[]) {
				const session = await startPrefixBoundSession(Settings.isolated({}));
				const requests = recordPromptAndMessages(session);
				await session.prompt("first");
				let request = 0;
				const client = {
					listMentalModels: () => responses[request++] ?? Promise.resolve({ items: [] }),
				} as unknown as HindsightApi;
				const state = new HindsightSessionState({
					sessionId: "hindsight-session",
					client,
					bankId: "b",
					config: { ...loadHindsightConfig(Settings.isolated({})), mentalModelsEnabled: true },
					session,
					banksSet: new Set(["b"]),
					lastRetainedTurn: 0,
					hasRecalledForFirstTurn: true,
				});
				return { session, requests, state };
			}

			function mentalModels(content: string): MentalModelListResponse {
				return { items: [{ id: "u", bank_id: "b", name: "User Preferences", content }] };
			}

			it("rides the next turn as a hidden message, keeping the prompt, and drops a superseded load", async () => {
				const stale = Promise.withResolvers<MentalModelListResponse>();
				const { session, requests, state } = await startHindsightState([
					stale.promise,
					Promise.resolve(mentalModels("current preference")),
				]);
				const committed = session.systemPrompt;

				const superseded = state.runMentalModelLoad({ bankId: "b" });
				await Promise.resolve();
				state.beginMentalModelsTranscriptReload();
				await state.mentalModelsLoadPromise;
				stale.resolve(mentalModels("stale preference"));
				await superseded;

				expect(session.systemPrompt).toBe(committed);
				await session.prompt("second");
				expect(requests[1].systemPrompt).toEqual(requests[0].systemPrompt);
				expect(requests[1].messages).toContain("current preference");
				expect(requests[1].messages).not.toContain("stale preference");
			});

			it("neither rebuilds nor delivers an empty mental-model block", async () => {
				const { session, requests, state } = await startHindsightState([Promise.resolve({ items: [] })]);
				state.mentalModelsSnippet = "<mental_models>old</mental_models>";
				const committed = session.systemPrompt;

				await state.runMentalModelLoad({ bankId: "b" });
				expect(state.mentalModelsSnippet).toBeUndefined();
				expect(session.systemPrompt).toBe(committed);
				await session.prompt("second");
				expect(requests[1].systemPrompt).toEqual(requests[0].systemPrompt);
				expect(
					session.agent.state.messages.some(
						message => message.role === "custom" && message.customType === "memory-recall",
					),
				).toBe(false);
			});
		});

		it("delivers a recall on a resumed transcript as a hidden message, keeping the cached prompt", async () => {
			const dbPath = path.join(registryDir, `recall-${Snowflake.next()}.db`);
			const sessionDir = path.join(registryDir, `sessions-${Snowflake.next()}`);
			// Without a first-turn recall in the transcript, the resumed turn recalls afresh.
			const first = await startPrefixBoundSession(recallSettings(dbPath, false), {
				sessionManager: SessionManager.create(registryDir, sessionDir),
			});
			const firstRequests = recordPromptAndMessages(first);
			await first.prompt("Which river do zebra herds cross?");
			await rememberFact(first, "Zebra herds cross the Mara river every July.");
			await first.sessionManager.flush();
			const sessionFile = first.sessionFile;
			if (!sessionFile) throw new Error("Expected a persisted session file");
			await first.dispose();

			const resumed = await startPrefixBoundSession(recallSettings(dbPath), {
				sessionManager: await SessionManager.open(sessionFile, sessionDir),
			});
			expect(resumed.agent.state.messages.some(message => message.role === "assistant")).toBe(true);
			const requests = recordPromptAndMessages(resumed);
			await resumed.prompt("When do zebra herds cross the Mara river?");

			expect(requests[0].systemPrompt).toEqual(firstRequests[0].systemPrompt);
			expect(requests[0].messages).toContain("Mara river every July");
		});
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

		it("lands a pending deferral when tree navigation leaves no sent turn, not again at the model switch", async () => {
			const { session, requests } = await startWithDeferredPersonality(
				Settings.isolated({ includeModelInPrompt: false }),
			);
			const firstUser = userEntryIds(session)[0];

			await session.navigateTree(firstUser);
			expect(session.agent.state.messages).toEqual([]);
			expect(session.systemPrompt[0]).not.toBe(requests[0].systemPrompt[0]);

			const committed = session.systemPrompt;
			await session.setModel(getBundledModel("anthropic", "claude-opus-5-5"));
			expect(session.systemPrompt).toBe(committed);
		});

		it("keeps a pending deferral when tree navigation keeps a sent turn", async () => {
			const { session, requests } = await startWithDeferredPersonality(
				Settings.isolated({ includeModelInPrompt: false }),
			);
			const secondUser = userEntryIds(session)[1];

			await session.navigateTree(secondUser);
			expect(session.agent.state.messages.some(message => message.role === "assistant")).toBe(true);
			expect(session.systemPrompt).toEqual(requests[0].systemPrompt);

			await session.setModel(getBundledModel("anthropic", "claude-opus-5-5"));
			expect(session.systemPrompt[0]).not.toBe(requests[0].systemPrompt[0]);
		});

		it("adds a workspace root at once and defers its prompt listing", async () => {
			const settings = Settings.isolated({});
			const { session, requests, notices } = await startWithDeferredPersonality(settings);
			const extraRoot = fs.mkdtempSync(path.join(registryDir, "extra-root-"));

			cfgWorkspaceAdditionalDirectories.set(settings, [extraRoot]);
			await settleWorkspaceRoots(session);
			expect(session.sessionManager.getAdditionalDirectories()).toEqual([extraRoot]);

			await session.prompt("third");
			expect(requests[2].systemPrompt).toEqual(requests[0].systemPrompt);
			expect(notices).toHaveLength(1);
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

		it("skips the rebuild and adds no notice when a commands discovery setting changes no rendered skill", async () => {
			const settings = Settings.isolated({});
			const { session, requests } = await startWithDeferredPersonality(settings);
			const notices = collectNotices(session);

			const refreshed = Promise.withResolvers<void>();
			const unsubscribe = session.subscribeCommandMetadataChanged(() => refreshed.resolve());
			cfgCommandsEnableClaudeUser.set(settings, !cfgCommandsEnableClaudeUser.get(settings));
			await refreshed.promise;
			unsubscribe();

			await session.prompt("third");
			expect(requests[2].systemPrompt).toEqual(requests[0].systemPrompt);
			expect(notices).toEqual([]);
		});

		it("defers a skills discovery setting change that hides skills, noticing once", async () => {
			const projectDir = writeProjectSkills(["alpha-skill"]);
			const settings = Settings.isolated(projectSkillSettings);
			const session = await startPrefixBoundSession(settings, {
				cwd: projectDir,
				agentDir: projectDir,
				skills: undefined,
			});
			expect(session.skills.map(skill => skill.name)).toContain("alpha-skill");
			const requests = recordRequests(session);
			const notices = collectNotices(session);
			await session.prompt("first");

			const refreshed = Promise.withResolvers<void>();
			const unsubscribe = session.subscribeCommandMetadataChanged(() => refreshed.resolve());
			cfgSkillsEnablePiProject.override(settings, false);
			await refreshed.promise;
			unsubscribe();
			expect(session.skills.map(skill => skill.name)).not.toContain("alpha-skill");

			await session.prompt("second");
			expect(requests[1].systemPrompt).toEqual(requests[0].systemPrompt);
			expect(notices).toHaveLength(1);
		});

		it("lands a mid-session skillful toggle at the next model switch", async () => {
			const projectDir = writeProjectSkills(["alpha-skill"]);
			const session = await startPrefixBoundSession(
				Settings.isolated({ ...projectSkillSettings, includeModelInPrompt: false }),
				{ cwd: projectDir, agentDir: projectDir, skills: undefined },
			);
			const requests = recordRequests(session);
			const notices = collectNotices(session);
			await session.prompt("first");
			expect(requests[0].systemPrompt.join("\n")).toContain("alpha-skill");

			await session.setSkillful(false);
			await session.prompt("second");
			expect(requests[1].systemPrompt).toEqual(requests[0].systemPrompt);
			expect(notices).toHaveLength(1);

			await session.setModel(getBundledModel("anthropic", "claude-opus-5-5"));
			expect(session.systemPrompt.join("\n")).not.toContain("alpha-skill");
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

	describe("while the first request of a prefix-bound session is in flight", () => {
		it("defers a prompt-only settings change past the continuation request", async () => {
			const settings = Settings.isolated({});
			const session = await startPrefixBoundSession(settings);
			const notices = collectNotices(session);
			const requests = recordRequestsAcrossToolCall(session, async () => {
				cfgPersonality.set(settings, "pragmatic");
				await settle(session);
			});

			await session.prompt("first");
			expect(requests).toHaveLength(2);
			expect(requests[1]).toEqual(requests[0]);
			expect(notices).toHaveLength(1);

			await session.prompt("second");
			expect(requests[2]).toEqual(requests[0]);
		});

		it("rebuilds before the continuation request on a model without prefix binding", async () => {
			const settings = Settings.isolated({});
			authStorage.keys.setRuntime("openai", "test-key");
			const session = await startSession(settings);
			const notices = collectNotices(session);
			const requests = recordRequestsAcrossToolCall(session, async () => {
				cfgPersonality.set(settings, "pragmatic");
				await settle(session);
			});

			await session.prompt("first");
			expect(requests).toHaveLength(2);
			expect(requests[1][0]).not.toBe(requests[0][0]);
			expect(notices).toEqual([]);
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

		it("with a workspace root change on a model without prefix binding after a turn", async () => {
			const settings = Settings.isolated({});
			authStorage.keys.setRuntime("openai", "test-key");
			const session = await startSession(settings);
			const requests = recordRequests(session);
			await session.prompt("first");
			const extraRoot = fs.mkdtempSync(path.join(registryDir, "extra-root-"));

			cfgWorkspaceAdditionalDirectories.set(settings, [extraRoot]);
			await settleWorkspaceRoots(session);
			await session.prompt("second");
			expect(requests[0].systemPrompt.join("\n")).not.toContain(extraRoot);
			expect(requests[1].systemPrompt.join("\n")).toContain(extraRoot);
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
