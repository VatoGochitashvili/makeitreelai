# MakeItReel — container image with ffmpeg + yt-dlp for the clip pipeline.
FROM node:20-slim

# System deps: ffmpeg (with libfreetype → captions work), plus the standalone
# yt-dlp binary (self-contained, no Python needed).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl \
 && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux \
      -o /usr/local/bin/yt-dlp \
 && chmod a+rx /usr/local/bin/yt-dlp \
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
