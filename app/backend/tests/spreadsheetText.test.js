import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { extractTextFromSpreadsheet } from "../spreadsheetText.js";
import { analyzeImportedText } from "../importAnalysis.js";
import { parseEpisodesFromText } from "../screenplayImport.js";
import { buildScreenplayProject } from "../screenplayProject.js";

async function workbookBuffer(build) {
  const wb = new ExcelJS.Workbook();
  build(wb);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// the layout of the owner's "TWO SISTERS" sheet: a title row, a header row, then one row per scene
const sceneTable = (wb) => {
  const ws = wb.addWorksheet("Scenes");
  ws.addRow(["AS", "TWO SISTERS"]);
  ws.addRow(["SL NO", "INT/EXT", "DAY/NIGHT", "LOCATION", "DESCRIPTION"]);
  ws.addRow([1, "Ext", "Day", "Lonely Road", "Biswa babu is in car, a girl suddenly comes across his road"]);
  ws.addRow([2, "INT", "Day", "Hospital corrpidor", "Smita byasta hei asanti, doctor kuhe he is okay"]);
  ws.addRow([]);
  ws.addRow([3, "int", "night", "Biswas house", { richText: [{ text: "Biswa babu is " }, { text: "stable" }] }]);
};

test("a scene table in Excel: every row is one scene with its own heading and one-liner", async () => {
  const text = await extractTextFromSpreadsheet(await workbookBuffer(sceneTable));
  assert.match(text, /SCENE 1\nEXT\. LONELY ROAD - DAY\nBiswa babu is in car/);
  assert.match(text, /SCENE 3\nINT\. BISWAS HOUSE - NIGHT\nBiswa babu is stable/);
  const a = analyzeImportedText(text);
  assert.equal(a.stage, "scene_list");
  assert.equal(a.totals.scenes, 3);
  const built = buildScreenplayProject(parseEpisodesFromText(text), { title: "TWO SISTERS" });
  assert.equal(built.sceneList.scenes.length, 3);
  assert.equal(built.sceneList.scenes[1].location.en, "HOSPITAL CORRPIDOR");
});

test("a sheet that is not a scene table keeps every row as a line, cells joined with ' | '", async () => {
  const text = await extractTextFromSpreadsheet(await workbookBuffer((wb) => {
    const ws = wb.addWorksheet("Notes");
    ws.addRow(["Idea", "A priest guards a temple"]);
    ws.addRow(["Theme", "Greed"]);
  }));
  assert.equal(text, "Idea | A priest guards a temple\nTheme | Greed");
});

test("scene numbers carry on across sheets; a file that is not Excel is refused plainly", async () => {
  const text = await extractTextFromSpreadsheet(await workbookBuffer((wb) => {
    for (const name of ["Act 1", "Act 2"]) {
      const ws = wb.addWorksheet(name);
      ws.addRow(["INT/EXT", "DAY/NIGHT", "LOCATION", "DESCRIPTION"]);
      ws.addRow(["INT", "Day", `${name} room`, "Something happens."]);
    }
  }));
  assert.match(text, /SCENE 1\nINT\. ACT 1 ROOM - DAY[^]*SCENE 2\nINT\. ACT 2 ROOM - DAY/);
  await assert.rejects(() => extractTextFromSpreadsheet(Buffer.from("not excel")), /could not open this Excel file/);
});
