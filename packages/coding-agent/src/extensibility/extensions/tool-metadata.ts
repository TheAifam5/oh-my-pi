/**
 * Pi-compatible tool orchestration metadata (`exposure`, `defaultActive`, `executionMode`,
 * `namespace`, `annotations`) mapped onto OMP's own tool fields.
 */
import type { ToolLoadMode } from "@oh-my-pi/pi-agent-core";
import type { TSchema } from "@oh-my-pi/pi-ai";
import { applyToolProxy } from "../tool-proxy";
import type { ToolDefinition, ToolExposure } from "./types";

const TOOL_EXPOSURES: readonly string[] = [
	"direct",
	"model-only",
	"codemode",
	"deferred",
	"hidden",
] satisfies ToolExposure[];

function isToolExposure(value: unknown): value is ToolExposure {
	return typeof value === "string" && TOOL_EXPOSURES.includes(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function conflict(name: string, piField: string, ompField: string): Error {
	return new Error(`Tool "${name}": ${piField} conflicts with ${ompField}; declare one of them`);
}

/** Top-level presentation implied by a Pi exposure; `hidden` keeps the declared mode. */
function loadModeForExposure(exposure: ToolExposure): ToolLoadMode | undefined {
	switch (exposure) {
		case "direct":
		case "model-only":
			return "essential";
		case "codemode":
		case "deferred":
			return "discoverable";
		case "hidden":
			return undefined;
	}
}

/**
 * Validate a tool's Pi metadata and return a definition whose OMP fields (`hidden`,
 * `loadMode`, `defaultInactive`, `concurrency`) carry it. A definition without Pi
 * orchestration fields is returned unchanged.
 *
 * @throws Error when a Pi field is malformed or contradicts the OMP field it maps onto.
 */
export function applyPiToolMetadata<TParams extends TSchema, TDetails>(
	tool: ToolDefinition<TParams, TDetails>,
): ToolDefinition<TParams, TDetails> {
	const { name, exposure, defaultActive, executionMode, namespace, annotations } = tool;
	if (
		namespace !== undefined &&
		(!isPlainObject(namespace) || typeof namespace.name !== "string" || !namespace.name)
	) {
		throw new Error(`Tool "${name}": namespace must be an object with a non-empty name`);
	}
	if (annotations !== undefined && !isPlainObject(annotations)) {
		throw new Error(`Tool "${name}": annotations must be an object`);
	}
	if (exposure === undefined && defaultActive === undefined && executionMode === undefined) return tool;

	const overrides: { hidden?: boolean; loadMode?: ToolLoadMode; defaultInactive?: boolean; concurrency?: string } = {};
	if (exposure !== undefined) {
		if (!isToolExposure(exposure)) {
			throw new Error(
				`Tool "${name}": unknown exposure "${String(exposure)}"; expected ${TOOL_EXPOSURES.join(", ")}`,
			);
		}
		const hidden = exposure === "hidden";
		if (tool.hidden !== undefined && tool.hidden !== hidden) throw conflict(name, `exposure "${exposure}"`, "hidden");
		const loadMode = loadModeForExposure(exposure);
		if (loadMode !== undefined && tool.loadMode !== undefined && tool.loadMode !== loadMode) {
			throw conflict(name, `exposure "${exposure}"`, `loadMode "${tool.loadMode}"`);
		}
		overrides.hidden = hidden;
		if (loadMode !== undefined) overrides.loadMode = loadMode;
	}
	if (defaultActive !== undefined) {
		if (typeof defaultActive !== "boolean") throw new Error(`Tool "${name}": defaultActive must be a boolean`);
		if (tool.defaultInactive !== undefined && tool.defaultInactive === defaultActive) {
			throw conflict(name, "defaultActive", "defaultInactive");
		}
		overrides.defaultInactive = !defaultActive;
	}
	if (executionMode !== undefined) {
		if (executionMode !== "sequential" && executionMode !== "parallel") {
			throw new Error(`Tool "${name}": executionMode must be "sequential" or "parallel"`);
		}
		const concurrency = executionMode === "sequential" ? "exclusive" : "shared";
		const declared = (tool as { concurrency?: unknown }).concurrency;
		if (declared !== undefined && declared !== concurrency) throw conflict(name, "executionMode", "concurrency");
		overrides.concurrency = concurrency;
	}
	// Forward every other member to the original so methods keep their own `this`.
	applyToolProxy(tool, overrides);
	return overrides as unknown as ToolDefinition<TParams, TDetails>;
}

/** The Pi exposure a tool reports: its declared value, else derived from `hidden` and `loadMode`. */
export function toolExposureOf(tool: { exposure?: unknown; hidden?: boolean; loadMode?: ToolLoadMode }): ToolExposure {
	if (isToolExposure(tool.exposure)) return tool.exposure;
	if (tool.hidden === true) return "hidden";
	return tool.loadMode === "discoverable" ? "deferred" : "direct";
}
