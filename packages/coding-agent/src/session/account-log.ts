import type { AuthAccountSummary, AuthStorage } from "./auth-storage";

/**
 * Log-safe identity of a stored account: `#<credential id>` plus the email with
 * its local part masked (`#14 ***@example.com`), or the non-secret key
 * fingerprint of an API key.
 */
export function maskedAccountLabel(account: AuthAccountSummary): string {
	const id = `#${account.credentialId}`;
	if (account.type === "api_key") return account.keyFingerprint ? `${id} key ${account.keyFingerprint}` : id;
	const email = account.email;
	const at = email?.lastIndexOf("@") ?? -1;
	return email && at >= 0 ? `${id} ***${email.slice(at)}` : id;
}

/**
 * {@link maskedAccountLabel} of the stored account `sessionId` is currently routed
 * to for `provider`; `undefined` when the session holds no stored credential
 * (runtime or config keys, no request yet).
 */
export function sessionAccountLogLabel(
	authStorage: AuthStorage,
	provider: string,
	sessionId: string | undefined,
): string | undefined {
	if (!sessionId) return undefined;
	const active = authStorage.sessions.accounts(provider, sessionId).find(account => account.active);
	return active ? maskedAccountLabel(active) : undefined;
}
