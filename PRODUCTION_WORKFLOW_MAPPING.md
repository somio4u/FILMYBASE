# Production Workflow — Phase 0 Mapping

Written 2026-10-09. Based on reading the code only (no real Gemini key in
the sandbox, so no live agent output has been observed).

## The existing "silent agent"
- Function: `generateAiMovieAssetExtraction` in `app/backend/server.js`.
- Output stored in: `ai_movie_projects.assets` (JSONB, one blob per project,
  **overwritten** on every run — no revision number, no run id).
- Runs after: Analyze/Proceed, Generate-from-Reference, every story-layer
  approval, the whole screenplay approval — and (new, see below) every 5th
  approved screenplay beat.
- It reads: pasted text + backfill (story, synopsis, characters, three-act,
  beat sheet, screenplay scenes so far) + Reference Material (capped).

## Output shape
Before (unchanged, still produced):
`{ characters[], properties[], environments[] }`, each
`{ name, visualDescription: { en, hi } }`.

Added 2026-10-09 (all optional — old stored rows without them still work):
- every entry: `aliases[]`, `sceneRefs[]`, `states[]`, `missing[]`
- characters: `costumes[ { name, description } ]`
- new list `otherAssets[ { kind, ...same fields } ]` (letters/signs with exact
  text, vehicles, creatures, VFX, songs)

## Gaps (what the agent still does NOT supply)
- No stable ids → the adapter matches by normalised name + aliases and keeps
  its own internal ids.
- No run/revision id → the adapter uses a hash of the payload as the
  revision identity and keeps every distinct payload as an immutable snapshot.
- No source-screenplay version id → the adapter records the project's
  `updated_at` and approved-stage status at import time.
- No shots, dialogue line ids, or evidence quotes → marked "absent", never invented.

## Project / user model
- Project = `ai_movie_projects.id`. Logins live in `users` (admin and
  "Production only"); routes use `requireRole("admin")`. Roles for the new
  workflow will map onto this table (owner/reviewer = admin; designer = a
  new simple role label until real designer logins are wanted).
- File storage: Supabase Storage bucket (default `crew-photos`) with a local
  `/uploads` fallback — reuse for designer uploads.
- Background jobs: none durable; existing pattern is fire-and-forget with an
  in-memory status map. Fine for Phase 1 (no paid jobs yet).

## Phase 1 change list (next)
1. New tables (safe `IF NOT EXISTS` migration): agent_imports,
   production_assets, asset_versions, asset_media, design_tasks,
   design_submissions, audit_events.
2. Adapter: read `assets` → snapshot (hash) → upsert assets → issues inbox.
3. Production Dossier screen. 4. Designer tasks + briefs
   (MUST KEEP / MAY EXPLORE / NEEDS DECISION). 5. Uploads + submit.
6. Exact-version approval + approved library. 7. ZIP export.
Each verified before the next.
