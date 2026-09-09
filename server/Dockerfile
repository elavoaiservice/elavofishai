# Build context is the REPO ROOT (so we can COPY both server/ and public/).
FROM node:22-slim AS build
WORKDIR /app/server
# OpenSSL is needed by Prisma's engine.
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY server/package.json server/package-lock.json* ./
RUN npm install
COPY server/ ./
RUN npx prisma generate && npm run build

FROM node:22-slim AS runtime
WORKDIR /app/server
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/server/node_modules ./node_modules
COPY --from=build /app/server/dist ./dist
COPY --from=build /app/server/prisma ./prisma
COPY --from=build /app/server/package.json ./package.json
COPY server/docker-start.sh ./docker-start.sh
# Static PWA lives at /app/public (server resolves ../../public from /app/server/dist).
COPY public/ /app/public/
RUN chmod +x docker-start.sh
EXPOSE 3100
CMD ["./docker-start.sh"]
