/**
 * Requests in flight per model, counted for the `least-loaded` and `p2c` pool strategies.
 *
 * The count is per process and covers session-turn requests only (the session `streamFn`);
 * background one-shot calls and other processes are not counted.
 */

/** In-flight count per `provider/model-id`; a model with none has no entry. */
const inFlight = new Map<string, number>();

function modelKey(provider: string, id: string): string {
	return `${provider}/${id}`;
}

/** Requests to `provider/id` started in this process that have not settled. */
export function inFlightRequests(provider: string, id: string): number {
	return inFlight.get(modelKey(provider, id)) ?? 0;
}

/** Counts one request to `provider/id` until `settled` resolves or rejects. */
export function trackInFlightRequest(provider: string, id: string, settled: Promise<unknown>): void {
	const key = modelKey(provider, id);
	inFlight.set(key, (inFlight.get(key) ?? 0) + 1);
	const release = () => {
		const remaining = (inFlight.get(key) ?? 1) - 1;
		if (remaining > 0) inFlight.set(key, remaining);
		else inFlight.delete(key);
	};
	settled.then(release, release);
}
