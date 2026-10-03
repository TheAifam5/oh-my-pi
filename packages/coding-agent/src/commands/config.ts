/**
 * Manage configuration settings.
 */

import { Args, CliUsageError, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { configHelp as commandHelp } from "../cli/command-help";
import { type ConfigAction, type ConfigCommandArgs, runConfigCommand } from "../cli/config-cli";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

const ACTIONS: ConfigAction[] = ["list", "get", "set", "reset", "path", "schema", "init-xdg"];

export default class Config extends Command {
	static description = commandHelp.description;
	static args = {
		action: Args.string({
			description: "Config action",
			required: false,
			options: ACTIONS,
		}),
		key: Args.string({
			description: "Setting key",
			required: false,
		}),
		value: Args.string({
			description: "Value (for set/reset)",
			required: false,
			multiple: true,
		}),
	};

	static flags = {
		json: Flags.boolean({ description: "Output JSON" }),
		out: Flags.string({ char: "o", description: "Write schema output to this file instead of stdout" }),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Config);
		const action = (args.action ?? "list") as ConfigAction;
		const value = Array.isArray(args.value) ? args.value.join(" ") : args.value;
		if (flags.out !== undefined) {
			if (action !== "schema") throw new CliUsageError("--out applies only to `config schema`");
			if (flags.out === "") throw new CliUsageError("--out requires a file path");
		}

		const cmd: ConfigCommandArgs = {
			action,
			key: args.key,
			value,
			flags: {
				json: flags.json,
				out: flags.out,
			},
		};

		// Without a loaded theme, schema descriptions render key hints in ASCII on every host.
		if (action !== "schema") await initTheme();
		await runConfigCommand(cmd);
	}
}
