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
		return { provider: PROVIDER, fetchedAt: Date.now(), metadata: { accountId }, limits };
	}

	beforeEach(async () => {
		setSystemTime(new Date("2026-10-05T10:00:00Z"));
		used.clear();
		overage.clear();
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

	async function advance(ms: number): Promise<string | undefined> {
		setSystemTime(new Date(Date.now() + ms));
		await storage.usage.invalidate(PROVIDER);
		return storage.keys.get(PROVIDER, SESSION);
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
