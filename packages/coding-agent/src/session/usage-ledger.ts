import type { Database, Statement } from "bun:sqlite";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { isSqliteBusyError, logger } from "@oh-my-pi/pi-utils";
import { usdToNanos } from "./spend-ledger";

/** How long usage entries are kept, in ms (400 days); longer than the longest limit window. */
export const USAGE_RETENTION_MS = 400 * 24 * 60 * 60 * 1000;

/** Writes between two prunes of one ledger handle. */
export const PRUNE_EVERY_WRITES = 64;

/** Most entries one prune deletes, bounding the write transaction it runs in. */
export const PRUNE_MAX_ROWS = 1_000;

/** One completed model call. */
export interface UsageEntry {
	/** Epoch ms the call completed. */
	atMs: number;
	provider: string;
	model: string;
	/** The account that served the call: its policy name, else a stable identity; unset when unknown. */
	account?: string;
	/** Pool id (`role:<role>` or `chain:<key>`) of the pool that selected the model; unset outside a pool. */
	pool?: string;
	/** Cost in nano-USD; a non-negative safe integer. */
	costNanos: number;
	inputTokens: number;
	outputTokens: number;
}

/** Attempts at appending one entry while agent.db is busy, and the first retry delay in ms (doubling). */
export const RECORD_MAX_ATTEMPTS = 3;
export const RECORD_RETRY_BASE_MS = 50;

/**
 * The ledger entry of the completed call `message`, or undefined for a call that reported no
 * usage at all (a failed request). An invalid cost (non-finite or negative) records as zero.
 */
export function usageEntryOf(
	message: AssistantMessage,
	atMs: number,
	attribution: { account?: string; pool?: string } = {},
): UsageEntry | undefined {
	const { input, output, cacheRead, cacheWrite, cost } = message.usage;
	const costNanos = usdToNanos(cost.total) ?? 0;
	if (input + output + cacheRead + cacheWrite <= 0 && costNanos === 0) return undefined;
	return {
		atMs,
		provider: message.provider,
		model: message.model,
		...(attribution.account !== undefined ? { account: attribution.account } : {}),
		...(attribution.pool !== undefined ? { pool: attribution.pool } : {}),
		costNanos,
		inputTokens: input,
		outputTokens: output,
	};
}

/** Appends `entry` to `ledger`, retrying while agent.db is busy; rejects with the last error otherwise. */
export async function recordUsageEntry(ledger: UsageLedger, entry: UsageEntry): Promise<void> {
	for (let attempt = 1; ; attempt++) {
		try {
			ledger.record(entry, USAGE_RETENTION_MS);
			return;
		} catch (error) {
			if (!isSqliteBusyError(error) || attempt >= RECORD_MAX_ATTEMPTS) throw error;
		}
		await Bun.sleep(RECORD_RETRY_BASE_MS * 2 ** (attempt - 1));
	}
}

/** Calls a total covers: every set field must match; an empty scope matches every call. */
export interface UsageScope {
	provider?: string;
	model?: string;
	account?: string;
	pool?: string;
}

/** Sums over the calls of a window. */
export interface UsageTotals {
	costNanos: bigint;
	requests: bigint;
	/** Input plus output tokens; cache reads and writes are not counted. */
	tokens: bigint;
}

const SCOPE_FIELDS = ["provider", "model", "account", "pool"] as const;

/**
 * Durable per-call usage kept in agent.db, shared by every session and process on the database.
 *
 * Each call is one append-only row, so concurrent writers never lose an update, and every limit
 * counts the same rows by its scope, so no call is counted twice. The table and its indexes are
 * only ever added, never altered. Methods throw the underlying SQLite error; callers decide whether
 * a failure blocks (reads) or is logged (writes).
 */
export class UsageLedger {
	readonly #db: Database;
	readonly #insertStmt: Statement;
	readonly #pruneStmt: Statement;
	/** Total statements by the scope shapes they filter on. */
	readonly #totalStmts = new Map<string, Statement>();
	#writesSincePrune = 0;
	#closed = false;

	constructor(db: Database) {
		this.#db = db;
		db.run(`
CREATE TABLE IF NOT EXISTS usage_ledger (
	id INTEGER PRIMARY KEY,
	at_ms INTEGER NOT NULL,
	provider TEXT NOT NULL,
	model TEXT NOT NULL,
	account TEXT,
	pool TEXT,
	cost_nanos INTEGER NOT NULL CHECK (cost_nanos >= 0),
	input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
	output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0)
);
CREATE INDEX IF NOT EXISTS usage_ledger_at ON usage_ledger (at_ms);
CREATE INDEX IF NOT EXISTS usage_ledger_model_at ON usage_ledger (provider, model, at_ms);
CREATE INDEX IF NOT EXISTS usage_ledger_account_at ON usage_ledger (account, at_ms);
`);
		this.#insertStmt = db.prepare(
			"INSERT INTO usage_ledger (at_ms, provider, model, account, pool, cost_nanos, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		);
		this.#pruneStmt = db.prepare(
			"DELETE FROM usage_ledger WHERE id IN (SELECT id FROM usage_ledger WHERE at_ms < ? ORDER BY at_ms LIMIT ?)",
		);
	}

	/**
	 * Appends `entry` in one statement, so a failed call writes nothing and may be retried. With
	 * `retainMs`, entries older than `entry.atMs - retainMs` are pruned once every
	 * {@link PRUNE_EVERY_WRITES} writes of this handle; a failed prune is logged, not thrown.
	 *
	 * @throws RangeError when an amount is not a non-negative safe integer or `atMs` is not finite.
	 * @throws Error when the ledger is closed.
	 */
	record(entry: UsageEntry, retainMs?: number): void {
		this.#assertOpen();
		for (const amount of [entry.costNanos, entry.inputTokens, entry.outputTokens]) {
			if (!Number.isSafeInteger(amount) || amount < 0) {
				throw new RangeError("usage amounts must be non-negative safe integers");
			}
		}
		if (!Number.isFinite(entry.atMs)) throw new RangeError("usage timestamp must be finite");
		this.#insertStmt.run(
			Math.trunc(entry.atMs),
			entry.provider,
			entry.model,
			entry.account ?? null,
			entry.pool ?? null,
			entry.costNanos,
			entry.inputTokens,
			entry.outputTokens,
		);
		if (retainMs === undefined) return;
		this.#writesSincePrune++;
		if (this.#writesSincePrune < PRUNE_EVERY_WRITES) return;
		this.#writesSincePrune = 0;
		try {
			this.#pruneStmt.run(Math.trunc(entry.atMs - retainMs), PRUNE_MAX_ROWS);
		} catch (error) {
			// The entry is written; a later write prunes again.
			logger.debug("Usage ledger prune failed", { error: String(error) });
		}
	}

	/**
	 * Totals of the calls stamped after `sinceMs` that match any of `scopes`; a call matching
	 * several counts once. Entries stamped in the future (clock skew between processes) count too.
	 */
	totals(scopes: readonly UsageScope[], sinceMs: number): UsageTotals {
		this.#assertOpen();
		if (scopes.length === 0) return { costNanos: 0n, requests: 0n, tokens: 0n };
		const shape = scopes.map(scope => SCOPE_FIELDS.map(field => (scope[field] === undefined ? "-" : "+")).join(""));
		const key = shape.join(",");
		let stmt = this.#totalStmts.get(key);
		if (!stmt) {
			const predicate = shape
				.map(fields => {
					const set = SCOPE_FIELDS.filter((_field, index) => fields[index] === "+");
					return set.length === 0 ? "1" : `(${set.map(field => `${field} = ?`).join(" AND ")})`;
				})
				.join(" OR ");
			// Summed as text so a total past 2^53 stays exact; SQLite raises on int64 overflow.
			stmt = this.#db.prepare(
				`SELECT CAST(COALESCE(SUM(cost_nanos), 0) AS TEXT) AS cost, COUNT(*) AS requests, CAST(COALESCE(SUM(input_tokens + output_tokens), 0) AS TEXT) AS tokens FROM usage_ledger WHERE at_ms > ? AND (${predicate})`,
			);
			this.#totalStmts.set(key, stmt);
		}
		const values = scopes.flatMap(scope => SCOPE_FIELDS.flatMap(field => scope[field] ?? []));
		const row = stmt.get(Math.trunc(sinceMs), ...values) as { cost: string; requests: number; tokens: string } | null;
		return {
			costNanos: BigInt(row?.cost ?? "0"),
			requests: BigInt(row?.requests ?? 0),
			tokens: BigInt(row?.tokens ?? "0"),
		};
	}

	#assertOpen(): void {
		if (this.#closed) throw new Error("usage ledger is closed");
	}

	/** Finalizes the prepared statements; the database stays open. Later calls throw. */
	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#insertStmt.finalize();
		this.#pruneStmt.finalize();
		for (const stmt of this.#totalStmts.values()) stmt.finalize();
		this.#totalStmts.clear();
	}
}
