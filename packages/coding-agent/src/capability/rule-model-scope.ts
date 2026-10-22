/**
 * Model scoping for rules.
 *
 * Frontmatter selectors restrict a rule to the session's resolved model:
 * - `models`: model globs matched against `provider/id` or the bare `id` (the `enabledModels` grammar)
 * - `providers`: globs matched against `Model.provider`
 * - `class` / `family`: globs matched against `model.identity.class` / `model.identity.family`
 *
 * Every selector accepts a YAML sequence, a single string, or a comma-separated
 * string, and is lowercased. Patterns within one selector are OR'd; selectors
 * are AND'd with each other and with `agents`.
 */
import type { Model } from "@oh-my-pi/pi-ai";
import { modelMatchesGlob } from "../config/model-resolver";
import type { RuleModelScope } from "./rule";

/** Model fields a rule's model selectors read. */
export type RuleScopeModel = Pick<Model, "provider" | "id" | "identity">;

/** Whether the rule declares any model selector. */
export function ruleIsModelScoped(rule: RuleModelScope): boolean {
	return Boolean(rule.models?.length || rule.providers?.length || rule.class?.length || rule.family?.length);
}

/** Whether any rule in `rules` declares a model selector. */
export function anyRuleModelScoped(rules: readonly RuleModelScope[] | undefined): boolean {
	return rules?.some(ruleIsModelScoped) === true;
}

function anyGlobMatches(patterns: readonly string[], value: string | undefined): boolean {
	if (value === undefined) return false;
	const subject = value.toLowerCase();
	return patterns.some(pattern => pattern === subject || new Bun.Glob(pattern).match(subject));
}

/**
 * Whether a rule's model selectors admit `model`. A rule without selectors
 * applies to every model; `model === undefined` disables model scoping
 * (used by CLI inventory listings that must show every rule).
 */
export function ruleAppliesToModel(rule: RuleModelScope, model: RuleScopeModel | undefined): boolean {
	if (model === undefined) return true;
	if (rule.models?.length && !rule.models.some(pattern => modelMatchesGlob(pattern, model))) return false;
	if (rule.providers?.length && !anyGlobMatches(rule.providers, model.provider)) return false;
	if (rule.class?.length && !anyGlobMatches(rule.class, model.identity?.class)) return false;
	if (rule.family?.length && !anyGlobMatches(rule.family, model.identity?.family)) return false;
	return true;
}
