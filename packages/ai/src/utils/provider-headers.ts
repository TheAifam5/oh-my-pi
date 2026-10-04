import type { Api, ProviderHeaders, ProviderHeadersTransform } from "../types";

const LINE_BREAKS = /[\r\n]/g;
/** RFC 9110 `token`: the only characters a field name may contain. */
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
/** Visible ASCII plus space and tab; rejects NUL, other controls, and non-ASCII. */
const HEADER_VALUE = /^[\t\x20-\x7e]*$/;

/** Longest header value, in characters, a transform may produce. */
export const MAX_PROVIDER_HEADER_VALUE_LENGTH = 8192;
/** Longest header name, in characters, a transform may produce. */
export const MAX_PROVIDER_HEADER_NAME_LENGTH = 256;
/** Most headers a transform may produce; entries past the cap are dropped in order. */
export const MAX_PROVIDER_HEADER_COUNT = 128;

/**
 * Lower-case header names a transform cannot change: connection-level and body-framing
 * headers that the HTTP client computes. Each keeps its pre-transform value (or stays absent).
 */
export const RESERVED_PROVIDER_HEADERS: ReadonlySet<string> = new Set([
	"host",
	"content-length",
	"content-encoding",
	"transfer-encoding",
	"connection",
	"keep-alive",
	"proxy-connection",
	"proxy-authorization",
	"te",
	"trailer",
	"upgrade",
]);

/** APIs whose transports apply `StreamOptions.transformHeaders`. */
export const PROVIDER_HEADER_TRANSFORM_APIS: ReadonlySet<Api> = new Set<Api>([
	"openai-completions",
	"openai-responses",
	"azure-openai-responses",
	"anthropic-messages",
	"bedrock-converse-stream",
]);

/** Why {@link sanitizeProviderHeaders} dropped or reverted a transformed header. */
export type RejectedProviderHeaderReason = "reserved" | "invalid-name" | "invalid-value" | "too-many";

/** Whether `name` is a header field name a transform may send: a token within {@link MAX_PROVIDER_HEADER_NAME_LENGTH}. */
export function isValidProviderHeaderName(name: string): boolean {
	return name.length <= MAX_PROVIDER_HEADER_NAME_LENGTH && HEADER_NAME.test(name);
}

/** Whether `value` is a header value a transform may send (after CR/LF stripping). */
export function isValidProviderHeaderValue(value: string): boolean {
	return value.length <= MAX_PROVIDER_HEADER_VALUE_LENGTH && HEADER_VALUE.test(value);
}

/**
 * Run `transform` over a copy of `headers` and return the sanitized result.
 *
 * A transform that returns `undefined` leaves `headers` untouched (no sanitizing).
 * Otherwise see {@link sanitizeProviderHeaders}. Once `signal` aborts, before or during the
 * transform, rejects with `abortError()` without waiting for it, so callers can throw the
 * same abort error their fetch path throws. Any other transform failure rejects as is;
 * callers that must not fail the request catch it themselves.
 */
export async function applyHeadersTransform(
	headers: Record<string, string>,
	transform: ProviderHeadersTransform | undefined,
	signal?: AbortSignal,
	abortError: () => unknown = () => signal?.reason,
): Promise<Record<string, string>> {
	if (!transform) return headers;
	if (signal?.aborted) throw abortError();
	let transformed: ProviderHeaders | undefined;
	try {
		const pending = Promise.resolve(transform({ ...headers }, signal));
		transformed = signal ? await raceAbort(pending, signal) : await pending;
	} catch (error) {
		if (signal?.aborted) throw abortError();
		throw error;
	}
	return transformed === undefined ? headers : sanitizeProviderHeaders(transformed, headers);
}

async function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	const aborted = Promise.withResolvers<never>();
	const onAbort = () => aborted.reject(signal.reason);
	signal.addEventListener("abort", onAbort, { once: true });
	// The transform may have aborted the signal synchronously, before the listener existed.
	if (signal.aborted) onAbort();
	try {
		return await Promise.race([promise, aborted.promise]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

/**
 * Collapse case-variant duplicates, apply `null` deletions, strip CR/LF, and drop entries
 * whose name is not a valid name (see {@link isValidProviderHeaderName}), whose value is not
 * visible ASCII within {@link MAX_PROVIDER_HEADER_VALUE_LENGTH}, or that come after
 * {@link MAX_PROVIDER_HEADER_COUNT} distinct names. Names in {@link RESERVED_PROVIDER_HEADERS} take
 * their value from `original` instead. `onRejected` receives the name (never the value) of
 * each dropped or reverted entry.
 */
export function sanitizeProviderHeaders(
	headers: ProviderHeaders,
	original: Record<string, string> = {},
	onRejected?: (name: string, reason: RejectedProviderHeaderReason) => void,
): Record<string, string> {
	const byLowerName = new Map<string, [name: string, value: string]>();
	for (const [rawName, value] of Object.entries(headers)) {
		const name = rawName.replace(LINE_BREAKS, "").trim();
		if (!name) continue;
		if (!isValidProviderHeaderName(name)) {
			onRejected?.(name, "invalid-name");
			continue;
		}
		const key = name.toLowerCase();
		if (RESERVED_PROVIDER_HEADERS.has(key)) continue;
		if (value === null) {
			byLowerName.delete(key);
			continue;
		}
		if (typeof value !== "string") continue;
		const cleaned = value.replace(LINE_BREAKS, "");
		if (!isValidProviderHeaderValue(cleaned)) {
			onRejected?.(name, "invalid-value");
			continue;
		}
		if (!byLowerName.has(key) && byLowerName.size >= MAX_PROVIDER_HEADER_COUNT) {
			onRejected?.(name, "too-many");
			continue;
		}
		// Re-inserting moves the entry to the end so the latest casing wins.
		byLowerName.delete(key);
		byLowerName.set(key, [name, cleaned]);
	}
	const reservedOriginal = new Map<string, [name: string, value: string]>();
	for (const [name, value] of Object.entries(original)) {
		const key = name.toLowerCase();
		if (RESERVED_PROVIDER_HEADERS.has(key)) reservedOriginal.set(key, [name, value]);
	}
	for (const [rawName, value] of Object.entries(headers)) {
		const key = rawName.trim().toLowerCase();
		if (!RESERVED_PROVIDER_HEADERS.has(key)) continue;
		const kept = reservedOriginal.get(key);
		if (kept?.[1] !== value) onRejected?.(rawName.trim(), "reserved");
	}
	const result: Record<string, string> = {};
	for (const [name, value] of byLowerName.values()) result[name] = value;
	for (const [name, value] of reservedOriginal.values()) result[name] = value;
	return result;
}
