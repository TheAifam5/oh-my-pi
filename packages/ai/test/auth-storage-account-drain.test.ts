import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, setSystemTime, test, vi } from "bun:test";
import { loadAuthAccountPolicyConfig } from "@oh-my-pi/pi-ai/auth-broker";
import {
	type AuthAccountPolicies,
	type AuthAccountPolicy,
	AuthStorage,
	apiKeyFingerprint,
	SqliteAuthCredentialStore,
} from "@oh-my-pi/pi-ai/auth-storage";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";
import type { CredentialRankingStrategy, UsageProvider, UsageReport } from "@oh-my-pi/pi-ai/usage";
import {
	type BillingSourceState,
	creditsFromDecimal,
	knownBilling,
	moneyFromDecimal,
	unknownBilling,
} from "@oh-my-pi/pi-ai/usage/billing";
import { drainStateKey, sessionDrainKey } from "@oh-my-pi/pi-ai/auth/drain-state";
import { accountUsageKey } from "@oh-my-pi/pi-ai/auth/policy";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { logger, TempDir } from "@oh-my-pi/pi-utils";

const PROVIDER = "unit-drain";
const SESSION = "session-drain";
const MINUTE = 60_000;

const POLICIES: AuthAccountPolicies = [
	{ provider: PROVIDER, name: "cool", account: { accountId: "acc-a" }, priority: 10 },
	{ provider: PROVIDER, name: "first", account: { accountId: "acc-b" }, drain: true },
];

const strategy: CredentialRankingStrategy = {
	findWindowLimits: (usage, context) => ({
		primary: usage.limits.find(
			limit => limit.scope.modelId === undefined || limit.scope.modelId === context?.modelId,
		),
	}),
	scopeLimits: (usage, context) =>
		usage.limits.filter(limit => limit.scope.modelId === undefined || limit.scope.modelId === context?.modelId),
	blockScope: context => (context?.modelId ? `model:${context.modelId}` : undefined),
	windowDefaults: { primaryMs: 5 * 60 * MINUTE, secondaryMs: 7 * 24 * 60 * MINUTE },
};

function oauthCredential(suffix: string) {
	return {
		type: "oauth" as const,
		access: `access-${suffix}`,
		refresh: `refresh-${suffix}`,
		expires: Date.now() + 365 * 24 * 60 * MINUTE,
		accountId: `acc-${suffix}`,
	};
}

describe("AuthStorage account drain", () => {
	const used = new Map<string, number>();
	/** Windows that report a spent allowance without blocking (the account keeps serving on overage). */
	const overage = new Set<string>();
	/** Prepaid credit balance by `accountId`, reported as billing evidence. */
	const credits = new Map<string, string>();
	/** Paid extra usage state by `accountId`. */
	const money = new Map<string, BillingSourceState>();
	/** Paid extra usage reported as used by `accountId`, in USD. */
	const moneyUsed = new Map<string, string>();
	let storage: AuthStorage;

	/** Used fraction by `accountId`, or by `accountId/modelId` for a model-scoped window. */
	function report(accountId: string): UsageReport {
		const limits = [...used]
			.filter(([key]) => key === accountId || key.startsWith(`${accountId}/`))
			.map(([key, usedFraction]) => {
				const modelId = key.includes("/") ? key.slice(key.indexOf("/") + 1) : undefined;
				return {
					id: key,
					label: key,
					scope: { provider: PROVIDER, ...(modelId ? { modelId } : {}) },
					window: { id: key, label: key, resetsAt: Date.now() + 2 * MINUTE },
					amount: { usedFraction, unit: "percent" as const },
					status: usedFraction >= 1 && !overage.has(key) ? ("exhausted" as const) : ("ok" as const),
				};
			});
		return {
			provider: PROVIDER,
			fetchedAt: Date.now(),
			metadata: {
				accountId,
				credits: credits.get(accountId),
				money: money.get(accountId),
				moneyUsed: moneyUsed.get(accountId),
			},
			limits,
		};
	}

	const usageProvider: UsageProvider = {
		id: PROVIDER,
		fetchUsage: async params => (params.credential.accountId ? report(params.credential.accountId) : null),
	};

	function storageOptions(accountPolicies: AuthAccountPolicies = POLICIES) {
		return {
			accountPolicies,
			usageProviderResolver: (provider: string) => (provider === PROVIDER ? usageProvider : undefined),
			rankingStrategyResolver: (provider: string) => (provider === PROVIDER ? strategy : undefined),
		};
	}

	beforeEach(async () => {
		setSystemTime(new Date("2026-10-05T10:00:00Z"));
		used.clear();
		overage.clear();
		credits.clear();
		money.clear();
		moneyUsed.clear();
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			return credential ? { newCredentials: credential, apiKey: credential.access } : null;
		});
		storage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")), storageOptions());
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b")]);
	});

	afterEach(() => {
		storage.close();
		vi.restoreAllMocks();
		setSystemTime();
	});

	/** Billing source reading the fake report's `credits` and `money` metadata. */
	function installBilling(target: AuthStorage = storage): void {
		target.usage.setBillingSource({
			read: (_provider, usage) => {
				const { credits: creditMeta, money: moneyMeta, moneyUsed: usedMeta } = usage.metadata ?? {};
				if (creditMeta === undefined && moneyMeta === undefined && usedMeta === undefined) {
					return unknownBilling(usage, "no-evidence");
				}
				const balance = usage.metadata?.credits;
				const remaining = typeof balance === "string" ? creditsFromDecimal(balance, "floor") : undefined;
				const moneyState = usage.metadata?.money;
				const spentUsd = usage.metadata?.moneyUsed;
				const spent = typeof spentUsd === "string" ? moneyFromDecimal(spentUsd, "USD", "ceil") : undefined;
				return knownBilling(usage, [
					{ mode: "subscription-included", state: "unknown" },
					{
						mode: "prepaid-credits",
						state:
							balance === "exhausted"
								? "exhausted"
								: remaining
									? remaining.amountMinor > 0
										? "available"
										: "exhausted"
									: "unknown",
						...(remaining ? { allowance: { kind: "credits" as const, remaining } } : {}),
					},
					{
						mode: "paid-extra-usage",
						state: typeof moneyState === "string" ? (moneyState as BillingSourceState) : "unknown",
						...(spent ? { allowance: { kind: "money" as const, used: spent } } : {}),
					},
				]);
			},
		});
	}

	function drainFirst(funding: Pick<AuthAccountPolicy, "spend" | "returnWhen">): void {
		storage.setAccountPolicies({
			accountPolicies: [POLICIES[0]!, { ...POLICIES[1]!, ...funding }],
			defaultReservePct: 10,
		});
	}

	async function advance(ms: number, modelId?: string): Promise<string | undefined> {
		setSystemTime(new Date(Date.now() + ms));
		await storage.usage.invalidate(PROVIDER);
		return storage.keys.get(PROVIDER, SESSION, modelId ? { modelId } : undefined);
	}

	test("serves the drain target first, moves on when it drains, and returns after cooldown and margin", async () => {
		used.set("acc-a", 0.2);
		used.set("acc-b", 0.5);
		expect(await storage.keys.get(PROVIDER, SESSION)).toBe("access-b");

		used.set("acc-b", 1);
		expect(await advance(MINUTE)).toBe("access-a");

		used.set("acc-b", 0.5);
		expect(await advance(5 * MINUTE)).toBe("access-a");

		used.set("acc-b", 0.97);
		expect(await advance(6 * MINUTE)).toBe("access-a");

		used.set("acc-b", 0.5);
		expect(await advance(MINUTE)).toBe("access-b");
	});

	test("an exclusive pin beats the drain target and a session can turn draining off", async () => {
		used.set("acc-a", 0.2);
		used.set("acc-b", 0.5);
		const cool = storage.sessions.accounts(PROVIDER).find(account => account.name === "cool");
		expect(storage.sessions.pin(PROVIDER, SESSION, cool?.credentialId ?? -1)).toBe(true);
		expect(await storage.keys.get(PROVIDER, SESSION)).toBe("access-a");

		const other = "session-drain-off";
		expect(storage.sessions.drain(PROVIDER, other, null)).toBe(true);
		expect(await storage.keys.get(PROVIDER, other)).toBe("access-a");
		expect(storage.sessions.drain(PROVIDER, other, undefined)).toBe(true);
		expect(await storage.keys.get(PROVIDER, other)).toBe("access-b");
	});

	test("rejects a second drain target for one provider", () => {
		const twice: AuthAccountPolicies = [
			...POLICIES,
			{ provider: PROVIDER, account: { accountId: "acc-a" }, drain: true },
		];
		expect(
			() => new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")), { accountPolicies: twice }),
		).toThrow(/only one may/);
	});

	test("keeps drain state per block scope: a model-scoped exhaustion drains only that model", async () => {
		used.set("acc-a", 0.2);
		used.set("acc-b/x", 1);
		used.set("acc-b/y", 0.3);
		expect(await storage.keys.get(PROVIDER, SESSION, { modelId: "x" })).toBe("access-a");
		expect(await storage.keys.get(PROVIDER, "session-model-y", { modelId: "y" })).toBe("access-b");
	});

	test("an auth block on the target does not start the return cooldown", async () => {
		used.set("acc-a", 0.2);
		used.set("acc-b", 0.5);
		const first = storage.sessions.accounts(PROVIDER).find(account => account.name === "first");
		storage.blocks.upsert({
			credentialId: first?.credentialId ?? -1,
			providerKey: `${PROVIDER}:oauth`,
			blockScope: "auth",
			blockedUntilMs: Date.now() + 2 * MINUTE,
		});
		expect(await storage.keys.get(PROVIDER, SESSION)).toBe("access-a");
		expect(await advance(3 * MINUTE)).toBe("access-b");
	});

	test("a clock that steps back restarts the cooldown", async () => {
		used.set("acc-a", 0.2);
		used.set("acc-b", 1);
		overage.add("acc-b");
		expect(await storage.keys.get(PROVIDER, SESSION)).toBe("access-a");

		used.set("acc-b", 0.5);
		expect(await advance(-60 * MINUTE)).toBe("access-a");
		expect(await advance(5 * MINUTE)).toBe("access-a");
		expect(await advance(6 * MINUTE)).toBe("access-b");
	});

	test("spend credits keeps the drain target first past an exhausted plan window until credits run out", async () => {
		installBilling();
		used.set("acc-a", 0.2);
		used.set("acc-b", 1);
		credits.set("acc-b", "10");
		drainFirst({ spend: ["plan", "credits"] });
		expect(await storage.keys.get(PROVIDER, SESSION)).toBe("access-b");

		credits.set("acc-b", "0");
		expect(await advance(MINUTE)).toBe("access-a");
	});

	test("a stored usage block drains a funded target; credits-added returns it once its balance grows", async () => {
		installBilling();
		drainFirst({ spend: ["credits"], returnWhen: "credits-added" });
		used.set("acc-a", 0.2);
		used.set("acc-b", 1);
		credits.set("acc-b", "5.5");
		const first = storage.sessions.accounts(PROVIDER).find(account => account.name === "first");
		storage.blocks.upsert({
			credentialId: first?.credentialId ?? -1,
			providerKey: `${PROVIDER}:oauth`,
			blockScope: "model:x",
			blockedUntilMs: Date.now() + 2 * MINUTE,
		});
		expect(await storage.keys.get(PROVIDER, SESSION, { modelId: "x" })).toBe("access-a");
		// The blocked target's report is first read once the block lapses; that read is the baseline.
		expect(await advance(5 * MINUTE, "x")).toBe("access-a");

		credits.set("acc-b", "6");
		expect(await advance(3 * MINUTE, "x")).toBe("access-a");

		credits.set("acc-b", "5.5");
		expect(await advance(3 * MINUTE, "x")).toBe("access-a");

		credits.set("acc-b", "6");
		expect(await advance(MINUTE, "x")).toBe("access-b");
	});

	test("takes the credits baseline from the first evidence after draining and logs a trigger it cannot evaluate", async () => {
		installBilling();
		const warn = vi.spyOn(logger, "warn");
		drainFirst({ spend: ["credits"], returnWhen: "credits-added" });
		used.set("acc-a", 0.2);
		used.set("acc-b", 1);
		expect(await storage.keys.get(PROVIDER, SESSION)).toBe("access-a");
		used.set("acc-b", 0.97);
		expect(await advance(11 * MINUTE)).toBe("access-a");
		expect(await advance(MINUTE)).toBe("access-a");
		expect(warn.mock.calls.filter(([message]) => String(message).startsWith("Drained account stays"))).toHaveLength(
			1,
		);

		credits.set("acc-b", "5");
		expect(await advance(MINUTE)).toBe("access-a");

		credits.set("acc-b", "6");
		expect(await advance(MINUTE)).toBe("access-b");
	});

	test("money-available returns a drained target once paid extra usage becomes available", async () => {
		installBilling();
		drainFirst({ spend: ["money"], returnWhen: ["money-available"] });
		used.set("acc-a", 0.2);
		used.set("acc-b", 1);
		overage.add("acc-b");
		money.set("acc-b", "disabled");
		expect(await storage.keys.get(PROVIDER, SESSION)).toBe("access-a");

		used.set("acc-b", 0.5);
		expect(await advance(11 * MINUTE)).toBe("access-a");

		money.set("acc-b", "available");
		expect(await advance(MINUTE)).toBe("access-b");
	});

	test("without a billing reader spend falls back to the plan, warns once, and reset still returns", async () => {
		const warn = vi.spyOn(logger, "warn");
		drainFirst({ spend: ["credits"], returnWhen: ["reset", "credits-added"] });
		used.set("acc-a", 0.2);
		used.set("acc-b", 1);
		overage.add("acc-b");
		credits.set("acc-b", "10");
		expect(await storage.keys.get(PROVIDER, SESSION)).toBe("access-a");
		expect(await advance(MINUTE)).toBe("access-a");
		expect(warn.mock.calls.filter(([message]) => String(message).startsWith("Drain spend"))).toHaveLength(1);

		used.set("acc-b", 0.5);
		expect(await advance(10 * MINUTE)).toBe("access-b");
	});

	test("without usage ranking a billing trigger is logged once and the drained target waits for reset", async () => {
		const plain = "unit-drain-plain";
		const warn = vi.spyOn(logger, "warn");
		const drained = (returnWhen: AuthAccountPolicy["returnWhen"]): AuthAccountPolicies => [
			{ provider: plain, account: { accountId: "acc-b" }, drain: true, spend: ["credits"], returnWhen },
		];
		const unranked = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")), {
			accountPolicies: drained("credits-added"),
		});
		try {
			await unranked.credentials.set(plain, [oauthCredential("a"), oauthCredential("b")]);
			const target = unranked.sessions.accounts(plain).find(account => account.accountId === "acc-b");
			unranked.blocks.upsert({
				credentialId: target?.credentialId ?? -1,
				providerKey: `${plain}:oauth`,
				blockScope: "",
				blockedUntilMs: Date.now() + 2 * MINUTE,
			});
			expect(await unranked.keys.get(plain, SESSION)).toBe("access-a");
			setSystemTime(new Date(Date.now() + 11 * MINUTE));
			expect(await unranked.keys.get(plain, SESSION)).toBe("access-a");
			expect(await unranked.keys.get(plain, SESSION)).toBe("access-a");
			expect(
				warn.mock.calls.filter(([message]) => String(message).startsWith("Drained account stays")),
			).toHaveLength(1);

			unranked.setAccountPolicies({ accountPolicies: drained(["reset", "credits-added"]), defaultReservePct: 10 });
			expect(await unranked.keys.get(plain, SESSION)).toBe("access-b");
		} finally {
			unranked.close();
		}
	});

	test("a restricted session never touches the drain state of an account outside its allowlist", async () => {
		const plain = "unit-drain-restricted";
		const db = new Database(":memory:");
		const unranked = new AuthStorage(new SqliteAuthCredentialStore(db), {
			accountPolicies: [{ provider: plain, account: { accountId: "acc-c" }, drain: true }],
		});
		try {
			await unranked.credentials.set(plain, [oauthCredential("a"), oauthCredential("b"), oauthCredential("c")]);
			const target = unranked.sessions.accounts(plain).find(account => account.accountId === "acc-c");
			unranked.blocks.upsert({
				credentialId: target?.credentialId ?? -1,
				providerKey: `${plain}:oauth`,
				blockScope: "",
				blockedUntilMs: Date.now() + 2 * MINUTE,
			});
			unranked.sessions.restrict(plain, SESSION, ["account:acc-a", "account:acc-b"]);
			// A restricted session cannot set an override naming the outside account.
			expect(unranked.sessions.drain(plain, SESSION, target?.credentialId ?? -1)).toBe(false);
			// One inherited from an unrestricted parent still leaves its drain state alone.
			expect(unranked.sessions.drain(plain, "parent", target?.credentialId ?? -1)).toBe(true);
			unranked.sessions.inherit("parent", "overridden");
			unranked.sessions.restrict(plain, "overridden", ["account:acc-a", "account:acc-b"]);

			for (const sessionId of [SESSION, "overridden"]) {
				expect(["access-a", "access-b"]).toContain((await unranked.keys.get(plain, sessionId)) ?? "");
			}
			expect(db.query("SELECT key FROM cache WHERE key LIKE 'drain:state:%'").all()).toEqual([]);

			// An unrestricted session drains the blocked target as before.
			expect(["access-a", "access-b"]).toContain((await unranked.keys.get(plain, "unrestricted")) ?? "");
			expect(db.query("SELECT key FROM cache WHERE key LIKE 'drain:state:%'").all()).toHaveLength(1);
		} finally {
			unranked.close();
		}
	});

	test("pool account order runs after the member account and before the drain target; unknown names are skipped", async () => {
		const warn = vi.spyOn(logger, "warn");
		used.set("acc-a", 0.2);
		used.set("acc-b", 0.5);
		const pool: { member?: string } = {};
		storage.sessions.setAccountPinSource({
			member: () => pool.member,
			routing: () => ({ order: ["ghost", "cool"] }),
		});
		expect(await storage.keys.get(PROVIDER, SESSION)).toBe("access-a");
		expect((await storage.oauth.access(PROVIDER, SESSION))?.accountId).toBe("acc-a");
		expect(warn.mock.calls.filter(([, meta]) => (meta as { account?: string })?.account === "ghost")).toHaveLength(1);

		pool.member = "first";
		expect(await storage.keys.get(PROVIDER, SESSION)).toBe("access-b");
	});

	/** Adds a third stored account named `third` (`acc-c`). */
	async function withThird(): Promise<number> {
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b"), oauthCredential("c")]);
		storage.setAccountPolicies({
			accountPolicies: [...POLICIES, { provider: PROVIDER, name: "third", account: { accountId: "acc-c" } }],
			defaultReservePct: 10,
		});
		return storage.sessions.accounts(PROVIDER).find(account => account.name === "third")?.credentialId ?? -1;
	}

	test("an exhausted pool order account falls through to the next one, then to normal selection", async () => {
		await withThird();
		used.set("acc-a", 1);
		used.set("acc-b", 0.5);
		used.set("acc-c", 0.3);
		storage.sessions.setAccountPinSource({ routing: () => ({ order: ["cool", "third"] }) });
		expect(await storage.keys.get(PROVIDER, SESSION)).toBe("access-c");

		used.set("acc-c", 1);
		expect(await advance(MINUTE)).toBe("access-b");
	});

	test("an exclusive pin beats the pool order and drain", async () => {
		const third = await withThird();
		used.set("acc-a", 0.2);
		used.set("acc-b", 0.5);
		used.set("acc-c", 0.3);
		storage.sessions.setAccountPinSource({ routing: () => ({ order: ["cool"], drain: "cool" }) });
		expect(storage.sessions.pin(PROVIDER, SESSION, third)).toBe(true);
		expect(await storage.keys.get(PROVIDER, SESSION)).toBe("access-c");
	});

	test("pool drain and spend replace the policy's, and a session drain override beats the pool", async () => {
		const third = await withThird();
		installBilling();
		used.set("acc-a", 1);
		used.set("acc-b", 0.5);
		used.set("acc-c", 0.5);
		credits.set("acc-a", "10");
		storage.sessions.setAccountPinSource({ routing: () => ({ drain: "cool", spend: ["credits"] }) });
		expect(await storage.keys.get(PROVIDER, SESSION)).toBe("access-a");

		storage.sessions.drain(PROVIDER, SESSION, third);
		expect(await storage.keys.get(PROVIDER, SESSION)).toBe("access-c");
	});

	test("pool-funded and policy-funded requests on one drain target keep separate cooldowns", async () => {
		installBilling();
		const policySession = "session-policy";
		const poolSession = "session-pool";
		storage.sessions.setAccountPinSource({
			routing: (_provider, sessionId) => (sessionId === poolSession ? { spend: ["credits"] } : undefined),
		});
		used.set("acc-a", 0.2);
		used.set("acc-b", 1);
		overage.add("acc-b");
		credits.set("acc-b", "10");
		expect(await storage.keys.get(PROVIDER, policySession)).toBe("access-a");
		expect(await storage.keys.get(PROVIDER, poolSession)).toBe("access-b");

		credits.set("acc-b", "0");
		setSystemTime(new Date(Date.now() + 5 * MINUTE));
		await storage.usage.invalidate(PROVIDER);
		expect(await storage.keys.get(PROVIDER, poolSession)).toBe("access-a");

		used.set("acc-b", 0.5);
		setSystemTime(new Date(Date.now() + 6 * MINUTE));
		await storage.usage.invalidate(PROVIDER);
		expect(await storage.keys.get(PROVIDER, policySession)).toBe("access-b");
		expect(await storage.keys.get(PROVIDER, poolSession)).toBe("access-a");
	});

	describe("persisted drain state", () => {
		let tempDir: TempDir;
		let dbPath = "";
		const extra: AuthStorage[] = [];

		/** Opens another AuthStorage on the shared database file, closed after the test. */
		async function open(accountPolicies?: AuthAccountPolicies): Promise<AuthStorage> {
			const opened = new AuthStorage(await SqliteAuthCredentialStore.open(dbPath), storageOptions(accountPolicies));
			extra.push(opened);
			await opened.credentials.reload();
			return opened;
		}

		/** Closes `storage` and continues on a fresh AuthStorage over the same database, like a restarted process. */
		async function restart(accountPolicies?: AuthAccountPolicies): Promise<void> {
			storage.close();
			storage = await open(accountPolicies);
			await storage.usage.invalidate(PROVIDER);
		}

		beforeEach(async () => {
			storage.close();
			// Cache rows expire against the database's wall clock, so the fake clock starts at real time.
			setSystemTime();
			setSystemTime(new Date(Date.now()));
			tempDir = await TempDir.create("@pi-ai-account-drain-");
			dbPath = tempDir.join("agent.db");
			storage = await open();
			await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b")]);
		});

		afterEach(async () => {
			for (const opened of extra.splice(0)) opened.close();
			await tempDir.remove();
		});

		/** Advances the clock and resolves for `session`, which is fresh so the persisted session affinity does not decide. */
		async function after(ms: number, session: string): Promise<string | undefined> {
			setSystemTime(new Date(Date.now() + ms));
			await storage.usage.invalidate(PROVIDER);
			return storage.keys.get(PROVIDER, session);
		}

		/** Writes a cache row into the database at `file`, live for an hour. */
		function writeCacheRow(file: string, key: string, value: string): void {
			const db = new Database(file);
			try {
				db.run(
					"INSERT INTO cache (key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at",
					[key, value, Math.floor(Date.now() / 1000) + 3600],
				);
			} finally {
				db.close();
			}
		}

		/** Moves every drain state row's expiry `seconds` earlier, as if the database clock had run that far ahead. */
		function ageDrainRows(seconds: number): void {
			const db = new Database(dbPath);
			try {
				db.run("UPDATE cache SET expires_at = expires_at - ? WHERE key LIKE 'drain:state:%'", [seconds]);
			} finally {
				db.close();
			}
		}

		test("a restart keeps the drained target behind until both cooldown and margin pass", async () => {
			used.set("acc-a", 0.2);
			used.set("acc-b", 1);
			expect(await storage.keys.get(PROVIDER, SESSION)).toBe("access-a");

			await restart();
			used.set("acc-b", 0.5);
			// Past the stored usage block, which lapses at the window reset two minutes out.
			expect(await after(3 * MINUTE, "in-cooldown")).toBe("access-a");
			used.set("acc-b", 0.98);
			expect(await after(8 * MINUTE, "below-margin")).toBe("access-a");
			used.set("acc-b", 0.5);
			expect(await after(MINUTE, "returned")).toBe("access-b");
		});

		test("credits-added compares against the baseline taken before a restart", async () => {
			const funded: AuthAccountPolicies = [
				POLICIES[0]!,
				{ ...POLICIES[1]!, spend: ["credits"], returnWhen: "credits-added" },
			];
			await restart(funded);
			installBilling();
			used.set("acc-a", 0.2);
			used.set("acc-b", 1);
			credits.set("acc-b", "5.5");
			const first = storage.sessions.accounts(PROVIDER).find(account => account.name === "first");
			storage.blocks.upsert({
				credentialId: first?.credentialId ?? -1,
				providerKey: `${PROVIDER}:oauth`,
				blockScope: "model:x",
				blockedUntilMs: Date.now() + 2 * MINUTE,
			});
			expect(await storage.keys.get(PROVIDER, SESSION, { modelId: "x" })).toBe("access-a");
			expect(await advance(5 * MINUTE, "x")).toBe("access-a");

			await restart(funded);
			installBilling();
			credits.set("acc-b", "6");
			expect(await advance(MINUTE, "x")).toBe("access-a");
			expect(await advance(5 * MINUTE, "x")).toBe("access-b");
		});

		test("session drain overrides survive a restart, and clearing one restores the account policy", async () => {
			const policies: AuthAccountPolicies = [
				...POLICIES,
				{ provider: PROVIDER, name: "third", account: { accountId: "acc-c" } },
			];
			await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b"), oauthCredential("c")]);
			await restart(policies);
			used.set("acc-a", 0.2);
			used.set("acc-b", 0.5);
			used.set("acc-c", 0.3);
			const third = storage.sessions.accounts(PROVIDER).find(account => account.name === "third");
			expect(storage.sessions.drain(PROVIDER, "s-target", third?.credentialId ?? -1)).toBe(true);
			expect(storage.sessions.drain(PROVIDER, "s-off", null)).toBe(true);
			expect(storage.sessions.drain(PROVIDER, "s-cleared", third?.credentialId ?? -1)).toBe(true);
			expect(storage.sessions.drain(PROVIDER, "s-cleared", undefined)).toBe(true);

			await restart(policies);
			expect(await storage.keys.get(PROVIDER, "s-target")).toBe("access-c");
			expect(await storage.keys.get(PROVIDER, "s-off")).toBe("access-a");
			expect(await storage.keys.get(PROVIDER, "s-cleared")).toBe("access-b");
		});

		test("a return in one process is seen by another sharing the database", async () => {
			const other = await open();
			used.set("acc-a", 0.2);
			used.set("acc-b", 1);
			expect(await storage.keys.get(PROVIDER, SESSION)).toBe("access-a");
			expect(await other.keys.get(PROVIDER, "session-other")).toBe("access-a");

			used.set("acc-b", 0.5);
			expect(await advance(11 * MINUTE)).toBe("access-b");
			used.set("acc-b", 0.97);
			await other.usage.invalidate(PROVIDER);
			// The first missed read may be transient; the second confirms the return.
			expect(await other.keys.get(PROVIDER, "session-other")).toBe("access-a");
			expect(await other.keys.get(PROVIDER, "session-other")).toBe("access-b");
		});

		test("a process with a pending miss does not re-create a returned row when its clock steps back", async () => {
			const other = await open();
			used.set("acc-a", 0.2);
			used.set("acc-b", 1);
			expect(await storage.keys.get(PROVIDER, SESSION)).toBe("access-a");
			expect(await other.keys.get(PROVIDER, "session-other")).toBe("access-a");
			used.set("acc-b", 0.5);
			expect(await advance(11 * MINUTE)).toBe("access-b");

			used.set("acc-b", 0.97);
			setSystemTime(new Date(Date.now() - 60 * MINUTE));
			await other.usage.invalidate(PROVIDER);
			expect(await other.keys.get(PROVIDER, "session-step-back")).toBe("access-a");
			await storage.usage.invalidate(PROVIDER);
			expect(await storage.keys.get(PROVIDER, "session-fresh")).toBe("access-b");
		});

		test("one missed read of a stored drain state does not return the target", async () => {
			used.set("acc-a", 0.2);
			used.set("acc-b", 1);
			expect(await storage.keys.get(PROVIDER, SESSION)).toBe("access-a");
			const getCache = SqliteAuthCredentialStore.prototype.getCache;
			let missed = false;
			vi.spyOn(SqliteAuthCredentialStore.prototype, "getCache").mockImplementation(
				function (this: SqliteAuthCredentialStore, key, options) {
					if (!missed && key.startsWith("drain:state:")) {
						missed = true;
						return null;
					}
					return getCache.call(this, key, options);
				},
			);
			used.set("acc-b", 0.5);
			expect(await after(3 * MINUTE, "after-miss")).toBe("access-a");
			expect(missed).toBe(true);
			expect(await after(MINUTE, "after-read")).toBe("access-a");
		});

		test("a target waiting for its trigger keeps its drain state past the row lifetime", async () => {
			const funded: AuthAccountPolicies = [
				POLICIES[0]!,
				{ ...POLICIES[1]!, spend: ["credits"], returnWhen: "credits-added" },
			];
			await restart(funded);
			installBilling();
			used.set("acc-a", 0.2);
			used.set("acc-b", 1);
			credits.set("acc-b", "5.5");
			const first = storage.sessions.accounts(PROVIDER).find(account => account.name === "first");
			storage.blocks.upsert({
				credentialId: first?.credentialId ?? -1,
				providerKey: `${PROVIDER}:oauth`,
				blockScope: "model:x",
				blockedUntilMs: Date.now() + 2 * MINUTE,
			});
			expect(await storage.keys.get(PROVIDER, SESSION, { modelId: "x" })).toBe("access-a");
			expect(await advance(5 * MINUTE, "x")).toBe("access-a");
			// Credits keep it funded, so it is not drained, and none were added.
			expect(await advance(7 * 60 * MINUTE, "x")).toBe("access-a");

			ageDrainRows(25 * 60 * 60);
			await restart(funded);
			installBilling();
			expect(await advance(MINUTE, "x")).toBe("access-a");
			credits.set("acc-b", "6");
			expect(await advance(MINUTE, "x")).toBe("access-b");
		});

		test("a store swap drops a session drain override whose account the new store lacks", async () => {
			await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b"), oauthCredential("c")]);
			used.set("acc-a", 0.2);
			used.set("acc-b", 0.5);
			used.set("acc-c", 0.3);
			const third = storage.sessions.accounts(PROVIDER).find(account => account.accountId === "acc-c");
			expect(storage.sessions.drain(PROVIDER, SESSION, third?.credentialId ?? -1)).toBe(true);
			const otherPath = tempDir.join("other.db");
			const other = new AuthStorage(await SqliteAuthCredentialStore.open(otherPath), storageOptions());
			extra.push(other);
			await other.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b")]);
			const cool = other.sessions.accounts(PROVIDER).find(account => account.name === "cool");
			// A stale override in the new store that the swap must not leave in effect.
			writeCacheRow(
				otherPath,
				sessionDrainKey(PROVIDER, SESSION),
				JSON.stringify({ credentialId: cool?.credentialId }),
			);
			await storage.replaceStore(await SqliteAuthCredentialStore.open(otherPath));
			expect(await storage.keys.get(PROVIDER, SESSION)).toBe("access-b");
		});

		test("a malformed drain state row reads as absent", async () => {
			used.set("acc-a", 0.2);
			used.set("acc-b", 0.97);
			const first = storage.sessions.accounts(PROVIDER).find(account => account.name === "first");
			const key = drainStateKey(PROVIDER, first?.credentialId ?? -1, undefined, "/reset");
			writeCacheRow(dbPath, key, JSON.stringify({ since: Date.now() }));
			expect(await storage.keys.get(PROVIDER, "session-valid")).toBe("access-a");

			writeCacheRow(dbPath, key, "{not json");
			await restart();
			expect(await storage.keys.get(PROVIDER, "session-malformed")).toBe("access-b");
		});

		test("ignores an expired drain state and one recorded for a deleted credential", async () => {
			used.set("acc-a", 0.2);
			used.set("acc-b", 1);
			const realNow = Date.now();
			setSystemTime(new Date(realNow - 2 * 24 * 60 * MINUTE));
			expect(await storage.keys.get(PROVIDER, SESSION)).toBe("access-a");
			setSystemTime(new Date(realNow));
			await restart();
			used.set("acc-b", 0.97);
			expect(await storage.keys.get(PROVIDER, "session-expired")).toBe("access-b");

			used.set("acc-b", 1);
			await storage.usage.invalidate(PROVIDER);
			expect(await storage.keys.get(PROVIDER, "session-deleted")).toBe("access-a");
			const drainedId = storage.sessions.accounts(PROVIDER).find(account => account.name === "first")?.credentialId;
			// A policy may not name an account that is not stored, so drop it while the account is gone.
			storage.setAccountPolicies({ accountPolicies: [POLICIES[0]!], defaultReservePct: 10 });
			expect(await storage.credentials.removeById(PROVIDER, drainedId ?? -1)).toBe(true);
			await storage.credentials.upsert(PROVIDER, oauthCredential("b"));
			await restart();
			const readdedId = storage.sessions.accounts(PROVIDER).find(account => account.name === "first")?.credentialId;
			expect(readdedId).not.toBe(drainedId);
			used.set("acc-b", 0.97);
			expect(await storage.keys.get(PROVIDER, "session-readded")).toBe("access-b");
		});
	});

	describe("account evidence limits", () => {
		const unblock = { drain: false } as const;
		const limited = (limits: unknown[], extra: Partial<AuthAccountPolicy> = {}) =>
			storage.setAccountPolicies({
				accountPolicies: [
					{ ...POLICIES[0]!, limits: limits as AuthAccountPolicy["limits"], ...extra },
					{ ...POLICIES[1]!, ...unblock },
				],
				defaultReservePct: 0,
			});

		beforeEach(() => {
			installBilling();
			storage.setAccountPolicies({
				accountPolicies: [POLICIES[0]!, { ...POLICIES[1]!, ...unblock }],
				defaultReservePct: 0,
			});
		});

		test("holds an account back once its used fraction reaches the usage cap, never while unmeasured", async () => {
			used.set("acc-b", 1);
			limited([{ metric: "usage", max: 0.8 }], {});
			expect(await storage.keys.get(PROVIDER, SESSION)).toBe("access-a");

			used.set("acc-b", 0.5);
			used.set("acc-a", 0.79);
			expect(await advance(MINUTE)).toBe("access-a");
			used.set("acc-a", 0.82);
			expect(await advance(MINUTE)).toBe("access-b");

			const pinned = storage.sessions.accounts(PROVIDER).find(account => account.name === "cool");
			expect(storage.sessions.pin(PROVIDER, SESSION, pinned?.credentialId ?? -1)).toBe(true);
			await expect(storage.keys.get(PROVIDER, SESSION)).rejects.toBeInstanceOf(AIError.AccountLimitError);
		});

		test("gates credits and extra usage only once the plan allowance is spent", async () => {
			used.set("acc-b", 1);
			used.set("acc-a", 0.5);
			credits.set("acc-a", "1");
			limited([{ metric: "credits", max: "5" }]);
			expect(await storage.keys.get(PROVIDER, SESSION)).toBe("access-a");

			used.set("acc-a", 1);
			overage.add("acc-a");
			expect(await advance(MINUTE)).toBe("access-b");

			credits.set("acc-a", "10");
			expect(await advance(MINUTE)).toBe("access-a");

			credits.delete("acc-a");
			expect(await advance(MINUTE)).toBe("access-b");

			moneyUsed.set("acc-a", "25");
			limited([{ metric: "extra-usd", max: "20" }]);
			expect(await advance(MINUTE)).toBe("access-b");
			moneyUsed.set("acc-a", "10");
			expect(await advance(MINUTE)).toBe("access-a");
		});

		test("refuses when every account is gated, but never for an account whose usage cannot be read", async () => {
			storage.setAccountPolicies({
				accountPolicies: [
					{ ...POLICIES[0]!, limits: [{ metric: "credits", max: "5", onLimit: "skip" }] },
					{ ...POLICIES[1]!, drain: false, limits: [{ metric: "credits", max: "5", onLimit: "skip" }] },
				],
				defaultReservePct: 0,
			});
			used.set("acc-a", 1);
			used.set("acc-b", 1);
			overage.add("acc-a");
			overage.add("acc-b");
			await expect(storage.keys.get(PROVIDER, SESSION)).rejects.toThrow("(limit usage could not be read)");

			used.clear();
			expect(await advance(MINUTE)).toMatch(/^access-/);
		});

		test("holds an account back at a used fraction equal to the cap, in the worst window for the requested model", async () => {
			used.set("acc-b", 0.5);
			used.set("acc-a", 0.1);
			limited([{ metric: "usage", max: 0.1 }]);
			expect(await storage.keys.get(PROVIDER, SESSION)).toBe("access-b");

			limited([{ metric: "usage", max: 0.8 }]);
			used.set("acc-a/x", 0.9);
			expect(await advance(MINUTE, "x")).toBe("access-b");
			expect(await storage.keys.get(PROVIDER, "session-model-y", { modelId: "y" })).toBe("access-a");
		});

		test("compares large credit floors exactly and treats spent classes without amounts as reached", async () => {
			used.set("acc-b", 1);
			used.set("acc-a", 1);
			overage.add("acc-a");
			credits.set("acc-a", "9000000");
			limited([{ metric: "credits", max: "5000000" }]);
			expect(await storage.keys.get(PROVIDER, SESSION)).toBe("access-a");
			limited([{ metric: "credits", max: "10000000" }]);
			expect(await advance(MINUTE)).toBe("access-b");

			storage.setAccountPolicies({
				accountPolicies: [
					{ ...POLICIES[0]!, limits: [{ metric: "credits", max: "5", onLimit: "skip" }] },
					{ ...POLICIES[1]!, drain: false, limits: [{ metric: "extra-usd", max: "5", onLimit: "skip" }] },
				],
				defaultReservePct: 0,
			});
			overage.add("acc-b");
			credits.set("acc-a", "exhausted");
			money.set("acc-b", "disabled");
			const error = await advance(MINUTE).then(
				() => undefined,
				(failure: unknown) => failure,
			);
			expect(error).toBeInstanceOf(AIError.AccountLimitError);
			expect((error as AIError.AccountLimitError).reason).toBe("reached");
		});

		test("judges each account once per request, so a usage refresh between steps cannot reach the fallback key", async () => {
			storage.setAccountPolicies({
				accountPolicies: [
					{ ...POLICIES[0]!, limits: [{ metric: "usage", max: 0.8, onLimit: "skip" }] },
					{ ...POLICIES[1]!, drain: false, limits: [{ metric: "usage", max: 0.8, onLimit: "skip" }] },
				],
				defaultReservePct: 0,
			});
			storage.keys.setConfig(PROVIDER, "fallback-key", { fallback: true });
			used.set("acc-a", 0.9);
			let readsOfB = 0;
			const service = storage.usage as unknown as {
				report(provider: string, credential: { accountId?: string }): Promise<UsageReport | null>;
			};
			vi.spyOn(service, "report").mockImplementation(async (_provider, credential) => {
				if (credential.accountId === "acc-b") used.set("acc-b", ++readsOfB === 1 ? 0.5 : 0.9);
				return credential.accountId ? report(credential.accountId) : null;
			});
			expect(await storage.keys.get(PROVIDER, SESSION)).toBe("access-b");
		});

		test("logs a reached warn limit once and keeps serving", async () => {
			const warn = vi.spyOn(logger, "warn");
			used.set("acc-a", 0.82);
			used.set("acc-b", 0.5);
			limited([{ metric: "usage", max: 0.8, onLimit: "warn" }]);
			expect(await storage.keys.get(PROVIDER, SESSION)).toBe("access-a");
			expect(await advance(MINUTE)).toBe("access-a");
			expect(warn.mock.calls.filter(([message]) => message === "Local account limit reached")).toHaveLength(1);
		});
	});

	describe("account limits", () => {
		const limited = new Set<string>();
		const once = [
			{
				metric: "requests" as const,
				max: 1,
				window: { type: "calendar" as const, period: "day" as const },
				onLimit: "skip" as const,
			},
		];

		beforeEach(() => {
			limited.clear();
			storage.usage.setLimitSource({
				refuses: (_provider, account) => (limited.has(account) ? "reached" : undefined),
			});
		});

		test("skips an account over a skip limit and counts a limited drain target as drained", async () => {
			storage.setAccountPolicies({
				accountPolicies: [POLICIES[0]!, { ...POLICIES[1]!, limits: once }],
				defaultReservePct: 10,
			});
			used.set("acc-a", 0.2);
			used.set("acc-b", 0.5);
			limited.add("acc-b");
			expect(await storage.keys.get(PROVIDER, SESSION)).toBe("access-a");

			limited.clear();
			expect(await advance(5 * MINUTE)).toBe("access-a");
			expect(await advance(6 * MINUTE)).toBe("access-b");
		});

		test("lets a member account fall through and fails an exclusive pin with AccountLimitError", async () => {
			storage.setAccountPolicies({
				accountPolicies: [
					{ ...POLICIES[0]!, name: "unauthorized", limits: once },
					{ ...POLICIES[1]!, drain: false },
				],
				defaultReservePct: 10,
			});
			used.set("acc-a", 0.5);
			used.set("acc-b", 0.2);
			storage.sessions.setAccountPinSource({ member: () => "unauthorized" });
			expect(await storage.keys.get(PROVIDER, SESSION)).toBe("access-a");

			limited.add("acc-a");
			expect(await storage.keys.get(PROVIDER, SESSION)).toBe("access-b");

			const pinned = storage.sessions.accounts(PROVIDER).find(account => account.name === "unauthorized");
			expect(storage.sessions.pin(PROVIDER, SESSION, pinned?.credentialId ?? -1)).toBe(true);
			const error = await storage.keys.get(PROVIDER, SESSION).then(
				() => undefined,
				(failure: unknown) => failure,
			);
			expect(error).toBeInstanceOf(AIError.AccountLimitError);
			expect(String((error as Error).message)).not.toContain("unauthorized");
			expect(AIError.classify(error)).toBe(0);
			expect(AIError.isAuthRetryableError(error)).toBe(false);
			expect(AIError.isProviderRetryableError(error)).toBe(false);
			// A provider id that spells an auth or quota failure still classifies as nothing.
			expect(AIError.classify(new AIError.AccountLimitError("401 unauthorized: usage limit reached"))).toBe(0);
		});

		test("fails instead of reaching a fallback key when every stored account is limited", async () => {
			storage.setAccountPolicies({
				accountPolicies: [
					{ ...POLICIES[0]!, limits: once },
					{ ...POLICIES[1]!, limits: once },
				],
				defaultReservePct: 10,
			});
			storage.keys.setConfig(PROVIDER, "fallback-key", { fallback: true });
			used.set("acc-a", 0.2);
			used.set("acc-b", 0.5);
			limited.add("acc-a");
			expect(await storage.keys.get(PROVIDER, SESSION)).toBe("access-b");

			limited.add("acc-b");
			await expect(storage.keys.get(PROVIDER, SESSION)).rejects.toBeInstanceOf(AIError.AccountLimitError);
		});

		test("counts calls under the same key the recorder uses, whether or not the account is named", async () => {
			const seen: string[] = [];
			storage.usage.setLimitSource({
				refuses: (_provider, account) => {
					seen.push(account);
					return undefined;
				},
			});
			const policies = (named: boolean): AuthAccountPolicies => [
				{ provider: PROVIDER, account: { accountId: "acc-a" }, ...(named ? { name: "cool" } : {}), limits: once },
				{ provider: PROVIDER, account: { accountId: "acc-b" }, limits: once },
			];
			storage.setAccountPolicies({ accountPolicies: policies(false), defaultReservePct: 10 });
			await storage.keys.get(PROVIDER, SESSION);
			const recorded = storage.sessions.accounts(PROVIDER).flatMap(account => accountUsageKey(account) ?? []);
			expect(new Set(seen)).toEqual(new Set(recorded));

			seen.length = 0;
			storage.setAccountPolicies({ accountPolicies: policies(true), defaultReservePct: 10 });
			await storage.keys.get(PROVIDER, "session-named");
			expect(new Set(seen)).toEqual(new Set(recorded));
			expect(storage.sessions.accounts(PROVIDER).flatMap(account => accountUsageKey(account) ?? [])).toEqual(
				recorded,
			);
		});

		test("skips a limited API key and fails a pin on it", async () => {
			const keyed = "unit-drain-keys";
			const keys = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")), {
				accountPolicies: [
					{
						provider: keyed,
						name: "capped",
						account: { keyFingerprint: apiKeyFingerprint("sk-capped") },
						limits: once,
					},
				],
			});
			try {
				const capped = `key:${apiKeyFingerprint("sk-capped")}`;
				keys.usage.setLimitSource({
					refuses: (_provider, account) => (account === capped ? "reached" : undefined),
				});
				await keys.credentials.set(keyed, [
					{ type: "api_key", key: "sk-capped" },
					{ type: "api_key", key: "sk-open" },
				]);
				for (const session of ["s1", "s2", "s3"]) expect(await keys.keys.get(keyed, session)).toBe("sk-open");
				const cappedRow = keys.sessions.accounts(keyed).find(account => account.name === "capped");
				expect(cappedRow && accountUsageKey(cappedRow)).toBe(capped);
				expect(keys.sessions.pin(keyed, SESSION, cappedRow?.credentialId ?? -1)).toBe(true);
				await expect(keys.keys.get(keyed, SESSION)).rejects.toBeInstanceOf(AIError.AccountLimitError);
			} finally {
				keys.close();
			}
		});
	});

	test("rejects spend and returnWhen without drain, unknown values, and triggers without their spend class", async () => {
		const store = () => new SqliteAuthCredentialStore(new Database(":memory:"));
		const build = (policy: Partial<AuthAccountPolicy>) => () =>
			new AuthStorage(store(), {
				accountPolicies: [{ provider: PROVIDER, account: { accountId: "acc-b" }, ...policy }],
			});
		expect(build({ spend: ["credits"] })).toThrow(/require drain: true/);
		expect(build({ drain: true, spend: ["gold" as "plan"] })).toThrow(/spend must be a list/);
		expect(build({ drain: true, returnWhen: [] })).toThrow(/returnWhen must be/);
		expect(build({ drain: true, returnWhen: "credits-added" })).toThrow(
			"auth.accountPolicies[0].returnWhen credits-added requires spend to include credits",
		);
		expect(build({ drain: true, spend: null as unknown as [] })).toThrow(/spend must be a list/);
		const parse = (policy: Record<string, unknown>) =>
			loadAuthAccountPolicyConfig({
				accountPolicies: [{ provider: PROVIDER, account: { accountId: "acc-b" }, ...policy }],
			});
		await expect(parse({ drain: true, spend: "credits" })).rejects.toThrow(/spend must be a list/);
		await expect(parse({ drain: true, returnWhen: "later" })).rejects.toThrow(/returnWhen must be/);
		await expect(parse({ drain: true, returnWhen: [] })).rejects.toThrow(/returnWhen must be/);
		await expect(parse({ returnWhen: "reset" })).rejects.toThrow(/require drain: true/);
		const limit = { metric: "requests", max: 1, window: { type: "calendar", period: "day" } } as const;
		expect(build({ limits: [{ ...limit, id: "shared" }] as never })).toThrow(
			"auth.accountPolicies[0].limits[0].id is not allowed on an account limit",
		);
		await expect(parse({ limits: [{ ...limit, id: "shared" }] })).rejects.toThrow(
			"auth.accountPolicies[0].limits[0].id is not allowed on an account limit",
		);
		expect((await parse({ limits: [limit] })).accountPolicies[0]?.limits).toEqual([{ ...limit, onLimit: "skip" }]);
		const usage = { metric: "usage", max: 0.9 } as const;
		const onKey = { provider: PROVIDER, account: { keyFingerprint: "0123abcd4567ef89" } };
		expect(
			() => new AuthStorage(store(), { accountPolicies: [{ ...onKey, limits: [{ ...usage, onLimit: "skip" }] }] }),
		).toThrow("auth.accountPolicies[0].limits[0].metric applies to OAuth accounts only");
		await expect(loadAuthAccountPolicyConfig({ accountPolicies: [{ ...onKey, limits: [usage] }] })).rejects.toThrow(
			"auth.accountPolicies[0].limits[0].metric applies to OAuth accounts only",
		);
		expect((await parse({ limits: [usage] })).accountPolicies[0]?.limits).toEqual([{ ...usage, onLimit: "skip" }]);
		await expect(parse({ drain: true, spend: ["credits"], returnWhen: ["money-available"] })).rejects.toThrow(
			"auth.accountPolicies[0].returnWhen money-available requires spend to include money",
		);
		await expect(parse({ drain: true, returnWhen: "credits-added" })).rejects.toThrow(
			"auth.accountPolicies[0].returnWhen credits-added requires spend to include credits",
		);
		expect((await parse({ drain: true, spend: ["credits"], returnWhen: "credits-added" })).accountPolicies).toEqual([
			{
				provider: PROVIDER,
				account: { accountId: "acc-b" },
				drain: true,
				spend: ["credits"],
				returnWhen: "credits-added",
			},
		]);
	});

	test("rejects malformed drain fields in policies and in the config parser", async () => {
		const store = () => new SqliteAuthCredentialStore(new Database(":memory:"));
		const build = (policy: AuthAccountPolicy) => () => new AuthStorage(store(), { accountPolicies: [policy] });
		expect(build({ provider: PROVIDER, account: { keyFingerprint: "0123abcd4567ef89" }, drain: true })).toThrow(
			/OAuth accounts only/,
		);
		expect(build({ provider: PROVIDER, account: { accountId: "acc-a" }, returnMargin: 150 })).toThrow(/returnMargin/);
		await expect(
			loadAuthAccountPolicyConfig({
				accountPolicies: [{ provider: PROVIDER, account: { accountId: "acc-a" }, drain: "yes" }],
			}),
		).rejects.toThrow(/drain must be a boolean/);
	});
});
