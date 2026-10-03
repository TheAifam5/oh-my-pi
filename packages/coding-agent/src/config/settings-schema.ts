/**
 * JSON Schema of `config.yml`, built from the settings registry.
 *
 * Every registered setting becomes a leaf at its dotted path; intermediate segments are closed
 * objects, so a misspelled key is reported as unknown. Credential settings never carry a default.
 */
import { keyHintPlatform, setKeyHintPlatform } from "@oh-my-pi/pi-tui/key-hint-format";
import { orderedSettings } from "./all-settings";
import type { AnySetting } from "./registry";

type JsonSchema = Record<string, unknown>;

/** URL the committed schema is published at; `$id` of the rendered document. */
export const SETTINGS_SCHEMA_ID =
	"https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/omp-config.schema.json";

/** Platform key hints in descriptions are rendered for, so output does not depend on the host OS. */
const SCHEMA_KEY_HINT_PLATFORM: NodeJS.Platform = "linux";

function leafSchema(setting: AnySetting): JsonSchema {
	const node: JsonSchema = {};
	const description = setting.ui?.description?.trim();
	if (description) node.description = description;
	switch (setting.type) {
		case "enum":
			node.type = "string";
			node.enum = [...(setting.enumValues ?? [])];
			break;
		case "record":
			node.type = "object";
			node.additionalProperties = true;
			break;
		case "array":
			// No `items`: path-scoped arrays also accept `{ path, values }` objects.
			node.type = "array";
			break;
		default:
			node.type = setting.type;
	}
	const fallback = setting.default;
	if (fallback !== undefined && !setting.isCredential) node.default = fallback;
	return node;
}

/**
 * Schema object for `settings`, nested by dotted id in the given order.
 *
 * @throws Error when one setting's id is a path prefix of another's (a leaf cannot also be a branch).
 */
export function buildSettingsSchema(settings: readonly AnySetting[]): JsonSchema {
	const properties: Record<string, JsonSchema> = {};
	const root: JsonSchema = {
		$schema: "https://json-schema.org/draft/2020-12/schema",
		$id: SETTINGS_SCHEMA_ID,
		title: "OMP config.yml",
		description: "Settings accepted in config.yml (global, project, and --config overlays) by the OMP coding agent.",
		type: "object",
		additionalProperties: false,
		properties,
	};
	const leaves = new Set<JsonSchema>();
	for (const setting of settings) {
		let level = properties;
		const segments = setting.segments;
		for (const segment of segments.slice(0, -1)) {
			let child = level[segment];
			if (child && leaves.has(child)) {
				throw new Error(`Setting "${setting.id}" nests under setting "${segment}", which is a leaf`);
			}
			if (!child) {
				child = { type: "object", additionalProperties: false, properties: {} };
				level[segment] = child;
			}
			level = child.properties as Record<string, JsonSchema>;
		}
		const name = segments[segments.length - 1];
		if (level[name]) throw new Error(`Setting "${setting.id}" collides with another setting's path`);
		const leaf = leafSchema(setting);
		leaves.add(leaf);
		level[name] = leaf;
	}
	return root;
}

/**
 * Schema of every registered setting as pretty-printed JSON with a trailing newline.
 *
 * Output is reproducible across hosts only while no theme is loaded: descriptions render key hints
 * with the active symbol theme (ASCII when none is loaded), always for the Linux key layout.
 */
export function renderSettingsSchema(): string {
	const previous = keyHintPlatform();
	setKeyHintPlatform(SCHEMA_KEY_HINT_PLATFORM);
	try {
		return `${JSON.stringify(buildSettingsSchema(orderedSettings()), null, 2)}\n`;
	} finally {
		setKeyHintPlatform(previous === process.platform ? undefined : previous);
	}
}
