/**
 * `omp account` — list stored provider accounts, name them, set their priority
 * and reserve, pin the current project to one, and log one out. Writes go to
 * the user config (`auth.accountPolicies`, `auth.accountPins`); see
 * `session/account-admin.ts` for the shared rules.
 */
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
	unpinProjectAccount,
} from "../session/account-admin";
import type { AuthStorage } from "../session/auth-storage";

export type AccountAction = "list" | "label" | "priority" | "reserve" | "pin" | "unpin" | "logout";

export interface AccountCommandArgs {
	action: AccountAction;
	target?: string;
	value?: string;
	json?: boolean;
}

const USAGE: Record<AccountAction, string> = {
	list: `${APP_NAME} account list [--json]`,
	label: `${APP_NAME} account label <account> <name>`,
	priority: `${APP_NAME} account priority <account> <number>`,
	reserve: `${APP_NAME} account reserve <account> <percent>`,
	pin: `${APP_NAME} account pin [provider/]<name>`,
	unpin: `${APP_NAME} account unpin [provider]`,
	logout: `${APP_NAME} account logout <account>`,
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
			keyFingerprint: row.account.keyFingerprint ?? null,
			projectPinned: row.projectPinned,
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
			row.projectPinned ? chalk.green("pinned for this project") : undefined,
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
