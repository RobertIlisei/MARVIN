#!/bin/sh
# Renders the supervisor workspace comps (brief §13) to PNG. Static mockups; no app code involved.
set -e
cd "$(dirname "$0")"
out=renders; mkdir -p "$out"
shot() { # name width height
  npx -y playwright screenshot --browser=chromium --viewport-size="$2,$3" --full-page \
    "file://$PWD/comps.html#$1" "$out/$1.png" >/dev/null
  echo "$out/$1.png"
}
shot typical-dark 1440 900
shot typical-light 1440 900
shot narrow-dark-cap 960 720
shot wide-light-auto 1920 1080
shot wide-dark-paused 1920 1080
shot off-light 1440 900
shot off-dark-narrow 960 720
shot states-dark 1330 900
shot states-light 1330 900
