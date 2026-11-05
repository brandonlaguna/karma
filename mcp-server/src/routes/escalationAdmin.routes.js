import { Router } from "express";
import { z } from "zod";
import { authMiddleware } from "../auth/jwtMiddleware.js";
import * as admin from "../db/escalationAdmin.js";
import * as catalog from "../db/escalationCatalog.js";
import { importMatrix } from "../db/escalationImport.js";

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

// Edición parcial: un campo que no viene se conserva; uno que viene en null se borra.
const teamUpdateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  countryCode: isoCode.optional(),
  resolverGroupCode: code.nullable().optional(),
  siteCode: code.nullable().optional(),
  description: z.string().max(1000).nullable().optional(),
});

const contactUpdateSchema = z.object({
  name: z.string().min(1).max(150).optional(),
  email: z.email().max(150).nullable().optional(),
  phone: z.string().max(255).nullable().optional(),
  active: z.boolean().optional(),
});

const assignmentUpdateSchema = z.object({
  levelNumber: z.number().int().min(0).optional(),
  raciRole: z.enum(["R", "A", "C", "I"]).optional(),
  teamId: z.number().int().min(1).optional(),
  contactId: z.number().int().min(1).optional(),
  contact: z
    .object({ name: z.string().min(1).max(150), email: z.email().max(150).optional(), phone: z.string().max(255).optional() })
    .optional(),
  schedule: z.string().max(100).nullable().optional(),
  responseTime: z.string().max(100).nullable().optional(),
  description: z.string().max(1000).nullable().optional(),
});

const idParam = z.coerce.number().int().min(1);

// Filas tal cual salen del Excel: la validación fina (países, niveles, correos...) la hace la importación y devuelve
// un reporte por fila, así que aquí solo se exige la forma general.
const importRow = z.record(z.string(), z.unknown());
const importSchema = z.object({
  teams: z.array(importRow).max(3000).optional(),
  assignments: z.array(importRow).max(3000).optional(),
  dryRun: z.boolean().optional(),
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
    if (error?.code === "23503") {
      return res.status(409).json({ error: "El registro está en uso por otros datos y no se puede borrar o cambiar así", detail: error.detail });
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

// ---- Lecturas para la pantalla de administración (planas, sin LLM) ----
router.get("/countries", (_req, res) => run(res, () => catalog.listCountries()));

router.get("/teams", (req, res) => {
  const countryCode = typeof req.query.countryCode === "string" && req.query.countryCode.trim() ? req.query.countryCode.trim() : undefined;
  run(res, () => catalog.listTeams({ countryCode }));
});

router.get("/levels", (_req, res) => run(res, () => catalog.listLevels()));

router.get("/contacts", (req, res) => {
  const q = typeof req.query.q === "string" && req.query.q.trim() ? req.query.q.trim() : undefined;
  run(res, () => catalog.listContacts({ q, limit: req.query.limit }));
});

router.get("/assignments", (req, res) => {
  const text = (value) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
  const level = text(req.query.levelNumber);
  const levelNumber = level === undefined ? undefined : Number(level);
  if (levelNumber !== undefined && !Number.isInteger(levelNumber)) return res.status(400).json({ error: "levelNumber debe ser un entero" });
  const team = text(req.query.teamId);
  const teamId = team === undefined ? undefined : Number(team);
  if (teamId !== undefined && !Number.isInteger(teamId)) return res.status(400).json({ error: "teamId debe ser un entero" });

  run(res, () => catalog.listAssignments({ countryCode: text(req.query.countryCode), levelNumber, teamId, q: text(req.query.q), limit: req.query.limit }));
});

router.get("/audit", (req, res) => run(res, () => catalog.listAudit({ limit: req.query.limit })));

// ---- Ediciones y bajas ----
router.put("/assignments/:id", (req, res) => {
  const id = idParam.safeParse(req.params.id);
  if (!id.success) return res.status(400).json({ error: "id debe ser un entero positivo" });
  const body = validate(assignmentUpdateSchema, req.body, res);
  if (body) run(res, () => admin.updateAssignment(id.data, body, actorFrom(req)));
});

router.put("/teams/:id", (req, res) => {
  const id = idParam.safeParse(req.params.id);
  if (!id.success) return res.status(400).json({ error: "id debe ser un entero positivo" });
  const body = validate(teamUpdateSchema, req.body, res);
  if (body) run(res, () => admin.updateTeam(id.data, body, actorFrom(req)));
});

router.delete("/teams/:id", (req, res) => {
  const id = idParam.safeParse(req.params.id);
  if (!id.success) return res.status(400).json({ error: "id debe ser un entero positivo" });
  run(res, () => admin.deleteTeam(id.data, actorFrom(req)));
});

router.put("/contacts/:id", (req, res) => {
  const id = idParam.safeParse(req.params.id);
  if (!id.success) return res.status(400).json({ error: "id debe ser un entero positivo" });
  const body = validate(contactUpdateSchema, req.body, res);
  if (body) run(res, () => admin.updateContact(id.data, body, actorFrom(req)));
});

router.delete("/contacts/:id", (req, res) => {
  const id = idParam.safeParse(req.params.id);
  if (!id.success) return res.status(400).json({ error: "id debe ser un entero positivo" });
  run(res, () => admin.deleteContact(id.data, actorFrom(req)));
});

router.delete("/countries/:isoCode", (req, res) => {
  const iso = isoCode.safeParse(req.params.isoCode);
  if (!iso.success) return res.status(400).json({ error: "isoCode debe tener 2 letras" });
  run(res, () => admin.deleteCountry(iso.data, actorFrom(req)));
});

router.delete("/levels/:levelNumber", (req, res) => {
  const levelNumber = z.coerce.number().int().min(0).safeParse(req.params.levelNumber);
  if (!levelNumber.success) return res.status(400).json({ error: "levelNumber debe ser un entero >= 0" });
  run(res, () => admin.deleteLevel(levelNumber.data, actorFrom(req)));
});

// Importación masiva desde Excel: con dryRun (por omisión) solo valida y devuelve el reporte; con dryRun=false, si no hay errores, guarda.
router.post("/import", (req, res) => {
  const body = validate(importSchema, req.body, res);
  if (body) run(res, () => importMatrix(body, actorFrom(req)));
});

export default router;
