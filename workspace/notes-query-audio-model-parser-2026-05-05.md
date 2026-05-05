# Query / audio-query improvement notes — 2026-05-05

## Problem
`lib/audio-query.ts` had grown into a large deterministic router based mostly on regexes and narrow state checks. It handled the happy path, but it was brittle around paraphrases, ambiguous references, ASR variation, and mixed intents.

## Change made
Introduced a hybrid query interpreter design:
- added a tiny model-backed parser step before deterministic execution
- kept deterministic session updates, recipe loading, stepping, and response shaping
- preserved the older heuristic path as a fallback if the model is unavailable or returns something unusable

## Main implementation details
- Added `OPENAI_QUERY_MODEL` support in `lib/audio-query.ts`
  - default: `gpt-4.1-nano`
- Added structured parser output (`ParsedQuery`) with actions like:
  - `search_recipe`
  - `load_recipe`
  - `get_ingredients`
  - `get_current_step`
  - `next_step`
  - `previous_step`
  - `repeat_step`
  - `substitution_question`
  - `recipe_question`
  - `clarify`
- Added candidate recipe ranking before model calls to keep prompts smaller and cheaper
- Added deterministic execution layer for parsed actions
- Retained the old regex-based intent path as a safety net

## Why
This gives better natural-language coverage without handing full answer generation over to the model. The model interprets the request; the app still owns state changes and recipe facts.

## Files touched
- `lib/audio-query.ts`

## Testing done
- Typecheck attempted after implementation
- More behavioral testing still needed through `/query` and `/query-audio`

## Follow-up / split-PR ideas
1. Extract model parsing into its own module, e.g. `lib/query-interpreter.ts`
2. Add request/response fixtures for spoken-style queries and edge cases
3. Add lightweight logging/telemetry for parser action + fallback rate
4. Improve substitution handling beyond the current narrow canned responses
5. Add structured support for jump-to-step and ingredient navigation
