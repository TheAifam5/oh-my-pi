import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import {
	CACHE_HIT_RATE_WINDOW_MS,
	type CacheEntry,
	cacheEntryOf,
} from "@oh-my-pi/pi-coding-agent/session/cache-ledger";
import { TempDir } from "@oh-my-pi/pi-utils";

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;
const BASE_URL = "https://api.example.com/v1";

function entry(atMs: number, extra: Partial<CacheEntry> = {}): CacheEntry {
	return {
		atMs,
		provider: "anthropic",
		model: "claude",
		baseUrl: BASE_URL,
		inputTokens: 10,
		cacheReadTokens: 60,
		cacheWriteTokens: 30,
		...extra,
	};
}

function message(usage: Partial<AssistantMessage["usage"]>): AssistantMessage {
	return {
		role: "assistant",
		provider: "anthropic",
		model: "claude",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			...usage,
		},
	} as AssistantMessage;
}

describe("cache ledger", () => {
	let tempDir: TempDir;
	let dbPath: string;

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-cache-ledger-");
		dbPath = path.join(tempDir.path(), "agent.db");
	});

	afterEach(() => {
		AgentStorage.close();
		tempDir.removeSync();
	});

	it("rates only the calls of the model and endpoint inside (sinceMs, nowMs]", async () => {
		const { cacheLedger } = await AgentStorage.open(dbPath);
		cacheLedger.record(entry(NOW - 100));
		cacheLedger.record(entry(NOW, { inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 }));
		cacheLedger.record(entry(NOW - 1_000, { cacheReadTokens: 1_000 }));
		cacheLedger.record(entry(NOW + 1, { cacheReadTokens: 1_000 }));
		cacheLedger.record(entry(NOW - 10, { model: "other", cacheReadTokens: 1_000 }));
		cacheLedger.record(entry(NOW - 10, { baseUrl: "https://proxy.example.com", cacheReadTokens: 1_000 }));
		cacheLedger.record(entry(NOW - 10, { baseUrl: undefined, inputTokens: 0, cacheWriteTokens: 0 }));

		expect(cacheLedger.cacheHitRate("anthropic", "claude", BASE_URL, NOW - 1_000, NOW)).toEqual({
			rate: 60 / 200,
			samples: 2,
		});
		expect(cacheLedger.cacheHitRate("anthropic", "claude", undefined, NOW - 1_000, NOW)).toEqual({
			rate: 1,
			samples: 1,
		});
		// The default window is the rolling week ending at nowMs.
		expect(cacheLedger.cacheHitRate("anthropic", "claude", BASE_URL, undefined, NOW)?.samples).toBe(3);
		expect(
			cacheLedger.cacheHitRate("anthropic", "claude", BASE_URL, undefined, NOW + CACHE_HIT_RATE_WINDOW_MS),
		).toEqual({ rate: 1_000 / 1_040, samples: 1 });
	});

	it("records calls without cache tokens so the rate can be zero, and skips calls without a prompt", async () => {
		const { cacheLedger } = await AgentStorage.open(dbPath);
		expect(cacheEntryOf(message({}), NOW, BASE_URL)).toBeUndefined();
		expect(cacheEntryOf(message({ output: 5 }), NOW, BASE_URL)).toBeUndefined();
		const uncached = cacheEntryOf(message({ input: 40, output: 5 }), NOW, BASE_URL);
		expect(uncached).toBeDefined();
		cacheLedger.record(uncached as CacheEntry);

		expect(cacheLedger.cacheHitRate("anthropic", "claude", BASE_URL, NOW - 1, NOW)).toEqual({ rate: 0, samples: 1 });
	});

	it("prunes calls older than the retention period while recording", async () => {
		const { cacheLedger } = await AgentStorage.open(dbPath);
		cacheLedger.record(entry(NOW - 2 * HOUR, { cacheReadTokens: 1_000 }));
		cacheLedger.record(entry(NOW - HOUR / 2, { cacheReadTokens: 1_000 }));
		for (let index = 0; index < 64; index++) cacheLedger.record(entry(NOW), HOUR);

		expect(cacheLedger.cacheHitRate("anthropic", "claude", BASE_URL, 0, NOW)?.samples).toBe(65);
	});

	it("has no rate without matching calls or when they reported no prompt tokens", async () => {
		const { cacheLedger } = await AgentStorage.open(dbPath);
		expect(cacheLedger.cacheHitRate("anthropic", "claude", BASE_URL, NOW - 1_000, NOW)).toBeUndefined();

		cacheLedger.record(entry(NOW, { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }));
		expect(cacheLedger.cacheHitRate("anthropic", "claude", BASE_URL, NOW - 1_000, NOW)).toBeUndefined();
	});

	it("has no rate when the ledger cannot be read", async () => {
		const { cacheLedger } = await AgentStorage.open(dbPath);
		cacheLedger.record(entry(NOW));
		const other = new Database(dbPath);
		other.run("DROP TABLE cache_usage_ledger");
		other.close();

		expect(cacheLedger.cacheHitRate("anthropic", "claude", BASE_URL, NOW - 1_000, NOW)).toBeUndefined();
	});

	it("adds the ledger to an agent.db written before it existed without touching its data", async () => {
		const before = await AgentStorage.open(dbPath);
		before.usageLedger.record({
			atMs: NOW,
			provider: "anthropic",
			model: "claude",
			costNanos: 7,
			inputTokens: 1,
			outputTokens: 1,
		});
		AgentStorage.close();
		const legacy = new Database(dbPath);
		legacy.run("DROP TABLE cache_usage_ledger");
		legacy.close();

		const reopened = await AgentStorage.open(dbPath);
		reopened.cacheLedger.record(entry(NOW));

		expect(reopened.usageLedger.totals([{}], 0).costNanos).toBe(7n);
		expect(reopened.cacheLedger.cacheHitRate("anthropic", "claude", BASE_URL, NOW - 1, NOW)?.samples).toBe(1);
	});
});
