# The Story Brain — design (draft for approval)

## Why we need it

Three script reviews of *Bishpan* said the same thing in different words: the story was
**assembled, not designed**. Each scene followed the rules, but nobody planned the
experience: the hook that makes you click episode 2, the mystery, the "wow" climax.

The app went straight from an idea to a pitch deck and then wrote forwards, a few
episodes at a time, hoping it would add up. Real writers do the opposite: they decide
the hook, the hidden truth and the ending first, then build backwards.

The **Story Brain** is that missing "writers' room". It runs before anything is
written and produces one document: the **Story Bible**. Every later writer
(pitch deck, characters, scenes) works from it, and every judge checks against it.

## Where it sits

```
Idea  →  STORY BRAIN (Story Bible)  →  [you approve one page]  →  Pitch deck  →  Cast
      →  Structure  →  Bit sheet  →  Scene list  →  Scenes  →  Script editor  →  Language check
```

The pitch deck stops inventing the story. It only presents what the Bible already decided.

## What the Story Bible contains

| Part | What it answers |
|---|---|
| **1. The promise** | Logline. The one question that keeps people watching. The genre promise (what thrill or feeling the audience is paying for). The trailer moment. |
| **2. The hidden truth** | What *really* happened, as a timeline, before the story starts. Who did it, why, how. Who knows what. (For a drama: the backstory wound and the secret.) |
| **3. Characters as engines** | For each main character: age, relation to the hero, look, what they want, what they need, their **secret**, the lie they believe, and **the moment they change the plot**. For the villain: his plan and his move in every episode. |
| **4. Facts sheet** | Things that must stay true: jobs, money, vehicles, health (who is bedridden), places, and the **rules of the supernatural** (what the Goddess can and can't do, and why). |
| **5. Setups and payoffs** | Every planted thing (an object, a line, a habit), where it is planted and where it pays off. Nothing important appears out of nowhere. |
| **6. Clue and reveal map** | Episode by episode: the clue found, the false lead, what the hero learns, and what the audience learns. The hero finds clues **by his own action and skills**, never by luck or overhearing. |
| **7. Episode blueprints** | For each episode: the cold-open hook, the episode's question, the hero's active move, one set piece, the turn, and the ending hook. Episode 1 follows the pilot rules below. |
| **8. Climax design** | Designed first and built backwards: the big reversal, the payoffs it fires, the hero's choice and what it costs him, the final image, and in one line **why the audience will say "wow"**. |
| **9. Set pieces** | One unforgettable sequence per episode, built on real local culture (festivals, rituals, places, beliefs), not decoration. |

## Storytelling rules the Brain follows

- **Pilot (episode 1):** a gripping cold open in the first 2 minutes. The hero's normal life is shown *with a crack already in it*. The incident that sets the story going lands by about minute 8. The episode ends on a shock or a question. Never only travel and set-up.
- **Hero agency:** the hero causes events; he doesn't just receive them. Every episode he makes a choice that makes things worse or better.
- **Escalation:** each episode raises the stakes: personal, family, then the whole village.
- **Mystery fair play:** the truth is decided first; clues are planted so a re-watch makes sense. A false suspect has a real motive *and* a secret of his own.
- **Setups pay off:** an important object or line in the climax must have been planted earlier.
- **Climax = reversal + choice + cost + payoff + image.** History may repeat (mirror the opening) for power.
- **Real-world logic:** money, jobs, health and belongings stay consistent with the facts sheet.
- **Freshness:** stock tropes (blackouts, mirror-staring, glowing eyes, villain confessing in public) are only allowed with a new twist.
- **Culture as engine:** local festivals, rituals and beliefs drive the plot, not just the background.

## How it thinks (the writers' room)

1. **Pitch room:** the best model writes **3 different directions**. Each has its hook, its central question, how episode 1 ends, and the climax twist. An *audience critic* scores each one on hook, freshness, wow factor and faithfulness to your idea. The best is picked automatically, or you pick.
2. **Truth first:** design the hidden truth, the characters and the facts sheet.
3. **Backwards:** design the climax, then the setups and payoffs and the clue map, then the episode blueprints from 1 to N, with the whole design in view (not in blind batches).
4. **Two critics**, both run on the best model:
   - **Story doctor:** checks logic, cause and effect, hero agency, and consistency with the facts.
   - **Audience critic:** asks "Would I click the next episode? Where would I get bored? What's the wow moment?"

   The Bible must score **8 or more** from both critics. It's revised until it does (a few rounds). If it still can't, the app tells you instead of carrying on with a weak design.
5. **You approve one page:** the promise, the episode 1 hook, the climax and the episode-by-episode hooks. You can approve it, or give a note and it revises.

## How the rest of the app uses it

- **Every writer** gets the parts it needs: the facts sheet, the cast, this episode's blueprint, and the setups to plant or pay off in this episode.
- **Every judge** checks against the Bible, for example "Is the clue for episode 3 there?" or "Is the bedridden grandmother still in bed?"
- **The scene writers keep the faster model.** The Bible decides the big story, so they don't need to.

## Models

| Job | Model |
|---|---|
| Story Brain (pitch room, design, both critics) | **Gemini 3.1 Pro** (the best available on your Google Cloud project, tested today). If it fails, it falls back to Gemini 2.5 Pro. |
| Pitch deck, structure, scene list, scenes, script editor, language check | Gemini 2.5 Flash, as today. We can consider Gemini 3 Flash later. |

Technical note: the app's Gemini library (version 0.3) is too old to reach Gemini 3.1 Pro.
Build step 1 adds that access.

Cost: the Brain uses roughly 10–20 calls to the Pro model per project. Each call costs
more than a Flash call. The app will record how much each run used, so you can see the cost.

## Build plan (small steps; each one tested before the next)

1. **Model access:** connect Gemini 3.1 Pro, with the 2.5 Pro fallback.
2. **The Brain on its own:** generate a Story Bible from an idea. Test it on 2 ideas: Bishpan's core idea and one fresh idea. **You read both and judge them as a storyteller.** Nothing else is connected yet.
3. **Critics and revisions:** the story doctor and audience critic, and the score-8 rule.
4. **Screen:** show the Bible's one-page summary in the app, with Approve / Give a note.
5. **Connect it:** the pitch deck and later writers and judges use the Bible and the facts sheet.
6. **Full test:** one complete script from idea to PDF, reviewed by you.

## Questions for you

1. **Approval page:** should the app always stop once to show you the one-page Bible before writing? (Recommended: yes. It's quick to read, and it's where a storyteller's eye matters most.)
2. **Vertical micro-dramas** (60 × 1.5 minutes) need different rules (a hook every 90 seconds). Should the Brain cover them now, or only films and web series first?
