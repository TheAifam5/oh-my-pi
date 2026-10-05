import type { Provider } from "../types";
import type { CredentialRankingStrategy, UsageProvider } from "../usage";
import { aimlapiBilling, aimlapiUsageProvider } from "./aimlapi";
import { alibabaTokenPlanRankingStrategy, alibabaTokenPlanUsageProvider } from "./alibaba-token-plan";
import { noEvidenceBilling, type ProviderBilling, ProviderBillingRegistry, subscriptionQuotaBilling } from "./billing";
import { charmHyperBilling, charmHyperUsageProvider } from "./charm-hyper";
import { claudeBilling, claudeRankingStrategy, claudeUsageProvider } from "./claude";
import { clinePassUsageProvider } from "./cline-pass";
import { commandCodeBilling, commandCodeRankingStrategy, commandCodeUsageProvider } from "./commandcode";
import { cursorBilling, cursorRankingStrategy, cursorUsageProvider } from "./cursor";
import { deepinfraBilling, deepinfraUsageProvider } from "./deepinfra";
import { deepseekBilling, deepseekUsageProvider } from "./deepseek";
import { devinBilling, devinUsageProvider } from "./devin";
import { factoryDroidBilling, factoryDroidRankingStrategy, factoryDroidUsageProvider } from "./factory-droid";
import { googleGeminiCliBilling, googleGeminiCliUsageProvider } from "./gemini";
import { githubCopilotBilling, githubCopilotUsageProvider } from "./github-copilot";
import { antigravityRankingStrategy, antigravityUsageProvider } from "./google-antigravity";
import { kimiBilling, kimiRankingStrategy, kimiUsageProvider } from "./kimi";
import { museCodeUsageProvider } from "./muse-code";
import { minimaxCodeUsageProvider } from "./minimax-code";
import { moonshotBilling, moonshotUsageProvider } from "./moonshot";
import { nanogptBilling, nanogptUsageProvider } from "./nanogpt";
import { novitaBilling, novitaUsageProvider } from "./novita";
import { ollamaCloudUsageProvider, ollamaUsageProvider } from "./ollama";
import { codexBilling, codexRankingStrategy, openaiCodexUsageProvider } from "./openai-codex";
import { opencodeGoBilling, opencodeGoRankingStrategy, opencodeGoUsageProvider } from "./opencode-go";
import { openrouterBilling, openrouterUsageProvider } from "./openrouter";
import { siliconflowBilling, siliconflowUsageProvider } from "./siliconflow";
import { syntheticBilling, syntheticUsageProvider } from "./synthetic";
import { umansUsageProvider } from "./umans";
import { veniceBilling, veniceUsageProvider } from "./venice";
import { vercelAiGatewayBilling, vercelAiGatewayUsageProvider } from "./vercel-ai-gateway";
import { xaiOauthBilling, xaiOauthRankingStrategy, xaiOauthUsageProvider } from "./xai-oauth";
import { zaiBilling, zaiRankingStrategy, zaiUsageProvider } from "./zai";

/** Resolves the usage-based ranking strategy for a provider. */
export type RankingStrategyResolver = (provider: Provider) => CredentialRankingStrategy | undefined;

/** Built-in usage providers, in probe order. */
export const DEFAULT_USAGE_PROVIDERS: readonly UsageProvider[] = [
	alibabaTokenPlanUsageProvider,
	openaiCodexUsageProvider,
	kimiUsageProvider,
	minimaxCodeUsageProvider,
	museCodeUsageProvider,
	antigravityUsageProvider,
	googleGeminiCliUsageProvider,
	ollamaUsageProvider,
	factoryDroidUsageProvider,
	ollamaCloudUsageProvider,
	claudeUsageProvider,
	clinePassUsageProvider,
	zaiUsageProvider,
	umansUsageProvider,
	opencodeGoUsageProvider,
	githubCopilotUsageProvider,
	cursorUsageProvider,
	syntheticUsageProvider,
	xaiOauthUsageProvider,
	devinUsageProvider,
	charmHyperUsageProvider,
	commandCodeUsageProvider,
	openrouterUsageProvider,
	deepseekUsageProvider,
	moonshotUsageProvider,
	novitaUsageProvider,
	aimlapiUsageProvider,
	nanogptUsageProvider,
	vercelAiGatewayUsageProvider,
	veniceUsageProvider,
	siliconflowUsageProvider,
	deepinfraUsageProvider,
];

const DEFAULT_USAGE_PROVIDER_MAP = new Map<Provider, UsageProvider>(
	DEFAULT_USAGE_PROVIDERS.map(provider => [provider.id, provider]),
);

/** Built-in usage provider for `provider`. */
export function defaultUsageProvider(provider: Provider): UsageProvider | undefined {
	return DEFAULT_USAGE_PROVIDER_MAP.get(provider);
}

const DEFAULT_RANKING_STRATEGIES = new Map<Provider, CredentialRankingStrategy>([
	["alibaba-token-plan", alibabaTokenPlanRankingStrategy],
	["openai-codex", codexRankingStrategy],
	["anthropic", claudeRankingStrategy],
	["cursor", cursorRankingStrategy],
	["google-antigravity", antigravityRankingStrategy],
	["factory-droid", factoryDroidRankingStrategy],
	["kimi-code", kimiRankingStrategy],
	["zai", zaiRankingStrategy],
	["opencode-go", opencodeGoRankingStrategy],
	["xai-oauth", xaiOauthRankingStrategy],
	["commandcode", commandCodeRankingStrategy],
]);

/** Built-in ranking strategy for `provider`. */
export function defaultRankingStrategy(provider: Provider): CredentialRankingStrategy | undefined {
	return DEFAULT_RANKING_STRATEGIES.get(provider);
}

/**
 * Built-in billing readers, at most one per provider. Readers of providers
 * whose usage reports carry no billing fields answer `no-evidence`.
 */
export const DEFAULT_BILLING_READERS: readonly ProviderBilling[] = [
	claudeBilling,
	codexBilling,
	factoryDroidBilling,
	cursorBilling,
	githubCopilotBilling,
	charmHyperBilling,
	commandCodeBilling,
	syntheticBilling,
	devinBilling,
	openrouterBilling,
	deepseekBilling,
	moonshotBilling,
	novitaBilling,
	aimlapiBilling,
	nanogptBilling,
	vercelAiGatewayBilling,
	veniceBilling,
	siliconflowBilling,
	deepinfraBilling,
	zaiBilling,
	xaiOauthBilling,
	kimiBilling,
	opencodeGoBilling,
	googleGeminiCliBilling,
	subscriptionQuotaBilling("minimax-code"),
	subscriptionQuotaBilling("muse-code"),
	subscriptionQuotaBilling("alibaba-token-plan"),
	subscriptionQuotaBilling("cline-pass"),
	noEvidenceBilling("umans"),
	noEvidenceBilling("ollama"),
	noEvidenceBilling("ollama-cloud"),
];

const DEFAULT_BILLING_READER_MAP = new Map<Provider, ProviderBilling>(
	DEFAULT_BILLING_READERS.map(reader => [reader.id, reader]),
);

/** Built-in billing reader for `provider`. */
export function defaultBillingReader(provider: Provider): ProviderBilling | undefined {
	return DEFAULT_BILLING_READER_MAP.get(provider);
}

/** A new billing registry holding the built-in readers; callers may register more. */
export function createDefaultBillingRegistry(): ProviderBillingRegistry {
	return new ProviderBillingRegistry(DEFAULT_BILLING_READERS);
}
