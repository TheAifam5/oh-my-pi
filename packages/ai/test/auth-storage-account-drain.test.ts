import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, setSystemTime, test, vi } from "bun:test";
import { loadAuthAccountPolicyConfig } from "@oh-my-pi/pi-ai/auth-broker";
import {
	type AuthAccountPolicies,
	type AuthAccountPolicy,
	AuthStorage,
	SqliteAuthCredentialStore,
} from "@oh-my-pi/pi-ai/auth-storage";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";
import type { CredentialRankingStrategy, UsageProvider, UsageReport } from "@oh-my-pi/pi-ai/usage";
import {
	type BillingSourceState,
	creditsFromDecimal,
	knownBilling,
	unknownBilling,
} from "@oh-my-pi/pi-ai/usage/billing";
import { logger } from "@oh-my-pi/pi-utils";

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
			metadata: { accountId, credits: credits.get(accountId), money: money.get(accountId) },
			limits,
		};
	}

	beforeEach(async () => {
		setSystemTime(new Date("2026-10-05T10:00:00Z"));
		used.clear();
		overage.clear();
		credits.clear();
		money.clear();
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			return credential ? { newCredentials: credential, apiKey: credential.access } : null;
		});
		const usageProvider: UsageProvider = {
			id: PROVIDER,
			fetchUsage: async params => (params.credential.accountId ? report(params.credential.accountId) : null),
		};
		storage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")), {
			accountPolicies: POLICIES,
			usageProviderResolver: provider => (provider === PROVIDER ? usageProvider : undefined),
			rankingStrategyResolver: provider => (provider === PROVIDER ? strategy : undefined),
		});
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b")]);
	});

	afterEach(() => {
		storage.close();
		vi.restoreAllMocks();
		setSystemTime();
	});

	/** Billing source reading the fake report's `credits` and `money` metadata. */
	function installBilling(): void {
		storage.usage.setBillingSource({
			read: (_provider, usage) => {
				if (usage.metadata?.credits === undefined && usage.metadata?.money === undefined) {
					return unknownBilling(usage, "no-evidence");
				}
				const balance = usage.metadata?.credits;
				const remaining = typeof balance === "string" ? creditsFromDecimal(balance, "floor") : undefined;
				const moneyState = usage.metadata?.money;
				return knownBilling(usage, [
					{ mode: "subscription-included", state: "unknown" },
					{
						mode: "prepaid-credits",
						state: remaining ? (remaining.amountMinor > 0 ? "available" : "exhausted") : "unknown",
						...(remaining ? { allowance: { kind: "credits" as const, remaining } } : {}),
					},
					{
						mode: "paid-extra-usage",
						state: typeof moneyState === "string" ? (moneyState as BillingSourceState) : "unknown",
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
		expect(build({ provider: PROVIDER, account: { keyFingerprint: "0123abcd" }, drain: true })).toThrow(
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
