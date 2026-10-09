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

---

# Media storage design (requested 2026-10-09)

**Rule:** every generated or uploaded image, video clip, audio file and
export lives in storage the user owns — **local disk or Google Drive** —
never only at the AI provider and never in the database.

## One interface, two backends
All production code calls one small `mediaStore` (built in the uploads step):
`put(projectId, role, stream, meta)`, `get(mediaId)` (stream, with Range),
`exists`, `remove` (refused for anything approved or used by a take).
The `media_files` table records: project_id, backend (`local` | `gdrive`),
**key** (relative path, or Drive fileId), sha256, bytes, mime,
width/height/duration, role, created_by. Provider URLs are never stored.

- **Local**: folder from `MEDIA_ROOT` (default `app/backend/media/`, git-ignored).
- **Google Drive**: Drive API v3, scope `drive.file` (the app only sees files
  it created itself). Reuses the app's existing Google sign-in (currently
  Contacts-only) with the extra scope + a one-time re-consent; the refresh
  token goes in the existing token table. Files sit in the user's own Drive
  quota. Optional `GOOGLE_DRIVE_ROOT_FOLDER_ID` (variable name only).
- Choose with `MEDIA_BACKEND=local|gdrive`; optional `MEDIA_MIRROR=gdrive`
  writes a second copy.

## Same folder layout in both
`<root>/<project>/{designs,storyboard,keyframes,video-takes,audio,exports}/<CODE>_v<N>_<hash8>.<ext>`
(e.g. `CHAR001_v2_9f3a1c7e.png`) — readable by a person browsing Drive or the folder.

## Generation flow
1. Job gets a provider result (image or video).
2. **Immediately** download it (provider links expire — Veo files in ~2 days)
   and stream it into `mediaStore` (never held fully in memory; Drive uses
   resumable upload).
3. Verify type, size and sha256; only then create the take as "ready".
4. If Drive is down: keep the file in a local spool, mark `pending_upload`,
   retry with capped backoff. A take never points at media that isn't stored.

## Viewing / security
- Browser never gets a Drive link. The backend streams media through
  `/api/production/media/:id` after checking login, role and project.
- Drive files are never made public; no credentials in manifests/logs/ZIPs.
- Identical content in one project is stored once (hash match).

## Honest limits
- **Local disk on Render's free tier is wiped on every deploy/restart** (the
  app's own existing note says so). Local mode is only safe when the backend
  runs on your own computer or a host with a persistent disk. On Render
  free tier use `gdrive`.
- The Drive backend can only be tested with a mock in this sandbox; a real
  upload test needs your Google consent, so it will be reported as
  "tested with fixture only" until you try it.
- Drive API limits (per-user rate limits, 750 GB/day upload) are far above a
  film's needs, but very large videos should upload in the background.
