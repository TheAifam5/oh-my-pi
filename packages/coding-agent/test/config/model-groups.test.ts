import { describe, expect, it } from "bun:test";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import {
	type ModelGroup,
	type ModelGroupIssue,
	parseModelGroupDefinition,
	parseModelRoleValue,
} from "@oh-my-pi/pi-coding-agent/config/model-groups";
const ASTRA = "openai-codex/gpt-6-astra";
const OPUS = "anthropic/claude-opus-5-5";

function pool(extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		strategy: "random",
		models: { opus: { model: OPUS }, astra: { model: ASTRA } },
		...extra,
	};
}

function roleIssues(role: string, value: unknown): readonly ModelGroupIssue[] {
	const result = parseModelRoleValue(role, value);
	if (result.ok) throw new Error(`expected ${role} to be rejected`);
	return result.issues;
}

function roleGroup(role: string, value: unknown): ModelGroup {
	const result = parseModelRoleValue(role, value);
	if (!result.ok) throw new Error(JSON.stringify(result.issues));
	if (result.value.kind !== "group") throw new Error(`expected a group, got ${result.value.kind}`);
	return result.value.group;
}

describe("modelRoles values (strict)", () => {
	it("returns legacy strings and lists verbatim", () => {
		const list = ["anthropic/claude-opus:high", "@smol"];
		const listResult = parseModelRoleValue("engineer", list);
		expect(listResult.ok && listResult.value.kind === "list" && listResult.value.value).toBe(list);
		expect(parseModelRoleValue("engineer", "anthropic/claude-opus:high,@slow")).toEqual({
			ok: true,
			value: { kind: "selector", value: "anthropic/claude-opus:high,@slow" },
			warnings: [],
		});
	});

	it("treats an entry-level null as clear", () => {
		expect(parseModelRoleValue("engineer", null)).toEqual({ ok: true, value: { kind: "clear" }, warnings: [] });
	});

	it("parses references in object and shorthand form", () => {
		expect(parseModelRoleValue("engineer", { use: "frontier", profile: "deep" })).toEqual({
			ok: true,
			value: { kind: "ref", ref: { use: "frontier", profile: "deep" }, shorthand: false },
			warnings: [],
		});
		expect(parseModelRoleValue("engineer", "+frontier@deep")).toEqual({
			ok: true,
			value: { kind: "ref", ref: { use: "frontier", profile: "deep" }, shorthand: true },
			warnings: [],
		});
	});

	it.each<[string, unknown, ModelGroupIssue[]]>([
		[
			"spending without metered funding",
			pool({ routing: { funding: { order: ["included"] }, spending: { policy: "provider-managed" } } }),
			[{ path: "modelRoles.engineer.routing.spending", message: "applies only when funding includes metered" }],
		],
		[
			"metered funding without spending",
			pool({ routing: { funding: { order: ["included", "metered"] } } }),
			[
				{
					path: "modelRoles.engineer.routing",
					message:
						"funding includes metered, which requires spending.policy: provider-managed or local-hard-budget",
				},
			],
		],
		[
			"a strategy that is not implemented",
			pool({ strategy: "cheapest" }),
			[
				{
					path: "modelRoles.engineer.strategy",
					message: '"cheapest" is not one of: priority, round-robin, weighted-random, random, quota',
				},
			],
		],
		[
			"a quota option that is not implemented",
			pool({ strategy: "quota", strategyOptions: { objective: "drain-before-reset" } }),
			[
				{
					path: "modelRoles.engineer.strategyOptions.objective",
					message: '"drain-before-reset" is not one of: balance',
				},
			],
		],
		[
			"routing limits",
			pool({ routing: { limits: { maxPoolAttempts: 2 } } }),
			[
				{
					path: "modelRoles.engineer.routing.limits",
					message: "unsupported field; supported: funding, quota, spending, accounts",
				},
			],
		],
		...(
			[
				[
					"an empty account order",
					{ order: [] },
					"order",
					"must be a non-empty list of account names matching ^[a-z0-9][a-z0-9_-]*$",
				],
				[
					"an account order that is not a list",
					{ order: "work" },
					"order",
					"must be a non-empty list of account names matching ^[a-z0-9][a-z0-9_-]*$",
				],
				["an unknown spend class", { spend: ["gold"] }, "spend", "must be a list of plan, credits, money"],
				["empty account routing", {}, "", "must set at least one of order, drain, spend, returnWhen"],
				[
					"account routing that is not a mapping",
					"work",
					"",
					"expected a mapping with order, drain, spend, returnWhen",
				],
			] as const
		).map(([name, accounts, field, message]): [string, unknown, ModelGroupIssue[]] => [
			name,
			pool({ routing: { accounts } }),
			[{ path: `modelRoles.engineer.routing.accounts${field ? `.${field}` : ""}`, message }],
		]),
		[
			"account routing with a repeated, malformed, or unfunded entry",
			pool({ routing: { accounts: { order: ["work", "work"], drain: "Work", returnWhen: "credits-added" } } }),
			[
				{ path: "modelRoles.engineer.routing.accounts.order", message: "lists an account twice" },
				{
					path: "modelRoles.engineer.routing.accounts.drain",
					message: "must be one of the account names matching ^[a-z0-9][a-z0-9_-]*$",
				},
				{
					path: "modelRoles.engineer.routing.accounts.returnWhen",
					message: "credits-added requires spend to include credits",
				},
			],
		],
		[
			"a local hard budget without a budget",
			pool({ routing: { funding: { order: ["metered"] }, spending: { policy: "local-hard-budget" } } }),
			[{ path: "modelRoles.engineer.routing.spending", message: "local-hard-budget requires a budget" }],
		],
		[
			"a malformed budget",
			pool({
				routing: {
					funding: { order: ["metered"] },
					spending: {
						policy: "local-hard-budget",
						budget: {
							id: "Team",
							currency: "EUR",
							perRequestMax: 0.25,
							window: { type: "fixed", durationMs: 86_400_000, maxSpend: "10" },
						},
					},
				},
			}),
			[
				{
					path: "modelRoles.engineer.routing.spending.budget.id",
					message: 'budget id "Team" must match ^[a-z0-9][a-z0-9_-]*$',
				},
				{ path: "modelRoles.engineer.routing.spending.budget.currency", message: 'must be "USD"' },
				{
					path: "modelRoles.engineer.routing.spending.budget.perRequestMax",
					message:
						'must be a quoted decimal amount with at most 12 integer and 9 fractional digits, such as "0.25"',
				},
				{ path: "modelRoles.engineer.routing.spending.budget.window.type", message: 'must be "rolling"' },
			],
		],
		[
			"a per-request maximum above the window maximum",
			pool({
				routing: {
					funding: { order: ["metered"] },
					spending: {
						policy: "local-hard-budget",
						budget: {
							id: "team",
							currency: "USD",
							perRequestMax: "2",
							window: { type: "rolling", durationMs: 86_400_000, maxSpend: "1" },
						},
					},
				},
			}),
			[{ path: "modelRoles.engineer.routing.spending.budget", message: "perRequestMax exceeds window.maxSpend" }],
		],
	])("rejects %s", (_name, value, expected) => {
		expect(roleIssues("engineer", value)).toEqual(expected);
	});

	it("accepts a local hard budget on metered funding", () => {
		const budget = {
			id: "team",
			currency: "USD",
			perRequestMax: "0.25",
			window: { type: "rolling", durationMs: 86_400_000, maxSpend: "10.5" },
		} as const;
		const group = roleGroup(
			"engineer",
			pool({
				routing: {
					funding: { order: ["included", "metered"] },
					spending: { policy: "local-hard-budget", budget },
				},
			}),
		);
		expect(group.routing?.spending).toEqual({ policy: "local-hard-budget", budget });
	});

	it("parses account routing and normalizes a single returnWhen to a list", () => {
		const group = roleGroup(
			"engineer",
			pool({
				routing: {
					accounts: { order: ["work", "home"], drain: "home", spend: ["credits"], returnWhen: "credits-added" },
				},
			}),
		);
		expect(group.routing?.accounts).toEqual({
			order: ["work", "home"],
			drain: "home",
			spend: ["credits"],
			returnWhen: ["credits-added"],
		});
	});

	it("reports every problem of one value, not just the first", () => {
		expect(
			roleIssues("engineer", {
				strategy: "priority",
				strategyOptions: { order: ["astra"] },
				models: { astra: { model: "openai/*" }, opus: { model: OPUS, weight: 1, extra: true } },
			}),
		).toEqual([
			{
				path: "modelRoles.engineer.models.astra.model",
				message: "must be a concrete model, not a wildcard pattern",
			},
			{
				path: "modelRoles.engineer.models.opus.extra",
				message: "unsupported field; supported: model, defaultEffort, weight, account",
			},
			{ path: "modelRoles.engineer.models.opus.weight", message: "applies only to strategy weighted-random" },
			{
				path: "modelRoles.engineer.strategyOptions.order",
				message: "must list every alias exactly once; missing: opus",
			},
		]);
	});

	it.each([
		["inline group", pool()],
		["object reference", { use: "frontier" }],
		["shorthand reference", "+frontier"],
	])("rejects a %s on a kind role that is not pool-capable", (_name, value) => {
		expect(roleIssues("speech", value)).toEqual([
			{
				path: "modelRoles.speech",
				message:
					"speech takes a model selector or list; model groups are supported only for chat roles, judge and image",
			},
		]);
	});

	it.each(["judge", "image"])("accepts groups and references on the %s kind role", role => {
		expect(roleGroup(role, pool()).models.map(model => model.alias)).toEqual(["astra", "opus"]);
		expect(parseModelRoleValue(role, "+frontier@deep").ok).toBe(true);
	});

	it("accepts legacy selectors on a kind role that is not pool-capable", () => {
		expect(parseModelRoleValue("speech", "openai/gpt-tts").ok).toBe(true);
	});
});

describe("tolerant loading", () => {
	it("skips only the bad member and drops it from order and profiles", () => {
		const result = parseModelRoleValue(
			"engineer",
			pool({
				strategy: "priority",
				strategyOptions: { order: ["bad", "opus", "astra"] },
				models: { opus: { model: OPUS }, astra: { model: ASTRA }, bad: { model: "openai/*" } },
				profiles: { deep: { bad: { effort: "high" }, opus: { effort: "high" } } },
			}),
			"tolerant",
		);
		if (!result.ok || result.value.kind !== "group") throw new Error("expected a group");
		expect(result.value.group.strategy).toEqual({ name: "priority", order: ["opus", "astra"] });
		expect(result.value.group.models.map(member => member.alias)).toEqual(["astra", "opus"]);
		expect(result.value.group.profiles.get("deep")?.models).toEqual(new Map([["opus", { effort: Effort.High }]]));
		expect(result.warnings).toEqual([
			{
				path: "modelRoles.engineer.models.bad.model",
				message: "must be a concrete model, not a wildcard pattern; member skipped",
			},
		]);
	});
});

describe("reserved names", () => {
	function definitionIssues(name: string, value: unknown): readonly ModelGroupIssue[] {
		const result = parseModelGroupDefinition(name, value);
		if (result.ok) throw new Error(`expected ${name} to be rejected`);
		return result.issues;
	}

	it.each(["constructor", "prototype", "__proto__"])("rejects the reserved name %j", name => {
		expect(definitionIssues(name, pool()).map(issue => issue.path)).toContain(`modelGroups.${name}`);
		expect(roleIssues(name, pool()).map(issue => issue.path)).toContain(`modelRoles.${name}`);
		expect(definitionIssues("g", { strategy: "random", models: { [name]: { model: OPUS } } }).length).toBe(1);
	});
});
