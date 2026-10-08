import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import {
	type AccountUsageResponse,
	AuthBrokerClient,
	type AuthBrokerServerHandle,
	RemoteAuthCredentialStore,
	startAuthBroker,
} from "@oh-my-pi/pi-ai/auth-broker";
import { clientUsageReportRequestSchema } from "@oh-my-pi/pi-ai/auth-broker/wire-schemas";
import type { ObservedUsageEntry } from "@oh-my-pi/pi-ai/usage";
import {
	CLIENT_USAGE_ATTRIBUTED_BUCKET_SQL,
	CLIENT_USAGE_UNATTRIBUTED_BUCKET_SQL,
} from "@oh-my-pi/pi-ai/auth/sqlite-credential-store";
import { logger, TempDir } from "@oh-my-pi/pi-utils";

const TOKEN = "account-usage-bearer";
const MINUTE = 60_000;
/** A minute boundary well in the past, so every entry lies before the test's real clock. */
const T0 = Math.floor((Date.now() - 60 * MINUTE) / MINUTE) * MINUTE;

function entry(at: number, account: string | undefined, requests = 1): ObservedUsageEntry {
	return {
		at,
		provider: "anthropic",
		model: "claude",
		requests,
		inputTokens: 10 * requests,
		outputTokens: 5 * requests,
		cacheReadTokens: 100 * requests,
		cacheWriteTokens: 0,
		costUsd: 0.25 * requests,
		...(account !== undefined ? { account } : {}),
	};
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("waitUntil timeout");
		await Bun.sleep(10);
	}
}

describe("auth-broker account usage totals", () => {
	let tempDir: TempDir;
	let storage: AuthStorage;
	let handle: AuthBrokerServerHandle;
	const remotes: RemoteAuthCredentialStore[] = [];

	beforeEach(async () => {
		tempDir = await TempDir.create("@pi-ai-account-usage-");
		storage = new AuthStorage(await SqliteAuthCredentialStore.open(tempDir.join("agent.db")));
		await storage.credentials.reload();
		handle = startAuthBroker({ storage, bind: "127.0.0.1:0", bearerTokens: [TOKEN], disableRefresher: true });
	});

	afterEach(async () => {
		for (const remote of remotes.splice(0)) remote.close();
		await handle.close();
		storage.close();
		await tempDir.remove();
	});

	function request(method: string, path: string, body?: unknown, token = TOKEN): Promise<Response> {
		return fetch(`${handle.url}${path}`, {
			method,
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	}

	async function report(installId: string, entries: ObservedUsageEntry[]): Promise<void> {
		const response = await request("POST", "/v1/usage/observed", { installId, app: "omp", entries });
		expect(response.status).toBe(200);
	}

	/** Totals of the accounts the tests report on; the route requires an account filter. */
	async function totals(
		sinceMs: number,
		accounts: readonly string[] = ["work", "home", "stale"],
	): Promise<AccountUsageResponse["accounts"]> {
		const filter = accounts.map(account => `&account=${encodeURIComponent(account)}`).join("");
		const response = await request("GET", `/v1/usage/accounts?sinceMs=${sinceMs}${filter}`);
		expect(response.status).toBe(200);
		return ((await response.json()) as AccountUsageResponse).accounts;
	}

	test("totals each account across installs after the window start, to the minute", async () => {
		await report("install-a", [entry(T0 + 10_000, "work"), entry(T0 + 50_000, "work"), entry(T0 + 70_000, "home")]);
		await report("install-b", [entry(T0 + 2 * MINUTE + 30_000, "work", 2)]);

		// Highest cost first, so a truncated answer keeps the accounts that matter most.
		expect(await totals(T0)).toEqual([
			{ provider: "anthropic", account: "work", costUsd: 1, requests: 4, tokens: 60 },
			{ provider: "anthropic", account: "home", costUsd: 0.25, requests: 1, tokens: 15 },
		]);
		// Exclusive start, like the local ledger: a request stamped at the start is outside the window.
		expect((await totals(T0 + 2 * MINUTE + 30_000)).map(total => total.account)).toEqual([]);
		expect((await totals(T0 + 2 * MINUTE + 29_999)).map(total => [total.account, total.requests])).toEqual([
			["work", 2],
		]);
		// One minute's requests are stamped with its newest: a start inside the minute counts the whole minute.
		expect((await totals(T0 + 30_000)).find(total => total.account === "work")?.requests).toBe(4);
		// Different minutes stay apart: a start between them counts only the later one.
		expect((await totals(T0 + MINUTE)).find(total => total.account === "work")?.requests).toBe(2);
	});

	test("keeps unattributed reports out of account totals and attributed ones in the per-client summary", async () => {
		await report("install-a", [entry(T0 + 10_000, "work")]);
		// A legacy report in the same minute must not fold into the attributed row.
		await report("install-a", [entry(T0 + 20_000, undefined, 5)]);
		expect(await totals(T0)).toEqual([
			{ provider: "anthropic", account: "work", costUsd: 0.25, requests: 1, tokens: 15 },
		]);
		const summary = storage.usage.clientSummary(0).clients[0]?.providers[0];
		expect(summary?.requests).toBe(6);
	});

	test("rejects malformed queries and reports, and requires the bearer token", async () => {
		for (const query of ["", "?sinceMs=", "?sinceMs=-1", "?sinceMs=1.5", "?sinceMs=abc", "?sinceMs=1e3"]) {
			expect((await request("GET", `/v1/usage/accounts${query}${query ? "&" : "?"}account=work`)).status).toBe(400);
		}
		expect((await request("GET", "/v1/usage/accounts?sinceMs=0&account=work", undefined, "wrong")).status).toBe(401);
		const overlong = { installId: "i", entries: [entry(T0, "x".repeat(257))] };
		expect((await request("POST", "/v1/usage/observed", overlong)).status).toBe(400);
		expect((await request("POST", "/v1/usage/observed", { installId: "i", entries: [entry(T0, "")] })).status).toBe(
			400,
		);
	});

	test("refuses negative and oversized amounts and malformed accounts, and holds attributed timestamps to the broker clock", async () => {
		await report("install-a", [entry(T0 + 10_000, "work")]);
		const before = await totals(T0);
		const rejected: Partial<ObservedUsageEntry>[] = [
			{ costUsd: -1 },
			{ requests: -5 },
			{ inputTokens: -1 },
			{ requests: 1e9 },
			{ costUsd: 1e9 },
			{ account: "work\u0000" },
			{ account: "work\nother" },
		];
		for (const override of rejected) {
			const response = await request("POST", "/v1/usage/observed", {
				installId: "attacker",
				entries: [{ ...entry(T0 + 20_000, "work"), ...override }],
			});
			expect(response.status).toBe(400);
		}
		expect(await totals(T0)).toEqual(before);

		// An entry stamped in 2100 is recorded at the broker's now, not in every future window.
		await report("attacker", [entry(Date.UTC(2100, 0, 1), "work")]);
		const db = new Database(tempDir.join("agent.db"), { readonly: true });
		try {
			const newest = db.query("SELECT MAX(recorded_at) AS at FROM client_usage WHERE account IS NOT NULL").get() as {
				at: number;
			};
			expect(newest.at).toBeLessThanOrEqual(Date.now());
		} finally {
			db.close();
		}
		// One older than the 35-day horizon is dropped.
		await report("attacker", [entry(Date.now() - 40 * 24 * 60 * MINUTE, "stale")]);
		expect((await totals(T0)).map(total => total.account)).not.toContain("stale");
		const check = new Database(tempDir.join("agent.db"), { readonly: true });
		try {
			const stale = check.query("SELECT COUNT(*) AS count FROM client_usage WHERE account = 'stale'").get() as {
				count: number;
			};
			expect(stale.count).toBe(0);
		} finally {
			check.close();
		}
	});

	test("a filter keeps an account retrievable however many other accounts outrank it", async () => {
		const junk = Array.from({ length: 1001 }, (_, index) => ({
			...entry(T0 + 10_000, `a-junk-${String(index).padStart(4, "0")}`),
			costUsd: 5,
		}));
		await report("attacker", junk.slice(0, 1000));
		await report("attacker", junk.slice(1000));
		await report("install-a", [entry(T0 + 10_000, "zz-real")]);

		// Without an account filter the broker refuses to group every account.
		expect((await request("GET", `/v1/usage/accounts?sinceMs=${T0}`)).status).toBe(400);
		// A maximal filter is never truncated, whatever else it names.
		const crowded = [
			...Array.from({ length: 63 }, (_, index) => `a-junk-${String(index).padStart(4, "0")}`),
			"zz-real",
		];
		const crowdedResponse = await request(
			"GET",
			`/v1/usage/accounts?sinceMs=${T0}&${crowded.map(account => `account=${account}`).join("&")}`,
		);
		const crowdedBody = (await crowdedResponse.json()) as AccountUsageResponse;
		expect(crowdedBody.truncated).toBe(false);
		expect(crowdedBody.accounts.map(total => total.account)).toContain("zz-real");

		const filtered = await request("GET", `/v1/usage/accounts?sinceMs=${T0}&provider=anthropic&account=zz-real`);
		expect(((await filtered.json()) as AccountUsageResponse).accounts).toEqual([
			{ provider: "anthropic", account: "zz-real", costUsd: 0.25, requests: 1, tokens: 15 },
		]);

		// The client asks only for the accounts it checks.
		const remote = new RemoteAuthCredentialStore({
			client: new AuthBrokerClient({ url: handle.url, token: TOKEN }),
			streamSnapshots: false,
			backgroundIdleMs: 50,
		});
		remotes.push(remote);
		remote.accountUsageTotals("anthropic", "zz-real", T0, Date.now());
		await remote.syncAccountUsage();
		expect(remote.accountUsageTotals("anthropic", "zz-real", T0, Date.now())?.requests).toBe(1);

		const tooMany = Array.from({ length: 65 }, (_, index) => `account=a${index}`).join("&");
		expect((await request("GET", `/v1/usage/accounts?sinceMs=${T0}&${tooMany}`)).status).toBe(400);
		expect((await request("GET", `/v1/usage/accounts?sinceMs=${T0}&account=%01x`)).status).toBe(400);
		expect((await request("GET", `/v1/usage/accounts?sinceMs=${T0}&provider=anthropic`)).status).toBe(400);
	});

	test("prunes attributed rows past the 35-day horizon and never totals older usage", async () => {
		const old = Date.now() - 36 * 24 * 60 * MINUTE;
		storage.usage.recordClient({ installId: "install-a", entries: [entry(old, "work")] });
		const db = new Database(tempDir.join("agent.db"));
		try {
			const attributed = () =>
				(
					db.query("SELECT COUNT(*) AS count FROM client_usage WHERE account IS NOT NULL").get() as {
						count: number;
					}
				).count;
			expect(attributed()).toBe(0);
			// A row that escaped pruning is still outside any window the broker totals.
			db.run(
				"INSERT INTO client_usage (recorded_at, install_id, app, provider, model, account, requests, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd) VALUES (?, 'i', '', 'anthropic', 'claude', 'work', 1, 1, 1, 0, 0, 1)",
				[old],
			);
			expect(attributed()).toBe(1);
		} finally {
			db.close();
		}
		expect(await totals(0)).toEqual([]);
	});

	test("refuses an oversized usage report sent without a length", async () => {
		const chunk = new TextEncoder().encode("x".repeat(512 * 1024));
		let chunks = 0;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (chunks++ >= 10) controller.close();
				else controller.enqueue(chunk);
			},
		});
		const response = await fetch(`${handle.url}/v1/usage/observed`, {
			method: "POST",
			headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
			body,
			duplex: "half",
		} as RequestInit);
		expect(response.status).toBe(413);
	});

	test("an oversized account usage answer fails the poll and leaves limits local", async () => {
		const hostile = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () =>
				new Response(`{"pad":"${"x".repeat(8 * 1024 * 1024)}"}`, {
					headers: { "Content-Type": "application/json" },
				}),
		});
		try {
			const remote = new RemoteAuthCredentialStore({
				client: new AuthBrokerClient({ url: `http://127.0.0.1:${hostile.port}`, token: TOKEN, maxRetries: 0 }),
				streamSnapshots: false,
				backgroundIdleMs: 50,
			});
			remotes.push(remote);
			const client = new AuthBrokerClient({ url: `http://127.0.0.1:${hostile.port}`, token: TOKEN, maxRetries: 0 });
			await expect(client.fetchAccountUsage(T0)).rejects.toThrow(/exceeded/);
			remote.accountUsageTotals("anthropic", "work", T0, Date.now());
			await remote.syncAccountUsage();
			expect(remote.accountUsageTotals("anthropic", "work", T0, Date.now())).toBeUndefined();
		} finally {
			hostile.stop(true);
		}
	});

	test("refuses oversized reports and identity fields", async () => {
		const many = (count: number) => Array.from({ length: count }, (_, index) => entry(T0 + index, "work"));
		const huge = await request("POST", "/v1/usage/observed", { installId: "i", entries: many(100_000) });
		expect([400, 413]).toContain(huge.status);
		expect((await request("POST", "/v1/usage/observed", { installId: "i", entries: many(1001) })).status).toBe(400);
		expect(
			(await request("POST", "/v1/usage/observed", { installId: "i".repeat(257), entries: many(1) })).status,
		).toBe(400);
		const longModel = [{ ...entry(T0, "work"), model: "m".repeat(257) }];
		expect((await request("POST", "/v1/usage/observed", { installId: "i", entries: longModel })).status).toBe(400);
		expect(await totals(T0)).toEqual([]);
	});

	test("saturates merged counters instead of overflowing, and keeps the totals route answering", async () => {
		const maximal = Array.from({ length: 1000 }, () => ({ ...entry(T0 + 10_000, "work"), inputTokens: 1e12 }));
		for (let round = 0; round < 10; round += 1) await report("install-a", maximal);
		const db = new Database(tempDir.join("agent.db"), { readonly: true });
		try {
			const row = db.query("SELECT MAX(input_tokens) AS tokens FROM client_usage").get() as { tokens: number };
			expect(row.tokens).toBe(Number.MAX_SAFE_INTEGER);
		} finally {
			db.close();
		}
		const [work] = await totals(T0);
		expect(work?.tokens).toBeGreaterThanOrEqual(Number.MAX_SAFE_INTEGER);
		expect(storage.usage.clientSummary(0).clients).toHaveLength(1);
		// Enough saturated rows overflow a 64-bit integer sum; the totals stay answerable.
		const writer = new Database(tempDir.join("agent.db"));
		try {
			const insert = writer.query(
				"INSERT INTO client_usage (recorded_at, install_id, app, provider, model, account, requests, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd) VALUES (?, 'install-a', '', 'anthropic', 'claude', 'work', ?, ?, 0, 0, 0, 0)",
			);
			for (let index = 0; index < 1100; index += 1) {
				insert.run(T0 + 20_000, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
			}
		} finally {
			writer.close();
		}
		expect((await totals(T0))[0]?.requests).toBeGreaterThan(1e18);
		expect(storage.usage.clientSummary(0).clients).toHaveLength(1);
	});

	test("caps an install's rows and accounts, folding usage past the row caps into existing rows", () => {
		const fewAccounts = new SqliteAuthCredentialStore(new Database(tempDir.join("accounts.db")), {
			clientUsageLimits: { accountsPerInstall: 3 },
		});
		try {
			fewAccounts.recordClientUsage({
				installId: "i",
				entries: ["a1", "a2", "a3"].map(account => entry(Date.now() - MINUTE, account)),
			});
			// The cap holds across reports, not only within one.
			fewAccounts.recordClientUsage({
				installId: "i",
				entries: ["a4", "a5"].map(account => entry(Date.now() - MINUTE, account)),
			});
			const recorded = fewAccounts.getClientAccountUsage(0, 100, { accounts: ["a1", "a2", "a3", "a4", "a5"] });
			expect(recorded.map(total => total.account).sort()).toEqual(["a1", "a2", "a3"]);
		} finally {
			fewAccounts.close();
		}
		const capped = new SqliteAuthCredentialStore(new Database(tempDir.join("caps.db")), {
			clientUsageLimits: { attributedRowsPerInstall: 3, accountsPerInstall: 3, unattributedRowsPerInstall: 2 },
		});
		try {
			const now = Date.now() - 10 * MINUTE;
			capped.recordClientUsage({
				installId: "i",
				entries: [
					...["a1", "a2", "a3", "a4", "a5"].map(account => entry(now, account)),
					...[0, 1, 2, 3].map(minute => entry(now + minute * MINUTE, "a1")),
					...[0, 6, 12, 18].map(minute => entry(now - 30 * MINUTE + minute * MINUTE, undefined)),
					{ ...entry(now, undefined), model: "new-model" },
				],
			});
			const accounts = capped.getClientAccountUsage(0, 100, { accounts: ["a1", "a2", "a3", "a4", "a5"] });
			// Accounts past the cap are not recorded; usage past the row cap folds into an existing row.
			expect(accounts.map(total => total.account).sort()).toEqual(["a1", "a2", "a3"]);
			expect(accounts.find(total => total.account === "a1")?.requests).toBe(5);
			const db = new Database(tempDir.join("caps.db"), { readonly: true });
			try {
				const rows = db
					.query(
						"SELECT COUNT(account) AS attributed, COUNT(*) - COUNT(account) AS unattributed FROM client_usage",
					)
					.get() as { attributed: number; unattributed: number };
				expect(rows).toEqual({ attributed: 3, unattributed: 2 });
			} finally {
				db.close();
			}
			const legacy = capped.getClientUsageSummary(0).clients[0]?.providers ?? [];
			// The per-client summary keeps every recorded request: 7 attributed, 4 unattributed (the new model is past the cap).
			expect(legacy.reduce((sum, usage) => sum + usage.requests, 0)).toBe(7 + 4);
		} finally {
			capped.close();
		}
	});

	test("looks up write-path buckets through indexes on every column they filter on", () => {
		const db = new Database(tempDir.join("agent.db"), { readonly: true });
		try {
			const plan = (sql: string, params: unknown[]) =>
				(db.query(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as string[])) as Array<{ detail: string }>)
					.map(row => row.detail)
					.join("\n");
			const attributed = plan(CLIENT_USAGE_ATTRIBUTED_BUCKET_SQL, ["i", "", "p", "m", "a", 0, 1]);
			expect(attributed).toContain("idx_client_usage_attributed_series");
			expect(attributed).toContain("account=?");
			const unattributed = plan(CLIENT_USAGE_UNATTRIBUTED_BUCKET_SQL, ["i", "", "p", "m", 0]);
			expect(unattributed).toContain("idx_client_usage_unattributed_series");
			expect(unattributed).toContain("app=?");
		} finally {
			db.close();
		}
	});

	test("a backdated unattributed entry never moves a merged row out of recent windows", () => {
		const recent = Date.now() - MINUTE;
		storage.usage.recordClient({ installId: "i", entries: [entry(recent, undefined)] });
		storage.usage.recordClient({ installId: "i", entries: [entry(0, undefined)] });
		const providers = storage.usage.clientSummary(recent - 1).clients[0]?.providers ?? [];
		expect(providers.reduce((sum, usage) => sum + usage.requests, 0)).toBe(2);
	});

	test("warns once per interval about usage dropped past the caps, without account text", () => {
		const warn = vi.spyOn(logger, "warn");
		const capped = new SqliteAuthCredentialStore(new Database(tempDir.join("warn.db")), {
			clientUsageLimits: { accountsPerInstall: 1 },
		});
		try {
			for (let round = 0; round < 3; round += 1) {
				capped.recordClientUsage({
					installId: "i",
					entries: [entry(Date.now(), "kept"), entry(Date.now(), `secret-${round}@example.com`)],
				});
			}
			const warnings = warn.mock.calls.filter(([message]) => String(message).includes("per-install caps"));
			expect(warnings).toHaveLength(1);
			expect(JSON.stringify(warnings)).not.toContain("secret");
		} finally {
			capped.close();
			warn.mockRestore();
		}
	});

	test("brokers ignore entry fields they predate, so attributed reports reach older brokers", () => {
		const validated = clientUsageReportRequestSchema({
			installId: "i",
			entries: [{ ...entry(T0, "work"), fieldFromANewerClient: 1 }],
		});
		expect(validated).not.toBeInstanceOf(type.errors);
	});

	test("a client folds attributed usage per minute and reads fleet totals back after polling", async () => {
		const remote = new RemoteAuthCredentialStore({
			client: new AuthBrokerClient({ url: handle.url, token: TOKEN }),
			streamSnapshots: false,
			backgroundIdleMs: 50,
			observedUsageFlushMs: 10,
		});
		remotes.push(remote);
		remote.recordObservedUsage([entry(T0 + 50_000, "work"), entry(T0 + 70_000, "work")]);
		// Overlong keys go unattributed instead of getting the whole report rejected.
		remote.recordObservedUsage([entry(T0 + 80_000, "x".repeat(300))]);
		await waitUntil(() => (storage.usage.clientSummary(0).clients[0]?.providers[0]?.requests ?? 0) === 3);

		// Nothing polled yet: the caller falls back to its own ledger.
		expect(remote.accountUsageTotals("anthropic", "work", T0 + MINUTE, Date.now())).toBeUndefined();
		expect(remote.accountUsageTotals("anthropic", "idle", T0 + MINUTE, Date.now())).toBeUndefined();
		await remote.syncAccountUsage();
		expect(remote.accountUsageTotals("anthropic", "work", T0 + MINUTE, Date.now())?.requests).toBe(1);
		// A complete response without an account it asked for means no fleet usage for it.
		expect(remote.accountUsageTotals("anthropic", "idle", T0 + MINUTE, Date.now())?.requests).toBe(0);
		// An account the poll did not ask for is unknown until the next poll.
		expect(remote.accountUsageTotals("anthropic", "unasked", T0 + MINUTE, Date.now())).toBeUndefined();
	});

	test("a broker without the route leaves limits local and is not polled again", async () => {
		const paths: string[] = [];
		const legacy = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(req) {
				const url = new URL(req.url);
				paths.push(url.pathname);
				return Response.json({ error: "no route" }, { status: 404 });
			},
		});
		try {
			const remote = new RemoteAuthCredentialStore({
				client: new AuthBrokerClient({ url: `http://127.0.0.1:${legacy.port}`, token: TOKEN, maxRetries: 0 }),
				streamSnapshots: false,
				backgroundIdleMs: 50,
			});
			remotes.push(remote);
			expect(remote.accountUsageTotals("anthropic", "work", T0, Date.now())).toBeUndefined();
			await remote.syncAccountUsage();
			await remote.syncAccountUsage();
			expect(remote.accountUsageTotals("anthropic", "work", T0, Date.now())).toBeUndefined();
			expect(paths.filter(path => path === "/v1/usage/accounts")).toHaveLength(1);

			// After the re-probe interval the broker is asked again (an upgraded broker, or a passing proxy 404).
			const reprobing = new RemoteAuthCredentialStore({
				client: new AuthBrokerClient({ url: `http://127.0.0.1:${legacy.port}`, token: TOKEN, maxRetries: 0 }),
				streamSnapshots: false,
				backgroundIdleMs: 50,
				featureReprobeMs: 100,
			});
			remotes.push(reprobing);
			reprobing.accountUsageTotals("anthropic", "work", T0, Date.now());
			await reprobing.syncAccountUsage();
			await Bun.sleep(150);
			reprobing.accountUsageTotals("anthropic", "work", T0, Date.now());
			await reprobing.syncAccountUsage();
			expect(paths.filter(path => path === "/v1/usage/accounts")).toHaveLength(3);
		} finally {
			legacy.stop(true);
		}
	});
});
