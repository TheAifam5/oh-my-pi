import { afterEach, describe, expect, it, vi } from "bun:test";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { parseRateLimitReason } from "../src/error/rate-limit";

const model: Model<"anthropic-messages"> = buildModel({
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
});

const context: Context = { messages: [{ role: "user", content: "Hello.", timestamp: 0 }] };

const SPEND_CAP = {
	type: "error",
	error: {
		type: "rate_limit_error",
		message: "You have reached your API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.",
		details: { error_code: "enforced_spend_limit_reached" },
	},
};
const USER_LIMIT = {
	type: "error",
	error: { type: "invalid_request_error", message: "You have reached your specified API usage limits." },
};

afterEach(() => vi.restoreAllMocks());

describe("Anthropic provider on a spend limit", () => {
	it.each([
		["the tier cap 429", 429, SPEND_CAP],
		["a self-set limit 400", 400, USER_LIMIT],
	])("sends %s once and surfaces it as a spend limit", async (_name, status, body) => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation((async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch);

		const result = await streamAnthropic(model, context, { apiKey: "sk-ant-api03-test" }).result();

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(status);
		expect(parseRateLimitReason(result.errorMessage ?? "")).toBe("SPEND_LIMIT_REACHED");
	});
});
