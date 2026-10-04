/**
 * Built-in model role ids. Settings and config parsing import this module, so
 * it must not import UI code.
 */

/** Canonical display ordering of built-in model roles. */
export type ModelRole =
	| "default"
	| "smol"
	| "slow"
	| "vision"
	| "plan"
	| "commit"
	| "tiny"
	| "memory"
	| "task"
	| "advisor"
	| "widget"
	| "image"
	| "web"
	| "speech"
	| "dictation"
	| "judge";
export const MODEL_ROLE_IDS: ModelRole[] = [
	"default",
	"smol",
	"slow",
	"vision",
	"plan",
	"commit",
	"tiny",
	"memory",
	"task",
	"advisor",
	"widget",
	"image",
	"web",
	"speech",
	"dictation",
	"judge",
];
export const CHAT_MODEL_ROLE_IDS: ModelRole[] = [
	"default",
	"smol",
	"slow",
	"vision",
	"plan",
	"commit",
	"tiny",
	"memory",
	"task",
	"advisor",
	"widget",
];
export const KIND_ROLE_IDS: ModelRole[] = ["image", "web", "speech", "dictation", "judge"];
