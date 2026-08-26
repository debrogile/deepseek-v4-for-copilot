import { existsSync, readFileSync } from 'fs';
import path from 'path';
import vscode from 'vscode';
import { logger } from './logger';

// ---- Types matching VS Code chatLanguageModels.json schema ----

interface ChatLanguageModelConfig {
	name?: string;
	vendor?: string;
	apiKey?: string;
	apiType?: string;
	models?: ChatLanguageModelEntry[];
}

interface ChatLanguageModelEntry {
	id: string;
	name?: string;
	url: string;
	toolCalling?: boolean;
	vision?: boolean;
	maxInputTokens?: number;
	maxOutputTokens?: number;
}

export interface DetectedCustomEndpoint {
	/** Display name from chatLanguageModels.json (e.g. "AI-UIS"). */
	label: string;
	/** Base URL for the endpoint (e.g. "http://lightcode-uis.hundsun.com:8080/v1"). */
	baseUrl: string;
	/** API type, typically "chat-completions". */
	apiType: string;
	/** Raw apiKey string from config (may be `${input:...}` placeholder). */
	rawApiKey?: string;
	/** Parsed model entries. */
	models: DetectedCustomEndpointModel[];
}

export interface DetectedCustomEndpointModel {
	id: string;
	name?: string;
	maxInputTokens: number;
	maxOutputTokens: number;
	supportsToolCalling: boolean;
}

// ---- Helpers ----

const DEFAULT_MAX_INPUT = 655360;
const DEFAULT_MAX_OUTPUT = 393216;

// ---- Core detection logic ----

/**
 * Path to VS Code's `chatLanguageModels.json` in the user data directory.
 * Supports stable, insider, and exploratory (OSS) variants.
 */
function getChatLanguageModelsPath(): string | undefined {
	const appData = process.env.APPDATA;
	if (appData) {
		// Windows: %APPDATA%\Code\User\chatLanguageModels.json
		const candidates = [
			path.join(appData, 'Code', 'User', 'chatLanguageModels.json'),
			path.join(appData, 'Code - Insiders', 'User', 'chatLanguageModels.json'),
			path.join(appData, 'Code - OSS', 'User', 'chatLanguageModels.json'),
			path.join(appData, 'Cursor', 'User', 'chatLanguageModels.json'),
			path.join(appData, 'Windsurf', 'User', 'chatLanguageModels.json'),
		];
		for (const candidate of candidates) {
			if (existsSync(candidate)) {
				return candidate;
			}
		}
	}

	// macOS / Linux fallbacks
	const home = process.env.HOME || process.env.USERPROFILE;
	if (home) {
		const unixCandidates = [
			path.join(home, 'Library', 'Application Support', 'Code', 'User', 'chatLanguageModels.json'),
			path.join(home, 'Library', 'Application Support', 'Code - Insiders', 'User', 'chatLanguageModels.json'),
			path.join(home, '.config', 'Code', 'User', 'chatLanguageModels.json'),
			path.join(home, '.config', 'Code - Insiders', 'User', 'chatLanguageModels.json'),
		];
		for (const candidate of unixCandidates) {
			if (existsSync(candidate)) {
				return candidate;
			}
		}
	}

	return undefined;
}

/**
 * Read and parse `chatLanguageModels.json`.
 * Returns an empty array on any error (file missing, parse error, etc.).
 */
function readChatLanguageModels(): ChatLanguageModelConfig[] {
	try {
		const filePath = getChatLanguageModelsPath();
		if (!filePath) {
			return [];
		}
		const raw = readFileSync(filePath, 'utf-8');
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) {
			logger.warn(`chatLanguageModels.json: expected array, got ${typeof parsed}`);
			return [];
		}
		return parsed;
	} catch (error) {
		logger.debug('chatLanguageModels.json not found or unreadable', error);
		return [];
	}
}

/**
 * Detect `customendpoint` vendor configurations from `chatLanguageModels.json`
 * that have DeepSeek-like model IDs (ids containing "deepseek").
 *
 * Returns the first matching configuration, or `undefined` if none found.
 */
export function detectCustomEndpointConfig(): DetectedCustomEndpoint | undefined {
	const configs = readChatLanguageModels();
	for (const entry of configs) {
		if (entry.vendor !== 'customendpoint' && entry.vendor !== 'copilot-customendpoint') {
			continue;
		}
		if (!entry.models || entry.models.length === 0) {
			continue;
		}

		// Look for DeepSeek models in this custom endpoint config
		const deepseekModels = entry.models.filter(
			(m) => m.id.toLowerCase().includes('deepseek'),
		);
		if (deepseekModels.length === 0) {
			continue;
		}

		// Use the URL from the first DeepSeek model as the base URL
		const firstModel = deepseekModels[0];
		const baseUrl = firstModel.url?.replace(/\/+$/u, '');

		logger.info(
			`Detected custom endpoint config "${entry.name ?? 'unnamed'}" ` +
				`with ${deepseekModels.length} DeepSeek model(s) at ${baseUrl}`,
		);

		return {
			label: entry.name ?? 'Custom Endpoint',
			baseUrl: baseUrl ?? '',
			apiType: entry.apiType ?? 'chat-completions',
			rawApiKey: entry.apiKey,
			models: deepseekModels.map((m) => ({
				id: m.id,
				name: m.name ?? m.id,
				maxInputTokens: m.maxInputTokens ?? DEFAULT_MAX_INPUT,
				maxOutputTokens: m.maxOutputTokens ?? DEFAULT_MAX_OUTPUT,
				supportsToolCalling: m.toolCalling ?? true,
			})),
		};
	}

	return undefined;
}

/**
 * Check whether a custom endpoint config has been detected for DeepSeek models.
 * This is called during activation to conditionally enable UIS integration.
 */
export async function checkAndApplyUISConfig(
	context: vscode.ExtensionContext,
): Promise<DetectedCustomEndpoint | undefined> {
	const config = detectCustomEndpointConfig();
	if (!config) {
		return undefined;
	}

	// Log what we found
	logger.info(
		`UIS gateway detected: "${config.label}" at ${config.baseUrl} ` +
			`with models: ${config.models.map((m) => m.id).join(', ')}`,
	);

	return config;
}

/**
 * Try to extract a usable API key from the raw apiKey string in the config.
 * The `${input:...}` secret references cannot be resolved from an extension.
 * Returns `undefined` for non-literal values (the user must configure the key
 * separately via the extension's UI).
 */
export function extractApiKeyFromConfig(rawApiKey: string | undefined): string | undefined {
	if (!rawApiKey) {
		return undefined;
	}
	// `${input:...}` is a VS Code-supplied secret reference — cannot resolve
	if (rawApiKey.startsWith('${input:') || rawApiKey.startsWith('${command:')) {
		return undefined;
	}
	return rawApiKey.trim() || undefined;
}
