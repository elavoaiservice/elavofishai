# Build context is the REPO ROOT (so we can COPY both server/ and public/).
FROM node:22-slim AS build
WORKDIR /app/server
# OpenSSL is needed by Prisma's engine; git lets us stamp the build with its commit.
RUN apt-get update && apt-get install -y --no-install-recommends openssl git ca-certificates && rm -rf /var/lib/apt/lists/*
COPY server/package.json server/package-lock.json* ./
RUN npm install
COPY server/ ./
RUN npx prisma generate && npm run build
# Stamp the built image with the git commit it came from → dist/build-info.json
# (read at runtime as the "current version"). .git is in the build context.
COPY .git /app/.git
# Bake the commit history too — the admin Changelog tab reads this in the
# container, where there is no .git to run `git log` against.
RUN node tools/bake-changelog.js /app/.git ./dist/changelog.json
RUN node -e "const cp=require('child_process'),fs=require('fs');const g=a=>cp.execSync(\"git -c safe.directory='*' --git-dir=/app/.git \"+a).toString().trim();let i={};try{i={commit:g('rev-parse HEAD'),commitShort:g('rev-parse --short HEAD'),subject:g('log -1 --pretty=%s'),committedAt:g('log -1 --pretty=%cI'),branch:g('rev-parse --abbrev-ref HEAD')};}catch(e){}try{i.version=require('./package.json').version;}catch(e){}i.builtAt=new Date().toISOString();fs.writeFileSync('./dist/build-info.json',JSON.stringify(i));console.log('build-info:',JSON.stringify(i));"

FROM node:22-slim AS runtime
WORKDIR /app/server
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/server/node_modules ./node_modules
COPY --from=build /app/server/dist ./dist
COPY --from=build /app/server/prisma ./prisma
COPY --from=build /app/server/package.json ./package.json
# tools/ ships too: the nightly backup runs `node tools/upload-backup.js` in
# this container to copy the dump offsite, and without it that step has been
# failing silently since the day it was written.
COPY --from=build /app/server/tools ./tools
COPY server/docker-start.sh ./docker-start.sh
# Static PWA lives at /app/public (server resolves ../../public from /app/server/dist).
COPY public/ /app/public/
RUN chmod +x docker-start.sh
EXPOSE 3100
CMD ["./docker-start.sh"]
