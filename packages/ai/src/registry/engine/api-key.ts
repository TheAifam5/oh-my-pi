/**
 * `login "api-key"` engine: open the provider's key page, prompt for a paste,
 * optionally prompt for a workspace id, optionally validate the key against a
 * declared probe, return the key.
 */
import type {
	CompiledApiKeyLogin,
	CompiledAuthValidation,
	CompiledKeyPrefix,
	CompiledWorkspacePrompt,
} from "@oh-my-pi/pi-catalog/compat/types";
import { $env } from "@oh-my-pi/pi-utils";
import * as AIError from "../../error";
import {
	validateAnthropicCompatibleApiKey,
	validateApiKeyAgainstModelsEndpoint,
	validateOpenAICompatibleApiKey,
} from "../api-key-validation";
import type { OAuthController } from "../oauth/types";
import { loadHeadersHook } from "./common";

async function runValidation(
	validate: CompiledAuthValidation,
	label: string,
	apiKey: string,
	options: OAuthController,
	extraHeaders: Record<string, string> | undefined,
): Promise<void> {
	const provider = validate.label ?? label;
	switch (validate.kind) {
		case "chat-completions":
			await validateOpenAICompatibleApiKey({
				provider,
				apiKey,
				baseUrl: validate.baseUrl,
				model: validate.model,
				maxTokensField: validate.maxTokensField,
				maxTokens: validate.maxTokens,
				tolerateModelDenied: validate.tolerateModelDenied,
				signal: options.signal,
				fetch: options.fetch,
			});
			return;
		case "anthropic-messages":
			await validateAnthropicCompatibleApiKey({
				provider,
				apiKey,
				baseUrl: validate.baseUrl,
				model: validate.model,
				signal: options.signal,
				fetch: options.fetch,
			});
			return;
		case "models-endpoint": {
			const envBase = validate.baseUrlEnv ? $env[validate.baseUrlEnv]?.trim() : undefined;
			const modelsUrl = envBase ? `${envBase.replace(/\/+$/, "")}/models` : validate.url;
			const hookHeaders = validate.headersHook ? (await loadHeadersHook(validate.headersHook))() : undefined;
			const headers = hookHeaders || extraHeaders ? { ...hookHeaders, ...extraHeaders } : undefined;
			await validateApiKeyAgainstModelsEndpoint({
				provider,
				apiKey,
				modelsUrl,
				headers,
				authHeader: validate.authHeader,
				signal: options.signal,
				fetch: options.fetch,
			});
		}
	}
}

/** Printable ASCII without spaces: the only bytes a prefixed key may carry. */
const PRINTABLE_KEY_PATTERN = /^[\x21-\x7e]+$/;

/**
 * Refuses a pasted key outside the rule's prefix guard with
 * {@link AIError.ApiKeyRequiredError}: a rejected or unaccepted prefix, or any
 * byte outside printable ASCII (whitespace, control, or invisible characters
 * that would corrupt the stored key or a request header). Messages never echo the key.
 */
function checkKeyPrefix(keyPrefix: CompiledKeyPrefix, label: string, apiKey: string): void {
	const rejection = keyPrefix.reject.find(rule => apiKey.startsWith(rule.prefix));
	if (rejection) throw new AIError.ApiKeyRequiredError(rejection.message);
	if (!keyPrefix.accept.some(prefix => apiKey.startsWith(prefix))) {
		const expected = keyPrefix.accept.map(prefix => `${prefix}...`).join(" or ");
		throw new AIError.ApiKeyRequiredError(`Not a ${label} key: expected one starting with ${expected}`);
	}
	if (!PRINTABLE_KEY_PATTERN.test(apiKey)) {
		throw new AIError.ApiKeyRequiredError(
			"The pasted key contains spaces, line breaks, or invisible characters; copy the key again and paste only the key",
		);
	}
}

/**
 * Asks for the optional workspace id. Returns `undefined` for an empty answer;
 * refuses an answer outside the rule's pattern with its static message.
 */
async function promptWorkspaceId(
	rule: CompiledWorkspacePrompt,
	onPrompt: NonNullable<OAuthController["onPrompt"]>,
	signal: AbortSignal | undefined,
): Promise<string | undefined> {
	const answer = await onPrompt({ message: rule.prompt, placeholder: rule.placeholder, allowEmpty: true });
	if (signal?.aborted) {
		throw new AIError.LoginCancelledError();
	}
	const workspaceId = answer.trim();
	if (!workspaceId) return undefined;
	if (!new RegExp(rule.pattern).test(workspaceId)) throw new AIError.ApiKeyRequiredError(rule.message);
	return workspaceId;
}

/** Builds the login function for one `login "api-key"` rule; `label` is the provider display name. */
export function createApiKeyLogin(
	rule: CompiledApiKeyLogin,
	label: string,
): (options: OAuthController) => Promise<string> {
	return async function login(options: OAuthController): Promise<string> {
		if (!options.onPrompt) {
			throw new AIError.OnPromptRequiredError(label);
		}
		if (rule.authUrl && rule.instructions) {
			options.onAuth?.({ url: rule.authUrl, instructions: rule.instructions });
		}
		const answer = await options.onPrompt({
			message: rule.prompt,
			placeholder: rule.placeholder,
			...(rule.emptyFallback !== undefined ? { allowEmpty: true } : {}),
		});
		if (options.signal?.aborted) {
			throw new AIError.LoginCancelledError();
		}
		let trimmed = answer.trim();
		if (rule.normalize === "strip-bearer" && trimmed) {
			trimmed = trimmed.replace(/^bearer\b\s*/i, "");
			if (!trimmed) {
				throw new AIError.ApiKeyRequiredError(`${label} API key is empty after stripping Bearer prefix`);
			}
		}
		if (!trimmed) {
			if (rule.emptyFallback !== undefined) return rule.emptyFallback;
			throw new AIError.ApiKeyRequiredError();
		}
		if (rule.keyPrefix) checkKeyPrefix(rule.keyPrefix, label, trimmed);
		const workspaceId = rule.workspacePrompt
			? await promptWorkspaceId(rule.workspacePrompt, options.onPrompt, options.signal)
			: undefined;
		const workspaceHeaders =
			workspaceId && rule.workspacePrompt ? { [rule.workspacePrompt.header]: workspaceId } : undefined;
		if (rule.validate) {
			options.onProgress?.(rule.validate.optional ? "Validating API key (optional)..." : "Validating API key...");
			try {
				await runValidation(rule.validate, label, trimmed, options, workspaceHeaders);
			} catch (error) {
				// An optional probe only rejects on a real auth failure (401/403, or
				// only 401 with `trustForbidden`); any other validation-endpoint
				// failure trusts the supplied key.
				const trustsForbidden = rule.validate.trustForbidden && AIError.status(error) === 403;
				if (
					!rule.validate.optional ||
					(AIError.is(AIError.classify(error), AIError.Flag.AuthFailed) && !trustsForbidden)
				) {
					throw error;
				}
				options.onProgress?.(`Skipping ${label} validation endpoint; continuing with provided API key.`);
			}
		}
		if (workspaceId) options.onWorkspaceId?.(workspaceId);
		return trimmed;
	};
}
