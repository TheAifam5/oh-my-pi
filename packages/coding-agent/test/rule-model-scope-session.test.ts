import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { Rule } from "@oh-my-pi/pi-coding-agent/capability/rule";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

const OPUS_MARKER = "OPUS_ONLY_RULE_BODY_7f3a";
const SONNET_MARKER = "SONNET_ONLY_RULE_BODY_2c9e";

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
	scopedRule("style.opus", OPUS_MARKER, ["*/claude-opus-5"]),
	scopedRule("style.sonnet", SONNET_MARKER, ["*/claude-sonnet-5"]),
];

// Both models resolve to the same delegation-bias / inline-descriptor policy, so
// without model-scoped rules the `includeModelInPrompt: false` refresh key would not change.
describe("model-scoped rules in a live session", () => {
	const opus = getBundledModel("anthropic", "claude-opus-5");
	const sonnet = getBundledModel("anthropic", "claude-sonnet-5");
	let dir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const sessions: AgentSession[] = [];

	beforeAll(async () => {
		dir = path.join(os.tmpdir(), `pi-rule-model-scope-${Snowflake.next()}`);
		await fs.mkdir(dir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(dir, "auth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(async () => {
		for (const session of sessions) await session.dispose().catch(() => {});
		authStorage.close();
		await removeWithRetries(dir);
	});

	async function startSession(options: { model: typeof opus; includeModelInPrompt?: boolean; taskDepth?: number }) {
		const { session } = await createAgentSession({
			cwd: dir,
			agentDir: dir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ includeModelInPrompt: options.includeModelInPrompt ?? true }),
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

	it("gives a subagent on another model its own variant", async () => {
		const parent = await startSession({ model: opus });
		const child = await startSession({ model: sonnet, taskDepth: 1 });
		expect(prompt(parent)).toContain(OPUS_MARKER);
		expect(prompt(child)).toContain(SONNET_MARKER);
		expect(prompt(child)).not.toContain(OPUS_MARKER);
	});
});
