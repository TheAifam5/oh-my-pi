import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import type { Api, FetchImpl } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { closeModelCache, writeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { resolveModelCacheProviderId } from "@oh-my-pi/pi-catalog/provider-models";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { COPILOT_API_HEADERS } from "@oh-my-pi/pi-catalog/wire/github-copilot";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

const COPILOT_KEY = "ghu_test_token";
const COPILOT_SERVED_ID = "claude-fable-5.5";
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

describe("ModelRegistry provider-scoped refresh", () => {
	let authStorage: AuthStorage;
	let tempDir: TempDir;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@omp-model-registry-scoped-refresh-");
		authStorage = await AuthStorage.create(":memory:");
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
		writeModelCache(
			resolveModelCacheProviderId("github-copilot", { apiKey: COPILOT_KEY }),
			Date.now(),
			[served],
			true,
			"",
			tempDir.join("models.db"),
			[sibling],
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
		const registry = new ModelRegistry(authStorage, tempDir.join("models.yml"), { fetch: syntheticModelsFetch() });
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
});
