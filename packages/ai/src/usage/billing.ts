/**
 * Provider billing evidence derived from usage reports.
 *
 * A billing reader turns one {@link UsageReport} into the funding sources an
 * account can draw on (subscription allowance, paid extra usage, prepaid
 * credits, metered spend) without any network access of its own. Readers use
 * the normalized `limits` and `metadata` of a report, which survive the auth
 * broker wire, and never treat missing evidence as free.
 */
import type { Provider } from "../types";
import type { UsageLimit, UsageReport } from "../usage";

/** How a funding source is paid for. */
export type BillingMode =
	| "subscription-included"
	| "paid-extra-usage"
	| "metered"
	| "prepaid-credits"
	| "free"
	| "unknown";

/**
 * Whether a funding source can pay for requests right now.
 *
 * `unknown` means the report carries no verdict for the source. A subscription
 * source reads `exhausted` only when an account-wide quota window is spent;
 * model-scoped windows stay with the usage ranking strategy.
 */
export type BillingSourceState = "available" | "exhausted" | "disabled" | "unknown";

/**
 * An exact amount of money: an integer count of the currency's minor unit.
 *
 * The minor unit is the ISO 4217 exponent of `currency` (2 for USD, 0 for JPY,
 * 3 for BHD); {@link currencyMinorUnitExponent} resolves it.
 */
export interface Money {
	/** Safe integer count of minor units; negative only for debts. */
	readonly amountMinor: number;
	/** Upper-case ISO 4217 currency code. */
	readonly currency: string;
}

/**
 * An exact non-monetary decimal quantity (provider credits): `amountMinor * 10^-exponent`.
 *
 * Credits are provider-specific units and never convert to {@link Money}.
 */
export interface DecimalQuantity {
	/** Safe integer coefficient. */
	readonly amountMinor: number;
	/** Non-negative count of decimal places in `amountMinor`. */
	readonly exponent: number;
}

/** Rounding applied when a value has more decimal places than the target scale. */
export type DecimalRounding = "floor" | "ceil" | "half-even";

/**
 * Remaining and consumed allowance of one funding source; absent fields were
 * not reported. `uncapped: true` means the provider reported that no cap
 * exists, so an absent `limit` and `remaining` are not missing evidence.
 */
export type BillingAllowance =
	| { kind: "money"; used?: Money; limit?: Money; remaining?: Money; uncapped?: true }
	| {
			kind: "credits";
			used?: DecimalQuantity;
			limit?: DecimalQuantity;
			remaining?: DecimalQuantity;
			uncapped?: true;
	  };

/** One way an account pays for requests. */
export interface BillingSource {
	mode: BillingMode;
	state: BillingSourceState;
	allowance?: BillingAllowance;
	/** Epoch ms the allowance resets, when reported. */
	resetsAt?: number;
}

/** Billing evidence of one account at the time its usage report was fetched. */
export interface BillingSnapshot {
	provider: Provider;
	/** Epoch ms the underlying usage report was fetched. */
	fetchedAt: number;
	/** Funding sources in the order the provider draws on them. */
	sources: BillingSource[];
}

/**
 * Why billing evidence is unavailable.
 *
 * - `no-reader`: no billing reader is registered for the provider.
 * - `no-report`: no usage report exists for the account.
 * - `no-evidence`: the report carries no billing fields.
 * - `malformed`: the report contradicts itself or belongs to another provider.
 * - `stale`: the evidence is older than the caller's freshness bound.
 */
export type BillingUnknownReason = "no-reader" | "no-report" | "no-evidence" | "malformed" | "stale";

/** Billing evidence, or a typed reason it is unavailable. Consumers must never read `unknown` as free. */
export type BillingResult =
	| { status: "known"; snapshot: BillingSnapshot }
	| {
			status: "unknown";
			provider: Provider;
			reason: BillingUnknownReason;
			/** Fetch time of the report behind this verdict, when one existed. */
			fetchedAt?: number;
	  };

/** Reads billing evidence for one provider from its usage reports. */
export interface ProviderBilling {
	id: Provider;
	/** Derive billing evidence from a report of this provider; performs no I/O. */
	readBilling(report: UsageReport): BillingResult;
}

// ─── Money ──────────────────────────────────────────────────────────────────

const exponentCache = new Map<string, number>();
let knownCurrencies: ReadonlySet<string> | undefined;

/** ISO 4217 minor-unit exponent of `currency`, or `undefined` when the runtime does not know the code. */
export function currencyMinorUnitExponent(currency: string): number | undefined {
	const code = currency.toUpperCase();
	const cached = exponentCache.get(code);
	if (cached !== undefined) return cached;
	// Intl formats any well-formed code, defaulting unknown ones to two places.
	knownCurrencies ??= new Set(Intl.supportedValuesOf("currency"));
	if (!knownCurrencies.has(code)) return undefined;
	const exponent = new Intl.NumberFormat("en", { style: "currency", currency: code }).resolvedOptions()
		.maximumFractionDigits;
	if (exponent === undefined) return undefined;
	exponentCache.set(code, exponent);
	return exponent;
}

const DECIMAL_PATTERN = /^([+-])?(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i;
const MAX_SCALE_SHIFT = 40;
/** Longest decimal string and largest written exponent accepted, bounding BigInt work. */
const MAX_DECIMAL_LENGTH = 64;

function pow10(n: number): bigint {
	return 10n ** BigInt(n);
}

function divideRounded(numerator: bigint, divisor: bigint, rounding: DecimalRounding): bigint {
	const quotient = numerator / divisor;
	const remainder = numerator % divisor;
	if (remainder === 0n) return quotient;
	const negative = numerator < 0n;
	// BigInt division truncates toward zero.
	const floor = negative ? quotient - 1n : quotient;
	if (rounding === "floor") return floor;
	if (rounding === "ceil") return floor + 1n;
	const twiceRemainder = (negative ? remainder + divisor : remainder) * 2n;
	if (twiceRemainder < divisor) return floor;
	if (twiceRemainder > divisor) return floor + 1n;
	return floor % 2n === 0n ? floor : floor + 1n;
}

function toSafeNumber(value: bigint): number | undefined {
	if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) return undefined;
	return Number(value);
}

/**
 * Scale a decimal to an integer count of `10^-exponent` units without
 * binary floating-point arithmetic.
 *
 * Numbers are read through their shortest round-trip decimal string, so a
 * float that came from `minor / 10^k` with at most 15 significant digits
 * recovers `minor` exactly. Returns `undefined` for non-finite or malformed
 * input and for results outside the safe integer range.
 */
export function scaleDecimal(value: number | string, exponent: number, rounding: DecimalRounding): number | undefined {
	if (!Number.isSafeInteger(exponent) || exponent < 0 || exponent > MAX_SCALE_SHIFT) return undefined;
	if (typeof value === "number" && !Number.isFinite(value)) return undefined;
	const text = typeof value === "number" ? String(value) : value.trim();
	if (text.length > MAX_DECIMAL_LENGTH) return undefined;
	const match = DECIMAL_PATTERN.exec(text);
	if (!match) return undefined;
	const [, sign, integerDigits, fractionDigits = "", exponentDigits] = match;
	const decimalExponent = exponentDigits === undefined ? 0 : Number(exponentDigits);
	if (Math.abs(decimalExponent) > MAX_DECIMAL_LENGTH) return undefined;
	let coefficient = BigInt(integerDigits + fractionDigits);
	if (sign === "-") coefficient = -coefficient;
	const shift = exponent + decimalExponent - fractionDigits.length;
	const scaled = shift >= 0 ? coefficient * pow10(shift) : divideRounded(coefficient, pow10(-shift), rounding);
	return toSafeNumber(scaled);
}

/** Money from a decimal amount in major units, rounded to the currency's minor unit. */
export function moneyFromDecimal(
	value: number | string,
	currency: string,
	rounding: DecimalRounding,
): Money | undefined {
	const exponent = currencyMinorUnitExponent(currency);
	if (exponent === undefined) return undefined;
	const amountMinor = scaleDecimal(value, exponent, rounding);
	return amountMinor === undefined ? undefined : { amountMinor, currency: currency.toUpperCase() };
}

/**
 * Money from an integer amount expressed at `exponent` decimal places
 * (e.g. `{ amount_minor: 1999, exponent: 2 }`), rescaled to the currency's
 * minor unit with `rounding` when the exponents differ.
 */
export function moneyFromMinor(
	amountMinor: number,
	exponent: number,
	currency: string,
	rounding: DecimalRounding,
): Money | undefined {
	if (!Number.isSafeInteger(amountMinor) || !Number.isSafeInteger(exponent) || exponent < 0) return undefined;
	const target = currencyMinorUnitExponent(currency);
	if (target === undefined) return undefined;
	const shift = target - exponent;
	if (Math.abs(shift) > MAX_SCALE_SHIFT) return undefined;
	const value = BigInt(amountMinor);
	const scaled =
		shift >= 0 ? toSafeNumber(value * pow10(shift)) : toSafeNumber(divideRounded(value, pow10(-shift), rounding));
	return scaled === undefined ? undefined : { amountMinor: scaled, currency: currency.toUpperCase() };
}

/** Sum of two amounts; `undefined` when currencies differ or the sum leaves the safe integer range. */
export function addMoney(a: Money, b: Money): Money | undefined {
	if (a.currency !== b.currency) return undefined;
	const sum = a.amountMinor + b.amountMinor;
	return Number.isSafeInteger(sum) ? { amountMinor: sum, currency: a.currency } : undefined;
}

/** `a - b`; `undefined` when currencies differ or the difference leaves the safe integer range. */
export function subtractMoney(a: Money, b: Money): Money | undefined {
	if (a.currency !== b.currency) return undefined;
	const difference = a.amountMinor - b.amountMinor;
	return Number.isSafeInteger(difference) ? { amountMinor: difference, currency: a.currency } : undefined;
}

/** Sign of `a - b`; `undefined` when currencies differ. */
export function compareMoney(a: Money, b: Money): -1 | 0 | 1 | undefined {
	if (a.currency !== b.currency) return undefined;
	return a.amountMinor < b.amountMinor ? -1 : a.amountMinor > b.amountMinor ? 1 : 0;
}

const MAX_CREDIT_EXPONENT = 9;

/**
 * Exact credit quantity at the fewest decimal places that represent `value`,
 * capped at nine; finer digits round with `rounding`.
 */
export function creditsFromDecimal(value: number | string, rounding: DecimalRounding): DecimalQuantity | undefined {
	const full = scaleDecimal(value, MAX_CREDIT_EXPONENT, rounding);
	if (full === undefined) return undefined;
	let amountMinor = full;
	let exponent = MAX_CREDIT_EXPONENT;
	while (exponent > 0 && amountMinor % 10 === 0) {
		amountMinor /= 10;
		exponent--;
	}
	return { amountMinor, exponent };
}

/** Sign of a quantity: -1, 0, or 1. */
export function quantitySign(value: Money | DecimalQuantity): -1 | 0 | 1 {
	return value.amountMinor < 0 ? -1 : value.amountMinor > 0 ? 1 : 0;
}

// ─── Freshness ──────────────────────────────────────────────────────────────

/** Largest future `fetchedAt` offset tolerated as clock skew between broker and client, in milliseconds. */
export const MAX_BILLING_CLOCK_SKEW_MS = 5 * 60 * 1000;

/**
 * Age of evidence fetched at `fetchedAt`, in milliseconds.
 *
 * A `fetchedAt` up to {@link MAX_BILLING_CLOCK_SKEW_MS} in the future counts
 * as age 0; one further ahead, or a non-finite one, counts as infinitely old.
 */
export function billingEvidenceAgeMs(fetchedAt: number, now: number): number {
	if (!Number.isFinite(fetchedAt) || !Number.isFinite(now)) return Number.POSITIVE_INFINITY;
	if (fetchedAt - now > MAX_BILLING_CLOCK_SKEW_MS) return Number.POSITIVE_INFINITY;
	return Math.max(0, now - fetchedAt);
}

/**
 * Enforce a freshness bound on billing evidence.
 *
 * A known result older than `maxAgeMs` becomes `unknown` with reason `stale`
 * and keeps its `fetchedAt`; everything else is returned unchanged. The bound
 * is the caller's policy, so there is no default.
 *
 * @throws RangeError when `maxAgeMs` is negative or not finite.
 */
export function requireFreshBilling(result: BillingResult, now: number, maxAgeMs: number): BillingResult {
	if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) {
		throw new RangeError(`billing maxAgeMs must be a finite non-negative number, got ${maxAgeMs}`);
	}
	if (result.status !== "known") return result;
	const { snapshot } = result;
	if (billingEvidenceAgeMs(snapshot.fetchedAt, now) <= maxAgeMs) return result;
	return { status: "unknown", provider: snapshot.provider, reason: "stale", fetchedAt: snapshot.fetchedAt };
}

// ─── Registry ───────────────────────────────────────────────────────────────

/** Billing readers keyed by provider; one reader per provider. */
export class ProviderBillingRegistry {
	#readers = new Map<Provider, ProviderBilling>();

	constructor(readers: Iterable<ProviderBilling> = []) {
		for (const reader of readers) this.register(reader);
	}

	/**
	 * Add a reader and return a function that removes it again.
	 *
	 * @throws Error when a reader for the same provider is already registered,
	 * so one registration can never silently shadow another.
	 */
	register(reader: ProviderBilling): () => void {
		if (this.#readers.has(reader.id)) {
			throw new Error(`billing reader already registered for provider ${reader.id}`);
		}
		this.#readers.set(reader.id, reader);
		return () => {
			if (this.#readers.get(reader.id) === reader) this.#readers.delete(reader.id);
		};
	}

	get(provider: Provider): ProviderBilling | undefined {
		return this.#readers.get(provider);
	}

	/**
	 * Billing evidence for `provider` from its latest usage report, without a
	 * freshness check; use {@link readFresh} before acting on the result.
	 *
	 * Returns `no-reader` without a registered reader, `no-report` for a null
	 * report, and `malformed` when the report belongs to another provider or the
	 * reader throws.
	 */
	read(provider: Provider, report: UsageReport | null | undefined): BillingResult {
		const reader = this.#readers.get(provider);
		if (!reader) return { status: "unknown", provider, reason: "no-reader", ...fetchedAtOf(report) };
		if (!report) return { status: "unknown", provider, reason: "no-report" };
		if (report.provider !== provider) {
			return { status: "unknown", provider, reason: "malformed", ...fetchedAtOf(report) };
		}
		try {
			return reader.readBilling(report);
		} catch {
			return { status: "unknown", provider, reason: "malformed", ...fetchedAtOf(report) };
		}
	}

	/**
	 * {@link read} followed by {@link requireFreshBilling}: known evidence older
	 * than `maxAgeMs` becomes `unknown` with reason `stale`.
	 *
	 * @throws RangeError when `maxAgeMs` is negative or not finite.
	 */
	readFresh(provider: Provider, report: UsageReport | null | undefined, now: number, maxAgeMs: number): BillingResult {
		return requireFreshBilling(this.read(provider, report), now, maxAgeMs);
	}
}

function fetchedAtOf(report: UsageReport | null | undefined): { fetchedAt?: number } {
	return report && Number.isFinite(report.fetchedAt) ? { fetchedAt: report.fetchedAt } : {};
}

// ─── Reader helpers ─────────────────────────────────────────────────────────

/** Known billing result for `report` with the given sources. */
export function knownBilling(report: UsageReport, sources: BillingSource[]): BillingResult {
	return { status: "known", snapshot: { provider: report.provider, fetchedAt: report.fetchedAt, sources } };
}

/** Unknown billing result for `report`, keeping its fetch time. */
export function unknownBilling(report: UsageReport, reason: BillingUnknownReason): BillingResult {
	return { status: "unknown", provider: report.provider, reason, ...fetchedAtOf(report) };
}

/** Options for allowances built from a normalized limit. */
export interface LimitAllowanceOptions {
	/** The provider reported that this source has no cap; set only on that evidence. */
	uncapped?: boolean;
	/**
	 * Compute `remaining` as `limit - used` in integer minor units even when the
	 * limit reports one, for limits whose `remaining` is a float difference.
	 */
	remainingFromUsed?: boolean;
}

/**
 * Money allowance from a normalized `usd` limit.
 *
 * Rounds conservatively: `used` up, `limit` and `remaining` down. The
 * reported `remaining` wins unless it is absent or `remainingFromUsed` is
 * set; then, with both `used` and `limit`, it is `limit - used` in integer
 * minor units, floored at zero.
 */
export function moneyAllowanceFromUsdLimit(
	limit: UsageLimit,
	options: LimitAllowanceOptions = {},
): BillingAllowance | undefined {
	if (limit.amount.unit !== "usd") return undefined;
	const used = decimalField(limit.amount.used, value => moneyFromDecimal(value, "USD", "ceil"));
	const cap = decimalField(limit.amount.limit, value => moneyFromDecimal(value, "USD", "floor"));
	const reported = decimalField(limit.amount.remaining, value => moneyFromDecimal(value, "USD", "floor"));
	if (used === null || cap === null || reported === null) return undefined;
	const derive = used && cap && (reported === undefined || options.remainingFromUsed === true);
	const remaining = derive ? clampedDifference(cap.amountMinor, used.amountMinor) : reported?.amountMinor;
	return buildAllowance(
		"money",
		used,
		cap,
		remaining === undefined ? undefined : { amountMinor: remaining, currency: "USD" },
		options,
	);
}

/**
 * Credit allowance from a normalized `credits` limit; rounding and the
 * `remaining` derivation match {@link moneyAllowanceFromUsdLimit}.
 */
export function creditAllowanceFromLimit(
	limit: UsageLimit,
	options: LimitAllowanceOptions = {},
): BillingAllowance | undefined {
	if (limit.amount.unit !== "credits") return undefined;
	const used = decimalField(limit.amount.used, value => creditsFromDecimal(value, "ceil"));
	const cap = decimalField(limit.amount.limit, value => creditsFromDecimal(value, "floor"));
	const reported = decimalField(limit.amount.remaining, value => creditsFromDecimal(value, "floor"));
	if (used === null || cap === null || reported === null) return undefined;
	let remaining = reported;
	if (used && cap && (reported === undefined || options.remainingFromUsed === true)) {
		const exponent = Math.max(used.exponent, cap.exponent);
		const difference = clampedDifference(
			cap.amountMinor * 10 ** (exponent - cap.exponent),
			used.amountMinor * 10 ** (exponent - used.exponent),
		);
		remaining = difference === undefined ? undefined : { amountMinor: difference, exponent };
	}
	return buildAllowance("credits", used, cap, remaining, options);
}

/** `cap - used` floored at zero; `undefined` outside the safe integer range. */
function clampedDifference(cap: number, used: number): number | undefined {
	const difference = cap - used;
	if (!Number.isSafeInteger(cap) || !Number.isSafeInteger(used) || !Number.isSafeInteger(difference)) {
		return undefined;
	}
	return Math.max(0, difference);
}

function buildAllowance<K extends BillingAllowance["kind"], T extends Money | DecimalQuantity>(
	kind: K,
	used: T | undefined,
	cap: T | undefined,
	remaining: T | undefined,
	options: LimitAllowanceOptions,
): BillingAllowance | undefined {
	const uncapped = options.uncapped === true && !cap;
	if (!used && !cap && !remaining && !uncapped) return undefined;
	return {
		kind,
		...(used ? { used } : {}),
		...(cap ? { limit: cap } : {}),
		...(remaining ? { remaining } : {}),
		...(uncapped ? { uncapped: true } : {}),
	} as BillingAllowance;
}

/** `undefined` for an absent field, `null` for a present but unparseable one. */
function decimalField<T>(value: number | undefined, parse: (value: number) => T | undefined): T | undefined | null {
	if (value === undefined) return undefined;
	return parse(value) ?? null;
}

/**
 * Funding state of a limit-backed source.
 *
 * `exhausted` when the limit says so or nothing remains; `available` when
 * something remains, the source is uncapped, or the limit reports `ok` or
 * `warning`; otherwise `unknown`.
 */
export function sourceStateFromLimit(limit: UsageLimit, allowance: BillingAllowance | undefined): BillingSourceState {
	if (limit.status === "exhausted") return "exhausted";
	const remaining = allowance?.remaining;
	if (remaining) return quantitySign(remaining) <= 0 ? "exhausted" : "available";
	if (allowance?.uncapped) return "available";
	if (limit.status === "ok" || limit.status === "warning") return "available";
	return "unknown";
}

/** Limit-backed source, or `undefined` when the limit carries no parseable allowance. */
export function sourceFromLimit(
	mode: BillingMode,
	limit: UsageLimit,
	options: LimitAllowanceOptions = {},
): BillingSource | undefined {
	const allowance = moneyAllowanceFromUsdLimit(limit, options) ?? creditAllowanceFromLimit(limit, options);
	if (!allowance) return undefined;
	return {
		mode,
		state: sourceStateFromLimit(limit, allowance),
		allowance,
		// A custom reset label marks an incremental regeneration tick, not a full reset.
		...(limit.window?.resetsAt !== undefined && limit.window.resetLabel === undefined
			? { resetsAt: limit.window.resetsAt }
			: {}),
	};
}

/** Whether a limit meters the whole account rather than one model. */
export function isAccountWideLimit(limit: UsageLimit): boolean {
	return limit.scope.modelId === undefined;
}

/**
 * Funding state of a subscription bounded by concurrent quota windows.
 *
 * `exhausted` when any window is exhausted, since every window must have room
 * for a request; `available` when every window reports `ok` or `warning`;
 * otherwise, including for no windows, `unknown`.
 */
export function subscriptionStateFromLimits(limits: readonly UsageLimit[]): BillingSourceState {
	if (limits.some(limit => limit.status === "exhausted")) return "exhausted";
	if (limits.length > 0 && limits.every(limit => limit.status === "ok" || limit.status === "warning")) {
		return "available";
	}
	return "unknown";
}

/** Account-wide limits of `report`; the default plan-window selection of {@link subscriptionQuotaBilling}. */
export function accountWideLimits(report: UsageReport): UsageLimit[] {
	return report.limits.filter(isAccountWideLimit);
}

/**
 * Billing reader for a subscription whose reports carry quota windows but no
 * money or credit amounts: one `subscription-included` source without an
 * allowance, whose state comes from the plan windows `selectLimits` returns.
 * A report without plan windows yields `no-evidence`. Paid fallbacks the
 * report does not mention are left out rather than reported as absent.
 */
export function subscriptionQuotaBilling(
	id: Provider,
	selectLimits: (report: UsageReport) => readonly UsageLimit[] = accountWideLimits,
): ProviderBilling {
	return {
		id,
		readBilling(report) {
			const limits = selectLimits(report);
			if (limits.length === 0) return unknownBilling(report, "no-evidence");
			return knownBilling(report, [{ mode: "subscription-included", state: subscriptionStateFromLimits(limits) }]);
		},
	};
}

/** Billing reader for a provider whose usage reports carry no billing evidence; always `no-evidence`. */
export function noEvidenceBilling(id: Provider): ProviderBilling {
	return { id, readBilling: report => unknownBilling(report, "no-evidence") };
}
