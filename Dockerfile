# Twig server: zero runtime dependencies, runs TypeScript directly on Node 22 (type stripping).
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080 DATABASE_PATH=/data/twig.db TRUST_PROXY=true
COPY server/package.json server/tsconfig.json ./server/
COPY server/src ./server/src
COPY server/public ./server/public
COPY sdk/web ./sdk/web
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "server/src/main.ts"]
