# DiagramService (flu3nce-bpmn-pipeline) para Hetzner. Ver docs/DEPLOY-HETZNER.md.
# Escrito el 1-nov-2026 SIN CONSTRUIR (en la VM de FLU3NCE no se ejecuta codigo
# de terceros): construir y probar en Hetzner.
#
# Fijar las imagenes por digest al construir la primera vez, p. ej.
#   NODE_IMAGE=node:22-bookworm-slim@sha256:<digest>
ARG NODE_IMAGE=node:22-bookworm-slim

# ── 1. build: dependencias (con las de desarrollo), tsc y poda ─────────────────
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
# --ignore-scripts: ninguna dependencia necesita scripts de instalacion.
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY src ./src
RUN npm run build \
 && npm prune --omit=dev --ignore-scripts --no-audit --no-fund

# ── 2. test (opcional): `docker build --target test .` corre npm test ─────────
FROM ${NODE_IMAGE} AS test
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY src ./src
COPY examples ./examples
COPY server ./server
COPY tests ./tests
RUN npm test

# ── 3. runtime: solo dist, dependencias de produccion y el servidor ──────────
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    PORT=8080
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY server/server.cjs server/healthcheck.cjs ./server/
# Usuario sin privilegios (uid 1000, viene en la imagen oficial). Los ficheros
# son de root y de solo lectura para el proceso.
USER node
# Puerto INTERNO: no se publica; solo el proxy (Caddy) lo alcanza por la red
# interna de compose.
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD ["node", "server/healthcheck.cjs"]
CMD ["node", "server/server.cjs"]
