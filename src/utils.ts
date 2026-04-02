import * as vscode from "vscode";
import type { HFModelItem, RetryConfig, ModelGroup, GroupModelConfig, ResolvedModel } from "./types";
import { resolveToHFModelItem } from "./types";
import { OpenAIFunctionToolDef } from "./openai/openaiTypes";

const RETRY_MAX_ATTEMPTS = 3;
const RETRY_INTERVAL_MS = 1000;

// HTTP status codes that should trigger a retry
const RETRYABLE_STATUS_CODES = [429, 500, 502, 503, 504];

// Network error patterns to retry
const networkErrorPatterns = [
	"fetch failed",
	"ECONNRESET",
	"ETIMEDOUT",
	"ENOTFOUND",
	"ECONNREFUSED",
	"timeout",
	"TIMEOUT",
	"network error",
	"NetworkError",
];

// Model ID parsing helper
export interface ParsedModelId {
	baseId: string;
	configId?: string;
}

export function getModelProviderId(model: unknown): string {
	if (!model || typeof model !== "object") {
		return "";
	}
	const obj = model as Record<string, unknown>;
	const pick = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
	return (
		pick(obj.owned_by) ||
		pick(obj.provide) ||
		pick(obj.provider) ||
		pick(obj.ownedBy) ||
		pick(obj.owner) ||
		pick(obj.vendor)
	);
}

export function normalizeUserModels(models: unknown): HFModelItem[] {
	const list = Array.isArray(models) ? models : [];
	const out: HFModelItem[] = [];
	for (const item of list) {
		if (!item || typeof item !== "object") {
			continue;
		}
		const provider = getModelProviderId(item);
		out.push({ ...(item as HFModelItem), owned_by: provider });
	}
	return out;
}

// ─── Group-based model management utilities ──────────────────────────────────

/** Model ID separator between group name and model id: "groupName/modelId" */
const GROUP_MODEL_SEPARATOR = "/";

/**
 * Parse a composite model ID in the format "groupName/modelId".
 * Returns { groupName, modelId } or null if the format is not a group model ID.
 */
export interface ParsedGroupModelId {
	groupName: string;
	modelId: string;
}

export function parseGroupModelId(compositeId: string): ParsedGroupModelId | null {
	const idx = compositeId.indexOf(GROUP_MODEL_SEPARATOR);
	if (idx <= 0 || idx === compositeId.length - 1) {
		return null;
	}
	return {
		groupName: compositeId.slice(0, idx),
		modelId: compositeId.slice(idx + 1),
	};
}

/**
 * Build a composite model ID from group name and model id.
 */
export function buildGroupModelId(groupName: string, modelId: string): string {
	return `${groupName}${GROUP_MODEL_SEPARATOR}${modelId}`;
}

/**
 * Load model groups from VS Code workspace configuration.
 */
export function loadGroups(): ModelGroup[] {
	const config = vscode.workspace.getConfiguration();
	const raw = config.get<unknown[]>("oaicopilot.groups", []);
	if (!Array.isArray(raw)) {
		return [];
	}
	const groups: ModelGroup[] = [];
	for (const item of raw) {
		if (!item || typeof item !== "object") {
			continue;
		}
		const obj = item as Record<string, unknown>;
		const name = typeof obj.name === "string" ? obj.name.trim() : "";
		const baseUrl = typeof obj.baseUrl === "string" ? obj.baseUrl.trim() : "";
		const apiMode = typeof obj.apiMode === "string" ? obj.apiMode : "openai";
		if (!name || !baseUrl) {
			continue;
		}
		const models: GroupModelConfig[] = [];
		if (Array.isArray(obj.models)) {
			for (const m of obj.models) {
				if (m && typeof m === "object" && typeof (m as Record<string, unknown>).id === "string") {
					models.push(m as GroupModelConfig);
				}
			}
		}
		groups.push({
			name,
			apiMode: apiMode as ModelGroup["apiMode"],
			baseUrl,
			headers: obj.headers as Record<string, string> | undefined,
			models,
		});
	}
	return groups;
}

/**
 * Find a model in groups by composite ID ("groupName/modelId").
 * Returns a ResolvedModel or undefined if not found.
 */
export function findModelInGroups(compositeId: string, groups?: ModelGroup[]): ResolvedModel | undefined {
	const parsed = parseGroupModelId(compositeId);
	if (!parsed) {
		return undefined;
	}
	const loadedGroups = groups ?? loadGroups();
	const group = loadedGroups.find((g) => g.name === parsed.groupName);
	if (!group) {
		return undefined;
	}
	const model = group.models.find((m) => m.id === parsed.modelId);
	if (!model) {
		return undefined;
	}
	return { group, model };
}

/**
 * Convert a ResolvedModel to HFModelItem for use by API implementation layers.
 */
export function resolvedToHFModelItem(resolved: ResolvedModel): HFModelItem {
	return resolveToHFModelItem(resolved);
}

/**
 * Migrate old flat config (oaicopilot.baseUrl + oaicopilot.models) to new groups format.
 * Groups models by owned_by. Only runs if groups is empty and models is non-empty.
 * Returns true if migration was performed.
 */
export async function migrateOldConfig(): Promise<boolean> {
	const config = vscode.workspace.getConfiguration();
	const existingGroups = config.get<unknown[]>("oaicopilot.groups", []);
	if (Array.isArray(existingGroups) && existingGroups.length > 0) {
		return false; // already has groups, no migration needed
	}

	const oldModels = normalizeUserModels(config.get<unknown>("oaicopilot.models", []));
	if (oldModels.length === 0) {
		return false; // nothing to migrate
	}

	const globalBaseUrl = config.get<string>("oaicopilot.baseUrl", "");

	// Group models by owned_by (provider name)
	const byProvider = new Map<string, HFModelItem[]>();
	for (const m of oldModels) {
		const provider = m.owned_by || "default";
		if (!byProvider.has(provider)) {
			byProvider.set(provider, []);
		}
		byProvider.get(provider)!.push(m);
	}

	const groups: ModelGroup[] = [];
	for (const [providerName, models] of byProvider) {
		// Determine group-level settings from the first model
		const first = models[0];
		const baseUrl = first.baseUrl || globalBaseUrl;
		const apiMode = first.apiMode ?? "openai";

		const groupModels: GroupModelConfig[] = models.map((m) => ({
			id: m.id,
			displayName: m.displayName,
			family: m.family,
			context_length: m.context_length,
			max_tokens: m.max_tokens,
			max_completion_tokens: m.max_completion_tokens,
			vision: m.vision,
			temperature: m.temperature,
			top_p: m.top_p,
			top_k: m.top_k,
			min_p: m.min_p,
			frequency_penalty: m.frequency_penalty,
			presence_penalty: m.presence_penalty,
			repetition_penalty: m.repetition_penalty,
			enable_thinking: m.enable_thinking,
			thinking_budget: m.thinking_budget,
			thinking: m.thinking,
			reasoning_effort: m.reasoning_effort,
			reasoning: m.reasoning,
			include_reasoning_in_request: m.include_reasoning_in_request,
			extra: m.extra,
			useForCommitGeneration: m.useForCommitGeneration,
			delay: m.delay,
		}));

		groups.push({
			name: providerName,
			apiMode,
			baseUrl,
			headers: first.headers,
			models: groupModels,
		});
	}

	// Write new groups config
	await config.update("oaicopilot.groups", groups, vscode.ConfigurationTarget.Global);
	console.log(`[OAICopilot] Migrated ${oldModels.length} models into ${groups.length} groups.`);
	return true;
}

/**
 * Check whether we should use the new group-based config or fall back to legacy flat config.
 * Returns true if groups are configured.
 */
export function hasGroupConfig(): boolean {
	const config = vscode.workspace.getConfiguration();
	const groups = config.get<unknown[]>("oaicopilot.groups", []);
	return Array.isArray(groups) && groups.length > 0;
}

/**
 * Parse a model ID that may contain a configuration ID separator.
 * Format: "baseId::configId" or just "baseId"
 */
export function parseModelId(modelId: string): ParsedModelId {
	const parts = modelId.split("::");
	if (parts.length >= 2) {
		return {
			baseId: parts[0],
			configId: parts.slice(1).join("::"), // In case configId itself contains '::'
		};
	}
	return {
		baseId: modelId,
	};
}

/**
 * Map VS Code message role to OpenAI message role string.
 * @param message The message whose role is mapped.
 */
export function mapRole(message: vscode.LanguageModelChatRequestMessage): "user" | "assistant" | "system" {
	const USER = vscode.LanguageModelChatMessageRole.User as unknown as number;
	const ASSISTANT = vscode.LanguageModelChatMessageRole.Assistant as unknown as number;
	const r = message.role as unknown as number;
	if (r === USER) {
		return "user";
	}
	if (r === ASSISTANT) {
		return "assistant";
	}
	return "system";
}

/**
 * Convert VS Code tool definitions to OpenAI function tool definitions.
 * @param options Request options containing tools and toolMode.
 */
export function convertToolsToOpenAI(options?: vscode.ProvideLanguageModelChatResponseOptions): {
	tools?: OpenAIFunctionToolDef[];
	tool_choice?: "auto" | { type: "function"; function: { name: string } };
} {
	const tools = options?.tools ?? [];
	if (!tools || tools.length === 0) {
		return {};
	}

	const toolDefs: OpenAIFunctionToolDef[] = tools
		.filter((t) => t && typeof t === "object")
		.map((t) => {
			const name = t.name;
			const description = typeof t.description === "string" ? t.description : "";
			const params = t.inputSchema ?? { type: "object", properties: {} };
			return {
				type: "function" as const,
				function: {
					name,
					description,
					parameters: params,
				},
			} satisfies OpenAIFunctionToolDef;
		});

	let tool_choice: "auto" | { type: "function"; function: { name: string } } = "auto";
	if (options?.toolMode === vscode.LanguageModelChatToolMode.Required) {
		if (tools.length !== 1) {
			console.error("[OAI Compatible Model Provider] ToolMode.Required but multiple tools:", tools.length);
			throw new Error("LanguageModelChatToolMode.Required is not supported with more than one tool");
		}
		tool_choice = { type: "function", function: { name: tools[0].name } };
	}

	return { tools: toolDefs, tool_choice };
}

export interface OpenAIResponsesFunctionToolDef {
	type: "function";
	name: string;
	description?: string;
	parameters?: object;
}

export type OpenAIResponsesToolChoice = "auto" | { type: "function"; name: string };

/**
 * Convert VS Code tool definitions to OpenAI Responses API tool definitions.
 * Responses uses `{ type:"function", name, description, parameters }` (no nested `function` object).
 */
export function convertToolsToOpenAIResponses(options?: vscode.ProvideLanguageModelChatResponseOptions): {
	tools?: OpenAIResponsesFunctionToolDef[];
	tool_choice?: OpenAIResponsesToolChoice;
} {
	const toolConfig = convertToolsToOpenAI(options);
	if (!toolConfig.tools || toolConfig.tools.length === 0) {
		return {};
	}

	const tools: OpenAIResponsesFunctionToolDef[] = toolConfig.tools.map((t) => {
		const out: OpenAIResponsesFunctionToolDef = {
			type: "function",
			name: t.function.name,
		};
		if (t.function.description) {
			out.description = t.function.description;
		}
		if (t.function.parameters) {
			out.parameters = t.function.parameters;
		}
		return out;
	});

	let tool_choice: OpenAIResponsesToolChoice | undefined;
	if (toolConfig.tool_choice === "auto") {
		tool_choice = "auto";
	} else if (toolConfig.tool_choice?.type === "function") {
		tool_choice = { type: "function", name: toolConfig.tool_choice.function.name };
	}

	return { tools, tool_choice };
}

/**
 * 检查是否为图片MIME类型
 */
export function isImageMimeType(mimeType: string): boolean {
	return mimeType.startsWith("image/") && ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(mimeType);
}

/**
 * 创建图片的data URL
 */
export function createDataUrl(dataPart: vscode.LanguageModelDataPart): string {
	const base64Data = Buffer.from(dataPart.data).toString("base64");
	return `data:${dataPart.mimeType};base64,${base64Data}`;
}

/**
 * Type guard for LanguageModelToolResultPart-like values.
 * @param value Unknown value to test.
 */
export function isToolResultPart(value: unknown): value is { callId: string; content?: ReadonlyArray<unknown> } {
	if (!value || typeof value !== "object") {
		return false;
	}
	const obj = value as Record<string, unknown>;
	const hasCallId = typeof obj.callId === "string";
	const hasContent = "content" in obj;
	return hasCallId && hasContent;
}

/**
 * Concatenate tool result content into a single text string.
 * @param pr Tool result-like object with content array.
 */
export function collectToolResultText(pr: { content?: ReadonlyArray<unknown> }): string {
	let text = "";
	for (const c of pr.content ?? []) {
		if (c instanceof vscode.LanguageModelTextPart) {
			text += c.value;
		} else if (typeof c === "string") {
			text += c;
		} else if (c instanceof vscode.LanguageModelDataPart && c.mimeType === "cache_control") {
			/* ignore */
		} else {
			try {
				text += JSON.stringify(c);
			} catch {
				/* ignore */
			}
		}
	}
	return text;
}

/**
 * Try to parse a JSON object from a string.
 * @param text The input string.
 * @returns Parsed object or ok:false.
 */
export function tryParseJSONObject(text: string): { ok: true; value: Record<string, unknown> } | { ok: false } {
	try {
		if (!text || !/[{]/.test(text)) {
			return { ok: false };
		}
		const value = JSON.parse(text);
		if (value && typeof value === "object" && !Array.isArray(value)) {
			return { ok: true, value };
		}
		return { ok: false };
	} catch {
		return { ok: false };
	}
}

/**
 * Create retry configuration from VS Code workspace settings.
 * @returns Retry configuration with default values.
 */
export function createRetryConfig(): RetryConfig {
	const config = vscode.workspace.getConfiguration();
	const retryConfig = config.get<RetryConfig>("oaicopilot.retry", {
		enabled: true,
		max_attempts: RETRY_MAX_ATTEMPTS,
		interval_ms: RETRY_INTERVAL_MS,
	});

	return {
		enabled: retryConfig.enabled ?? true,
		max_attempts: retryConfig.max_attempts ?? RETRY_MAX_ATTEMPTS,
		interval_ms: retryConfig.interval_ms ?? RETRY_INTERVAL_MS,
		status_codes: retryConfig.status_codes,
	};
}

/**
 * Execute a function with retry logic for rate limiting.
 * @param fn The async function to execute
 * @param retryConfig Retry configuration
 * @param token Cancellation token
 * @returns Result of the function execution
 */
export async function executeWithRetry<T>(fn: () => Promise<T>, retryConfig: RetryConfig): Promise<T> {
	if (!retryConfig.enabled) {
		return await fn();
	}

	const maxAttempts = retryConfig.max_attempts ?? RETRY_MAX_ATTEMPTS;
	const intervalMs = retryConfig.interval_ms ?? RETRY_INTERVAL_MS;
	// Merge user-configured status codes with default ones, removing duplicates
	const retryableStatusCodes = retryConfig.status_codes
		? [...new Set([...RETRYABLE_STATUS_CODES, ...retryConfig.status_codes])]
		: RETRYABLE_STATUS_CODES;
	let lastError: Error | undefined;

	for (let attempt = 0; attempt <= maxAttempts; attempt++) {
		try {
			return await fn();
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));

			// Check if error is retryable based on status codes
			const isRetryableStatusError = retryableStatusCodes.some((code) => lastError?.message.includes(`[${code}]`));
			// Check if error is retryable based on network error patterns
			const isRetryableNetworkError = networkErrorPatterns.some((pattern) => lastError?.message.includes(pattern));
			const isRetryableError = isRetryableStatusError || isRetryableNetworkError;

			if (!isRetryableError || attempt === maxAttempts) {
				throw lastError;
			}

			console.error(
				`[OAI Compatible Model Provider] Retryable error detected, retrying in ${intervalMs}ms (attempt ${attempt + 1}/${maxAttempts}). Error:`,
				lastError instanceof Error ? { name: lastError.name, message: lastError.message } : String(lastError)
			);

			// Wait for the specified interval before retrying
			await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
		}
	}

	// This should never be reached, but TypeScript needs it
	throw lastError || new Error("Retry failed");
}
