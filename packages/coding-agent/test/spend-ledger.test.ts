import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { Database } from "bun:sqlite";
import { type SpendEntry, usdToNanos } from "@oh-my-pi/pi-coding-agent/session/spend-ledger";
import { TempDir } from "@oh-my-pi/pi-utils";

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;
const WRITER_PROBE = path.join(import.meta.dir, "fixtures", "spend-ledger-writer-probe.ts");

function entry(budgetId: string, atMs: number, costNanos: number): SpendEntry {
	return {
		atMs,
		budgetId,
		owner: "engineer",
		member: "openai/gpt-4o-mini",
		provider: "openai",
		model: "gpt-4o-mini",
		costNanos,
	};
}

describe("spend ledger", () => {
	let tempDir: TempDir;
	let dbPath: string;

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-spend-ledger-");
		dbPath = path.join(tempDir.path(), "agent.db");
	});

	afterEach(() => {
		AgentStorage.close();
		tempDir.removeSync();
	});

	it("sums only the budget's charges inside the rolling window ending now", async () => {
		const { spendLedger } = await AgentStorage.open(dbPath);
		spendLedger.record(entry("daily", NOW - 25 * HOUR, 1_000));
		spendLedger.record(entry("daily", NOW - 24 * HOUR, 2_000));
		spendLedger.record(entry("daily", NOW - HOUR, 30_000));
		spendLedger.record(entry("other", NOW - HOUR, 400_000));
		// Another process's clock running ahead still counts against the window.
		spendLedger.record(entry("daily", NOW + 1_000, 5));

		expect(spendLedger.spentInWindow("daily", 24 * HOUR, NOW)).toBe(30_005n);
		expect(spendLedger.spentInWindow("daily", 48 * HOUR, NOW)).toBe(33_005n);
		expect(spendLedger.spentInWindow("missing", 24 * HOUR, NOW)).toBe(0n);
	});

	it("prunes charges older than the retention period while recording", async () => {
		const { spendLedger } = await AgentStorage.open(dbPath);
		spendLedger.record(entry("daily", NOW - 72 * HOUR, 1_000_000));
		for (let index = 0; index < 200; index++) spendLedger.record(entry("daily", NOW, 1), 48 * HOUR);

		expect(spendLedger.spentInWindow("daily", 96 * HOUR, NOW)).toBe(200n);
		expect(spendLedger.prune(NOW + 1)).toBe(200);
	});

	it("adds the ledger to an agent.db written before it existed without touching its data", async () => {
		const before = await AgentStorage.open(dbPath);
		before.recordModelUsage("openai/gpt-4o-mini");
		AgentStorage.close();
		// An agent.db from a binary that predates the ledger has no spend tables.
		const legacy = new Database(dbPath);
		legacy.run("DROP TABLE spend_ledger");
		legacy.close();

		const reopened = await AgentStorage.open(dbPath);
		reopened.spendLedger.record(entry("daily", NOW, 3));

		expect(reopened.getModelUsageOrder()).toEqual(["openai/gpt-4o-mini"]);
		expect(reopened.spendLedger.spentInWindow("daily", HOUR, NOW)).toBe(3n);
	});

	it("loses no charge when several processes create and record into one database at once", async () => {
		const writers = 4;
		const perWriter = 50;
		const children = Array.from({ length: writers }, () =>
			Bun.spawn([process.execPath, WRITER_PROBE, dbPath, String(perWriter), "shared"], {
				// Workspace imports in the probe resolve from its own location; cwd pins the package root.
				cwd: path.join(import.meta.dir, ".."),
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			}),
		);
		const results = await Promise.all(
			children.map(async child => ({ code: await child.exited, stderr: await new Response(child.stderr).text() })),
		);

		expect(results.filter(result => result.code !== 0)).toEqual([]);
		const { spendLedger } = await AgentStorage.open(dbPath);
		expect(spendLedger.spentInWindow("shared", HOUR, Date.now())).toBe(BigInt(writers * perWriter));
	}, 30_000);
});

describe("call cost conversion", () => {
	it("converts USD to nano-USD exactly, rounding sub-nano remainders up", () => {
		expect(usdToNanos(0)).toBe(0);
		expect(usdToNanos(0.0012)).toBe(1_200_000);
		expect(usdToNanos(1e-9)).toBe(1);
		expect(usdToNanos(1e-12)).toBe(1);
		expect(usdToNanos(12.5)).toBe(12_500_000_000);
	});

	it("rejects costs that cannot be charged", () => {
		for (const cost of [Number.NaN, Number.POSITIVE_INFINITY, -0.01, 1e10]) {
			expect(usdToNanos(cost)).toBeUndefined();
		}
	});
});
