// Synopsis mode: the user's story is kept word for word; suggestions only change what the user accepts.
import test from "node:test";
import assert from "node:assert/strict";
import { splitEpisodes, designBibleFromSynopsis, cleanSuggestions, unitParts, applyDecisions, finalizeSynopsisBible, decorateSynopsisBible, currentSynopsis, lockedSynopsisIdea } from "../synopsisBrain.js";

const EP = (n, body) => `Episode ${n}: Title ${n}\n${body}\n\n`;
const BODY = (n) => `In part ${n} Soumya reaches Rambhadipur and meets the village headman near the old temple. ${"The tension rises as the night falls over the fields. ".repeat(3)}Soumya decides to open the sealed door at the end of part ${n}.`;
const SYN = [1, 2, 3].map((n) => EP(n, BODY(n))).join("");

const unitFor = (i) => ({ number: i, title: `T${i}`, coldOpen: "c", question: "q", heroMove: "h", villainMove: "v", clue: "k", falseLead: "f", heroLearns: "l", audienceLearns: "a", setPiece: "s", sideStory: "ss", turn: "t", endingHook: "hook", cliffhangerType: "door", cliffhangerImage: "img", burningQuestion: "who?", audienceTheories: ["a", "b"], nextEpisodePayoff: "n", plants: [], payoffs: [] });
function scriptedAsk(over = {}) {
  const calls = [];
  const ask = async (label, contents) => {
    calls.push(label);
    if (/Reading your synopsis/.test(label)) return {
      promise: { title: "Mahakali", logline: "L", centralQuestion: "Q", genrePromise: "G", whyWow: "W" },
      hiddenTruth: { summary: "s", timeline: [], whoKnowsWhat: [], participants: [] }, namesInOdia: [], characters: [{ name: "Soumya" }], villainPlan: "plan",
      facts: { jobsAndMoney: [], healthAndBodies: [], belongingsAndVehicles: [], places: [], worldRules: [] },
      climax: { setting: "s", reversal: "r", heroChoice: "h", cost: "c", payoffs: [], finalImage: "f", whyWow: "w", resolution: "x" }, setupsPayoffs: [],
      units: [1, 2, 3].map(unitFor),
    };
    if (/Rating your synopsis/.test(label)) return over.rated ?? {
      episodeScores: [{ unit: 1, score: 8, note: "good" }, { unit: 2, score: 6, note: "weak middle" }, { unit: 3, score: 9, note: "great" }],
      suggestions: [
        { unit: 2, severity: "major", why: "The night scene drags", original: "The tension rises as the night falls over the fields.", replacement: "The wind rises and the lights go out." },
        { unit: 1, severity: "minor", why: "Name slip", original: "meets the village headman", replacement: "meets the headman, Bhima" },
        { unit: 3, severity: "minor", why: "invented quote", original: "this sentence is not in the synopsis", replacement: "x" },
      ],
    };
    return { score: 8, verdict: "fine", strengths: [], problems: [] }; // the three critics
  };
  return { ask, calls };
}

test("splitEpisodes finds English, Hindi and Odia headings (with their digits) and keeps the user's words untouched", () => {
  const eng = splitEpisodes(SYN);
  assert.equal(eng.length, 3); assert.equal(eng[1].title, "Title 2"); assert.equal(eng[1].text, BODY(2));
  const hi = splitEpisodes("एपिसोड १: शुरुआत\nपहली कहानी यहाँ है।\n\nएपिसोड २ - दूसरा\nदूसरी कहानी यहाँ है।\n\nएपिसोड ३\nतीसरी कहानी।");
  assert.deepEqual(hi.map((u) => u.number), [1, 2, 3]); assert.equal(hi[0].text, "पहली कहानी यहाँ है।");
  const od = splitEpisodes("ଏପିସୋଡ୍ ୧\nପ୍ରଥମ\n\nଏପିସୋଡ୍ ୨\nଦ୍ୱିତୀୟ");
  assert.equal(od.length, 2);
  assert.equal(splitEpisodes("just a paragraph with no headings at all"), null);
  assert.equal(splitEpisodes(SYN + "\nEpisode 9: stray heading that breaks the sequence\nx").length, 3, "a heading out of sequence is not an episode");
});

test("the Story Bible is built AROUND the user's synopsis: every episode's text is theirs, word for word; it is rated, not rewritten", async () => {
  const { ask, calls } = scriptedAsk();
  const { bible } = await designBibleFromSynopsis(SYN, { type: "series", episodeCount: 8, episodeMinutes: 20 }, { ask });
  assert.equal(bible.synopsisMode, true);
  assert.equal(bible.units.count, 3, "the user's own episode count wins over the form's");
  for (const [i, u] of bible.blueprint.entries()) assert.equal(u.synopsis, BODY(i + 1), `episode ${i + 1} is exactly what the user wrote`);
  assert.ok(!calls.some((l) => /Pitch room|Climax, setups|blueprints|revises/.test(l)), "no new story was designed and nothing was rewritten");
  assert.deepEqual(Object.keys(bible.review.scores).sort(), ["audienceCritic", "cultureExpert", "storyDoctor"]);
  // only suggestions whose words really are in the episode survive
  assert.deepEqual(bible.synopsisReview.suggestions.map((s) => s.id), ["s1", "s2"]);
  assert.ok(bible.synopsisReview.suggestions.every((s) => s.status === "pending"));
  assert.equal(bible.synopsisReview.episodeScores.length, 3);
});

test("colours: unchanged words are 'same' (black); accepted changes are 'changed' and waiting ones 'proposed' (red); rejected ones vanish", async () => {
  const { ask } = scriptedAsk();
  let { bible } = await designBibleFromSynopsis(SYN, { type: "series" }, { ask });
  let u2 = decorateSynopsisBible(bible).blueprint[1];
  assert.deepEqual(u2.parts.map((p) => p.kind), ["same", "proposed", "same"], "a proposal is shown in red before any answer");
  assert.equal(u2.parts.map((p) => (p.kind === "proposed" ? p.was : p.text)).join(""), BODY(2), "with the proposals undone, the text is exactly the user's");
  bible = applyDecisions(bible, { decisions: { s1: "accept", s2: "reject" } });
  u2 = decorateSynopsisBible(bible).blueprint[1];
  assert.deepEqual(u2.parts.map((p) => p.kind), ["same", "changed", "same"], "accepted: shown in red as a change");
  const u1 = decorateSynopsisBible(bible).blueprint[0];
  assert.deepEqual(u1.parts.map((p) => p.kind), ["same"], "rejected: back to the user's words, nothing marked");
  assert.match(bible.blueprint[1].synopsis, /The wind rises and the lights go out\./);
  assert.equal(bible.blueprint[0].synopsis, BODY(1), "a rejected change never reaches the story");
  assert.equal(bible.blueprint[1].synopsisOriginal, BODY(2), "the original is always kept");
});

test("approving finalises: anything the user did not accept is dropped; 'accept all' / 'reject all' work", async () => {
  const { ask } = scriptedAsk();
  const { bible } = await designBibleFromSynopsis(SYN, { type: "series" }, { ask });
  const all = applyDecisions(bible, { all: "accept" });
  assert.ok(all.synopsisReview.suggestions.every((s) => s.status === "accepted"));
  assert.match(all.blueprint[0].synopsis, /Bhima/);
  const none = applyDecisions(bible, { all: "reject" });
  assert.deepEqual(none.blueprint.map((u) => u.synopsis), [BODY(1), BODY(2), BODY(3)]);
  const final = finalizeSynopsisBible(applyDecisions(bible, { decisions: { s2: "accept" } }));
  assert.deepEqual(final.synopsisReview.suggestions.map((s) => s.status), ["rejected", "accepted"], "the unanswered one is dropped");
  assert.equal(final.blueprint[1].synopsis, BODY(2), "the night-scene change was not accepted, so episode 2 is exactly the user's"); assert.match(final.blueprint[0].synopsis, /headman, Bhima near/);
  assert.equal(final.synopsisReview.finalized, true);
});

test("overlapping or invented suggestions are discarded; too-short synopsis is refused with a plain message", async () => {
  const bp = [{ number: 1, synopsisOriginal: "Alpha beta gamma delta. Epsilon zeta eta theta." }];
  const out = cleanSuggestions([
    { unit: 1, original: "Alpha beta gamma", replacement: "A B G" },
    { unit: 1, original: "beta gamma delta", replacement: "overlaps the first" },
    { unit: 1, original: "Epsilon zeta", replacement: "E Z" },
    { unit: 9, original: "x", replacement: "y" },
    { unit: 1, original: "not there", replacement: "y" },
  ], bp);
  assert.deepEqual(out.map((s) => s.original), ["Alpha beta gamma", "Epsilon zeta"]);
  await assert.rejects(designBibleFromSynopsis("too short", { type: "series" }, { ask: scriptedAsk().ask }), /too short/);
  await assert.rejects(designBibleFromSynopsis("x ".repeat(200), { type: "series" }, { ask: async () => ({ episodes: [] }) }), /could not find the episodes/);
  assert.equal(currentSynopsis({ number: 1, synopsisOriginal: "abc def" }, []), "abc def");
  assert.equal(unitParts({ number: 1, synopsisOriginal: "abc" }, []).length, 1);
});

test("every later stage gets the locked synopsis: the user's words with only accepted changes, and the rule that a contradiction is a blocking problem", async () => {
  const { ask } = scriptedAsk();
  const { bible } = await designBibleFromSynopsis(SYN, { type: "series" }, { ask });
  const final = finalizeSynopsisBible(applyDecisions(bible, { decisions: { s2: "accept" } }));
  const text = lockedSynopsisIdea(final);
  assert.match(text, /LOCKED SYNOPSIS MODE/); assert.match(text, /BLOCKING problem/);
  assert.match(text, /Never change the order of events, who lives or dies, any twist/);
  assert.ok(text.includes(BODY(2)), "an episode with no accepted change appears exactly as written");
  assert.ok(text.includes("meets the headman, Bhima"), "the accepted change is in");
  assert.ok(!text.includes("The wind rises and the lights go out."), "the rejected change is nowhere");
  assert.ok(text.indexOf("EPISODE 1") < text.indexOf("EPISODE 2") && text.indexOf("EPISODE 2") < text.indexOf("EPISODE 3"));
});

test("a paste copied from a PDF is READ first: page headers and page numbers never reach the story, and Adu says what he removed", async () => {
  const HEADER = (n) => `DETAILED EPISODE SYNOPSIS / 1999-2026 ${n} MAHA KALI / SEASON 01`;
  const noisy = [1, 2, 3].map((n) => `Episode ${n}: Title ${n}\n${BODY(n).replace("reaches Rambhadipur", `reaches ${HEADER(n * 3)} Rambhadipur`)}\n${n * 3}\nE P I S O D E 0 ${n} / 0 3\n\n`).join("");
  const { ask } = scriptedAsk();
  const { bible } = await designBibleFromSynopsis(noisy, { type: "series" }, { ask });
  for (const u of bible.blueprint) {
    assert.ok(!/DETAILED EPISODE SYNOPSIS|MAHA KALI|SEASON 01|E P I S O D E/.test(u.synopsis), `episode ${u.number} has no page header in it`);
    assert.ok(!/\n?\b\d+\s*$/.test(u.synopsis.replace(/part \d+\.$/, "")), "no page number left at the end");
  }
  assert.equal(bible.blueprint[1].synopsis, BODY(2), "the story itself is exactly the user's words");
  assert.equal(bible.pasteCleanup.changed, true); assert.match(bible.pasteCleanup.summary, /removed \d+ repeated page header/);
});
