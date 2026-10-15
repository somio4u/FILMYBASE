// BRINGING PICTURES BACK. The director makes the pictures in another tool, saving each under the name the "image commands" PDF
// gave it, and uploads them here (loose files or a .zip). Each picture is matched by the code at the start of its name to
// its character, environment, prop, props sheet or shot, and stored as a new version of that target, waiting for the
// director's review (or approved straight away if asked). A picture that cannot be matched is reported with the reason,
// never guessed at and never lost.
import AdmZip from "adm-zip";
import { listShots } from "./shots.js";
import { imageKind, parsePictureName } from "./pictureNames.js";

const junk = (name) => /(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db)(\/|$)/i.test(name) || /(^|\/)\._/.test(name);

// files: [{ name, bytes }] — a .zip is opened and its pictures used as if they had been uploaded one by one
export function expandUploads(files) {
  const out = [];
  for (const file of files) {
    if (/\.zip$/i.test(file.name)) {
      try {
        for (const entry of new AdmZip(file.bytes).getEntries()) {
          if (!entry.isDirectory && !junk(entry.entryName)) out.push({ name: entry.entryName.split("/").pop(), bytes: entry.getData() });
        }
      } catch {
        out.push({ name: file.name, bytes: Buffer.alloc(0), problem: "This zip file could not be opened." });
      }
    } else if (!junk(file.name)) {
      out.push(file);
    }
  }
  return out;
}

export async function importPictures({ db, gens, projectId, files, actorUserId = null, autoApprove = false }) {
  const imported = [];
  const skipped = [];
  const uploads = expandUploads(files);
  const assets = (await db.query("SELECT id, code, name, kind, grouped_into FROM production_assets WHERE project_id = $1 AND in_latest_import", [projectId])).rows;
  const byCode = new Map(assets.map((a) => [a.code.toUpperCase(), a]));
  const shots = await listShots(db, projectId);
  const byShot = new Map(shots.map((s) => [`${s.sceneCode}|${s.code}`.toUpperCase(), s]));

  for (const file of uploads) {
    const skip = (reason) => skipped.push({ file: file.name, reason });
    if (file.problem) { skip(file.problem); continue; }
    const kind = imageKind(file.bytes);
    if (!kind) { skip("This is not a picture (PNG, JPG or WebP)."); continue; }
    const parsed = parsePictureName(file.name);
    if (!parsed) { skip("The name does not start with a code like CHAR001, LOC002, PROP003, PGRP01 or SC001_SH003, so I cannot tell what this picture is. Rename it to the name in the PDF."); continue; }
    try {
      if (parsed.type === "asset") {
        const asset = byCode.get(parsed.code);
        if (!asset) { skip(`There is no item with the code ${parsed.code} in this film.`); continue; }
        if (asset.grouped_into) {
          const sheet = assets.find((a) => a.id === asset.grouped_into);
          skip(`${asset.code} ${asset.name} is on the props sheet ${sheet?.code ?? ""}. Upload the picture of the whole sheet, named ${sheet?.code ?? "PGRP01"}_….`);
          continue;
        }
        const made = await gens.importPicture(projectId, { assetId: asset.id, ...kind, bytes: file.bytes, originalName: file.name, actorUserId, autoApprove });
        imported.push({ file: file.name, target: `${asset.code} ${asset.name}`, kind: asset.kind, version: made.version, approved: made.review === "approved" });
      } else {
        const shot = byShot.get(`${parsed.sceneCode}|${parsed.shotCode}`);
        if (!shot) { skip(`There is no shot ${parsed.sceneCode}_${parsed.shotCode} in this film.`); continue; }
        const made = await gens.importPicture(projectId, { shotId: shot.id, ...kind, bytes: file.bytes, originalName: file.name, actorUserId, autoApprove });
        imported.push({ file: file.name, target: `${shot.sceneCode}_${shot.code}`, kind: "keyframe", version: made.version, approved: made.review === "approved" });
      }
    } catch (error) {
      skip(error.message);
    }
  }
  return { imported, skipped };
}
