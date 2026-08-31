# MakeItReel — container image with ffmpeg + yt-dlp (+ a JS runtime) for the pipeline.
FROM node:20-slim

# System deps:
#  - ffmpeg (with libfreetype → captions work)
#  - the standalone yt-dlp binary (self-contained, no Python needed). It ships
#    per-architecture, so pick the right one — the x86 build simply will not run
#    on ARM, which is the only thing that stopped this image working on
#    Hetzner's cheaper CAX line.
#  - deno: yt-dlp needs a JS runtime to solve YouTube's player challenges
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl unzip \
 && case "$(uname -m)" in \
      aarch64|arm64) YTDLP=yt-dlp_linux_aarch64 ;; \
      *)             YTDLP=yt-dlp_linux ;; \
    esac \
 && curl -L "https://github.com/yt-dlp/yt-dlp/releases/latest/download/$YTDLP" \
      -o /usr/local/bin/yt-dlp \
 && chmod a+rx /usr/local/bin/yt-dlp \
 && curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first for better layer caching.
COPY package*.json ./
RUN npm ci --omit=dev

# App source.
COPY . .

ENV NODE_ENV=production
# Hosts set $PORT; the server already reads it (defaults to 3000).
EXPOSE 3000

CMD ["npm", "start"]
