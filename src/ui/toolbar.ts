// Whiteboard toolbar: one compact row; tapping a tool that has options opens a small menu under it.

import type { Board } from "../board/board";
import { BoardView, renderPage, type ShapeKind, type ViewTool } from "../board/view";
import type { Template } from "../board/model";
import { h, icon, iconBtn, toast } from "./dom";
import { exportPdf, downloadBlob } from "../board/export";
import { openDesmos } from "./desmos";

const COLORS = ["#1f2937", "#2563eb", "#dc2626", "#16a34a", "#ea580c", "#9333ea", "#0891b2", "#db2777", "#ca8a04", "#ffffff"];
const HL_COLORS = ["#facc15", "#4ade80", "#60a5fa", "#f472b6", "#fb923c"];
const SIZES = [2, 3.5, 6, 10];
const SHAPES: { id: ShapeKind; icon: string; label: string }[] = [
  { id: "line", icon: "line", label: "קו ישר" },
  { id: "arrow", icon: "arrow", label: "חץ" },
  { id: "rect", icon: "rect", label: "מלבן" },
  { id: "ellipse", icon: "ellipse", label: "עיגול / אליפסה" },
  { id: "tri", icon: "tri", label: "משולש" },
];
const TEMPLATES: { id: Template; label: string }[] = [
  { id: "blank", label: "ריק" },
  { id: "grid", label: "משבצות" },
  { id: "lines", label: "שורות" },
  { id: "dots", label: "נקודות" },
  { id: "mm", label: "נייר מילימטרי" },
];

interface Fav { tool: "pen" | "hl"; color: string; size: number; dash: boolean }
const FAV_KEY = "shiur.favs";
const DEFAULT_FAVS: Fav[] = [
  { tool: "pen", color: "#1f2937", size: 3.5, dash: false },
  { tool: "pen", color: "#2563eb", size: 3.5, dash: false },
  { tool: "pen", color: "#dc2626", size: 3.5, dash: false },
];
function loadFavs(): Fav[] {
  try {
    const f = JSON.parse(localStorage.getItem(FAV_KEY) || "null");
    if (Array.isArray(f) && f.length === 3) return f;
  } catch { /* ignore */ }
  return DEFAULT_FAVS.map((f) => ({ ...f }));
}

// ---------- popover ----------
let openPop: { el: HTMLElement; anchor: HTMLElement } | null = null;
function closePop() {
  openPop?.el.remove();
  openPop = null;
}
document.addEventListener("pointerdown", (e) => {
  if (openPop && !openPop.el.contains(e.target as Node) && !openPop.anchor.contains(e.target as Node)) closePop();
}, true);

function popover(anchor: HTMLElement, build: () => HTMLElement) {
  if (openPop?.anchor === anchor) return closePop();
  closePop();
  const el = h("div", { class: "pop", role: "dialog" }, build());
  document.body.append(el);
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth;
  el.style.top = `${r.bottom + 6}px`;
  el.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2))}px`;
  openPop = { el, anchor };
}

const row = (...c: (Node | null)[]) => h("div", { class: "pop-row" }, ...c);
const label = (t: string) => h("div", { class: "pop-label" }, t);
function choice(text: string, on: boolean, onclick: () => void, ic?: string) {
  return h("button", { class: `pop-item ${on ? "on" : ""}`, type: "button", onclick }, ic ? icon(ic, 18) : null, text);
}

export function buildToolbar(board: Board, view: BoardView, opts: { isTeacher: boolean; isStaff: boolean; roomName: string }) {
  const toolBtns = new Map<ViewTool, HTMLButtonElement>();
  const pageLabel = h("span", { class: "pagelbl" });
  const zoomBtn = h("button", { class: "zoomlbl", type: "button", title: "זום" });
  const lockBtn = iconBtn("unlock", "נעילה: רק המורה כותב", () => board.setLock(!board.state.lock.on));
  const styleBtn = h("button", { class: "ibtn stylebtn", type: "button", title: "צבע ועובי", "aria-label": "צבע ועובי" }, h("span", { class: "dot" }));
  const fileInput = h("input", { type: "file", accept: "application/pdf,image/*", hidden: true }) as HTMLInputElement;
  let favs = loadFavs();
  const favBtns: HTMLButtonElement[] = [];

  fileInput.addEventListener("change", async () => {
    const f = fileInput.files?.[0];
    fileInput.value = "";
    if (!f) return;
    if (f.size > 40 * 1024 * 1024) return toast("הקובץ גדול מדי (עד 40MB)");
    toast(`טוען את ${f.name}…`);
    try { await board.importFile(f); } catch (e) { console.error(e); toast("לא הצלחתי לפתוח את הקובץ"); }
  });

  const refreshTools = () => {
    for (const [id, b] of toolBtns) b.classList.toggle("on", id === view.tool);
    const shapeBtn = toolBtns.get("shape");
    if (shapeBtn) shapeBtn.replaceChildren(icon(SHAPES.find((s) => s.id === view.shape)?.icon ?? "line"), h("span", { class: "caret" }));
    const dot = styleBtn.firstElementChild as HTMLElement;
    dot.style.background = view.color;
    const px = Math.min(18, 4 + view.size * 1.4);
    dot.style.width = dot.style.height = `${px}px`;
    styleBtn.classList.toggle("dashed", view.dash);
    favBtns.forEach((b, i) => {
      const f = favs[i];
      b.classList.toggle("on", (view.tool === "pen" || view.tool === "hl") && view.tool === f.tool && view.color === f.color && view.size === f.size && view.dash === f.dash);
    });
  };

  const setTool = (t: ViewTool) => {
    view.tool = t;
    if (t !== "lasso") view.clearSelection();
    if (t === "hl" && !HL_COLORS.includes(view.color)) view.color = HL_COLORS[0];
    if ((t === "pen" || t === "fade" || t === "shape") && HL_COLORS.includes(view.color)) view.color = COLORS[0];
    refreshTools();
  };
  view.onViewChange = () => refresh();

  const toolBtn = (id: ViewTool, ic: string, lbl: string, menu?: () => HTMLElement) => {
    const b = iconBtn(ic, lbl, () => {
      if (menu && view.tool === id) return popover(b, menu);
      closePop();
      setTool(id);
    });
    if (menu) b.append(h("span", { class: "caret" }));
    toolBtns.set(id, b);
    return b;
  };

  const shapeMenu = () => h("div", null,
    label("צורה"),
    row(...SHAPES.map((s) => {
      const b = iconBtn(s.icon, s.label, () => { view.shape = s.id; setTool("shape"); closePop(); });
      b.classList.toggle("on", view.shape === s.id);
      return b;
    })),
    choice("קו מקווקו", view.dash, () => { view.dash = !view.dash; refreshTools(); closePop(); }, "dash"),
    choice("הוסף צירי x / y", false, () => { closePop(); view.insertAxes(); }, "axes"),
  );
  const eraserMenu = () => h("div", null,
    label("מחק"),
    choice("מוחק קו שלם", view.eraserMode === "stroke", () => { view.eraserMode = "stroke"; closePop(); }),
    choice("מחק חלקי (רק איפה שעוברים)", view.eraserMode === "partial", () => { view.eraserMode = "partial"; closePop(); }),
  );
  const laserMenu = () => h("div", null,
    label("לייזר"),
    choice("עם שובל", !view.laserDot, () => { view.laserDot = false; closePop(); }),
    choice("נקודה בלבד", view.laserDot, () => { view.laserDot = true; closePop(); }),
  );
  const penMenu = () => h("div", null,
    label("עט"),
    choice("זיהוי צורות (ציור + החזקה)", view.autoShape, () => { view.autoShape = !view.autoShape; closePop(); }),
    choice("קו מקווקו", view.dash, () => { view.dash = !view.dash; refreshTools(); closePop(); }, "dash"),
  );

  const styleMenu = () => {
    const palette = view.tool === "hl" ? HL_COLORS : COLORS;
    const custom = h("input", { type: "color", class: "swatch custom", title: "צבע אחר", value: view.color.length === 7 ? view.color : "#000000" }) as HTMLInputElement;
    custom.addEventListener("change", () => { view.color = custom.value; refreshTools(); });
    return h("div", null,
      label("צבע"),
      h("div", { class: "pop-grid" }, ...palette.map((c) =>
        h("button", { class: `swatch ${view.color === c ? "on" : ""}`, type: "button", title: "צבע", style: { background: c }, onclick: () => { view.color = c; refreshTools(); closePop(); } })), custom),
      label("עובי"),
      row(...SIZES.map((s, i) =>
        h("button", { class: `sizebtn ${view.size === s ? "on" : ""}`, type: "button", title: ["דק", "בינוני", "עבה", "עבה מאוד"][i], onclick: () => { view.size = s; refreshTools(); closePop(); } },
          h("span", { style: { width: `${3 + s * 1.3}px`, height: `${3 + s * 1.3}px` } })))),
      view.tool === "pen" || view.tool === "shape" ? choice("קו מקווקו", view.dash, () => { view.dash = !view.dash; refreshTools(); closePop(); }, "dash") : null,
    );
  };
  styleBtn.addEventListener("click", () => popover(styleBtn, styleMenu));

  // favourites: tap to use, long-press (or right-click) to save the current pen into the slot
  for (let i = 0; i < 3; i++) {
    const b = h("button", { class: "ibtn fav", type: "button", title: "עט מועדף (לחיצה ארוכה: שמור את העט הנוכחי)", "aria-label": `עט מועדף ${i + 1}` });
    const draw = () => {
      const f = favs[i];
      b.replaceChildren(icon(f.tool === "hl" ? "hl" : "pen", 18), h("span", { class: "fav-bar", style: { background: f.color, height: `${Math.min(6, 2 + f.size / 2)}px` } }));
    };
    let timer: number | undefined;
    let saved = false;
    const save = () => {
      saved = true;
      const tool = view.tool === "hl" ? "hl" : "pen";
      favs[i] = { tool, color: view.color, size: view.size, dash: view.dash };
      localStorage.setItem(FAV_KEY, JSON.stringify(favs));
      draw();
      refreshTools();
      toast("העט נשמר במועדפים");
    };
    b.addEventListener("pointerdown", () => { saved = false; timer = window.setTimeout(save, 600); });
    for (const t of ["pointerup", "pointerleave", "pointercancel"]) b.addEventListener(t, () => clearTimeout(timer));
    b.addEventListener("contextmenu", (e) => { e.preventDefault(); save(); });
    b.addEventListener("click", () => {
      if (saved) return;
      const f = favs[i];
      view.color = f.color;
      view.size = f.size;
      view.dash = f.dash;
      setTool(f.tool);
    });
    draw();
    favBtns.push(b);
  }

  const pageMenu = () => h("div", null,
    choice("עמוד חדש", false, () => { closePop(); board.addPage(); }, "plus"),
    opts.isStaff ? choice("דף פרטי חדש (רק אתה רואה)", false, () => { closePop(); board.addPage(true); toast("דף פרטי: התלמיד לא רואה אותו"); }, "lock") : null,
    choice("שכפל עמוד", false, () => { closePop(); board.duplicatePage(); }, "copy"),
    board.canPaste ? choice("הדבק כאן", false, () => { closePop(); view.pasteHere(); }, "paste") : null,
    label("רקע לעמוד"),
    h("div", { class: "pop-grid tpl" }, ...TEMPLATES.map((t) =>
      choice(t.label, (board.currentPage.tpl ?? "blank") === t.id, () => { closePop(); if (board.currentPage.bg) toast("לעמוד עם PDF או תמונה אין רקע"); else board.setTemplate(t.id); }))),
    h("hr"),
    choice("נקה את העמוד", false, () => { closePop(); if (confirm("לנקות את כל הכתוב בעמוד הזה?")) board.clearPage(); }, "trash"),
    choice("מחק את העמוד", false, () => { closePop(); if (confirm("למחוק את העמוד הזה?")) board.deletePage(); }, "pageDel"),
  );
  const pageMenuBtn = iconBtn("grid", "עמודים ורקע", () => popover(pageMenuBtn, pageMenu));

  // export
  const stamp = () => new Date().toLocaleDateString("he-IL").replace(/\./g, "-");
  const exportPng = async () => {
    const page = board.currentPage;
    const c = await renderPage(board, page, 2000);
    c.toBlob((blob) => {
      if (blob) downloadBlob(blob, `${opts.roomName}-${stamp()}-עמוד-${board.pages.findIndex((p) => p.id === page.id) + 1}.png`);
    }, "image/png");
  };
  let exporting = false;
  const pdfBtn = iconBtn("pdf", "ייצא את כל הלוח ל-PDF", () => void exportAll());
  const exportAll = async () => {
    if (exporting) return;
    exporting = true;
    pdfBtn.classList.add("busy");
    toast("מכין PDF של כל הלוח…");
    try {
      const blob = await exportPdf(board, (done, total) => { pdfBtn.title = `מכין PDF… ${done}/${total}`; });
      downloadBlob(blob, `${opts.roomName}-${stamp()}.pdf`);
      toast(`ה-PDF מוכן (${board.pages.length} עמודים)`);
    } catch (e) {
      console.error(e);
      toast("לא הצלחתי ליצור PDF");
    } finally {
      exporting = false;
      pdfBtn.classList.remove("busy");
      pdfBtn.title = "ייצא את כל הלוח ל-PDF";
    }
  };
  const fileMenu = () => h("div", null,
    choice("העלה PDF או תמונה", false, () => { closePop(); fileInput.click(); }, "upload"),
    opts.isStaff ? choice("מחשבון גרפים Desmos", false, () => { closePop(); openDesmos((blob) => void board.importFile(blob, "desmos.png")); }, "graph") : null,
    choice("שמור את העמוד כתמונה", false, () => { closePop(); void exportPng(); }, "download"),
    choice("ייצא את כל הלוח ל-PDF", false, () => { closePop(); void exportAll(); }, "pdf"),
  );
  const fileMenuBtn = iconBtn("file", "קבצים", () => popover(fileMenuBtn, fileMenu));
  zoomBtn.addEventListener("click", () => popover(zoomBtn, () => h("div", null,
    row(iconBtn("zoomOut", "הקטן", () => view.zoomBy(1 / 1.25)), iconBtn("zoomIn", "הגדל", () => view.zoomBy(1.25)), iconBtn("fit", "התאם למסך", () => { view.fitPage(); closePop(); })),
  )));

  // floating menu next to a lasso selection
  view.setSelectionMenu(h("div", { class: "selbar" },
    ...COLORS.slice(0, 6).map((c) => h("button", { class: "swatch sm", type: "button", title: "צבע", style: { background: c }, onclick: () => view.restyleSelection({ color: c }) })),
    iconBtn("dash", "מקווקו / רציף", () => {
      const s = board.state.strokes[view.selection[0]];
      view.restyleSelection({ dash: !s?.dash });
    }),
    iconBtn("copy", "העתק (אפשר להדביק גם בעמוד אחר)", () => { view.copySelection(); toast("הועתק. להדבקה: תפריט העמודים ← הדבק כאן"); }),
    iconBtn("plus", "שכפל", () => view.duplicateSelection()),
    iconBtn("trash", "מחק", () => view.deleteSelection()),
  ));

  const bar = h("div", { class: "toolbar", role: "toolbar", "aria-label": "כלי הלוח" },
    h("div", { class: "tgroup" },
      toolBtn("pen", "pen", "עט (P)", penMenu),
      toolBtn("hl", "hl", "מרקר (H)"),
      toolBtn("fade", "fade", "דיו נעלם: נמחק לבד אחרי כמה שניות (F)"),
      toolBtn("shape", "line", "צורות (S)", shapeMenu),
      toolBtn("eraser", "eraser", "מחק (E)", eraserMenu),
      toolBtn("lasso", "lasso", "לאסו: בחר, הזז, הגדל, צבע (V)"),
      toolBtn("laser", "laser", "לייזר להצבעה (L)", laserMenu),
      toolBtn("pan", "pan", "הזזת הדף"),
    ),
    h("div", { class: "tgroup" }, ...favBtns, styleBtn),
    h("div", { class: "tgroup" },
      iconBtn("undo", "בטל (Ctrl+Z)", () => board.undo()),
      iconBtn("redo", "בצע שוב (Ctrl+Y)", () => board.redo()),
    ),
    h("div", { class: "tgroup" },
      iconBtn("next", "עמוד קודם", () => board.goRelative(-1)),
      pageLabel,
      iconBtn("prev", "עמוד הבא", () => board.goRelative(1)),
      pageMenuBtn,
    ),
    h("div", { class: "tgroup" }, fileMenuBtn, pdfBtn, zoomBtn),
    opts.isTeacher ? h("div", { class: "tgroup" }, lockBtn) : null,
    fileInput,
  );

  function refresh() {
    const ps = board.pages;
    const i = ps.findIndex((p) => p.id === board.currentPage.id);
    pageLabel.textContent = `${board.currentPage.priv ? "🔒 " : ""}${i + 1}/${ps.length}`;
    zoomBtn.textContent = `${view.zoomPct}%`;
    const locked = board.state.lock.on;
    lockBtn.classList.toggle("on", locked);
    lockBtn.replaceChildren(icon(locked ? "lock" : "unlock"));
    lockBtn.title = locked ? "הלוח נעול לתלמיד. לחץ לפתיחה" : "נעל: רק המורה כותב";
    refreshTools();
  }

  const KEYS: Record<string, ViewTool> = { p: "pen", h: "hl", f: "fade", s: "shape", e: "eraser", v: "lasso", l: "laser" };
  window.addEventListener("keydown", (e) => {
    const a = document.activeElement;
    if (a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA")) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); if (e.shiftKey) board.redo(); else board.undo(); return; }
    if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); board.redo(); return; }
    if (mod && e.key.toLowerCase() === "v") { e.preventDefault(); view.pasteHere(); return; }
    if (mod) return;
    if (e.key === "PageDown") board.goRelative(1);
    if (e.key === "PageUp") board.goRelative(-1);
    const t = KEYS[e.key.toLowerCase()];
    if (t) setTool(t);
  });

  setTool("pen");
  refresh();
  return { el: bar, refresh };
}
