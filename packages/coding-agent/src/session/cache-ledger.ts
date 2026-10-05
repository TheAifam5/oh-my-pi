import type { Database, Statement } from "bun:sqlite";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { isSqliteBusyError, logger } from "@oh-my-pi/pi-utils";
import {
	PRUNE_EVERY_WRITES,
	PRUNE_MAX_ROWS,
	RECORD_MAX_ATTEMPTS,
	RECORD_RETRY_BASE_MS,
	USAGE_RETENTION_MS,
} from "./usage-ledger";

/** Default window of {@link CacheLedger.cacheHitRate}, in ms (7 days, rolling). */
export const CACHE_HIT_RATE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Attempts at reading the hit rate while agent.db is busy; reads are synchronous, so retries are immediate. */
const READ_ATTEMPTS = 3;

/** Prompt-cache token usage of one completed model call. */
export interface CacheEntry {
	/** Epoch ms the call completed. */
	atMs: number;
	provider: string;
	model: string;
	/** Endpoint the call was sent to, recorded under its {@link cacheEndpointKey}; unset when unknown. */
	baseUrl?: string;
	/** Uncached input tokens. */
	inputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
}

/** A prompt-cache hit rate and the number of calls it was computed from. */
export interface CacheHitRate {
	/** Cache-read tokens over all prompt tokens (cache reads, cache writes, and uncached input), in [0, 1]. */
	rate: number;
	samples: number;
}

/**
 * The key an endpoint is recorded and looked up under: `baseUrl` trimmed, with its scheme and host
 * lowercased and trailing slashes after the host removed; null when unset or empty.
 */
export function cacheEndpointKey(baseUrl: string | undefined): string | null {
	const trimmed = baseUrl?.trim();
	if (!trimmed) return null;
	const origin = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i.exec(trimmed)?.[0] ?? "";
	return origin.toLowerCase() + trimmed.slice(origin.length).replace(/\/+$/, "");
}

/**
 * The cache entry of the completed call `message`, or undefined for a call that reported no
 * prompt tokens (a failed request, or one that reported only output).
 */
export function cacheEntryOf(message: AssistantMessage, atMs: number, baseUrl?: string): CacheEntry | undefined {
	const { input, cacheRead, cacheWrite } = message.usage;
	if (input + cacheRead + cacheWrite <= 0) return undefined;
	return {
		atMs,
		provider: message.provider,
		model: message.model,
		...(baseUrl ? { baseUrl } : {}),
		inputTokens: input,
		cacheReadTokens: cacheRead,
		cacheWriteTokens: cacheWrite,
	};
}

/** Appends `entry` to `ledger`, retrying while agent.db is busy; rejects with the last error otherwise. */
export async function recordCacheEntry(ledger: CacheLedger, entry: CacheEntry): Promise<void> {
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

/**
 * Durable per-call prompt-cache token usage kept in agent.db, shared by every session and process
 * on the database. Each call is one append-only row; the table and its index are only ever added,
 * never altered.
 */
export class CacheLedger {
	readonly #insertStmt: Statement;
	readonly #pruneStmt: Statement;
	readonly #rateStmt: Statement;
	#writesSincePrune = 0;
	#closed = false;

	constructor(db: Database) {
		db.run(`
CREATE TABLE IF NOT EXISTS cache_usage_ledger (
	id INTEGER PRIMARY KEY,
	at_ms INTEGER NOT NULL,
	provider TEXT NOT NULL,
	model TEXT NOT NULL,
	base_url TEXT,
	input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
	cache_read_tokens INTEGER NOT NULL CHECK (cache_read_tokens >= 0),
	cache_write_tokens INTEGER NOT NULL CHECK (cache_write_tokens >= 0)
);
CREATE INDEX IF NOT EXISTS cache_usage_ledger_at ON cache_usage_ledger (at_ms);
CREATE INDEX IF NOT EXISTS cache_usage_ledger_model_at ON cache_usage_ledger (provider, model, base_url, at_ms);
`);
		this.#insertStmt = db.prepare(
			"INSERT INTO cache_usage_ledger (at_ms, provider, model, base_url, input_tokens, cache_read_tokens, cache_write_tokens) VALUES (?, ?, ?, ?, ?, ?, ?)",
		);
		this.#pruneStmt = db.prepare(
			"DELETE FROM cache_usage_ledger WHERE id IN (SELECT id FROM cache_usage_ledger WHERE at_ms < ? ORDER BY at_ms LIMIT ?)",
		);
		// Summed as REAL: the rate is a ratio, so exactness past 2^53 tokens does not matter.
		this.#rateStmt = db.prepare(
			"SELECT COUNT(*) AS samples, TOTAL(cache_read_tokens) AS hits, TOTAL(cache_read_tokens + cache_write_tokens + input_tokens) AS prompt FROM cache_usage_ledger WHERE provider = ? AND model = ? AND base_url IS ? AND at_ms > ? AND at_ms <= ?",
		);
	}

	/**
	 * Appends `entry` in one statement, so a failed call writes nothing and may be retried. With
	 * `retainMs`, entries older than `entry.atMs - retainMs` are pruned once every
	 * {@link PRUNE_EVERY_WRITES} writes of this handle; a failed prune is logged, not thrown.
	 *
	 * @throws RangeError when a token count is not a non-negative safe integer or `atMs` is not finite.
	 * @throws Error when the ledger is closed.
	 */
	record(entry: CacheEntry, retainMs?: number): void {
		if (this.#closed) throw new Error("cache ledger is closed");
		for (const amount of [entry.inputTokens, entry.cacheReadTokens, entry.cacheWriteTokens]) {
			if (!Number.isSafeInteger(amount) || amount < 0) {
				throw new RangeError("cache token counts must be non-negative safe integers");
			}
		}
		if (!Number.isFinite(entry.atMs)) throw new RangeError("cache usage timestamp must be finite");
		this.#insertStmt.run(
			Math.trunc(entry.atMs),
			entry.provider,
			entry.model,
			cacheEndpointKey(entry.baseUrl),
			entry.inputTokens,
			entry.cacheReadTokens,
			entry.cacheWriteTokens,
		);
		if (retainMs === undefined) return;
		this.#writesSincePrune++;
		if (this.#writesSincePrune < PRUNE_EVERY_WRITES) return;
		this.#writesSincePrune = 0;
		try {
			this.#pruneStmt.run(Math.trunc(entry.atMs - retainMs), PRUNE_MAX_ROWS);
		} catch (error) {
			// The entry is written; a later write prunes again.
			logger.debug("Cache ledger prune failed", { error: String(error) });
		}
	}

	/**
	 * The prompt-cache hit rate of the calls to `provider`/`model` at `baseUrl` (compared by
	 * {@link cacheEndpointKey}; unset matches calls recorded without one) stamped in `(sinceMs, nowMs]`; `sinceMs` defaults to
	 * `nowMs - CACHE_HIT_RATE_WINDOW_MS`. Undefined when no call matches, the matching calls
	 * reported no prompt tokens, or the ledger cannot be read; never throws.
	 */
	cacheHitRate(
		provider: string,
		model: string,
		baseUrl: string | undefined,
		sinceMs: number | undefined,
		nowMs: number,
	): CacheHitRate | undefined {
		const since = sinceMs ?? nowMs - CACHE_HIT_RATE_WINDOW_MS;
		for (let attempt = 1; ; attempt++) {
			try {
				if (this.#closed) return undefined;
				const row = this.#rateStmt.get(
					provider,
					model,
					cacheEndpointKey(baseUrl),
					Math.trunc(since),
					Math.trunc(nowMs),
				) as {
					samples: number;
					hits: number;
					prompt: number;
				} | null;
				if (!row || row.samples === 0 || row.prompt <= 0) return undefined;
				return { rate: row.hits / row.prompt, samples: row.samples };
			} catch (error) {
				if (isSqliteBusyError(error) && attempt < READ_ATTEMPTS) continue;
				logger.debug("Cache ledger could not be read", { error: String(error) });
				return undefined;
			}
		}
	}

	/** Finalizes the prepared statements; the database stays open. Later writes throw. */
	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#insertStmt.finalize();
		this.#pruneStmt.finalize();
		this.#rateStmt.finalize();
	}
}
