-- =====================================================================
-- Esquema: matriz RACI de escalamiento de incidentes, multi-país.
--
-- Diseño (ver explicación completa en el chat):
--   - countries / opmanager_probes: relacionan cada sonda de OpManager
--     con un país desde el día uno (por opmanager_probe_id, no por IP
--     ni nombre, que pueden cambiar).
--   - escalation_levels: los niveles genéricos (1 = primera respuesta,
--     2 = escalamiento, 3 = crisis), independientes de país.
--   - teams / contacts: separa el ROL funcional (ej. "NOC", "Redes")
--     de la PERSONA que lo ocupa en un momento dado -- si alguien
--     cambia de puesto, se actualiza el contacto, no la matriz.
--   - escalation_raci: la matriz en sí. country_id NULL = regla
--     global/default; una fila con country_id específico SOBRESCRIBE
--     la regla global para ese país (fallback: si no hay override,
--     se usa la fila global).
-- =====================================================================

CREATE TABLE IF NOT EXISTS countries (
  id SERIAL PRIMARY KEY,
  iso_code VARCHAR(2) NOT NULL UNIQUE,   -- ISO 3166-1 alpha-2, ej. 'CO', 'PE', 'EC'
  name VARCHAR(100) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS opmanager_probes (
  id SERIAL PRIMARY KEY,
  opmanager_probe_id VARCHAR(100) NOT NULL UNIQUE, -- ID real que asigna OpManager a la sonda
  country_id INTEGER NOT NULL REFERENCES countries(id),
  name VARCHAR(150) NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_opmanager_probes_country ON opmanager_probes(country_id);

CREATE TABLE IF NOT EXISTS teams (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,             -- ej. 'NOC', 'Redes', 'Country Ops', 'Dirección'
  -- NULL = área genérica, aplica a cualquier país (Redes, Servidores,
  -- Telefonía, BBDD, Desarrollo...). Con valor = específica de ese país
  -- (ej. una sede/site como "Infraestructura Royal", que solo existe en
  -- Colombia) -- mismo patrón global+override que escalation_raci.country_id.
  country_id INTEGER REFERENCES countries(id),
  -- Match EXACTO contra el customField "Grupo Resolutor" de OpManager
  -- (ej. "CO-REDES", "CO-SERVIDORES") -- para áreas funcionales
  -- genéricas. Preferible a comparar por nombre de área (que varía:
  -- "Redes" vs "REDES Co" vs "Networking").
  resolver_group_code VARCHAR(50),
  -- Match EXACTO contra el customField "Site" de OpManager (ej.
  -- "ROYAL") -- para las áreas de infraestructura ligadas a una
  -- sede/site específica, que no tienen Grupo Resolutor propio.
  site_code VARCHAR(50),
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS contacts (
  id SERIAL PRIMARY KEY,
  name VARCHAR(150) NOT NULL,
  email VARCHAR(150),
  phone VARCHAR(255), -- no siempre es un teléfono "limpio": puede traer PBX/extensión en el mismo campo
  team_id INTEGER REFERENCES teams(id),
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_contacts_team ON contacts(team_id);

-- Unicidad por email (parcial: permite varios contactos sin email, pero
-- no dos con el MISMO email) -- necesario porque la misma persona suele
-- aparecer como responsable en varias áreas/niveles a la vez.
CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_email_unique
  ON contacts(email) WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS escalation_levels (
  id SERIAL PRIMARY KEY,
  level_number INTEGER NOT NULL UNIQUE,   -- 1, 2, 3...
  name VARCHAR(100) NOT NULL,             -- 'Primera respuesta', 'Escalamiento', 'Crisis'
  trigger_description TEXT,               -- cuándo aplica este nivel (severidad, tiempo sin resolver, etc.)
  response_sla_minutes INTEGER,
  resolution_sla_minutes INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS escalation_raci (
  id SERIAL PRIMARY KEY,
  escalation_level_id INTEGER NOT NULL REFERENCES escalation_levels(id),
  country_id INTEGER REFERENCES countries(id),  -- NULL = regla global (default para todos los países)
  team_id INTEGER REFERENCES teams(id),
  contact_id INTEGER REFERENCES contacts(id),   -- opcional: persona específica en vez de/además del equipo
  raci_role VARCHAR(1) NOT NULL CHECK (raci_role IN ('R', 'A', 'C', 'I')),
  description TEXT,                              -- contexto en lenguaje natural para que el agente lo entienda mejor
  schedule VARCHAR(100),                          -- horario de atención de este contacto/rol, ej. "24x7"
  response_time VARCHAR(100),                     -- tiempo de respuesta comprometido (texto libre: no siempre es un número limpio de minutos)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_team_or_contact CHECK (team_id IS NOT NULL OR contact_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_escalation_raci_lookup
  ON escalation_raci(escalation_level_id, country_id);

-- Evita duplicar la misma fila (mismo nivel+país+área+contacto+rol) si
-- el seed se corre más de una vez.
CREATE UNIQUE INDEX IF NOT EXISTS idx_escalation_raci_unique
  ON escalation_raci(escalation_level_id, country_id, team_id, contact_id, raci_role);

-- ---------------------------------------------------------------------
-- Inventario de dispositivos conocidos -- lookup EXACTO por nombre de
-- dispositivo (nomenclatura completa), para resolver país/ciudad/sede/
-- grupo de soporte sin depender de que el customField de OpManager
-- esté bien diligenciado. Si el dispositivo no está catalogado acá, se
-- cae al parseo de la nomenclatura (ver knowledge-base/nomenclatura-
-- dispositivos.md) como último recurso.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS devices (
  id SERIAL PRIMARY KEY,
  device_name VARCHAR(255) NOT NULL UNIQUE, -- nomenclatura completa, ej. "PERLIM-STACATALINA-NETSWCOR_10.222.79.5"
  country_id INTEGER REFERENCES countries(id),
  city VARCHAR(100),
  site VARCHAR(100),          -- Ubicación/Sede (ej. "STACATALINA")
  support_group VARCHAR(20),  -- código corto de la nomenclatura (ej. "NET", "SER")
  device_type VARCHAR(50),    -- ej. "SW", "FW"
  service VARCHAR(50),        -- ej. "COR", "SEG"
  ip_or_url VARCHAR(255),
  display_name VARCHAR(255),  -- nombre descriptivo (ej. "SW CORE 1 DC")
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_devices_country ON devices(country_id);

-- ---------------------------------------------------------------------
-- Migración incremental: "schedule"/"response_time" se agregaron
-- DESPUÉS de la primera corrida de migrate en el servidor -- el
-- CREATE TABLE IF NOT EXISTS de arriba no las crea en una tabla que ya
-- existe, por eso el ALTER explícito acá (sí es idempotente: no falla
-- si ya se corrió antes o si la tabla se creó de cero con las columnas
-- ya incluidas).
-- ---------------------------------------------------------------------
ALTER TABLE escalation_raci ADD COLUMN IF NOT EXISTS schedule VARCHAR(100);
ALTER TABLE escalation_raci ADD COLUMN IF NOT EXISTS response_time VARCHAR(100);
-- contacts.phone era VARCHAR(50) -- insuficiente para valores reales que
-- traen PBX/extensión en el mismo campo (ej. "6015940000 Ext: 10046
-- PBX 601 5940000 ext 21888 Op7", 51 caracteres).
ALTER TABLE contacts ALTER COLUMN phone TYPE VARCHAR(255);
-- teams.country_id es nuevo -- mismo motivo, ADD COLUMN IF NOT EXISTS
-- porque la tabla ya existía sin esta columna.
ALTER TABLE teams ADD COLUMN IF NOT EXISTS country_id INTEGER REFERENCES countries(id);
CREATE INDEX IF NOT EXISTS idx_teams_country ON teams(country_id);
-- resolver_group_code/site_code son nuevos -- mismo motivo.
ALTER TABLE teams ADD COLUMN IF NOT EXISTS resolver_group_code VARCHAR(50);
ALTER TABLE teams ADD COLUMN IF NOT EXISTS site_code VARCHAR(50);
CREATE UNIQUE INDEX IF NOT EXISTS idx_teams_resolver_group_code
  ON teams(resolver_group_code) WHERE resolver_group_code IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_teams_site_code
  ON teams(site_code) WHERE site_code IS NOT NULL;

-- ---------------------------------------------------------------------
-- Corrección de diseño (2026-08-05): al principio se asumió que áreas
-- como "Redes"/"Servidores"/"BBDD" eran genéricas (un solo team,
-- country_id NULL, válido para cualquier país). Con datos reales de
-- Perú/Chile/México quedó claro que NO es así: cada país tiene su
-- propio "Grupo Resolutor" (CO-REDES vs PE-REDES vs CL-REDES...), o
-- sea que cada país necesita su PROPIA fila de team con su propio
-- resolver_group_code -- ya no alcanza un solo team "Redes" compartido
-- entre países. Por eso el nombre del team deja de ser único por sí
-- solo: ahora la unicidad es (nombre, país). teams_name_key es el
-- nombre que Postgres le da por defecto al UNIQUE inline de la
-- definición original de la tabla.
-- ---------------------------------------------------------------------
ALTER TABLE teams DROP CONSTRAINT IF EXISTS teams_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_teams_name_country_unique ON teams(name, country_id);
