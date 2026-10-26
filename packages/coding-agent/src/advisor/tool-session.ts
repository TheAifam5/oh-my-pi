import type { ToolSession } from "../tools";

type AllowedAdvisorToolSessionKey = keyof Pick<
	ToolSession,
	| "cwd"
	| "additionalDirectories"
	| "hasUI"
	| "canPromptUser"
	| "advertiseHeadlessAsk"
	| "settingsApproval"
	| "isDisposed"
	| "suppressSpawnAdvisory"
	| "fetch"
	| "getApiKey"
	| "getCredentialSourceSessionId"
	| "skipPythonPreflight"
	| "contextFiles"
	| "workspaceTree"
	| "skills"
	| "skillHintVisible"
	| "refreshSkills"
	| "promptTemplates"
	| "rules"
	| "activeRules"
	| "extensionPaths"
	| "preparedExtensions"
	| "effectiveExtensionRoots"
	| "customToolPaths"
	| "enableLsp"
	| "lspReadOnly"
	| "enableMCP"
	| "hasEditTool"
	| "eventBus"
	| "subagentEventBus"
	| "outputSchema"
	| "outputSchemaMode"
	| "requireYieldTool"
	| "prewalkArmed"
	| "restrictToolNames"
	| "seanceSourceArtifactsDir"
	| "taskDepth"
	| "getEvalSessionId"
	| "getSessionFile"
	| "sessionManager"
	| "getEvalKernelOwnerId"
	| "getEvalPreludes"
	| "getAdvertisedEvalPreludes"
	| "assertEvalExecutionAllowed"
	| "trackEvalExecution"
	| "getSessionId"
	| "getProviderSessionId"
	| "getHindsightSessionState"
	| "getMnemopiSessionState"
	| "getAgentId"
	| "getPromptCacheKey"
	| "getToolContext"
	| "isToolActive"
	| "isToolAdvertised"
	| "getAdvertisedToolSettings"
	| "setActiveToolNames"
	| "xdev"
	| "deviceOnlyWrite"
	| "pendingFullWriteDescription"
	| "agentLifecycle"
	| "getArtifactsDir"
	| "getArtifactManager"
	| "allocateOutputArtifact"
	| "getSessionSpawns"
	| "getSessionAgents"
	| "advertisedSessionAgents"
	| "getModelString"
	| "getActiveModelString"
	| "getActiveModel"
	| "getServiceTierByFamily"
	| "emitBeforeSubagentSpawn"
	| "authStorage"
	| "modelRegistry"
	| "agentOutputManager"
	| "asyncJobManager"
	| "mcpManager"
	| "localProtocolOptions"
	| "settings"
	| "getPlanModeState"
	| "getPlanReferencePath"
	| "getGoalModeState"
	| "getGoalRuntime"
	| "getUsageStatistics"
	| "getTurnBudget"
	| "recordEvalSubagentUsage"
	| "getClientBridge"
	| "getTodoPhases"
	| "setTodoPhases"
	| "persistTodoPhases"
	| "getWorkPoolYieldItems"
	| "getLastAssistantText"
	| "getYieldReportText"
	| "getToolCallIntent"
	| "setWorkPoolYieldItems"
	| "getToolChoiceQueue"
	| "buildToolChoice"
	| "steer"
	| "peekQueueInvoker"
	| "peekPendingInvoker"
	| "clearPendingInvokers"
	| "peekPlanProposalHandler"
	| "setPlanProposalHandler"
	| "getCheckpointState"
	| "setCheckpointState"
	| "getLastCompletedRewind"
	| "editStore"
	| "conflictHistory"
	| "diagnosticsLedger"
	| "queueDeferredMessage"
	| "queueLaunchCompletion"
	| "registerDisposeCallback"
	| "registerSessionChangeCallback"
	| "queueDeferredDiagnostics"
	| "bumpFileMutationVersion"
	| "getFileMutationVersion"
	| "getTelemetry"
	| "getImageAttachments"
>;

/** Every session field not explicitly allowed requires an advisor-local replacement. */
export type AdvisorToolSessionOverrides<Session extends ToolSession = ToolSession> = {
	[Key in Exclude<keyof Session, AllowedAdvisorToolSessionKey>]-?: Session[Key];
};

/** Removes primary peer, findings-management, and tool-lookup capabilities from an advisor session. */
export function isolateAdvisorToolSession(session: ToolSession): ToolSession {
	const memoryContext = session.memoryContext ?? session;
	const scopedMemoryContext = {
		get settings() {
			return memoryContext.settings;
		},
		getMnemopiSessionState: memoryContext.getMnemopiSessionState?.bind(memoryContext),
		isDisposed: memoryContext.isDisposed?.bind(memoryContext),
	};
	const overrides = {
		memoryContext: scopedMemoryContext,
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
	} satisfies AdvisorToolSessionOverrides;
	const sourceDescriptors = Object.getOwnPropertyDescriptors(session);
	const overrideDescriptors = Object.getOwnPropertyDescriptors(overrides);
	const descriptors = Object.assign(sourceDescriptors, overrideDescriptors);
	return Object.create(Object.getPrototypeOf(session), descriptors);
}
