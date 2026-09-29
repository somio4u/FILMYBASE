# AI Movie — Production Studio Blueprint

**Status:** plan only, nothing built yet. Build it after the screenplay is finished.
**Written:** 2026-09-29, after Steps A, B and C of the screenplay work were done.

This file is the plan for the Production side of an AI Movie: turning a
finished screenplay into images, video clips, voices and music. It is
written in simple English on purpose (project Rule 2).

---

## 1. The big idea

- **Production is a separate studio.** It is not part of the screenplay
  screens. When the screenplay is done, the user clicks
  **"Go for Production"**, and a completely different screen opens: the
  **Production Studio**, with its own layout, made for creating images and
  videos.
- **Production works from a locked copy of the screenplay.** Clicking "Go
  for Production" saves a frozen copy (a *locked version*) of the whole
  screenplay. The Studio only ever reads that copy. The user can keep
  editing the screenplay, and nothing in the Studio breaks.
- **Changes are sent across on purpose.** If the screenplay changes later,
  the user clicks **"Send changes to Production"**. The Studio then shows
  exactly which scenes changed, and marks the shots, images and clips made
  from those scenes as **out of date**. Nothing else is touched.

Why the lock matters: a 150-minute film is about **1,500–2,500 shots**.
Images and videos cost real money and time. If production read the
screenplay while it was still changing, finished images would silently stop
matching the story.

## 2. When is the screenplay "ready for production"?

The "Go for Production" button shows only when every beat is approved. The
Studio also shows a checklist (a warning only, never a block):

- [ ] Every beat approved
- [ ] Dialogue written for every scene that needs it
- [ ] Interval placed (for Akhada: after beat 25)
- [ ] Song sheets written for every song beat (Akhada: beats 8, 29, 35)
- [ ] Script Doctor run on every beat, major notes handled
- [ ] Every beat at (or near) its fixed Beat Sheet time

## 3. What already exists that Production will use

Built during the screenplay work, ready to feed the Studio:

| Already built | Used in Production for |
|---|---|
| Scene heading parts: INT/EXT, place, time of day (Step B1) | Grouping scenes by location; light and time of day |
| Scene cards: purpose, emotion, strength 1–10, emotional turn (Step C1) | Music, lighting, colour, acting direction |
| Acting notes like *(quietly)*, (V.O.), (O.S.) (Step B2) | Voice direction for voice generation |
| Transitions: CUT TO:, FREEZE FRAME: (Step B3) | How shots join in the edit |
| Song sheets: situation, mood, music, singers, filming plan (Step C3) | Song sequences: shots, music brief, choreography |
| Character voice briefs (silent agent) | Voice casting for each character |
| Supabase Storage (already used for crew photos) | Storing generated images and videos |
| The Movie side's Script Breakdown agent (cast, locations, props, costumes, art) | A starting template for the Bible agents |

**Needs replacing, not reusing:** the current silent Asset Extractor (the
character / prop / location list). It rewrites its whole list from scratch
after every approval, so descriptions change each time. That is the
opposite of what image consistency needs. Each item is one text blob with
no looks or states, and the list is never shown to the user. The Bibles
below replace it.

## 4. The layers of Production

Built in this order. Each layer feeds the next.

### Layer 1 — Bibles (made once, approved by the user, then locked)

The single source of truth for how everything looks. Every image and video
prompt is built from the Bibles, never from loose text.

- **Character Bible.** Per character:
  - A fixed "identity" that must never change: age, skin tone, height,
    build, face shape, eyes, hair, marks and scars.
  - **Looks over time**: e.g. Rudra's engineer uniform in Act 1, his
    training clothes in the Akhada, his warrior form after the climax.
    Each look is linked to the scenes it's used in.
  - **States by scene**: wounds, dirt, tiredness (e.g. the Rakhyaka's chest
    wound from beat 10).
  - How their element power looks (Rudra's fire, Meera's water…).
  - Voice profile, for voice generation.
  - **Reference images**: front, side, three-quarter, full body, picked and
    locked by the user.
- **Location Bible.** Per location: architecture, scale, materials,
  colours, light at each time of day, weather, sound. **States**: e.g. the
  Grand Road before and after the Breach. An approved reference image.
- **Prop Bible.** Per prop: material, size, colour, condition, who owns it,
  and **states**: e.g. the lathi wrapped in silk, then chained by
  Kalapahada, then glowing in Rudra's hand.
- **World and Style Bible.** One per film:
  - Photo-real or stylised, aspect ratio, colour grade per act, and
    camera/lens style.
  - The 5000 AD design language and creature designs (shadow-soldiers,
    nagas, danavas).
  - How powers look (VFX rules).
  - **Religious guardrails**, written as hard rules every prompt must obey:
    the Lord blesses and never fights; the journey is grace, not flight;
    how the deities are shown. **This is critical.**

### Layer 2 — Scene breakdown (one per scene)

For each scene of the locked screenplay:
- Characters present, and which **look/state** each is in.
- Location and its state, time of day, and weather.
- Props present and their state.
- Emotion and strength (from the scene card).
- Music cue, sound effects and ambience.
- **Continuity in/out**: what must match the scene before and the scene
  after.

### Layer 3 — Shot list (the real working unit of an AI film)

Each scene is split into shots of about 3–10 seconds. The shot durations
must add up to the scene's time, which keeps the beat's fixed time rule all
the way into production. Per shot:
- Shot number, size (wide / medium / close-up…), angle, lens, and camera
  movement.
- Length in seconds.
- What happens, and the dialogue line it covers (if any).
- Which Bible entries it uses (characters + looks, location + state,
  props + states).
- Light and mood.
- First frame / last frame notes, so the next shot joins smoothly.

### Layer 4 — Image and video generation

- **Image prompt per shot** → a **keyframe image**, built only from the
  shot and its Bible entries, with the Bible's reference images attached
  for consistency.
- **Video prompt per shot** → a **video clip**, started from the approved
  keyframe.
- Every image and clip is a **take**. The user can make more takes, pick
  the best one, and lock it. Nothing overwrites a locked take.
- Each take remembers the exact prompt, the Bible version and the screenplay
  version it was made from. That's how "out of date" (section 1) is worked
  out.

### Layer 5 — Audio

- **Dialogue voices**: one voice per character (from the voice profile),
  directed by the scene's acting notes and emotion. NARRATOR always V.O.
- **Songs**: the song sheet goes to a real lyricist and composer (the user
  chose no AI lyrics). The Studio holds the song brief and the final
  uploaded track.
- **Score and sound effects**: cues from the scene breakdown.

### Layer 6 — Assembly

- A **timeline**: locked clips in scene order, with transitions, voices,
  music and sound, and the INTERVAL card.
- Export for a real editing program (an edit list), plus a rough preview.

## 5. The Production Studio screens

A separate screen with its own layout, not inside the current screens:

- **Left side:** a list of **Bibles** and **Scenes** (with progress: how
  many shots have locked images/clips).
- **Middle:** the work area — a **big preview** of the image or clip, or
  the editor for the item picked on the left.
- **Right side:** the **prompt and settings** panel — the prompt (editable),
  which Bible items are attached, take history, "Generate", "Lock this take".

The windows inside the Studio:
1. **Dashboard** — the whole film: every scene, its status, what's out of date.
2. **Bible editor** — one page per character / location / prop, with looks,
   states and reference images.
3. **Scene board** — every scene as a card (from the breakdown).
4. **Shot list editor** — one scene's shots in order, with timing.
5. **Image window** — keyframes, takes, lock.
6. **Video window** — clips, takes, lock.
7. **Audio window** — voices, songs, score, sound.
8. **Timeline** — the assembled film.

**Technical note for the builder:** the current app is one very large screen
file (`app/frontend/src/App.jsx`, ~14,000 lines). The Studio should live in
**its own new files** (e.g. `app/frontend/src/production/`), opened from the
"Go for Production" button. It must not be added into App.jsx. Same backend,
same login.

## 6. New agents needed

| Agent | Job |
|---|---|
| Bible agent | Builds the Character / Location / Prop / Style Bibles from the locked screenplay + reference material. Replaces the Asset Extractor. |
| Scene Breakdown agent | Layer 2, one scene at a time, using the Bibles. |
| Shot List agent (cinematographer) | Layer 3: splits a scene into shots that add up to its time. |
| Prompt agent | Turns one shot + its Bible entries into image and video prompts, always adding the Style Bible and the guardrails. |
| Continuity checker | Compares neighbouring shots/scenes for mismatches (a wound that vanishes, a prop in the wrong hand). |
| Voice casting agent | Turns each voice profile into settings for the voice generator. |

## 7. Decisions the user must make before building

These are real choices with cost. Ask the user; don't guess.

1. **Image generator**: which service (e.g. Google's own image models,
   since the app already uses Gemini, or another).
2. **Video generator**: which service (e.g. Google Veo), and the maximum
   clip length it allows.
3. **Budget**: roughly how much per minute of finished film. At
   ~1,500–2,500 shots with several takes each, this matters a lot.
4. **Look**: photo-real or stylised; aspect ratio (e.g. 2.39:1 cinema, or
   16:9).
5. **Voice generation**: which service, and whether real actors will voice
   any characters.
6. **Storage**: video files are big. Check the Supabase storage plan limits
   before generating at scale.

## 8. Build order (small steps, one at a time)

Each step is built, checked, and approved before the next:

- **D0** — "Go for Production" button + locked screenplay version + an empty
  Studio shell (the new layout, with no generation yet).
- **D1** — Bibles: generate, edit, approve, lock (text only first).
- **D2** — Reference images for the Bibles (the first real image generation).
- **D3** — Scene breakdown.
- **D4** — Shot list.
- **D5** — Keyframe images per shot (takes, lock).
- **D6** — Video clips per shot (takes, lock).
- **D7** — Audio: voices, song tracks, score and sound.
- **D8** — Timeline and export.
- **D9** — "Send changes to Production" and out-of-date tracking.

Start with a **small pilot** before the whole film: one song beat (e.g.
beat 8, The Pahandi) and one dialogue beat. Take them all the way through
D1–D6 to check quality and real cost per minute, then scale up.
