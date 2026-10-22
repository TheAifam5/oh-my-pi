import { resolveCredentialIdentityKey } from "@oh-my-pi/pi-ai";
import type { AuthApiKeyOptions, AuthStorage, SessionRestrictionLease } from "@oh-my-pi/pi-ai/auth-storage";
import * as AIError from "@oh-my-pi/pi-ai/error";
import type { Api, Model } from "@oh-my-pi/pi-ai/types";
import { isRecord, logger } from "@oh-my-pi/pi-utils";
import { resolveDisabledAccounts } from "../session/disabled-accounts";
import { type ApiKeyResolverModel, type ApiKeyResolverOptions, createApiKeyResolver } from "./api-key-resolver";
import type { ModelRegistry } from "./model-registry";
import { cfgAuthAccountPolicies, cfgAuthDisabledAccounts } from "./model-settings";
import type { Settings } from "./settings";

/**
 * Provider id → OAuth identity keys one session may authenticate with; see
 * `AuthStorage.sessions.restrict`. A listed provider uses only those accounts
 * and never an API key; an empty list allows no account.
 */
export type OAuthAccountPools = Readonly<Record<string, readonly string[]>>;

/**
 * Validate the exact-agent `task.agentAccountPools` map (agent name → provider
 * id → identity keys). An absent or empty (`null`) mapping means no pools, and
 * a `null` agent entry clears one inherited from a lower-priority settings
 * layer. Any other malformed level fails settings load: dropping it would
 * silently widen a restricted agent to every account. Both levels are
 * null-prototype maps, so a name such as `__proto__` stays an own entry.
 */
export function validateAgentAccountPools(value: unknown): Record<string, OAuthAccountPools> {
	if (value === undefined || value === null) return {};
	if (!isRecord(value)) {
		throw new Error(
			`Invalid task.agentAccountPools: expected a map of agent name to provider account pools, got ${Array.isArray(value) ? "an array" : `a ${typeof value}`}.`,
		);
	}
	const pools: Record<string, OAuthAccountPools> = Object.create(null);
	for (const [agentName, providers] of Object.entries(value)) {
		if (providers === null) continue;
		if (!isRecord(providers)) {
			throw new Error(
				`Invalid task.agentAccountPools.${agentName}: expected a map of provider to OAuth identity keys, got ${Array.isArray(providers) ? "an array" : `a ${typeof providers}`}.`,
			);
		}
		const agentPools: Record<string, readonly string[]> = Object.create(null);
		for (const [provider, identityKeys] of Object.entries(providers)) {
			if (
				!Array.isArray(identityKeys) ||
				!identityKeys.every((key): key is string => typeof key === "string" && key.length > 0 && key.trim() === key)
			) {
				throw new Error(
					`Invalid task.agentAccountPools.${agentName}.${provider}: expected a list of OAuth identity keys such as "email:you@example.com|org:<org-id>".`,
				);
			}
			agentPools[provider] = identityKeys;
		}
		pools[agentName] = agentPools;
	}
	return pools;
}

/** Unscoped registry and owning scope behind each registry {@link SessionAccountPoolScope.registry} returned. */
const scopedRegistries = new WeakMap<ModelRegistry, { target: ModelRegistry; scope: SessionAccountPoolScope }>();

/** The scope whose {@link SessionAccountPoolScope.registry} returned `registry`; undefined for any other registry. */
export function accountPoolScopeOf(registry: ModelRegistry): SessionAccountPoolScope | undefined {
	return scopedRegistries.get(registry)?.scope;
}

/** Receives `auth.disabledAccounts` problems when they appear and once they are gone. */
export interface DisabledAccountsIssueSink {
	raised(message: string): void;
	cleared(message: string): void;
}

/**
 * One agent session's account restrictions, enforced at its key lookups: its
 * OAuth account pools, and the accounts `auth.disabledAccounts` excludes.
 *
 * A pooled provider is restricted to its pool's identity keys. A provider with
 * an `auth.disabledAccounts` entry is restricted to the identity keys of its
 * stored OAuth accounts (or its pool's, when pooled) minus the excluded ones,
 * or to none when an entry is dead (see `resolveDisabledAccounts`). With
 * `settings`, the allowlists are recomputed when stored credentials change
 * (`AuthStorage.credentials.onGeneration`), when either setting's effective
 * value changes, and before a key lookup through {@link registry} once the
 * settings revision moved on, so a directory-layer edit, a login, or a logout
 * applies without a restart. A provider that drops out of both is lifted.
 *
 * The registry from {@link registry} restricts every provider session id that
 * resolves a key through it before resolving, so requests the session sends
 * under ids it mints on the side (title generation, skill compression,
 * advisors, nested subagents) stay inside the allowlists without each call
 * site opting in. A lookup without a session id for a restricted provider
 * resolves under the primary id instead of falling back to the provider's
 * unrestricted credentials.
 *
 * The scope holds the lease of every id it restricted; {@link release} retires
 * them (`AuthStorage.sessions.retire`) once the session can no longer resolve
 * keys. A lease retires only the restriction it installed, so a restriction
 * another session has installed on the same id since, such as a revived
 * session's, stays. A released scope restricts nothing more, stops following
 * settings and credentials, and refuses every restricted provider's key lookup
 * through {@link registry}. A read that bypasses the registry and goes to the
 * auth store directly under a released id (a scan job, a deferred side
 * request, a tool holding the id) stays inside the allowlist: the retired
 * restriction keeps denying every other account and every API key until a
 * later owner restricts the id again, as a revived or resumed session does. The
 * auth store keeps retired restrictions in memory, in this process only, for
 * 24 hours after they are retired (`SESSION_RESTRICTION_TOMBSTONE_TTL_MS`);
 * once one expires, or a memory safety cap evicts it, its id is unrestricted
 * again.
 */
export class SessionAccountPoolScope {
	readonly #authStorage: Pick<AuthStorage, "sessions" | "credentials">;
	readonly #pools: OAuthAccountPools;
	readonly #settings: Settings | undefined;
	/** Restricted provider id → sorted allowed identity keys, as installed on every known id. */
	#allowlists = new Map<string, readonly string[]>();
	/** Provider id → restriction lease, by known provider session id. */
	readonly #leases = new Map<string, Map<string, SessionRestrictionLease>>();
	/** Settings revision and credential generation {@link #allowlists} were computed at. */
	#computedAt: { revision: number; generation: number } | undefined;
	/** Current `auth.disabledAccounts` problems. */
	#issues = new Set<string>();
	#issueSink: DisabledAccountsIssueSink | undefined;
	readonly #unsubscribers: (() => void)[] = [];
	#primarySessionId: string;
	#released = false;

	constructor(
		authStorage: Pick<AuthStorage, "sessions" | "credentials">,
		pools: OAuthAccountPools,
		primarySessionId: string,
		settings?: Settings,
	) {
		this.#authStorage = authStorage;
		this.#pools = pools;
		this.#primarySessionId = primarySessionId;
		this.#settings = settings;
		if (settings) {
			this.#unsubscribers.push(
				authStorage.credentials.onGeneration(() => this.#refresh()),
				settings.onEffectiveChange([cfgAuthDisabledAccounts, cfgAuthAccountPolicies], () => this.#refresh()),
			);
		}
		this.restrict(primarySessionId);
	}

	/** The OAuth account pools this scope enforces. */
	get pools(): OAuthAccountPools {
		return this.#pools;
	}

	/** Deliver current and later `auth.disabledAccounts` problems to `sink`. */
	setIssueSink(sink: DisabledAccountsIssueSink): void {
		this.#issueSink = sink;
		for (const message of this.#issues) sink.raised(message);
	}

	/** Restrict `sessionId` like every id of this scope, once per id; does nothing after {@link release}. */
	restrict(sessionId: string): void {
		if (this.#released || this.#leases.has(sessionId)) return;
		this.#refresh();
		const leases = new Map<string, SessionRestrictionLease>();
		for (const [provider, identityKeys] of this.#allowlists) {
			leases.set(provider, this.#authStorage.sessions.restrict(provider, sessionId, identityKeys));
		}
		this.#leases.set(sessionId, leases);
	}

	/** Make `sessionId` the session's primary id: restricted, and the id for lookups that carry none. */
	adopt(sessionId: string): void {
		this.restrict(sessionId);
		this.#primarySessionId = sessionId;
	}

	/**
	 * Retire every restriction this scope installed, so later direct auth store
	 * lookups under its ids stay inside the allowlists; later restricted lookups
	 * through {@link registry} are refused.
	 */
	release(): void {
		this.#released = true;
		for (const unsubscribe of this.#unsubscribers.splice(0)) unsubscribe();
		for (const [sessionId, leases] of this.#leases) {
			for (const [provider, lease] of leases) {
				this.#authStorage.sessions.retire(provider, sessionId, lease);
			}
		}
		this.#leases.clear();
	}

	/** Recompute the allowlists when settings or stored credentials changed, and install the changes on every known id. */
	#refresh(): void {
		if (this.#released) return;
		const settings = this.#settings;
		const computedAt = settings
			? { revision: settings.revision, generation: this.#authStorage.credentials.generation }
			: { revision: -1, generation: -1 };
		if (
			this.#computedAt?.revision === computedAt.revision &&
			this.#computedAt?.generation === computedAt.generation
		) {
			return;
		}
		this.#computedAt = computedAt;
		const credentials = this.#authStorage.credentials;
		const resolution = settings ? resolveDisabledAccounts(settings, credentials) : undefined;
		const next = new Map<string, readonly string[]>();
		for (const [provider, identityKeys] of Object.entries(this.#pools)) {
			const excluded = resolution?.providers.get(provider);
			const allowed = excluded === null ? [] : identityKeys.filter(key => !excluded?.has(key));
			next.set(provider, [...new Set(allowed)].sort());
		}
		for (const [provider, excluded] of resolution?.providers ?? []) {
			if (Object.hasOwn(this.#pools, provider)) continue;
			const allowed = new Set<string>();
			for (const row of excluded === null ? [] : credentials.list(provider)) {
				const key = resolveCredentialIdentityKey(provider, row.credential);
				if (key !== null && !excluded?.has(key)) allowed.add(key);
			}
			next.set(provider, [...allowed].sort());
		}
		const sessions = this.#authStorage.sessions;
		for (const [provider, identityKeys] of next) {
			const previous = this.#allowlists.get(provider);
			if (previous && Bun.deepEquals(previous, identityKeys)) continue;
			for (const [sessionId, leases] of this.#leases) {
				leases.set(provider, sessions.restrict(provider, sessionId, identityKeys));
			}
		}
		for (const provider of this.#allowlists.keys()) {
			if (next.has(provider)) continue;
			for (const [sessionId, leases] of this.#leases) {
				const lease = leases.get(provider);
				if (lease === undefined) continue;
				sessions.unrestrict(provider, sessionId, lease);
				leases.delete(provider);
			}
		}
		this.#allowlists = next;
		this.#reportIssues(new Set(resolution?.issues.map(issue => issue.message)));
	}

	/** Report each problem once while it persists, and its end. */
	#reportIssues(next: Set<string>): void {
		for (const message of this.#issues) {
			if (!next.has(message)) this.#issueSink?.cleared(message);
		}
		for (const message of next) {
			if (this.#issues.has(message)) continue;
			logger.warn("auth.disabledAccounts problem", { message });
			this.#issueSink?.raised(message);
		}
		this.#issues = next;
	}

	/**
	 * The session id a key lookup for `provider` resolves under, restricted first.
	 * @throws AIError.MissingApiKeyError for a restricted provider once the scope is released.
	 */
	#sessionIdFor(provider: string, sessionId: string | undefined): string | undefined {
		this.#refresh();
		if (!this.#allowlists.has(provider)) {
			if (sessionId !== undefined) this.restrict(sessionId);
			return sessionId;
		}
		if (this.#released) {
			throw new AIError.MissingApiKeyError(
				provider,
				`No API key for provider: ${provider} (the session that restricted its ${provider} accounts has ended)`,
			);
		}
		const scopedSessionId = sessionId ?? this.#primarySessionId;
		this.restrict(scopedSessionId);
		return scopedSessionId;
	}

	/**
	 * `registry` with its key lookups (`getApiKey`, `getApiKeyForProvider`,
	 * `getApiKeyWithCredentialForProvider`, `getApiKeyAndHeaders`, `resolver`)
	 * routed through this scope. Every other member is the unscoped registry's,
	 * so model state, discovery, and caches stay shared. A registry another
	 * scope returned is unwrapped first: a nested agent's scope replaces its
	 * parent's.
	 */
	registry(registry: ModelRegistry): ModelRegistry {
		const target = scopedRegistries.get(registry)?.target ?? registry;
		const getApiKey = async (model: Model<Api>, sessionId?: string, options?: { signal?: AbortSignal }) =>
			target.getApiKey(model, this.#sessionIdFor(model.provider, sessionId), options);
		const getApiKeyWithCredentialForProvider = async (
			provider: string,
			sessionId?: string,
			options?: AuthApiKeyOptions,
		) => target.getApiKeyWithCredentialForProvider(provider, this.#sessionIdFor(provider, sessionId), options);
		const scoped: Partial<ModelRegistry> = {
			getApiKey,
			getApiKeyWithCredentialForProvider,
			getApiKeyForProvider: async (provider, sessionId, options) =>
				target.getApiKeyForProvider(provider, this.#sessionIdFor(provider, sessionId), options),
			getApiKeyAndHeaders: async model => {
				try {
					const apiKey = await getApiKey(model);
					if (apiKey === undefined) {
						return { ok: false, error: `No API key found for "${model.provider}"` };
					}
					return { ok: true, apiKey, headers: await target.getProviderHeaders(model.provider) };
				} catch (error) {
					return { ok: false, error: error instanceof Error ? error.message : String(error) };
				}
			},
			resolver: ((
				resolverTarget: string | ApiKeyResolverModel,
				optionsOrSessionId?: ApiKeyResolverOptions | string,
			) => {
				const options =
					typeof optionsOrSessionId === "string" ? { sessionId: optionsOrSessionId } : (optionsOrSessionId ?? {});
				const provider = typeof resolverTarget === "string" ? resolverTarget : resolverTarget.provider;
				let sessionId: string | undefined;
				try {
					sessionId = this.#sessionIdFor(provider, options.sessionId);
				} catch (error) {
					// The refusal surfaces when the request resolves its key, like a failed lookup.
					return () => Promise.reject(error);
				}
				return createApiKeyResolver(
					{ getApiKeyWithCredentialForProvider, authStorage: target.authStorage },
					provider,
					{
						...options,
						...(typeof resolverTarget === "string"
							? {}
							: { baseUrl: resolverTarget.baseUrl, modelId: resolverTarget.id }),
						sessionId,
					},
				);
			}) as ModelRegistry["resolver"],
		};
		// ModelRegistry keeps its state in #private fields, so every other member
		// runs against the target itself; bound methods are cached per name.
		const bound = new Map<PropertyKey, unknown>();
		const proxy = new Proxy(target, {
			get(object, property) {
				if (Object.hasOwn(scoped, property)) return scoped[property as keyof ModelRegistry];
				const value: unknown = Reflect.get(object, property, object);
				if (typeof value !== "function") return value;
				let method = bound.get(property);
				if (method === undefined) {
					method = value.bind(object);
					bound.set(property, method);
				}
				return method;
			},
		});
		scopedRegistries.set(proxy, { target, scope: this });
		return proxy;
	}
}
