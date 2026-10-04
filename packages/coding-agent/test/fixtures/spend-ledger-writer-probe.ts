/**
 * Child process for the spend ledger concurrency test: opens agent.db at argv[2] through
 * AgentStorage and records argv[3] one-nano charges to budget argv[4], then exits.
 */
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";

const [dbPath, countArg, budgetId] = process.argv.slice(2);
if (!dbPath || !countArg || !budgetId) throw new Error("usage: <db> <count> <budget>");
const storage = await AgentStorage.open(dbPath);
for (let index = 0; index < Number(countArg); index++) {
	storage.spendLedger.record({
		atMs: Date.now(),
		budgetId,
		owner: `pid-${process.pid}`,
		member: "openai/gpt-4o-mini",
		provider: "openai",
		model: "gpt-4o-mini",
		costNanos: 1,
	});
	await Bun.sleep(0);
}
AgentStorage.close();
