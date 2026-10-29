import test from "node:test";
import assert from "node:assert/strict";
import { parseEpisodesFromText } from "../screenplayImport.js";
import { numberKey, planFill, samePlace } from "../pdfFill.js";

const text = (v) => ({ en: v, or: v, hi: v });
const outline = (n, intExt, place, time = "NIGHT") => ({ sceneNumber: String(n), intExt, location: text(place), timeOfDay: time, oneLiner: text("x"), estimatedMinutes: 1 });

const PDF = `SCENE 1
INT. TEMPLE COMMITTEE OFFICE - NIGHT
ବଳରାମ ଚାହିଁ ରହିଛି।
BALARAM
ମନ୍ଦିର ଜମି ଦେଇଦିଅ।
SCENE 2
EXT. OLD KALI TEMPLE - NIGHT
ସେମାନେ ମନ୍ଦିରରେ ପଶିଲେ।
SCENE 3
EXT. VILLAGE ROAD - NIGHT
ଦେବା ଡରୁଛି।
DEBA
କିଏ ଅଛୁ?`;

test("places and numbers are compared sensibly", () => {
  assert.ok(samePlace("TEMPLE COMMITTEE OFFICE", text("Temple Committee Office")));
  assert.ok(samePlace("OLD KALI TEMPLE", text("Kali Temple")));
  assert.ok(!samePlace("VILLAGE ROAD", text("Kali Temple")));
  assert.equal(numberKey("E2S5"), "5");
  assert.equal(numberKey("12"), "12");
  assert.equal(numberKey("5A"), "5A");
  assert.equal(numberKey("୩"), "3");
});

test("a film: written PDF scenes are filled into the same scene; a one-liner PDF scene is not; nothing is moved or invented", () => {
  const proj = [{ episodeIndex: null, scenes: [outline(1, "INT", "Temple Committee Office"), outline(2, "EXT", "Old Kali Temple"), outline(3, "EXT", "Village Road")] }];
  const plan = planFill({ projectEpisodes: proj, pdfEpisodes: parseEpisodesFromText(PDF).episodes });
  assert.deepEqual(plan.items.map((i) => [i.pdfNumber, i.action, i.sceneIndex ?? null]), [["1", "fill", 0], ["2", "pdf_one_liner", null], ["3", "fill", 2]]);
  assert.equal(plan.counts.fill, 2);
});

test("a project scene that is already written is skipped unless the writer asks to replace it", () => {
  const proj = [{ episodeIndex: null, scenes: [outline(1, "INT", "Temple Committee Office"), outline(2, "EXT", "Old Kali Temple"), outline(3, "EXT", "Village Road")] }];
  const pdfEpisodes = parseEpisodesFromText(PDF).episodes;
  const keep = planFill({ projectEpisodes: proj, pdfEpisodes, writtenKeys: new Set(["null:0"]) });
  assert.equal(keep.items[0].action, "skip_written");
  assert.equal(keep.counts.skipWritten, 1);
  assert.equal(keep.counts.fill, 1);
  const replace = planFill({ projectEpisodes: proj, pdfEpisodes, writtenKeys: new Set(["null:0"]), replaceWritten: true });
  assert.equal(replace.items[0].action, "fill");
  assert.equal(replace.items[0].replaces, true);
  assert.equal(replace.counts.replace, 1);
});

test("when the project has its scenes in another order, the same place finds the right scene; unsure ones are left alone", () => {
  const proj = [{ episodeIndex: null, scenes: [outline(1, "EXT", "Village Road"), outline(2, "INT", "Temple Committee Office"), outline(3, "INT", "Hospital")] }];
  const plan = planFill({ projectEpisodes: proj, pdfEpisodes: parseEpisodesFromText(PDF).episodes });
  const by = Object.fromEntries(plan.items.map((i) => [i.pdfNumber, i]));
  assert.equal(by["1"].action, "fill");
  assert.equal(by["1"].sceneIndex, 1); // the committee office, wherever it is in the project
  assert.equal(by["3"].action, "fill");
  assert.equal(by["3"].sceneIndex, 0);
  assert.equal(by["2"].action, "pdf_one_liner");
});

test("a scene with a different place and no safe position match is NOT guessed", () => {
  const proj = [{ episodeIndex: null, scenes: [outline(1, "INT", "Hospital"), outline(2, "EXT", "Beach")] }]; // 2 scenes vs 3 in the PDF
  const plan = planFill({ projectEpisodes: proj, pdfEpisodes: parseEpisodesFromText(PDF).episodes });
  assert.equal(plan.counts.fill, 0);
  assert.equal(plan.counts.notSure, 2);
});

test("same place, same position, same count: placed even when the project's spelling of the place differs", () => {
  const proj = [{ episodeIndex: null, scenes: [outline(1, "INT", "Mandir Samiti Karyalaya"), outline(2, "EXT", "Puraana Mandir"), outline(3, "EXT", "Gaon Rasta")] }];
  const plan = planFill({ projectEpisodes: proj, pdfEpisodes: parseEpisodesFromText(PDF).episodes });
  assert.deepEqual(plan.items.map((i) => [i.pdfNumber, i.action]), [["1", "fill"], ["2", "pdf_one_liner"], ["3", "fill"]]);
  assert.match(plan.items[0].how, /same position and number/);
});

test("a series: episodes are matched by their number; an episode the project does not have is reported", () => {
  const series = `EPISODE 1: A
SCENE 1
INT. HOUSE - DAY
ସେ ଘରେ ଅଛି।
MEERA
ମୁଁ ଆସିଲି।
EPISODE 3: C
SCENE 1
EXT. ROAD - DAY
ରାସ୍ତା।
RAVI
ଚାଲ।`;
  const proj = [{ episodeIndex: 0, scenes: [outline(1, "INT", "House", "DAY")] }, { episodeIndex: 1, scenes: [outline(1, "INT", "Shop", "DAY")] }];
  const plan = planFill({ projectEpisodes: proj, pdfEpisodes: parseEpisodesFromText(series).episodes });
  assert.deepEqual(plan.items.map((i) => [i.pdfEpisode, i.action]), [[1, "fill"]]);
  assert.match(plan.warnings.join(" "), /episode 3 that this project does not have/);
});

test("writers may use the PDF fill on their own project's scene list only", async () => {
  const { matchWriterRoute } = await import("../writerAccess.js");
  assert.equal(matchWriterRoute("POST", "/api/scene-lists/12/pdf-fill")?.kind, "sceneList");
  assert.equal(matchWriterRoute("GET", "/api/scene-lists/12/pdf-fill"), null);
});
