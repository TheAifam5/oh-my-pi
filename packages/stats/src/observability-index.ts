import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { isRecord } from "@oh-my-pi/pi-utils";

export function ensureObservabilityIndex(database: Database): void {
	database.run("DROP TABLE IF EXISTS observability_index");
	database.run("DROP TABLE IF EXISTS observability_index_v2");
	database.run("DROP TABLE IF EXISTS observability_index_v3");
	database.run(
		"CREATE TABLE IF NOT EXISTS observability_index_v4 (session_file TEXT PRIMARY KEY, last_modified INTEGER NOT NULL, source_offset INTEGER NOT NULL, source_identity TEXT NOT NULL, checkpoint TEXT NOT NULL, ancestry TEXT NOT NULL, entries TEXT NOT NULL, unreadable INTEGER NOT NULL DEFAULT 0)",
	);
}

interface IndexedFile {
	session_file: string;
	last_modified: number;
	offset: number;
	previous_offset: number | null;
	source_identity: string | null;
	checkpoint: string | null;
	ancestry: string | null;
	entries: string | null;
}

interface IndexOptions {
	files?: readonly string[];
	read?: (path: string, start: number, end: number) => Promise<string>;
}

export async function refreshObservabilityIndex(database: Database, options: IndexOptions = {}): Promise<void> {
	ensureObservabilityIndex(database);
	const selected = options.files ? new Set(options.files) : null;
	const files = database
		.query<IndexedFile, []>(
			"SELECT f.session_file, f.last_modified, f.offset, o.source_offset AS previous_offset, o.source_identity, o.checkpoint, o.ancestry, o.entries FROM file_offsets f LEFT JOIN observability_index_v4 o ON o.session_file = f.session_file WHERE o.session_file IS NULL OR o.last_modified != f.last_modified OR o.source_offset != f.offset",
		)
		.all();
	const read = options.read ?? ((path: string, start: number, end: number) => Bun.file(path).slice(start, end).text());
	for (const file of files) {
		if (selected && !selected.has(file.session_file)) continue;
		let entries: string[] = [];
		const ancestors = new Map<string, string | null>();
		let checkpoint = "";
		let identity = "";
		let unreadable = 0;
		try {
			const stat = await Bun.file(file.session_file).stat();
			identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
			let start = 0;
			if (
				file.previous_offset !== null &&
				file.previous_offset <= file.offset &&
				file.source_identity === identity
			) {
				const boundary = await read(
					file.session_file,
					Math.max(0, file.previous_offset - 256),
					file.previous_offset,
				);
				if (createHash("sha256").update(boundary).digest("hex") === file.checkpoint) {
					start = file.previous_offset;
					entries = file.entries ? [file.entries] : [];
					const saved: unknown = JSON.parse(file.ancestry ?? "[]");
					if (Array.isArray(saved)) {
						for (const pair of saved) {
							if (
								Array.isArray(pair) &&
								typeof pair[0] === "string" &&
								(typeof pair[1] === "string" || pair[1] === null)
							)
								ancestors.set(pair[0], pair[1]);
						}
					}
				}
			}
			const tail = await read(file.session_file, start, file.offset);
			checkpoint = createHash("sha256")
				.update(await read(file.session_file, Math.max(0, file.offset - 256), file.offset))
				.digest("hex");
			for (const line of tail.split("\n")) {
				let entry: unknown;
				try {
					entry = JSON.parse(line);
				} catch {
					continue;
				}
				if (!isRecord(entry)) continue;
				const parent = typeof entry.parentId === "string" ? (ancestors.get(entry.parentId) ?? null) : null;
				if (typeof entry.id === "string")
					ancestors.set(entry.id, entry.customType === "advisor_findings" ? entry.id : parent);
				if (
					entry.customType === "advisor_findings" &&
					isRecord(entry.data) &&
					typeof entry.data.turn === "number" &&
					Array.isArray(entry.data.findings)
				) {
					const findings = entry.data.findings.flatMap(value => {
						if (
							!isRecord(value) ||
							typeof value.id !== "string" ||
							typeof value.status !== "string" ||
							typeof value.category !== "string" ||
							typeof value.createdTurn !== "number"
						)
							return [];
						const resolution =
							isRecord(value.resolution) && typeof value.resolution.turn === "number"
								? {
										turn: value.resolution.turn,
										by:
											value.resolution.by === "user" || value.resolution.by === "agent"
												? value.resolution.by
												: typeof value.resolution.by === "string"
													? "advisor"
													: undefined,
									}
								: undefined;
						return [
							{
								id: value.id,
								status: value.status,
								severity: typeof value.severity === "string" ? value.severity : "unknown",
								category: value.category,
								owner: typeof value.owner === "string" ? value.owner : undefined,
								createdTurn: value.createdTurn,
								resolution,
							},
						];
					});
					entries.push(
						JSON.stringify({
							customType: "advisor_findings",
							data: { turn: entry.data.turn, findings },
							timestamp: typeof entry.timestamp === "string" ? entry.timestamp : undefined,
							id: typeof entry.id === "string" ? entry.id : undefined,
							parentId: parent,
						}),
					);
				} else if (isRecord(entry.message) && isRecord(entry.message.retryRecovery)) {
					const message = entry.message;
					if (
						typeof message.provider !== "string" ||
						typeof message.model !== "string" ||
						typeof message.timestamp !== "number"
					)
						continue;
					entries.push(
						JSON.stringify({
							message: {
								provider: message.provider,
								model: message.model,
								timestamp: message.timestamp,
								retryRecovery: {
									status: entry.message.retryRecovery.status === "recovered" ? "recovered" : "superseded",
								},
							},
						}),
					);
				}
			}
		} catch {
			unreadable = 1;
		}
		database
			.query(`
			INSERT OR REPLACE INTO observability_index_v4
				(session_file, last_modified, source_offset, source_identity, checkpoint, ancestry, entries, unreadable)
			SELECT ?, ?, ?, ?, ?, ?, ?, ?
			WHERE EXISTS (
				SELECT 1 FROM file_offsets WHERE session_file = ? AND last_modified = ? AND offset = ?
			) AND (SELECT source_offset FROM observability_index_v4 WHERE session_file = ?) IS ?
			  AND (SELECT checkpoint FROM observability_index_v4 WHERE session_file = ?) IS ?
		`)
			.run(
				file.session_file,
				file.last_modified,
				file.offset,
				identity,
				checkpoint,
				JSON.stringify([...ancestors]),
				entries.join("\n"),
				unreadable,
				file.session_file,
				file.last_modified,
				file.offset,
				file.session_file,
				file.previous_offset,
				file.session_file,
				file.checkpoint,
			);
	}
	if (!selected)
		database.run(
			"DELETE FROM observability_index_v4 WHERE session_file NOT IN (SELECT session_file FROM file_offsets)",
		);
}
