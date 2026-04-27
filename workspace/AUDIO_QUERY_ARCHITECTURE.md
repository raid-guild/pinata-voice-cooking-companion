# Audio Query Architecture (Current Version)

This document describes the exact architecture and implementation currently used for the Pinata Chef audio query flow in this version of the app.

It is intended as a handoff note for other agents and developers.

---

## Overview

The current system supports a cooking-assistant flow with:

- saved recipes in SQLite
- lightweight persistent voice session state in SQLite
- text query handling
- audio query handling
- server-side speech-to-text via OpenAI
- server-side text-to-speech via OpenAI
- temporary generated MP3 storage on local disk
- daily cleanup of generated audio files

This is **not** a general chat-memory system. The session model is a narrow cooking-state machine that tracks the currently loaded recipe and where the user is in ingredients/steps.

---

## Main Components

### 1. API routes

#### `/query`
Text-first endpoint for structured JSON requests.

File:
- `app/query/route.ts`

Behavior:
- accepts JSON requests
- supports `inputMode: "query" | "next_step"`
- for `query`, requires `query` text
- for `next_step`, advances current cooking/session state without requiring text
- returns JSON only
- does **not** generate audio

#### `/query-audio`
Audio-capable endpoint.

File:
- `app/query-audio/route.ts`

Behavior:
- supports multipart audio uploads for spoken queries
- supports JSON requests for `inputMode: "next_step"`
- returns JSON, including optional `audio.url`
- uses the same underlying cooking/session logic as `/query`

#### `/app/api/audio/[name]`
Static-style file serving route for generated TTS MP3s.

File:
- `app/api/audio/[name]/route.ts`

Behavior:
- serves generated MP3 files from local disk
- returns `404` if a file has already been deleted by cleanup

---

## Core Library Logic

### `lib/audio-query.ts`
This is the main orchestration layer for spoken and typed cooking interactions.

Responsibilities:
- validate incoming audio files
- transcribe audio to text
- detect cooking intent from transcript text
- read and update session state
- resolve recipe lookup / step progression / repeat / substitution questions
- synthesize answer text to MP3 when audio is requested
- shape final JSON responses

### `lib/recipes.ts`
This is the persistence layer for recipes, food events, and voice sessions.

Responsibilities:
- SQLite database initialization
- recipe CRUD helpers
- food-event CRUD helpers
- persistent voice session state read/write

---

## Storage Model

### SQLite database

Database path:
- `workspace/data/recipes.db`

Defined in:
- `lib/recipes.ts`

The database contains at least these tables relevant to this architecture:
- `recipes`
- `food_events`
- `voice_sessions`

### `voice_sessions` table

The voice-session table stores the minimal persistent state needed for cooking flow continuity.

Stored fields:
- `client_key` — session id
- `active_recipe_id` — recipe identifier currently loaded into the voice flow
- `step_index` — current ingredient or instruction index
- `phase` — `ingredients` or `steps`
- `pending_prompt` — pending disambiguation state
- `updated_at` — timestamp for last change

Important note:
- the database **does not store generated audio URLs**
- the database **does not store raw transcripts as conversation history**
- the database **does not store uploaded audio blobs**

### Generated audio on disk

Generated TTS files are written to:
- `workspace/generated-audio`

These files are transient artifacts, not durable records.

Current behavior:
- each generated TTS response is saved as a unique MP3 file
- the JSON response includes a URL pointing at that file
- the file can later disappear after cleanup

---

## Session Model

The audio/text cooking flow uses a very small session object.

Shape:

```ts
{
  activeRecipeId: string | null;
  stepIndex: number;
  phase: "ingredients" | "steps";
  pendingPrompt: "ingredients_or_first_step" | "ingredients_or_repeat" | null;
}
```

The public response returns a simplified session payload:

```json
{
  "session": {
    "id": "sess_<uuid>",
    "activeRecipeId": "recipe-slug-or-null",
    "stepIndex": 0,
    "phase": "ingredients"
  }
}
```

### What sessions are for

Sessions are used to track:
- which recipe is active
- whether the assistant is reading ingredients or steps
- which ingredient/step index is current
- whether a follow-up clarification is pending

### What sessions are not for

Sessions are **not** used to store:
- general chat memory
- long transcript history
- audio files
- generated audio URLs

---

## Session ID Resolution

The system supports multiple ways for a client to provide session identity.

### `/query` JSON requests
Accepted sources, in order:
1. `sessionId`
2. `session.id`
3. `x-session-id` header
4. generated fallback: `sess_<uuid>`

### `/query-audio` JSON requests
Accepted sources, in order:
1. `sessionId`
2. `session.id`
3. `x-session-id` header
4. generated fallback: `sess_<uuid>`

### `/query-audio` multipart form requests
Accepted sources, in order:
1. form field `sessionId`
2. form field `session.id`
3. `x-session-id` header
4. generated fallback: `sess_<uuid>`

---

## `/query` Contract

### Supported input modes
- `query`
- `next_step`

### Example request: text query

```json
{
  "inputMode": "query",
  "query": "How do I make scallop scampi?"
}
```

### Example request: button-driven advancement

```json
{
  "inputMode": "next_step",
  "session": {
    "id": "sess_123"
  }
}
```

### Response behavior
Returns JSON like:

```json
{
  "ok": true,
  "transcript": "How do I make scallop scampi?",
  "intent": "recipe_lookup",
  "answerText": "I found Scallop Scampi. Want ingredients or the first step?",
  "session": {
    "id": "sess_123",
    "activeRecipeId": "scallop-scampi",
    "stepIndex": 0,
    "phase": "ingredients"
  }
}
```

No audio is generated by `/query`.

---

## `/query-audio` Contract

### Mode 1: multipart spoken query

Expected request:
- `Content-Type: multipart/form-data`
- file field `audio` (preferred) or `file`
- optional session identity as described above

Supported input audio formats:
- `.wav`
- `.mp3`
- `audio/wav`
- `audio/mpeg`

Current size limit:
- 8 MB max

Flow:
1. accept uploaded audio file
2. validate file type and size
3. transcribe via OpenAI
4. pass transcript into the same text-query logic used by `/query`
5. generate answer text
6. synthesize answer MP3 via OpenAI
7. save MP3 to disk
8. return JSON including `audio.url`

### Mode 2: JSON next-step request

Expected request:

```json
{
  "inputMode": "next_step",
  "session": {
    "id": "sess_123"
  }
}
```

Behavior:
- does not accept free-text query mode in JSON on `/query-audio`
- only advances the current step/ingredient flow
- generates audio in the response path

### Example response

```json
{
  "ok": true,
  "transcript": "how do i make scallop scampi",
  "intent": "recipe_lookup",
  "answerText": "I found Scallop Scampi. Want ingredients or the first step?",
  "audio": {
    "mimeType": "audio/mpeg",
    "url": "/app/api/audio/1777252806310-f616ab9f-3025-4aa6-882b-4a28843511a6.mp3"
  },
  "session": {
    "id": "sess_123",
    "activeRecipeId": "scallop-scampi",
    "stepIndex": 0,
    "phase": "ingredients"
  }
}
```

Important note:
- `audio.url` should be treated as **temporary**
- it points to a generated file that may later be deleted by cleanup

---

## Speech-to-Text Implementation

Speech-to-text is implemented in:
- `lib/audio-query.ts`

Current mechanism:
- direct server-side HTTP call to OpenAI Audio Transcriptions API

Endpoint used:
- `https://api.openai.com/v1/audio/transcriptions`

Auth:
- `Authorization: Bearer ${OPENAI_API_KEY}`

Request style:
- multipart `FormData`
- includes:
  - `model`
  - `file`

Current default model:
- `whisper-1`

Configured by environment variable:
- `OPENAI_TRANSCRIPTION_MODEL`

Fallback default if unset:
- `whisper-1`

Important note:
- there is currently **no local transcription engine**
- there is currently **no ffmpeg preprocessing/transcoding pipeline**
- uploaded audio is **not persisted to disk**

---

## Text-to-Speech Implementation

Text-to-speech is implemented in:
- `lib/audio-query.ts`

Current mechanism:
- direct server-side HTTP call to OpenAI Audio Speech API

Endpoint used:
- `https://api.openai.com/v1/audio/speech`

Auth:
- `Authorization: Bearer ${OPENAI_API_KEY}`

Request style:
- JSON body with:
  - `model`
  - `voice`
  - `input`
  - `format`

Current defaults:
- model: `gpt-4o-mini-tts`
- voice: `alloy`
- format: `mp3`

Configured by environment variables:
- `OPENAI_TTS_MODEL`
- `OPENAI_TTS_VOICE`

Fallback defaults if unset:
- `gpt-4o-mini-tts`
- `alloy`

Output behavior:
1. receive MP3 bytes from OpenAI
2. create `workspace/generated-audio` if needed
3. write MP3 file to disk
4. return a relative or absolute URL for later fetch

---

## Intent and State Handling

The cooking interaction is intentionally lightweight and deterministic.

It is driven by:
- string normalization
- keyword/phrase detection
- recipe title matching
- current session state
- pending disambiguation prompts

### Supported intent categories
- `recipe_lookup`
- `load_recipe`
- `next_step`
- `substitution_question`
- `repeat_step`
- `general_help`

### Examples of supported behaviors
- find a saved recipe by spoken title
- load recipe and ask whether to read ingredients or first step
- move through ingredients one by one
- move through instructions one by one
- repeat current step
- answer contextual questions like:
  - time
  - temperature
  - what step am I on?
  - what was the previous step?
  - what comes next?
- answer simple substitution prompts

This is **not** a freeform agentic reasoning loop. It is a structured cooking assistant flow built on deterministic state and heuristics.

---

## Recipe Resolution Strategy

Recipe lookup is based on saved recipes in SQLite.

Current behavior includes:
- normalization of recipe titles
- simple title variant matching
- scoring based on exact match / substring match / partial word overlap
- fallback recommendation based on matching words against recipe metadata and ingredients

If a recipe is not found:
- the user gets a clear “not found / not saved yet” style answer
- no fake recipe is invented

---

## Error Handling

### Common cases
- missing/invalid `inputMode`
- missing `query` text for `/query`
- missing audio file on `/query-audio`
- unsupported audio type
- oversized audio file
- no active recipe loaded for step advancement
- missing `OPENAI_API_KEY`

### Behavior
Errors generally return JSON with:
- `ok: false`
- human-readable `answerText`
- current or fallback `session` object

If `OPENAI_API_KEY` is missing on audio route:
- `/query-audio` returns an “Audio processing is not configured yet.” style response

---

## Generated Audio Retention Policy

### Why generated audio is temporary
Generated audio files are implementation artifacts used to provide a fetchable `audio.url` response.

They are **not** treated as durable user data because:
- they can be regenerated from `answerText`
- they are not referenced from SQLite records
- keeping them forever adds little value

### Cleanup implementation
Cleanup script:
- `workspace/scripts/prune-generated-audio.sh`

Current behavior:
- deletes `*.mp3` files from `workspace/generated-audio`
- deletes files older than 1 day

### Scheduled cleanup
A daily OpenClaw cron job runs the cleanup script.

Current schedule:
- daily at `03:30 UTC`

Job purpose:
- prune old generated TTS audio
- prevent unbounded disk growth
- keep the current architecture simple

### Important implication
Old `audio.url` links can eventually return `404` after cleanup.

This is acceptable in the current design because:
- audio links are temporary response artifacts
- SQLite does not store or resend those URLs

---

## What Is Persisted vs Not Persisted

### Persisted
- recipes
- food events
- voice session state

### Not persisted
- uploaded input audio files
- generated audio URLs in the database
- transcript history as a full conversation log
- arbitrary chat memory for voice sessions

### Temporarily persisted on disk
- generated TTS MP3 files under `workspace/generated-audio`

---

## Current Architectural Tradeoffs

### Strengths
- simple implementation
- narrow and predictable state model
- persistent step/recipe continuity across requests
- no need for heavyweight chat memory
- straightforward client contract
- fetchable audio URL works well for web and embedded consumers

### Limitations
- generated audio is file-backed rather than streamed directly
- old audio URLs can expire after cleanup
- recipe matching is heuristic, not semantic
- no transcript/audit history for voice turns
- no local STT/TTS fallback if OpenAI is unavailable

---

## Embedded / ESP32 Implications

The current design is compatible with an embedded client that can:
- upload audio to `/query-audio`
- parse JSON
- optionally fetch and play MP3 from `audio.url`

Important client assumption:
- the returned `audio.url` should be treated as temporary
- clients should fetch and play it promptly rather than assuming long-term retention

---

## Environment Variables in Use

Current relevant environment variables:
- `OPENAI_API_KEY`
- `OPENAI_TRANSCRIPTION_MODEL`
- `OPENAI_TTS_MODEL`
- `OPENAI_TTS_VOICE`

Defaults if unset:
- transcription model: `whisper-1`
- TTS model: `gpt-4o-mini-tts`
- TTS voice: `alloy`

---

## Source Files to Read First

If another agent needs to understand or modify this system, start with these files:

1. `app/query-audio/route.ts`
2. `app/query/route.ts`
3. `lib/audio-query.ts`
4. `lib/recipes.ts`
5. `app/api/audio/[name]/route.ts`
6. `workspace/scripts/prune-generated-audio.sh`

---

## Version Notes for This Writeup

This writeup reflects the version where:
- session state is stored in SQLite
- `/query` supports `inputMode: "query" | "next_step"`
- `/query-audio` accepts multipart spoken queries and JSON `inputMode: "next_step"`
- server-generated session IDs are returned in `session.id`
- clients may provide session identity via `sessionId`, `session.id`, or `x-session-id`
- generated MP3s are stored under `workspace/generated-audio`
- generated audio is pruned daily
- SQLite does not store generated audio URLs

---

## Recommended Usage Guidance for Other Agents

When describing this system to users or other agents, do not imply that:
- generated audio files are permanent
- voice session state contains a full conversation history
- the app uses local Whisper or local TTS
- missing recipes are inferred from the open web

The correct framing is:
- persistent recipe + cooking-state system
- OpenAI-backed STT and TTS
- temporary generated audio artifacts
- deterministic recipe/step assistant behavior layered over saved recipes
