# [EJEMPLO -- borra o reemplaza este archivo] Escalamiento de incidentes críticos

Este es un documento de ejemplo para probar que la ingesta a Qdrant y la
búsqueda funcionan de punta a punta. No es contenido real de Epistech --
reemplázalo por tus políticas y contactos reales cuando estés listo.

## Nivel 1 -- Primera respuesta

Ante una alerta crítica (severity Critical o Service Down), el
especialista de turno del NOC debe reconocer la alerta dentro de los
primeros 10 minutos y notificar al canal correspondiente según el área
afectada.

## Nivel 2 -- Escalamiento

Si el incidente no se resuelve en 30 minutos, o si afecta a más de un
sitio simultáneamente (alerta masiva), se escala al Nivel 2:

- Redes: Cristian Sánchez Eslava
- NOC: Martín Escalante

## Nivel 3 -- Crisis

Incidentes que afectan servicio a cliente por más de 1 hora, o caídas de
enlace principal y backup simultáneas, se declaran como Sala de Crisis y
se notifica a los responsables de cada país afectado.
