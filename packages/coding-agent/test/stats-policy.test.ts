import { expect, it } from "bun:test";
import { headroom } from "@oh-my-pi/omp-stats/observability";
import { buildStatsHeadroomPolicies } from "../src/cli/stats-policy";
import { cfgAuthAccountPolicies } from "../src/config/model-settings";
import { Settings } from "../src/config/settings";
import { TempDir } from "@oh-my-pi/pi-utils";
import { beginSettingsTest, restoreSettingsTestState } from "./helpers/settings-test-state";

it("returns only safe aliases and aggregate account limit values", async () => {
	const state = beginSettingsTest();
	const directory = TempDir.createSync("@pi-stats-policy-");
	try {
		const settings = await Settings.loadReadOnly({ cwd: directory.path(), agentDir: directory.join("agent") });
		cfgAuthAccountPolicies.set(settings, [
			{
				provider: "openai",
				name: "policy-private@example.invalid",
				account: { email: "private@example.invalid", accountId: "private-account-id" },
				limits: [
					{ metric: "requests", max: 10, window: { type: "rolling", durationMs: 3600000 }, onLimit: "skip" },
				],
			},
			{
				provider: "openai",
				account: { keyFingerprint: "1234567890abcdef" },
				limits: [{ metric: "usd", max: "5", window: { type: "calendar", period: "day" }, onLimit: "skip" }],
			},
		]);
		const policies = buildStatsHeadroomPolicies(settings);
		expect(policies.map(policy => policy.label)).toEqual(["openai · Account 1: requests", "openai · Account 2: usd"]);
		const serialized = JSON.stringify({ policies, apiRows: headroom(undefined, policies, Date.now()) });
		for (const secret of [
			"policy-private@example.invalid",
			"private@example.invalid",
			"private-account-id",
			"1234567890abcdef",
		]) {
			expect(serialized.includes(secret)).toBe(false);
		}
		expect(policies.every(policy => policy.scopes.length === 0)).toBe(true);
		expect(policies.every(policy => policy.snapshot !== undefined)).toBe(true);
	} finally {
		restoreSettingsTestState(state);
		directory.removeSync();
	}
});
