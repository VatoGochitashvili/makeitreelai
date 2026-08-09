# Replit system dependencies. This installs the two command-line tools
# the pipeline needs: ffmpeg (video cutting) and yt-dlp (downloading).
{ pkgs }: {
  deps = [
    pkgs.nodejs_20
    pkgs.ffmpeg
    pkgs.yt-dlp
  ];
}
