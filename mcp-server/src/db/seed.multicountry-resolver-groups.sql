-- =====================================================================
-- Catálogo de "Grupo Resolutor" / "Site" multi-país (2026-08-05).
-- Generado desde la plantilla de confirmación que llenó Victor
-- (plantilla_datos_pendientes.xlsx). Solo incluye filas marcadas
-- "Confirmado: Sí" -- las marcadas "No" (ej. PE-BASESDEDATOS,
-- PE-DESARROLLO, todo USNS) quedan pendientes, ver notas al final.
--
-- IMPORTANTE: esto es solo el catálogo de RUTEO (a qué país/área
-- pertenece un dispositivo). Los CONTACTOS y la matriz RACI de
-- Perú/Chile/México todavía NO están cargados -- get_escalation_matrix
-- va a poder identificar el equipo/país correcto, pero no va a
-- devolver contactos hasta que esos datos lleguen.
-- =====================================================================

INSERT INTO countries (iso_code, name) VALUES
  ('PE', 'Perú'),
  ('CL', 'Chile'),
  ('MX', 'México')
ON CONFLICT (iso_code) DO NOTHING;

-- ---------------------------------------------------------------------
-- Perú -- solo Redes/Servidores/Telefonía confirmados. BBDD y
-- Desarrollo quedaron marcados "No" en la plantilla, no se cargan.
-- ---------------------------------------------------------------------
INSERT INTO teams (name, country_id, resolver_group_code)
SELECT v.name, co.id, v.code
FROM (VALUES
  ('Redes', 'PE-REDES'),
  ('Servidores', 'PE-SERVIDORES'),
  ('Telefonía', 'PE-TELEFONIA')
) AS v(name, code)
JOIN countries co ON co.iso_code = 'PE'
ON CONFLICT (name, country_id) DO UPDATE SET resolver_group_code = EXCLUDED.resolver_group_code;

-- ---------------------------------------------------------------------
-- Chile -- las 5 áreas confirmadas. OJO: Victor aclaró que
-- "CL-DESARROLLO" en la práctica lo atiende el equipo de Servidores
-- (no hay un equipo de Desarrollo separado en Chile) -- se deja como
-- team propio para no perder el código de ruteo, pero cuando se
-- carguen los contactos reales de Chile, el contacto de este team
-- debería ser el MISMO que el de "Servidores" (Chile), no uno nuevo.
-- ---------------------------------------------------------------------
INSERT INTO teams (name, country_id, resolver_group_code, description)
SELECT v.name, co.id, v.code, v.description
FROM (VALUES
  ('Redes', 'CL-REDES', NULL),
  ('Servidores', 'CL-SERVIDORES', NULL),
  ('Telefonía', 'CL-TELEFONIA', NULL),
  ('BBDD', 'CL-BASESDEDATOS', NULL),
  ('Desarrollo', 'CL-DESARROLLO', 'Lo atiende el equipo de Servidores (Chile) -- no hay un equipo de Desarrollo separado. Al cargar contactos reales, usar el mismo contacto que Servidores (Chile).')
) AS v(name, code, description)
JOIN countries co ON co.iso_code = 'CL'
ON CONFLICT (name, country_id) DO UPDATE SET resolver_group_code = EXCLUDED.resolver_group_code, description = EXCLUDED.description;

-- ---------------------------------------------------------------------
-- México -- 10 áreas confirmadas (el catálogo de áreas de México es
-- más amplio que el de los demás países: además de las 5 "base" tiene
-- Directorio Activo, Grabadoras, Seguridad de la Información,
-- Marcadores y WFM). "Telecomunicaciones" también aparece como
-- "TELECOM Mx" en algunos dispositivos -- mismo código guardado, alias
-- documentado en description por si el customField real varía.
-- ---------------------------------------------------------------------
INSERT INTO teams (name, country_id, resolver_group_code, description)
SELECT v.name, co.id, v.code, v.description
FROM (VALUES
  ('Redes', 'MX-REDES', NULL),
  ('Servidores', 'MX-SERVIDORES', NULL),
  ('Telecomunicaciones', 'MX-TELECOMUNICACIONES', 'También puede aparecer como "TELECOM Mx" en algunos dispositivos.'),
  ('Desarrollo', 'MX-DESARROLLO', NULL),
  ('BBDD', 'MX-BASESDEDATOS', NULL),
  ('Directorio Activo', 'MX-DIRECTORIOACTIVO', NULL),
  ('Grabadoras', 'MX-GRABADORAS', NULL),
  ('Seguridad de la Información', 'MX-SEGURIDADDELAINFORMACION', NULL),
  ('Marcadores', 'MX-MARCADORES', NULL),
  ('WFM', 'MX-WFM', NULL)
) AS v(name, code, description)
JOIN countries co ON co.iso_code = 'MX'
ON CONFLICT (name, country_id) DO UPDATE SET resolver_group_code = EXCLUDED.resolver_group_code, description = EXCLUDED.description;

-- ---------------------------------------------------------------------
-- Colombia -- 3 sedes nuevas que no estaban en el Excel original de
-- Atento (Royal/Dorado/Telares/Elemento/Nevados-Olaya/Medellín).
-- ---------------------------------------------------------------------
INSERT INTO teams (name, country_id, site_code)
SELECT v.name, co.id, v.code
FROM (VALUES
  ('Infraestructura Colombia XV', 'CXV'),
  ('Infraestructura Nearshore', 'NEARSHORE'),
  ('Infraestructura Bucaramanga', 'BUCARAMANGA')
) AS v(name, code)
JOIN countries co ON co.iso_code = 'CO'
ON CONFLICT (name, country_id) DO UPDATE SET site_code = EXCLUDED.site_code;

-- ---------------------------------------------------------------------
-- Pendiente / NO cargado en este seed (dejar constancia para no
-- repetir el trabajo de diagnóstico):
--
-- 1. USNS (5 filas en la plantilla: Servidores, Telefonía x2, Redes,
--    Seguridad de la Información) -- Victor marcó que el customField
--    real de esas sondas NO trae el indicativo de país "usns" como se
--    asumió. Falta el valor EXACTO tal cual aparece en OpManager antes
--    de poder cargarlo -- "USNS" tampoco es un código ISO de país real,
--    hay que decidir si es un país propio en la tabla `countries` o
--    una unidad de negocio distinta (ej. "Nearshore USA").
--
-- 2. PE-BASESDEDATOS y PE-DESARROLLO -- quedaron marcados "No" en la
--    plantilla, sin ejemplo real confirmado. No se cargaron.
--
-- 3. site_code de "Infraestructura Elemento" e "Infraestructura
--    Medellín" -- siguen sin confirmar (quedaron con los valores
--    inferidos ELEMENTO/MEDELLIN en seed.colombia.sql, marcados "sin
--    confirmar" ahí mismo).
-- ---------------------------------------------------------------------
