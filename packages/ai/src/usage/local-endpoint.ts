import type { Provider } from "../types";
import type { UsageReport } from "../usage";
import { knownBilling, type ProviderBilling, unknownBilling } from "./billing";

/** Providers whose models run on a self-hosted or in-process endpoint and have no usage API. */
const LOCAL_ENDPOINT_PROVIDERS: ReadonlySet<Provider> = new Set(["lm-studio", "llama.cpp", "vllm", "local", "apple"]);

/** Schemes served in-process or over a local socket, with no network host to reach. */
const IN_PROCESS_SCHEMES: ReadonlySet<string> = new Set(["local:", "unix:"]);
const NETWORK_SCHEMES: ReadonlySet<string> = new Set(["http:", "https:", "ws:", "wss:"]);
/** Dotted-quad 127/8; WHATWG URL parsing already canonicalizes IPv4 hosts of network schemes. */
const IPV4_LOOPBACK = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/**
 * Whether `baseUrl` is provably this machine: an in-process (`local:`) or
 * Unix-socket endpoint, or an HTTP(S)/WS(S) host that is exactly `localhost`,
 * a 127/8 literal, or `[::1]`. Private-network, link-local, and `*.local`
 * hosts are not, since one may front a billed gateway.
 */
function isLoopbackBaseUrl(baseUrl: string): boolean {
	let url: URL;
	try {
		url = new URL(baseUrl.trim());
	} catch {
		return false;
	}
	if (IN_PROCESS_SCHEMES.has(url.protocol)) return true;
	if (!NETWORK_SCHEMES.has(url.protocol)) return false;
	const { hostname } = url;
	return hostname === "localhost" || hostname === "[::1]" || IPV4_LOOPBACK.test(hostname);
}

/**
 * Usage report carrying a model's endpoint as billing evidence, for the
 * self-hosted providers that have billing readers here; `undefined` for any
 * other provider. These providers have no usage fetcher, so callers that know
 * the model synthesize the report instead.
 */
export function localEndpointUsageReport(
	provider: Provider,
	baseUrl: string,
	fetchedAt: number,
): UsageReport | undefined {
	if (!LOCAL_ENDPOINT_PROVIDERS.has(provider)) return undefined;
	return { provider, fetchedAt, limits: [], metadata: { baseUrl } };
}

/**
 * Billing reader for a self-hosted model provider: one uncapped `free` source
 * when `metadata.baseUrl` is a loopback or in-process endpoint
 * ({@link isLoopbackBaseUrl}), otherwise `no-evidence`, since the same
 * provider can point at a paid remote host.
 */
function localEndpointBilling(id: Provider): ProviderBilling {
	return {
		id,
		readBilling(report) {
			const baseUrl = report.metadata?.baseUrl;
			if (typeof baseUrl !== "string" || !isLoopbackBaseUrl(baseUrl)) {
				return unknownBilling(report, "no-evidence");
			}
			return knownBilling(report, [
				{ mode: "free", state: "available", allowance: { kind: "money", uncapped: true } },
			]);
		},
	};
}

/** Billing readers of every self-hosted model provider. */
export const localEndpointBillingReaders: readonly ProviderBilling[] = [...LOCAL_ENDPOINT_PROVIDERS].map(
	localEndpointBilling,
);
