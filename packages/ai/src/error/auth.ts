import { ACCOUNT_LIMIT_MESSAGE_PREFIX, ACCOUNT_UNAVAILABLE_MESSAGE_PREFIX, attach, create, Flag } from "./flags";

/**
 * No API key / credential was available to dispatch a request.
 *
 * The default message preserves the historical `"No API key for provider: X"`
 * wording, which {@link Flag.AuthFailed}'s regex (`no api key`) keys off — but
 * the flag is also attached structurally so classification never depends on the
 * exact phrasing.
 */
export class MissingApiKeyError extends Error {
	readonly provider: string | undefined;

	constructor(provider?: string, message?: string) {
		super(message ?? (provider ? `No API key for provider: ${provider}` : "No API key available"));
		this.name = "MissingApiKeyError";
		this.provider = provider;
		attach(this, create(Flag.AuthFailed));
	}
}

/**
 * Every usable OAuth credential for a provider failed to refresh with a
 * retryable error (network blip, timeout, 5xx). The stored credentials are
 * intact, so this is classified transient: retrying the request can succeed,
 * unlike {@link MissingApiKeyError}. The refresh failure is kept as `cause`.
 */
export class OAuthRefreshUnavailableError extends Error {
	readonly provider: string;

	constructor(provider: string, cause: unknown) {
		super(
			`OAuth token refresh failed for provider ${provider}: ${cause instanceof Error ? cause.message : String(cause)}`,
			{ cause },
		);
		this.name = "OAuthRefreshUnavailableError";
		this.provider = provider;
		attach(this, create(Flag.Transient));
	}
}

/**
 * A pinned or preferred account cannot serve the request: no stored credential
 * carries that account name, or the pinned credential could not produce a key.
 * Never falls back to another account.
 *
 * Classifies as no failure kind at all (see {@link ACCOUNT_UNAVAILABLE_MESSAGE_PREFIX}):
 * credential invalidation keyed on auth failures must not touch stored
 * credentials for a configuration problem, and retrying cannot fix it.
 */
export class AccountUnavailableError extends Error {
	readonly provider: string;
	/** Account name that could not be resolved; kept out of the message so its text never drives classification. */
	readonly account: string | undefined;

	constructor(provider: string, account?: string) {
		super(`${ACCOUNT_UNAVAILABLE_MESSAGE_PREFIX}${provider}`);
		this.name = "AccountUnavailableError";
		this.provider = provider;
		this.account = account;
	}
}

/**
 * A `skip` limit of an account policy refuses the request: the session's exclusively pinned
 * account is over it, or every stored account of the provider is. The request fails instead of
 * switching accounts or falling back to an environment key. Classifies as no failure kind at
 * all, like {@link AccountUnavailableError}; the account is kept out of the message.
 */
export class AccountLimitError extends Error {
	readonly provider: string;
	readonly account: string | undefined;
	/** `reached` when a cap is reached, `unreadable` when the counted usage could not be read. */
	readonly reason: "reached" | "unreadable";

	constructor(provider: string, reason: "reached" | "unreadable" = "reached", account?: string) {
		super(
			`${ACCOUNT_LIMIT_MESSAGE_PREFIX}${provider}${reason === "unreadable" ? " (limit usage could not be read)" : ""}`,
		);
		this.name = "AccountLimitError";
		this.provider = provider;
		this.account = account;
		this.reason = reason;
	}
}

/** A user-facing login flow required an `onPrompt` callback that was not supplied. */
export class OnPromptRequiredError extends Error {
	constructor(providerLabel: string) {
		super(`${providerLabel} login requires onPrompt callback`);
		this.name = "OnPromptRequiredError";
	}
}

/** An interactive login asked for an API key but the user supplied an empty value. */
export class ApiKeyRequiredError extends Error {
	constructor(message = "API key is required") {
		super(message);
		this.name = "ApiKeyRequiredError";
	}
}

/**
 * A user cancelled an interactive login / device flow. Classified as an abort
 * so it is never surfaced as a retryable transient failure.
 */
export class LoginCancelledError extends Error {
	constructor(message = "Login cancelled") {
		super(message);
		this.name = "LoginCancelledError";
		attach(this, create(Flag.Abort));
	}
}
