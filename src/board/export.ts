// Export the whole board (all pages, backgrounds + ink) as one PDF file.

import type { Board } from "./board";
import { livePages, pageStrokes, type BoardState, type Page, type Stroke } from "./model";
import { renderPage } from "./view";

/** What the exporter needs from a board: its pages and the ink on each page. */
export interface BoardLike {
  pages: Page[];
  strokes(pageId: string): Stroke[];
}

/**
 * A saved board (e.g. a finished lesson) as something the exporter can render. Teacher-only
 * pages are left out unless `withPrivate`, since the lesson PDF is meant for the student.
 */
export function boardOf(state: BoardState, withPrivate = false): BoardLike {
  const strokes = (pageId: string) => pageStrokes(state, pageId);
  return { pages: pagesToExport({ pages: livePages(state).filter((p) => withPrivate || !p.priv), strokes }), strokes };
}

/**
 * The pages worth exporting: the board always has a blank page after the last one written on
 * (so the teacher can keep writing), which shouldn't end up as an empty last page in the PDF.
 */
export function pagesToExport(board: BoardLike): Page[] {
  const ps = board.pages.slice();
  while (ps.length > 1) {
    const last = ps[ps.length - 1];
    if (last.bg || board.strokes(last.id).length) break;
    ps.pop();
  }
  return ps;
}

const PAGE_PX = 1600; // render width per page: sharp enough to print, small enough for iPad memory

export async function exportPdf(board: Board | BoardLike, onProgress: (done: number, total: number) => void = () => {}): Promise<Blob> {
  const { jsPDF } = await import("jspdf"); // loaded only when needed
  const pages = pagesToExport(board);
  if (!pages.length) throw new Error("no pages");
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
  (window as any).__lastDownload = name; // read by the automated tests
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
