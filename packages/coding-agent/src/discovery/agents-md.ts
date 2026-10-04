/**
 * AGENTS.md Provider
 *
 * Discovers standalone AGENTS.md files by walking up from cwd.
 * This handles AGENTS.md files that live in project root (not in config directories
 * like .codex/ or .gemini/, which are handled by their respective providers).
 * An AGENTS.override.md replaces AGENTS.md and CLAUDE.md in its own directory only.
 */
import { registerProvider } from "../capability";
import { type ContextFile, contextFileCapability } from "../capability/context-file";
import type { LoadContext, LoadResult } from "../capability/types";
import { loadStandaloneContextFiles } from "./helpers";

const PROVIDER_ID = "agents-md";
const DISPLAY_NAME = "AGENTS.md";
const AGENTS_MD_CANDIDATES = ["AGENTS.override.md", "AGENTS.md"] as const;

/**
 * Load standalone AGENTS.md files by walking up from cwd
 * (see {@link loadStandaloneContextFiles}). In each directory a non-empty
 * AGENTS.override.md is returned ahead of AGENTS.md, so it wins that depth.
 */
export async function loadAgentsMd(ctx: LoadContext): Promise<LoadResult<ContextFile>> {
	return loadStandaloneContextFiles(ctx, PROVIDER_ID, AGENTS_MD_CANDIDATES);
}

registerProvider(contextFileCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Standalone AGENTS.md files (Codex/Gemini style)",
	priority: 10,
	load: loadAgentsMd,
});
