import { describe, expect, it } from "bun:test";
import { classifyModel } from "@oh-my-pi/pi-catalog/identity";
import type { RuleModelScope } from "@oh-my-pi/pi-coding-agent/capability/rule";
import {
	anyRuleModelScoped,
	type RuleScopeModel,
	ruleAppliesToModel,
} from "@oh-my-pi/pi-coding-agent/capability/rule-model-scope";
import { buildRuleFromMarkdown, createSourceMeta } from "@oh-my-pi/pi-coding-agent/discovery/helpers";

function scopeModel(spec: string): RuleScopeModel {
	const slash = spec.indexOf("/");
	const provider = spec.slice(0, slash);
	const id = spec.slice(slash + 1);
	return { provider, id, identity: classifyModel(provider, id, { lenient: true }) };
}

function applies(scope: RuleModelScope, spec: string): boolean {
	return ruleAppliesToModel(scope, scopeModel(spec));
}

function parse(frontmatter: string) {
	return buildRuleFromMarkdown(
		"scoped.md",
		`---\n${frontmatter}\n---\nbody`,
		"scoped.md",
		createSourceMeta("test", "scoped.md", "project"),
	);
}

describe("model selector frontmatter normalization", () => {
	it("lowercases a YAML sequence", () => {
		const rule = parse(`models: [Claude-Opus-5, "*/claude-opus-5"]`);
		expect(rule.models).toEqual(["claude-opus-5", "*/claude-opus-5"]);
	});

	it("splits comma-separated strings for every selector", () => {
		const rule = parse(`providers: "Anthropic, openai-*"\nclass: "anthropic"\nfamily: "opus, sonnet"`);
		expect(rule.providers).toEqual(["anthropic", "openai-*"]);
		expect(rule.class).toEqual(["anthropic"]);
		expect(rule.family).toEqual(["opus", "sonnet"]);
		expect(rule.models).toBeUndefined();
	});

	it("keeps `{a, b}` glob groups intact", () => {
		expect(parse(`models: "{claude-opus-5, claude-sonnet-5}"`).models).toEqual(["{claude-opus-5,claude-sonnet-5}"]);
	});

	it("normalizes an empty list to undefined and reports the rule as unscoped", () => {
		const rule = parse("models: []");
		expect(rule.models).toBeUndefined();
		expect(anyRuleModelScoped([rule])).toBe(false);
		expect(anyRuleModelScoped([rule, parse("family: opus")])).toBe(true);
	});
});

describe("ruleAppliesToModel", () => {
	it("`*/claude-opus-5` matches claude-opus-5 on any provider, including routed ids, and no revision variants", () => {
		const scope = { models: ["*/claude-opus-5"] };
		expect(applies(scope, "anthropic/claude-opus-5")).toBe(true);
		// Routed id `anthropic/claude-opus-5` matches through the bare-id comparison.
		expect(applies(scope, "openrouter/anthropic/claude-opus-5")).toBe(true);
		expect(applies(scope, "anthropic/claude-opus-5-5")).toBe(false);
		expect(applies(scope, "anthropic/claude-opus-5-1")).toBe(false);
		expect(applies(scope, "openrouter/anthropic/claude-opus-5-5")).toBe(false);
	});

	it("matches the gpt-6 / gpt-6.1 / daybreak globs and rejects neighbouring ids", () => {
		const scope = { models: ["*/gpt-6", "*/gpt-6-*", "*/gpt-6.1", "*/gpt-6.1-*", "*/gpt-daybreak-*"] };
		expect(applies(scope, "openai-codex/gpt-6-sol")).toBe(true);
		expect(applies(scope, "openai/gpt-6.1-sol")).toBe(true);
		expect(applies(scope, "openrouter/openai/gpt-6-luna")).toBe(true);
		expect(applies(scope, "openai-codex/gpt-daybreak-blue-latest")).toBe(true);
		expect(applies(scope, "openai-codex/gpt-6.2-x")).toBe(false);
		expect(applies(scope, "openai-codex/gpt-60")).toBe(false);
		expect(applies(scope, "openai-codex/gpt-image-2")).toBe(false);
	});

	it("`**/claude-*` reaches a routed id and `provider/*` pins the provider", () => {
		expect(applies({ models: ["**/claude-*"] }, "openrouter/anthropic/claude-opus-5")).toBe(true);
		expect(applies({ models: ["anthropic/*"] }, "anthropic/claude-opus-5")).toBe(true);
		expect(applies({ models: ["openai/*"] }, "anthropic/claude-opus-5")).toBe(false);
	});

	it("matches case-insensitively against provider/id", () => {
		expect(applies({ models: ["anthropic/claude-*"] }, "Anthropic/Claude-Opus-5")).toBe(true);
	});

	it("matches providers globs against Model.provider", () => {
		expect(applies({ providers: ["openai*"] }, "openai-codex/gpt-6-sol")).toBe(true);
		expect(applies({ providers: ["openai"] }, "openai-codex/gpt-6-sol")).toBe(false);
	});

	it("matches class and family against the classified identity across providers", () => {
		const opusFamily = { class: ["anthropic"], family: ["opus"] };
		expect(applies(opusFamily, "anthropic/claude-opus-5")).toBe(true);
		expect(applies(opusFamily, "openrouter/anthropic/claude-opus-5")).toBe(true);
		expect(applies(opusFamily, "anthropic/claude-sonnet-5")).toBe(false);
		expect(applies({ class: ["openai"] }, "anthropic/claude-opus-5")).toBe(false);
	});

	it("ORs patterns within a selector and ANDs selectors", () => {
		const scope = { models: ["claude-opus-*", "gpt-5*"], providers: ["anthropic"] };
		expect(applies(scope, "anthropic/claude-opus-5")).toBe(true);
		expect(applies(scope, "openai/gpt-5.5")).toBe(false);
	});

	it("applies to every model without selectors, and to an undefined model with selectors", () => {
		expect(applies({}, "openai/gpt-5.5")).toBe(true);
		expect(ruleAppliesToModel({ models: ["gpt-*"] }, undefined)).toBe(true);
	});
});
