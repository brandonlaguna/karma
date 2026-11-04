import express from "express";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";

import { runAnthropicChat } from "./anthropicChat.js";
import { listToolsForLLM } from "./mcp/client.js";
import { executeTool } from "./toolExecutor/index.js";
import { getConversation, saveConversation, createConversationId } from "./conversations.js";
import { activeVendors } from "./prompts/vendors.js";
import { composeTriagePrompt, composeGeneralPrompt } from "./prompts/compose.js";

// Vendors con herramientas activas en este despliegue (ENABLED_VENDORS; vacío = todos). Mismo criterio que el MCP server.
const ACTIVE_VENDORS = activeVendors();

const app = express();

app.use(express.json());

// Proveedor del modelo de chat -- "ollama" (local, sin costo, default),
// "openai" (API de OpenAI, de pago) o "anthropic" (Claude, de pago).
// Configurable vía AI_PROVIDER para alternar sin tocar código entre
// lab/dev (Ollama) y un deploy que necesite mejor calidad de respuesta
// (o cuyo cliente ya tenga contratado uno de los dos). OJO: con "openai"
// o "anthropic", el JSON crudo de cada alerta (IPs, nombres de
// dispositivo, topología) y resultados de tools (traceroutes, gráficas)
// salen a la API de ese proveedor -- confirmar que sea aceptable para los
// clientes cuya infraestructura pasa por ahí antes de usarlo en producción.
const SUPPORTED_PROVIDERS = ["ollama", "openai", "anthropic"] as const;
type Provider = (typeof SUPPORTED_PROVIDERS)[number];

const requestedProvider = (process.env.AI_PROVIDER || "ollama").trim().toLowerCase();
const AI_PROVIDER: Provider = (SUPPORTED_PROVIDERS as readonly string[]).includes(requestedProvider)
  ? (requestedProvider as Provider)
  : "ollama";

if (AI_PROVIDER !== requestedProvider) {
  console.warn(
    `AI_PROVIDER="${requestedProvider}" no es válido (usar ${SUPPORTED_PROVIDERS.join(" | ")}); se usa "ollama".`
  );
}

// Ollama y OpenAI hablan el mismo formato (chat completions); Claude tiene su
// propio cliente y su propio loop (ver anthropicChat.ts). Solo se crea el
// cliente del proveedor activo.
const openaiCompatClient =
  AI_PROVIDER === "openai"
    ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
    : AI_PROVIDER === "ollama"
      ? new OpenAI({
          baseURL: `${process.env.OLLAMA_BASE_URL || "http://host.docker.internal:11434"}/v1`,
          apiKey: "ollama"
        })
      : null;

// El SDK toma ANTHROPIC_API_KEY del entorno por su cuenta; nunca se pasa por código ni se loguea.
const anthropicClient =
  AI_PROVIDER === "anthropic"
    ? new Anthropic({ timeout: Number(process.env.ANTHROPIC_TIMEOUT_MS) || 55000, maxRetries: 2 })
    : null;

if (AI_PROVIDER === "anthropic" && !process.env.ANTHROPIC_API_KEY) {
  console.warn("AI_PROVIDER=anthropic pero ANTHROPIC_API_KEY no está definida: el chat responderá con error de credenciales.");
}

// Modelo por defecto según el proveedor -- CHAT_MODEL para OpenAI,
// ANTHROPIC_CHAT_MODEL para Claude, LOCAL_MODEL para Ollama (ver
// docker-compose.yml / .env). El request puede seguir pisándolo con
// { "model": "..." } si hace falta.
const DEFAULT_MODEL =
  AI_PROVIDER === "openai"
    ? (process.env.CHAT_MODEL || "gpt-4.1-mini")
    : AI_PROVIDER === "anthropic"
      ? (process.env.ANTHROPIC_CHAT_MODEL || "claude-sonnet-5-5")
      : (process.env.LOCAL_MODEL || "qwen3:8b");

// Tope de rondas de tool-calling por conversación. Sin esto, un modelo
// que se queda pidiendo tools indefinidamente (o un loop de tools que
// se retroalimentan) podría no terminar nunca. Al llegar al tope se
// fuerza una respuesta final sin más tools disponibles.
const MAX_TOOL_ITERATIONS = Number(process.env.MAX_TOOL_ITERATIONS) || 6;

/*
  Prompt fijo del lado del servidor para el modo "triage de alerta" --
  a propósito NO se deja que el frontend lo componga: así el
  comportamiento queda consistente sin importar qué cliente (Postman,
  una web futura, etc.) mande la alerta.

  FIX: el frontend manda el ID interno de la alerta (alerts.id de
  Epistech) como parámetro EXPLÍCITO ("alertId" en el body), NO
  embebido dentro de "message" como texto libre. Antes se le pedía al
  modelo que llamara get_alert_by_id transcribiendo el ID a mano desde
  el mensaje -- con un modelo chico (qwen3:8b) corriendo local, eso es
  un lugar fácil para alucinar/transponer dígitos (se observó en
  pruebas: el modelo llamó la tool con un ID inventado, no el real).
  Ahora el propio backend hace el pre-fetch de get_alert_by_id ANTES de
  llamar al modelo (ver bloque de armado de "messages" más abajo) y le
  entrega el resultado ya resuelto en el historial -- el modelo nunca
  tiene que copiar el ID para esto.
*/
// El texto del prompt vive en src/prompts/ (bloques comunes + uno por vendor) y se compone según ENABLED_VENDORS:
// Fusionet (zabbix) no ve nada de OpManager y Atento (opmanager,zabbix) ve ambos con su regla de alcance por fuente.
const ALERT_TRIAGE_SYSTEM_PROMPT = composeTriagePrompt(ACTIVE_VENDORS);

/*
  Prompt por defecto para el asistente lateral (panel a nivel de toda la
  app, ver EpistechFrontend/src/shared/ui/AiAssistant) -- se usa cuando
  la conversación NO trae "context": "alert_triage" (ej. el usuario lo
  abre desde cualquier módulo, sin ninguna alerta puntual en mente).
  Mismas tools disponibles que en triage (el descubrimiento de tools no
  se filtra por contexto, ver mcp/client.js), pero acá no se asume que
  la conversación empiece con un ID de alerta -- si el usuario pega uno
  o pregunta por una alerta puntual, el modelo puede usar
  get_alert_by_id igual.
*/
const GENERAL_ASSISTANT_SYSTEM_PROMPT = composeGeneralPrompt(ACTIVE_VENDORS);

app.get("/health", (_, res) => {

  // provider/model: para comprobar desde fuera con qué modelo está corriendo
  // este deploy (no incluye ninguna credencial).
  return res.json({
    ok: true,
    provider: AI_PROVIDER,
    model: DEFAULT_MODEL
  });

});

app.post("/chat", async (req, res) => {

  try {

    const {
      message,
      // Ver DEFAULT_MODEL arriba -- depende de AI_PROVIDER (LOCAL_MODEL
      // para Ollama, CHAT_MODEL para OpenAI). Ej. "qwen3:8b" hace OOM en
      // un host con ~4GB disponibles para Ollama en CPU-only -- ahí
      // conviene algo como "qwen3:4b" vía LOCAL_MODEL en el .env de ese
      // server.
      model = DEFAULT_MODEL,
      systemPrompt = GENERAL_ASSISTANT_SYSTEM_PROMPT,
      // Qwen3 soporta un modo "thinking" (razonamiento largo antes de
      // responder) que dispara la latencia para casos de uso donde no
      // hace falta -- consultas prácticas de NOC quieren respuesta
      // rápida, no un ensayo. Desactivado por default vía el flag
      // oficial del modelo (/no_think); se puede reactivar por request
      // con { "thinking": true } si algún día se necesita razonamiento
      // más profundo.
      // FIX: el default estaba en `true`, contradiciendo este mismo
      // comentario -- con thinking prendido por defecto, cada ronda de
      // tool-calling (hasta MAX_TOOL_ITERATIONS) generaba una cadena de
      // razonamiento larga antes de decidir la siguiente tool, lo que
      // fácilmente superaba el timeout de 60s del proxy en
      // EpistechBackend (ver integration/ai-lab/aiLab.client.js).
      thinking = false,
      // "alert_triage" pisa el systemPrompt con el prompt fijo de
      // investigación de alertas -- el mensaje trae solo el ID interno
      // de la alerta, no la alerta cruda (ver ALERT_TRIAGE_SYSTEM_PROMPT
      // arriba). Sin "context" (ej. el panel lateral, ver
      // GENERAL_ASSISTANT_SYSTEM_PROMPT), se usa el prompt general. Solo
      // importa en el PRIMER mensaje de una conversación -- si ya hay
      // historial (conversationId existente), se ignora, porque el
      // system prompt de esa conversación ya quedó fijado al crearla.
      context,
      // Si se manda un conversationId que ya existe, se sigue esa
      // conversación (se le agrega el turno nuevo al historial ya
      // guardado). Si no se manda, o no existe, se crea una nueva y se
      // devuelve su id en la respuesta para que el cliente la reuse.
      conversationId: incomingConversationId,
      // ID interno de la alerta (alerts.id de Epistech) como parámetro
      // EXPLÍCITO -- solo se usa cuando context: "alert_triage" y es el
      // PRIMER mensaje de una conversación nueva. Ver el fix arriba de
      // ALERT_TRIAGE_SYSTEM_PROMPT: el backend pre-carga la alerta acá
      // mismo, no se le pide al modelo que transcriba este ID.
      alertId
    } = req.body;

    /*
      DESCUBRIR TOOLS EN VIVO
      Antes esta lista vivía hardcodeada en tools/index.js, duplicada a
      mano contra lo que exponía mcp-server. Ahora se pregunta al
      mcp-server real cada vez -- agregar una tool nueva ahí no
      requiere tocar este archivo.
    */

    const tools = await listToolsForLLM();

    const existingConversation = getConversation(incomingConversationId);
    const conversationId = existingConversation ? incomingConversationId : createConversationId();

    // Historial de la conversación -- si ya existía, se retoma tal
    // cual (incluye el system prompt original de esa conversación) y
    // solo se le agrega el mensaje nuevo del usuario. Si es nueva, se
    // arma desde cero con el system prompt que corresponda.
    const messages: any[] = existingConversation
      ? [...existingConversation.messages, { role: "user", content: message }]
      : await (async () => {
          const baseSystemPrompt = context === "alert_triage" ? ALERT_TRIAGE_SYSTEM_PROMPT : systemPrompt;
          // "/no_think" es el flag propio de Qwen3 para desactivar su
          // modo "thinking" -- no existe en la API de OpenAI ni en la de
          // Claude, así que solo se agrega corriendo contra Ollama.
          const effectiveSystemPrompt =
            thinking || AI_PROVIDER !== "ollama" ? baseSystemPrompt : `${baseSystemPrompt}\n/no_think`;

          const initialMessages: any[] = [{ role: "system", content: effectiveSystemPrompt }];

          // Pre-fetch server-side de la alerta -- ver el fix arriba en
          // ALERT_TRIAGE_SYSTEM_PROMPT. Solo aplica al PRIMER mensaje de
          // una conversación nueva de triage con alertId explícito.
          if (context === "alert_triage" && alertId) {
            try {
              const alertData = await executeTool("get_alert_by_id", { alertId });
              // El Alert ID que ve el usuario (el del vendor) se entrega ya resuelto en texto claro: si el modelo tiene que
              // buscarlo dentro del JSON, a veces escribe el nombre del campo como marcador en vez del número.
              let detail: any = alertData;
              if (typeof alertData === "string") {
                try {
                  detail = JSON.parse(alertData);
                } catch {
                  detail = null;
                }
              }
              const vendorAlertId = detail?.alert_id ?? detail?.event?.alert_id ?? null;
              initialMessages.push({
                role: "system",
                content:
                  (vendorAlertId != null
                    ? `El Alert ID que el usuario ve en pantalla para esta alerta (el número del vendor) es ${vendorAlertId}: úsalo tal cual para nombrarla.\n`
                    : "") +
                  `Detalle de la alerta con id interno ${alertId}, que NO debes mostrarle al usuario (ya obtenido vía get_alert_by_id -- ` +
                  `NO la vuelvas a llamar salvo que necesites datos actualizados más ` +
                  `adelante en la conversación):\n` +
                  (typeof alertData === "string" ? alertData : JSON.stringify(alertData))
              });
            } catch (error: any) {
              console.error(`Pre-fetch de get_alert_by_id (alertId=${alertId}) falló:`, error.message);
              initialMessages.push({
                role: "system",
                content:
                  `No se pudo pre-cargar automáticamente la alerta ${alertId} (error: ` +
                  `${error.message}). Si la necesitas, llama a "get_alert_by_id" con ` +
                  `exactamente este ID: ${alertId} -- no inventes ni uses otro.`
              });
            }
          }

          initialMessages.push({ role: "user", content: message });
          return initialMessages;
        })();

    // Traza de qué tools se llamaron en esta conversación (todas las
    // rondas), útil para depurar/auditar qué hizo el asistente antes de
    // llegar a la respuesta final.
    const toolCallsLog: Array<{ name: string; args: unknown; ok: boolean; error?: string }> = [];

    // Guardia contra reintentos ciegos: si el modelo pide la MISMA tool
    // con los MISMOS argumentos que ya falló antes en este request, no
    // se vuelve a ejecutar -- se le devuelve el error ya conocido sin
    // gastar otra llamada real. Importante contra APIs frágiles como
    // OpManager (throttling): un modelo que insiste sin cambiar nada
    // solo suma carga a una API que ya está al límite, sin ganar nada.
    const failedCallSignatures = new Map<string, string>(); // "tool::args" -> error

    const callSignature = (name: string, args: unknown) => `${name}::${JSON.stringify(args)}`;

    // Ejecución de UNA tool con la guardia anterior y la traza. La comparten
    // los dos loops (OpenAI/Ollama abajo, Claude en anthropicChat.ts). Nunca
    // lanza: un error se devuelve como contenido, para que el modelo decida
    // si reintenta, usa otra tool o le avisa al usuario.
    const runTool = async (toolName: string, toolArgs: any): Promise<{ content: unknown; ok: boolean }> => {
      const signature = callSignature(toolName, toolArgs);
      const priorError = failedCallSignatures.get(signature);
      if (priorError) {
        console.warn(`Tool "${toolName}" repetida con los mismos argumentos que ya fallaron -- no se reintenta.`);
        toolCallsLog.push({ name: toolName, args: toolArgs, ok: false, error: `(no reintentado) ${priorError}` });
        return {
          ok: false,
          content: `Ya intentaste esta misma llamada con estos mismos argumentos en este turno y falló con: "${priorError}". No la repitas igual -- ajusta los argumentos (ej. si falta un dato, dilo) o continúa sin ella.`
        };
      }

      try {
        const result = await executeTool(toolName, toolArgs);
        toolCallsLog.push({ name: toolName, args: toolArgs, ok: true });
        return { ok: true, content: result };
      } catch (error: any) {
        console.error(`Tool "${toolName}" falló:`, error.message);
        failedCallSignatures.set(signature, error.message);
        toolCallsLog.push({ name: toolName, args: toolArgs, ok: false, error: error.message });
        return { ok: false, content: `Error ejecutando la tool: ${error.message}` };
      }
    };

    // Claude: su propio loop nativo (otro formato de mensajes y de tools).
    if (AI_PROVIDER === "anthropic") {
      const result = await runAnthropicChat({
        client: anthropicClient!,
        model,
        messages,
        tools,
        runTool,
        maxIterations: MAX_TOOL_ITERATIONS
      });

      saveConversation(conversationId, result.messages);

      return res.json({
        response: result.text,
        toolCalls: toolCallsLog,
        ...(result.truncated ? { truncated: true } : {}),
        conversationId,
        provider: AI_PROVIDER,
        model,
        usage: result.usage
      });
    }

    const client = openaiCompatClient!;

    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {

      const completion = await client.chat.completions.create({
        model,
        messages,
        tools,
        temperature: 0.6
      });

      const assistantMessage = completion.choices[0].message;
      messages.push(assistantMessage);

      /*
        SIN TOOL CALLS -> esta es la respuesta final.
      */
      if (!assistantMessage.tool_calls?.length) {
        saveConversation(conversationId, messages);
        return res.json({
          response: assistantMessage.content,
          toolCalls: toolCallsLog,
          conversationId,
          provider: AI_PROVIDER,
          model
        });
      }

      console.log(
        `Ronda ${iteration + 1}/${MAX_TOOL_ITERATIONS}: ${assistantMessage.tool_calls.length} tool call(s) -> ` +
          assistantMessage.tool_calls.map((tc: any) => tc.function.name).join(", ")
      );

      /*
        EJECUTAR TODAS las tools que pidió el modelo en este turno, no
        solo la primera. Son independientes entre sí dentro del mismo
        turno, así que corren en paralelo. Si una falla, no se corta el
        loop -- se le devuelve el error AL MODELO como resultado de esa
        tool, para que decida si reintenta, usa otra, o le avisa al
        usuario.
      */
      const toolResults = await Promise.all(
        assistantMessage.tool_calls.map(async (toolCall: any) => {
          const toolName = toolCall.function.name;
          const toolArgs = toolCall.function.arguments
            ? JSON.parse(toolCall.function.arguments)
            : {};

          const { content } = await runTool(toolName, toolArgs);
          return { toolCall, content };
        })
      );

      // Un mensaje role:"tool" por cada tool_call_id -- la API exige que
      // la cantidad y el orden coincidan con los tool_calls del mensaje
      // del assistant anterior.
      for (const { toolCall, content } of toolResults) {
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: typeof content === "string" ? content : JSON.stringify(content)
        });
      }

    }

    /*
      Se acabaron las iteraciones permitidas y el modelo seguía pidiendo
      tools -- se corta acá para no loopear indefinidamente, y se le
      pide una respuesta final SIN tools disponibles (no puede seguir
      pidiendo más).
    */
    console.warn(`Se alcanzó el máximo de ${MAX_TOOL_ITERATIONS} rondas de tools, forzando respuesta final.`);

    const forcedCompletion = await client.chat.completions.create({
      model,
      messages: [
        ...messages,
        {
          role: "user",
          content:
            "Responde ahora con la mejor respuesta posible usando solo la información que ya obtuviste, sin pedir más herramientas."
        }
      ]
    });

    saveConversation(conversationId, [
      ...messages,
      { role: "assistant", content: forcedCompletion.choices[0].message.content }
    ]);

    return res.json({
      response: forcedCompletion.choices[0].message.content,
      toolCalls: toolCallsLog,
      truncated: true,
      conversationId,
      provider: AI_PROVIDER,
      model
    });

  } catch (error) {

    console.error(error);

    return res.status(500).json({
      error: error.message
    });

  }

});

app.listen(4000, "0.0.0.0", () => {

  console.log(`AI Backend running on 4000 (provider=${AI_PROVIDER}, model=${DEFAULT_MODEL})`);

});