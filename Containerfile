# Multi-stage build: compile the client and server, then ship only the
# runtime dependencies. The final image is ~200 MB and runs as the unprivileged
# "node" user.
FROM docker.io/library/node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM docker.io/library/node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/client/dist client/dist
COPY bin/tern-cli /usr/local/bin/tern-cli
RUN chmod +x /usr/local/bin/tern-cli && chown -R node:node /app
USER node
EXPOSE 3080
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s CMD wget -qO- http://127.0.0.1:3080/healthz >/dev/null 2>&1 || exit 1
CMD ["node", "server/dist/index.js"]
