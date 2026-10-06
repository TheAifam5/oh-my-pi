/**
 * Account limits the `omp auth-gateway` transports (`serve`, `stdio`) enforce against a usage
 * ledger in the agent's `agent.db`.
 */
import type { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AuthAccountPolicies, AuthStorage } from "@oh-my-pi/pi-ai";
import { type AuthGatewayRouteOptions, exemptCommittedSpend } from "@oh-my-pi/pi-ai/auth-gateway";
import { isAccountEvidenceLimit } from "@oh-my-pi/pi-ai/usage/limits";
import { isEnoent, openSqliteDatabase } from "@oh-my-pi/pi-utils";
import { createAccountLimitSource } from "../session/local-limits";
import { recordUsageEntry, UsageLedger, usageEntryOf } from "../session/usage-ledger";

/** Account limits a gateway enforces against its own usage ledger. */
export interface GatewayAccountLimits {
	/** Records each served call in the ledger under its account. */
	onUsage: NonNullable<AuthGatewayRouteOptions["onUsage"]>;
	/** Waits for the ledger writes recorded so far, then releases the ledger. */
	close(): Promise<void>;
}

/** A usage ledger a gateway records its calls in. */
export interface GatewayLedger {
	ledger: UsageLedger;
	/** Releases the ledger after its last write; a no-op for a ledger another owner closes. */
	close(): void;
}

/**
 * Enforce the account-policy limits that count calls (`usd`, `requests`, `tokens`) on `storage`
 * against the usage ledger `openLedger` provides, and return the hook that records the gateway's
 * calls there; undefined, without opening the ledger, when no policy has such a limit. A failed
 * ledger write is logged and never fails the request it records.
 */
export async function installGatewayAccountLimits(
	storage: AuthStorage,
	accountPolicies: AuthAccountPolicies,
	openLedger: () => Promise<GatewayLedger>,
): Promise<GatewayAccountLimits | undefined> {
	if (!accountPolicies.some(policy => policy.limits?.some(limit => !isAccountEvidenceLimit(limit)) === true)) {
		return undefined;
	}
	const opened = await openLedger();
	const { ledger } = opened;
	storage.usage.setLimitSource(exemptCommittedSpend(createAccountLimitSource(() => ledger)));
	const pendingWrites = new Set<Promise<void>>();
	return {
		onUsage(model, usage, account) {
			const entry = usageEntryOf(
				{ provider: model.provider, model: model.id, usage },
				Date.now(),
				account === undefined ? {} : { account },
			);
			if (!entry) return;
			// The gateway logs a failed write; the pending set only waits for it.
			const write = recordUsageEntry(ledger, entry);
			const settled = write.then(
				() => {},
				() => {},
			);
			pendingWrites.add(settled);
			void settled.finally(() => pendingWrites.delete(settled));
			return write;
		},
		async close() {
			await Promise.all(pendingWrites);
			opened.close();
		},
	};
}

/** The usage ledger in `dbPath`, opened by {@link openGatewayLedgerDatabase} and closed with its database. */
export async function openGatewayLedger(dbPath: string): Promise<GatewayLedger> {
	const db = await openGatewayLedgerDatabase(dbPath);
	let ledger: UsageLedger;
	try {
		ledger = new UsageLedger(db);
	} catch (error) {
		db.close();
		throw error;
	}
	return {
		ledger,
		close() {
			ledger.close();
			db.close();
		},
	};
}

/**
 * Open `dbPath` (the agent's `agent.db`) for the usage ledger alone, creating it owner-only in an
 * owner-only directory when missing. Corruption recovery stays off: a gateway never quarantines or
 * replaces the database other processes share, so a corrupt one fails the open instead.
 */
export async function openGatewayLedgerDatabase(dbPath: string): Promise<Database> {
	await fs.mkdir(path.dirname(dbPath), { recursive: true, mode: 0o700 });
	// Created owner-only before SQLite opens it, so the WAL and shared-memory files it adds inherit the mode.
	let created = false;
	try {
		await (await fs.open(dbPath, "wx", 0o600)).close();
		created = true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	const db = await openSqliteDatabase(dbPath, db => {
		db.run("PRAGMA journal_mode=WAL");
		return db;
	});
	if (created && process.platform !== "win32") {
		for (const sidecar of [`${dbPath}-wal`, `${dbPath}-shm`]) {
			try {
				await fs.chmod(sidecar, 0o600);
			} catch (error) {
				if (!isEnoent(error)) {
					db.close();
					throw error;
				}
			}
		}
	}
	return db;
}
