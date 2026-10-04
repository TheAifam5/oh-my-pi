import { sanitizeDisplaySingleLine } from "@oh-my-pi/pi-tui/overlays/extensions/display-text";

/** Bidirectional formatting controls, which reorder how the rest of a line displays. */
const BIDI_CONTROLS = /[؜‎‏‪-‮⁦-⁩]/g;

/**
 * `text` as one line of a user-facing warning: ANSI sequences, C0/C1 controls, malformed
 * surrogates, and bidirectional controls removed, tabs expanded, line breaks collapsed to spaces.
 */
export function sanitizeNoticeLine(text: string): string {
	return sanitizeDisplaySingleLine(text).replace(BIDI_CONTROLS, "");
}
