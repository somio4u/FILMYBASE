# Project: End-to-End Filmmaking Platform

## What this project is
An app that takes filmmakers from a raw movie concept all the way through
pre-production, scheduling, budgeting, casting, and post-production tools.
Full vision is in ROADMAP.md.

## Who is building this
The person you're working with is NOT a professional coder. They are
"vibe coding" — learning as they go, directing you in plain English.

**Rules for how you should behave in this project:**
- Always explain what you're about to do in plain language before doing it, especially the first time you touch something new (e.g. "I'm about to set up a database — this is where we'll store movie projects and their data").
- Work in small steps. Build one feature, confirm it works, then move to the next. Never build multiple phases in one go.
- After finishing any step, update PROGRESS.md: mark the step done, add a one-line plain-English note of what was built, and state the next step clearly.
- If something is ambiguous, ask a simple question rather than guessing silently.
- Prefer simple, readable solutions over clever ones. This person will need to understand what exists later.

## Architecture: Multi-Agent System
This app is built as a set of specialized AI agents, coordinated by one
orchestrator ("Hero Agent"), rather than one general-purpose AI doing
everything. Each agent's full system prompt lives in `/agents`:

- `agents/story-screenplay-agent.md` — story development through final screenplay
- `agents/storyboard-agent.md` — visual references and shot-type storyboards
- `agents/production-management-agent.md` — scheduling and budget
- `agents/hero-agent.md` — routes work between the above, tracks project stage

During this testing phase, one human (the project owner) plays every role:
Story Writer, Screenplay Writer, Director, and Production Manager.

**Update 2026-08-13:** the UI used to label every approval button/badge with
its role ("Approve as Producer", "Locked as Story Writer", etc). User found
this added friction while one person plays every role and asked to simplify
to plain "Approve" / "Locked" everywhere. The underlying approval STAGES and
gating logic are unchanged — only the on-screen wording lost the role suffix.
If real team members with distinct roles join later, revisit whether the
role labels should come back (e.g. shown only when more than one person is
attached to a project), rather than assuming this was permanent.

Build order: Story & Screenplay Agent first (standalone, no orchestration)
→ then a simple Hero Agent that only saves/hands off data → then Storyboard
Agent → then Production Management Agent. Don't build multiple agents at once.

## Current status
Check PROGRESS.md for the live checklist — always read it first when starting a new session.

## Tech stack (do not deviate without discussing first)
- Frontend: React
- Backend: Node.js
- Database: PostgreSQL
- File storage: (to be set up in Phase 2 — not needed yet)
- AI: Google Gemini API (switched from Anthropic Claude API on 2026-08-11 — Gemini's free tier let us test without adding billing credit. Separate from the Claude Code subscription — needs its own API key from aistudio.google.com)

## Where things are
- `ROADMAP.md` — the full 7-phase vision, for reference only, don't try to build it all at once
- `PROGRESS.md` — the live, step-by-step checklist — THIS is what drives daily work
- `/app` — the actual application code (created once Phase 1 Step 1 begins)

## First-session instruction
If this is a fresh session and `/app` doesn't exist yet, read PROGRESS.md,
find the first unchecked step, explain it in plain language, confirm with
the user, then begin.
