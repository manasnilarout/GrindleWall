# All-in-one image: Node serves the API, the WebSocket, and the Vite build.
# One process, one port — the shape Cloud Run, Render, Railway, and Fly expect.
# Build from the repository root:
#   docker build -f deploy/Dockerfile -t grindelwald .

FROM node:22-bookworm-slim AS frontend
WORKDIR /app
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    STATIC_DIR=/app/ui \
    SESSION_DIR=/data/sessions

RUN mkdir -p /data/sessions && chown -R node:node /data

COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node backend/package.json backend/package-lock.json backend/tsconfig.json ./
COPY --chown=node:node backend/src ./src
COPY --from=frontend --chown=node:node /app/dist /app/ui

USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=25s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

# node is PID 1 so SIGTERM from Cloud Run / docker stop reaches the process.
# `tsx` is a runtime dependency — do not switch this stage to omit it.
CMD ["node", "--import", "tsx", "src/index.ts"]
