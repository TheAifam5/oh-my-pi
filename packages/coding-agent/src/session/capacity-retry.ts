import * as AIError from "@oh-my-pi/pi-ai/error";
import { calculateRateLimitBackoffMs, parseRateLimitReason } from "@oh-my-pi/pi-ai/error/rate-limit";

const CAPACITY_TEXT_PATTERN = /\bcapacity\b|overloaded/i;

/**
 * Whether a failure is a transient provider capacity error that names its
 * cause (`at capacity`, `turn_rate_limit_exceeded` capacity text, overloaded)
 * rather than a usage limit, an account-policy denial, or a bare 503/529.
 */
export function isCapacityFailure(errorId: number, message: string): boolean {
	if (AIError.is(errorId, AIError.Flag.UsageLimit) || AIError.is(errorId, AIError.Flag.AccountPolicy)) return false;
	return parseRateLimitReason(message) === "MODEL_CAPACITY_EXHAUSTED" && CAPACITY_TEXT_PATTERN.test(message);
}

/**
 * Wait before same-model capacity retry `attempt` (1-based): the provider's
 * retry-after hint, else `baseDelayMs` doubled per earlier attempt. Capped by
 * `maxDelayMs` (0 = no cap); `undefined` when the provider's hint exceeds it,
 * so the caller switches account or model instead of waiting.
 */
export function capacityRetryDelayMs(
	baseDelayMs: number,
	attempt: number,
	retryAfterMs: number | undefined,
	maxDelayMs: number,
): number | undefined {
	if (retryAfterMs !== undefined) {
		return maxDelayMs > 0 && retryAfterMs > maxDelayMs ? undefined : Math.max(0, retryAfterMs);
	}
	const delayMs = Math.max(0, baseDelayMs) * 2 ** Math.max(0, attempt - 1);
	return maxDelayMs > 0 ? Math.min(delayMs, maxDelayMs) : delayMs;
}

/**
 * How long a capacity failure blocks the failing account before a sibling is
 * tried: the provider's retry-after hint, else the library capacity window.
 */
export function capacityAccountBlockMs(retryAfterMs: number | undefined): number {
	return retryAfterMs ?? calculateRateLimitBackoffMs("MODEL_CAPACITY_EXHAUSTED");
}
