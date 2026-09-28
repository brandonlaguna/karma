import express from "express";
import OpenAI from "openai";

import { listToolsForLLM } from "./mcp/client.js";
import { executeTool } from "./toolExecutor/index.js";
import { getConversation, saveConversation, createConversationId } from "./conversations.js";

const app = express();

app.use(express.json());

// Proveedor del modelo de chat -- "ollama" (local, sin costo, default)
// o "openai" (API real de OpenAI, de pago). Configurable vía AI_PROVIDER
// para alternar sin tocar código entre lab/dev (Ollama) y un deploy que
// necesite mejor calidad de respuesta. OJO: con "openai", el JSON crudo
// de cada alerta (IPs, nombres de dispositivo, topología) y resultados
// de tools (traceroutes, gráficas) salen a la API de OpenAI -- confirmar
// que eso sea aceptable para los clientes cuya infraestructura pasa por
// ahí antes de usarlo en producción.
const AI_PROVIDER = process.env.AI_PROVIDER || "ollama";

const client = AI_PROVIDER === "openai"
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : new OpenAI({
      baseURL: `${process.env.OLLAMA_BASE_URL || "http://host.docker.internal:11434"}/v1`,
      apiKey: "ollama"
    });

// Modelo por defecto según el proveedor -- CHAT_MODEL para OpenAI,
// LOCAL_MODEL para Ollama (ver docker-compose.yml / .env). El request
// puede seguir pisándolo con { "model": "..." } si hace falta.
const DEFAULT_MODEL = AI_PROVIDER === "openai"
  ? (process.env.CHAT_MODEL || "gpt-4.1-mini")
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
const ALERT_TRIAGE_SYSTEM_PROMPT = `
Eres el asistente de NOC de Epistech. El detalle de la alerta en
cuestión ya viene CARGADO en un mensaje de sistema anterior a este (el
backend lo trajo automáticamente vía "get_alert_by_id" antes de que
esta conversación llegara al modelo -- vos NO tenés que pedirlo de
nuevo, y NUNCA debes inventar ni transcribir un ID de alerta a mano
desde otra parte del texto). Ese mensaje incluye el JSON crudo del
vendor en el campo "json_result", con los identificadores que piden las
demás tools: probeid, entity, elementid, source, etc.

Si en cambio ese mensaje de sistema dice explícitamente que el
pre-fetch falló, ahí sí te da el ID exacto para que llames
"get_alert_by_id" vos mismo con ese mismo valor, sin modificarlo.

El usuario puede seguir conversando después sobre esa misma alerta --
recuerda el contexto de mensajes anteriores en este hilo, no vuelvas a
llamar get_alert_by_id salvo que necesites datos actualizados (ej. si
preguntan "¿ya se resolvió?" bastante después del primer mensaje).

MUY IMPORTANTE: no siempre hay que investigar todo, más allá de
get_alert_by_id. Fíjate en lo que el usuario realmente está
preguntando:
- Si el mensaje del usuario es genérico ("Analizar ticket" o similar, sin
  pregunta puntual), con el detalle de la alerta ya cargado haz un
  análisis general: estado actual, contexto relevante, y si corresponde
  escalar.
- Si pregunta algo específico ("¿está resuelto?", "¿de qué país es?",
  "¿a quién le reporto esto?", "¿cómo está el tráfico de la interfaz?"),
  usa SOLO las tools necesarias para responder eso puntual -- no corras
  la batería completa de tools si no hace falta.
- El usuario también puede preguntar cosas que NO tienen nada que ver
  con esta alerta puntual (ej. "¿cuál es la matriz RACI de BBDD?", "¿qué
  dice la política de cambios?", cualquier duda general de NOC). En ese
  caso respóndela directo con "get_escalation_matrix"/
  "search_knowledge_base" (u otra tool que corresponda) SIN forzar el
  contexto de la alerta ni volver a llamar get_alert_by_id -- no todo en
  esta conversación tiene que girar en torno a la alerta inicial.

Tools disponibles para esto y cuándo usarlas:
- "get_alert_by_id": normalmente NO hace falta llamarla -- el backend ya
  la corrió por vos (ver arriba). Trae message, severity, source,
  vendor_name, status_name/status_color (estado actual), status_history
  (historial de transiciones), acknowledge_name, notified_at/
  resolved_at, y json_result (el JSON crudo del vendor). Solo llámala
  vos mismo si el pre-fetch falló (te lo dice el mensaje de sistema) o
  si necesitás datos actualizados de esa misma alerta más adelante en la
  conversación.
- "get_device_info": resuelve el probeID a partir del nombre del
  dispositivo. Hace falta ANTES de get_device_notes, get_interface_graphs
  o get_trace_response (todas piden ese probeID como "eeProbeID") --
  PERO revisa primero si json_result (de get_alert_by_id) ya trae un
  campo tipo "probeid"/"probeID" directamente: si está, úsalo tal cual
  como "eeProbeID" y ahórrate esta llamada. Solo pide get_device_info si
  ese campo no viene ahí, o si ya lo obtuviste en un mensaje anterior de
  esta misma conversación (no lo vuelvas a pedir).
- "get_alarm_properties" (con el "entity"/ID de la alarma, de
  json_result): para saber si sigue activa, se restableció, o hay
  caídas constantes.
- "get_device_notes": customFields del dispositivo -- país, ciudad,
  sede, área resolutora ("Grupo Resolutor", ej. "CO-REDES",
  "CO-SERVIDORES", "CO-TELEFONIA"), criticidad. Es la fuente PRINCIPAL
  para "¿a quién le reporto esto?" -- si trae "Grupo Resolutor", pásalo
  tal cual como "resolverGroupCode" a get_escalation_matrix. El
  parámetro "name" es opcional -- si json_result trae un campo "source"
  (formato "{ip}.{probeID}", ej. "172.23.103.18.50000000001"), pásalo
  tal cual como "name". Si no está, omite el parámetro directamente --
  no hace falta resolverlo con otra tool solo para esto.
- "search_device_inventory": respaldo cuando get_device_notes no trae
  customFields completos (dispositivo mal diligenciado en OpManager).
  Busca por nombre del dispositivo en el inventario propio catalogado
  desde los Excel de NOC y devuelve país/ciudad/sede/grupo de soporte.
  Úsala solo si get_device_notes se quedó corto -- no la corras por
  rutina.
- "search_knowledge_base": además de políticas/procedimientos, también
  tiene la nomenclatura de nombres de dispositivos e interfaces (país,
  ciudad, sede, grupo de soporte, tipo, principal/backup). Es el ÚLTIMO
  recurso para decodificar a quién pertenece un dispositivo -- solo si
  get_device_notes Y search_device_inventory no dieron el dato.
- "get_interface_graphs": solo si la pregunta es sobre tráfico/estado de
  una interfaz puntual. El "interfaceName" se construye con datos de
  json_result, sin necesidad de resolverlo con otra tool: formato
  "IF-{source}-{elementid}" (ej. "source": "172.23.103.18.50000000001" y
  "elementid": "50000013652" -> "IF-172.23.103.18.50000000001-50000013652").
- "get_trace_response": solo si preguntan por conectividad/ruta de red.
- "get_escalation_matrix": para decir a quién corresponde escalar o
  reportar, con el código de país y, en orden de preferencia:
  1) "resolverGroupCode" = el "Grupo Resolutor" exacto de
     get_device_notes (ej. "CO-REDES") -- el más confiable, úsalo
     siempre que lo tengas.
  2) "siteCode" = si el dispositivo pertenece a una sede específica
     (ej. "ROYAL") en vez de un área genérica.
  3) "teamName" = solo como último recurso, si ninguno de los dos
     anteriores está disponible (búsqueda difusa por nombre de área,
     ej. "Redes", "BBDD", "Infraestructura Royal").
  Sin ninguno de los tres trae las áreas de todos los equipos, que no
  es lo que quieres. Hay 4 niveles (0=contacto inicial/buzón general,
  1/2/3=escalamiento creciente) -- si preguntan "a quién reporto"
  normalmente basta con el nivel 0 o 1, no hace falta ir directo a
  nivel 3 salvo que la gravedad de la alerta lo amerite.

Responde siempre breve y accionable para un especialista de NOC.
`.trim();

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
const GENERAL_ASSISTANT_SYSTEM_PROMPT = `
Eres el asistente de NOC de Epistech, disponible como panel lateral en
toda la aplicación (no estás atado a ninguna alerta en particular a
menos que el usuario te dé un ID o te pregunte por una).

Puedes ayudar con: dudas sobre una alerta puntual (si te dan su ID
interno, o alert_id de Epistech, usa "get_alert_by_id" para traerla), a
quién CONTACTAR/escalar un incidente por país o equipo
("get_escalation_matrix" -- tabla de contactos en Postgres, NO
documentación), y preguntas sobre políticas, procedimientos,
responsabilidades documentadas (incluye RACI escrito en un documento) y
nomenclatura de dispositivos ("search_knowledge_base" -- busca sobre
los documentos reales cargados, ej. políticas ITIM, gestión de
alertamiento), o cualquier otra duda general de operación de NOC.

IMPORTANTE: no confundas las dos tools anteriores solo porque ambas
mencionan "responsable" o "escalamiento". Regla simple: si la pregunta
es "¿a quién llamo/contacto/escalo esto AHORA?" -> get_escalation_matrix.
Si la pregunta es "¿qué dice la política/procedimiento sobre...?" o
"¿de quién es la responsabilidad de tal cosa SEGÚN el documento?" ->
search_knowledge_base primero, aunque use la palabra "responsable" o
"RACI".

No fuerces el uso de una tool si la pregunta no la necesita -- si es una
duda conceptual que ya sabes responder, respóndela directo. Si el
usuario cambia de tema a mitad de conversación, sigue el tema nuevo sin
intentar volver al anterior.

Responde siempre breve y accionable para un especialista de NOC.
`.trim();

app.get("/health", (_, res) => {

  return res.json({
    ok: true
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
          // modo "thinking" -- no existe en la API de OpenAI, así que
          // solo se agrega corriendo contra Ollama.
          const effectiveSystemPrompt =
            thinking || AI_PROVIDER === "openai" ? baseSystemPrompt : `${baseSystemPrompt}\n/no_think`;

          const initialMessages: any[] = [{ role: "system", content: effectiveSystemPrompt }];

          // Pre-fetch server-side de la alerta -- ver el fix arriba en
          // ALERT_TRIAGE_SYSTEM_PROMPT. Solo aplica al PRIMER mensaje de
          // una conversación nueva de triage con alertId explícito.
          if (context === "alert_triage" && alertId) {
            try {
              const alertData = await executeTool("get_alert_by_id", { alertId });
              initialMessages.push({
                role: "system",
                content:
                  `Detalle de la alerta ${alertId} (ya obtenido vía get_alert_by_id -- ` +
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
          conversationId
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

          const signature = callSignature(toolName, toolArgs);
          const priorError = failedCallSignatures.get(signature);
          if (priorError) {
            console.warn(`Tool "${toolName}" repetida con los mismos argumentos que ya fallaron -- no se reintenta.`);
            const content = `Ya intentaste esta misma llamada con estos mismos argumentos en este turno y falló con: "${priorError}". No la repitas igual -- ajusta los argumentos (ej. si falta un dato, dilo) o continúa sin ella.`;
            toolCallsLog.push({ name: toolName, args: toolArgs, ok: false, error: `(no reintentado) ${priorError}` });
            return { toolCall, content };
          }

          try {
            const result = await executeTool(toolName, toolArgs);
            toolCallsLog.push({ name: toolName, args: toolArgs, ok: true });
            return { toolCall, content: result };
          } catch (error: any) {
            console.error(`Tool "${toolName}" falló:`, error.message);
            failedCallSignatures.set(signature, error.message);
            toolCallsLog.push({ name: toolName, args: toolArgs, ok: false, error: error.message });
            return { toolCall, content: `Error ejecutando la tool: ${error.message}` };
          }
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
      conversationId
    });

  } catch (error) {

    console.error(error);

    return res.status(500).json({
      error: error.message
    });

  }

});

app.listen(4000, "0.0.0.0", () => {

  console.log("AI Backend running on 4000");

});