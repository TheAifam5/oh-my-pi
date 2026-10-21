import { describe, expect, test } from "bun:test";
import { loadAuthAccountPolicyConfig } from "@oh-my-pi/pi-ai/auth-broker";
import { AccountPolicies } from "@oh-my-pi/pi-ai/auth/policy";

const message = "Saved resets (resetOn and autoRedeem) apply to OAuth accounts only.";

describe("API-key saved-reset policy rejection", () => {
	for (const resetFields of [{ resetOn: ["7d"] as const }, { autoRedeem: "no" as const }]) {
		test(`rejects ${Object.keys(resetFields)[0]} in direct and parsed account policies`, async () => {
			const accountPolicies = [
				{
					provider: "openai-codex",
					account: { keyFingerprint: "0123abcd4567ef89" },
					...resetFields,
				},
			];
			expect(() => new AccountPolicies(accountPolicies, 10)).toThrow(`auth.accountPolicies[0]: ${message}`);
			await expect(loadAuthAccountPolicyConfig({ accountPolicies, usageReservePct: 10 })).rejects.toThrow(
				`auth.accountPolicies[0]: ${message}`,
			);
		});
	}
});
