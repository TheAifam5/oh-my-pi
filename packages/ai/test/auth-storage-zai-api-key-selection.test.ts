import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AuthCredentialStore, AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { USAGE_REPORT_TTL_MS } from "@oh-my-pi/pi-ai/auth/sqlite-credential-store";
import type { UsageProvider, UsageReport } from "@oh-my-pi/pi-ai/usage";
import { removeWithRetries } from "../../utils/src/temp";

const HOUR_MS = 60 * 60 * 1000;

describe("AuthStorage Z.AI API-key usage ranking", () => {
	let tempDir = "";
	let store: AuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;
	const usageByKey = new Map<string, UsageReport>();

	const usageProvider: UsageProvider = {
		id: "zai",
		async fetchUsage(params) {
			const apiKey = params.credential.apiKey;
			if (!apiKey) return null;
			return usageByKey.get(apiKey) ?? null;
		},
		supports: params => params.provider === "zai" && params.credential.type === "api_key",
	};

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-zai-selection-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		authStorage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "zai" ? usageProvider : undefined),
			async configValueResolver(config) {
				if (config === "ZAI_EXHAUSTED_REF") return "zai-exhausted";
				if (config === "ZAI_HEALTHY_REF") return "zai-healthy";
				return config;
			},
		});
		usageByKey.clear();
	});

	afterEach(async () => {
		setSystemTime();
		authStorage?.close();
		store?.close();
		store = null;
		authStorage = null;
		if (tempDir.length > 0) {
			await removeWithRetries(tempDir);
		}
		tempDir = "";
	});

	test("skips an exhausted login API key when a Z.AI sibling has request quota", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.credentials.set("zai", [
			{ type: "api_key", key: "zai-exhausted", source: "login" },
			{ type: "api_key", key: "zai-healthy", source: "login" },
		]);
		usageByKey.set("zai-exhausted", {
			provider: "zai",
			fetchedAt: Date.now(),
			limits: [
				{
					id: "zai:requests:5h",
					label: "ZAI Request Quota",
					scope: { provider: "zai", windowId: "5h", shared: true },
					window: { id: "5h", label: "5 Hour", durationMs: 5 * HOUR_MS, resetsAt: Date.now() + HOUR_MS },
					amount: {
						unit: "requests",
						used: 100,
						limit: 100,
						remaining: 0,
						usedFraction: 1,
						remainingFraction: 0,
					},
					status: "exhausted",
				},
			],
		});
		usageByKey.set("zai-healthy", {
			provider: "zai",
			fetchedAt: Date.now(),
			limits: [
				{
					id: "zai:requests:5h",
					label: "ZAI Request Quota",
					scope: { provider: "zai", windowId: "5h", shared: true },
					window: { id: "5h", label: "5 Hour", durationMs: 5 * HOUR_MS, resetsAt: Date.now() + 2 * HOUR_MS },
					amount: {
						unit: "requests",
						used: 20,
						limit: 100,
						remaining: 80,
						usedFraction: 0.2,
						remainingFraction: 0.8,
					},
					status: "ok",
				},
			],
		});

		expect(await authStorage.keys.get("zai")).toBe("zai-healthy");
	});

	test("resolves stored API-key references before probing Z.AI usage", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.credentials.set("zai", [
			{ type: "api_key", key: "ZAI_EXHAUSTED_REF", source: "login" },
			{ type: "api_key", key: "ZAI_HEALTHY_REF", source: "login" },
		]);
		usageByKey.set("zai-exhausted", {
			provider: "zai",
			fetchedAt: Date.now(),
			limits: [
				{
					id: "zai:requests:5h",
					label: "ZAI Request Quota",
					scope: { provider: "zai", windowId: "5h", shared: true },
					window: { id: "5h", label: "5 Hour", durationMs: 5 * HOUR_MS, resetsAt: Date.now() + HOUR_MS },
					amount: {
						unit: "requests",
						used: 100,
						limit: 100,
						remaining: 0,
						usedFraction: 1,
						remainingFraction: 0,
					},
					status: "exhausted",
				},
			],
		});
		usageByKey.set("zai-healthy", {
			provider: "zai",
			fetchedAt: Date.now(),
			limits: [
				{
					id: "zai:requests:5h",
					label: "ZAI Request Quota",
					scope: { provider: "zai", windowId: "5h", shared: true },
					window: { id: "5h", label: "5 Hour", durationMs: 5 * HOUR_MS, resetsAt: Date.now() + 2 * HOUR_MS },
					amount: {
						unit: "requests",
						used: 20,
						limit: 100,
						remaining: 80,
						usedFraction: 0.2,
						remainingFraction: 0.8,
					},
					status: "ok",
				},
			],
		});
		expect(await authStorage.keys.get("zai")).toBe("zai-healthy");
	});

	test("markUsageLimitReached inspects usage report for API keys to determine accurate reset time", async () => {
		if (!authStorage || !store?.listCredentialBlocks) throw new Error("test setup failed");

		await authStorage.credentials.set("zai", [
			{ type: "api_key", key: "zai-acc1", source: "login" },
			{ type: "api_key", key: "zai-acc2", source: "login" },
		]);
		const earlyReset = Date.now() + HOUR_MS;
		const futureReset = Date.now() + 24 * HOUR_MS;
		usageByKey.set("zai-acc1", {
			provider: "zai",
			fetchedAt: Date.now(),
			limits: [
				{
					id: "zai:requests:5h",
					label: "ZAI Request Quota",
					scope: { provider: "zai", windowId: "5h", shared: true },
					window: { id: "5h", label: "5 Hour", durationMs: 5 * HOUR_MS, resetsAt: earlyReset },
					amount: {
						unit: "requests",
						used: 100,
						limit: 100,
						remaining: 0,
						usedFraction: 1,
						remainingFraction: 0,
					},
					status: "exhausted",
				},
				{
					id: "zai:credits:1w",
					label: "ZAI Weekly Credit Quota",
					scope: { provider: "zai", windowId: "1w", shared: true },
					window: { id: "1w", label: "Weekly", durationMs: 7 * 24 * HOUR_MS, resetsAt: futureReset },
					amount: {
						unit: "credits",
						used: 140000,
						limit: 140000,
						remaining: 0,
						usedFraction: 1,
						remainingFraction: 0,
					},
					status: "exhausted",
				},
			],
		});

		const outcome = await authStorage.limits.markReached("zai", "session-xyz", {
			apiKey: "zai-acc1",
		});

		const blockedRow = store
			.listAuthCredentials("zai")
			.find(entry => entry.credential.type === "api_key" && entry.credential.key === "zai-acc1");
		if (!blockedRow) throw new Error("blocked credential missing");
		expect(outcome.switched).toBe(true);
		expect(store.listCredentialBlocks([blockedRow.id]).map(block => block.blockedUntilMs)).toContain(futureReset);
		expect(await authStorage.keys.get("zai", "session-xyz")).toBe("zai-acc2");
	});

	test("ignores exhausted Z.AI feature quotas for model request routing", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.credentials.set("zai", [
			{ type: "api_key", key: "zai-feature-exhausted", source: "login" },
			{ type: "api_key", key: "zai-general-busier", source: "login" },
		]);
		usageByKey.set("zai-feature-exhausted", {
			provider: "zai",
			fetchedAt: Date.now(),
			limits: [
				{
					id: "zai:features:zread:5h",
					label: "ZAI Zread Quota",
					scope: { provider: "zai", windowId: "5h", tier: "zread", shared: false },
					window: { id: "5h", label: "5 Hour", durationMs: 5 * HOUR_MS, resetsAt: Date.now() + HOUR_MS },
					amount: {
						unit: "requests",
						used: 100,
						limit: 100,
						remaining: 0,
						usedFraction: 1,
						remainingFraction: 0,
					},
					status: "exhausted",
				},
				{
					id: "zai:requests:5h",
					label: "ZAI Request Quota",
					scope: { provider: "zai", windowId: "5h", shared: true },
					window: { id: "5h", label: "5 Hour", durationMs: 5 * HOUR_MS, resetsAt: Date.now() + 2 * HOUR_MS },
					amount: {
						unit: "requests",
						used: 10,
						limit: 100,
						remaining: 90,
						usedFraction: 0.1,
						remainingFraction: 0.9,
					},
					status: "ok",
				},
			],
		});
		usageByKey.set("zai-general-busier", {
			provider: "zai",
			fetchedAt: Date.now(),
			limits: [
				{
					id: "zai:requests:5h",
					label: "ZAI Request Quota",
					scope: { provider: "zai", windowId: "5h", shared: true },
					window: { id: "5h", label: "5 Hour", durationMs: 5 * HOUR_MS, resetsAt: Date.now() + 2 * HOUR_MS },
					amount: {
						unit: "requests",
						used: 80,
						limit: 100,
						remaining: 20,
						usedFraction: 0.8,
						remainingFraction: 0.2,
					},
					status: "ok",
				},
			],
		});

		expect(await authStorage.keys.get("zai")).toBe("zai-feature-exhausted");
	});

	test("a live report showing recovered token quota lifts a Z.AI API key's quota block", async () => {
		if (!authStorage || !store?.listCredentialBlocks) throw new Error("test setup failed");
		const start = Date.UTC(2026, 9, 20, 12, 0);
		setSystemTime(start);
		const quota = (id: string, unit: "requests" | "tokens", used: number) => ({
			id,
			label: id,
			scope: { provider: "zai", windowId: "5h", shared: true },
			window: { id: "5h", label: "5 Hour", durationMs: 5 * HOUR_MS, resetsAt: start + 4 * HOUR_MS },
			amount: {
				unit,
				used,
				limit: 100,
				remaining: 100 - used,
				usedFraction: used / 100,
				remainingFraction: 1 - used / 100,
			},
			status: used >= 100 ? ("exhausted" as const) : ("ok" as const),
		});
		const zaiReport = (requestsUsed: number, tokensUsed: number): UsageReport => ({
			provider: "zai",
			fetchedAt: Date.now(),
			limits: [quota("zai:requests:5h", "requests", requestsUsed), quota("zai:tokens:5h", "tokens", tokensUsed)],
		});
		await authStorage.credentials.set("zai", [
			{ type: "api_key", key: "zai-recovering", source: "login" },
			{ type: "api_key", key: "zai-busier", source: "login" },
		]);
		usageByKey.set("zai-recovering", zaiReport(10, 100));
		usageByKey.set("zai-busier", zaiReport(70, 20));
		expect(await authStorage.keys.get("zai")).toBe("zai-busier");
		const recovering = store
			.listAuthCredentials("zai")
			.find(entry => entry.credential.type === "api_key" && entry.credential.key === "zai-recovering");
		if (!recovering) throw new Error("blocked credential missing");
		expect(store.listCredentialBlocks([recovering.id]).map(block => block.blockScope)).toEqual(["quota"]);

		// A report still inside the block's probe window cannot lift it; a later live one can.
		setSystemTime(start + 2 * USAGE_REPORT_TTL_MS);
		usageByKey.set("zai-recovering", zaiReport(10, 30));
		usageByKey.set("zai-busier", zaiReport(70, 20));
		expect(await authStorage.keys.get("zai")).toBe("zai-recovering");
		expect(store.listCredentialBlocks([recovering.id])).toEqual([]);
	});

	test("a Z.AI usage-limit error's retry hint outlasts a recovered quota, while the report's quota block lifts", async () => {
		if (!authStorage || !store?.listCredentialBlocks) throw new Error("test setup failed");
		const start = Date.UTC(2026, 9, 20, 12, 0);
		setSystemTime(start);
		const tokens = (used: number): UsageReport => ({
			provider: "zai",
			fetchedAt: Date.now(),
			limits: [
				{
					id: "zai:tokens:5h",
					label: "ZAI Token Quota",
					scope: { provider: "zai", windowId: "5h", shared: true },
					window: { id: "5h", label: "5 Hour", durationMs: 5 * HOUR_MS, resetsAt: start + 4 * HOUR_MS },
					amount: { unit: "tokens", used, limit: 100, usedFraction: used / 100 },
					status: used >= 100 ? "exhausted" : "ok",
				},
			],
		});
		await authStorage.credentials.set("zai", [
			{ type: "api_key", key: "zai-limited", source: "login" },
			{ type: "api_key", key: "zai-sibling", source: "login" },
		]);
		usageByKey.set("zai-limited", tokens(100));
		usageByKey.set("zai-sibling", tokens(80));
		await authStorage.limits.markReached("zai", "session-hint", {
			apiKey: "zai-limited",
			retryAfterMs: 2 * HOUR_MS,
			providerTimed: true,
		});
		const limited = store
			.listAuthCredentials("zai")
			.find(entry => entry.credential.type === "api_key" && entry.credential.key === "zai-limited");
		const listBlocks = store.listCredentialBlocks.bind(store);
		if (!limited) throw new Error("blocked credential missing");
		const blocks = () =>
			listBlocks([limited.id]).map(({ blockScope, blockedUntilMs }) => ({ blockScope, blockedUntilMs }));
		expect(blocks()).toEqual([
			{ blockScope: "credits", blockedUntilMs: start + 2 * HOUR_MS },
			{ blockScope: "quota", blockedUntilMs: start + 4 * HOUR_MS },
		]);

		setSystemTime(start + 2 * USAGE_REPORT_TTL_MS);
		usageByKey.set("zai-limited", tokens(10));
		await authStorage.usage.reports();
		expect(blocks()).toEqual([{ blockScope: "credits", blockedUntilMs: start + 2 * HOUR_MS }]);
		expect(await authStorage.keys.get("zai")).toBe("zai-sibling");
	});
});
