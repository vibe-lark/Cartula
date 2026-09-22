FROM node:22.23.1-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --registry=https://registry.npmjs.org --no-audit --no-fund --fetch-retries=1 --fetch-timeout=30000
FROM deps AS build
COPY tsconfig*.json vite*.ts index.html app.html mcp-host.html ./
COPY src ./src
COPY scripts ./scripts
COPY skills ./skills
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:22.23.1-bookworm-slim
ENV NODE_ENV=production PORT=3900 DATABASE_PATH=/app/data/cartula.sqlite
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
COPY package.json ./
COPY scripts ./scripts
COPY skills ./skills
COPY THIRD_PARTY_NOTICES.md LICENSE ./
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 3900
HEALTHCHECK --interval=15s --timeout=4s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:3900/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist-server/server/index.js"]
