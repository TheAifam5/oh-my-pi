import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { logoutProviderCredentials } from "@oh-my-pi/pi-coding-agent/cli/auth-broker-cli";

async function anthropicStore(): Promise<SqliteAuthCredentialStore> {
	const store = new SqliteAuthCredentialStore(new Database(":memory:"));
	await store.upsertAuthCredential("anthropic", {
		type: "oauth",
		access: "access",
		refresh: "refresh",
		expires: Date.now() + 3_600_000,
		email: "user@example.com",
	});
	await store.upsertAuthCredential("anthropic", { type: "api_key", key: "sk-ant-api03-login", source: "login" });
	await store.upsertAuthCredential("anthropic", { type: "api_key", key: "sk-ant-api03-legacy" });
	return store;
}

function kinds(store: SqliteAuthCredentialStore): string[] {
	return store
		.listAuthCredentials("anthropic")
		.map(row => (row.credential.type === "oauth" ? "oauth" : row.credential.key))
		.sort();
}

describe("omp auth-broker logout", () => {
	test("the Console API-key alias removes only login-stored anthropic keys", async () => {
		const store = await anthropicStore();
		try {
			const result = await logoutProviderCredentials(store, "anthropic-api-key");
			expect(result).toEqual({ provider: "anthropic", scope: "login-keys", removed: 1 });
			expect(kinds(store)).toEqual(["oauth", "sk-ant-api03-legacy"]);
		} finally {
			store.close();
		}
	});

	test("the provider id itself still removes every anthropic credential", async () => {
		const store = await anthropicStore();
		try {
			const result = await logoutProviderCredentials(store, "anthropic");
			expect(result).toEqual({ provider: "anthropic", scope: "provider" });
			expect(kinds(store)).toEqual([]);
		} finally {
			store.close();
		}
	});

	test("an OAuth login alias removes nothing and names the commands to use", async () => {
		const store = new SqliteAuthCredentialStore(new Database(":memory:"));
		try {
			await store.upsertAuthCredential("openai-codex", {
				type: "oauth",
				access: "access",
				refresh: "refresh",
				expires: Date.now() + 3_600_000,
				email: "user@example.com",
			});
			const result = await logoutProviderCredentials(store, "openai-codex-device");
			expect(result.scope).toBe("refused");
			expect(result.scope === "refused" ? result.message : "").toContain("auth-broker logout openai-codex");
			expect(result.scope === "refused" ? result.message : "").toContain("account logout openai-codex/<account>");
			expect(store.listAuthCredentials("openai-codex")).toHaveLength(1);
		} finally {
			store.close();
		}
	});
});
