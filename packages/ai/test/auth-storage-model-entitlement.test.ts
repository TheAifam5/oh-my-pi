import { afterEach, beforeEach, describe, expect, setSystemTime, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { CredentialBlocks } from "@oh-my-pi/pi-ai/auth/blocks";
import { MODEL_ENTITLEMENT_DENIAL_TTL_MS } from "@oh-my-pi/pi-ai/auth/entitlement";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { ProviderHttpError } from "@oh-my-pi/pi-ai/error";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";
import type { OAuthCredentials } from "@oh-my-pi/pi-ai/registry/oauth/types";
import { removeWithRetries } from "../../utils/src/temp";
import { OAuthRefresher } from "../src/auth/refresh";

const CODEX = "openai-codex";
const DAYBREAK = "gpt-daybreak-blue-latest";
const ANTHROPIC = "anthropic";
const MYTHOS = "claude-mythos-5";
const SONNET = "claude-sonnet-5-5";
const HOUR_MS = 60 * 60_000;

function farExpiry(): number {
	return Date.now() + 30 * 24 * HOUR_MS;
}

function usageLimitError(): Error & { status: number } {
	return Object.assign(new Error("You have hit your usage limit. Try again in ~158 min."), { status: 429 });
}

describe("model entitlement routing", () => {
	let tempDir = "";
	let dbPath = "";
	const stores: SqliteAuthCredentialStore[] = [];

	async function open(): Promise<AuthStorage> {
		const store = await SqliteAuthCredentialStore.open(dbPath);
		stores.push(store);
		const storage = new AuthStorage(store, { usageProviderResolver: () => undefined });
		await storage.credentials.reload();
		return storage;
	}

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-model-entitlement-"));
		dbPath = path.join(tempDir, "agent.db");
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider] as OAuthCredentials | undefined;
			return credential ? { apiKey: credential.access, newCredentials: credential } : null;
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		setSystemTime();
		for (const store of stores.splice(0)) store.close();
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	test("a Codex model never reaches an account its access list omits, even when the listed account cannot serve", async () => {
		const storage = await open();
		await storage.credentials.set(CODEX, [
			{ type: "oauth", access: "access-private", refresh: "refresh-private", expires: 0, accountId: "private" },
			{ type: "oauth", access: "access-work", refresh: "refresh-work", expires: farExpiry(), accountId: "work" },
		]);
		vi.spyOn(OAuthRefresher.prototype, "refresh").mockImplementation(async (_provider, credential) => {
			if (credential.accountId === "private") throw new Error("ECONNRESET network error");
			return credential;
		});

		expect(await storage.keys.get(CODEX, "advisor", { modelId: DAYBREAK, accountIds: ["private"] })).toBeUndefined();
		expect(await storage.keys.get(CODEX, "main", { modelId: "gpt-6-luna" })).toBe("access-work");
	});

	test("Codex rotation reports no switch when only accounts outside the model's access list are free", async () => {
		const storage = await open();
		await storage.credentials.set(CODEX, [
			{ type: "oauth", access: "access-private", refresh: "r1", expires: farExpiry(), accountId: "private" },
			{ type: "oauth", access: "access-work", refresh: "r2", expires: farExpiry(), accountId: "work" },
		]);

		storage.setModelAccountAccess(CODEX, DAYBREAK, ["private"]);
		const first = await storage.keys.get(CODEX, "advisor", { modelId: DAYBREAK });
		expect(first).toBe("access-private");
		const rotation = await storage.limits.rotate(CODEX, "advisor", {
			error: usageLimitError(),
			modelId: DAYBREAK,
			apiKey: first,
		});
		expect(rotation).toEqual({ switched: false });
		expect(await storage.keys.get(CODEX, "advisor", { modelId: DAYBREAK, accountIds: ["private"] })).toBe(
			"access-private",
		);
	});

	test("explicit access overrides do not replace registered entitlement and clearing registration removes it", async () => {
		const storage = await open();
		await storage.credentials.set(CODEX, [
			{ type: "oauth", access: "access-private", refresh: "r1", expires: farExpiry(), accountId: "private" },
			{ type: "oauth", access: "access-work", refresh: "r2", expires: farExpiry(), accountId: "work" },
		]);
		storage.setModelAccountAccess(CODEX, DAYBREAK, ["private"]);
		expect(await storage.keys.get(CODEX, "override", { modelId: DAYBREAK, accountIds: ["work"] })).toBe(
			"access-work",
		);
		expect(await storage.keys.get(CODEX, "registered", { modelId: DAYBREAK })).toBe("access-private");
		storage.setModelAccountAccess(CODEX, DAYBREAK);
		expect(
			(
				await storage.limits.rotate(CODEX, "registered", {
					modelId: DAYBREAK,
					apiKey: "access-private",
					error: usageLimitError(),
				})
			).switched,
		).toBe(true);
	});

	test("a learned Anthropic model denial excludes that account for that model only, across restarts, until it expires", async () => {
		const storage = await open();
		await storage.credentials.set(ANTHROPIC, [
			{ type: "oauth", access: "access-denied", refresh: "r1", expires: farExpiry(), email: "denied@example.com" },
			{ type: "oauth", access: "access-entitled", refresh: "r2", expires: farExpiry(), email: "ok@example.com" },
		]);
		const deniedId = storage.credentials
			.list(ANTHROPIC)
			.find(row => row.credential.type === "oauth" && row.credential.access === "access-denied")?.id;
		if (deniedId === undefined) throw new Error("expected denied row");
		storage.sessions.pin(ANTHROPIC, "security", deniedId, { restoredAtMs: Date.now() });
		expect(await storage.keys.get(ANTHROPIC, "security", { modelId: MYTHOS })).toBe("access-denied");

		const rotation = await storage.limits.rotate(ANTHROPIC, "security", {
			error: new ProviderHttpError("This model is not available for your account.", 403, {
				code: "permission_error",
			}),
			modelId: MYTHOS,
			apiKey: "access-denied",
		});
		expect(rotation.switched).toBe(true);
		expect(await storage.keys.get(ANTHROPIC, "security", { modelId: MYTHOS })).toBe("access-entitled");

		const restarted = await open();
		// The entitled account exhausting its quota leaves no entitled sibling: no switch, and the
		// denied account is not handed out for the model even as a last resort.
		const mark = await restarted.limits.markReached(ANTHROPIC, "security", {
			apiKey: "access-entitled",
			modelId: MYTHOS,
			retryAfterMs: HOUR_MS,
		});
		expect(mark.switched).toBe(false);
		for (let attempt = 0; attempt < 3; attempt += 1) {
			expect(await restarted.keys.get(ANTHROPIC, `security-${attempt}`, { modelId: MYTHOS })).toBe(
				"access-entitled",
			);
		}
		// Past the account-wide policy backoff, other models use the denied account again.
		setSystemTime(new Date(Date.now() + 2 * 60_000));
		expect(await restarted.keys.get(ANTHROPIC, "main", { modelId: SONNET })).toBe("access-denied");

		setSystemTime(new Date(Date.now() + MODEL_ENTITLEMENT_DENIAL_TTL_MS + 60_000));
		const later = await open();
		const laterRotation = await later.limits.rotate(ANTHROPIC, "security-later", {
			error: usageLimitError(),
			modelId: MYTHOS,
			apiKey: "access-entitled",
		});
		expect(laterRotation.switched).toBe(true);
		expect(await later.keys.get(ANTHROPIC, "security-later", { modelId: MYTHOS })).toBe("access-denied");
	});

	test("an organization-wide OAuth refusal records no model denial", async () => {
		const storage = await open();
		await storage.credentials.set(ANTHROPIC, [
			{ type: "oauth", access: "access-a", refresh: "r1", expires: farExpiry(), email: "a@example.com" },
		]);
		await storage.limits.rotate(ANTHROPIC, "s", {
			error: new ProviderHttpError("OAuth authentication is currently not allowed for this organization.", 403, {
				code: "permission_error",
			}),
			modelId: MYTHOS,
			apiKey: "access-a",
		});

		setSystemTime(new Date(Date.now() + HOUR_MS));
		const later = await open();
		expect(await later.keys.get(ANTHROPIC, "s", { modelId: MYTHOS })).toBe("access-a");
	});

	test("recordModelDenial honors an explicit lifetime for the named credential", async () => {
		const storage = await open();
		await storage.credentials.set(ANTHROPIC, [
			{ type: "oauth", access: "access-a", refresh: "r1", expires: farExpiry(), email: "a@example.com" },
		]);
		const [row] = storage.credentials.list(ANTHROPIC);
		if (!row) throw new Error("expected row");

		expect(
			await storage.limits.recordModelDenial(ANTHROPIC, undefined, {
				modelId: MYTHOS,
				credentialId: row.id,
				ttlMs: HOUR_MS,
			}),
		).toBe(true);
		expect(await storage.keys.get(ANTHROPIC, "s", { modelId: MYTHOS })).toBeUndefined();
		expect(await storage.keys.get(ANTHROPIC, "s", { modelId: SONNET })).toBe("access-a");

		setSystemTime(new Date(Date.now() + HOUR_MS + 1_000));
		expect(await storage.keys.get(ANTHROPIC, "s", { modelId: MYTHOS })).toBe("access-a");
	});

	test("clearing an account's blocks after a reset keeps its model entitlement denial", async () => {
		const storage = await open();
		await storage.credentials.set(CODEX, [
			{ type: "oauth", access: "access-a", refresh: "r1", expires: farExpiry(), accountId: "a" },
		]);
		const [row] = storage.credentials.list(CODEX);
		if (!row) throw new Error("expected row");
		await storage.limits.recordModelDenial(CODEX, undefined, { modelId: DAYBREAK, credentialId: row.id });
		await storage.limits.markReached(CODEX, undefined, { credentialId: row.id, retryAfterMs: HOUR_MS });

		(storage.blocks as CredentialBlocks).clearAll(CODEX, row.id);

		expect(await storage.keys.get(CODEX, "s", { modelId: "gpt-6-luna" })).toBe("access-a");
		expect(await storage.keys.get(CODEX, "s", { modelId: DAYBREAK })).toBeUndefined();
		expect(await (await open()).keys.get(CODEX, "s", { modelId: DAYBREAK })).toBeUndefined();
	});
});
