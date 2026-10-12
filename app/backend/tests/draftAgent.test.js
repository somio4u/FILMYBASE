// Universal Auto Screenplay Agent: intent routing, scoped edits (preview -> apply -> undo), alternatives, and the NEW_DRAFT workflow with its
// hard synopsis checkpoint. Every key flow runs for BOTH modules (Film "Movie" and AI Movie). REAL Postgres; the MODEL IS A SCRIPTED MOCK
// (nothing here proves what the real Gemini models write).
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import pg from "pg";
import { ensureAllProductionSchemas } from "../productionSchema.js";
import { analyzeScreenplay } from "../screenplayAnalysis.js";
import { branchDraft, compareDrafts, draftUnits, ensureDraftFor, getDraft, updateDraft } from "../drafts.js";
import { applyChangeSet, approveFinal, approveSynopsis, cancelRequest, classifyPrompt, conform, failInterruptedRequests, getRequest, heuristicIntent, interpret, productionImpact, propose, registerDraftAgentRoutes, rejectChangeSet, requestSynopsisChanges, resolveTargets, retryRequest, revisionDetail, startAlternative, startRevision, undoChangeSet, whenIdle, readUnit } from "../draftAgent.js";
import { createBlank } from "../drafts.js";

const db = new pg.Pool({ database: process.env.TEST_DB || "filmmaking_app_test", user: process.env.PGUSER || "root", host: process.env.PGHOST || "/var/run/postgresql" });
const requireRole = () => (req, res, next) => ((req.user = { id: 1 }), next());
const J = (v) => JSON.stringify(v);
let film, ai, calls, server, base;

// ---- scripted model ----
const mutate = (v) => {
  if (typeof v === "string") return v.length > 6 && !v.includes("[revised]") ? `${v} [revised]` : v;
  if (Array.isArray(v)) return v.map(mutate);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === "type" ? x : mutate(x)]));
  return v;
};
function mockModels(over = {}) {
  calls = [];
  return {
    async json(draft, agent, prompt, opts) {
      calls.push({ agent, module: draft.module, kind: prompt.includes("routing step") ? "classify" : prompt.includes("Sort EVERY piece") ? "impact" : prompt.includes("REVISED DRAFT") ? "proposal" : prompt.includes("CURRENT (JSON)") || prompt.includes("CURRENT TEXT") ? "rewrite" : "other", prompt });
      if (over.json) { const r = await over.json(draft, agent, prompt, opts, calls[calls.length - 1].kind); if (r !== undefined) return r; }
      const kind = calls[calls.length - 1].kind;
      if (kind === "classify") return over.classify ?? { intent: "LOCAL_EDIT", summary: "Edit.", targets: [{ type: "selection" }] };
      if (kind === "impact") {
        const keys = [...prompt.matchAll(/^\[([^\]]+)\] /gm)].map((m) => m[1]);
        const scenes = keys.filter((k) => /^(b\d+s\d+|e\d+s\d+)$/.test(k));
        return over.impact?.(keys, scenes) ?? { modified: scenes.slice(1, 2).map((key) => ({ key, why: "the villain changes here" })), indirect: scenes.slice(2, 3).map((key) => ({ key, why: "refers to the villain" })), removed: [], added: [{ label: "A new confrontation", why: "needed" }] };
      }
      if (kind === "proposal") return over.proposal ?? { summary: "The villain becomes the hero's brother.", revisedSynopsis: "A dancer faces her own brother.", revisedSynopsisHi: "x", seasonArc: "Arc", episodes: [{ index: 1, title: "E1", synopsis: "Brother appears." }, { index: 2, title: "E2", synopsis: "Brother returns." }], sequenceOutline: [{ label: "Act 2", change: "brother reveal" }] };
      if (kind === "rewrite") {
        const m = /CURRENT \(JSON\):\n([\s\S]*?)\n\nReturn JSON only/.exec(prompt);
        if (m) return mutate(JSON.parse(m[1]));
        return { text: "A rewritten idea." };
      }
      return {};
    },
  };
}
const scene = (h, text, line = "Stay back.") => ({ sceneHeading: { en: h, hi: h }, content: [{ type: "action", text: { en: text, hi: text } }, { type: "dialogue", character: "RAHUL", text: { en: line, hi: line } }] });

async function fixtures() {
  await db.query("DELETE FROM concepts WHERE title LIKE '[DA-TEST]%'");
  await db.query("DELETE FROM ai_movie_projects WHERE title LIKE '[DA-TEST]%'");
  // Film: a SERIES with two episodes
  film = (await db.query("INSERT INTO concepts (concept_text, storylines, title) VALUES ($1,$2,$3) RETURNING id", ["A keeper fights smugglers.", J([{ title: { en: "The Last Light" } }]), "[DA-TEST] Film"])).rows[0].id;
  const deck = (await db.query("INSERT INTO pitch_decks (concept_id, content, status) VALUES ($1,$2,'approved') RETURNING id", [film, J({ logline: { en: "An old keeper fights smugglers.", hi: "x" }, premise: { en: "Smugglers and a storm." } })])).rows[0].id;
  await db.query("INSERT INTO character_sheets (pitch_deck_id, content, status) VALUES ($1,$2,'approved')", [deck, J([{ name: "Harbinder", want: { en: "peace" } }])]);
  const act = (await db.query("INSERT INTO three_act_structures (pitch_deck_id, content, status) VALUES ($1,$2,'locked') RETURNING id", [deck, J([{ actName: { en: "Act One" }, description: { en: "Smugglers arrive." } }])])).rows[0].id;
  const bits = (await db.query("INSERT INTO bit_sheets (three_act_structure_id, content, status) VALUES ($1,$2,'approved') RETURNING id", [act, J({ bits: [{ title: { en: "First boat" } }] })])).rows[0].id;
  const list = (await db.query("INSERT INTO scene_lists (bit_sheet_id, content, status) VALUES ($1,$2,'approved') RETURNING id", [bits, J({ scenes: [{ oneLiner: { en: "A lantern at sea." } }] })])).rows[0].id;
  const sc = (ep, i, h, t) => db.query("INSERT INTO screenplay_scenes (scene_list_id, episode_index, scene_index, content) VALUES ($1,$2,$3,$4)", [list, ep, i, J({ heading: h, elements: [{ type: "action", text: t }, { type: "dialogue", character: "HARBINDER", text: "Stay back." }] })]);
  await sc(0, 0, "EXT. HARBOUR - NIGHT", "A lantern bobs in the dark.");
  await sc(0, 1, "INT. LIGHTHOUSE - DAWN", "Harbinder climbs the stairs.");
  await sc(1, 0, "EXT. CLIFF - DAY", "The smugglers return with a stranger.");
  await sc(1, 1, "INT. CELLAR - NIGHT", "A map is unrolled.");
  const backfill = {
    story: { title: { en: "Storm Dancer" } }, synopsis: { logline: { en: "A dancer defies a cyclone.", hi: "x" }, premise: { en: "A village temple stands in a storm's path." } },
    characterArc: [{ name: "Mala", arc: { en: "fear to courage" } }, { name: "Villain", arc: { en: "pride to ruin" } }], threeAct: [{ actName: { en: "Act One" }, description: { en: "The warning." } }], plot: [{ title: { en: "The gust" }, description: { en: "Wind rises." } }],
    screenplayBeats: [{ status: "approved", scenes: [scene("EXT. TEMPLE - DAY", "Mala dances before the storm."), scene("INT. TEMPLE - NIGHT", "Wind shakes the doors."), scene("EXT. VILLAGE - DAWN", "The villain watches the sea.")] }, { status: "approved", scenes: [scene("INT. HALL - DAY", "The villain confronts Mala.")] }],
  };
  ai = (await db.query("INSERT INTO ai_movie_projects (title, pasted_text, backfill, assets, stage_status) VALUES ($1,$2,$3,$4,$5) RETURNING id", ["[DA-TEST] AI", "A dancer fights a cyclone.", J(backfill), J({}), J({ story: { status: "approved" }, synopsis: { status: "approved" }, characterArc: { status: "approved" }, threeAct: { status: "approved" }, plot: { status: "approved" }, screenplay: { status: "approved" } })])).rows[0].id;
}
const MODS = () => [["ai_movie", () => ai], ["film", () => film]];
const rowText = async (module, ref, key) => J((await readUnit(db, module, ref, key))?.value);
const unitHashes = async (module, ref) => J((await draftUnits(db, module, ref)).map((u) => [u.key, u.hash]));
const sceneKeys = async (module, ref) => (await draftUnits(db, module, ref)).filter((u) => u.section === "screenplay").map((u) => u.key);

test.before(async () => {
  for (const sql of [
    `CREATE TABLE IF NOT EXISTS concepts (id SERIAL PRIMARY KEY, concept_text TEXT NOT NULL, storylines JSONB NOT NULL, title TEXT, pinned BOOLEAN NOT NULL DEFAULT false, project_type TEXT NOT NULL DEFAULT 'story', clapboard_banner_path TEXT, owner_user_id INTEGER, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
    `CREATE TABLE IF NOT EXISTS pitch_decks (id SERIAL PRIMARY KEY, concept_id INTEGER REFERENCES concepts(id) ON DELETE CASCADE, content JSONB NOT NULL, status TEXT NOT NULL DEFAULT 'pending', feedback TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
    `CREATE TABLE IF NOT EXISTS character_sheets (id SERIAL PRIMARY KEY, pitch_deck_id INTEGER REFERENCES pitch_decks(id) ON DELETE CASCADE, content JSONB NOT NULL, status TEXT NOT NULL DEFAULT 'pending', feedback TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
    `CREATE TABLE IF NOT EXISTS three_act_structures (id SERIAL PRIMARY KEY, pitch_deck_id INTEGER REFERENCES pitch_decks(id) ON DELETE CASCADE, content JSONB NOT NULL, status TEXT NOT NULL DEFAULT 'pending', feedback TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
    `CREATE TABLE IF NOT EXISTS bit_sheets (id SERIAL PRIMARY KEY, three_act_structure_id INTEGER REFERENCES three_act_structures(id) ON DELETE CASCADE, content JSONB NOT NULL, status TEXT NOT NULL DEFAULT 'pending', feedback TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
    `CREATE TABLE IF NOT EXISTS scene_lists (id SERIAL PRIMARY KEY, bit_sheet_id INTEGER REFERENCES bit_sheets(id) ON DELETE CASCADE, three_act_structure_id INTEGER, concept_id INTEGER REFERENCES concepts(id) ON DELETE CASCADE, content JSONB NOT NULL, status TEXT NOT NULL DEFAULT 'pending', feedback TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
    `CREATE TABLE IF NOT EXISTS screenplay_scenes (id SERIAL PRIMARY KEY, scene_list_id INTEGER REFERENCES scene_lists(id) ON DELETE CASCADE, episode_index INTEGER, scene_index INTEGER NOT NULL, content JSONB NOT NULL, status TEXT NOT NULL DEFAULT 'pending', feedback TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
    `CREATE TABLE IF NOT EXISTS ai_movie_projects (id SERIAL PRIMARY KEY, title TEXT, pasted_text TEXT NOT NULL, detected_stage TEXT, backfill JSONB, assets JSONB, stage_status JSONB NOT NULL DEFAULT '{}', created_by INTEGER, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
    `CREATE TABLE IF NOT EXISTS ai_movie_reference_files (id SERIAL PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES ai_movie_projects(id) ON DELETE CASCADE, category TEXT NOT NULL DEFAULT 'other', label TEXT, content TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  ]) await db.query(sql);
  assert.deepEqual(await ensureAllProductionSchemas(db), []);
});
test.beforeEach(fixtures);
test.after(async () => { server?.close(); await db.query("DELETE FROM concepts WHERE title LIKE '[DA-TEST]%'"); await db.query("DELETE FROM ai_movie_projects WHERE title LIKE '[DA-TEST]%'"); await db.end(); });

test("intent routing: the model recommends, the words can only make it more careful, nothing is executed, locked drafts are flagged, money limit stops it", async () => {
  for (const [module, ref] of MODS()) {
    const d = await ensureDraftFor(db, module, ref());
    const before = await unitHashes(module, ref());
    const units = await draftUnits(db, module, ref());
    const sel = units.find((u) => u.section === "screenplay").text.split("\n")[1].slice(0, 20);
    const a = await interpret(db, mockModels({ classify: { intent: "LOCAL_EDIT", confidence: 0.9, summary: "Make the line more threatening.", targets: [{ type: "selection" }] } }), d.id, { instruction: "Rewrite this dialogue to feel more threatening.", context: { selectedText: sel, stage: "screenplay" } });
    assert.equal(a.intent, "LOCAL_EDIT"); assert.equal(a.executesNothing, true); assert.equal(a.targets.length, 1, `${module}: the selection is found in exactly one scene`);
    assert.equal(a.needsClarification, false); assert.ok(a.estimate.modelCalls >= 1);
    // a model that says "just edit" to "create a second draft" is overruled toward the careful option
    const b = await interpret(db, mockModels({ classify: { intent: "LOCAL_EDIT", summary: "x", targets: [] } }), d.id, { instruction: "Keep the opening and protagonist, change the villain and create a second draft." });
    assert.equal(b.intent, "NEW_DRAFT");
    assert.equal((await interpret(db, mockModels({ classify: { intent: "SCOPED_REWRITE", summary: "x", targets: [{ type: "scenes", from: 1, to: 2 }] } }), d.id, { instruction: "Rewrite scenes 1-2 and fix anything else affected." })).targets.length, 2);
    assert.equal((await interpret(db, mockModels({ classify: { intent: "ALTERNATIVE", summary: "x", targets: [{ type: "ending" }] } }), d.id, { instruction: "Try an ending where the villain survives." })).intent, "ALTERNATIVE");
    // "the climax" is NOT guessed
    const c = await interpret(db, mockModels({ classify: { intent: "SCOPED_REWRITE", summary: "x", targets: [{ type: "climax" }] } }), d.id, { instruction: "Make the climax bigger." });
    assert.equal(c.needsClarification, true); assert.ok(c.unresolved.some((u) => u.type === "climax")); assert.ok(c.candidates.length >= 3, "candidates to pick from are offered");
    // unclear -> the four choices
    const u = await interpret(db, mockModels({ classify: { intent: "UNCLEAR", summary: "?", targets: [] } }), d.id, { instruction: "Make it better." });
    assert.equal(u.needsClarification, true); assert.deepEqual(u.options.map((o) => o.label), ["Edit current draft", "Create new draft", "Explore alternative", "Start new story"]);
    // model down: the wording still routes safely
    const f = await interpret(db, mockModels({ json: () => { throw new Error("model down"); } }), d.id, { instruction: "Create an entirely different story." });
    assert.equal(f.intent, "NEW_STORY"); assert.equal(f.usedModel, false); assert.ok(f.modelError);
    // locked drafts are flagged before any work
    await updateDraft(db, d.id, { status: "locked" });
    const l = await interpret(db, mockModels({ classify: { intent: "LOCAL_EDIT", summary: "x", targets: [{ type: "selection" }] } }), d.id, { instruction: "Rewrite this line.", context: { selectedText: sel } });
    assert.equal(l.draft.editable, false); assert.match(l.draft.message, /locked/);
    await updateDraft(db, d.id, { status: "working" });
    // the money limit propagates (nothing is hidden)
    await assert.rejects(interpret(db, mockModels({ json: () => { throw Object.assign(new Error("over the money limit"), { status: 402 }); } }), d.id, { instruction: "Rewrite this line.", context: { selectedText: sel } }), /money limit/);
    await assert.rejects(interpret(db, mockModels(), d.id, { instruction: "   " }), /Say or type/);
    assert.equal(await unitHashes(module, ref()), before, `${module}: routing changed nothing`);
  }
  assert.equal(heuristicIntent("continue my unfinished screenplay"), "CONTINUE");
  assert.equal(heuristicIntent("what if the villain survives"), "ALTERNATIVE");
  const r = resolveTargets([{ section: "screenplay", key: "b0s0", label: "S1", text: "x" }], [{ type: "scene", from: 9 }], "scene 9");
  assert.equal(r.unresolved.length, 1);
  assert.match(classifyPrompt("hi", { stage: "screenplay" }, { status: "working", draft_number: 1 }, []), /INSTRUCTION \(verbatim\)/);
});

test("LOCAL_EDIT in BOTH modules: confirm -> preview -> apply changes only the chosen scene; no new draft; the parent copy is untouched; undo; double apply; stale and locked refusals", async () => {
  for (const [module, ref] of MODS()) {
    const d = await ensureDraftFor(db, module, ref());
    const copy = await branchDraft(db, d.id); // a sibling draft that must never change
    const copyBefore = await unitHashes(module, copy.project_ref);
    const keys = await sceneKeys(module, ref());
    const target = keys[1];
    const before = await unitHashes(module, ref());
    const models = mockModels();
    await assert.rejects(propose(db, models, d.id, { instruction: "More threatening.", intent: "LOCAL_EDIT", targetKeys: [target] }), /Confirm the action first/);
    assert.equal(calls.length, 0, "nothing was sent to the AI before confirmation");
    const cs = await propose(db, models, d.id, { instruction: "More threatening.", intent: "LOCAL_EDIT", targetKeys: [target], confirmed: true, actorUserId: 1 });
    assert.equal(cs.status, "proposed"); assert.equal(cs.changes, 1);
    assert.match(cs.edits[0].afterText, /\[revised\]/); assert.doesNotMatch(cs.edits[0].beforeText, /\[revised\]/);
    assert.equal(await unitHashes(module, ref()), before, `${module}: a preview changes nothing`);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM project_drafts WHERE group_id = $1", [d.group_id])).rows[0].n, 2, "no new draft was made");
    const applied = await applyChangeSet(db, cs.id, { confirmEditApproved: true }); // the fixture draft is approved, so an edit needs this confirmation
    assert.equal(applied.status, "applied");
    const after = await draftUnits(db, module, ref());
    const was = JSON.parse(before);
    for (const u of after) assert.equal(u.hash === was.find((x) => x[0] === u.key)?.[1], u.key !== target, `${module}: only ${target} changed (${u.key})`);
    assert.equal(await unitHashes(module, copy.project_ref), copyBefore, "the other draft is untouched");
    assert.equal((await applyChangeSet(db, cs.id, { confirmEditApproved: true })).status, "applied", "pressing Apply twice changes nothing more");
    if (module === "film") assert.ok((await db.query("SELECT count(*)::int AS n FROM screenplay_scenes ss JOIN scene_lists sl ON sl.id = ss.scene_list_id JOIN bit_sheets b ON b.id = sl.bit_sheet_id JOIN three_act_structures t ON t.id = b.three_act_structure_id JOIN pitch_decks p ON p.id = t.pitch_deck_id WHERE p.concept_id = $1", [film])).rows[0].n === 5, "Film keeps the old scene version as history");
    await undoChangeSet(db, cs.id);
    assert.equal(await unitHashes(module, ref()), before, `${module}: undo restores the scene exactly`);
    await assert.rejects(undoChangeSet(db, cs.id), /Only an applied change/);
    // stale: the scene is edited between preview and apply
    const cs2 = await propose(db, models, d.id, { instruction: "More threatening.", intent: "LOCAL_EDIT", targetKeys: [target], confirmed: true });
    const raw = await readUnit(db, module, ref(), target);
    const { writeUnit } = await import("../draftAgent.js");
    await writeUnit(db, module, ref(), target, mutate(mutate(raw.value)).constructor === Object ? JSON.parse(J(raw.value).replace("Stay back.", "A person's own edit.")) : raw.value);
    await assert.rejects(applyChangeSet(db, cs2.id, { confirmEditApproved: true }), /changed after this preview/);
    assert.equal((await db.query("SELECT status FROM draft_change_sets WHERE id = $1", [cs2.id])).rows[0].status, "stale");
    assert.match(await rowText(module, ref(), target), /A person's own edit/, "the person's edit was not overwritten");
    // locked / approved
    const cs3 = await propose(db, models, d.id, { instruction: "x", intent: "LOCAL_EDIT", targetKeys: [keys[0]], confirmed: true });
    await updateDraft(db, d.id, { status: "locked" });
    await assert.rejects(applyChangeSet(db, cs3.id), /locked/);
    await assert.rejects(propose(db, models, d.id, { instruction: "x", intent: "LOCAL_EDIT", targetKeys: [keys[0]], confirmed: true }), /locked/);
    await updateDraft(db, d.id, { status: "approved" });
    await assert.rejects(applyChangeSet(db, cs3.id), /approved/);
    assert.equal((await applyChangeSet(db, cs3.id, { confirmEditApproved: true })).status, "applied");
    const cs4 = await propose(db, models, d.id, { instruction: "x", intent: "LOCAL_EDIT", targetKeys: [keys[0]], confirmed: true });
    assert.equal((await rejectChangeSet(db, cs4.id)).status, "rejected");
    await assert.rejects(propose(db, models, d.id, { instruction: "x", intent: "NEW_DRAFT", targetKeys: [keys[0]], confirmed: true }), /Only LOCAL_EDIT/);
  }
});

test("SCOPED_REWRITE touches exactly the chosen range (AI Movie and Film); a model answer that breaks the structure changes nothing and is reported", async () => {
  for (const [module, ref] of MODS()) {
    const d = await ensureDraftFor(db, module, ref());
    const keys = await sceneKeys(module, ref());
    const before = await unitHashes(module, ref());
    const cs = await propose(db, mockModels(), d.id, { instruction: "Raise the stakes.", intent: "SCOPED_REWRITE", targetKeys: keys.slice(0, 3), confirmed: true });
    assert.equal(cs.changes, 3);
    await applyChangeSet(db, cs.id, { confirmEditApproved: true });
    const now = JSON.parse(await unitHashes(module, ref())), was = JSON.parse(before);
    assert.deepEqual(now.filter((x, i) => x[1] !== was[i][1]).map((x) => x[0]), keys.slice(0, 3));
    const bad = await propose(db, mockModels({ json: (draft, a, p, o, kind) => (kind === "rewrite" ? { nonsense: true } : undefined) }), d.id, { instruction: "x", intent: "SCOPED_REWRITE", targetKeys: [keys[3]], confirmed: true });
    assert.equal(bad.changes, 0); assert.match(bad.failures[0].message, /did not keep the required structure/);
    await assert.rejects(propose(db, mockModels(), d.id, { instruction: "x", intent: "SCOPED_REWRITE", targetKeys: Array.from({ length: 13 }, (_, i) => keys[0] + i), confirmed: true }), /Choose what to change|or fewer/);
    await assert.rejects(propose(db, null, d.id, { instruction: "x", intent: "SCOPED_REWRITE", targetKeys: [keys[0]], confirmed: true }), /not available/);
  }
  assert.deepEqual(conform({ a: 1, b: { en: "x" } }, { a: 2, b: { en: "y" }, extra: 9 }), { a: 2, b: { en: "y" } });
  assert.equal(conform({ a: 1 }, [1]), null);
  assert.equal(conform("text", { text: "new" }), "new");
});

test("ALTERNATIVE: a trial copy with no draft number; the preview is made inside it; the original never changes; promote it later", async () => {
  for (const [module, ref] of MODS()) {
    const d = await ensureDraftFor(db, module, ref());
    const before = await unitHashes(module, ref());
    const keys = await sceneKeys(module, ref());
    await assert.rejects(startAlternative(db, mockModels(), d.id, { instruction: "Try an ending where the villain survives.", targetKeys: keys.slice(-1) }), /Confirm first/);
    const r = await startAlternative(db, mockModels(), d.id, { instruction: "Try an ending where the villain survives.", targetKeys: keys.slice(-1), confirmed: true });
    assert.equal(r.alternative.kind, "alternative"); assert.equal(r.alternative.draft_number, null);
    assert.equal(r.changeSet.draftId, r.alternative.id, "the preview belongs to the alternative");
    assert.equal(await unitHashes(module, ref()), before, "the original draft is untouched");
    await applyChangeSet(db, r.changeSet.id, { confirmEditApproved: true }); // applies inside the alternative
    assert.equal(await unitHashes(module, ref()), before);
    assert.notEqual(await unitHashes(module, r.alternative.project_ref), before);
    const { promoteAlternative } = await import("../drafts.js");
    assert.equal((await promoteAlternative(db, r.alternative.id)).draft_number, 2);
  }
});

test("NEW_DRAFT in BOTH modules: copy -> impact map -> revised synopsis -> STOP; changes to the synopsis start nothing; approval starts the selective rewrite; the original never changes", async () => {
  for (const [module, ref] of MODS()) {
    const d = await ensureDraftFor(db, module, ref());
    const parentBefore = await unitHashes(module, ref());
    const models = mockModels();
    await assert.rejects(startRevision(db, models, d.id, { instruction: "Keep the opening and protagonist; change the villain.", constraints: { mustKeep: ["the opening"] } }), /Confirm first/);
    const { request, draft } = await startRevision(db, models, d.id, { instruction: "Keep the opening and protagonist; change the villain and the central conflict.", constraints: { mustKeep: ["the opening"], mustChange: ["the villain"] }, source: "mic", confirmed: true, actorUserId: 1 });
    assert.equal(request.status, "analyzing"); assert.equal(draft.draft_number, 2); assert.equal(draft.parent_draft_id, d.id);
    await whenIdle(request.id);
    let r = await getRequest(db, request.id);
    assert.equal(r.status, "awaiting_synopsis_approval", `${module}: it STOPS here`);
    assert.equal(r.instruction, "Keep the opening and protagonist; change the villain and the central conflict.", "the original instruction is kept verbatim");
    assert.equal(r.source, "mic"); assert.deepEqual(r.constraints.mustKeep, ["the opening"]);
    assert.ok(r.impact_map.counts.modified >= 1 && r.impact_map.counts.unchanged >= 1 && r.impact_map.counts.added === 1);
    assert.ok(r.proposal.revisedSynopsis);
    if (module === "film") { assert.equal(r.proposal.series, true); assert.ok(r.proposal.episodes.length >= 1, "a series gets a revised synopsis per affected episode"); assert.ok(r.proposal.seasonArc); }
    else { assert.equal(r.proposal.series, false); assert.ok(r.proposal.sequenceOutline.length >= 1, "a film gets a synopsis and a sequence outline"); }
    const rewritesSoFar = calls.filter((c) => c.kind === "rewrite").length;
    assert.equal(rewritesSoFar, 0, "no screenplay rewriting before approval");
    assert.equal(await unitHashes(module, draft.project_ref), parentBefore, "the new draft is still an exact copy");
    assert.equal(await unitHashes(module, ref()), parentBefore);
    assert.equal((await getDraft(db, draft.id)).status, "pending_approval"); assert.equal((await getDraft(db, draft.id)).current_stage, "synopsis_review");
    // wrong-state calls
    await assert.rejects(approveFinal(db, request.id), /not waiting for final approval/);
    // reject / request changes: re-proposes, still nothing downstream
    await assert.rejects(requestSynopsisChanges(db, models, request.id, { feedback: "" }), /Say what should change/);
    await requestSynopsisChanges(db, models, request.id, { feedback: "Make the villain her mentor instead." });
    await whenIdle(request.id);
    r = await getRequest(db, request.id);
    assert.equal(r.status, "awaiting_synopsis_approval"); assert.deepEqual(r.proposal.feedbackHistory, ["Make the villain her mentor instead."]);
    assert.ok(calls.some((c) => c.kind === "proposal" && /mentor/.test(c.prompt)), "the feedback reached the planner");
    assert.equal(calls.filter((c) => c.kind === "rewrite").length, 0, "still no downstream rewrite after a change request");
    assert.equal(calls.filter((c) => c.kind === "impact").length, 1, "the impact map is reused, not paid for again");
    // stale approval refused
    await assert.rejects(approveSynopsis(db, models, request.id, { expectedRevision: r.revision - 1 }), /changed since you loaded/);
    // approve -> rewrite
    await approveSynopsis(db, models, request.id, { expectedRevision: r.revision, actorUserId: 1 });
    assert.equal((await getRequest(db, request.id)).status, "rewriting");
    await whenIdle(request.id);
    r = await getRequest(db, request.id);
    assert.equal(r.status, "awaiting_final_approval");
    const touched = r.impact_map.modified.concat(r.impact_map.indirect).map((x) => x.key);
    const nowUnits = JSON.parse(await unitHashes(module, draft.project_ref)), wasUnits = JSON.parse(parentBefore);
    const changedKeys = nowUnits.filter((x) => (wasUnits.find((w) => w[0] === x[0]) ?? [])[1] !== x[1]).map((x) => x[0]);
    assert.ok(touched.every((k) => changedKeys.includes(k)), `${module}: every marked piece was rewritten`);
    assert.ok(changedKeys.includes("synopsis"), "the approved synopsis was applied");
    assert.ok(wasUnits.filter((w) => !touched.includes(w[0]) && w[0] !== "synopsis").every((w) => nowUnits.find((x) => x[0] === w[0])?.[1] === w[1]), "unaffected pieces are preserved byte for byte");
    assert.equal(await unitHashes(module, ref()), parentBefore, "Draft 1 never changed");
    assert.ok(r.impact_map.manual.some((m) => /New: A new confrontation/.test(m)), "pieces that cannot be created safely are listed for the writer");
    const detail = await revisionDetail(db, request.id);
    assert.equal(detail.comparison.counts.modified, changedKeys.length); assert.ok(detail.comparison.counts.preserved >= 1);
    const cmp = await compareDrafts(db, d.id, draft.id);
    assert.equal(cmp.counts.modified, changedKeys.length);
    // final approval
    const fin = await approveFinal(db, request.id, { expectedRevision: r.revision, actorUserId: 1 });
    assert.equal(fin.request.status, "completed"); assert.ok(["working", "approved"].includes((await getDraft(db, draft.id)).status));
    assert.equal((await getDraft(db, draft.id)).approval.status, "accepted");
    await assert.rejects(cancelRequest(db, request.id), /already completed/);
  }
});

test("rewritten AI Movie / Film pieces are marked for review (not silently approved)", async () => {
  const d = await ensureDraftFor(db, "ai_movie", ai);
  const { request, draft } = await startRevision(db, mockModels(), d.id, { instruction: "Change the villain.", confirmed: true });
  await whenIdle(request.id);
  await approveSynopsis(db, mockModels(), request.id);
  await whenIdle(request.id);
  const p = (await db.query("SELECT stage_status, backfill FROM ai_movie_projects WHERE id = $1", [draft.project_ref])).rows[0];
  assert.equal(p.stage_status.synopsis.status, "pending");
  assert.equal(p.stage_status.screenplay, undefined, "the screenplay needs re-approval");
  assert.ok(p.backfill.screenplayBeats.some((b) => b.status === "pending"));
  const parent = (await db.query("SELECT stage_status FROM ai_movie_projects WHERE id = $1", [ai])).rows[0];
  assert.equal(parent.stage_status.screenplay.status, "approved", "Draft 1 stays approved");
  const f = await ensureDraftFor(db, "film", film);
  const fr = await startRevision(db, mockModels(), f.id, { instruction: "Change the villain.", confirmed: true });
  await whenIdle(fr.request.id); await approveSynopsis(db, mockModels(), fr.request.id); await whenIdle(fr.request.id);
  const deck = (await db.query("SELECT status FROM pitch_decks WHERE concept_id = $1", [fr.draft.project_ref])).rows[0];
  assert.equal(deck.status, "pending", "Film: the revised synopsis needs approval again");
  assert.equal((await db.query("SELECT status FROM pitch_decks WHERE concept_id = $1", [film])).rows[0].status, "approved");
});

test("cancel archives the copy (kept for the record) and the original is untouched; failures can be retried and finished pieces are not redone; restarts mark running requests failed", async () => {
  for (const [module, ref] of MODS()) {
    const d = await ensureDraftFor(db, module, ref());
    const before = await unitHashes(module, ref());
    const a = await startRevision(db, mockModels(), d.id, { instruction: "Change the villain.", confirmed: true });
    await whenIdle(a.request.id);
    const c = await cancelRequest(db, a.request.id);
    assert.equal(c.status, "cancelled"); assert.equal((await getDraft(db, a.draft.id)).status, "archived");
    assert.equal(await unitHashes(module, ref()), before);
    await assert.rejects(cancelRequest(db, a.request.id), /already cancelled/);
    // a failure during the rewrite (here: the money limit) leaves a clear failed state; Retry resumes without redoing finished pieces
    let rewrites = 0, failAt = 2;
    const flaky = mockModels({ json: (dr, ag, p, o, kind) => { if (kind === "rewrite" && ++rewrites === failAt) throw Object.assign(new Error("This would cost about $0.12, but only $0.00 is left."), { status: 402 }); return undefined; } });
    const b = await startRevision(db, flaky, d.id, { instruction: "Change the villain.", confirmed: true });
    await whenIdle(b.request.id);
    await approveSynopsis(db, flaky, b.request.id);
    await whenIdle(b.request.id);
    let r = await getRequest(db, b.request.id);
    assert.equal(r.status, "failed"); assert.match(r.error, /\$0\.12/);
    const doneBefore = r.decisions.filter((x) => x.status === "done").map((x) => x.key);
    assert.ok(doneBefore.length >= 1);
    failAt = 999;
    await retryRequest(db, flaky, b.request.id);
    await whenIdle(b.request.id);
    r = await getRequest(db, b.request.id);
    assert.equal(r.status, "awaiting_final_approval");
    const keysDone = r.decisions.filter((x) => x.status === "done").map((x) => x.key);
    assert.equal(new Set(keysDone).size, keysDone.length, "no piece was rewritten twice");
    assert.ok(doneBefore.every((k) => keysDone.includes(k)));
    await assert.rejects(retryRequest(db, flaky, b.request.id), /Only a failed request/);
    assert.equal(await unitHashes(module, ref()), before);
  }
  const d = await ensureDraftFor(db, "ai_movie", ai);
  const never = new Promise(() => {});
  const stuck = await startRevision(db, mockModels({ json: () => never }), d.id, { instruction: "Change the villain.", confirmed: true });
  assert.equal(await failInterruptedRequests(db), 1);
  assert.equal((await getRequest(db, stuck.request.id)).status, "failed");
});

test("new story: choose same project (a draft on the dashboard) or a new project; the current draft is untouched; both modules", async () => {
  for (const [module, ref] of MODS()) {
    const d = await ensureDraftFor(db, module, ref());
    const row = await getDraft(db, d.id);
    const before = await unitHashes(module, ref());
    await assert.rejects(createBlank(db, row, { destination: "same_project", idea: "  " }), /Write the new story idea/);
    const same = await createBlank(db, row, { destination: "same_project", idea: "A robot learns to paint." });
    assert.equal(same.draft.draftNumber, 2); assert.equal(same.draft.currentStage, "idea");
    const diff = await createBlank(db, row, { destination: "new_project", idea: "A chef solves a murder." });
    assert.equal(diff.draft.draftNumber, 1); assert.notEqual(diff.draft.groupId, row.group_id, "a new project has its own drafts");
    assert.equal(await unitHashes(module, ref()), before);
    assert.equal((await draftUnits(db, module, same.projectRef))[0].text, "A robot learns to paint.");
  }
});

test("production safety (AI Movie): Draft 2's changes are classified against Draft 1's production work; nothing is reused or touched", async () => {
  const d = await ensureDraftFor(db, "ai_movie", ai);
  await analyzeScreenplay(db, ai);
  const shots = await db.query("SELECT id FROM production_scenes WHERE project_id = $1 ORDER BY order_index", [ai]);
  assert.ok(shots.rowCount >= 3);
  const parentProduction = J((await db.query("SELECT code, source_key, content_hash, revision FROM production_scenes WHERE project_id = $1 ORDER BY id", [ai])).rows);
  assert.equal((await productionImpact(db, d.id)).applicable, false);
  const { request, draft } = await startRevision(db, mockModels(), d.id, { instruction: "Change the villain.", confirmed: true });
  await whenIdle(request.id); await approveSynopsis(db, mockModels(), request.id); await whenIdle(request.id);
  const impact = await productionImpact(db, draft.id);
  assert.equal(impact.applicable, true);
  assert.ok(impact.counts.reusable >= 1 && impact.counts.needs_review >= 1, JSON.stringify(impact.counts));
  assert.equal(impact.overall, "needs_review");
  assert.ok(impact.classes.reusable.every((x) => x.change === "preserved"));
  assert.equal(impact.guarantees.length, 2);
  assert.equal(J((await db.query("SELECT code, source_key, content_hash, revision FROM production_scenes WHERE project_id = $1 ORDER BY id", [ai])).rows), parentProduction, "Draft 1's production records are exactly as before");
  assert.equal((await db.query("SELECT count(*)::int AS n FROM production_scenes WHERE project_id = $1", [draft.project_ref])).rows[0].n, 0, "Draft 2 has no production records of its own until its screenplay is approved");
  const f = await ensureDraftFor(db, "film", film);
  assert.equal((await productionImpact(db, f.id)).applicable, false);
});

test("routes: the whole flow over HTTP for both modules, with plain errors", async () => {
  const app = express();
  app.use(express.json());
  registerDraftAgentRoutes(app, db, requireRole, { models: mockModels() });
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  const http = async (method, url, body) => { const r = await fetch(`${base}${url}`, { method, headers: { "Content-Type": "application/json" }, body: body ? J(body) : undefined }); return { status: r.status, json: await r.json().catch(() => null) }; };
  for (const [module, ref] of MODS()) {
    const d = await ensureDraftFor(db, module, ref());
    const keys = await sceneKeys(module, ref());
    const i = await http("POST", `/api/drafts/${d.id}/agent/interpret`, { instruction: "Rewrite scene 1 to be darker.", source: "pen", context: { stage: "screenplay" } });
    assert.equal(i.status, 200); assert.equal(i.json.executesNothing, true);
    assert.equal((await http("POST", `/api/drafts/${d.id}/agent/interpret`, { instruction: "" })).status, 400);
    assert.equal((await http("POST", `/api/drafts/${d.id}/agent/propose`, { instruction: "x", targetKeys: [keys[0]] })).status, 409);
    const p = await http("POST", `/api/drafts/${d.id}/agent/propose`, { instruction: "Darker.", intent: "LOCAL_EDIT", targetKeys: [keys[0]], confirmed: true });
    assert.equal(p.status, 201);
    assert.equal((await http("POST", `/api/drafts/change-sets/${p.json.changeSet.id}/apply`, { confirmEditApproved: true })).json.changeSet.status, "applied");
    assert.equal((await http("POST", `/api/drafts/change-sets/${p.json.changeSet.id}/undo`, {})).json.changeSet.status, "undone");
    assert.equal((await http("GET", `/api/drafts/${d.id}/agent/change-sets`)).json.changeSets.length, 1);
    const rev = await http("POST", `/api/drafts/${d.id}/agent/revision`, { instruction: "Change the villain.", confirmed: true });
    assert.equal(rev.status, 202);
    await whenIdle(rev.json.request.id);
    const det = await http("GET", `/api/drafts/requests/${rev.json.request.id}`);
    assert.equal(det.json.request.status, "awaiting_synopsis_approval"); assert.ok(det.json.comparison);
    assert.equal((await http("POST", `/api/drafts/requests/${rev.json.request.id}/approve`, {})).status, 409, "final approval before the synopsis gate is refused");
    assert.equal((await http("POST", `/api/drafts/requests/${rev.json.request.id}/cancel`, {})).json.request.status, "cancelled");
    assert.equal((await http("POST", `/api/drafts/${d.id}/agent/new-story`, { idea: "x" })).status, 400);
    assert.equal((await http("POST", `/api/drafts/${d.id}/agent/continue`, {})).json.module, module);
    assert.equal((await http("GET", `/api/drafts/${d.id}/production-impact`)).status, 200);
    assert.equal((await http("GET", "/api/drafts/requests/999999")).status, 404);
  }
});
