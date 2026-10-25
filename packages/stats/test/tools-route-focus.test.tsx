import { afterEach, expect, it, vi } from "bun:test";
import { parseHTML } from "@oh-my-pi/pi-utils/dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ToolsRoute } from "../src/client/routes/ToolsRoute";
import type { ToolDashboardStats } from "../src/client/types";

const saved = new Map<string, PropertyDescriptor | undefined>();
let root: Root | undefined;

afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	vi.restoreAllMocks();
	for (const [name, descriptor] of saved) {
		if (descriptor) Object.defineProperty(globalThis, name, descriptor);
		else Reflect.deleteProperty(globalThis, name);
	}
	saved.clear();
});

it("restores focus to the stable model heading after clearing a keyboard-selected tool", async () => {
	const window = parseHTML('<html><body><div id="root"></div></body></html>').window;
	class ResizeObserver {
		observe() { }
		disconnect() { }
	}
	for (const [name, value] of Object.entries({
		window,
		document: window.document,
		navigator: window.navigator,
		Node: window.Node,
		Element: window.Element,
		HTMLElement: window.HTMLElement,
		HTMLIFrameElement: window.HTMLIFrameElement,
		SVGElement: window.SVGElement,
		ResizeObserver,
		IS_REACT_ACT_ENVIRONMENT: true,
	})) {
		saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
		Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
	}
	const tool = {
		tool: "read",
		calls: 2,
		errors: 0,
		argsChars: 20,
		resultChars: 100,
		totalTokensShare: 50,
		outputTokensShare: 10,
		costShare: 0.01,
		unpricedRequestsShare: 0,
		lastUsed: Date.now(),
	};
	const data: ToolDashboardStats = {
		byTool: [tool],
		byToolModel: [{ ...tool, model: "Example", provider: "Provider" }],
		series: [],
	};
	vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(data));
	const container = document.getElementById("root");
	if (!container) throw new Error("Missing test root");
	root = createRoot(container);
	await act(async () => root?.render(<ToolsRoute active range="90d" />));
	const heading = document.querySelector<HTMLHeadingElement>(".tools-explorer-title h3");
	const row = document.querySelector<HTMLElement>('[aria-label="Tool usage"] tbody tr');
	if (!heading || !row) throw new Error("Missing tool explorer");
	for (const key of ["Enter", " "]) {
		row.focus();
		const event = new window.Event("keydown", { bubbles: true, cancelable: true });
		Object.defineProperty(event, "key", { value: key });
		await act(async () => {
			row.dispatchEvent(event as unknown as Event);
		});
		expect(heading.textContent).toBe("read · model breakdown");
		const clear = document.querySelector<HTMLButtonElement>(".tools-explorer-title button");
		if (!clear) throw new Error("Missing clear filter button");
		clear.focus();
		expect(document.activeElement).toBe(clear);
		await act(async () => clear.click());
		expect(document.querySelector(".tools-explorer-title button")).toBeNull();
		expect(heading.textContent).toBe("All tools · model breakdown");
		expect(document.activeElement).toBe(heading);
		expect(heading.getAttribute("tabindex")).toBe("-1");
	}
});
