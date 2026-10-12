// A SCRIPTED stand-in for the AI, used ONLY when DRAFT_AGENT_MOCK=1 (development and browser tests). It never runs in normal use.
// It makes predictable, labelled changes so the whole Draft Agent flow can be exercised end to end without calling Google.
const mutate = (v) => {
  if (typeof v === "string") return v.length > 6 && !v.includes("[revised]") ? `${v} [revised]` : v;
  if (Array.isArray(v)) return v.map(mutate);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === "type" ? x : mutate(x)]));
  return v;
};
export const scriptedAgentModels = {
  async json(draft, agentId, prompt) {
    if (prompt.includes("routing step")) {
      const t = /INSTRUCTION \(verbatim\): """([\s\S]*?)"""/.exec(prompt)?.[1] ?? "";
      if (/second draft|new draft|villain|keep the/i.test(t)) return { intent: "NEW_DRAFT", confidence: 0.9, summary: "A big revision that should be a new draft.", targets: [{ type: "whole" }], mustKeep: /keep (the )?([^,.;]+)/i.test(t) ? [/keep (the )?([^,.;]+)/i.exec(t)[2]] : [], mustChange: [] };
      if (/try|what if|alternative/i.test(t)) return { intent: "ALTERNATIVE", confidence: 0.85, summary: "Try this without changing the draft.", targets: [{ type: "ending" }] };
      if (/scenes? \d/i.test(t)) return { intent: "SCOPED_REWRITE", confidence: 0.85, summary: "Rewrite those scenes.", targets: [] };
      return { intent: "LOCAL_EDIT", confidence: 0.9, summary: "Change the selected piece.", targets: [{ type: "selection" }] };
    }
    if (prompt.includes("Sort EVERY piece")) {
      const keys = [...prompt.matchAll(/^\[([^\]]+)\] /gm)].map((m) => m[1]);
      const scenes = keys.filter((k) => /^(b\d+s\d+|e\d+s\d+)$/.test(k));
      return { modified: scenes.slice(1, 2).map((key) => ({ key, why: "the villain changes here" })), indirect: scenes.slice(2, 3).map((key) => ({ key, why: "refers to the villain" })), removed: [], added: [{ label: "A new confrontation", why: "the new conflict needs it" }] };
    }
    if (prompt.includes("REVISED DRAFT")) return { summary: "The villain becomes the hero's brother; the opening and hero stay.", revisedSynopsis: "A dancer must face her own brother, who leads the storm cult.", revisedSynopsisHi: "x", seasonArc: "The brother arc runs through the season.", episodes: [{ index: 1, title: "The brother", synopsis: "The brother appears." }], sequenceOutline: [{ label: "Act 2", change: "The brother is revealed." }] };
    const m = /CURRENT \(JSON\):\n([\s\S]*?)\n\nReturn JSON only/.exec(prompt);
    if (m) return mutate(JSON.parse(m[1]));
    return { text: "A rewritten idea." };
  },
};

// ---------------------------------------------------------------------------
// A SCRIPTED stand-in for the app's own writing routes (Story Brain, judged stages, screenplay beats, Film story process).
// It changes the database the way those routes do, with predictable scores, so the Draft Agent's orchestration can be tested and
// demonstrated without calling Google. It proves nothing about how the real routes behave. Used only in tests and DRAFT_AGENT_MOCK=1.
// ---------------------------------------------------------------------------
const J = JSON.stringify;
const mutateText = (v, tag) => {
  if (typeof v === "string") return v.length > 6 && !v.includes(tag) ? `${v} ${tag}` : v;
  if (Array.isArray(v)) return v.map((x) => mutateText(x, tag));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === "type" ? x : mutateText(x, tag)]));
  return v;
};
const fakeBible = (title, notes = []) => ({
  promise: { title, logline: "A dancer faces her estranged sister, who calls the storm.", centralQuestion: "Can she forgive in time?" },
  characters: [{ name: "Mala", role: "hero" }, { name: "Sister", role: "villain" }], climax: { reversal: "The sister saves her.", heroChoice: "Forgive", finalImage: "Two dancers in the rain" },
  units: { kind: "sequence", label: "5 sequences" }, blueprint: [1, 2, 3].map((n) => ({ number: n, title: `Sequence ${n}` })), userNotes: notes,
  review: { passed: true, keptVersion: 2, scores: { story: 8, audience: 9 }, history: [{ version: 1, scores: { story: 7, audience: 8 } }, { version: 2, scores: { story: 8, audience: 9 } }], reports: {} },
});

export function fakePipeline(db, { stageScores = {}, onCall = null } = {}) {
  const runs = new Map();
  let nextRun = 1;
  const attempts = new Map();
  const ok = (json, status = 200) => ({ status, json });
  async function ai(method, path, body) {
    let m;
    const pid = Number(/\/projects\/(\d+)\//.exec(path)?.[1] ?? body?.projectId);
    const row = async () => (await db.query("SELECT * FROM ai_movie_projects WHERE id = $1", [pid])).rows[0];
    if ((m = /story-bible\/(note|design)$/.exec(path))) {
      const r = await row();
      const bible = fakeBible(r.story_bible?.promise?.title ?? "The Revised Story", [...(r.story_bible?.userNotes ?? []), ...(m[1] === "note" ? [body.note] : [])]);
      await db.query("UPDATE ai_movie_projects SET story_bible = $2, story_bible_job = $3, stage_status = COALESCE(stage_status,'{}'::jsonb) || $4::jsonb WHERE id = $1", [pid, J(bible), J({ status: "idle" }), J({ storyBible: { status: "pending", feedback: null } })]);
      return ok({ started: true });
    }
    if (/story-bible$/.test(path) && method === "GET") { const r = await row(); return ok({ bible: r.story_bible, markdown: "", status: r.stage_status?.storyBible?.status ?? "none", job: r.story_bible_job ?? { status: "idle" } }); }
    if (/story-bible\/approve$/.test(path)) { await db.query("UPDATE ai_movie_projects SET stage_status = COALESCE(stage_status,'{}'::jsonb) || $2::jsonb WHERE id = $1", [pid, J({ storyBible: { status: "approved", feedback: null } })]); return ok({ ok: true }); }
    if ((m = /^\/api\/ai-movie\/stages\/(synopsis|characterArc|threeAct|plot)\/generate$/.exec(path))) {
      const stage = m[1];
      const key = `${pid}:${stage}`;
      const n = (attempts.get(key) ?? 0) + 1; attempts.set(key, n);
      const seq = stageScores[stage] ?? [6, 9];
      const score = seq[Math.min(n - 1, seq.length - 1)];
      const r = await row();
      const content = mutateText(r.backfill?.[stage] ?? {}, `[new draft v${n}]`);
      const judge = { versions: [{ version: 1, score, blocking: false, problems: score < 8 ? [{ severity: "major", problem: { en: `The ${stage} lacks a strong turn.` } }] : [] }], kept: 1, keptScore: score, passScore: 7, passed: score >= 7, qualityMode: "professional" };
      await db.query("UPDATE ai_movie_projects SET backfill = jsonb_set(COALESCE(backfill,'{}'::jsonb), ARRAY[$2], $3::jsonb), stage_status = COALESCE(stage_status,'{}'::jsonb) || $4::jsonb WHERE id = $1", [pid, stage, J(content), J({ [stage]: { status: "pending", feedback: body.feedback ?? null, judge } })]);
      return ok({ stageKey: stage, content, judge });
    }
    if ((m = /^\/api\/ai-movie\/stages\/(\w+)\/approve$/.exec(path)) && !/beats/.test(path)) { const prev = (await row()).stage_status?.[m[1]] ?? {}; await db.query("UPDATE ai_movie_projects SET stage_status = COALESCE(stage_status,'{}'::jsonb) || $2::jsonb WHERE id = $1", [pid, J({ [m[1]]: { ...prev, status: "approved", feedback: null } })]); return ok({ ok: true }); }
    if (path === "/api/ai-movie/stages/screenplay/generate") {
      const r = await row();
      const beats = (r.backfill?.plot ?? []).map((b, i) => ({ status: "pending", feedback: null, scenes: [{ sceneHeading: { en: `Beat ${i + 1} scene`, hi: `Beat ${i + 1} scene` }, content: [{ type: "action", text: { en: `Written in the new draft, beat ${i + 1}.`, hi: `Written in the new draft, beat ${i + 1}.` } }] }] }));
      await db.query("UPDATE ai_movie_projects SET backfill = jsonb_set(COALESCE(backfill,'{}'::jsonb), '{screenplayBeats}', $2::jsonb), stage_status = stage_status - 'screenplay' WHERE id = $1", [pid, J(beats)]);
      return ok({ started: true });
    }
    if ((m = /beats\/(\d+)\/doctor$/.exec(path))) {
      const notes = [{ sceneNumber: 1, severity: "major", category: "story_logic", problem: { en: "Slow start" }, fix: { en: "Open on the storm" }, applied: false }, { sceneNumber: 1, severity: "minor", problem: { en: "x" }, fix: { en: "y" }, applied: false }];
      await db.query("UPDATE ai_movie_projects SET backfill = jsonb_set(backfill, ARRAY['screenplayBeats',$2,'doctorNotes'], $3::jsonb) WHERE id = $1", [pid, m[1], J({ notes, reviewedAt: new Date().toISOString() })]);
      return ok({ beatIndex: Number(m[1]), doctorNotes: { notes } });
    }
    if ((m = /beats\/(\d+)\/scenes\/(\d+)\/revise$/.exec(path))) {
      const r = await row();
      const scene = r.backfill.screenplayBeats[m[1]].scenes[m[2]];
      await db.query("UPDATE ai_movie_projects SET backfill = jsonb_set(backfill, ARRAY['screenplayBeats',$2,'scenes',$3], $4::jsonb) WHERE id = $1", [pid, m[1], m[2], J(mutateText(scene, "[doctor fix]"))]);
      return ok({ ok: true });
    }
    if ((m = /beats\/(\d+)\/approve$/.exec(path))) {
      const r = await row();
      const beats = r.backfill.screenplayBeats; beats[m[1]] = { ...beats[m[1]], status: "approved" };
      const all = beats.every((b) => b.status === "approved");
      await db.query("UPDATE ai_movie_projects SET backfill = jsonb_set(backfill, '{screenplayBeats}', $2::jsonb), stage_status = stage_status || $3::jsonb WHERE id = $1", [pid, J(beats), J(all ? { screenplay: { status: "approved", feedback: null } } : {})]);
      return ok({ beatIndex: Number(m[1]), allApproved: all });
    }
    if (/beats\/\d+\/request-changes$/.test(path)) return ok({ ok: true });
    return null;
  }
  async function film(method, path, body) {
    let m;
    if (path === "/api/auto-pipeline/start") {
      const id = nextRun++;
      runs.set(id, { id, status: "awaiting_approval", concept: body.concept, references: body.references, format: body.format, dialogueLanguage: body.dialogueLanguage, bible: fakeBible("The Revised Story"), notes: [] });
      return ok({ runId: id });
    }
    if ((m = /^\/api\/auto-pipeline\/(\d+)\/status$/.exec(path))) {
      const run = runs.get(Number(m[1]));
      if (!run) return ok({ error: "Run not found" }, 404);
      if (run.status === "running_bible") run.status = "awaiting_approval";
      if (run.status === "writing") {
        const c = (await db.query("INSERT INTO concepts (concept_text, storylines, title) VALUES ($1,'[]','The Revised Story') RETURNING id", [run.concept])).rows[0].id;
        const deck = (await db.query("INSERT INTO pitch_decks (concept_id, content, status) VALUES ($1,$2,'approved') RETURNING id", [c, J({ title: { en: "The Revised Story", hi: "x" } })])).rows[0].id;
        const sheet = (await db.query("INSERT INTO character_sheets (pitch_deck_id, content, status) VALUES ($1,$2,'approved') RETURNING id", [deck, J([{ name: "Mala" }])])).rows[0].id;
        const act = (await db.query("INSERT INTO three_act_structures (pitch_deck_id, content, status) VALUES ($1,$2,'locked') RETURNING id", [deck, J([{ actName: { en: "Act One" } }])])).rows[0].id;
        const bits = (await db.query("INSERT INTO bit_sheets (three_act_structure_id, content, status) VALUES ($1,$2,'approved') RETURNING id", [act, J({ bits: [] })])).rows[0].id;
        const list = (await db.query("INSERT INTO scene_lists (bit_sheet_id, content, status) VALUES ($1,$2,'approved') RETURNING id", [bits, J({ scenes: [] })])).rows[0].id;
        await db.query("INSERT INTO screenplay_scenes (scene_list_id, scene_index, content) VALUES ($1,0,$2)", [list, J({ heading: "EXT. NEW - DAY", elements: [{ type: "action", text: "The revised story begins." }] })]);
        void sheet;
        run.conceptId = c; run.status = "completed";
        run.notes = [{ stage: "pitch-deck", text: "Version 1 — Judge score: 6/10 — thin" }, { stage: "pitch-deck", text: "Version 2 — Judge score: 9/10 — strong" }, { stage: "three-act", text: "Version 1 — Judge score: 8/10 — good" }];
      }
      return ok({ id: run.id, status: run.status, storyBible: run.bible, conceptId: run.conceptId ?? null, reviewNotes: run.notes, error: run.error ?? null });
    }
    if ((m = /^\/api\/auto-pipeline\/(\d+)\/bible-note$/.exec(path))) { const run = runs.get(Number(m[1])); run.status = "running_bible"; run.bible = fakeBible("The Revised Story", [...(run.bible.userNotes ?? []), body.note]); return ok({ runId: run.id }); }
    if ((m = /^\/api\/auto-pipeline\/(\d+)\/bible-approve$/.exec(path))) { runs.get(Number(m[1])).status = "writing"; return ok({ runId: Number(m[1]) }); }
    return null;
  }
  return {
    runs,
    async open(userId) {
      return {
        userId,
        async call(method, path, body) {
          onCall?.(method, path, body);
          const out = (await ai(method, path, body)) ?? (await film(method, path, body));
          return out ?? { status: 404, json: { error: `fake pipeline: no route ${method} ${path}` } };
        },
        async close() {},
      };
    },
  };
}
