import vscode from 'vscode';
import { CONFIG_SECTION } from './consts';

export type DebugMode = 'minimal' | 'metadata' | 'verbose';

// ──────────────────────────────────────────────
//  Direct connection (original DeepSeek API)
// ──────────────────────────────────────────────

/**
 * Get DeepSeek API base URL from settings.
 * Controls where **direct-connection** models send requests.
 * Defaults to the official DeepSeek API endpoint.
 */
export function getBaseUrl(): string {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	return config.get<string>('baseUrl') || 'https://api.deepseek.com';
}

// ──────────────────────────────────────────────
//  Proxy configuration
// ──────────────────────────────────────────────

/** Suffix appended to model IDs for proxy-routed model variants. */
export const PROXY_MODEL_SUFFIX = '-proxy';

/**
 * Whether proxy mode is enabled.
 * When enabled, additional proxy-routed models appear alongside direct models.
 */
export function isProxyEnabled(): boolean {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	return config.get<boolean>('proxyEnabled', false);
}

/**
 * Get the proxy display label (e.g. "UIS", "Company Gateway").
 * Shown in the model picker to distinguish proxy models.
 */
export function getProxyLabel(): string {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	return config.get<string>('proxyLabel', 'Proxy').trim() || 'Proxy';
}

/**
 * Get the proxy endpoint base URL.
 * Returns `undefined` if not configured or proxy is disabled.
 */
export function getProxyBaseUrl(): string | undefined {
	if (!isProxyEnabled()) {
		return undefined;
	}
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const url = config.get<string>('proxyBaseUrl', '').trim();
	return url || undefined;
}

/**
 * Check if a model ID corresponds to a proxy-routed model variant.
 */
export function isProxyModel(vscodeModelId: string): boolean {
	return vscodeModelId.endsWith(PROXY_MODEL_SUFFIX);
}

/**
 * Build the proxy variant model ID from a base model ID.
 * e.g. "deepseek-v4-flash" → "deepseek-v4-flash-proxy"
 */
export function toProxyModelId(baseModelId: string): string {
	return `${baseModelId}${PROXY_MODEL_SUFFIX}`;
}

/**
 * Strip proxy suffix to get the base model ID.
 * e.g. "deepseek-v4-flash-proxy" → "deepseek-v4-flash"
 * Falls back to the input if not a proxy model.
 */
export function fromProxyModelId(proxyModelId: string): string {
	return proxyModelId.endsWith(PROXY_MODEL_SUFFIX)
		? proxyModelId.slice(0, -PROXY_MODEL_SUFFIX.length)
		: proxyModelId;
}

/**
 * Resolve the API model ID to send to the endpoint.
 * Strips the proxy suffix, then applies user-defined modelIdOverrides.
 */
export function getApiModelId(vscodeModelId: string): string {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const overrides = config.get<Record<string, string>>('modelIdOverrides');
	const baseId = fromProxyModelId(vscodeModelId);
	const override = overrides?.[baseId]?.trim();
	return override || baseId;
}

/**
 * Get the configured max output tokens limit.
 * Returns `undefined` when set to 0 (API default — no limit).
 */
export function getMaxTokens(): number | undefined {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const value = config.get<number>('maxTokens', 0);
	return value > 0 ? value : undefined;
}

/**
 * Diagnostic mode. `verbose` also enables metadata logs.
 *
 * The legacy boolean `debug` setting is still read as a fallback so old
 * settings keep working even if migration cannot update every scope.
 */
export function getDebugMode(): DebugMode {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const mode = getConfiguredDebugMode(config);
	if (mode) return mode;

	return config.get<boolean>('debug', false) ? 'metadata' : 'minimal';
}

/**
 * Whether to log privacy-preserving diagnostic debug information.
 */
export function getDebugLoggingEnabled(): boolean {
	return getDebugMode() !== 'minimal';
}

/**
 * Whether to write full DeepSeek request payloads to disk.
 */
export function getRequestDumpEnabled(): boolean {
	return getDebugMode() === 'verbose';
}

export function getStabilizeToolListEnabled(): boolean {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	return config.get<boolean>('experimental.stabilizeToolList', false);
}

/**
 * Migrate the legacy boolean `deepseek-copilot.debug` setting to `debugMode`.
 *
 * `debug: true` maps to `debugMode: metadata`; `debug: false` maps to the
 * default `minimal`, so it only needs cleanup.
 */
export async function migrateLegacyDebugSetting(): Promise<void> {
	await migrateLegacyDebugSettingAtScope(vscode.ConfigurationTarget.Global);
	if (vscode.workspace.workspaceFile || vscode.workspace.workspaceFolders?.length) {
		await migrateLegacyDebugSettingAtScope(vscode.ConfigurationTarget.Workspace);
	}
}

function getConfiguredDebugMode(config: vscode.WorkspaceConfiguration): DebugMode | undefined {
	const mode = config.inspect<unknown>('debugMode');
	return normalizeDebugMode(mode?.workspaceValue) ?? normalizeDebugMode(mode?.globalValue);
}

function normalizeDebugMode(value: unknown): DebugMode | undefined {
	if (value === 'minimal' || value === 'metadata' || value === 'verbose') {
		return value;
	}
	return undefined;
}

async function migrateLegacyDebugSettingAtScope(
	target: vscode.ConfigurationTarget,
	resource?: vscode.Uri,
): Promise<void> {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION, resource);
	const legacy = config.inspect<boolean>('debug');
	const mode = config.inspect<DebugMode>('debugMode');
	const legacyValue = getScopedValue(legacy, target);

	if (legacyValue === undefined) {
		return;
	}

	if (legacyValue === true && getScopedValue(mode, target) === undefined) {
		await config.update('debugMode', 'metadata', target);
	}
	await config.update('debug', undefined, target);
}

function getScopedValue<T>(
	inspection:
		| {
				globalValue?: T;
				workspaceValue?: T;
				workspaceFolderValue?: T;
		  }
		| undefined,
	target: vscode.ConfigurationTarget,
): T | undefined {
	if (!inspection) {
		return undefined;
	}

	if (target === vscode.ConfigurationTarget.Global) {
		return inspection.globalValue;
	}
	if (target === vscode.ConfigurationTarget.Workspace) {
		return inspection.workspaceValue;
	}
	return undefined;
}
