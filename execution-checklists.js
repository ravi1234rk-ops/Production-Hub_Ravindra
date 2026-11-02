"use strict";

const write = require("write-excel-file/node");
const { templates } = require("./config/execution-checklists.json");

function checklistTemplate(assetType, role = "executioner") {
  const asset = String(assetType || "").toLowerCase();
  const type = /ppt|gslide|powerpoint|google slide/.test(asset) ? "PPT/Gslide" : /banner/.test(asset) ? "Banner"
    : /ipdf/.test(asset) ? "iPDF" : /^print$/.test(asset) ? "Print" : "";
  const template = templates.find((template) => template.assetType === type);
  if (role === "auditor") {
    const source = template?.items.some((item) => item.section === "Graphics Audit") ? template
      : templates.find((item) => item.items.some((check) => check.section === "Graphics Audit"));
    return { assetType: "Graphics Audit", forAssetType: type, source: source.source, items: source.items.filter((item) => item.section === "Graphics Audit") };
  }
  return template ? { ...template, items: template.items.filter((item) => !["Graphics Audit", "Brand Guidelines"].includes(item.section)) } : null;
}

function roleTemplates(role) {
  return role === "auditor" ? [...templates.map((template) => checklistTemplate(template.assetType, role)), checklistTemplate("", role)]
    : templates.map((template) => checklistTemplate(template.assetType, role));
}

async function checklistWorkbook(delivery, checklist, name) {
  const cell = (value, header = false) => ({ value: String(value ?? ""), type: String, wrap: true,
    ...(header ? { fontWeight: "bold", backgroundColor: "#E8EEF5" } : {}) });
  const info = [
    ["Project ID", delivery.ref], ["Project", delivery.title], ["Asset", delivery.project?.assetType],
    ["CR", delivery.crId], ["Member", name], ["Saved", checklist.updatedAt],
    ["Functional document", checklist.functionalLink], ["Style guide", checklist.styleLink],
    ["Checklist URL", checklist.checklistLink], ["Observations", checklist.observations],
    ...(checklist.inputDocuments || []).map((doc) => ["Input: " + doc.name, doc.link]),
    ...(checklist.outputDocuments || []).map((doc) => ["Output: " + doc.name, doc.link])
  ].map((row) => row.map((value) => cell(value)));
  const rows = [["Section", "Checkpoint", "Guidance", "Self QA (Done / N.A. / In Progress / Pending)", "Notes"].map((value) => cell(value, true)),
    ...checklist.items.map((item) => [item.section || "Additional", item.label, item.detail || "",
      item.result || (item.done ? "Done" : "Pending"), item.comment || ""].map((value) => cell(value)))];
  return write([
    { data: info, sheet: "Project info", columns: [{ width: 26 }, { width: 90 }] },
    { data: rows, sheet: (checklist.worksheet || "Asset checklist").replace(/[\\/?*:[\]]/g, "-").slice(0, 31), columns: [{ width: 24 }, { width: 85 }, { width: 65 }, { width: 25 }, { width: 60 }] }
  ]).toBuffer();
}

module.exports = { checklistTemplate, checklistWorkbook, roleTemplates, templates };
