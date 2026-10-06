/**
 * `omp auth-gateway stdio`: the gateway's routes as JSON lines on stdin and
 * stdout (`serveAuthGatewayStdio`), for a parent process that wants omp's
 * inference without an HTTP listener or a bearer token.
 *
 * Unlike `serve` it runs on this omp's own credentials (the broker when one is
 * configured, else the local store), models (`models.yml` and extension
 * providers included) and settings. A request's `model` is an omp model
 * selector, as `--model` takes it ({@link selectorCandidates}); an attempt
 * that fails before its reply starts moves on to the next candidate. Serving
 * ends when stdin does.
 */
import type { Api, AuthAccountPolicies, AuthStorage, Model } from "@oh-my-pi/pi-ai";
import { createAuthGatewayRouter, serveAuthGatewayStdio, settleAuthGatewayRouter } from "@oh-my-pi/pi-ai/auth-gateway";
import { getAgentDbPath, getProjectDir, isRecord, logger, postmortem, VERSION } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../config/model-registry";
import { formatModelStringWithRouting, normalizeModelPatternList, resolveCliModel } from "../config/model-resolver";
import { Settings } from "../config/settings";
import { claimRpcInput } from "../modes/rpc/rpc-input";
import { discoverAuthStorage, loadCliExtensionProviders } from "../sdk";
import { loadEffectiveAuthAccountPolicyConfig } from "../session/auth-broker-config";
import { warnRolePoolProjection } from "../session/pool-selection";
import { collectOnlineTinyCandidates, expandOnlineTinyModelFallbacks } from "../tiny/online-candidates";
import { type GatewayAccountLimits, installGatewayAccountLimits, openGatewayLedger } from "./auth-gateway-limits";

/** Names the caller in the gateway's logs. */
const STDIO_PEER = "stdio";

/**
 * The models a request naming `selector` may run on, in order: the model
 * `--model` would pick (the first entry of a comma list that resolves), then
 * that model's `retry.fallbackChains` (its role's chain when the entry named a
 * role). Empty when no entry resolves.
 */
export function selectorCandidates(
	selector: string,
	settings: Settings,
	registry: Pick<ModelRegistry, "getAll" | "getAvailable">,
): Model<Api>[] {
	const available = registry.getAvailable();
	for (const pattern of normalizeModelPatternList(selector)) {
		const { model, configuredRole } = resolveCliModel({ cliModel: pattern, modelRegistry: registry, settings });
		if (!model) continue;
		// Routing is per request and synchronous, so a pool role runs its ordered member list.
		if (configuredRole) warnRolePoolProjection(settings, configuredRole);
		const chain = configuredRole
			? collectOnlineTinyCandidates([configuredRole], settings, available).map(candidate => candidate.model)
			: expandOnlineTinyModelFallbacks(model, settings, available);
		const seen = new Set<string>();
		return [model, ...chain].filter(candidate => {
			const key = formatModelStringWithRouting(candidate);
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
	}
	return [];
}

/**
 * Enforce `accountPolicies`' call-counting limits on `storage` as `serve` does, against the usage
 * ledger of the agent storage `settings` holds (which owns and closes it); without one, against
 * `agent.db` opened ledger-only.
 */
export function installStdioAccountLimits(
	storage: AuthStorage,
	accountPolicies: AuthAccountPolicies,
	settings: Settings,
): Promise<GatewayAccountLimits | undefined> {
	return installGatewayAccountLimits(storage, accountPolicies, async () => {
		const agentStorage = settings.getStorage();
		if (!agentStorage) return openGatewayLedger(getAgentDbPath(settings.getAgentDir()));
		return { ledger: agentStorage.usageLedger, close: () => {} };
	});
}

/** Serves the gateway on stdin/stdout until stdin ends, then exits. */
export async function runAuthGatewayStdio(): Promise<void> {
	// Claimed before extension discovery so no in-process module can read the protocol's input.
	const input = claimRpcInput();
	const cwd = getProjectDir();
	const settings = await Settings.init({ cwd });
	const { accountPolicies } = await loadEffectiveAuthAccountPolicyConfig({ settings });
	const storage = await discoverAuthStorage(undefined, { settings, accountPolicies });
	let accountLimits: GatewayAccountLimits | undefined;
	const closeLedger = async () => {
		try {
			await accountLimits?.close();
		} catch (error) {
			logger.warn("auth-gateway usage ledger did not close cleanly", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	};
	let registry: ModelRegistry;
	try {
		// Account limits count this process's own calls in its agent.db.
		accountLimits = await installStdioAccountLimits(storage, accountPolicies, settings);
		registry = new ModelRegistry(storage);
		await registry.refresh();
		await loadCliExtensionProviders(registry, settings, cwd);
	} catch (error) {
		await closeLedger();
		storage.close();
		throw error;
	}

	// Candidates are routed by their exact `provider/id[@upstream]`, so the
	// router only ever resolves a model this process picked for the request.
	const routed = new Map<string, Model<Api>>();
	const router = createAuthGatewayRouter({
		storage,
		resolveModel: id => routed.get(id),
		listModels: () => registry.getAvailable(),
		onUsage: accountLimits?.onUsage,
	});
	const route = async (req: Request): Promise<Response> => {
		// Unparseable bodies pass through for the route to reject in its own wire format.
		const body: unknown = req.body
			? await req
					.clone()
					.json()
					.catch(() => undefined)
			: undefined;
		if (!isRecord(body) || typeof body.model !== "string") return router.route(req, STDIO_PEER);
		const selector = body.model;
		const candidates = selectorCandidates(selector, settings, registry);
		let response = Response.json(
			{ error: { message: `No available model matches "${selector}"`, type: "invalid_request_error" } },
			{ status: 404 },
		);
		for (const model of candidates) {
			const key = formatModelStringWithRouting(model);
			routed.set(key, model);
			const attempt = new Request(req.url, {
				method: req.method,
				headers: req.headers,
				body: JSON.stringify({ ...body, model: key }),
			});
			response = await router.route(attempt, STDIO_PEER);
			// 400 is the request's own fault and 499 its caller's: another model would fare no better.
			if (response.status <= 400 || response.status === 499) return response;
			logger.warn("auth-gateway stdio attempt failed", { selector, model: key, status: response.status });
		}
		return response;
	};

	try {
		await serveAuthGatewayStdio({ input, write: line => process.stdout.write(line), route, version: VERSION });
	} finally {
		// Stream responses record their usage after their last line is written.
		await settleAuthGatewayRouter(router);
		router.close();
		await closeLedger();
		storage.close();
	}
	// Idle provider sockets and settings timers would otherwise keep the process alive past stdin's end.
	await postmortem.quit(0);
}
