import type { SessionPinOutcome, SessionUnpinOutcome } from "../../session/agent-session-types";
import type { AuthAccountSummary } from "../../session/auth-storage";
import { formatActiveAccountLabel } from "./active-oauth-account";

import type { SessionPinAccount } from "@oh-my-pi/pi-tui/overlays/session-account-selector";

/** Account choice for `/session pin`: the shared picker shape plus the account name and key fingerprint. */
export interface SessionPinChoice extends SessionPinAccount {
	name?: string;
	keyFingerprint?: string;
	pinned: boolean;
}

function baseLabel(account: AuthAccountSummary): string {
	if (account.type === "api_key") return `API key ${account.keyFingerprint ?? `#${account.credentialId}`}`;
	const enterpriseUrl = account.enterpriseUrl?.trim();
	return (formatActiveAccountLabel(account) ?? enterpriseUrl) || `OAuth credential #${account.credentialId}`;
}

/** Add stable user-facing labels to provider account summaries; a named account leads with its name. */
export function toSessionPinAccounts(accounts: readonly AuthAccountSummary[]): SessionPinChoice[] {
	return accounts.map((account, position) => {
		const base = baseLabel(account);
		const label = account.name ? `${account.name} (${base})` : base;
		return {
			position,
			credentialId: account.credentialId,
			accountId: account.accountId,
			email: account.email,
			projectId: account.projectId,
			enterpriseUrl: account.enterpriseUrl,
			orgId: account.orgId,
			orgName: account.orgName,
			active: account.active,
			pinned: account.pinned,
			label: account.pinned ? `${label} [pinned]` : label,
			...(account.name !== undefined ? { name: account.name } : {}),
			...(account.keyFingerprint !== undefined ? { keyFingerprint: account.keyFingerprint } : {}),
		};
	});
}

/** Match a `/session pin` selector by 1-based position, account name, key fingerprint, or exact account identity. */
export function matchSessionPinAccounts(accounts: readonly SessionPinChoice[], selector: string): SessionPinChoice[] {
	const wanted = selector.trim().toLowerCase();
	if (!wanted) return [];
	if (wanted === "active") return accounts.filter(account => account.active);

	if (/^\d+$/.test(wanted)) {
		const position = Number(wanted) - 1;
		const positioned = accounts.find(account => account.position === position);
		if (positioned) return [positioned];
	}

	const named = accounts.filter(account => account.name === wanted);
	if (named.length > 0) return named;

	return accounts.filter(account =>
		[
			account.label,
			account.email,
			account.accountId,
			account.projectId,
			account.enterpriseUrl,
			account.orgId,
			account.orgName,
			account.keyFingerprint,
			`OAuth credential #${account.credentialId}`,
		].some(value => value?.trim().toLowerCase() === wanted),
	);
}

/** User-facing text for a `/session pin` outcome. */
export function describeSessionPinOutcome(outcome: SessionPinOutcome, label: string, providerName: string): string {
	switch (outcome) {
		case "pinned":
			return `Pinned ${label} to this session for ${providerName}; no other account will be used.`;
		case "no-model":
			return "Select a model before pinning a provider account.";
		case "streaming":
			return "Cannot pin an account while the session is streaming.";
		case "overridden":
			return `Not pinned: a --api-key or models.yml apiKey override is active for ${providerName}.`;
		case "restricted":
			return `Not pinned: ${label} is outside the ${providerName} account pool this session is restricted to.`;
		case "unavailable":
			return `${label} is no longer available to pin.`;
		case "not-persistable":
			return `Not pinned: ${label} has no email, account id, or key fingerprint to remember the pin by.`;
	}
}

/** User-facing text for a `/session unpin` outcome. */
export function describeSessionUnpinOutcome(outcome: SessionUnpinOutcome, provider: string): string {
	switch (outcome) {
		case "unpinned":
			return `Removed this session's account pin for ${provider}.`;
		case "no-model":
			return "Select a model before unpinning a provider account.";
		case "streaming":
			return "Cannot unpin an account while the session is streaming.";
		case "project-pin":
			return `This session follows the project account pin for ${provider}; remove it from auth.accountPins.`;
		case "none":
			return `This session has no account pin for ${provider}.`;
	}
}
