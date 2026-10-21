import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { isAnthropicOAuthToken } from "@oh-my-pi/pi-catalog/utils";
import { ApiKeyRequiredError } from "../src/error/auth";
import { ProviderHttpError } from "../src/error/classes";
import { classify, Flag, is } from "../src/error/flags";
import { apiKeyCredentialSchema } from "../src/auth-broker/wire-schemas";
import { buildAnthropicHeaders, streamAnthropic } from "../src/providers/anthropic";
import type { OAuthPrompt } from "../src/registry/oauth/types";
import type { Context, FetchImpl, Model } from "../src/types";
import { isOAuthToken } from "../src/utils/anthropic-auth";
import { withOfficialAnthropicEndpoint } from "./helpers";

withOfficialAnthropicEndpoint();

const VALID_KEY = "sk-ant-api03-test-key-0000";

const ANTHROPIC_MODEL: Model<"anthropic-messages"> = buildModel({
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
});

const CONTEXT: Context = { messages: [{ role: "user", content: "hello", timestamp: 0 }] };

type Probe = { url: string; headers: Headers; redirect: RequestInit["redirect"] };

async function openStorage(): Promise<{ store: SqliteAuthCredentialStore; storage: AuthStorage }> {
	const store = new SqliteAuthCredentialStore(new Database(":memory:"));
	const storage = new AuthStorage(store);
	await storage.credentials.reload();
	return { store, storage };
}

/**
 * Logs in through the Console API-key alias, pasting `pasted` and then
 * `workspaceId` (empty by default), answering every probe with `respond`.
 */
async function login(pasted: string, respond: () => Response | Promise<Response>, workspaceId = "") {
	const { store, storage } = await openStorage();
	const probes: Probe[] = [];
	const progress: string[] = [];
	const prompts: OAuthPrompt[] = [];
	const fetch: FetchImpl = async (input, init) => {
		probes.push({ url: String(input), headers: new Headers(init?.headers), redirect: init?.redirect });
		return respond();
	};
	const outcome = await storage.oauth
		.login("anthropic-api-key", {
			onAuth: () => {},
			onPrompt: async prompt => {
				prompts.push(prompt);
				return prompts.length === 1 ? pasted : workspaceId;
			},
			onProgress: message => progress.push(message),
			fetch,
		})
		.then(
			identity => ({ identity, error: undefined }),
			(error: unknown) => ({ identity: undefined, error }),
		);
	const stored = store.listAuthCredentials("anthropic").map(row => row.credential);
	const storedUnderAlias = store.listAuthCredentials("anthropic-api-key").length;
	const resolved = await storage.keys.get("anthropic", "session-1");
	const withCredential = await storage.keys.getWithCredential("anthropic", "session-1");
	const source = storage.keys.source("anthropic");
	storage.close();
	return { ...outcome, probes, progress, prompts, stored, storedUnderAlias, resolved, withCredential, source };
}

describe("Anthropic Console API-key login", () => {
	test("the login roster offers the Console key beside the subscription OAuth login, both storing under anthropic", () => {
		const providers = getOAuthProviders();
		const ids = providers.map(provider => provider.id);
		const oauth = ids.indexOf("anthropic");
		expect(ids[oauth + 1]).toBe("anthropic-api-key");
		expect(providers.find(provider => provider.id === "anthropic-api-key")?.storeCredentialsAs).toBe("anthropic");
		expect(providers.find(provider => provider.id === "anthropic")?.storeCredentialsAs).toBeUndefined();
	});

	test("a valid key is checked against GET /v1/models with x-api-key and stored as an anthropic login key", async () => {
		const result = await login(`Bearer ${VALID_KEY}`, () => new Response('{"data":[]}', { status: 200 }));

		expect(result.error).toBeUndefined();
		expect(result.identity).toEqual({ type: "api_key" });
		expect(result.probes).toHaveLength(1);
		const [probe] = result.probes;
		expect(probe?.url).toBe("https://api.anthropic.com/v1/models");
		expect(probe?.headers.get("x-api-key")).toBe(VALID_KEY);
		expect(probe?.headers.get("anthropic-version")).toBe("2023-06-01");
		expect(probe?.headers.get("authorization")).toBeNull();
		// A redirect fails the probe instead of carrying x-api-key to another origin.
		expect(probe?.redirect).toBe("error");
		expect(result.stored).toEqual([{ type: "api_key", key: VALID_KEY, source: "login" }]);
		expect(result.storedUnderAlias).toBe(0);
		// The stored key serves anthropic requests as a login credential.
		expect(result.resolved).toBe(VALID_KEY);
		expect(result.source).toEqual({ kind: "api_key", concrete: true });
		// Without a workspace id the probe and later requests carry no workspace header.
		expect(result.prompts[1]?.allowEmpty).toBe(true);
		expect(probe?.headers.get("anthropic-workspace-id")).toBeNull();
		expect(result.withCredential).not.toHaveProperty("oauthIdentity");
	});

	test("a personal sk-ant-usr key is accepted, validated with x-api-key, and stored", async () => {
		const personalKey = "sk-ant-usr01-test-key-0000";
		const result = await login(personalKey, () => new Response('{"data":[]}', { status: 200 }));

		expect(result.error).toBeUndefined();
		expect(result.probes).toHaveLength(1);
		expect(result.probes[0]?.headers.get("x-api-key")).toBe(personalKey);
		expect(result.probes[0]?.headers.get("authorization")).toBeNull();
		expect(result.stored).toEqual([{ type: "api_key", key: personalKey, source: "login" }]);
	});

	test("a personal sk-ant-usr key is sent as x-api-key, not as an OAuth bearer", () => {
		const personalKey = "sk-ant-usr01-test-key-0000";
		expect(isAnthropicOAuthToken(personalKey)).toBe(false);
		expect(isOAuthToken(personalKey)).toBe(false);
		const headers = new Headers(buildAnthropicHeaders({ apiKey: personalKey }));
		expect(headers.get("x-api-key")).toBe(personalKey);
		expect(headers.get("authorization")).toBeNull();
	});

	test.each([
		["a subscription OAuth token", "sk-ant-oat01-abc", /OAuth token/],
		["an Admin API key", "sk-ant-admin01-abc", /Admin API keys/],
		["an unrelated key", "sk-proj-abc", /expected one starting with sk-ant-api\.\.\. or sk-ant-usr\.\.\./],
	])("refuses %s before any request and stores nothing", async (_name, pasted, message) => {
		const result = await login(pasted, () => new Response("{}", { status: 200 }));

		expect(result.error).toBeInstanceOf(ApiKeyRequiredError);
		expect((result.error as Error).message).toMatch(message);
		expect((result.error as Error).message).not.toContain(pasted);
		expect(result.probes).toHaveLength(0);
		expect(result.stored).toEqual([]);
	});

	test.each([
		["a line break", "sk-ant-api03-abc\ndef"],
		["a space", "sk-ant-api03-abc def"],
		["a tab", "sk-ant-api03-abc\tdef"],
		["a zero-width space", "sk-ant-api03-abc\u200bdef"],
	])("refuses a key containing %s before any request and stores nothing", async (_name, pasted) => {
		const result = await login(pasted, () => new Response("{}", { status: 200 }));

		expect(result.error).toBeInstanceOf(ApiKeyRequiredError);
		expect((result.error as Error).message).not.toContain("abc");
		expect(result.probes).toHaveLength(0);
		expect(result.stored).toEqual([]);
	});

	test("a 401 from the models endpoint rejects the key as an auth failure", async () => {
		const result = await login(
			VALID_KEY,
			() =>
				new Response('{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}', {
					status: 401,
				}),
		);

		expect(result.error).toBeInstanceOf(ProviderHttpError);
		expect((result.error as ProviderHttpError).status).toBe(401);
		expect(is(classify(result.error), Flag.AuthFailed)).toBe(true);
		expect(result.stored).toEqual([]);
	});

	test.each([
		["a 5xx", () => new Response("upstream down", { status: 503 })],
		[
			"a network failure",
			() => {
				throw new TypeError("fetch failed");
			},
		],
	])("%s while validating still saves the key and says validation was skipped", async (_name, respond) => {
		const result = await login(VALID_KEY, respond);

		expect(result.error).toBeUndefined();
		expect(result.stored).toEqual([{ type: "api_key", key: VALID_KEY, source: "login" }]);
		expect(result.progress.some(message => message.startsWith("Skipping"))).toBe(true);
	});

	test("an OAuth login keeps a login-stored key as a second account and retires only a legacy key", async () => {
		const { store, storage } = await openStorage();
		try {
			await store.upsertAuthCredential("anthropic", { type: "api_key", key: VALID_KEY, source: "login" });
			await store.upsertAuthCredential("anthropic", { type: "api_key", key: "sk-ant-api03-legacy" });
			await store.upsertAuthCredential("anthropic", {
				type: "oauth",
				access: "sk-ant-oat01-access",
				refresh: "refresh",
				expires: Date.now() + 3_600_000,
				email: "user@example.com",
			});
			await storage.credentials.reload();

			const kept = store.listAuthCredentials("anthropic").map(row => row.credential);
			expect(kept).toContainEqual({ type: "api_key", key: VALID_KEY, source: "login" });
			expect(
				kept.some(credential => credential.type === "api_key" && credential.key === "sk-ant-api03-legacy"),
			).toBe(false);
			expect(kept.some(credential => credential.type === "oauth")).toBe(true);
			// The OAuth account still outranks the kept key.
			expect(await storage.keys.get("anthropic", "session-1")).toBe("sk-ant-oat01-access");
		} finally {
			storage.close();
		}
	});

	test("a workspace id is validated with the key, stored with it, and carried to requests", async () => {
		const workspaceId = "wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ";
		const result = await login(VALID_KEY, () => new Response('{"data":[]}', { status: 200 }), ` ${workspaceId} `);

		expect(result.error).toBeUndefined();
		expect(result.probes).toHaveLength(1);
		expect(result.probes[0]?.headers.get("anthropic-workspace-id")).toBe(workspaceId);
		expect(result.probes[0]?.headers.get("x-api-key")).toBe(VALID_KEY);
		expect(result.stored).toEqual([{ type: "api_key", key: VALID_KEY, source: "login", workspaceId }]);
		expect(result.withCredential).toMatchObject({ apiKey: VALID_KEY, oauthIdentity: { workspaceId } });
	});

	test.each([
		["a missing id after the prefix", "wrkspc_"],
		["another prefix", "ws_01JwQvzr7rXLA5AGx3HKfFUJ"],
		["a line break", "wrkspc_01Jw\nQvzr"],
		["a space", "wrkspc_01Jw Qvzr"],
		["a hyphen", "wrkspc_01Jw-Qvzr"],
	])("refuses a workspace id with %s before any request and stores nothing", async (_name, workspaceId) => {
		const result = await login(VALID_KEY, () => new Response("{}", { status: 200 }), workspaceId);

		expect(result.error).toBeInstanceOf(ApiKeyRequiredError);
		expect((result.error as Error).message).toBe(
			"Not a workspace ID: expected wrkspc_ followed by letters and digits.",
		);
		expect(result.probes).toHaveLength(0);
		expect(result.stored).toEqual([]);
	});

	test("the broker wire schema accepts a valid workspace id and rejects an invalid one", () => {
		const credential = { type: "api_key", key: VALID_KEY, source: "login", workspaceId: "wrkspc_01Jw" } as const;
		expect(apiKeyCredentialSchema(credential)).toEqual(credential);
		expect(apiKeyCredentialSchema({ ...credential, workspaceId: "wrkspc_01\nJw" })).toBeInstanceOf(type.errors);
	});

	test.each([
		["sends anthropic-workspace-id for", { workspaceId: "wrkspc_01Jw" }, "wrkspc_01Jw"],
		["sends no anthropic-workspace-id without", undefined, null],
	])("an Anthropic request %s a credential workspace id", async (_name, oauthIdentity, expected) => {
		const seen: Headers[] = [];
		const fetch: FetchImpl = async (_input, init) => {
			seen.push(new Headers(init?.headers));
			return new Response(
				JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "x" } }),
				{
					status: 400,
					headers: { "content-type": "application/json" },
				},
			);
		};
		await streamAnthropic(ANTHROPIC_MODEL, CONTEXT, { apiKey: VALID_KEY, fetch, oauthIdentity }).result();

		expect(seen.length).toBeGreaterThan(0);
		for (const headers of seen) expect(headers.get("anthropic-workspace-id")).toBe(expected);
	});
});
