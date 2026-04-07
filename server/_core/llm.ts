/**
 * Multi-Provider LLM Abstraction
 * 
 * Supports OpenAI (GPT-4o for vision) and Anthropic (Claude for text).
 * Maintains the same InvokeResult interface so all callers work unchanged.
 */

export type Role = "system" | "user" | "assistant" | "tool" | "function";

export type TextContent = {
  type: "text";
  text: string;
};

export type ImageContent = {
  type: "image_url";
  image_url: {
    url: string;
    detail?: "auto" | "low" | "high";
  };
};

export type FileContent = {
  type: "file_url";
  file_url: {
    url: string;
    mime_type?: "audio/mpeg" | "audio/wav" | "application/pdf" | "audio/mp4" | "video/mp4" ;
  };
};

export type MessageContent = string | TextContent | ImageContent | FileContent;

export type Message = {
  role: Role;
  content: MessageContent | MessageContent[];
  name?: string;
  tool_call_id?: string;
};

export type Tool = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
};

export type ToolChoicePrimitive = "none" | "auto" | "required";
export type ToolChoiceByName = { name: string };
export type ToolChoiceExplicit = {
  type: "function";
  function: {
    name: string;
  };
};

export type ToolChoice =
  | ToolChoicePrimitive
  | ToolChoiceByName
  | ToolChoiceExplicit;

export type InvokeParams = {
  messages: Message[];
  tools?: Tool[];
  toolChoice?: ToolChoice;
  tool_choice?: ToolChoice;
  maxTokens?: number;
  max_tokens?: number;
  outputSchema?: OutputSchema;
  output_schema?: OutputSchema;
  responseFormat?: ResponseFormat;
  response_format?: ResponseFormat;
};

export type ToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

export type InvokeResult = {
  id: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: Role;
      content: string | Array<TextContent | ImageContent | FileContent>;
      tool_calls?: ToolCall[];
    };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
};

export type JsonSchema = {
  name: string;
  schema: Record<string, unknown>;
  strict?: boolean;
};

export type OutputSchema = JsonSchema;

export type ResponseFormat =
  | { type: "text" }
  | { type: "json_object" }
  | { type: "json_schema"; json_schema: JsonSchema };

// ─── Provider Detection ─────────────────────────────────────────────────

type LlmProvider = "openai" | "anthropic";

function getProvider(): LlmProvider {
  const explicit = process.env.LLM_PROVIDER;
  if (explicit === "anthropic") return "anthropic";
  if (explicit === "openai") return "openai";
  
  // Auto-detect from available keys
  if (process.env.OPENAI_API_KEY) return "openai";
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  
  throw new Error(
    "No LLM provider configured. Set LLM_PROVIDER=openai or LLM_PROVIDER=anthropic, " +
    "and provide the corresponding API key (OPENAI_API_KEY or ANTHROPIC_API_KEY)."
  );
}

// ─── Message Normalization ──────────────────────────────────────────────

const ensureArray = (
  value: MessageContent | MessageContent[]
): MessageContent[] => (Array.isArray(value) ? value : [value]);

const normalizeContentPart = (
  part: MessageContent
): TextContent | ImageContent | FileContent => {
  if (typeof part === "string") return { type: "text", text: part };
  if (part.type === "text") return part;
  if (part.type === "image_url") return part;
  if (part.type === "file_url") return part;
  throw new Error("Unsupported message content part");
};

const normalizeMessage = (message: Message) => {
  const { role, name, tool_call_id } = message;

  if (role === "tool" || role === "function") {
    const content = ensureArray(message.content)
      .map(part => (typeof part === "string" ? part : JSON.stringify(part)))
      .join("\n");
    return { role, name, tool_call_id, content };
  }

  const contentParts = ensureArray(message.content).map(normalizeContentPart);
  if (contentParts.length === 1 && contentParts[0].type === "text") {
    return { role, name, content: contentParts[0].text };
  }
  return { role, name, content: contentParts };
};

const normalizeToolChoice = (
  toolChoice: ToolChoice | undefined,
  tools: Tool[] | undefined
): "none" | "auto" | ToolChoiceExplicit | undefined => {
  if (!toolChoice) return undefined;
  if (toolChoice === "none" || toolChoice === "auto") return toolChoice;
  if (toolChoice === "required") {
    if (!tools || tools.length === 0) throw new Error("tool_choice 'required' was provided but no tools were configured");
    if (tools.length > 1) throw new Error("tool_choice 'required' needs a single tool or specify the tool name explicitly");
    return { type: "function", function: { name: tools[0].function.name } };
  }
  if ("name" in toolChoice) return { type: "function", function: { name: toolChoice.name } };
  return toolChoice;
};

const normalizeResponseFormat = ({
  responseFormat, response_format, outputSchema, output_schema,
}: {
  responseFormat?: ResponseFormat; response_format?: ResponseFormat;
  outputSchema?: OutputSchema; output_schema?: OutputSchema;
}):
  | { type: "json_schema"; json_schema: JsonSchema }
  | { type: "text" }
  | { type: "json_object" }
  | undefined => {
  const explicitFormat = responseFormat || response_format;
  if (explicitFormat) {
    if (explicitFormat.type === "json_schema" && !explicitFormat.json_schema?.schema) {
      throw new Error("responseFormat json_schema requires a defined schema object");
    }
    return explicitFormat;
  }
  const schema = outputSchema || output_schema;
  if (!schema) return undefined;
  if (!schema.name || !schema.schema) throw new Error("outputSchema requires both name and schema");
  return {
    type: "json_schema",
    json_schema: {
      name: schema.name,
      schema: schema.schema,
      ...(typeof schema.strict === "boolean" ? { strict: schema.strict } : {}),
    },
  };
};

// ─── OpenAI Provider ────────────────────────────────────────────────────

async function invokeOpenAI(params: InvokeParams): Promise<InvokeResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured");

  const model = process.env.OPENAI_MODEL || "gpt-4o";
  const { messages, tools, toolChoice, tool_choice, ...rest } = params;

  const payload: Record<string, unknown> = {
    model,
    messages: messages.map(normalizeMessage),
    max_tokens: params.maxTokens || params.max_tokens || 16384,
    temperature: 0,  // deterministic outputs for compliance analysis
    seed: 42,        // OpenAI best-effort reproducibility (same seed + temperature=0 → same output)
  };

  if (tools && tools.length > 0) payload.tools = tools;

  const normalizedToolChoice = normalizeToolChoice(toolChoice || tool_choice, tools);
  if (normalizedToolChoice) payload.tool_choice = normalizedToolChoice;

  const normalizedResponseFormat = normalizeResponseFormat(rest);
  if (normalizedResponseFormat) payload.response_format = normalizedResponseFormat;

  console.log(`[LLM/OpenAI] Sending request → model=${model} messages=${messages.length} tools=${(payload.tools as any[])?.length ?? 0} response_format=${(payload.response_format as any)?.type ?? "none"} max_tokens=${payload.max_tokens} temperature=0 seed=42`);

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[LLM/OpenAI] ❌ HTTP ${response.status} ${response.statusText}`);
    console.error(`[LLM/OpenAI] Error body: ${errorText}`);
    console.error(`[LLM/OpenAI] Request payload (truncated): ${JSON.stringify(payload).slice(0, 2000)}`);
    throw new Error(`OpenAI API failed: ${response.status} ${response.statusText} – ${errorText}`);
  }

  const result = (await response.json()) as InvokeResult;
  const usage = result.usage;
  console.log(`[LLM/OpenAI] ✅ Response received finish_reason=${result.choices?.[0]?.finish_reason} usage=${JSON.stringify(usage)}`);
  return result;
}

// ─── Anthropic Provider ─────────────────────────────────────────────────

async function invokeAnthropic(params: InvokeParams): Promise<InvokeResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not configured");

  const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514";
  const { messages, tools, ...rest } = params;

  // Convert OpenAI-format messages to Anthropic format
  const systemMessages = messages.filter(m => m.role === "system");
  const nonSystemMessages = messages.filter(m => m.role !== "system");

  const system = systemMessages
    .map(m => {
      const parts = ensureArray(m.content);
      return parts.map(p => typeof p === "string" ? p : (p as TextContent).text).join("\n");
    })
    .join("\n\n");

  const anthropicMessages = nonSystemMessages.map(m => {
    const parts = ensureArray(m.content).map(normalizeContentPart);
    const content = parts.map(part => {
      if (part.type === "text") return { type: "text" as const, text: part.text };
      if (part.type === "image_url") {
        // Convert OpenAI image_url format to Anthropic format
        const url = part.image_url.url;
        if (url.startsWith("data:")) {
          // Base64 data URL
          const match = url.match(/^data:(image\/\w+);base64,(.+)$/);
          if (match) {
            return {
              type: "image" as const,
              source: { type: "base64" as const, media_type: match[1], data: match[2] },
            };
          }
        }
        // URL-based image
        return {
          type: "image" as const,
          source: { type: "url" as const, url },
        };
      }
      // file_url not directly supported by Anthropic — convert to text description
      if (part.type === "file_url") {
        return { type: "text" as const, text: `[Video file: ${part.file_url.url}]` };
      }
      return { type: "text" as const, text: JSON.stringify(part) };
    });

    return { role: m.role as "user" | "assistant", content };
  });

  const payload: Record<string, unknown> = {
    model,
    max_tokens: params.maxTokens || params.max_tokens || 16384,
    temperature: 0,  // deterministic outputs for compliance analysis
    messages: anthropicMessages,
  };

  if (system) payload.system = system;

  // Convert tools to Anthropic format
  const anthropicTools: any[] = tools
    ? tools.map(t => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters,
      }))
    : [];

  // Convert json_schema response_format → Anthropic tool use (the reliable structured output path)
  const normalizedResponseFormat = normalizeResponseFormat(rest);
  if (normalizedResponseFormat?.type === "json_schema") {
    const schema = normalizedResponseFormat.json_schema;
    anthropicTools.push({
      name: schema.name,
      description: "Return your complete analysis result in this exact JSON format. All required fields must be present.",
      input_schema: schema.schema,
    });
    payload.tool_choice = { type: "tool", name: schema.name };
  }

  if (anthropicTools.length > 0) payload.tools = anthropicTools;

  console.log(`[LLM/Anthropic] Sending request → model=${model} messages=${anthropicMessages.length} tools=${anthropicTools.length} tool_choice=${JSON.stringify(payload.tool_choice ?? null)} max_tokens=${payload.max_tokens}`);

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[LLM/Anthropic] ❌ HTTP ${response.status} ${response.statusText}`);
    console.error(`[LLM/Anthropic] Error body: ${errorText}`);
    console.error(`[LLM/Anthropic] Request payload (truncated): ${JSON.stringify({ ...payload, messages: `[${anthropicMessages.length} messages]` }).slice(0, 2000)}`);
    throw new Error(`Anthropic API failed: ${response.status} ${response.statusText} – ${errorText}`);
  }

  const data = await response.json();

  // Convert Anthropic response to OpenAI-compatible InvokeResult format.
  // When we forced tool use for structured output, extract from tool_use block.
  const toolUseBlock = data.content?.find((c: any) => c.type === "tool_use");
  const textContent = toolUseBlock
    ? JSON.stringify(toolUseBlock.input)
    : (data.content
        ?.filter((c: any) => c.type === "text")
        ?.map((c: any) => c.text)
        ?.join("") || ""
      ).replace(/^```(?:json)?\s*/m, "").replace(/\s*```\s*$/m, "").trim();

  console.log(`[LLM/Anthropic] ✅ Response received stop_reason=${data.stop_reason} content_blocks=${data.content?.length} tool_use=${!!toolUseBlock} usage=${JSON.stringify(data.usage)}`);

  return {
    id: data.id,
    created: Math.floor(Date.now() / 1000),
    model: data.model,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: textContent,
      },
      finish_reason: data.stop_reason || "stop",
    }],
    usage: data.usage ? {
      prompt_tokens: data.usage.input_tokens,
      completion_tokens: data.usage.output_tokens,
      total_tokens: data.usage.input_tokens + data.usage.output_tokens,
    } : undefined,
  };
}

// ─── Main Entry Point ───────────────────────────────────────────────────

function getRetryDelays(error: unknown): number[] {
  const msg = error instanceof Error ? error.message : String(error);
  if (/429|rate.?limit|too many requests/i.test(msg)) return [5000, 10000, 20000];
  if (/50[023]/.test(msg)) return [2000, 5000];
  if (/timeout|timed out/i.test(msg)) return [3000];
  return [];
}

export async function invokeLLM(params: InvokeParams): Promise<InvokeResult> {
  const provider = getProvider();
  console.log(`[LLM] Invoking ${provider} provider`);
  const invoke = provider === "anthropic" ? invokeAnthropic : invokeOpenAI;

  let lastErr: unknown;
  let attempt = 0;
  while (true) {
    try {
      return await invoke(params);
    } catch (err) {
      lastErr = err;
      const delays = getRetryDelays(err);
      if (attempt >= delays.length) break;
      const delay = delays[attempt];
      console.warn(`[LLM] Attempt ${attempt + 1} failed (${(err as Error).message}), retrying in ${delay}ms`);
      await new Promise(resolve => setTimeout(resolve, delay));
      attempt++;
    }
  }
  throw lastErr;
}
