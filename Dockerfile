# syntax=docker/dockerfile:1
#
# Multi-stage build: dependencies and the TypeScript compiler stay in the build
# stages, so the runtime image contains only production modules and compiled
# JavaScript.

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --from=build /app/dist ./dist

# The service needs no privileges beyond reading its own files.
USER node

EXPOSE 8080
CMD ["node", "dist/index.js"]
