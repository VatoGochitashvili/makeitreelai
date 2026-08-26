#!/bin/bash
# Double-click this file to start MakeItReel and watch it work.
# (Finder runs .command files in a new Terminal window.)

cd "$(dirname "$0")" || exit 1

# ffmpeg-full is keg-only but is the build that can render captions.
export PATH="/opt/homebrew/opt/ffmpeg-full/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
export DEBUG_JOBS=1          # show yt-dlp / ffmpeg output too

clear
printf '\033[1;36m'
cat <<'BANNER'
  __  __       _        _ _   ____           _
 |  \/  | __ _| | _____(_) |_|  _ \ ___  ___| |
 | |\/| |/ _` | |/ / _ \ | __| |_) / _ \/ _ \ |
 | |  | | (_| |   <  __/ | |_|  _ <  __/  __/ |
 |_|  |_|\__,_|_|\_\___|_|\__|_| \_\___|\___|_|
BANNER
printf '\033[0m\n'

# --- checks -----------------------------------------------------------
missing=0
for tool in node ffmpeg yt-dlp; do
  if command -v "$tool" >/dev/null 2>&1; then
    printf '  \033[32m✓\033[0m %-8s %s\n' "$tool" "$(command -v $tool)"
  else
    printf '  \033[31m✗\033[0m %-8s NOT FOUND\n' "$tool"
    missing=1
  fi
done

if ffmpeg -hide_banner -filters 2>/dev/null | grep -qw subtitles; then
  printf '  \033[32m✓\033[0m captions animated captions supported\n'
else
  printf '  \033[33m!\033[0m captions ffmpeg lacks libass — run: brew install ffmpeg-full\n'
fi

if grep -q '^OPENAI_API_KEY=sk-' .env 2>/dev/null; then
  printf '  \033[32m✓\033[0m api key  loaded from .env\n'
else
  printf '  \033[31m✗\033[0m api key  missing from .env — clips will fail\n'
  missing=1
fi

if [ "$missing" = "1" ]; then
  printf '\n\033[31mFix the items above, then run this again.\033[0m\n'
  read -r -p "Press Return to close…" _
  exit 1
fi

# --- free the port ----------------------------------------------------
if lsof -ti :3000 >/dev/null 2>&1; then
  echo
  echo "  (stopping a server already on port 3000)"
  lsof -ti :3000 | xargs kill -9 2>/dev/null
  sleep 1
fi

printf '\n\033[1mStarting…\033[0m  the browser will open in a moment.\n'
printf 'Everything the server does — downloads, Whisper, GPT, ffmpeg — prints below.\n'
printf 'Press \033[1mCtrl+C\033[0m to stop.\n\n'

# open the browser once the server answers
( for _ in $(seq 1 40); do
    if curl -s -o /dev/null http://localhost:3000/; then open http://localhost:3000; break; fi
    sleep 0.5
  done ) &

# Run node directly rather than via npm: npm doesn't forward signals to its
# child, so closing this window would leave the server orphaned.
exec node server.js
