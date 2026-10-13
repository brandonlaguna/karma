import jwt from "jsonwebtoken";

/**
 * Token de servicio para las llamadas de las tools a EpistechBackend: sus
 * rutas exigen un JWT (authMiddleware) firmado con su JWT_SECRET, que ai-lab
 * comparte. Mismo patrón que getInternalServiceToken de EpistechBackend
 * (utils/httpFetcher.js): usuario técnico sin claims, solo "autenticado".
 * Dura minutos y se firma por llamada, así que no hay nada que cachear ni
 * renovar. Las acciones no quedan atribuidas a la persona que usa el chat.
 */
export function internalAuthHeaders() {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET no está configurado en ai-lab: EpistechBackend rechazaría la llamada de las tools (401).");
  }

  const token = jwt.sign({ user: { Id: 0, Nombre: "ai-lab-mcp", CLAIMS: [] }, internal: true }, secret, {
    expiresIn: "5m",
  });

  return { Authorization: `Bearer ${token}` };
}
