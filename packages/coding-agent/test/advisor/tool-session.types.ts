import type { AdvisorToolSessionOverrides } from "../../src/advisor/tool-session";
import type { ToolSession } from "../../src/tools";

type Assert<T extends true> = T;
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type RequiredKeys<T> = { [Key in keyof T]-?: {} extends Pick<T, Key> ? never : Key }[keyof T];

type RestrictedKeys =
	| "memoryContext"
	| "listAdvisorFindings"
	| "getAdvisorFinding"
	| "resolveAdvisorFindings"
	| "reopenAdvisorFindings"
	| "agentRegistry"
	| "enableIrc"
	| "getToolByName"
	| "getToolForEvalBridge"
	| "getEvalBridgeToolNames"
	| "toolRegistry";

export type CurrentOverridesAreExhaustive = Assert<Same<keyof AdvisorToolSessionOverrides, RestrictedKeys>>;
export type EveryRestrictedFieldRequiresAnOverride = Assert<
	Same<RequiredKeys<AdvisorToolSessionOverrides>, RestrictedKeys>
>;

type ExtendedToolSession = ToolSession & { newCapability?: () => void };
type ExtendedOverrides = AdvisorToolSessionOverrides<ExtendedToolSession>;

export type NewOptionalCapabilityRequiresAnOverride = Assert<
	Same<RequiredKeys<ExtendedOverrides>, RestrictedKeys | "newCapability">
>;
export type ExistingOverridesCannotCoverNewCapability = Assert<
	Same<AdvisorToolSessionOverrides extends ExtendedOverrides ? true : false, false>
>;
