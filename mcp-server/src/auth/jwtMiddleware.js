import jwt from "jsonwebtoken";

/**
 * Valida los JWT que emite EpistechBackend (HS256, firmados con su
 * JWT_SECRET -- ai-lab debe tener el MISMO valor, no emite tokens propios).
 * Mismo contrato que authMiddleware de EpistechBackend: token en
 * "Authorization: Bearer", claims en decoded.user.CLAIMS.
 *
 * AUTH_ENFORCE=true  -> rechaza (401/403) lo que no valide.
 * cualquier otro valor -> modo permisivo: valida y deja el resultado en
 * req.auth (para auditoría), pero SIEMPRE deja pasar y solo avisa en el log.
 */
function verifyRequest(req, requiredClaims) {
  const secret = process.env.JWT_SECRET;
  if (!secret) return { status: 500, message: "JWT_SECRET no está configurado en ai-lab" };

  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return { status: 401, message: "Falta el token (Authorization: Bearer ...)" };

  let decoded;
  try {
    decoded = jwt.verify(token, secret, { algorithms: ["HS256"] });
  } catch (error) {
    return { status: 401, message: error.name === "TokenExpiredError" ? "Token expirado" : "Token inválido" };
  }

  req.auth.user = decoded.user ?? null;
  req.auth.subject = decoded.sub ?? null;

  // validateUser de EPISTECH emite (sin contraseña) un token de 2 minutos con
  // jti: prueba que el correo existe, no que la sesión esté autenticada.
  if (decoded.jti) return { status: 401, message: "Token temporal de validación, no es un token de sesión" };
  if (!decoded.user) return { status: 401, message: "El token no trae datos de usuario" };

  if (requiredClaims?.length) {
    const userClaims = decoded.user.CLAIMS ?? [];
    if (!requiredClaims.some((claim) => userClaims.includes(claim))) {
      return { status: 403, message: "El usuario no tiene los claims requeridos" };
    }
  }

  return null;
}

export function authMiddleware(requiredClaims = null) {
  return (req, res, next) => {
    req.auth = { ok: false, user: null, subject: null };

    const failure = verifyRequest(req, requiredClaims);
    if (!failure) {
      req.auth.ok = true;
      return next();
    }

    if (process.env.AUTH_ENFORCE === "true") {
      return res.status(failure.status).json({ error: failure.message });
    }

    console.warn(`[auth] modo permisivo (AUTH_ENFORCE != true), se deja pasar ${req.method} ${req.originalUrl}: ${failure.message}`);
    return next();
  };
}
