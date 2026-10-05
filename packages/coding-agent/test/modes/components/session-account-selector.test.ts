import { beforeAll, describe, expect, it } from "bun:test";
import { SessionAccountSelectorComponent } from "@oh-my-pi/pi-tui/overlays/session-account-selector";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { toSessionPinAccounts } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/session-pin";

beforeAll(async () => {
	await initTheme();
});

const accounts = toSessionPinAccounts([
	{ credentialId: 11, type: "oauth", email: "first@example.com", active: false, pinned: false },
	{ credentialId: 12, type: "oauth", email: "second@example.com", active: true, pinned: false },
]);

describe("SessionAccountSelectorComponent", () => {
	it("handles navigation, selection, Escape, and Ctrl+C while focused", () => {
		const selected: number[] = [];
		let cancellations = 0;
		const component = new SessionAccountSelectorComponent(
			"Anthropic",
			accounts,
			account => selected.push(account.credentialId),
			() => {
				cancellations += 1;
			},
		);

		component.handleInput("\x1b[A");
		component.handleInput("\n");
		expect(selected).toEqual([11]);

		const escapeComponent = new SessionAccountSelectorComponent(
			"Anthropic",
			accounts,
			() => {},
			() => {
				cancellations += 1;
			},
		);
		escapeComponent.handleInput("\x1b");

		const ctrlCComponent = new SessionAccountSelectorComponent(
			"Anthropic",
			accounts,
			() => {},
			() => {
				cancellations += 1;
			},
		);
		ctrlCComponent.handleInput("\x03");
		expect(cancellations).toBe(2);
	});
});
