import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import type { Model } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { buildRuleFromMarkdown, createSourceMeta } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

function rule(name: string, selectors: string, body: string) {
	return buildRuleFromMarkdown(
		`${name}.md`,
		`---\nalwaysApply: true\n${selectors}\n---\n${body}`,
		`${name}.md`,
		createSourceMeta("test", `${name}.md`, "project"),
	);
}

function bundled(provider: "anthropic" | "openai", id: string): Model {
	const model = getBundledModel(provider, id);
	if (!model) throw new Error(`Missing bundled model ${provider}/${id}`);
	return model;
}

const opus = bundled("anthropic", "claude-opus-5");
const other = bundled("openai", "gpt-4o-mini");
const opusBody = "Opus reviewer must inspect ownership boundaries.";
const otherBody = "OpenAI reviewer must inspect error mapping.";
const unscopedBody = "Executor-only rule must not reach reviewers.";
const specialization = "Review public interfaces.";

describe("advisor model-scoped always-apply rules", () => {
	let session: AgentSession | undefined;
	let tempDir: TempDir | undefined;
	let authStorage: AuthStorage | undefined;

	afterEach(async () => {
		vi.restoreAllMocks();
		await session?.dispose();
		authStorage?.close();
		await tempDir?.remove();
	});

	async function start(advisorModel: Model) {
		tempDir = TempDir.createSync("@pi-advisor-model-rules-");
		fs.writeFileSync(
			tempDir.join("WATCHDOG.yml"),
			`advisors:\n  - name: Reviewer\n    model: ${advisorModel.provider}/${advisorModel.id}\n    instructions: ${specialization}\n`,
		);
		authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
		authStorage.keys.setRuntime("openai", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"), {
			cacheDbPath: tempDir.join("models.db"),
		});
		const settings = Settings.isolated({
			"async.enabled": false,
			"advisor.enabled": true,
			"advisor.syncBacklog": "1",
			"retry.capacityRetries": 0,
			"retry.baseDelayMs": 1,
			"retry.fallbackChains": { advisor: [`${other.provider}/${other.id}`] },
			"compaction.enabled": false,
			"ttsr.disabledRules": ["disabled"],
		});
		settings.setModelRole("advisor", `${advisorModel.provider}/${advisorModel.id}`);
		const result = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			authStorage,
			modelRegistry,
			settings,
			model: other,
			disableExtensionDiscovery: true,
			rules: [
				rule("opus", "models: claude-opus-5\nproviders: anthropic\nclass: anthropic\nfamily: opus", opusBody),
				rule("other", "providers: openai", otherBody),
				rule("unscoped", "", unscopedBody),
				rule("disabled", "models: '*'", "Disabled reviewer rule."),
				rule("conditional", "models: '*'\ncondition: forbidden", "Conditional reviewer rule."),
			],
			skills: [],
			contextFiles: [],
			workspaceTree: { rootPath: tempDir.path(), rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});
		session = result.session;
		return { session, modelRegistry };
	}

	it("includes matching Opus selectors before specialization without leaking executor or conditional rules", async () => {
		const { session } = await start(opus);
		const blocks = session.getAdvisorAgent()?.state.systemPrompt;
		expect(blocks).toContain(opusBody);
		expect(blocks).not.toContain(otherBody);
		expect(blocks).not.toContain(unscopedBody);
		expect(blocks).not.toContain("Disabled reviewer rule.");
		expect(blocks).not.toContain("Conditional reviewer rule.");
		expect(blocks!.indexOf(opusBody)).toBeLessThan(blocks!.indexOf(specialization));
	});

	it("excludes Opus rules when the advisor resolves to another model", async () => {
		const { session } = await start(other);
		expect(session.getAdvisorAgent()?.state.systemPrompt).not.toContain(opusBody);
		expect(session.getAdvisorAgent()?.state.systemPrompt).toContain(otherBody);
	});

	it("replaces model-specific prompt rules on fallback and cooldown restore", async () => {
		const { session, modelRegistry } = await start(opus);
		const primary = createMockModel({ handler: { content: ["primary complete"] } });
		const advisorMock = createMockModel();
		const requests: Array<{ id: string; prompt: string }> = [];
		let failPrimary = true;
		session.agent.streamFn = primary.stream;
		const advisor = session.getAdvisorAgent();
		if (!advisor) throw new Error("Expected live advisor");
		advisor.streamFn = (model, context, options) => {
			requests.push({
				id: model.id,
				prompt: Array.isArray(context.systemPrompt)
					? context.systemPrompt.join("\n\n")
					: (context.systemPrompt ?? ""),
			});
			if (model.id === opus.id && failPrimary) {
				advisorMock.push({ throw: "overloaded_error: provider returned error 503" });
			} else {
				advisorMock.push({ content: ["review complete"] });
			}
			return advisorMock.stream(model, context, options);
		};
		vi.spyOn(modelRegistry.authStorage.limits, "markReached").mockResolvedValue({ switched: false });
		await session.prompt("Review the first change.");
		await session.waitForIdle();
		expect(await session.waitForAdvisorCatchup(5000, { waitThroughRecovery: true })).toBe(true);
		expect(requests[0]?.prompt).toContain(opusBody);
		expect(requests.at(-1)?.id).toBe(other.id);
		expect(requests.at(-1)?.prompt).toContain(otherBody);
		expect(requests.at(-1)?.prompt).not.toContain(opusBody);
		failPrimary = false;
		vi.spyOn(Date, "now").mockReturnValue(Date.now() + 10 * 60_000);
		await session.prompt("Review the second change.");
		await session.waitForIdle();
		expect(await session.waitForAdvisorCatchup(5000, { waitThroughRecovery: true })).toBe(true);
		expect(requests.at(-1)?.id).toBe(opus.id);
		expect(requests.at(-1)?.prompt).toContain(opusBody);
		expect(requests.at(-1)?.prompt).not.toContain(otherBody);
	});
});
