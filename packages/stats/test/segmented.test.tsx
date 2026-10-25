import { afterEach, expect, it } from "bun:test";
import { parseHTML } from "@oh-my-pi/pi-utils/dom";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Segmented } from "../src/client/ui/Segmented";

const saved = new Map<string, PropertyDescriptor | undefined>();
let root: Root | undefined;

afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	for (const [name, descriptor] of saved) {
		if (descriptor) Object.defineProperty(globalThis, name, descriptor);
		else Reflect.deleteProperty(globalThis, name);
	}
	saved.clear();
});

it("uses radio semantics, one tab stop and wrapping arrow, Home and End selection", async () => {
	const window = parseHTML('<html><body><div id="root"></div></body></html>').window;
	class ResizeObserver {
		observe() {}
		disconnect() {}
	}
	for (const [name, value] of Object.entries({
		window,
		document: window.document,
		navigator: window.navigator,
		Node: window.Node,
		Element: window.Element,
		HTMLElement: window.HTMLElement,
		ResizeObserver,
		IS_REACT_ACT_ENVIRONMENT: true,
	})) {
		saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
		Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
	}
	const container = document.getElementById("root");
	if (!container) throw new Error("Missing test root");
	function Filter() {
		const [value, setValue] = useState("a");
		return (
			<Segmented
				aria-label="Provider"
				value={value}
				onChange={setValue}
				options={[
					{ value: "a", label: "Alpha" },
					{ value: "b", label: "Beta" },
					{ value: "c", label: "Charlie" },
				]}
			/>
		);
	}
	root = createRoot(container);
	await act(async () => root?.render(<Filter />));
	expect(document.querySelector('[role="radiogroup"]')?.getAttribute("aria-label")).toBe("Provider");
	expect(document.querySelector('[role="tablist"]')).toBeNull();
	const selected = () => document.querySelector('[aria-checked="true"]');
	const key = async (value: string) => {
		const event = new window.Event("keydown", { bubbles: true, cancelable: true });
		Object.defineProperty(event, "key", { value });
		await act(async () => {
			selected()?.dispatchEvent(event as unknown as Event);
		});
		expect(document.querySelectorAll('[role="radio"][tabindex="0"]').length).toBe(1);
	};
	await key("ArrowLeft");
	expect(selected()?.textContent).toBe("Charlie");
	await key("ArrowRight");
	expect(selected()?.textContent).toBe("Alpha");
	await key("ArrowDown");
	expect(selected()?.textContent).toBe("Beta");
	await key("End");
	expect(selected()?.textContent).toBe("Charlie");
	await key("Home");
	expect(selected()?.textContent).toBe("Alpha");
	const beta = document.querySelectorAll<HTMLButtonElement>('[role="radio"]')[1];
	await act(async () => beta?.click());
	expect(selected()?.textContent).toBe("Beta");
});
