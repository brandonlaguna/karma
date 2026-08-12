/**
 * Memoria de conversación -- en memoria del proceso, por conversationId.
 * Suficiente para el estado actual del lab (un solo proceso de
 * ai-backend, sin réplicas); si más adelante se necesita sobrevivir
 * reinicios o correr varias instancias, esto se movería a la Postgres
 * propia de ai-lab. Por ahora, simple y liviano.
 */

interface StoredConversation {
  messages: any[];
  updatedAt: number;
}

// Conversaciones inactivas por más de este tiempo se olvidan solas --
// evita que el Map crezca sin límite si nadie cierra el chat.
const CONVERSATION_TTL_MS = (Number(process.env.CONVERSATION_TTL_MINUTES) || 120) * 60 * 1000;

// Tope de turnos (preguntas del usuario) que se guardan por
// conversación -- una conversación larga no "mejora" con el tiempo,
// al contrario: cada turno nuevo suma más contexto que el modelo tiene
// que procesar en cada respuesta, así que se pone más lenta. Se recorta
// al guardar, conservando siempre el mensaje "system" inicial (el
// prompt fijo de alert_triage, si aplica) y los últimos N turnos
// completos -- nunca se corta a la mitad de un turno con tool calls,
// porque el API exige que cada mensaje "tool" tenga su "assistant" con
// tool_calls correspondiente justo antes (o la próxima llamada al
// modelo falla).
const MAX_CONVERSATION_TURNS = Number(process.env.MAX_CONVERSATION_TURNS) || 8;

const conversations = new Map<string, StoredConversation>();

function cleanupExpired() {
  const now = Date.now();
  for (const [id, conv] of conversations) {
    if (now - conv.updatedAt > CONVERSATION_TTL_MS) {
      conversations.delete(id);
    }
  }
}

/**
 * Recorta el historial a los últimos `maxTurns` turnos. Un "turno"
 * empieza en cada mensaje role:"user" -- se cuenta desde ahí hasta el
 * siguiente "user" (incluye la respuesta del assistant y cualquier
 * mensaje "tool" intermedio). El mensaje "system" inicial (si existe)
 * siempre se conserva, sin contar como turno.
 */
function trimToMaxTurns(messages: any[], maxTurns: number): any[] {
  if (messages.length === 0) return messages;

  const hasSystem = messages[0]?.role === "system";
  const systemMessage = hasSystem ? [messages[0]] : [];
  const rest = hasSystem ? messages.slice(1) : messages;

  const turnStarts: number[] = [];
  rest.forEach((m, i) => {
    if (m.role === "user") turnStarts.push(i);
  });

  if (turnStarts.length <= maxTurns) {
    return messages;
  }

  const cutIndex = turnStarts[turnStarts.length - maxTurns];
  return [...systemMessage, ...rest.slice(cutIndex)];
}

export function getConversation(conversationId: string | undefined | null): StoredConversation | null {
  if (!conversationId) return null;
  cleanupExpired();
  return conversations.get(conversationId) ?? null;
}

export function saveConversation(conversationId: string, messages: any[]) {
  conversations.set(conversationId, {
    messages: trimToMaxTurns(messages, MAX_CONVERSATION_TURNS),
    updatedAt: Date.now(),
  });
}

export function createConversationId(): string {
  return globalThis.crypto.randomUUID();
}
