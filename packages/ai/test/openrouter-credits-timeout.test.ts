import { afterEach, expect, test, vi } from "bun:test";
import { openrouterBilling, openrouterUsageProvider } from "@oh-my-pi/pi-ai/usage/openrouter";

afterEach(() => {
	vi.restoreAllMocks();
});

test("returns key limits when concurrent credits hangs past its own deadline", async () => {
	const timeout = AbortSignal.timeout.bind(AbortSignal);
	const timeouts: number[] = [];
	vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
		timeouts.push(ms);
		return timeout(10);
	});
	const keyResponse = Promise.withResolvers<Response>();
	const requests: string[] = [];
	const reportPromise = openrouterUsageProvider.fetchUsage(
		{ provider: "openrouter", credential: { type: "api_key", apiKey: "test-key" } },
		{
			fetch: async (input, init) => {
				const url = String(input);
				requests.push(url);
				if (url.endsWith("/key")) return keyResponse.promise;
				const pending = Promise.withResolvers<Response>();
				const signal = init?.signal;
				if (!signal) throw new Error("Expected credits timeout signal");
				if (signal.aborted) pending.reject(signal.reason);
				else signal.addEventListener("abort", () => pending.reject(signal.reason), { once: true });
				return pending.promise;
			},
		},
	);
	try {
		expect(requests).toContain("https://openrouter.ai/api/v1/credits");
		expect(requests).toContain("https://openrouter.ai/api/v1/key");
	} finally {
		keyResponse.resolve(Response.json({ data: { is_free_tier: false, limit: 20, limit_remaining: 7 } }));
	}
	const report = await reportPromise;
	expect(timeouts).toEqual([3_000]);
	expect(report?.limits.find(limit => limit.id === "openrouter:key-limit")?.amount.remaining).toBe(7);
	expect(report?.metadata?.creditsUnavailableReason).toBe("timeout");
	if (!report) throw new Error("Expected key limits to remain available");
	expect(openrouterBilling.readBilling(report)).toMatchObject({ status: "unknown", reason: "timeout" });
});

test.each(["free-tier", "rejected", "unavailable"] as const)(
	"cancels unused credits when the key is %s",
	async outcome => {
		let creditsSignal: AbortSignal | undefined;
		const reportPromise = openrouterUsageProvider.fetchUsage(
			{ provider: "openrouter", credential: { type: "api_key", apiKey: "test-key" } },
			{
				fetch: async (input, init) => {
					if (String(input).endsWith("/key")) {
						if (outcome === "unavailable") throw new Error("Connection closed");
						return outcome === "rejected"
							? new Response(null, { status: 401 })
							: Response.json({ data: { is_free_tier: true } });
					}
					creditsSignal = init?.signal ?? undefined;
					if (!creditsSignal) throw new Error("Expected credits cancellation signal");
					const pending = Promise.withResolvers<Response>();
					creditsSignal.addEventListener("abort", () => pending.reject(creditsSignal?.reason), { once: true });
					return pending.promise;
				},
			},
		);
		if (outcome === "rejected") await expect(reportPromise).rejects.toThrow(/401/);
		else await reportPromise;
		expect(creditsSignal?.aborted).toBe(true);
	},
);
