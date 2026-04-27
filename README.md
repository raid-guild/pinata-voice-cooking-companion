# Pinata Voice Cooking Companion

A Pinata / OpenClaw template for building a **voice-first cooking companion**.

This template is being shaped around a focused interaction model:

- save and search recipes
- keep lightweight cooking session state
- accept spoken cooking queries
- answer with structured JSON plus optional audio
- support embedded clients such as ESP32-based kitchen devices
- expose an optional hosted `/app` route for recipe browsing and debugging

## Status

This repository is starting from the modern Pinata template shape and is being built up in reviewable PRs.

### Planned PR sequence

1. **Template scaffold**
   - manifest
   - workspace files
   - README
   - template positioning
2. **Core voice cooking backend**
   - SQLite persistence
   - `/query`
   - `/query-audio`
   - generated audio serving
   - audio cleanup policy
3. **Docs and polish**
   - architecture writeup
   - onboarding refinement
   - naming, metadata, and deployment polish

## Intended capabilities

The target implementation for this template includes:

- SQLite-backed recipe storage
- persistent `voice_sessions` state
- server-side speech-to-text via OpenAI
- server-side text-to-speech via OpenAI
- temporary generated audio files with scheduled cleanup
- a hosted recipe explorer at `/app`

## Why this is a separate template

This repo is **not** intended to be a direct fork of Pinata Chef as a marketplace artifact. Instead, it starts from Pinata's current template conventions and ports over the cooking-specific voice architecture intentionally.

That keeps the template:

- aligned with the current Pinata starter shape
- easier to review and maintain
- easier to position as a dedicated voice-first cooking companion

## Deployment model

This template is meant for Pinata Agents / OpenClaw-style deployments.

The final template is expected to use:

- workspace identity files under `workspace/`
- an optional hosted app route
- OpenAI secrets for STT/TTS
- recipe and session persistence inside the workspace

## Current repository contents

This scaffold PR intentionally keeps the repo small:

- `manifest.json`
- `workspace/BOOTSTRAP.md`
- `workspace/SOUL.md`
- `workspace/AGENTS.md`
- `workspace/IDENTITY.md`
- `workspace/USER.md`
- `workspace/TOOLS.md`
- `workspace/HEARTBEAT.md`

Implementation code lands in follow-up PRs.
