// FILE NAMES FOR PICTURES MADE ELSEWHERE. The "image commands" PDF tells the director exactly what to save each picture as;
// when the pictures are uploaded back, the name alone says which character, environment, props sheet or shot each one is.
//   characters / environments / props / props sheets :  CHAR001_Rohan.png   LOC002_Old-Temple.png   PROP004_Lamp.png   PGRP01_Props-sheet-1.png
//   shot first frames                                  :  SC001_SH003.png
// Only the CODE at the start matters when reading a name back (CHAR001, SC001_SH003), so a tool that adds " (1)", "-copy" or
// its own suffix still matches, and so does any image format.

export const slug = (text) => String(text ?? "").normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "item";

export const assetFileName = (asset) => `${asset.code}_${slug(asset.name)}`;
export const shotFileName = (shot) => `${shot.sceneCode}_${shot.code}`;

const ASSET_CODE = /(?:^|[^A-Za-z0-9])((?:CHAR|PROP|PGRP|LOC|ENV|OTH|OTHER|ITEM)\d+)(?![0-9])/i;
const SHOT_CODE = /(?:^|[^A-Za-z0-9])(SC\d+)[_\-\s.]+(SH\d+)(?![0-9])/i;

// "SC001_SH003 (2).jpg" -> { type: "shot", sceneCode: "SC001", shotCode: "SH003" }; "char001-rohan.PNG" -> { type: "asset", code: "CHAR001" }
export function parsePictureName(fileName) {
  const base = String(fileName ?? "").split(/[\\/]/).pop().replace(/\.[A-Za-z0-9]{2,5}$/, "");
  const shot = SHOT_CODE.exec(base);
  if (shot) return { type: "shot", sceneCode: shot[1].toUpperCase(), shotCode: shot[2].toUpperCase() };
  const asset = ASSET_CODE.exec(base);
  if (asset) return { type: "asset", code: asset[1].toUpperCase() };
  return null;
}

// Real pictures only: the first bytes decide, not the name the other app gave the file.
export function imageKind(bytes) {
  if (!bytes || bytes.length < 12) return null;
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: "image/png", ext: ".png" };
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { mime: "image/jpeg", ext: ".jpg" };
  if (bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") return { mime: "image/webp", ext: ".webp" };
  return null;
}
