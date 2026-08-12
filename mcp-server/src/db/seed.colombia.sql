-- =====================================================================
-- Seed REAL: matriz de escalamiento de Atento/Colombia, extraída de
-- 'Atento_Matriz de Contactos.xlsx' (hoja 'Matriz de Escalamientos').
-- Generado programáticamente desde el Excel real -- no editar a mano
-- salvo para corregir un dato puntual; si el Excel cambia, regenerar.
-- =====================================================================

INSERT INTO countries (iso_code, name) VALUES ('CO', 'Colombia')
ON CONFLICT (iso_code) DO NOTHING;

INSERT INTO escalation_levels (level_number, name, trigger_description) VALUES
  (0, 'Contacto Inicial', 'Primer punto de contacto del área -- buzón/soporte general, antes de escalar a una persona.')
ON CONFLICT (level_number) DO NOTHING;

INSERT INTO teams (name) VALUES
  ('Redes'),
  ('Servidores'),
  ('Telefonía'),
  ('BBDD'),
  ('Infraestructura Royal'),
  ('Infraestructura Dorado'),
  ('Infraestructura Telares'),
  ('Infraestructura Elemento'),
  ('Infraestructura Nevados-Olaya'),
  ('Infraestructura Medellín'),
  ('Desarrollo')
ON CONFLICT (name) DO NOTHING;

INSERT INTO contacts (name, email, phone) VALUES
  ('Soporte Redes', 'redes.Colombia@atento.com', '+57 316 463 82 57
PBX 601 5940000 ext 21888 Op2'),
  ('Diego Fernando Herrera', 'diego.herrera@atento.com', '+57 321 923 54 64'),
  ('Saul Federico Neuhaus', 'saul.romero@atento.com', '+57 317 3453759'),
  ('Javier Leandro Suarez', 'javier.suarez@atento.com', '+57 315 343 21 76'),
  ('Soporte Servidores', 'servidores.colombia@atento.com', '+57 318 364 42 71
PBX 601 5940000 ext 21888 Op4'),
  ('Oscar Javier Ramirez', 'oscar.ramirez@atento.com', '+57 313 255 25 09'),
  ('Sopote Telefonía', 'telefonia.colombia@atento.com', '+57 3
PBX 601 5940000 ext 21888 Op1'),
  ('Lorena Catalina Salazar', 'lorena.salazar@atento.com', '+57 318 708 06 39'),
  ('Jairo Rodolfo Gonzalez', 'jairo.lamprea@atento.com', '+57 317 6474252'),
  ('Soporte Bases de Datos', 'BasedeDatos.Colombia@atento.com', '+57 318 695 42 88
PBX 601 5940000 ext 21888 Op3'),
  ('Jeison Maldonado', 'jeisson.rincon@atento.com', '+57 317 641 58 16'),
  ('Daniel Leiton Ruiz', 'daniel.leyton@atento.com', '+57 320 407 23 36'),
  ('John Alexander Ramire', 'john.ramirez@atento.com', '+57 315 809 66 98'),
  ('Cindy Janeth Vivas', 'cindy.vivas@atento.com', '57 3153006943'),
  ('Andres Bedoya', 'andres.bedoya@atento.com', '+57 315 612 64 58'),
  ('Henry Vargas', 'henry.vargas@atento.com', '++57 315 302 83 37'),
  ('Jhon Jairo Carrillo', 'jhon.bravo@atento.com', '+57 318 254 27 54'),
  ('Jesus Varela', 'jesus.varela@atento.com', '+57 315 607 23 03'),
  ('Karol  Marroquin - Juan  Rubio', 'desarrollo.colombia@atento.com', '6015940000 Ext: 10046
PBX 601 5940000 ext 21888 Op7'),
  ('Francisco Javier Bolivar', 'francisco.bolivar@atento.com', '+57 316 6205415'),
  ('Gabriel Arturo Adames', 'gabriel.adames@atento.com', '+57 315 3568590')
ON CONFLICT (email) WHERE email IS NOT NULL DO NOTHING;

-- Matriz RACI: un Responsable (R) por área+nivel, con horario del
-- Excel. Todas country_id = Colombia (dato específico de Atento/CO,
-- no aplica como regla global a otros países).
INSERT INTO escalation_raci (escalation_level_id, country_id, team_id, contact_id, raci_role, schedule, response_time, description)
SELECT lvl.id, co.id, t.id, c.id, 'R', v.schedule, v.response_time, v.description
FROM (VALUES
  (0, 'CO', 'Redes', 'redes.Colombia@atento.com', '24x7', NULL, 'Redes - Contacto Inicial'),
  (1, 'CO', 'Redes', 'diego.herrera@atento.com', '24x7', NULL, 'Redes - Nivel 1'),
  (2, 'CO', 'Redes', 'saul.romero@atento.com', '24x7', NULL, 'Redes - Nivel 2'),
  (3, 'CO', 'Redes', 'javier.suarez@atento.com', '24x7', NULL, 'Redes - Nivel 3'),
  (0, 'CO', 'Servidores', 'servidores.colombia@atento.com', '24x7', NULL, 'Servidores - Contacto Inicial'),
  (1, 'CO', 'Servidores', 'oscar.ramirez@atento.com', '24x7', NULL, 'Servidores - Nivel 1'),
  (2, 'CO', 'Servidores', 'saul.romero@atento.com', '24x7', NULL, 'Servidores - Nivel 2'),
  (3, 'CO', 'Servidores', 'javier.suarez@atento.com', '24x7', NULL, 'Servidores - Nivel 3'),
  (0, 'CO', 'Telefonía', 'telefonia.colombia@atento.com', '24x7', NULL, 'Telefonía - Contacto Inicial'),
  (1, 'CO', 'Telefonía', 'lorena.salazar@atento.com', '24x7', NULL, 'Telefonía - Nivel 1'),
  (2, 'CO', 'Telefonía', 'jairo.lamprea@atento.com', '24x7', NULL, 'Telefonía - Nivel 2'),
  (3, 'CO', 'Telefonía', 'javier.suarez@atento.com', '24x7', NULL, 'Telefonía - Nivel 3'),
  (0, 'CO', 'BBDD', 'BasedeDatos.Colombia@atento.com', '24x7', NULL, 'BBDD - Contacto Inicial'),
  (1, 'CO', 'BBDD', 'oscar.ramirez@atento.com', '24x7', NULL, 'BBDD - Nivel 1'),
  (2, 'CO', 'BBDD', 'saul.romero@atento.com', '24x7', NULL, 'BBDD - Nivel 2'),
  (3, 'CO', 'BBDD', 'javier.suarez@atento.com', '24x7', NULL, 'BBDD - Nivel 3'),
  (0, 'CO', 'Infraestructura Royal', 'jeisson.rincon@atento.com', '24x7', NULL, 'Infraestructura Royal - Contacto Inicial'),
  (1, 'CO', 'Infraestructura Royal', 'daniel.leyton@atento.com', '24x7', NULL, 'Infraestructura Royal - Nivel 1'),
  (2, 'CO', 'Infraestructura Royal', 'john.ramirez@atento.com', '24x7', NULL, 'Infraestructura Royal - Nivel 2'),
  (3, 'CO', 'Infraestructura Royal', 'cindy.vivas@atento.com', '24x7', NULL, 'Infraestructura Royal - Nivel 3'),
  (0, 'CO', 'Infraestructura Dorado', 'andres.bedoya@atento.com', '24x7', NULL, 'Infraestructura Dorado - Contacto Inicial'),
  (1, 'CO', 'Infraestructura Dorado', 'daniel.leyton@atento.com', '24x7', NULL, 'Infraestructura Dorado - Nivel 1'),
  (2, 'CO', 'Infraestructura Dorado', 'john.ramirez@atento.com', '24x7', NULL, 'Infraestructura Dorado - Nivel 2'),
  (3, 'CO', 'Infraestructura Dorado', 'cindy.vivas@atento.com', '24x7', NULL, 'Infraestructura Dorado - Nivel 3'),
  (0, 'CO', 'Infraestructura Telares', 'henry.vargas@atento.com', '24x7', NULL, 'Infraestructura Telares - Contacto Inicial'),
  (1, 'CO', 'Infraestructura Telares', 'daniel.leyton@atento.com', '24x7', NULL, 'Infraestructura Telares - Nivel 1'),
  (2, 'CO', 'Infraestructura Telares', 'john.ramirez@atento.com', '24x7', NULL, 'Infraestructura Telares - Nivel 2'),
  (3, 'CO', 'Infraestructura Telares', 'cindy.vivas@atento.com', '24x7', NULL, 'Infraestructura Telares - Nivel 3'),
  (0, 'CO', 'Infraestructura Elemento', 'jhon.bravo@atento.com', '24x7', NULL, 'Infraestructura Elemento - Contacto Inicial'),
  (1, 'CO', 'Infraestructura Elemento', 'daniel.leyton@atento.com', '24x7', NULL, 'Infraestructura Elemento - Nivel 1'),
  (2, 'CO', 'Infraestructura Elemento', 'john.ramirez@atento.com', '24x7', NULL, 'Infraestructura Elemento - Nivel 2'),
  (3, 'CO', 'Infraestructura Elemento', 'cindy.vivas@atento.com', '24x7', NULL, 'Infraestructura Elemento - Nivel 3'),
  (0, 'CO', 'Infraestructura Nevados-Olaya', 'jesus.varela@atento.com', '24x7', NULL, 'Infraestructura Nevados-Olaya - Contacto Inicial'),
  (1, 'CO', 'Infraestructura Nevados-Olaya', 'daniel.leyton@atento.com', '24x7', NULL, 'Infraestructura Nevados-Olaya - Nivel 1'),
  (2, 'CO', 'Infraestructura Nevados-Olaya', 'john.ramirez@atento.com', '24x7', NULL, 'Infraestructura Nevados-Olaya - Nivel 2'),
  (3, 'CO', 'Infraestructura Nevados-Olaya', 'cindy.vivas@atento.com', '24x7', NULL, 'Infraestructura Nevados-Olaya - Nivel 3'),
  (0, 'CO', 'Infraestructura Medellín', 'jhon.bravo@atento.com', '24x7', NULL, 'Infraestructura Medellín - Contacto Inicial'),
  (1, 'CO', 'Infraestructura Medellín', 'daniel.leyton@atento.com', '24x7', NULL, 'Infraestructura Medellín - Nivel 1'),
  (2, 'CO', 'Infraestructura Medellín', 'john.ramirez@atento.com', '24x7', NULL, 'Infraestructura Medellín - Nivel 2'),
  (3, 'CO', 'Infraestructura Medellín', 'cindy.vivas@atento.com', '24x7', NULL, 'Infraestructura Medellín - Nivel 3'),
  (0, 'CO', 'Desarrollo', 'desarrollo.colombia@atento.com', '24x7', NULL, 'Desarrollo - Contacto Inicial'),
  (1, 'CO', 'Desarrollo', 'francisco.bolivar@atento.com', '24x7', NULL, 'Desarrollo - Nivel 1'),
  (2, 'CO', 'Desarrollo', 'gabriel.adames@atento.com', '24x7', NULL, 'Desarrollo - Nivel 2'),
  (3, 'CO', 'Desarrollo', 'javier.suarez@atento.com', '24x7', NULL, 'Desarrollo - Nivel 3')
) AS v(level_number, country_iso, team_name, contact_key, schedule, response_time, description)
JOIN escalation_levels lvl ON lvl.level_number = v.level_number
JOIN countries co ON co.iso_code = v.country_iso
JOIN teams t ON t.name = v.team_name
JOIN contacts c ON c.email = v.contact_key OR (c.email IS NULL AND c.name = v.contact_key)
ON CONFLICT (escalation_level_id, country_id, team_id, contact_id, raci_role) DO NOTHING;

-- Corrección (2026-08-05): originalmente se pensó dejar
-- Redes/Servidores/Telefonía/BBDD/Desarrollo como áreas "genéricas"
-- (country_id NULL, compartidas entre países). Con datos reales de
-- Perú/Chile/México quedó claro que NO son genéricas -- cada país
-- tiene su propio Grupo Resolutor (CO-REDES vs PE-REDES vs CL-REDES),
-- así que también se marcan con country_id = Colombia, igual que las
-- sedes "Infraestructura X".
UPDATE teams SET country_id = (SELECT id FROM countries WHERE iso_code = 'CO')
WHERE name IN (
  'Redes',
  'Servidores',
  'Telefonía',
  'BBDD',
  'Desarrollo',
  'Infraestructura Royal',
  'Infraestructura Dorado',
  'Infraestructura Telares',
  'Infraestructura Elemento',
  'Infraestructura Nevados-Olaya',
  'Infraestructura Medellín'
);

-- resolver_group_code: match exacto contra el customField "Grupo
-- Resolutor" de OpManager. Los 5 confirmados contra ejemplos reales
-- (2026-08-05, plantilla llenada por Victor): CO-REDES, CO-SERVIDORES,
-- CO-TELEFONIA, CO-BASESDEDATOS, CO-DESARROLLO.
UPDATE teams SET resolver_group_code = 'CO-REDES' WHERE name = 'Redes' AND country_id = (SELECT id FROM countries WHERE iso_code = 'CO');
UPDATE teams SET resolver_group_code = 'CO-SERVIDORES' WHERE name = 'Servidores' AND country_id = (SELECT id FROM countries WHERE iso_code = 'CO');
UPDATE teams SET resolver_group_code = 'CO-TELEFONIA' WHERE name = 'Telefonía' AND country_id = (SELECT id FROM countries WHERE iso_code = 'CO');
UPDATE teams SET resolver_group_code = 'CO-BASESDEDATOS' WHERE name = 'BBDD' AND country_id = (SELECT id FROM countries WHERE iso_code = 'CO');
UPDATE teams SET resolver_group_code = 'CO-DESARROLLO' WHERE name = 'Desarrollo' AND country_id = (SELECT id FROM countries WHERE iso_code = 'CO');

-- site_code: match exacto contra el customField "Site" de OpManager.
-- Solo "ROYAL" está confirmado contra un ejemplo real; el resto son
-- inferidos del nombre del área -- ajustar si el Site real es distinto.
UPDATE teams SET site_code = 'ROYAL' WHERE name = 'Infraestructura Royal';
UPDATE teams SET site_code = 'DORADO' WHERE name = 'Infraestructura Dorado'; -- sin confirmar
UPDATE teams SET site_code = 'TELARES' WHERE name = 'Infraestructura Telares'; -- sin confirmar
UPDATE teams SET site_code = 'ELEMENTO' WHERE name = 'Infraestructura Elemento'; -- sin confirmar
UPDATE teams SET site_code = 'NEVADOS-OLAYA' WHERE name = 'Infraestructura Nevados-Olaya'; -- sin confirmar
UPDATE teams SET site_code = 'MEDELLIN' WHERE name = 'Infraestructura Medellín'; -- sin confirmar
