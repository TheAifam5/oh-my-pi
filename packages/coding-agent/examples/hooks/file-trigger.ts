/**
 * File Trigger Hook
 *
 * Watches a trigger file and injects its contents into the conversation.
 * Useful for external systems to send messages to the agent.
 *
 * Usage:
 *   echo "Run the tests" > /tmp/agent-trigger.txt
 */
import * as fs from "node:fs";
import { isSessionReplacementStart } from "@oh-my-pi/pi-coding-agent";
import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";

export default function (pi: HookAPI) {
	pi.on("session_start", async (event, ctx) => {
		// session_start also fires after /new, resume, and fork; watch the file once.
		if (isSessionReplacementStart(event)) return;
		const triggerFile = "/tmp/agent-trigger.txt";

		fs.watch(triggerFile, async () => {
			try {
				const content = (await Bun.file(triggerFile).text()).trim();
				if (content) {
					pi.sendMessage(
						{
							customType: "file-trigger",
							content: `External trigger: ${content}`,
							display: true,
						},
						{ triggerTurn: true }, // get LLM to respond
					);
					await Bun.write(triggerFile, ""); // Clear after reading
				}
			} catch {
				// File might not exist yet
			}
		});

		if (ctx.hasUI) {
			ctx.ui.notify(`Watching ${triggerFile}`, "info");
		}
	});
}
