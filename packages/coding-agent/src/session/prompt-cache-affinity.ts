import type { Api, AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { observedPromptCacheTier, type PromptCacheTier } from "./cache-warmer";

/**
 * The prompt caches one session's responses left warm, by `provider/model` and base URL, read by
 * pools with `routing.cache.affinity`. Accounts are not part of the key: pools pick a member before
 * an account is chosen.
 *
 * A response that read or wrote the prompt cache keeps its model warm from the request's start
 * (`message.timestamp`, else the observation time) for the lifetime the model's `promptCache`
 * declares for the tier written: the tier the provider reports writing, else the tier last
 * reported for the model; when that tier declares no lifetime, or no tier is known, the shortest
 * declared lifetime. The latest response sets the window, so a switch to a shorter tier shortens
 * it. A model that declares no lifetime is never warm. A completed response that neither read nor
 * wrote the cache forgets the model; an errored or aborted one only ever records cache use.
 */
export class PromptCacheAffinity {
	readonly #entries = new Map<string, { warmUntilMs: number; tier?: PromptCacheTier }>();

	/** Records the cache use of `message`, a response of `model` observed at `nowMs` (epoch ms). */
	observe(message: AssistantMessage, model: Model<Api>, nowMs: number): void {
		const key = cacheKey(model);
		const { usage } = message;
		if (usage.cacheRead <= 0 && usage.cacheWrite <= 0) {
			if (message.stopReason !== "error" && message.stopReason !== "aborted") this.#entries.delete(key);
			return;
		}
		const tier = observedPromptCacheTier(usage) ?? this.#entries.get(key)?.tier;
		const lifetimes = model.promptCache;
		const shortest = Math.min(
			lifetimes?.short ?? Number.POSITIVE_INFINITY,
			lifetimes?.long ?? Number.POSITIVE_INFINITY,
		);
		const seconds = (tier !== undefined ? lifetimes?.[tier] : undefined) ?? shortest;
		if (!Number.isFinite(seconds) || seconds <= 0) {
			this.#entries.delete(key);
			return;
		}
		const startMs = Number.isFinite(message.timestamp) && message.timestamp <= nowMs ? message.timestamp : nowMs;
		this.#entries.set(key, { warmUntilMs: startMs + seconds * 1000, ...(tier !== undefined ? { tier } : {}) });
	}

	/** Whether `model`'s prompt cache is still warm at `nowMs` (epoch ms). */
	isWarm(model: Model<Api>, nowMs: number): boolean {
		const entry = this.#entries.get(cacheKey(model));
		return entry !== undefined && nowMs < entry.warmUntilMs;
	}

	/** Forgets every model, as when the session's conversation is replaced or rewritten. */
	clear(): void {
		this.#entries.clear();
	}
}

function cacheKey(model: Model<Api>): string {
	return `${model.provider}/${model.id} ${model.baseUrl ?? ""}`;
}
