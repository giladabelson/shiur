// Whiteboard toolbar.

import type { Board } from "../board/board";
import { BoardView, renderPage, type ViewTool } from "../board/view";
import { h, icon, iconBtn, toast } from "./dom";

const COLORS = ["#1f2937", "#2563eb", "#dc2626", "#16a34a", "#ea580c", "#9333ea"];
const SIZES = [2, 3.5, 6];

const TOOLS: { id: ViewTool; icon: string; label: string; key: string }[] = [
  { id: "pen", icon: "pen", label: "עט (P)", key: "p" },
  { id: "hl", icon: "hl", label: "מרקר (H)", key: "h" },
  { id: "line", icon: "line", label: "קו ישר", key: "" },
  { id: "rect", icon: "rect", label: "מלבן", key: "" },
  { id: "ellipse", icon: "ellipse", label: "אליפסה", key: "" },
  { id: "eraser", icon: "eraser", label: "מחק (E)", key: "e" },
  { id: "laser", icon: "laser", label: "לייזר להצבעה (L)", key: "l" },
  { id: "pan", icon: "pan", label: "הזזה (רווח)", key: "" },
];

export function buildToolbar(board: Board, view: BoardView, opts: { isTeacher: boolean; roomName: string }) {
  const toolBtns = new Map<ViewTool, HTMLButtonElement>();
  const colorBtns: HTMLButtonElement[] = [];
  const sizeBtns: HTMLButtonElement[] = [];
  const pageLabel = h("span", { class: "pagelbl" });
  const zoomLabel = h("span", { class: "zoomlbl" });
  const lockBtn = iconBtn("unlock", "נעילה: רק המורה כותב", () => board.setLock(!board.state.lock.on));
  const fileInput = h("input", { type: "file", accept: "application/pdf,image/*", hidden: true }) as HTMLInputElement;
  fileInput.addEventListener("change", async () => {
    const f = fileInput.files?.[0];
    fileInput.value = "";
    if (!f) return;
    if (f.size > 40 * 1024 * 1024) return toast("הקובץ גדול מדי (עד 40MB)");
    toast(`טוען את ${f.name}…`);
    try { await board.importFile(f); } catch (e) { console.error(e); toast("לא הצלחתי לפתוח את הקובץ"); }
  });

  const setTool = (t: ViewTool) => {
    view.tool = t;
    for (const [id, b] of toolBtns) b.classList.toggle("on", id === t);
  };
  const setColor = (c: string) => {
    view.color = c;
    if (view.tool === "eraser" || view.tool === "laser" || view.tool === "pan") setTool("pen");
    colorBtns.forEach((b) => b.classList.toggle("on", b.dataset.c === c));
  };
  const setSize = (s: number) => {
    view.size = s;
    sizeBtns.forEach((b) => b.classList.toggle("on", Number(b.dataset.s) === s));
  };

  const toolsGroup = h("div", { class: "tgroup" });
  for (const t of TOOLS) {
    const b = iconBtn(t.icon, t.label, () => setTool(t.id));
    toolBtns.set(t.id, b);
    toolsGroup.append(b);
  }
  const colorsGroup = h("div", { class: "tgroup" });
  for (const c of COLORS) {
    const b = h("button", { class: "swatch", type: "button", title: "צבע", "aria-label": "צבע", style: { background: c }, onclick: () => setColor(c) });
    b.dataset.c = c;
    colorBtns.push(b);
    colorsGroup.append(b);
  }
  const sizesGroup = h("div", { class: "tgroup" });
  SIZES.forEach((s, i) => {
    const b = h("button", { class: "sizebtn", type: "button", title: ["דק", "בינוני", "עבה"][i], onclick: () => setSize(s) },
      h("span", { style: { width: `${4 + i * 4}px`, height: `${4 + i * 4}px` } }));
    b.dataset.s = String(s);
    sizeBtns.push(b);
    sizesGroup.append(b);
  });

  const exportPng = async () => {
    const page = board.currentPage;
    const c = await renderPage(board, page, 2000);
    c.toBlob((blob) => {
      if (!blob) return;
      const a = h("a", { href: URL.createObjectURL(blob), download: `${opts.roomName}-עמוד-${board.pages.findIndex((p) => p.id === page.id) + 1}.png` });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }, "image/png");
  };

  const bar = h("div", { class: "toolbar", role: "toolbar", "aria-label": "כלי הלוח" },
    toolsGroup,
    colorsGroup,
    sizesGroup,
    h("div", { class: "tgroup" },
      iconBtn("undo", "בטל (Ctrl+Z)", () => board.undo()),
      iconBtn("redo", "בצע שוב (Ctrl+Y)", () => board.redo()),
      iconBtn("trash", "נקה את העמוד", () => { if (confirm("לנקות את כל הכתוב בעמוד הזה?")) board.clearPage(); }),
    ),
    h("div", { class: "tgroup" },
      iconBtn("next", "עמוד קודם", () => board.goRelative(-1)),
      pageLabel,
      iconBtn("prev", "עמוד הבא", () => board.goRelative(1)),
      iconBtn("plus", "עמוד חדש", () => board.addPage()),
      iconBtn("pageDel", "מחק עמוד", () => { if (confirm("למחוק את העמוד הזה?")) board.deletePage(); }),
    ),
    h("div", { class: "tgroup" },
      iconBtn("upload", "העלה PDF או תמונה", () => fileInput.click()),
      iconBtn("download", "שמור את העמוד כתמונה", () => void exportPng()),
    ),
    h("div", { class: "tgroup" },
      iconBtn("zoomOut", "הקטן", () => view.zoomBy(1 / 1.25)),
      zoomLabel,
      iconBtn("zoomIn", "הגדל", () => view.zoomBy(1.25)),
      iconBtn("fit", "התאם למסך", () => view.fitPage()),
    ),
    opts.isTeacher ? h("div", { class: "tgroup" }, lockBtn) : null,
    fileInput,
  );

  const refresh = () => {
    const ps = board.pages;
    const i = ps.findIndex((p) => p.id === board.currentPage.id);
    pageLabel.textContent = `${i + 1}/${ps.length}`;
    zoomLabel.textContent = `${view.zoomPct}%`;
    const locked = board.state.lock.on;
    lockBtn.classList.toggle("on", locked);
    lockBtn.replaceChildren(icon(locked ? "lock" : "unlock"));
    lockBtn.title = locked ? "הלוח נעול לתלמיד. לחץ לפתיחה" : "נעל: רק המורה כותב";
  };
  view.onViewChange = refresh;

  window.addEventListener("keydown", (e) => {
    const a = document.activeElement;
    if (a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA")) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); if (e.shiftKey) board.redo(); else board.undo(); return; }
    if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); board.redo(); return; }
    if (mod) return;
    if (e.key === "PageDown") board.goRelative(1);
    if (e.key === "PageUp") board.goRelative(-1);
    const t = TOOLS.find((x) => x.key && x.key === e.key.toLowerCase());
    if (t) setTool(t.id);
  });

  setTool("pen");
  setColor(COLORS[0]);
  setSize(SIZES[1]);
  refresh();
  return { el: bar, refresh };
}
