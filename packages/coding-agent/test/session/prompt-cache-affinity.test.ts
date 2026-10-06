import { describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { PromptCacheAffinity } from "@oh-my-pi/pi-coding-agent/session/prompt-cache-affinity";

describe("PromptCacheAffinity", () => {
	it("keeps a GPT-5.6 cache read warm for OpenAI's declared 30-minute lifetime", () => {
		const model = getBundledModel("openai", "gpt-5.6");
		const t0 = 1_000_000;
		const message: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 10,
				output: 10,
				cacheRead: 5000,
				cacheWrite: 0,
				totalTokens: 5020,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: t0,
		};
		const affinity = new PromptCacheAffinity();
		affinity.observe(message, model, t0);
		expect(affinity.isWarm(model, t0 + 1_799_000)).toBe(true);
		expect(affinity.isWarm(model, t0 + 1_800_000)).toBe(false);
	});
});
