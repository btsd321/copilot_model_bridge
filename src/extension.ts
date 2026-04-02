import * as vscode from "vscode";
import { HuggingFaceChatModelProvider } from "./provider";
import type { HFModelItem, HFApiMode, GroupModelConfig } from "./types";
import { initStatusBar } from "./statusBar";
import { ConfigViewPanel } from "./views/configView";
import { normalizeUserModels, loadGroups, migrateOldConfig, hasGroupConfig } from "./utils";
import { abortCommitGeneration, generateCommitMsg } from "./gitCommit/commitMessageGenerator";
import { TokenizerManager } from "./tokenizer/tokenizerManager";
import { logger } from "./log/logger";

export function activate(context: vscode.ExtensionContext) {
	// Initialize logger output channel
	logger.init(vscode.window.createOutputChannel("OAICopilot"));

	// Initialize TokenizerManager with extension path
	TokenizerManager.initialize(context.extensionPath);

	// Auto-migrate old flat config to groups on first activation
	migrateOldConfig().catch((err) =>
		logger.error("Migration failed:", err)
	);

	const tokenCountStatusBarItem: vscode.StatusBarItem = initStatusBar(context);
	const provider = new HuggingFaceChatModelProvider(context.secrets, tokenCountStatusBarItem);
	// Register the Hugging Face provider under the vendor id used in package.json
	vscode.lm.registerLanguageModelChatProvider("oaicopilot", provider);

	// Management command to configure API key
	context.subscriptions.push(
		vscode.commands.registerCommand("oaicopilot.setApikey", async () => {
			const existing = await context.secrets.get("oaicopilot.apiKey");
			const apiKey = await vscode.window.showInputBox({
				title: "OAI Compatible Provider API Key",
				prompt: existing ? "Update your OAI Compatible API key" : "Enter your OAI Compatible API key",
				ignoreFocusOut: true,
				password: true,
				value: existing ?? "",
			});
			if (apiKey === undefined) {
				return; // user canceled
			}
			if (!apiKey.trim()) {
				await context.secrets.delete("oaicopilot.apiKey");
				vscode.window.showInformationMessage("OAI Compatible API key cleared.");
				return;
			}
			await context.secrets.store("oaicopilot.apiKey", apiKey.trim());
			vscode.window.showInformationMessage("OAI Compatible API key saved.");
		})
	);

	// Management command to configure provider-specific API keys (supports both groups and legacy)
	context.subscriptions.push(
		vscode.commands.registerCommand("oaicopilot.setProviderApikey", async () => {
			// Collect provider names from groups and/or legacy models
			const providerNames: string[] = [];

			if (hasGroupConfig()) {
				const groups = loadGroups();
				for (const g of groups) {
					const name = g.name.trim().toLowerCase();
					if (name && !providerNames.includes(name)) {
						providerNames.push(name);
					}
				}
			} else {
				const config = vscode.workspace.getConfiguration();
				const userModels = normalizeUserModels(config.get<HFModelItem[]>("oaicopilot.models", []));
				for (const m of userModels) {
					const name = m.owned_by?.toLowerCase().trim();
					if (name && !providerNames.includes(name)) {
						providerNames.push(name);
					}
				}
			}
			providerNames.sort();

			if (providerNames.length === 0) {
				vscode.window.showErrorMessage(
					"No providers/groups found. Please configure oaicopilot.groups or oaicopilot.models first."
				);
				return;
			}

			const selectedProvider = await vscode.window.showQuickPick(providerNames, {
				title: "Select Provider / Group",
				placeHolder: "Select a provider or group to configure API key",
			});
			if (!selectedProvider) {
				return;
			}

			const providerKey = `oaicopilot.apiKey.${selectedProvider}`;
			const existing = await context.secrets.get(providerKey);

			const apiKey = await vscode.window.showInputBox({
				title: `API Key for ${selectedProvider}`,
				prompt: existing ? `Update API key for ${selectedProvider}` : `Enter API key for ${selectedProvider}`,
				ignoreFocusOut: true,
				password: true,
				value: existing ?? "",
			});

			if (apiKey === undefined) {
				return;
			}
			if (!apiKey.trim()) {
				await context.secrets.delete(providerKey);
				vscode.window.showInformationMessage(`API key for ${selectedProvider} cleared.`);
				return;
			}
			await context.secrets.store(providerKey, apiKey.trim());
			vscode.window.showInformationMessage(`API key for ${selectedProvider} saved.`);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("oaicopilot.openConfig", async () => {
			ConfigViewPanel.openPanel(context.extensionUri, context.secrets);
		})
	);

	// Multi-step wizard: Add a new model group
	context.subscriptions.push(
		vscode.commands.registerCommand("oaicopilot.addGroup", async () => {
			// Step 1: Group name
			const groupName = await vscode.window.showInputBox({
				title: "Add Model Group (1/4): Group Name",
				prompt: "Enter a unique group name (e.g., DeepSeek, Claude, Local-Ollama)",
				ignoreFocusOut: true,
				validateInput: (val) => {
					if (!val.trim()) { return "Group name is required"; }
					if (val.includes("/")) { return "Group name cannot contain '/'"; }
					const existing = loadGroups();
					if (existing.some((g) => g.name.toLowerCase() === val.trim().toLowerCase())) {
						return `Group "${val.trim()}" already exists`;
					}
					return undefined;
				},
			});
			if (!groupName) { return; }

			// Step 2: API mode
			const apiModeItems: vscode.QuickPickItem[] = [
				{ label: "openai", description: "OpenAI-compatible API (default)" },
				{ label: "openai-responses", description: "OpenAI Responses API" },
				{ label: "anthropic", description: "Anthropic / Claude API" },
				{ label: "ollama", description: "Ollama native API" },
				{ label: "gemini", description: "Google Gemini API" },
			];
			const selectedMode = await vscode.window.showQuickPick(apiModeItems, {
				title: "Add Model Group (2/4): API Mode",
				placeHolder: "Select the API protocol for this group",
			});
			if (!selectedMode) { return; }
			const apiMode = selectedMode.label as HFApiMode;

			// Step 3: API key
			const apiKey = await vscode.window.showInputBox({
				title: "Add Model Group (3/4): API Key",
				prompt: `Enter the API key for ${groupName.trim()}`,
				ignoreFocusOut: true,
				password: true,
			});
			if (apiKey === undefined) { return; }
			if (apiKey.trim()) {
				const keyName = `oaicopilot.apiKey.${groupName.trim().toLowerCase()}`;
				await context.secrets.store(keyName, apiKey.trim());
			}

			// Step 4: Base URL
			const defaultUrls: Record<string, string> = {
				"openai": "https://api.openai.com/v1",
				"openai-responses": "https://api.openai.com/v1",
				"anthropic": "https://api.anthropic.com",
				"ollama": "http://localhost:11434",
				"gemini": "https://generativelanguage.googleapis.com/v1beta",
			};
			const baseUrl = await vscode.window.showInputBox({
				title: "Add Model Group (4/4): Base URL",
				prompt: `Enter the base URL for ${groupName.trim()}`,
				ignoreFocusOut: true,
				value: defaultUrls[apiMode] ?? "",
				validateInput: (val) => {
					if (!val.trim()) { return "Base URL is required"; }
					if (!val.trim().startsWith("http")) { return "Base URL must start with http:// or https://"; }
					return undefined;
				},
			});
			if (!baseUrl) { return; }

			// Save the new group
			const config = vscode.workspace.getConfiguration();
			const existingGroups = config.get<unknown[]>("oaicopilot.groups", []);
			const groups = Array.isArray(existingGroups) ? [...existingGroups] : [];
			groups.push({
				name: groupName.trim(),
				apiMode,
				baseUrl: baseUrl.trim(),
				models: [],
			});
			await config.update("oaicopilot.groups", groups, vscode.ConfigurationTarget.Global);
			vscode.window.showInformationMessage(
				`Group "${groupName.trim()}" added. Open settings to add models to this group.`
			);
		})
	);

	// Add a model to an existing group
	context.subscriptions.push(
		vscode.commands.registerCommand("oaicopilot.addModelToGroup", async () => {
			const groups = loadGroups();
			if (groups.length === 0) {
				const createNow = await vscode.window.showInformationMessage(
					"No groups configured. Create a group first.",
					"Add Group"
				);
				if (createNow === "Add Group") {
					vscode.commands.executeCommand("oaicopilot.addGroup");
				}
				return;
			}

			// Pick group
			const groupItems = groups.map((g) => ({
				label: g.name,
				description: `${g.apiMode} · ${g.baseUrl}`,
			}));
			const selectedGroup = await vscode.window.showQuickPick(groupItems, {
				title: "Add Model: Select Group",
				placeHolder: "Select the group to add a model to",
			});
			if (!selectedGroup) { return; }

			// Model ID
			const modelId = await vscode.window.showInputBox({
				title: "Add Model: Model ID",
				prompt: "Enter the model ID (e.g., deepseek-chat, claude-sonnet-4-20250514)",
				ignoreFocusOut: true,
				validateInput: (val) => val.trim() ? undefined : "Model ID is required",
			});
			if (!modelId) { return; }

			// Display name (optional)
			const displayName = await vscode.window.showInputBox({
				title: "Add Model: Display Name (optional)",
				prompt: "Enter a display name for the model picker (leave empty to use model ID)",
				ignoreFocusOut: true,
			});
			if (displayName === undefined) { return; }

			// Context length
			const ctxInput = await vscode.window.showInputBox({
				title: "Add Model: Context Length",
				prompt: "Maximum context window in tokens",
				ignoreFocusOut: true,
				value: "128000",
				validateInput: (val) => {
					const n = parseInt(val, 10);
					return isNaN(n) || n <= 0 ? "Enter a positive number" : undefined;
				},
			});
			if (ctxInput === undefined) { return; }

			// Max output tokens
			const maxOutInput = await vscode.window.showInputBox({
				title: "Add Model: Max Output Tokens",
				prompt: "Maximum output tokens per response",
				ignoreFocusOut: true,
				value: "4096",
				validateInput: (val) => {
					const n = parseInt(val, 10);
					return isNaN(n) || n <= 0 ? "Enter a positive number" : undefined;
				},
			});
			if (maxOutInput === undefined) { return; }

			const newModel: GroupModelConfig = {
				id: modelId.trim(),
				...(displayName?.trim() ? { displayName: displayName.trim() } : {}),
				context_length: parseInt(ctxInput, 10),
				max_tokens: parseInt(maxOutInput, 10),
			};

			// Write to config
			const config = vscode.workspace.getConfiguration();
			const rawGroups = config.get<unknown[]>("oaicopilot.groups", []) as Record<string, unknown>[];
			const updated = rawGroups.map((g) => {
				if ((g as { name?: string }).name === selectedGroup.label) {
					const models = Array.isArray(g.models) ? [...g.models, newModel] : [newModel];
					return { ...g, models };
				}
				return g;
			});
			await config.update("oaicopilot.groups", updated, vscode.ConfigurationTarget.Global);
			vscode.window.showInformationMessage(
				`Model "${newModel.id}" added to group "${selectedGroup.label}".`
			);
		})
	);

	// Register the generateGitCommitMessage command handler
	context.subscriptions.push(
		vscode.commands.registerCommand("oaicopilot.generateGitCommitMessage", async (scm) => {
			generateCommitMsg(context.secrets, scm);
		}),
		vscode.commands.registerCommand("oaicopilot.abortGitCommitMessage", () => {
			abortCommitGeneration();
		})
	);
}

export function deactivate() {}
