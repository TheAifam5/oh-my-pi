import { describe, expect, it, vi } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { SessionStatsTracker, type SessionStatsTrackerHost } from "../src/session/session-stats";

function trackerWith(ingest: ReturnType<typeof vi.fn>, providerUrl: string | undefined) {
	const host = {
		agent: { sessionId: "s1" },
		modelRegistry: {
			authStorage: { usage: { ingestHeaders: ingest } },
			getProviderBaseUrl: () => providerUrl,
		},
	} as unknown as SessionStatsTrackerHost;
	return new SessionStatsTracker(host);
}

describe("ingestProviderUsageHeaders base URL", () => {
	it("passes the model's own gateway URL even when the provider URL is unset", () => {
		const ingest = vi.fn();
		const model = { provider: "anthropic", baseUrl: "https://gateway.example/v1" } as Model;
		trackerWith(ingest, undefined).ingestProviderUsageHeaders({ status: 200, headers: {} }, model);
		expect(ingest.mock.calls[0][2].baseUrl).toBe("https://gateway.example/v1");
	});

	it("falls back to the provider URL when the model has none", () => {
		const ingest = vi.fn();
		const model = { provider: "anthropic" } as Model;
		trackerWith(ingest, "https://proxy.example").ingestProviderUsageHeaders({ status: 200, headers: {} }, model);
		expect(ingest.mock.calls[0][2].baseUrl).toBe("https://proxy.example");
	});
});
