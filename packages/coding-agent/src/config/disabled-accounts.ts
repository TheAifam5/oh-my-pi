/**
 * Grammar of `auth.disabledAccounts` entries: `<provider>/#<credential id>`,
 * `<provider>/<account name>`, or an `auth.accountPolicies[].account` matcher
 * with its `provider`.
 */
import type { AuthAccountSelector } from "@oh-my-pi/pi-ai/auth-storage";
import { ACCOUNT_NAME, AccountPolicies, MAX_ACCOUNT_NAME_LENGTH } from "@oh-my-pi/pi-ai/auth/policy";
import { isRecord } from "@oh-my-pi/pi-utils";

/** One `auth.disabledAccounts` entry as configured. */
export type DisabledAccountEntry = string | Readonly<AuthAccountSelector & { provider: string }>;

/** One parsed `auth.disabledAccounts` entry; `label` is the entry as users write it. */
export type DisabledAccountRef =
	| { kind: "id"; provider: string; credentialId: number; label: string }
	| { kind: "name"; provider: string; name: string; label: string }
	| { kind: "matcher"; provider: string; account: AuthAccountSelector; label: string };

const SELECTOR_FIELDS = ["email", "accountId", "projectId", "orgId", "keyFingerprint"] as const;
const CREDENTIAL_ID = /^#([1-9][0-9]*)$/;

/**
 * Parse entry `index` of `auth.disabledAccounts`.
 * @throws Error naming the entry when it is malformed.
 */
export function parseDisabledAccountEntry(entry: unknown, index: number): DisabledAccountRef {
	const path = `auth.disabledAccounts[${index}]`;
	if (typeof entry === "string") {
		const slash = entry.lastIndexOf("/");
		const provider = entry.slice(0, slash);
		const target = entry.slice(slash + 1);
		if (slash <= 0 || provider.trim() !== provider || target.length === 0) {
			throw new Error(`${path} must be "<provider>/#<credential id>" or "<provider>/<account name>": ${entry}`);
		}
		const id = CREDENTIAL_ID.exec(target);
		if (id) {
			const credentialId = Number(id[1]);
			if (!Number.isSafeInteger(credentialId))
				throw new Error(`${path} names an out-of-range credential id: ${entry}`);
			return { kind: "id", provider, credentialId, label: entry };
		}
		if (target.length > MAX_ACCOUNT_NAME_LENGTH || !ACCOUNT_NAME.test(target)) {
			throw new Error(
				`${path} account name must match ${ACCOUNT_NAME.source} and be at most ${MAX_ACCOUNT_NAME_LENGTH} characters: ${entry}`,
			);
		}
		return { kind: "name", provider, name: target, label: entry };
	}
	if (!isRecord(entry)) {
		throw new Error(`${path} must be a "<provider>/…" string or a { provider, email | accountId | … } mapping`);
	}
	for (const key of Object.keys(entry)) {
		if (key !== "provider" && !(SELECTOR_FIELDS as readonly string[]).includes(key)) {
			throw new Error(`${path}.${key} is not a field; use provider, ${SELECTOR_FIELDS.join(", ")}`);
		}
	}
	const { provider, ...account } = entry;
	if (typeof provider !== "string" || provider.length === 0 || provider.trim() !== provider) {
		throw new Error(`${path}.provider must be a non-empty string without surrounding whitespace`);
	}
	const selector = account as AuthAccountSelector;
	try {
		new AccountPolicies([{ provider, account: selector }], undefined);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			message.replace("auth.accountPolicies[0].account", path).replace("auth.accountPolicies[0]", path),
		);
	}
	const label = `${provider} ${SELECTOR_FIELDS.flatMap(field =>
		selector[field] === undefined ? [] : [`${field}=${selector[field]}`],
	).join(" ")}`;
	return { kind: "matcher", provider, account: selector, label };
}

/**
 * `auth.disabledAccounts` validation: a list whose every entry parses.
 * @throws Error naming the first malformed entry.
 */
export function validateDisabledAccounts(raw: unknown): void {
	if (raw === undefined || raw === null) return;
	if (!Array.isArray(raw)) throw new Error("auth.disabledAccounts must be a list");
	raw.forEach(parseDisabledAccountEntry);
}
