import { Database } from "bun:sqlite";
import { describe, expect, test, vi } from "bun:test";
import type { ApiKeyResolver } from "@oh-my-pi/pi-ai/auth-retry";
import { resolveCredentialIdentityKey } from "@oh-my-pi/pi-ai/auth/sqlite-credential-store";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "../../src/config/settings";
import {
	CodexSecurityCloudClient,
	createExactSecurityOAuthResolver,
	createSecurityAuthResolver,
	resolveExactSecurityOAuthAccess,
	selectSecurityAuth,
} from "../../src/security";
import { AuthStorage, SqliteAuthCredentialStore } from "../../src/session/auth-storage";
import type { ToolSession } from "../../src/tools";
import { SecurityScanTool } from "../../src/tools/security-scan";

function model() {
	const value = getBundledModel("openai-codex", "gpt-5.6-sol");
	if (!value) throw new Error("Expected bundled Codex model");
	return value;
}

describe("exact security OAuth resolver", () => {
	test("selects an explicit credential without account rotation", () => {
		const listOAuthAccounts = vi.fn(() => [
			{ credentialId: 11, position: 0, active: true, accountId: "workspace-a" },
			{ credentialId: 42, position: 1, active: false, accountId: "workspace-b" },
		]);
		const selected = selectSecurityAuth(
			{ oauth: { accounts: listOAuthAccounts } } as unknown as AuthStorage,
			model(),
			42,
			"session-a",
		);
		expect(selected).toEqual({ provider: "openai-codex", credentialId: 42, accountId: "workspace-b" });
		expect(listOAuthAccounts).toHaveBeenCalledWith("openai-codex", "session-a");
	});

	test("a restricted session cannot select or resolve an account outside its pool", async () => {
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			return credential ? { newCredentials: credential, apiKey: credential.access } : null;
		});
		const authStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
		try {
			const credential = (suffix: string) => ({
				type: "oauth" as const,
				access: `access-${suffix}`,
				refresh: `refresh-${suffix}`,
				expires: Date.now() + 60 * 60_000,
				accountId: `workspace-${suffix}`,
				email: `${suffix}@example.com`,
			});
			await authStorage.credentials.set("openai-codex", [credential("a"), credential("b")]);
			const [inside, outside] = authStorage.oauth.accounts("openai-codex");
			const insideKey = resolveCredentialIdentityKey("openai-codex", credential("a"));
			if (!inside || !outside || !insideKey) throw new Error("expected stored accounts");
			authStorage.sessions.restrict("openai-codex", "session-a", [insideKey]);

			expect(() => selectSecurityAuth(authStorage, model(), outside.credentialId, "session-a")).toThrow(
				`Security OAuth credential ${outside.credentialId} is not available`,
			);
			expect(selectSecurityAuth(authStorage, model(), undefined, "session-a")).toMatchObject({
				credentialId: inside.credentialId,
			});
			let current: string | undefined = "session-a";
			const exact = (credentialId: number) =>
				createExactSecurityOAuthResolver({
					authStorage,
					account: { provider: "openai-codex", credentialId },
					sessionId: () => current,
				})(model()) as ApiKeyResolver;
			const insideResolver = exact(inside.credentialId);
			const outsideResolver = exact(outside.credentialId);
			const request = { lastChance: false, error: undefined };
			expect(await insideResolver(request)).toBe("access-a");
			await expect(outsideResolver(request)).rejects.toThrow("credential is unavailable");
			// The restriction id is read at each request, not when the resolver was built.
			current = "unrestricted-session";
			expect(await outsideResolver(request)).toBe("access-b");
			// No session id never means unrestricted on these paths.
			current = undefined;
			await expect(insideResolver(request)).rejects.toThrow("credential is unavailable");
			await expect(
				resolveExactSecurityOAuthAccess(
					authStorage,
					{ provider: "openai-codex", credentialId: inside.credentialId },
					{
						forceRefresh: false,
						sessionId: undefined,
					},
				),
			).rejects.toThrow("credential is unavailable");

			const fetched = vi.fn(async () => new Response("{}"));
			const cloud = new CodexSecurityCloudClient({
				authStorage,
				account: { provider: "openai-codex", credentialId: outside.credentialId },
				sessionId: () => current,
				fetch: fetched,
			});
			for (const sessionId of ["session-a", undefined]) {
				current = sessionId;
				await expect(cloud.listAllConfigurations()).rejects.toThrow("credential is unavailable");
			}
			expect(fetched).not.toHaveBeenCalled();
			// Each request reads the current restriction id.
			current = "unrestricted-session";
			await cloud.listAllConfigurations().catch(() => undefined);
			expect(fetched).toHaveBeenCalled();
			current = "session-a";

			// The tool checks the provider session id the restriction is keyed on, not the session file's id.
			vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network disabled"));
			const tool = new SecurityScanTool({
				settings: Settings.isolated({ "security.enabled": true }),
				authStorage,
				getSessionId: () => "session-file",
				getProviderSessionId: () => "session-a",
			} as unknown as ToolSession);
			await expect(
				tool.execute("call", { action: "cloud_scans", credential_id: outside.credentialId }),
			).rejects.toThrow(`Security OAuth credential ${outside.credentialId} is not available`);
		} finally {
			authStorage.close();
			vi.restoreAllMocks();
		}
	});

	test("plans provider-owned authentication for recognized Bedrock routes without OAuth", () => {
		const authStorage = { oauth: { accounts: vi.fn(() => []) } } as unknown as AuthStorage;
		for (const [provider, modelId, api] of [
			["amazon-bedrock", "us.anthropic.claude-opus-4-8", "bedrock-converse-stream"],
			["bedrock-mantle", "openai.gpt-5.6-terra", "openai-responses"],
		] as const) {
			const bedrockModel = getBundledModel(provider, modelId);
			if (!bedrockModel) throw new Error(`Expected bundled model ${provider}/${modelId}`);
			expect(selectSecurityAuth(authStorage, bedrockModel)).toEqual({ provider, api });
		}
	});

	test("rejects unsupported provider-owned authentication routes", () => {
		const authStorage = { oauth: { accounts: vi.fn(() => []) } } as unknown as AuthStorage;
		expect(() => selectSecurityAuth(authStorage, { provider: "openai", api: "openai-responses" })).toThrow(
			"require a stored OAuth account",
		);
		expect(() => selectSecurityAuth(authStorage, { provider: "amazon-bedrock", api: "openai-responses" })).toThrow(
			"do not support provider authentication",
		);
	});

	test("provider-owned resolver stays within the pinned provider and API", () => {
		const bedrockModel = getBundledModel("amazon-bedrock", "us.anthropic.claude-opus-4-8");
		const mantleModel = getBundledModel("bedrock-mantle", "openai.gpt-5.6-terra");
		if (!bedrockModel || !mantleModel) throw new Error("Expected bundled Bedrock models");
		const providerResolver = vi.fn(() => "provider-owned");
		const resolver = createSecurityAuthResolver({
			authStorage: {} as unknown as AuthStorage,
			auth: { provider: bedrockModel.provider, api: bedrockModel.api },
			providerResolver,
			sessionId: () => undefined,
		});
		expect(resolver(bedrockModel)).toBe("provider-owned");
		expect(() => resolver(mantleModel)).toThrow("provider mismatch");
		expect(() => resolver({ ...bedrockModel, api: "openai-responses" })).toThrow("API mismatch");
		expect(providerResolver).toHaveBeenCalledTimes(1);
	});

	test("resolves and refreshes only the pinned durable row", async () => {
		const getOAuthAccessByCredentialId = vi.fn(async (_provider, credentialId, options) => ({
			ok: true as const,
			accessToken: options?.forceRefresh ? "refreshed" : "initial",
			credentialId,
			accountId: "workspace-a",
		}));
		const authStorage = { oauth: { accessById: getOAuthAccessByCredentialId } } as unknown as AuthStorage;
		const resolver = createExactSecurityOAuthResolver({
			authStorage,
			account: { provider: "openai-codex", credentialId: 42, accountId: "workspace-a" },
			sessionId: () => "session-a",
		});
		const apiKey = resolver(model());
		expect(typeof apiKey).toBe("function");
		const exact = apiKey as ApiKeyResolver;
		expect(await exact({ lastChance: false, error: undefined })).toBe("initial");
		expect(await exact({ lastChance: false, error: new Error("401") })).toBe("refreshed");
		expect(await exact({ lastChance: true, error: new Error("401") })).toBeUndefined();
		expect(getOAuthAccessByCredentialId.mock.calls.map(call => call[1])).toEqual([42, 42]);
	});

	test("rejects a model whose provider crosses the pinned OAuth boundary", async () => {
		const getOAuthAccessByCredentialId = vi.fn(async () => ({
			ok: true as const,
			accessToken: "must-not-be-requested",
			credentialId: 42,
			accountId: "workspace-a",
		}));
		const authStorage = { oauth: { accessById: getOAuthAccessByCredentialId } } as unknown as AuthStorage;
		const resolver = createExactSecurityOAuthResolver({
			authStorage,
			account: { provider: "openai-codex", credentialId: 42, accountId: "workspace-a" },
			sessionId: () => "session-a",
		});
		const wrongProviderModel = { ...model(), provider: "anthropic" } as unknown as Parameters<typeof resolver>[0];
		expect(() => resolver(wrongProviderModel)).toThrow("provider mismatch");
		expect(getOAuthAccessByCredentialId).not.toHaveBeenCalled();
	});

	test("fails closed when any durable account identity changes", async () => {
		const account = {
			provider: "openai-codex",
			credentialId: 42,
			accountId: "workspace-a",
			email: "owner@example.com",
			organizationId: "org-a",
			organizationName: "Workspace A",
		};
		const resolved = {
			credentialId: 42,
			accountId: "workspace-a",
			email: "owner@example.com",
			orgId: "org-a",
			orgName: "Workspace A",
		};
		for (const mismatch of [
			{ credentialId: 99 },
			{ accountId: "workspace-b" },
			{ email: "other@example.com" },
			{ orgId: "org-b" },
			{ orgName: "Workspace B" },
		]) {
			const authStorage = {
				oauth: {
					accessById: async () => ({
						ok: true as const,
						accessToken: "token",
						...resolved,
						...mismatch,
					}),
				},
			} as unknown as AuthStorage;
			const resolver = createExactSecurityOAuthResolver({ authStorage, account, sessionId: () => "session-a" });
			const exact = resolver(model()) as ApiKeyResolver;
			await expect(exact({ lastChance: false, error: undefined })).rejects.toThrow("identity mismatch");
		}
	});

	test("fails closed when the refreshed row loses its workspace identity", async () => {
		const authStorage = {
			oauth: {
				accessById: async () => ({
					ok: true as const,
					accessToken: "token",
					credentialId: 42,
					accountId: undefined,
				}),
			},
		} as unknown as AuthStorage;
		const resolver = createExactSecurityOAuthResolver({
			authStorage,
			account: { provider: "openai-codex", credentialId: 42, accountId: "workspace-a" },
			sessionId: () => "session-a",
		});
		const exact = resolver(model()) as ApiKeyResolver;
		let caught: unknown;
		try {
			await exact({ lastChance: false, error: undefined });
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(Error);
		if (!(caught instanceof Error)) throw new Error("expected identity mismatch");
		expect(caught.message).toContain("identity mismatch");
		expect(caught.message).not.toContain("workspace-a");
		expect(caught.message).not.toContain("undefined");
	});
});
