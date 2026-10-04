import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { agentLoop } from "@oh-my-pi/pi-agent-core/agent-loop";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	BeforeToolExecutionContext,
} from "@oh-my-pi/pi-agent-core/types";
import type { Message, TextContent } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { createUserMessage } from "./helpers";

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

const echoSchema = type({ value: "string" });

function echoTool(executed: string[], extra: Partial<AgentTool<typeof echoSchema>> = {}): AgentTool<typeof echoSchema> {
	return {
		name: "echo",
		label: "Echo",
		description: "Echo tool",
		parameters: echoSchema,
		...extra,
		async execute(toolCallId) {
			executed.push(toolCallId);
			return { content: [{ type: "text", text: "ok" }], details: {} };
		},
	};
}

function echoCalls(...ids: string[]): MockResponse {
	return { content: ids.map(id => ({ type: "toolCall" as const, id, name: "echo", arguments: { value: id } })) };
}

async function run(
	tool: AgentTool<typeof echoSchema>,
	responses: MockResponse[],
	config: Partial<AgentLoopConfig>,
	signal?: AbortSignal,
): Promise<AgentEvent[]> {
	const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };
	const mock = createMockModel({ responses: [...responses, { content: ["done"] }] });
	const events: AgentEvent[] = [];
	const stream = agentLoop(
		[createUserMessage("go")],
		context,
		{ model: mock.model, convertToLlm: identityConverter, ...config },
		signal,
		mock.stream,
	);
	for await (const event of stream) events.push(event);
	return events;
}

function toolEnd(events: AgentEvent[], toolCallId: string): Extract<AgentEvent, { type: "tool_execution_end" }> {
	const end = events.find(
		(event): event is Extract<AgentEvent, { type: "tool_execution_end" }> =>
			event.type === "tool_execution_end" && event.toolCallId === toolCallId,
	);
	if (!end) throw new Error(`missing tool_execution_end for ${toolCallId}`);
	return end;
}

function resultText(end: Extract<AgentEvent, { type: "tool_execution_end" }>): string {
	const content: { type: string }[] = end.result.content;
	return content.map(part => (part.type === "text" ? (part as TextContent).text : "")).join("");
}

describe("beforeToolExecution", () => {
	it("runs after the assistant message_end and before tool_execution_start and execute", async () => {
		const executed: string[] = [];
		const seenAtHook: string[][] = [];
		const consumed: AgentEvent[] = [];
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [echoTool(executed)] };
		const mock = createMockModel({ responses: [echoCalls("call-1"), { content: ["done"] }] });
		const stream = agentLoop(
			[createUserMessage("go")],
			context,
			{
				model: mock.model,
				convertToLlm: identityConverter,
				beforeToolExecution: async ({ toolCall, assistantMessage }: BeforeToolExecutionContext) => {
					// Let the consumer drain everything the loop pushed before this hook.
					await Bun.sleep(20);
					expect(assistantMessage.content.some(part => part.type === "toolCall")).toBe(true);
					expect(executed).toEqual([]);
					seenAtHook.push(
						consumed.flatMap(event => {
							if (event.type === "message_end" && event.message.role === "assistant") return ["assistant_end"];
							if (event.type === "tool_execution_start") return [`start:${event.toolCallId}`];
							return [];
						}),
					);
					expect(toolCall.id).toBe("call-1");
				},
			},
			undefined,
			mock.stream,
		);
		for await (const event of stream) consumed.push(event);

		expect(seenAtHook).toEqual([["assistant_end"]]);
		expect(executed).toEqual(["call-1"]);
	});

	it("an abort during the wait yields the aborted result and the tool never starts", async () => {
		const executed: string[] = [];
		const controller = new AbortController();
		const events = await run(
			echoTool(executed),
			[echoCalls("call-1")],
			{
				beforeToolExecution: async (_ctx, signal) => {
					const aborted = Promise.withResolvers<void>();
					signal?.addEventListener("abort", () => aborted.resolve(), { once: true });
					controller.abort();
					await aborted.promise;
				},
			},
			controller.signal,
		);

		expect(executed).toEqual([]);
		const end = toolEnd(events, "call-1");
		expect(end.isError).toBe(true);
		expect(resultText(end)).toContain("aborted");
	});

	it("a throw becomes the tool's error result and the tool never starts", async () => {
		const executed: string[] = [];
		const events = await run(echoTool(executed), [echoCalls("call-1")], {
			beforeToolExecution: () => {
				throw new Error("journal unavailable");
			},
		});

		expect(executed).toEqual([]);
		const end = toolEnd(events, "call-1");
		expect(end.isError).toBe(true);
		expect(resultText(end)).toBe("journal unavailable");
	});

	it("is not invoked for calls that fail validation", async () => {
		const executed: string[] = [];
		const hooked: string[] = [];
		const events = await run(
			echoTool(executed),
			[{ content: [{ type: "toolCall", id: "bad", name: "echo", arguments: {} }] }],
			{ beforeToolExecution: ({ toolCall }) => void hooked.push(toolCall.id) },
		);

		expect(hooked).toEqual([]);
		expect(executed).toEqual([]);
		expect(toolEnd(events, "bad").isError).toBe(true);
	});

	it("is not invoked for interruptible calls skipped by queued steering", async () => {
		const executed: string[] = [];
		const hooked: string[] = [];
		let delivered = false;
		const events = await run(
			echoTool(executed, { concurrency: "exclusive", interruptible: true }),
			[echoCalls("call-1", "call-2")],
			{
				interruptMode: "immediate",
				hasSteeringMessages: () => executed.length >= 1 && !delivered,
				getSteeringMessages: async () => {
					if (executed.length < 1 || delivered) return [];
					delivered = true;
					return [createUserMessage("interrupt")];
				},
				beforeToolExecution: ({ toolCall }) => void hooked.push(toolCall.id),
			},
		);

		expect(executed).toEqual(["call-1"]);
		expect(hooked).toEqual(["call-1"]);
		expect(toolEnd(events, "call-2").result.details).toMatchObject({ source: "interrupt_skipped" });
	});
	it("is not invoked for blocked calls or calls naming no tool", async () => {
		const executed: string[] = [];
		const hooked: string[] = [];
		const events = await run(
			echoTool(executed),
			[
				{
					content: [
						{ type: "toolCall", id: "blocked", name: "echo", arguments: { value: "x" } },
						{ type: "toolCall", id: "missing", name: "no_such_tool", arguments: {} },
					],
				},
			],
			{
				beforeToolCall: async () => ({ block: true, reason: "policy" }),
				beforeToolExecution: ({ toolCall }) => void hooked.push(toolCall.id),
			},
		);

		expect(hooked).toEqual([]);
		expect(executed).toEqual([]);
		expect(toolEnd(events, "blocked").isError).toBe(true);
		expect(toolEnd(events, "missing").isError).toBe(true);
	});

	it("skips an interruptible call when steering is queued while the hook waits", async () => {
		const executed: string[] = [];
		let steeringQueued = false;
		let delivered = false;
		const events = await run(echoTool(executed, { interruptible: true }), [echoCalls("call-1")], {
			interruptMode: "immediate",
			hasSteeringMessages: () => steeringQueued && !delivered,
			getSteeringMessages: async () => {
				if (!steeringQueued || delivered) return [];
				delivered = true;
				return [createUserMessage("interrupt")];
			},
			beforeToolExecution: async () => {
				steeringQueued = true;
				// Outlast one 250 ms steering poll so the loop observes the queued message.
				await Bun.sleep(400);
			},
		});

		expect(executed).toEqual([]);
		expect(toolEnd(events, "call-1").result.details).toMatchObject({ source: "interrupt_skipped" });
	});
});
