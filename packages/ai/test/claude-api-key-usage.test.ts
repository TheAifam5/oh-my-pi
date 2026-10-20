import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { claudeBilling, parseClaudeApiKeyRateLimitHeaders, parseClaudeRateLimitHeaders } from "../src/usage/claude";
import { removeWithRetries } from "../../utils/src/temp";

const NOW = Date.UTC(2026, 9, 20, 15, 30);
const RESET = "2026-10-20T15:30:40Z";

/** Response headers of a request served with a Console API key. */
function apiKeyHeaders(overrides: Record<string, string> = {}): Record<string, string> {
	return {
		"anthropic-ratelimit-requests-limit": "1000",
		"anthropic-ratelimit-requests-remaining": "999",
		"anthropic-ratelimit-requests-reset": RESET,
		"anthropic-ratelimit-tokens-limit": "2400000",
		"anthropic-ratelimit-tokens-remaining": "2394000",
		"anthropic-ratelimit-tokens-reset": RESET,
		"anthropic-ratelimit-input-tokens-limit": "2000000",
		"anthropic-ratelimit-input-tokens-remaining": "1995000",
		"anthropic-ratelimit-input-tokens-reset": RESET,
		"anthropic-ratelimit-output-tokens-limit": "400000",
		"anthropic-ratelimit-output-tokens-remaining": "0",
		"anthropic-ratelimit-output-tokens-reset": RESET,
		"anthropic-organization-id": "org-test",
		...overrides,
	};
}

describe("Claude API-key rate-limit headers", () => {
	test("each per-minute bucket becomes a limit with its counts and RFC 3339 refill time", () => {
		const report = parseClaudeApiKeyRateLimitHeaders(apiKeyHeaders(), NOW);
		expect(report?.fetchedAt).toBe(NOW);
		const byId = new Map(report?.limits.map(limit => [limit.id, limit]));
		expect([...byId.keys()]).toEqual([
			"anthropic:api-key:requests",
			"anthropic:api-key:tokens",
			"anthropic:api-key:input-tokens",
			"anthropic:api-key:output-tokens",
		]);
		expect(byId.get("anthropic:api-key:requests")).toMatchObject({
			amount: { used: 1, limit: 1000, remaining: 999, unit: "requests" },
			window: { durationMs: 60_000, resetsAt: Date.parse(RESET) },
			status: "ok",
		});
		expect(byId.get("anthropic:api-key:output-tokens")).toMatchObject({
			amount: { used: 400000, limit: 400000, remaining: 0, unit: "tokens", usedFraction: 1 },
			status: "exhausted",
		});
		// Informational only: no limit is shared or tier-scoped, so none gates a request.
		expect(report?.limits.every(limit => limit.scope.shared !== true && limit.scope.tier === undefined)).toBe(true);
	});

	test("buckets without a positive limit and a remaining count are skipped; none at all yields no report", () => {
		const partial = parseClaudeApiKeyRateLimitHeaders(
			apiKeyHeaders({
				"anthropic-ratelimit-tokens-limit": "0",
				"anthropic-ratelimit-input-tokens-remaining": "n/a",
				"anthropic-ratelimit-output-tokens-limit": "",
			}),
			NOW,
		);
		expect(partial?.limits.map(limit => limit.id)).toEqual(["anthropic:api-key:requests"]);
		expect(parseClaudeApiKeyRateLimitHeaders({ "anthropic-organization-id": "org-test" }, NOW)).toBeNull();
	});

	test("headers of requests routed to a gateway or ANTHROPIC_BASE_URL are not trusted", () => {
		expect(
			parseClaudeApiKeyRateLimitHeaders(apiKeyHeaders(), NOW, { baseUrl: "https://gateway.example.com" }),
		).toBeNull();
		expect(
			parseClaudeApiKeyRateLimitHeaders(apiKeyHeaders(), NOW, { baseUrl: "https://api.anthropic.com/v1" }),
		).not.toBeNull();
		const previous = Bun.env.ANTHROPIC_BASE_URL;
		Bun.env.ANTHROPIC_BASE_URL = "https://proxy.example.com";
		try {
			expect(parseClaudeApiKeyRateLimitHeaders(apiKeyHeaders(), NOW)).toBeNull();
		} finally {
			if (previous === undefined) delete Bun.env.ANTHROPIC_BASE_URL;
			else Bun.env.ANTHROPIC_BASE_URL = previous;
		}
	});

	test("an API-key report bills as metered spend in an unknown state; subscription reports keep their sources", () => {
		const apiKeyReport = parseClaudeApiKeyRateLimitHeaders(apiKeyHeaders(), NOW);
		if (!apiKeyReport) throw new Error("no report");
		expect(claudeBilling.readBilling(apiKeyReport)).toEqual({
			status: "known",
			snapshot: { provider: "anthropic", fetchedAt: NOW, sources: [{ mode: "metered", state: "unknown" }] },
		});
		const subscriptionReport = parseClaudeRateLimitHeaders(
			{
				"anthropic-ratelimit-unified-5h-utilization": "0.2",
				"anthropic-ratelimit-unified-5h-reset": String(Math.floor(NOW / 1000) + 3600),
			},
			NOW,
		);
		if (!subscriptionReport) throw new Error("no subscription report");
		const billing = claudeBilling.readBilling(subscriptionReport);
		expect(billing.status === "known" ? billing.snapshot.sources.map(source => source.mode) : []).toEqual([
			"subscription-included",
			"paid-extra-usage",
		]);
	});
});

describe("AuthStorage header ingestion for Anthropic API keys", () => {
	let tempDir = "";
	let store: SqliteAuthCredentialStore | null = null;
	let storage: AuthStorage | null = null;
	const usageRequests: string[] = [];
	const usageFetch = (async (input: string | URL | Request) => {
		usageRequests.push(String(input));
		return new Response("{}", { status: 500 });
	}) as unknown as typeof fetch;

	beforeEach(async () => {
		setSystemTime(NOW);
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-claude-api-key-usage-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		storage = new AuthStorage(store, { usageFetch });
		usageRequests.length = 0;
	});

	afterEach(async () => {
		setSystemTime();
		storage?.close();
		store?.close();
		storage = null;
		store = null;
		if (tempDir) await removeWithRetries(tempDir);
		tempDir = "";
	});

	async function anthropicReports() {
		if (!storage) throw new Error("test setup failed");
		return ((await storage.usage.reports()) ?? []).filter(report => report.provider === "anthropic");
	}

	test("headers from a stored key's response become that key's report without blocking the key", async () => {
		if (!storage) throw new Error("test setup failed");
		await storage.credentials.set("anthropic", [{ type: "api_key", key: "sk-ant-api03-only", source: "login" }]);
		expect(await anthropicReports()).toEqual([]);
		expect(await storage.keys.get("anthropic", "s1")).toBe("sk-ant-api03-only");

		expect(storage.usage.ingestHeaders("anthropic", apiKeyHeaders(), { sessionId: "s1" })).toBe(true);
		await Bun.sleep(0);

		const reports = await anthropicReports();
		expect(reports).toHaveLength(1);
		expect(reports[0]?.limits.map(limit => limit.id)).toContain("anthropic:api-key:output-tokens");
		// A spent per-minute bucket is shown, not enforced: the only key still serves requests.
		expect(await storage.keys.get("anthropic", "s1")).toBe("sk-ant-api03-only");
		// The Anthropic API has no usage endpoint for API keys; nothing was polled.
		expect(usageRequests).toEqual([]);
	});

	test("headers are not attributed to a stored key when the session was served by a runtime key", async () => {
		if (!storage) throw new Error("test setup failed");
		await storage.credentials.set("anthropic", [{ type: "api_key", key: "sk-ant-api03-only", source: "login" }]);
		expect(await storage.keys.get("anthropic", "s1")).toBe("sk-ant-api03-only");
		storage.keys.setRuntime("anthropic", "sk-ant-api03-runtime");

		expect(storage.usage.ingestHeaders("anthropic", apiKeyHeaders(), { sessionId: "s1" })).toBe(false);
	});
});
