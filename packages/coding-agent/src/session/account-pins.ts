/**
 * Settings-backed account pins for a session: the project pin from
 * `auth.accountPins` and the pool member `account` preference. The auth store
 * reads both through {@link settingsAccountPinSource} on every credential
 * resolution, so settings changes apply to the next request.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AccountPinSource } from "@oh-my-pi/pi-ai/auth-storage";
import { isRecord, logger } from "@oh-my-pi/pi-utils";
import type { ModelGroup, ParsedModelValue } from "../config/model-groups";
import { cfgAuthAccountPins, cfgModelGroups } from "../config/model-settings";
import type { Settings } from "../config/settings";
import { cfgRetryFallbackChains } from "./settings";

/** Settings revision at which an ignored project-layer `auth.accountPins` was last reported. */
const projectPinWarnings = new WeakMap<Settings, number>();

function warnProjectPinsIgnored(settings: Settings): void {
	if (projectPinWarnings.get(settings) === settings.revision) return;
	projectPinWarnings.set(settings, settings.revision);
	logger.warn("auth.accountPins is read from the user config only; project settings value ignored", {
		cwd: settings.getCwd(),
	});
}

/** Real path of `dir`, or its resolved path when it cannot be resolved (missing directory, permissions). */
export function canonicalDir(dir: string): string {
	try {
		return fs.realpathSync(dir);
	} catch {
		return path.resolve(dir);
	}
}

const userPinsCache = new WeakMap<Settings, { revision: number; pins: Map<string, Map<string, string>> }>();

/**
 * Merged `auth.accountPins` of the global config, `--config` overlays, and
 * runtime overrides, later layers winning per project and provider, keyed by
 * canonical project directory. The project layer is skipped: a repository
 * cannot pin the user's accounts.
 */
function userAccountPins(settings: Settings): Map<string, Map<string, string>> {
	const cached = userPinsCache.get(settings);
	if (cached?.revision === settings.revision) return cached.pins;
	const merged = new Map<string, Map<string, string>>();
	for (const { source, value } of settings.getLayerValues(cfgAuthAccountPins)) {
		if (source === "project") {
			warnProjectPinsIgnored(settings);
			continue;
		}
		if (!isRecord(value)) continue;
		for (const [project, pins] of Object.entries(value)) {
			if (!isRecord(pins)) continue;
			const key = canonicalDir(project);
			const providers = merged.get(key) ?? new Map<string, string>();
			for (const [provider, name] of Object.entries(pins)) {
				if (typeof name === "string") providers.set(provider, name);
			}
			merged.set(key, providers);
		}
	}
	userPinsCache.set(settings, { revision: settings.revision, pins: merged });
	return merged;
}

/** `revision\0cwd` pairs already reported as matching no configured project, per settings instance. */
const unmatchedPinWarnings = new WeakMap<Settings, Set<string>>();

function warnNoProjectMatched(settings: Settings, cwd: string): void {
	const key = `${settings.revision}\0${cwd}`;
	const warned = unmatchedPinWarnings.get(settings) ?? new Set<string>();
	if (warned.has(key)) return;
	warned.add(key);
	unmatchedPinWarnings.set(settings, warned);
	logger.warn("auth.accountPins names no project containing the working directory", { cwd });
}

/**
 * Account name pinned for `provider` in the project containing `cwd`: the
 * pinned project directory nearest to `cwd` (itself or an ancestor) that pins
 * the provider. Both sides compare as real paths, so symlinked directories match.
 */
export function projectAccountPin(settings: Settings, cwd: string, provider: string): string | undefined {
	const pins = userAccountPins(settings);
	if (pins.size === 0) return undefined;
	const start = canonicalDir(cwd);
	let matchedProject = false;
	let dir = start;
	for (;;) {
		const providers = pins.get(dir);
		if (providers) matchedProject = true;
		const name = providers?.get(provider);
		if (name !== undefined) return name;
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	if (!matchedProject) warnNoProjectMatched(settings, start);
	return undefined;
}

/** Member accounts by `provider/model-id`; `null` marks members of one model that disagree. */
type MemberAccounts = Map<string, string | null>;

const memberAccountsCache = new WeakMap<Settings, { revision: number; accounts: MemberAccounts }>();

function collectMemberAccounts(settings: Settings): MemberAccounts {
	const accounts: MemberAccounts = new Map();
	const add = (group: ModelGroup | undefined) => {
		for (const member of group?.models ?? []) {
			if (member.account === undefined) continue;
			const previous = accounts.get(member.model);
			accounts.set(member.model, previous === undefined || previous === member.account ? member.account : null);
		}
	};
	const addSpec = (spec: ParsedModelValue | undefined) => {
		if (spec?.kind === "group") add(spec.group);
	};
	for (const role of Object.keys(settings.getModelRoleEntries())) addSpec(settings.getModelRoleSpec(role));
	for (const key of Object.keys(cfgRetryFallbackChains.get(settings))) addSpec(settings.getFallbackChainSpec(key));
	for (const name of Object.keys(cfgModelGroups.get(settings))) add(settings.getModelGroup(name));
	for (const [model, account] of accounts) {
		if (account !== null) continue;
		logger.warn("Pool members of one model prefer different accounts; ignoring both", { model });
	}
	return accounts;
}

/**
 * Account the pool members for `provider/modelId` prefer, from every
 * configured group. Members of the same model that name different accounts
 * cancel out, so neither preference applies.
 */
export function memberAccount(settings: Settings, provider: string, modelId: string | undefined): string | undefined {
	if (modelId === undefined) return undefined;
	let cached = memberAccountsCache.get(settings);
	if (cached?.revision !== settings.revision) {
		cached = { revision: settings.revision, accounts: collectMemberAccounts(settings) };
		memberAccountsCache.set(settings, cached);
	}
	return cached.accounts.get(`${provider}/${modelId}`) ?? undefined;
}

/** Settings and working directory of every live session, by provider session id. */
const sessionScopes = new Map<string, { settings: Settings; cwd: () => string }>();

/**
 * Resolve `sessionId`'s project pin and pool member preference from
 * `settings`, with the project pin read for `cwd()`. Returns the teardown,
 * which restores the registration this one replaced and leaves a later
 * registration for the same session id in place.
 */
export function registerSessionAccountPins(sessionId: string, settings: Settings, cwd: () => string): () => void {
	const scope = { settings, cwd };
	const previous = sessionScopes.get(sessionId);
	sessionScopes.set(sessionId, scope);
	return () => {
		if (sessionScopes.get(sessionId) !== scope) return;
		if (previous) sessionScopes.set(sessionId, previous);
		else sessionScopes.delete(sessionId);
	};
}

/**
 * Resolve `targetSessionId`'s project pin and member preference like
 * `sourceSessionId`'s (side sessions such as title generation). Returns the
 * teardown; a no-op when the source is not registered.
 */
export function shareSessionAccountPins(sourceSessionId: string, targetSessionId: string): () => void {
	const scope = sessionScopes.get(sourceSessionId);
	return scope ? registerSessionAccountPins(targetSessionId, scope.settings, scope.cwd) : () => {};
}

/** Pin source for the auth store, answering from each registered session's settings. */
export const settingsAccountPinSource: AccountPinSource = {
	project: (provider, sessionId) => {
		const scope = sessionScopes.get(sessionId);
		return scope ? projectAccountPin(scope.settings, scope.cwd(), provider) : undefined;
	},
	member: (provider, sessionId, modelId) => {
		const scope = sessionScopes.get(sessionId);
		return scope ? memberAccount(scope.settings, provider, modelId) : undefined;
	},
};
