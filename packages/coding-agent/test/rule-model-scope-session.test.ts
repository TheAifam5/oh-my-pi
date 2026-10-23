import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import type { Rule } from "@oh-my-pi/pi-coding-agent/capability/rule";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as sdk from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { resolveSessionModelSelector } from "@oh-my-pi/pi-coding-agent/session/model-selector";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir, Snowflake } from "@oh-my-pi/pi-utils";

const OPUS_MARKER = "OPUS_ONLY_RULE_BODY_7f3a";
const SONNET_MARKER = "SONNET_ONLY_RULE_BODY_2c9e";
const CODEX_MARKER = "CODEX_ONLY_RULE_BODY_9e1b";
const CODEX_SELECTORS = ["*/gpt-6", "*/gpt-6-*", "*/gpt-6.1", "*/gpt-6.1-*", "*/gpt-daybreak-*"];
const OPUS_SELECTORS = ["*/claude-opus-5"];

function scopedRule(name: string, content: string, models: string[]): Rule {
	return {
		name,
		path: `/rules/${name}.md`,
		content,
		alwaysApply: true,
		models,
		_source: { provider: "native", providerName: "native", path: `/rules/${name}.md`, level: "user" },
	};
}

const rules = [
	scopedRule("style.opus", OPUS_MARKER, OPUS_SELECTORS),
	scopedRule("style.sonnet", SONNET_MARKER, ["*/claude-sonnet-5"]),
	scopedRule("style.codex", CODEX_MARKER, CODEX_SELECTORS),
];

describe("model-scoped rules in a live session", () => {
	const opus = getBundledModel("anthropic", "claude-opus-5");
	const sonnet = getBundledModel("anthropic", "claude-sonnet-5");
	const codex = getBundledModel("openai", "gpt-6-sol");
	let dir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const sessions: AgentSession[] = [];

	beforeAll(async () => {
		dir = path.join(os.tmpdir(), `pi-rule-model-scope-${Snowflake.next()}`);
		await fs.mkdir(dir, { recursive: true });
		setAgentDir(dir);
		authStorage = await AuthStorage.create(path.join(dir, "auth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		authStorage.keys.setRuntime("openai", "test-key");
	});

	afterAll(async () => {
		for (const session of sessions) await session.dispose().catch(() => {});
		authStorage.close();
		__resetDirsFromEnvForTests();
		await removeWithRetries(dir);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		for (const model of [opus, codex]) {
			modelRegistry.clearSuppressedSelector(`${model.provider}/${model.id}`);
		}
	});

	async function startSession(options: {
		model: typeof opus;
		includeModelInPrompt?: boolean;
		taskDepth?: number;
		settings?: Settings;
	}) {
		const { session } = await sdk.createAgentSession({
			cwd: dir,
			agentDir: dir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings:
				options.settings ?? Settings.isolated({ includeModelInPrompt: options.includeModelInPrompt ?? true }),
			model: options.model,
			rules,
			taskDepth: options.taskDepth,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			toolNames: ["read"],
		});
		sessions.push(session);
		return session;
	}

	function prompt(session: AgentSession): string {
		return session.agent.state.systemPrompt.join("\n");
	}

	it("renders only the resolved model's variant in the first prompt", async () => {
		const session = await startSession({ model: sonnet });
		expect(prompt(session)).toContain(SONNET_MARKER);
		expect(prompt(session)).not.toContain(OPUS_MARKER);
	});

	for (const includeModelInPrompt of [true, false]) {
		it(`swaps the variant on every model switch (includeModelInPrompt=${includeModelInPrompt})`, async () => {
			const session = await startSession({ model: opus, includeModelInPrompt });
			expect(prompt(session)).toContain(OPUS_MARKER);
			expect(prompt(session)).not.toContain(SONNET_MARKER);

			await session.setModel(sonnet);
			expect(prompt(session)).toContain(SONNET_MARKER);
			expect(prompt(session)).not.toContain(OPUS_MARKER);

			await session.setModel(opus);
			expect(prompt(session)).toContain(OPUS_MARKER);
			expect(prompt(session)).not.toContain(SONNET_MARKER);
		});
	}

	for (const [primary, fallback, primaryMarker, fallbackMarker] of [
		[opus, codex, OPUS_MARKER, CODEX_MARKER],
		[codex, opus, CODEX_MARKER, OPUS_MARKER],
	] as const) {
		it(`refreshes rendered rules when retry fallback switches ${primary.id} to ${fallback.id}`, async () => {
			const settings = Settings.isolated({
				includeModelInPrompt: false,
				modelRoles: { default: `${primary.provider}/${primary.id}` },
				"retry.fallbackChains": { default: [`${fallback.provider}/${fallback.id}`] },
				"retry.capacityRetries": 0,
				"retry.baseDelayMs": 1,
				"retry.maxRetries": 2,
				"compaction.enabled": false,
				"advisor.enabled": false,
			});
			const session = await startSession({ model: primary, settings });
			const mock = createMockModel();
			const requests: { model: string; prompt: string }[] = [];
			session.agent.streamFn = (model, context, options) => {
				requests.push({ model: model.id, prompt: (context.systemPrompt ?? []).join("\n") });
				mock.push(
					model.id === primary.id
						? { throw: "overloaded_error: provider returned error 503" }
						: { content: ["recovered"] },
				);
				return mock.stream(model, context, options);
			};
			expect(prompt(session)).toContain(primaryMarker);
			expect(prompt(session)).not.toContain(fallbackMarker);

			await session.prompt("Exercise retry fallback.");

			expect(session.model?.id).toBe(fallback.id);
			const request = requests.find(entry => entry.model === fallback.id);
			expect(request).toBeDefined();
			expect(request?.prompt).toContain(fallbackMarker);
			expect(request?.prompt).not.toContain(primaryMarker);
			expect(prompt(session)).toContain(fallbackMarker);
			expect(prompt(session)).not.toContain(primaryMarker);
		});
	}

	it("refreshes rendered rules for an explicit @role/member session pool pick", async () => {
		const settings = Settings.isolated({
			includeModelInPrompt: false,
			modelRoles: {
				default: {
					strategy: "priority",
					strategyOptions: { order: ["opus", "codex"] },
					models: {
						opus: { model: `${opus.provider}/${opus.id}` },
						codex: { model: `${codex.provider}/${codex.id}` },
					},
				},
			},
		});
		const session = await startSession({ model: opus, settings });
		expect(prompt(session)).toContain(OPUS_MARKER);
		for (const [member, marker, absent] of [
			["codex", CODEX_MARKER, OPUS_MARKER],
			["opus", OPUS_MARKER, CODEX_MARKER],
		]) {
			const selected = await resolveSessionModelSelector(`@default/${member}`, session, settings);
			expect(selected.error).toBeUndefined();
			expect(selected.poolRole).toBe("default");
			if (!selected.model) throw new Error("Expected an eligible named pool member");
			await session.setModelTemporary(selected.model, selected.thinkingLevel, { poolRole: selected.poolRole });
			expect(prompt(session)).toContain(marker);
			expect(prompt(session)).not.toContain(absent);
			expect(session.isRolePoolPickActive("default")).toBe(true);
		}
	});

	it("renders the child's model rules in a real Task executor spawn instead of the parent's rules", async () => {
		const parent = await startSession({ model: opus });
		const create = sdk.createAgentSession;
		const childPrompts: string[] = [];
		vi.spyOn(sdk, "createAgentSession").mockImplementation(async options => {
			const result = await create(options);
			const mock = createMockModel();
			result.session.agent.streamFn = (model, context, streamOptions) => {
				childPrompts.push((context.systemPrompt ?? []).join("\n"));
				mock.push({ content: ["child result"] });
				return mock.stream(model, context, streamOptions);
			};
			return result;
		});
		const result = await runSubprocess({
			cwd: dir,
			agent: {
				name: "rules-worker",
				description: "Model rule regression worker",
				systemPrompt: "Complete the assigned task.",
				source: "bundled",
				tools: ["read"],
				structured: false,
			},
			task: "Report the result.",
			index: 0,
			id: "RulesWorker",
			modelOverride: `${codex.provider}/${codex.id}`,
			authStorage,
			modelRegistry,
			rules,
			settings: Settings.isolated({
				"task.agentIdleTtlMs": 0,
				"compaction.enabled": false,
				"todo.enabled": false,
				"todo.reminders": false,
				"advisor.enabled": false,
			}),
			enableLsp: false,
			enableMCP: false,
			enableIrc: false,
		});
		expect(result.exitCode).toBe(0);
		expect(result.resolvedModelIdentity).toBe(`${codex.provider}/${codex.id}`);
		expect(childPrompts.length).toBeGreaterThan(0);
		for (const rendered of childPrompts) {
			expect(rendered).toContain(CODEX_MARKER);
			expect(rendered).not.toContain(OPUS_MARKER);
		}
		expect(prompt(parent)).toContain(OPUS_MARKER);
		expect(prompt(parent)).not.toContain(CODEX_MARKER);
	});
});
