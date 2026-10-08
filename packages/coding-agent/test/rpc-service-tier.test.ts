import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ServiceTier, ServiceTierFamily } from "@oh-my-pi/pi-ai";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { rejectionOf } from "./helpers/rejection";

// The fixture runs real RPC dispatch over an isolated session whose live model is Anthropic Claude Sonnet 4.5.
describe("RPC service tier", () => {
	let client: RpcClient;
	let directory: string;

	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-service-tier-"));
		client = new RpcClient({
			command: [process.execPath, path.join(import.meta.dir, "fixtures", "fork-rpc-agent.ts"), directory],
			cwd: directory,
			env: { PI_CODING_AGENT_DIR: directory, PI_NO_TITLE: "1" },
		});
		await client.start();
	});

	afterEach(async () => {
		await client?.stop();
		await removeWithRetries(directory);
	});

	test("sets, persists, and clears per-family tiers, including families other than the live model's", async () => {
		const fresh = await client.getState();
		expect(fresh.serviceTiers).toEqual({});
		expect(fresh.effectiveServiceTier).toBeUndefined();

		expect(await client.setServiceTier("openai", "flex")).toEqual({ openai: "flex" });
		const otherFamily = await client.getState();
		expect(otherFamily.serviceTiers).toEqual({ openai: "flex" });
		expect(otherFamily.effectiveServiceTier).toBeUndefined();
		expect(otherFamily.fastModeEnabled).toBe(false);

		expect(await client.setServiceTier("anthropic", "priority")).toEqual({ openai: "flex", anthropic: "priority" });
		const liveFamily = await client.getState();
		expect(liveFamily.effectiveServiceTier).toBe("priority");
		expect(liveFamily.fastModeEnabled).toBe(true);

		const { entries } = await client.getEntries();
		const tierChanges = entries.flatMap(entry => (entry.type === "service_tier_change" ? [entry.serviceTier] : []));
		expect(tierChanges.at(-1)).toEqual({ openai: "flex", anthropic: "priority" });

		expect(await client.setServiceTier("openai")).toEqual({ anthropic: "priority" });
		expect((await client.getState()).serviceTiers).toEqual({ anthropic: "priority" });
	}, 30_000);

	test("rejects tiers a family does not accept and unknown families without changing the map", async () => {
		await client.setServiceTier("openai", "scale");
		const invalid: Array<[ServiceTierFamily, ServiceTier, string]> = [
			["anthropic", "flex", "Invalid service tier for anthropic: flex"],
			["openai", "none" as ServiceTier, "Invalid service tier for openai: none"],
			["mistral" as ServiceTierFamily, "priority", "Invalid service tier family: mistral"],
		];
		for (const [family, tier, message] of invalid) {
			expect(await rejectionOf(client.setServiceTier(family, tier))).toMatchObject({ message });
		}
		expect((await client.getState()).serviceTiers).toEqual({ openai: "scale" });
	}, 30_000);
});
