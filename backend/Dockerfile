# syntax=docker/dockerfile:1
#
# Build context is the REPO ROOT, not backend/ (see the `build.context: .`
# in ../docker-compose.yml) — the backend depends on the npm workspace
# package packages/types (issue #107), so the install step needs both
# backend/ and packages/ present to resolve "@stellar-global-wallet/types".
#
# No root package-lock.json is committed yet (see the PR that introduced
# this file), so this uses `npm install` rather than `npm ci`.

FROM node:20-slim AS build
WORKDIR /app

COPY package.json ./
COPY packages ./packages
COPY backend/package.json ./backend/package.json
RUN npm install

COPY backend ./backend
RUN npm run build --workspace backend

FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json ./
COPY packages ./packages
COPY backend/package.json ./backend/package.json
RUN npm install --omit=dev

COPY --from=build /app/backend/dist ./backend/dist
# Curated verified-asset lists (#54), read at runtime from backend/data.
COPY backend/data ./backend/data

EXPOSE 4000
CMD ["node", "backend/dist/index.js"]
