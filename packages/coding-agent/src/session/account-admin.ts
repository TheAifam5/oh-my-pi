/**
 * Account administration shared by `omp account`, the `/account` manager, and
 * the account selector: naming accounts and setting their priority, reserve,
 * drain return thresholds, and limits (`auth.accountPolicies` in the user
 * config), pinning a project to an account (`auth.accountPins`), setting a pool
 * member's preferred account, and logging an account out.
 *
 * Every write goes to the user (global) config layer only and is validated
 * against the stored credentials before it is applied.
 */

import * as path from "node:path";
import type {
	AuthAccountPolicies,
	AuthAccountPolicy,
	AuthAccountSelector,
	DrainReturnTrigger,
	DrainSpendClass,
} from "@oh-my-pi/pi-ai/auth-storage";
import { AccountPolicies, accountUsageKey, matchesAuthAccountSelector } from "@oh-my-pi/pi-ai/auth/policy";
import {
	type AccountEvidenceMetric,
	type AccountLimit,
	isAccountEvidenceLimit,
	LOCAL_LIMIT_PERIODS,
	parseAccountLimits,
} from "@oh-my-pi/pi-ai/usage/limits";
import { isRecord, logger } from "@oh-my-pi/pi-utils";
import type { ModelGroup, ParsedModelValue } from "../config/model-groups";
import { cfgAuthAccountPins, cfgAuthAccountPolicies, cfgModelGroups } from "../config/model-settings";
import type { Settings } from "../config/settings";
import { canonicalDir, projectAccountPin } from "./account-pins";
import { loadEffectiveAuthAccountPolicyConfig } from "./auth-broker-config";
import type { AuthAccountSummary, AuthStorage } from "./auth-storage";
import { type LimitStatus, limitStatus } from "./local-limits";
import { cfgRetryFallbackChains, cfgRetryUsageReservePct } from "./settings";
import type { UsageLedger } from "./usage-ledger";

/** A rejected account operation; the message is meant for the user. */
export class AccountAdminError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AccountAdminError";
	}
}

/** One stored credential addressed by an account command. */
export interface AccountRef {
	provider: string;
	account: AuthAccountSummary;
}

/** One row of `omp account list`. */
export interface AccountListing extends AccountRef {
	/** Human identity: email, account id, project, enterprise URL, or `API key <fingerprint>`. */
	label: string;
	priority?: number;
	reservePct?: number;
	/** True when the account policy drains this account first. */
	drain: boolean;
	/** Funding classes the drained account may spend, as configured. */
	spend?: readonly DrainSpendClass[];
	/** Triggers that return the drained account, as configured. */
	returnWhen?: readonly DrainReturnTrigger[];
	/** Percent of quota back before a drained account is used first again. */
	returnMargin?: number;
	/** Shortest time a drained account stays behind its siblings, in ms. */
	returnCooldownMs?: number;
	/**
	 * The account policy's limits with their counted usage; a provider-evidence limit
	 * (`usage`, `credits`, `extra-usd`) carries no `window` or `used`.
	 */
	limits: AccountLimitView[];
	/** True when `auth.accountPins` pins this account for the working directory's project. */
	projectPinned: boolean;
}

/** One account limit as listed: a ledger limit's {@link LimitStatus}, or a provider-evidence limit. */
export type AccountLimitView =
	| LimitStatus
	| { name: string; metric: AccountEvidenceMetric; max: string | number; onLimit: "skip" | "warn" };

/** Human identity of a stored account; never includes key material. */
export function accountLabel(account: AuthAccountSummary): string {
	if (account.type === "api_key") return `API key ${account.keyFingerprint ?? `#${account.credentialId}`}`;
	const base = account.email ?? account.accountId ?? account.projectId ?? account.enterpriseUrl;
	if (!base) return `OAuth credential #${account.credentialId}`;
	const org = account.orgName ?? account.orgId;
	return org && org !== base ? `${base} (${org})` : base;
}

function storedProviders(authStorage: AuthStorage): string[] {
	return [...new Set(authStorage.credentials.list().map(row => row.provider))].sort();
}

/**
 * The account `selector` names: `[provider/]<name|email|account id|key fingerprint|#credential id>`.
 *
 * @throws AccountAdminError when nothing or more than one account matches.
 */
export function resolveAccount(authStorage: AuthStorage, selector: string): AccountRef {
	const slash = selector.indexOf("/");
	const provider = slash > 0 ? selector.slice(0, slash) : undefined;
	const wanted = (slash > 0 ? selector.slice(slash + 1) : selector).trim();
	if (!wanted) throw new AccountAdminError("Name an account: [provider/]<name|email|account id|key fingerprint|#id>.");
	const credentialId = /^#\d+$/.test(wanted) ? Number(wanted.slice(1)) : undefined;
	const matches: AccountRef[] = [];
	for (const candidate of provider ? [provider] : storedProviders(authStorage)) {
		for (const account of authStorage.sessions.accounts(candidate)) {
			const hit =
				credentialId !== undefined
					? account.credentialId === credentialId
					: [account.name, account.email, account.accountId, account.keyFingerprint].includes(wanted);
			if (hit) matches.push({ provider: candidate, account });
		}
	}
	if (matches.length === 1) return matches[0]!;
	if (matches.length === 0) {
		throw new AccountAdminError(`No stored account matches. Run \`omp account list\` to see them.`);
	}
	const choices = matches.map(
		match => `${match.provider}/#${match.account.credentialId} (${accountLabel(match.account)})`,
	);
	throw new AccountAdminError(`That matches several accounts: ${choices.join(", ")}. Use provider/#id.`);
}

function matchesPolicy(policy: AuthAccountPolicy, ref: AccountRef): boolean {
	if (policy.provider !== ref.provider || !isRecord(policy.account)) return false;
	if (ref.account.type === "api_key") return policy.account.keyFingerprint === ref.account.keyFingerprint;
	return matchesAuthAccountSelector(policy.account, ref.account);
}

/**
 * The smallest policy selector that matches exactly this stored account among
 * the provider's stored accounts; `orgId` is added only when an account id or
 * email alone is shared by several org-scoped credentials.
 */
function selectorFor(authStorage: AuthStorage, ref: AccountRef): AuthAccountSelector {
	const { account } = ref;
	if (account.type === "api_key") return { keyFingerprint: account.keyFingerprint };
	const siblings = authStorage.sessions.accounts(ref.provider).filter(candidate => candidate.type === "oauth");
	const { accountId, email, projectId, orgId } = account;
	const candidates: AuthAccountSelector[] = [
		{ accountId },
		{ email },
		{ projectId },
		{ accountId, orgId },
		{ email, orgId },
		{ accountId, email, projectId, orgId },
	];
	for (const candidate of candidates) {
		const selector = Object.fromEntries(
			Object.entries(candidate).filter(([, value]) => value !== undefined),
		) as AuthAccountSelector;
		if (selector.accountId === undefined && selector.email === undefined && selector.projectId === undefined)
			continue;
		if (siblings.filter(sibling => matchesAuthAccountSelector(selector, sibling)).length === 1) return selector;
	}
	throw new AccountAdminError(`${accountLabel(account)} has no identity that tells it apart from the other accounts.`);
}

/** `auth.accountPolicies` as the user config holds it; project and overlay entries are never copied into it. */
function userPolicies(settings: Settings): AuthAccountPolicies {
	const auth = settings.getGlobalSettings().auth;
	const policies = isRecord(auth) ? auth.accountPolicies : undefined;
	return Array.isArray(policies) ? (policies as AuthAccountPolicies) : [];
}

/** Warning when the user config value is not the effective one, so the write does not apply. */
function shadowWarning(settings: Settings): string | undefined {
	const provenance = cfgAuthAccountPolicies.provenance(settings);
	if (provenance === "global" || provenance === "default") return undefined;
	return `auth.accountPolicies is set in the ${provenance} layer, which replaces the user config value; this change does not apply there.`;
}

/**
 * Why an `auth.accountPolicies` edit would not apply: a project, `--config`, or runtime layer
 * sets the value and replaces the user config's; undefined when the user config value is effective.
 */
export function accountPolicyWriteBlocker(settings: Settings): string | undefined {
	const provenance = cfgAuthAccountPolicies.provenance(settings);
	return provenance === "global" || provenance === "default"
		? undefined
		: `auth.accountPolicies is set in the ${provenance} layer`;
}

/** Result of a write: the user-facing warning, if any. */
export interface AccountWriteResult {
	warning?: string;
}

type PolicyPatch = Partial<
	Pick<
		AuthAccountPolicy,
		| "name"
		| "priority"
		| "reservePct"
		| "drain"
		| "spend"
		| "returnWhen"
		| "returnMargin"
		| "returnCooldownMs"
		| "limits"
	>
>;

/** `policies` with `patch` applied to the entry for `ref`, created when missing; an `undefined` field is removed. */
function patchedPolicies(
	authStorage: AuthStorage,
	policies: AuthAccountPolicies,
	ref: AccountRef,
	patch: PolicyPatch,
): AuthAccountPolicy[] {
	const index = policies.findIndex(policy => matchesPolicy(policy, ref));
	const next = [...policies];
	const base = index === -1 ? { provider: ref.provider, account: selectorFor(authStorage, ref) } : policies[index]!;
	const updated: { -readonly [K in keyof AuthAccountPolicy]: AuthAccountPolicy[K] } = { ...base, ...patch };
	for (const key of Object.keys(patch) as (keyof PolicyPatch)[]) if (patch[key] === undefined) delete updated[key];
	// An entry left with only its provider and account would still switch on the policy reserve; drop it.
	if (Object.keys(updated).every(key => key === "provider" || key === "account")) {
		if (index !== -1) next.splice(index, 1);
	} else if (index === -1) next.push(updated);
	else next[index] = updated;
	return next;
}

/** Validates `next` against `provider`'s stored credentials, then writes it to the user config. */
function commitPolicies(
	settings: Settings,
	authStorage: AuthStorage,
	provider: string,
	next: AuthAccountPolicies,
): AccountWriteResult {
	try {
		const policies = new AccountPolicies(next, cfgRetryUsageReservePct.get(settings));
		policies.validateFor(
			provider,
			authStorage.credentials.list(provider).map(row => row.credential),
		);
	} catch (error) {
		throw new AccountAdminError(error instanceof Error ? error.message : String(error));
	}
	cfgAuthAccountPolicies.set(settings, next);
	return { warning: shadowWarning(settings) };
}

function writePolicy(
	settings: Settings,
	authStorage: AuthStorage,
	ref: AccountRef,
	patch: PolicyPatch,
): AccountWriteResult {
	return commitPolicies(
		settings,
		authStorage,
		ref.provider,
		patchedPolicies(authStorage, userPolicies(settings), ref, patch),
	);
}

/**
 * Make `ref` the OAuth account `provider` drains first, or with `ref`
 * undefined, drain none; the other accounts of the provider lose `drain`,
 * `spend`, and `returnWhen`. `funding` fields replace those of `ref`'s entry;
 * omitted ones keep the values it had while already drained, and the defaults
 * (`spend` of only `plan`, `returnWhen` of only `reset`) remove the field.
 */
export function setAccountDrain(
	settings: Settings,
	authStorage: AuthStorage,
	provider: string,
	ref: AccountRef | undefined,
	funding: Partial<Pick<AuthAccountPolicy, "spend" | "returnWhen">> = {},
): AccountWriteResult {
	if (ref && ref.account.type !== "oauth") throw new AccountAdminError("Only OAuth accounts can be drained.");
	const current = userPolicies(settings);
	const previous = ref ? current.find(policy => policy.drain === true && matchesPolicy(policy, ref)) : undefined;
	// An entry left with only its provider and account would still switch on the policy reserve; drop it.
	const cleared = current.flatMap(policy => {
		if (policy.provider !== provider || policy.drain === undefined) return [policy];
		const { drain: _drain, spend: _spend, returnWhen: _returnWhen, ...rest } = policy;
		return Object.keys(rest).every(key => key === "provider" || key === "account") ? [] : [rest];
	});
	const spend = funding.spend ?? previous?.spend;
	const returnWhen = funding.returnWhen ?? previous?.returnWhen;
	const keepSpend = spend?.some(spendClass => spendClass !== "plan") === true;
	const keepReturnWhen = returnWhen !== undefined && [returnWhen].flat().some(trigger => trigger !== "reset");
	return commitPolicies(
		settings,
		authStorage,
		provider,
		ref
			? patchedPolicies(authStorage, cleared, ref, {
					drain: true,
					...(keepSpend ? { spend } : {}),
					...(keepReturnWhen ? { returnWhen } : {}),
				})
			: cleared,
	);
}

/**
 * Name an account (`auth.accountPolicies[].name`); names are unique per provider. Renaming warns
 * about project pins and pool members that still name the account by its previous name; session
 * pins follow the credential and are unaffected.
 */
export function labelAccount(
	settings: Settings,
	authStorage: AuthStorage,
	ref: AccountRef,
	name: string,
): AccountWriteResult {
	const result = writePolicy(settings, authStorage, ref, { name });
	const previous = ref.account.name;
	if (previous === name) return result;
	const warnings = [result.warning];
	// The name is already written; a failed reference scan must not turn that into a reported failure.
	try {
		const dangling = previous === undefined ? [] : nameReferences(settings, ref.provider, previous);
		if (dangling.length > 0) {
			warnings.push(
				`${dangling.join(", ")} still name "${previous}"; ${ref.provider} requests that use ${dangling.length === 1 ? "it" : "them"} no longer reach this account until updated to "${name}".`,
			);
		}
		const adopted = nameReferences(settings, ref.provider, name);
		if (adopted.length > 0) {
			warnings.push(
				`${adopted.join(", ")} already name "${name}"; ${ref.provider} requests that use ${adopted.length === 1 ? "it" : "them"} now reach this account.`,
			);
		}
	} catch (error) {
		warnings.push(
			`Could not check what else names this account: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const warning = warnings.filter(Boolean).join(" ");
	return warning ? { warning } : {};
}

/** Project pins (outside the project layer) and pool members that name `provider`'s account `name`. */
function nameReferences(settings: Settings, provider: string, name: string): string[] {
	const references: string[] = [];
	for (const { source, value } of settings.getLayerValues(cfgAuthAccountPins)) {
		if (source === "project" || !isRecord(value)) continue;
		for (const [dir, pins] of Object.entries(value)) {
			if (stringPins(pins)[provider] === name) references.push(`auth.accountPins["${dir}"]`);
		}
	}
	for (const member of listPoolMembers(settings)) {
		if (member.account === name && member.model.startsWith(`${provider}/`)) references.push(poolMemberPath(member));
	}
	return references;
}

/** Set an account's routing priority; higher wins among otherwise equal accounts. */
export function setAccountPriority(
	settings: Settings,
	authStorage: AuthStorage,
	ref: AccountRef,
	priority: number,
): AccountWriteResult {
	if (!Number.isFinite(priority)) throw new AccountAdminError("Priority must be a finite number.");
	return writePolicy(settings, authStorage, ref, { priority });
}

/** Set the remaining-quota percentage (0–100) kept in reserve for an OAuth account. */
export function setAccountReserve(
	settings: Settings,
	authStorage: AuthStorage,
	ref: AccountRef,
	reservePct: number,
): AccountWriteResult {
	if (ref.account.type !== "oauth") throw new AccountAdminError("A reserve applies to OAuth accounts only.");
	if (!Number.isFinite(reservePct) || reservePct < 0 || reservePct > 100) {
		throw new AccountAdminError("Reserve must be a percentage between 0 and 100.");
	}
	if (!authStorage.usage.canFetchOAuthUsage(ref.provider)) {
		throw new AccountAdminError(
			`${ref.provider} has no usage source (no local provider and no broker), so a reserve cannot be enforced.`,
		);
	}
	const result = writePolicy(settings, authStorage, ref, { reservePct });
	if (authStorage.usage.providerFor(ref.provider) !== undefined) return result;
	const brokerWarning = `The reserve gives no protection until the broker reports usage for ${ref.provider}; if it never does, the reserve never applies.`;
	return { warning: [result.warning, brokerWarning].filter(Boolean).join(" ") };
}

/**
 * Set when a drained OAuth account is used first again: `returnMargin` (percent of quota back,
 * 0–100) and `returnCooldownMs`. A field given as `undefined` is removed (its default applies);
 * an omitted field is kept.
 */
export function setAccountReturn(
	settings: Settings,
	authStorage: AuthStorage,
	ref: AccountRef,
	thresholds: Pick<AuthAccountPolicy, "returnMargin" | "returnCooldownMs">,
): AccountWriteResult {
	if (ref.account.type !== "oauth") throw new AccountAdminError("Return thresholds apply to OAuth accounts only.");
	return writePolicy(settings, authStorage, ref, thresholds);
}

/**
 * Replace an account's local limits; an empty list removes them.
 *
 * @throws AccountAdminError when two limits are the same, or the policy write refuses them.
 */
export function setAccountLimits(
	settings: Settings,
	authStorage: AuthStorage,
	ref: AccountRef,
	limits: readonly unknown[],
): AccountWriteResult {
	const parsed = parseAccountLimits(limits, "limits");
	if (parsed.issues.length === 0) {
		const duplicate = parsed.limits.findIndex((limit, index) =>
			parsed.limits.slice(0, index).some(earlier => Bun.deepEquals(earlier, limit)),
		);
		if (duplicate !== -1) {
			throw new AccountAdminError(
				`${formatAccountLimitSpec(parsed.limits[duplicate]!)} is already a limit of this account.`,
			);
		}
	}
	return writePolicy(settings, authStorage, ref, {
		limits: limits.length > 0 ? (limits as AuthAccountPolicy["limits"]) : undefined,
	});
}

const LIMIT_SPEC_USAGE =
	"Limit: <usd|requests|tokens> <max> <day|week|month|<n>m|<n>h|<n>d> [warn|skip], or <usage|credits|extra-usd> <max> [warn|skip].";
const ROLLING_UNITS_MS = { d: 86_400_000, h: 3_600_000, m: 60_000 } as const;

/**
 * An account limit from `<metric> <max> [<window>] [warn|skip]`: a calendar `day`/`week`/`month`
 * or a rolling `<n>m`/`<n>h`/`<n>d` window for ledger metrics, none for provider evidence. Only
 * the syntax is checked here; the policy write validates the values.
 *
 * @throws AccountAdminError when the text does not have that shape.
 */
export function parseAccountLimitSpec(spec: string): Record<string, unknown> {
	const [metric, max, ...rest] = spec.trim().split(/\s+/);
	if (!metric || !max) throw new AccountAdminError(LIMIT_SPEC_USAGE);
	const limit: Record<string, unknown> = {
		metric,
		max: ["requests", "tokens", "usage"].includes(metric) ? Number(max) : max.replace(/^\$/, ""),
	};
	for (const word of rest) {
		const rolling = /^(\d+)([mhd])$/.exec(word);
		if (word === "warn" || word === "skip") limit.onLimit = word;
		else if ((LOCAL_LIMIT_PERIODS as readonly string[]).includes(word))
			limit.window = { type: "calendar", period: word };
		else if (rolling) {
			const unit = rolling[2] as keyof typeof ROLLING_UNITS_MS;
			limit.window = { type: "rolling", durationMs: Number(rolling[1]) * ROLLING_UNITS_MS[unit] };
		} else throw new AccountAdminError(LIMIT_SPEC_USAGE);
	}
	return limit;
}

/** `limit` in the {@link parseAccountLimitSpec} syntax. */
export function formatAccountLimitSpec(limit: AccountLimit): string {
	const words = [limit.metric, String(limit.max)];
	if ("window" in limit) {
		const { window } = limit;
		if (window.type === "calendar") words.push(window.period);
		else {
			const unit = (["d", "h", "m"] as const).find(
				candidate => window.durationMs % ROLLING_UNITS_MS[candidate] === 0,
			);
			words.push(unit ? `${window.durationMs / ROLLING_UNITS_MS[unit]}${unit}` : `${window.durationMs}ms`);
		}
	}
	words.push(limit.onLimit);
	return words.join(" ");
}

/**
 * The limits configured on `ref`'s effective policy entry, parsed.
 *
 * @throws AccountAdminError when an entry is invalid, so a later write never drops it silently.
 */
export function accountLimits(settings: Settings, ref: AccountRef): AccountLimit[] {
	const policy = cfgAuthAccountPolicies.get(settings).find(entry => matchesPolicy(entry, ref));
	if (policy?.limits === undefined) return [];
	const parsed = parseAccountLimits(policy.limits, "limits");
	const issue = parsed.issues[0];
	if (issue)
		throw new AccountAdminError(`${ref.provider} account ${issue.path} ${issue.message}; fix it in the config.`);
	return parsed.limits;
}

/** A model pool member, addressed by where its pool is configured. */
export interface PoolMemberRef {
	/** `modelRoles.<key>`, `retry.fallbackChains.<key>`, or `modelGroups.<key>`. */
	kind: "role" | "chain" | "group";
	key: string;
	alias: string;
}

/** One member of a configured model pool with the account it prefers. */
export interface PoolMemberListing extends PoolMemberRef {
	/** `provider/model-id`. */
	model: string;
	account?: string;
	/** Why the member cannot be edited in the user config: the layer that sets its pool. */
	readOnly?: string;
}

const POOL_PATH: Record<PoolMemberRef["kind"], string> = {
	role: "modelRoles",
	chain: "retry.fallbackChains",
	group: "modelGroups",
};

/** Config path of `ref`, such as `modelRoles.default.models.fast`. */
export function poolMemberPath(ref: PoolMemberRef): string {
	return `${POOL_PATH[ref.kind]}.${ref.key}.models.${ref.alias}`;
}

function poolProvenanceBlocker(settings: Settings, kind: PoolMemberRef["kind"], key: string): string | undefined {
	const provenance =
		kind === "role"
			? settings.getModelRoleProvenance(key)
			: settings.getProvenance(kind === "chain" ? cfgRetryFallbackChains : cfgModelGroups);
	return provenance === "global" || provenance === "default" ? undefined : `set in the ${provenance} layer`;
}

/** Members of every inline role and fallback-chain pool and every named model group. */
export function listPoolMembers(settings: Settings): PoolMemberListing[] {
	const rows: PoolMemberListing[] = [];
	const add = (kind: PoolMemberRef["kind"], key: string, group: ModelGroup | undefined) => {
		if (!group) return;
		const readOnly = poolProvenanceBlocker(settings, kind, key);
		for (const member of group.models) {
			rows.push({
				kind,
				key,
				alias: member.alias,
				model: member.model,
				...(member.account !== undefined ? { account: member.account } : {}),
				...(readOnly ? { readOnly } : {}),
			});
		}
	};
	const inline = (spec: ParsedModelValue | undefined) => (spec?.kind === "group" ? spec.group : undefined);
	for (const role of Object.keys(settings.getModelRoleEntries()))
		add("role", role, inline(settings.getModelRoleSpec(role)));
	for (const key of Object.keys(cfgRetryFallbackChains.get(settings))) {
		add("chain", key, inline(settings.getFallbackChainSpec(key)));
	}
	for (const name of Object.keys(cfgModelGroups.get(settings))) add("group", name, settings.getModelGroup(name));
	return rows;
}

/**
 * Set (or with `account` undefined, remove) the account a pool member tries first, in the
 * user config. The pool is written back through its strict validator.
 *
 * @throws AccountAdminError when a higher layer sets the pool, the user config holds no inline
 * pool with that member, or the validator refuses the result.
 */
export function setPoolMemberAccount(settings: Settings, ref: PoolMemberRef, account: string | undefined): void {
	const where = poolMemberPath(ref);
	const blocker = poolProvenanceBlocker(settings, ref.kind, ref.key);
	if (blocker) throw new AccountAdminError(`${where} is ${blocker}; change it there.`);
	const global = settings.getGlobalSettings();
	const container =
		ref.kind === "role"
			? global.modelRoles
			: ref.kind === "chain"
				? isRecord(global.retry)
					? global.retry.fallbackChains
					: undefined
				: global.modelGroups;
	const raw = isRecord(container) ? container[ref.key] : undefined;
	const members = isRecord(raw) ? raw.models : undefined;
	const member = isRecord(members) ? members[ref.alias] : undefined;
	if (!isRecord(raw) || !isRecord(members) || !isRecord(member)) {
		throw new AccountAdminError(`${where} is not a pool member in the user config.`);
	}
	const { account: _previous, ...rest } = member;
	const next = {
		...raw,
		models: { ...members, [ref.alias]: account === undefined ? rest : { ...rest, account } },
	};
	try {
		if (ref.kind === "role") settings.setModelRoleSpec(ref.key, next);
		else if (ref.kind === "chain") settings.setFallbackChainSpec(ref.key, next);
		else settings.setModelGroup(ref.key, next);
	} catch (error) {
		throw new AccountAdminError(error instanceof Error ? error.message : String(error));
	}
}

/** A user-config `auth.accountPins` location: its canonical directory, raw key spellings, and merged pins. */
interface UserPinLocation {
	dir: string;
	keys: string[];
	pins: Record<string, string>;
}

function stringPins(entry: unknown): Record<string, string> {
	if (!isRecord(entry)) return {};
	return Object.fromEntries(
		Object.entries(entry).filter((pair): pair is [string, string] => typeof pair[1] === "string"),
	);
}

/** User-config pin entries by canonical directory, merging entries whose keys spell the same directory. */
function userPinLocations(settings: Settings): Map<string, UserPinLocation> {
	const auth = settings.getGlobalSettings().auth;
	const entries = isRecord(auth) && isRecord(auth.accountPins) ? auth.accountPins : {};
	const locations = new Map<string, UserPinLocation>();
	for (const [key, entry] of Object.entries(entries)) {
		const dir = canonicalDir(key);
		const location = locations.get(dir) ?? { dir, keys: [], pins: {} };
		location.keys.push(key);
		Object.assign(location.pins, stringPins(entry));
		locations.set(dir, location);
	}
	return locations;
}

/** Directories from `cwd` (canonical) up to the filesystem root. */
function ancestorDirs(cwd: string): string[] {
	const dirs: string[] = [];
	let dir = canonicalDir(cwd);
	for (;;) {
		dirs.push(dir);
		const parent = path.dirname(dir);
		if (parent === dir) return dirs;
		dir = parent;
	}
}

/** The nearest user-config pin location at or above `cwd` whose pins satisfy `accept`. */
function nearestUserPin(
	settings: Settings,
	cwd: string,
	accept: (pins: Record<string, string>) => boolean,
): UserPinLocation | undefined {
	const locations = userPinLocations(settings);
	for (const dir of ancestorDirs(cwd)) {
		const location = locations.get(dir);
		if (location && accept(location.pins)) return location;
	}
	return undefined;
}

/** Writes `pins` at `location.dir` first, then drops the other spellings of that directory. */
function writePinLocation(settings: Settings, location: UserPinLocation, pins: Record<string, string>): void {
	cfgAuthAccountPins.setEntry(settings, location.dir, Object.keys(pins).length > 0 ? pins : undefined);
	for (const key of location.keys) if (key !== location.dir) cfgAuthAccountPins.setEntry(settings, key, undefined);
}

/** Result of pinning the project: the pinned provider and name, the directory written, and an optional warning. */
export interface ProjectPinResult extends AccountWriteResult {
	provider: string;
	name: string;
	/** Directory whose pins were updated: the nearest existing pinned project, else the working directory. */
	projectDir: string;
}

/**
 * Pin the project containing `cwd` to the account named `selector`
 * (`[provider/]<name>`), in the user config. An existing pinned project at or
 * above `cwd` is updated; otherwise `cwd` becomes a pinned project.
 *
 * @throws AccountAdminError when no or several providers have an account by that name.
 */
export function pinProjectAccount(
	settings: Settings,
	authStorage: AuthStorage,
	cwd: string,
	selector: string,
): ProjectPinResult {
	const slash = selector.indexOf("/");
	const wantedProvider = slash > 0 ? selector.slice(0, slash) : undefined;
	const name = slash > 0 ? selector.slice(slash + 1) : selector;
	const providers = [
		...new Set(
			cfgAuthAccountPolicies
				.get(settings)
				.filter(
					policy => policy.name === name && (wantedProvider === undefined || policy.provider === wantedProvider),
				)
				.map(policy => policy.provider),
		),
	];
	if (providers.length === 0) {
		throw new AccountAdminError("No account has that name. Name one with `omp account label`.");
	}
	if (providers.length > 1) {
		throw new AccountAdminError(`That name belongs to accounts of ${providers.join(", ")}; use provider/<name>.`);
	}
	const provider = providers[0]!;
	const location = nearestUserPin(settings, cwd, () => true) ?? { dir: canonicalDir(cwd), keys: [], pins: {} };
	writePinLocation(settings, location, { ...location.pins, [provider]: name });
	const stored = authStorage.sessions.accounts(provider).some(account => account.name === name);
	return {
		provider,
		name,
		projectDir: location.dir,
		...(stored ? {} : { warning: `No stored ${provider} account is named "${name}"; requests fail until one is.` }),
	};
}

/** Result of removing project pins. */
export interface ProjectUnpinResult {
	/** Number of provider pins removed. */
	removed: number;
	/** Directory whose pins were changed. */
	projectDir?: string;
	/** Layers (overlay, runtime) that still pin this project and cannot be changed here. */
	shadowedBy: string[];
}

/**
 * Remove the pin for `provider`, or every pin, of the nearest pinned project
 * at or above `cwd` in the user config.
 */
export function unpinProjectAccount(settings: Settings, cwd: string, provider?: string): ProjectUnpinResult {
	const covers = (pins: Record<string, string>) =>
		provider === undefined ? Object.keys(pins).length > 0 : Object.hasOwn(pins, provider);
	const location = nearestUserPin(settings, cwd, covers);
	let removed = 0;
	if (location) {
		const kept = Object.entries(location.pins).filter(([pinned]) => provider !== undefined && pinned !== provider);
		removed = Object.keys(location.pins).length - kept.length;
		writePinLocation(settings, location, Object.fromEntries(kept));
	}
	return {
		removed,
		...(location ? { projectDir: location.dir } : {}),
		shadowedBy: shadowingPinLayers(settings, cwd, covers),
	};
}

/** Layers above the user config (overlay, runtime) whose `auth.accountPins` cover `cwd` with pins satisfying `covers`. */
function shadowingPinLayers(
	settings: Settings,
	cwd: string,
	covers: (pins: Record<string, string>) => boolean,
): string[] {
	const dirs = new Set(ancestorDirs(cwd));
	return settings
		.getLayerValues(cfgAuthAccountPins)
		.filter(({ source, value }) => {
			if (source === "global" || source === "project" || !isRecord(value)) return false;
			return Object.entries(value).some(([key, entry]) => dirs.has(canonicalDir(key)) && covers(stringPins(entry)));
		})
		.map(({ source }) => source);
}

/**
 * Why a user-config project pin edit for `provider` at `cwd` would not apply: an overlay or
 * runtime `auth.accountPins` value pins it; undefined otherwise.
 */
export function projectPinWriteBlocker(settings: Settings, cwd: string, provider: string): string | undefined {
	const layers = shadowingPinLayers(settings, cwd, pins => Object.hasOwn(pins, provider));
	return layers.length > 0 ? `auth.accountPins for this project is set in the ${layers.at(-1)} layer` : undefined;
}

/** The views of an account policy's `configured` limits, ledger limits counted under the account's usage key. */
function accountLimitViews(
	provider: string,
	account: AuthAccountSummary,
	configured: unknown,
	ledger: UsageLedger | undefined,
	nowMs: number,
): AccountLimitView[] {
	if (configured === undefined) return [];
	const key = accountUsageKey(account);
	const name = account.name ?? accountLabel(account);
	return parseAccountLimits(configured, "limits").limits.map(limit =>
		isAccountEvidenceLimit(limit)
			? { name, metric: limit.metric, max: limit.max, onLimit: limit.onLimit }
			: limitStatus(
					key === undefined ? undefined : ledger,
					{ key: name, label: name, limit, scopes: [{ provider, account: key ?? "" }] },
					name,
					nowMs,
				),
	);
}

/** Every stored account with its name, policy, label, and project pin mark for `cwd`. */
export function listAccounts(settings: Settings, authStorage: AuthStorage, cwd: string): AccountListing[] {
	const policies = cfgAuthAccountPolicies.get(settings);
	const ledger = settings.getStorage()?.usageLedger;
	const nowMs = Date.now();
	const rows: AccountListing[] = [];
	for (const provider of storedProviders(authStorage)) {
		const pinnedName = projectAccountPin(settings, cwd, provider);
		for (const account of authStorage.sessions.accounts(provider)) {
			const ref = { provider, account };
			const policy = policies.find(entry => matchesPolicy(entry, ref));
			rows.push({
				...ref,
				label: accountLabel(account),
				...(policy?.priority !== undefined ? { priority: policy.priority } : {}),
				...(policy?.reservePct !== undefined ? { reservePct: policy.reservePct } : {}),
				drain: policy?.drain === true,
				...(policy?.spend !== undefined ? { spend: policy.spend } : {}),
				...(policy?.returnWhen !== undefined ? { returnWhen: [policy.returnWhen].flat() } : {}),
				...(policy?.returnMargin !== undefined ? { returnMargin: policy.returnMargin } : {}),
				...(policy?.returnCooldownMs !== undefined ? { returnCooldownMs: policy.returnCooldownMs } : {}),
				limits: accountLimitViews(provider, account, policy?.limits, ledger, nowMs),
				projectPinned: pinnedName !== undefined && account.name === pinnedName,
			});
		}
	}
	return rows;
}

/** Result of a logout: project pins that still name the removed account and now fail closed. */
export interface LogoutResult extends AccountWriteResult {
	pinnedProjects: string[];
}

/**
 * Log an account out: drop the user-config policies that name it, so the
 * remaining accounts still satisfy policy validation, then delete the stored
 * credential. Any failure restores the user-config policies.
 *
 * @throws AccountAdminError when the credential is no longer stored, or a
 * project or overlay policy names the account (it must be removed there first).
 */
export async function logoutAccount(
	settings: Settings,
	authStorage: AuthStorage,
	ref: AccountRef,
): Promise<LogoutResult> {
	const provenance = cfgAuthAccountPolicies.provenance(settings);
	if (
		provenance !== "global" &&
		provenance !== "default" &&
		cfgAuthAccountPolicies.get(settings).some(policy => matchesPolicy(policy, ref))
	) {
		throw new AccountAdminError(
			`auth.accountPolicies in the ${provenance} layer names ${accountLabel(ref.account)}; remove that entry before logging out.`,
		);
	}
	const current = userPolicies(settings);
	const next = current.filter(policy => !matchesPolicy(policy, ref));
	const policiesChanged = next.length !== current.length;
	try {
		if (policiesChanged) {
			cfgAuthAccountPolicies.set(settings, next);
			authStorage.setAccountPolicies(await loadEffectiveAuthAccountPolicyConfig({ settings }));
		}
		const removed = await authStorage.credentials.removeById(ref.provider, ref.account.credentialId);
		if (!removed)
			throw new AccountAdminError(`${accountLabel(ref.account)} is no longer stored for ${ref.provider}.`);
	} catch (error) {
		if (policiesChanged) {
			cfgAuthAccountPolicies.set(settings, current);
			try {
				authStorage.setAccountPolicies(await loadEffectiveAuthAccountPolicyConfig({ settings }));
			} catch (restoreError) {
				logger.warn("Could not re-apply account policies after a failed logout", { error: String(restoreError) });
			}
		}
		if (error instanceof AccountAdminError) throw error;
		throw new AccountAdminError(`Logout failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	const pinnedProjects: string[] = [];
	const name = ref.account.name;
	if (name !== undefined) {
		for (const location of userPinLocations(settings).values()) {
			if (location.pins[ref.provider] === name) pinnedProjects.push(location.dir);
		}
	}
	return { pinnedProjects };
}
