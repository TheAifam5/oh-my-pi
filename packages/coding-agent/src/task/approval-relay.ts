import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { replaceTabs, truncateToWidth } from "@oh-my-pi/pi-tui";
import { PREVIEW_LIMITS, TRUNCATE_LENGTHS } from "@oh-my-pi/pi-tui/render/render-utils";
import { isRecord, sanitizeText, untilAborted } from "@oh-my-pi/pi-utils";
import type { ExtensionAgentIdentity, ExtensionUIContext } from "../extensibility/extensions/types";
import { requestApproval } from "../tools/approval";
import type { EventBus } from "../utils/event-bus";

const REQUEST = "task:approval:request";
const RESPONSE = "task:approval:response";
const hosts = new WeakMap<EventBus, ApprovalRelayHost>();

type ApprovalTool = Pick<
	AgentTool,
	"name" | "approval" | "approvalActions" | "formatApprovalDetails" | "approvalCacheTargets"
>;
interface RelayRequest {
	id: string;
	agent: ExtensionAgentIdentity;
	tool: ApprovalTool;
	args: unknown;
	reason?: string;
	signal: AbortSignal;
}

function approvalDisplay(text: string): string {
	return replaceTabs(sanitizeText(text))
		.split("\n", PREVIEW_LIMITS.EXPANDED_LINES)
		.map(line => truncateToWidth(line, TRUNCATE_LENGTHS.LINE))
		.join("\n");
}

export class ApprovalRelayHost {
	#queue: RelayRequest[] = [];
	#active = false;
	#disposed = new AbortController();
	#unsubscribe: () => void;

	constructor(
		readonly bus: EventBus,
		readonly getUI: () => Pick<ExtensionUIContext, "select" | "approve"> | undefined,
	) {
		hosts.set(bus, this);
		this.#unsubscribe = bus.on(REQUEST, data => {
			if (!isRecord(data) || typeof data.id !== "string" || !(data.signal instanceof AbortSignal)) return;
			const request = data as unknown as RelayRequest;
			if (!this.getUI() || this.#queue.length >= 1024) {
				this.#respond(request.id, false);
				return;
			}
			this.#queue.push(request);
			void this.#drain();
		});
	}

	#respond(id: string, approved: boolean): void {
		this.bus.emit(RESPONSE, { id, approved });
	}

	async #drain(): Promise<void> {
		if (this.#active) return;
		this.#active = true;
		try {
			while (this.#queue.length > 0) {
				const request = this.#queue.shift()!;
				const signal = AbortSignal.any([request.signal, this.#disposed.signal]);
				let approved = false;
				try {
					const ui = this.getUI();
					if (ui && !signal.aborted) {
						const label = approvalDisplay(`${request.agent.id} (${request.agent.name})`);
						const preview = approvalDisplay(JSON.stringify(request.args) ?? "");
						const details = request.tool.formatApprovalDetails?.(request.args);
						const displayTool = {
							approval: request.tool.approval,
							approvalActions: request.tool.approvalActions,
							name: approvalDisplay(request.tool.name),
							formatApprovalDetails: () =>
								(typeof details === "string" ? [details] : (details ?? [])).map(approvalDisplay),
						};
						const answer = await untilAborted(signal, () =>
							requestApproval(ui, displayTool, request.args, {
								reason: request.reason ? approvalDisplay(request.reason) : undefined,
								appendix: [`Requesting agent: ${label}`, `Arguments: ${preview}`],
								signal,
							}),
						);
						approved = answer === "once" && !signal.aborted;
					}
				} catch {
					approved = false;
				}
				this.#respond(request.id, approved);
			}
		} finally {
			this.#active = false;
		}
	}

	dispose(): void {
		this.#disposed.abort();
		this.#unsubscribe();
		if (hosts.get(this.bus) === this) hosts.delete(this.bus);
		for (const request of this.#queue.splice(0)) this.#respond(request.id, false);
	}
}

export async function relayApproval(
	bus: EventBus,
	agent: ExtensionAgentIdentity,
	tool: ApprovalTool,
	args: unknown,
	timeoutMs: number,
	signal?: AbortSignal,
	reason?: string,
): Promise<boolean> {
	if (!hosts.get(bus)?.getUI()) {
		throw new Error(
			`Tool "${tool.name}" requires approval for agent "${agent.id}" (${agent.name}) but the root has no interactive approval UI. ` +
				`Use an interactive root session to relay approval, or configure trusted task.agentApproval.${agent.name}.${tool.name}: allow.`,
		);
	}
	if (signal?.aborted) return false;
	const controller = new AbortController();
	const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
	const pending = Promise.withResolvers<boolean>();
	const id = crypto.randomUUID();
	const unsubscribe = bus.on(RESPONSE, data => {
		if (isRecord(data) && data.id === id) pending.resolve(data.approved === true && !combined.aborted);
	});
	const abort = () => pending.resolve(false);
	combined.addEventListener("abort", abort, { once: true });
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		bus.emit(REQUEST, { id, agent, tool, args, reason, signal: combined } satisfies RelayRequest);
		return await pending.promise;
	} catch {
		return false;
	} finally {
		clearTimeout(timer);
		unsubscribe();
		combined.removeEventListener("abort", abort);
		controller.abort();
	}
}
