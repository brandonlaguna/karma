FROM node:22-alpine

WORKDIR /app

COPY package*.json pnpm-workspace.yaml ./

RUN npm install -g pnpm
RUN pnpm install --config.confirmModulesPurge=false

COPY . .

EXPOSE 4000

CMD ["pnpm", "start"]
