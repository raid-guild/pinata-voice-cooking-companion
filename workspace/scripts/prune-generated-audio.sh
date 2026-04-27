#!/bin/sh
set -eu

AUDIO_DIR="/home/node/clawd/workspace/generated-audio"
RETENTION_DAYS="${RETENTION_DAYS:-1}"

if [ ! -d "$AUDIO_DIR" ]; then
  echo "generated-audio directory not found; nothing to clean."
  exit 0
fi

find "$AUDIO_DIR" -maxdepth 1 -type f -name '*.mp3' -mtime +"$RETENTION_DAYS" -print -delete

echo "generated-audio cleanup complete (retention: ${RETENTION_DAYS} day(s))."
