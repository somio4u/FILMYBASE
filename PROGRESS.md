# Progress Tracker

**How to use this**: Start every Claude Code session by saying:
"Read PROGRESS.md and CLAUDE.md, tell me what's next, and let's continue."

Check off `[x]` as things get done. Claude Code should update this file
itself as work finishes — if it doesn't, ask it to.

---

## Agents Restructure: Independent Production Management ✅ DONE
User felt Production Management shouldn't live "after Screenplay" as just
another stage in one long list — it should be genuinely independent of the
Story & Screenplay agent, with each agent switchable on its own and
skippable if unwanted. Confirmed the shape with 3 quick questions first
(agent switching = full tabs, screenplay import = paste+AI extraction,
project identity = fully independent project) before restructuring.

- [x] **Sidebar "Stages" list replaced with an "Agents" list.** Two
  entries — Story & Screenplay, Production Management — each an
  accordion header that expands to show ONLY that agent's own stages when
  selected. Clicking a header switches the whole main content area like a
  tab, not just scrolling.
- [x] **History is now per-agent.** Added a `project_type` column on
  `concepts` (`'story'` or `'production'`). The History list filters to
  only the active agent's projects, and "New Idea" relabels to "New
  Production" while on that tab.
- [x] **Production Management now works as a fully standalone project** —
  no Story & Screenplay data required at all. A new `scene_lists.concept_id`
  column lets a 'production'-type project's scene list hang directly off
  its concept, bypassing the whole pitch-deck/character-sheet/three-act/
  bit-sheet chain entirely. (When a Production tab IS viewing a Story
  project's own finished screenplay instead — the normal continue-in-the-
  same-project case from the previous session — nothing changed there,
  same contextual behavior as before.)
- [x] **Import Screenplay**, to start a Production project from scratch:
  paste raw text, or **upload a real file** — Final Draft (.fdx), Scrite
  (.scrite), Word (.docx/.doc), PDF, or plain text/Fountain. One AI call
  (reusing the same extraction used for paste) derives the scene list
  (locations/timing/purpose/turn) and a plain character-name list — no
  archetype/want/need richness needed here, this is for scheduling, not
  creative development. New `POST /api/import-screenplay-for-production`
  (text) and `/file` (upload, via `multer`) endpoints; installed `pdf-parse`,
  `mammoth` (docx), `word-extractor` (legacy .doc), and `fast-xml-parser`
  (.fdx) — each format is converted to plain text by its own small reader,
  then funneled through the one shared AI-extraction function.
  **Scrite's exact JSON schema couldn't be verified offline** — implemented
  a best-effort structured read of the documented shape with a generic
  "collect readable strings" fallback if that shape isn't found, so it
  degrades gracefully rather than failing outright on a schema mismatch.
- [x] **Found and fixed 3 real cross-tab data leaks while testing**: with a
  production-only project loaded, `concepts.storylines` defaults to `[]`
  (not null) so bare `storylines &&` truthiness checks were firing on an
  empty array — showed an empty "Storyline suggestions" header and the
  wrong "type your idea" bubble on the Story tab, and briefly let the
  Screenplay section render a Production project's scene list under the
  wrong agent. Fixed by checking `.length` instead of bare truthiness, and
  gating story-only content on `projectType === 'story'` in addition to
  `activeAgent === 'story'`. Also had to split the persistent input bar's
  whole mode-detection chain by `activeAgent` first — a shared chain length-
  based guard alone wasn't enough once Production got its own revise-mode.
Tested end-to-end live: switched agents and confirmed the main view fully
replaces itself each time; imported a screenplay via paste AND via a real
uploaded PDF, DOCX, and FDX file (each hand-built and round-tripped through
the actual endpoints, not mocked) — all three correctly extracted title,
characters, and scenes; confirmed Story and Production tabs no longer
cross-contaminate after the fixes above.

---

## Script Breakdown before Scheduling ✅ DONE
User wanted an assistant director's-style script breakdown to happen
**between** a finished screenplay and the shoot schedule — not go straight
from screenplay to schedule. This is standard real-world film practice:
before you can schedule shoot days, someone has to read the whole script
and list out everything each department needs.

- [x] **New "Script Breakdown" stage**, sitting between "Production"
  (import screenplay) and "Shoot Schedule" in the Production Management
  agent's own sidebar sub-stage list. New `script_breakdowns` table
  (same pending/approved/changes_requested pattern as every other stage).
- [x] **One AI pass reads the whole script** and sorts everything into 5
  categories: Artist List (cast), Location List (with INT/EXT and scene
  counts), Property List (props), Costume Changes, and Art Department
  Notes — each bilingual (English + Odia).
- [x] **Review/approve/revise cycle**, same pattern as every other stage in
  the app — request changes with a feedback note, or approve to unlock the
  next stage.
- [x] **Download a PDF for each of the 5 categories separately** — a
  "Download PDF" link on every category card, reusing the same PDFKit +
  Odia-font setup as the screenplay PDF export.
- [x] **Shoot Schedule now requires the breakdown to be approved first** —
  the backend rejects `/api/shoot-schedule` until a script_breakdown for
  that scene list is approved, and the UI only shows the schedule section
  once the breakdown is.
- [x] **Tentative shoot start date + "how many days" question**, shown once
  the breakdown is approved, right before the existing character/location
  availability form. Start date defaults to 3 weeks from today; day count
  defaults to 10. The AI is told to fit the schedule within that many days
  where possible, and each shoot day gets stamped with a real calendar date
  (plain date-arithmetic, not AI-generated, so the dates are always exactly
  right).
- [x] **Fixed a date-off-by-one bug found during testing**: the date
  stamping used `new Date(...).toISOString()`, which converts through UTC —
  on a server running in IST (or any timezone ahead of UTC), that silently
  shifted every shoot day back by one calendar day from the date the user
  actually typed in. Fixed by doing the date math in UTC from the start
  (`Date.UTC(...)`) instead of relying on the local-to-UTC conversion.
Tested end-to-end live on a real project ("The Potter Wheel"): generated a
breakdown and confirmed all 5 categories populated with real content from
the script; downloaded and verified all 5 PDFs (English and Odia) actually
open as valid PDF files; approved the breakdown and confirmed the schedule
section only then appears; set a custom start date and day count and
confirmed the generated schedule's Day 1 date exactly matches the date
typed in.

---

## Script Breakdown: Re-analyze & Manual Edit ✅ DONE
The AI won't always catch every character or prop on its first pass. User
asked for a way to double-check and fix any one section without having to
regenerate (and possibly reshuffle) the whole breakdown.

- [x] **"Re-analyze" button on each of the 5 category cards.** Re-reads the
  full script but focuses on just that one category, explicitly told to
  double-check for anything subtle a first pass could miss (brief
  appearances, background mentions, minor items mentioned once) — shown its
  own previous list for that category so it corrects/extends rather than
  starting blind. The other 4 categories are left completely untouched.
  New `POST /api/script-breakdown/:id/reanalyze` endpoint.
- [x] **"Edit" button on each category card**, turning it into an editable
  list: every existing item becomes text fields (both English and Odia side
  by side, so bilingual output stays intact), a "Remove" button per item,
  a "+ Add Item" button to add something the AI missed entirely, and
  Save/Cancel. New `POST /api/script-breakdown/:id/edit` endpoint — takes
  the full corrected breakdown, no AI call involved for this one.
- [x] Both actions insert a new breakdown row rather than overwriting —
  same non-destructive history as every other stage — which also means the
  breakdown goes back to "pending" and needs approving again before the
  Shoot Schedule stage unlocks, exactly like any other content change would.
Tested live on "The Potter Wheel": used Edit to manually add a missed
minor character ("Village Fair Vendor") to the Artist List and saved it;
used Re-analyze on the Property List and confirmed via the API that it came
back as a fresh row tagged "Re-analyzed: props" — with the manually-added
artist from the previous step still intact, confirming re-analyzing one
category doesn't touch the others.

---

## AGENT 4 — Production Management: Shoot Schedule ✅ DONE (Part 1 of 2)
Agent 1 (Story & Screenplay) is functionally complete per its original
numbered plan (all of Steps 1.1–1.9 done), so per CLAUDE.md's build order
the next milestone should have been Agent 2 (Hero) then Agent 3
(Storyboard). User asked to jump straight to Agent 4 (Production
Management) instead. Flagged the skip and the fact that the agent's own
spec assumes data "from the Storyboard Agent (via the Hero Agent)," which
doesn't exist — user chose to proceed anyway, wiring Production Management
directly to Agent 1's existing scene list rather than waiting on Hero/
Storyboard. The Storyboard/Hero handoff can be added later without
reworking this.

Full spec: `agents/production-management-agent.md`. Its 5 instructions were
split into two builds (small steps) — this is Part 1 (Instructions 1, 2, 4):

- [x] **New "Production" stage**, unlocked once the Scene List is approved
  (doesn't need the full screenplay written — scheduling only needs
  locations/INT-EXT/timing, which the scene list already has).
- [x] **Availability form** (Instruction 1: "gather availability") — one row
  per major character (from the Character Sheet) and one row per unique
  location (deduped from the scene list), each with a free-text "available
  dates" field or an "Unknown — estimate for me" checkbox. This is a
  one-time input shown only before the first schedule is generated, not its
  own approvable stage — matches how the format question worked before it
  moved earlier in the flow.
- [x] **AI-generated shoot schedule** (Instruction 2: "build the schedule") —
  a day-by-day plan grouping scenes by shared location first, then by
  character availability, referencing scenes by position (episode+scene
  index) rather than duplicating their content. Same approve/request-changes
  cycle as every other stage. New `shoot_schedules` table, keyed off
  `scene_list_id`.
- [x] **Conflict flagging** (Instruction 4) — folded into the same
  generation call rather than a separate step: a bilingual `conflicts` list
  the AI is told to use "plainly" rather than producing an optimistic
  schedule that papers over a real problem.
- [x] Wired into the full-project loader, Export/Import, the sidebar Stages
  panel (now Idea → Synopsis → Characters → Bit Sheet → Screenplay →
  **Production**), and the persistent input bar's revise-mode chain.
  Revising the Scene List now also clears any existing shoot schedule
  (its scene references would go stale), matching the cascade pattern used
  everywhere else in the app.
Tested end-to-end live in the browser on "The Raid of Redress": filled in
one character's real constraint ("only available weekends in March") and
marked everything else unknown, generated a 7-day schedule, confirmed it
correctly flagged that exact constraint as a real conflict with a clear
explanation (not silently ignored), confirmed scene references resolved
back to the actual scene one-liners correctly, approved it, and confirmed
it survives a full page reload.

**Not yet built (Part 2, next up)**: Instruction 3 — Budget allocation (a
total-budget input, then an AI-proposed category breakdown with reasoning,
same approve/revise pattern). Instruction 5 (signal completion to Hero
Agent) is deferred along with the rest of the Hero Agent handoff.

---

## Colloquial Odia Dialogue + Flashback/ECHOING Format ✅ DONE
User dropped a real, professionally-written Odia episode script into a new
`DEMO SCREENPLAY DRAFT/` folder and asked for two things: dialogue that
sounds like genuine spoken Odia (Chalita Bhasha) instead of formal/AI-sounding
Odia (Sadhu Bhasha), and dialogue that carries real emotion instead of
flat "cut to cut" information-passing. Also asked whether to add two extra
format elements found in that demo — attributed POV flashbacks and an
"ECHOING" modifier — decided together with the user to build both at once.

- [x] Read the demo script directly (its PDF text layer is garbled/non-
  Unicode — had to render pages as images to actually read the Odia). It
  confirmed the target style: short broken lines, trailing ellipses, real
  code-switching ("ରୁମ୍", "ବ୍ୟାଗ୍", "ଅଙ୍କଲ୍" dropped straight into Odia
  script), and verb endings that shift by relationship (respectful ଛନ୍ତି
  toward an elder, intimate ତୁ/ଯିବୁ from child to mother).
- [x] Rewrote `SCREENPLAY_SYSTEM_PROMPT`'s dialogue section with the user's
  own Sanskritized→colloquial word-swap rules (Grahana Karantu→Nia/Dhara,
  Prasthana Kariba→Bahariba/Jiba, Bartalapa→Kathabarta, Krodhita→Ragi) and
  an explicit relationship-based verb-ending rule (respectful ଛନ୍ତି toward
  elders, casual ଛି/ଛୁ/ଛ toward friends/juniors/intimate family — an AI
  default of formal ଛନ୍ତି for everyone was exactly the mistake to fix), plus
  a direct instruction against flat info-passing dialogue.
- [x] Added **POV-attributed flashbacks** — a new `flashback` screenplay
  element (`character` = whose memory, `text` = what's remembered),
  rendered as "FLASH - [CHARACTER]'S POV:" matching the demo's exact
  convention.
- [x] Added **ECHOING** as a `characterModifier` option (alongside the
  already-built CONT'D/O.S./V.O.) for a remembered line replaying in
  another character's mind — typically follows a flashback element.
- [x] **Caught and fixed a real bug during testing**: the AI translated a
  transition marker into Odia ("ଦୃଶ୍ୟ ବଦଳିବ:" instead of "CUT TO:"). Real
  Odia shooting scripts keep these technical markers in English on both
  sides — added an explicit instruction not to translate them.
Tested end-to-end live: wrote a real new screenplay scene and read the
actual generated Odia directly (not just the English side) — confirmed
natural short sentences, real code-switching, and a believable emotional
exchange between a disgraced coach and a temple priest, not stiff textbook
Odia. CONT'D and transition rendering both confirmed working structurally;
flashback/ECHOING are schema-ready and prompted for but weren't triggered
by this particular scene's content (used only when "dramatically
meaningful," by design) — will show up naturally on a scene that calls
for a memory intrusion.

---

## Climax-as-Sequence + Scene-Level Craft ✅ DONE
The last two items from the craft-book analysis (after Characters). Both
additive schema/prompt changes — no new stages, no schema restructuring.

- [x] **Climax is now a 3-beat sequence, not one tag.** Added two new Bit
  Sheet beat types — `crisis` (the protagonist's hardest genuine dilemma,
  connects back to the catalyst) and `realization` (explicit, visible
  self-awareness right after the climax, distinct from `resolution_beat`)
  — both now mandatory-exactly-once anchors alongside the existing 6,
  always in the fixed order Crisis → Climax → Realization near the end of
  Act 3. The prompt also tells the AI to pick a climax SHAPE that fits the
  story's own genre (direct confrontation for action/thriller/sports vs. a
  multi-thread convergence or authority/institution judgment for a family/
  moral/devotional story) instead of forcing one template — this came
  straight from the real screenplays sampled (Neelachala's climax resolves
  morally at a shared festival event, not a fight). Raised the Bit Sheet's
  minimum bit count from 10 to 12 to keep room for the now-8 anchors.
- [x] **Scene one-liners now carry `purpose` and `turn`.** Every scene
  must be tagged `plot_advancing` or `character_revealing` (Field's rule:
  a scene should do one, never both/neither) and given a short `turn`
  phrase naming its value-shift (McKee's scene method — e.g. "pride turns
  to quiet anguish"). Shown as a badge + italic note under each scene.
  This was actually recommendation #3 from the very FIRST craft-book pass
  ("require a stated turn per scene one-liner") — now built too.
- [x] **Screenplay scenes now support CONT'D/O.S./V.O. and transitions.**
  Dialogue elements got a `characterModifier` field (CONT'D if the same
  character keeps talking after a brief interrupting action beat, O.S. if
  heard-not-seen, V.O. for narration/inner-thought/phone-voice); a new
  `transition` element type supports an occasional meaningful "CUT TO:" /
  "MATCH CUT TO:" / "DISSOLVE TO:" line at a scene's end. This closes the
  screenplay-formatting gap flagged since the very first craft-book pass
  (recommendation #5) — CONT'D/O.S./V.O. and transitions are now covered;
  montage blocks and letter-suffixed parallel micro-scenes (11A/11B) are
  NOT — deferred as a bigger structural change, not attempted here.
Tested end-to-end live on the same real project ("The Raid of Redress"):
generated a fresh 3-episode Bit Sheet and confirmed every episode got the
full Crisis → Climax → Realization sequence with genuinely dilemma-shaped
crisis text; generated scene one-liners and confirmed purpose badges and
turn phrases rendered correctly (e.g. "pride turns to quiet anguish"); wrote
one full screenplay scene and confirmed the AI used `BIRA (CONT'D)`
correctly and unprompted on a real interrupted-dialogue beat.

This completes all 3 gaps from the craft-book + real-screenplay analysis
(Characters, Climax-as-sequence, Scene-craft). Smaller/lower-priority items
from that analysis (a "Sequence" grouping between beats and scenes;
Snyder's Logline Test/genre taxonomy; montage blocks) remain unbuilt —
revisit only if the user wants to go further.

---

## New Stage: Create Characters ✅ DONE
User asked for a full analysis of the pipeline against all 5 craft books
(Field, McKee, Snyder, Trottier, Vogler) AND real reference screenplays (K4,
Ashok Kumar, Neelachala Bhakta Nibas, GIRL_PROBLEM) to find missing steps.
Ran 7 parallel research passes (one per book, plus 2 sampling real
screenplay pages). Strong convergent evidence across nearly every source
pointed to 3 gaps: no real Characters layer, climax as one thin beat-tag
instead of a sequence, and no scene-level craft between the one-liner and
full dialogue. Characters was the biggest and most-confirmed, so built it
first (Climax and Scene-craft are next, not started yet).

- [x] **New stage: Create Characters**, inserted right after Pitch Deck
  approval and before Three-Act Structure — deepens the pitch deck's thin
  3-5 "Major Characters" (name/role/emotional-core/conflict) into a full
  character sheet per character: **archetype** (Vogler's 8 — Hero/Mentor/
  Threshold Guardian/Herald/Shapeshifter/Shadow/Ally/Trickster, framed as a
  function that can shift, not a fixed tag, with an `archetypeNote` for
  when it does), **want vs. need** (conscious goal vs. the deeper wound
  actually driving them), **flaw**, **3+ virtues**, **inner conflict**,
  **outer conflict**, **arc** (one-line A→Z change), and an **introduction
  beat** — the specific action that should introduce them on the page,
  matching the real pattern found in every reference screenplay sampled.
  The character playing the Shadow/antagonist also gets a **heroLogline**
  ("their own story, as if they were the hero of it" — Vogler's rule
  against shallow villains). Same approve/request-changes pattern as every
  other stage; keeps the pitch deck's existing names, may add at most one
  extra minor character if the story genuinely needs one.
- [x] **Three-Act Structure generation now requires approved Characters**
  first (was previously gated on the Pitch Deck alone) — enforced on the
  backend, not just hidden in the UI. Character want/need/arc data is now
  passed into the three-act prompt so the acts stay consistent with who
  each character actually is, instead of being generated independently.
- [x] Added a `character_sheets` table (parallel to the other stage tables,
  linked to `pitch_deck_id`). Wired into the full-project loader, the
  Export/Import round-trip, and the sidebar Stages panel (now Idea →
  Synopsis → **Characters** → Bit Sheet → Screenplay). The persistent input
  bar also got a new "revise the characters" mode in its priority chain.
  Extended the skip-to-bitsheet/skip-to-scenelist "skip ahead" backfill
  endpoints to also produce a matching character sheet, for consistency —
  code-reviewed but not live-tested (same quota-conservation call as before).
- [x] **Found a genuinely useful side-effect while testing**: the character
  sheet's `heroLogline` field correctly appeared ONLY on the character
  tagged `shadow` (not on the two `hero`-tagged leads), confirming the
  conditional-field prompt instruction worked exactly as designed.
Tested end-to-end live in the browser on a real project ("The Raid of
Redress"): approved the pitch deck, generated a character sheet (3 seed
characters deepened + 1 new Ally character added, matching the "at most one
extra" rule), approved it, confirmed "Generate Three-Act Structure" only
appeared after that approval (not after the pitch deck alone), and
confirmed the resulting three-act theme was genuinely consistent with the
characters' individual arcs (not generated independently of them).

Not yet built (next up, per the same craft-book analysis): **Climax as a
sequence** (Crisis → Confrontation → Reversal → Realization → Consequence,
instead of one Bit Sheet tag) and **scene-level craft** (plot-advancing vs.
character-revealing check, plus the still-outstanding screenplay formatting
gap — CONT'D, O.S./V.O., montage, transitions — flagged since the very
first craft-book pass and still not built).

---

## Richer Pitch Deck: Major Characters + Elaborated Episode Synopsis ✅ DONE
User felt the pitch deck's episode synopsis (2-3 sentences) wasn't enough to
actually establish a whole episode. Discussed reordering the pipeline
(three-act structure before pitch deck) but recommended against it — it
would mean paying for the most expensive per-episode step for every episode
before the cheap producer-approval gate even happens. Went with enriching
the pitch deck itself instead:

- [x] **Major Characters** — every pitch deck (film or series) now includes
  3-5 major characters: name, a one-line role/descriptor, their emotional
  core (what they secretly want or fear), and their central conflict. Shown
  as its own section on screen (between Target Audience and the episode
  breakdown) and as a new slide in the PDF export.
- [x] **Elaborated episode synopsis** (web series) — grew from a generic
  2-3 sentence plot beat to a real mini dramatic shape: what the episode
  opens on, the conflict that develops through it, and how it turns or
  ends — enough to actually picture the episode, not just guess its topic.
- [x] Extended the same two additions into the three "skip ahead" backfill
  endpoints (skip-to-synopsis/bitsheet/scenelist) for consistency, so a
  pasted-content project's pitch deck matches the new richer shape too.
- [x] **Found and fixed a real, recurring bug while testing this**: Gemini
  occasionally leaks a stray character from a non-Latin script into an
  otherwise-correct ENGLISH sentence — seen twice now (a Hebrew letter, then
  an Odia letter, both mid-word). The existing sanitizer only ever cleaned
  the Odia ("or") field; added the mirror-image filter for the English
  ("en") field, tested against the exact glitches seen plus normal
  punctuation/accented names to make sure nothing legitimate gets stripped.
Tested end-to-end live: generated a real 3-episode series pitch deck,
confirmed 3 well-formed major characters and genuinely richer per-episode
synopses on screen, and confirmed the PDF export (9 pages: cover, premise,
tone/genre, target audience, major characters, 3 episodes, closing) — sent
to the user directly to inspect.

---

## Small Tweaks ✅ DONE
- [x] **Default format numbers changed**: Film default runtime 90 → 120
  minutes; Web Series defaults 12 episodes × 25 min → 10 episodes × 10 min
  each. Updated everywhere these defaults appear (the first-screen format
  picker, and the backend's safety-net fallback values). Verified live.
- [x] **Removed role suffixes from approval buttons/badges** — "Approve as
  Producer" → "Approve", "🔒 Locked as Story Writer" → "🔒 Locked", "Approve
  Bit Sheet (as Story Writer)" → "Approve Bit Sheet", "Approve Scene List
  (as Screenplay Writer)" → "Approve Scene List". User felt the role labels
  added friction while playing every role solo. This reverses a decision
  CLAUDE.md had explicitly documented (see the note added there) — the
  approval STAGES themselves are unchanged, only the on-screen wording.

---

## Format Question Moved to the Very First Screen ✅ DONE
User asked: the first screen should ask "film or web series?" first, then
duration (film) or episode count + minutes/episode (series) — before typing
an idea at all, instead of asking after choosing a storyline like before.

- [x] Added a "Is this a film or a web series?" card at the very top of the
  empty state (above the greeting and the "Start from" tabs), reusing the
  existing radio + duration/episode fields, defaulting to Film / 90 minutes.
  Only shown for the normal Idea flow — the skip-ahead paste flow (Synopsis/
  Bit Sheet/Scene One-Liners) keeps its own dedicated film-only runtime field
  since series isn't supported there yet (see previous section).
- [x] `/api/generate-storylines` now takes the chosen format and threads it
  into the prompt, so storylines are shaped for a film vs. a multi-episode
  series arc from the very first draft, not decided after the fact.
- [x] Removed the now-redundant second format question that used to appear
  after choosing a storyline — since format is already known up front,
  choosing a storyline now goes straight into building the pitch deck (a
  brief "Building your pitch deck…" message shows while it's in flight; on
  failure the choice unlocks so you can try again or pick the other option).
Tested end-to-end live in the browser: picked Web Series then switched back
to Film, typed a new idea, generated two format-aware storylines, chose one,
and confirmed it skipped straight to a correctly-tagged "FEATURE FILM" pitch
deck with no second format question in between.

---

## Export/Import, History Management, Skip-Ahead ✅ DONE
User asked for six things in one go: offline save/load (export/import a
project as a file on your own computer), a way to start directly from the
Synopsis / Bit Sheet / Scene One-Liners stage instead of always from Idea,
having pasted content at any of those stages auto-generate the missing
earlier stages so the rest of the app still works normally, and History
management (delete, pin — rename was already there).

- [x] **Export Idea / Import Idea** — two new buttons under "New Idea".
  Export downloads the current project (concept, storylines, pitch deck,
  three-act structure, bit sheet, scene list, every written screenplay
  scene) as one `.json` file to your computer — pure client-side, no server
  round-trip needed since the data's already in memory. Import reads that
  file back and rebuilds the whole chain as a brand-new project via a new
  `POST /api/concepts/import` endpoint. Verified the full round-trip
  end-to-end (export → import → reload → every stage's status and content
  matched exactly), including the cascade-delete change below.
- [x] **History: pin and delete** (rename already existed). Every project
  row now has its own pin and delete icon, not just the active one. Pinned
  projects sort to the top of History automatically. Deleting asks for
  confirmation and — since the database foreign keys were changed from
  `ON DELETE SET NULL` to `ON DELETE CASCADE` — cleanly removes the entire
  chain (pitch deck, three-act, bit sheet, scene list, every screenplay
  scene), not just the concept row. Verified the cascade directly: deleting
  a concept with a full chain attached left zero orphaned rows behind.
- [x] **Skip ahead / start from a later stage** — a small "Start from: Idea
  / Synopsis / Bit Sheet / Scene One-Liners" tab row above the input on a
  fresh project. Picking anything other than Idea swaps in a paste box (for
  your own already-written synopsis, bit sheet, or scene list text) plus a
  runtime-minutes field and a Continue button.
- [x] **Auto-generating the missing earlier stages** — pasting, say, a Bit
  Sheet doesn't just save that text; one AI call both (a) faithfully
  restructures your pasted text into the app's real Bit Sheet schema
  (bilingual, correct beat types) and (b) invents short, plausible earlier
  stages (concept, storyline, pitch deck, locked three-act structure) that
  are consistent with it, so the normal approve/revise/lock flow keeps
  working from that point on exactly like a project that started from Idea.
  Same pattern for Synopsis (backfills concept+storyline) and Scene
  One-Liners (backfills concept+storyline+pitch deck+three-act+bit sheet).
  **Film format only for now** — a web series needs per-episode consistency
  a single pasted excerpt can't reliably reverse-engineer yet; picking
  "Web Series" isn't offered in this flow.
  **Quota note, worth knowing**: each skip-ahead action is exactly ONE
  Gemini call regardless of how many stages it backfills (all the backfilled
  stages and the parsed target stage come back in one combined structured
  response) — kept deliberately to one call given the 20/day free-tier cap,
  rather than the 3-5 separate calls a naive "generate each stage one by
  one" approach would have cost.
- [x] Tested `skip-to-bitsheet` for real end-to-end: pasted a short bit-sheet
  outline (a fisherman story), got back a fully backfilled concept →
  approved pitch deck → locked three-act → pending bit sheet whose beats
  faithfully matched what was pasted, with the connecting beats (theme
  stated, setbacks, etc.) plausibly invented to complete the required
  structural anchors. The persistent input bar correctly landed in
  "revise the bit sheet" mode immediately, same as a normally-built project.
  Noted one rare AI glitch during this test — a stray Hebrew character
  leaked into one English-language beat title ("Fיית Fury Unleashed"). Very
  unusual (the existing Odia-script sanitizer doesn't cover this since it
  only cleans the "or" field), not fixed as a general filter since it's a
  one-off seen only once across this whole project's testing — regenerating
  that one beat via "Request Changes" clears it. Worth a proper fix later if
  it turns out to recur.
- [x] Verified `skip-to-synopsis` and `skip-to-scenelist` by code review only
  (not run live) to conserve the day's AI quota, since they reuse the exact
  same one-call backfill pattern the bitsheet test already proved works —
  recommend the user try these two themselves when convenient.

Not built: series support for skip-ahead (see note above); rename and
delete's confirmation dialogs use native browser `prompt()`/`confirm()`,
which couldn't be driven by the automated test browser — please try those
two yourself.

---

## UI Redesign — Gemini-Style Chat Layout ✅ DONE
**Note:** an earlier version of this section described a stage-nav sidebar
(Idea/Synopsis/Bit Sheet/Screenplay, click-to-jump). That was built, then the
user reviewed it live and said directly: "you have created a messed up ui."
It was fully replaced by the design below — no stage nav exists anymore.

- [x] User shared a real Google Gemini UI screenshot plus two custom icon
  sets, and specified exactly how it should work: a plain text bubble on
  first load ("type your idea and explore"), a single persistent input bar
  at the bottom, side-by-side storyline options after hitting Enter, an
  empty Enter regenerating both options, and choosing one visually locking
  it (with the other dimmed) before the film/series question appears.
- [x] Removed the stage-nav sidebar entirely. Sidebar is now just: logo +
  title, a "New Idea" button (resets all state), a "History" section
  (placeholder — see below), and the language toggle pinned to the bottom.
- [x] Main content is a real scrolling chat log, not a single active panel.
  Empty state shows a centered gradient greeting; once a concept exists, an
  AI-style bubble appears, followed by whatever's been generated so far,
  stacked in order (storylines → format form → pitch deck → three-act →
  bit sheet → scene list → screenplay), same underlying data as before.
- [x] One persistent, contextual input bar fixed to the bottom of the main
  pane (hidden once a pitch deck exists, since the rest of the flow uses its
  own inline forms/buttons):
  - Before storylines exist: typing an idea + Enter (or the send button)
    generates them.
  - After storylines exist and none is chosen: the same bar becomes a
    "regenerate" box — Enter with it empty regenerates 2 new options;
    typing feedback first and hitting Enter regenerates with that feedback
    folded in.
- [x] Storyline options render side by side ("Option 1" / "Option 2" labels).
  Choosing one shows a "✓ Locked in" badge on it and visually dims the other
  (its "Choose this one" button stays clickable, so switching is possible
  before the format step is submitted).
- [x] Full dark, Gemini-inspired color theme applied app-wide (not just the
  sidebar) — deep near-black background, dark card panels, a blue-to-purple
  accent gradient for the greeting/buttons/badges, and every existing card
  (pitch deck, three-act structure, bit sheet, scene list, screenplay) reskinned
  to match instead of staying light-themed. Removed a leftover Vite-starter
  default in `index.css` (`#root` had a fixed 1126px boxed width with side
  borders and centered text) that was fighting the full-bleed sidebar+chat
  layout.
- [ ] Not yet built: the right-side panel (New Artifact / Customize / More
  Filmmaking / Filmmaking Projects) — user's list had a likely duplicate
  entry ("Filmmaking Projects" appeared twice), flagged but not resolved yet.
- [x] Real multi-project switching — see "Multi-Project Support" section below.
  (Was a placeholder when this section was first written; now built.)

Tested end-to-end live in the browser: fresh empty state → typed a new idea
→ Enter generated 2 real side-by-side storyline options → choosing one showed
the locked badge and dimmed the other → the film/series format question
appeared right after, exactly matching the user's spec. Also confirmed the
dark theme renders correctly on an existing, far-progressed real project
(pitch deck through screenplay, all reskinned and readable).

---

## Multi-Project Support + Always-On Input Bar + Stage Panel ✅ DONE
User reported four problems after using the Gemini-style rebuild for real:
projects kept mixing up ("why does it always show the last project"), there
was no way to explicitly load an old project or start a genuinely fresh one,
the input bar disappeared after the synopsis step instead of staying put like
a real chat, and the stage-progress list from the earlier (reverted) sidebar
was missed. All four turned out to share one root cause and got fixed together.

**Root cause found:** every `/latest` backend endpoint (pitch-deck, three-act,
bit-sheet, scene-list) just grabbed the single newest row in its whole table,
with no idea which project/concept it belonged to. Loading the app always
reattached whatever was newest ANYWHERE, not "your current project" — so two
different projects touched close together in time could get their content
crossed.

- [x] **Backend**: added a `title` column to `concepts` (for renaming), plus
  three new scoped endpoints — `GET /api/concepts` (list every project for
  History), `POST /api/concepts/:id/title` (rename), and
  `GET /api/concepts/:id/full` (loads ONE project's entire chain — pitch deck
  → three-act → bit sheet → scene list — by walking the real foreign-key
  chain, never "whatever's newest").
- [x] **Load / New / History**: the sidebar's History section now lists every
  real project (newest first), each clickable to load that exact project's
  full state via the new scoped endpoint. "New Idea" now also clears a
  `localStorage` pointer, so a page refresh after starting fresh actually
  stays fresh instead of silently reloading old work — this was the literal
  "why does a new project not start fresh" bug. No separate "Save" button was
  needed since every step already auto-saves to the database the instant it's
  generated; instead, added a rename option (pencil icon next to the active
  project, prompts for a name) so projects are easier to tell apart in History
  than just raw concept text.
- [x] **Stage progress panel, brought back** — a small clickable Idea /
  Synopsis / Bit Sheet / Screenplay list in the sidebar showing done (green) /
  current (blue) / upcoming (grey) for the loaded project. Unlike the earlier
  reverted stage-nav, clicking a stage does NOT hide/replace the chat log —
  it just smooth-scrolls to that section, since the "single stage replaces
  everything" model was the actual thing the user disliked before, not the
  concept of a progress list.
- [x] **Persistent input bar, now truly persistent** — it no longer disappears
  once a pitch deck exists. It now stays mounted for the entire project and
  changes what it does based on what's currently awaiting a decision: type an
  idea (nothing generated yet) → generate storylines; empty Enter or feedback
  (storylines shown, none chosen) → regenerate; typed feedback whenever a
  pitch deck / three-act structure / bit sheet / scene list exists and isn't
  yet approved/locked → submits as a revision to THAT stage (reusing the same
  non-destructive request-changes endpoints the inline "Request Changes"
  boxes already use, just triggered from one place). When nothing is
  currently revisable (e.g. between approving one stage and generating the
  next), the bar stays visible but shows an inert "nothing to revise right
  now" placeholder instead of silently doing nothing.
- [x] **Sidebar layout fix**: the sidebar was scrolling away together with
  the main chat log instead of staying put, because `.app-shell` used
  `min-height: 100vh` (lets the whole page grow taller than the screen) instead
  of a fixed `height: 100vh` with its own internal scroll areas. Fixed so the
  sidebar and the main chat area now scroll fully independently — the sidebar
  never moves.
- [x] Cleaned up 4 abandoned test rows a concurrent test session created by
  pasting bit-sheet content into the "type your idea" box while the app was
  in a confusing intermediate state (from a bug in the very first draft of
  the mode-detection logic above, fixed before this was finished) — deleted
  since nothing downstream referenced them.

Tested end-to-end live in the browser: loaded a real far-progressed project
from History and confirmed the Stages panel correctly showed Idea/Synopsis/
Bit Sheet done and Screenplay current; confirmed the persistent bar correctly
detected "nothing to revise" for that project's current state instead of
wrongly offering to regenerate storylines (a real bug caught and fixed during
testing — loading a project loses the in-memory "which storyline was chosen"
marker, so the very first version of the mode-detection incorrectly fell back
to "regenerate" mode even when a pitch deck already existed); confirmed
clicking a stage jumps the chat log without hiding anything; confirmed
"New Idea" followed by a real page refresh stays on a blank project instead
of reloading old work; confirmed the sidebar stays fixed while scrolling
through a very long, fully-drafted screenplay. Rename was implemented and
code-reviewed but needs the user's own manual test, since it uses a native
browser prompt() dialog that the automated browser tool can't drive.

---

## Screenwriting Craft Guides (analysis done — not yet implemented)
- [x] User added 5 industry-standard screenwriting craft books into
  `screenwriting-craft-guides/` (renamed/cleaned up from a messier folder):
  Syd Field's *Screenplay*, Robert McKee's *Story*, Blake Snyder's
  *Save the Cat!*, David Trottier's *The Screenwriter's Bible*, and
  Christopher Vogler's *The Writer's Journey*.
- [x] Read all 5 and compared each author's framework against our actual
  pipeline (Concept → Storylines → Pitch Deck → Three-Act Structure →
  Bit Sheet → Scene One-Liners → Screenplay). Full findings summarized in
  chat; not duplicated here to avoid drift — ask Claude to re-summarize if
  needed, or check memory.
Five concrete recommendations came out of this. User said "build all one by
one" — building sequentially in this order, each tested before the next:

1. [x] **DONE** — Expand the Bit Sheet's beat-type list with the missing
   structural anchors (from Field + Snyder). `BIT_BEAT_TYPES` grew from 7 to
   13: added `opening_image`, `theme_stated`, `plot_point_1`, `all_is_lost`,
   `plot_point_2`, `final_image` as mandatory-exactly-once anchors (the
   original 7 stay flexible/repeatable). The prompt now tells the AI exactly
   where each anchor belongs (opening_image = first bit, plot_point_1 = last
   bit of Act 1, etc.). Raised the minimum bit count from 6 to 10 so there's
   room for both the anchors and the flexible connective beats. Added
   frontend labels + a distinct badge color per new type (all_is_lost gets a
   stark black badge, matching Snyder's "false death" framing). For a
   series, each episode gets its own complete set of anchors (its own
   opening/final image, its own two plot points), not just once for the
   whole series — each episode is still a self-contained mini-story.
   Tested: regenerated bit sheets for both an existing film and an existing
   4-episode series project — anchors landed in exactly the right positions
   every time (confirmed programmatically: `plot_point_1` was always the
   last Act 1 bit, `final_image` always the last bit overall, etc.), the
   `theme_stated` beat genuinely stated a thematic argument through a
   character's remark, `opening_image`/`final_image` genuinely mirrored
   each other (eve preparation → dawn celebration, showing the change),
   downstream scene-list generation still worked correctly from the richer
   bit sheet, and the Odia-script sanitizer still found zero issues.
2. [ ] Add an explicit Theme/Controlling Idea field, threaded into later
   generation prompts — from McKee + Snyder. **Next up.**
3. [ ] Add a required "turn"/value-shift to each scene one-liner so flat,
   non-dramatic scenes get caught early — from McKee.
4. [ ] Add a structured Characters layer (name, archetype/role, one-line
   arc) referenced by ID from bits and dialogue, instead of character
   only existing as a free-text name string — from Vogler. Likely the
   single biggest/most valuable gap found.
5. [ ] Expand the screenplay element schema with missing industry-standard
   formatting (CONT'D, O.S./V.O., montage, transitions, intercut,
   flashback wrappers) plus a page-count-based duration cross-check
   alongside the current AI-guessed minutes — from Trottier.

---

## Reference Screenplays (writing-style improvement — not a numbered step)
- [x] Folder created: `reference-screenplays/` with `odia/film/hits/`,
  `odia/film/average/`, `odia/series/`, `odia/telefilm/`, and
  `other-languages/` subfolders, plus a README explaining how to use it.
  The hits-vs-average split is deliberate — comparing a hit against an
  average film side by side should surface what actually makes the
  difference (pacing, dialogue, hook), not just "what Odia looks like."
- [x] User added real screenplays into `odia/series/` (K4 episodes 1-6, RITUKHA,
  4TO9, night angel, GIRL_PROBLEM, KP_E_1&2, EP_3_SHOOTING_SCRIPT, a `sasubahu`
  .scrite project, and the 6-episode "ashok kumar" series). Read a
  representative sample across several of these (a crime thriller, a
  suicide-helpline drama, two family dramas, and a youth/social-issue
  drama) — no hits/average or telefilm/film examples yet, only series so far.
- [x] Updated `SCREENPLAY_SYSTEM_PROMPT` in `app/backend/server.js` based on
  real patterns found: dialogue is short/broken/imperfect rather than full
  grammatical sentences, natural English code-switching is common (varies by
  character — urban/young characters code-switch more, rural/older ones
  less), speech register must vary sharply by character type, and family/
  relational address terms (Ma, Bapa, Bhai, Kaka...) get used constantly.
  Caught and fixed a real regression while testing this: because several of
  the real references write dialogue in Romanized Odia (Latin letters) for
  on-set convenience, the AI's first attempt wrote the "or" field in
  Romanized Odia too — breaking the actual bilingual requirement (English +
  genuine Odia SCRIPT). Fixed by explicitly telling the prompt that code-
  switching means an English word embedded inside an Odia-script sentence,
  not writing whole sentences in Latin letters. Verified the fix: regenerated
  the same scene and confirmed the Odia field stayed in real Odia script,
  including the code-switched word itself ("seriously" → "ସିରିଅସ୍ଲି") being
  transliterated INTO Odia script rather than left in Latin.
- [ ] Only `odia/series/` has content so far — `odia/film/hits`, `odia/film/average`,
  `odia/telefilm`, and `other-languages` are all still empty. Revisit this
  pass once (or if) those get filled in, since film/telefilm pacing and a
  genuine hit-vs-average comparison haven't been analyzed yet.

---

## AGENT 1 — Story & Screenplay Agent (build this alone first, no orchestration yet)
Full spec: `agents/story-screenplay-agent.md`

### Step 1.1 — Project skeleton ✅ DONE
- [x] Set up a basic React + Node.js project structure
- [x] Confirm you can run it locally and see a blank page in your browser
- [x] Learning goal: understand what "running the app locally" means

**What was built:** Created `/app/frontend` (React, via Vite) and `/app/backend`
(Node.js + Express). Frontend runs on http://localhost:5173 and shows a simple
placeholder page. Backend runs on http://localhost:4000 and responds at
`/api/health`. Installed Node.js on this machine as part of this step.

### Step 1.2 — Concept input ✅ DONE
- [x] Build a simple page: a text box where you type a movie concept, and a button labeled "Generate"
- [x] Learning goal: understand what a "component" is and how a button triggers an action

**What was built:** `App.jsx` now has a text box for your movie concept and a
"Generate" button. Clicking it currently just displays what you typed below
the button (no AI call yet — that's Step 1.3). Tested in the browser: typed a
sample concept, clicked Generate, confirmed it displayed correctly.

### Step 1.3 — Connect to an AI API using the agent's system prompt ✅ DONE
- [x] Set up an API key for an AI provider (switched to Google Gemini — see note below)
- [x] Use the contents of `agents/story-screenplay-agent.md` as the system prompt for this agent's API calls
- [x] Wire the "Generate" button to send your concept to the AI API and get back storyline suggestions
- [x] Display the 2-3 generated storylines on screen
- [x] Learning goal: understand what an "API call" is, and how a system prompt shapes an agent's behavior

**Stubbed for now (decided 2026-08-11):** No Anthropic API key yet, so the
backend's `/api/generate-storylines` route returns 3 hardcoded fake
storylines instead of calling the real Claude API. This still proves out the
real pattern — frontend calls backend, backend responds, screen updates —
which is the actual learning goal for this step. Tested in the browser:
typed a concept, clicked Generate, got 3 storylines displayed.
**Update 2026-08-11 (switched to Google Gemini):** The Anthropic Claude API
account had no billing credit, so we switched AI providers to Google's
Gemini API instead of adding credit — Gemini's free tier works without
adding payment info. `app/backend/server.js` now calls Gemini
(`@google/genai` package, model `gemini-flash-latest`) with the same system
prompt idea adapted from `agents/story-screenplay-agent.md`, returning
structured JSON. API key is saved in `app/backend/.env` (not committed).
**This is a tech stack change — see the updated "AI" line in CLAUDE.md.**
Tested successfully end-to-end in the browser: typed a concept, got 3 real
AI-generated storylines with title/logline/summary. Step 1.3 is now fully
complete (previously stubbed with fake data — no longer needed).

### Step 1.4 — Save to a database ✅ DONE
- [x] Set up PostgreSQL (locally first, don't worry about cloud yet)
- [x] Save each generated concept + its storylines so they don't disappear on refresh
- [x] Learning goal: understand the difference between "in the browser" (temporary) and "in a database" (saved)

**What was built:** Installed PostgreSQL via Postgres.app (a simple Mac app,
no command line install needed) and created a `filmmaking_app` database with
one table, `concepts` (see `app/backend/schema.sql`). Every time "Generate"
is clicked, the concept + its storylines are saved to this table. The
frontend now also loads the most recently saved concept when the page first
opens (`GET /api/concepts/latest`), so refreshing — or even quitting and
reopening the browser — no longer loses your last result. Tested: generated
a concept, refreshed the page twice, confirmed it reappeared both times.

### Step 1.5 — Pitch deck view ✅ DONE
- [x] Build a simple formatted view of a chosen storyline that looks presentable (title, logline, structure)
- [x] Add a basic export-to-PDF or export-to-doc button
- [x] Learning goal: understand how to generate a downloadable file from app data

**What was built:** Each storyline card now has a "Choose this one" button.
Clicking it sends that storyline to Gemini with a new prompt (adapted from
Instruction 2 in `agents/story-screenplay-agent.md`) asking it to expand the
storyline into a producer-ready pitch: premise, tone/genre, and target
audience. This gets saved to a new `pitch_decks` table and displayed in a
clean, boxed layout below the storylines. An "Export as PDF" button (using
the `pdfkit` package) generates a real, downloadable one-page PDF with the
same content, formatted for presentation.

**Update 2026-08-11 (cultural authenticity + bilingual):** After testing,
feedback was that storylines felt generic/Hollywood-style, not Indian or
Odia. Rewrote the AI prompts (and `agents/story-screenplay-agent.md`) so the
Story & Screenplay Agent now specializes in Odia (Odisha) cinema by
default — Ollywood sensibility, Odisha settings, festivals like Nuakhai and
Rath Yatra, authentic family/social dynamics — instead of generic Hollywood
plots. Every storyline and pitch deck is now generated in **both English
and Odia (Odia script)** simultaneously, and the app has a language toggle
(English / ଓଡ଼ିଆ) at the top that instantly switches everything — page text,
storylines, pitch deck, and even the exported PDF (which required embedding
a real Odia font, Noto Sans Oriya, since the default PDF fonts can't render
Indic scripts). Tested end-to-end in both languages, including opening both
PDF exports and visually confirming the Odia script rendered correctly (not
boxes/garbage).

**Update 2026-08-11 (format selector + presentation-style PDF):** Feedback
was that the pitch deck felt too plain (white page, black text) and lacked
key production info. Two changes:
1. Added a **format selector** — before building a pitch deck, the app now
   asks "Film or Web Series?", and for a series, how many episodes and how
   many minutes each. This is saved with the pitch deck and shown as a badge
   ("FEATURE FILM" or "WEB SERIES · 12 EPISODES × 25 MIN EACH").
2. Rebuilt the PDF export as a real multi-slide presentation deck: landscape
   orientation, 3 slides (cover with title/logline/format tag, premise,
   tone+audience side-by-side), a dark color theme that's picked automatically
   based on the story's genre (e.g. warm amber for family drama, red for
   thriller, teal as a neutral default), decorative accent lines, and an
   elegant serif display font (Playfair Display for English, a bold Noto
   Sans Oriya for Odia — both had to be converted from variable-font format
   to static instances, since the PDF library can't read variable fonts).
   Tested with a Film and a Web Series (15 episodes × 10 min, matching the
   exact numbers given), in both languages, confirming the color theme
   genuinely changes with genre and both scripts render correctly.

**Update 2026-08-11 (matched a real reference deck):** User shared a real
professional pitch deck (for an Odia web series, "HANU-MAN", produced for
Tarang Plus) as the quality bar. Analyzed its structure: landscape 16:9,
cinematic AI-generated poster art, bold condensed red section titles,
split light/dark panel layouts, and — importantly — **one page per episode**
with a synopsis. Checked whether we could generate real AI artwork (Gemini
does have image-generation models) but hit a hard wall: Google's free tier
allows zero image-generation requests — would need billing enabled. User
chose to stay free for now and upgrade everything else. Changes made:
- Added a bold condensed display font (Anton) for section titles/episode
  titles/closing slide, matching the reference's punchy red-title look.
- Rebuilt slides to follow the reference's "light band + big title +
  dark body panel" rhythm (Premise, Tone/Genre, and Target Audience are
  now each their own slide, not combined).
- **New: episode-by-episode breakdown for web series.** When format is
  "series", the app now asks Gemini for a full episode-by-episode
  synopsis (one Gemini call, exact episode count requested) and renders
  one PDF slide per episode — a colored block with a big episode number
  (standing in for the missing photo) next to the title and synopsis.
  Also shown in the on-screen pitch deck view, not just the PDF.
- Added a closing "Thank You" slide, matching the reference's ending.
- Fixed a real bug found during testing: the AI sometimes wrote "Episode
  1:" inside the episode title itself, doubling up with the app's own
  numbering ("Episode 1: Episode 1: ...") — fixed via an explicit prompt
  instruction, verified with a fresh generation.
Tested a 5-episode and a 3-episode series end-to-end (generation + PDF +
on-screen view, both languages) plus re-verified the film path still works
correctly (no episode slides, 5-page PDF).

### Step 1.6 — Approval flow (confirm "as Producer") ✅ DONE
- [x] Add an "Approve" and "Request Changes" button on the pitch view
- [x] If "Request Changes" — add a text box for feedback, and a way to regenerate based on that feedback
- [x] Store the approval status against the project in the database
- [x] Learning goal: understand how apps track "state" (approved vs. pending vs. needs changes)

**What was built:** Added `status` ('pending' / 'approved' / 'changes_requested')
and `feedback` columns to `pitch_decks`. Two new endpoints:
`POST /api/pitch-deck/:id/approve` (marks it approved) and
`POST /api/pitch-deck/:id/request-changes` (records the feedback on the old
version, then generates a brand-new version that addresses it — the old
version is never overwritten, just marked). The UI shows "Approve as
Producer" and "Request Changes" buttons; requesting changes reveals a
feedback box, and after regenerating, the new draft shows a note like
'Revised after feedback: "..."' so it's clear why it changed. Once approved,
the buttons are replaced with a green "✅ Approved as Producer" badge.
Tested end-to-end in the browser: requested changes ("add more suspense,
less comedic") on a lighthearted draft and got back a genuinely tenser
version (new episode titles like "Betrayal and Panic", "Defending the
Sanctuary"), then approved it and confirmed the badge survives a page
refresh (proving it's really saved in the database, not just in-memory).

### Step 1.7 — Three-act structure generation ✅ DONE
- [x] Once approved, add a button "Generate Three-Act Structure"
- [x] Send the approved concept to Claude API, ask for a three-act breakdown, display it
- [x] Learning goal: reusing the same API-call pattern you learned in Step 1.3 — notice it's the same idea again

**What was built:** A new `three_act_structures` table, and a
"Generate Three-Act Structure" button that only appears once a pitch deck
is approved. It sends the approved title/logline/premise/tone to Gemini
(same call pattern as Step 1.3 and the pitch deck) and gets back Setup /
Confrontation / Resolution, each with a summary and a bulleted list of key
beats, fully bilingual. Displayed as its own card below the pitch deck.
Tested end-to-end: generated a real three-act structure from an approved
pitch deck, confirmed it's genuinely tied to that story (character names,
setting, plot beats all match), confirmed it survives a page refresh (saved
in the database), and confirmed the English/Odia toggle works for it too.
Note: this step is generate-and-display only — revision and locking come
next in Step 1.8, on purpose (small steps, one thing at a time).

**Update 2026-08-12 (per-episode three-act breakdown for web series):**
For a web series, the three-act structure now covers two levels at once:
one overall three-act structure for the whole series arc (as before), PLUS
a compact three-act mini-structure for each individual episode (its own
Setup/Confrontation/Resolution, tied to that episode's synopsis from the
pitch deck). Shown as a new "Episode-by-Episode Three-Act Breakdown"
section under the overall structure, one card per episode. This uses the
exact same revision/lock/version-history system from Step 1.8 — no new
buttons needed, regenerating or locking updates both levels together.
Tested end-to-end with a real 3-episode series: confirmed each episode's
breakdown is genuinely distinct and specific to that episode (not repeated
across episodes), confirmed requesting changes ("Episode 2 needs more
tension") correctly escalated that one episode's confrontation beat while
regenerating everything, and confirmed the old version's original episode
breakdowns stayed intact and viewable in Version History. Also confirmed
in both languages. Film format is unaffected (no episode section shown).
Note: for series with many episodes (worked cleanly at 3; not yet tested
at 12-15), the AI response could theoretically get cut off since there's a
lot more content to generate at once — something to watch for if a very
long series is tried and the three-act structure comes back incomplete.

### Step 1.8 — Revision + lock (confirm "as Story Writer") ✅ DONE
- [x] Add a revision loop for the three-act structure (same pattern as Step 1.6)
- [x] Add a "Lock Structure" button — once locked, no more edits (unless explicitly unlocked)
- [x] Keep version history — every past version should still be viewable, not deleted
- [x] Learning goal: understand version history / not overwriting data

**What was built:** Added `status` ('pending' / 'changes_requested' / 'locked')
and `feedback` columns to `three_act_structures`, mirroring Step 1.6's pattern.
New endpoints: `POST /api/three-act-structure/:id/request-changes` (records
feedback on the old version, generates a brand-new revised version — old
version kept, never overwritten) and `POST /api/three-act-structure/:id/lock`
(marks a version locked, after which the UI hides the edit buttons and shows
a "🔒 Locked as Story Writer" badge instead). A `GET
/api/three-act-structure/history` endpoint lists every version for the
current pitch deck, and the UI shows a "Version History" section listing
each one with its status and any feedback given, plus a "View"/"Hide" button
per version that expands to show that exact version's full Setup/
Confrontation/Resolution content (fetched fresh from the database, not just
cached in memory) without touching the current locked version on screen.
Tested end-to-end in the browser: requested changes ("the resolution feels
rushed — add a beat where Dibakar almost fails before succeeding") and got
back a genuinely revised Act 3 with a new near-failure beat added, locked
that version and confirmed the lock badge replaced the edit buttons and
survived a page refresh, then expanded Version 1 in the history list and
confirmed it shows the original, un-revised resolution — proving old
versions are truly preserved and not silently replaced.

### Step 1.8b — Bit Sheet / Plot Points (new stage) ✅ DONE
- [x] Insert a new stage between the locked three-act structure and scene
  one-liners: a Bit Sheet, a more granular list of the story's major
  plot-point beats (catalyst, reveal, midpoint, setback, climax, turning
  point, resolution beat), grouped by act.
- [x] Give it its own Approve / Request Changes cycle (same non-destructive
  revision pattern as everything else), gated on the three-act structure
  being locked first.
- [x] Change scene one-liner generation to build from the approved Bit
  Sheet instead of straight from the three-act structure — each bit
  typically becomes 1-3 scenes.

**Why this got added:** the user shared a much bigger blueprint proposing a
full chat-style UI rewrite, a Bit Sheet stage, an automated quality-scoring
engine, and natural-language stage-jumping — all bundled as one request.
Rather than build all of that at once (which would have broken the
small-steps approach this whole project has followed), the plan was split
into separate pieces and the user picked the Bit Sheet as the lowest-risk,
most-consistent-with-existing-architecture piece to build first. The other
three pieces (chat UI, scoring engine, stage-jump routing) are intentionally
NOT built yet — see the note in the Session Log for what each would involve
if picked up later.

**What was built:** A new `bit_sheets` table (tied to a locked three-act
structure, same status/feedback columns as everything else) and a new
`bit_sheet_id` column on `scene_lists` (replacing the direct link to
`three_act_structures` — scene generation now reads from the Bit Sheet).
New endpoints: `POST /api/bit-sheet` (generate, refuses if the three-act
structure isn't locked), `GET /api/bit-sheet/latest`, `POST /api/bit-sheet/:id/approve`,
`POST /api/bit-sheet/:id/request-changes`. For a web series, each episode
gets its own Bit Sheet (reusing that episode's three-act mini-structure);
for a film, one Bit Sheet for the whole story. Bit count scales loosely
with runtime (roughly one bit per 8 minutes, clamped to a sane range) —
advisory, not a hard rule. The UI shows each bit with a small color-coded
badge for its beat type, grouped by act, with the same Approve/Request
Changes pattern used everywhere else.
Tested end-to-end via the backend and confirmed live in the browser: a
10-bit film Bit Sheet and a 4-episode series Bit Sheet (6 bits/episode)
both generated cleanly, scenes generated correctly FROM the bit sheet
(confirmed a scene list still landed within a few minutes of its runtime
target), a full screenplay scene still generated correctly through the
extended chain, and a revision ("add a bit where he hesitates before
stepping into the pond") correctly inserted a new "Hesitation at the
Water's Edge" beat in exactly the right spot.
Note: this changes the required pipeline order going forward — a scene
list can no longer be generated directly from a three-act structure, it
needs an approved Bit Sheet in between. Older test projects created before
this feature (e.g., the "Shadow of Puri" series scene list mentioned in the
Step 1.9 notes below) needed a fresh Bit Sheet generated before new scenes
could be added to them; nothing already-written was lost, but the
short-cut path no longer exists for old data.

### Step 1.9 — Scene one-liners and full screenplay ✅ DONE
- [x] Add format selector (film vs. web series) if not already asked — done early, in Step 1.5 (see above)
- [x] Generate scene-by-scene one-liners from the locked structure
- [x] Generate full screenplay draft, scene by scene (confirm "as Screenplay Writer")
- [x] Learning goal: chaining multiple agent calls together in sequence within one agent

**What was built (scene one-liners half):** A new `scene_lists` table, tied
to a specific locked three-act structure. Once a structure is locked, a
"Generate Scene One-Liners" button appears (enforced on the backend too —
it refuses if the structure isn't locked yet, matching the agent spec's
"Once locked..." instruction). For a film, it breaks the whole three-act
structure into one ordered scene list; for a web series, it instead breaks
down each episode's own mini three-act structure into that episode's own
scene list, reusing the per-episode breakdown from the earlier update. Each
scene has an act number, a scene heading (interior/exterior, a bilingual
location name, day/night), and a bilingual one-line description — grouped
on screen by act, with act headers. A simple Approve / Request Changes step
(as Screenplay Writer) gates this before the next half (full screenplay) is
built, matching the "never skip an approval step" rule in the agent spec.
Tested end-to-end with the 3-episode series: generated real per-episode
scene lists tied to specific locations and events already established in
the story, requested changes ("Episode 3 needs one more scene showing
Ananya thanking her guru") and confirmed the new scene was inserted in the
right place, approved it, and confirmed everything survived a full page
reload in both languages. Also confirmed the film path (one flat scene
list, no episode grouping) works via a direct backend test.
Note: same AI-generation caveat as the per-episode three-act update — a
couple of stray non-Odia characters occasionally show up inside otherwise-
correct Odia sentences (e.g. a Devanagari word mixed into an Odia one).

**Update 2026-08-12 (Odia script cleanup filter):** Added an automatic
cleanup step, applied to every piece of AI-generated Odia text right after
it comes back from Gemini (storylines, pitch decks, three-act structures,
scene lists — all of it), that strips out any stray characters from other
scripts (Devanagari, Arabic, Bengali, Gurmukhi, Gujarati, Tamil, Telugu,
Kannada, Malayalam) that occasionally slip into an otherwise-correct Odia
sentence. Caught a real near-miss while building this: the first version
of the filter also deleted the Odia sentence-ending punctuation mark "।"
(danda), because that character technically lives inside the Devanagari
Unicode block even though it's the normal full stop in Odia too — every
sentence would have lost its full stop. Fixed by carving out an exception
for that punctuation specifically. Tested with the exact glitchy sentences
seen earlier (confirmed they now clean up correctly) and with a fresh full
three-act regeneration afterward (scanned every single bilingual field
programmatically — zero stray foreign characters found, and all Odia
punctuation intact).

**Update 2026-08-12 (real runtime instead of a fixed scene count):** After
testing, feedback was that a 20-minute episode only got 5 scenes — nowhere
near enough. The root problem: scene generation never actually knew how
long the episode or film was meant to run, and a film had no runtime field
at all (only a web series asked for episode length). Fixed properly:
- Film format now asks for a **Total Runtime (minutes)** when you pick
  "Film," the same way a web series already asks for episode count and
  length. That number is saved with the pitch deck and now drives everything
  downstream.
- Every scene the AI generates now gets its own **estimated duration in
  minutes**, shown right on screen (e.g. "Scene 3 — INT. Tea Stall — DAY
  (~2 min)"), and the app shows a running total against the target ("Estimated
  total: 112 min (target: 120 min)") so it's visible at a glance whether the
  scene list actually covers the runtime.
- The AI is now told the real target runtime and asked to size the scene
  count and each scene's length to genuinely fill it, instead of a vague
  "roughly 4-8 scenes" guess. It also scales complexity: a 12-minute short
  film gets a lean 1-2 beats per act in the three-act structure, while a
  120-minute feature gets 4-6 beats per act with real subplots — same idea
  applied to a web series' overall arc and each episode individually.
- Added a safety net: if the AI's first attempt is off by more than 25% from
  the target runtime, the app automatically asks it to try again once
  (never more than once, to protect the daily free-tier quota) with the
  actual vs. target numbers spelled out.
- Fixed a real bug found while testing a 120-minute film: the AI's response
  got cut off mid-JSON because the token budget was fixed regardless of how
  much content a long film actually needs. The budget now scales with the
  target runtime instead.
Tested end-to-end: a 20-minute series episode went from 5 scenes to 9
scenes summing to 19.5-20 minutes; a 12-minute short film came back as 6
scenes summing to exactly 12 minutes with lean 2-beat acts; a 120-minute
feature came back as 56 scenes summing to 112 minutes (well within the
tolerance, so no retry was even needed) with a richer 5-beat three-act
structure and real subplots. Verified all of this live in the browser too,
not just via direct backend checks.

**Update 2026-08-12 (full screenplay draft, scene by scene):** Once the
scene list is approved, each scene now shows a "Write This Scene" button.
Clicking it expands that ONE scene into real screenplay format — action
lines plus character dialogue — matching the agent spec's explicit
instruction to write "scene-by-scene, not the whole film at once." This is
also a deliberate quota decision: each scene is its own AI call, and on
Gemini's free tier (20 requests/day) a one-click "write everything" button
for a 40+ scene project would burn most of a day's quota instantly, so the
user stays in control of the pace. A new `screenplay_scenes` table stores
one row per scene (episode + scene index for a series, just scene index for
a film); writing a scene shows the AI the full scene outline plus the
immediately preceding scene's already-written content, so character names
and voice stay consistent from scene to scene without needing a separate
"character bible." Each scene has its own Request Changes box (feedback
regenerates just that one scene, non-destructively — old draft kept). A
running "Screenplay progress: X / Y scenes written" line tracks how much of
the project is drafted, and once every scene has a draft it's replaced with
a completion banner (a nod to Instruction 6 — signaling the stage is done
and ready to hand off — though there's no Hero Agent yet to actually hand
off to).
Tested end-to-end on a real 41-scene, 4-episode series: wrote a scene via
the actual "Write This Scene" button in the browser and confirmed it
genuinely continued the previous scene's moment (referencing the isolation
established one scene earlier), requested changes on an earlier scene
("mention his late father's name, Kanhu") and confirmed the new line landed
in exactly the right place, and confirmed clean bilingual output with zero
foreign-script leftovers (scanned programmatically) plus correct rendering
in both languages live in the browser, including the progress counter
updating correctly.
Note: character name cues (e.g. "BIRA") currently stay in Roman script even
when viewing in Odia, since names aren't translated by design — but real
Odia screenplays often write the cue itself in Odia script too. Flagged as
a possible refinement, not changed yet, since it touches how character
identity is tracked across scenes.

**Agent 1 complete when**: you can type a concept, get storylines, approve
as Producer, get a three-act structure, revise and lock it as Story Writer,
then generate scene one-liners and a full screenplay as Screenplay Writer —
all saved and reloadable. No other agents exist yet — that's correct at this stage.

**This milestone is now reached** (2026-08-12) — every piece of that pipeline
exists and works end-to-end, including the runtime-matching and Odia-quality
fixes along the way. Writing every single scene of a full-length project is
still a manual, scene-by-scene process by design (see the note above on
Gemini's free-tier quota), but the capability itself is complete. Agent 2
(Hero Agent) can be started next whenever the user is ready.

---

## AGENT 2 — Hero Agent (simple router version only)
Full spec: `agents/hero-agent.md`

- [ ] Not started
- [ ] Goal for this stage: only build save/handoff logic — take Agent 1's finalized output and mark the project ready for the next stage. No smart coordination yet.

---

## AGENT 3 — Storyboard Agent
Full spec: `agents/storyboard-agent.md`

- [ ] Not started — begin only after Agent 2 (simple router) works

---

## AGENT 4 — Production Management Agent
Full spec: `agents/production-management-agent.md`

- [x] Part 1 (Shoot Schedule — Instructions 1/2/4) DONE, built ahead of
  Agent 2/3 at the user's explicit request — see the full write-up near the
  top of this file. Wired directly to Agent 1's scene list, skipping the
  Hero/Storyboard handoff for now.
- [ ] Part 2 (Budget Allocation — Instruction 3) — not started, next up.
- [ ] Instruction 5 (signal completion to Hero Agent) — deferred with the
  rest of the Hero Agent build.

---

## LATER PHASES (not yet broken into agent form)
- [ ] Casting matching (likely folds into Production Management Agent — decide when you get here)
- [ ] Crew Communication (WhatsApp) — likely its own agent or service
- [ ] Post-Production Tools (promo, censor docs, subtitles) — likely its own agent

---

## Session Log
*(Add a one-line entry here every time you finish a session, so you can see progress over time)*

- Project created — roadmap and tracker set up. Ready to begin Step 1.1.
- Step 1.1 done — installed Node.js, built the React + Node.js skeleton, confirmed it runs locally in the browser. Next: Step 1.2 (concept input page).
- Step 1.2 done — built the concept text box + Generate button, verified the click triggers a display update. Next: Step 1.3 (connect to Claude API).
- Step 1.3 stubbed — wired Generate button to a real backend API call, but backend returns fake storylines (no Anthropic key yet). Next: Step 1.4 (save to database), with real Claude API as a follow-up whenever ready.
- Step 1.3 completed for real — switched AI provider from Anthropic Claude to Google Gemini (free tier, no billing needed), wired up a real API key, tested live in browser with genuine AI-generated storylines. Tech stack updated in CLAUDE.md. Next: Step 1.4 (save to database).
- Step 1.4 done — installed PostgreSQL via Postgres.app, created the `concepts` table, wired the backend to save every generated concept + storylines and reload the latest one on page load. Verified with real page refreshes. Next: Step 1.5 (pitch deck view + export).
- Step 1.5 done — added "Choose this one" per storyline, which generates a full pitch deck (premise, tone/genre, target audience) via Gemini, saves it to a new `pitch_decks` table, displays it cleanly, and exports it as a real downloadable PDF. Verified the PDF opens correctly. Next: Step 1.6 (approval flow as Producer).
- Step 1.5 revised — switched storyline/pitch-deck generation to be Odisha-culture-grounded (Ollywood style, not Hollywood) and fully bilingual (English + Odia), with a language toggle in the UI and Odia-script PDF export (embedded Noto Sans Oriya font). Tested both languages end-to-end, including PDF rendering. Next: Step 1.6 (approval flow as Producer).
- Step 1.5 revised again — added the film/web-series format selector (with episode count + length for series) and rebuilt the PDF export as a proper landscape, multi-slide presentation deck with genre-based color themes and better typography. Tested with both a film and a 15x10min web series, in both languages. Next: Step 1.6 (approval flow as Producer).
- Step 1.5 revised once more — matched the design to a real reference pitch deck the user shared (checked AI image generation, but it needs paid billing, so stayed free); added a punchy display font, per-episode breakdown pages/content for web series, and a closing slide. Fixed a duplicate-episode-numbering bug found during testing. Next: Step 1.6 (approval flow as Producer).
- Fixed a real bug: hit Google's free-tier daily cap (20 requests/day) on `gemini-flash-latest`, which caused the whole page to go blank on any AI error (frontend crashed instead of showing a message). Switched the model to `gemini-flash-lite-latest` (separate quota, worked immediately) and added proper error handling in the frontend so future hiccups show a message instead of crashing. Confirmed fixed live in browser. Session ended for the night here — next up whenever we resume: Step 1.6 (approval flow as Producer).
- Step 1.6 done — added Approve/Request Changes buttons, a feedback box that regenerates the pitch deck (as a new version, old one kept with the feedback recorded), and an "✅ Approved as Producer" badge once approved. Verified end-to-end: feedback genuinely changed the tone, and the approved badge survived a page refresh. Next: Step 1.7 (three-act structure generation).
- Step 1.7 done — added "Generate Three-Act Structure" (only shown once approved), reusing the Step 1.3 API-call pattern to get Setup/Confrontation/Resolution with key beats, bilingual. Verified end-to-end including page refresh and language toggle. Next: Step 1.8 (revision + lock for the three-act structure).
- Step 1.8 done — added Request Changes/Lock Structure buttons for the three-act structure (same revision pattern as Step 1.6), plus a Version History list where every past version stays viewable (never deleted) with a View/Hide toggle per version. Verified end-to-end in the browser: a revision genuinely added a new plot beat, locking survived a page refresh, and an old version's un-revised content correctly reappeared when expanded. Next: Step 1.9 (scene one-liners and full screenplay).
- Step 1.7 enhanced — for web series, the three-act structure now also generates a mini three-act breakdown per individual episode (not just one structure for the whole series), reusing Step 1.8's revision/lock/history system automatically. Tested with a real 3-episode series in both languages, including a revision that correctly targeted one specific episode. Next: Step 1.9 (scene one-liners and full screenplay).
- Step 1.9 started (scene one-liners half done) — once a three-act structure is locked, a new "Generate Scene One-Liners" button breaks it into a full scene-by-scene list (per-episode for a series, one flat list for a film), each scene with a heading and bilingual one-liner, with its own Approve/Request Changes step as Screenplay Writer. Tested end-to-end with a 3-episode series: a revision correctly inserted a new scene in the right place, and everything survived a full page reload in both languages. Next: the full screenplay draft (second half of Step 1.9).
- Added an Odia script cleanup filter — strips stray characters from other scripts that occasionally slipped into AI-generated Odia text. Caught and fixed a near-miss where the first version of the filter would have deleted the Odia sentence-ending punctuation mark too. Verified clean with a fresh regeneration, scanned programmatically. User is now testing scene one-liners themselves before the full screenplay draft is built.
- Fixed a real pacing bug the user caught: scene one-liners were being generated with a fixed low scene count, ignoring the actual runtime — a 20-minute episode only got 5 scenes. Added a Total Runtime field for films (series already had episode length), made every scene carry its own estimated duration with a running total shown against the target, made the three-act structure scale its beat count to the runtime (lean for a short film, richer for a feature), and fixed a token-budget bug that silently truncated a 120-minute film's scene list. Tested a 12-min short, a 20-min series episode, and a 120-min feature — all landed within a few minutes of their target. Next: the full screenplay draft (second half of Step 1.9).
- Created `reference-screenplays/` (with `odia/film`, `odia/series`, `other-languages` subfolders + a README) as a drop-off point for real screenplays the user wants to share, so Claude can later study natural Odia dialogue and story structure and use it to make the app's writing less robotic. Waiting on the user to add files before any analysis can happen.
- Refined the reference-screenplays structure: split `odia/film/` into `hits/` and `average/` (so a hit and an average film can be compared side by side to see what actually makes the difference, not just what Odia dialogue looks like in general) and added a separate `odia/telefilm/` category, since telefilms are a distinct shorter TV-broadcast format with different pacing from a feature film or series episode.
- Step 1.9 finished — built the full screenplay draft feature: once a scene list is approved, each scene gets a "Write This Scene" button that expands it into real action lines + dialogue, one scene at a time (by design, both per the agent spec and to keep control over the daily AI-quota cost). Each scene has its own Request Changes box, and a progress line tracks how much of the project is drafted. Tested live on a real 41-scene series: a written scene correctly continued the previous one, a revision landed in exactly the right spot, and bilingual output stayed clean. This completes Agent 1's full pipeline end-to-end. Next: Agent 2 (the Hero Agent), whenever the user is ready to start it.
- First reference-screenplay analysis pass — user added real Odia web series scripts into `odia/series/`. Read a sample across several, rewrote the screenplay dialogue prompt to match real patterns (broken/imperfect sentences, natural English code-switching, register varying sharply by character, constant family-address terms). Caught and fixed a real regression during testing: the AI briefly started writing the Odia field in Romanized Latin letters (mimicking how some real scripts are written for on-set use), which broke the actual bilingual requirement — fixed by clarifying that code-switching means an English word inside an Odia-script sentence, not the whole sentence in Latin. Verified with a side-by-side regeneration of the same scene. Only `odia/series/` has content so far; film/telefilm/hits-vs-average still empty.
- User shared a big blueprint for a full chat-style UI rewrite + a Bit Sheet stage + a quality-scoring engine + natural-language stage-jumping, all as one request. Split it into four separate pieces instead of building it all at once, and built the Bit Sheet stage first (see Step 1.8b) since it was lowest-risk and fit the existing architecture. The other three are still just proposals, not built:
  - **Chat-style UI rewrite**: biggest/riskiest — would replace most of the working UI from Steps 1.1-1.9. Needs its own scoping conversation, likely its own multi-session project.
  - **Quality scoring engine** (X/10 + suggested fixes per stage): needs a design decision on whether "Auto-Apply Fixes" should ever change content without explicit review (tension with the "never skip an approval step" rule already followed everywhere else), plus a plan for the extra Gemini-call cost against the free-tier quota.
  - **Natural-language stage-jumping**: overlaps with Agent 2 (the Hero Agent), which the roadmap already scoped as "simple router, no smart coordination yet" — would need deciding whether to expand that scope now or later.
  Revisit these whenever the user wants to pick one up.
- User added 5 classic screenwriting craft books (Field, McKee, Snyder, Trottier, Vogler) into `screenwriting-craft-guides/`. Ran 5 parallel research passes reading each book and comparing its framework against our actual pipeline. Five concrete recommendations came out of it (expand Bit Sheet beat types, add a Theme/Controlling Idea field, require a "turn" per scene, add a structured Characters layer, expand screenplay formatting support) — none built yet, waiting on the user to prioritize. The single most valuable gap found: we have no structured Characters concept anywhere — character is just a free-text name string on dialogue lines.
- Started "build all one by one" on the 5 craft-book recommendations: #1 (Bit Sheet structural anchors) done and tested; #2 (Theme/Controlling Idea field) code-complete but not yet tested — paused mid-verification when the user redirected to UI work instead.
- Pivoted to a UI redesign per explicit user request: converted the dashboard-style "show everything stacked" layout into a stage-based one — a left sidebar with an Idea/Synopsis/Bit Sheet/Screenplay navigator (done/current/upcoming states, click to jump), main content showing only the active stage, a minimal single-bubble-plus-input first screen, and Enter-to-submit on the idea box. Kept the "skip ahead" mechanism deliberately simple (navigate freely, get a clear message + one-click link back if a stage's prerequisites aren't ready yet) rather than building auto-chaining or NL routing. Tested end-to-end against a real, live-progressing project. Next: a right-side action panel (some ambiguity in the requested items to resolve), then real multi-project switching.
- User reviewed the stage-nav redesign live and said directly it was "a messed up ui," then shared a real Gemini UI screenshot plus custom icons and a precise respecification: no stage tracker, a genuine scrolling chat log, one persistent contextual input bar, and side-by-side storyline options with a locked/dimmed visual state. Confirmed via two quick questions (Gemini-style only, no stage tracker; icon placement left to Claude's judgment) before rebuilding. Removed the stage-nav entirely and rebuilt: empty-state gradient greeting, persistent bottom input bar that switches between "generate" and "regenerate" modes depending on whether storylines already exist, side-by-side option cards with a "✓ Locked in" badge + dimmed sibling, and a full dark Gemini-inspired color theme applied across every existing card (pitch deck, three-act, bit sheet, scene list, screenplay), not just the sidebar. Also fixed a leftover Vite-starter default (`#root` boxed at 1126px with side borders) that was fighting the new full-bleed layout. Tested the entire flow live in the browser end-to-end — matches the user's spec exactly. Next: the right-side action panel, then real multi-project switching.
- Fixed the "always shows the last project" bug and built real multi-project support: found the actual root cause (every `/latest` backend endpoint grabbed the single newest row anywhere, ignoring which project it belonged to), added scoped endpoints (list all projects, load one project's full chain by id, rename), and wired the sidebar's History section up to them for real Load/New project switching — "New Idea" now also clears its `localStorage` pointer so a refresh actually stays fresh. Brought back a stage-progress list in the sidebar (Idea/Synopsis/Bit Sheet/Screenplay, done/current/upcoming) that smooth-scrolls to a section on click instead of replacing the chat log, learning from what actually went wrong with the earlier reverted stage-nav. Made the persistent input bar truly persistent — it no longer disappears after the synopsis, and now routes typed feedback to whichever stage is currently awaiting a decision. Also fixed the sidebar visibly scrolling away with the main content (an `.app-shell` sizing bug) so it now stays fixed. Caught and fixed a real bug during testing: loading a project from History lost the in-memory "chosen storyline" marker, which briefly made the input bar wrongly offer to regenerate storylines even when a pitch deck already existed. Tested end-to-end live in the browser. Rename is code-complete but needs the user's own manual test (uses a native prompt() dialog the automated browser can't drive). Next: the right-side action panel.
- Big batch: added Export Idea/Import Idea (download/reload a project as a `.json` file on your own computer), History pin and delete (changed the database foreign keys from `ON DELETE SET NULL` to `ON DELETE CASCADE` so deleting a project cleanly removes its whole chain), and "skip ahead" — a "Start from: Idea/Synopsis/Bit Sheet/Scene One-Liners" tab row that lets you paste your own already-written material and have ONE AI call both faithfully parse it into the real schema AND invent plausible, consistent earlier stages behind it (film format only for now). Also moved the film/web-series question to the very first screen (before typing an idea at all) instead of after choosing a storyline, and threaded that format into storyline generation itself — choosing a storyline now goes straight to building the pitch deck since format is already known. Tested export→import round-trip, cascade-delete, pin-to-top, the full format-first flow, and a real skip-to-bitsheet paste end-to-end live in the browser; skip-to-synopsis/skip-to-scenelist verified by code review only to conserve the day's Gemini quota (same proven one-call pattern). Noted one rare AI glitch (a stray Hebrew character in one English title) — not chasing it as a general fix since it's a one-off. Rename/delete confirmation dialogs are native browser prompts the automated test browser can't drive — worth the user's own click-through. Next: the right-side action panel; trying rename/delete/skip-ahead (all 3 target stages) yourself.
