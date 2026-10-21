/**
 * `omp account` — list stored provider accounts, name them, set their priority,
 * reserve, and saved-reset policy, pin the current project to one, and log one out.
 * Writes go to the user config (`auth.accountPolicies`, `auth.accountPins`); see
 * `session/account-admin.ts` for the shared rules.
 */
import {
	RESET_AUTO_REDEEM_MODES,
	RESET_ON_WINDOWS,
	type ResetAutoRedeemOverride,
	type ResetOnWindow,
} from "@oh-my-pi/pi-ai/auth-storage";
import { APP_NAME, getProjectDir } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { Settings } from "../config/settings";
import { discoverAuthStorage } from "../sdk";
import {
	type AccountListing,
	type AccountWriteResult,
	labelAccount,
	listAccounts,
	logoutAccount,
	pinProjectAccount,
	resolveAccount,
	setAccountPriority,
	setAccountReserve,
	setAccountEnabled,
	setAccountResets,
	unpinProjectAccount,
} from "../session/account-admin";
import type { AuthStorage } from "../session/auth-storage";
import { formatLimitUsage, localLimitJson } from "../session/local-limits";

export type AccountAction =
	| "list"
	| "label"
	| "priority"
	| "reserve"
	| "reset"
	| "pin"
	| "unpin"
	| "logout"
	| "enable"
	| "disable";

export interface AccountCommandArgs {
	action: AccountAction;
	target?: string;
	value?: string;
	json?: boolean;
	/** `reset`: comma-separated {@link RESET_ON_WINDOWS}, or `any` to remove `resetOn`. */
	on?: string;
	/** `reset`: {@link RESET_AUTO_REDEEM_MODES} value, or `inherit` to remove `autoRedeem`. */
	auto?: string;
}

const USAGE: Record<AccountAction, string> = {
	list: `${APP_NAME} account list [--json]`,
	label: `${APP_NAME} account label <account> <name>`,
	priority: `${APP_NAME} account priority <account> <number>`,
	reserve: `${APP_NAME} account reserve <account> <percent>`,
	reset: `${APP_NAME} account reset <account> [--on 5h|7d|5h,7d|any] [--auto yes|no|unset|inherit]`,
	pin: `${APP_NAME} account pin [provider/]<name>`,
	unpin: `${APP_NAME} account unpin [provider]`,
	logout: `${APP_NAME} account logout <account>`,
	enable: `${APP_NAME} account enable <account>`,
	disable: `${APP_NAME} account disable <account>`,
};

function required(value: string | undefined, action: AccountAction): string {
	if (value === undefined || value.trim() === "") throw new Error(`Usage: ${USAGE[action]}`);
	return value.trim();
}

function number(value: string, what: string): number {
	const parsed = Number(value);
	if (value.trim() === "" || !Number.isFinite(parsed)) throw new Error(`${what} must be a number: ${value}`);
	return parsed;
}

function resetOnWindows(value: string): readonly ResetOnWindow[] | undefined {
	if (value.trim() === "any") return undefined;
	const windows = [...new Set(value.split(",").map(window => window.trim()))];
	if (windows.some(window => !(RESET_ON_WINDOWS as readonly string[]).includes(window))) {
		throw new Error(`--on must be any or a comma-separated list of ${RESET_ON_WINDOWS.join(", ")}: ${value}`);
	}
	return windows as ResetOnWindow[];
}

function autoRedeemOverride(value: string): ResetAutoRedeemOverride | undefined {
	const mode = value.trim();
	if (mode === "inherit") return undefined;
	if (!(RESET_AUTO_REDEEM_MODES as readonly string[]).includes(mode)) {
		throw new Error(`--auto must be one of ${RESET_AUTO_REDEEM_MODES.join(", ")}, or inherit: ${value}`);
	}
	return mode as ResetAutoRedeemOverride;
}

function printListing(rows: readonly AccountListing[], json: boolean | undefined): void {
	if (json) {
		const out = rows.map(row => ({
			provider: row.provider,
			credentialId: row.account.credentialId,
			type: row.account.type,
			name: row.account.name ?? null,
			label: row.label,
			priority: row.priority ?? null,
			reservePct: row.reservePct ?? null,
			drain: row.drain,
			resetOn: row.resetOn ?? null,
			autoRedeem: row.autoRedeem ?? null,
			limits: row.limits.map(localLimitJson),
			keyFingerprint: row.account.keyFingerprint ?? null,
			projectPinned: row.projectPinned,
			disabled: row.account.disabled === true,
		}));
		process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
		return;
	}
	if (rows.length === 0) {
		process.stdout.write(`No stored accounts. Log in with \`${APP_NAME} login\`.\n`);
		return;
	}
	let provider: string | undefined;
	for (const row of rows) {
		if (row.provider !== provider) {
			provider = row.provider;
			process.stdout.write(`${chalk.bold(provider)}\n`);
		}
		const facts = [
			row.priority !== undefined ? `priority ${row.priority}` : undefined,
			row.reservePct !== undefined ? `reserve ${row.reservePct}%` : undefined,
			row.drain ? "drained first" : undefined,
			row.resetOn !== undefined ? `resets on ${row.resetOn.join(", ")}` : undefined,
			row.autoRedeem !== undefined ? `auto-redeem ${row.autoRedeem}` : undefined,
			...row.limits.map(limit =>
				"window" in limit ? `limit ${formatLimitUsage(limit, Date.now())}` : `limit ${limit.metric} ${limit.max}`,
			),
			row.projectPinned ? chalk.green("pinned for this project") : undefined,
			row.account.disabled
				? chalk.red(`disabled (${APP_NAME} account enable ${row.provider}/#${row.account.credentialId})`)
				: undefined,
		].filter(Boolean);
		const name = row.account.name ? chalk.cyan(row.account.name) : chalk.dim("(unnamed)");
		process.stdout.write(
			`  #${row.account.credentialId}  ${name}  ${row.label}${facts.length > 0 ? chalk.dim(`  ${facts.join(" · ")}`) : ""}\n`,
		);
	}
	process.stdout.write(chalk.dim(`\nSession pins are per session; manage them with /session pin or /account.\n`));
}

function printWarning(result: AccountWriteResult): void {
	if (result.warning) process.stderr.write(chalk.yellow(`${result.warning}\n`));
}

async function runAction(
	cmd: AccountCommandArgs,
	settings: Settings,
	authStorage: AuthStorage,
	cwd: string,
): Promise<void> {
	switch (cmd.action) {
		case "list":
			printListing(listAccounts(settings, authStorage, cwd), cmd.json);
			return;
		case "label": {
			const ref = resolveAccount(authStorage, required(cmd.target, "label"));
			const name = required(cmd.value, "label");
			printWarning(labelAccount(settings, authStorage, ref, name));
			process.stdout.write(chalk.green(`Named ${ref.provider} account #${ref.account.credentialId} "${name}".\n`));
			return;
		}
		case "priority": {
			const ref = resolveAccount(authStorage, required(cmd.target, "priority"));
			const priority = number(required(cmd.value, "priority"), "Priority");
			printWarning(setAccountPriority(settings, authStorage, ref, priority));
			process.stdout.write(
				chalk.green(`Set priority ${priority} for ${ref.provider} account #${ref.account.credentialId}.\n`),
			);
			return;
		}
		case "reserve": {
			const ref = resolveAccount(authStorage, required(cmd.target, "reserve"));
			const reservePct = number(required(cmd.value, "reserve").replace(/%$/, ""), "Reserve");
			printWarning(setAccountReserve(settings, authStorage, ref, reservePct));
			process.stdout.write(
				chalk.green(`Set reserve ${reservePct}% for ${ref.provider} account #${ref.account.credentialId}.\n`),
			);
			return;
		}
		case "reset": {
			const ref = resolveAccount(authStorage, required(cmd.target, "reset"));
			if (cmd.on === undefined && cmd.auto === undefined) throw new Error(`Usage: ${USAGE.reset}`);
			const resets = {
				...(cmd.on !== undefined ? { resetOn: resetOnWindows(cmd.on) } : {}),
				...(cmd.auto !== undefined ? { autoRedeem: autoRedeemOverride(cmd.auto) } : {}),
			};
			printWarning(setAccountResets(settings, authStorage, ref, resets));
			process.stdout.write(
				chalk.green(`Set saved-reset policy for ${ref.provider} account #${ref.account.credentialId}.\n`),
			);
			return;
		}
		case "pin": {
			const result = pinProjectAccount(settings, authStorage, cwd, required(cmd.target, "pin"));
			printWarning(result);
			process.stdout.write(chalk.green(`Pinned ${result.provider} to "${result.name}" for ${result.projectDir}.\n`));
			return;
		}
		case "unpin": {
			const result = unpinProjectAccount(settings, cwd, cmd.target?.trim() || undefined);
			process.stdout.write(
				result.removed > 0
					? chalk.green(`Removed ${result.removed} project pin(s) from ${result.projectDir}.\n`)
					: "No project pin in the user config covers this directory.\n",
			);
			for (const layer of result.shadowedBy) {
				process.stderr.write(
					chalk.yellow(`A ${layer} auth.accountPins value still pins this project; change it where it is set.\n`),
				);
			}
			return;
		}
		case "logout": {
			const ref = resolveAccount(authStorage, required(cmd.target, "logout"));
			const result = await logoutAccount(settings, authStorage, ref);
			printWarning(result);
			process.stdout.write(chalk.green(`Logged out ${ref.provider} account #${ref.account.credentialId}.\n`));
			for (const project of result.pinnedProjects) {
				process.stderr.write(
					chalk.yellow(
						`${project} is still pinned to "${ref.account.name}"; its ${ref.provider} requests fail until you unpin it.\n`,
					),
				);
			}
			return;
		}
		case "enable":
		case "disable": {
			const enabled = cmd.action === "enable";
			const ref = resolveAccount(authStorage, required(cmd.target, cmd.action));
			const result = await setAccountEnabled(settings, authStorage, ref, enabled);
			const account = `${ref.provider} account #${ref.account.credentialId}`;
			process.stdout.write(
				result.changed
					? chalk.green(`${enabled ? "Enabled" : "Disabled"} ${account}.\n`)
					: `${account} is already ${enabled ? "enabled" : "disabled"}.\n`,
			);
			if (!enabled) {
				for (const project of result.pinnedProjects) {
					process.stderr.write(
						chalk.yellow(
							`${project} is pinned to "${ref.account.name}"; its ${ref.provider} requests fail until you enable it or unpin it.\n`,
						),
					);
				}
			}
			return;
		}
	}
}

/** Settings, credential store, and working directory an action runs against; tests supply their own. */
export interface AccountCommandContext {
	settings: Settings;
	authStorage: AuthStorage;
	cwd: string;
}

/**
 * Run one `omp account` action against the user config and the configured
 * credential store. A rejected action prints its reason to stderr, sets exit
 * code 1, and does not save the user config.
 */
export async function runAccountCommand(cmd: AccountCommandArgs, context?: AccountCommandContext): Promise<void> {
	const cwd = context?.cwd ?? getProjectDir();
	const settings = context?.settings ?? (await Settings.init({ cwd }));
	const authStorage = context?.authStorage ?? (await discoverAuthStorage(undefined, { settings }));
	try {
		await authStorage.credentials.reload();
		await runAction(cmd, settings, authStorage, cwd);
		await settings.flush();
	} catch (error) {
		process.stderr.write(chalk.red(`${error instanceof Error ? error.message : String(error)}\n`));
		process.exitCode = 1;
	} finally {
		if (!context) authStorage.close();
	}
}
