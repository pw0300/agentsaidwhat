FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=dev
COPY tsconfig*.json vite.config.ts index.html ./
COPY src ./src
COPY api ./api
COPY server ./server
RUN npm run build

FROM node:22-slim AS runtime
LABEL org.opencontainers.image.title="Our Agent Said What?!" \
      org.opencontainers.image.source="https://github.com/pw0300/agentsaidwhat"
# AGENT_QA_HOME stays stable so existing deployments retain their data configuration.
ENV NODE_ENV=production HOST=0.0.0.0 PORT=5199 AGENT_QA_HOME=/data
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force && mkdir -p /data && chown node:node /data
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
COPY server ./server
COPY api ./api
COPY scenarios ./scenarios
COPY cli.mjs ./cli.mjs
USER node
VOLUME ["/data"]
EXPOSE 5199
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:5199/api/health').then(r=>{if(!r.ok)process.exit(1);return r.json()}).then(h=>{if(!h.ready)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server/local.mjs"]
