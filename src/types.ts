/**
 * A single underlying provider (e.g., together, groq) for a model.
 */
export interface HFProvider {
	provider: string;
	status: string;
	supports_tools?: boolean;
	supports_structured_output?: boolean;
	context_length?: number;
}

/**
 * A model entry returned by the Hugging Face router models endpoint.
 */
export interface HFArchitecture {
	input_modalities?: string[];
	output_modalities?: string[];
}

export interface HFModelItem {
	id: string;
	object?: string;
	created?: number;
	owned_by: string;
	configId?: string;
	displayName?: string;
	baseUrl?: string;
	providers?: HFProvider[];
	architecture?: HFArchitecture;
	context_length?: number;
	vision?: boolean;
	max_tokens?: number;
	// OpenAI new standard parameter
	max_completion_tokens?: number;
	reasoning_effort?: string;
	enable_thinking?: boolean;
	thinking_budget?: number;
	// New thinking configuration for Zai provider
	thinking?: ThinkingConfig;
	// Allow null so user can explicitly disable sending this parameter (fall back to provider default)
	temperature?: number | null;
	// Allow null so user can explicitly disable sending this parameter (fall back to provider default)
	top_p?: number | null;
	top_k?: number;
	min_p?: number;
	frequency_penalty?: number;
	presence_penalty?: number;
	repetition_penalty?: number;
	reasoning?: ReasoningConfig;
	/**
	 * Optional family specification for the model. This allows users to specify
	 * the model family (e.g., "gpt-4", "claude-3", "gemini") to enable family-specific
	 * optimizations and behaviors in the Copilot extension. If not specified,
	 * defaults to "oai-compatible".
	 */
	family?: string;

	/**
	 * Extra configuration parameters that can be used for custom functionality.
	 * This allows users to add any additional parameters they might need
	 * without modifying the core interface.
	 */
	extra?: Record<string, unknown>;

	/**
	 * Custom HTTP headers to be sent with every request to this model's provider.
	 * These headers will be merged with the default headers (Authorization, Content-Type, User-Agent).
	 * Example: { "X-API-Version": "v1", "X-Custom-Header": "value" }
	 */
	headers?: Record<string, string>;

	/**
	 * Whether to include reasoning_content in assistant messages sent to the API.
	 * Support deepseek-v3.2 or others.
	 */
	include_reasoning_in_request?: boolean;

	/**
	 * API mode: "openai" for OpenAI Chat Completions, "openai-responses" for OpenAI Responses,
	 * "ollama" for Ollama native API, "anthropic" for Anthropic Messages, "gemini" for Gemini native API.
	 * Default is "openai".
	 */
	apiMode?: HFApiMode;

	/**
	 * Whether this model can be used for Git commit message generation.
	 * If true, this model will be available for generating commit messages.
	 * Default is false.
	 */
	useForCommitGeneration?: boolean;

	/**
	 * Model-specific delay in milliseconds between consecutive requests.
	 * If not specified, falls back to global `oaicopilot.delay` configuration.
	 */
	delay?: number;
}

/**
 * OpenRouter reasoning configuration
 */
export interface ReasoningConfig {
	effort?: string;
	exclude?: boolean;
	max_tokens?: number;
	enabled?: boolean;
}

/**
 * Supplemental model info from the Hugging Face hub API.
 */
// Deprecated: extra model info was previously fetched from the hub API
export interface HFExtraModelInfo {
	id: string;
	pipeline_tag?: string;
}

/**
 * Response envelope for the router models listing.
 */
export interface HFModelsResponse {
	object: string;
	data: HFModelItem[];
}

/**
 * Thinking configuration for Zai provider
 */
export interface ThinkingConfig {
	type?: string;
}

/**
 * Retry configuration for rate limiting
 */
export interface RetryConfig {
	enabled?: boolean;
	max_attempts?: number;
	interval_ms?: number;
	status_codes?: number[];
}

/** Supports API mode. */
export type HFApiMode = "openai" | "openai-responses" | "ollama" | "anthropic" | "gemini";

// ─── Group-based model management ────────────────────────────────────────────

/**
 * A model group that represents a single provider endpoint.
 * Each group has one apiMode, one baseUrl, one apiKey, and multiple models.
 */
export interface ModelGroup {
	/** Unique group name (e.g., "DeepSeek", "Claude", "Local-Ollama") */
	name: string;
	/** API protocol for this group */
	apiMode: HFApiMode;
	/** Base URL for the API endpoint */
	baseUrl: string;
	/** Custom HTTP headers merged with defaults */
	headers?: Record<string, string>;
	/** Models configured under this group */
	models: GroupModelConfig[];
}

/**
 * Model-level configuration within a group.
 * Provider-level settings (apiMode, baseUrl, apiKey, headers) come from the parent group.
 */
export interface GroupModelConfig {
	/** Model ID sent to the API (e.g., "deepseek-chat", "claude-sonnet-4-20250514") */
	id: string;
	/** Display name shown in the Copilot model picker */
	displayName?: string;
	/** Model family for family-specific optimizations */
	family?: string;
	/** Context window size in tokens. Default: 128000 */
	context_length?: number;
	/** Maximum output tokens. Default: 4096 */
	max_tokens?: number;
	/** Maximum output tokens (OpenAI new standard parameter, takes precedence over max_tokens) */
	max_completion_tokens?: number;
	/** Whether the model supports image input */
	vision?: boolean;
	/** Sampling temperature (0-2) */
	temperature?: number | null;
	/** Top-p sampling */
	top_p?: number | null;
	/** Top-k sampling */
	top_k?: number;
	/** Minimum probability threshold */
	min_p?: number;
	/** Frequency penalty */
	frequency_penalty?: number;
	/** Presence penalty */
	presence_penalty?: number;
	/** Repetition penalty */
	repetition_penalty?: number;
	/** Enable thinking/reasoning mode */
	enable_thinking?: boolean;
	/** Token budget for thinking chain output */
	thinking_budget?: number;
	/** Thinking configuration (Zai provider style) */
	thinking?: ThinkingConfig;
	/** Reasoning effort level (OpenAI style) */
	reasoning_effort?: string;
	/** Reasoning configuration (OpenRouter style) */
	reasoning?: ReasoningConfig;
	/** Whether to include reasoning_content in assistant messages */
	include_reasoning_in_request?: boolean;
	/** Extra request body parameters */
	extra?: Record<string, unknown>;
	/** Whether this model can be used for Git commit message generation */
	useForCommitGeneration?: boolean;
	/** Per-model request delay in ms */
	delay?: number;
}

/**
 * Internal resolved model: group + model merged, ready for API calls.
 * Used by provider.ts after looking up a model from groups.
 */
export interface ResolvedModel {
	group: ModelGroup;
	model: GroupModelConfig;
}

/**
 * Convert a ResolvedModel to the HFModelItem format expected by API implementation layers.
 * This bridges the new group-based config to the existing API adapters (OpenaiApi, AnthropicApi, etc.).
 */
export function resolveToHFModelItem(resolved: ResolvedModel): HFModelItem {
	const { group, model } = resolved;
	return {
		id: model.id,
		owned_by: group.name,
		displayName: model.displayName,
		baseUrl: group.baseUrl,
		apiMode: group.apiMode,
		headers: group.headers,
		family: model.family,
		context_length: model.context_length,
		max_tokens: model.max_tokens,
		max_completion_tokens: model.max_completion_tokens,
		vision: model.vision,
		temperature: model.temperature,
		top_p: model.top_p,
		top_k: model.top_k,
		min_p: model.min_p,
		frequency_penalty: model.frequency_penalty,
		presence_penalty: model.presence_penalty,
		repetition_penalty: model.repetition_penalty,
		enable_thinking: model.enable_thinking,
		thinking_budget: model.thinking_budget,
		thinking: model.thinking,
		reasoning_effort: model.reasoning_effort,
		reasoning: model.reasoning,
		include_reasoning_in_request: model.include_reasoning_in_request,
		extra: model.extra,
		useForCommitGeneration: model.useForCommitGeneration,
		delay: model.delay,
	};
}
