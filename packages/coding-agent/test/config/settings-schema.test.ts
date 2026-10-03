import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { type AnySetting, Setting, type SettingDefinition } from "@oh-my-pi/pi-coding-agent/config/registry";
import { buildSettingsSchema } from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import { TempDir } from "@oh-my-pi/pi-utils";

const cliEntry = path.resolve(import.meta.dir, "../../src/cli.ts");

function handles(...definitions: SettingDefinition[]): AnySetting[] {
	return definitions.map(definition => new Setting(definition) as AnySetting);
}

type Node = { type?: string; properties?: Record<string, Node>; [key: string]: unknown };

describe("buildSettingsSchema", () => {
	it("maps each setting kind to a JSON Schema leaf at its dotted path", () => {
		const schema = buildSettingsSchema(
			handles(
				{
					id: "mode",
					type: "enum",
					values: ["a", "b"],
					default: "b",
					ui: { tab: "appearance", label: "Mode", description: " Pick one " },
				},
				{ id: "group.limit", type: "number", default: 3 },
				{ id: "group.nested.tags", type: "array", default: ["x"] },
				{ id: "group.nested.map", type: "record", default: { k: 1 } },
				{ id: "group.optional", type: "string", default: undefined },
			),
		) as Node;

		expect(schema.additionalProperties).toBe(false);
		expect(schema.properties?.mode).toEqual({
			description: "Pick one",
			type: "string",
			enum: ["a", "b"],
			default: "b",
		});
		const group = schema.properties?.group as Node;
		expect(group).toMatchObject({ type: "object", additionalProperties: false });
		expect(group.properties?.limit).toEqual({ type: "number", default: 3 });
		expect(group.properties?.optional).toEqual({ type: "string" });
		const nested = group.properties?.nested as Node;
		expect(nested.properties?.tags).toEqual({ type: "array", default: ["x"] });
		expect(nested.properties?.map).toEqual({ type: "object", additionalProperties: true, default: { k: 1 } });
	});

	it("omits defaults of credential settings", () => {
		const schema = buildSettingsSchema(
			handles(
				{ id: "creds", type: "record", default: {}, credential: true },
				{
					id: "token",
					type: "string",
					default: "placeholder",
					ui: { tab: "appearance", label: "Token", description: "API token", secret: true },
				},
			),
		) as Node;

		expect(schema.properties?.creds).toEqual({ type: "object", additionalProperties: true });
		expect(schema.properties?.token).toEqual({ description: "API token", type: "string" });
	});
});

describe("omp config schema", () => {
	async function runCli(tempDir: TempDir, args: string[]) {
		const home = tempDir.join("home");
		// The child must not read the developer's agent dir or profile.
		const env: Record<string, string | undefined> = { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: "1" };
		delete env.PI_CODING_AGENT_DIR;
		delete env.PI_CONFIG_DIR;
		delete env.OMP_PROFILE;
		delete env.PI_PROFILE;
		const proc = Bun.spawn([process.execPath, cliEntry, "config", ...args], {
			cwd: tempDir.path(),
			env,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		return { exitCode, stdout, stderr };
	}

	it("prints only the schema JSON on stdout, or writes the same bytes to --out", async () => {
		using tempDir = TempDir.createSync("@omp-config-schema-");
		const printed = await runCli(tempDir, ["schema"]);

		expect(printed.exitCode, printed.stderr).toBe(0);
		const schema = JSON.parse(printed.stdout) as Node;
		expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
		expect(schema.properties?.compaction?.properties?.enabled).toMatchObject({ type: "boolean" });

		const outPath = tempDir.join("schema.json");
		const written = await runCli(tempDir, ["schema", "--out", outPath]);
		expect(written.exitCode, written.stderr).toBe(0);
		expect(written.stdout).toBe("");
		expect(await Bun.file(outPath).text()).toBe(printed.stdout);
	}, 60_000);
});
