import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import * as fs from "node:fs/promises";
import type { Api, FetchImpl } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { closeModelCache, writeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { resolveModelCacheProviderId } from "@oh-my-pi/pi-catalog/provider-models";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { COPILOT_API_HEADERS } from "@oh-my-pi/pi-catalog/wire/github-copilot";
import { ModelRegistry, type ProviderConfigInput } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { cfgExtendedContext } from "@oh-my-pi/pi-coding-agent/session/context-settings";
import { TempDir } from "@oh-my-pi/pi-utils";

const COPILOT_KEY = "ghu_test_token";
const COPILOT_SERVED_ID = "claude-fable-5.5";
// Served-only Copilot model whose window follows the extended-context policy.
const COPILOT_WINDOWED_ID = "gpt-5.7-sol";
const SYNTHETIC_MODELS_URL = "https://api.synthetic.new/openai/v1/models";
const SYNTHETIC_SERVED_ID = "hf:zai-org/GLM-5.1";

function syntheticModelsFetch(): FetchImpl {
	return async input => {
		const url = input instanceof Request ? input.url : String(input);
		if (url === SYNTHETIC_MODELS_URL) {
			return Response.json({ data: [{ id: SYNTHETIC_SERVED_ID }] });
		}
		throw new Error(`Unexpected URL: ${url}`);
	};
}

function providerModelIds(registry: ModelRegistry, provider: string): string[] {
	return registry
		.getAll()
		.filter(model => model.provider === provider)
		.map(model => model.id)
		.sort();
}

describe("ModelRegistry refresh with credential-scoped discovery", () => {
	let authStorage: AuthStorage;
	let settings: Settings;
	let tempDir: TempDir;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@omp-model-registry-scoped-refresh-");
		authStorage = await AuthStorage.create(":memory:");
		settings = Settings.isolated();
		authStorage.keys.setRuntime("github-copilot", COPILOT_KEY);
		authStorage.keys.setRuntime("synthetic", "synthetic-test-key");
		// A Copilot roster with a model the bundled catalog does not know, so a
		// fallback to the bundled list is observable.
		const sibling = getBundledModel("github-copilot", "claude-fable-5");
		if (!sibling) throw new Error("Expected bundled Copilot claude-fable-5");
		expect(getBundledModel("github-copilot", COPILOT_SERVED_ID)).toBeUndefined();
		const served = buildModel({
			...(sibling as ModelSpec<Api>),
			id: COPILOT_SERVED_ID,
			name: "Claude Fable 5.5",
			headers: { ...COPILOT_API_HEADERS },
		});
		const windowedSibling = getBundledModel("github-copilot", "gpt-5.6-sol");
		if (!windowedSibling) throw new Error("Expected bundled Copilot gpt-5.6-sol");
		expect(getBundledModel("github-copilot", COPILOT_WINDOWED_ID)).toBeUndefined();
		const windowed = buildModel({
			...(windowedSibling as ModelSpec<Api>),
			id: COPILOT_WINDOWED_ID,
			name: "GPT-5.7 Sol",
			maxContextWindow: 1_050_000,
			headers: { ...COPILOT_API_HEADERS },
		});
		writeModelCache(
			resolveModelCacheProviderId("github-copilot", { apiKey: COPILOT_KEY }),
			Date.now(),
			[served, windowed],
			true,
			"",
			tempDir.join("models.db"),
			[sibling, windowedSibling],
			{ ...COPILOT_API_HEADERS },
		);
	});

	afterEach(() => {
		authStorage.close();
		// The registry opened <tempDir>/models.db; Windows cannot delete an open database.
		closeModelCache();
		tempDir.removeSync();
	});

	async function createHydratedRegistry(): Promise<ModelRegistry> {
		const registry = new ModelRegistry(authStorage, tempDir.join("models.yml"), {
			fetch: syntheticModelsFetch(),
			settings,
		});
		await registry.hydrateCredentialScopedModelCaches();
		expect(providerModelIds(registry, "github-copilot")).toContain(COPILOT_SERVED_ID);
		return registry;
	}

	test("refreshing another provider does not revert a credential-scoped provider to its bundled models", async () => {
		const registry = await createHydratedRegistry();
		const copilotIds = providerModelIds(registry, "github-copilot");
		const copilotDiscovery = registry.getProviderDiscoveryState("github-copilot");

		await registry.refreshProvider("synthetic", "online");

		expect(providerModelIds(registry, "synthetic")).toEqual([SYNTHETIC_SERVED_ID]);
		expect(providerModelIds(registry, "github-copilot")).toEqual(copilotIds);
		expect(registry.getProviderDiscoveryState("github-copilot")).toEqual(copilotDiscovery);
	});

	test("a models config edit between provider refreshes applies without dropping credential-scoped models", async () => {
		const registry = await createHydratedRegistry();
		const copilotIds = providerModelIds(registry, "github-copilot");
		const modelsPath = tempDir.join("models.yml");
		await Bun.write(
			modelsPath,
			JSON.stringify({
				providers: {
					"scratch-proxy": {
						baseUrl: "https://scratch-proxy.example.com/v1",
						apiKey: "SCRATCH_KEY",
						api: "openai-completions",
						models: [
							{
								id: "scratch-model",
								name: "Scratch Model",
								reasoning: false,
								input: ["text"],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								contextWindow: 128_000,
								maxTokens: 8_192,
							},
						],
					},
				},
			}),
		);
		const configMtime = new Date("2020-01-01T00:00:00Z");
		await fs.utimes(modelsPath, configMtime, configMtime);

		await registry.refreshProvider("synthetic", "online");

		expect(registry.find("scratch-proxy", "scratch-model")).toBeDefined();
		expect(providerModelIds(registry, "synthetic")).toEqual([SYNTHETIC_SERVED_ID]);
		expect(providerModelIds(registry, "github-copilot")).toEqual(copilotIds);
	});

	test("refreshing another provider discovers extension providers without a fresh cached catalog", async () => {
		const registry = await createHydratedRegistry();
		let fetches = 0;
		const config: ProviderConfigInput = {
			baseUrl: "https://extension.example.com/v1",
			apiKey: "EXTENSION_KEY",
			api: "openai-completions",
			fetchDynamicModels: async () => {
				fetches++;
				return [
					{
						id: `extension-model-${fetches}`,
						name: "Extension Model",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128_000,
						maxTokens: 8_192,
					},
				];
			},
		};
		// Registered after startup discovery: no cache row exists yet.
		registry.registerProvider("extension-provider", config, "ext://scoped-refresh");

		await registry.refreshProvider("synthetic", "online");
		expect(providerModelIds(registry, "extension-provider")).toEqual(["extension-model-1"]);

		// A fresh cache row costs no network.
		await registry.refreshProvider("synthetic", "online");
		expect(fetches).toBe(1);

		// Past the 24h runtime-provider cache TTL the row is refetched.
		setSystemTime(new Date(Date.now() + 25 * 60 * 60 * 1000));
		try {
			await registry.refreshProvider("synthetic", "online");
		} finally {
			setSystemTime();
		}
		expect(fetches).toBe(2);
		expect(providerModelIds(registry, "extension-provider")).toEqual(["extension-model-2"]);
	});

	describe("full refresh", () => {
		test("re-hydrates credential-scoped discovered models instead of reverting to bundled ones", async () => {
			const registry = await createHydratedRegistry();
			const copilotIds = providerModelIds(registry, "github-copilot");

			await registry.refresh("offline");
			expect(providerModelIds(registry, "github-copilot")).toEqual(copilotIds);

			await registry.refresh("online-if-uncached");
			expect(providerModelIds(registry, "github-copilot")).toEqual(copilotIds);
		});

		test("reapplying model policies rebuilds credential-scoped discovered models under the new policy", async () => {
			const registry = await createHydratedRegistry();
			const copilotIds = providerModelIds(registry, "github-copilot");
			expect(registry.find("github-copilot", COPILOT_WINDOWED_ID)?.contextWindow).toBe(272_000);

			cfgExtendedContext.set(settings, true);
			await registry.reapplyModelPolicies();
			expect(registry.find("github-copilot", COPILOT_WINDOWED_ID)?.contextWindow).toBe(1_050_000);
			expect(providerModelIds(registry, "github-copilot")).toEqual(copilotIds);

			cfgExtendedContext.set(settings, false);
			await registry.reapplyModelPolicies();
			expect(registry.find("github-copilot", COPILOT_WINDOWED_ID)?.contextWindow).toBe(272_000);
		});
	});
});
