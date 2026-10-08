/**
 * Which credential cache rows the auth broker shares across clients, and the
 * bounds every shared row obeys. The server enforces these limits; clients
 * apply the same checks before writing so a row the broker would refuse stays
 * local instead of failing in the background.
 */
import { DRAIN_STATE_CACHE_PREFIX, SESSION_DRAIN_CACHE_PREFIX } from "../auth/drain-state";

/**
 * Cache key prefixes shared through the broker: account drain state and
 * session drain overrides. Every other cache row (usage reports, session pins
 * and stickies, tool caches) never leaves the process that wrote it.
 */
export const SHARED_CACHE_PREFIXES: readonly string[] = [DRAIN_STATE_CACHE_PREFIX, SESSION_DRAIN_CACHE_PREFIX];

/** Longest shared cache key or prefix, in UTF-16 code units. */
export const SHARED_CACHE_MAX_KEY_LENGTH = 512;

/**
 * Largest shared cache value, in UTF-8 bytes of its JSON string encoding
 * (escapes included), so a listing's size is bounded whatever characters the
 * values hold. Drain rows are well under 1 KiB.
 */
export const SHARED_CACHE_MAX_VALUE_BYTES = 4 * 1024;

/** Most live rows the broker keeps under one shared prefix; a write of a new key past it is refused. */
export const SHARED_CACHE_MAX_ROWS_PER_PREFIX = 1024;

/**
 * Longest lifetime of a shared row past the broker's clock, in seconds. Later
 * expiries are clamped to it; it covers the 30-day session drain override.
 */
export const SHARED_CACHE_MAX_TTL_SEC = 35 * 24 * 60 * 60;

/** Largest accepted `PUT /v1/cache/:key` body, in bytes: a maximal encoded value plus the envelope. */
export const SHARED_CACHE_MAX_BODY_BYTES = 2 * SHARED_CACHE_MAX_VALUE_BYTES;

/**
 * Largest `GET /v1/cache` response body, in bytes: a full prefix of rows,
 * each a maximal encoded value, a maximal key (no control characters, so at
 * most three UTF-8 bytes per code unit), and the row envelope.
 */
export const SHARED_CACHE_MAX_LISTING_BYTES =
	SHARED_CACHE_MAX_ROWS_PER_PREFIX * (SHARED_CACHE_MAX_VALUE_BYTES + 3 * SHARED_CACHE_MAX_KEY_LENGTH + 64) + 256;

const TEXT_ENCODER = new TextEncoder();

// C0 and C1 control characters, which no cache key the auth modules write contains.
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;

/** The shared prefix `keyOrPrefix` falls under, or undefined when it is not shared. */
export function sharedCachePrefixOf(keyOrPrefix: string): string | undefined {
	return SHARED_CACHE_PREFIXES.find(prefix => keyOrPrefix.startsWith(prefix));
}

/**
 * Whether `value` is an acceptable shared key or listing prefix: under a
 * shared prefix, within {@link SHARED_CACHE_MAX_KEY_LENGTH}, without control
 * characters, and well-formed UTF-16 so it survives URL encoding.
 */
export function isSharedCacheKey(value: string): boolean {
	return (
		value.length <= SHARED_CACHE_MAX_KEY_LENGTH &&
		sharedCachePrefixOf(value) !== undefined &&
		!CONTROL_CHARACTER.test(value) &&
		value.isWellFormed()
	);
}

/** Whether `value`'s JSON string encoding fits {@link SHARED_CACHE_MAX_VALUE_BYTES}. */
export function isSharedCacheValue(value: string): boolean {
	// Every UTF-16 code unit encodes to at most six bytes (a `\uXXXX` escape), plus the quotes.
	if (value.length * 6 + 2 <= SHARED_CACHE_MAX_VALUE_BYTES) return true;
	return TEXT_ENCODER.encode(JSON.stringify(value)).byteLength <= SHARED_CACHE_MAX_VALUE_BYTES;
}
