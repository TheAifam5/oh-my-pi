/**
 * Shared fetch path for providers that expose one account balance endpoint
 * read with the inference API key.
 *
 * Billing endpoints live at documented absolute URLs that do not follow the
 * inference base URL, so a credential configured for any other host is never
 * sent there: the request is skipped and no report is produced. Without an
 * explicit base URL or override, the inference base is the catalog default,
 * whose host is the endpoint's `inferenceHost`.
 */
import { DEFAULT_USAGE_REQUEST_TIMEOUT_MS } from "../auth/usage-cache";
import { ProviderHttpError } from "../error";
import type { Provider } from "../types";
import type { UsageFetchContext, UsageFetchParams, UsageLimit, UsageProvider, UsageReport } from "../usage";
import { isRecord } from "../utils";
import { type BillingSource, knownBilling, type ProviderBilling, sourceFromLimit, unknownBilling } from "./billing";

/** A documented balance endpoint and the inference host whose keys it accepts. */
export interface AccountBalanceEndpoint {
	provider: Provider;
	/** Display name used in log messages. */
	name: string;
	/** Absolute documented URL of the balance endpoint. */
	url: string;
	/** Host of the provider's catalog default inference base URL. */
	inferenceHost: string;
	/** Inference base URL that overrides the configured one at request time (an environment variable). */
	baseUrlOverride?: () => string | undefined;
	/**
	 * The provider documents that this endpoint takes the inference API key, so
	 * a 401 means the key itself was rejected. Otherwise a 401 may only reflect
	 * a narrower billing scope: it is transient, and health checks skip the endpoint.
	 */
	acceptsInferenceKey: boolean;
	method?: "GET" | "POST";
	/** Request headers carrying the key; defaults to a Bearer `Authorization` header. */
	authHeaders?: (apiKey: string) => Record<string, string>;
	/** Maps a JSON object body to limits and metadata; `undefined` rejects the body as malformed. */
	parse(payload: Record<string, unknown>): Pick<UsageReport, "limits" | "metadata"> | undefined;
}

const DECIMAL_STRING = /^-?(\d+)(?:\.(\d+))?$/;
/** Most significant digits a double carries exactly. */
const MAX_SIGNIFICANT_DIGITS = 15;

/**
 * A plain decimal string as sent by the provider with at most 15 significant
 * digits, so `Number()` of it round-trips exactly; `undefined` for anything else.
 */
export function decimalString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const match = DECIMAL_STRING.exec(value);
	if (!match) return undefined;
	const digits = `${match[1]}${match[2] ?? ""}`.replace(/^0+/, "").replace(/0+$/, "");
	return digits.length <= MAX_SIGNIFICANT_DIGITS ? value : undefined;
}

/** A finite number, or `undefined`. */
export function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Account-wide balance limit: windowless and shared, because every key of the
 * account reports the same pool. Negative balances (debts) read as nothing remaining.
 */
export function balanceLimit(
	provider: Provider,
	id: string,
	label: string,
	remaining: number,
	unit: "usd" | "credits" | "unknown",
	options: { limit?: number; exhausted?: boolean; currency?: string } = {},
): UsageLimit {
	const cap = options.limit !== undefined && options.limit >= 0 ? options.limit : undefined;
	const clamped = Math.max(0, cap === undefined ? remaining : Math.min(cap, remaining));
	return {
		id,
		label,
		scope: { provider, windowId: "balance", shared: true },
		amount: {
			...(cap !== undefined ? { limit: cap } : {}),
			remaining: clamped,
			unit,
			...(options.currency ? { currency: options.currency } : {}),
		},
		...(options.exhausted ? { status: "exhausted" } : {}),
	};
}

/** Every inference base URL a request for this credential may use is on the endpoint's inference host. */
function onInferenceHost(endpoint: AccountBalanceEndpoint, params: UsageFetchParams): boolean {
	const configured = [params.baseUrl, endpoint.baseUrlOverride?.()]
		.map(value => value?.trim())
		.filter((value): value is string => !!value);
	return configured.every(baseUrl => sameHost(baseUrl, endpoint.inferenceHost));
}

function sameHost(baseUrl: string, host: string): boolean {
	try {
		return new URL(baseUrl).host === host;
	} catch {
		return false;
	}
}

async function fetchAccountBalance(
	endpoint: AccountBalanceEndpoint,
	params: UsageFetchParams,
	ctx: UsageFetchContext,
): Promise<UsageReport | null> {
	if (params.provider !== endpoint.provider) return null;
	const credential = params.credential;
	if (credential.type !== "api_key" || !credential.apiKey) return null;
	if (!onInferenceHost(endpoint, params)) return null;

	const url = new URL(endpoint.url);
	const where = `${url.host}${url.pathname}`;
	let payload: unknown;
	try {
		const response = await ctx.fetch(url.href, {
			method: endpoint.method ?? "GET",
			headers: {
				...(endpoint.authHeaders?.(credential.apiKey) ?? { Authorization: `Bearer ${credential.apiKey}` }),
				Accept: "application/json",
			},
			// A redirect could carry the key to another host.
			redirect: "error",
			signal: AbortSignal.any([
				AbortSignal.timeout(DEFAULT_USAGE_REQUEST_TIMEOUT_MS),
				...(params.signal ? [params.signal] : []),
			]),
		});
		if (!response.ok) {
			// 403 may be a plan restriction on the billing endpoint, not a revoked key.
			if (response.status === 401 && endpoint.acceptsInferenceKey) {
				throw new ProviderHttpError(`${endpoint.name} ${where} returned 401`, 401);
			}
			ctx.logger?.warn(`${endpoint.name} usage fetch failed`, { endpoint: where, status: response.status });
			return null;
		}
		payload = await response.json();
	} catch (error) {
		if (error instanceof ProviderHttpError) throw error;
		ctx.logger?.warn(`${endpoint.name} usage request failed`, {
			endpoint: where,
			error: error instanceof Error ? error.name : "unknown",
		});
		return null;
	}
	const parsed = isRecord(payload) ? endpoint.parse(payload) : undefined;
	if (!parsed) return null;
	return { provider: endpoint.provider, fetchedAt: Date.now(), ...parsed };
}

/** Usage provider reading one documented account balance endpoint. */
export function accountBalanceUsageProvider(endpoint: AccountBalanceEndpoint): UsageProvider {
	return {
		id: endpoint.provider,
		fetchUsage: (params, ctx) => fetchAccountBalance(endpoint, params, ctx),
		supports: params => params.provider === endpoint.provider && params.credential.type === "api_key",
		validatesCredentials: endpoint.acceptsInferenceKey,
	};
}

/**
 * Billing reader turning the listed balance limits, in report order (the
 * provider's draw order), into prepaid-credit sources. A report with none of
 * them is no evidence; one whose listed limit carries no parseable amount is malformed.
 */
export function prepaidBalanceBilling(provider: Provider, limitIds: readonly string[]): ProviderBilling {
	const ids = new Set(limitIds);
	return {
		id: provider,
		readBilling(report) {
			const sources: BillingSource[] = [];
			for (const limit of report.limits) {
				if (!ids.has(limit.id)) continue;
				const source = sourceFromLimit("prepaid-credits", limit);
				if (!source) return unknownBilling(report, "malformed");
				sources.push(source);
			}
			return sources.length > 0 ? knownBilling(report, sources) : unknownBilling(report, "no-evidence");
		},
	};
}
