/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import * as path from "node:path";
import { isRecord } from "@oh-my-pi/pi-utils";
import { register, type SettingValueOf } from "./registry";
import type { AuthAccountPolicies } from "@oh-my-pi/pi-ai/auth-storage";
import { ACCOUNT_NAME, MAX_ACCOUNT_NAME_LENGTH } from "@oh-my-pi/pi-ai/auth/policy";
import type { cfgDefaultThinkingLevel } from "../session/settings";
import { parseLimitsSetting } from "./local-limits";
import { assertModelGroupSectionWritable } from "./model-groups";

/** Display metadata for one model tag. */
export interface ModelTagDef {
	name: string;
	color?: string;
	/** If true, the role is functional but not shown in the model selector UI. */
	hidden?: boolean;
}

/**
 * One configured `modelRoles` entry: a selector string, a selector list, or a model-group mapping
 * (inline group or `use` reference); see `config/model-groups.ts`.
 */
export type ModelRoleEntry = string | readonly string[] | Readonly<Record<string, unknown>>;

/** Model tags keyed by tag id (`modelTags`). */
export type ModelTagsSettings = Record<string, ModelTagDef>;

/**
 * One saved model preset (`modelPresets.<name>`): the role assignments and default thinking level
 * captured by `/modelpreset save` or the model hub, re-applied as a whole by `/modelpreset switch`.
 */
export interface ModelPreset {
	modelRoles: Record<string, string>;
	/** `defaultThinkingLevel` at save time; absent in hand-written presets that leave it alone. */
	defaultThinkingLevel?: SettingValueOf<typeof cfgDefaultThinkingLevel>;
}

const EMPTY_STRING_ARRAY: string[] = [];
const EMPTY_MODEL_ROLES_RECORD: Record<string, ModelRoleEntry> = {};
const DEFAULT_CYCLE_ORDER: string[] = ["smol", "default", "slow"];
const EMPTY_MODEL_TAGS_RECORD: ModelTagsSettings = {};
const EMPTY_MODEL_GROUPS_RECORD: Record<string, Record<string, unknown>> = {};
const EMPTY_MODEL_PRESETS_RECORD: Record<string, ModelPreset> = {};
const EMPTY_AUTH_ACCOUNT_POLICIES: AuthAccountPolicies = [];
const EMPTY_AUTH_ACCOUNT_PINS: AuthAccountPins = {};
const EMPTY_LIMITS: Readonly<Record<string, unknown>> = {};

// Auth broker — credentials proxied through a remote `omp auth-broker serve`
// host. Hidden from the UI; populate via env vars or hand-edited config.yml. Env takes
// precedence so per-machine overrides remain trivial. The connection itself is resolved by
// `@oh-my-pi/pi-ai/auth-broker/discover` from env + global config.yml only (project layers
// never redirect credentials); these definitions own validation, CLI, and `cfg://` display.
export const cfgAuthBrokerUrl = register({
	id: "auth.broker.url",
	type: "string",
	default: undefined,
	env: "OMP_AUTH_BROKER_URL",
});

export const cfgAuthBrokerToken = register({
	id: "auth.broker.token",
	type: "string",
	default: undefined,
	env: "OMP_AUTH_BROKER_TOKEN",
	credential: true,
});

export const cfgAuthAccountPolicies = register({
	id: "auth.accountPolicies",
	type: "array",
	default: EMPTY_AUTH_ACCOUNT_POLICIES,
});

/** Project account pins: absolute project directory → provider id → account name. */
export type AuthAccountPins = Readonly<Record<string, Readonly<Record<string, string>>>>;

function validateAuthAccountPins(raw: unknown): void {
	if (!isRecord(raw)) return;
	for (const [project, pins] of Object.entries(raw)) {
		if (!path.isAbsolute(project))
			throw new Error(`auth.accountPins keys must be absolute project paths: ${project}`);
		if (!isRecord(pins)) throw new Error(`auth.accountPins["${project}"] must map provider ids to account names`);
		for (const [provider, name] of Object.entries(pins)) {
			if (typeof name !== "string" || name.length > MAX_ACCOUNT_NAME_LENGTH || !ACCOUNT_NAME.test(name)) {
				throw new Error(
					`auth.accountPins["${project}"].${provider} must be an account name matching ${ACCOUNT_NAME.source}`,
				);
			}
		}
	}
}

/**
 * Pins one provider account to every session whose working directory is inside a project.
 * Read from the global config, `--config` overlays, and runtime overrides only; project settings
 * cannot pin accounts.
 */
export const cfgAuthAccountPins = register({
	id: "auth.accountPins",
	type: "record",
	default: EMPTY_AUTH_ACCOUNT_PINS,
	validate: validateAuthAccountPins,
});

/**
 * Local limits on spend, requests, and tokens, keyed by `provider/model-id`, `provider`, or `*`.
 * Read from the global config, `--config` overlays, and runtime overrides only; project settings
 * cannot set them.
 */
export const cfgLimits = register({
	id: "limits",
	type: "record",
	default: EMPTY_LIMITS,
	entryMerge: "replace",
	validate: raw => {
		parseLimitsSetting(raw);
	},
	dropInvalidInProject: true,
});

export const cfgEnabledModels = register({
	id: "enabledModels",
	type: "array",
	default: EMPTY_STRING_ARRAY,
	pathScoped: { valuesKey: "models" },
});

export const cfgEnabledProviders = register({
	id: "enabledProviders",
	type: "array",
	default: EMPTY_STRING_ARRAY,
	pathScoped: { valuesKey: "providers" },
});

export const cfgDisabledProviders = register({
	id: "disabledProviders",
	type: "array",
	default: EMPTY_STRING_ARRAY,
	pathScoped: { valuesKey: "providers" },
});

export const cfgModelRoleStorage = register({
	id: "modelRoleStorage",
	type: "enum",
	values: ["global", "project"] as const,
	default: "global",
	ui: {
		tab: "model",
		group: "Prompt",
		label: "Model Role Storage",
		description: "Where model selector role assignments are saved",
		options: [
			{
				value: "global",
				label: "Global",
				description: "Save role models in the active profile config (current behavior)",
			},
			{
				value: "project",
				label: "Per-project",
				description: "Save project role models in .omp/config.yml; missing project roles use global defaults",
			},
		],
	},
});

export const cfgModelRoles = register({
	id: "modelRoles",
	type: "record",
	default: EMPTY_MODEL_ROLES_RECORD,
	entryMerge: "replace",
	validateWrite: raw => assertModelGroupSectionWritable("modelRoles", raw),
});

/** Named model groups (`modelGroups.<name>`), referenced from roles and fallback chains by `use` or `+<name>`. */
export const cfgModelGroups = register({
	id: "modelGroups",
	type: "record",
	default: EMPTY_MODEL_GROUPS_RECORD,
	entryMerge: "replace",
	validateWrite: raw => assertModelGroupSectionWritable("modelGroups", raw),
});

/**
 * Lets project settings add pools whose funding includes `metered` and redefine `modelGroups`
 * entries that a lower layer defines. Read from the global config, `--config` overlays, and runtime
 * overrides; a project-layer value is ignored with a warning.
 */
export const cfgAllowProjectMeteredPools = register({
	id: "allowProjectMeteredPools",
	type: "boolean",
	default: false,
});

/** Named model presets; no settings-panel UI — managed by `/modelpreset` and the model hub. */
export const cfgModelPresets = register({
	id: "modelPresets",
	type: "record",
	default: EMPTY_MODEL_PRESETS_RECORD,
});

export const cfgModelTags = register({ id: "modelTags", type: "record", default: EMPTY_MODEL_TAGS_RECORD });

export const cfgModelProviderOrder = register({ id: "modelProviderOrder", type: "array", default: EMPTY_STRING_ARRAY });

export const cfgCycleOrder = register({ id: "cycleOrder", type: "array", default: DEFAULT_CYCLE_ORDER });
