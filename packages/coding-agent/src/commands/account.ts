/**
 * Manage stored provider accounts.
 */

import { APP_NAME } from "@oh-my-pi/pi-utils";
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { type AccountAction, runAccountCommand } from "../cli/account-cli";
import { accountHelp as commandHelp } from "../cli/command-help";

const ACTIONS: AccountAction[] = [
	"list",
	"label",
	"priority",
	"reserve",
	"reset",
	"pin",
	"unpin",
	"logout",
	"enable",
	"disable",
];

export default class Account extends Command {
	static description = commandHelp.description;
	static args = {
		action: Args.string({ description: "Account action", required: false, options: ACTIONS }),
		target: Args.string({
			description: "Account ([provider/]name, email, account id, key fingerprint, or #id), or provider for unpin",
			required: false,
		}),
		value: Args.string({ description: "Name, priority, or reserve percentage", required: false }),
	};

	static flags = {
		json: Flags.boolean({ description: "Output JSON (list)" }),
		on: Flags.string({ description: "reset: windows whose exhaustion permits recovery (5h, 7d, 5h,7d; any clears)" }),
		auto: Flags.string({
			description: "reset: autoRedeem override for the account (yes, no, unset; inherit clears)",
		}),
	};

	static examples = [
		`# List stored accounts with names, priorities, reserves, and project pins\n  ${APP_NAME} account list`,
		`# Name an account, then pin the current project to it\n  ${APP_NAME} account label work@example.com work\n  ${APP_NAME} account pin work`,
		`# Prefer an account and keep 20% of its quota in reserve\n  ${APP_NAME} account priority work 10\n  ${APP_NAME} account reserve work 20`,
		`# A negative priority goes after --\n  ${APP_NAME} account priority work -- -5`,
		`# Spend saved resets on an account only when its 7-day window is exhausted, without asking\n  ${APP_NAME} account reset anthropic/work --on 7d --auto yes`,
		`# Stop using an account without logging it out, then use it again\n  ${APP_NAME} account disable anthropic/work\n  ${APP_NAME} account enable anthropic/work`,
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Account);
		await runAccountCommand({
			action: (args.action ?? "list") as AccountAction,
			target: args.target,
			value: args.value,
			json: flags.json,
			on: flags.on,
			auto: flags.auto,
		});
	}
}
