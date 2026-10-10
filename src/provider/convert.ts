import vscode from 'vscode';
import { safeStringify } from '../json';
import type {
	DeepSeekContentPart,
	DeepSeekMessage,
	DeepSeekTool,
	DeepSeekToolCall,
} from '../types';
import { parseFirstReplayMarker } from './replay';

/**
 * Placeholder used when an assistant message must carry `reasoning_content` but the original
 * reasoning text can no longer be recovered from the VS Code message history.
 *
 * DeepSeek rejects thinking-mode requests (HTTP 400, "The reasoning_content in the thinking
 * mode must be passed back to the API.") when such a message has a missing **or empty**
 * `reasoning_content`, so the field must always be non-empty while thinking is enabled.
 * Reasoning becomes unrecoverable whenever the history holds an assistant turn that was
 * produced without a replay marker or thinking part — a model switch inside the same
 * conversation, history compaction/summarization, or turns restored from an older build.
 */
export const EMPTY_REASONING_PLACEHOLDER = '(prior reasoning unavailable)';

export interface ConvertMessagesStats {
	/** Assistant messages whose reasoning fell back to {@link EMPTY_REASONING_PLACEHOLDER}. */
	emptyReasoningFallbacks: number;
}

/**
 * Convert VS Code chat messages to DeepSeek format.
 * Injects marker-replayed reasoning_content for assistant messages.
 */
export function convertMessages(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
	isThinkingModel: boolean,
	nativeImageInput: boolean,
	stats?: ConvertMessagesStats,
): DeepSeekMessage[] {
	const result: DeepSeekMessage[] = [];

	for (const message of messages) {
		const role = mapRole(message.role);

		let content = '';
		const nativeVisionContentParts: DeepSeekContentPart[] = [];
		let thinkingContent = '';
		const toolCalls: DeepSeekToolCall[] = [];
		const toolResults: Array<{ callId: string; content: string }> = [];

		for (const part of message.content) {
			if (part instanceof vscode.LanguageModelTextPart) {
				content += part.value;
				if (nativeImageInput && role === 'user') {
					nativeVisionContentParts.push({
						type: 'text',
						text: part.value,
					});
				}
			} else if (nativeImageInput && role === 'user' && isImageDataPart(part)) {
				nativeVisionContentParts.push({
					type: 'image_url',
					image_url: {
						url: toImageDataUrl(part),
					},
				});
			} else if (isLanguageModelThinkingPart(part)) {
				thinkingContent += normalizeThinkingPartText(part.value);
			} else if (part instanceof vscode.LanguageModelToolCallPart) {
				toolCalls.push({
					id: part.callId,
					type: 'function',
					function: {
						name: part.name,
						arguments: safeStringify(part.input),
					},
				});
			} else if (part instanceof vscode.LanguageModelToolResultPart) {
				let toolContent = '';
				for (const item of part.content) {
					if (item instanceof vscode.LanguageModelTextPart) {
						toolContent += item.value;
					}
				}
				toolResults.push({
					callId: part.callId,
					content: toolContent || safeStringify(part.content),
				});
			}
		}

		if (role === 'assistant') {
			if (content || toolCalls.length > 0) {
				const replayMarker = isThinkingModel ? parseFirstReplayMarker(message) : undefined;
				const msg: DeepSeekMessage = {
					role: 'assistant' as const,
					content: content || '',
				};

				if (toolCalls.length > 0) {
					msg.tool_calls = toolCalls;
				}

				if (isThinkingModel) {
					const reasoningContent = getReasoningContent(replayMarker, thinkingContent);
					if (reasoningContent.length > 0) {
						msg.reasoning_content = reasoningContent;
					} else {
						// Never send an empty reasoning_content: DeepSeek treats it as missing and
						// rejects the whole request while thinking is enabled.
						msg.reasoning_content = EMPTY_REASONING_PLACEHOLDER;
						if (stats) {
							stats.emptyReasoningFallbacks += 1;
						}
					}
				}

				result.push(msg);
			}
		} else {
			if (nativeImageInput && role === 'user' && nativeVisionContentParts.length > 0) {
				result.push({
					role: 'user',
					content: nativeVisionContentParts,
				});
			} else if (content) {
				result.push({
					role: role as 'user' | 'assistant',
					content: content,
				});
			}
		}

		// Tool result messages follow their associated assistant message
		for (const tr of toolResults) {
			result.push({
				role: 'tool',
				content: tr.content,
				tool_call_id: tr.callId,
			});
		}
	}

	return result;
}

function isImageDataPart(part: unknown): part is vscode.LanguageModelDataPart {
	return part instanceof vscode.LanguageModelDataPart && part.mimeType.startsWith('image/');
}

function toImageDataUrl(part: vscode.LanguageModelDataPart): string {
	return `data:${part.mimeType};base64,${Buffer.from(part.data).toString('base64')}`;
}

/**
 * Drop `reasoning_content` from converted messages.
 *
 * Used when thinking ended up disabled for the request: the API ignores the field then, and
 * streaming it costs payload size (and prefix-cache stability) for no benefit.
 */
export function stripReasoningContent(messages: DeepSeekMessage[]): void {
	for (const message of messages) {
		if (message.role === 'assistant') {
			delete message.reasoning_content;
		}
	}
}

/**
 * Resolve the reasoning text to send back for one assistant message.
 *
 * The replay marker wins because it preserves the original text across reloads and
 * compaction; the live thinking part is the fallback for the current turn. Callers must
 * substitute a non-empty placeholder when this returns an empty string (see
 * `EMPTY_REASONING_PLACEHOLDER`).
 */
function getReasoningContent(
	replayMarker: ReturnType<typeof parseFirstReplayMarker>,
	thinkingContent: string,
): string {
	if (replayMarker?.valid && replayMarker.reasoningText) {
		return replayMarker.reasoningText;
	}
	return thinkingContent;
}

function isLanguageModelThinkingPart(part: unknown): part is vscode.LanguageModelThinkingPart {
	return (
		typeof vscode.LanguageModelThinkingPart === 'function' &&
		part instanceof vscode.LanguageModelThinkingPart
	);
}

function normalizeThinkingPartText(value: string | string[]): string {
	return Array.isArray(value) ? value.join('') : value;
}

function mapRole(role: vscode.LanguageModelChatMessageRole): 'user' | 'assistant' {
	switch (role) {
		case vscode.LanguageModelChatMessageRole.User:
			return 'user';
		case vscode.LanguageModelChatMessageRole.Assistant:
			return 'assistant';
		default:
			return 'user';
	}
}

/**
 * Convert VS Code tool definitions to DeepSeek format.
 */
export function convertTools(
	tools: readonly vscode.LanguageModelChatTool[] | undefined,
): DeepSeekTool[] | undefined {
	if (!tools || tools.length === 0) {
		return undefined;
	}

	return tools.map((tool) => ({
		type: 'function' as const,
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.inputSchema as Record<string, unknown> | undefined,
		},
	}));
}

/**
 * Count total characters across all messages to calibrate chars-per-token ratio.
 */
export function countMessageChars(messages: DeepSeekMessage[]): number {
	let total = 0;
	for (const msg of messages) {
		total += getMessageContentChars(msg.content);
		total += msg.reasoning_content?.length ?? 0;
		if (msg.tool_calls) {
			for (const tc of msg.tool_calls) {
				total += tc.function?.name?.length ?? 0;
				total += tc.function?.arguments?.length ?? 0;
			}
		}
	}
	return total;
}

function getMessageContentChars(content: DeepSeekMessage['content']): number {
	if (typeof content === 'string') {
		return content.length;
	}

	let total = 0;
	for (const part of content) {
		if (part.type === 'text') {
			total += part.text.length;
		} else if (part.type === 'image_url') {
			// Do not count base64 URL chars. Native-image requests are excluded from
			// adaptive charsPerToken updates, and image cost is handled separately.
			total += 0;
		}
	}
	return total;
}
