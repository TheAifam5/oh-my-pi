/**
 * Account administration shared by `omp account` and the `/account` selector:
 * naming accounts and setting their priority or reserve (`auth.accountPolicies`
 * in the user config), pinning a project to an account (`auth.accountPins`),
 * and logging an account out.
 *
 * Every write goes to the user (global) config layer only and is validated
 * against the stored credentials before it is applied.
 */

import * as path from "node:path";
import type { AuthAccountPolicies, AuthAccountPolicy, AuthAccountSelector } from "@oh-my-pi/pi-ai/auth-storage";
import { AccountPolicies, matchesAuthAccountSelector } from "@oh-my-pi/pi-ai/auth/policy";
import { isRecord, logger } from "@oh-my-pi/pi-utils";
import { cfgAuthAccountPins, cfgAuthAccountPolicies } from "../config/model-settings";
import type { Settings } from "../config/settings";
import { canonicalDir, projectAccountPin } from "./account-pins";
import { loadEffectiveAuthAccountPolicyConfig } from "./auth-broker-config";
import type { AuthAccountSummary, AuthStorage } from "./auth-storage";
import { cfgRetryUsageReservePct } from "./settings";

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
	/** True when `auth.accountPins` pins this account for the working directory's project. */
	projectPinned: boolean;
}

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

/** Result of a write: the user-facing warning, if any. */
export interface AccountWriteResult {
	warning?: string;
}

function writePolicy(
	settings: Settings,
	authStorage: AuthStorage,
	ref: AccountRef,
	patch: Partial<Pick<AuthAccountPolicy, "name" | "priority" | "reservePct">>,
): AccountWriteResult {
	const current = userPolicies(settings);
	const index = current.findIndex(policy => matchesPolicy(policy, ref));
	const next = [...current];
	const base = index === -1 ? { provider: ref.provider, account: selectorFor(authStorage, ref) } : current[index]!;
	const updated = { ...base, ...patch };
	if (index === -1) next.push(updated);
	else next[index] = updated;
	try {
		const policies = new AccountPolicies(next, cfgRetryUsageReservePct.get(settings));
		policies.validateFor(
			ref.provider,
			authStorage.credentials.list(ref.provider).map(row => row.credential),
		);
	} catch (error) {
		throw new AccountAdminError(error instanceof Error ? error.message : String(error));
	}
	cfgAuthAccountPolicies.set(settings, next);
	return { warning: shadowWarning(settings) };
}

/** Name an account (`auth.accountPolicies[].name`); names are unique per provider. */
export function labelAccount(
	settings: Settings,
	authStorage: AuthStorage,
	ref: AccountRef,
	name: string,
): AccountWriteResult {
	return writePolicy(settings, authStorage, ref, { name });
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
	if (authStorage.usage.providerFor(ref.provider) === undefined) {
		throw new AccountAdminError(`${ref.provider} reports no usage, so a reserve cannot be enforced.`);
	}
	return writePolicy(settings, authStorage, ref, { reservePct });
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
	const dirs = new Set(ancestorDirs(cwd));
	const shadowedBy = settings
		.getLayerValues(cfgAuthAccountPins)
		.filter(({ source, value }) => {
			if (source === "global" || source === "project" || !isRecord(value)) return false;
			return Object.entries(value).some(([key, entry]) => dirs.has(canonicalDir(key)) && covers(stringPins(entry)));
		})
		.map(({ source }) => source);
	return { removed, ...(location ? { projectDir: location.dir } : {}), shadowedBy };
}

/** Every stored account with its name, policy, label, and project pin mark for `cwd`. */
export function listAccounts(settings: Settings, authStorage: AuthStorage, cwd: string): AccountListing[] {
	const policies = cfgAuthAccountPolicies.get(settings);
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
