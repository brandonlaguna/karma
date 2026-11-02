/**
 * Proveedor "anthropic" del chat de ai-backend (Claude, con el SDK oficial).
 *
 * El loop de chat de index.ts habla el formato de OpenAI (mensajes role:"tool",
 * tool_calls) porque lo comparten Ollama y OpenAI. Claude usa otro formato:
 * el system va aparte y las tools son bloques `tool_use` / `tool_result` dentro
 * de los mensajes. Este módulo corre el MISMO loop (descubrir tools -> pedir
 * respuesta -> ejecutar tools -> repetir, con tope de rondas) nativamente en el
 * formato de Claude, sin traducir mensajes en cada vuelta.
 *
 * Contrato con index.ts: recibe `messages` con uno o más mensajes `system` al
 * inicio (como los arma index.ts) y devuelve la lista COMPLETA ya en formato
 * Claude (con un único `system` al inicio) para guardarla en la memoria de
 * conversación. Un mismo proceso usa un solo proveedor, así que el historial
 * guardado nunca mezcla formatos.
 */
import Anthropic from "@anthropic-ai/sdk";

export type RunTool = (name: string, args: any) => Promise<{ content: unknown; ok: boolean }>;

export interface AnthropicChatUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface AnthropicChatResult {
  text: string;
  messages: any[];
  truncated: boolean;
  usage: AnthropicChatUsage;
}

// Tope de tokens de SALIDA por respuesta. Un valor absurdo (por ejemplo, copiar aquí un presupuesto diario) haría
// que la API rechace TODAS las peticiones con un 400, así que se limita a un techo seguro para cualquier modelo.
const MAX_TOKENS_CEILING = 32000;
const requestedMaxTokens = Number(process.env.ANTHROPIC_MAX_TOKENS) || 4096;
const DEFAULT_MAX_TOKENS = Math.min(requestedMaxTokens, MAX_TOKENS_CEILING);
if (requestedMaxTokens > MAX_TOKENS_CEILING) {
  console.warn(
    `ANTHROPIC_MAX_TOKENS=${requestedMaxTokens} es demasiado alto para un chat (máximo de salida por respuesta); se usa ${MAX_TOKENS_CEILING}. Lo normal es 4096.`
  );
}

/** Tools del mcp-server (formato OpenAI, ver mcp/client.js) -> formato de Claude. */
export function toAnthropicTools(tools: any[]): Anthropic.Tool[] {
  return tools.map((tool) => {
    const { $schema: _ignored, ...schema } = tool.function.parameters ?? {};
    return {
      name: tool.function.name,
      description: tool.function.description,
      input_schema: { type: "object", properties: {}, ...schema } as Anthropic.Tool.InputSchema,
    };
  });
}

/** Junta los mensajes `system` iniciales (el prompt fijo + el contexto de alerta pre-cargado) en un solo texto. */
function splitSystem(messages: any[]): { system: string; rest: any[] } {
  const parts: string[] = [];
  let index = 0;
  while (index < messages.length && messages[index].role === "system") {
    parts.push(String(messages[index].content));
    index += 1;
  }
  return { system: parts.join("\n\n"), rest: messages.slice(index) };
}

/** Errores del SDK -> mensajes claros para quien opera el chat (sin exponer credenciales). */
function describeError(error: unknown): Error {
  if (error instanceof Anthropic.AuthenticationError) {
    return new Error("Claude rechazó las credenciales: revisar ANTHROPIC_API_KEY en el .env de ai-lab.");
  }
  if (error instanceof Anthropic.PermissionDeniedError) {
    return new Error("La cuenta de Claude no tiene permiso para usar ese modelo (ANTHROPIC_CHAT_MODEL).");
  }
  if (error instanceof Anthropic.NotFoundError) {
    return new Error("Claude no encontró el modelo configurado: revisar ANTHROPIC_CHAT_MODEL.");
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new Error("Claude respondió 429 (límite de uso). Intenta de nuevo en unos segundos.");
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new Error(`No se pudo conectar a la API de Claude: ${error.message}`);
  }
  if (error instanceof Anthropic.APIError) {
    return new Error(`Error de la API de Claude (${error.status}): ${error.message}`);
  }
  return error instanceof Error ? error : new Error(String(error));
}

function textOf(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

export async function runAnthropicChat(options: {
  client: Anthropic;
  model: string;
  messages: any[];
  tools: any[];
  runTool: RunTool;
  maxIterations: number;
  maxTokens?: number;
}): Promise<AnthropicChatResult> {
  const { client, model, tools, runTool, maxIterations, maxTokens = DEFAULT_MAX_TOKENS } = options;
  const { system, rest } = splitSystem(options.messages);

  const history: any[] = [...rest];
  const anthropicTools = toAnthropicTools(tools);
  const usage: AnthropicChatUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

  // cache_control en el bloque system cachea también las tools (van antes en el prefijo): el prompt largo y la
  // lista de tools se pagan completos solo en la primera llamada de cada ventana de caché.
  const systemBlocks: Anthropic.TextBlockParam[] = [{ type: "text", text: system, cache_control: { type: "ephemeral" } }];

  const finish = (text: string, truncated = false): AnthropicChatResult => ({
    text: text || "No obtuve una respuesta del modelo. Intenta reformular la pregunta.",
    messages: [{ role: "system", content: system }, ...history],
    truncated,
    usage,
  });

  const callModel = async (extra: Partial<Anthropic.MessageCreateParamsNonStreaming> = {}) => {
    try {
      const response = await client.messages.create({
        model,
        max_tokens: maxTokens,
        system: systemBlocks,
        tools: anthropicTools,
        messages: history,
        ...extra,
      });
      usage.inputTokens += response.usage.input_tokens ?? 0;
      usage.outputTokens += response.usage.output_tokens ?? 0;
      usage.cacheReadTokens += response.usage.cache_read_input_tokens ?? 0;
      usage.cacheWriteTokens += response.usage.cache_creation_input_tokens ?? 0;
      return response;
    } catch (error) {
      throw describeError(error);
    }
  };

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const response = await callModel();
    const toolUses = response.content.filter((block): block is Anthropic.ToolUseBlock => block.type === "tool_use");

    // Un turno cortado (límite de tokens o rechazo) puede dejar un tool_use sin resultado: ese turno no se guarda,
    // porque el siguiente mensaje de la conversación fallaría (la API exige un tool_result por cada tool_use).
    if (response.stop_reason === "max_tokens" || response.stop_reason === "refusal") {
      if (!toolUses.length) history.push({ role: "assistant", content: response.content });
      const reason =
        response.stop_reason === "refusal"
          ? "El modelo no pudo responder a esta consulta."
          : "La respuesta superó el límite de longitud; intenta una pregunta más acotada.";
      return finish(textOf(response.content) || reason, response.stop_reason === "max_tokens");
    }

    history.push({ role: "assistant", content: response.content });

    // Sin tools pedidas = respuesta final.
    if (response.stop_reason !== "tool_use" || !toolUses.length) {
      if (response.stop_reason === "pause_turn") continue;
      return finish(textOf(response.content));
    }

    console.log(
      `Ronda ${iteration + 1}/${maxIterations}: ${toolUses.length} tool call(s) -> ${toolUses.map((t) => t.name).join(", ")}`
    );

    // Las tools de un mismo turno son independientes: corren en paralelo. Si una falla no se corta el loop: el
    // error vuelve al modelo como resultado (is_error) para que decida cómo seguir.
    const results = await Promise.all(
      toolUses.map(async (toolUse) => {
        const { content, ok } = await runTool(toolUse.name, toolUse.input ?? {});
        return {
          type: "tool_result" as const,
          tool_use_id: toolUse.id,
          content: typeof content === "string" ? content : JSON.stringify(content),
          ...(ok ? {} : { is_error: true }),
        };
      })
    );
    history.push({ role: "user", content: results });
  }

  // Se acabaron las rondas y el modelo seguía pidiendo tools: se pide una respuesta final con lo ya obtenido, sin
  // dejarle usar más tools (tool_choice none). La instrucción va DENTRO del último mensaje de resultados.
  console.warn(`Se alcanzó el máximo de ${maxIterations} rondas de tools, forzando respuesta final.`);
  const last = history[history.length - 1];
  if (last?.role === "user" && Array.isArray(last.content)) {
    last.content.push({
      type: "text",
      text: "Responde ahora con la mejor respuesta posible usando solo la información que ya obtuviste, sin pedir más herramientas.",
    });
  }
  const forced = await callModel({ tool_choice: { type: "none" } });
  history.push({ role: "assistant", content: forced.content });
  return finish(textOf(forced.content), true);
}
