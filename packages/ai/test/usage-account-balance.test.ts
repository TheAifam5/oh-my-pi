import { afterEach, describe, expect, it } from "bun:test";
import { isUsageLimitReached } from "@oh-my-pi/pi-ai/auth/usage-report";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import type { UsageProvider } from "@oh-my-pi/pi-ai/usage";
import { aimlapiBilling, aimlapiUsageProvider } from "@oh-my-pi/pi-ai/usage/aimlapi";
import type { BillingResult, ProviderBilling } from "@oh-my-pi/pi-ai/usage/billing";
import { deepinfraBilling, deepinfraUsageProvider } from "@oh-my-pi/pi-ai/usage/deepinfra";
import { deepseekBilling, deepseekUsageProvider } from "@oh-my-pi/pi-ai/usage/deepseek";
import { moonshotBilling, moonshotUsageProvider } from "@oh-my-pi/pi-ai/usage/moonshot";
import { nanogptBilling, nanogptUsageProvider } from "@oh-my-pi/pi-ai/usage/nanogpt";
import { novitaBilling, novitaUsageProvider } from "@oh-my-pi/pi-ai/usage/novita";
import { siliconflowBilling, siliconflowUsageProvider } from "@oh-my-pi/pi-ai/usage/siliconflow";
import { veniceBilling, veniceUsageProvider } from "@oh-my-pi/pi-ai/usage/venice";
import { vercelAiGatewayBilling, vercelAiGatewayUsageProvider } from "@oh-my-pi/pi-ai/usage/vercel-ai-gateway";

const KEY = "sk-test";
const usd = (amountMinor: number) => ({ amountMinor, currency: "USD" });
const credits = (amountMinor: number, exponent = 0) => ({ amountMinor, exponent });

type Seen = { url: string; method: string; headers: Headers; redirect?: RequestInit["redirect"] };

async function fetchReport(
	provider: UsageProvider,
	body: unknown,
	options: { status?: number; baseUrl?: string; headers?: Record<string, string> } = {},
) {
	const seen: Seen[] = [];
	const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		seen.push({
			url: String(input),
			method: init?.method ?? "GET",
			headers: new Headers(init?.headers),
			redirect: init?.redirect,
		});
		return new Response(JSON.stringify(body), { status: options.status ?? 200, headers: options.headers });
	}) as unknown as FetchImpl;
	const report = await provider.fetchUsage(
		{
			provider: provider.id,
			credential: { type: "api_key", apiKey: KEY },
			...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
		},
		{ fetch },
	);
	return { report, seen };
}

async function billingOf(provider: UsageProvider, reader: ProviderBilling, body: unknown) {
	const { report } = await fetchReport(provider, body);
	if (!report) throw new Error("fixture did not parse");
	return sources(reader.readBilling(report));
}

function sources(result: BillingResult) {
	if (result.status !== "known") throw new Error(`expected known billing, got ${result.reason}`);
	return result.snapshot.sources;
}

function bearer(seen: Seen[]) {
	return seen.map(({ url, method, headers }) => ({ url, method, authorization: headers.get("authorization") }));
}

describe("DeepSeek balance", () => {
	/** Documentation-derived: https://api-docs.deepseek.com/api/get-user-balance */
	const documented = {
		is_available: true,
		balance_infos: [
			{ currency: "CNY", total_balance: "110.00", granted_balance: "10.00", topped_up_balance: "100.00" },
		],
	};

	it("reads each currency balance as exact prepaid money", async () => {
		const { report, seen } = await fetchReport(deepseekUsageProvider, documented);
		expect(bearer(seen)).toEqual([
			{ url: "https://api.deepseek.com/user/balance", method: "GET", authorization: `Bearer ${KEY}` },
		]);
		expect(report?.limits).toMatchObject([
			{
				id: "deepseek:balance:cny",
				amount: { remaining: 110, unit: "unknown", currency: "CNY" },
				scope: { shared: true },
			},
		]);
		const both = {
			is_available: true,
			balance_infos: [...documented.balance_infos, { currency: "USD", total_balance: "0.00" }],
		};
		expect(await billingOf(deepseekUsageProvider, deepseekBilling, both)).toEqual([
			{
				mode: "prepaid-credits",
				state: "available",
				allowance: { kind: "money", remaining: { amountMinor: 11000, currency: "CNY" } },
			},
			{ mode: "prepaid-credits", state: "exhausted", allowance: { kind: "money", remaining: usd(0) } },
		]);
	});

	it("marks every balance exhausted when the account is unavailable", async () => {
		const unavailable = { ...documented, is_available: false };
		const { report } = await fetchReport(deepseekUsageProvider, unavailable);
		expect(report?.limits[0]?.status).toBe("exhausted");
		expect((await billingOf(deepseekUsageProvider, deepseekBilling, unavailable))[0]?.state).toBe("exhausted");
	});

	it("rejects an undocumented currency or a numeric amount", async () => {
		const euro = { is_available: true, balance_infos: [{ currency: "EUR", total_balance: "1.00" }] };
		const numeric = { is_available: true, balance_infos: [{ currency: "USD", total_balance: 1 }] };
		expect((await fetchReport(deepseekUsageProvider, euro)).report).toBeNull();
		expect((await fetchReport(deepseekUsageProvider, numeric)).report).toBeNull();
		const empty = { is_available: true, balance_infos: [] };
		expect((await fetchReport(deepseekUsageProvider, empty)).report).toBeNull();
	});

	it("purges a rejected key and leaves server errors transient", async () => {
		await expect(fetchReport(deepseekUsageProvider, { error: "invalid" }, { status: 401 })).rejects.toThrow(
			"DeepSeek api.deepseek.com/user/balance returned 401",
		);
		expect((await fetchReport(deepseekUsageProvider, documented, { status: 403 })).report).toBeNull();
		expect((await fetchReport(deepseekUsageProvider, documented, { status: 500 })).report).toBeNull();
	});

	it("refuses to follow a redirect", async () => {
		const { report, seen } = await fetchReport(deepseekUsageProvider, documented, {
			status: 302,
			headers: { Location: "https://attacker.example/collect" },
		});
		expect(report).toBeNull();
		expect(seen.map(request => [request.url, request.redirect])).toEqual([
			["https://api.deepseek.com/user/balance", "error"],
		]);
	});

	it("accepts the default inference base URL", async () => {
		const { report } = await fetchReport(deepseekUsageProvider, documented, { baseUrl: "https://api.deepseek.com/" });
		expect(report?.limits).toHaveLength(1);
	});
});

describe("Moonshot balance", () => {
	const originalBaseUrl = Bun.env.MOONSHOT_BASE_URL;
	afterEach(() => {
		if (originalBaseUrl === undefined) delete Bun.env.MOONSHOT_BASE_URL;
		else Bun.env.MOONSHOT_BASE_URL = originalBaseUrl;
	});

	/** Documentation-derived: https://platform.kimi.ai/docs/api/balance */
	const documented = {
		code: 0,
		data: { available_balance: 49.58894, voucher_balance: 46.58893, cash_balance: 3.00001 },
		scode: "0x0",
		status: true,
	};

	it("reads the available balance as prepaid money rounded down", async () => {
		const { report, seen } = await fetchReport(moonshotUsageProvider, documented);
		expect(bearer(seen)).toEqual([
			{ url: "https://api.moonshot.ai/v1/users/me/balance", method: "GET", authorization: `Bearer ${KEY}` },
		]);
		expect(report?.metadata).toEqual({ voucherBalanceUsd: 46.58893, cashBalanceUsd: 3.00001 });
		expect(await billingOf(moonshotUsageProvider, moonshotBilling, documented)).toEqual([
			{ mode: "prepaid-credits", state: "available", allowance: { kind: "money", remaining: usd(4958) } },
		]);
	});

	it("marks a debt exhausted with nothing remaining", async () => {
		const debt = { ...documented, data: { available_balance: -1.5, voucher_balance: 0, cash_balance: -1.5 } };
		const { report } = await fetchReport(moonshotUsageProvider, debt);
		expect(report?.limits[0]).toMatchObject({ amount: { remaining: 0 }, status: "exhausted" });
		expect((await billingOf(moonshotUsageProvider, moonshotBilling, debt))[0]?.state).toBe("exhausted");
		const zero = { ...documented, data: { available_balance: 0 } };
		expect((await fetchReport(moonshotUsageProvider, zero)).report?.limits[0]?.status).toBe("exhausted");
	});

	it("rejects an error envelope", async () => {
		expect((await fetchReport(moonshotUsageProvider, { ...documented, code: 1 })).report).toBeNull();
		expect((await fetchReport(moonshotUsageProvider, { ...documented, status: false })).report).toBeNull();
	});

	it("never sends the key to the China platform", async () => {
		const { report, seen } = await fetchReport(moonshotUsageProvider, documented, {
			baseUrl: "https://api.moonshot.cn/v1",
		});
		expect(report).toBeNull();
		expect(seen).toEqual([]);
	});

	it("never sends the key when MOONSHOT_BASE_URL points inference at the China platform", async () => {
		Bun.env.MOONSHOT_BASE_URL = "https://api.moonshot.cn/v1";
		const { report, seen } = await fetchReport(moonshotUsageProvider, documented);
		expect(report).toBeNull();
		expect(seen).toEqual([]);
		const explicit = await fetchReport(moonshotUsageProvider, documented, { baseUrl: "https://api.moonshot.ai/v1" });
		expect(explicit.seen).toEqual([]);
	});
});

describe("Novita balance", () => {
	/** Documentation-derived: https://docs.novita.ai/api-reference/basic-get-user-balance.md */
	const documented = {
		availableBalance: "1000000",
		cashBalance: "800000",
		creditLimit: "200000",
		pendingCharges: "0",
		outstandingInvoices: "0",
	};

	it("reads the cash balance in 1/10000 USD as exact prepaid money, without the credit line", async () => {
		const { report, seen } = await fetchReport(novitaUsageProvider, documented);
		expect(bearer(seen)).toEqual([
			{
				url: "https://api.novita.ai/openapi/v1/billing/balance/detail",
				method: "GET",
				authorization: `Bearer ${KEY}`,
			},
		]);
		expect(report?.metadata).toEqual({
			availableBalanceUsd: 100,
			creditLimitUsd: 20,
			pendingChargesUsd: 0,
			outstandingInvoicesUsd: 0,
		});
		expect(await billingOf(novitaUsageProvider, novitaBilling, documented)).toEqual([
			{ mode: "prepaid-credits", state: "available", allowance: { kind: "money", remaining: usd(8000) } },
		]);
		const odd = { ...documented, cashBalance: "123456" };
		expect(await billingOf(novitaUsageProvider, novitaBilling, odd)).toEqual([
			{ mode: "prepaid-credits", state: "available", allowance: { kind: "money", remaining: usd(1234) } },
		]);
		const empty = { ...documented, cashBalance: "0" };
		expect((await billingOf(novitaUsageProvider, novitaBilling, empty))[0]?.state).toBe("exhausted");
	});

	it("rejects a non-integer amount", async () => {
		expect((await fetchReport(novitaUsageProvider, { ...documented, cashBalance: "0x2710" })).report).toBeNull();
		expect((await fetchReport(novitaUsageProvider, { ...documented, cashBalance: 100 })).report).toBeNull();
	});
});

describe("AI/ML API balance", () => {
	/** Documentation-derived: https://docs.aimlapi.com/api-references/service-endpoints/account-balance.md */
	const documented = { current_balance: 150.5, currency: "USD" };

	it("reads the USD balance as prepaid money", async () => {
		const { seen } = await fetchReport(aimlapiUsageProvider, documented);
		expect(bearer(seen)).toEqual([
			{ url: "https://api.aimlapi.com/v2/billing", method: "GET", authorization: `Bearer ${KEY}` },
		]);
		expect(await billingOf(aimlapiUsageProvider, aimlapiBilling, documented)).toEqual([
			{ mode: "prepaid-credits", state: "available", allowance: { kind: "money", remaining: usd(15050) } },
		]);
		const empty = { ...documented, current_balance: 0 };
		expect((await billingOf(aimlapiUsageProvider, aimlapiBilling, empty))[0]?.state).toBe("exhausted");
	});

	it("rejects a balance in another currency", async () => {
		expect((await fetchReport(aimlapiUsageProvider, { ...documented, currency: "EUR" })).report).toBeNull();
	});
});

describe("NanoGPT balance", () => {
	/** Documentation-derived: https://docs.nano-gpt.com/api-reference/endpoint/check-balance */
	const documented = {
		usd_balance: "129.46956147",
		nano_balance: "26.71801147",
		nanoDepositAddress: "nano_1gx385nnj7rw67hsksa3pyxwnfr48zu13t35ncjmtnqb9zdebtjhh7ahks34",
	};

	it("posts with x-api-key and reads only the USD balance", async () => {
		const { report, seen } = await fetchReport(nanogptUsageProvider, documented);
		expect(
			seen.map(({ url, method, headers }) => [url, method, headers.get("x-api-key"), headers.get("authorization")]),
		).toEqual([["https://api.nano-gpt.com/api/check-balance", "POST", KEY, null]]);
		expect(JSON.stringify(report)).not.toContain("nano_1");
		expect(await billingOf(nanogptUsageProvider, nanogptBilling, documented)).toEqual([
			{ mode: "prepaid-credits", state: "available", allowance: { kind: "money", remaining: usd(12946) } },
		]);
	});

	it("rejects a non-string balance", async () => {
		expect((await fetchReport(nanogptUsageProvider, { usd_balance: 12.5 })).report).toBeNull();
	});
});

describe("Vercel AI Gateway credits", () => {
	/** Documentation-derived: https://vercel.com/docs/ai-gateway/sdks-and-apis/rest-api */
	const documented = { balance: "95.50", total_used: "4.50" };

	it("reads the credit balance as prepaid money and keeps lifetime spend out of the limit", async () => {
		const { report, seen } = await fetchReport(vercelAiGatewayUsageProvider, documented);
		expect(bearer(seen)).toEqual([
			{ url: "https://ai-gateway.vercel.sh/v1/credits", method: "GET", authorization: `Bearer ${KEY}` },
		]);
		expect(report?.limits[0]?.amount).toEqual({ remaining: 95.5, unit: "usd" });
		expect(report?.metadata).toEqual({ totalUsedUsd: 4.5 });
		expect(await billingOf(vercelAiGatewayUsageProvider, vercelAiGatewayBilling, documented)).toEqual([
			{ mode: "prepaid-credits", state: "available", allowance: { kind: "money", remaining: usd(9550) } },
		]);
	});

	it("rejects a numeric balance", async () => {
		expect((await fetchReport(vercelAiGatewayUsageProvider, { balance: 95.5 })).report).toBeNull();
	});
});

describe("Venice balance", () => {
	/** Documentation-derived: https://docs.venice.ai/api-reference/endpoint/billing/balance */
	const documented = {
		canConsume: true,
		consumptionCurrency: "DIEM",
		balances: { diem: 90.5, usd: 25, bundledCredits: 10, earnedCredits: 5 },
		diemEpochAllocation: 100,
	};

	it("reads every balance, the consumed currency first", async () => {
		const { seen } = await fetchReport(veniceUsageProvider, documented);
		expect(bearer(seen)).toEqual([
			{ url: "https://api.venice.ai/api/v1/billing/balance", method: "GET", authorization: `Bearer ${KEY}` },
		]);
		expect(await billingOf(veniceUsageProvider, veniceBilling, documented)).toEqual([
			{
				mode: "prepaid-credits",
				state: "available",
				allowance: { kind: "credits", limit: credits(100), remaining: credits(905, 1) },
			},
			{ mode: "prepaid-credits", state: "available", allowance: { kind: "money", remaining: usd(2500) } },
			{ mode: "prepaid-credits", state: "available", allowance: { kind: "credits", remaining: credits(10) } },
			{ mode: "prepaid-credits", state: "available", allowance: { kind: "credits", remaining: credits(5) } },
		]);
	});

	it("marks every balance exhausted when the account cannot consume", async () => {
		const blocked = {
			...documented,
			canConsume: false,
			consumptionCurrency: null,
			balances: { diem: 140, usd: null, bundledCredits: 3, earnedCredits: null },
		};
		const { report } = await fetchReport(veniceUsageProvider, blocked);
		expect(report?.limits.map(limit => [limit.id, limit.amount.remaining, limit.status])).toEqual([
			["venice:diem", 140, "exhausted"],
			["venice:bundled-credits", 3, "exhausted"],
		]);
		const states = (await billingOf(veniceUsageProvider, veniceBilling, blocked)).map(source => source.state);
		expect(states).toEqual(["exhausted", "exhausted"]);
	});

	it("keeps DIEM available without an epoch allocation while the account can consume", async () => {
		const unallocated = { ...documented, balances: { diem: 5 }, diemEpochAllocation: 0 };
		expect(await billingOf(veniceUsageProvider, veniceBilling, unallocated)).toEqual([
			{ mode: "prepaid-credits", state: "available", allowance: { kind: "credits", remaining: credits(5) } },
		]);
	});

	it("treats a 401 as transient and stays out of credential health checks", async () => {
		expect(veniceUsageProvider.validatesCredentials).toBe(false);
		expect((await fetchReport(veniceUsageProvider, { error: "unauthorized" }, { status: 401 })).report).toBeNull();
	});

	it("rejects a payload without a verdict or any balance", async () => {
		const { canConsume: _verdict, ...noVerdict } = documented;
		expect((await fetchReport(veniceUsageProvider, noVerdict)).report).toBeNull();
		const noBalance = { ...documented, balances: { diem: null, usd: null } };
		expect((await fetchReport(veniceUsageProvider, noBalance)).report).toBeNull();
	});
});

describe("SiliconFlow balance", () => {
	/** Documentation-derived: https://docs.siliconflow.com/en/api-reference/userinfo/get-user-info */
	const documented = {
		code: 20000,
		message: "OK",
		status: true,
		data: { id: "userid", balance: "0.88", status: "normal", chargeBalance: "88.00", totalBalance: "88.88" },
	};

	it("reads the total balance as exact credits, never as money", async () => {
		const { report, seen } = await fetchReport(siliconflowUsageProvider, documented);
		expect(bearer(seen)).toEqual([
			{ url: "https://api.siliconflow.com/v1/user/info", method: "GET", authorization: `Bearer ${KEY}` },
		]);
		expect(report?.metadata).toEqual({});
		expect(await billingOf(siliconflowUsageProvider, siliconflowBilling, documented)).toEqual([
			{ mode: "prepaid-credits", state: "available", allowance: { kind: "credits", remaining: credits(8888, 2) } },
		]);
		const debt = { ...documented, data: { ...documented.data, totalBalance: "-1.50" } };
		expect(await billingOf(siliconflowUsageProvider, siliconflowBilling, debt)).toEqual([
			{ mode: "prepaid-credits", state: "exhausted", allowance: { kind: "credits", remaining: credits(0) } },
		]);
	});

	it("keeps a zero balance from blocking the credential while billing reads it as exhausted", async () => {
		const zero = { ...documented, data: { ...documented.data, totalBalance: "0.00" } };
		const { report } = await fetchReport(siliconflowUsageProvider, zero);
		if (!report) throw new Error("fixture did not parse");
		expect(isUsageLimitReached(report.limits)).toBe(false);
		expect(sources(siliconflowBilling.readBilling(report))).toEqual([
			{ mode: "prepaid-credits", state: "exhausted", allowance: { kind: "credits", remaining: credits(0) } },
		]);
	});

	it("rejects an error envelope or a non-decimal balance", async () => {
		const rejected = [
			{ ...documented, code: 20001 },
			{ ...documented, status: false },
			{ ...documented, data: { ...documented.data, totalBalance: 88.88 } },
			{ ...documented, data: { ...documented.data, totalBalance: "abc" } },
		];
		for (const body of rejected) expect((await fetchReport(siliconflowUsageProvider, body)).report).toBeNull();
	});

	it("never sends the key to the China platform, which does not document the endpoint", async () => {
		const { report, seen } = await fetchReport(siliconflowUsageProvider, documented, {
			baseUrl: "https://api.siliconflow.cn/v1",
		});
		expect(report).toBeNull();
		expect(seen).toEqual([]);
	});

	it("purges a rejected key", async () => {
		await expect(fetchReport(siliconflowUsageProvider, { code: 401 }, { status: 401 })).rejects.toThrow(
			"SiliconFlow api.siliconflow.com/v1/user/info returned 401",
		);
	});
});

describe("DeepInfra account state", () => {
	/** Documentation-derived schema with illustrative values (no example given): https://docs.deepinfra.com/api-reference/billing/get-checklist.md */
	const documented = {
		email: true,
		payment_method: true,
		suspended: false,
		overdue_invoices: 0,
		stripe_balance: -2500,
		recent: 120,
		limit: 5000,
		suspend_reason: null,
		topup: false,
		scoped_credits: [
			{ name: "launch", granted_cents: 1000, remaining_cents: 250, granted_ts: 1700000000, expired: false },
			{ name: "old", granted_cents: 500, remaining_cents: 0, granted_ts: 1600000000, expired: true },
		],
	};

	it("reads ready funds as a prepaid source of unreported size and keeps scoped credits out of it", async () => {
		const { report, seen } = await fetchReport(deepinfraUsageProvider, documented);
		expect(bearer(seen)).toEqual([
			{ url: "https://api.deepinfra.com/payment/checklist", method: "GET", authorization: `Bearer ${KEY}` },
		]);
		expect(report?.limits).toEqual([]);
		expect(report?.metadata).toEqual({
			suspended: false,
			fundsReady: true,
			scopedCredits: [{ grantedCents: 1000, remainingCents: 250 }],
		});
		expect(await billingOf(deepinfraUsageProvider, deepinfraBilling, documented)).toEqual([
			{ mode: "prepaid-credits", state: "available" },
		]);
	});

	it("reports an active account without ready funds as no evidence", async () => {
		for (const stripe_balance of [0, 42]) {
			const { report } = await fetchReport(deepinfraUsageProvider, { ...documented, stripe_balance });
			if (!report) throw new Error("fixture did not parse");
			expect(deepinfraBilling.readBilling(report)).toMatchObject({ status: "unknown", reason: "no-evidence" });
		}
	});

	it("maps a suspension to an exhausted or disabled source and an exhausted account limit", async () => {
		const overLimit = { ...documented, suspended: true, suspend_reason: "limit-reached" };
		const { report } = await fetchReport(deepinfraUsageProvider, overLimit);
		expect(report?.limits).toMatchObject([
			{ id: "deepinfra:account", status: "exhausted", notes: ["suspended: limit-reached"] },
		]);
		expect(await billingOf(deepinfraUsageProvider, deepinfraBilling, overLimit)).toEqual([
			{ mode: "prepaid-credits", state: "exhausted" },
		]);
		const banned = { ...documented, stripe_balance: 10, suspended: true, suspend_reason: "admin" };
		expect(await billingOf(deepinfraUsageProvider, deepinfraBilling, banned)).toEqual([
			{ mode: "unknown", state: "disabled" },
		]);
		const unexplained = { ...documented, suspended: true, suspend_reason: null };
		expect(await billingOf(deepinfraUsageProvider, deepinfraBilling, unexplained)).toEqual([
			{ mode: "prepaid-credits", state: "disabled" },
		]);
	});

	it("ignores the suspend reason and the spending limit while the account is active", async () => {
		const stale = { ...documented, suspend_reason: "weird" };
		expect((await fetchReport(deepinfraUsageProvider, stale)).report?.metadata).toMatchObject({ fundsReady: true });
		// `limit` has no documented unit and only a suspension stops the account.
		const overLimit = { ...documented, recent: 9000, limit: 10 };
		expect(await billingOf(deepinfraUsageProvider, deepinfraBilling, overLimit)).toEqual([
			{ mode: "prepaid-credits", state: "available" },
		]);
	});

	it("skips an expired scoped credit without validating it", async () => {
		const expired = {
			...documented,
			scoped_credits: [{ name: "old", granted_cents: null, remaining_cents: null, expired: true }],
		};
		const { report } = await fetchReport(deepinfraUsageProvider, expired);
		expect(report?.metadata).toEqual({ suspended: false, fundsReady: true });
	});

	it("rejects an undocumented suspend reason or a malformed balance or credit", async () => {
		const rejected = [
			{ ...documented, suspended: true, suspend_reason: "weird" },
			{ ...documented, suspended: "no" },
			{ ...documented, stripe_balance: "-2500" },
			{ ...documented, scoped_credits: [{ name: "x", granted_cents: 1, remaining_cents: null }] },
		];
		for (const body of rejected) expect((await fetchReport(deepinfraUsageProvider, body)).report).toBeNull();
	});

	it("treats a 401 as transient and stays out of credential health checks", async () => {
		expect(deepinfraUsageProvider.validatesCredentials).toBe(false);
		expect((await fetchReport(deepinfraUsageProvider, { detail: "x" }, { status: 401 })).report).toBeNull();
	});
});

describe("account balance billing", () => {
	it("reports a balance limit without a readable amount as malformed", () => {
		const report = {
			provider: "venice",
			fetchedAt: 1,
			limits: [
				{ id: "venice:usd", label: "USD balance", scope: { provider: "venice" }, amount: { unit: "usd" as const } },
			],
		};
		expect(veniceBilling.readBilling(report)).toMatchObject({ status: "unknown", reason: "malformed" });
	});

	it("reports no evidence for a report without balance limits", () => {
		const report = { provider: "venice", fetchedAt: 1, limits: [] };
		expect(veniceBilling.readBilling(report)).toMatchObject({ status: "unknown", reason: "no-evidence" });
		expect(deepseekBilling.readBilling({ ...report, provider: "deepseek" })).toMatchObject({
			status: "unknown",
			reason: "no-evidence",
		});
	});
});
