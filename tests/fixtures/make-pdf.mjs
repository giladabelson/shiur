// Builds tests/fixtures/worksheet.pdf: a small 2-page worksheet used by the walkthrough tests.
import { jsPDF } from "jspdf";
import fs from "node:fs";
const doc = new jsPDF({ unit: "pt", format: "a4" });
for (let i = 1; i <= 2; i++) {
  if (i > 1) doc.addPage();
  doc.setFontSize(28);
  doc.text(`Worksheet page ${i}`, 60, 90);
  doc.setFontSize(14);
  for (let q = 1; q <= 5; q++) doc.text(`Q${q}. A block of mass ${q} kg slides down a ${10 * q} degree incline.`, 60, 140 + q * 60);
  doc.rect(40, 40, 515, 760);
}
fs.writeFileSync(new URL("./worksheet.pdf", import.meta.url), Buffer.from(doc.output("arraybuffer")));
