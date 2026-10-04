/**
 * Model role selector constants and role-kind checks. Settings definitions and
 * the model-group parser import this module, so it must not import UI code.
 */

import { KIND_ROLE_IDS } from "@oh-my-pi/pi-tui/overlays/model-role-ids";

/** Canonical prefix for a configured model role selector. */
export const MODEL_ROLE_ALIAS_PREFIX = "@";

/** Legacy prefix accepted for backwards-compatible role selectors. */
export const LEGACY_MODEL_ROLE_ALIAS_PREFIX = "pi/";

/** Shorthand selector for the default model role. */
export const DEFAULT_MODEL_ROLE_ALIAS = "*";

/** Whether a role belongs to the non-chat model-kind section. */
export function isKindRole(role: string): boolean {
	return KIND_ROLE_IDS.some(id => id === role);
}
