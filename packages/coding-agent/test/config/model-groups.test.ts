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
	it("parses the option-free strategies and least-used's rolling window, defaulting to 24 hours", () => {
		for (const strategy of ["cheapest", "least-loaded", "p2c", "shuffle-bag"] as const) {
			expect(roleGroup("engineer", pool({ strategy })).strategy).toEqual({ name: strategy });
		}
		expect(roleGroup("engineer", pool({ strategy: "least-used" })).strategy).toEqual({
			name: "least-used",
			windowMs: 86_400_000,
		});
		const hourly = pool({
			strategy: "least-used",
			strategyOptions: { window: { type: "rolling", durationMs: 3_600_000 } },
		});
		expect(roleGroup("engineer", hourly).strategy).toEqual({ name: "least-used", windowMs: 3_600_000 });
	});

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
			pool({ strategy: "fastest" }),
			[
				{
					path: "modelRoles.engineer.strategy",
					message:
						'"fastest" is not one of: priority, round-robin, weighted-random, random, quota, cheapest, least-used, least-loaded, p2c, shuffle-bag',
				},
			],
		],
		[
			"a window on a strategy without options",
			pool({ strategy: "cheapest", strategyOptions: { window: { type: "rolling", durationMs: 1000 } } }),
			[{ path: "modelRoles.engineer.strategyOptions.window", message: "unsupported field; supported: none" }],
		],
		[
			"a least-used window that is not rolling or too long",
			pool({ strategy: "least-used", strategyOptions: { window: { type: "calendar", durationMs: 4e10 } } }),
			[
				{ path: "modelRoles.engineer.strategyOptions.window.type", message: 'must be "rolling"' },
				{
					path: "modelRoles.engineer.strategyOptions.window.durationMs",
					message: "must be at most 31536000000 (365 days)",
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
			"a routing limit with a numeric usd max",
			pool({
				routing: { limits: [{ metric: "usd", max: 5, window: { type: "calendar", period: "day" } }] },
			}),
			[
				{
					path: "modelRoles.engineer.routing.limits[0].max",
					message: 'must be a positive quoted decimal amount, such as "5.00"',
				},
			],
		],
		[
			"an unsupported routing field",
			pool({ routing: { maxPoolAttempts: 2 } }),
			[
				{
					path: "modelRoles.engineer.routing.maxPoolAttempts",
					message: "unsupported field; supported: funding, quota, spending, accounts, limits, cache",
				},
			],
		],
		[
			"an unsupported cache field",
			pool({ routing: { cache: { affinity: true, ttlMs: 300_000 } } }),
			[
				{
					path: "modelRoles.engineer.routing.cache.ttlMs",
					message: "unsupported field; supported: affinity, pricing",
				},
			],
		],
		[
			"cache routing without affinity or pricing",
			pool({ routing: { cache: {} } }),
			[{ path: "modelRoles.engineer.routing.cache", message: "set at least one of affinity or pricing" }],
		],
		[
			"a cache affinity that is not a boolean",
			pool({ routing: { cache: { affinity: "yes" } } }),
			[{ path: "modelRoles.engineer.routing.cache.affinity", message: "must be true or false" }],
		],
		[
			"a cache pricing that is not a boolean",
			pool({ routing: { cache: { affinity: true, pricing: 1 } } }),
			[{ path: "modelRoles.engineer.routing.cache.pricing", message: "must be true or false" }],
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

	it("parses cache affinity and pricing on a role pool and a model group", () => {
		expect(roleGroup("engineer", pool({ routing: { cache: { affinity: true } } })).routing?.cache).toEqual({
			affinity: true,
		});
		const result = parseModelGroupDefinition("frontier", pool({ routing: { cache: { affinity: false } } }));
		if (!result.ok) throw new Error(JSON.stringify(result.issues));
		expect(result.value.routing?.cache).toEqual({ affinity: false });
		expect(roleGroup("engineer", pool({ routing: { cache: { pricing: true } } })).routing?.cache).toEqual({
			pricing: true,
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

describe("strategy lists", () => {
	it("parses each listed strategy with the options it consumes, the first one reported as the strategy", () => {
		const group = roleGroup(
			"engineer",
			pool({
				strategy: ["quota", "least-used", "weighted-random"],
				strategyOptions: { tolerance: 0.1, window: { type: "rolling", durationMs: 3_600_000 } },
				models: { opus: { model: OPUS, weight: 3 }, astra: { model: ASTRA } },
			}),
		);
		expect(group.strategies).toEqual([
			{ name: "quota", tolerance: 0.1 },
			{ name: "least-used", windowMs: 3_600_000 },
			{ name: "weighted-random" },
		]);
		expect(group.strategy).toEqual({ name: "quota", tolerance: 0.1 });
		expect(group.models.find(member => member.alias === "opus")?.weight).toBe(3);
		const ordered = roleGroup(
			"engineer",
			pool({ strategy: ["cheapest", "priority"], strategyOptions: { order: ["opus", "astra"] } }),
		);
		expect(ordered.strategies).toEqual([{ name: "cheapest" }, { name: "priority", order: ["opus", "astra"] }]);
	});

	it("parses a single name exactly as a one-entry list", () => {
		const single = roleGroup("engineer", pool({ strategy: "quota" }));
		expect(single.strategies).toEqual([{ name: "quota" }]);
		expect(roleGroup("engineer", pool({ strategy: ["quota"] }))).toEqual(single);
	});

	it.each<[string, unknown, ModelGroupIssue[]]>([
		[
			"a strategy that is not key-based before the last entry",
			pool({ strategy: ["random", "cheapest"] }),
			[
				{
					path: "modelRoles.engineer.strategy[0]",
					message:
						"random may only be the last strategy; entries before it must be quota, cheapest, least-used, least-loaded",
				},
			],
		],
		[
			"p2c as the last entry of a list",
			pool({ strategy: ["least-loaded", "p2c"] }),
			[{ path: "modelRoles.engineer.strategy[1]", message: "p2c cannot be combined with other strategies" }],
		],
		[
			"p2c before another entry",
			pool({ strategy: ["p2c", "cheapest"] }),
			[{ path: "modelRoles.engineer.strategy[0]", message: "p2c cannot be combined with other strategies" }],
		],
		[
			"a strategy listed twice",
			pool({ strategy: ["cheapest", "cheapest"] }),
			[{ path: "modelRoles.engineer.strategy[1]", message: "lists cheapest twice" }],
		],
		[
			"more than four strategies",
			pool({ strategy: ["quota", "cheapest", "least-used", "least-loaded", "random"] }),
			[
				{
					path: "modelRoles.engineer.strategy",
					message: "must be a strategy name or a list of 1 to 4 strategy names",
				},
			],
		],
		[
			"an empty strategy list",
			pool({ strategy: [] }),
			[
				{
					path: "modelRoles.engineer.strategy",
					message: "must be a strategy name or a list of 1 to 4 strategy names",
				},
			],
		],
		[
			"an unknown name in a list",
			pool({ strategy: ["quota", "fastest"] }),
			[
				{
					path: "modelRoles.engineer.strategy[1]",
					message:
						'"fastest" is not one of: priority, round-robin, weighted-random, random, quota, cheapest, least-used, least-loaded, p2c, shuffle-bag',
				},
			],
		],
		[
			"a tolerance without quota",
			pool({ strategy: ["cheapest", "random"], strategyOptions: { tolerance: 0.1 } }),
			[
				{
					path: "modelRoles.engineer.strategyOptions.tolerance",
					message: "applies only when the strategy includes quota",
				},
			],
		],
		[
			"a tolerance of zero",
			pool({ strategy: ["quota", "cheapest"], strategyOptions: { tolerance: 0 } }),
			[{ path: "modelRoles.engineer.strategyOptions.tolerance", message: "must be a number in (0, 0.5]" }],
		],
		[
			"a tolerance above one half",
			pool({ strategy: "quota", strategyOptions: { tolerance: 0.6 } }),
			[{ path: "modelRoles.engineer.strategyOptions.tolerance", message: "must be a number in (0, 0.5]" }],
		],
		[
			"an option no listed strategy consumes",
			pool({ strategy: ["quota", "cheapest"], strategyOptions: { order: ["opus", "astra"] } }),
			[
				{
					path: "modelRoles.engineer.strategyOptions.order",
					message: "unsupported field; supported: objective, capacityMetric, tolerance",
				},
			],
		],
		[
			"a priority last entry without order",
			pool({ strategy: ["quota", "priority"] }),
			[
				{
					path: "modelRoles.engineer.strategyOptions",
					message: "priority requires order listing every member alias exactly once",
				},
			],
		],
		[
			"a member weight without weighted-random in the list",
			pool({ strategy: ["cheapest", "random"], models: { opus: { model: OPUS, weight: 2 } } }),
			[{ path: "modelRoles.engineer.models.opus.weight", message: "applies only to strategy weighted-random" }],
		],
	])("rejects %s", (_label, value, issues) => {
		expect(roleIssues("engineer", value)).toEqual(issues);
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
