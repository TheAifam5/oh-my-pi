import { beforeAll, describe, expect, it } from "bun:test";
import { LogoutAccountSelectorComponent } from "@oh-my-pi/pi-tui/overlays/logout-account-selector";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { StoredAuthCredential } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { toLogoutAccounts } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/logout";

beforeAll(async () => {
	await initTheme();
});

describe("LogoutAccountSelectorComponent", () => {
	it("starts on the active stored account and selects that credential", () => {
		const rows: StoredAuthCredential[] = [
			{
				id: 11,
				provider: "anthropic",
				disabledCause: null,
				credential: {
					type: "oauth",
					access: "access-a",
					refresh: "refresh-a",
					expires: Date.now() + 60_000,
					email: "a@example.com",
					accountId: "acct-a",
				},
			},
			{
				id: 12,
				provider: "anthropic",
				disabledCause: null,
				credential: {
					type: "oauth",
					access: "access-b",
					refresh: "refresh-b",
					expires: Date.now() + 60_000,
					email: "b@example.com",
					accountId: "acct-b",
				},
			},
		];
		const accounts = toLogoutAccounts("anthropic", rows, { activeIdentity: { accountId: "acct-b" } });
		const selected: number[] = [];
		const component = new LogoutAccountSelectorComponent(
			"Anthropic",
			accounts,
			account => selected.push(account.credentialId),
			() => {},
		);

		const rendered = component
			.render(100)
			.map(line => Bun.stripANSI(line))
			.join("\n");
		expect(rendered).toContain("b@example.com (active)");
		expect(rendered.indexOf("b@example.com")).toBeLessThan(rendered.indexOf("a@example.com"));

		component.handleInput("\n");

		expect(selected).toEqual([12]);
	});

	it("runs an action key on the highlighted account and keeps Enter as log out", () => {
		const rows: StoredAuthCredential[] = [
			{ id: 21, provider: "openai", disabledCause: null, credential: { type: "api_key", key: "sk-test" } },
		];
		const accounts = toLogoutAccounts("openai", rows, {
			annotations: new Map([[21, { name: "work", facts: ["key 1234abcd"] }]]),
		});
		const actions: string[] = [];
		const loggedOut: number[] = [];
		const component = new LogoutAccountSelectorComponent(
			"OpenAI",
			accounts,
			account => loggedOut.push(account.credentialId),
			() => {},
			{
				actions: [{ id: "pin-project", label: "pin project", key: "p" }],
				onAction: (account, actionId) => actions.push(`${actionId}:${account.credentialId}`),
			},
		);

		const rendered = component
			.render(120)
			.map(line => Bun.stripANSI(line))
			.join("\n");
		expect(rendered).toContain("work (API key #21)");
		component.handleInput("p");
		component.handleInput("\n");

		expect(actions).toEqual(["pin-project:21"]);
		expect(loggedOut).toEqual([21]);
	});
});
