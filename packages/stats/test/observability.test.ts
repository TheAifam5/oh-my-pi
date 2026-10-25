import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getAgentDbPath } from "@oh-my-pi/pi-utils";
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { initDb } from "../src/db";
import { getObservabilityStats, headroom, percentile, replayFindings } from "../src/observability";
import type { FindingSnapshot, HeadroomPolicy } from "../src/observability-types";
import { handleApi, startServer } from "../src/server";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-observability-");

function finding(status: string, by?: string): FindingSnapshot["findings"][number] {
	return {
		id: "F1",
		status,
		severity: "blocker",
		category: "correctness",
		owner: "reviewer",
		createdTurn: 1,
		resolution: status === "resolved" ? { by, turn: 4 } : undefined,
	};
}

it("compares branch snapshots with their ancestor rather than the previous physical entry", () => {
	const result = replayFindings([
		{ id: "a", parentId: null, turn: 1, findings: [finding("open")] },
		{ id: "b", parentId: "a", turn: 4, findings: [finding("resolved", "user")] },
		{ id: "c", parentId: "a", turn: 2, findings: [finding("open")] },
	]);
	expect(result.resolved).toEqual({ user: 1 });
	expect(result.reopened).toBe(0);
	expect(result.open[0]?.count).toBe(1);
});

describe("finding snapshot replay", () => {
	it("counts transitions once, normalizes resolvers and retains reopened history", () => {
		const result = replayFindings([
			{ turn: 1, findings: [finding("open")] },
			{ turn: 4, findings: [finding("resolved", "user")] },
			{ turn: 4, findings: [finding("resolved", "user")] },
			{ turn: 5, findings: [finding("open")] },
			{ turn: 6, findings: [finding("resolved", "reviewer")] },
		]);
		expect(result.observed).toBe(1);
		expect(result.resolved).toEqual({ user: 1, advisor: 1 });
		expect(result.reopened).toBe(1);
		expect(result.turns).toEqual([3, 3]);
		expect(result.resolvedConcerns).toBe(2);
		expect(result.open).toEqual([]);
	});
	it("keeps v1 actors unknown, expiry separate and disappearance unresolved", () => {
		const result = replayFindings([
			{ turn: 1, findings: [finding("open")] },
			{ turn: 4, findings: [finding("resolved")] },
			{ turn: 5, findings: [finding("open")] },
			{ turn: 55, findings: [finding("expired")] },
			{ turn: 56, findings: [] },
		]);
		expect(result.resolved).toEqual({ unknown: 1 });
		expect(result.expired).toBe(1);
	});
	it("uses a pre-range baseline and separates reset epochs", () => {
		const result = replayFindings(
			[
				{ turn: 1, timestamp: 10, findings: [finding("open")] },
				{ turn: 4, timestamp: 30, findings: [finding("resolved", "agent")] },
				{ turn: 0, timestamp: 40, findings: [finding("open")] },
			],
			20,
		);
		expect(result.resolved).toEqual({ agent: 1 });
		expect(result.reopened).toBe(0);
		expect(result.observed).toBe(2);
		expect(result.open[0]?.count).toBe(1);
	});
	it("does not invent resolution from compaction, eviction or merge disappearance", () => {
		const result = replayFindings([
			{ turn: 1, findings: [finding("open")] },
			{ turn: 2, findings: [] },
		]);
		expect(result.resolved).toEqual({});
		expect(result.expired).toBe(0);
	});
});

describe("budget and limit counters", () => {
	it("counts overlapping scopes once and reports rolling recovery and previous usage", () => {
		const database = new Database(":memory:");
		try {
			database.run(
				"CREATE TABLE usage_ledger (at_ms INTEGER, provider TEXT, model TEXT, pool TEXT, account TEXT, cost_nanos INTEGER, input_tokens INTEGER, output_tokens INTEGER)",
			);
			database.run(
				"INSERT INTO usage_ledger VALUES (950, 'p', 'm', 'role:r', NULL, 1000000000, 20, 30), (850, 'p', 'm', NULL, NULL, 2000000000, 1, 2)",
			);
			const policy: HeadroomPolicy = {
				label: "Shared",
				limit: { metric: "usd", max: "5", window: { type: "rolling", durationMs: 100 }, onLimit: "skip" },
				scopes: [{ provider: "p" }, { model: "m" }],
			};
			const row = headroom(database, [policy], 1000)[0];
			expect(row?.used).toBe(1);
			expect(row?.previous).toBe(2);
			expect(row?.samples).toBe(1);
			expect(row?.recoveryAt).toBe(1050);
			expect(row?.resetAt).toBeNull();
		} finally {
			database.close();
		}
	});
	it("keeps absent ledgers and provider-only evidence unknown instead of zero", () => {
		const policies: HeadroomPolicy[] = [
			{
				label: "Requests",
				limit: { metric: "requests", max: 5, window: { type: "calendar", period: "day" }, onLimit: "skip" },
				scopes: [{}],
			},
			{ label: "Credits", limit: { metric: "credits", max: "5", onLimit: "skip" }, scopes: [] },
		];
		expect(headroom(undefined, policies, Date.now()).map(row => row.used)).toEqual([null, null]);
	});
});

it("computes nearest-rank percentiles with explicit empty samples", () => {
	expect(percentile([], 0.95)).toBeNull();
	expect(percentile([9, 1, 5], 0.5)).toBe(5);
	expect(percentile([9, 1, 5], 0.95)).toBe(9);
});

it("refuses sensitive reads on non-loopback bindings even through a loopback request URL", async () => {
	const response = await handleApi(new Request("http://127.0.0.1/api/stats/observability"), "0.0.0.0");
	expect(response.status).toBe(403);
	const server = await startServer(0, "0.0.0.0");
	try {
		const response = await fetch(`http://127.0.0.1:${server.port}/api/stats/observability`);
		expect(response.status).toBe(403);
	} finally {
		server.stop();
	}
});

it("serves explicit empty coverage with no source ledgers", async () => {
	const result = await getObservabilityStats("24h");
	expect(result.ledgerAvailable).toBe(false);
	expect(result.routing).toEqual([]);
	expect(result.findings.observed).toBe(0);
	expect(result.models).toEqual([]);
});

it("uses the Overview cache hit-rate definition and excludes writes from its denominator", async () => {
	const database = await initDb();
	database
		.query(`
		INSERT INTO messages (
			session_file, entry_id, folder, model, provider, api, timestamp, stop_reason,
			input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens,
			premium_requests, cost_input, cost_output, cost_cache_read, cost_cache_write, cost_total
		) VALUES ('cache-definition', 'entry', '', 'Example', 'Provider', 'test', ?, 'stop',
			10, 0, 80, 10, 100, 0, 0, 0, 0, 0, 0)
	`)
		.run(Date.now());
	const result = await getObservabilityStats("24h");
	expect(result.cacheModels).toHaveLength(1);
	expect(result.cacheModels[0]?.hitRate).toBeCloseTo(80 / 90);
});

it("returns read-only served-call aggregates without account identities", async () => {
	mkdirSync(dirname(getAgentDbPath()), { recursive: true });
	const ledger = new Database(getAgentDbPath());
	try {
		ledger.run(
			"CREATE TABLE usage_ledger (at_ms INTEGER, provider TEXT, model TEXT, account TEXT, pool TEXT, cost_nanos INTEGER, input_tokens INTEGER, output_tokens INTEGER)",
		);
		ledger
			.query(
				"INSERT INTO usage_ledger VALUES (?, 'p', 'm', 'secret@example.invalid', 'role:test', 1000000000, 20, 30), (?, 'p', 'm', NULL, NULL, 2000000000, 10, 10)",
			)
			.run(Date.now(), Date.now());
		const response = await handleApi(
			new Request("http://127.0.0.1/api/stats/observability?range=24h", { headers: { Host: "127.0.0.1" } }),
			"127.0.0.1",
		);
		expect(response.status).toBe(200);
		const serialized = await response.text();
		expect(serialized.includes("secret@example.invalid")).toBe(false);
		const result = JSON.parse(serialized) as {
			routing: { requests: number; cost: number; tokens: number; account: string; pool: string }[];
		};
		expect(result.routing.reduce((sum, row) => sum + row.requests, 0)).toBe(2);
		expect(result.routing.reduce((sum, row) => sum + row.cost, 0)).toBe(3);
		expect(result.routing.reduce((sum, row) => sum + row.tokens, 0)).toBe(70);
		expect(result.routing.some(row => row.account === "Unknown account" && row.pool === "No pool")).toBe(true);
		expect(ledger.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM usage_ledger").get()?.count).toBe(2);
	} finally {
		ledger.close();
	}
});

it("rejects rebinding Hosts, foreign Origins and wrong ports on sensitive endpoints", async () => {
	const origin = "http://127.0.0.1:3847";
	for (const endpoint of ["/api/stats/observability", "/api/frustration/judge", "/api/sync"]) {
		const method = endpoint === "/api/stats/observability" ? "GET" : "POST";
		for (const headers of [
			{ Host: "attacker.invalid:3847" },
			{ Host: "127.0.0.1:9999" },
			{ Origin: "http://attacker.invalid" },
			{ Origin: "http://127.0.0.1:9999" },
			{ Origin: "null" },
		]) {
			const response = await handleApi(new Request(`${origin}${endpoint}`, { method, headers }), "127.0.0.1", 3847);
			expect(response.status).toBe(403);
		}
		expect(
			(await handleApi(new Request(`http://attacker.invalid:3847${endpoint}`, { method }), "127.0.0.1", 3847))
				.status,
		).toBe(403);
	}
	const accepted = await handleApi(
		new Request(`${origin}/api/stats/observability`, {
			headers: { Host: "127.0.0.1:3847", Origin: origin },
		}),
		"127.0.0.1",
		3847,
	);
	expect(accepted.status).toBe(200);
});

it("derives timestamped resolution durations across baselines, branches and reopened findings", () => {
	const result = replayFindings(
		[
			{ id: "a", parentId: null, turn: 1, timestamp: 1000, findings: [finding("open")] },
			{ id: "b", parentId: "a", turn: 4, timestamp: 61000, findings: [finding("resolved", "user")] },
			{ id: "c", parentId: "b", turn: 5, timestamp: 121000, findings: [finding("open")] },
			{ id: "d", parentId: "c", turn: 6, timestamp: 151000, findings: [finding("resolved", "agent")] },
		],
		2000,
	);
	expect(result.durationsMs).toEqual([60000, 30000]);
	expect(result.rows).toEqual([
		{ severity: "blocker", category: "correctness", owner: "reviewer", status: "resolved", count: 1 },
	]);
	expect(
		replayFindings([
			{ turn: 1, findings: [finding("open")] },
			{ turn: 4, timestamp: 61000, findings: [finding("resolved", "user")] },
		]).durationsMs,
	).toEqual([]);
});
