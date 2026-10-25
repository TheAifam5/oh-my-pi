import * as path from "node:path";
import {
	RESET_AUTO_REDEEM_MODES,
	RESET_ON_WINDOWS,
	type ResetAutoRedeemOverride,
	type ResetOnWindow,
} from "@oh-my-pi/pi-ai/auth-storage";
import { resolveUsedFraction, type UsageLimit, type UsageReport } from "@oh-my-pi/pi-ai/usage";
import type { AccountLimit } from "@oh-my-pi/pi-ai/usage/limits";
import type {
	AccountManagerAccount,
	AccountManagerAction,
	AccountManagerDeps,
	AccountManagerField,
	AccountManagerPage,
	AccountManagerResult,
} from "@oh-my-pi/pi-tui/overlays/account-manager";
import { parseModelString } from "@oh-my-pi/pi-tui/overlays/model-selector";
import {
	collapseSharedUsageReports,
	formatLimitTitle,
	summarizeUsageResetCredits,
} from "@oh-my-pi/pi-tui/overlays/usage-display";
import { formatAbsoluteOnlyAmount, formatUsageProjection } from "@oh-my-pi/pi-tui/prompt/usage-amounts";
import { shortenPath } from "@oh-my-pi/pi-tui/render/render-utils";
import { formatDuration, formatNumber, logger, withTimeout } from "@oh-my-pi/pi-utils";
import { GLOBAL_LIMIT_KEY } from "../config/local-limits";
import { cfgAuthAccountPolicies } from "../config/model-settings";
import type { Settings } from "../config/settings";
import {
	type AccountListing,
	type AccountRef,
	accountLimits,
	accountPolicyWriteBlocker,
	formatAccountLimitSpec,
	globalLimitWriteBlocker,
	labelAccount,
	listAccounts,
	listGlobalLimits,
	listPoolMembers,
	listProjectPins,
	type PoolMemberListing,
	type PoolMemberRef,
	parseAccountLimitSpec,
	pinProjectAccount,
	poolMemberPath,
	projectDirPinWriteBlocker,
	projectPinWriteBlocker,
	setAccountDrain,
	setAccountLimits,
	setAccountPriority,
	setAccountReserve,
	setAccountResets,
	setAccountReturn,
	setAccountEnabled,
	setGlobalLimits,
	setPoolMemberAccount,
	setProjectDirPin,
	unpinProjectAccount,
	userGlobalLimits,
} from "../session/account-admin";
import { canonicalDir } from "../session/account-pins";
import type { SessionPinOutcome, SessionUnpinOutcome } from "../session/agent-session-types";
import { loadEffectiveAuthAccountPolicyConfig } from "../session/auth-broker-config";
import type { AuthStorage } from "../session/auth-storage";
import { configuredLimitTargets, formatLimitUsage, limitStatus } from "../session/local-limits";
import { DEFAULT_GROUP_OBSERVATION_MAX_AGE_MS, providerBillingResults } from "../session/retry-fallback-groups";
import { describeSessionPinOutcome, describeSessionUnpinOutcome } from "../slash-commands/helpers/session-pin";
import { reportIdentifiers } from "../slash-commands/helpers/usage-accounts";

/** The session the manager pins accounts for. */
export interface AccountManagerSession {
	readonly sessionId: string;
	pinProviderAccount(provider: string, credentialId: number): SessionPinOutcome;
	unpinProviderAccount(provider: string): SessionUnpinOutcome;
}

/** Host state the account manager reads and writes. */
export interface AccountManagerHost {
	settings: Settings;
	authStorage: AuthStorage;
	cwd: () => string;
	/** Without it, session pins are shown read-only. */
	session?: AccountManagerSession;
	/** Usage reports already held by the session; it must not fetch. Without it no billing is shown. */
	usageReports?: () => readonly UsageReport[] | undefined;
}

const NAME_HINT = "Account name: lowercase letters, digits, - and _";
const DEFAULT_LIMIT_SPEC = "usd 5 day skip";
const LIMIT_HINT =
	"<usd|requests|tokens> <max> <day|week|month|Nm|Nh|Nd> [warn|skip], or <usage|credits|extra-usd> <max>";
const GLOBAL_LIMIT_HINT = "<usd|requests|tokens> <max> <day|week|month|Nm|Nh|Nd> [warn|skip]";
const NEW_SCOPE_HINT = `<provider/model|provider|*> ${GLOBAL_LIMIT_HINT}`;
const SPEND_CLASSES = ["credits", "money"] as const;
const RETURN_TRIGGERS = ["reset", "credits-added", "money-available"] as const;
/** `autoRedeem` choices: the override modes, then `inherit` (no override). */
const AUTO_REDEEM_CHOICES = [...RESET_AUTO_REDEEM_MODES, "inherit"] as const;
const MINUTE_MS = 60_000;
/** Longest wait on the credential store or the policy loader before the manager gives up, in ms. */
export const STORE_TIMEOUT_MS = 10_000;
export const STORE_TIMEOUT_MESSAGE = "Timed out reading the credential store";
/** Actions applied with a target state (`on` or `off`) rather than typed text. */
const TOGGLES =
	/^(?:enabled|drain|pin-session|pin-project|spend:.*|return:(?:reset|credits-added|money-available)|reset-on:.*|pool:.*)$/;
/** Row id prefix of the global limits page: the `limits` key follows. */
const LIMITS_ROW = "limits:";
/** Row id of the global limits page's row that adds a new key. */
const LIMITS_NEW_ROW = "limits+";
/** Row id prefix of the project pins page: `[source, dir, provider]` as JSON follows. */
const PIN_ROW = "pin:";

function accountId(row: Pick<AccountListing, "provider" | "account">): string {
	return `${row.provider}#${row.account.credentialId}`;
}

function memberActionId(member: PoolMemberRef): string {
	return `pool:${JSON.stringify([member.kind, member.key, member.alias])}`;
}

/** Edit and remove actions for each of `limits`, then add, in the limit spec grammar; `expect` is the shown spec. */
function limitActions(limits: readonly AccountLimit[], hint: string, initial: string): AccountManagerAction[] {
	const actions: AccountManagerAction[] = limits.flatMap((limit, index) => {
		const spec = formatAccountLimitSpec(limit);
		const label = "id" in limit && limit.id !== undefined ? `${spec} (id ${limit.id})` : spec;
		return [
			{ id: `limit:edit:${index}`, label: `edit ${label}`, input: { initial: spec, hint }, expect: spec },
			{ id: `limit:remove:${index}`, label: `remove ${label}`, expect: spec },
		];
	});
	actions.push({ id: "limit:add", label: "add…", input: { initial, hint } });
	return actions;
}

/**
 * `limits` after the `limit:add`, `limit:edit:<i>`, or `limit:remove:<i>` action with the typed
 * spec `value`, or the refusal; an edited limit keeps its `id`.
 *
 * @throws AccountAdminError when `value` is not a limit spec.
 */
function nextLimits(
	limits: readonly AccountLimit[],
	actionId: string,
	value: string,
	expect: string | undefined,
): unknown[] | { error: string } {
	const match = /^limit:(?:(add)|(edit|remove):(0|[1-9]\d*))$/.exec(actionId);
	const index = match?.[3] === undefined ? undefined : Number(match[3]);
	if (!match || (index !== undefined && index >= limits.length)) {
		return { error: `Unknown limit action: ${actionId}` };
	}
	if (index !== undefined && formatAccountLimitSpec(limits[index]!) !== expect) {
		return { error: "That limit changed since it was shown; reload with ctrl+r." };
	}
	const next: unknown[] = [...limits];
	if (match[1]) next.push(parseAccountLimitSpec(value));
	else if (match[2] === "edit") {
		const edited = limits[index!]!;
		const id = "id" in edited ? edited.id : undefined;
		next[index!] = { ...(id === undefined ? {} : { id }), ...parseAccountLimitSpec(value) };
	} else next.splice(index!, 1);
	return next;
}

/**
 * Whether `report` positively names `account`: one of its email, account id, or project id is
 * among the report's identifiers, and their organizations agree when either side carries one. A
 * report without identity is attributed to no account.
 */
function reportNamesAccount(report: UsageReport, account: AccountListing["account"]): boolean {
	const ids = [account.email, account.accountId, account.projectId]
		.filter((value): value is string => typeof value === "string" && value.length > 0)
		.map(value => value.toLowerCase());
	const identifiers = reportIdentifiers(report);
	if (!ids.some(id => identifiers.has(id))) return false;
	const reportOrg = typeof report.metadata?.orgId === "string" ? report.metadata.orgId.toLowerCase() : undefined;
	return (account.orgId?.toLowerCase() || undefined) === (reportOrg || undefined);
}

function accountUsageLimit(limit: UsageLimit, nowMs: number): string {
	const { amount, window } = limit;
	const fraction = resolveUsedFraction(limit);
	const remaining =
		amount.remaining ??
		(amount.limit !== undefined
			? amount.used !== undefined
				? amount.limit - amount.used
				: fraction !== undefined
					? amount.limit * Math.max(0, 1 - fraction)
					: undefined
			: undefined);
	let value: string | undefined;
	if (amount.unit !== "percent" && amount.limit !== undefined && remaining !== undefined) {
		value = `${formatNumber(Math.max(0, remaining))}/${formatNumber(amount.limit)} ${amount.currency ?? amount.unit} left`;
	} else if (fraction !== undefined) {
		value =
			limit.status === "exhausted" || fraction >= 1
				? "exhausted"
				: `${Number((Math.max(0, 1 - fraction) * 100).toFixed(1))}% left`;
	} else {
		value = formatAbsoluteOnlyAmount([limit]) ?? (limit.status === "exhausted" ? "exhausted" : "unknown");
	}
	const title = window?.label ?? formatLimitTitle(limit);
	const parts = [`${title} ${value}`];
	const projection = formatUsageProjection(limit, nowMs);
	if (projection) parts.push(projection);
	if (window?.resetsAt !== undefined) {
		parts.push(`${window.resetLabel ?? "resets"} in ${formatDuration(Math.max(0, window.resetsAt - nowMs))}`);
	}
	return parts.join(" · ");
}

/** Usage from reports naming this OAuth account, or the provider's only stored API key. */
function accountBilling(
	row: AccountListing,
	reports: readonly UsageReport[],
	providerAccountCount: number,
): { summary?: string; models: string[] } {
	const { account, provider } = row;
	const nowMs = Date.now();
	const own = collapseSharedUsageReports(
		reports.filter(
			report =>
				report.provider === provider &&
				(account.type === "api_key" ? providerAccountCount === 1 : reportNamesAccount(report, account)),
		),
	);
	const parts = new Set<string>();
	const models = new Set<string>();
	for (const report of own) {
		const stale =
			nowMs - report.fetchedAt > DEFAULT_GROUP_OBSERVATION_MAX_AGE_MS
				? ` · fetched ${formatDuration(nowMs - report.fetchedAt)} ago`
				: "";
		for (const limit of report.limits) {
			const line = accountUsageLimit(limit, nowMs) + stale;
			if (!limit.scope.modelId && (limit.scope.shared || !limit.scope.tier)) parts.add(line);
			else models.add(`${limit.scope.modelId ?? limit.scope.tier} · ${line}`);
		}
		const resets = summarizeUsageResetCredits(report.resetCredits, nowMs);
		if (resets) parts.add(`${resets.bankedCount} saved reset${resets.bankedCount === 1 ? "" : "s"}${stale}`);
	}
	const hasNumbers = parts.size > 0;
	for (const result of providerBillingResults(provider, own, nowMs, DEFAULT_GROUP_OBSERVATION_MAX_AGE_MS)) {
		if (result.status === "unknown") {
			if (!hasNumbers && result.reason !== "no-reader") parts.add(`unknown (${result.reason})`);
		} else {
			for (const source of result.snapshot.sources) {
				if (source.state === "disabled") parts.add("extra usage disabled");
				else if (!hasNumbers && source.state === "exhausted") parts.add("exhausted");
			}
		}
	}
	if (parts.size === 0 && own.length > 0) parts.add("unknown (no-report)");
	return { summary: parts.size > 0 ? [...parts].join(", ") : undefined, models: [...models] };
}

function limitLine(limit: AccountListing["limits"][number]): string {
	if ("window" in limit) return formatLimitUsage(limit, Date.now());
	return `${limit.metric} ${limit.max} (provider evidence)${limit.onLimit === "warn" ? " · warn only" : ""}`;
}

function minutes(ms: number): string {
	return `${Number((ms / MINUTE_MS).toFixed(2))} min`;
}

/** A successful write's confirmation `message` with the write's warning, if any. */
function written(message: string, result: { warning?: string }): AccountManagerResult {
	return { message, ...(result.warning ? { warning: result.warning } : {}) };
}

/** Supply the `/account` manager with stored accounts and apply its edits through account-admin. */
export function createAccountManagerDeps(host: AccountManagerHost): AccountManagerDeps {
	const { settings, authStorage, cwd, session } = host;

	const sessionPinned = (provider: string): Set<number> => {
		if (!session) return new Set();
		return new Set(
			authStorage.sessions
				.accounts(provider, session.sessionId)
				.filter(account => account.pinned)
				.map(account => account.credentialId),
		);
	};

	const fieldsFor = (
		row: AccountListing,
		members: readonly PoolMemberListing[],
		pinnedForSession: boolean,
	): AccountManagerField[] => {
		const policyReadOnly = accountPolicyWriteBlocker(settings);
		const oauthOnly = row.account.type === "oauth" ? policyReadOnly : "applies to OAuth accounts only";
		const drainedOnly = row.drain ? policyReadOnly : "drain this account first";
		const spend = row.spend ?? ["plan"];
		const returnWhen = row.returnWhen ?? ["reset"];
		const name = row.account.name;
		let limits: AccountLimit[] = [];
		let limitsInvalid: string | undefined;
		try {
			limits = accountLimits(settings, row);
		} catch (error) {
			limitsInvalid = error instanceof Error ? error.message : String(error);
		}
		const providerMembers = members.filter(member => parseModelString(member.model)?.provider === row.provider);
		const autoRedeem = row.autoRedeem ?? "inherit";
		return [
			{
				id: "name",
				label: "name",
				key: "n",
				value: name ?? "unnamed",
				input: { initial: name ?? "", hint: NAME_HINT },
				readOnly: policyReadOnly,
			},
			{
				id: "priority",
				label: "priority",
				key: "p",
				value: row.priority === undefined ? "default" : String(row.priority),
				input: {
					initial: row.priority === undefined ? "" : String(row.priority),
					hint: "Priority: a number; higher wins",
				},
				readOnly: policyReadOnly,
			},
			{
				id: "reserve",
				label: "reserve",
				key: "r",
				value: row.reservePct === undefined ? "default" : `${row.reservePct}%`,
				input: {
					initial: row.reservePct === undefined ? "" : String(row.reservePct),
					hint: "Reserve: percent of quota kept back, 0-100",
				},
				readOnly: oauthOnly,
			},
			{ id: "drain", label: "drain", key: "d", value: row.drain ? "on" : "off", on: row.drain, readOnly: oauthOnly },
			{
				id: "spend",
				label: "spend",
				key: "f",
				value: spend.join(", "),
				readOnly: drainedOnly,
				choices: SPEND_CLASSES.map(spendClass => ({
					id: `spend:${spendClass}`,
					label: spendClass,
					on: spend.includes(spendClass),
				})),
			},
			{
				id: "return",
				label: "return",
				key: "t",
				value: [
					returnWhen.join(", "),
					row.returnMargin === undefined ? undefined : `margin ${row.returnMargin}%`,
					row.returnCooldownMs === undefined ? undefined : `cooldown ${minutes(row.returnCooldownMs)}`,
				]
					.filter(Boolean)
					.join(" · "),
				readOnly: drainedOnly,
				choices: [
					...RETURN_TRIGGERS.map(trigger => ({
						id: `return:${trigger}`,
						label: trigger,
						on: returnWhen.includes(trigger),
					})),
					{
						id: "return:margin",
						label: "margin…",
						input: {
							initial: row.returnMargin === undefined ? "" : String(row.returnMargin),
							hint: "Return margin: percent of quota back, 0-100 (empty: default 5)",
						},
					},
					{
						id: "return:cooldown",
						label: "cooldown…",
						input: {
							initial: row.returnCooldownMs === undefined ? "" : String(row.returnCooldownMs / MINUTE_MS),
							hint: "Return cooldown in minutes (empty: default 10)",
						},
					},
				],
			},
			{
				id: "reset-on",
				label: "resets on",
				key: "w",
				value: row.resetOn === undefined ? "any" : row.resetOn.join(", "),
				readOnly: oauthOnly,
				choices: [
					...RESET_ON_WINDOWS.map(window => ({
						id: `reset-on:${window}`,
						label: window,
						on: row.resetOn?.includes(window) === true,
					})),
					{ id: "reset-on:any", label: "any", on: row.resetOn === undefined },
				],
			},
			{
				id: "auto-redeem",
				label: "auto-redeem",
				key: "a",
				value: autoRedeem,
				readOnly: oauthOnly,
				choices: AUTO_REDEEM_CHOICES.map(mode => ({
					id: `auto-redeem:${mode}`,
					label: mode,
					on: autoRedeem === mode,
					expect: autoRedeem,
				})),
			},
			{
				id: "pin-session",
				label: "session pin",
				key: "s",
				value: pinnedForSession ? "on" : "off",
				on: pinnedForSession,
				readOnly: session ? undefined : "no session to pin",
			},
			{
				id: "pin-project",
				label: "project pin",
				key: "j",
				value: row.projectPinned ? "on" : "off",
				on: row.projectPinned,
				readOnly: policyReadOnly ?? projectPinWriteBlocker(settings, cwd(), row.provider),
			},
			{
				id: "pool",
				label: "pool member",
				key: "o",
				value: `${providerMembers.filter(member => name !== undefined && member.account === name).length} of ${providerMembers.length}`,
				readOnly: providerMembers.length === 0 ? `no pool member uses ${row.provider}` : policyReadOnly,
				choices: providerMembers.map(member => ({
					id: memberActionId(member),
					label: `${poolMemberPath(member)} (${member.model})`,
					on: name !== undefined && member.account === name,
					...(member.readOnly ? { readOnly: member.readOnly } : {}),
				})),
			},
			{
				id: "enabled",
				label: "enabled",
				key: "e",
				value: row.account.disabled ? "off" : "on",
				on: row.account.disabled !== true,
				...(row.account.disabled ? {} : { confirm: "Disable account? No request will use it" }),
			},
			{
				id: "limits",
				label: "limits",
				key: "l",
				value: limitsInvalid ? "invalid" : String(limits.length),
				readOnly: limitsInvalid ?? policyReadOnly,
				choices: limitActions(limits, LIMIT_HINT, DEFAULT_LIMIT_SPEC),
			},
		];
	};

	const load = (): AccountManagerAccount[] => {
		const rows = listAccounts(settings, authStorage, cwd());
		const members = listPoolMembers(settings);
		const reports = host.usageReports?.();
		const pinnedByProvider = new Map<string, Set<number>>();
		const countByProvider = new Map<string, number>();
		for (const row of rows) countByProvider.set(row.provider, (countByProvider.get(row.provider) ?? 0) + 1);
		return rows.map(row => {
			let pinned = pinnedByProvider.get(row.provider);
			if (!pinned) {
				pinned = sessionPinned(row.provider);
				pinnedByProvider.set(row.provider, pinned);
			}
			const pinnedForSession = pinned.has(row.account.credentialId) && !row.projectPinned;
			const name = row.account.name;
			const poolMembership = members
				.filter(
					member =>
						name !== undefined &&
						member.account === name &&
						parseModelString(member.model)?.provider === row.provider,
				)
				.map(poolMemberPath);
			const billing = reports ? accountBilling(row, reports, countByProvider.get(row.provider) ?? 0) : undefined;
			const pins = [
				pinnedForSession ? "session" : undefined,
				row.projectPinned ? `project (${shortenPath(cwd())})` : undefined,
				...poolMembership.map(path => `pool ${path}`),
			].filter((pin): pin is string => pin !== undefined);
			const details: AccountManagerAccount["details"] = [
				{ label: "type", value: row.account.type === "oauth" ? "OAuth" : "API key" },
				{
					label: "state",
					value: row.account.disabled ? "disabled (no request uses it)" : "enabled",
					tone: row.account.disabled ? "error" : "dim",
				},
				{ label: "priority", value: row.priority === undefined ? "default" : String(row.priority) },
				{ label: "reserve", value: row.reservePct === undefined ? "default" : `${row.reservePct}%` },
				{
					label: "drain",
					value: row.drain
						? `drained first · spend ${(row.spend ?? ["plan"]).join(", ")} · returns on ${(row.returnWhen ?? ["reset"]).join(", ")}${row.returnMargin === undefined ? "" : ` · margin ${row.returnMargin}%`}${row.returnCooldownMs === undefined ? "" : ` · cooldown ${minutes(row.returnCooldownMs)}`}`
						: "off",
					tone: row.drain ? "success" : "dim",
				},
				{
					label: "pins",
					value: pins.length > 0 ? pins.join(", ") : "none",
					tone: pins.length > 0 ? "success" : "dim",
				},
				...(row.limits.length > 0
					? row.limits.map(limit => ({ label: "limit", value: limitLine(limit) }))
					: [{ label: "limits", value: "none", tone: "dim" as const }]),
			];
			if (billing?.summary !== undefined) details.push({ label: "billing", value: billing.summary });
			for (const value of billing?.models ?? []) details.push({ label: "model usage", value });
			if (row.resetOn !== undefined || row.autoRedeem !== undefined) {
				details.push({
					label: "resets",
					value: [
						row.resetOn === undefined ? undefined : `on ${row.resetOn.join(", ")}`,
						row.autoRedeem === undefined ? undefined : `auto-redeem ${row.autoRedeem}`,
					]
						.filter(Boolean)
						.join(" · "),
				});
			}
			const readOnly = accountPolicyWriteBlocker(settings);
			if (readOnly) details.push({ label: "policy", value: `${readOnly}; shown read-only`, tone: "warning" });
			return {
				id: accountId(row),
				provider: row.provider,
				...(name !== undefined ? { name } : {}),
				identity: row.label,
				badges: [
					billing?.summary,
					row.priority !== undefined ? `priority ${row.priority}` : undefined,
					row.reservePct !== undefined ? `reserve ${row.reservePct}%` : undefined,
					row.drain ? "drain" : undefined,
					row.account.disabled ? "disabled" : undefined,
					pinnedForSession ? "session pin" : undefined,
					row.projectPinned ? "project pin" : undefined,
					poolMembership.length > 0 ? "pool" : undefined,
					row.limits.length > 0 ? `${row.limits.length} limit${row.limits.length === 1 ? "" : "s"}` : undefined,
				].filter((badge): badge is string => badge !== undefined),
				facts: {
					type: row.account.type === "oauth" ? "OAuth" : "API key",
					state: row.account.disabled ? "disabled" : row.drain ? "drained first" : "enabled",
					billing: billing?.summary ?? "",
					routing: [
						row.priority !== undefined ? `priority ${row.priority}` : undefined,
						row.reservePct !== undefined ? `reserve ${row.reservePct}%` : undefined,
					]
						.filter(Boolean)
						.join(" · "),
					pins: [
						pinnedForSession ? "session" : undefined,
						row.projectPinned ? "project" : undefined,
						...poolMembership.map(path => `pool ${path}`),
					]
						.filter(Boolean)
						.join(", "),
					limits: row.limits.map(formatAccountLimitSpec).join(", "),
				},
				details,
				fields: fieldsFor(row, members, pinnedForSession),
			};
		});
	};

	const run = (
		row: AccountListing,
		actionId: string,
		value: string,
		expect: string | undefined,
	): AccountManagerResult => {
		const ref: AccountRef = { provider: row.provider, account: row.account };
		const label = row.account.name ?? row.label;
		const name = row.account.name;
		// Project pins and pool members address accounts by policy name, so they follow the policy layer too.
		const policyBlocker = accountPolicyWriteBlocker(settings);
		const policyAction =
			["name", "priority", "reserve", "drain", "pin-project"].includes(actionId) ||
			/^(spend|return|reset-on|auto-redeem|limit|pool):/.test(actionId);
		if (policyAction && policyBlocker) return { error: `${policyBlocker}; change it there.` };
		if (TOGGLES.test(actionId) && value !== "on" && value !== "off") {
			return { error: "A toggle needs its target state (on or off)." };
		}
		const on = value === "on";
		const number = (what: string): number => {
			const parsed = Number(value.replace(/%$/, ""));
			if (value === "" || !Number.isFinite(parsed)) throw new Error(`${what} must be a number.`);
			return parsed;
		};
		const optionalNumber = (what: string): number | undefined => (value === "" ? undefined : number(what));
		const toggled = <T extends string>(current: readonly T[], entry: T): T[] =>
			on ? [...new Set([...current, entry])] : current.filter(candidate => candidate !== entry);
		if (actionId === "name") {
			if (!value) return { error: "Enter a name." };
			return written(`Named ${row.label} "${value}".`, labelAccount(settings, authStorage, ref, value));
		}
		if (actionId === "priority") {
			const priority = number("Priority");
			return written(
				`Set priority ${priority} for ${label}.`,
				setAccountPriority(settings, authStorage, ref, priority),
			);
		}
		if (actionId === "reserve") {
			const reserve = number("Reserve");
			return written(
				`Set reserve ${reserve}% for ${label}.`,
				setAccountReserve(settings, authStorage, ref, reserve),
			);
		}
		if (actionId === "drain") {
			if (on === row.drain) return { message: `${label} is already ${on ? "drained first" : "not drained"}.` };
			const displaced = on
				? listAccounts(settings, authStorage, cwd()).find(
						other => other.provider === row.provider && other.drain && accountId(other) !== accountId(row),
					)
				: undefined;
			const result = setAccountDrain(settings, authStorage, row.provider, on ? ref : undefined);
			const message = on ? `${label} is drained first.` : `${label} is no longer drained first.`;
			return written(
				displaced ? `${message} ${displaced.account.name ?? displaced.label} no longer is.` : message,
				result,
			);
		}
		if ((actionId.startsWith("spend:") || actionId.startsWith("return:")) && !row.drain) {
			return { error: `Drain ${label} first.` };
		}
		const spendClass = SPEND_CLASSES.find(candidate => actionId === `spend:${candidate}`);
		if (spendClass) {
			const spend = toggled(row.spend ?? ["plan"], spendClass);
			const next = spend.includes("plan") ? spend : ["plan" as const, ...spend];
			return written(
				`${label} spends ${next.join(", ")}.`,
				setAccountDrain(settings, authStorage, row.provider, ref, { spend: next }),
			);
		}
		if (actionId === "return:margin") {
			const returnMargin = optionalNumber("Return margin");
			return written(
				`Return margin for ${label}: ${returnMargin === undefined ? "default" : `${returnMargin}%`}.`,
				setAccountReturn(settings, authStorage, ref, { returnMargin }),
			);
		}
		if (actionId === "return:cooldown") {
			const cooldown = optionalNumber("Return cooldown");
			return written(
				`Return cooldown for ${label}: ${cooldown === undefined ? "default" : `${cooldown} min`}.`,
				setAccountReturn(settings, authStorage, ref, {
					returnCooldownMs: cooldown === undefined ? undefined : Math.round(cooldown * MINUTE_MS),
				}),
			);
		}
		const trigger = RETURN_TRIGGERS.find(candidate => actionId === `return:${candidate}`);
		if (trigger) {
			const next = toggled(row.returnWhen ?? ["reset"], trigger);
			const returnWhen = next.length > 0 ? next : ["reset" as const];
			return written(
				`${label} returns on ${returnWhen.join(", ")}.`,
				setAccountDrain(settings, authStorage, row.provider, ref, { returnWhen }),
			);
		}
		const resetWindow = RESET_ON_WINDOWS.find(candidate => actionId === `reset-on:${candidate}`);
		if (resetWindow || actionId === "reset-on:any") {
			let resetOn: readonly ResetOnWindow[] | undefined;
			if (resetWindow) {
				const next = toggled(row.resetOn ?? [], resetWindow);
				resetOn = next.length > 0 ? RESET_ON_WINDOWS.filter(window => next.includes(window)) : undefined;
			} else if (!on) {
				return { error: `Choose ${RESET_ON_WINDOWS.join(" or ")} to limit the windows ${label} resets on.` };
			}
			return written(
				`${label} resets on ${resetOn === undefined ? "any window" : resetOn.join(", ")}.`,
				setAccountResets(settings, authStorage, ref, { resetOn }),
			);
		}
		const autoRedeemChoice = AUTO_REDEEM_CHOICES.find(candidate => actionId === `auto-redeem:${candidate}`);
		if (autoRedeemChoice) {
			const current = row.autoRedeem ?? "inherit";
			if (expect !== undefined && expect !== current) {
				return { error: "Auto-redeem changed since it was shown; reload with ctrl+r." };
			}
			if (autoRedeemChoice === current) return { message: `${label} auto-redeem is already ${current}.` };
			const autoRedeem: ResetAutoRedeemOverride | undefined =
				autoRedeemChoice === "inherit" ? undefined : autoRedeemChoice;
			return written(
				`${label} auto-redeem: ${autoRedeemChoice}.`,
				setAccountResets(settings, authStorage, ref, { autoRedeem }),
			);
		}
		if (actionId.startsWith("limit:")) {
			const next = nextLimits(accountLimits(settings, ref), actionId, value, expect);
			if (!Array.isArray(next)) return next;
			return written(
				`${label} has ${next.length} limit${next.length === 1 ? "" : "s"}.`,
				setAccountLimits(settings, authStorage, ref, next),
			);
		}
		if (actionId === "pin-session") {
			if (!session) return { error: "No session to pin." };
			const pinned = sessionPinned(row.provider).has(row.account.credentialId) && !row.projectPinned;
			if (on === pinned) return { message: `${label} is already ${on ? "pinned" : "not pinned"} to this session.` };
			if (on && row.projectPinned) {
				return { error: `${label} is already pinned for this project; a session pin would not change it.` };
			}
			if (!on) {
				const outcome = session.unpinProviderAccount(row.provider);
				const message = describeSessionUnpinOutcome(outcome, row.provider);
				return outcome === "unpinned" ? { message } : { error: message };
			}
			const outcome = session.pinProviderAccount(row.provider, row.account.credentialId);
			const message = describeSessionPinOutcome(outcome, row.label, row.provider);
			return outcome === "pinned" ? { message } : { error: message };
		}
		if (actionId === "pin-project") {
			const blocker = projectPinWriteBlocker(settings, cwd(), row.provider);
			if (blocker) return { error: `${blocker}; change it there.` };
			if (on === row.projectPinned) {
				return { message: `${label} is already ${on ? "pinned" : "not pinned"} for this project.` };
			}
			if (!on) {
				const result = unpinProjectAccount(settings, cwd(), row.provider);
				return result.removed > 0 && result.projectDir
					? { message: `Removed the ${row.provider} pin of ${shortenPath(result.projectDir)}.` }
					: { error: "No project pin in the user config covers this directory." };
			}
			if (name === undefined) return { error: "Name this account first (n)." };
			const result = pinProjectAccount(settings, authStorage, cwd(), `${row.provider}/${name}`);
			return written(`Pinned ${row.provider} to "${result.name}" for ${shortenPath(result.projectDir)}.`, result);
		}
		if (actionId.startsWith("pool:")) {
			if (name === undefined) return { error: "Name this account first (n)." };
			const member = listPoolMembers(settings).find(candidate => memberActionId(candidate) === actionId);
			if (!member) return { error: "That pool member is no longer configured." };
			if (parseModelString(member.model)?.provider !== row.provider) {
				return { error: `${poolMemberPath(member)} does not use ${row.provider}.` };
			}
			if (on === (member.account === name)) {
				return { message: `${poolMemberPath(member)} already ${on ? "prefers" : "does not prefer"} ${name}.` };
			}
			setPoolMemberAccount(settings, member, on ? name : undefined);
			return {
				message: on
					? `${poolMemberPath(member)} tries ${name} first.`
					: `${poolMemberPath(member)} no longer prefers ${name}.`,
			};
		}
		return { error: `Unknown account action: ${actionId}` };
	};

	const limitsPage = (): AccountManagerPage => {
		const ledger = settings.getStorage()?.usageLedger;
		const nowMs = Date.now();
		const targets = configuredLimitTargets(settings);
		const rows: AccountManagerAccount[] = listGlobalLimits(settings).map(entry => {
			const scope =
				entry.key === GLOBAL_LIMIT_KEY
					? "every call"
					: entry.key.includes("/")
						? "calls to this model"
						: "calls to this provider";
			const usage = entry.limits.map((limit, index) => {
				const targetKey = limit.id !== undefined ? `id:${limit.id}` : `${entry.key}#${index}`;
				const target = targets.find(candidate => candidate.key === targetKey);
				return target
					? formatLimitUsage(limitStatus(ledger, target, entry.key, nowMs), nowMs)
					: formatAccountLimitSpec(limit);
			});
			const shadowed = entry.source !== "global";
			return {
				id: `${LIMITS_ROW}${entry.key}`,
				provider: "",
				name: entry.key,
				identity: scope,
				badges: [
					entry.invalid ? "invalid" : `${entry.limits.length} limit${entry.limits.length === 1 ? "" : "s"}`,
					shadowed ? entry.source : undefined,
				].filter((badge): badge is string => badge !== undefined),
				facts: {
					covers: scope,
					limits: entry.invalid ? "invalid" : usage.join(" · "),
					layer: shadowed ? entry.source : "user",
				},
				details: [
					{ label: "covers", value: scope },
					{
						label: "layer",
						value: shadowed ? `${entry.source}; shown read-only` : "user config",
						tone: shadowed ? "warning" : "dim",
					},
					...(entry.invalid
						? [{ label: "invalid", value: entry.invalid, tone: "error" as const }]
						: usage.map(value => ({ label: "limit", value }))),
				],
				fields: [
					{
						id: "limits",
						label: "limits",
						key: "l",
						value: entry.invalid ? "invalid" : String(entry.limits.length),
						readOnly: entry.invalid ?? globalLimitWriteBlocker(settings, entry.key),
						choices: limitActions(entry.limits, GLOBAL_LIMIT_HINT, DEFAULT_LIMIT_SPEC),
					},
				],
			};
		});
		const count = rows.length;
		rows.push({
			id: LIMITS_NEW_ROW,
			provider: "",
			name: "(add scope)",
			identity: "limits for a provider/model, a provider, or * (every call)",
			badges: [],
			facts: { covers: "add a scope" },
			details: [{ label: "add", value: NEW_SCOPE_HINT, tone: "dim" }],
			fields: [
				{
					id: "limit:add",
					label: "add",
					key: "a",
					value: "scope and limit",
					input: { initial: `${GLOBAL_LIMIT_KEY} ${DEFAULT_LIMIT_SPEC}`, hint: NEW_SCOPE_HINT },
				},
			],
		});
		return {
			id: "limits",
			label: "Global limits",
			empty: "No global limits.",
			rows,
			count,
			columns: [
				{ id: "covers", head: "Covers", priority: 3 },
				{ id: "limits", head: "Limits", priority: 2 },
				{ id: "layer", head: "Layer", priority: 1 },
			],
		};
	};

	const pinsPage = (): AccountManagerPage => {
		const here = canonicalDir(cwd());
		const policyReadOnly = accountPolicyWriteBlocker(settings);
		const policies = cfgAuthAccountPolicies.get(settings);
		const rows: AccountManagerAccount[] = listProjectPins(settings).map(pin => {
			const names = [
				...new Set(
					policies.flatMap(policy =>
						policy.provider === pin.provider && policy.name !== undefined ? [policy.name] : [],
					),
				),
			].sort();
			const readOnly =
				pin.source === "global"
					? (policyReadOnly ?? projectDirPinWriteBlocker(settings, pin.dir, pin.provider))
					: `set in the ${pin.source} layer`;
			const relative = path.relative(pin.dir, here);
			const coversHere = relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
			const stored = authStorage.sessions.accounts(pin.provider).some(account => account.name === pin.name);
			const shadowed = pin.source !== "global";
			return {
				id: `${PIN_ROW}${JSON.stringify([pin.source, pin.dir, pin.provider])}`,
				provider: pin.provider,
				name: shortenPath(pin.dir),
				identity: pin.name,
				badges: [
					coversHere ? "this directory" : undefined,
					shadowed ? pin.source : undefined,
					pin.shadowedBy ? `replaced by ${pin.shadowedBy}` : undefined,
					stored ? undefined : "no stored account",
				].filter((badge): badge is string => badge !== undefined),
				facts: {
					account: `${pin.provider}/${pin.name}`,
					status: [
						coversHere ? "this directory" : undefined,
						pin.shadowedBy ? `replaced by ${pin.shadowedBy}` : undefined,
						stored ? undefined : "no stored account",
					]
						.filter(Boolean)
						.join(" · "),
					layer: shadowed ? pin.source : "user",
				},
				details: [
					{ label: "directory", value: shortenPath(pin.dir) },
					{
						label: "account",
						value: stored
							? `${pin.provider}/${pin.name}`
							: `${pin.provider}/${pin.name} (not stored; requests fail)`,
						tone: stored ? "success" : "warning",
					},
					{
						label: "layer",
						value: shadowed ? `${pin.source}; shown read-only` : "user config",
						tone: shadowed ? "warning" : "dim",
					},
					...(pin.shadowedBy
						? [{ label: "replaced", value: `a ${pin.shadowedBy} pin applies instead`, tone: "warning" as const }]
						: []),
				],
				fields: [
					{
						id: "pin:account",
						label: "account",
						key: "a",
						value: pin.name,
						readOnly: readOnly ?? (names.length === 0 ? `no ${pin.provider} account has a name` : undefined),
						choices: names.map(name => ({
							id: `pin:account:${name}`,
							label: name,
							on: name === pin.name,
							expect: pin.name,
						})),
					},
					{ id: "pin:remove", label: "remove", key: "x", value: "unpin", readOnly, expect: pin.name },
				],
			};
		});
		return {
			id: "pins",
			label: "Project pins",
			empty: "No project pins. Pin the current project from an account (j).",
			rows,
			columns: [
				{ id: "account", head: "Account", priority: 3 },
				{ id: "status", head: "Status", priority: 2 },
				{ id: "layer", head: "Layer", priority: 1 },
			],
		};
	};

	/** Apply an edit to a page row; undefined when `id` names no page row. */
	const runPageRow = (
		id: string,
		actionId: string,
		value: string,
		expect: string | undefined,
	): AccountManagerResult | undefined => {
		if (id === LIMITS_NEW_ROW || id.startsWith(LIMITS_ROW)) {
			let key = id.slice(LIMITS_ROW.length);
			let spec = value;
			if (id === LIMITS_NEW_ROW) {
				if (actionId !== "limit:add") return { error: `Unknown limits action: ${actionId}` };
				const match = /^(\S+)\s+(\S.*)$/.exec(value.trim());
				if (!match) return { error: `Enter ${NEW_SCOPE_HINT}.` };
				key = match[1]!;
				spec = match[2]!;
			}
			const blocker = globalLimitWriteBlocker(settings, key);
			if (blocker) return { error: `${blocker}; change it there.` };
			const next = nextLimits(userGlobalLimits(settings, key), actionId, spec, expect);
			if (!Array.isArray(next)) return next;
			return written(
				`${key} has ${next.length} limit${next.length === 1 ? "" : "s"}.`,
				setGlobalLimits(settings, key, next),
			);
		}
		if (!id.startsWith(PIN_ROW)) return undefined;
		const parsed: unknown = JSON.parse(id.slice(PIN_ROW.length));
		if (!Array.isArray(parsed) || parsed.length !== 3 || !parsed.every(part => typeof part === "string")) {
			return { error: `Unknown pin: ${id}` };
		}
		const [source, dir, provider] = parsed as [string, string, string];
		if (source !== "global") return { error: `That pin is set in the ${source} layer; change it there.` };
		const blocker = accountPolicyWriteBlocker(settings) ?? projectDirPinWriteBlocker(settings, dir, provider);
		if (blocker) return { error: `${blocker}; change it there.` };
		const current = listProjectPins(settings).find(
			pin => pin.source === "global" && pin.dir === dir && pin.provider === provider,
		);
		if (!current) return { error: "That pin is no longer configured; reload with ctrl+r." };
		if (expect !== undefined && expect !== current.name) {
			return { error: "That pin changed since it was shown; reload with ctrl+r." };
		}
		if (actionId === "pin:remove") {
			const result = setProjectDirPin(settings, authStorage, dir, provider, undefined);
			return written(`Removed the ${provider} pin of ${shortenPath(result.projectDir)}.`, result);
		}
		if (actionId.startsWith("pin:account:")) {
			const name = actionId.slice("pin:account:".length);
			if (name === current.name) return { message: `${shortenPath(dir)} already pins ${provider} to "${name}".` };
			const result = setProjectDirPin(settings, authStorage, dir, provider, name);
			return written(`Pinned ${provider} to "${name}" for ${shortenPath(result.projectDir)}.`, result);
		}
		return { error: `Unknown pin action: ${actionId}` };
	};

	return {
		load,
		accountColumns: [
			{ id: "billing", head: "Billing", priority: 6 },
			{ id: "state", head: "State", priority: 5 },
			{ id: "type", head: "Type", priority: 4 },
			{ id: "routing", head: "Routing", priority: 3 },
			{ id: "pins", head: "Pins", priority: 2 },
			{ id: "limits", head: "Limits", priority: 1 },
		],
		pages: () => [limitsPage(), pinsPage()],
		refresh: () => withTimeout(authStorage.credentials.reload(), STORE_TIMEOUT_MS, STORE_TIMEOUT_MESSAGE),
		apply: async (id, actionId, value = "", expect) => {
			let result: AccountManagerResult;
			const revision = settings.revision;
			try {
				await withTimeout(authStorage.credentials.reload(), STORE_TIMEOUT_MS, STORE_TIMEOUT_MESSAGE);
				const pageResult = runPageRow(id, actionId, value, expect);
				if (pageResult) return pageResult;
				const row = listAccounts(settings, authStorage, cwd()).find(candidate => accountId(candidate) === id);
				if (!row) return { error: "That account is no longer stored." };
				if (actionId === "enabled") {
					if (value !== "on" && value !== "off") return { error: "A toggle needs its target state (on or off)." };
					const enabled = value === "on";
					const label = row.account.name ?? row.label;
					const outcome = await withTimeout(
						setAccountEnabled(settings, authStorage, row, enabled),
						STORE_TIMEOUT_MS,
						STORE_TIMEOUT_MESSAGE,
					);
					if (!outcome.changed) return { message: `${label} is already ${enabled ? "enabled" : "disabled"}.` };
					const pinned = outcome.pinnedProjects.map(project => shortenPath(project)).join(", ");
					return {
						message: enabled ? `${label} is enabled.` : `${label} is disabled; no request uses it.`,
						...(!enabled && pinned
							? { warning: `Pinned for ${pinned}; those requests fail until it is enabled.` }
							: {}),
					};
				}
				result = run(row, actionId, value, expect);
			} catch (error) {
				return { error: error instanceof Error ? error.message : String(error) };
			}
			// Only a settings write changes policies; "already …" results and session pins write none.
			if (result.error || settings.revision === revision) return result;
			// Applied now rather than by the settings listener, so the reload that follows sees new account names.
			try {
				authStorage.setAccountPolicies(
					await withTimeout(
						loadEffectiveAuthAccountPolicyConfig({ settings }),
						STORE_TIMEOUT_MS,
						"Timed out re-applying account policies",
					),
				);
			} catch (error) {
				logger.warn("Could not re-apply account policies after an account edit", { error: String(error) });
				const notice = `Saved; it may need a restart to take effect (${error instanceof Error ? error.message : String(error)}).`;
				return { ...result, warning: [result.warning, notice].filter(Boolean).join(" ") };
			}
			return result;
		},
	};
}
