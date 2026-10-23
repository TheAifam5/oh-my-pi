import { sanitizeNoticeLine } from "../utils/notice-text";
import type { PoolPickerMember } from "@oh-my-pi/pi-tui/overlays/model-picker";
import { logger } from "@oh-my-pi/pi-utils";
import { cfgModelGroups } from "../config/model-settings";
import { resolveRolePoolGroup, type GroupFallbackChain } from "./retry-fallback-groups";
import {
	getModelMatchPreferences,
	resolveCliModel,
	resolveModelRoleValue,
	type ResolveCliModelResult,
} from "../config/model-resolver";
import { groupMemberSelectors } from "../config/model-groups";
import type { Settings } from "../config/settings";
import type { AgentSession } from "./agent-session";
import { describeRolePoolSkip, resolveRolePool, rolePoolAliasTarget } from "./pool-selection";
import { pickRolePoolTarget } from "./role-pool-resolution";

export interface SessionModelSelection extends ResolveCliModelResult {
	poolRole?: string;
}

/** Resolves session selectors with pool eligibility and kept role picks. */
export async function resolveSessionModelSelector(
	selector: string,
	session: AgentSession,
	settings: Settings,
	options: { advanceActiveRole?: boolean; signal?: AbortSignal } = {},
): Promise<SessionModelSelection> {
	try {
		const scoped = session.scopedModels.map(entry => entry.model);
		const target = rolePoolAliasTarget(selector, settings);
		const availableModels =
			scoped.length > 0 ? scoped : target ? session.getAvailableModels() : session.modelRegistry.getAvailable();
		if (target?.group) {
			const pick = await pickRolePoolTarget(target, settings, availableModels, {
				modelRegistry: session.modelRegistry,
				sessionId: session.sessionId,
				signal: options.signal,
			});
			if (!pick) throw new Error(sanitizeNoticeLine(`Pool member "${selector}" is unavailable`));
			return {
				model: pick.model,
				selector,
				thinkingLevel: pick.thinkingLevel,
				warning: undefined,
				error: undefined,
			};
		}
		if (target) {
			let advance = target.advance;
			if (target.advance)
				await session.resolveRoleModelAsync(target.role, { availableModels, signal: options.signal });
			if (options.advanceActiveRole && !target.memberSelector && !advance) {
				advance = session.isRolePoolPickActive(target.role);
			}
			const resolved = await session.resolveRoleModelAsync(target.role, {
				availableModels,
				memberSelector: target.memberSelector,
				advance,
				thinkingLevel: target.thinkingLevel,
				signal: options.signal,
			});
			return {
				model: resolved.model,
				selector,
				thinkingLevel: target.thinkingLevel ?? resolved.thinkingLevel,
				warning: resolved.warning,
				error: resolved.model ? undefined : `No eligible member of pool "${target.role}"`,
				poolRole: target.role,
			};
		}
		return resolveCliModel({
			cliModel: selector,
			modelRegistry: session.modelRegistry,
			availableModels: scoped.length > 0 ? scoped : undefined,
			settings,
			preferences: getModelMatchPreferences(settings),
		});
	} catch (error) {
		return {
			model: undefined,
			selector: undefined,
			warning: undefined,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

/** Member rows of configured role pools and model groups, with current eligibility. */
export async function listSessionPoolMembers(
	session: AgentSession,
	settings: Settings,
	signal?: AbortSignal,
): Promise<PoolPickerMember[]> {
	const pools: { parent: string; policy: GroupFallbackChain }[] = [];
	for (const role of Object.keys(settings.getModelRoles())) {
		const policy = resolveRolePoolGroup(settings, role);
		if (policy) pools.push({ parent: `@${role}`, policy });
	}
	for (const name of Object.keys(cfgModelGroups.get(settings))) {
		const group = settings.getModelGroup(name);
		if (group)
			pools.push({
				parent: `+${name}`,
				policy: { group, members: groupMemberSelectors(group), poolId: `group:${name}` },
			});
	}
	const rows: PoolPickerMember[] = [];
	const allModels = session.modelRegistry.getAll();
	const scopedModels = session.scopedModels.map(entry => entry.model);
	const availableModels = scopedModels.length > 0 ? scopedModels : session.getAvailableModels();
	for (const { parent, policy } of pools) {
		signal?.throwIfAborted();
		const resolution = await resolveRolePool(
			parent,
			{
				settings,
				modelRegistry: session.modelRegistry,
				sessionId: () => session.sessionId,
				emitNotice: async message => logger.info(message),
				availableModels: () => availableModels,
			},
			{ signal, policy, checkHealth: true },
		);
		if (resolution?.kind === "aborted") signal?.throwIfAborted();
		const skipped = resolution?.kind === "picked" || resolution?.kind === "none" ? (resolution.skipped ?? []) : [];
		for (const entry of policy.members) {
			if (parent.startsWith("@") && entry.member.alias === "next") continue;
			const model = resolveModelRoleValue(entry.selector, allModels, { settings, exact: true }).model;
			if (!model) continue;
			const skip = skipped.find(candidate => candidate.selector === entry.selector);
			const until = session.modelRegistry.selectorSuppressedUntil(entry.selector);
			const state =
				until !== undefined
					? `blocked until ${new Date(until).toLocaleTimeString()}`
					: skip?.reason.kind === "no-auth"
						? "no entitled account"
						: skip
							? describeRolePoolSkip(skip.reason)
							: "usable";
			rows.push({ parent, selector: `${parent}/${entry.member.alias}`, model, state });
		}
	}
	return rows;
}
