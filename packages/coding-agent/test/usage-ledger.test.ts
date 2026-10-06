import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import type { UsageEntry } from "@oh-my-pi/pi-coding-agent/session/usage-ledger";
import { TempDir } from "@oh-my-pi/pi-utils";

const NOW = 1_700_000_000_000;

function entry(provider: string, model: string, atMs: number, extra: Partial<UsageEntry> = {}): UsageEntry {
	return { atMs, provider, model, costNanos: 1_000, inputTokens: 10, outputTokens: 5, ...extra };
}

describe("usage ledger", () => {
	let tempDir: TempDir;

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-usage-ledger-");
	});

	afterEach(() => {
		AgentStorage.close();
		tempDir.removeSync();
	});

	it("counts a call matching several scopes once and only calls inside the window", async () => {
		const { usageLedger } = await AgentStorage.open(path.join(tempDir.path(), "agent.db"));
		usageLedger.record(entry("openai", "gpt-4o-mini", NOW - 10, { account: "work" }));
		usageLedger.record(entry("openai", "gpt-4o", NOW - 10));
		usageLedger.record(entry("anthropic", "claude", NOW - 10, { account: "work" }));
		usageLedger.record(entry("openai", "gpt-4o-mini", NOW - 1_000));

		expect(
			usageLedger.totals([{ provider: "openai" }, { provider: "openai", model: "gpt-4o-mini" }], NOW - 100),
		).toEqual({ costNanos: 2_000n, requests: 2n, tokens: 30n });
		expect(usageLedger.totals([{ account: "work" }], NOW - 100).requests).toBe(2n);
		expect(usageLedger.totals([{}], NOW - 100).requests).toBe(3n);
	});

	it("sees writes by another connection and by itself on the next repeated totals call", async () => {
		const dbPath = path.join(tempDir.path(), "agent.db");
		const { usageLedger } = await AgentStorage.open(dbPath);
		usageLedger.record(entry("openai", "gpt-4o", NOW - 10));
		expect(usageLedger.totals([{ provider: "openai" }], NOW - 100).requests).toBe(1n);

		using other = new Database(dbPath);
		other.run(
			"INSERT INTO usage_ledger (at_ms, provider, model, cost_nanos, input_tokens, output_tokens) VALUES (?, 'openai', 'gpt-4o', 1000, 10, 5)",
			[NOW - 5],
		);
		expect(usageLedger.totals([{ provider: "openai" }], NOW - 100).requests).toBe(2n);

		usageLedger.record(entry("openai", "gpt-4o", NOW - 1));
		expect(usageLedger.totals([{ provider: "openai" }], NOW - 100).requests).toBe(3n);
	});
});
