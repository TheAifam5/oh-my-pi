import { describe, expect, it } from "bun:test";
import { anthropicModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";

async function discoveryHeaders(workspaceId?: string): Promise<Headers | undefined> {
	let seen: Headers | undefined;
	const fetchMock = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = String(input instanceof Request ? input.url : input);
		if (url === "https://api.anthropic.com/v1/models") {
			seen = new Headers(init?.headers);
			return Response.json({ data: [{ type: "model", id: "claude-opus-5", display_name: "Claude Opus 5" }] });
		}
		return new Response("not found", { status: 404 });
	}) as typeof fetch;
	await anthropicModelManagerOptions({
		apiKey: "sk-ant-api03-test",
		baseUrl: "https://api.anthropic.com",
		fetch: fetchMock,
		workspaceId,
	}).fetchDynamicModels?.();
	return seen;
}

describe("anthropic discovery workspace header", () => {
	it("sends anthropic-workspace-id when the key has a workspace id", async () => {
		const headers = await discoveryHeaders("wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ");
		expect(headers?.get("anthropic-workspace-id")).toBe("wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ");
	});

	it("sends no anthropic-workspace-id without a workspace id", async () => {
		const headers = await discoveryHeaders();
		expect(headers).toBeDefined();
		expect(headers?.get("anthropic-workspace-id")).toBeNull();
	});
});
