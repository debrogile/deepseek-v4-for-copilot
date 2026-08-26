import vscode from 'vscode';
import { API_KEY_SECRET, PROXY_API_KEY_SECRET } from './consts';
import { t } from './i18n';

/**
 * Manages DeepSeek API keys via VS Code SecretStorage (secure).
 *
 * - **Main API key** (`API_KEY_SECRET`): used for direct-connection models.
 * - **Proxy API key** (`PROXY_API_KEY_SECRET`): used for proxy-routed models
 *   (e.g., UIS gateway). Falls back to the main key if not set separately.
 */
export class AuthManager {
	private readonly secretStorage: vscode.SecretStorage;

	constructor(context: vscode.ExtensionContext) {
		this.secretStorage = context.secrets;
	}

	// ── Main API key (direct connection) ──

	/**
	 * Get main API key. Tries SecretStorage first, then falls back to settings.
	 */
	async getApiKey(): Promise<string | undefined> {
		const secretKey = await this.secretStorage.get(API_KEY_SECRET);
		if (secretKey) {
			return secretKey;
		}

		const config = vscode.workspace.getConfiguration('deepseek-copilot');
		const settingsKey = config.get<string>('apiKey');
		if (settingsKey?.trim()) {
			return settingsKey.trim();
		}

		return undefined;
	}

	async setApiKey(apiKey: string): Promise<void> {
		await this.secretStorage.store(API_KEY_SECRET, apiKey.trim());
	}

	async deleteApiKey(): Promise<void> {
		await this.secretStorage.delete(API_KEY_SECRET);
	}

	async hasApiKey(): Promise<boolean> {
		const key = await this.getApiKey();
		return key !== undefined && key.length > 0;
	}

	async promptForApiKey(): Promise<boolean> {
		const apiKey = await vscode.window.showInputBox({
			prompt: t('auth.prompt'),
			placeHolder: t('auth.placeholder'),
			password: true,
			ignoreFocusOut: true,
			validateInput: (value: string) => {
				if (!value?.trim()) {
					return t('auth.emptyValidation');
				}
				return undefined;
			},
		});

		if (apiKey) {
			await this.setApiKey(apiKey);
			vscode.window.showInformationMessage(t('auth.saved'));
			return true;
		}

		return false;
	}

	// ── Proxy API key ──

	/**
	 * Get proxy API key. Falls back to the main API key if not set separately.
	 */
	async getProxyApiKey(): Promise<string | undefined> {
		const secretKey = await this.secretStorage.get(PROXY_API_KEY_SECRET);
		if (secretKey) {
			return secretKey;
		}

		// Fallback: use the same key as direct connection
		return this.getApiKey();
	}

	async setProxyApiKey(apiKey: string): Promise<void> {
		await this.secretStorage.store(PROXY_API_KEY_SECRET, apiKey.trim());
	}

	async deleteProxyApiKey(): Promise<void> {
		await this.secretStorage.delete(PROXY_API_KEY_SECRET);
	}

	async promptForProxyApiKey(): Promise<boolean> {
		const apiKey = await vscode.window.showInputBox({
			prompt: t('auth.proxyPrompt'),
			placeHolder: t('auth.proxyPlaceholder'),
			password: true,
			ignoreFocusOut: true,
			validateInput: (value: string) => {
				if (!value?.trim()) {
					return t('auth.emptyValidation');
				}
				return undefined;
			},
		});

		if (apiKey) {
			await this.setProxyApiKey(apiKey);
			vscode.window.showInformationMessage(t('auth.proxySaved'));
			return true;
		}

		return false;
	}
}
