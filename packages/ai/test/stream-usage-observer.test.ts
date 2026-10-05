import { afterEach, describe, expect, it, vi } from "bun:test";
import { clearCustomApis, registerCustomApi } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { completeSimple, setStreamUsageObserver, streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { AssistantMessage, Context, Model, StreamUsageObserver } from "@oh-my-pi/pi-ai/types";
import { logger } from "@oh-my-pi/pi-utils";

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };

/** An observer whose `record` calls resolve `next()` in turn. */
function recordingObserver(admit: StreamUsageObserver["admit"] = () => undefined) {
	const recorded: AssistantMessage[] = [];
	let waiter = Promise.withResolvers<void>();
	const observer: StreamUsageObserver = {
		admit,
		record: (_model, message) => {
			recorded.push(message);
			waiter.resolve();
			waiter = Promise.withResolvers<void>();
		},
	};
	return { observer, recorded, next: () => waiter.promise };
}

describe("stream usage observer", () => {
	afterEach(() => {
		setStreamUsageObserver(undefined);
		clearCustomApis();
		vi.restoreAllMocks();
	});

	it("refuses a request before the provider sees it and records completed ones, skipping self-recorded requests", async () => {
		registerMockApi();
		const mock = createMockModel({ handler: () => ({ content: ["ok"], usage: { input: 3, output: 2 } }) });
		let refusal: string | undefined = "Usage preflight blocked: local limit refused mock/model";
		const { observer, recorded, next } = recordingObserver(() => refusal);
		setStreamUsageObserver(observer);

		await expect(completeSimple(mock.model, context)).rejects.toThrow("local limit refused mock/model");
		expect(mock.calls).toHaveLength(0);

		refusal = undefined;
		const recordedOnce = next();
		await streamSimple(mock.model, context).result();
		await recordedOnce;
		await streamSimple(mock.model, context, { usageRecorded: true }).result();
		expect(mock.calls).toHaveLength(2);
		expect(recorded.map(message => message.usage.input)).toEqual([3]);
	});

	it("sends the request when admit throws and swallows a throwing record", async () => {
		registerMockApi();
		const mock = createMockModel({ handler: () => ({ content: ["ok"] }) });
		const warn = vi.spyOn(logger, "warn");
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		let recordCalled = Promise.withResolvers<void>();
		setStreamUsageObserver({
			admit: () => {
				throw new Error("observer broke");
			},
			record: () => {
				recordCalled.resolve();
				throw new Error("ledger broke");
			},
		});
		try {
			await expect(streamSimple(mock.model, context).result()).resolves.toMatchObject({ stopReason: "stop" });
			await recordCalled.promise;
			// One macrotask lets the runtime report a rejection nothing handled.
			await Bun.sleep(0);
			expect(mock.calls).toHaveLength(1);
			expect(unhandled).toEqual([]);
			expect(warn.mock.calls.map(([message]) => message)).toContain(
				"Stream usage observer failed to record a request",
			);
		} finally {
			process.off("unhandledRejection", onUnhandled);
			recordCalled = Promise.withResolvers<void>();
		}
	});

	it("observes a provider that delegates back to streamSimple once", async () => {
		registerMockApi();
		const mock = createMockModel({ handler: () => ({ content: ["ok"], usage: { input: 1, output: 1 } }) });
		registerCustomApi("delegating-test", (_model, ctx, options) => streamSimple(mock.model, ctx, options));
		const { observer, recorded, next } = recordingObserver();
		let admitted = 0;
		setStreamUsageObserver({
			...observer,
			admit: () => {
				admitted++;
				return undefined;
			},
		});
		const recordedOnce = next();
		await streamSimple({ ...mock.model, api: "delegating-test" } as Model, context).result();
		await recordedOnce;
		expect(admitted).toBe(1);
		expect(recorded).toHaveLength(1);
	});
});
