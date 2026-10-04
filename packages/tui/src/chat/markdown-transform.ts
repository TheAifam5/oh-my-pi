/** Process-wide display-only transform of transcript Markdown, installed by the host. */
import type { AssistantMessage } from "@oh-my-pi/pi-ai";

/** Where a transcript Markdown transform is being applied. */
export interface ChatMarkdownTransformContext {
	messageType: "user" | "assistant" | "assistant-thinking";
	/** True while the message is still streaming in. */
	isStreaming: boolean;
}

/** Returns the Markdown to render for `markdown`. Must not throw; the host contains failures. */
export type ChatMarkdownTransform = (markdown: string, context: ChatMarkdownTransformContext) => string;

let activeTransform: ChatMarkdownTransform | undefined;

/** Install the transcript Markdown transform, or clear it with `undefined`. Affects components rendered afterwards. */
export function setChatMarkdownTransform(transform: ChatMarkdownTransform | undefined): void {
	activeTransform = transform;
}

/** Apply the installed transform to user Markdown; returns `markdown` unchanged when none is installed. */
export function transformUserMarkdown(markdown: string): string {
	return activeTransform ? activeTransform(markdown, { messageType: "user", isStreaming: false }) : markdown;
}

/**
 * Display copy of `message` with text and thinking blocks passed through the
 * installed transform. Returns `message` itself when no transform is installed;
 * the input is never mutated.
 */
export function transformAssistantMarkdown(message: AssistantMessage, isStreaming: boolean): AssistantMessage {
	const transform = activeTransform;
	if (!transform) return message;
	let content: AssistantMessage["content"] | undefined;
	for (const [index, block] of message.content.entries()) {
		let replacement: AssistantMessage["content"][number] | undefined;
		if (block.type === "text") {
			const text = transform(block.text, { messageType: "assistant", isStreaming });
			if (text !== block.text) replacement = { ...block, text };
		} else if (block.type === "thinking") {
			const thinking = transform(block.thinking, { messageType: "assistant-thinking", isStreaming });
			if (thinking !== block.thinking) replacement = { ...block, thinking };
		}
		if (replacement === undefined) continue;
		content ??= message.content.slice();
		content[index] = replacement;
	}
	return content ? { ...message, content } : message;
}
