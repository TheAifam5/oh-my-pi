import type { UsageReport } from "@oh-my-pi/pi-ai/usage";
import type { AccountLimit } from "@oh-my-pi/pi-ai/usage/limits";
import type {
	AccountManagerAccount,
	AccountManagerAction,
	AccountManagerDeps,
	AccountManagerField,
	AccountManagerResult,
} from "@oh-my-pi/pi-tui/overlays/account-manager";
import { parseModelString } from "@oh-my-pi/pi-tui/overlays/model-selector";
import { shortenPath } from "@oh-my-pi/pi-tui/render/render-utils";
import { logger, withTimeout } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import {
	type AccountListing,
	type AccountRef,
	accountLimits,
	accountPolicyWriteBlocker,
	formatAccountLimitSpec,
	labelAccount,
	listAccounts,
	listPoolMembers,
	type PoolMemberListing,
	type PoolMemberRef,
	parseAccountLimitSpec,
	pinProjectAccount,
	poolMemberPath,
	projectPinWriteBlocker,
	setAccountDrain,
	setAccountLimits,
	setAccountPriority,
	setAccountReserve,
	setAccountReturn,
	setPoolMemberAccount,
	unpinProjectAccount,
} from "../session/account-admin";
import type { SessionPinOutcome, SessionUnpinOutcome } from "../session/agent-session-types";
import { loadEffectiveAuthAccountPolicyConfig } from "../session/auth-broker-config";
import type { AuthStorage } from "../session/auth-storage";
import { formatLimitUsage } from "../session/local-limits";
import { describeSessionPinOutcome, describeSessionUnpinOutcome } from "../slash-commands/helpers/session-pin";
import { reportIdentifiers } from "../slash-commands/helpers/usage-accounts";
import { billingSummary } from "./model-browser-source";

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
const SPEND_CLASSES = ["credits", "money"] as const;
const RETURN_TRIGGERS = ["reset", "credits-added", "money-available"] as const;
const MINUTE_MS = 60_000;
/** Longest wait on the credential store or the policy loader before the manager gives up, in ms. */
export const STORE_TIMEOUT_MS = 10_000;
export const STORE_TIMEOUT_MESSAGE = "Timed out reading the credential store";
/** Actions applied with a target state (`on` or `off`) rather than typed text. */
const TOGGLES = /^(?:drain|pin-session|pin-project|spend:.*|return:(?:reset|credits-added|money-available)|pool:.*)$/;

function accountId(row: Pick<AccountListing, "provider" | "account">): string {
	return `${row.provider}#${row.account.credentialId}`;
}

function memberActionId(member: PoolMemberRef): string {
	return `pool:${JSON.stringify([member.kind, member.key, member.alias])}`;
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

/**
 * Billing evidence for `row` from `reports`: the reports that name an OAuth account, or for an
 * API key, the provider's reports when it is the provider's only stored account.
 */
function accountBilling(
	row: AccountListing,
	reports: readonly UsageReport[],
	providerAccountCount: number,
): string | undefined {
	const { account, provider } = row;
	const own = reports.filter(
		report =>
			report.provider === provider &&
			(account.type === "api_key" ? providerAccountCount === 1 : reportNamesAccount(report, account)),
	);
	return billingSummary(provider, own, Date.now());
}

function limitLine(limit: AccountListing["limits"][number]): string {
	if ("window" in limit) return formatLimitUsage(limit, Date.now());
	return `${limit.metric} ${limit.max} (provider evidence)${limit.onLimit === "warn" ? " · warn only" : ""}`;
}

function minutes(ms: number): string {
	return `${Number((ms / MINUTE_MS).toFixed(2))} min`;
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
		const limitChoices: AccountManagerAction[] = limits.flatMap((limit, index) => {
			const spec = formatAccountLimitSpec(limit);
			return [
				{
					id: `limit:edit:${index}`,
					label: `edit ${spec}`,
					input: { initial: spec, hint: LIMIT_HINT },
					expect: spec,
				},
				{ id: `limit:remove:${index}`, label: `remove ${spec}`, expect: spec },
			];
		});
		limitChoices.push({ id: "limit:add", label: "add…", input: { initial: DEFAULT_LIMIT_SPEC, hint: LIMIT_HINT } });
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
				id: "limits",
				label: "limits",
				key: "l",
				value: limitsInvalid ? "invalid" : String(limits.length),
				readOnly: limitsInvalid ?? policyReadOnly,
				choices: limitChoices,
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
			if (billing !== undefined) details.push({ label: "billing", value: billing });
			const readOnly = accountPolicyWriteBlocker(settings);
			if (readOnly) details.push({ label: "policy", value: `${readOnly}; shown read-only`, tone: "warning" });
			return {
				id: accountId(row),
				provider: row.provider,
				...(name !== undefined ? { name } : {}),
				identity: row.label,
				badges: [
					row.priority !== undefined ? `priority ${row.priority}` : undefined,
					row.reservePct !== undefined ? `reserve ${row.reservePct}%` : undefined,
					row.drain ? "drain" : undefined,
					pinnedForSession ? "session pin" : undefined,
					row.projectPinned ? "project pin" : undefined,
					poolMembership.length > 0 ? "pool" : undefined,
					row.limits.length > 0 ? `${row.limits.length} limit${row.limits.length === 1 ? "" : "s"}` : undefined,
				].filter((badge): badge is string => badge !== undefined),
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
			/^(spend|return|limit|pool):/.test(actionId);
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
		const written = (message: string, result: { warning?: string }): AccountManagerResult => ({
			message,
			...(result.warning ? { warning: result.warning } : {}),
		});
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
		if (actionId.startsWith("limit:")) {
			const limits = accountLimits(settings, ref);
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
			else if (match[2] === "edit") next[index!] = parseAccountLimitSpec(value);
			else next.splice(index!, 1);
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

	return {
		load,
		refresh: () => withTimeout(authStorage.credentials.reload(), STORE_TIMEOUT_MS, STORE_TIMEOUT_MESSAGE),
		apply: async (id, actionId, value = "", expect) => {
			let result: AccountManagerResult;
			const revision = settings.revision;
			try {
				await withTimeout(authStorage.credentials.reload(), STORE_TIMEOUT_MS, STORE_TIMEOUT_MESSAGE);
				const row = listAccounts(settings, authStorage, cwd()).find(candidate => accountId(candidate) === id);
				if (!row) return { error: "That account is no longer stored." };
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
