import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, type AuthStorageOptions, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { USAGE_REPORT_TTL_MS } from "@oh-my-pi/pi-ai/auth/sqlite-credential-store";
import {
	limitResetAt,
	OPENROUTER_FREE_BLOCK_SCOPE,
	OPENROUTER_FREE_QUOTA_BLOCK_SCOPE,
	OPENROUTER_KEY_CAP_BLOCK_SCOPE,
	openrouterRankingStrategy,
} from "@oh-my-pi/pi-ai/usage/openrouter";
import { removeWithRetries } from "../../utils/src/temp";

const FREE_MODEL = "meta-llama/llama-3.3-70b-instruct:free";
const PAID_MODEL = "meta-llama/llama-3.3-70b-instruct";
const NOW = Date.UTC(2026, 9, 20, 15, 30);
/** Past every jittered usage-cache expiry and the block's probe window, well before midnight UTC. */
const AFTER_PROBE_WINDOW = NOW + 2 * USAGE_REPORT_TTL_MS;

type FreeCounter = { used: number; limit: number; remaining: number };

/** A `GET /key` body with a monthly USD cap (`capRemaining` of $100) and the account's free-model counter. */
function keyBody(capRemaining: number, free: FreeCounter, capLimit = 100) {
	return {
		data: {
			label: "k",
			limit: capLimit,
			limit_remaining: capRemaining,
			limit_reset: "monthly",
			is_free_tier: false,
			is_management_key: false,
			free_model_daily_requests: free,
		},
	};
}

const SPENT_FREE: FreeCounter = { used: 50, limit: 50, remaining: 0 };
const HEALTHY_FREE: FreeCounter = { used: 10, limit: 50, remaining: 40 };

describe("AuthStorage OpenRouter free-model quota", () => {
	let tempDir = "";
	let store: SqliteAuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;
	const bodies = new Map<string, unknown>();
	const fetchedKeys: string[] = [];

	let slowUsage = false;

	const usageFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
		const key = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "") ?? "";
		fetchedKeys.push(key);
		if (slowUsage) {
			// Answers only when the request's own timeout aborts it.
			const { promise, reject } = Promise.withResolvers<Response>();
			init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
			return promise;
		}
		const body = bodies.get(key);
		return body === undefined ? new Response("{}", { status: 500 }) : new Response(JSON.stringify(body));
	}) as unknown as typeof fetch;

	function openStorage(options: AuthStorageOptions = {}): AuthStorage {
		if (!store || authStorage) throw new Error("test setup failed");
		authStorage = new AuthStorage(store, { usageFetch, ...options });
		return authStorage;
	}

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-openrouter-free-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		bodies.clear();
		fetchedKeys.length = 0;
		slowUsage = false;
		setSystemTime(NOW);
	});

	afterEach(async () => {
		setSystemTime();
		authStorage?.close();
		store?.close();
		store = null;
		authStorage = null;
		if (tempDir.length > 0) await removeWithRetries(tempDir);
		tempDir = "";
	});

	/** Live block rows of a stored key, as scope and deadline. */
	function blocksFor(key: string) {
		if (!store) throw new Error("test setup failed");
		const row = store
			.listAuthCredentials("openrouter")
			.find(entry => entry.credential.type === "api_key" && entry.credential.key === key);
		if (!row) throw new Error(`credential ${key} missing`);
		return store
			.listCredentialBlocks([row.id])
			.filter(block => block.blockedUntilMs > Date.now())
			.map(({ blockScope, blockedUntilMs }) => ({ blockScope, blockedUntilMs }));
	}

	async function setKeys(...keys: string[]): Promise<AuthStorage> {
		const storage = authStorage ?? openStorage();
		await storage.credentials.set(
			"openrouter",
			keys.map(key => ({ type: "api_key" as const, key, source: "login" as const })),
		);
		return storage;
	}

	test("a spent free counter moves :free requests to a sibling while paid requests keep the key until the reset", async () => {
		const storage = await setKeys("or-free-spent", "or-free-healthy");
		bodies.set("or-free-spent", keyBody(90, SPENT_FREE));
		bodies.set("or-free-healthy", keyBody(20, HEALTHY_FREE));

		expect(await storage.keys.get("openrouter", undefined, { modelId: FREE_MODEL })).toBe("or-free-healthy");
		expect(await storage.keys.get("openrouter", undefined, { modelId: PAID_MODEL })).toBe("or-free-spent");
		expect(blocksFor("or-free-spent")).toEqual([
			{ blockScope: OPENROUTER_FREE_QUOTA_BLOCK_SCOPE, blockedUntilMs: limitResetAt("daily", NOW) },
		]);
		expect(blocksFor("or-free-healthy")).toEqual([]);

		setSystemTime(limitResetAt("daily", NOW) + 60_000);
		bodies.set("or-free-spent", keyBody(90, { used: 0, limit: 50, remaining: 50 }));
		expect(await storage.keys.get("openrouter", undefined, { modelId: FREE_MODEL })).toBe("or-free-spent");
	});

	test("a usage-limit error blocks only its own request's scope, and the report's spent limit separately", async () => {
		const storage = await setKeys("or-only");
		bodies.set("or-only", keyBody(90, SPENT_FREE));

		const freeOutcome = await storage.limits.markReached("openrouter", "session-free", {
			apiKey: "or-only",
			modelId: FREE_MODEL,
		});
		expect(freeOutcome).toMatchObject({ switched: false, blockedUntilMs: limitResetAt("daily", NOW) });
		expect(blocksFor("or-only")).toEqual([
			{ blockScope: OPENROUTER_FREE_QUOTA_BLOCK_SCOPE, blockedUntilMs: limitResetAt("daily", NOW) },
			{ blockScope: OPENROUTER_FREE_BLOCK_SCOPE, blockedUntilMs: NOW + 60_000 },
		]);

		await storage.limits.markReached("openrouter", "session-paid", { apiKey: "or-only", modelId: PAID_MODEL });
		expect(blocksFor("or-only")).toContainEqual({ blockScope: "", blockedUntilMs: NOW + 60_000 });
	});

	test("a paid usage-limit error's retry hint outlasts a recovered cap, while the cap block lifts", async () => {
		const storage = await setKeys("or-limited", "or-sibling");
		bodies.set("or-limited", keyBody(0, HEALTHY_FREE));
		bodies.set("or-sibling", keyBody(80, HEALTHY_FREE));
		await storage.limits.markReached("openrouter", "session-paid", {
			apiKey: "or-limited",
			modelId: PAID_MODEL,
			retryAfterMs: 60 * 60_000,
			providerTimed: true,
		});
		expect(blocksFor("or-limited")).toEqual([
			{ blockScope: "", blockedUntilMs: NOW + 60 * 60_000 },
			{ blockScope: OPENROUTER_KEY_CAP_BLOCK_SCOPE, blockedUntilMs: limitResetAt("monthly", NOW) },
		]);

		setSystemTime(AFTER_PROBE_WINDOW);
		bodies.set("or-limited", keyBody(180, HEALTHY_FREE, 200));
		await storage.usage.reports();
		expect(blocksFor("or-limited")).toEqual([{ blockScope: "", blockedUntilMs: NOW + 60 * 60_000 }]);
		expect(await storage.keys.get("openrouter", undefined, { modelId: PAID_MODEL })).toBe("or-sibling");
	});

	test("a raised key cap lifts the cap block on the next live report", async () => {
		const storage = openStorage({
			async configValueResolver(config) {
				return config === "OR_CAPPED_REF" ? "or-capped" : config;
			},
		});
		await setKeys("OR_CAPPED_REF", "or-busier");
		bodies.set("or-capped", keyBody(0, HEALTHY_FREE));
		bodies.set("or-busier", keyBody(20, HEALTHY_FREE));

		expect(await storage.keys.get("openrouter", undefined, { modelId: PAID_MODEL })).toBe("or-busier");
		expect(blocksFor("OR_CAPPED_REF")).toEqual([
			{ blockScope: OPENROUTER_KEY_CAP_BLOCK_SCOPE, blockedUntilMs: limitResetAt("monthly", NOW) },
		]);

		setSystemTime(AFTER_PROBE_WINDOW);
		bodies.set("or-capped", keyBody(180, HEALTHY_FREE, 200));
		expect(await storage.keys.get("openrouter", undefined, { modelId: PAID_MODEL })).toBe("or-capped");
		expect(blocksFor("OR_CAPPED_REF")).toEqual([]);
	});

	test("a raised free-model ceiling lifts the :free block on the next live report", async () => {
		const storage = await setKeys("or-free-spent", "or-free-healthy");
		bodies.set("or-free-spent", keyBody(90, SPENT_FREE));
		bodies.set("or-free-healthy", keyBody(90, HEALTHY_FREE));
		expect(await storage.keys.get("openrouter", undefined, { modelId: FREE_MODEL })).toBe("or-free-healthy");

		setSystemTime(AFTER_PROBE_WINDOW);
		bodies.set("or-free-spent", keyBody(90, { used: 50, limit: 1000, remaining: 950 }));
		expect(await storage.keys.get("openrouter", undefined, { modelId: FREE_MODEL })).toBe("or-free-spent");
		expect(blocksFor("or-free-spent")).toEqual([]);
	});

	test("a live report keeps blocks whose own limit is still spent, and the free counter never lifts the cap block", async () => {
		const storage = await setKeys("or-free-spent", "or-cap-spent", "or-sibling");
		bodies.set("or-free-spent", keyBody(90, SPENT_FREE));
		bodies.set("or-cap-spent", keyBody(0, HEALTHY_FREE));
		bodies.set("or-sibling", keyBody(20, HEALTHY_FREE));
		expect(await storage.keys.get("openrouter", undefined, { modelId: FREE_MODEL })).toBe("or-sibling");
		expect(await storage.keys.get("openrouter", undefined, { modelId: PAID_MODEL })).toBe("or-free-spent");

		setSystemTime(AFTER_PROBE_WINDOW);
		bodies.set("or-free-spent", keyBody(90, SPENT_FREE));
		bodies.set("or-cap-spent", keyBody(0, { used: 0, limit: 1000, remaining: 1000 }));
		// The :free request probes both blocked keys; neither live report may lift a block whose limit is spent.
		expect(await storage.keys.get("openrouter", undefined, { modelId: FREE_MODEL })).toBe("or-sibling");
		expect(blocksFor("or-cap-spent")).toEqual([
			{ blockScope: OPENROUTER_KEY_CAP_BLOCK_SCOPE, blockedUntilMs: limitResetAt("monthly", NOW) },
		]);
		expect(blocksFor("or-free-spent")).toEqual([
			{ blockScope: OPENROUTER_FREE_QUOTA_BLOCK_SCOPE, blockedUntilMs: limitResetAt("daily", NOW) },
		]);
		expect(await storage.keys.get("openrouter", undefined, { modelId: PAID_MODEL })).toBe("or-free-spent");
	});

	test("a retained report from before the midnight reset does not re-block the key during an outage", async () => {
		const storage = await setKeys("or-free-spent", "or-free-healthy");
		const lateEvening = Date.UTC(2026, 9, 20, 23, 50);
		setSystemTime(lateEvening);
		bodies.set("or-free-spent", keyBody(90, SPENT_FREE));
		bodies.set("or-free-healthy", keyBody(90, HEALTHY_FREE));
		expect(await storage.keys.get("openrouter", undefined, { modelId: FREE_MODEL })).toBe("or-free-healthy");

		setSystemTime(limitResetAt("daily", lateEvening) + 10 * 60_000);
		bodies.clear();
		await storage.keys.get("openrouter", undefined, { modelId: FREE_MODEL });
		expect(fetchedKeys.filter(key => key === "or-free-spent")).toHaveLength(2);
		expect(blocksFor("or-free-spent")).toEqual([]);
	});

	test("a failing or slow /key fails open to the session's credential order without block writes", async () => {
		openStorage({ usageRequestTimeoutMs: 200 });
		const storage = await setKeys("or-a", "or-b");
		const failingPick = await storage.keys.get("openrouter", "session-order", { modelId: FREE_MODEL });
		expect(fetchedKeys.length).toBe(2);

		// Past the failure cool-down, so the next selection probes /key again.
		setSystemTime(NOW + 60_000);
		slowUsage = true;
		const started = performance.now();
		const slowPick = await storage.keys.get("openrouter", "session-order", { modelId: FREE_MODEL });

		expect(fetchedKeys.length).toBe(4);
		expect(performance.now() - started).toBeLessThan(2_000);
		expect(slowPick).toBe(failingPick);
		expect(failingPick === "or-a" || failingPick === "or-b").toBe(true);
		expect([...blocksFor("or-a"), ...blocksFor("or-b")]).toEqual([]);
	});

	test("a paid usage-limit error on a spent cap keeps both blocks, reports the later one, and counts it as the prior block", async () => {
		const storage = await setKeys("or-capped");
		bodies.set("or-capped", keyBody(0, HEALTHY_FREE));

		const first = await storage.limits.markReached("openrouter", "session-paid", {
			apiKey: "or-capped",
			modelId: PAID_MODEL,
		});
		expect(first.blockedUntilMs).toBe(limitResetAt("monthly", NOW));
		expect(blocksFor("or-capped")).toEqual([
			{ blockScope: "", blockedUntilMs: NOW + 60_000 },
			{ blockScope: OPENROUTER_KEY_CAP_BLOCK_SCOPE, blockedUntilMs: limitResetAt("monthly", NOW) },
		]);

		const second = await storage.limits.markReached("openrouter", "session-paid", {
			apiKey: "or-capped",
			modelId: PAID_MODEL,
		});
		expect(second).toMatchObject({ priorBlockedUntilMs: limitResetAt("monthly", NOW), priorBlockedUntilTimed: true });
	});

	test("a healthy report lifts no usage-limit error block on a key without a cap", async () => {
		const storage = await setKeys("or-uncapped", "or-sibling");
		const uncapped = {
			data: { label: "k", limit: null, is_free_tier: false, free_model_daily_requests: HEALTHY_FREE },
		};
		bodies.set("or-uncapped", uncapped);
		bodies.set("or-sibling", keyBody(80, HEALTHY_FREE));
		await storage.limits.markReached("openrouter", "session-paid", {
			apiKey: "or-uncapped",
			modelId: PAID_MODEL,
			retryAfterMs: 60 * 60_000,
			providerTimed: true,
		});

		setSystemTime(AFTER_PROBE_WINDOW);
		await storage.usage.reports();
		expect(blocksFor("or-uncapped")).toEqual([{ blockScope: "", blockedUntilMs: NOW + 60 * 60_000 }]);
	});

	test("a strategy that does not opt API keys into healing leaves their blocks to the clock", async () => {
		const storage = openStorage({
			rankingStrategyResolver: provider =>
				provider === "openrouter" ? { ...openrouterRankingStrategy, healsApiKeyBlocks: false } : undefined,
		});
		await setKeys("or-capped", "or-busier");
		bodies.set("or-capped", keyBody(0, HEALTHY_FREE));
		bodies.set("or-busier", keyBody(20, HEALTHY_FREE));
		expect(await storage.keys.get("openrouter", undefined, { modelId: PAID_MODEL })).toBe("or-busier");

		setSystemTime(AFTER_PROBE_WINDOW);
		bodies.set("or-capped", keyBody(180, HEALTHY_FREE, 200));
		await storage.usage.reports();
		expect(await storage.keys.get("openrouter", undefined, { modelId: PAID_MODEL })).toBe("or-busier");
		expect(blocksFor("or-capped")).toEqual([
			{ blockScope: OPENROUTER_KEY_CAP_BLOCK_SCOPE, blockedUntilMs: limitResetAt("monthly", NOW) },
		]);
	});

	describe("reference keys", () => {
		const refs = new Map<string, string>();
		const refStorage = () =>
			openStorage({
				async configValueResolver(config) {
					return refs.get(config) ?? (config.startsWith("OR_") ? undefined : config);
				},
			});
		const capKey = (key: string) =>
			blocksFor(key).filter(block => block.blockScope === OPENROUTER_KEY_CAP_BLOCK_SCOPE);

		beforeEach(() => refs.clear());

		/** Both reference rows start with a spent cap, so a paid selection blocks both. */
		async function blockBoth(secretA: string, secretB: string): Promise<AuthStorage> {
			refs.set("OR_A_REF", secretA);
			refs.set("OR_B_REF", secretB);
			const storage = refStorage();
			await setKeys("OR_A_REF", "OR_B_REF");
			bodies.set(secretA, keyBody(0, HEALTHY_FREE));
			bodies.set(secretB, keyBody(0, HEALTHY_FREE));
			await storage.keys.get("openrouter", undefined, { modelId: PAID_MODEL });
			expect(capKey("OR_A_REF")).toHaveLength(1);
			expect(capKey("OR_B_REF")).toHaveLength(1);
			setSystemTime(AFTER_PROBE_WINDOW);
			return storage;
		}

		test("a report for a rotated reference's old secret heals the row that now resolves to it, not the old row", async () => {
			const storage = await blockBoth("sk-x", "sk-b");
			refs.set("OR_A_REF", "sk-y");
			refs.set("OR_B_REF", "sk-x");
			bodies.set("sk-y", keyBody(0, HEALTHY_FREE));
			bodies.set("sk-x", keyBody(180, HEALTHY_FREE, 200));
			await storage.usage.reports();
			expect(capKey("OR_A_REF")).toHaveLength(1);
			expect(capKey("OR_B_REF")).toEqual([]);
		});

		test("a reference that no longer resolves stops owning its old secret", async () => {
			const storage = await blockBoth("sk-x", "sk-b");
			refs.delete("OR_A_REF");
			refs.set("OR_B_REF", "sk-x");
			bodies.set("sk-x", keyBody(180, HEALTHY_FREE, 200));
			await storage.usage.reports();
			expect(capKey("OR_A_REF")).toHaveLength(1);
			expect(capKey("OR_B_REF")).toEqual([]);
		});

		test("two rows storing the same reference are ambiguous owners, so a selection probe heals neither", async () => {
			refs.set("OR_SAME_REF", "sk-same");
			const storage = refStorage();
			await setKeys("OR_SAME_REF", "OR_SAME_REF");
			if (!store) throw new Error("test setup failed");
			const rows = store.listAuthCredentials("openrouter");
			expect(rows).toHaveLength(2);
			bodies.set("sk-same", keyBody(0, HEALTHY_FREE));
			await storage.keys.get("openrouter", undefined, { modelId: PAID_MODEL });
			const capBlocks = () =>
				store
					?.listCredentialBlocks(rows.map(row => row.id))
					.filter(b => b.blockScope === OPENROUTER_KEY_CAP_BLOCK_SCOPE);
			expect(capBlocks()).toHaveLength(2);

			setSystemTime(AFTER_PROBE_WINDOW);
			bodies.set("sk-same", keyBody(180, HEALTHY_FREE, 200));
			await storage.keys.get("openrouter", undefined, { modelId: PAID_MODEL });
			expect(capBlocks()).toHaveLength(2);
		});

		test("a literal key and a reference resolving to it are ambiguous owners, so its report heals neither", async () => {
			refs.set("OR_LIT_REF", "sk-lit");
			const storage = refStorage();
			await setKeys("sk-lit", "OR_LIT_REF");
			bodies.set("sk-lit", keyBody(0, HEALTHY_FREE));
			await storage.keys.get("openrouter", undefined, { modelId: PAID_MODEL });
			expect(capKey("sk-lit")).toHaveLength(1);
			expect(capKey("OR_LIT_REF")).toHaveLength(1);

			setSystemTime(AFTER_PROBE_WINDOW);
			bodies.set("sk-lit", keyBody(180, HEALTHY_FREE, 200));
			await storage.keys.get("openrouter", undefined, { modelId: PAID_MODEL });
			expect(capKey("sk-lit")).toHaveLength(1);
			expect(capKey("OR_LIT_REF")).toHaveLength(1);
		});

		test("two references resolving to one secret are ambiguous, so its report heals neither", async () => {
			const storage = await blockBoth("sk-shared", "sk-shared");
			bodies.set("sk-shared", keyBody(180, HEALTHY_FREE, 200));
			await storage.usage.reports();
			expect(capKey("OR_A_REF")).toHaveLength(1);
			expect(capKey("OR_B_REF")).toHaveLength(1);
		});
	});
});
