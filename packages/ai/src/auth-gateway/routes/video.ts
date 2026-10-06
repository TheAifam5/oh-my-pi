import type { Api, Model } from "@oh-my-pi/pi-catalog/types";
import { logger } from "@oh-my-pi/pi-utils";
import type { ResolvedApiKey } from "../../auth-retry";
import { classifyGatewayError } from "../../error/gateway";
import * as videoServer from "../../providers/video-server";
import { downloadVideo, pollVideo, submitVideo } from "../../video";
import type { VideoJob } from "../../video/types";
import { deterministicUuid } from "../../utils/deterministic-id";
import {
	type AuthGatewayRouteOptions,
	buildGatewayApiKeyResolver,
	GatewayServingAccount,
	hasRecordableUsage,
	mirrorRequestAbort,
	recordGatewayUsage,
	resolveGatewayApiKey,
	withCommittedSpend,
} from "../dispatch";
import { gatewayResponseHeaders, json, resolveClientIdentity } from "../http";

interface ResolvedVideoRequest {
	model: Model<Api>;
	upstreamId: string;
	sessionId: string;
	apiKey: ResolvedApiKey;
	serving: GatewayServingAccount;
	controller: AbortController;
}

function aborted(): Response {
	return videoServer.formatError(499, "request_aborted", "client closed request");
}

async function resolveVideoJob(
	bootOpts: AuthGatewayRouteOptions,
	req: Request,
	peer: string,
	gatewayId: string,
): Promise<ResolvedVideoRequest | Response> {
	const controller = mirrorRequestAbort(req);
	if (controller.signal.aborted) return aborted();
	let identity: videoServer.GatewayJobIdentity;
	try {
		identity = videoServer.decodeGatewayJobId(gatewayId);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return videoServer.formatError(400, "invalid_request_error", message);
	}
	const model = bootOpts.resolveModel(`${identity.provider}/${identity.modelId}`);
	if (!model) {
		return videoServer.formatError(
			404,
			"invalid_request_error",
			`Unknown model: ${identity.provider}/${identity.modelId}`,
		);
	}
	if (model.api !== "openrouter-video") {
		return videoServer.formatError(
			400,
			"invalid_request_error",
			`Model ${model.id} does not support video generation`,
		);
	}
	const sessionId = deterministicUuid(`video\u0000${model.provider}/${model.id}`);
	const apiKey = await resolveGatewayApiKey(bootOpts.storage, model, sessionId, controller.signal, peer);
	if (controller.signal.aborted) return aborted();
	if ("status" in apiKey) return videoServer.formatError(apiKey.status, apiKey.type, apiKey.message);
	const serving = new GatewayServingAccount(bootOpts.storage, model.provider, apiKey);
	return { model, upstreamId: identity.upstreamId, sessionId, apiKey, serving, controller };
}

function videoOptions(bootOpts: AuthGatewayRouteOptions, resolved: ResolvedVideoRequest, peer: string) {
	return {
		apiKey: buildGatewayApiKeyResolver(
			bootOpts.storage,
			resolved.model,
			resolved.sessionId,
			resolved.apiKey,
			resolved.controller.signal,
			"video",
			peer,
			next => resolved.serving.update(next),
		),
		fetch: bootOpts.fetch,
		signal: resolved.controller.signal,
	};
}

function logVideoRequest(
	requestId: string,
	operation: "submit" | "poll" | "content",
	model: ResolvedVideoRequest["model"],
	peer: string,
): void {
	logger.info("auth-gateway request", {
		requestId,
		format: `video-${operation}`,
		model: model.id,
		resolvedProvider: model.provider,
		resolvedModel: model.id,
		stream: operation === "content",
		peer,
	});
}

/**
 * Most completed jobs a {@link RecordedVideoJobs} remembers. The oldest is forgotten first, and a
 * restart forgets them all, so a job polled again after either is recorded again.
 */
const RECORDED_VIDEO_JOBS_MAX = 4096;

/** Completed video jobs whose usage a router already recorded, so repeated polls record it once. */
export class RecordedVideoJobs {
	/** Jobs whose ledger record is done or in flight. */
	#recorded = new Set<string>();
	/** Jobs the broker has observed; a retried ledger record does not observe them again. */
	#observed = new Set<string>();

	has(key: string): boolean {
		return this.#recorded.has(key);
	}

	/** Claim `key` for recording: undefined when already claimed, else whether the broker still has to observe it. */
	claim(key: string): { observe: boolean } | undefined {
		if (this.#recorded.has(key)) return undefined;
		remember(this.#recorded, key);
		const observe = !this.#observed.has(key);
		if (observe) remember(this.#observed, key);
		return { observe };
	}

	/** Forget the ledger record of `key`, so a later poll retries it. */
	release(key: string): void {
		this.#recorded.delete(key);
	}
}

/** Adds `key` to `keys`, forgetting the oldest past {@link RECORDED_VIDEO_JOBS_MAX}. */
function remember(keys: Set<string>, key: string): void {
	keys.add(key);
	if (keys.size > RECORDED_VIDEO_JOBS_MAX) keys.delete(keys.values().next().value!);
}

/**
 * A job's identity for {@link RecordedVideoJobs}: the provider the server resolved and the
 * provider's job id, which is unique per provider. The model named in the gateway job id is
 * client-supplied, so it stays out: naming another model must not record the job again.
 */
function recordedJobKey(resolved: ResolvedVideoRequest): string {
	return `${resolved.model.provider}\0${resolved.upstreamId}`;
}

function recordCompletedUsage(
	bootOpts: AuthGatewayRouteOptions,
	resolved: ResolvedVideoRequest,
	req: Request,
	job: VideoJob,
	recorded: RecordedVideoJobs,
): void {
	if (job.status !== "completed" || job.usage === undefined || !hasRecordableUsage(job.usage)) return;
	const key = recordedJobKey(resolved);
	const claim = recorded.claim(key);
	if (!claim) return;
	void recordGatewayUsage(bootOpts, resolved.model, resolveClientIdentity(req.headers), job.usage, resolved.serving, {
		observe: claim.observe,
	}).then(ok => {
		if (!ok) recorded.release(key);
	});
}

/** OpenRouter-compatible `POST /v1/videos` asynchronous video submit handler. */
export async function handleVideoSubmit(
	bootOpts: AuthGatewayRouteOptions,
	req: Request,
	peer: string,
): Promise<Response> {
	const startedAt = performance.now();
	const requestId = crypto.randomUUID();
	const controller = mirrorRequestAbort(req);
	if (controller.signal.aborted) return aborted();
	let parsed: videoServer.VideoParsedRequest;
	try {
		parsed = videoServer.parseRequest(await req.json());
	} catch (error) {
		if (controller.signal.aborted) return aborted();
		const message = error instanceof Error ? error.message : String(error);
		return videoServer.formatError(400, "invalid_request_error", message);
	}
	const model = bootOpts.resolveModel(parsed.modelId);
	if (!model) return videoServer.formatError(404, "invalid_request_error", `Unknown model: ${parsed.modelId}`);
	if (model.api !== "openrouter-video") {
		return videoServer.formatError(
			400,
			"invalid_request_error",
			`Model ${parsed.modelId} does not support video generation`,
		);
	}
	const sessionId = deterministicUuid(`video\u0000${model.provider}/${model.id}`);
	const apiKey = await resolveGatewayApiKey(bootOpts.storage, model, sessionId, controller.signal, peer);
	if (controller.signal.aborted) return aborted();
	if ("status" in apiKey) return videoServer.formatError(apiKey.status, apiKey.type, apiKey.message);
	logger.info("auth-gateway request", {
		requestId,
		format: "video-submit",
		model: parsed.modelId,
		resolvedProvider: model.provider,
		resolvedModel: model.id,
		stream: false,
		peer,
	});
	try {
		const job = await submitVideo(model, parsed.request, {
			apiKey: buildGatewayApiKeyResolver(
				bootOpts.storage,
				model,
				sessionId,
				apiKey,
				controller.signal,
				"video",
				peer,
			),
			fetch: bootOpts.fetch,
			signal: controller.signal,
		});
		const gatewayId = videoServer.encodeGatewayJobId({
			provider: model.provider,
			modelId: model.id,
			upstreamId: job.id,
		});
		return json(
			202,
			videoServer.encodeSubmitResponse(job, req, gatewayId),
			gatewayResponseHeaders(model, { requestId, startedAt }),
		);
	} catch (error) {
		if (controller.signal.aborted) return aborted();
		const classified = classifyGatewayError(error);
		logger.warn("auth-gateway video submit failed", { format: "video-submit", error: classified.message, peer });
		return videoServer.formatError(classified.status, classified.type, classified.message);
	}
}

/**
 * OpenRouter-compatible `GET /v1/videos/:id` asynchronous video poll handler. A submitted job is
 * already paid for, so its polls are never refused by a local account limit; a completed job's
 * usage is recorded on the first poll that sees it.
 */
export function handleVideoPoll(
	bootOpts: AuthGatewayRouteOptions,
	req: Request,
	peer: string,
	gatewayId: string,
	recorded: RecordedVideoJobs,
): Promise<Response> {
	return withCommittedSpend(() => pollVideoJob(bootOpts, req, peer, gatewayId, recorded));
}

async function pollVideoJob(
	bootOpts: AuthGatewayRouteOptions,
	req: Request,
	peer: string,
	gatewayId: string,
	recorded: RecordedVideoJobs,
): Promise<Response> {
	const startedAt = performance.now();
	const requestId = crypto.randomUUID();
	const resolved = await resolveVideoJob(bootOpts, req, peer, gatewayId);
	if (resolved instanceof Response) return resolved;
	logVideoRequest(requestId, "poll", resolved.model, peer);
	try {
		const job = await pollVideo(resolved.model, resolved.upstreamId, videoOptions(bootOpts, resolved, peer));
		recordCompletedUsage(bootOpts, resolved, req, job, recorded);
		return json(
			200,
			videoServer.encodePollResponse(job, req, gatewayId),
			gatewayResponseHeaders(resolved.model, {
				requestId,
				...(job.usage !== undefined && { costUsd: job.usage.cost.total }),
				startedAt,
			}),
		);
	} catch (error) {
		if (resolved.controller.signal.aborted) return aborted();
		const classified = classifyGatewayError(error);
		logger.warn("auth-gateway video poll failed", { format: "video-poll", error: classified.message, peer });
		return videoServer.formatError(classified.status, classified.type, classified.message);
	}
}

/**
 * OpenRouter-compatible `GET /v1/videos/:id/content` streaming video content handler; like polls,
 * never refused by a local account limit. A job no poll recorded yet is polled once first, so a
 * client that skips polling is still charged.
 */
export function handleVideoContent(
	bootOpts: AuthGatewayRouteOptions,
	req: Request,
	peer: string,
	gatewayId: string,
	recorded: RecordedVideoJobs,
): Promise<Response> {
	return withCommittedSpend(() => fetchVideoContent(bootOpts, req, peer, gatewayId, recorded));
}

async function fetchVideoContent(
	bootOpts: AuthGatewayRouteOptions,
	req: Request,
	peer: string,
	gatewayId: string,
	recorded: RecordedVideoJobs,
): Promise<Response> {
	const startedAt = performance.now();
	const requestId = crypto.randomUUID();
	const resolved = await resolveVideoJob(bootOpts, req, peer, gatewayId);
	if (resolved instanceof Response) return resolved;
	logVideoRequest(requestId, "content", resolved.model, peer);
	if (!recorded.has(recordedJobKey(resolved))) {
		try {
			const job = await pollVideo(resolved.model, resolved.upstreamId, videoOptions(bootOpts, resolved, peer));
			recordCompletedUsage(bootOpts, resolved, req, job, recorded);
		} catch (error) {
			if (resolved.controller.signal.aborted) return aborted();
			logger.warn("auth-gateway video status before content failed", {
				format: "video-content",
				error: classifyGatewayError(error).message,
				peer,
			});
		}
	}
	try {
		const content = await downloadVideo(resolved.model, resolved.upstreamId, videoOptions(bootOpts, resolved, peer));
		const headers = new Headers(gatewayResponseHeaders(resolved.model, { requestId, startedAt }));
		headers.set("Content-Type", content.contentType);
		headers.set("X-Content-Type-Options", "nosniff");
		if (content.contentLength !== undefined) headers.set("Content-Length", String(content.contentLength));
		return new Response(content.body, { status: 200, headers });
	} catch (error) {
		if (resolved.controller.signal.aborted) return aborted();
		const classified = classifyGatewayError(error);
		logger.warn("auth-gateway video content failed", { format: "video-content", error: classified.message, peer });
		return videoServer.formatError(classified.status, classified.type, classified.message);
	}
}
