import { logger } from "@oh-my-pi/pi-utils";
import type { BillingMode, BillingSnapshot, BillingSource } from "../usage/billing";
import type { DrainSpendClass } from "./types";

const DRAIN_STATE_CACHE_PREFIX = "drain:state:";
/** Prefix for persisted session drain overrides. */
export const SESSION_DRAIN_CACHE_PREFIX = "session:drain:";
/** Shortest lifetime of a persisted drain state row past its last write. */
const DRAIN_STATE_MIN_TTL_MS = 24 * 60 * 60_000;

/** Billing modes each non-plan spend class pays with. */
export const SPEND_CLASS_MODES: Record<Exclude<DrainSpendClass, "plan">, readonly BillingMode[]> = {
	credits: ["prepaid-credits"],
	money: ["paid-extra-usage", "metered"],
};

const BASELINE_MODES: ReadonlySet<string> = new Set(Object.values(SPEND_CLASS_MODES).flat());
const SOURCE_STATES: ReadonlySet<string> = new Set(["available", "exhausted", "disabled", "unknown"]);

/** Drain state of one target and block scope: when it drained and its billing evidence then. */
export type DrainedState = { since: number; baseline?: BillingSnapshot };

/** Cache key of the drain state of `credentialId` under `blockScope` and one spend/return funding. */
export function drainStateKey(
	provider: string,
	credentialId: number,
	blockScope: string | undefined,
	funding: string,
): string {
	return `${DRAIN_STATE_CACHE_PREFIX}${provider}:${credentialId}:${blockScope ?? ""}:${funding}`;
}

/** Lifetime of a drain state row past its last write: the longer of a day and two return cooldowns. */
export function drainStateTtlMs(cooldownMs: number): number {
	return Math.max(DRAIN_STATE_MIN_TTL_MS, 2 * cooldownMs);
}

/** Expiry (epoch seconds) of a drain state row written at `nowMs`. */
export function drainStateExpiresAtSec(nowMs: number, cooldownMs: number): number {
	return Math.floor((nowMs + drainStateTtlMs(cooldownMs)) / 1000);
}

/** JSON row of `state`; the baseline keeps only the credit and money sources the return triggers compare. */
export function serializeDrainedState(state: DrainedState): string {
	const { baseline } = state;
	return JSON.stringify({
		since: state.since,
		...(baseline
			? {
					baseline: {
						provider: baseline.provider,
						fetchedAt: baseline.fetchedAt,
						sources: baseline.sources.filter(source => BASELINE_MODES.has(source.mode)),
					},
				}
			: {}),
	});
}

/** The drain state in a persisted row; a malformed row reads as absent. */
export function parseDrainedState(raw: string): DrainedState | undefined {
	try {
		const value = JSON.parse(raw) as { since?: unknown; baseline?: unknown };
		if (typeof value.since !== "number" || !Number.isFinite(value.since)) throw new Error("since is not a number");
		if (value.baseline === undefined) return { since: value.since };
		const baseline = parseBaseline(value.baseline);
		if (!baseline) throw new Error("baseline is malformed");
		return { since: value.since, baseline };
	} catch (err) {
		logger.debug("Ignoring malformed drain state in persistent store cache", { err });
		return undefined;
	}
}

function parseBaseline(value: unknown): BillingSnapshot | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const { provider, fetchedAt, sources } = value as Record<string, unknown>;
	if (typeof provider !== "string" || typeof fetchedAt !== "number" || !Array.isArray(sources)) return undefined;
	if (!sources.every(isBaselineSource)) return undefined;
	return { provider, fetchedAt, sources };
}

function isBaselineSource(value: unknown): value is BillingSource {
	if (typeof value !== "object" || value === null) return false;
	const { mode, state, allowance } = value as Record<string, unknown>;
	if (typeof mode !== "string" || !BASELINE_MODES.has(mode)) return false;
	if (typeof state !== "string" || !SOURCE_STATES.has(state)) return false;
	if (allowance === undefined) return true;
	if (typeof allowance !== "object" || allowance === null) return false;
	const { kind, used, limit, remaining } = allowance as Record<string, unknown>;
	if (kind !== "money" && kind !== "credits") return false;
	return [used, limit, remaining].every(
		quantity => quantity === undefined || isQuantity(quantity, kind === "money" ? "currency" : "exponent"),
	);
}

function isQuantity(value: unknown, unit: "currency" | "exponent"): boolean {
	if (typeof value !== "object" || value === null) return false;
	const quantity = value as Record<string, unknown>;
	if (!Number.isSafeInteger(quantity.amountMinor)) return false;
	return unit === "currency" ? typeof quantity.currency === "string" : Number.isSafeInteger(quantity.exponent);
}

/** Cache key of a session's drain override for `provider`. */
export function sessionDrainKey(provider: string, sessionId: string): string {
	return `${SESSION_DRAIN_CACHE_PREFIX}${provider}:${sessionId}`;
}

/** JSON row of a session drain override: a row id, or `null` for no drain target. */
export function serializeSessionDrain(credentialId: number | null): string {
	return JSON.stringify({ credentialId });
}

/** The override in a persisted session drain row; a malformed row reads as absent. */
export function parseSessionDrain(raw: string): number | null | undefined {
	try {
		const { credentialId } = JSON.parse(raw) as { credentialId?: unknown };
		if (credentialId === null || (typeof credentialId === "number" && Number.isSafeInteger(credentialId))) {
			return credentialId;
		}
		throw new Error("credentialId is not a row id or null");
	} catch (err) {
		logger.debug("Ignoring malformed session drain override in persistent store cache", { err });
		return undefined;
	}
}
