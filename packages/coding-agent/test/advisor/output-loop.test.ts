import { describe, expect, it } from "bun:test";
import { Agent, type AgentMessage, AppendOnlyContextManager } from "@oh-my-pi/pi-agent-core";
import { defaultConvertToLlm } from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, Context } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { buildResponsesInput } from "@oh-my-pi/pi-ai/providers/openai-shared";
import { createOpenAIResponsesHistoryPayload } from "@oh-my-pi/pi-ai/utils";
import { guardThinkingLoopStream } from "@oh-my-pi/pi-ai/utils/thinking-loop";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { type AdvisorAgent, AdvisorRuntime } from "../../src/advisor/runtime";

const repeatedBlock = "[**in progress — more steps follow**]";

async function settled(runtime: AdvisorRuntime): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (runtime.backlog > 0) {
		if (Date.now() > deadline) throw new Error("Advisor review did not settle");
		const next = Promise.withResolvers<void>();
		setImmediate(next.resolve);
		await next.promise;
	}
	await Promise.resolve();
}

function advisorFacade(agent: Agent): AdvisorAgent {
	return {
		prompt: input => (Array.isArray(input) ? agent.prompt(input) : agent.prompt(input)),
		abort: reason => agent.abort(reason),
		reset: () => agent.reset(),
		rollbackTo: count => {
			agent.state.messages.splice(count);
			agent.state.error = undefined;
			agent.appendOnlyContext?.resetSyncCursor();
		},
		state: agent.state,
	};
}

describe("advisor output-loop recovery", () => {
	it("removes three commentary echoes and their paired reasoning from the next native request", async () => {
		const model = buildModel({
			id: "gpt-5.3-codex-spark",
			name: "Advisor replay fixture",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 32_000,
		});
		const mock = createMockModel({
			responses: [
				{
					content: Array.from({ length: 3 }, (_, index) => ({
						type: "text" as const,
						text: repeatedBlock,
						textSignature: JSON.stringify({ v: 1, id: `msg-${index}`, phase: "commentary" }),
					})),
				},
				{ content: [] },
			],
		});
		const contexts: Context[] = [];
		const agent = new Agent({
			appendOnlyContext: new AppendOnlyContextManager(),
			initialState: { model, tools: [] },
			streamFn: (current, context, options) => {
				contexts.push(structuredClone(context));
				return mock.stream(current, context, options);
			},
		});
		const primary: AgentMessage[] = [{ role: "user", content: "first update", timestamp: 1 }];
		const runtime = new AdvisorRuntime(advisorFacade(agent), { snapshotMessages: () => primary });
		const unsubscribe = agent.subscribe(event => {
			if (event.type !== "message_end" || event.message.role !== "assistant") return;
			const message = event.message;
			if (!message.content.some(block => block.type === "text" && block.text === repeatedBlock)) return;
			message.providerPayload = createOpenAIResponsesHistoryPayload(
				model.provider,
				Array.from({ length: 3 }, (_, index) => [
					{ type: "reasoning", id: `rs-${index}`, encrypted_content: "opaque", summary: [] },
					{
						type: "message",
						id: `msg-${index}`,
						role: "assistant",
						phase: "commentary",
						content: [{ type: "output_text", text: repeatedBlock, annotations: [] }],
					},
				]).flat(),
			);
		});
		try {
			runtime.onTurnEnd();
			await settled(runtime);
			primary.push({ role: "user", content: "second update", timestamp: 2 });
			runtime.onTurnEnd();
			await settled(runtime);
			expect(contexts).toHaveLength(2);
			expect(JSON.stringify(contexts[1].messages)).not.toContain(repeatedBlock);
			const replay = buildResponsesInput({
				model,
				context: { messages: defaultConvertToLlm(contexts[1].messages) },
				strictResponsesPairing: true,
				supportsImageDetailOriginal: false,
				nativeHistory: { replay: true, filterReasoning: false },
			});
			expect(JSON.stringify(replay)).not.toContain(repeatedBlock);
			expect(replay.filter(item => item.type === "reasoning")).toEqual([]);
			expect(replay.some(item => "content" in item && JSON.stringify(item.content).includes("second update"))).toBe(
				true,
			);
		} finally {
			unsubscribe();
			runtime.dispose();
		}
	});

	it("preserves signed native history at a compaction boundary", async () => {
		const mock = createMockModel({ handler: { content: [repeatedBlock] } });
		const agent = new Agent({
			initialState: { model: mock, tools: [] },
			streamFn: mock.stream,
		});
		const payload = createOpenAIResponsesHistoryPayload(
			mock.provider,
			[
				{ type: "reasoning", id: "rs-kept", encrypted_content: "opaque", summary: [] },
				{
					type: "message",
					id: "msg-kept",
					role: "assistant",
					content: [{ type: "output_text", text: repeatedBlock, annotations: [] }],
				},
				{ type: "compaction", encrypted_content: "compacted-history" },
			],
			false,
		);
		const signature = JSON.stringify({ v: 1, id: "msg-kept", phase: "final_answer" });
		const unsubscribe = agent.subscribe(event => {
			if (event.type !== "message_end" || event.message.role !== "assistant") return;
			event.message.providerPayload = payload;
			event.message.content = [{ type: "text", text: repeatedBlock, textSignature: signature }];
		});
		const runtime = new AdvisorRuntime(advisorFacade(agent), {
			snapshotMessages: () => [{ role: "user", content: "review update", timestamp: 1 }],
		});
		try {
			runtime.onTurnEnd();
			await settled(runtime);
			const message = agent.state.messages.at(-1);
			if (message?.role !== "assistant") throw new Error("Expected native assistant turn");
			expect(message.providerPayload).toEqual(payload);
			expect(message.content).toEqual([{ type: "text", text: repeatedBlock, textSignature: signature }]);
		} finally {
			unsubscribe();
			runtime.dispose();
		}
	});

	it("completes a guarded five-block text loop silently and drains the review backlog", async () => {
		const mock = createMockModel({ handler: { content: Array.from({ length: 5 }, () => repeatedBlock) } });
		let failures = 0;
		let successes = 0;
		const agent = new Agent({
			initialState: { model: mock, tools: [] },
			streamFn: (model, context, options) =>
				guardThinkingLoopStream(mock.stream(model, context, options), model, new AbortController()),
		});
		const unsubscribe = agent.subscribe(event => {
			if (
				event.type === "message_end" &&
				event.message.role === "assistant" &&
				event.message.loopGuardFailure === "text"
			) {
				event.message.errorMessage = "Repeated assistant output interrupted";
			}
		});
		const runtime = new AdvisorRuntime(
			advisorFacade(agent),
			{
				snapshotMessages: () => [{ role: "user", content: "review this change", timestamp: 1 }],
				onTurnError: () => {
					failures++;
					return false;
				},
				onTurnSuccess: () => {
					successes++;
				},
			},
			0,
		);
		try {
			runtime.onTurnEnd();
			await settled(runtime);
			expect(mock.calls).toHaveLength(1);
			expect(failures).toBe(0);
			expect(successes).toBe(1);
			expect(runtime.backlog).toBe(0);
			expect(runtime.yielded).toBe(true);
			expect(agent.state.error).toBeUndefined();
			expect(agent.state.messages.filter(message => message.role === "assistant")).toEqual([]);
		} finally {
			unsubscribe();
			runtime.dispose();
		}
	});

	it("bounds tool-started loop failures even when every recovery hook reports recovery", async () => {
		const mock = createMockModel({
			handler: {
				content: [
					{ type: "toolCall", id: "read-loop", name: "read", arguments: {} },
					{ type: "thinking", thinking: repeatedBlock.repeat(5) },
				],
			},
		});
		const failures: AssistantMessage[] = [];
		const agent = new Agent({
			initialState: { model: mock, tools: [] },
			streamFn: (model, context, options) =>
				guardThinkingLoopStream(mock.stream(model, context, options), model, new AbortController()),
		});
		const primary: AgentMessage[] = [];
		const runtime = new AdvisorRuntime(
			advisorFacade(agent),
			{
				snapshotMessages: () => primary,
				onTurnError: (_error, messages) => {
					const failure = messages.findLast(
						(message): message is AssistantMessage => message.role === "assistant",
					);
					if (!failure) throw new Error("Expected loop failure");
					failures.push(failure);
					return true;
				},
			},
			0,
		);
		try {
			for (let cycle = 0; cycle < 3; cycle++) {
				primary.push({ role: "user", content: `update ${cycle}`, timestamp: cycle });
				runtime.onTurnEnd();
				await settled(runtime);
				expect(mock.calls).toHaveLength((cycle + 1) * 3);
			}
			expect(failures.every(message => AIError.is(message.errorId, AIError.Flag.ThinkingLoop))).toBe(true);
			expect(runtime.halted).toBe(true);
			primary.push({ role: "user", content: "after halt", timestamp: 4 });
			runtime.onTurnEnd();
			expect(mock.calls).toHaveLength(9);
		} finally {
			runtime.dispose();
		}
	});
});
