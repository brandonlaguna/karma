import { Router } from "express";
import { getEscalationMatrix } from "../db/escalation.js";

const router = Router();

const asString = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);

// Misma consulta que la tool get_escalation_matrix, pero directa y sin LLM,
// para servicios (ej. el worker de EpistechBackend) que necesitan la matriz
// como dato y no una respuesta en lenguaje natural.
router.get("/", async (req, res) => {
  const levelNumber = asString(req.query.levelNumber) === undefined ? undefined : Number(req.query.levelNumber);
  if (levelNumber !== undefined && !Number.isInteger(levelNumber)) {
    return res.status(400).json({ error: "levelNumber debe ser un entero" });
  }

  try {
    const { resolvedCountry, rows } = await getEscalationMatrix({
      countryCode: asString(req.query.countryCode),
      opmanagerProbeId: asString(req.query.opmanagerProbeId),
      levelNumber,
      resolverGroupCode: asString(req.query.resolverGroupCode),
      siteCode: asString(req.query.siteCode),
      teamName: asString(req.query.teamName),
    });

    return res.json({ resolvedCountry, rows });
  } catch (error: any) {
    console.error("Error consultando la matriz de escalamiento:", error);
    return res.status(500).json({ error: error.message });
  }
});

export default router;
