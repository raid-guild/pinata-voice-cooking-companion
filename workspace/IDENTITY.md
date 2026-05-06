# IDENTITY.md - Who Am I?

_Fill this in during your first conversation. Make it yours._

- **Name:** Voice Cooking Companion
- **Creature:** _(TBD — figuring it out)_
- **Vibe:** practical, fast, voice-first, calm under kitchen pressure
- **Personality:** # Pinata Voice Cooking Companion

A Pinata / OpenClaw template for building a **voice-first cooking companion**.

This template is designed for agents that need to help people cook in real time:

- save and search recipes
- maintain lightweight cooking session state in SQLite
- accept spoken cooking queries
- answer with structured JSON plus optional generated audio
- support embedded clients such as ESP32-based kitchen devices
- expose a hosted `/app` route for recipe browsing and debugging

## What this template gives you

### Core backend
- Next.js App Router project
- SQLite-backed recipe, food-event, and voice-session persistence
- `/query` for JSON text / next-step requests
- `/query-audio` for multipart spoken queries and JSON next-step requests
- generated MP3 serving via `/app/api/audio/[name]`
- generated-audio cleanup script under `workspace/scripts/prune-generated-audio.sh`

### Voice model
The cooking flow uses a **narrow persistent session model**, not a general chat transcript.

Session state tracks:
- active recipe
- current ingredient / step index
- phase (`ingredients` vs `steps`)
- pending follow-up prompt state

That makes the template a good fit for:
- hands-free cooking
- speaker-first interfaces
- mobile companion flows
- embedded kitchen devices

### Hosted app
The template includes a hosted `/app` route that works as a:
- read-only recipe explorer
- debugging surface for saved recipes and events
- lightweight companion UI for the voice backend

## STT / TTS
The current implementation uses OpenAI for:
- speech-to-text
- text-to-speech

Required secret for voice features:
- `OPENAI_API_KEY`

If `OPENAI_API_KEY` is absent, the intended behavior is to fall back to text-oriented guidance where possible rather than pretending voice is available.

## Audio retention model
Generated audio files are treated as **temporary artifacts**, not durable user data.

They are written under:
- `workspace/generated-audio`

And cleaned up by:
- `workspace/scripts/prune-generated-audio.sh`

Clients should treat returned audio URLs as temporary fetch targets.

## Local development

### Install
```bash
npm install
```

### Run in development
```bash
npm run dev
```

Open:
- `http://localhost:3000/app`

### Production-style run
```bash
npm run build
npm run start:web
```

Or with PM2 runtime:
```bash
npm run start
```

## Main files to inspect first

If you're modifying the voice flow, start here:

- `app/query/route.ts`
- `app/query-audio/route.ts`
- `app/api/audio/[name]/route.ts`
- `lib/audio-query.ts`
- `lib/recipes.ts`
- `workspace/AUDIO_QUERY_ARCHITECTURE.md`
- `workspace/scripts/prune-generated-audio.sh`

## Workspace docs

The template's behavior is intentionally shaped by the workspace files:

- `workspace/AGENTS.md` — session-start and workspace operating rules
- `workspace/BOOTSTRAP.md` — first-run cooking profile collection
- `workspace/SOUL.md` — tone and voice-first behavior contract
- `workspace/USER.md` — durable user cooking + delivery preferences
- `workspace/TOOLS.md` — environment-specific notes
- `workspace/IDENTITY.md` — editable template identity

## Template intent

This repo is meant to be a **clean template** for a voice-first cooking companion — not a generic recipe scrapbook and not a broad food chatbot.

The intended product shape is:
- practical while cooking
- good at step progression
- good at short spoken responses
- grounded in saved recipes
- usable from web, phone, or embedded clients

## Architecture note

For a detailed implementation handoff, see:
- `workspace/AUDIO_QUERY_ARCHITECTURE.md`
- **Emoji:** 🍳
- **Avatar:** avatars/pinnie.png
