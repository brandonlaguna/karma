-- =====================================================================
-- Seed REAL: inventario de dispositivos de Perú, extraído de
-- 'NOC_v20260506.xlsx' (hoja 'Inventario NOC Disp Peru').
-- Generado programáticamente -- no editar a mano, regenerar si cambia.
-- =====================================================================

INSERT INTO countries (iso_code, name) VALUES ('PE', 'Perú')
ON CONFLICT (iso_code) DO NOTHING;

INSERT INTO devices (device_name, country_id, city, site, support_group, device_type, service, ip_or_url, display_name)
SELECT v.device_name, co.id, v.city, v.site, v.support_group, v.device_type, v.service, v.ip_or_url, v.display_name
FROM (VALUES
  ('PERLIM-STACATALINA-NETFWPER_10.222.79.4', 'Lima', 'STACATALINA', 'NET', 'FW', 'PER', '10.222.79.4', 'PERIMETRAL 600F DC - HA'),
  ('PERLIM-STACATALINA-NETSWCOR_10.222.79.5', 'Lima', 'STACATALINA', 'NET', 'SW', 'COR', '10.222.79.5', 'SW CORE 1 DC'),
  ('PERLIM-STACATALINA-NETSWCOR_10.222.79.6', 'Lima', 'STACATALINA', 'NET', 'SW', 'COR', '10.222.79.6', 'SW CORE 2 DC'),
  ('PERLIM-STACATALINA-NETFWSEG_10.222.79.7', 'Lima', 'STACATALINA', 'NET', 'FW', 'SEG', '10.222.79.7', 'SEGMENTACION 600F DC - HA'),
  ('PERLIM-STACATALINA-NETSWSER_10.222.79.8', 'Lima', 'STACATALINA', 'NET', 'SW', 'SER', '10.222.79.8', 'SW SRV ARUBA'),
  ('PERLIM-ATE-NETSWCOR_10.222.79.9', 'Lima', 'ATE', 'NET', 'SW', 'COR', '10.222.79.9', 'SW CORE 1 ATE'),
  ('PERLIM-ATE-NETSWCOR_10.222.79.10', 'Lima', 'ATE', 'NET', 'SW', 'COR', '10.222.79.10', 'SW CORE 2 ATE'),
  ('PERLIM-STACATALINA-SERMON_10.222.79.18', 'Lima', 'STACATALINA', 'SER', 'MONITORING', 'N/A', '10.222.79.18', 'NCE-Campus'),
  ('PERLIM-STACATALINA-SERMONINSIGHT_10.222.79.19', 'Lima', 'STACATALINA', 'SER', 'MONITORING', 'INSIGHT', '10.222.79.19', 'NCE-CampusInsight'),
  ('PERLIM-STACATALINA-NETFWFAZ_10.222.79.50', 'Lima', 'STACATALINA', 'NET', 'FW', 'FAZ', '10.222.79.50', 'FORTIANALYZER'),
  ('PERLIM-STACATALINA-NET_10.222.79.26', 'Lima', 'STACATALINA', 'NET', 'N/A', 'N/A', '10.222.79.26', 'PE_DCSC_AGREGACION_HW_STACK')
) AS v(device_name, city, site, support_group, device_type, service, ip_or_url, display_name)
JOIN countries co ON co.iso_code = 'PE'
ON CONFLICT (device_name) DO NOTHING;
