"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const read = require("read-excel-file/node");

async function main() {
  const directory = process.argv[2];
  if (!directory) throw new Error("Supply the directory containing the approved checklist workbooks.");
  const sources = [
    ["Banner", "Checklist_Banner.xlsx", ["Banner", "Graphics Audit"]],
    ["iPDF", "Checklist_iPdf.xlsx", ["iPDF", "Graphics Audit"]],
    ["Print", "Checklist_Print.xlsx", ["Print", "Graphics Audit"]],
    ["PPT/Gslide", "PPT-Gslide- Checklist.xlsx", ["Checklist", "Brand Guidelines"]]
  ];
  const templates = [];
  for (const [assetType, filename, selected] of sources) {
    const sheets = await read(path.join(directory, filename));
    const items = [];
    for (const sheetName of selected) {
      const sheet = sheets.find((item) => item.sheet === sheetName);
      if (!sheet) throw new Error(`${filename} is missing ${sheetName}.`);
      let section = sheetName;
      sheet.data.forEach((row, index) => {
        let label;
        let detail = "";
        if (["iPDF", "Print"].includes(sheetName)) {
          if (index < 2) return;
          section = row[1] || section;
          if (!row[2] && !row[3]) return;
          label = `${section}: ${row[3] || row[2]}`;
          detail = row[3] && row[2] ? String(row[2]) : "";
        } else {
          if (index < (sheetName === "Brand Guidelines" ? 1 : 2) || !row[1]) return;
          if (sheetName === "Checklist") section = row[0] || section;
          label = sheetName === "Checklist" ? `${section}: ${row[1]}` : String(row[1]);
        }
        items.push({ id: `${assetType}:${sheetName}:${index + 1}`, section: sheetName, label: String(label), detail });
      });
    }
    templates.push({ assetType, source: filename, items });
  }
  await fs.writeFile(path.join(__dirname, "../config/execution-checklists.json"), `${JSON.stringify({ version: 1, templates }, null, 2)}\n`);
  console.log(templates.map((item) => `${item.assetType}: ${item.items.length} checks`).join("\n"));
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
