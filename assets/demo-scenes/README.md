# Demo scenes

The two scenes behind everything on the features pages. Both are ours, which is
the point: the demo clips are real pipeline output, and they can be published
because no one else's footage is in them.

- `studio.html` — a podcast studio, speaker deliberately left of centre so
  Smart Frame has a real off-centre subject to find (it lands on 42%).
- `course.html` — a procedurally laid out blocky parkour course, used as the
  gameplay background for the split-screen and brainrot formats.

Rendering them needs Chrome:

```bash
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
"$CHROME" --headless --disable-gpu --no-sandbox --hide-scrollbars \
  --window-size=1920,1080 --screenshot=studio.png file://$PWD/studio.html
"$CHROME" --headless --disable-gpu --no-sandbox --hide-scrollbars \
  --window-size=1080,5400 --screenshot=course.png file://$PWD/course.html
```

The course becomes footage by panning it, which is what gives the scroll:

```bash
ffmpeg -loop 1 -i course.png -t 40 -r 30 \
  -vf "crop=1080:1920:0:'(ih-1920)*(1-t/40)',format=yuv420p" gameplay.mp4
```

Then rebuild `public/demo-assets/source.mp4` from `studio.png` plus the
narration, and run the pipeline against it four ways — balanced, crop, split,
brainrot — as described in CLAUDE.md.
