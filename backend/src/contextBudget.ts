/**
 * Recorte de historial por presupuesto de TOKENS, en vez de por cantidad
 * de turnos (ver trimToMaxTurns en conversations.ts, que es lo que de
 * verdad se usa hoy en el flujo de /chat). Pensado para reemplazar ese
 * recorte cuando MAX_CONTEXT_TOKENS esté configurado en .env -- todavía
 * NO está conectado a ningún lado (ni conversations.ts ni index.ts lo
 * importan). Ver el README de esta sección para cómo activarlo.
 *
 * Estimación de tokens: heurística simple (largo del texto / 4), sin
 * dependencia de un tokenizer real -- alcanza para un presupuesto
 * aproximado. Si más adelante hace falta precisión exacta contra el
 * tokenizer real de un modelo (ej. para no pasarse justo del límite
 * duro de OpenAI), esto se puede reemplazar por `tiktoken`/
 * `gpt-tokenizer` sin cambiar la firma de estas funciones.
 */

function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

function messageTokens(message: any): number {
  const content =
    typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "");
  let total = estimateTokens(content);

  // Los tool_calls del assistant también pesan -- nombre + argumentos
  // van en el payload real que se le manda al modelo.
  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      total += estimateTokens(call.function?.name ?? "");
      total += estimateTokens(call.function?.arguments ?? "");
    }
  }

  return total;
}

/**
 * Recorta `messages` para que la suma estimada de tokens no supere
 * `maxTokens`, descartando turnos completos desde el más viejo -- nunca
 * a la mitad de un turno con tool calls (mismo criterio que
 * trimToMaxTurns: la API exige que cada mensaje "tool" tenga su
 * "assistant" con tool_calls justo antes). El mensaje "system" inicial
 * siempre se conserva y no cuenta como turno, pero sí suma al
 * presupuesto -- si él solo ya lo supera, se devuelve solo.
 */
export function trimToTokenBudget(messages: any[], maxTokens: number): any[] {
  if (messages.length === 0) return messages;

  const hasSystem = messages[0]?.role === "system";
  const systemMessage = hasSystem ? [messages[0]] : [];
  const rest = hasSystem ? messages.slice(1) : messages;

  const systemTokens = systemMessage.reduce((sum, m) => sum + messageTokens(m), 0);
  let budget = maxTokens - systemTokens;

  if (budget <= 0) return systemMessage;

  const turnStarts: number[] = [];
  rest.forEach((m, i) => {
    if (m.role === "user") turnStarts.push(i);
  });

  // Recorre los turnos del más nuevo al más viejo, sumando tokens hasta
  // agotar el presupuesto -- el primer turno que ya no entra completo
  // marca dónde cortar (se descarta él y todo lo anterior).
  let keepFromIndex = rest.length;
  for (let t = turnStarts.length - 1; t >= 0; t--) {
    const start = turnStarts[t];
    const end = t + 1 < turnStarts.length ? turnStarts[t + 1] : rest.length;
    const turnTokens = rest.slice(start, end).reduce((sum, m) => sum + messageTokens(m), 0);

    if (turnTokens > budget) break;

    budget -= turnTokens;
    keepFromIndex = start;
  }

  return [...systemMessage, ...rest.slice(keepFromIndex)];
}
