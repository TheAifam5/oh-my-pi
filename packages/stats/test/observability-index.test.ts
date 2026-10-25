import { Database } from "bun:sqlite";
import { expect, it } from "bun:test";
import { refreshObservabilityIndex } from "../src/observability-index";
import { installStatsTestIsolation } from "./helpers/temp-agent";

const isolation = installStatsTestIsolation("@pi-stats-observability-index-");

it("projects aggregate fields, scrubs the old projection and preserves branch ancestry", async () => {
	const directory = isolation.current();
	if (!directory) throw new Error("Missing test directory");
	const file = directory.join("session.jsonl");
	const entries = [
		{
			id: "s1",
			parentId: null,
			customType: "advisor_findings",
			timestamp: new Date().toISOString(),
			data: {
				v: 2,
				turn: 1,
				findings: [
					{
						id: "F1",
						status: "open",
						severity: "blocker",
						category: "logic",
						owner: "reviewer",
						createdTurn: 1,
						anchor: "private-path-sentinel",
						reports: [{ defect: "private-report-sentinel" }],
					},
				],
			},
		},
		{
			id: "m1",
			parentId: "s1",
			message: {
				role: "assistant",
				content: "private-message-sentinel",
				provider: "p",
				model: "m",
				timestamp: Date.now(),
				retryRecovery: {
					status: "recovered",
					note: "private-note-sentinel",
					supersededBy: { responseId: "private-response-sentinel" },
				},
			},
		},
		{ id: "s2", parentId: "m1", customType: "advisor_findings", data: { v: 2, turn: 2, findings: [] } },
		{ id: "tail", parentId: "s2", message: { content: "private-checkpoint-sentinel" } },
	];
	await Bun.write(file, entries.map(entry => JSON.stringify(entry)).join("\n"));
	const database = new Database(":memory:");
	try {
		database.run("CREATE TABLE file_offsets (session_file TEXT PRIMARY KEY, last_modified INTEGER, offset INTEGER)");
		database.query("INSERT INTO file_offsets VALUES (?, ?, ?)").run(file, 1, Bun.file(file).size);
		database.run("CREATE TABLE observability_index (entries TEXT)");
		database.run("INSERT INTO observability_index VALUES ('private-old-sentinel')");
		database.run("CREATE TABLE observability_index_v3 (checkpoint TEXT)");
		database.run("INSERT INTO observability_index_v3 VALUES ('private-old-checkpoint-sentinel')");
		await refreshObservabilityIndex(database);
		const serialized =
			database.query<{ entries: string }, []>("SELECT entries FROM observability_index_v4").get()?.entries ?? "";
		const stored = JSON.stringify(database.query("SELECT * FROM observability_index_v4").all());
		for (const value of [
			"private-path-sentinel",
			"private-report-sentinel",
			"private-message-sentinel",
			"private-note-sentinel",
			"private-response-sentinel",
			"private-old-sentinel",
			"private-old-checkpoint-sentinel",
			"private-checkpoint-sentinel",
		])
			expect(stored.includes(value)).toBe(false);
		expect(database.query("SELECT name FROM sqlite_master WHERE name = 'observability_index'").all()).toEqual([]);
		expect(database.query("SELECT name FROM sqlite_master WHERE name = 'observability_index_v3'").all()).toEqual([]);
		expect(
			database.query<{ checkpoint: string }, []>("SELECT checkpoint FROM observability_index_v4").get()?.checkpoint,
		).toMatch(/^[a-f0-9]{64}$/);
		const indexed = serialized
			.split("\n")
			.map(line => JSON.parse(line) as { parentId?: string; message?: { retryRecovery: { status: string } } });
		expect(indexed[2]?.parentId).toBe("s1");
		expect(indexed[1]?.message?.retryRecovery).toEqual({ status: "recovered" });
		await Bun.write(file, "invalid changed file");
		await refreshObservabilityIndex(database);
		expect(database.query<{ entries: string }, []>("SELECT entries FROM observability_index_v4").get()?.entries).toBe(
			serialized,
		);
		database.query("UPDATE file_offsets SET last_modified = 2").run();
		await refreshObservabilityIndex(database);
		expect(database.query<{ entries: string }, []>("SELECT entries FROM observability_index_v4").get()?.entries).toBe(
			"",
		);
	} finally {
		database.close();
	}
});

it("reads only appended data plus bounded checkpoints and respects targeted files", async () => {
	const directory = isolation.current();
	if (!directory) throw new Error("Missing test directory");
	const file = directory.join("incremental.jsonl");
	const other = directory.join("excluded.jsonl");
	const initial = `${JSON.stringify({ id: "root", message: { content: "x".repeat(16384) } })}\n`;
	await Bun.write(file, initial);
	await Bun.write(other, initial);
	const database = new Database(":memory:");
	const reads: { path: string; start: number; end: number }[] = [];
	const read = async (path: string, start: number, end: number) => {
		reads.push({ path, start, end });
		return Bun.file(path).slice(start, end).text();
	};
	try {
		database.run("CREATE TABLE file_offsets (session_file TEXT PRIMARY KEY, last_modified INTEGER, offset INTEGER)");
		database.query("INSERT INTO file_offsets VALUES (?, 1, ?)").run(file, Bun.file(file).size);
		database.query("INSERT INTO file_offsets VALUES (?, 1, ?)").run(other, Bun.file(other).size);
		await refreshObservabilityIndex(database, { files: [file], read });
		expect(reads.every(item => item.path === file)).toBe(true);
		expect(database.query("SELECT session_file FROM observability_index_v4").all()).toEqual([{ session_file: file }]);
		reads.length = 0;
		const before = Bun.file(file).size;
		const appended = `${JSON.stringify({ id: "snapshot", parentId: "root", customType: "advisor_findings", data: { turn: 1, findings: [] } })}\n`;
		await Bun.write(file, initial + appended);
		const after = Bun.file(file).size;
		database.query("UPDATE file_offsets SET last_modified = 2, offset = ? WHERE session_file = ?").run(after, file);
		await refreshObservabilityIndex(database, { files: [file], read });
		expect(reads.some(item => item.start === before && item.end === after)).toBe(true);
		expect(reads.every(item => item.path === file && item.start >= before - 256)).toBe(true);
		expect(reads.reduce((sum, item) => sum + item.end - item.start, 0)).toBeLessThanOrEqual(after - before + 512);
		expect(
			database.query<{ entries: string }, []>("SELECT entries FROM observability_index_v4").get()?.entries,
		).toContain("snapshot");
		reads.length = 0;
		await refreshObservabilityIndex(database, { files: [file], read });
		expect(reads).toEqual([]);
	} finally {
		database.close();
	}
});

it("does not commit a stale projection when ingestion advances during a read", async () => {
	const directory = isolation.current();
	if (!directory) throw new Error("Missing test directory");
	const file = directory.join("racing.jsonl");
	await Bun.write(
		file,
		`${JSON.stringify({ id: "a", customType: "advisor_findings", data: { turn: 1, findings: [] } })}\n`,
	);
	const database = new Database(":memory:");
	try {
		database.run("CREATE TABLE file_offsets (session_file TEXT PRIMARY KEY, last_modified INTEGER, offset INTEGER)");
		database.query("INSERT INTO file_offsets VALUES (?, 1, ?)").run(file, Bun.file(file).size);
		await refreshObservabilityIndex(database, {
			read: async (path, start, end) => {
				database.run("UPDATE file_offsets SET last_modified = 2");
				return Bun.file(path).slice(start, end).text();
			},
		});
		expect(database.query("SELECT * FROM observability_index_v4").all()).toEqual([]);
		await refreshObservabilityIndex(database);
		expect(database.query("SELECT last_modified FROM observability_index_v4").all()).toEqual([{ last_modified: 2 }]);
	} finally {
		database.close();
	}
});
