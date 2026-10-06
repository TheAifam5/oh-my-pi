import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { toModelSpec } from "@oh-my-pi/pi-catalog/provider-models/bundled-references";
import type { Api, ModelSpec } from "@oh-my-pi/pi-catalog/types";

function spec(provider: string, id: string, api: Api = "openai-completions"): ModelSpec<Api> {
	return {
		id,
		name: id,
		api,
		provider,
		baseUrl: "https://example.invalid/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 0 },
		contextWindow: 400_000,
		maxTokens: 128_000,
	};
}

describe("non-Anthropic prompt-cache lifetimes", () => {
	test("OpenAI and Azure declare 30 minutes from GPT-5.6 and 5 minutes before it", () => {
		for (const provider of ["openai", "azure"]) {
			const api: Api = provider === "azure" ? "azure-openai-responses" : "openai-responses";
			const gpt = buildModel(spec(provider, "gpt-5.6", api));
			expect(gpt.promptCache).toEqual({ short: 1800 });
			// Lifetimes alone inform affinity; replay warming stays unvalidated here.
			expect(gpt.promptCacheWarming).toBeUndefined();
			expect(buildModel(spec(provider, "gpt-6-astra", api)).promptCache).toEqual({ short: 1800 });
			expect(buildModel(spec(provider, "gpt-5.5", api)).promptCache).toEqual({ short: 300 });
		}
		expect(buildModel(spec("openai", "daybreak-blue-latest", "openai-responses")).promptCache).toEqual({
			short: 1800,
		});
	});

	test("lifetimes follow the extracted revision, so revision-less ids get none", () => {
		// `gpt-4o` and bare `o3` carry no numeric revision; `o3-mini` extracts 3.
		expect(buildModel(spec("openai", "gpt-4o", "openai-responses")).promptCache).toBeUndefined();
		expect(buildModel(spec("openai", "o3", "openai-responses")).promptCache).toBeUndefined();
		expect(buildModel(spec("openai", "o3-mini", "openai-responses")).promptCache).toEqual({ short: 300 });
	});

	test("Moonshot declares a lifetime for Kimi K3 only", () => {
		const k3 = buildModel(spec("moonshot", "kimi-k3"));
		expect(k3.promptCache).toEqual({ short: 300 });
		expect(k3.promptCacheWarming).toBeUndefined();
		expect(buildModel(spec("moonshot", "kimi-k2.6")).promptCache).toBeUndefined();
	});

	test("other hosts of the same models declare none", () => {
		for (const provider of ["xai", "deepseek", "openrouter", "github-copilot", "openai-codex"]) {
			expect(buildModel(spec(provider, "gpt-5.6")).promptCache).toBeUndefined();
			expect(buildModel(spec(provider, "gpt-5.5")).promptCache).toBeUndefined();
		}
		expect(buildModel(spec("openrouter", "moonshotai/kimi-k3")).promptCache).toBeUndefined();
	});

	test("rows discovered on another host from a bundled reference carry no lifetime or warming opt-in", () => {
		for (const [provider, id] of [
			["openai", "gpt-5.6"],
			["anthropic", "claude-sonnet-4-5"],
		] as const) {
			const reference = toModelSpec(getBundledModel(provider, id));
			expect(reference.promptCache).toBeDefined();
			const copilot = buildModel({
				...reference,
				provider: "github-copilot",
				baseUrl: "https://api.githubcopilot.com",
			});
			expect(copilot.promptCache).toBeUndefined();
			expect(copilot.promptCacheWarming).toBeUndefined();
		}
	});
});
