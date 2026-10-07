import { afterEach, describe, expect, it, vi } from "bun:test";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import * as accountAdmin from "@oh-my-pi/pi-coding-agent/session/account-admin";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

function createRuntimeHarness(options?: {
	handleSessionCommand?: InteractiveModeContext["handleSessionCommand"];
	handleSessionDeleteCommand?: InteractiveModeContext["handleSessionDeleteCommand"];
	showSessionPinSelector?: InteractiveModeContext["showSessionPinSelector"];
}) {
	const setText = vi.fn();
	const handleSessionCommand =
		options?.handleSessionCommand ??
		vi.fn(async () => {
			return;
		});
	const handleSessionDeleteCommand =
		options?.handleSessionDeleteCommand ??
		vi.fn(async () => {
			return;
		});
	const showSessionPinSelector =
		options?.showSessionPinSelector ??
		vi.fn(async () => {
			return;
		});

	return {
		setText,
		handleSessionCommand,
		handleSessionDeleteCommand,
		showSessionPinSelector,
		runtime: {
			ctx: {
				editor: { setText } as unknown as InteractiveModeContext["editor"],
				handleSessionCommand,
				handleSessionDeleteCommand,
				showSessionPinSelector,
			} as InteractiveModeContext,
		},
	};
}

describe("/session slash command", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("writes --spend and --return-when only with --save and leaves the session drain alone when saving fails", async () => {
		const account = { credentialId: 7, type: "oauth", accountId: "acc-b", active: false, pinned: false };
		const session = {
			listCurrentProviderAccounts: vi.fn(async () => ({ provider: "openai-codex", accounts: [account] })),
			drainCurrentProviderAccount: vi.fn(() => "drained"),
			settings: {},
			modelRegistry: { authStorage: {} },
		};
		const showStatus = vi.fn();
		const save = vi.spyOn(accountAdmin, "setAccountDrain").mockReturnValue({});
		const runtime = {
			ctx: {
				editor: { setText: vi.fn() },
				session,
				showStatus,
				statusLine: { invalidate: vi.fn() },
				ui: { requestRender: vi.fn() },
			} as unknown as InteractiveModeContext,
		};

		await executeBuiltinSlashCommand("/session drain acc-b --spend credits", runtime);
		expect(showStatus).toHaveBeenLastCalledWith(expect.stringMatching(/^Usage: \/session drain/));
		expect(session.drainCurrentProviderAccount).not.toHaveBeenCalled();

		await executeBuiltinSlashCommand(
			"/session drain acc-b --save --spend credits --return-when reset,credits-added",
			runtime,
		);
		expect(session.drainCurrentProviderAccount).toHaveBeenCalledWith(7);
		expect(save).toHaveBeenCalledWith(
			session.settings,
			session.modelRegistry.authStorage,
			"openai-codex",
			{ provider: "openai-codex", account },
			{ spend: ["credits"], returnWhen: ["reset", "credits-added"] },
		);
		session.drainCurrentProviderAccount.mockClear();
		save.mockImplementation(() => {
			throw new accountAdmin.AccountAdminError("rejected");
		});
		await executeBuiltinSlashCommand("/session drain acc-b --save --return-when credits-added", runtime);
		expect(showStatus).toHaveBeenLastCalledWith("Not saved: rejected");
		expect(session.drainCurrentProviderAccount).not.toHaveBeenCalled();
	});

	it("awaits session info before resolving the default command", async () => {
		const deferred = Promise.withResolvers<void>();
		const handleSessionCommand = vi.fn(() => deferred.promise);
		const harness = createRuntimeHarness({ handleSessionCommand });

		let settled = false;
		const execution = executeBuiltinSlashCommand("/session", harness.runtime).then(result => {
			settled = true;
			return result;
		});

		await Promise.resolve();

		expect(handleSessionCommand).toHaveBeenCalledTimes(1);
		expect(harness.handleSessionDeleteCommand).not.toHaveBeenCalled();
		expect(harness.setText).not.toHaveBeenCalled();
		expect(settled).toBe(false);

		deferred.resolve();

		expect(await execution).toBe(true);
		expect(settled).toBe(true);
		expect(harness.setText).toHaveBeenCalledWith("");
	});

	it("awaits the session account picker", async () => {
		const deferred = Promise.withResolvers<void>();
		const showSessionPinSelector = vi.fn(() => deferred.promise);
		const harness = createRuntimeHarness({ showSessionPinSelector });
		let settled = false;
		const execution = executeBuiltinSlashCommand("/session pin", harness.runtime).then(result => {
			settled = true;
			return result;
		});

		await Promise.resolve();
		expect(showSessionPinSelector).toHaveBeenCalledTimes(1);
		expect(harness.setText).not.toHaveBeenCalled();
		expect(settled).toBe(false);

		deferred.resolve();
		expect(await execution).toBe(true);
		expect(harness.setText).toHaveBeenCalledWith("");
	});

	it("propagates session info failures through executeBuiltinSlashCommand", async () => {
		const infoError = new Error("info failed");
		const handleSessionCommand = vi.fn(async () => {
			throw infoError;
		});
		const harness = createRuntimeHarness({ handleSessionCommand });

		await expect(executeBuiltinSlashCommand("/session info", harness.runtime)).rejects.toBe(infoError);
		expect(handleSessionCommand).toHaveBeenCalledTimes(1);
		expect(harness.handleSessionDeleteCommand).not.toHaveBeenCalled();
		expect(harness.setText).not.toHaveBeenCalled();
	});

	it("awaits session deletion before resolving the builtin command", async () => {
		const deferred = Promise.withResolvers<void>();
		const handleSessionDeleteCommand = vi.fn(() => deferred.promise);
		const harness = createRuntimeHarness({ handleSessionDeleteCommand });

		let settled = false;
		const execution = executeBuiltinSlashCommand("/session delete", harness.runtime).then(result => {
			settled = true;
			return result;
		});

		await Promise.resolve();

		expect(handleSessionDeleteCommand).toHaveBeenCalledTimes(1);
		expect(harness.setText).toHaveBeenCalledWith("");
		expect(settled).toBe(false);

		deferred.resolve();

		expect(await execution).toBe(true);
		expect(settled).toBe(true);
	});

	it("propagates session deletion failures through executeBuiltinSlashCommand", async () => {
		const deleteError = new Error("delete failed");
		const handleSessionDeleteCommand = vi.fn(async () => {
			throw deleteError;
		});
		const harness = createRuntimeHarness({ handleSessionDeleteCommand });

		await expect(executeBuiltinSlashCommand("/session delete", harness.runtime)).rejects.toBe(deleteError);
		expect(handleSessionDeleteCommand).toHaveBeenCalledTimes(1);
		expect(harness.setText).toHaveBeenCalledWith("");
	});
});
