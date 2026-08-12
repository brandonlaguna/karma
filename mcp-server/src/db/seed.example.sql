-- =====================================================================
-- [EJEMPLO/PLANTILLA -- no se ejecuta automáticamente]
-- Muestra cómo poblar la matriz RACI con datos reales. Copia lo que
-- necesites, reemplaza por tus países/sondas/contactos reales, y
-- ejecútalo manualmente (psql o el cliente que prefieras).
-- =====================================================================

-- 1) Países que maneja Epistech
INSERT INTO countries (iso_code, name) VALUES
  ('CO', 'Colombia'),
  ('PE', 'Perú')
ON CONFLICT (iso_code) DO NOTHING;

-- 2) Sondas de OpManager -> país. opmanager_probe_id debe ser el ID
--    real que usa OpManager para esa sonda (no el nombre ni la IP).
INSERT INTO opmanager_probes (opmanager_probe_id, country_id, name, description)
SELECT '12345', id, 'Sonda Bogotá', 'Sonda principal OpManager - Colombia'
FROM countries WHERE iso_code = 'CO'
ON CONFLICT (opmanager_probe_id) DO NOTHING;

-- 3) Equipos (roles funcionales, no personas)
INSERT INTO teams (name, description) VALUES
  ('NOC', 'Turno de monitoreo y primera respuesta'),
  ('Redes', 'Especialistas de infraestructura de red'),
  ('Direccion', 'Responsables de país / crisis')
ON CONFLICT (name) DO NOTHING;

-- 4) Contactos (personas reales que ocupan un rol en un momento dado)
INSERT INTO contacts (name, email, phone, team_id)
SELECT 'Nombre Apellido', 'correo@epistech.com', '+57 300 0000000', id
FROM teams WHERE name = 'NOC';

-- 5) Niveles de escalamiento
INSERT INTO escalation_levels (level_number, name, trigger_description, response_sla_minutes, resolution_sla_minutes) VALUES
  (1, 'Primera respuesta', 'Alerta crítica (severity Critical o Service Down)', 10, NULL),
  (2, 'Escalamiento', 'No resuelto en 30 min, o afecta más de un sitio', 30, 60),
  (3, 'Crisis', 'Afecta cliente > 1h, o caída de enlace principal + backup simultánea', 60, NULL)
ON CONFLICT (level_number) DO NOTHING;

-- 6) Matriz RACI -- regla GLOBAL (country_id NULL = aplica a todos los países)
INSERT INTO escalation_raci (escalation_level_id, country_id, team_id, raci_role, description)
SELECT lvl.id, NULL, t.id, 'R', 'El NOC de turno reconoce y responde primero, en cualquier país'
FROM escalation_levels lvl, teams t
WHERE lvl.level_number = 1 AND t.name = 'NOC';

-- 7) Matriz RACI -- override ESPECÍFICO de país (ej. Colombia tiene un
--    accountable distinto al default global para nivel 2)
INSERT INTO escalation_raci (escalation_level_id, country_id, team_id, raci_role, description)
SELECT lvl.id, c.id, t.id, 'A', 'Para Colombia, Redes aprueba el escalamiento a nivel 2'
FROM escalation_levels lvl, countries c, teams t
WHERE lvl.level_number = 2 AND c.iso_code = 'CO' AND t.name = 'Redes';
