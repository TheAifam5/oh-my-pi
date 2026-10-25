import { HubPrefs, type HubPrefsField, type HubPrefsValue } from "./hub-prefs";
import {
	parseModelString,
	splitThinkingSuffix,
	splitUpstreamRouting,
	formatModelSelectorValue,
} from "./model-selector";
import { isRecord, logger } from "@oh-my-pi/pi-utils";
import { sanitizeDisplayLine } from "./extensions/display-text";
/**
 * Fullscreen /models hub, shown on the alternate screen like /settings.
 *
 * Layout: a sidebar of scopes (recently used, role management, all models,
 * one entry per provider — locked providers included, dimmed) beside a
 * {@link ModelBrowser} body. The Roles view manages assignments directly:
 * pick a role, pick a model, adjust thinking in an inline strip, or clear the
 * role back to auto-selection. Locked providers forward to the /login flow.
 * Fully mouse-navigable (hover, wheel, click). Session-only switching lives
 * in the compact alt+p picker ({@link ./model-picker}).
 */
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type {
	TspPickerAction,
	TspPickerColumn,
	TspPickerGroup,
	TspPickerItem,
	TspPickerProps,
	TspPickerScope,
	TspSpan,
} from "@oh-my-pi/pi-wire";
import type { KeysApi, Model } from "@oh-my-pi/pi-ai";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { providerEntry } from "@oh-my-pi/pi-catalog/compat/providers";
import { MODEL_KINDS, modelKind, type ModelKind } from "@oh-my-pi/pi-catalog/types";
import type { Component, TUI } from "../tui";
import { extractPrintableText, matchesKey } from "../keys";
import { FuzzyCorpus } from "../fuzzy";
import { formatKeyHint, formatKeyHints } from "../app-keybindings";
import { boundKeys, editorKey } from "../chrome/keybinding-hints";
import type { KeyName } from "../key-hint-format";
import { col, compact, kbd, md, node, span, text } from "../native/describe";
import {
	CLOSE_ACTION,
	type PickerEvent,
	picker,
	pickerAction,
	pickerActionHints,
	pickerEvent,
	pickerHits,
	pickerQuery,
} from "../native/picker";
import type { DescribeContext, NativeChild, NativeNode, NativeUiEvent } from "../native/node";
import { actionHint, hintsRow, type NativeHint } from "../native/overlay";
import { plainText } from "../native/spans";
import { isNativeRendering } from "../native/state";
import { Input } from "../components/input";
import { routeSgrMouseInput, type SgrMouseEvent } from "../mouse";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../utils";
import type {
	ModelBrowserSource,
	ModelBrowserRegistry,
	ModelRoleLookup,
	ResolvedModelRoleValue,
} from "./model-browser";
import { AUTO_THINKING, type ConfiguredThinkingLevel, getConfiguredThinkingLevelMetadata } from "../thinking";
import { sanitizeDisplayWarning, thinkingLevelGlyph } from "../render/render-utils";
import { theme } from "../theme/theme";
import { matchesSelectCancel, matchesSelectDown, matchesSelectUp } from "../keybinding-matchers";
import {
	buildBrowserItems,
	MODEL_PICKER_COLUMNS,
	ModelBrowser,
	type ModelBrowserItem,
	modelSearchText,
	providerMark,
	thinkingDotToken,
	type RoleAssignments,
	resolveRoleAssignments,
	scopedRolePool,
	sortModelItems,
} from "./model-browser";
import {
	describeHubFrame,
	describeHubSidebar,
	HubFrame,
	moveStripSelection,
	pagedHints,
	type SidebarEntry as HubSidebarEntry,
	type SidebarStyle,
	type StripChip as HubStripChip,
	type StripState as HubStripState,
} from "./hub-frame";
import { renderSegmentTrack } from "../chrome/segment-track";
import {
	accountDrain,
	accountList,
	accountOrder,
	appendPoolLimit,
	BUDGET_SPEC_USAGE,
	draftRecord,
	formatBudgetSpec,
	POOL_DRAIN_RETURN,
	POOL_DRAIN_SPEND,
	poolLimitList,
	removePoolLimit,
	setAccountDrain,
	setMeteredSpending,
	setQuotaTolerance,
	spendingPolicy,
	strategyNames,
	parseBudgetSpec,
} from "./model-hub-routing";

const MODEL_HUB_BODY_MIN_WIDTH = 28;

/**
 * A row of the Roles view: a role, a model/wildcard chain-key header, one of a
 * chain's fallback entries, or the trailing "+ New role…". Fallback rows under
 * a chain-key header carry the key in `role` — `retry.fallbackChains` treats
 * roles, `provider/model-id`, and `provider/*` keys uniformly. A role whose
 * value is a pool summarizes it on its own row; a chain configured as a pool
 * gets a `pool` summary row in place of its entries. `poolMember` rows list a
 * pool's members under its summary. The Groups view lists one `group` row per
 * `modelGroups` entry (`role` holds its name) with its members, then `newGroup`.
 */
type RolesRow =
	| { kind: "role"; role: string }
	| { kind: "chainKey"; role: string }
	| { kind: "fallback"; role: string; chainIndex: number; selector: string }
	| { kind: "pool"; role: string }
	| { kind: "poolMember"; role: string; target: ModelHubPoolTarget; alias: string }
	| { kind: "group"; role: string }
	| { kind: "profile"; role: string; profile: string }
	| { kind: "separator" }
	| { kind: "newFallback" }
	| { kind: "newRole" }
	| { kind: "newGroup" };

/**
 * What the model browser is currently picking for: a role's model, a slot in
 * a fallback chain (`role` may be a role name, model selector, or `provider/*`
 * key), the primary model a brand-new fallback chain protects, a pool
 * member (`alias` replaces that member, `null` adds one), or the first member
 * of the new `modelGroups.<name>`.
 */
type AssignTarget =
	| { kind: "role"; role: string }
	| { kind: "fallback"; role: string; index: number | null }
	| { kind: "fallbackKey" }
	| { kind: "poolMember"; role: string; target: ModelHubPoolTarget; alias: string | null }
	| { kind: "newGroup"; name: string };

/** A pool's settings entry: a role's `modelRoles` value, a `retry.fallbackChains` entry, or a `modelGroups` entry. */
export interface ModelHubPoolTarget {
	kind: "role" | "chain" | "group";
	key: string;
}

/** A role or chain entry that references a model group, with the profile its own value selects. */
export interface ModelHubGroupReference extends ModelHubPoolTarget {
	profile?: string;
	/** The reference is stored in the global layer, even when another layer shadows it. */
	global?: boolean;
}

/** One pool member as the hub shows it. */
export interface ModelHubPoolMember {
	alias: string;
	/** `provider/model-id`. */
	model: string;
	/** Effort the pool runs the member at: the selected profile's override, else its `defaultEffort`. */
	effort?: string;
	weight?: number;
}

/** View of a pool configured at a role or fallback-chain entry. */
export interface ModelHubPool {
	/** `inline`: the group is written at the entry; `ref`: the entry names `modelGroups.<group>`. */
	source: { kind: "inline" } | { kind: "ref"; group: string; profile?: string };
	/** Strategy name; a strategy list as its names joined by ` → `. */
	strategy: string;
	/** Members in scheduling order: the `order` of a priority or round-robin strategy, else alias order. */
	members: readonly ModelHubPoolMember[];
	/** Authorized billing classes in funding order; empty when the pool configures none. */
	funding: readonly string[];
	/** Spending policy as display text. */
	spending?: string;
	/** Local limits as display text (how many, and the one closest to its cap). */
	limits?: string;
	/** `routing.quota` as display text (reserve, observation age, unknown handling). */
	quota?: string;
	/** `routing.accounts` as display text (order, drain target, drain spend, return triggers). */
	accounts?: string;
	/** `routing.cache` as display text (affinity, pricing). */
	cache?: string;
	/**
	 * The group's profiles in name order: per-member effort overrides by alias. A member a profile
	 * leaves out keeps its `defaultEffort`. Absent or empty: the group defines none.
	 */
	profiles?: readonly { name: string; efforts: Readonly<Record<string, string>> }[];
	/** Why the hub must not edit this pool; undefined when it may. */
	readOnly?: string;
	/**
	 * Validation problems of a global entry that the settings merge drops, so the entry selects no
	 * model; the hub can only remove such an entry. Undefined for a valid pool.
	 */
	invalid?: string;
	/**
	 * The configuration edits replace, present only when the hub may edit it: the entry for an inline
	 * pool, the `modelGroups.<group>` definition for a reference. Edits round-trip through a copy.
	 */
	raw?: Readonly<Record<string, unknown>>;
	/** Effective configuration for disabled preference rows; never used for writes. */
	effective?: Readonly<Record<string, unknown>>;
}

/** A pool limit parsed from the `<metric> <max> [<window>] [warn|skip]` syntax, or why it does not parse. */
export type ModelHubLimitSpecResult = { limit: Readonly<Record<string, unknown>> } | { error: string };

/** Live preferences and selector operations supplied by the host. */
export interface ModelHubSource extends ModelBrowserSource {
	readonly disabledProviders: readonly string[];
	readonly fallbackChains: Record<string, string[]>;
	/** `retry.fallbackChains` keys configured as a model group; list edits never write them. Absent: none. */
	readonly fallbackChainGroupKeys?: readonly string[];
	readonly modelRoleStorage: "global" | "project";
	readonly cycleOrder: readonly string[];
	getProjectModelRole(role: string): string | undefined;
	getGlobalModelRole(role: string): string | undefined;
	getModelRoleSource(role: string): "global" | "project" | "default";
	/**
	 * Saved model presets (in switch order) and the one the current role setup
	 * matches, if any. Absent hosts have no presets to switch between.
	 */
	getModelPresets?(): { names: readonly string[]; active: string | undefined };
	/**
	 * Pool configured at `target`; undefined for a legacy or unset entry, or an invalid entry that is
	 * not a global role entry. An invalid global role entry yields a pool with `invalid` set. Absent
	 * hosts have no pools.
	 */
	getPool?(target: ModelHubPoolTarget): ModelHubPool | undefined;
	/** Whether `modelRoles.<role>` may hold a pool; absent means no role does. */
	roleAcceptsPools?(role: string): boolean;
	/** Why a pool written at `target` would not take effect (another layer supplies the entry); undefined when it would. */
	poolWriteBlocker?(target: ModelHubPoolTarget): string | undefined;
	/**
	 * Billing state of the provider of `provider/model-id` (every model of a provider reads the
	 * same) as display text, from the usage reports the host last polled; must not fetch.
	 * Undefined, or an absent member, shows no billing.
	 */
	billingFor?(model: string): string | undefined;
	/** Changes (by identity) whenever {@link billingFor} may answer differently; absent: never. */
	readonly billingRevision?: unknown;
	/** Names of the stored accounts (`auth.accountPolicies[].name`) `routing.accounts` may list; absent: none. */
	readonly accountNames?: readonly string[];
	/** A pool limit from the `/account` limit syntax; absent hosts take no typed limits. */
	parseLimitSpec?(spec: string): ModelHubLimitSpecResult;
	/** A configured pool limit in the `/account` limit syntax; undefined for an entry that does not parse. */
	formatLimit?(limit: unknown): string | undefined;
	/** Names of the effective `modelGroups` entries; absent: none. */
	readonly modelGroupNames?: readonly string[];
	/**
	 * Role and chain entries that reference `modelGroups.<name>`, each with the profile its stored
	 * value selects: effective entries plus global entries a higher layer shadows.
	 */
	modelGroupReferences?(name: string): readonly ModelHubGroupReference[];
	/** Why a global write of `modelGroups.<name>` would not take effect; undefined when it would. */
	modelGroupWriteBlocker?(name: string): string | undefined;
}

/** Catalog capabilities required by the model hub. */
export interface ModelHubRegistry extends ModelBrowserRegistry {
	readonly authStorage: { readonly keys: Pick<KeysApi, "source"> };
	getDiscoverableProviders(): string[];
	getProviderDiscoveryState(provider: string):
		| {
				optional: boolean;
				status: "idle" | "ok" | "empty" | "cached" | "unavailable" | "unauthenticated";
				fetchedAt?: number;
				error?: string;
		  }
		| undefined;
	find(provider: string, id: string): Model | undefined;
	refresh(strategy: "online"): Promise<void>;
	refreshProvider(
		provider: string,
		strategy: "online",
		options?: { refreshCommandCredentials?: boolean },
	): Promise<void>;
}

/** A `--models` scope entry (mirrors the session's scoped model list). */
export interface ScopedModelItem {
	model: Model;
	thinkingLevel?: string;
}

export type ModelRoleSelectionScope = "global" | "project";

export interface ModelHubCallbacks {
	/** Persist a role assignment. */
	onAssign: (
		model: Model,
		role: string,
		thinkingLevel: ConfiguredThinkingLevel | undefined,
		selector: string,
		scope?: ModelRoleSelectionScope,
	) => void | boolean | Promise<void | boolean>;
	/** Clear a configured role back to auto-selection. */
	onUnassign: (role: string, scope?: ModelRoleSelectionScope) => void;
	/** Persist a `retry.fallbackChains` entry — keyed by a role, `provider/model-id`, or `provider/*`; an empty chain clears the key. */
	onFallbackChainChange?: (role: string, chain: string[]) => void;
	/**
	 * Persist a pool edit: `value` replaces the entry at `target` (a role or chain entry, or a
	 * `modelGroups` entry), `undefined` removes it. Returns the validator's message when the value is
	 * refused and nothing was written.
	 */
	onPoolChange?: (
		target: ModelHubPoolTarget,
		value: Readonly<Record<string, unknown>> | undefined,
	) => string | undefined;
	/** Locked provider activation: forward to the /login flow. */
	onLoginRequest?: (providerId: string) => void;
	/** Save the current role assignments and default thinking level as a named model preset. */
	onSavePreset?: (name: string) => void;
	/**
	 * Apply a saved model preset (ctrl+←/→ or p/⇧P in the Roles view) and report
	 * the outcome itself. A switch that writes nothing (a refused preset) still
	 * advances the hub's preset cursor, so the next press moves past it.
	 */
	onSwitchPreset?: (name: string) => void | Promise<void>;
	/** Persist a new quick-switch cycle order (the ctrl+p role cycle). */
	onCycleOrderChange?: (order: string[]) => void;
	/**
	 * Persist typed text as `model`'s own compaction limit: a token base the
	 * policy scales (`400k`), a fixed trigger (`f400k`), a percentage (`80%`), or
	 * empty to reset. Rejected input returns `{ kind: "error" }`; input that
	 * needs acknowledgement (one that opens the extended window) returns
	 * `{ kind: "confirm" }` until called again with the same text and
	 * `confirmed`. Either keeps the field open.
	 */
	onCompactionPointChange?: (
		model: Model,
		input: string,
		confirmed: boolean,
	) => CompactionPointChangeResult | undefined;
	/**
	 * One short line on where `model` would compact with the typed limit
	 * (`compacts at 340K · 85% of 400K base`), shown beside the field while
	 * typing; undefined for input that does not parse or fit.
	 */
	previewCompactionPoint?: (model: Model, input: string) => string | undefined;
	onCancel: () => void;
}

/** Why {@link ModelHubCallbacks.onCompactionPointChange} kept the field open. */
export type CompactionPointChangeResult = { kind: "error"; message: string } | { kind: "confirm"; message: string };

export interface ModelHubOptions {
	/** Preselect this provider's sidebar entry (e.g. when reopening after /login). */
	initialProviderId?: string;
	/** `provider/id` of the session's model, marked current in the native picker. */
	currentSelector?: string;
}

interface SidebarEntry extends HubSidebarEntry<"recent" | "roles" | "groups" | "all" | "separator" | "provider"> {
	providerId?: string;
	locked?: boolean;
	oauth?: boolean;
	catalogCount?: number;
}

/**
 * The focused sidebar entry plus its screen row, captured before a rebuild so
 * the viewport can be restored around it. `index` is the entry's position in
 * `#entries` (−1 when absent); `offset` is its row relative to the scroll top.
 */
interface SidebarAnchor {
	id: string;
	index: number;
	offset: number;
}

interface StripChip extends HubStripChip<
	"assign" | "unassign" | "fallback" | "fallbackModel" | "fallbackProvider" | "scope" | "thinking"
> {
	role?: string;
	thinkingLevel?: ConfiguredThinkingLevel;
	scope?: ModelRoleSelectionScope;
}

interface GroupAction {
	label: string;
	apply: () => void;
}

type StripState =
	| (HubStripState<StripChip> & {
			kind: "role" | "scope" | "thinking";
			item: ModelBrowserItem;
			role?: string;
			/** Set when a thinking strip edits a fallback-chain entry instead of a role assignment. */
			fallbackIndex?: number;
			scope?: ModelRoleSelectionScope;
			/** Where to land when a scope or thinking strip closes. */
			returnToRoles: boolean;
			/** Thinking value already committed for this strip. */
			initialThinkingLevel?: ConfiguredThinkingLevel;
	  })
	| {
			/** Footer text input naming a new role, or saving a model preset. */
			kind: "name";
			purpose: "role" | "preset";
			input: Input;
	  }
	| {
			/**
			 * Footer text input setting `model`'s compaction limit; `error` is the last
			 * rejection, `confirm` the warning a second Enter on the same `value`
			 * accepts, `preview` the host's live line for the typed `value`.
			 */
			kind: "name";
			purpose: "compaction";
			model: Model;
			input: Input;
			error?: string;
			confirm?: { value: string; message: string };
			preview?: { value: string; text: string | undefined };
	  };

/** A Roles-view command; keys and the picker's action bar both run {@link ModelHubComponent}'s `#runRolesAction`. */
type RolesAction =
	| "pick"
	| "clear"
	| "fallback"
	| "cycle"
	| "earlier"
	| "later"
	| "new"
	| "thinking"
	| "compaction"
	| "save"
	| "nextPreset"
	| "prevPreset"
	| "pool"
	| "strategy"
	| "funding"
	| "weight"
	| "affinity"
	| "pricing"
	| "quotaUnknown"
	| "reserve"
	| "routing"
	| "groups"
	| "rename"
	| "newProfile";

/** Printable keys of the Roles view and the command each runs. */
const ROLES_ACTION_KEYS: Record<string, RolesAction> = {
	x: "clear",
	f: "fallback",
	c: "cycle",
	"[": "earlier",
	"]": "later",
	n: "new",
	t: "thinking",
	k: "compaction",
	s: "save",
	// Letter twins of ctrl+←/→, which macOS reserves for switching Spaces.
	p: "nextPreset",
	P: "prevPreset",
	m: "pool",
	g: "strategy",
	o: "funding",
	w: "weight",
	a: "affinity",
	h: "pricing",
	u: "quotaUnknown",
	r: "reserve",
	e: "routing",
	G: "groups",
	R: "rename",
	"@": "newProfile",
};

/** Strategies `g` cycles through: each needs no options, or only an `order` the hub derives from the members. */
const POOL_STRATEGY_CYCLE = [
	"priority",
	"round-robin",
	"weighted-random",
	"random",
	"quota",
	"cheapest",
	"least-used",
	"least-loaded",
	"p2c",
	"shuffle-bag",
] as const;

/** Pool limit syntax, the `/account` limit syntax without provider evidence. */
const LIMIT_SPEC_HINT = "<usd|requests|tokens> <max> <day|week|month|<n>m|<n>h|<n>d> [warn|skip]";

/** Longest member alias the hub derives from a model id; the validator allows 64 and suffixes need room. */
const POOL_ALIAS_MAX_LENGTH = 48;

/** Member aliases the group grammar reserves. */
const POOL_RESERVED_ALIASES: readonly string[] = ["window", "__proto__", "constructor", "prototype"];

/**
 * Grammar of model group and profile names, as the settings validator enforces it: lowercase, so
 * case-insensitive lookups never confuse two names.
 */
const MODEL_GROUP_NAME = /^[a-z0-9][a-z0-9_-]*$/;

/** Longest model group or profile name the validator accepts, in characters. */
const MODEL_GROUP_NAME_MAX_LENGTH = 64;

/** Names the validator rejects because they name object internals. */
const MODEL_GROUP_RESERVED_NAMES: readonly string[] = ["constructor", "prototype"];

/** Field hint of a group or profile name. */
const NAME_HINT = "(lowercase letters, digits, - and _)";

/** Picker fact columns of the Roles view; billing and routing hide first when narrow. */
const ROLE_PICKER_COLUMNS: readonly TspPickerColumn[] = [
	{ id: "model", head: "Model", format: "text", priority: 3 },
	{ id: "thinking", head: "Thinking", format: "dim", priority: 2 },
	{ id: "billing", head: "Billing", format: "dim", priority: 1 },
	{ id: "routing", head: "Routing", format: "dim", priority: 0 },
];

/** Roles view fact columns that are shown only when some row carries the fact. */
const ROLE_PICKER_OPTIONAL_COLUMNS: readonly string[] = ["billing", "routing"];

/** Column cells of one Roles row: model, thinking, billing, routing. */
interface RolesRowCells {
	model?: string;
	thinking?: string;
	billing?: string;
	routing?: string;
}

/** Picker facts of a Roles row's cells; absent and empty cells are omitted. */
function rolesCellFacts(cells: RolesRowCells): Record<string, string> {
	const facts: Record<string, string> = {};
	for (const [key, value] of Object.entries(cells)) {
		if (value !== undefined && value.length > 0) facts[key] = value;
	}
	return facts;
}

/** Dim value spans of a Roles row's thinking, billing and routing cells; undefined when all are absent. */
function rolesCellValue(cells: RolesRowCells): TspSpan[] | undefined {
	const parts = [cells.thinking, cells.billing, cells.routing].filter(
		(part): part is string => part !== undefined && part.length > 0,
	);
	return parts.length > 0 ? [span(parts.join("  "), "dim")] : undefined;
}

/** Kind tab labels (sentence case; acronyms stay upper). */
const MODEL_KIND_LABELS: Record<"all" | ModelKind, string> = {
	all: "All",
	chat: "Chat",
	tiny: "Tiny",
	image: "Image",
	tts: "TTS",
	stt: "STT",
	search: "Search",
	judge: "Judge",
	embedding: "Embedding",
	rerank: "Rerank",
	video: "Video",
};

const PROVIDER_REFRESH_DEBOUNCE_MS = 120;
const RECENT_LIMIT = 15;
/** Accepted compaction limit input, shown beside the field: a scaled base, a fixed trigger, or a percentage. */
const COMPACTION_INPUT_HINT = "400k base · f400k fixed · 80% · empty resets";

type CompactionStrip = Extract<StripState, { purpose: "compaction" }>;

/** Whether the compaction field still holds the text its pending warning was raised for. */
function compactionConfirmPending(strip: CompactionStrip): boolean {
	return strip.confirm !== undefined && strip.confirm.value === strip.input.getValue();
}

/**
 * The note beside the compaction field: the last error, a pending warning, the
 * host's live preview of the typed limit, or (empty or unparsed input) the
 * input syntax. Host text embeds model ids and config text, so it is
 * sanitized for every render path (terminal footer, Tern picker and strip).
 */
function compactionNotice(
	strip: CompactionStrip,
	preview: ((model: Model, input: string) => string | undefined) | undefined,
): { text: string; style: "error" | "warning" | "dim" } {
	if (strip.error) return { text: sanitizeDisplayWarning(strip.error), style: "error" };
	// The footer hint and the primary action already say Enter accepts; the
	// notice stays short so it fits beside the field.
	if (strip.confirm && compactionConfirmPending(strip)) {
		return { text: sanitizeDisplayWarning(strip.confirm.message), style: "warning" };
	}
	const value = strip.input.getValue();
	if (preview && value.trim().length > 0) {
		// Renders repeat per frame; ask the host once per typed value.
		if (strip.preview?.value !== value) strip.preview = { value, text: preview(strip.model, value) };
		if (strip.preview.text) return { text: sanitizeDisplayWarning(strip.preview.text), style: "dim" };
	}
	return { text: COMPACTION_INPUT_HINT, style: "dim" };
}

const MODEL_KIND_TABS: ReadonlyArray<"all" | ModelKind> = ["all", ...MODEL_KINDS];
const ROLE_TABS = ["all", "chat", "kind"] as const;
type RoleTab = (typeof ROLE_TABS)[number];

/** Stable native list-item key of a Roles-view row. */
function rolesRowKey(row: RolesRow, index: number): string {
	switch (row.kind) {
		case "role":
			return `role:${row.role}`;
		case "chainKey":
			return `chain:${row.role}`;
		case "fallback":
			return `fallback:${row.role}:${row.chainIndex}`;
		case "pool":
			return `pooled:${row.role}`;
		case "poolMember":
			return `member:${row.target.kind}:${row.role}:${row.alias}`;
		case "group":
			return `group:${row.role}`;
		case "profile":
			return `profile:${row.role}:${row.profile}`;
		case "separator":
			return `sep:${index}`;
		case "newRole":
		case "newFallback":
		case "newGroup":
			return row.kind;
	}
}

/** Whether a sidebar entry kind shows the Roles-view rows: Roles itself, or the Groups view built on them. */
function isRolesView(kind: string): boolean {
	return kind === "roles" || kind === "groups";
}

/**
 * The mutable `strategyOptions.order` of a pool draft whose strategy, or the last entry of whose
 * strategy list, is priority or round-robin; undefined for other strategies.
 */
function draftOrder(draft: Record<string, unknown>): string[] | undefined {
	const ordering = Array.isArray(draft.strategy) ? draft.strategy.at(-1) : draft.strategy;
	if (ordering !== "priority" && ordering !== "round-robin") return undefined;
	const options = draftRecord(draft, "strategyOptions");
	if (!Array.isArray(options.order)) options.order = [];
	return options.order as string[];
}

/**
 * The strategy that orders the ties of `pool`: its strategy, or the last entry of the strategy list
 * an editable pool configures. Only that entry consumes `order` or member weights.
 */
function poolTailStrategy(pool: ModelHubPool | undefined): string | undefined {
	const configured = pool?.raw?.strategy;
	if (!Array.isArray(configured)) return pool?.strategy;
	const last = configured.at(-1);
	return typeof last === "string" ? last : undefined;
}

function memberModel(member: unknown): unknown {
	return isRecord(member) ? member.model : undefined;
}

/**
 * A member alias for `model` that matches the group name grammar and is not
 * in `taken`: its model id lowercased, other characters folded to `-`, and a
 * numeric suffix on collision.
 */
function uniquePoolAlias(model: string, taken: readonly string[]): string {
	const id = model.slice(model.lastIndexOf("/") + 1).toLowerCase();
	const base =
		id
			.replace(/[^a-z0-9_-]+/g, "-")
			.replace(/^[^a-z0-9]+/, "")
			.slice(0, POOL_ALIAS_MAX_LENGTH)
			.replace(/[-_]+$/, "") || "model";
	let alias = base;
	for (let suffix = 2; taken.includes(alias) || POOL_RESERVED_ALIASES.includes(alias); suffix++) {
		alias = `${base}-${suffix}`;
	}
	return alias;
}

/**
 * Providers already auto-refreshed this process. Selecting a provider fetches
 * its live model list at most once per application lifetime (surviving hub
 * close/reopen); F5 re-fetches on demand.
 */
const autoRefreshedProviders = new Set<string>();

/** Test hook: forget which providers were auto-refreshed this process. */
export function resetProviderAutoRefreshGuard(): void {
	autoRefreshedProviders.clear();
}

/**
 * The fullscreen model hub component. Hosted via `ui.showOverlay(..., { fullscreen: true })`;
 * the host must call {@link ModelHubComponent.dispose} when the overlay closes.
 */
export class ModelHubComponent implements Component {
	#tui: TUI;
	#settings: ModelHubSource;
	#registry: ModelHubRegistry;
	#scopedModels: ReadonlyArray<ScopedModelItem>;
	#callbacks: ModelHubCallbacks;

	#browser: ModelBrowser;
	#roles: RoleAssignments = {};
	#availableItems: ModelBrowserItem[] = [];
	#recentItems: ModelBrowserItem[] = [];
	/** Selectors of {@link #recentItems}, rebuilt with it, for search hit counts. */
	#recentSelectors: ReadonlySet<string> = new Set();
	#candidateItems: ModelBrowserItem[] = [];
	/** {@link #availableItems} when the candidates are that whole catalog (All scope, no role filter). */
	#candidateCatalog: readonly ModelBrowserItem[] | undefined;
	/** {@link #availableItems} when the browser's base items are that whole catalog; its query ranking then covers every count. */
	#browserCatalog: readonly ModelBrowserItem[] | undefined;
	/** Fuzzy index over {@link #availableItems}, for match counts while the browser holds a narrower scope. */
	#catalogCorpus: { items: readonly ModelBrowserItem[]; corpus: FuzzyCorpus<ModelBrowserItem> } | undefined;
	#modelKindTab: "all" | ModelKind = "all";
	#roleTab: RoleTab = "all";
	#configError: string | undefined;

	#entries: SidebarEntry[] = [];
	// Sidebar sections from the last registry sync; #composeEntries assembles
	// #entries from these (reordered while searching).
	#fixedEntries: SidebarEntry[] = [];
	#unlockedProviderEntries: SidebarEntry[] = [];
	#lockedProviderEntries: SidebarEntry[] = [];
	/** Fuzzy match totals while searching: recent-scope hits and overall hits. */
	#recentSearchCount = 0;
	#searchTotal = 0;
	#activeEntryId = "all";
	/** Snap the sidebar viewport to the active entry on the next render; wheel panning leaves it free. */
	#sidebarFollowActive = true;
	#sidebarHover: number | null = null;
	/**
	 * Arrow-key ownership: `scope` (default) hops the sidebar; `list`
	 * navigates rows (browser models or role rows). Typing anywhere focuses
	 * the model list; Tab toggles; ←/→ switches between sidebar and list.
	 */
	#focus: "scope" | "list" = "scope";

	#rolesRows: RolesRow[] = [];
	#roleSearch = new Input();
	#roleSearching = false;
	#roleRowsTotal = 0;
	#roleConfirm:
		| { key: string; view: string; text: string }
		| { role: string; scope?: ModelRoleSelectionScope; text: string }
		| undefined;
	/** Pools read for the current rows, keyed `<kind>:<key>`; cleared on every rows rebuild. */
	#poolCache = new Map<string, ModelHubPool | undefined>();
	/** Group references read for the current rows, keyed by group name; cleared on every rows rebuild. */
	#referenceCache = new Map<string, readonly ModelHubGroupReference[]>();
	/** Sanitized billing text per `provider/model-id` for the current rows; cleared on every rows rebuild. */
	#billingCache = new Map<string, string | undefined>();
	#billingRevision: unknown;
	/**
	 * Outcome of the last pool edit worth reporting: the validator's message for a refused edit
	 * (`error`) or a note on an edit the hub declined or adjusted (`warning`). Sanitized; cleared by
	 * the next roles action or cursor move.
	 */
	#poolStatus: { text: string; tone: "error" | "warning" } | undefined;
	#roleIndex = 0;
	/** Which view `#rolesRows` was built for; switching between Roles and Groups rebuilds them. */
	#rowsBuiltFor: "roles" | "groups" = "roles";
	/** Footer hint page `?` selected for the pool row at `index`; page 0 elsewhere. */
	#poolHintPage: { index: number; page: number } | undefined;
	#roleHover: number | null = null;
	/** First roles row drawn in the scroll window; follows the cursor and clamps to the list. */
	#roleScrollStart = 0;
	/** Roles rows actually drawn this frame; bounds mouse hit-testing to the visible window. */
	#rolesVisibleCount = 0;

	#assigning: AssignTarget | null = null;
	#strip: StripState | null = null;
	#prefs: HubPrefs | undefined;
	#assignmentPending = false;
	/**
	 * Last preset ctrl+←/→ tried in this hub, with the settings revision after the
	 * attempt; steps from it while nothing matches the setup or nothing changed since.
	 */
	#presetCursor: { name: string; revision: number } | undefined;
	#presetsMemo: { revision: number; names: readonly string[]; active: string | undefined } | undefined;
	#disposed = false;
	/** Per-provider fuzzy match counts while a query is active; null when not searching. */
	#searchCounts: Map<string, number> | null = null;

	// Provider discovery refresh (debounced per sidebar selection, with spinner).
	#refreshingProviders = new Set<string>();
	#scheduledProviderRefreshes = new Map<string, Timer>();
	/** F5 while a catalog-only refresh is in flight: re-run with credentials after it settles. */
	#pendingCredentialRefreshProviders = new Set<string>();
	#refreshSpinnerFrame = 0;
	#refreshSpinnerInterval?: Timer;
	#renderBodyPane = (width: number, height: number | undefined): readonly string[] => {
		const rows = Math.max(1, Math.floor(height ?? 10));
		const lines: string[] = [this.#statusRow(width)];
		const entry = this.#activeEntry();
		if (isRolesView(entry.kind) && this.#assigning === null) {
			lines.push(...this.#renderRolesView(width, rows - 1));
		} else if (entry.kind === "provider" && entry.locked && this.#assigning === null) {
			lines.push(...this.#renderLockedView(entry, width, rows - 1));
		} else {
			lines.push(this.#renderModelKindTabs(width));
			this.#browser.setMaxVisible(rows - 2 - 5);
			this.#browser.setFocused(this.#focus === "list");
			lines.push(...this.#browser.render(width));
		}
		while (lines.length < rows) lines.push("");
		return lines.slice(0, rows);
	};
	readonly #frame: HubFrame = new HubFrame(
		"Models",
		{ min: 18, max: 26 },
		(width, rows) => this.#renderSidebar(width, rows),
		this.#renderBodyPane,
		{ bodyMinWidth: MODEL_HUB_BODY_MIN_WIDTH, preserveSidebar: true },
	);
	#lockedLoginLine: number | null = null;
	#rolesRowStart = 1;
	/** Bumped on every visible-state change; the described node is rebuilt when it moves. */
	#nativeVersion = 0;
	#nativeCache: { version: number; picker: boolean; billing: unknown; node: NativeNode } | undefined;
	#currentSelector: string | undefined;
	/** The opening online catalog refresh is still in flight (an empty scope then shows as loading). */
	#catalogRefreshing = false;
	#kindTabsMemo: { candidates: readonly ModelBrowserItem[]; tabs: TspPickerProps["tabs"] } | undefined;
	#pickerRoleItems:
		| {
				rows: readonly RolesRow[];
				roles: RoleAssignments;
				cycle: string;
				billing: unknown;
				items: readonly TspPickerItem[];
		  }
		| undefined;
	#pickerRolePreview:
		| {
				row: RolesRow | undefined;
				roles: RoleAssignments;
				rows: readonly RolesRow[];
				revision: number;
				billing: unknown;
				children: readonly NativeChild[];
		  }
		| undefined;

	constructor(
		tui: TUI,
		settings: ModelHubSource,
		registry: ModelHubRegistry,
		scopedModels: ReadonlyArray<ScopedModelItem>,
		callbacks: ModelHubCallbacks,
		options: ModelHubOptions = {},
	) {
		this.#tui = tui;
		this.#settings = settings;
		this.#registry = registry;
		this.#scopedModels = scopedModels;
		this.#callbacks = callbacks;
		this.#currentSelector = options.currentSelector;

		this.#browser = new ModelBrowser(settings, {
			emptyText: () => this.#emptyStateMessage(),
		});
		this.#browser.onActivate = item => this.#activateItem(item);
		this.#browser.onCancel = () => this.#callbacks.onCancel();
		this.#browser.onQueryChange = query => this.#onQueryChanged(query);

		// Hydrate synchronously from the current registry snapshot so the first
		// Enter after opening acts on cached models instead of being dropped
		// while the offline refresh promise is still pending.
		this.#syncFromRegistryState();

		const initialProvider = options.initialProviderId;
		if (initialProvider && this.#entries.some(entry => entry.providerId === initialProvider)) {
			this.#setActiveEntry(`provider:${initialProvider}`);
		} else {
			this.#setActiveEntry("all");
		}

		// Reconcile catalogs in the background. This is online discovery only —
		// it must not re-run `!command` credential helpers (F5 / `omp models
		// refresh` pass refreshCommandCredentials for that). A --models scope is
		// registry-independent, so the reload would only repeat the hydration
		// above.
		if (this.#scopedModels.length === 0) {
			this.#catalogRefreshing = true;
			this.#registry
				.refresh("online")
				.then(() => this.#syncFromRegistryState())
				.catch(error => {
					this.#configError = error instanceof Error ? error.message : String(error);
				})
				.finally(() => {
					this.#catalogRefreshing = false;
					this.#requestRender();
				});
		}
	}

	/** Cancel pending provider refresh timers and the spinner. Host calls this on overlay close. */
	dispose(): void {
		this.#disposed = true;
		for (const [, timer] of this.#scheduledProviderRefreshes) clearTimeout(timer);
		this.#scheduledProviderRefreshes.clear();
		this.#refreshingProviders.clear();
		this.#pendingCredentialRefreshProviders.clear();
		if (this.#refreshSpinnerInterval) {
			clearInterval(this.#refreshSpinnerInterval);
			this.#refreshSpinnerInterval = undefined;
		}
	}

	invalidate(): void {
		this.#nativeVersion++;
		this.#frame.invalidate();
	}

	/** Request a repaint after a state change, invalidating the described node. */
	#requestRender(): void {
		this.#nativeVersion++;
		this.#tui.requestRender();
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Data pipeline
	// ═══════════════════════════════════════════════════════════════════════

	#visibleRoleIds(): string[] {
		return this.#settings.knownRoleIds.filter(role => !this.#settings.getRoleInfo(role).hidden);
	}

	/** Resolve every known role: configured values first, auto-selection for the rest. */
	#reloadRoles(autoCandidates: ReadonlyArray<Model>): void {
		const allModels = this.#scopedModels.length > 0 ? autoCandidates : this.#registry.getAll("all");
		this.#roles = resolveRoleAssignments(this.#settings, allModels, autoCandidates);
	}

	/** Rebuild items, roles, and the sidebar from the registry's in-memory state. */
	#syncFromRegistryState(): void {
		this.#nativeVersion++;
		// A background rebuild (provider refresh, mutation) must not yank the
		// sidebar viewport: remember the focused entry's screen row so it — or
		// its nearest survivor — stays put after #buildSidebar reshuffles entries.
		const anchor = this.#captureSidebarAnchor();
		let allModels: ReadonlyArray<Model>;
		let availableModels: ReadonlyArray<Model>;
		if (this.#scopedModels.length > 0) {
			this.#configError = undefined;
			try {
				allModels = scopedRolePool(
					this.#scopedModels.map(scoped => scoped.model),
					this.#registry,
				);
			} catch (error) {
				this.#configError = error instanceof Error ? error.message : String(error);
				allModels = this.#scopedModels.map(scoped => scoped.model);
			}
			availableModels = allModels;
		} else {
			const loadError = this.#registry.getError();
			this.#configError = loadError ? String(loadError) : undefined;
			allModels = this.#registry.getAll("all");
			try {
				availableModels = this.#registry.getAvailable("all");
			} catch (error) {
				this.#configError = error instanceof Error ? error.message : String(error);
				availableModels = [];
			}
		}

		this.#reloadRoles(availableModels);
		this.#buildRolesRows();

		const mruOrder = this.#settings.mruOrder;
		this.#availableItems = buildBrowserItems(availableModels);
		sortModelItems(this.#availableItems, { roles: this.#roles, mruOrder });
		this.#browser.setRoles(this.#roles);
		this.#browser.setMruOrder(mruOrder);
		this.#browser.setPerfStats(this.#settings.modelPerf);

		const bySelector = new Map(this.#availableItems.map(item => [item.selector, item]));
		this.#recentItems = [];
		for (const key of mruOrder) {
			const item = bySelector.get(key);
			if (item) this.#recentItems.push(item);
			if (this.#recentItems.length >= RECENT_LIMIT) break;
		}
		this.#recentSelectors = new Set(this.#recentItems.map(item => item.selector));

		this.#buildSidebar(allModels, availableModels);
		this.#restoreSidebarAnchor(anchor);
		this.#applyScope();
	}

	#buildSidebar(allModels: ReadonlyArray<Model>, availableModels: ReadonlyArray<Model>): void {
		const scoped = this.#scopedModels.length > 0;
		let disabledProviders: ReadonlySet<string>;
		try {
			disabledProviders = new Set(this.#settings.disabledProviders);
		} catch {
			disabledProviders = new Set();
		}

		const availableCounts = new Map<string, number>();
		for (const model of availableModels) {
			availableCounts.set(model.provider, (availableCounts.get(model.provider) ?? 0) + 1);
		}
		const catalogCounts = new Map<string, number>();
		for (const model of allModels) {
			catalogCounts.set(model.provider, (catalogCounts.get(model.provider) ?? 0) + 1);
		}

		const unlocked = new Set<string>(availableCounts.keys());
		const locked = new Set<string>();
		if (!scoped) {
			const authStorage = this.#registry.authStorage;
			for (const provider of catalogCounts.keys()) {
				if (!unlocked.has(provider) && !disabledProviders.has(provider)) {
					locked.add(provider);
				}
			}
			for (const provider of this.#registry.getDiscoverableProviders()) {
				if (unlocked.has(provider) || disabledProviders.has(provider)) continue;
				// Discoverable without stored auth: catalog-backed providers stay
				// locked; keyless/custom endpoints (ollama, vllm, …) surface as
				// selectable so discovery can populate them.
				const authenticated = authStorage.keys.source(provider) !== undefined;
				if (authenticated || !locked.has(provider)) {
					// #2761: implicit local endpoints (optional: true) stay hidden
					// until discovery actually reaches a server. "idle" means never
					// probed; "unavailable" means the endpoint is unreachable; both
					// would render a dead tab for a provider the user never
					// configured. models.yml discovery providers (optional: false)
					// and providers with stored auth keep their entry so
					// misconfigurations stay visible and diagnosable.
					if (!authenticated) {
						const discovery = this.#registry.getProviderDiscoveryState(provider);
						if (discovery?.optional && (discovery.status === "idle" || discovery.status === "unavailable")) {
							continue;
						}
					}
					locked.delete(provider);
					unlocked.add(provider);
				}
			}
		}

		const oauthIds = new Set(getOAuthProviders().map(provider => provider.id));
		const providerEntry = (providerId: string, isLocked: boolean): SidebarEntry => ({
			id: `provider:${providerId}`,
			kind: "provider",
			label: providerId,
			providerId,
			locked: isLocked,
			annotation: isLocked ? undefined : String(availableCounts.get(providerId) ?? 0),
			oauth: oauthIds.has(providerId),
			catalogCount: catalogCounts.get(providerId) ?? 0,
		});

		const visibleRoles = this.#visibleRoleIds();
		let assignedCount = 0;
		for (const role of visibleRoles) {
			const assignment = this.#roles[role];
			if (assignment && !assignment.autoSelected) assignedCount++;
		}

		// Roles leads the fixed section so downward hops from Recent head into
		// model scopes instead of being captured by the roles view.
		const fixed: SidebarEntry[] = [
			{
				id: "roles",
				kind: "roles",
				label: "Roles",
				annotation: `${assignedCount}/${visibleRoles.length}`,
			},
			{ id: "groups", kind: "groups", label: "Groups", annotation: String(this.#modelGroupNames().length) },
			{ id: "all", kind: "all", label: "All models", annotation: String(availableModels.length) },
		];

		this.#fixedEntries = fixed;
		this.#unlockedProviderEntries = [...unlocked]
			.sort((a, b) => a.localeCompare(b))
			.map(provider => providerEntry(provider, false));
		this.#lockedProviderEntries = [...locked]
			.sort((a, b) => a.localeCompare(b))
			.map(provider => providerEntry(provider, true));
		this.#composeEntries();
	}

	/**
	 * Assemble `#entries` from the stored sections. While a search is active,
	 * providers with matches float to the top of the provider section (each
	 * group stays alphabetical) so the hop order, mouse hit-testing, and the
	 * paint all agree.
	 */
	#composeEntries(): void {
		const counts = this.#searchCounts;
		let providers = this.#unlockedProviderEntries;
		if (counts) {
			providers = [...providers].sort((a, b) => {
				const aMatched = (counts.get(a.providerId ?? "") ?? 0) > 0;
				const bMatched = (counts.get(b.providerId ?? "") ?? 0) > 0;
				if (aMatched !== bMatched) return aMatched ? -1 : 1;
				return a.label.localeCompare(b.label);
			});
		}

		const entries: SidebarEntry[] = [...this.#fixedEntries];
		if (providers.length > 0) {
			entries.push({ id: "sep:providers", kind: "separator", label: "" }, ...providers);
		}
		if (this.#lockedProviderEntries.length > 0) {
			entries.push({ id: "sep:locked", kind: "separator", label: "" }, ...this.#lockedProviderEntries);
		}

		this.#entries = entries;
		if (!entries.some(entry => entry.id === this.#activeEntryId)) {
			this.#activeEntryId = "all";
			this.#sidebarFollowActive = true;
		}
	}

	/** Snapshot the focused entry and its row within the sidebar viewport. */
	#captureSidebarAnchor(): SidebarAnchor {
		const index = this.#entries.findIndex(entry => entry.id === this.#activeEntryId);
		return { id: this.#activeEntryId, index, offset: index - this.#frame.sidebarScroll };
	}

	/**
	 * Reposition the sidebar after {@link #buildSidebar} rebuilt `#entries`. A
	 * surviving focused entry keeps its screen row; if it vanished (a keyless
	 * provider flipping back to hidden mid-navigation), focus falls to the
	 * nearest surviving entry instead of snapping to the top.
	 */
	#restoreSidebarAnchor(anchor: SidebarAnchor): void {
		if (anchor.index < 0) return;
		const survivor = this.#entries.findIndex(entry => entry.id === anchor.id);
		if (survivor >= 0) {
			this.#frame.sidebarScroll = Math.max(0, survivor - anchor.offset);
			return;
		}
		const replacement = this.#nearestNavigableEntry(anchor.index);
		if (!replacement) return;
		this.#activeEntryId = replacement.id;
		this.#frame.sidebarScroll = Math.max(0, this.#entries.indexOf(replacement) - anchor.offset);
	}

	/** The selectable entry nearest `preferredIndex` in the current `#entries`. */
	#nearestNavigableEntry(preferredIndex: number): SidebarEntry | undefined {
		const entries = this.#entries;
		if (entries.length === 0) return undefined;
		const start = Math.max(0, Math.min(preferredIndex, entries.length - 1));
		for (let radius = 0; radius < entries.length; radius++) {
			for (const index of radius === 0 ? [start] : [start + radius, start - radius]) {
				const entry = entries[index];
				if (entry && !this.#isHopSkipped(entry)) return entry;
			}
		}
		return undefined;
	}

	#activeEntry(): SidebarEntry {
		return this.#entries.find(entry => entry.id === this.#activeEntryId) ?? this.#entries[0];
	}

	#setActiveEntry(id: string): void {
		if (!this.#entries.some(entry => entry.id === id)) return;
		this.#activeEntryId = id;
		this.#sidebarFollowActive = true;
		this.#applyScope();
		const entry = this.#activeEntry();
		// Hops must never steal arrow focus: landing on a scope keeps provider
		// navigation active. Diving into the roles rows is explicit (Enter, →,
		// or a click on the Roles entry).
		this.#focus = "scope";
		if (entry.kind === "provider" && !entry.locked) {
			this.#scheduleProviderRefresh(entry.providerId ?? "");
		}
		this.#cancelScheduledRefreshesExcept(entry.kind === "provider" ? entry.providerId : undefined);
	}

	/** Push the active scope's items into the browser. */
	#applyScope(): void {
		const entry = this.#activeEntry();
		switch (entry.kind) {
			case "recent":
				this.#browser.setShowProvider(true);
				this.#setCandidateItems(this.#recentItems);
				break;
			case "provider": {
				if (entry.locked) {
					// Assign-mode renders the browser regardless of scope; a locked
					// provider contributes nothing selectable.
					this.#setCandidateItems([]);
					break;
				}
				const providerId = entry.providerId;
				this.#browser.setShowProvider(false);
				this.#setCandidateItems(this.#availableItems.filter(item => item.provider === providerId));
				break;
			}
			case "roles":
			case "groups":
				if (this.#rowsBuiltFor !== entry.kind) {
					this.#roleIndex = 0;
					this.#roleScrollStart = 0;
					this.#buildRolesRows();
				}
				this.#roleIndex = Math.min(this.#roleIndex, Math.max(0, this.#rolesRowCount - 1));
				break;
			default:
				this.#browser.setShowProvider(true);
				this.#setCandidateItems(this.#availableItems);
				break;
		}
	}

	/**
	 * Push the active scope's items into the browser. While assigning a role,
	 * the role's `accepts` predicate is re-applied here so a scope hop
	 * (provider/all/recent) can never surface a model the role rejects — role
	 * resolution and the runtime candidate pool filter the same way, so an
	 * unaccepted pick would persist a selector that never resolves.
	 */
	#setCandidateItems(items: ReadonlyArray<ModelBrowserItem>): void {
		const assigning = this.#assigning;
		const scoped =
			assigning?.kind === "role"
				? items.filter(item => this.#settings.getRoleInfo(assigning.role).accepts(item.model))
				: items;
		this.#candidateItems = [...scoped];
		this.#candidateCatalog = scoped === this.#availableItems ? this.#availableItems : undefined;
		this.#applyModelKind();
	}

	#applyModelKind(): void {
		const kind = this.#modelKindTab;
		this.#browserCatalog = kind === "all" ? this.#candidateCatalog : undefined;
		this.#browser.setItems(
			kind === "all"
				? [...this.#candidateItems]
				: this.#candidateItems.filter(item => modelKind(item.model) === kind),
		);
	}

	/**
	 * The configured `retry.fallbackChains` record with malformed keys/entries
	 * dropped: non-array chains and non-string selectors never reach the rows
	 * or chain editors, so an edit through the hub replaces them wholesale.
	 * Model-group keys are dropped too but are never edited ({@link #isPooledChain}).
	 */
	#fallbackChains(): Record<string, string[]> {
		try {
			const chains = this.#settings.fallbackChains;
			if (!chains || typeof chains !== "object" || Array.isArray(chains)) return {};
			const sanitized: Record<string, string[]> = {};
			for (const key in chains) {
				const chain = (chains as Record<string, unknown>)[key];
				if (!Array.isArray(chain)) continue;
				sanitized[key] = chain.filter((entry): entry is string => typeof entry === "string");
			}
			return sanitized;
		} catch {
			return {};
		}
	}

	#pooledChainKeys(): readonly string[] {
		try {
			return this.#settings.fallbackChainGroupKeys ?? [];
		} catch {
			return [];
		}
	}

	/** Whether `key` holds a model-group chain, which list edits never write. */
	#isPooledChain(key: string): boolean {
		return this.#pooledChainKeys().includes(key);
	}

	/** Pool at `target`, memoized until the next rows rebuild so every render path reads one snapshot. */
	#pool(target: ModelHubPoolTarget): ModelHubPool | undefined {
		const id = `${target.kind}:${target.key}`;
		if (this.#poolCache.has(id)) return this.#poolCache.get(id);
		let pool: ModelHubPool | undefined;
		try {
			pool = this.#settings.getPool?.(target);
		} catch {
			pool = undefined;
		}
		this.#poolCache.set(id, pool);
		return pool;
	}

	/**
	 * Billing text of `model` from the host, memoised per rows rebuild and per
	 * {@link ModelHubSource.billingRevision}; undefined when the host shows none.
	 */
	#billing(model: string): string | undefined {
		const revision = this.#settings.billingRevision;
		if (revision !== this.#billingRevision) {
			this.#billingRevision = revision;
			this.#billingCache.clear();
		}
		if (this.#billingCache.has(model)) return this.#billingCache.get(model);
		let billing: string | undefined;
		try {
			const text = this.#settings.billingFor?.(model);
			billing = text ? sanitizeDisplayLine(text) : undefined;
		} catch (error) {
			logger.debug("Model hub billing lookup failed", { model, error: String(error) });
			billing = undefined;
		}
		this.#billingCache.set(model, billing);
		return billing;
	}

	/** `billing <text>` for `model`, or undefined when the host shows none. */
	#billingFact(model: string): string | undefined {
		const billing = this.#billing(model);
		return billing ? `billing ${billing}` : undefined;
	}

	#rolePool(role: string): ModelHubPool | undefined {
		return this.#pool({ kind: "role", key: role });
	}

	#chainPool(key: string): ModelHubPool | undefined {
		return this.#isPooledChain(key) ? this.#pool({ kind: "chain", key }) : undefined;
	}

	/** Whether the hub may write the pool at `target`: an inline pool from the global layer with a write callback. */
	#poolEditable(pool: ModelHubPool | undefined): pool is ModelHubPool & { raw: Readonly<Record<string, unknown>> } {
		return pool?.raw !== undefined && pool.readOnly === undefined && this.#callbacks.onPoolChange !== undefined;
	}

	/** Member rows of `pool` in scheduling order. */
	#poolMemberRows(role: string, target: ModelHubPoolTarget, pool: ModelHubPool | undefined): RolesRow[] {
		return (pool?.members ?? []).map(member => ({ kind: "poolMember", role, target, alias: member.alias }));
	}

	/**
	 * Rebuild the Roles view rows: each visible role followed by its pool
	 * members and fallback-chain entries, then model-oriented chains
	 * (`provider/model-id` and `provider/*` keys) as headed groups.
	 */
	#buildRolesRows(): void {
		this.#poolCache.clear();
		this.#referenceCache.clear();
		this.#billingCache.clear();
		const rows: RolesRow[] = [];
		const groupsView =
			this.#activeEntryId === "groups" ||
			(this.#assigning?.kind === "poolMember" && this.#assigning.target.kind === "group");
		this.#rowsBuiltFor = groupsView ? "groups" : "roles";
		if (groupsView) {
			for (const name of [...this.#modelGroupNames()].sort()) {
				const target: ModelHubPoolTarget = { kind: "group", key: name };
				rows.push({ kind: "group", role: name });
				const pool = this.#pool(target);
				rows.push(...this.#poolMemberRows(name, target, pool));
				for (const profile of pool?.profiles ?? [])
					rows.push({ kind: "profile", role: name, profile: profile.name });
			}
			if (this.#callbacks.onPoolChange) rows.push({ kind: "newGroup" });
			this.#filterRolesRows(rows);
			return;
		}
		const chains = this.#fallbackChains();
		const appendChainPool = (key: string): void => {
			rows.push({ kind: "pool", role: key });
			const target: ModelHubPoolTarget = { kind: "chain", key };
			rows.push(...this.#poolMemberRows(key, target, this.#chainPool(key)));
		};
		const appendRoles = (roles: ReadonlyArray<string>): void => {
			for (const role of roles) {
				rows.push({ kind: "role", role });
				const target: ModelHubPoolTarget = { kind: "role", key: role };
				rows.push(...this.#poolMemberRows(role, target, this.#rolePool(role)));
				if (this.#isPooledChain(role)) {
					appendChainPool(role);
					continue;
				}
				const chain = chains[role] ?? [];
				for (let i = 0; i < chain.length; i++) {
					rows.push({ kind: "fallback", role, chainIndex: i, selector: chain[i] });
				}
			}
		};
		const visibleRoles = this.#visibleRoleIds();
		if (this.#roleTab === "all") {
			const chatRoles = visibleRoles.filter(role => this.#settings.getRoleInfo(role).section === "chat");
			const kindRoles = visibleRoles.filter(role => this.#settings.getRoleInfo(role).section === "kind");
			appendRoles(chatRoles);
			if (chatRoles.length > 0 && kindRoles.length > 0) rows.push({ kind: "separator" });
			appendRoles(kindRoles);
		} else {
			appendRoles(visibleRoles.filter(role => this.#settings.getRoleInfo(role).section === this.#roleTab));
		}
		rows.push({ kind: "newRole" });
		rows.push({ kind: "separator" });
		const modelKeys = [...new Set([...Object.keys(chains), ...this.#pooledChainKeys()])]
			.filter(key => key.includes("/"))
			.sort();
		for (const key of modelKeys) {
			const chain = chains[key] ?? [];
			rows.push({ kind: "chainKey", role: key });
			if (this.#isPooledChain(key)) {
				appendChainPool(key);
				continue;
			}
			for (let i = 0; i < chain.length; i++) {
				rows.push({ kind: "fallback", role: key, chainIndex: i, selector: chain[i] });
			}
		}
		rows.push({ kind: "newFallback" });
		this.#filterRolesRows(rows);
	}

	#filterRolesRows(rows: RolesRow[]): void {
		this.#roleRowsTotal = rows.filter(row => row.kind !== "separator").length;
		const selected = this.#rolesRows[this.#roleIndex];
		const selectedKey = selected ? rolesRowKey(selected, this.#roleIndex) : undefined;
		const tokens = this.#roleSearch.getValue().toLowerCase().split(/\s+/).filter(Boolean);
		this.#rolesRows = tokens.length
			? rows.filter(row => {
					if (!("role" in row)) return false;
					const info = row.kind === "role" ? this.#settings.getRoleInfo(row.role) : undefined;
					const cells = row.kind === "role" ? this.#roleCells(row.role) : this.#rolesRowCells(row);
					const search = [
						row.role,
						info?.tag,
						info?.name,
						row.kind === "profile" ? row.profile : undefined,
						row.kind === "poolMember" ? row.alias : undefined,
						...Object.values(cells ?? {}),
					]
						.join(" ")
						.toLowerCase();
					return tokens.every(token => search.includes(token));
				})
			: rows;
		const index = this.#rolesRows.findIndex((row, index) => rolesRowKey(row, index) === selectedKey);
		this.#roleIndex = index >= 0 ? index : Math.min(this.#roleIndex, Math.max(0, this.#rolesRows.length - 1));
		this.#roleScrollStart = 0;
	}

	#roleBadges(row: RolesRow): NonNullable<TspPickerItem["badges"]> {
		const badges: { text: string; tone?: "warning" | "muted" | "error" }[] = [];
		if (row.kind === "role" && this.#roles[row.role]?.autoSelected)
			badges.push({ text: "auto-selected", tone: "muted" });
		if (row.kind === "group" && this.#groupReferences(row.role).length === 0)
			badges.push({ text: "unused", tone: "muted" });
		if (row.kind === "profile" && this.#profileReferences(row.role, row.profile).length === 0)
			badges.push({ text: "unused", tone: "muted" });
		const target = row.kind === "profile" ? { kind: "group" as const, key: row.role } : this.#rowPoolTarget(row);
		const pool = target ? this.#pool(target) : undefined;
		if (pool?.invalid !== undefined) badges.push({ text: "invalid pool", tone: "error" });
		if (pool?.readOnly !== undefined) badges.push({ text: "read-only", tone: "warning" });
		const billing = (row.kind === "role" ? this.#roleCells(row.role) : this.#rolesRowCells(row))?.billing;
		if (billing && /\bexhausted\b/i.test(billing)) badges.push({ text: "exhausted", tone: "warning" });
		return badges;
	}

	/**
	 * Rows the Roles view lists on the All tab, separators aside: the picker's
	 * unfiltered `total`, counted in the same rows Tern counts as shown.
	 */
	#allRolesRowCount(): number {
		const chains = this.#fallbackChains();
		// "New role…" and "New fallback chain…", then each role and model chain with its fallback entries.
		let count = 2;
		const chainPoolRows = (key: string): number => 1 + (this.#chainPool(key)?.members.length ?? 0);
		for (const role of this.#visibleRoleIds()) {
			count += 1 + (this.#rolePool(role)?.members.length ?? 0);
			count += this.#isPooledChain(role) ? chainPoolRows(role) : (chains[role]?.length ?? 0);
		}
		for (const key in chains) if (key.includes("/") && !this.#isPooledChain(key)) count += 1 + chains[key].length;
		// A pooled model key shows its header, the pool summary row, and its members.
		for (const key of this.#pooledChainKeys()) if (key.includes("/")) count += 1 + chainPoolRows(key);
		return count;
	}

	/** Refresh roles + dependent state after a settings mutation (assign/unassign). */
	#refreshAfterMutation(): void {
		this.#syncFromRegistryState();
		this.#requestRender();
	}

	/** Re-sync after an asynchronous callback finishes mutating settings. */
	refreshAfterExternalMutation(): void {
		this.#refreshAfterMutation();
	}

	/**
	 * Recompute per-provider match counts for the active query. Providers
	 * without matches gray out and the scope hop skips them; a provider scope
	 * that just lost its last match falls back to All models so the results
	 * never silently vanish.
	 */
	#onQueryChanged(query: string): void {
		this.#nativeVersion++;
		if (!query.trim()) {
			this.#searchCounts = null;
			this.#composeEntries();
			return;
		}
		const matches = this.#catalogMatches(query);
		const counts = new Map<string, number>();
		let recentCount = 0;
		for (const item of matches) {
			counts.set(item.provider, (counts.get(item.provider) ?? 0) + 1);
			if (this.#recentSelectors.has(item.selector)) recentCount++;
		}
		this.#recentSearchCount = recentCount;
		this.#searchTotal = matches.length;
		this.#searchCounts = counts;
		this.#composeEntries();
		const entry = this.#activeEntry();
		if (
			this.#assigning === null &&
			entry.kind === "provider" &&
			(entry.locked || (counts.get(entry.providerId ?? "") ?? 0) === 0)
		) {
			this.#setActiveEntry("all");
		}
	}

	/**
	 * Catalog items matching a non-blank `query`. When the browser holds the
	 * whole catalog its ranking for this query already ran, so reuse it;
	 * otherwise scan a catalog index kept across keystrokes.
	 */
	#catalogMatches(query: string): readonly ModelBrowserItem[] {
		if (this.#browserCatalog === this.#availableItems && this.#browser.query === query) {
			const ranked = this.#browser.queryMatches;
			if (ranked) return ranked;
		}
		let cached = this.#catalogCorpus;
		if (cached?.items !== this.#availableItems) {
			cached = { items: this.#availableItems, corpus: new FuzzyCorpus(this.#availableItems, modelSearchText) };
			this.#catalogCorpus = cached;
		}
		return cached.corpus.rank(query).map(result => result.item);
	}

	/**
	 * Entries the scope hop skips: separators always; while searching, also
	 * the Roles view (not a model scope), an empty Recent, locked providers,
	 * and providers without matches.
	 */
	#isHopSkipped(entry: SidebarEntry): boolean {
		if (entry.kind === "separator") return true;
		if (!this.#searchCounts) return false;
		if (isRolesView(entry.kind)) return true;
		if (entry.kind === "recent") return this.#recentSearchCount === 0;
		if (entry.kind === "provider") {
			if (entry.locked) return true;
			return (this.#searchCounts.get(entry.providerId ?? "") ?? 0) === 0;
		}
		return false;
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Provider discovery refresh
	// ═══════════════════════════════════════════════════════════════════════

	#startRefreshSpinner(): void {
		// Native surfaces clock the refresh spinner themselves.
		if (this.#refreshSpinnerInterval || isNativeRendering()) return;
		this.#refreshSpinnerInterval = setInterval(() => {
			const frameCount = theme.spinnerFrames.length;
			if (frameCount > 0) {
				this.#refreshSpinnerFrame = (this.#refreshSpinnerFrame + 1) % frameCount;
			}
			this.#requestRender();
		}, 80);
	}

	#stopRefreshSpinnerIfIdle(): void {
		if (this.#refreshingProviders.size > 0) return;
		if (this.#refreshSpinnerInterval) {
			clearInterval(this.#refreshSpinnerInterval);
			this.#refreshSpinnerInterval = undefined;
		}
		this.#refreshSpinnerFrame = 0;
	}

	#setProviderRefreshing(providerId: string, refreshing: boolean): void {
		if (refreshing) {
			this.#refreshingProviders.add(providerId);
			this.#startRefreshSpinner();
		} else {
			this.#refreshingProviders.delete(providerId);
			this.#stopRefreshSpinnerIfIdle();
		}
	}

	#cancelScheduledRefreshesExcept(keepProviderId?: string): void {
		// Hover debounce only. An explicit F5 queued behind an in-flight catalog
		// fetch must still re-mint credentials after that fetch settles, even if
		// the user has moved to All models or another provider.
		for (const [providerId, timer] of this.#scheduledProviderRefreshes) {
			if (providerId === keepProviderId) continue;
			clearTimeout(timer);
			this.#scheduledProviderRefreshes.delete(providerId);
			this.#setProviderRefreshing(providerId, false);
		}
	}

	#scheduleProviderRefresh(providerId: string, options?: { force?: boolean }): void {
		if (this.#scopedModels.length > 0 || !providerId) return;
		const force = options?.force === true;
		if (force) {
			const pending = this.#scheduledProviderRefreshes.get(providerId);
			if (pending) {
				// Selection already queued a catalog-only fetch. F5 upgrades it
				// instead of returning at the pending-guard and dropping force.
				clearTimeout(pending);
				this.#scheduledProviderRefreshes.delete(providerId);
				autoRefreshedProviders.add(providerId);
				void this.#refreshProviderInBackground(providerId, true);
				return;
			}
			if (this.#refreshingProviders.has(providerId)) {
				this.#pendingCredentialRefreshProviders.add(providerId);
				return;
			}
		} else if (this.#scheduledProviderRefreshes.has(providerId) || this.#refreshingProviders.has(providerId)) {
			return;
		}
		// Hovering a provider must not re-fetch on every visit: auto-refresh runs
		// at most once per provider for the process lifetime. F5 forces a re-fetch.
		if (!force && autoRefreshedProviders.has(providerId)) return;
		this.#setProviderRefreshing(providerId, true);
		const timer = setTimeout(() => {
			// Consume the once-guard only when the fetch actually starts: hopping
			// through a provider cancels the debounce and must not burn its slot.
			autoRefreshedProviders.add(providerId);
			this.#scheduledProviderRefreshes.delete(providerId);
			void this.#refreshProviderInBackground(providerId, force);
		}, PROVIDER_REFRESH_DEBOUNCE_MS);
		this.#scheduledProviderRefreshes.set(providerId, timer);
	}

	async #refreshProviderInBackground(providerId: string, refreshCommandCredentials = false): Promise<void> {
		try {
			if (refreshCommandCredentials) {
				await this.#registry.refreshProvider(providerId, "online", { refreshCommandCredentials: true });
			} else {
				await this.#registry.refreshProvider(providerId, "online");
			}
			// The provider refresh already updated the registry snapshot;
			// re-reading it here stays purely in-memory.
			this.#syncFromRegistryState();
		} catch (error) {
			this.#configError = error instanceof Error ? error.message : String(error);
		} finally {
			this.#setProviderRefreshing(providerId, false);
			if (!this.#disposed && this.#pendingCredentialRefreshProviders.delete(providerId)) {
				this.#setProviderRefreshing(providerId, true);
				autoRefreshedProviders.add(providerId);
				void this.#refreshProviderInBackground(providerId, true);
			}
			this.#requestRender();
		}
	}

	#formatDiscoveryAge(fetchedAt: number | undefined): string | undefined {
		if (!fetchedAt) return undefined;
		const ageMs = Math.max(0, Date.now() - fetchedAt);
		if (ageMs < 60_000) return "less than a minute ago";
		return `${Math.round(ageMs / 60_000)}m ago`;
	}

	#emptyStateMessage(): string | undefined {
		if (this.#configError) return `  ${this.#configError}`;
		const entry = this.#activeEntry();
		if (entry.kind === "recent") return "  No recently used models yet";
		if (entry.kind !== "provider" || entry.locked) return undefined;
		if (this.#browser.query.trim()) {
			return `  No matching models in ${entry.label}. Switch to All models to search every provider.`;
		}
		const providerId = entry.providerId ?? "";
		const state = this.#registry.getProviderDiscoveryState(providerId);
		if (!state) return undefined;
		const age = this.#formatDiscoveryAge(state.fetchedAt);
		switch (state.status) {
			case "cached":
				return age
					? `  Using cached model list from ${age}. Live refresh is still pending.`
					: "  Using cached model list. Live refresh is still pending.";
			case "unavailable": {
				const httpMatch = state.error?.match(/^HTTP (\d+) from (.+)$/);
				if (httpMatch?.[1] === "404") {
					return `  Discovery endpoint ${httpMatch[2]} returned 404. Point baseUrl at the host that serves /models (usually .../v1).`;
				}
				if (state.error) return `  Discovery failed: ${state.error}`;
				return age ? `  Provider unavailable. Using cached model list from ${age}.` : "  Provider unavailable.";
			}
			case "unauthenticated":
				return "  Provider requires authentication before models can be discovered.";
			case "idle":
				return "  Provider has not been refreshed yet.";
			case "empty":
				return "  Discovery succeeded but returned 0 models. Check that /models returns { data: [{ id }] }.";
			case "ok":
				return undefined;
		}
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Assignment flow
	// ═══════════════════════════════════════════════════════════════════════

	#activateItem(item: ModelBrowserItem): void {
		// Also reached from the browser's own native list events, which bypass handleInput.
		this.#nativeVersion++;
		if (this.#assigning) {
			const target = this.#assigning;
			this.#assigning = null;
			if (target.kind === "role") {
				this.#assignRole(item, target.role, true);
			} else if (target.kind === "fallbackKey") {
				this.#openFallbackKeyStrip(item);
			} else if (target.kind === "poolMember") {
				this.#commitPoolMember(item, target);
			} else if (target.kind === "newGroup") {
				this.#commitNewGroup(item, target.name);
			} else {
				this.#commitFallback(item, target);
			}
			return;
		}
		this.#openRoleStrip(item);
	}

	#roleForScope(role: string, scope: ModelRoleSelectionScope): ResolvedModelRoleValue {
		const roleValue =
			scope === "project" ? this.#settings.getProjectModelRole(role) : this.#settings.getGlobalModelRole(role);
		const allModels =
			this.#scopedModels.length > 0
				? scopedRolePool(
						this.#scopedModels.map(scoped => scoped.model),
						this.#registry,
					)
				: this.#registry.getAll("all");
		const roleLookup: ModelRoleLookup = {
			getModelRole: scopedRole =>
				scope === "project"
					? (this.#settings.getProjectModelRole(scopedRole) ?? this.#settings.getGlobalModelRole(scopedRole))
					: this.#settings.getGlobalModelRole(scopedRole),
		};
		return this.#settings.resolveRoleValue(roleValue, allModels, roleLookup);
	}

	#thinkingLevelForScope(role: string, scope: ModelRoleSelectionScope): ConfiguredThinkingLevel {
		const resolved = this.#roleForScope(role, scope);
		return resolved.explicitThinkingLevel ? (resolved.thinkingLevel ?? ThinkingLevel.Inherit) : ThinkingLevel.Inherit;
	}
	#finishAssignment(result: void | boolean | Promise<void | boolean>, onSuccess: () => void): void {
		if (!(result instanceof Promise)) {
			if (result !== false) onSuccess();
			else this.#requestRender();
			return;
		}
		this.#assignmentPending = true;
		this.#requestRender();
		void result.then(
			applied => {
				this.#assignmentPending = false;
				if (this.#disposed) return;
				if (applied !== false) onSuccess();
				else this.#requestRender();
			},
			() => {
				this.#assignmentPending = false;
				if (!this.#disposed) this.#requestRender();
			},
		);
	}

	/**
	 * Persist `role → item`, preserving a still-supported thinking level, then
	 * open the thinking strip — skipped for models with no reasoning surface,
	 * where every chip would be a no-op ({@link #thinkingOptionsFor}).
	 */
	#assignRole(item: ModelBrowserItem, role: string, returnToRoles: boolean, scope?: ModelRoleSelectionScope): void {
		if (this.#settings.modelRoleStorage === "project" && scope === undefined) {
			this.#openScopeStrip(item, role, returnToRoles);
			return;
		}

		const current = this.#roles[role];
		let level: ConfiguredThinkingLevel = ThinkingLevel.Inherit;
		if (this.#settings.modelRoleStorage === "project" && scope !== undefined) {
			level = this.#thinkingLevelForScope(role, scope);
		} else if (current && !current.autoSelected) {
			level = current.thinkingLevel;
		}
		const supported = this.#thinkingOptionsFor(item.model);
		if (!supported.includes(level)) level = ThinkingLevel.Inherit;
		const result = this.#callbacks.onAssign(item.model, role, level, item.selector, scope);
		this.#finishAssignment(result, () => {
			this.#refreshAfterMutation();
			if (supported.length === 0) {
				if (returnToRoles) {
					this.#setActiveEntry("roles");
					this.#focus = "list";
				}
				return;
			}
			this.#openThinkingStrip(item, role, returnToRoles, scope, level);
		});
	}

	#unassignRole(role: string): void {
		const assignment = this.#roles[role];
		if (!assignment || assignment.autoSelected) return;
		if (this.#settings.modelRoleStorage === "project") {
			const source = this.#settings.getModelRoleSource(role);
			this.#callbacks.onUnassign(role, source === "default" ? undefined : source);
		} else {
			this.#callbacks.onUnassign(role);
		}
		this.#refreshAfterMutation();
	}

	/**
	 * Clear a role whose value is a pool, whether or not a member resolves. Only a pool the global
	 * layer supplies is cleared, so `x` never removes a lower-precedence value instead.
	 */
	#unassignPooledRole(role: string): void {
		if (!this.#poolClearable({ kind: "role", key: role })) return;
		if (this.#settings.modelRoleStorage === "project") this.#callbacks.onUnassign(role, "global");
		else this.#callbacks.onUnassign(role);
		this.#refreshAfterMutation();
	}

	/**
	 * Thinking levels a role assignment can actually apply. A model that does
	 * not reason gets none: no request path sends reasoning for it, and
	 * `applyAutoThinkingLevel` early-returns on `!model.reasoning`, so
	 * `inherit`/`off`/`auto` would all be no-ops. Reasoners without an effort
	 * dial (`thinking: undefined`, e.g. `xai/grok-code-fast-1`) keep the three
	 * always-on levels — their thinking is real, only the ladder is absent.
	 */
	#thinkingOptionsFor(model: Model): ConfiguredThinkingLevel[] {
		if (!model.reasoning) return [];
		if (model.thinking?.unverified) return [ThinkingLevel.Inherit, ThinkingLevel.Off, ...getSupportedEfforts(model)];
		return [ThinkingLevel.Inherit, ThinkingLevel.Off, AUTO_THINKING, ...getSupportedEfforts(model)];
	}

	/**
	 * Resolve what `t` on a role row would edit: the role's model in its
	 * persisted scope. Undefined when the role is unassigned or its model has
	 * no thinking levels to offer, which makes both `t` and its footer hint
	 * inert — the same rule wildcard fallback rows follow.
	 */
	#roleThinkingTarget(role: string): { item: ModelBrowserItem; scope?: ModelRoleSelectionScope } | undefined {
		const assignment = this.#roles[role];
		// A role assignment would replace the pool with one model; member efforts are edited per member.
		if (!assignment || this.#rolePool(role)) return undefined;
		const source =
			this.#settings.modelRoleStorage === "project" ? this.#settings.getModelRoleSource(role) : "default";
		const scope = source === "project" || source === "global" ? source : undefined;
		const model = scope ? this.#roleForScope(role, scope).model : assignment.model;
		if (!model || this.#thinkingOptionsFor(model).length === 0) return undefined;
		return {
			item: { provider: model.provider, id: model.id, model, selector: `${model.provider}/${model.id}` },
			scope,
		};
	}

	/** Offer only the roles this model can actually fill (chat roles for chat models, `web` for search runners, …). */
	#openRoleStrip(item: ModelBrowserItem): void {
		const chips: StripChip[] = [];
		const scopedStorage = this.#settings.modelRoleStorage === "project";
		const scopes: readonly ModelRoleSelectionScope[] = scopedStorage ? ["project", "global"] : ["global"];
		for (const role of this.#visibleRoleIds()) {
			const info = this.#settings.getRoleInfo(role);
			if (!info.accepts(item.model)) continue;
			const assignment = this.#roles[role];
			for (const scope of scopes) {
				const scopedModel = scopedStorage
					? this.#roleForScope(role, scope).model
					: assignment && !assignment.autoSelected
						? assignment.model
						: undefined;
				const assignedHere =
					!!scopedModel && scopedModel.provider === item.model.provider && scopedModel.id === item.model.id;
				const roleLabel = sanitizeDisplayLine(info.tag ?? info.name ?? role).toLowerCase();
				const label = scopedStorage ? `${scope} ${roleLabel}` : roleLabel;
				chips.push({
					label,
					styled: assignedHere
						? // Separator required: under the `nerd` preset this glyph is a
							// two-cell-wide PUA icon that `visibleWidth` counts as one, so
							// without it the icon overhangs and eats `label`'s first char.
							theme.fg(info.color ?? "muted", `${theme.status.enabled} ${label}`) +
							theme.fg("dim", ` ${theme.status.success}`)
						: theme.fg(info.color ?? "muted", label),
					role,
					scope,
					action: assignedHere ? "unassign" : "assign",
				});
			}
		}
		chips.push({
			label: `fallbacks:${item.model.id}`,
			styled: theme.fg("muted", `fallbacks:${item.model.id}`),
			action: "fallbackModel",
		});
		chips.push({
			label: `fallbacks:${item.model.provider}/*`,
			styled: theme.fg("muted", `fallbacks:${item.model.provider}/*`),
			action: "fallbackProvider",
		});
		// `retry-fallback` appends to the default chain, so only chat-capable models qualify.
		if (this.#settings.getRoleInfo("default").accepts(item.model)) {
			chips.push({ label: "fallback", styled: theme.fg("muted", "retry-fallback"), action: "fallback" });
		}
		this.#strip = { kind: "role", item, chips, index: 0, returnToRoles: false };
	}

	#openScopeStrip(item: ModelBrowserItem, role: string, returnToRoles: boolean): void {
		const chips: StripChip[] = [
			{ label: "project", styled: theme.fg("accent", "project"), action: "scope", scope: "project" },
			{ label: "global", styled: theme.fg("muted", "global"), action: "scope", scope: "global" },
		];
		this.#strip = { kind: "scope", item, role, chips, index: 0, returnToRoles };
	}

	#openThinkingStrip(
		item: ModelBrowserItem,
		role: string,
		returnToRoles: boolean,
		scope?: ModelRoleSelectionScope,
		committedLevel?: ConfiguredThinkingLevel,
	): void {
		const options = this.#thinkingOptionsFor(item.model);
		const current =
			committedLevel ??
			(this.#settings.modelRoleStorage === "project" && scope !== undefined
				? this.#thinkingLevelForScope(role, scope)
				: (this.#roles[role]?.thinkingLevel ?? ThinkingLevel.Inherit));
		const chips = this.#thinkingChips(options);
		const preselect = options.indexOf(current);
		this.#strip = {
			kind: "thinking",
			item,
			role,
			scope,
			chips,
			index: preselect >= 0 ? preselect : 0,
			returnToRoles,
			initialThinkingLevel: current,
		};
	}

	/** Build the footer chips for a thinking strip from its level options. */
	#thinkingChips(options: ConfiguredThinkingLevel[]): StripChip[] {
		return options.map(level => {
			const label = getConfiguredThinkingLevelMetadata(level).label;
			const glyph = thinkingLevelGlyph(level, theme);
			return {
				label,
				styled: glyph ? `${theme.fg("accent", glyph)} ${label}` : label,
				action: "thinking",
				thinkingLevel: level,
			};
		});
	}

	/**
	 * Fallback-entry model lookup through the registry — the same
	 * case-insensitive, alias-aware resolution the runtime uses, so
	 * `OpenAI/GPT-5.5` edits the model it runs. Covers locked providers too:
	 * effort support is a catalog fact, not an auth fact, and the row already
	 * exists, so the strip changes no scope.
	 */
	#findFallbackModel(provider: string, id: string): ModelBrowserItem | undefined {
		const model = this.#registry.find(provider, id);
		if (!model) return undefined;
		return { provider: model.provider, id: model.id, model, selector: `${model.provider}/${model.id}` };
	}

	/**
	 * Split a fallback-chain entry into its model base, explicit effort, and
	 * `@upstream` routing. An exact literal id wins over routing
	 * (`google-vertex/claude-opus-4-8@default` is a real model, not a route —
	 * mirroring the runtime's exact-first precedence); otherwise the routing
	 * slug is kept verbatim so saves can re-attach it (`openrouter/id@fireworks`
	 * looks up `openrouter/id` but persists with the route intact).
	 */
	#parseFallbackEntry(raw: string):
		| {
				provider: string;
				id: string;
				thinkingLevel?: ConfiguredThinkingLevel;
				upstream: string | undefined;
		  }
		| undefined {
		const trimmed = raw.trim();
		const parse = (pattern: string) =>
			parseModelString(pattern, {
				allowMaxSuffix: true,
				allowAutoAlias: true,
				isLiteralModelId: (provider, id) => this.#findFallbackModel(provider, id) !== undefined,
			});
		const literal = parse(trimmed);
		if (literal && this.#findFallbackModel(literal.provider, literal.id)) return { ...literal, upstream: undefined };
		const routing = splitUpstreamRouting(trimmed);
		if (!routing) {
			if (!literal) return undefined;
			return { ...literal, upstream: undefined };
		}
		const parsed = parse(routing.base.trim());
		if (!parsed) return undefined;
		return { ...parsed, upstream: routing.upstream };
	}

	/**
	 * Resolve a fallback-chain entry to its browser item, explicit effort, and
	 * routing. Undefined when the row is inert: `provider/*` wildcards (always
	 * inherit) or models known neither live nor from the catalog.
	 */
	#resolveFallbackEntry(
		role: string,
		index: number,
	):
		| { item: ModelBrowserItem; thinkingLevel: ConfiguredThinkingLevel | undefined; upstream: string | undefined }
		| undefined {
		const raw = this.#fallbackChains()[role]?.[index];
		if (!raw || raw.endsWith("/*")) return undefined;
		const parsed = this.#parseFallbackEntry(raw);
		if (!parsed) return undefined;
		const item = this.#findFallbackModel(parsed.provider, parsed.id);
		if (!item) return undefined;
		return { item, thinkingLevel: parsed.thinkingLevel, upstream: parsed.upstream };
	}

	/**
	 * Open the thinking strip for a fallback-chain entry (`t` on a `↳` row).
	 * Wildcard entries (`provider/*`) always inherit by design, so `t` is inert on them.
	 */
	#openFallbackThinkingStrip(row: { role: string; chainIndex: number }): void {
		const resolved = this.#resolveFallbackEntry(row.role, row.chainIndex);
		if (!resolved) return;
		const { item } = resolved;
		// No `auto` chip: a hand-written `:auto` suffix collapses to inherit at
		// apply time, so offering it would promise per-prompt classification the
		// fallback never performs. A primary running `auto` is inherited anyway
		// through the bare form.
		const options: ConfiguredThinkingLevel[] = [
			ThinkingLevel.Inherit,
			ThinkingLevel.Off,
			...getSupportedEfforts(item.model),
		];
		const current =
			resolved.thinkingLevel === undefined || resolved.thinkingLevel === AUTO_THINKING
				? ThinkingLevel.Inherit
				: resolved.thinkingLevel;
		const chips = this.#thinkingChips(options);
		this.#strip = {
			kind: "thinking",
			item,
			role: row.role,
			fallbackIndex: row.chainIndex,
			chips,
			index: Math.max(0, options.indexOf(current)),
			returnToRoles: true,
		};
	}

	/** Persist a fallback entry's thinking choice: an explicit effort is suffixed, inherit is stored bare. */
	#setFallbackThinking(role: string, index: number, level: ConfiguredThinkingLevel): void {
		const chain = [...(this.#fallbackChains()[role] ?? [])];
		if (index >= chain.length) return;
		const resolved = this.#resolveFallbackEntry(role, index);
		if (!resolved) return;
		// Save the registry-canonical spelling (`OpenAI/GPT-5.5` persists as
		// `openai/gpt-5.5:off`), re-attaching `@upstream` routing ahead of the
		// effort suffix (`id@up:low` is the canonical order).
		const base = `${resolved.item.provider}/${resolved.item.id}`;
		const routed = resolved.upstream ? `${base}@${resolved.upstream}` : base;
		const next = formatModelSelectorValue(routed, level);
		chain[index] = next;
		for (let i = chain.length - 1; i >= 0; i--) {
			if (i !== index && chain[i] === next) chain.splice(i, 1);
		}
		this.#setFallbackChain(role, chain);
		const rowIndex = this.#rolesRows.findIndex(
			row => row.kind === "fallback" && row.role === role && row.selector === next,
		);
		if (rowIndex >= 0) this.#roleIndex = rowIndex;
	}

	#closeStrip(): void {
		const strip = this.#strip;
		this.#strip = null;
		this.#frame.chipRanges = [];
		if ((strip?.kind === "scope" || strip?.kind === "thinking") && strip.returnToRoles) {
			this.#setActiveEntry("roles");
			this.#focus = "list";
		}
	}

	#activateStripChip(): void {
		const strip = this.#strip;
		if (!strip || strip.kind === "name") return;
		const chip = strip.chips[strip.index];
		if (!chip) return;
		switch (chip.action) {
			case "assign":
				if (chip.role) {
					this.#strip = null;
					this.#assignRole(strip.item, chip.role, false, chip.scope);
				}
				return;
			case "unassign":
				if (chip.role) {
					this.#roleConfirm = {
						role: chip.role,
						scope: chip.scope,
						text: `Clear role ${sanitizeDisplayLine(chip.role)}${chip.scope ? ` (${chip.scope})` : ""}?`,
					};
				}
				return;
			case "fallback":
				this.#appendFallback(strip.item, "default");
				this.#closeStrip();
				return;
			case "fallbackModel":
				this.#closeStrip();
				this.#startAssignFallback(strip.item.selector, null);
				return;
			case "fallbackProvider":
				this.#closeStrip();
				this.#startAssignFallback(`${strip.item.model.provider}/*`, null);
				return;
			case "scope":
				if (strip.role && chip.scope) {
					this.#strip = null;
					this.#assignRole(strip.item, strip.role, strip.returnToRoles, chip.scope);
				}
				return;
			case "thinking": {
				if (strip.role && chip.thinkingLevel !== undefined && strip.fallbackIndex !== undefined) {
					this.#setFallbackThinking(strip.role, strip.fallbackIndex, chip.thinkingLevel);
					this.#strip = null;
					this.#frame.chipRanges = [];
					return;
				}
				// The preselected level is confirmation, not a force-reapply action;
				// only a changed level should call setModel() again.
				const changed = chip.thinkingLevel !== strip.initialThinkingLevel;
				if (strip.role && chip.thinkingLevel !== undefined && changed) {
					const result = this.#callbacks.onAssign(
						strip.item.model,
						strip.role,
						chip.thinkingLevel,
						strip.item.selector,
						strip.scope,
					);
					this.#closeStrip();
					this.#finishAssignment(result, () => this.#refreshAfterMutation());
				} else {
					this.#closeStrip();
				}
				return;
			}
		}
	}

	/**
	 * Switch the body into assign mode for `role`: full catalog, cleared query, current model preselected.
	 * Arrows land on the model rows (the next step of the flow); ← still reaches the provider scopes.
	 */
	#startAssign(role: string): void {
		this.#assigning = { kind: "role", role };
		this.#focus = "list";
		this.#browser.setShowProvider(true);
		this.#setCandidateItems(this.#availableItems);
		this.#browser.setQuery("");
		const current = this.#roles[role];
		if (current) {
			this.#browser.selectSelector(`${current.model.provider}/${current.model.id}`);
		}
	}

	/**
	 * Browse the catalog to fill a fallback-chain slot: `index` replaces an entry, `null` appends.
	 * Appending to a chain configured as a pool adds a pool member instead; a read-only pool takes neither.
	 */
	#startAssignFallback(role: string, index: number | null): void {
		if (this.#isPooledChain(role)) {
			if (index === null) this.#startAssignPoolMember(role, { kind: "chain", key: role }, null);
			return;
		}
		this.#assigning = { kind: "fallback", role, index };
		this.#focus = "list";
		this.#browser.setShowProvider(true);
		this.#setCandidateItems(this.#availableItems);
		this.#browser.setQuery("");
		if (index !== null) {
			const selector = this.#fallbackChains()[role]?.[index];
			// Suffixed entries (`provider/id:low`) carry effort the browser rows
			// don't show; match on the base so the current model preselects.
			if (selector) {
				const parsed = this.#parseFallbackEntry(selector);
				this.#browser.selectSelector(parsed ? `${parsed.provider}/${parsed.id}` : selector);
			}
		}
	}

	/** Browse the catalog for the primary model a brand-new fallback chain protects. */
	#startAssignFallbackKey(): void {
		this.#assigning = { kind: "fallbackKey" };
		this.#focus = "list";
		this.#browser.setShowProvider(true);
		this.#setCandidateItems(this.#availableItems);
		this.#browser.setQuery("");
	}

	/** Second step of "+ New fallback…": key the chain by the picked model or its whole provider. */
	#openFallbackKeyStrip(item: ModelBrowserItem): void {
		const chips: StripChip[] = [
			{
				label: `for ${item.selector}`,
				styled: theme.fg("muted", `for ${item.selector}`),
				action: "fallbackModel",
			},
			{
				label: `for ${item.model.provider}/*`,
				styled: theme.fg("muted", `for ${item.model.provider}/*`),
				action: "fallbackProvider",
			},
		];
		this.#strip = { kind: "role", item, chips, index: 0, returnToRoles: false };
	}

	/** Write the picked model into the target chain slot, dedupe, and land back on its Roles row. */
	#commitFallback(item: ModelBrowserItem, target: { role: string; index: number | null }): void {
		const chain = [...(this.#fallbackChains()[target.role] ?? [])];
		// New picks are stored bare, i.e. inherit-the-primary; `t` on the row specializes the effort.
		const selector = item.selector;
		if (target.index !== null && target.index < chain.length) {
			chain[target.index] = selector;
			for (let i = chain.length - 1; i >= 0; i--) {
				if (i !== target.index && chain[i] === selector) chain.splice(i, 1);
			}
		} else if (!chain.includes(selector)) {
			chain.push(selector);
		}
		this.#setFallbackChain(target.role, chain);
		this.#browser.setQuery("");
		this.#setActiveEntry("roles");
		this.#focus = "list";
		const rowIndex = this.#rolesRows.findIndex(
			row => row.kind === "fallback" && row.role === target.role && row.selector === selector,
		);
		if (rowIndex >= 0) this.#roleIndex = rowIndex;
	}

	/**
	 * Persist `role`'s chain through the host callback and rebuild dependent state. A model-group
	 * key is left untouched, so no hub edit replaces a configured pool with a list.
	 */
	#setFallbackChain(role: string, chain: string[]): void {
		if (this.#isPooledChain(role)) return;
		this.#callbacks.onFallbackChainChange?.(role, chain);
		this.#refreshAfterMutation();
	}

	/** Append `item` to `role`'s fallback chain (no-op when already present). */
	#appendFallback(item: ModelBrowserItem, role: string): void {
		const chain = [...(this.#fallbackChains()[role] ?? [])];
		if (chain.includes(item.selector)) return;
		chain.push(item.selector);
		this.#setFallbackChain(role, chain);
	}

	/** Remove one chain entry; the cursor stays on the nearest surviving row. */
	#removeFallback(row: { role: string; chainIndex: number }): void {
		const chain = [...(this.#fallbackChains()[row.role] ?? [])];
		if (row.chainIndex >= chain.length) return;
		chain.splice(row.chainIndex, 1);
		this.#setFallbackChain(row.role, chain);
		this.#roleIndex = Math.min(this.#roleIndex, Math.max(0, this.#rolesRows.length - 1));
	}

	/** Move a chain entry one slot earlier/later; the cursor follows the moved entry. */
	#moveFallback(row: { role: string; chainIndex: number }, delta: -1 | 1): void {
		const chain = [...(this.#fallbackChains()[row.role] ?? [])];
		const target = row.chainIndex + delta;
		if (row.chainIndex >= chain.length || target < 0 || target >= chain.length) return;
		[chain[row.chainIndex], chain[target]] = [chain[target], chain[row.chainIndex]];
		this.#setFallbackChain(row.role, chain);
		this.#roleIndex += delta;
	}

	#cancelAssign(): void {
		const home = this.#assignHome(this.#assigning);
		this.#assigning = null;
		this.#browser.setQuery("");
		this.#setActiveEntry(home);
		this.#focus = "list";
	}

	/** The view a pick returns to: Groups for a group's member or a new group, else Roles. */
	#assignHome(assign: AssignTarget | null): "roles" | "groups" {
		const group = assign?.kind === "newGroup" || (assign?.kind === "poolMember" && assign.target.kind === "group");
		return group ? "groups" : "roles";
	}

	/** What a role, fallback or pool-member pick is for: `+name` for a group's member, else the role's tag. */
	#assignLabel(assign: Exclude<AssignTarget, { kind: "fallbackKey" } | { kind: "newGroup" }>): string {
		if (assign.kind === "poolMember" && assign.target.kind === "group") {
			return `+${sanitizeDisplayLine(assign.target.key)}`;
		}
		const info = this.#settings.getRoleInfo(assign.role);
		return sanitizeDisplayLine(info.tag ?? info.name ?? assign.role);
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Pool editing
	// ═══════════════════════════════════════════════════════════════════════

	/** The pool a row edits: a pooled role's value, a chain pool, or a member's pool. */
	#rowPoolTarget(row: RolesRow | undefined): ModelHubPoolTarget | undefined {
		switch (row?.kind) {
			case "role":
				return this.#rolePool(row.role) ? { kind: "role", key: row.role } : undefined;
			case "pool":
				return { kind: "chain", key: row.role };
			case "chainKey":
				return this.#isPooledChain(row.role) ? { kind: "chain", key: row.role } : undefined;
			case "poolMember":
				return row.target;
			case "group":
				return { kind: "group", key: row.role };
			default:
				return undefined;
		}
	}

	/** The editable pool a row edits; undefined when the row has none or it is read-only. */
	#rowEditablePool(
		row: RolesRow | undefined,
	): { target: ModelHubPoolTarget; pool: ModelHubPool & { raw: Readonly<Record<string, unknown>> } } | undefined {
		const target = this.#rowPoolTarget(row);
		if (!target) return undefined;
		const pool = this.#pool(target);
		return this.#poolEditable(pool) ? { target, pool } : undefined;
	}

	/** Legacy selectors `m` would turn into a pool, with the entry they live at; undefined when `m` does not apply. */
	#legacyPoolSource(row: RolesRow | undefined): { target: ModelHubPoolTarget; selectors: string[] } | undefined {
		if (!this.#callbacks.onPoolChange || !row) return undefined;
		let target: ModelHubPoolTarget;
		let selectors: string[];
		if (row.kind === "role") {
			if (this.#rolePool(row.role) || !this.#settings.roleAcceptsPools?.(row.role)) return undefined;
			target = { kind: "role", key: row.role };
			selectors = (this.#settings.getModelRole(row.role) ?? "")
				.split(",")
				.map(selector => selector.trim())
				.filter(selector => selector.length > 0);
		} else if (row.kind === "fallback" || (row.kind === "chainKey" && !this.#isPooledChain(row.role))) {
			target = { kind: "chain", key: row.role };
			selectors = [...(this.#fallbackChains()[row.role] ?? [])];
		} else {
			return undefined;
		}
		if (selectors.length === 0) return undefined;
		try {
			if (this.#settings.poolWriteBlocker?.(target) !== undefined) return undefined;
		} catch {
			return undefined;
		}
		return { target, selectors };
	}

	/** Persist `value` at `target` through the host; the refusal (sanitized) when nothing was written. */
	#savePool(target: ModelHubPoolTarget, value: Readonly<Record<string, unknown>> | undefined): string | undefined {
		const write = this.#callbacks.onPoolChange;
		if (!write) return "pool edits are not available here";
		let error: string | undefined;
		try {
			error = write(target, value);
		} catch (failure) {
			error = failure instanceof Error ? failure.message : String(failure);
		}
		if (error === undefined) this.#referenceCache.clear();
		return error === undefined ? undefined : sanitizeDisplayLine(error);
	}

	/**
	 * Persist `value` at `target` through the host. A refused value leaves the
	 * settings untouched and its validator message in the status row.
	 */
	#writePool(target: ModelHubPoolTarget, value: Readonly<Record<string, unknown>> | undefined): boolean {
		const error = this.#savePool(target, value);
		this.#poolStatus = error === undefined ? undefined : { text: error, tone: "error" };
		this.#refreshAfterMutation();
		return error === undefined;
	}

	/** Report a pool edit the hub declined or adjusted, in the status row until the next roles action. */
	#poolNotice(text: string): void {
		this.#poolStatus = { text: sanitizeDisplayLine(text), tone: "warning" };
	}

	/**
	 * A copy of the editable pool at `target` after `mutate`, with where it is written: the entry, or
	 * the `modelGroups` entry a reference names. Undefined when the pool is not editable or `mutate`
	 * returns false.
	 */
	#poolDraft(
		target: ModelHubPoolTarget,
		mutate: (draft: Record<string, unknown>) => boolean,
	): { write: ModelHubPoolTarget; draft: Record<string, unknown> } | undefined {
		const pool = this.#pool(target);
		if (!this.#poolEditable(pool)) return undefined;
		const draft = structuredClone(pool.raw) as Record<string, unknown>;
		if (!mutate(draft)) return undefined;
		return { write: pool.source.kind === "ref" ? { kind: "group", key: pool.source.group } : target, draft };
	}

	/** Apply `mutate` to a copy of the editable pool at `target` and persist it; `mutate` returns false to skip the write. */
	#editPool(target: ModelHubPoolTarget, mutate: (draft: Record<string, unknown>) => boolean): boolean {
		const edit = this.#poolDraft(target, mutate);
		return edit !== undefined && this.#writePool(edit.write, edit.draft);
	}

	/** Persist a preference edit and return its field-level refusal. */
	#editPoolFromField(
		target: ModelHubPoolTarget,
		mutate: (draft: Record<string, unknown>) => void,
	): string | undefined {
		const edit = this.#poolDraft(target, draft => {
			mutate(draft);
			return true;
		});
		if (!edit) return this.#pool(target)?.readOnly ?? "Pool is no longer editable";
		const error = this.#savePool(edit.write, edit.draft);
		this.#refreshAfterMutation();
		return error;
	}

	/** `m`: turn a legacy selector value into a `priority` pool, one member per selector in configured order. */
	#convertToPool(row: RolesRow | undefined): void {
		const source = this.#legacyPoolSource(row);
		if (!source) return;
		const models: Record<string, Record<string, unknown>> = {};
		const order: string[] = [];
		for (const selector of source.selectors) {
			const { base, level } = splitThinkingSuffix(selector, selector.indexOf("/"));
			const alias = uniquePoolAlias(base, order);
			// An unsupported suffix (`:off`, `:auto`) is kept so the validator names it instead of the hub dropping it.
			models[alias] =
				level && level !== ThinkingLevel.Inherit ? { model: base, defaultEffort: level } : { model: base };
			order.push(alias);
		}
		if (this.#writePool(source.target, { strategy: "priority", strategyOptions: { order }, models })) {
			const index = this.#rolesRows.findIndex(candidate =>
				source.target.kind === "role"
					? candidate.kind === "role" && candidate.role === source.target.key
					: candidate.kind === "pool" && candidate.role === source.target.key,
			);
			if (index >= 0) this.#roleIndex = index;
		}
	}

	/** Browse the catalog to add a member to the pool at `target` (`alias` null) or replace member `alias`. */
	#startAssignPoolMember(role: string, target: ModelHubPoolTarget, alias: string | null): void {
		if (!this.#poolEditable(this.#pool(target))) return;
		this.#assigning = { kind: "poolMember", role, target, alias };
		this.#focus = "scope";
		this.#browser.setShowProvider(true);
		this.#setCandidateItems(this.#availableItems);
		this.#browser.setQuery("");
		const member = alias === null ? undefined : this.#pool(target)?.members.find(entry => entry.alias === alias);
		if (member) this.#browser.selectSelector(member.model);
	}

	/** Write the picked model as a new or replaced member and land on its row. */
	#commitPoolMember(
		item: ModelBrowserItem,
		assign: { role: string; target: ModelHubPoolTarget; alias: string | null },
	): void {
		const selector = item.selector;
		let landed = assign.alias;
		let notice: string | undefined;
		this.#editPool(assign.target, draft => {
			const models = draftRecord(draft, "models");
			const holder = Object.keys(models).find(alias => memberModel(models[alias]) === selector);
			if (holder !== undefined) {
				notice = `${selector} is already member ${holder} of this pool`;
				return false;
			}
			if (assign.alias === null) {
				landed = uniquePoolAlias(selector, Object.keys(models));
				models[landed] = { model: selector };
				draftOrder(draft)?.push(landed);
				return true;
			}
			const member = models[assign.alias];
			if (!isRecord(member)) return false;
			member.model = selector;
			// The alias stays; an effort the new model cannot run falls back to inherit.
			const effort = member.defaultEffort;
			if (typeof effort === "string" && !getSupportedEfforts(item.model).some(level => level === effort)) {
				delete member.defaultEffort;
				notice = `${item.model.id} does not support effort ${effort}; member ${assign.alias} now inherits`;
			}
			return true;
		});
		// A validator refusal outranks the hub's own note.
		if (notice !== undefined && this.#poolStatus?.tone !== "error") this.#poolNotice(notice);
		this.#browser.setQuery("");
		this.#setActiveEntry(assign.target.kind === "group" ? "groups" : "roles");
		this.#focus = "list";
		this.#landOnPoolMember(assign.target, landed);
	}

	/** Move the roles cursor to member `alias` of the pool at `target`; a missing member leaves it in place. */
	#landOnPoolMember(target: ModelHubPoolTarget, alias: string | null): void {
		const index = this.#rolesRows.findIndex(
			row =>
				row.kind === "poolMember" &&
				row.alias === alias &&
				row.target.kind === target.kind &&
				row.target.key === target.key,
		);
		if (index >= 0) this.#roleIndex = index;
	}

	/** Remove member `alias` with every `order` and profile entry naming it; the cursor stays on the nearest row. */
	#removePoolMember(target: ModelHubPoolTarget, alias: string): void {
		this.#editPool(target, draft => {
			const models = draftRecord(draft, "models");
			if (!Object.hasOwn(models, alias)) return false;
			delete models[alias];
			const order = draftOrder(draft);
			if (order) {
				const index = order.indexOf(alias);
				if (index >= 0) order.splice(index, 1);
			}
			if (isRecord(draft.profiles)) {
				for (const profile of Object.values(draft.profiles)) if (isRecord(profile)) delete profile[alias];
			}
			return true;
		});
		this.#roleIndex = Math.min(this.#roleIndex, Math.max(0, this.#rolesRows.length - 1));
	}

	/** Move member `alias` one slot in a priority or round-robin `order`; the cursor follows it. */
	#movePoolMember(target: ModelHubPoolTarget, alias: string, delta: -1 | 1): void {
		const moved = this.#editPool(target, draft => {
			const order = draftOrder(draft);
			const index = order?.indexOf(alias) ?? -1;
			const next = index + delta;
			if (!order || index < 0 || next < 0 || next >= order.length) return false;
			[order[index], order[next]] = [order[next]!, order[index]!];
			return true;
		});
		if (moved) this.#roleIndex += delta;
	}

	/** Whether the pool at `target` schedules members in an explicit order that `[`/`]` can change. */
	#poolOrdered(target: ModelHubPoolTarget): boolean {
		const strategy = poolTailStrategy(this.#pool(target));
		return strategy === "priority" || strategy === "round-robin";
	}

	/** Catalog entry whose supported efforts can be edited; undefined for unknown or non-reasoning models. */
	#poolMemberEffortItem(row: RolesRow | undefined): ModelBrowserItem | undefined {
		if (row?.kind !== "poolMember" || !this.#rowEditablePool(row)) return undefined;
		const member = this.#pool(row.target)?.members.find(entry => entry.alias === row.alias);
		const parsed = member ? parseModelString(member.model) : undefined;
		const item = parsed ? this.#findFallbackModel(parsed.provider, parsed.id) : undefined;
		return item && getSupportedEfforts(item.model).length > 0 ? item : undefined;
	}

	/**
	 * `t` on a member row opens its effort preference. A reference through a group
	 * profile edits that profile's override (inherit removes it), else its `defaultEffort` (inherit
	 * clears it).
	 */
	#openPoolEffortPrefs(row: RolesRow | undefined): void {
		if (row?.kind !== "poolMember") return;
		const source = this.#pool(row.target)?.source;
		if (source?.kind === "ref" && source.profile !== undefined) {
			this.#openProfilePrefs(source.group, source.profile);
			this.#prefs?.focus(`effort:${row.alias}`);
		} else this.#openRoutingMenu(row.target, `effort:${row.alias}`);
	}

	// ─── Routing editors ────────────────────────────────────────────────────

	#groupAction(label: string, apply: () => void): GroupAction {
		return { label: sanitizeDisplayLine(label), apply };
	}

	/** Open a group action sheet. Returns false when there are no actions. */
	#openGroupActions(title: string, chips: () => GroupAction[]): boolean {
		if (chips().length === 0) return false;
		const prefs = new HubPrefs(
			title,
			() =>
				chips().map((chip, index) => ({
					id: String(index),
					label: chip.label,
					control: { k: "action", label: chip.label, act: `pool:${index}` },
					apply: () => {
						chip.apply?.();
						if (this.#prefs === prefs) this.#prefs = undefined;
						return undefined;
					},
				})),
			() => {
				this.#prefs = undefined;
				this.#requestRender();
			},
			() => this.#requestRender(),
		);
		this.#prefs = prefs;
		return true;
	}

	/** Open a text preference prefilled with `value`; `submit` returns why the text was refused. */
	#openPoolTextPrefs(label: string, hint: string, value: string, submit: (value: string) => string | undefined): void {
		this.#prefs = new HubPrefs(
			label,
			() => [
				{
					id: "value",
					label: sanitizeDisplayLine(label),
					hint,
					control: { k: "text", value },
					apply: input => {
						const error = submit(String(input ?? ""));
						if (error === undefined) this.#prefs = undefined;
						return error;
					},
				},
			],
			() => {
				this.#prefs = undefined;
				this.#requestRender();
			},
			() => this.#requestRender(),
		);
		this.#prefs.startEditing("value");
	}

	#accountNames(): readonly string[] {
		try {
			return this.#settings.accountNames ?? [];
		} catch {
			return [];
		}
	}

	#modelGroupNames(): readonly string[] {
		try {
			return this.#settings.modelGroupNames ?? [];
		} catch {
			return [];
		}
	}

	#openRoutingMenu(target: ModelHubPoolTarget, focus?: string): void {
		const accounts = this.#accountNames();
		this.#prefs = new HubPrefs(
			`Pool ${target.key}`,
			() => this.#poolPrefsFields(target, accounts),
			() => {
				this.#prefs = undefined;
				this.#requestRender();
			},
			() => this.#requestRender(),
		);
		if (focus) this.#prefs.focus(focus);
	}

	#poolPrefsFields(target: ModelHubPoolTarget, accounts: readonly string[]): HubPrefsField[] {
		const pool = this.#pool(target);
		const raw = pool?.raw ?? pool?.effective ?? {};
		const routing = isRecord(raw.routing) ? raw.routing : {};
		const quota = isRecord(routing.quota) ? routing.quota : {};
		const cache = isRecord(routing.cache) ? routing.cache : {};
		const options = isRecord(raw.strategyOptions) ? raw.strategyOptions : {};
		const aliases = (pool?.members ?? []).map(member => member.alias);
		const disabled =
			pool?.readOnly ?? pool?.invalid ?? (!pool?.raw ? "Pool is not editable in this layer" : undefined);
		const rows: HubPrefsField[] = [];
		const add = (
			id: string,
			label: string,
			control: HubPrefsField["control"],
			mutate: (draft: Record<string, unknown>, value: HubPrefsValue) => void,
			hint?: string,
			initial?: string,
		) => {
			rows.push({
				id,
				label,
				control,
				hint,
				disabled,
				initial,
				apply: value => this.#editPoolFromField(target, draft => mutate(draft, value)),
			});
		};
		const strings = (value: unknown): string[] =>
			Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
		const multi = (
			values: readonly string[],
			choices: readonly string[],
			ordered = false,
		): HubPrefsField["control"] => ({
			k: "multi",
			values,
			options: [...new Set([...values, ...choices])].map(value => ({ value, label: value })),
			ordered,
		});
		const choice = (value: string, choices: readonly string[]): HubPrefsField["control"] => ({
			k: "choice",
			value,
			options: [...new Set([...choices, value])].map(value => ({ value, label: value || "inherit" })),
		});
		const number = (
			value: unknown,
			min: number,
			max?: number,
			step = 1,
			unit?: string,
		): HubPrefsField["control"] => ({
			k: "number",
			value: typeof value === "number" ? value : min,
			min,
			max,
			step,
			unit,
		});
		const set = (path: readonly string[], value: unknown, draft: Record<string, unknown>) => {
			let parent = draft;
			for (const [index, key] of path.slice(0, -1).entries()) {
				if (path[0] === "models" && index === 1 && typeof parent[key] === "string")
					parent[key] = { model: parent[key] };
				parent = draftRecord(parent, key);
			}
			const key = path[path.length - 1]!;
			if (value === null || value === "" || (Array.isArray(value) && value.length === 0)) delete parent[key];
			else parent[key] = value;
		};
		const numeric = (value: HubPrefsValue) => (value === null || value === "" ? null : Number(value));
		add(
			"strategy",
			"Strategies",
			multi(strategyNames(raw), POOL_STRATEGY_CYCLE, true),
			(draft, value) => {
				const names = strings(value);
				draft.strategy = names.length === 1 ? names[0] : names;
				const options = draftRecord(draft, "strategyOptions");
				if (names.includes("priority") || names.includes("round-robin")) options.order ??= aliases;
				else delete options.order;
				if (!names.includes("quota")) {
					delete options.tolerance;
					delete options.objective;
					delete options.capacityMetric;
				}
				if (!names.includes("least-used")) delete options.window;
				if (!names.includes("weighted-random")) {
					for (const member of Object.values(draftRecord(draft, "models")))
						if (isRecord(member)) delete member.weight;
				}
				if (Object.keys(options).length === 0) delete draft.strategyOptions;
			},
			"Ordered strategies; the pool validator checks allowed combinations",
		);
		add("order", "Member order", multi(strings(options.order), aliases, true), (draft, value) =>
			set(["strategyOptions", "order"], value, draft),
		);
		add(
			"tolerance",
			"Quota tolerance",
			number(options.tolerance, 0, 0.5, 0.01),
			(draft, value) => setQuotaTolerance(draft, numeric(value) ?? undefined),
			"(0, 0.5]; clear to inherit",
			options.tolerance === undefined ? "" : undefined,
		);
		add(
			"objective",
			"Quota objective",
			choice(typeof options.objective === "string" ? options.objective : "", ["", "balance"]),
			(draft, value) => set(["strategyOptions", "objective"], value, draft),
		);
		add(
			"capacityMetric",
			"Quota capacity metric",
			choice(typeof options.capacityMetric === "string" ? options.capacityMetric : "", ["", "fraction"]),
			(draft, value) => set(["strategyOptions", "capacityMetric"], value, draft),
		);
		const window = isRecord(options.window) ? options.window : {};
		add(
			"window",
			"Least-used window",
			number(window.durationMs, 1, 31536000000, 1000, "ms"),
			(draft, value) =>
				set(
					["strategyOptions", "window"],
					value === null || value === "" ? null : { type: "rolling", durationMs: Number(value) },
					draft,
				),
			"Rolling window; clear to inherit",
			window.durationMs === undefined ? "" : undefined,
		);
		const funding = isRecord(routing.funding) ? strings(routing.funding.order) : [...(pool?.funding ?? [])];
		add("funding", "Funding order", multi(funding, ["included", "free", "metered"], true), (draft, value) => {
			set(["routing", "funding", "order"], value, draft);
			if (!strings(value).includes("metered")) delete draftRecord(draft, "routing").spending;
			else if (!isRecord(draftRecord(draft, "routing").spending))
				draftRecord(draft, "routing").spending = { policy: "provider-managed" };
		});
		add(
			"spending",
			"Metered spending",
			choice(spendingPolicy(raw) ?? "off", ["off", "provider-managed", "local-hard-budget"]),
			(draft, value) => {
				if (value === "off") setMeteredSpending(draft, undefined);
				else if (value === "provider-managed") setMeteredSpending(draft, { policy: "provider-managed" });
				else {
					const parsed = parseBudgetSpec(formatBudgetSpec(raw));
					if ("spending" in parsed) setMeteredSpending(draft, parsed.spending);
					else set(["routing", "spending"], { policy: "local-hard-budget" }, draft);
				}
			},
			"Set a valid budget below to enable local-hard-budget",
		);
		rows.push({
			id: "budget",
			label: "Local hard budget",
			hint: BUDGET_SPEC_USAGE,
			disabled,
			control: { k: "text", value: formatBudgetSpec(raw) },
			apply: value => {
				const parsed = parseBudgetSpec(String(value ?? ""));
				return "error" in parsed
					? parsed.error
					: this.#editPoolFromField(target, draft => setMeteredSpending(draft, parsed.spending));
			},
		});
		add(
			"reserve",
			"Quota reserve",
			number(quota.reserveFraction, 0, 0.999999, 0.01, " fraction"),
			(draft, value) => set(["routing", "quota", "reserveFraction"], numeric(value), draft),
			"[0, 1); clear to inherit",
			quota.reserveFraction === undefined ? "" : undefined,
		);
		add(
			"maxAge",
			"Quota observation age",
			number(quota.maxObservationAgeMs, 1, undefined, 1000, "ms"),
			(draft, value) => set(["routing", "quota", "maxObservationAgeMs"], numeric(value), draft),
			"Clear to inherit",
			quota.maxObservationAgeMs === undefined ? "" : undefined,
		);
		add(
			"unknown",
			"Unknown quota",
			choice(typeof quota.unknown === "string" ? quota.unknown : "", ["", "allow", "exclude"]),
			(draft, value) => set(["routing", "quota", "unknown"], value, draft),
		);
		add("accounts.order", "Account order", multi(accountOrder(raw), accounts, true), (draft, value) =>
			set(["routing", "accounts", "order"], value, draft),
		);
		add("accounts.drain", "Drain account", choice(accountDrain(raw) ?? "", ["", ...accounts]), (draft, value) =>
			setAccountDrain(draft, value ? String(value) : undefined),
		);
		for (const field of ["spend", "returnWhen"] as const) {
			add(
				`accounts.${field}`,
				field === "spend" ? "Drain spend" : "Return when",
				multi(accountList(raw, field), field === "spend" ? POOL_DRAIN_SPEND : POOL_DRAIN_RETURN),
				(draft, value) => set(["routing", "accounts", field], value, draft),
			);
		}
		for (const field of ["affinity", "pricing"] as const) {
			add(`cache.${field}`, `Cache ${field}`, { k: "switch", on: cache[field] === true }, (draft, value) =>
				set(["routing", "cache", field], value, draft),
			);
		}
		for (const [index, limit] of poolLimitList(raw).entries()) {
			rows.push({
				id: `limit:${index}`,
				label: `Limit ${index + 1}`,
				disabled,
				control: { k: "text", value: this.#limitLabel(limit) },
				apply: value => {
					const parsed = this.#settings.parseLimitSpec?.(String(value ?? ""));
					if (!parsed) return "Limit parser is unavailable";
					if ("error" in parsed) return parsed.error;
					return this.#editPoolFromField(target, draft => {
						const limits = [...poolLimitList(draft)];
						limits[index] = parsed.limit;
						draftRecord(draft, "routing").limits = limits;
					});
				},
			});
			add(
				`limit:remove:${index}`,
				`Remove limit ${index + 1}`,
				{ k: "action", label: "Remove", act: `remove-limit:${index}` },
				draft => removePoolLimit(draft, index),
			);
		}
		rows.push({
			id: "limit:add",
			label: "Add limit",
			disabled: disabled ?? (!this.#settings.parseLimitSpec ? "Limit parser is unavailable" : undefined),
			hint: LIMIT_SPEC_HINT,
			control: { k: "text", value: "" },
			apply: value => {
				const parsed = this.#settings.parseLimitSpec?.(String(value ?? ""));
				if (!parsed) return "Limit parser is unavailable";
				return "error" in parsed
					? parsed.error
					: this.#editPoolFromField(target, draft => appendPoolLimit(draft, parsed.limit));
			},
		});
		for (const member of pool?.members ?? []) {
			add(
				`weight:${member.alias}`,
				`${member.alias} weight`,
				number(member.weight, 1, undefined, 1),
				(draft, value) => set(["models", member.alias, "weight"], numeric(value), draft),
				"Clear to inherit",
				member.weight === undefined ? "" : undefined,
			);
			const parsed = parseModelString(member.model);
			const item = parsed ? this.#findFallbackModel(parsed.provider, parsed.id) : undefined;
			add(
				`effort:${member.alias}`,
				`${member.alias} effort`,
				choice(member.effort ?? "", ["", ...(item ? getSupportedEfforts(item.model) : [])]),
				(draft, value) => set(["models", member.alias, "defaultEffort"], value, draft),
			);
		}
		return rows;
	}

	#limitLabel(limit: unknown): string {
		let label: string | undefined;
		try {
			label = this.#settings.formatLimit?.(limit);
		} catch {
			label = undefined;
		}
		return label ?? JSON.stringify(limit) ?? "limit";
	}

	// ─── Model groups ───────────────────────────────────────────────────────

	/** The entry `G` on `row` edits: a pool-capable role or a fallback chain the global layer supplies. */
	#groupEntry(row: RolesRow | undefined): ModelHubPoolTarget | undefined {
		if (!this.#callbacks.onPoolChange || !row) return undefined;
		let target: ModelHubPoolTarget;
		switch (row.kind) {
			case "role":
				if (!this.#settings.roleAcceptsPools?.(row.role)) return undefined;
				target = { kind: "role", key: row.role };
				break;
			case "chainKey":
			case "pool":
			case "fallback":
				target = { kind: "chain", key: row.role };
				break;
			case "poolMember":
				// A group's own members define it; pointing a group at another group is not a thing.
				if (row.target.kind === "group") return undefined;
				target = row.target;
				break;
			default:
				return undefined;
		}
		try {
			return this.#settings.poolWriteBlocker?.(target) === undefined ? target : undefined;
		} catch {
			return undefined;
		}
	}

	/** Config path of a role, chain or group entry. */
	#entryPath(target: ModelHubPoolTarget): string {
		const section =
			target.kind === "role" ? "modelRoles" : target.kind === "chain" ? "retry.fallbackChains" : "modelGroups";
		return `${section}.${target.key}`;
	}

	/**
	 * Actions of the `G` editor on `entry`: point it at each other model group; turn its inline pool into
	 * a new group; rename or delete the group it references.
	 */
	#groupActions(entry: ModelHubPoolTarget): GroupAction[] {
		const pool = this.#pool(entry);
		const current = pool?.source.kind === "ref" ? pool.source.group : undefined;
		const currentProfile = pool?.source.kind === "ref" ? pool.source.profile : undefined;
		// Every group, then each of its profiles; the reference the entry already holds is left out.
		const chips = this.#modelGroupNames().flatMap(name =>
			[undefined, ...this.#groupProfiles(name).map(entry => entry.name)]
				.filter(profile => name !== current || profile !== currentProfile)
				.map(profile =>
					this.#groupAction(`use +${name}${profile === undefined ? "" : `@${profile}`}`, () =>
						this.#writePool(entry, profile === undefined ? { use: name } : { use: name, profile }),
					),
				),
		);
		if (!this.#poolEditable(pool)) return chips;
		const raw = pool.raw;
		if (current === undefined) {
			chips.push(this.#groupAction("new group…", () => this.#openNewGroup(entry, raw)));
		} else {
			const profile = pool.source.kind === "ref" ? pool.source.profile : undefined;
			chips.push(
				this.#groupAction(`rename +${current}…`, () => this.#openRenameGroup(current, raw)),
				this.#groupAction(`delete +${current}`, () => this.#deleteGroup(entry, current, raw, profile)),
			);
		}
		return chips;
	}

	/** Whether `G` on `row` opens an editor with something to do. */
	#groupsAvailable(row: RolesRow | undefined): boolean {
		const entry = this.#groupEntry(row);
		return entry !== undefined && this.#groupActions(entry).length > 0;
	}

	/** `G`: the model-group editor of the entry `row` edits. */
	#openGroupPrefs(row: RolesRow | undefined): void {
		const entry = this.#groupEntry(row);
		if (entry) this.#openGroupActions(`Group of ${entry.key}`, () => this.#groupActions(entry));
	}

	/** Name a new `modelGroups` entry holding the inline pool `raw`, and point `entry` at it. */
	#openNewGroup(entry: ModelHubPoolTarget, raw: Readonly<Record<string, unknown>>): void {
		this.#openPoolTextPrefs("New group name:", NAME_HINT, "", value => {
			const name = value.trim();
			const refused = this.#nameRefusal("group", name);
			if (refused !== undefined) return refused;
			if (this.#modelGroupNames().includes(name)) return `modelGroups.${name} already exists`;
			const { profile, ...definition } = raw;
			const created = this.#savePool({ kind: "group", key: name }, definition);
			if (created !== undefined) return created;
			const pointed = this.#savePool(entry, typeof profile === "string" ? { use: name, profile } : { use: name });
			if (pointed !== undefined) this.#savePool({ kind: "group", key: name }, undefined);
			this.#refreshAfterMutation();
			return pointed;
		});
	}

	#openRenameGroup(from: string, raw: Readonly<Record<string, unknown>>): void {
		this.#openPoolTextPrefs(`Rename +${from} to:`, NAME_HINT, from, value =>
			this.#renameGroup(from, value.trim(), raw),
		);
	}

	/** Why `name` cannot name a group or profile: empty, too long, outside the grammar, or reserved. */
	#nameRefusal(what: "group" | "profile", name: string): string | undefined {
		if (name.length === 0) return `Enter a ${what} name`;
		if (name.length > MODEL_GROUP_NAME_MAX_LENGTH)
			return `A ${what} name has at most ${MODEL_GROUP_NAME_MAX_LENGTH} characters`;
		if (!MODEL_GROUP_NAME.test(name) || MODEL_GROUP_RESERVED_NAMES.includes(name)) {
			return `A ${what} name is lowercase letters, digits, - and _, starting with a letter or digit`;
		}
		return undefined;
	}

	/** Why the hub cannot edit `modelGroups.<group>` (its layer, its validation, or no writer); undefined when it can. */
	#groupEditRefusal(group: string): string | undefined {
		const pool = this.#pool({ kind: "group", key: group });
		if (this.#poolEditable(pool)) return undefined;
		if (!this.#callbacks.onPoolChange) return "group edits are not available here";
		if (pool?.invalid !== undefined) return `modelGroups.${group} is invalid; fix it in config`;
		return `modelGroups.${group} is ${pool?.readOnly ?? "not editable here"}`;
	}

	/**
	 * Rename a group and its writable references, including shadowed global references.
	 * Failed writes restore repointed references before removing the new definition.
	 */
	#renameGroup(from: string, to: string, raw: Readonly<Record<string, unknown>>): string | undefined {
		if (to === from) return undefined;
		const refused = this.#nameRefusal("group", to);
		if (refused !== undefined) return refused;
		if (this.#modelGroupNames().includes(to)) return `modelGroups.${to} already exists`;
		const references = this.#groupReferences(from);
		for (const reference of references) {
			const blocker = reference.global ? undefined : this.#settings.poolWriteBlocker?.(reference);
			if (blocker !== undefined) return `${this.#entryPath(reference)} uses +${from} and is ${blocker}`;
		}
		const created = this.#savePool({ kind: "group", key: to }, raw);
		if (created !== undefined) return created;
		const repointed: ModelHubGroupReference[] = [];
		const rollback = (failure: string): string => {
			const errors: string[] = [];
			for (const reference of repointed.toReversed()) {
				const error = this.#savePool(
					reference,
					reference.profile === undefined ? { use: from } : { use: from, profile: reference.profile },
				);
				if (error !== undefined) errors.push(error);
			}
			if (errors.length === 0) {
				const error = this.#savePool({ kind: "group", key: to }, undefined);
				if (error !== undefined) errors.push(error);
			}
			this.#refreshAfterMutation();
			return errors.length ? `${failure}; rollback failed: ${errors.join("; ")}` : failure;
		};
		for (const reference of references) {
			const profile = reference.profile;
			const error = this.#savePool(reference, profile === undefined ? { use: to } : { use: to, profile });
			if (error !== undefined) return rollback(error);
			repointed.push(reference);
		}
		const removed = this.#savePool({ kind: "group", key: from }, undefined);
		if (removed !== undefined) return rollback(removed);
		this.#refreshAfterMutation();
		const index = this.#rolesRows.findIndex(row => row.kind === "group" && row.role === to);
		if (index >= 0) this.#roleIndex = index;
		return removed;
	}

	/** References to `modelGroups.<name>`, memoized until the next rows rebuild. */
	#groupReferences(name: string): readonly ModelHubGroupReference[] {
		const cached = this.#referenceCache.get(name);
		if (cached) return cached;
		let references: readonly ModelHubGroupReference[];
		try {
			references = this.#settings.modelGroupReferences?.(name) ?? [];
		} catch {
			references = [];
		}
		this.#referenceCache.set(name, references);
		return references;
	}

	/**
	 * Delete `modelGroups.<name>`, which only `entry` references: `entry` keeps the pool as an inline
	 * copy of `raw` (with its `profile`). Declined while another entry references the group.
	 */
	#deleteGroup(
		entry: ModelHubPoolTarget,
		name: string,
		raw: Readonly<Record<string, unknown>>,
		profile: string | undefined,
	): void {
		const others = this.#groupReferences(name).filter(
			reference => reference.kind !== entry.kind || reference.key !== entry.key,
		);
		if (others.length > 0) {
			const users = others.map(reference => this.#entryPath(reference)).join(", ");
			this.#poolNotice(`+${name} is still used by ${users}; point those elsewhere first`);
			return;
		}
		if (!this.#writePool(entry, profile === undefined ? { ...raw } : { ...raw, profile })) return;
		this.#writePool({ kind: "group", key: name }, undefined);
	}

	/** Groups view `n`: name a new `modelGroups` entry, then browse the catalog for its first member. */
	#startNewGroup(): void {
		if (!this.#callbacks.onPoolChange) return;
		this.#openPoolTextPrefs("New group name:", NAME_HINT, "", value => {
			const name = value.trim();
			const refused = this.#nameRefusal("group", name);
			if (refused !== undefined) return refused;
			if (this.#modelGroupNames().includes(name)) return `modelGroups.${name} already exists`;
			const blocker = this.#settings.modelGroupWriteBlocker?.(name);
			if (blocker !== undefined) return `modelGroups.${name} is ${blocker}`;
			this.#assigning = { kind: "newGroup", name };
			this.#focus = "scope";
			this.#browser.setShowProvider(true);
			this.#setCandidateItems(this.#availableItems);
			this.#browser.setQuery("");
			return undefined;
		});
	}

	/** Write `modelGroups.<name>` as a priority group whose only member is the picked model, and land on it. */
	#commitNewGroup(item: ModelBrowserItem, name: string): void {
		const alias = uniquePoolAlias(item.selector, []);
		const written = this.#writePool(
			{ kind: "group", key: name },
			{ strategy: "priority", strategyOptions: { order: [alias] }, models: { [alias]: { model: item.selector } } },
		);
		this.#browser.setQuery("");
		this.#setActiveEntry("groups");
		this.#focus = "list";
		if (written) this.#landOnPoolMember({ kind: "group", key: name }, alias);
	}

	/** Groups view `x`: remove `modelGroups.<name>`; declined while an entry references it or another layer owns it. */
	#deleteUnusedGroup(name: string): void {
		const users = this.#referencePaths(this.#groupReferences(name));
		if (users !== undefined) {
			this.#poolNotice(`+${name} is used by ${users}; point those elsewhere first`);
			return;
		}
		const blocker = this.#settings.poolWriteBlocker?.({ kind: "group", key: name });
		if (blocker !== undefined || !this.#callbacks.onPoolChange) {
			this.#poolNotice(
				blocker !== undefined ? `modelGroups.${name} is ${blocker}` : "group edits are not available here",
			);
			return;
		}
		this.#writePool({ kind: "group", key: name }, undefined);
		this.#roleIndex = Math.min(this.#roleIndex, Math.max(0, this.#rolesRows.length - 1));
	}

	/** Groups view `R`: rename `modelGroups.<name>` and every entry that references it. */
	#startRenameGroup(name: string): void {
		const refused = this.#groupEditRefusal(name);
		const pool = this.#pool({ kind: "group", key: name });
		if (refused !== undefined || !this.#poolEditable(pool)) {
			this.#poolNotice(refused ?? `modelGroups.${name} is not editable here`);
			return;
		}
		this.#openRenameGroup(name, pool.raw);
	}

	/** The entries that reference `modelGroups.<name>`, as config paths; "unused" when none do. */
	#groupUsers(name: string): string {
		return this.#referencePaths(this.#groupReferences(name)) ?? "unused";
	}

	/** Distinct config paths of `references` as sanitized display text; undefined for none. */
	#referencePaths(references: readonly ModelHubPoolTarget[]): string | undefined {
		const paths = [...new Set(references.map(reference => this.#entryPath(reference)))];
		return paths.length > 0 ? sanitizeDisplayLine(paths.join(", ")) : undefined;
	}

	// ─── Group profiles ─────────────────────────────────────────────────────

	/** The entries whose own value references `modelGroups.<group>` through `profile`, shadowed global ones included. */
	#profileReferences(group: string, profile: string): ModelHubGroupReference[] {
		return this.#groupReferences(group).filter(reference => reference.profile === profile);
	}

	/** `group`'s profiles; empty when it defines none or is not a valid group. */
	#groupProfiles(group: string): readonly { name: string; efforts: Readonly<Record<string, string>> }[] {
		return this.#pool({ kind: "group", key: group })?.profiles ?? [];
	}

	#openProfilePrefs(group: string, profile: string): void {
		const target: ModelHubPoolTarget = { kind: "group", key: group };
		this.#prefs = new HubPrefs(
			`Profile @${profile} of +${group}`,
			() => {
				const pool = this.#pool(target);
				const efforts = pool?.profiles?.find(entry => entry.name === profile)?.efforts ?? {};
				return (pool?.members ?? []).map(member => {
					const parsed = parseModelString(member.model);
					const item = parsed ? this.#findFallbackModel(parsed.provider, parsed.id) : undefined;
					return {
						id: `effort:${member.alias}`,
						label: member.alias,
						disabled: pool?.readOnly ?? (!pool?.raw ? "Profile is not editable in this layer" : undefined),
						control: {
							k: "choice" as const,
							value: efforts[member.alias] ?? "",
							options: ["", ...(item ? getSupportedEfforts(item.model) : [])].map(value => ({
								value,
								label: value || "inherit",
							})),
						},
						apply: (value: HubPrefsValue) =>
							this.#editPoolFromField(target, draft => {
								const overrides = draftRecord(draftRecord(draft, "profiles"), profile);
								if (value === "" || value === null) delete overrides[member.alias];
								else overrides[member.alias] = { effort: value };
							}),
					};
				});
			},
			() => {
				this.#prefs = undefined;
				this.#requestRender();
			},
			() => this.#requestRender(),
		);
	}

	/** `@` in the Groups view: name a new, empty profile of `group` and land on it. */
	#startNewProfile(group: string): void {
		const target: ModelHubPoolTarget = { kind: "group", key: group };
		const refused = this.#groupEditRefusal(group);
		if (refused !== undefined) {
			this.#poolNotice(refused);
			return;
		}
		this.#openPoolTextPrefs(`New profile of +${group}:`, NAME_HINT, "", value => {
			const name = value.trim();
			const invalid = this.#nameRefusal("profile", name);
			if (invalid !== undefined) return invalid;
			if (this.#groupProfiles(group).some(entry => entry.name === name)) return `@${name} already exists`;
			const error = this.#editPoolFromField(target, draft => {
				draftRecord(draftRecord(draft, "profiles"), name);
			});
			if (error === undefined) this.#landOnProfile(group, name);
			return error;
		});
	}

	/**
	 * Rename a profile without leaving references to a missing profile.
	 * Shadowed global references are writable; failed writes restore earlier references.
	 */
	#startRenameProfile(group: string, profile: string): void {
		const target: ModelHubPoolTarget = { kind: "group", key: group };
		const refused = this.#groupEditRefusal(group);
		if (refused !== undefined) {
			this.#poolNotice(refused);
			return;
		}
		this.#openPoolTextPrefs(`Rename @${profile} of +${group} to:`, NAME_HINT, profile, value => {
			const to = value.trim();
			if (to === profile) return undefined;
			const invalid = this.#nameRefusal("profile", to);
			if (invalid !== undefined) return invalid;
			if (this.#groupProfiles(group).some(entry => entry.name === to)) return `@${to} already exists`;
			const references = this.#profileReferences(group, profile);
			for (const reference of references) {
				const blocker = reference.global ? undefined : this.#settings.poolWriteBlocker?.(reference);
				if (blocker !== undefined) {
					return `${this.#entryPath(reference)} uses +${group}@${profile} and is ${blocker}`;
				}
			}
			if (this.#groupProfiles(group).length >= 32 && references.length > 0) {
				return "Cannot safely rename a referenced profile at the 32-profile limit; remove a profile first";
			}
			if (this.#groupProfiles(group).length >= 32) {
				const error = this.#editPoolFromField(target, draft => {
					const profiles = draftRecord(draft, "profiles");
					profiles[to] = profiles[profile];
					delete profiles[profile];
				});
				if (error === undefined) this.#landOnProfile(group, to);
				return error;
			}
			const added = this.#editPoolFromField(target, draft => {
				const profiles = draftRecord(draft, "profiles");
				profiles[to] = structuredClone(draftRecord(profiles, profile));
			});
			if (added !== undefined) return added;
			const repointed: ModelHubGroupReference[] = [];
			const rollback = (failure: string): string => {
				const errors: string[] = [];
				for (const reference of repointed.toReversed()) {
					const error = this.#savePool(reference, { use: group, profile });
					if (error !== undefined) errors.push(error);
				}
				if (errors.length === 0) {
					const error = this.#editPoolFromField(target, draft => {
						delete draftRecord(draft, "profiles")[to];
					});
					if (error !== undefined) errors.push(error);
				}
				this.#refreshAfterMutation();
				return errors.length ? `${failure}; rollback failed: ${errors.join("; ")}` : failure;
			};
			for (const reference of references) {
				const error = this.#savePool(reference, { use: group, profile: to });
				if (error !== undefined) return rollback(error);
				repointed.push(reference);
			}
			const removed = this.#editPoolFromField(target, draft => {
				delete draftRecord(draft, "profiles")[profile];
			});
			if (removed !== undefined) return rollback(removed);
			if (removed === undefined) this.#landOnProfile(group, to);
			return removed;
		});
	}

	/**
	 * `x` on a profile row: remove it; declined while an entry references it (a shadowed global entry
	 * included) or another layer owns the group.
	 */
	#deleteProfile(group: string, profile: string): void {
		const users = this.#referencePaths(this.#profileReferences(group, profile));
		if (users !== undefined) {
			this.#poolNotice(`+${group}@${profile} is used by ${users}; point those elsewhere first`);
			return;
		}
		const refused = this.#groupEditRefusal(group);
		if (refused !== undefined) {
			this.#poolNotice(refused);
			return;
		}
		this.#editPool({ kind: "group", key: group }, draft => {
			const profiles = draftRecord(draft, "profiles");
			if (!Object.hasOwn(profiles, profile)) return false;
			delete profiles[profile];
			if (Object.keys(profiles).length === 0) delete draft.profiles;
			return true;
		});
		this.#roleIndex = Math.min(this.#roleIndex, Math.max(0, this.#rolesRows.length - 1));
	}

	/** Move the Groups cursor to profile `profile` of `group`; a missing row leaves it in place. */
	#landOnProfile(group: string, profile: string): void {
		const index = this.#rolesRows.findIndex(
			row => row.kind === "profile" && row.role === group && row.profile === profile,
		);
		if (index >= 0) this.#roleIndex = index;
	}

	/** A profile row's summary: each override as `alias effort`; "no overrides" when it sets none. */
	#profileSummary(group: string, profile: string): string {
		const efforts = this.#groupProfiles(group).find(entry => entry.name === profile)?.efforts ?? {};
		const parts = Object.entries(efforts).map(([alias, effort]) => `${alias} ${effort}`);
		return sanitizeDisplayLine(parts.length > 0 ? parts.join(" · ") : "no overrides");
	}

	// ─── Pool display ───────────────────────────────────────────────────────

	/** A pool's column cells: source and member count, funding order, strategy with routing badges. */
	#poolColumns(pool: ModelHubPool | undefined): { model: string; funding?: string; routing?: string } {
		if (!pool) return { model: "invalid pool · fix it in config" };
		if (pool.invalid !== undefined) return { model: sanitizeDisplayLine(`invalid pool · skipped · ${pool.invalid}`) };
		const source =
			pool.source.kind === "ref"
				? `pool +${pool.source.group}${pool.source.profile ? `@${pool.source.profile}` : ""}`
				: "pool";
		const count = pool.members.length;
		const badges = [
			pool.quota ? "quota" : undefined,
			pool.accounts ? "accounts" : undefined,
			pool.cache ? "cache" : undefined,
			pool.funding.includes("metered") || pool.spending ? "metered" : undefined,
			pool.limits ? "limits" : undefined,
		].filter(badge => badge !== undefined);
		const routing = [
			pool.strategy,
			badges.length > 0 ? badges.join(" ") : undefined,
			pool.readOnly ? `read-only: ${pool.readOnly}` : undefined,
		]
			.filter(part => part !== undefined && part.length > 0)
			.join(" · ");
		return {
			model: sanitizeDisplayLine(`${source} · ${count} model${count === 1 ? "" : "s"}`),
			...(pool.funding.length > 0 ? { funding: sanitizeDisplayLine(pool.funding.join(" → ")) } : {}),
			...(routing.length > 0 ? { routing: sanitizeDisplayLine(routing) } : {}),
		};
	}

	/** A pool's labelled facts: strategy, funding, group, spending, limits, quota, accounts, cache, read-only reason. */
	#poolFacts(pool: ModelHubPool): { key: string; value: string }[] {
		const facts = [
			{ key: "Strategy", value: pool.strategy || "—" },
			{ key: "Funding", value: pool.funding.length > 0 ? pool.funding.join(" → ") : "not configured" },
			pool.source.kind === "ref"
				? { key: "Group", value: `${pool.source.group}${pool.source.profile ? `@${pool.source.profile}` : ""}` }
				: undefined,
			pool.spending ? { key: "Spending", value: pool.spending } : undefined,
			pool.limits ? { key: "Limits", value: pool.limits } : undefined,
			pool.quota ? { key: "Quota", value: pool.quota } : undefined,
			pool.accounts ? { key: "Accounts", value: pool.accounts } : undefined,
			pool.cache ? { key: "Cache", value: pool.cache } : undefined,
			pool.readOnly ? { key: "Read-only", value: pool.readOnly } : undefined,
		];
		return facts
			.filter(fact => fact !== undefined)
			.map(fact => ({ key: fact.key, value: sanitizeDisplayLine(fact.value) }));
	}

	/** Column cells of a non-role Roles row (pool, pool member, fallback); undefined for other kinds. */
	#rolesRowCells(row: RolesRow): RolesRowCells | undefined {
		switch (row.kind) {
			case "profile": {
				const users = this.#referencePaths(this.#profileReferences(row.role, row.profile));
				return {
					thinking: this.#profileSummary(row.role, row.profile),
					routing: users !== undefined ? `used by ${users}` : "unused",
				};
			}
			case "pool":
			case "group": {
				const pool = row.kind === "pool" ? this.#chainPool(row.role) : this.#pool({ kind: "group", key: row.role });
				const columns = this.#poolColumns(pool);
				// A group defines members, so its Model cell is just the count.
				const model = row.kind === "group" ? columns.model.replace(/^pool · /, "") : columns.model;
				return { model, billing: columns.funding, routing: columns.routing };
			}
			case "poolMember": {
				const member = this.#poolMemberOf(row);
				if (!member) return {};
				const routing: string[] = [];
				if (member.weight !== undefined) routing.push(`weight ${member.weight}`);
				const parsed = parseModelString(member.model);
				if (!parsed || !this.#findFallbackModel(parsed.provider, parsed.id)) routing.push("not in catalog");
				const billing = this.#billing(member.model);
				return {
					model: sanitizeDisplayLine(member.model),
					...(member.effort ? { thinking: sanitizeDisplayLine(member.effort) } : {}),
					...(billing ? { billing } : {}),
					...(routing.length > 0 ? { routing: routing.join(" · ") } : {}),
				};
			}
			case "fallback": {
				const billing = this.#billing(row.selector);
				return { model: sanitizeDisplayLine(row.selector), ...(billing ? { billing } : {}) };
			}
			default:
				return undefined;
		}
	}

	/** Column cells of a role row. */
	#roleCells(role: string): RolesRowCells {
		const rolePool = this.#rolePool(role);
		if (rolePool) {
			const columns = this.#poolColumns(rolePool);
			return { model: columns.model, billing: columns.funding, routing: columns.routing };
		}
		const assignment = this.#roles[role];
		if (!assignment) return { model: "—" };
		const selector = `${assignment.model.provider}/${assignment.model.id}`;
		if (assignment.autoSelected) return { model: `auto → ${sanitizeDisplayLine(selector)}` };
		const billing = this.#billing(selector);
		return {
			model: sanitizeDisplayLine(selector),
			...(assignment.thinkingLevel !== ThinkingLevel.Inherit
				? { thinking: getConfiguredThinkingLevelMetadata(assignment.thinkingLevel).label }
				: {}),
			...(billing ? { billing } : {}),
		};
	}

	/**
	 * A Roles table row for the terminal: its plain name cell (a role's starts with two columns for
	 * its status dot) and its column cells, a configured thinking level led by its glyph. Undefined
	 * for separators, "new" rows and chain keys.
	 */
	#rolesTableRow(row: RolesRow): { name: string; cells: RolesRowCells } | undefined {
		switch (row.kind) {
			case "profile":
				return { name: `  · @${sanitizeDisplayLine(row.profile)}`, cells: this.#rolesRowCells(row) ?? {} };
			case "role": {
				const info = this.#settings.getRoleInfo(row.role);
				const cells = this.#roleCells(row.role);
				const assignment = this.#roles[row.role];
				const glyph = assignment ? thinkingLevelGlyph(assignment.thinkingLevel, theme) : "";
				return {
					name: `  ${sanitizeDisplayLine(info.tag ?? info.name ?? row.role)}`,
					cells: cells.thinking && glyph ? { ...cells, thinking: `${glyph} ${cells.thinking}` } : cells,
				};
			}
			case "group":
				return { name: `  +${sanitizeDisplayLine(row.role)}`, cells: this.#rolesRowCells(row) ?? {} };
			case "pool":
				return { name: "  ↳ fallback pool", cells: this.#rolesRowCells(row) ?? {} };
			case "fallback":
				return { name: `  ↳ fallback ${row.chainIndex + 1}`, cells: this.#rolesRowCells(row) ?? {} };
			case "poolMember":
				return {
					name: `${row.target.kind === "chain" ? "    • " : "  • "}${sanitizeDisplayLine(row.alias)}`,
					cells: this.#rolesRowCells(row) ?? {},
				};
			default:
				return undefined;
		}
	}

	#poolMemberOf(row: RolesRow): ModelHubPoolMember | undefined {
		if (row.kind !== "poolMember") return undefined;
		return this.#pool(row.target)?.members.find(member => member.alias === row.alias);
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Quick-switch cycle (ctrl+p) editing
	// ═══════════════════════════════════════════════════════════════════════

	#cycleOrder(): string[] {
		try {
			return [...this.#settings.cycleOrder];
		} catch {
			return [];
		}
	}

	/** Toggle `role`'s membership in the quick-switch cycle (appended at the end). */
	#toggleCycleMembership(role: string): void {
		const order = this.#cycleOrder();
		const index = order.indexOf(role);
		if (index >= 0) {
			order.splice(index, 1);
		} else {
			order.push(role);
		}
		this.#callbacks.onCycleOrderChange?.(order);
		this.#refreshAfterMutation();
	}

	/** Move `role` one slot earlier/later within the cycle order. */
	#moveCycleMembership(role: string, delta: -1 | 1): void {
		const order = this.#cycleOrder();
		const index = order.indexOf(role);
		const target = index + delta;
		if (index < 0 || target < 0 || target >= order.length) return;
		[order[index], order[target]] = [order[target], order[index]];
		this.#callbacks.onCycleOrderChange?.(order);
		this.#refreshAfterMutation();
	}

	/** Open the footer name input: a new custom role, or saving the current setup as a model preset. */
	#openNameStrip(purpose: "role" | "preset"): void {
		this.#strip = { kind: "name", purpose, input: new Input() };
	}

	/** The model a Roles row resolves to (assigned role or resolvable fallback), whose compaction point `k` edits. */
	#roleRowModel(): Model | undefined {
		const row = this.#rolesRows[this.#roleIndex];
		if (row?.kind === "role") return this.#roles[row.role]?.model;
		if (row?.kind === "fallback") return this.#resolveFallbackEntry(row.role, row.chainIndex)?.item.model;
		return undefined;
	}

	/** Open the footer input for the Roles row's model compaction point, prefilled with its own entry. */
	#openCompactionStrip(): void {
		if (!this.#callbacks.onCompactionPointChange) return;
		const model = this.#roleRowModel();
		if (!model) return;
		const input = new Input();
		input.setValue(this.#settings.compactionPointFor?.(model)?.draft ?? "");
		this.#strip = { kind: "name", purpose: "compaction", model, input };
	}

	/** Validate and commit the name strip: a new role, a preset name, or a compaction point. */
	#submitNameStrip(): void {
		const strip = this.#strip;
		if (strip?.kind !== "name") return;
		if (strip.purpose === "compaction") {
			const value = strip.input.getValue();
			const result = this.#callbacks.onCompactionPointChange?.(strip.model, value, compactionConfirmPending(strip));
			if (result?.kind === "error") {
				strip.error = result.message;
				strip.confirm = undefined;
				return;
			}
			if (result?.kind === "confirm") {
				strip.error = undefined;
				strip.confirm = { value, message: result.message };
				return;
			}
			this.#strip = null;
			this.#frame.chipRanges = [];
			this.#refreshAfterMutation();
			return;
		}
		if (strip.purpose === "preset") {
			this.#submitPresetName();
			return;
		}
		this.#submitRoleName();
	}

	/** Validate and commit the new-role name: jump straight into assigning it. */
	#submitRoleName(): void {
		const strip = this.#strip;
		if (strip?.kind !== "name" || strip.purpose !== "role") return;
		const name = strip.input.getValue().trim();
		if (!/^[a-zA-Z][\w-]*$/.test(name)) return;
		if (this.#visibleRoleIds().includes(name)) return;
		this.#strip = null;
		this.#frame.chipRanges = [];
		this.#startAssign(name);
	}

	/** Validate and commit the preset name: save the current setup under it (overwrites). */
	#submitPresetName(): void {
		const strip = this.#strip;
		if (strip?.kind !== "name" || strip.purpose !== "preset") return;
		const name = strip.input.getValue().trim();
		if (!/^[a-zA-Z][\w-]*$/.test(name)) return;
		this.#strip = null;
		this.#frame.chipRanges = [];
		this.#callbacks.onSavePreset?.(name);
		this.#refreshAfterMutation();
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Input
	// ═══════════════════════════════════════════════════════════════════════

	#moveModelKind(delta: -1 | 1): void {
		const current = MODEL_KIND_TABS.indexOf(this.#modelKindTab);
		const next = (Math.max(0, current) + delta + MODEL_KIND_TABS.length) % MODEL_KIND_TABS.length;
		this.#modelKindTab = MODEL_KIND_TABS[next] ?? "all";
		this.#applyModelKind();
	}

	#moveRoleTab(delta: -1 | 1): void {
		const current = ROLE_TABS.indexOf(this.#roleTab);
		const next = (Math.max(0, current) + delta + ROLE_TABS.length) % ROLE_TABS.length;
		this.#roleTab = ROLE_TABS[next] ?? "all";
		this.#roleIndex = 0;
		this.#roleScrollStart = 0;
		this.#buildRolesRows();
	}

	/** Saved presets and the one the setup matches; empty unless the host can both list and switch. */
	#presets(): { names: readonly string[]; active: string | undefined } {
		if (!this.#callbacks.onSwitchPreset || !this.#settings.getModelPresets) return { names: [], active: undefined };
		const revision = this.#settings.revision;
		if (this.#presetsMemo?.revision !== revision) {
			const { names, active } = this.#settings.getModelPresets();
			this.#presetsMemo = { revision, names, active };
		}
		return this.#presetsMemo;
	}

	/**
	 * The preset ctrl+←/→ steps from: the last one tried here while settings are
	 * unchanged since (a refused switch writes nothing, so the next press moves
	 * past it) or nothing matches; otherwise the preset the setup matches.
	 */
	#presetBase(active: string | undefined): string | undefined {
		const cursor = this.#presetCursor;
		if (cursor && (active === undefined || cursor.revision === this.#settings.revision)) return cursor.name;
		return active;
	}

	/** Apply the previous/next saved preset (wrapping), as `/modelpreset switch` does. */
	#switchPreset(delta: -1 | 1): void {
		const onSwitchPreset = this.#callbacks.onSwitchPreset;
		const { names, active } = this.#presets();
		if (!onSwitchPreset || names.length === 0) return;
		const base = this.#presetBase(active);
		const current = base === undefined ? -1 : names.indexOf(base);
		const next = current < 0 ? (delta > 0 ? 0 : names.length - 1) : (current + delta + names.length) % names.length;
		const name = names[next];
		if (name === undefined) return;
		const settle = () => {
			this.#presetCursor = { name, revision: this.#settings.revision };
			this.#refreshAfterMutation();
		};
		// Stepping onto the preset already in effect has nothing to apply.
		if (name === active) {
			settle();
			return;
		}
		// The host reports refusals itself, so the cursor moves once the switch
		// resolves, refused or not (`#presetBase` sees a refusal left the revision alone).
		this.#finishAssignment(onSwitchPreset(name), settle);
	}

	handleInput(data: string): void {
		this.#nativeVersion++;
		if (this.#assignmentPending) {
			if (matchesSelectCancel(data)) this.#callbacks.onCancel();
			return;
		}
		if (this.#roleConfirm) {
			if (matchesSelectCancel(data)) this.#roleConfirm = undefined;
			else if (matchesKey(data, "enter") || data === "\n" || extractPrintableText(data) === "x")
				this.#confirmRoleClear();
			return;
		}
		if (this.#prefs) {
			this.#prefs.handleInput(data);
			return;
		}
		if (data.startsWith("\x1b[<")) {
			routeSgrMouseInput(data, event => this.#routeMouseEvent(event));
			return;
		}

		if (this.#strip) {
			this.#handleStripInput(data);
			return;
		}

		if (matchesSelectCancel(data)) {
			this.#cancel();
			return;
		}

		const entry = this.#activeEntry();
		const rolesView = isRolesView(entry.kind) && this.#assigning === null;
		const lockedView = entry.kind === "provider" && entry.locked && this.#assigning === null;
		if (rolesView && (this.#roleSearching || extractPrintableText(data) === "/")) {
			this.#focus = "list";
			if (!this.#roleSearching) this.#roleSearching = true;
			else if (matchesKey(data, "enter") || data === "\n") this.#roleSearching = false;
			else if (matchesSelectUp(data) || matchesSelectDown(data)) {
				this.#roleIndex = this.#stepRoleIndex(this.#roleIndex, matchesSelectUp(data) ? -1 : 1);
			} else {
				this.#roleSearch.handleInput(data);
				this.#buildRolesRows();
			}
			return;
		}

		if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
			this.#focus = this.#focus === "scope" ? "list" : "scope";
			return;
		}
		if (matchesKey(data, "f5")) {
			if (entry.kind === "provider" && !entry.locked) {
				this.#scheduleProviderRefresh(entry.providerId ?? "", { force: true });
			}
			return;
		}
		// Ctrl+←/→ in the Roles view steps through saved model presets, wrapping.
		const rolesOnly = rolesView && entry.kind === "roles";
		if (rolesOnly && (matchesKey(data, "ctrl+left") || matchesKey(data, "ctrl+right"))) {
			this.#switchPreset(matchesKey(data, "ctrl+left") ? -1 : 1);
			return;
		}
		// Alt+←/→ cycles whichever tab strip is on screen: role tabs in the
		// Roles view, kind tabs in every browser view; the Groups view has none.
		// Ctrl+←/→ is unusable on macOS (Spaces shortcut). macOS terminals
		// (ghostty, Terminal.app, iTerm) send ESC b / ESC f for Option+←/→, which
		// parse as alt+b / alt+f — the same aliases the editor's word-motion bindings accept.
		if (matchesKey(data, "alt+left") || matchesKey(data, "alt+b")) {
			if (rolesOnly) this.#moveRoleTab(-1);
			else if (!rolesView) this.#moveModelKind(-1);
			return;
		}
		if (matchesKey(data, "alt+right") || matchesKey(data, "alt+f")) {
			if (rolesOnly) this.#moveRoleTab(1);
			else if (!rolesView) this.#moveModelKind(1);
			return;
		}

		// ←/→ are spatial pane switches: the sidebar sits left of the rows.
		// They never reach the search caret — fuzzy queries don't need one.
		if (matchesKey(data, "left")) {
			this.#focus = "scope";
			return;
		}
		if (matchesKey(data, "right")) {
			// Only views with rows can take list focus (not the locked pane).
			if (rolesView || this.#isBrowserView(entry)) {
				this.#focus = "list";
			}
			return;
		}

		// Arrow ownership: scope mode hops the sidebar; list mode navigates rows.
		if (this.#focus === "scope") {
			if (matchesSelectUp(data)) {
				this.#moveSidebar(-1);
				return;
			}
			if (matchesSelectDown(data)) {
				this.#moveSidebar(1);
				return;
			}
		}

		if (rolesView) {
			if (this.#focus === "scope" && extractPrintableText(data) !== undefined) {
				this.#setActiveEntry("all");
				this.#focus = "list";
				this.#browser.handleInput(data);
				return;
			}
			this.#handleRolesViewInput(data);
			return;
		}
		if (lockedView) {
			const printable = extractPrintableText(data);
			if (printable !== undefined && printable.trim().length > 0) {
				this.#setActiveEntry("all");
				this.#focus = "list";
				this.#browser.handleInput(data);
				return;
			}
			if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
				this.#requestLogin(entry);
			}
			return;
		}

		// Enter on the sidebar is a pane switch, like →: it lands on the model
		// rows instead of acting on a row the user cannot see is selected.
		if (this.#focus === "scope" && (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n")) {
			this.#focus = "list";
			return;
		}

		const beforeQuery = this.#browser.query;
		const isPrintable = extractPrintableText(data) !== undefined;
		this.#browser.handleInput(data);
		if (isPrintable || this.#browser.query !== beforeQuery) {
			this.#focus = "list";
		}
	}

	/** The cancel key's ladder: close a strip, leave assign mode, clear the query, then close the hub. */
	#cancel(): void {
		if (this.#roleConfirm) {
			this.#roleConfirm = undefined;
			return;
		}
		if (this.#assignmentPending) {
			this.#callbacks.onCancel();
			return;
		}
		if (this.#strip) {
			this.#closeStrip();
			return;
		}
		if (this.#assigning !== null) {
			this.#cancelAssign();
			return;
		}
		if (isRolesView(this.#activeEntry().kind) && (this.#roleSearching || this.#roleSearch.getValue())) {
			this.#roleSearching = false;
			this.#roleSearch.setValue("");
			this.#buildRolesRows();
			return;
		}
		if (this.#isBrowserView(this.#activeEntry()) && this.#browser.query.length > 0) {
			this.#browser.handleCancel();
			return;
		}
		this.#callbacks.onCancel();
	}

	#isBrowserView(entry: SidebarEntry): boolean {
		if (this.#assigning !== null) return true;
		return entry.kind === "recent" || entry.kind === "all" || (entry.kind === "provider" && !entry.locked);
	}

	#handleStripInput(data: string): void {
		const strip = this.#strip;
		if (!strip) return;
		if (matchesSelectCancel(data)) {
			this.#closeStrip();
			return;
		}
		if (strip.kind === "name") {
			if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
				this.#submitNameStrip();
				return;
			}
			strip.input.handleInput(data);
			if (strip.purpose === "compaction") strip.error = undefined;
			return;
		}
		if (moveStripSelection(strip, data)) return;
		if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
			this.#activateStripChip();
			return;
		}
	}

	#moveSidebar(delta: number): void {
		const count = this.#entries.length;
		if (count === 0) return;
		let index = this.#entries.findIndex(entry => entry.id === this.#activeEntryId);
		if (index < 0) index = 0;
		for (let step = 0; step < count; step++) {
			index = (index + delta + count) % count;
			const entry = this.#entries[index];
			if (entry && !this.#isHopSkipped(entry)) {
				// Scope changes keep an active assignment (scoping helps find the
				// model); landing on the Roles view cancels it.
				if (isRolesView(entry.kind)) this.#assigning = null;
				this.#setActiveEntry(entry.id);
				return;
			}
		}
	}

	/** Row count of the roles view (roles, their fallback entries, and the trailing "+ New role…" row). */
	get #rolesRowCount(): number {
		return this.#rolesRows.length;
	}

	/** Enter/click activation for a Roles-view row. */
	#activateRolesRow(row: RolesRow): void {
		switch (row.kind) {
			case "role": {
				// A valid pool gains a member; replacing it with one model is `x` then Enter. Any other
				// role, an invalid pool included, is assigned one model.
				const pool = this.#rolePool(row.role);
				if (pool && pool.invalid === undefined) {
					this.#startAssignPoolMember(row.role, { kind: "role", key: row.role }, null);
				} else this.#startAssign(row.role);
				return;
			}
			case "chainKey":
			case "pool":
				this.#startAssignFallback(row.role, null);
				return;
			case "group": {
				const refused = this.#groupEditRefusal(row.role);
				if (refused !== undefined) this.#poolNotice(refused);
				else this.#startAssignPoolMember(row.role, { kind: "group", key: row.role }, null);
				return;
			}
			case "newGroup":
				this.#startNewGroup();
				return;
			case "profile":
				this.#openProfilePrefs(row.role, row.profile);
				return;
			case "poolMember":
				this.#startAssignPoolMember(row.role, row.target, row.alias);
				return;
			case "fallback":
				this.#startAssignFallback(row.role, row.chainIndex);
				return;
			case "newFallback":
				this.#startAssignFallbackKey();
				return;
			case "newRole":
				this.#openNameStrip("role");
				return;
			case "separator":
				return;
		}
	}

	/** Scroll `#roleScrollStart` just enough to keep `#roleIndex` inside a window of `viewHeight` rows, clamped to the list. */
	#ensureRoleVisible(viewHeight: number, total: number): number {
		if (viewHeight <= 0) return 0;
		let start = this.#roleScrollStart;
		if (this.#roleIndex < start) start = this.#roleIndex;
		else if (this.#roleIndex >= start + viewHeight) start = this.#roleIndex - viewHeight + 1;
		return Math.max(0, Math.min(start, Math.max(0, total - viewHeight)));
	}

	/** Step the roles cursor by one row, skipping separator rows. Wraps at the ends unless `wrap: false` (then the cursor stays put). */
	#stepRoleIndex(from: number, delta: -1 | 1, options: { wrap?: boolean } = {}): number {
		const wrap = options.wrap ?? true;
		const count = this.#rolesRows.length;
		if (count === 0) return 0;
		let index = from;
		for (let i = 0; i < count; i++) {
			const next = index + delta;
			if (next < 0 || next >= count) {
				if (!wrap) return from;
				index = (next + count) % count;
			} else {
				index = next;
			}
			if (this.#rolesRows[index]?.kind !== "separator") return index;
		}
		return from;
	}

	#handleRolesViewInput(data: string): void {
		// Scope focus treats the roles view as a preview: Enter/Space dives
		// into the rows, everything else is inert (arrows already hop).
		if (this.#focus === "scope") {
			if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n" || matchesKey(data, "space")) {
				this.#focus = "list";
			}
			return;
		}
		if (matchesSelectUp(data)) {
			this.#poolStatus = undefined;
			this.#roleIndex = this.#stepRoleIndex(this.#roleIndex, -1);
			return;
		}
		if (matchesSelectDown(data)) {
			this.#poolStatus = undefined;
			this.#roleIndex = this.#stepRoleIndex(this.#roleIndex, 1);
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
			this.#runRolesAction("pick");
			return;
		}
		if (matchesKey(data, "backspace") || matchesKey(data, "delete")) {
			this.#runRolesAction("clear");
			return;
		}
		// Reordering: [ / shift+↑ moves the row earlier, ] / shift+↓ later —
		// cycle order on a role row, chain order on a fallback row.
		if (matchesKey(data, "shift+up")) {
			this.#runRolesAction("earlier");
			return;
		}
		if (matchesKey(data, "shift+down")) {
			this.#runRolesAction("later");
			return;
		}
		const printable = extractPrintableText(data);
		if (printable === "?" && this.#poolRowHints(this.#rolesRows[this.#roleIndex])) {
			const page = this.#poolHintPage?.index === this.#roleIndex ? this.#poolHintPage.page + 1 : 1;
			this.#poolHintPage = { index: this.#roleIndex, page };
			return;
		}
		if (printable !== undefined && Object.hasOwn(ROLES_ACTION_KEYS, printable)) {
			this.#runRolesAction(ROLES_ACTION_KEYS[printable]!);
		}
	}

	/** One Roles-view command on the selected row (keys and action-bar buttons share it). */
	#runRolesAction(action: RolesAction, confirmed = false): void {
		this.#poolStatus = undefined;
		const row = this.#rolesRows[this.#roleIndex];
		const role = row?.kind === "role" ? row.role : undefined;
		const editable = this.#rowEditablePool(row);
		const offered = this.#pickerActions(this.#activeEntry(), true, false).find(
			candidate => candidate.id === `roles:${action}`,
		);
		if (action === "clear" && !offered) return;
		if (offered?.disabled) {
			if (typeof offered.disabled === "string") this.#poolNotice(offered.disabled);
			return;
		}
		if (action === "clear" && row && !confirmed && offered?.danger) {
			const target =
				row.kind === "profile"
					? `profile +${row.role}@${row.profile}`
					: row.kind === "group"
						? `group +${row.role}`
						: row.kind === "poolMember"
							? `member ${row.alias} of ${row.role}`
							: row.kind === "fallback"
								? `fallback ${row.chainIndex + 1} of ${row.role}`
								: "role" in row
									? `${row.kind === "role" ? "role" : "fallback chain"} ${row.role}`
									: row.kind;
			this.#roleConfirm = {
				key: rolesRowKey(row, this.#roleIndex),
				view: this.#activeEntryId,
				text: `Remove ${sanitizeDisplayLine(target)}?`,
			};
			return;
		}
		switch (action) {
			case "pick":
				if (row) this.#activateRolesRow(row);
				return;
			case "clear":
				if (role && this.#rolePool(role)) this.#unassignPooledRole(role);
				else if (role) this.#unassignRole(role);
				else if (row?.kind === "fallback") this.#removeFallback(row);
				else if (row?.kind === "group") this.#deleteUnusedGroup(row.role);
				else if (row?.kind === "profile") this.#deleteProfile(row.role, row.profile);
				else if (row?.kind === "poolMember") {
					if (editable) this.#removePoolMember(row.target, row.alias);
				} else if (row?.kind === "pool" || (row?.kind === "chainKey" && this.#isPooledChain(row.role))) {
					if (this.#poolClearable({ kind: "chain", key: row.role })) {
						this.#writePool({ kind: "chain", key: row.role }, undefined);
					}
				} else if (row?.kind === "chainKey") this.#setFallbackChain(row.role, []);
				return;
			case "fallback":
				if (row?.kind === "newFallback") this.#startAssignFallbackKey();
				else if (row?.kind === "group") {
					const refused = this.#groupEditRefusal(row.role);
					if (refused !== undefined) this.#poolNotice(refused);
					else this.#startAssignPoolMember(row.role, { kind: "group", key: row.role }, null);
				} else if (row?.kind === "poolMember" && row.target.kind !== "role") {
					this.#startAssignPoolMember(row.role, row.target, null);
				} else if (
					row &&
					row.kind !== "newRole" &&
					row.kind !== "separator" &&
					row.kind !== "newGroup" &&
					row.kind !== "profile"
				) {
					this.#startAssignFallback(row.role, null);
				}
				return;
			case "cycle":
				if (role) this.#toggleCycleMembership(role);
				return;
			case "earlier":
			case "later": {
				const delta = action === "earlier" ? -1 : 1;
				if (role) this.#moveCycleMembership(role, delta);
				else if (row?.kind === "fallback") this.#moveFallback(row, delta);
				else if (row?.kind === "poolMember" && editable && this.#poolOrdered(row.target)) {
					this.#movePoolMember(row.target, row.alias, delta);
				}
				return;
			}
			case "pool":
				this.#convertToPool(row);
				return;
			case "strategy":
			case "funding":
			case "weight":
			case "affinity":
			case "pricing":
			case "quotaUnknown":
			case "reserve":
			case "routing":
				{
					const target = this.#rowPoolTarget(row);
					if (target)
						this.#openRoutingMenu(
							target,
							action === "quotaUnknown"
								? "unknown"
								: action === "affinity" || action === "pricing"
									? `cache.${action}`
									: action === "weight" && row?.kind === "poolMember"
										? `weight:${row.alias}`
										: action,
						);
				}
				return;
			case "groups":
				this.#openGroupPrefs(row);
				return;
			case "new":
				if (this.#activeEntryId === "groups") this.#startNewGroup();
				else this.#openNameStrip("role");
				return;
			case "rename":
				if (row?.kind === "group") this.#startRenameGroup(row.role);
				else if (row?.kind === "profile") this.#startRenameProfile(row.role, row.profile);
				return;
			case "newProfile": {
				const group =
					row?.kind === "group" || row?.kind === "profile"
						? row.role
						: row?.kind === "poolMember" && row.target.kind === "group"
							? row.target.key
							: undefined;
				if (group !== undefined) this.#startNewProfile(group);
				return;
			}
			case "save":
				if (this.#callbacks.onSavePreset && this.#activeEntryId === "roles") this.#openNameStrip("preset");
				return;
			case "nextPreset":
			case "prevPreset":
				// Presets hold role assignments; the Groups view has none to switch.
				if (this.#activeEntryId === "roles") this.#switchPreset(action === "nextPreset" ? 1 : -1);
				return;
			case "compaction":
				this.#openCompactionStrip();
				return;
			case "thinking":
				if (role) {
					const target = this.#roleThinkingTarget(role);
					if (target) this.#openThinkingStrip(target.item, role, true, target.scope);
				} else if (row?.kind === "fallback") {
					this.#openFallbackThinkingStrip(row);
				} else if (row?.kind === "poolMember") {
					this.#openPoolEffortPrefs(row);
				} else if (row?.kind === "profile") {
					this.#openProfilePrefs(row.role, row.profile);
				}
				return;
		}
	}

	#confirmRoleClear(): void {
		const pending = this.#roleConfirm;
		this.#roleConfirm = undefined;
		if (pending && "role" in pending) {
			if (this.#settings.modelRoleStorage === "project") this.#callbacks.onUnassign(pending.role, pending.scope);
			else this.#callbacks.onUnassign(pending.role);
			this.#closeStrip();
			this.#refreshAfterMutation();
			return;
		}
		const row = this.#rolesRows[this.#roleIndex];
		if (pending && row && pending.view === this.#activeEntryId && pending.key === rolesRowKey(row, this.#roleIndex)) {
			this.#runRolesAction("clear", true);
		}
	}

	#requestLogin(entry: SidebarEntry): void {
		if (!entry.providerId) return;
		if (entry.oauth) {
			this.#callbacks.onLoginRequest?.(entry.providerId);
		}
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Mouse
	// ═══════════════════════════════════════════════════════════════════════

	#routeMouseEvent(event: SgrMouseEvent): boolean {
		if (this.#assignmentPending) return true;
		const { footerColumn, bodyHeight, contentLine, overSidebar, overBody, bodyLine } = this.#frame.locate(
			event.row,
			event.col,
		);
		const entry = this.#activeEntry();

		// Footer strip chips (columns stay in frame coordinates).
		if (footerColumn !== undefined && this.#strip) {
			const strip = this.#strip;
			if (event.leftClick && strip.kind !== "name" && this.#frame.selectChipAt(strip, footerColumn)) {
				this.#activateStripChip();
			}
			return true;
		}

		if (event.wheel !== null) {
			if (overSidebar) {
				// Wheel pans the sidebar viewport; picking a scope is click/keys only.
				this.#frame.scrollSidebar(event.wheel, bodyHeight, this.#entries.length);
				this.#sidebarHover = this.#sidebarEntryIndexAt(contentLine);
			} else if (overBody) {
				if (isRolesView(entry.kind) && this.#assigning === null) {
					this.#roleIndex = this.#stepRoleIndex(this.#roleIndex, event.wheel > 0 ? 1 : -1, { wrap: false });
				} else if (this.#isBrowserView(entry) && bodyLine > 0) {
					this.#browser.routeMouse(event, bodyLine - 1);
				}
			}
			return true;
		}

		if (event.motion) {
			this.#sidebarHover = overSidebar ? this.#sidebarEntryIndexAt(contentLine) : null;
			if (overBody && isRolesView(entry.kind) && this.#assigning === null) {
				const roleLine = bodyLine - this.#rolesRowStart;
				this.#roleHover =
					roleLine >= 0 && roleLine < this.#rolesVisibleCount ? roleLine + this.#roleScrollStart : null;
			} else {
				this.#roleHover = null;
				if (overBody && this.#isBrowserView(entry) && bodyLine > 0) {
					this.#browser.routeMouse(event, bodyLine - 1);
				} else {
					// Pointer left the browser pane: without this, the last
					// hovered row keeps its band while the sidebar hovers too.
					this.#browser.clearHover();
				}
			}
			return true;
		}

		if (!event.leftClick) return true;

		if (overSidebar) {
			const index = this.#sidebarEntryIndexAt(contentLine);
			this.#clickSidebarEntry(index !== null ? this.#entries[index] : undefined);
			return true;
		}

		if (overBody) {
			if (isRolesView(entry.kind) && this.#assigning === null) {
				this.#focus = "list";
				const listLine = bodyLine - this.#rolesRowStart;
				if (listLine >= 0 && listLine < this.#rolesVisibleCount) {
					const roleLine = listLine + this.#roleScrollStart;
					const rowDef = this.#rolesRows[roleLine];
					if (rowDef && rowDef.kind !== "separator") {
						if (roleLine === this.#roleIndex) {
							this.#activateRolesRow(rowDef);
						} else {
							this.#roleIndex = roleLine;
						}
					}
				}
			} else if (entry.kind === "provider" && entry.locked && this.#assigning === null) {
				if (this.#lockedLoginLine !== null && bodyLine === this.#lockedLoginLine) {
					this.#requestLogin(entry);
				}
			} else if (this.#isBrowserView(entry) && bodyLine > 0) {
				this.#browser.routeMouse(event, bodyLine - 1);
			}
		}
		return true;
	}

	/** Pointer activation of a sidebar entry: pick the scope; a second click on a locked provider logs in. */
	#clickSidebarEntry(clicked: SidebarEntry | undefined): void {
		if (!clicked || clicked.kind === "separator") return;
		const already = clicked.id === this.#activeEntryId;
		if (isRolesView(clicked.kind)) this.#assigning = null;
		this.#setActiveEntry(clicked.id);
		// A click on Roles is a deliberate dive into the rows.
		if (isRolesView(clicked.kind)) this.#focus = "list";
		if (already && clicked.kind === "provider" && clicked.locked) {
			this.#requestLogin(clicked);
		}
	}

	/** Map a content-line index to a sidebar entry index (accounting for scroll). */
	#sidebarEntryIndexAt(contentLine: number): number | null {
		const index = this.#frame.sidebarScroll + contentLine;
		if (index < 0 || index >= this.#entries.length) return null;
		return index;
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Rendering
	// ═══════════════════════════════════════════════════════════════════════

	#renderSidebar(width: number, rows: number): string[] {
		const lines = this.#frame.renderSidebar(
			this.#entries,
			width,
			rows,
			{ id: this.#activeEntryId, focused: this.#focus === "scope", follow: this.#sidebarFollowActive, clamp: true },
			this.#sidebarStyle,
		);
		this.#sidebarFollowActive = false;
		return lines;
	}

	#sidebarStyle = (entry: SidebarEntry, index: number): SidebarStyle => {
		const searching = this.#searchCounts !== null;
		let matchCount: number | undefined;
		if (searching) {
			if (entry.kind === "provider" && !entry.locked) {
				matchCount = this.#searchCounts?.get(entry.providerId ?? "") ?? 0;
			} else if (entry.kind === "recent") {
				matchCount = this.#recentSearchCount;
			} else if (entry.kind === "all") {
				matchCount = this.#searchTotal;
			}
		}
		// Search-ineligible entries gray out, but keep their place in the viewport.
		const muted = entry.locked || matchCount === 0 || (searching && isRolesView(entry.kind));
		let icon: string;
		if (entry.kind === "recent") {
			icon = theme.icon.time;
		} else if (isRolesView(entry.kind)) {
			icon = theme.icon.extensionSkill;
		} else if (entry.kind === "all") {
			icon = theme.icon.model;
		} else {
			icon = muted ? theme.status.shadowed : theme.status.enabled;
		}
		const refreshing = entry.providerId ? this.#refreshingProviders.has(entry.providerId) : false;
		const annotationText = matchCount !== undefined ? String(matchCount) : (entry.annotation ?? "");
		return {
			icon: theme.fg(muted ? "dim" : entry.kind === "provider" ? "success" : "accent", icon),
			annotation: refreshing
				? theme.fg("warning", theme.spinnerFrames[this.#refreshSpinnerFrame % theme.spinnerFrames.length] ?? "")
				: theme.fg("dim", annotationText),
			muted,
			hovered: index === this.#sidebarHover,
			padTruncated: true,
		};
	};

	#renderModelKindTabs(width: number): string {
		const active = MODEL_KIND_TABS.indexOf(this.#modelKindTab);
		const track = renderSegmentTrack(
			MODEL_KIND_TABS.map(kind => ({ label: kind })),
			Math.max(0, active),
		);
		return truncateToWidth(
			` ${theme.fg("dim", "Kind:")} ${track}  ${theme.fg("dim", formatKeyHints(["alt+left", "alt+right"]))}`,
			width,
		);
	}

	#renderRoleTabs(width: number): string {
		const active = ROLE_TABS.indexOf(this.#roleTab);
		const track = renderSegmentTrack(
			ROLE_TABS.map(tab => ({ label: tab === "kind" ? "kinds" : tab })),
			Math.max(0, active),
		);
		const { names, active: activePreset } = this.#presets();
		const presetKeys = this.#roleSearching
			? formatKeyHints(["ctrl+left", "ctrl+right"])
			: `${formatKeyHints(["ctrl+left", "ctrl+right"])} · ${formatKeyHints(["p", "shift+p"])}`;
		const preset =
			names.length > 0
				? `   ${theme.fg("dim", "Preset:")} ${activePreset ? theme.fg("accent", activePreset) : theme.fg("muted", "custom")}  ${theme.fg("dim", presetKeys)}`
				: "";
		return truncateToWidth(
			` ${theme.fg("dim", "Roles:")} ${track}  ${theme.fg("dim", formatKeyHints(["alt+left", "alt+right"]))}${preset}`,
			width,
		);
	}

	#statusRow(width: number): string {
		if (this.#assignmentPending) {
			return truncateToWidth(theme.fg("accent", " Applying model…"), width);
		}
		if (this.#assigning !== null) {
			const enter = formatKeyHint("enter");
			const cancel = editorKey("tui.select.cancel");
			if (this.#assigning.kind === "fallbackKey") {
				return truncateToWidth(
					theme.fg("accent", ` New fallback chain — ${enter} picks the model it protects, ${cancel} cancels`),
					width,
				);
			}
			if (this.#assigning.kind === "newGroup") {
				const name = sanitizeDisplayLine(this.#assigning.name);
				return truncateToWidth(
					theme.fg("accent", ` New group +${name} — ${enter} picks its first model, ${cancel} cancels`),
					width,
				);
			}
			const label = this.#assignLabel(this.#assigning);
			if (this.#assigning.kind === "poolMember") {
				return truncateToWidth(
					theme.fg(
						"accent",
						` ${this.#poolAssignVerb(this.#assigning)} ${theme.bold(label)} — ${enter} picks the member model, ${cancel} cancels`,
					),
					width,
				);
			}
			if (this.#assigning.kind === "fallback") {
				const verb = this.#assigning.index === null ? "Adding fallback for" : "Replacing fallback of";
				return truncateToWidth(
					theme.fg(
						"accent",
						` ${verb} ${theme.bold(label)} — ${enter} picks the fallback model, ${cancel} cancels`,
					),
					width,
				);
			}
			return truncateToWidth(
				theme.fg("accent", ` Assigning ${theme.bold(label)} — ${enter} assigns, ${cancel} cancels`),
				width,
			);
		}
		const entry = this.#activeEntry();
		const scopedSuffix = this.#scopedModels.length > 0 ? " · --models scope" : "";
		let text: string;
		switch (entry.kind) {
			case "recent":
				text = `Recently used models${scopedSuffix}`;
				break;
			case "roles":
				text = `Model roles — ${formatKeyHint("f")} adds a retry fallback, cleared roles fall back to auto-selection`;
				break;
			case "groups":
				text = `Model groups — shared pools roles use as +name${this.#callbacks.onPoolChange ? `; ${formatKeyHint("n")} adds one` : ""}`;
				break;
			case "provider":
				if (entry.locked) {
					text = `${entry.label} · not configured`;
				} else if (entry.providerId && this.#refreshingProviders.has(entry.providerId)) {
					text = `${entry.label} · refreshing model list…`;
				} else {
					text = `${entry.label} · ${entry.annotation ?? "0"} models${scopedSuffix}`;
				}
				break;
			default:
				text = `All available models${scopedSuffix}`;
				break;
		}
		if (this.#configError && entry.kind !== "provider") {
			text = this.#configError;
			return truncateToWidth(theme.fg("error", ` ${text}`), width);
		}
		if (this.#poolStatus && isRolesView(entry.kind)) {
			return truncateToWidth(theme.fg(this.#poolStatus.tone, ` ${this.#poolStatus.text}`), width);
		}
		return truncateToWidth(theme.fg("muted", ` ${text}`), width);
	}

	/** Whether `x` may remove the whole entry at `target`: the global layer supplies it, so the removal takes effect. */
	#poolClearable(target: ModelHubPoolTarget): boolean {
		if (!this.#callbacks.onPoolChange && target.kind !== "role") return false;
		try {
			return this.#settings.poolWriteBlocker?.(target) === undefined;
		} catch {
			return false;
		}
	}

	/** Whether `f` on `role`'s rows can add to its fallbacks: a list chain always, a pool chain only when editable. */
	#fallbackAddable(role: string): boolean {
		return !this.#isPooledChain(role) || this.#poolEditable(this.#chainPool(role));
	}

	/**
	 * Key hints of a row that shows a pool (a pooled role, a chain pool summary or header, a member),
	 * listing only keys that act on it; undefined for any other row. Both footers render these.
	 */
	#poolRowHints(row: RolesRow | undefined): { label: string; keys: KeyName[] }[] | undefined {
		if (row?.kind === "newGroup")
			return this.#callbacks.onPoolChange ? [{ label: "new group", keys: ["enter"] }] : [];
		if (row?.kind === "profile") {
			if (this.#groupEditRefusal(row.role) !== undefined) return [];
			return [
				{ label: "edit efforts", keys: ["enter"] },
				{ label: "rename", keys: ["shift+r"] },
				{ label: "delete", keys: ["x"] },
				{ label: "new profile", keys: ["@"] },
			];
		}
		const target = this.#rowPoolTarget(row);
		if (!row || !target) return undefined;
		const editable = this.#rowEditablePool(row) !== undefined;
		const hints: ({ label: string; keys: KeyName[] } | false)[] = [];
		const routing = [
			...(editable
				? [
						{ label: "strategy", keys: ["g"] as KeyName[] },
						{ label: "funding", keys: ["o"] as KeyName[] },
						{ label: "routing", keys: ["e"] as KeyName[] },
						{ label: "cache affinity", keys: ["a"] as KeyName[] },
						{ label: "cache pricing", keys: ["h"] as KeyName[] },
						{ label: "quota unknown", keys: ["u"] as KeyName[] },
						{ label: "quota reserve", keys: ["r"] as KeyName[] },
					]
				: []),
			...(this.#groupsAvailable(row) ? [{ label: "group", keys: ["shift+g"] as KeyName[] }] : []),
		];
		if (row.kind === "group") {
			hints.push(
				editable && { label: "add member", keys: ["enter"] },
				editable && { label: "rename", keys: ["shift+r"] },
				this.#poolClearable(target) && { label: "delete", keys: ["x"] },
				this.#callbacks.onPoolChange !== undefined && { label: "new group", keys: ["n"] },
				editable && { label: "new profile", keys: ["@"] },
				...routing,
			);
		} else if (row.kind === "role") {
			hints.push(
				editable && { label: "add member", keys: ["enter"] },
				this.#rolePool(row.role)?.invalid !== undefined && { label: "replace", keys: ["enter"] },
				this.#fallbackAddable(row.role) && { label: "fallback", keys: ["f"] },
				this.#poolClearable(target) && { label: "clear", keys: ["x"] },
				...routing,
				{ label: "cycle", keys: ["c"] },
				{ label: "reorder", keys: ["[", "]"] },
				{ label: "new", keys: ["n"] },
				this.#callbacks.onSavePreset !== undefined && { label: "save preset", keys: ["s"] },
				this.#presets().names.length > 0 && { label: "preset", keys: ["p", "shift+p"] },
			);
		} else if (row.kind === "poolMember") {
			const pool = this.#pool(target);
			hints.push(
				editable && { label: "replace", keys: ["enter"] },
				target.kind !== "role" && editable && { label: "add member", keys: ["f"] },
				target.kind === "role" && this.#fallbackAddable(row.role) && { label: "fallback", keys: ["f"] },
				editable && { label: "remove", keys: ["x"] },
				this.#poolMemberEffortItem(row) !== undefined && { label: "effort", keys: ["t"] },
				editable && poolTailStrategy(pool) === "weighted-random" && { label: "weight", keys: ["w"] },
				editable && this.#poolOrdered(target) && { label: "reorder", keys: ["[", "]"] },
				...routing,
			);
		} else {
			hints.push(
				editable && { label: "add member", keys: ["enter", "f"] },
				this.#poolClearable(target) && { label: "clear chain", keys: ["x"] },
				...routing,
			);
		}
		return hints.filter(hint => hint !== false);
	}

	/** Status verb of a pool-member pick: which pool it adds to or which member it replaces. */
	#poolAssignVerb(assign: { target: ModelHubPoolTarget; alias: string | null }): string {
		const pool = assign.target.kind === "role" ? "pool" : assign.target.kind === "chain" ? "fallback pool" : "group";
		return assign.alias === null
			? `Adding a member to the ${pool} of`
			: `Replacing member ${sanitizeDisplayLine(assign.alias)} in the ${pool} of`;
	}

	/** Clamp a roles row to `width`; the bg band is reserved for mouse hover. */
	#finishRolesRow(line: string, width: number, hovered: boolean): string {
		let out = truncateToWidth(line, width);
		if (hovered) {
			const w = visibleWidth(out);
			if (w < width) out += " ".repeat(width - w);
			return theme.bg("selectedBg", out);
		}
		return out;
	}

	/**
	 * The Roles view's detail rows, at most `maxLines`: an open field's refusal or the pool status
	 * error in full, then the selected pool's facts, values wrapped under their column.
	 */
	#rolesDetail(width: number, maxLines: number): string[] {
		if (maxLines <= 0) return [];
		const lines: string[] = [];
		const error = this.#poolStatus?.tone === "error" ? this.#poolStatus.text : undefined;
		if (error !== undefined) {
			for (const line of wrapTextWithAnsi(error, Math.max(1, width - 2))) {
				lines.push(truncateToWidth(`  ${theme.fg("error", line)}`, width));
			}
		}
		const target = this.#rowPoolTarget(this.#rolesRows[this.#roleIndex]);
		const pool = target ? this.#pool(target) : undefined;
		if (pool && pool.invalid === undefined) {
			const facts = this.#poolFacts(pool);
			const keyWidth = Math.max(...facts.map(fact => visibleWidth(fact.key)));
			const valueWidth = Math.max(1, width - keyWidth - 4);
			for (const fact of facts) {
				wrapTextWithAnsi(fact.value, valueWidth).forEach((part, index) => {
					const key = index === 0 ? theme.fg("muted", fact.key.padEnd(keyWidth)) : " ".repeat(keyWidth);
					lines.push(truncateToWidth(`  ${key}  ${part}`, width));
				});
			}
		}
		if (lines.length <= maxLines) return lines;
		const kept = lines.slice(0, maxLines);
		kept[maxLines - 1] = truncateToWidth(`${kept[maxLines - 1]} …`, width);
		return kept;
	}

	#renderRolesView(width: number, rows: number): string[] {
		const lines: string[] = [];
		const groupsView = this.#activeEntryId === "groups";
		// The Groups view has no tab strip; its blank row keeps the rows where the role tabs leave them.
		lines.push(groupsView ? "" : this.#renderRoleTabs(width));
		if (this.#roleSearching || this.#roleSearch.getValue()) {
			lines.push(truncateToWidth(` Search: ${sanitizeDisplayLine(this.#roleSearch.getValue())}`, width));
		}
		if (!this.#rolesRows.length) {
			const empty = this.#roleSearch.getValue().trim() ? "No rows match your search." : "No rows in this view.";
			lines.push(theme.fg("dim", ` ${empty}`));
		}
		// First row's offset in bodyLine coordinates: the mouse router's
		// `bodyLine` has already dropped the status row, leaving the tabs row.
		this.#rolesRowStart = lines.length;

		// Aligned columns: name | model | thinking | billing | routing, with widths over every table
		// row so scrolling keeps the alignment; routing, then billing, then thinking drop when narrow.
		const tableRows = new Map<RolesRow, { name: string; cells: RolesRowCells }>();
		for (const rowDef of this.#rolesRows) {
			const table = this.#rolesTableRow(rowDef);
			if (table) tableRows.set(rowDef, table);
		}
		const nameWidth = Math.max(0, ...[...tableRows.values()].map(entry => visibleWidth(entry.name)));
		// The cycle badge is drawn only where it still fits, so it never costs a column.
		const columns = (["model", "thinking", "billing", "routing"] as const)
			.map(column => ({
				column,
				width: Math.max(0, ...[...tableRows.values()].map(entry => visibleWidth(entry.cells[column] ?? ""))),
			}))
			.filter(entry => entry.width > 0);
		const tableWidth = () => 3 + nameWidth + columns.reduce((sum, entry) => sum + 2 + entry.width, 0);
		while (columns.length > 1 && tableWidth() > width) columns.pop();

		const cycleOrder = this.#cycleOrder();
		const listFocused = this.#focus === "list";
		// Window the list around the cursor so entries past the panel height stay
		// reachable; the trailing indicator line steals one row when clipped.
		const total = this.#rolesRows.length;
		const detail = this.#rolesDetail(width, Math.floor(Math.max(0, rows - 2 - this.#rolesRowStart) / 2));
		const capacity = Math.max(0, rows - 2 - this.#rolesRowStart - detail.length);
		const overflow = total > capacity;
		const viewHeight = overflow ? Math.max(0, capacity - 1) : capacity;
		this.#roleScrollStart = this.#ensureRoleVisible(viewHeight, total);
		const endIndex = Math.min(this.#roleScrollStart + viewHeight, total);
		this.#rolesVisibleCount = Math.max(0, endIndex - this.#roleScrollStart);
		for (let i = this.#roleScrollStart; i < endIndex; i++) {
			const rowDef = this.#rolesRows[i];
			if (!rowDef) continue;
			const selected = i === this.#roleIndex;
			const hovered = i === this.#roleHover;
			// The unfocused pane draws no cursor; accent text still marks the row.
			const cursor = selected && listFocused ? theme.fg("accent", theme.nav.cursor) : " ";

			if (rowDef.kind === "separator") {
				lines.push(`   ${theme.fg("border", "─".repeat(Math.max(1, width - 6)))}`);
				continue;
			}

			if (rowDef.kind === "newRole" || rowDef.kind === "newFallback" || rowDef.kind === "newGroup") {
				const label =
					rowDef.kind === "newRole"
						? "+ New role…"
						: rowDef.kind === "newGroup"
							? "+ New group…"
							: "+ New fallback…";
				let line = ` ${cursor} ${theme.fg(selected ? "accent" : "dim", label)}`;
				line = this.#finishRolesRow(line, width, hovered);
				lines.push(line);
				continue;
			}

			if (rowDef.kind === "chainKey") {
				const key = sanitizeDisplayLine(rowDef.role);
				const slash = key.lastIndexOf("/");
				const tail = key.slice(slash + 1);
				const keyStyled = theme.fg("dim", key.slice(0, slash + 1)) + (selected ? theme.fg("accent", tail) : tail);
				let line = ` ${cursor} ${theme.fg("dim", theme.status.shadowed)} ${keyStyled}`;
				line = this.#finishRolesRow(line, width, hovered);
				lines.push(line);
				continue;
			}

			const table = tableRows.get(rowDef);
			if (!table) continue;
			const role = rowDef.kind === "role" ? rowDef.role : undefined;
			const assignment = role !== undefined ? this.#roles[role] : undefined;
			const pooled = rowDef.kind === "pool" || (role !== undefined && this.#rolePool(role) !== undefined);
			const single = role !== undefined && !pooled && assignment !== undefined && !assignment.autoSelected;
			const pad = (text: string, cellWidth: number) =>
				text + " ".repeat(Math.max(0, cellWidth - visibleWidth(text)));
			let line: string;
			if (role !== undefined) {
				const info = this.#settings.getRoleInfo(role);
				const color = pooled || single ? (info.color ?? "muted") : "dim";
				const dot = pooled || single ? theme.status.enabled : theme.status.shadowed;
				line = ` ${cursor} ${theme.fg(color, dot)} ${theme.fg(color, pad(table.name.slice(2), nameWidth - 2))}`;
			} else if (rowDef.kind === "group") {
				// A group some entry uses lights its dot; an unused one stays shadowed.
				const used = this.#groupReferences(rowDef.role).length > 0;
				const dot = used ? theme.status.enabled : theme.status.shadowed;
				line = ` ${cursor} ${theme.fg(used ? "accent" : "dim", dot)} ${theme.fg(selected || used ? "accent" : "muted", pad(table.name.slice(2), nameWidth - 2))}`;
			} else {
				const lead = table.name.length - table.name.trimStart().length + 2;
				line = ` ${cursor} ${theme.fg("dim", table.name.slice(0, lead))}${theme.fg(selected ? "accent" : "muted", pad(table.name.slice(lead), nameWidth - lead))}`;
			}
			for (const { column, width: cellWidth } of columns) {
				const padded = pad(table.cells[column] ?? "", cellWidth);
				let styled: string;
				if (column !== "model") styled = theme.fg("dim", padded);
				else if (single) {
					const slash = padded.indexOf("/");
					const id = padded.slice(slash + 1);
					styled = `${theme.fg("dim", padded.slice(0, slash + 1))}${selected ? theme.fg("accent", id) : id}`;
				} else if (selected) styled = theme.fg("accent", padded);
				else if (rowDef.kind === "poolMember") styled = padded;
				else styled = theme.fg(role !== undefined && !pooled ? "dim" : "muted", padded);
				line += `  ${styled}`;
			}
			line = line.trimEnd();
			const badges = this.#roleBadges(rowDef);
			if (badges.length) {
				const markers = ` [${badges.map(badge => badge.text).join(" · ")}]`;
				line = `${truncateToWidth(line, Math.max(1, width - visibleWidth(markers)))}${theme.fg("dim", markers)}`;
			}
			// Quick-cycle membership badge (`⟳ 2` = second stop of the ctrl+p cycle).
			const cycleIndex = role !== undefined ? cycleOrder.indexOf(role) : -1;
			if (cycleIndex >= 0) {
				const badge = theme.fg("accent", `${theme.icon.loop} ${cycleIndex + 1}`);
				const lineWidth = visibleWidth(line);
				const badgeWidth = visibleWidth(badge);
				if (lineWidth + badgeWidth + 2 <= width)
					line = `${line}${" ".repeat(width - lineWidth - badgeWidth - 1)}${badge}`;
			}
			lines.push(this.#finishRolesRow(line, width, hovered));
		}

		if (overflow) {
			const hiddenAbove = this.#roleScrollStart;
			const hiddenBelow = total - endIndex;
			const parts: string[] = [];
			if (hiddenAbove > 0) parts.push(`↑ ${hiddenAbove} more`);
			if (hiddenBelow > 0) parts.push(`↓ ${hiddenBelow} more`);
			lines.push(truncateToWidth(theme.fg("dim", `   ${parts.join("   ")}`), width));
		}

		// The selected pool's facts and the last refusal sit above the cycle row.
		while (lines.length < rows - 1 - detail.length) lines.push("");
		lines.push(...detail);
		// Live preview of the quick-switch cycle, rendered with the exact
		// segment track the ctrl+p status uses; the selected role's chip fills.
		while (lines.length < rows - 1) lines.push("");
		if (rows >= 2 && !groupsView) {
			const cycleKey = editorKey("app.model.cycleForward") || formatKeyHint("ctrl+p");
			if (cycleOrder.length > 0) {
				const selectedRow = this.#rolesRows[this.#roleIndex];
				const selectedRole =
					selectedRow && "role" in selectedRow && selectedRow.kind !== "chainKey" ? selectedRow.role : "";
				const activeIndex = cycleOrder.indexOf(selectedRole);
				const track = renderSegmentTrack(
					cycleOrder.map(role => ({ label: sanitizeDisplayLine(role) })),
					activeIndex,
				);
				lines[rows - 1] = truncateToWidth(`  ${theme.fg("dim", `${cycleKey} cycle:`)} ${track}`, width);
			} else {
				lines[rows - 1] = truncateToWidth(
					theme.fg("dim", `  ${cycleKey} cycle is empty — press ${formatKeyHint("c")} on a role to add it`),
					width,
				);
			}
		}
		return lines;
	}

	#renderLockedView(entry: SidebarEntry, width: number, rows: number): string[] {
		const lines: string[] = [];
		this.#lockedLoginLine = null;
		lines.push("");
		lines.push(truncateToWidth(theme.fg("warning", `  ${entry.label} has no credentials configured`), width));
		lines.push("");
		const envVars = entry.providerId ? (providerEntry(entry.providerId)?.envVars ?? []) : [];
		if (envVars.length > 0) {
			lines.push(
				truncateToWidth(
					theme.fg("muted", `  Set ${envVars.join(" or ")} in your environment, or add a key in config.`),
					width,
				),
			);
		} else {
			lines.push(truncateToWidth(theme.fg("muted", "  Add an API key for this provider in config."), width));
		}
		if (entry.oauth) {
			this.#lockedLoginLine = lines.length + 1; // +1 for the status row offset handled by caller
			lines.push(
				truncateToWidth(
					theme.fg("accent", `  ${theme.nav.cursor} Log in with OAuth (${formatKeyHint("enter")})`),
					width,
				),
			);
		}
		lines.push("");
		const catalogCount = entry.catalogCount ?? 0;
		if (catalogCount > 0) {
			lines.push(truncateToWidth(theme.fg("dim", `  ${catalogCount} models in catalog:`), width));
			const preview = this.#scopedModels.length > 0 ? [] : this.#registry.getAll("all");
			for (const model of preview) {
				if (model.provider !== entry.providerId) continue;
				if (lines.length >= rows) break;
				lines.push(truncateToWidth(theme.fg("dim", `    ${model.id}`), width));
			}
		}
		while (lines.length < rows) lines.push("");
		return lines.slice(0, rows);
	}

	#footerHint(width: number): string {
		const page = this.#poolHintPage?.index === this.#roleIndex ? this.#poolHintPage.page : 0;
		return pagedHints(
			this.#footerHints().flatMap(hint =>
				hint ? [`${hint.keys.length ? `${formatKeyHints(hint.keys)} ` : ""}${hint.label}`] : [],
			),
			width,
			page,
		);
	}

	#renderFooter(width: number): string {
		const strip = this.#strip;
		if (this.#roleConfirm) {
			return truncateToWidth(
				`${this.#roleConfirm.text} · ${formatKeyHint("enter")} confirm · ${editorKey("tui.select.cancel")} cancel`,
				width,
			);
		}
		return this.#frame.renderFooter(
			width,
			this.#footerHint(width),
			strip ? () => this.#renderStrip(width, strip) : undefined,
		);
	}

	#renderStrip(width: number, strip: StripState): string {
		if (strip.kind === "name") {
			const labelText =
				strip.purpose === "compaction"
					? `${strip.model.id} limit:`
					: strip.purpose === "preset"
						? "Preset name:"
						: "New role name:";
			const label = theme.fg("accent", labelText);
			// A compaction point is at most a few characters (`1500k`, `12.5%`); a
			// narrow field leaves the row for its notice.
			const maxInputWidth = strip.purpose === "compaction" ? 10 : 32;
			const inputWidth = Math.max(8, Math.min(maxInputWidth, width - visibleWidth(labelText) - 24));
			const inputLine = strip.input.render(inputWidth)[0] ?? "";
			let hint: string;
			if (strip.purpose === "compaction") {
				const notice = compactionNotice(strip, this.#callbacks.previewCompactionPoint);
				hint = theme.fg(notice.style, notice.text);
			} else {
				hint = theme.fg("dim", "(letters, digits, - and _)");
			}
			return truncateToWidth(`${label} ${inputLine} ${hint}`, width);
		}

		let prefix: string;
		if (strip.kind === "role")
			prefix = `${theme.fg("accent", sanitizeDisplayLine(strip.item.id))}${theme.fg("dim", " →")} `;
		else {
			const info = this.#settings.getRoleInfo(strip.role ?? "");
			prefix = `${theme.fg(info.color ?? "muted", sanitizeDisplayLine(info.tag ?? strip.role ?? "").toLowerCase())}${theme.fg("dim", ` · ${sanitizeDisplayLine(strip.item.id)} →`)} `;
		}

		// Horizontal window: once the strip overflows, drop leading chips behind
		// a dim ellipsis so the selected chip (plus one chip of lookahead when it
		// fits) stays visible while cycling right.
		const prefixWidth = visibleWidth(prefix);
		const available = Math.max(1, width - prefixWidth);
		const chipWidths = strip.chips.map(
			(chip, i) => visibleWidth(` ${chip.styled} `) + (i === strip.index ? 2 : 0) + 1,
		);
		// Smallest start index whose window [start..target] (with its "… " lead-in
		// when start > 0) fits in the available width; `target` itself may still
		// overflow when a single chip is wider than the row.
		const startFor = (target: number): number => {
			let start = 0;
			while (start < target) {
				let sum = start > 0 ? 2 : 0;
				for (let i = start; i <= target; i++) sum += chipWidths[i] ?? 0;
				if (sum <= available) break;
				start++;
			}
			return start;
		};
		let start = startFor(Math.min(strip.index + 1, strip.chips.length - 1));
		if (start > strip.index) start = startFor(strip.index);

		return this.#frame.renderChips(width, prefix, strip, start);
	}

	render(width: number): readonly string[] {
		if (this.#prefs) return this.#prefs.render(width);
		const height = Math.max(16, this.#tui.terminal?.rows || process.stdout.rows || 40);
		return this.#frame.render(width, height, this.#entries, this.#renderFooter(width - 4));
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Native (TSP) description
	// ═══════════════════════════════════════════════════════════════════════

	/** A `picker` is its own sheet: the backend mounts it in `layer` without an `overlay` wrapper. */
	nativeSheet(cx: DescribeContext): boolean {
		return cx.supports("picker");
	}

	describe(cx: DescribeContext): NativeNode {
		if (this.#prefs) return this.#prefs.describe(cx);
		const usePicker = cx.supports("picker");
		const cached = this.#nativeCache;
		const billing = this.#settings.billingRevision;
		if (cached?.version === this.#nativeVersion && cached.picker === usePicker && cached.billing === billing) {
			return cached.node;
		}
		if (usePicker) {
			const pickerNode = this.#describePicker();
			const described = pickerNode;
			this.#nativeCache = { version: this.#nativeVersion, picker: true, billing, node: described };
			return described;
		}
		const footer: NativeChild[] = [];
		if (this.#roleConfirm) footer.push(text([span(this.#roleConfirm.text, "warning")]));
		const strip = this.#describeStrip();
		if (strip) footer.push(strip);
		footer.push(hintsRow(this.#footerHints()));
		const described = describeHubFrame(
			"omp.overlay.model-hub",
			"Models",
			describeHubSidebar(this.#entries, this.#activeEntryId, this.#nativeSidebarStyle, "scopes"),
			this.#describeBody(),
			node("col", { gap: "xs" }, footer, "footer"),
		);
		this.#nativeCache = { version: this.#nativeVersion, picker: false, billing, node: described };
		return described;
	}

	handleNativeEvent(event: NativeUiEvent): void {
		if (this.#prefs) {
			this.#prefs.handleNativeEvent(event);
			return;
		}
		const picked = pickerEvent(event);
		if (picked) {
			this.#handlePickerEvent(picked);
			this.#requestRender();
			return;
		}
		// Same gate as the mouse router: nothing is interactive while an assignment applies.
		if (this.#assignmentPending) return;
		const target = event.key.slice(event.key.lastIndexOf("/") + 1);
		if (event.type === "action") {
			const entry = this.#activeEntry();
			if (target !== "login" || event.act !== "login") return;
			if (entry.kind !== "provider" || !entry.locked || this.#assigning !== null) return;
			this.#requestLogin(entry);
		} else if (event.type === "select" || event.type === "activate") {
			switch (target) {
				case "scopes":
					this.#clickSidebarEntry(this.#entries.find(entry => entry.id === event.item));
					break;
				case "roles": {
					if (!isRolesView(this.#activeEntry().kind) || this.#assigning !== null) return;
					const index = this.#rolesRows.findIndex((rowDef, i) => rolesRowKey(rowDef, i) === event.item);
					const rowDef = this.#rolesRows[index];
					if (!rowDef || rowDef.kind === "separator") return;
					this.#focus = "list";
					this.#roleIndex = index;
					this.#activateRolesRow(rowDef);
					break;
				}
				case "roleTabs": {
					if (this.#activeEntryId === "groups") return;
					const tab = ROLE_TABS.find(candidate => candidate === event.item);
					if (!tab) return;
					this.#roleTab = tab;
					this.#roleIndex = 0;
					this.#roleScrollStart = 0;
					this.#buildRolesRows();
					break;
				}
				case "kinds": {
					const kind = MODEL_KIND_TABS.find(candidate => candidate === event.item);
					if (!kind) return;
					this.#modelKindTab = kind;
					this.#applyModelKind();
					break;
				}
				case "strip": {
					// A chip click picks and applies it, like the footer mouse path.
					const strip = this.#strip;
					const index = Number(event.item);
					if (!strip || strip.kind === "name") return;
					if (!Number.isInteger(index) || !strip.chips[index]) return;
					strip.index = index;
					this.#activateStripChip();
					break;
				}
				default:
					return;
			}
		} else {
			return;
		}
		this.#requestRender();
	}

	/** Sidebar decoration for the native list: refreshing providers show an ellipsis, the status row spins. */
	#nativeSidebarStyle = (entry: SidebarEntry, index: number): Pick<SidebarStyle, "icon" | "annotation" | "muted"> => {
		const style = this.#sidebarStyle(entry, index);
		const refreshing = entry.providerId !== undefined && this.#refreshingProviders.has(entry.providerId);
		return { ...style, annotation: refreshing ? "…" : plainText(style.annotation) };
	};

	#describeBody(): NativeNode {
		const children: NativeChild[] = [this.#describeStatus()];
		const entry = this.#activeEntry();
		if (isRolesView(entry.kind) && this.#assigning === null) {
			children.push(...this.#describeRolesView());
		} else if (entry.kind === "provider" && entry.locked && this.#assigning === null) {
			children.push(this.#describeLockedView(entry));
		} else {
			children.push(
				node(
					"row",
					{ gap: "sm", align: "center" },
					[
						text([span("Kind:", "dim")]),
						node(
							"tabs",
							{ items: MODEL_KIND_TABS.map(kind => ({ id: kind, label: kind })), active: this.#modelKindTab },
							undefined,
							"kinds",
						),
					],
					"kindTabs",
				),
				this.#browser,
			);
		}
		// Zero basis: the body takes the space left of the sidebar instead of sizing to its widest line.
		return node("col", { gap: "sm", grow: 1, basis: 0, min: { w: 0 } }, children, "body");
	}

	#describeStatus(): NativeNode {
		if (this.#assignmentPending) {
			return node("spinner", { label: [span("Applying model…", "accent")] }, undefined, "status");
		}
		let spans: TspSpan[];
		const assigning = this.#assigning;
		if (assigning !== null) {
			if (assigning.kind === "fallbackKey") {
				spans = [span("New fallback chain — pick the model it protects", "accent")];
			} else if (assigning.kind === "newGroup") {
				spans = [span(`New group +${assigning.name} — pick its first model`, "accent")];
			} else {
				const label = this.#assignLabel(assigning);
				const verb =
					assigning.kind === "role"
						? "Assigning"
						: assigning.kind === "poolMember"
							? this.#poolAssignVerb(assigning)
							: assigning.index === null
								? "Adding fallback for"
								: "Replacing fallback of";
				spans = [span(`${verb} `, "accent"), span(label, "accent strong")];
			}
			return node("text", { spans, truncate: "end" }, undefined, "status");
		}
		const entry = this.#activeEntry();
		if (this.#configError && entry.kind !== "provider") {
			return node("text", { spans: [span(this.#configError, "error")], wrap: "word" }, undefined, "status");
		}
		if (this.#poolStatus && isRolesView(entry.kind)) {
			return node(
				"text",
				{ spans: [span(this.#poolStatus.text, this.#poolStatus.tone)], wrap: "word" },
				undefined,
				"status",
			);
		}
		const scopedSuffix = this.#scopedModels.length > 0 ? " · --models scope" : "";
		switch (entry.kind) {
			case "recent":
				spans = [span(`Recently used models${scopedSuffix}`, "muted")];
				break;
			case "roles":
				spans = [
					span("Model roles — ", "muted"),
					span("f", "key"),
					span(" adds a retry fallback, cleared roles fall back to auto-selection", "muted"),
				];
				break;
			case "groups":
				spans = [
					span("Model groups — shared pools roles use as +name; ", "muted"),
					span("n", "key"),
					span(" adds one", "muted"),
				];
				break;
			case "provider":
				if (entry.locked) {
					spans = [span(`${entry.label} · not configured`, "muted")];
				} else if (entry.providerId && this.#refreshingProviders.has(entry.providerId)) {
					return node(
						"spinner",
						{ label: [span(`${entry.label} · refreshing model list…`, "muted")] },
						undefined,
						"status",
					);
				} else {
					spans = [span(`${entry.label} · ${entry.annotation ?? "0"} models${scopedSuffix}`, "muted")];
				}
				break;
			default:
				spans = [span(`All available models${scopedSuffix}`, "muted")];
				break;
		}
		return node("text", { spans, truncate: "end" }, undefined, "status");
	}

	#describeRolesView(): NativeNode[] {
		const tabs = node(
			"row",
			{ gap: "sm", align: "center" },
			[
				text([span("Roles:", "dim")]),
				node(
					"tabs",
					{
						items: ROLE_TABS.map(tab => ({ id: tab, label: tab === "kind" ? "kinds" : tab })),
						active: this.#roleTab,
					},
					undefined,
					"roleTabs",
				),
			],
			"roleTabsRow",
		);
		const cycleOrder = this.#cycleOrder();
		const items = this.#rolesRows.map((rowDef, index) => this.#describeRolesRow(rowDef, index, cycleOrder));
		const selectedRow = this.#rolesRows[this.#roleIndex];
		const list = node(
			"list",
			{
				selected: selectedRow ? rolesRowKey(selectedRow, this.#roleIndex) : null,
				virtual: true,
				grow: 1,
				tone: this.#focus === "list" ? "accent" : undefined,
				aria: "Roles",
			},
			items,
			"roles",
		);
		if (this.#activeEntryId === "groups") return [list];
		return [tabs, list, this.#describeCycle(cycleOrder)];
	}

	#describeRolesRow(rowDef: RolesRow, index: number, cycleOrder: readonly string[]): NativeNode {
		const key = rolesRowKey(rowDef, index);
		switch (rowDef.kind) {
			case "separator":
				return node("rule", undefined, undefined, key);
			case "newRole":
				return node("item", { label: [span("+ New role…", "dim")] }, undefined, key);
			case "newFallback":
				return node("item", { label: [span("+ New fallback…", "dim")] }, undefined, key);
			case "newGroup":
				return node("item", { label: [span("+ New group…", "dim")] }, undefined, key);
			case "profile":
				return node(
					"item",
					{
						label: [span("    @", "dim"), span(sanitizeDisplayLine(rowDef.profile), "muted")],
						value: rolesCellValue(this.#rolesRowCells(rowDef) ?? {}),
					},
					undefined,
					key,
				);
			case "group": {
				const cells = this.#rolesRowCells(rowDef) ?? {};
				const used = this.#groupReferences(rowDef.role).length > 0;
				return node(
					"item",
					{
						label: [
							span(`${used ? theme.status.enabled : theme.status.shadowed} `, used ? "accent" : "dim"),
							span(`+${sanitizeDisplayLine(rowDef.role)}`, used ? "accent" : "muted"),
						],
						detail: cells.model ? [span(cells.model, "muted")] : undefined,
						value: rolesCellValue(cells),
					},
					undefined,
					key,
				);
			}
			case "chainKey": {
				const slash = rowDef.role.lastIndexOf("/");
				return node(
					"item",
					{
						label: [
							span(`${theme.status.shadowed} `, "dim"),
							span(sanitizeDisplayLine(rowDef.role.slice(0, slash + 1)), "dim"),
							span(sanitizeDisplayLine(rowDef.role.slice(slash + 1))),
						],
					},
					undefined,
					key,
				);
			}
			case "fallback":
			case "pool":
			case "poolMember": {
				const cells = this.#rolesRowCells(rowDef) ?? {};
				const indent =
					rowDef.kind === "poolMember" ? (rowDef.target.kind === "chain" ? "      • " : "    • ") : "  ↳ ";
				const name =
					rowDef.kind === "poolMember"
						? sanitizeDisplayLine(rowDef.alias)
						: rowDef.kind === "pool"
							? "fallback pool"
							: `fallback ${rowDef.chainIndex + 1}`;
				return node(
					"item",
					{
						label: [span(indent, "dim"), span(name, "muted")],
						detail: cells.model ? [span(cells.model, "muted")] : undefined,
						value: rolesCellValue(cells),
					},
					undefined,
					key,
				);
			}
			case "role":
				break;
		}
		const role = rowDef.role;
		const info = this.#settings.getRoleInfo(role);
		const assignment = this.#roles[role];
		const tag = sanitizeDisplayLine(info.tag ?? info.name ?? role);
		let label: TspSpan[];
		let detail: TspSpan[];
		const value: TspSpan[] = [];
		const rolePool = this.#rolePool(role);
		if (rolePool) {
			const color = info.color ?? "muted";
			const cells = this.#roleCells(role);
			label = [span(`${theme.status.enabled} `, color), span(tag, color)];
			detail = [span(cells.model ?? "", "muted")];
			value.push(...(rolesCellValue(cells) ?? []));
		} else if (assignment && !assignment.autoSelected) {
			const color = info.color ?? "muted";
			label = [span(`${theme.status.enabled} `, color), span(tag, color)];
			detail = [
				span(`${sanitizeDisplayLine(assignment.model.provider)}/`, "dim"),
				span(sanitizeDisplayLine(assignment.model.id)),
			];
			if (assignment.thinkingLevel !== ThinkingLevel.Inherit) {
				const glyph = thinkingLevelGlyph(assignment.thinkingLevel, theme);
				const levelLabel = getConfiguredThinkingLevelMetadata(assignment.thinkingLevel).label;
				value.push(span(glyph ? `${glyph} ${levelLabel}` : levelLabel, "dim"));
			}
		} else {
			label = [span(`${theme.status.shadowed} `, "dim"), span(tag, "dim")];
			detail = assignment
				? [
						span(
							`auto → ${sanitizeDisplayLine(assignment.model.provider)}/${sanitizeDisplayLine(assignment.model.id)}`,
							"dim",
						),
					]
				: [span("—", "dim")];
		}
		// Quick-cycle membership badge (`⟳ 2` = second stop of the ctrl+p cycle).
		const cycleIndex = cycleOrder.indexOf(role);
		if (cycleIndex >= 0) {
			if (value.length > 0) value.push(span("  "));
			value.push(span(`${theme.icon.loop} ${cycleIndex + 1}`, "accent"));
		}
		return node("item", { label, detail, value: value.length > 0 ? value : undefined }, undefined, key);
	}

	/** Live preview of the quick-switch cycle; the selected row's role is emphasized. */
	#describeCycle(cycleOrder: readonly string[]): NativeNode {
		const [cycleKey] = boundKeys("app.model.cycleForward", ["ctrl+p"]);
		const keycap: NativeChild[] = cycleKey ? [kbd(cycleKey)] : [];
		if (cycleOrder.length === 0) {
			return node(
				"row",
				{ gap: "xs", align: "center", wrap: true },
				[
					...keycap,
					text([span("cycle is empty — press ", "dim"), span("c", "key"), span(" on a role to add it", "dim")]),
				],
				"cycle",
			);
		}
		const selectedRow = this.#rolesRows[this.#roleIndex];
		const selectedRole =
			selectedRow && "role" in selectedRow && selectedRow.kind !== "chainKey" ? selectedRow.role : "";
		const track: TspSpan[] = [];
		for (const role of cycleOrder) {
			if (track.length > 0) track.push(span(" › ", "dim"));
			track.push(span(sanitizeDisplayLine(role), role === selectedRole ? "accent strong" : "muted"));
		}
		return node(
			"row",
			{ gap: "xs", align: "center", wrap: true },
			[...keycap, text([span("cycle:", "dim")]), text(track, { wrap: "word" })],
			"cycle",
		);
	}

	#describeLockedView(entry: SidebarEntry): NativeNode {
		const children: NativeChild[] = [
			text([span(`${entry.label} has no credentials configured`, "warning")], { wrap: "word" }),
		];
		const envVars = entry.providerId ? (providerEntry(entry.providerId)?.envVars ?? []) : [];
		children.push(
			text(
				[
					span(
						envVars.length > 0
							? `Set ${envVars.join(" or ")} in your environment, or add a key in config.`
							: "Add an API key for this provider in config.",
						"muted",
					),
				],
				{ wrap: "word" },
			),
		);
		if (entry.oauth) {
			children.push(
				node(
					"row",
					{ gap: "sm", align: "center", actions: { click: "login" } },
					[text([span("Log in with OAuth", "accent")]), node("kbd", { keys: ["enter"] })],
					"login",
				),
			);
		}
		const catalogCount = entry.catalogCount ?? 0;
		if (catalogCount > 0) {
			const models = this.#scopedModels.length > 0 ? [] : this.#registry.getAll("all");
			const items: NativeNode[] = [];
			for (const model of models) {
				if (model.provider !== entry.providerId) continue;
				items.push(node("item", { label: model.id, disabled: true }, undefined, model.id));
			}
			children.push(
				node(
					"section",
					{ head: [span(`${catalogCount} models in catalog`, "dim")] },
					[node("list", { selected: null, virtual: true }, items, "catalog")],
					"catalog",
				),
			);
		}
		return node("col", { gap: "sm", grow: 1 }, children, "locked");
	}

	// ─── Picker (data-first `picker` kind, NATIVE_REDESIGN.md §4.7) ─────────

	#describePicker(): NativeNode {
		const entry = this.#activeEntry();
		const rolesView = isRolesView(entry.kind) && this.#assigning === null;
		const lockedView = entry.kind === "provider" && entry.locked === true && this.#assigning === null;
		const strip = this.#strip;
		const props: TspPickerProps = {
			title: "Models",
			subtitle: this.#pickerSubtitle(entry, rolesView),
			icon: "cpu",
			noun: rolesView ? (entry.kind === "groups" ? "groups" : "roles") : "models",
			size: "lg",
			layout: "rows",
			preview: "side",
			...(rolesView
				? pickerQuery(this.#roleSearching || this.#roleSearch.getValue() ? this.#roleSearch : null)
				: { query: this.#browser.query, cursor: this.#browser.cursor }),
			placeholder: rolesView ? "Search roles and groups…" : "Search models…",
			scopes: this.#pickerScopes(),
			scope: entry.id,
			actions: this.#pickerActions(entry, rolesView, lockedView),
			strip: strip ? this.#pickerStrip(strip) : null,
			confirm: this.#roleConfirm ? { text: this.#roleConfirm.text, act: "confirm", label: "Remove" } : null,
			focus: strip ? "strip" : this.#focus === "scope" ? "scopes" : "list",
		};
		if (rolesView) {
			const row = this.#rolesRows[this.#roleIndex];
			const items = this.#rolePickerItems();
			const groupsView = entry.kind === "groups";
			return picker(
				{
					...props,
					...(groupsView
						? {}
						: {
								tabs: ROLE_TABS.map(tab => ({
									id: tab,
									label: tab === "all" ? "All" : tab === "chat" ? "Chat" : "Kinds",
									count: this.#visibleRoleIds().filter(
										role => tab === "all" || this.#settings.getRoleInfo(role).section === tab,
									).length,
								})),
								tab: this.#roleTab,
							}),
					columns: ROLE_PICKER_COLUMNS.filter(
						column =>
							!ROLE_PICKER_OPTIONAL_COLUMNS.includes(column.id) ||
							items.some(item => item.facts?.[column.id] !== undefined),
					),
					items,
					order: this.#rolePickerOrder(),
					selected: row && row.kind !== "separator" ? rolesRowKey(row, this.#roleIndex) : null,
					total: groupsView ? this.#roleRowsTotal : this.#allRolesRowCount(),
					hits: Object.fromEntries(
						items.map(item => [
							item.id,
							pickerHits(
								typeof item.label === "string" ? item.label : "",
								this.#roleSearch.getValue().toLowerCase().split(/\s+/),
							),
						]),
					),
					state: this.#assignmentPending
						? "loading"
						: this.#configError || this.#poolStatus?.tone === "error"
							? "error"
							: "ready",
					message: this.#configError ? sanitizeDisplayLine(this.#configError) : this.#poolStatus?.text,
					empty: this.#roleSearch.getValue().trim() ? "No rows match your search." : "No rows in this view.",
				},
				this.#rolePreview(row),
			);
		}
		const catalogue = this.#browser.pickerItems(this.#availableItems);
		const current = this.#currentSelector ? [this.#currentSelector] : undefined;
		if (lockedView) {
			return picker(
				{
					...props,
					columns: MODEL_PICKER_COLUMNS,
					...catalogue,
					order: [],
					selected: null,
					total: entry.catalogCount ?? 0,
					empty: this.#lockedMessage(entry),
					...(current ? { current } : {}),
				},
				this.#lockedPreview(entry),
			);
		}
		const query = this.#browser.query.trim();
		const view = this.#browser.pickerOrder({
			providers: entry.kind === "all" && query.length === 0,
			rest: entry.kind === "provider" ? entry.label : query ? "Matches" : "All models",
		});
		const refreshing =
			this.#catalogRefreshing ||
			(entry.kind === "provider" && this.#refreshingProviders.has(entry.providerId ?? ""));
		const state = this.#assignmentPending
			? "loading"
			: view.count > 0 || query
				? "ready"
				: refreshing
					? "loading"
					: this.#configError && !this.#assigning
						? "error"
						: "ready";
		return picker(
			{
				...props,
				tabs: this.#pickerKindTabs(),
				tab: this.#modelKindTab,
				columns: MODEL_PICKER_COLUMNS,
				...catalogue,
				order: view.order,
				...(view.hits ? { hits: view.hits } : {}),
				selected: this.#browser.pickerSelected,
				...(current ? { current } : {}),
				total: this.#browser.baseCount,
				state,
				...(state === "error" && this.#configError ? { message: this.#configError } : {}),
				empty:
					this.#emptyStateMessage()?.trim() ??
					(entry.kind === "provider" ? `No models from ${entry.label} yet` : "No models available in this scope"),
			},
			this.#browser.pickerPreview("full", this.#currentSelector),
		);
	}

	/** What the hub is doing when it is more than browsing: applying, assigning, refreshing, a config error. */
	#pickerSubtitle(entry: SidebarEntry, rolesView: boolean): TspPickerProps["subtitle"] {
		if (this.#assignmentPending) return "Applying model…";
		const assigning = this.#assigning;
		if (assigning !== null) {
			if (assigning.kind === "fallbackKey") return "New fallback chain — pick the model it protects";
			if (assigning.kind === "newGroup") return `New group +${assigning.name} — pick its first model`;
			const label = this.#assignLabel(assigning);
			const verb =
				assigning.kind === "role"
					? "Assigning"
					: assigning.kind === "poolMember"
						? this.#poolAssignVerb(assigning)
						: assigning.index === null
							? "Adding fallback for"
							: "Replacing fallback of";
			return [span(`${verb} `), span(label, "strong")];
		}
		if (this.#configError && entry.kind !== "provider") return [span(this.#configError, "error")];
		if (this.#poolStatus && rolesView) return [span(this.#poolStatus.text, this.#poolStatus.tone)];
		if (entry.kind === "groups") return "Shared model groups";
		if (entry.kind === "provider" && entry.providerId && this.#refreshingProviders.has(entry.providerId)) {
			return `${entry.label} · refreshing model list…`;
		}
		const presets = rolesView ? this.#presets() : undefined;
		if (presets && presets.names.length > 0) {
			return [
				span("Preset ", "muted"),
				presets.active ? span(presets.active, "strong") : span("custom", "muted"),
				span(
					this.#scopedModels.length > 0 ? " · --models scope" : " · Cleared roles fall back to auto-selection",
					"muted",
				),
			];
		}
		if (this.#scopedModels.length > 0) return "--models scope";
		if (rolesView) return "Cleared roles fall back to auto-selection";
		return undefined;
	}

	/** The sidebar as picker scopes: Roles, All models, then signed-in and signed-out providers. */
	#pickerScopes(): TspPickerScope[] {
		const counts = this.#searchCounts;
		const oauthIds = new Set(getOAuthProviders().map(provider => provider.id));
		const scopes: TspPickerScope[] = [];
		for (const entry of this.#entries) {
			switch (entry.kind) {
				case "separator":
					break;
				case "roles":
					scopes.push({ id: entry.id, label: "Roles", icon: "sparkles", count: this.#visibleRoleIds().length });
					break;
				case "groups":
					scopes.push({ id: entry.id, label: "Groups", icon: "layers", count: this.#modelGroupNames().length });
					break;
				case "all":
					scopes.push({
						id: entry.id,
						label: "All models",
						icon: "list",
						count: counts ? this.#searchTotal : this.#availableItems.length,
					});
					break;
				case "recent":
					scopes.push({
						id: entry.id,
						label: "Recent",
						icon: "clock",
						count: counts ? this.#recentSearchCount : this.#recentItems.length,
					});
					break;
				case "provider": {
					const providerId = entry.providerId ?? entry.label;
					const mark = providerMark(providerId);
					if (entry.locked) {
						const envVars = providerEntry(providerId)?.envVars ?? [];
						scopes.push({
							id: entry.id,
							label: entry.label,
							mark,
							group: "Not signed in",
							disabled: oauthIds.has(providerId)
								? "Sign in with /login"
								: envVars.length > 0
									? `Set ${envVars.join(" or ")} to sign in`
									: "Add an API key in config to sign in",
							dot: "muted",
						});
						break;
					}
					const dot = this.#providerDot(providerId);
					scopes.push({
						id: entry.id,
						label: entry.label,
						mark,
						group: "Providers",
						count: counts ? (counts.get(providerId) ?? 0) : Number(entry.annotation ?? 0),
						...(dot ? { dot } : {}),
					});
					break;
				}
			}
		}
		return scopes;
	}

	/** Discovery state as a scope dot: refreshing, ok, cached/empty, unavailable, signed out. */
	#providerDot(providerId: string): TspPickerScope["dot"] {
		if (this.#refreshingProviders.has(providerId)) return "pending";
		switch (this.#registry.getProviderDiscoveryState(providerId)?.status) {
			case "ok":
				return "success";
			case "cached":
			case "empty":
				return "warning";
			case "unavailable":
				return "error";
			case "unauthenticated":
				return "muted";
			default:
				return undefined;
		}
	}

	/** Kind tabs with their counts in the active scope; the same array while the scope's models are unchanged. */
	#pickerKindTabs(): TspPickerProps["tabs"] {
		const candidates = this.#candidateItems;
		if (this.#kindTabsMemo?.candidates === candidates) return this.#kindTabsMemo.tabs;
		const counts = new Map<string, number>();
		for (const item of candidates) {
			const kind = modelKind(item.model);
			counts.set(kind, (counts.get(kind) ?? 0) + 1);
		}
		const tabs = MODEL_KIND_TABS.map(kind => ({
			id: kind,
			label: MODEL_KIND_LABELS[kind],
			count: kind === "all" ? candidates.length : (counts.get(kind) ?? 0),
		}));
		this.#kindTabsMemo = { candidates, tabs };
		return tabs;
	}

	/** The action bar for the current view; every button runs the path of the key it shows. */
	#pickerActions(entry: SidebarEntry, rolesView: boolean, lockedView: boolean): TspPickerAction[] {
		const strip = this.#strip;
		const cancel = (label: string): TspPickerAction => ({ ...CLOSE_ACTION, label });
		if (this.#roleConfirm)
			return [pickerAction("confirm", "Remove", "enter", { primary: true, danger: true }), cancel("Cancel")];
		if (this.#assignmentPending) return [CLOSE_ACTION];
		if (strip) {
			const apply =
				strip.kind === "name"
					? strip.purpose === "compaction"
						? pickerAction(
								"compactionPoint",
								compactionConfirmPending(strip) ? "Accept compaction point" : "Set compaction point",
								"enter",
								{ primary: true },
							)
						: pickerAction(
								strip.purpose === "preset" ? "presetName" : "roleName",
								strip.purpose === "preset" ? "Save preset" : "Create role",
								"enter",
								{ primary: true },
							)
					: pickerAction(
							"stripApply",
							strip.kind === "thinking" ? "Apply" : strip.kind === "scope" ? "Save to scope" : "Assign / clear",
							"enter",
							{ primary: true, danger: strip.chips[strip.index]?.action === "unassign" },
						);
			return [apply, cancel(strip.kind === "thinking" ? "Keep" : "Cancel")];
		}
		const refresh =
			entry.kind === "provider" && !entry.locked ? pickerAction("refresh", "Refresh provider", "f5") : undefined;
		if (this.#focus === "scope" && !lockedView) {
			return compact([
				pickerAction("focusList", rolesView ? (entry.kind === "groups" ? "Groups" : "Roles") : "Models", "enter"),
				rolesView ? pickerAction("search", "Search", "/") : refresh,
				cancel(
					this.#assigning
						? "Cancel"
						: rolesView && this.#roleSearch.getValue()
							? "Clear search"
							: this.#browser.query
								? "Clear search"
								: "Close",
				),
			]);
		}
		if (this.#assigning !== null) {
			const label =
				this.#assigning.kind === "fallback"
					? "Pick fallback"
					: this.#assigning.kind === "fallbackKey"
						? "Pick protected model"
						: this.#assigning.kind === "poolMember"
							? "Pick member"
							: "Assign";
			return compact([pickerAction("assign", label, "enter", { primary: true }), refresh, cancel("Cancel")]);
		}
		if (rolesView) {
			if (this.#roleSearching)
				return [pickerAction("searchDone", "Done searching", "enter"), cancel("Clear search")];
			const row = this.#rolesRows[this.#roleIndex];
			const searching = this.#roleSearching;
			const roleAction = (action: RolesAction, label: string, key: string, primary = false) =>
				pickerAction(`roles:${action}`, label, searching && key !== "enter" ? undefined : key, {
					...(primary ? { primary: true } : {}),
					...(action === "clear" ? { danger: true } : {}),
				});
			const poolHints = this.#poolRowHints(row);
			if (poolHints) {
				const actions = poolHints.flatMap((hint): TspPickerAction[] => {
					if (hint.keys[0] === "[")
						return [roleAction("earlier", "Earlier", "["), roleAction("later", "Later", "]")];
					const key = hint.keys.includes("enter") ? "enter" : hint.keys[0]!;
					// A shifted letter runs the command of the capital it types.
					const typed = key.startsWith("shift+") ? key.slice("shift+".length).toUpperCase() : key;
					const action = key === "enter" ? "pick" : ROLES_ACTION_KEYS[typed];
					const label = `${hint.label.charAt(0).toUpperCase()}${hint.label.slice(1)}`;
					return action ? [roleAction(action, label, key, key === "enter")] : [];
				});
				const target =
					row?.kind === "profile" ? { kind: "group" as const, key: row.role } : this.#rowPoolTarget(row);
				const pool = target ? this.#pool(target) : undefined;
				const readOnly =
					row?.kind === "group" || row?.kind === "profile" ? this.#groupEditRefusal(row.role) : pool?.readOnly;
				if (readOnly) {
					if (!actions.some(action => action.id === "roles:pick")) {
						actions.push({ ...roleAction("pick", "Edit", "enter"), disabled: sanitizeDisplayLine(readOnly) });
					}
					if (target?.kind === "group") {
						const clear = actions.find(action => action.id === "roles:clear");
						if (clear) clear.disabled = sanitizeDisplayLine(readOnly);
						else actions.push({ ...roleAction("clear", "Remove", "x"), disabled: sanitizeDisplayLine(readOnly) });
					}
				}
				if (target && !this.#poolClearable(target) && !actions.some(action => action.id === "roles:clear")) {
					actions.push({
						...roleAction("clear", "Remove", "x"),
						disabled: "Read-only: another layer owns this entry",
					});
				}
				if (row?.kind === "group" || row?.kind === "profile") {
					const used =
						row.kind === "group"
							? this.#groupReferences(row.role)
							: this.#profileReferences(row.role, row.profile);
					if (used.length) {
						const clear = actions.find(action => action.id === "roles:clear");
						if (clear)
							clear.disabled = `+${row.role}${row.kind === "profile" ? `@${row.profile}` : ""} is used by ${this.#referencePaths(used)}; point those elsewhere first`;
					}
				}
				return [
					...actions,
					pickerAction("search", "Search", "/"),
					this.#roleSearch.getValue() ? cancel("Clear search") : CLOSE_ACTION,
				];
			}
			const convert = this.#legacyPoolSource(row) ? roleAction("pool", "Make pool", "m") : undefined;
			const actions: (TspPickerAction | undefined)[] = [];
			const compaction =
				this.#callbacks.onCompactionPointChange && this.#roleRowModel()
					? roleAction("compaction", "Compaction limit", "k")
					: undefined;
			switch (row?.kind) {
				case "role": {
					const assigned = this.#roles[row.role];
					actions.push(
						roleAction("pick", "Pick model", "enter", true),
						this.#fallbackAddable(row.role) ? roleAction("fallback", "Add fallback", "f") : undefined,
						assigned && !assigned.autoSelected ? roleAction("clear", "Clear", "x") : undefined,
						this.#roleThinkingTarget(row.role) ? roleAction("thinking", "Thinking", "t") : undefined,
						compaction,
						convert,
						roleAction("cycle", this.#cycleOrder().includes(row.role) ? "Leave cycle" : "Add to cycle", "c"),
						roleAction("new", "New role", "n"),
						this.#callbacks.onSavePreset ? roleAction("save", "Save preset", "s") : undefined,
						this.#presets().names.length > 0 ? roleAction("nextPreset", "Next preset", "p") : undefined,
					);
					break;
				}
				case "fallback":
					actions.push(
						roleAction("pick", "Replace", "enter", true),
						roleAction("fallback", "Add another", "f"),
						roleAction("clear", "Remove", "x"),
						this.#resolveFallbackEntry(row.role, row.chainIndex)
							? roleAction("thinking", "Thinking", "t")
							: undefined,
						compaction,
						roleAction("earlier", "Earlier", "["),
						roleAction("later", "Later", "]"),
						convert,
					);
					break;
				case "chainKey":
					actions.push(
						roleAction("pick", "Add fallback", "enter", true),
						roleAction("clear", "Clear chain", "x"),
						convert,
					);
					break;
				case "newFallback":
					actions.push(roleAction("pick", "New fallback chain", "enter", true));
					break;
				case "newRole":
					actions.push(roleAction("pick", "New role", "enter", true));
					break;
			}
			if (row?.kind === "role" && this.#cycleOrder().includes(row.role)) {
				actions.push(roleAction("earlier", "Earlier", "["), roleAction("later", "Later", "]"));
			}
			if (row?.kind === "role" && this.#presets().names.length > 0) {
				actions.push(roleAction("prevPreset", "Previous preset", "shift+p"));
			}
			if (this.#groupsAvailable(row)) actions.push(roleAction("groups", "Model group", "shift+g"));
			return compact([
				...actions,
				pickerAction("search", "Search", "/"),
				this.#roleSearch.getValue() ? cancel("Clear search") : CLOSE_ACTION,
			]);
		}
		if (lockedView) {
			return entry.oauth
				? [pickerAction("login", "Log in", "enter", { primary: true }), CLOSE_ACTION]
				: [CLOSE_ACTION];
		}
		return compact([
			pickerAction(
				"assign",
				"Assign role",
				"enter",
				this.#browser.pickerSelected ? { primary: true } : { primary: true, disabled: "No model selected" },
			),
			refresh,
			this.#browser.query.length > 0 ? cancel("Clear search") : CLOSE_ACTION,
		]);
	}

	/** The open strip as the picker's chip strip (role assignment, save scope, thinking level, new role name). */
	#pickerStrip(strip: StripState): NonNullable<TspPickerProps["strip"]> {
		if (strip.kind === "name") {
			if (strip.purpose === "compaction") {
				const notice = compactionNotice(strip, this.#callbacks.previewCompactionPoint);
				return {
					label: [
						span(strip.model.id, "mono"),
						span(" limit ", "muted"),
						span(strip.input.getValue(), "mono"),
						span("▏", "accent"),
						span(`  ${notice.text}`, notice.style),
					],
					items: [],
				};
			}
			return {
				label: [
					span(strip.purpose === "preset" ? "Preset name " : "New role name ", "muted"),
					span(strip.input.getValue(), "mono"),
					span("▏", "accent"),
				],
				items: [],
			};
		}
		let label: TspSpan[];
		if (strip.kind === "role") {
			// The second step of "New fallback chain…" reuses the role strip with key chips only.
			const keyStrip = strip.chips.every(chip => chip.label.startsWith("for "));
			label = keyStrip
				? [span("New fallback chain", "muted")]
				: [span("Assign ", "muted"), span(sanitizeDisplayLine(strip.item.id), "mono"), span(" to", "muted")];
		} else {
			const info = this.#settings.getRoleInfo(strip.role ?? "");
			const roleLabel = sanitizeDisplayLine(info.tag ?? strip.role ?? "").toLowerCase();
			label = [
				span(strip.kind === "thinking" ? "Thinking for " : "Save ", "muted"),
				span(roleLabel, "strong"),
				span(" · ", "muted"),
				span(sanitizeDisplayLine(strip.item.id), "mono"),
				...(strip.kind === "scope" ? [span(" to", "muted")] : []),
			];
		}
		return {
			label,
			items: strip.chips.map((chip, index) => {
				const assigned = chip.role ? this.#roles[chip.role] : undefined;
				const level =
					chip.action === "thinking"
						? chip.thinkingLevel
						: chip.action === "unassign" && assigned && !assigned.autoSelected
							? assigned.thinkingLevel
							: undefined;
				const dot = level !== undefined ? thinkingDotToken(level) : undefined;
				const on =
					chip.action === "unassign" ||
					(strip.kind === "thinking" &&
						chip.thinkingLevel !== undefined &&
						chip.thinkingLevel === strip.initialThinkingLevel);
				return { id: String(index), label: chip.label, ...(on ? { on: true } : {}), ...(dot ? { dot } : {}) };
			}),
			selected: String(strip.index),
		};
	}

	/** Roles-view rows as picker items; rebuilt only when the rows, roles or cycle change. */
	#rolePickerItems(): readonly TspPickerItem[] {
		const cycleOrder = this.#cycleOrder();
		const cycle = cycleOrder.join("\0");
		const memo = this.#pickerRoleItems;
		const billingRevision = this.#settings.billingRevision;
		if (
			memo?.rows === this.#rolesRows &&
			memo.roles === this.#roles &&
			memo.cycle === cycle &&
			memo.billing === billingRevision
		) {
			return memo.items;
		}
		const items: TspPickerItem[] = [];
		this.#rolesRows.forEach((row, index) => {
			const id = rolesRowKey(row, index);
			switch (row.kind) {
				case "separator":
					return;
				case "newRole":
					items.push({ id, label: "New role…", icon: "plus", tone: "muted" });
					return;
				case "newFallback":
					items.push({ id, label: "New fallback chain…", icon: "plus", tone: "muted" });
					return;
				case "newGroup":
					items.push({ id, label: "New group…", icon: "plus", tone: "muted" });
					return;
				case "profile": {
					const used = this.#profileReferences(row.role, row.profile).length > 0;
					items.push({
						id,
						label: `@${sanitizeDisplayLine(row.profile)}`,
						mono: true,
						depth: 1,
						...(used ? {} : { tone: "muted" as const }),
						facts: rolesCellFacts(this.#rolesRowCells(row) ?? {}),
					});
					return;
				}
				case "group": {
					const users = this.#groupUsers(row.role);
					items.push({
						id,
						label: `+${sanitizeDisplayLine(row.role)}`,
						mono: true,
						icon: "layers",
						detail: users === "unused" ? "unused" : `used by ${users}`,
						...(users === "unused" ? { tone: "muted" as const } : {}),
						facts: rolesCellFacts(this.#rolesRowCells(row) ?? {}),
					});
					return;
				}
				case "chainKey":
					items.push({
						id,
						label: sanitizeDisplayLine(row.role),
						mono: true,
						icon: "git-branch",
						detail: "fallback chain",
					});
					return;
				case "fallback":
					items.push({
						id,
						label: `fallback ${row.chainIndex + 1}`,
						depth: 1,
						tone: "muted",
						facts: rolesCellFacts(this.#rolesRowCells(row) ?? {}),
					});
					return;
				case "pool":
					items.push({
						id,
						label: "fallback pool",
						depth: 1,
						tone: "muted",
						facts: rolesCellFacts(this.#rolesRowCells(row) ?? {}),
					});
					return;
				case "poolMember":
					items.push({
						id,
						label: sanitizeDisplayLine(row.alias),
						mono: true,
						depth: row.target.kind === "chain" ? 2 : 1,
						tone: "muted",
						facts: rolesCellFacts(this.#rolesRowCells(row) ?? {}),
					});
					return;
				case "role":
					break;
			}
			const info = this.#settings.getRoleInfo(row.role);
			const tag = sanitizeDisplayLine(info.tag ?? info.name ?? row.role);
			const assignment = this.#roles[row.role];
			const facts = rolesCellFacts(this.#roleCells(row.role));
			const cycleIndex = cycleOrder.indexOf(row.role);
			items.push({
				id,
				label: tag,
				...(info.name && info.name !== tag ? { detail: sanitizeDisplayLine(info.name) } : {}),
				facts,
				...(assignment && !assignment.autoSelected ? {} : { tone: "muted" as const }),
				...(cycleIndex >= 0
					? {
							badges: [
								{
									text: `cycle ${cycleIndex + 1}`,
									tone: "accent" as const,
									title: `Stop ${cycleIndex + 1} of the quick-switch cycle`,
								},
							],
						}
					: {}),
			});
		});
		const rowsById = new Map(this.#rolesRows.map((row, index) => [rolesRowKey(row, index), row]));
		for (const item of items) {
			const row = rowsById.get(item.id);
			if (!row) continue;
			const badges = this.#roleBadges(row);
			if (badges.length) item.badges = [...(item.badges ?? []), ...badges];
		}
		this.#pickerRoleItems = { rows: this.#rolesRows, roles: this.#roles, cycle, billing: billingRevision, items };
		return items;
	}

	/** Roles-view order: the separators become group heads (chat roles, kind roles, model fallback chains). */
	#rolePickerOrder(): (string | TspPickerGroup)[] {
		const order: (string | TspPickerGroup)[] = [];
		let head: { group: string; label: string; count: number } | undefined;
		const open = (group: string, label: string) => {
			head = { group, label, count: 0 };
			order.push(head);
		};
		if (this.#activeEntryId === "groups") open("groups", "Model groups");
		else open(this.#roleTab === "kind" ? "kind" : "chat", this.#roleTab === "kind" ? "Kind roles" : "Chat roles");
		this.#rolesRows.forEach((row, index) => {
			if (row.kind === "separator") {
				const previous = this.#rolesRows[index - 1];
				if (previous?.kind === "newRole") open("chains", "Model fallback chains");
				else open("kind", "Kind roles");
				return;
			}
			order.push(rolesRowKey(row, index));
			// Heads count roles and chains, not their fallback entries or the "new" rows.
			if (head && (row.kind === "role" || row.kind === "chainKey" || row.kind === "group")) head.count++;
		});
		return order;
	}

	/** The selected Roles-view row's preview: its model's facts and its fallback chain. */
	#rolePreview(row: RolesRow | undefined): readonly NativeChild[] {
		const memo = this.#pickerRolePreview;
		const revision = this.#settings.revision;
		const billingRevision = this.#settings.billingRevision;
		if (
			memo !== undefined &&
			memo.row === row &&
			memo.roles === this.#roles &&
			memo.rows === this.#rolesRows &&
			memo.revision === revision &&
			memo.billing === billingRevision
		) {
			return memo.children;
		}
		const children: NativeChild[] = [];
		const chainList = (key: string): NativeChild | undefined => {
			const chain = this.#fallbackChains()[key] ?? [];
			if (chain.length === 0) return undefined;
			return node("section", { head: "Fallback chain" }, [
				md(
					chain
						.map(
							(selector, index) =>
								`${index + 1}. ${sanitizeDisplayLine(selector).replace(/[\\`*_[\]<>]/g, "\\$&")}`,
						)
						.join("\n"),
				),
			]);
		};
		const chainPool = (key: string): NativeChild[] =>
			this.#isPooledChain(key) ? this.#poolPreview(this.#chainPool(key), "Fallback pool") : [];
		const billingRow = (model: string) => {
			const billing = this.#billing(model);
			return billing ? [{ k: [span("Billing", "muted")], v: billing }] : [];
		};
		const modelItem = (model: Model): ModelBrowserItem => ({
			provider: model.provider,
			id: model.id,
			model,
			selector: `${model.provider}/${model.id}`,
		});
		switch (row?.kind) {
			case "role": {
				const info = this.#settings.getRoleInfo(row.role);
				const assignment = this.#roles[row.role];
				const rolePool = this.#rolePool(row.role);
				if (rolePool) {
					children.push(
						text(sanitizeDisplayLine(info.name), { role: "omp.picker.title" }),
						...this.#poolPreview(rolePool, "Role pool"),
					);
				} else if (assignment) {
					children.push(...this.#browser.modelPreview(modelItem(assignment.model), "full", this.#currentSelector));
					children.push(
						node("kv", {
							items: [
								{ k: [span("Role", "muted")], v: sanitizeDisplayLine(info.name) },
								{
									k: [span("Thinking", "muted")],
									v: getConfiguredThinkingLevelMetadata(assignment.thinkingLevel).label,
								},
								{ k: [span("Source", "muted")], v: assignment.autoSelected ? "auto-selected" : "configured" },
								...billingRow(`${assignment.model.provider}/${assignment.model.id}`),
							],
						}),
					);
				} else {
					children.push(
						text(sanitizeDisplayLine(info.name), { role: "omp.picker.title" }),
						text([span("Not assigned; no available model fits this role.", "muted")], { wrap: "word" }),
					);
				}
				const chain = chainList(row.role);
				if (chain) children.push(chain);
				children.push(...chainPool(row.role));
				break;
			}
			case "fallback": {
				const resolved = this.#resolveFallbackEntry(row.role, row.chainIndex);
				if (resolved) children.push(...this.#browser.modelPreview(resolved.item, "full", this.#currentSelector));
				else children.push(text([span(sanitizeDisplayLine(row.selector), "mono")], { role: "omp.picker.title" }));
				const billing = billingRow(row.selector);
				if (billing.length > 0) children.push(node("kv", { items: billing }));
				const chain = chainList(row.role);
				if (chain) children.push(chain);
				break;
			}
			case "chainKey": {
				children.push(text([span(sanitizeDisplayLine(row.role), "mono")], { role: "omp.picker.title" }));
				const chain = chainList(row.role);
				if (chain) children.push(chain);
				children.push(...chainPool(row.role));
				break;
			}
			case "pool":
				children.push(
					text([span(sanitizeDisplayLine(row.role), "mono")], { role: "omp.picker.title" }),
					...this.#poolPreview(this.#chainPool(row.role), "Fallback pool"),
				);
				break;
			case "poolMember": {
				const member = this.#poolMemberOf(row);
				const parsed = member ? parseModelString(member.model) : undefined;
				const item = parsed ? this.#findFallbackModel(parsed.provider, parsed.id) : undefined;
				if (item) children.push(...this.#browser.modelPreview(item, "full", this.#currentSelector));
				else if (member)
					children.push(text([span(sanitizeDisplayLine(member.model), "mono")], { role: "omp.picker.title" }));
				const poolLabel =
					row.target.kind === "role"
						? "Role pool"
						: row.target.kind === "chain"
							? "Fallback pool"
							: `Group +${row.target.key}`;
				children.push(...this.#poolPreview(this.#pool(row.target), poolLabel));
				break;
			}
			case "newRole":
				children.push(
					text("New role", { role: "omp.picker.title" }),
					text([span("Name a custom role, then pick the model it runs on.", "muted")], { wrap: "word" }),
				);
				break;
			case "newFallback":
				children.push(
					text("New fallback chain", { role: "omp.picker.title" }),
					text([span("Pick the model (or provider) a new retry fallback chain protects.", "muted")], {
						wrap: "word",
					}),
				);
				break;
			case "group":
				children.push(
					text([span(`+${sanitizeDisplayLine(row.role)}`, "mono")], { role: "omp.picker.title" }),
					node("kv", { items: [{ k: [span("Used by", "muted")], v: this.#groupUsers(row.role) }] }),
					...this.#poolPreview(this.#pool({ kind: "group", key: row.role }), "Group"),
				);
				break;
			case "profile": {
				const efforts = this.#groupProfiles(row.role).find(entry => entry.name === row.profile)?.efforts ?? {};
				const members = this.#pool({ kind: "group", key: row.role })?.members ?? [];
				children.push(
					text([span(`+${sanitizeDisplayLine(row.role)}@${sanitizeDisplayLine(row.profile)}`, "mono")], {
						role: "omp.picker.title",
					}),
					node("kv", {
						items: [
							{
								k: [span("Used by", "muted")],
								v: (this.#rolesRowCells(row)?.routing ?? "unused").replace(/^used by /, ""),
							},
							...members.map(member => ({
								k: [span(sanitizeDisplayLine(member.alias), "muted")],
								v: efforts[member.alias] ?? `default (${member.effort ?? "inherit"})`,
							})),
						],
					}),
				);
				break;
			}
			case "newGroup":
				children.push(
					text("New group", { role: "omp.picker.title" }),
					text(
						[
							span(
								"Name a shared pool, then pick its first model. Roles and fallback chains use it as +name.",
								"muted",
							),
						],
						{ wrap: "word" },
					),
				);
				break;
		}
		this.#pickerRolePreview = {
			row,
			roles: this.#roles,
			rows: this.#rolesRows,
			revision,
			billing: billingRevision,
			children,
		};
		return children;
	}

	/** A pool's preview section: strategy, funding, routing, then each member with effort and weight. */
	#poolPreview(pool: ModelHubPool | undefined, head: string): NativeChild[] {
		if (!pool || pool.invalid !== undefined) {
			const message =
				pool?.invalid === undefined
					? "This pool is invalid and is skipped; fix it in config."
					: `This pool is invalid and is skipped: ${sanitizeDisplayLine(pool.invalid)}. Fix it in config, or clear it with x.`;
			return [text([span(message, "warning")], { wrap: "word" })];
		}
		const row = (key: string, value: string) => ({ k: [span(key, "muted")], v: value });
		const facts = this.#poolFacts(pool).map(fact => row(fact.key, fact.value));
		const members = pool.members.map(member => {
			const details = [
				member.model,
				member.effort,
				member.weight !== undefined ? `weight ${member.weight}` : undefined,
				this.#billingFact(member.model),
			];
			return row(
				sanitizeDisplayLine(member.alias),
				sanitizeDisplayLine(details.filter(detail => detail !== undefined).join(" · ")),
			);
		});
		return [
			node("section", { head }, [
				node("kv", { items: facts }),
				...(members.length > 0 ? [node("kv", { items: members })] : []),
			]),
		];
	}

	#lockedMessage(entry: SidebarEntry): string {
		const envVars = entry.providerId ? (providerEntry(entry.providerId)?.envVars ?? []) : [];
		const how =
			envVars.length > 0
				? `Set ${envVars.join(" or ")} in your environment, or add a key in config.`
				: "Add an API key for this provider in config.";
		return `${entry.label} has no credentials configured. ${how}`;
	}

	/** A signed-out provider's preview: how to sign in and what its catalog holds. */
	#lockedPreview(entry: SidebarEntry): readonly NativeChild[] {
		const children: NativeChild[] = [
			text(entry.label, { role: "omp.picker.title" }),
			text([span(this.#lockedMessage(entry), "muted")], { wrap: "word" }),
		];
		const catalogCount = entry.catalogCount ?? 0;
		if (catalogCount > 0 && this.#scopedModels.length === 0) {
			const ids: string[] = [];
			for (const model of this.#registry.getAll("all")) {
				if (model.provider === entry.providerId) ids.push(`- \`${model.id}\``);
			}
			children.push(node("section", { head: `${catalogCount} models in catalog` }, [md(ids.join("\n"))]));
		}
		return children;
	}

	/** Picker pointer events, each on the path of the key it stands for. */
	#handlePickerEvent(event: PickerEvent): void {
		if (this.#roleConfirm) {
			if (event.kind === "action" && event.act === "confirm") this.#confirmRoleClear();
			else if (event.kind === "action" && (event.act === CLOSE_ACTION.id || event.act === "cancel"))
				this.#roleConfirm = undefined;
			return;
		}
		if (event.kind === "action" && event.act === CLOSE_ACTION.id) {
			this.#cancel();
			return;
		}
		// Same gate as the keys: only cancel works while an assignment applies.
		if (this.#assignmentPending) return;
		const entry = this.#activeEntry();
		const rolesView = isRolesView(entry.kind) && this.#assigning === null;
		if (event.kind !== "action") {
			if (this.#strip) return;
			if (rolesView) {
				const index = this.#rolesRows.findIndex((row, i) => rolesRowKey(row, i) === event.item);
				const row = this.#rolesRows[index];
				if (!row || row.kind === "separator") return;
				this.#focus = "list";
				this.#roleIndex = index;
				if (event.kind === "activate") this.#activateRolesRow(row);
				return;
			}
			if (this.#isBrowserView(entry) && this.#browser.routePickerItem(event.item, event.kind === "activate")) {
				this.#focus = "list";
			}
			return;
		}
		const { act, value } = event;
		if (act.startsWith("roles:")) {
			const action = act.slice("roles:".length) as RolesAction;
			if (!rolesView || this.#strip) return;
			this.#focus = "list";
			this.#runRolesAction(action);
			return;
		}
		switch (act) {
			case "focusList":
				this.#focus = "list";
				return;
			case "search":
				if (rolesView && !this.#strip) {
					this.#roleSearching = true;
					this.#focus = "list";
				}
				return;
			case "searchDone":
				this.#roleSearching = false;
				return;
			case "confirm":
				return;
			case "scope":
				this.#clickSidebarEntry(this.#entries.find(candidate => candidate.id === value));
				return;
			case "tab":
				if (entry.kind === "groups") return;
				if (rolesView) {
					const tab = ROLE_TABS.find(candidate => candidate === value);
					if (!tab) return;
					this.#roleTab = tab;
					this.#roleIndex = 0;
					this.#roleScrollStart = 0;
					this.#buildRolesRows();
				} else {
					const kind = MODEL_KIND_TABS.find(candidate => candidate === value);
					if (!kind) return;
					this.#modelKindTab = kind;
					this.#applyModelKind();
				}
				return;
			case "strip": {
				const strip = this.#strip;
				const index = Number(value);
				if (!strip || strip.kind === "name") return;
				if (!Number.isInteger(index) || !strip.chips[index]) return;
				strip.index = index;
				this.#activateStripChip();
				return;
			}
			case "stripApply":
				this.#activateStripChip();
				return;
			case "roleName":
				this.#submitRoleName();
				return;
			case "presetName":
				this.#submitPresetName();
				return;
			case "compactionPoint":
				this.#submitNameStrip();
				return;
			case "cancel":
				if (this.#strip) this.#closeStrip();
				return;
			case "clear":
				if (this.#browser.query.length > 0) this.#browser.handleCancel();
				return;
			case "assign": {
				if (this.#strip || !this.#isBrowserView(entry)) return;
				const selected = this.#browser.pickerSelected;
				if (!selected) return;
				this.#focus = "list";
				this.#browser.routePickerItem(selected, true);
				return;
			}
			case "refresh":
				if (entry.kind === "provider" && !entry.locked) {
					this.#scheduleProviderRefresh(entry.providerId ?? "", { force: true });
				}
				return;
			case "login":
				if (entry.kind === "provider" && entry.locked && this.#assigning === null) this.#requestLogin(entry);
				return;
		}
	}

	/** Footer chip labels, built from each chip's action instead of its ANSI rendering. */
	#chipSpans(chip: StripChip): TspSpan[] {
		switch (chip.action) {
			case "assign":
			case "unassign": {
				const color = this.#settings.getRoleInfo(chip.role ?? "").color ?? "muted";
				return chip.action === "unassign"
					? [span(`${theme.status.enabled} ${chip.label}`, color), span(` ${theme.status.success}`, "dim")]
					: [span(chip.label, color)];
			}
			case "scope":
				return [span(chip.label, chip.scope === "project" ? "accent" : "muted")];
			case "thinking": {
				const glyph = chip.thinkingLevel === undefined ? "" : thinkingLevelGlyph(chip.thinkingLevel, theme);
				return glyph ? [span(glyph, "accent"), span(` ${chip.label}`)] : [span(chip.label)];
			}
			default:
				return [span(plainText(chip.styled), "muted")];
		}
	}

	#describeStrip(_cx?: DescribeContext): NativeNode | undefined {
		const strip = this.#strip;
		if (!strip) return undefined;
		if (strip.kind === "name") {
			if (strip.purpose === "compaction") {
				const notice = compactionNotice(strip, this.#callbacks.previewCompactionPoint);
				return node(
					"row",
					{ gap: "sm", align: "center" },
					[
						text([span(`${strip.model.id} limit:`, "accent")]),
						col([strip.input], { grow: 1 }),
						text([span(notice.text, notice.style)], { wrap: "word" }),
					],
					"compactionPoint",
				);
			}
			const preset = strip.purpose === "preset";
			return node(
				"row",
				{ gap: "sm", align: "center" },
				[
					text([span(preset ? "Preset name:" : "New role name:", "accent")]),
					col([strip.input], { grow: 1 }),
					text([span("(letters, digits, - and _)", "dim")]),
				],
				preset ? "presetName" : "roleName",
			);
		}
		let prefix: TspSpan[];
		if (strip.kind === "role") {
			prefix = [span(sanitizeDisplayLine(strip.item.id), "accent"), span(" →", "dim")];
		} else {
			const info = this.#settings.getRoleInfo(strip.role ?? "");
			prefix = [
				span(sanitizeDisplayLine(info.tag ?? strip.role ?? "").toLowerCase(), info.color ?? "muted"),
				span(` · ${sanitizeDisplayLine(strip.item.id)} →`, "dim"),
			];
		}
		return node(
			"row",
			{ gap: "sm", align: "center" },
			[
				text(prefix),
				node(
					"tabs",
					{
						items: strip.chips.map((chip, index) => ({ id: String(index), label: this.#chipSpans(chip) })),
						active: String(strip.index),
						actions: { click: "activate" },
					},
					undefined,
					"strip",
				),
			],
			"chips",
		);
	}

	#footerHints(): (NativeHint | undefined)[] {
		const entry = this.#activeEntry();
		const rolesView = isRolesView(entry.kind) && this.#assigning === null;
		const actions = this.#pickerActions(entry, rolesView, entry.kind === "provider" && entry.locked === true);
		const hints: (NativeHint | undefined)[] = pickerActionHints(actions);
		if (!this.#roleConfirm) {
			hints.push(actionHint(["tui.select.up", "tui.select.down"], this.#focus === "scope" ? "providers" : "rows"));
			if (this.#strip && this.#strip.kind !== "name") {
				hints.push({ keys: ["left", "right"], label: "choose" });
			} else if (!this.#strip) {
				hints.push({ keys: ["tab"], label: "providers / rows" });
				if (!rolesView) hints.push({ keys: [], label: "type to search" });
			}
		}
		return hints;
	}
}
