import { Router } from "express";
import { z } from "zod";
import { authMiddleware } from "../auth/jwtMiddleware.js";
import * as admin from "../db/escalationAdmin.js";

// Claims requeridos para escribir, separados por coma. Vacío = basta con
// estar autenticado (y con AUTH_ENFORCE != true, ni eso: ver jwtMiddleware).
const writeClaims = (process.env.ESCALATION_WRITE_CLAIMS ?? "")
  .split(",")
  .map((claim) => claim.trim())
  .filter(Boolean);

const router = Router();
router.use(authMiddleware(writeClaims.length ? writeClaims : null));

const isoCode = z.string().length(2);
const code = z.string().min(1).max(50);

const countrySchema = z.object({ isoCode, name: z.string().min(1).max(100) });

const teamSchema = z.object({
  countryCode: isoCode,
  name: z.string().min(1).max(100),
  resolverGroupCode: code.optional(),
  siteCode: code.optional(),
  description: z.string().max(1000).optional(),
});

const levelSchema = z.object({
  name: z.string().min(1).max(100),
  triggerDescription: z.string().max(1000).optional(),
  responseSlaMinutes: z.number().int().min(0).optional(),
  resolutionSlaMinutes: z.number().int().min(0).optional(),
});

const assignmentSchema = z
  .object({
    countryCode: isoCode,
    resolverGroupCode: code.optional(),
    siteCode: code.optional(),
    teamName: z.string().min(1).max(100).optional(),
    levelNumber: z.number().int().min(0),
    raciRole: z.enum(["R", "A", "C", "I"]).default("R"),
    contact: z.object({
      name: z.string().min(1).max(150),
      email: z.email().max(150).optional(),
      phone: z.string().max(255).optional(),
    }),
    schedule: z.string().max(100).optional(),
    responseTime: z.string().max(100).optional(),
    description: z.string().max(1000).optional(),
    replace: z.boolean().default(false),
  })
  .refine((value) => value.resolverGroupCode || value.siteCode || value.teamName, {
    message: "Indica resolverGroupCode, siteCode o teamName para identificar el equipo",
  });

function actorFrom(req) {
  const user = req.auth?.user;
  const id = user?.Id ?? req.auth?.subject ?? null;
  return { id: id === null ? null : String(id), name: user?.Nombre ?? null, authenticated: Boolean(req.auth?.ok) };
}

async function run(res, work) {
  try {
    return res.json(await work());
  } catch (error) {
    if (error instanceof admin.HttpError) return res.status(error.status).json({ error: error.message });
    if (error?.code === "23505") {
      return res.status(409).json({ error: "Ya existe un registro con ese valor único", detail: error.detail });
    }
    console.error("Error en la administración de la matriz de escalamiento:", error);
    return res.status(500).json({ error: "Error interno" });
  }
}

function validate(schema, data, res) {
  const parsed = schema.safeParse(data ?? {});
  if (parsed.success) return parsed.data;
  res.status(400).json({ error: "Datos inválidos", issues: parsed.error.issues });
  return null;
}

router.post("/countries", (req, res) => {
  const body = validate(countrySchema, req.body, res);
  if (body) run(res, () => admin.upsertCountry(body, actorFrom(req)));
});

router.post("/teams", (req, res) => {
  const body = validate(teamSchema, req.body, res);
  if (body) run(res, () => admin.upsertTeam(body, actorFrom(req)));
});

router.put("/levels/:levelNumber", (req, res) => {
  const levelNumber = z.coerce.number().int().min(0).safeParse(req.params.levelNumber);
  if (!levelNumber.success) return res.status(400).json({ error: "levelNumber debe ser un entero >= 0" });

  const body = validate(levelSchema, req.body, res);
  if (body) run(res, () => admin.upsertLevel({ ...body, levelNumber: levelNumber.data }, actorFrom(req)));
});

router.post("/assignments", (req, res) => {
  const body = validate(assignmentSchema, req.body, res);
  if (body) run(res, () => admin.createAssignment(body, actorFrom(req)));
});

router.delete("/assignments/:id", (req, res) => {
  const id = z.coerce.number().int().min(1).safeParse(req.params.id);
  if (!id.success) return res.status(400).json({ error: "id debe ser un entero positivo" });

  run(res, () => admin.deleteAssignment(id.data, actorFrom(req)));
});

export default router;
