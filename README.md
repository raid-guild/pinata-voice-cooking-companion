# Pinata Voice Cooking Companion

A Pinata / OpenClaw template for building a **voice-first cooking companion**.

This template centers a practical kitchen interaction loop:

- save and search recipes
- keep lightweight cooking session state in SQLite
- accept spoken cooking queries
- answer with structured JSON plus optional generated audio
- support embedded clients such as ESP32-based kitchen devices
- expose a hosted `/app` route for recipe browsing and debugging

## Status

This repository is being built in reviewable PRs.

### PR sequence

1. **Template scaffold** ✅
2. **Core voice cooking backend** ← current phase
3. **Docs and polish**

## Current implementation in this PR phase

This template now includes:

- Next.js app router project
- SQLite-backed recipe, food-event, and voice-session persistence
- `/query` for JSON text / next-step requests
- `/query-audio` for multipart spoken queries and JSON next-step requests
- generated MP3 serving via `/app/api/audio/[name]`
- scheduled cleanup script for generated audio artifacts
- architecture writeup in `workspace/AUDIO_QUERY_ARCHITECTURE.md`

## Voice query model

The cooking flow uses a narrow persistent session model rather than a full chat transcript.

Session state tracks:
- active recipe
- current ingredient/step index
- phase (`ingredients` vs `steps`)
- pending follow-up prompt state

This makes the template well-suited to hands-free or embedded cooking experiences.

## STT / TTS

The current implementation uses OpenAI for:
- speech-to-text
- text-to-speech

When `OPENAI_API_KEY` is absent, the intended behavior is to degrade gracefully to text-only guidance where possible.

## Audio retention

Generated audio files are temporary artifacts stored under `workspace/generated-audio` and cleaned up by a scheduled script.

They should be treated as temporary fetch targets, not durable user data.

## Main files to inspect

- `app/query/route.ts`
- `app/query-audio/route.ts`
- `app/api/audio/[name]/route.ts`
- `lib/audio-query.ts`
- `lib/recipes.ts`
- `workspace/AUDIO_QUERY_ARCHITECTURE.md`
- `workspace/scripts/prune-generated-audio.sh`
