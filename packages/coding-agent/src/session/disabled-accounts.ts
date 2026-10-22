/**
 * Resolution of `auth.disabledAccounts` against stored credentials: which
 * OAuth identity keys each provider excludes, and which providers fail closed.
 */
import {
	type AuthAccountPolicy,
	type CredentialsApi,
	resolveCredentialIdentityKey,
	type StoredAuthCredential,
} from "@oh-my-pi/pi-ai";
import { AccountPolicies } from "@oh-my-pi/pi-ai/auth/policy";
import { isRecord, logger } from "@oh-my-pi/pi-utils";
import { type DisabledAccountRef, parseDisabledAccountEntry } from "../config/disabled-accounts";
import { cfgAuthAccountPolicies, cfgAuthDisabledAccounts } from "../config/model-settings";
import type { Settings } from "../config/settings";

/** One `auth.disabledAccounts` problem to show the user; `key` identifies it across re-resolutions. */
export interface DisabledAccountsIssue {
	readonly key: string;
	readonly message: string;
}

/** Outcome of {@link resolveDisabledAccounts}. */
export interface DisabledAccountsResolution {
	/** Provider → OAuth identity keys excluded, or `null` when the provider is unusable (dead entry). */
	readonly providers: ReadonlyMap<string, ReadonlySet<string> | null>;
	readonly issues: readonly DisabledAccountsIssue[];
}

const FIX_HINT = "run `omp account list` to see stored accounts, then fix or remove the entry";

/** Value of `setting` in the highest-precedence layer other than the project layer. */
function trustedLayerValue(
	settings: Settings,
	setting: typeof cfgAuthAccountPolicies | typeof cfgAuthDisabledAccounts,
) {
	return settings.getLayerValues(setting).findLast(layer => layer.source !== "project")?.value;
}

/** Stored rows of `provider`, enabled first, then user-disabled. */
function storedRows(credentials: Pick<CredentialsApi, "list" | "listUserDisabled">, provider: string) {
	return [...credentials.list(provider), ...credentials.listUserDisabled(provider)];
}

/**
 * Resolve the trusted-layer `auth.disabledAccounts` of `settings` against
 * `credentials`.
 *
 * A `#id` entry naming no stored row of its provider, and a name entry that the
 * trusted-layer `auth.accountPolicies` do not define for its provider, make the
 * provider unusable. A name or matcher matching no stored row excludes nothing.
 * A matched row without an OAuth identity key (an API key) cannot be excluded;
 * an entry matching only such rows is ignored. Every problem is an issue.
 */
export function resolveDisabledAccounts(
	settings: Settings,
	credentials: Pick<CredentialsApi, "list" | "listUserDisabled">,
): DisabledAccountsResolution {
	const providers = new Map<string, Set<string> | null>();
	const issues: DisabledAccountsIssue[] = [];
	const issue = (key: string, message: string) => issues.push({ key, message });

	const projectAuth = settings.getProjectSettings().auth;
	const project = isRecord(projectAuth) ? projectAuth : {};
	if (project.disabledAccounts !== undefined) {
		issue(
			"project",
			"auth.disabledAccounts in project settings (.omp/config.yml) is ignored; set it in the global config or a directory layer (~/.omp/agent/directories/<folder>/config.yml).",
		);
	}

	const raw = trustedLayerValue(settings, cfgAuthDisabledAccounts);
	if (!Array.isArray(raw) || raw.length === 0) return { providers, issues };
	const rawPolicies = trustedLayerValue(settings, cfgAuthAccountPolicies);
	const policies: readonly AuthAccountPolicy[] = Array.isArray(rawPolicies) ? rawPolicies : [];

	const failClosed = (ref: DisabledAccountRef, reason: string) => {
		providers.set(ref.provider, null);
		issue(
			`dead\0${ref.label}`,
			`auth.disabledAccounts entry "${ref.label}" ${reason}; ${ref.provider} is unavailable in this directory until you ${FIX_HINT}.`,
		);
	};
	const exclude = (ref: DisabledAccountRef, rows: readonly StoredAuthCredential[]) => {
		if (providers.get(ref.provider) === null) return;
		const keys: string[] = [];
		let keyless = 0;
		for (const row of rows) {
			const key = resolveCredentialIdentityKey(ref.provider, row.credential);
			if (key === null) keyless += 1;
			else keys.push(key);
		}
		if (keyless > 0) {
			issue(
				`keyless\0${ref.label}`,
				`auth.disabledAccounts entry "${ref.label}" matches ${keyless === 1 ? "a stored credential" : `${keyless} stored credentials`} without an OAuth identity (an API key); API keys cannot be disabled individually per directory. Disabling any ${ref.provider} OAuth account already excludes ${ref.provider} API keys in that scope.`,
			);
			if (keys.length === 0) return;
		}
		if (rows.length === 0) {
			issue(
				`unmatched\0${ref.label}`,
				`auth.disabledAccounts entry "${ref.label}" matches no stored ${ref.provider} account; it excludes nothing.`,
			);
		}
		const excluded = providers.get(ref.provider) ?? new Set<string>();
		for (const key of keys) excluded.add(key);
		providers.set(ref.provider, excluded);
	};
	const matching = (ref: DisabledAccountRef, policy: AuthAccountPolicy) => {
		let matcher: AccountPolicies;
		try {
			matcher = new AccountPolicies([{ provider: ref.provider, account: policy.account }], undefined);
		} catch (error) {
			failClosed(ref, `names an invalid account policy (${error instanceof Error ? error.message : String(error)})`);
			return;
		}
		exclude(
			ref,
			storedRows(credentials, ref.provider).filter(row => matcher.forStored(ref.provider, row.credential)),
		);
	};

	raw.forEach((entry, index) => {
		let ref: DisabledAccountRef;
		try {
			ref = parseDisabledAccountEntry(entry, index);
		} catch (error) {
			logger.warn("Ignoring malformed auth.disabledAccounts entry", { error: String(error) });
			return;
		}
		switch (ref.kind) {
			case "id": {
				const row = storedRows(credentials, ref.provider).find(candidate => candidate.id === ref.credentialId);
				if (row) exclude(ref, [row]);
				else failClosed(ref, `names no stored ${ref.provider} credential`);
				return;
			}
			case "name": {
				const policy = policies.find(
					candidate => candidate.provider === ref.provider && candidate.name === ref.name,
				);
				if (policy && isRecord(policy.account)) {
					matching(ref, policy);
					return;
				}
				const projectPolicies = project.accountPolicies;
				const inProject =
					Array.isArray(projectPolicies) &&
					projectPolicies.some(
						candidate =>
							isRecord(candidate) && candidate.provider === ref.provider && candidate.name === ref.name,
					);
				failClosed(
					ref,
					inProject
						? `names an account defined only in project settings, which cannot name accounts for auth.disabledAccounts`
						: `names no ${ref.provider} account in auth.accountPolicies`,
				);
				return;
			}
			case "matcher":
				matching(ref, { provider: ref.provider, account: ref.account });
				return;
		}
	});
	return { providers, issues };
}
