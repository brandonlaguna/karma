FROM node:22-alpine

WORKDIR /app

COPY package.json pnpm-workspace.yaml ./

RUN npm install -g pnpm
RUN pnpm install --config.confirmModulesPurge=false

COPY . .

# FIX: "pnpm start" corre dist/index.js, pero nunca se generaba con
# "tsc" en la imagen -- dist/ quedaba con lo que hubiera en el disco al
# momento del build (código viejo, desincronizado de src/). Esto causaba
# que las tools vivieran con lógica/esquema desactualizado aunque src/
# ya estuviera corregido (ej. "relation countries does not exist" pese
# a que la tabla sí existía -- el dist/ viejo apuntaba a otro esquema).
RUN pnpm run build

EXPOSE 4100

CMD ["pnpm", "start"]