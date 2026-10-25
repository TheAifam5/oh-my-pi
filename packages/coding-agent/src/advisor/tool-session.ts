import type { ToolSession } from "../tools";

/** Removes primary peer, findings-management, and tool-lookup capabilities from an advisor session. */
export function isolateAdvisorToolSession(session: ToolSession): ToolSession {
	const memoryContext = session.memoryContext ?? session;
	const descriptors = Object.assign(
		Object.getOwnPropertyDescriptors(session),
		Object.getOwnPropertyDescriptors({
			memoryContext: {
				get settings() {
					return memoryContext.settings;
				},
				getMnemopiSessionState: memoryContext.getMnemopiSessionState?.bind(memoryContext),
				isDisposed: memoryContext.isDisposed?.bind(memoryContext),
			},
			listAdvisorFindings: undefined,
			getAdvisorFinding: undefined,
			resolveAdvisorFindings: undefined,
			reopenAdvisorFindings: undefined,
			agentRegistry: undefined,
			enableIrc: false,
			getToolByName: undefined,
			getToolForEvalBridge: undefined,
			getEvalBridgeToolNames: undefined,
			toolRegistry: undefined,
		}),
	);
	return Object.create(Object.getPrototypeOf(session), descriptors);
}
