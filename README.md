# karma
Toda acción tiene una reacción. En el monitoreo de infraestructura, así es exactamente como funcionan las redes: un pico de tráfico (causa) provoca latencia (efecto). Un servidor que falla (causa) activa un protocolo de conmutación automática (efecto).

es un paso único en el host (no por cada deploy) — descarga el modelo de embeddings a Ollama, que corre nativo en el servidor

- ´ollama pull nomic-embed-text´

levantas todo
-  ´docker compose up -d --build´

El único paso manual extra, y no es de despliegue sino de contenido: cargar la base de conocimiento con
- ´docker exec -it ai_mcp_server pnpm run ingest´
