FROM node:24-alpine AS dependencies
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm ci --no-audit --no-fund

FROM dependencies AS build
COPY tsconfig*.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine AS production-dependencies
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:24-alpine AS release
RUN apk add --no-cache tini
WORKDIR /usr/src/app
COPY --from=production-dependencies /usr/src/app/node_modules ./node_modules
COPY --from=build /usr/src/app/build/src ./
COPY config ./config
ENV NODE_ENV=production PORT=3000
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s CMD node -e "fetch('http://127.0.0.1:' + (process.env.NODE_PORT || process.env.PORT || 3000) + '/health', {signal: AbortSignal.timeout(2000)}).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "index.js"]
