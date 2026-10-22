import { afterEach, describe, expect, it } from "bun:test";
import { createApiKeyResolver } from "@oh-my-pi/pi-coding-agent/config/api-key-resolver";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";

const PROVIDER = "openai-codex";
const MODEL_ID = "gpt-daybreak-blue-latest";
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function codexCredential(accountId: string, email: string) {
	return {
		type: "oauth" as const,
		access: `access-${accountId}`,
		refresh: `refresh-${accountId}`,
		expires: Date.now() + WEEK_MS,
		accountId,
		email,
	};
}

describe("api key resolver entitlement", () => {
	let authStorage: AuthStorage | undefined;

	afterEach(() => {
		authStorage?.close();
		authStorage = undefined;
	});

	it("does not rotate a fresh store's usage-limited session onto an account the model does not list", async () => {
		authStorage = await AuthStorage.create(":memory:", { usageProviderResolver: () => undefined });
		await authStorage.credentials.set(PROVIDER, [
			codexCredential("account-entitled", "entitled@example.com"),
			codexCredential("account-other", "other@example.com"),
		]);
		const entitled = authStorage.sessions
			.accounts(PROVIDER)
			.find(account => account.accountId === "account-entitled");
		if (!entitled) throw new Error("expected the entitled Codex account");
		const sessionId = "entitlement-fresh-store";
		expect(authStorage.sessions.pin(PROVIDER, sessionId, entitled.credentialId, { restoredAtMs: Date.now() })).toBe(
			true,
		);
		const store = authStorage;
		const resolver = createApiKeyResolver(
			{
				getApiKeyWithCredentialForProvider: (provider, session, options) =>
					store.keys.getWithCredential(provider, session, options),
				authStorage: store,
			},
			PROVIDER,
			{ sessionId, modelId: MODEL_ID, accountIds: ["account-entitled"] },
		);

		const resolved = await resolver({
			lastChance: true,
			error: new Error("usage_limit_reached: The usage limit has been reached"),
		});

		expect(resolved).toBeUndefined();
	});
});
