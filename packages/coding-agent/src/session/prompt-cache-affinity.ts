import type { Api, AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import type { CacheLedger } from "./cache-ledger";
import { observedPromptCacheTier, type PromptCacheTier } from "./cache-warmer";

/** How long a ledger hit rate read by {@link PromptCacheAffinity.cacheHitRate} is reused, in ms. */
export const LEDGER_HIT_RATE_TTL_MS = 30_000;

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
 *
 * Every response other than a cache-warming replay that reports prompt tokens also counts toward
 * its model's session hit rate, the fallback of {@link PromptCacheAffinity.cacheHitRate} read by
 * pools with `routing.cache.pricing`.
 */
export class PromptCacheAffinity {
	readonly #entries = new Map<string, { warmUntilMs: number; tier?: PromptCacheTier }>();
	/** Prompt tokens of this session's responses by model, for {@link cacheHitRate}. */
	readonly #tokens = new Map<string, { hits: number; prompt: number }>();
	/** Ledger hit rates by model and the epoch ms each was read at; `rate` undefined when the ledger had none. */
	readonly #ledgerRates = new Map<string, { rate: number | undefined; readAtMs: number }>();

	/**
	 * Records the cache use of `message`, a response of `model` observed at `nowMs` (epoch ms). A
	 * `cacheWarm` response (a cache-warming replay) extends warmth but is left out of the hit rate.
	 */
	observe(message: AssistantMessage, model: Model<Api>, nowMs: number, cacheWarm = false): void {
		const key = cacheKey(model);
		const { usage } = message;
		const prompt = usage.cacheRead + usage.cacheWrite + usage.input;
		if (!cacheWarm && Number.isFinite(prompt) && prompt > 0) {
			const tokens = this.#tokens.get(key) ?? { hits: 0, prompt: 0 };
			tokens.hits += usage.cacheRead;
			tokens.prompt += prompt;
			this.#tokens.set(key, tokens);
		}
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

	/**
	 * Expected prompt-cache hit rate of `model` at `nowMs` (epoch ms), in [0, 1]: `ledger`'s rolling
	 * rate when it has calls of the model (they include this session's recorded turns), else
	 * cache-read tokens over all prompt tokens of this session's responses on it. Undefined when
	 * neither has data. A ledger answer, including none, is reused for
	 * {@link LEDGER_HIT_RATE_TTL_MS}.
	 */
	cacheHitRate(
		model: Model<Api>,
		nowMs: number,
		ledger: Pick<CacheLedger, "cacheHitRate"> | undefined,
	): number | undefined {
		const key = cacheKey(model);
		let rate: number | undefined;
		if (ledger) {
			const cached = this.#ledgerRates.get(key);
			if (cached && nowMs >= cached.readAtMs && nowMs - cached.readAtMs < LEDGER_HIT_RATE_TTL_MS) {
				rate = cached.rate;
			} else {
				rate = ledger.cacheHitRate(model.provider, model.id, model.baseUrl, undefined, nowMs)?.rate;
				this.#ledgerRates.set(key, { rate, readAtMs: nowMs });
			}
		}
		if (rate !== undefined) return rate;
		const tokens = this.#tokens.get(key);
		return tokens ? tokens.hits / tokens.prompt : undefined;
	}

	/** Forgets every model's warmth but keeps its hit rate, as when an in-place rewrite changes the sent prefix. */
	clearWarmth(): void {
		this.#entries.clear();
	}

	/** Forgets every model, as when the session's conversation is replaced or rewritten. */
	clear(): void {
		this.#entries.clear();
		this.#tokens.clear();
		this.#ledgerRates.clear();
	}
}

function cacheKey(model: Model<Api>): string {
	return `${model.provider}/${model.id} ${model.baseUrl ?? ""}`;
}
