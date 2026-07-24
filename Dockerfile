FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY server.ts start-server.ts skill.md THIRD_PARTY_NOTICES.md LICENSE ./
COPY lib ./lib
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN useradd --create-home --uid 10001 atlas && mkdir -p /tmp/evidiq-atlas-artifacts && chown atlas:atlas /tmp/evidiq-atlas-artifacts && chmod 0700 /tmp/evidiq-atlas-artifacts
COPY --from=build --chown=atlas:atlas /app/package.json /app/package-lock.json ./
COPY --from=build --chown=atlas:atlas /app/node_modules ./node_modules
COPY --from=build --chown=atlas:atlas /app/dist ./dist
COPY --from=build --chown=atlas:atlas /app/skill.md /app/THIRD_PARTY_NOTICES.md /app/LICENSE ./
USER atlas
EXPOSE 3000
CMD ["node", "dist/start-server.js"]
