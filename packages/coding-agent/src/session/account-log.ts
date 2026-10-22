import { maskedAccountLabel } from "@oh-my-pi/pi-ai/auth/types";
import type { AuthStorage } from "./auth-storage";

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
