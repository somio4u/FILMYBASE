// AI MOVIE → "Write the whole screenplay": ONE background job instead of the beat-by-beat, scene-by-scene hand work.
//
// Until now the screenplay was written four beats ahead, a beat only moved on once it was approved by hand, and the dialogue of a beat could only be asked
// for one scene at a time (a button on every scene). This job does all of it in order, for every beat that is not finished:
//     write the beat's scenes  ->  approve it (marked "approved automatically" so it can still be read and changed)  ->  write the dialogue of every scene of it
// and goes on to the next beat. Beats that are already approved and already have their dialogue are skipped. It runs in the shared background-job machine
// (writeScenesJobs.js, kind "ai-movie-write-all"): the screen follows it with a progress card, it survives a reload and a server restart, and it can be stopped.
//
// Everything that touches the database or the AI is passed in (`deps`), so this file is tested with a scripted writer.

export const WRITE_ALL_KIND = "ai-movie-write-all";

const WAIT_FOR_ANOTHER_WRITER_MS = 12 * 60 * 1000; // the 4-beat background writer may be busy with this very beat
const POLL_MS = 5000;

// a scene has its dialogue once it carries the ordered blocks ("content") — the one authoritative shape
export const sceneHasDialogue = (scene) => Array.isArray(scene?.content) && scene.content.length > 0;

// is this beat finished, as far as this job is concerned?
export function beatIsComplete(beat, { dialogue = true, isSong = false } = {}) {
  if (!beat || beat.status !== "approved" || !Array.isArray(beat.scenes) || beat.scenes.length === 0) return false;
  if (!dialogue || isSong) return true; // a song beat is the song sheet, not spoken dialogue
  return beat.scenes.every(sceneHasDialogue);
}

// the beats still to do, in story order: [{ beatIndex, label, title, ... }] (shaped like the items of the shared job machine)
export function planWriteAll({ beats, screenplayBeats, isSong = () => false, dialogue = true, projectId }) {
  const items = [];
  beats.forEach((beat, beatIndex) => {
    if (beatIsComplete(screenplayBeats?.[beatIndex], { dialogue, isSong: isSong(beatIndex) })) return;
    items.push({
      episodeIndex: null, sceneIndex: beatIndex, label: `Beat ${beatIndex + 1}`, beatIndex, totalBeats: beats.length,
      title: String(beat?.title?.en ?? beat?.title ?? "").slice(0, 80), dialogue, sceneListId: Number(projectId),
    });
  });
  return items;
}

// One beat, all the way. deps = {
//   getBeat(i) -> { status, scenes, feedback },  reviveStuck(i)  (a beat "generating" for far too long is reset to not_started),
//   generateBeat(i) -> "generated" | "error",    approveBeat(i),  writeDialogue(i, sceneIndex),  isSong(i),  sleep(ms), now()
// }; say(text) tells the screen what is happening right now.
export async function writeWholeBeat({ item, say = async () => {}, deps }) {
  const { beatIndex: i, totalBeats: total, dialogue } = item;
  const n = i + 1;
  let beat = await deps.getBeat(i);

  // another writer (the older 4-beat one) may be in the middle of this very beat: wait for it instead of writing it twice
  const waitedFrom = deps.now();
  while (beat?.status === "generating") {
    await deps.reviveStuck(i);
    beat = await deps.getBeat(i);
    if (beat?.status !== "generating") break;
    if (deps.now() - waitedFrom > WAIT_FOR_ANOTHER_WRITER_MS) throw new Error(`Beat ${n} is still being written by another run. Try again in a few minutes.`);
    await say(`Beat ${n} of ${total} — the AI is already writing it, waiting for it to finish`);
    await deps.sleep(POLL_MS);
    beat = await deps.getBeat(i);
  }

  if (!beat || beat.status === "not_started" || beat.status === "error" || !Array.isArray(beat.scenes)) {
    await say(`Beat ${n} of ${total}${item.title ? ` — ${item.title}` : ""}: writing its scenes`);
    const outcome = await deps.generateBeat(i);
    beat = await deps.getBeat(i);
    if (outcome !== "generated" || !Array.isArray(beat?.scenes)) throw new Error(`Beat ${n} could not be written: ${beat?.feedback || "the AI did not answer"}`);
  }

  if (beat.status !== "approved") {
    await say(`Beat ${n} of ${total}: approving it (automatically — you can still read and change it)`);
    await deps.approveBeat(i);
    beat = await deps.getBeat(i);
  }

  if (dialogue && !deps.isSong(i)) {
    const failures = [];
    for (let j = 0; j < beat.scenes.length; j++) {
      if (sceneHasDialogue(beat.scenes[j])) continue; // already has its dialogue
      await say(`Beat ${n} of ${total}: dialogue for scene ${j + 1} of ${beat.scenes.length}`);
      try {
        await deps.writeDialogue(i, j);
      } catch (error) {
        failures.push(`scene ${j + 1}: ${String(error.message ?? error).slice(0, 120)}`);
        if (error.code === "BUDGET" || /money limit|budget/i.test(String(error.message ?? ""))) break; // no point going on once the money limit is reached
      }
    }
    if (failures.length > 0) throw new Error(`Beat ${n}: the dialogue could not be written for ${failures.join("; ")}. Press the button again to try those scenes again.`);
  }
}

// "Approve all": the person has read the screenplay and signs it off. Every written beat becomes approved BY THEM (the "approved automatically" marks go);
// refused while any beat is not written yet. Returns { unwritten: [beat numbers], changed, beats } — `beats` is the new list (unchanged when something is unwritten).
export function planApproveAll(screenplayBeats) {
  const list = Array.isArray(screenplayBeats) ? screenplayBeats : [];
  const unwritten = list.map((b, i) => (Array.isArray(b?.scenes) && b.scenes.length > 0 ? null : i + 1)).filter(Boolean);
  if (list.length === 0 || unwritten.length > 0) return { unwritten, changed: 0, beats: list, empty: list.length === 0 };
  let changed = 0;
  const beats = list.map((beat) => {
    if (beat.status === "approved" && !beat.autoApproved) return beat;
    changed += 1;
    const { autoApproved: _mark, ...rest } = beat;
    return { ...rest, status: "approved" };
  });
  return { unwritten, changed, beats, empty: false };
}
