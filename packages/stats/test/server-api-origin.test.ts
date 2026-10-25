import { describe, expect, it } from "bun:test";
import { createConnection } from "node:net";
import { networkInterfaces } from "node:os";
import { handleApi, startServer } from "../src/server";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-api-origin-");

function rawStatus(port: number, target: string, headers: string[]): Promise<number> {
	const { promise, resolve, reject } = Promise.withResolvers<number>();
	const socket = createConnection({ host: "127.0.0.1", port });
	let response = "";
	socket.setEncoding("utf8");
	// Real socket I/O has a bounded deadline independent of fake timers.
	socket.setTimeout(5000, () => socket.destroy(new Error("HTTP response timed out")));
	socket.once("error", reject);
	socket.once("connect", () => {
		socket.write([`GET ${target} HTTP/1.1`, ...headers, "Connection: close", "", ""].join("\r\n"));
	});
	socket.on("data", chunk => {
		response += chunk;
		const status = /^HTTP\/1\.[01] (\d{3}) /.exec(response);
		if (status) {
			socket.destroy();
			resolve(Number(status[1]));
		}
	});
	socket.once("close", () => reject(new Error("HTTP connection closed without a status")));
	return promise;
}

describe("dashboard API origin guard", () => {
	it("rejects foreign, absent and disagreeing authorities before dispatch", async () => {
		const origin = "http://127.0.0.1:3847";
		for (const endpoint of ["/api/stats/provider-windows", "/api/stats/models"]) {
			for (const headers of [
				{},
				{ Origin: origin },
				{ Host: "" },
				{ Host: "attacker.invalid:3847" },
				{ Host: "127.0.0.1:9999" },
				{ Host: "127.0.0.1:3847", Origin: "http://attacker.invalid" },
				{ Host: "127.0.0.1:3847", Origin: "http://127.0.0.1:9999" },
				{ Host: "127.0.0.1:3847", Origin: "null" },
			]) {
				const response = await handleApi(new Request(`${origin}${endpoint}`, { headers }), "127.0.0.1", 3847);
				expect(response.status).toBe(403);
			}
			for (const url of ["http://attacker.invalid:3847", "http://127.0.0.1:9999", "https://127.0.0.1:3847"]) {
				const response = await handleApi(
					new Request(`${url}${endpoint}`, { headers: { Host: "127.0.0.1:3847", Origin: origin } }),
					"127.0.0.1",
					3847,
				);
				expect(response.status).toBe(403);
			}
		}
	});

	it("guards real GETs, preflights and event streams and preserves same-origin response shapes", async () => {
		const server = await startServer(0);
		const host = `127.0.0.1:${server.port}`;
		const origin = `http://${host}`;
		try {
			for (const endpoint of ["/api/stats/provider-windows", "/api/stats/models", "/api/events"]) {
				for (const method of ["GET", "OPTIONS"]) {
					for (const headers of [
						{ Host: `attacker.invalid:${server.port}` },
						{ Origin: "http://attacker.invalid" },
					]) {
						const response = await fetch(`${origin}${endpoint}`, { method, headers });
						expect(response.status).toBe(403);
						await response.body?.cancel();
					}
				}
				expect([400, 403]).toContain(await rawStatus(server.port, endpoint, []));
				expect([400, 403]).toContain(await rawStatus(server.port, `${origin}${endpoint}`, []));
				for (const target of [`${origin}${endpoint}`, `http://attacker.invalid:${server.port}${endpoint}`]) {
					expect(await rawStatus(server.port, target, [`Host: attacker.invalid:${server.port}`])).toBe(403);
					expect(await rawStatus(server.port, target, [`Host: ${host}`, "Origin: http://attacker.invalid"])).toBe(
						403,
					);
				}
			}
			// Bun derives the Request URL authority from Host, including absolute-form request targets.
			expect(
				await rawStatus(server.port, `http://attacker.invalid:${server.port}/api/stats/models`, [`Host: ${host}`]),
			).toBe(200);
			const windows = await fetch(`${origin}/api/stats/provider-windows`, { headers: { Origin: origin } });
			expect(windows.status).toBe(200);
			expect(await windows.json()).toEqual({ windowInsights: [], usageSeries: [] });
			const models = await fetch(`${origin}/api/stats/models`, { headers: { Origin: origin } });
			expect(models.status).toBe(200);
			expect(await models.json()).toEqual([]);
			const noOrigin = await fetch(`${origin}/api/stats/models`);
			expect(noOrigin.status).toBe(200);
			await noOrigin.body?.cancel();
			const events = await fetch(`${origin}/api/events`, { headers: { Origin: origin } });
			try {
				expect(events.status).toBe(200);
				expect(events.headers.get("content-type")).toBe("text/event-stream");
			} finally {
				await events.body?.cancel();
			}
		} finally {
			server.stop();
		}
	});

	it("accepts configured non-loopback authorities without enabling sensitive reads", async () => {
		const origin = "http://192.0.2.10:3847";
		for (const endpoint of ["/api/stats/provider-windows", "/api/stats/models"]) {
			const response = await handleApi(
				new Request(`${origin}${endpoint}`, { headers: { Host: "192.0.2.10:3847", Origin: origin } }),
				"192.0.2.10",
				3847,
			);
			expect(response.status).toBe(200);
		}
		const sensitive = await handleApi(
			new Request(`${origin}/api/stats/observability`, { headers: { Host: "192.0.2.10:3847", Origin: origin } }),
			"192.0.2.10",
			3847,
		);
		expect(sensitive.status).toBe(403);
	});

	it("limits wildcard bindings to local authorities with matching origins", async () => {
		const localAddress = Object.values(networkInterfaces())
			.flat()
			.find(address => address?.family === "IPv4" && !address.internal)?.address;
		for (const hostname of ["127.0.0.1", ...(localAddress ? [localAddress] : [])]) {
			const host = `${hostname}:3847`;
			const response = await handleApi(
				new Request(`http://${host}/api/stats/models`, { headers: { Host: host, Origin: `http://${host}` } }),
				"0.0.0.0",
				3847,
			);
			expect(response.status).toBe(200);
		}
		for (const hostname of ["attacker.invalid", "192.0.2.10"]) {
			const host = `${hostname}:3847`;
			const response = await handleApi(
				new Request(`http://${host}/api/stats/models`, { headers: { Host: host, Origin: `http://${host}` } }),
				"0.0.0.0",
				3847,
			);
			expect(response.status).toBe(403);
		}
	});
});
