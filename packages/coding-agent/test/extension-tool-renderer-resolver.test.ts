import { beforeAll, describe, expect, test } from "bun:test";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Component, TUI } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { ChatTranscriptBuilder } from "@oh-my-pi/pi-tui/chat/chat-transcript-builder";
import { ToolExecutionComponent, type ToolExecutionUi } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { getThemeByName, setThemeInstance, type Theme } from "@oh-my-pi/pi-tui/theme";
import { Settings } from "../src/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "../src/extensibility/extensions/loader";
import { ExtensionRunner } from "../src/extensibility/extensions/runner";
import type { ToolRenderers } from "../src/extensibility/extensions/types";
import { resolveToolExecutionRenderers, wrapRegisteredTools } from "../src/extensibility/extensions/wrapper";
import { EventBus } from "../src/utils/event-bus";

/** Renderer in upstream pi's `renderCall(args, theme, context)` order, as shipped plugins call it. */
type PiRenderCall = (args: unknown, theme: Theme, context: unknown) => Component;

const ui: ToolExecutionUi = { requestRender() {}, requestComponentRender() {}, resetDisplay() {} };

function piRenderer(label: string): ToolRenderers["renderCall"] {
	const render: PiRenderCall = (_args, theme) => new Text(theme.bold(label), 0, 0);
	return render as unknown as ToolRenderers["renderCall"];
}

async function setup(): Promise<{ runner: ExtensionRunner; tool: AgentTool }> {
	const runtime = new ExtensionRuntime();
	const extension = await loadExtensionFromFactory(
		pi => {
			pi.registerTool({
				name: "aft_search",
				label: "AFT Search",
				description: "third-party search tool",
				parameters: pi.arktype({}),
				execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
				renderCall: piRenderer("own renderer"),
			});
			pi.registerToolRenderer((toolName, next) => {
				if (toolName === "mcp_lookup") return { renderCall: piRenderer("resolver renderer") };
				const wrap: PiRenderCall = (args, theme, context) => {
					const base = next()?.renderCall as unknown as PiRenderCall;
					const inner = base(args, theme, context).render(80).join("");
					return new Text(`${theme.bold("wrapped:")} ${inner}`, 0, 0);
				};
				return { renderCall: wrap as unknown as ToolRenderers["renderCall"] };
			});
		},
		"/project",
		new EventBus(),
		runtime,
		"renderer-resolver",
	);
	const runner = new ExtensionRunner(
		[extension],
		runtime,
		"/project",
		{ getCwd: () => "/project" } as never,
		{} as never,
	);
	const tool = wrapRegisteredTools(runner.getAllRegisteredTools(), runner)[0];
	if (!tool) throw new Error("registered tool missing");
	return { runner, tool };
}

function renderCard(runner: ExtensionRunner, toolName: string, tool: AgentTool | undefined): string {
	const component = new ToolExecutionComponent(
		toolName,
		{},
		{ showImages: false, renderers: resolveToolExecutionRenderers(runner, toolName, tool) },
		tool,
		ui,
		"/project",
	);
	return Bun.stripANSI(component.render(100).join("\n"));
}

describe("pi.registerToolRenderer", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
		const loaded = await getThemeByName("dark");
		if (!loaded) throw new Error("dark theme missing");
		setThemeInstance(loaded);
	});

	test("renders calls to a tool name with no registered tool", async () => {
		const { runner } = await setup();
		expect(renderCard(runner, "mcp_lookup", undefined)).toContain("resolver renderer");
	});

	test("next() yields the tool's own renderer to a pi-order wrapper", async () => {
		const { runner, tool } = await setup();
		expect(renderCard(runner, "aft_search", tool)).toContain("wrapped: own renderer");
	});

	test("replayed overlay transcripts render tool calls through the resolvers", async () => {
		const { runner } = await setup();
		const builder = new ChatTranscriptBuilder({
			ui: ui as unknown as TUI,
			cwd: "/project",
			requestRender() {},
			getToolRenderers: (name, tool) => resolveToolExecutionRenderers(runner, name, tool),
		});
		builder.rebuild([
			{
				type: "message",
				id: "a1",
				parentId: null,
				timestamp: new Date(0).toISOString(),
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "call-1", name: "mcp_lookup", arguments: {} }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-sonnet-4-5",
					stopReason: "toolUse",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					timestamp: 0,
				},
			},
		]);
		const rendered = builder.container.children.map(child => child.render(100).join("\n")).join("\n");
		expect(Bun.stripANSI(rendered)).toContain("resolver renderer");
	});
});
