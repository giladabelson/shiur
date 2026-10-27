// Export the whole board (all pages, backgrounds + ink) as one PDF file.

import type { Board } from "./board";
import { renderPage } from "./view";

const PAGE_PX = 1600; // render width per page: sharp enough to print, small enough for iPad memory

export async function exportPdf(board: Board, onProgress: (done: number, total: number) => void): Promise<Blob> {
  const { jsPDF } = await import("jspdf"); // loaded only when needed
  const pages = board.pages;
  let doc: InstanceType<typeof jsPDF> | null = null;
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    const w = 595; // A4 width in points; height follows the page's own proportions
    const hgt = Math.round((w * p.h) / p.w);
    const orientation = hgt >= w ? "portrait" : "landscape";
    if (!doc) doc = new jsPDF({ unit: "pt", format: [w, hgt], orientation, compress: true });
    else doc.addPage([w, hgt], orientation);
    const canvas = await renderPage(board, p, PAGE_PX);
    // JPEG keeps a scanned-worksheet PDF to a reasonable size.
    doc.addImage(canvas.toDataURL("image/jpeg", 0.88), "JPEG", 0, 0, w, hgt, undefined, "FAST");
    canvas.width = canvas.height = 0;
    onProgress(i + 1, pages.length);
    await new Promise((r) => setTimeout(r, 0)); // keep the UI responsive between pages
  }
  return doc!.output("blob");
}

export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
