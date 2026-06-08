FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
# Pin pnpm to package.json#packageManager. pnpm 11 requires Node >=22.13,
# so the base image must be node:22 (or newer).
RUN corepack enable && corepack prepare --activate
RUN pnpm install --frozen-lockfile --prod

FROM node:22-alpine
# yt-dlp + ffmpeg: required at runtime by src/modules/youtube to fetch subtitles
# (fast path) or extract audio for local Whisper transcription (fallback).
# tzdata: para que la env TZ del contenedor (p.ej. Europe/Madrid) tenga efecto
# y los crons del Gmail digest se disparen a la hora local declarada, no en UTC.
RUN apk add --no-cache tini yt-dlp ffmpeg tzdata
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json pnpm-lock.yaml ./
COPY src ./src
COPY types ./types
# config dir is bind-mounted from the host so download-rules.json can be edited without rebuild
RUN addgroup -S luis && adduser -S luis -G luis && chown -R luis:luis /app
USER luis
EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/main.js"]
