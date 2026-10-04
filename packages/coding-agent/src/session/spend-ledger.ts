import type { Database, Statement } from "bun:sqlite";
import { scaleDecimal } from "@oh-my-pi/pi-ai/usage/billing";
import { logger } from "@oh-my-pi/pi-utils";

/** Decimal places of a ledger amount: amounts are integer nano-USD, the precision of budget amounts. */
export const SPEND_AMOUNT_EXPONENT = 9;

/** How long spend entries are kept, in ms (400 days); longer than the longest budget window. */
export const SPEND_RETENTION_MS = 400 * 24 * 60 * 60 * 1000;

/** Writes between two prunes of one ledger handle. */
const PRUNE_EVERY_WRITES = 64;

/** Most entries one prune deletes, bounding the write transaction it runs in. */
export const PRUNE_MAX_ROWS = 1_000;

/** One model call charged to a local budget. */
export interface SpendEntry {
	/** Epoch ms the call completed. */
	atMs: number;
	/** `budget.id` of the `local-hard-budget` policy the call is charged to. */
	budgetId: string;
	/** Role or chain key whose pool selected the model. */
	owner: string;
	/** Member selector as configured. */
	member: string;
	provider: string;
	model: string;
	/** Cost in nano-USD; a non-negative safe integer ({@link usdToNanos}). */
	costNanos: number;
}

/**
 * Cost of one call in nano-USD, rounded up so a budget is never undercharged. `undefined` for a
 * non-finite or negative cost and for costs beyond the safe integer range.
 */
export function usdToNanos(costUsd: number): number | undefined {
	if (!Number.isFinite(costUsd) || costUsd < 0) return undefined;
	return scaleDecimal(costUsd, SPEND_AMOUNT_EXPONENT, "ceil");
}

/**
 * Durable per-budget spend kept in agent.db, shared by every session and process on the database.
 *
 * Each call is one append-only row, so concurrent writers never lose an update: a window's spend is
 * the sum of its rows at read time. The table and its indexes are only ever added, never altered,
 * so a binary that predates them keeps using the same database unchanged. Methods throw the
 * underlying SQLite error; callers decide whether a failure blocks (reads) or is logged (writes).
 */
export class SpendLedger {
	readonly #insertStmt: Statement;
	readonly #sumStmt: Statement;
	readonly #pruneStmt: Statement;
	#writesSincePrune = 0;
	#closed = false;

	constructor(db: Database) {
		db.run(`
CREATE TABLE IF NOT EXISTS spend_ledger (
	id INTEGER PRIMARY KEY,
	at_ms INTEGER NOT NULL,
	budget_id TEXT NOT NULL,
	owner TEXT NOT NULL,
	member TEXT NOT NULL,
	provider TEXT NOT NULL,
	model TEXT NOT NULL,
	cost_nanos INTEGER NOT NULL CHECK (cost_nanos >= 0)
);
CREATE INDEX IF NOT EXISTS spend_ledger_budget_at ON spend_ledger (budget_id, at_ms);
CREATE INDEX IF NOT EXISTS spend_ledger_at ON spend_ledger (at_ms);
`);
		this.#insertStmt = db.prepare(
			"INSERT INTO spend_ledger (at_ms, budget_id, owner, member, provider, model, cost_nanos) VALUES (?, ?, ?, ?, ?, ?, ?)",
		);
		// Summed as text so a total past 2^53 stays exact; SQLite raises on int64 overflow.
		this.#sumStmt = db.prepare(
			"SELECT CAST(COALESCE(SUM(cost_nanos), 0) AS TEXT) AS total FROM spend_ledger WHERE budget_id = ? AND at_ms > ?",
		);
		this.#pruneStmt = db.prepare(
			"DELETE FROM spend_ledger WHERE id IN (SELECT id FROM spend_ledger WHERE at_ms < ? ORDER BY at_ms LIMIT ?)",
		);
	}

	/**
	 * Appends `entry` in one statement, so a failed call writes nothing and may be retried. With
	 * `retainMs`, entries older than `entry.atMs - retainMs` are pruned once every
	 * {@link PRUNE_EVERY_WRITES} writes of this handle; a failed prune is logged, not thrown.
	 *
	 * @throws RangeError when `costNanos` is not a non-negative safe integer or `atMs` is not finite.
	 * @throws Error when the ledger is closed.
	 */
	record(entry: SpendEntry, retainMs?: number): void {
		this.#assertOpen();
		if (!Number.isSafeInteger(entry.costNanos) || entry.costNanos < 0) {
			throw new RangeError("spend cost must be a non-negative safe integer of nano-USD");
		}
		if (!Number.isFinite(entry.atMs)) throw new RangeError("spend timestamp must be finite");
		this.#insertStmt.run(
			Math.trunc(entry.atMs),
			entry.budgetId,
			entry.owner,
			entry.member,
			entry.provider,
			entry.model,
			entry.costNanos,
		);
		if (retainMs === undefined) return;
		this.#writesSincePrune++;
		if (this.#writesSincePrune < PRUNE_EVERY_WRITES) return;
		this.#writesSincePrune = 0;
		try {
			this.prune(entry.atMs - retainMs);
		} catch (error) {
			// The entry is written; a later write prunes again.
			logger.debug("Spend ledger prune failed", { error: String(error) });
		}
	}

	/**
	 * Spend charged to `budgetId` in the rolling window of `durationMs` ending at `nowMs`, in
	 * nano-USD. Entries stamped after `nowMs` (clock skew between processes) count too.
	 */
	spentInWindow(budgetId: string, durationMs: number, nowMs: number): bigint {
		this.#assertOpen();
		const row = this.#sumStmt.get(budgetId, Math.trunc(nowMs - durationMs)) as { total: string } | null;
		return BigInt(row?.total ?? "0");
	}

	/**
	 * Deletes up to {@link PRUNE_MAX_ROWS} of the oldest entries stamped before `beforeMs`; returns
	 * how many were deleted. Later prunes continue where a capped one stopped.
	 */
	prune(beforeMs: number): number {
		this.#assertOpen();
		return this.#pruneStmt.run(Math.trunc(beforeMs), PRUNE_MAX_ROWS).changes;
	}

	#assertOpen(): void {
		if (this.#closed) throw new Error("spend ledger is closed");
	}

	/** Finalizes the prepared statements; the database stays open. Later calls throw. */
	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#insertStmt.finalize();
		this.#sumStmt.finalize();
		this.#pruneStmt.finalize();
	}
}
