#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
WORKSPACE_DIR=$(dirname "$SCRIPT_DIR")
AUDIO_DIR="${AUDIO_DIR:-$WORKSPACE_DIR/generated-audio}"
RETENTION_DAYS="${RETENTION_DAYS:-1}"

if [ ! -d "$AUDIO_DIR" ]; then
  echo "generated-audio directory not found; nothing to clean."
  exit 0
fi

find "$AUDIO_DIR" -maxdepth 1 -type f -name '*.mp3' -mtime +"$RETENTION_DAYS" -print -delete

echo "generated-audio cleanup complete (retention: ${RETENTION_DAYS} day(s))."
