import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { classify, Flag, is } from "../src/error/flags";
import { isProviderRetryableError } from "../src/error/retryable";
import {
	ANTHROPIC_SPEND_LIMIT_MAX_BLOCK_MS,
	calculateRateLimitBackoffMs,
	isAnthropicUserSpendLimitMessage,
	isUsageLimitOutcome,
	parseRateLimitReason,
} from "../src/error/rate-limit";
import { extractProviderRetryHint } from "../src/utils/retry-after";
import { removeWithRetries } from "../../utils/src/temp";

const NOW = Date.UTC(2026, 9, 20, 15, 30);
const NEXT_MONTH = Date.UTC(2026, 10, 1);
const NEXT_UTC_DAY = Date.UTC(2026, 9, 21);

function body(error: Record<string, unknown>): string {
	return JSON.stringify({ type: "error", error, request_id: "req_test" });
}

/** The documented tier spend-cap 429; its message here deliberately avoids any usage-limit wording. */
function tierCap(message = "Your organization is paused until 2026-11-01."): string {
	return `429 ${body({ type: "rate_limit_error", message, details: { error_code: "enforced_spend_limit_reached" } })}`;
}

function userLimit(message: string): string {
	return `400 ${body({ type: "invalid_request_error", message })}`;
}

function httpError(message: string): Error {
	return Object.assign(new Error(message), { status: Number(message.slice(0, 3)) });
}

describe("Anthropic spend-limit classification", () => {
	beforeEach(() => setSystemTime(NOW));
	afterEach(() => setSystemTime());

	test("the tier cap is recognized by its error code alone and is a non-retryable usage limit", () => {
		const message = tierCap();
		expect(parseRateLimitReason(message)).toBe("SPEND_LIMIT_REACHED");
		expect(isUsageLimitOutcome(429, message)).toBe(true);
		expect(is(classify(httpError(message)), Flag.UsageLimit)).toBe(true);
		expect(isProviderRetryableError(httpError(message))).toBe(false);
	});

	test("a self-set or workspace spend limit 400 is a usage limit; other invalid requests are not", () => {
		for (const message of [
			userLimit(
				"You have reached your specified API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.",
			),
			userLimit("You have reached your specified workspace API usage limits."),
		]) {
			expect(parseRateLimitReason(message)).toBe("SPEND_LIMIT_REACHED");
			expect(is(classify(httpError(message)), Flag.UsageLimit)).toBe(true);
			expect(isProviderRetryableError(httpError(message))).toBe(false);
		}
		const badRequest = userLimit("messages: text content blocks must be non-empty");
		expect(parseRateLimitReason(badRequest)).not.toBe("SPEND_LIMIT_REACHED");
		expect(is(classify(httpError(badRequest)), Flag.UsageLimit)).toBe(false);
		// The sentence only counts as an invalid_request_error message.
		const otherType = `400 ${body({ type: "api_error", message: "You have reached your specified API usage limits." })}`;
		expect(parseRateLimitReason(otherType)).not.toBe("SPEND_LIMIT_REACHED");
	});

	test("an envelope quoted inside other error text (model output in a tool-call error) is not a spend limit", () => {
		const envelope = tierCap().slice(4);
		for (const message of [
			`500 Failed to parse tool call arguments: ${envelope}`,
			`Refusal: ${envelope}`,
			`429 ${JSON.stringify({ error: { details: { error_code: "enforced_spend_limit_reached" } } })}`,
		]) {
			expect(parseRateLimitReason(message)).not.toBe("SPEND_LIMIT_REACHED");
			expect(extractProviderRetryHint("anthropic", message)).toBeUndefined();
		}
	});

	test("the self-set limit sentence matches only at the start of the message", () => {
		expect(isAnthropicUserSpendLimitMessage("You have reached your specified API usage limits.")).toBe(true);
		expect(isAnthropicUserSpendLimitMessage("You have reached your specified workspace API usage limits.")).toBe(
			true,
		);
		expect(isAnthropicUserSpendLimitMessage("Note: You have reached your specified API usage limits.")).toBe(false);
		expect(isAnthropicUserSpendLimitMessage("You have reached your API usage limits.")).toBe(false);
	});

	test("the retry hint is the stated resume instant, else the next month for the tier cap, else none", () => {
		const stated = "You have reached your API usage limits. You will regain access on 2026-10-25 at 06:00 UTC.";
		expect(extractProviderRetryHint("anthropic", tierCap(stated))).toBe(Date.UTC(2026, 9, 25, 6) - NOW);
		expect(extractProviderRetryHint("anthropic", tierCap())).toBe(NEXT_MONTH - NOW);
		expect(
			extractProviderRetryHint(
				"anthropic",
				userLimit(
					"You have reached your specified API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.",
				),
			),
		).toBe(NEXT_MONTH - NOW);
		// A self-set limit stating no instant has no provider timing; the backoff guess holds it to the next UTC day.
		const unstated = userLimit("You have reached your specified API usage limits.");
		expect(extractProviderRetryHint("anthropic", unstated)).toBeUndefined();
		expect(calculateRateLimitBackoffMs(parseRateLimitReason(unstated))).toBe(NEXT_UTC_DAY - NOW);
	});
});

test("a far-future stated resume instant blocks no longer than the cap", () => {
	setSystemTime(NOW);
	try {
		const farFuture = tierCap(
			"You have reached your API usage limits. You will regain access on 9999-12-31 at 00:00 UTC.",
		);
		expect(extractProviderRetryHint("anthropic", farFuture)).toBe(ANTHROPIC_SPEND_LIMIT_MAX_BLOCK_MS);
	} finally {
		setSystemTime();
	}
});

describe("AuthStorage rotation on an Anthropic spend limit", () => {
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
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-anthropic-spend-limit-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		storage = new AuthStorage(store, { usageFetch });
		usageRequests.length = 0;
		await storage.credentials.set("anthropic", [
			{ type: "api_key", key: "sk-ant-api03-first", source: "login" },
			{ type: "api_key", key: "sk-ant-api03-second", source: "login" },
		]);
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

	function liveBlocks(key: string) {
		if (!store) throw new Error("test setup failed");
		const row = store
			.listAuthCredentials("anthropic")
			.find(entry => entry.credential.type === "api_key" && entry.credential.key === key);
		if (!row) throw new Error(`credential ${key} missing`);
		return store
			.listCredentialBlocks([row.id])
			.filter(block => block.blockedUntilMs > Date.now())
			.map(({ blockScope, blockedUntilMs }) => ({ blockScope, blockedUntilMs }));
	}

	test("the tier cap moves the session to the sibling key and blocks the spent key until the next month", async () => {
		if (!storage) throw new Error("test setup failed");
		const modelId = "claude-sonnet-4-5";
		const spent = await storage.keys.get("anthropic", "s1", { modelId });
		const sibling = spent === "sk-ant-api03-first" ? "sk-ant-api03-second" : "sk-ant-api03-first";
		if (!spent) throw new Error("no key resolved");

		const rotation = await storage.limits.rotate("anthropic", "s1", { error: httpError(tierCap()), modelId });

		expect(rotation.switched).toBe(true);
		expect(liveBlocks(spent)).toEqual([{ blockScope: "", blockedUntilMs: NEXT_MONTH }]);
		expect(liveBlocks(sibling)).toEqual([]);
		expect(await storage.keys.get("anthropic", "s1", { modelId })).toBe(sibling);
		// An API key has no usage endpoint, so recording the block sent no request.
		expect(usageRequests).toEqual([]);
	});
});
