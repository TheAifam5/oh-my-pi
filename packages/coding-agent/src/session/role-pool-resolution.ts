import type { Api, Model, UsageReport } from "@oh-my-pi/pi-ai";
import { modelsAreEqual } from "@oh-my-pi/pi-catalog/models";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import { logger, untilAborted } from "@oh-my-pi/pi-utils";
import { isAuthenticated, kNoAuth, type ModelRegistry } from "../config/model-registry";
import {
	formatModelStringWithRouting,
	type RoleChainCandidate,
	resolveModelRoleValue,
	resolveRoleChain,
	resolveRoleSelection,
} from "../config/model-resolver";
import type { Settings } from "../config/settings";
import {
	notePoolPickApplied,
	PoolSelection,
	type RolePoolDeps,
	type RolePoolPick,
	RolePoolUnavailableError,
	resolveRolePool,
	rolePoolEvidenceHint,
	rolePoolPolicyBlocked,
	type RolePoolTarget,
	rolePoolTarget,
} from "./pool-selection";

/** Registry capabilities a pool-role resolution outside a session needs. */
export type RolePoolRegistry = RolePoolDeps["modelRegistry"] & Pick<ModelRegistry, "getApiKey">;

/** Where a pool-role resolution outside a session reads credentials and reports skips. */
export interface RolePoolContext {
	modelRegistry: RolePoolRegistry;
	/** Session credentials and usage lookups are attributed to. */
	sessionId?: string;
	signal?: AbortSignal;
	/** Delivers the funding-skip notice; skips are logged either way. */
	emitNotice?(message: string): Promise<void>;
}

/**
 * Selection shared by the roles one consumer resolves in one call: a single usage-report read
 * (its outcome, including a deadline miss, holds for the whole call), one notice dedupe, and one
 * {@link pickRolePool} outcome per role, a blocked pool's error included.
 */
export interface RolePoolCall {
	readonly selection: PoolSelection;
	readonly picks: Map<string, Promise<RolePoolPick | undefined>>;
	/** Picks this call returned, in order; {@link noteRolePoolModelUsed} records them. */
	readonly made: RolePoolPick[];
	/** Picks of {@link made} already recorded; each is recorded at most once. */
	readonly recorded: Set<RolePoolPick>;
}

/** A {@link RolePoolCall} for `context`; pass it to every {@link pickRolePool} of one call. */
export function createRolePoolCall(settings: Settings, context: RolePoolContext): RolePoolCall {
	let reports: Promise<UsageReport[] | null> | undefined;
	return {
		picks: new Map(),
		made: [],
		recorded: new Set(),
		selection: new PoolSelection({
			settings,
			modelRegistry: context.modelRegistry,
			sessionId: () => context.sessionId,
			emitNotice: async message => context.emitNotice?.(message),
			usageReports: options => {
				reports ??= context.modelRegistry.authStorage.usage.reports(options);
				return reports;
			},
		}),
	};
}

/**
 * Records the round-robin position ({@link notePoolPickApplied}) of every pick `call` made whose
 * model is `model`. A consumer calls it when it sends a request to `model`, so a pick it passes over
 * or never reaches leaves its pool's position unchanged. Each pick is recorded once per call, so a
 * consumer reusing its pick never moves the position back after other consumers advanced it.
 */
export function noteRolePoolModelUsed(call: RolePoolCall, model: Model<Api>): void {
	for (const pick of call.made) {
		if (call.recorded.has(pick) || !modelsAreEqual(pick.model, model)) continue;
		call.recorded.add(pick);
		notePoolPickApplied(pick);
	}
}

/**
 * The member `role`'s pool picks, selected afresh on every call, or `undefined` when `role` is
 * neither a pool nor an alias of one ({@link rolePoolTarget}) or no member is eligible without a
 * funding or quota skip; the caller then resolves the legacy value as before. An alias's `:level`
 * replaces the picked member's effort.
 *
 * Members are limited to `availableModels` and probed by configured credentials only, which pins
 * no session credential and refreshes nothing; only the picked member's key is resolved through
 * `getApiKey` (keyless providers count). A pick whose key does not resolve, or whose lookup
 * fails, is passed over and the pool selects again. A pick does not advance the pool's round-robin
 * position: the consumer records it when it uses the pick ({@link notePoolPickApplied},
 * {@link noteRolePoolModelUsed}), so concurrent picks before any use choose the same member. Within
 * one `call` a role is picked once and later calls return the same outcome.
 *
 * @throws RolePoolUnavailableError when no member is eligible and the funding or quota policy excluded one.
 * @throws the abort reason when `context.signal` aborts.
 */
export async function pickRolePool(
	role: string,
	settings: Settings,
	availableModels: Model<Api>[],
	context: RolePoolContext,
	call: RolePoolCall = createRolePoolCall(settings, context),
): Promise<RolePoolPick | undefined> {
	const memoized = call.picks.get(role);
	if (memoized) return memoized;
	const target = rolePoolTarget(settings, role);
	if (!target) return undefined;
	const pick = pickRolePoolTarget(target, settings, availableModels, context, call);
	call.picks.set(role, pick);
	return pick;
}

/**
 * {@link pickRolePool} for a resolved {@link RolePoolTarget}, such as a `--model @role:level`
 * selection ({@link rolePoolAliasTarget}).
 *
 * @throws RolePoolUnavailableError when no member is eligible and the funding or quota policy excluded one.
 * @throws the abort reason when `context.signal` aborts.
 */
export async function pickRolePoolTarget(
	target: RolePoolTarget,
	settings: Settings,
	availableModels: Model<Api>[],
	context: RolePoolContext,
	call: RolePoolCall = createRolePoolCall(settings, context),
): Promise<RolePoolPick | undefined> {
	const { modelRegistry, sessionId, signal } = context;
	const unusable = new Set<string>();
	for (;;) {
		const resolution = await resolveRolePool(
			target.role,
			{
				settings,
				modelRegistry,
				sessionId: () => sessionId,
				emitNotice: async message => context.emitNotice?.(message),
				availableModels: () => availableModels,
				hasUsableAuth: model =>
					!unusable.has(formatModelStringWithRouting(model)) && modelRegistry.hasConfiguredAuth(model),
				selection: call.selection,
			},
			{ signal },
		);
		if (resolution === undefined) return undefined;
		switch (resolution.kind) {
			case "aborted":
				signal?.throwIfAborted();
				return undefined;
			case "none":
				if (rolePoolPolicyBlocked(resolution.skipped)) {
					throw new RolePoolUnavailableError(
						target.role,
						resolution.skipped,
						rolePoolEvidenceHint(resolution.skipped),
					);
				}
				return undefined;
			case "picked": {
				const { pick } = resolution;
				let key: string | undefined;
				try {
					key = await untilAborted(signal, modelRegistry.getApiKey(pick.model, sessionId, { signal }));
				} catch (error) {
					signal?.throwIfAborted();
					// A failed refresh or broker error leaves the member unusable, as a missing key does.
					logger.debug("Model role pool could not resolve the picked member's key", {
						selector: pick.selector.raw,
						error: String(error),
					});
				}
				signal?.throwIfAborted();
				if (key !== kNoAuth && !isAuthenticated(key)) {
					unusable.add(formatModelStringWithRouting(pick.model));
					continue;
				}
				const picked =
					target.thinkingLevel === undefined
						? pick
						: { ...pick, thinkingLevel: target.thinkingLevel, explicitThinkingLevel: true };
				call.made.push(picked);
				return picked;
			}
		}
	}
}

/**
 * {@link resolveRoleSelection} that resolves a pool role through {@link pickRolePool}, for
 * background fallback lists: roles are tried in order, a role whose pool its policy blocks is
 * skipped (and logged) so the next role may serve, and a legacy role or a pool role without a pick
 * resolves exactly as {@link resolveRoleSelection} resolves it. All roles share one funding read,
 * and `call` lets several selections of one run share it and their picks. `pick` is the pool pick
 * the selection came from; the consumer records it ({@link notePoolPickApplied}) when it uses it.
 *
 * @throws RolePoolUnavailableError, the first blocked pool's, when no role resolves and one was blocked.
 * @throws the abort reason when `context.signal` aborts.
 */
export async function resolveRoleSelectionAsync(
	roles: readonly string[],
	settings: Settings,
	availableModels: Model<Api>[],
	context: RolePoolContext,
	call: RolePoolCall = createRolePoolCall(settings, context),
): Promise<
	{ role: string; model: Model<Api>; thinkingLevel?: ConfiguredThinkingLevel; pick?: RolePoolPick } | undefined
> {
	let blocked: RolePoolUnavailableError | undefined;
	for (const role of roles) {
		let pick: RolePoolPick | undefined;
		try {
			pick = await pickRolePool(role, settings, availableModels, context, call);
		} catch (error) {
			if (!(error instanceof RolePoolUnavailableError)) throw error;
			logger.info("Skipped a blocked model role pool in a role fallback list", { role, error: error.message });
			blocked ??= error;
			continue;
		}
		if (pick) return { role, model: pick.model, thinkingLevel: pick.thinkingLevel, pick };
		const legacy = resolveRoleSelection([role], settings, availableModels);
		if (legacy) return legacy;
	}
	if (blocked) throw blocked;
	return undefined;
}

/**
 * The chain a pool pick leads: the pick, then the pool's other eligible members in strategy and
 * funding order, resolved exactly in `pool`.
 */
export function rolePoolPickCandidates(
	pick: RolePoolPick,
	settings: Settings,
	pool: Model<Api>[],
	options: { includeRest?: boolean } = {},
): RoleChainCandidate[] {
	const candidates: RoleChainCandidate[] = [
		{
			model: pick.model,
			explicit: true,
			...(pick.thinkingLevel !== undefined ? { thinkingLevel: pick.thinkingLevel } : {}),
		},
	];
	if (options.includeRest === false) return candidates;
	for (const member of pick.rest) {
		const resolved = resolveModelRoleValue(member.raw, pool, { settings, exact: true });
		if (!resolved.model) continue;
		candidates.push({
			model: resolved.model,
			explicit: true,
			...(resolved.thinkingLevel !== undefined ? { thinkingLevel: resolved.thinkingLevel } : {}),
		});
	}
	return candidates;
}

/**
 * {@link resolveRoleChain} that leads a pool role's chain with {@link rolePoolPickCandidates},
 * followed by the role's retry candidates. A legacy role, and a pool role without a pick, resolve
 * exactly as {@link resolveRoleChain} resolves them. Only `role`'s own value is read, so a
 * model-kind role never inherits the `default` pool. The pick is recorded in `call`; the consumer
 * records its position with {@link noteRolePoolModelUsed} when it sends a request to a candidate.
 *
 * @throws RolePoolUnavailableError when the pool's policy excluded every eligible member.
 * @throws the abort reason when `context.signal` aborts.
 */
export async function resolveRoleChainAsync(
	role: string,
	settings: Settings,
	pool: Model<Api>[],
	context: RolePoolContext,
	call: RolePoolCall = createRolePoolCall(settings, context),
): Promise<RoleChainCandidate[]> {
	const pick = await pickRolePool(role, settings, pool, context, call);
	if (!pick) return resolveRoleChain(role, settings, pool);
	return resolveRoleChain(role, settings, pool, { leading: rolePoolPickCandidates(pick, settings, pool) });
}
