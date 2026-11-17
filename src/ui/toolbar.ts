// Whiteboard toolbar, two rows:
//  1. the tools (pen, highlighter, shapes, eraser, lasso, pointer) and the general controls;
//  2. directly beneath, an always-visible strip with the options of the selected tool.

import type { Board } from "../board/board";
import { BoardView, renderPage, type ShapeKind, type ViewTool } from "../board/view";
import type { Template } from "../board/model";
import { h, icon, iconBtn, toast } from "./dom";
import { exportPdf, downloadBlob } from "../board/export";
import { openDesmos } from "./desmos";

const COLORS = ["#1f2937", "#2563eb", "#dc2626", "#16a34a", "#ea580c", "#9333ea", "#0891b2", "#db2777", "#ca8a04", "#ffffff"];
const HL_COLORS = ["#facc15", "#4ade80", "#60a5fa", "#f472b6", "#fb923c"];
const SIZES = [2, 3.5, 6, 10];
const SIZE_NAMES = ["דק", "בינוני", "עבה", "עבה מאוד"];
const ERASER_KEY = "shiur.eraser";
const ERASER_SIZES = [{ px: 10, label: "קטן" }, { px: 18, label: "בינוני" }, { px: 32, label: "גדול" }];
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

// TODO(integration): BoardView is getting `lassoMode` and Board `followOn` / `setFollow`
// from a parallel change. These narrow intersection types let the toolbar build before
// that lands and keep type-checking after it; drop them once both are in place.
type LassoMode = "free" | "rect";
type LassoView = BoardView & { lassoMode?: LassoMode };
type FollowBoard = Board & { followOn?: boolean; setFollow?: (on: boolean) => void };

// ---------- popover (pages, files, zoom) ----------
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

export interface ToolbarOpts {
  isTeacher: boolean;
  isStaff: boolean;
  roomName: string;
  /** Teacher: choose a file to pin next to the board (split view). */
  pickSideFile?: () => void;
  /** Teacher: earlier lessons and their PDFs. */
  openLessons?: () => void;
  /** Teacher: save this lesson's PDF now. */
  saveLessonNow?: () => void;
}

/** Tools a student may use while the teacher hasn't allowed writing (they scroll with wheel / finger). */
const POINT_TOOLS: ViewTool[] = ["laser"];

/** The tools that have a button in the first row (in order). */
type BarTool = "pen" | "hl" | "shape" | "eraser" | "lasso" | "laser";

export function buildToolbar(board: Board, view: BoardView, opts: ToolbarOpts) {
  const lv = view as LassoView;
  const fb = board as FollowBoard;
  const toolBtns = new Map<ViewTool, HTMLButtonElement>();
  /** Re-sync the "on" state of every option button; filled by the option builders below. */
  const syncs: (() => void)[] = [];
  const pageLabel = h("span", { class: "pagelbl" });
  const zoomBtn = h("button", { class: "zoomlbl", type: "button", title: "זום" });
  const lockBtn = iconBtn("lock", "התלמיד רק מצביע", () => {
    board.setLock(!board.state.lock.on);
    toast(board.state.lock.on ? "התלמיד יכול רק להצביע עם העכבר" : "התלמיד יכול עכשיו לכתוב על הלוח");
  });
  const followBtn = h("button", { class: "followbtn", type: "button" }, icon("eye", 18), h("span", null, "התלמיד עוקב אחרי הזום שלי"));
  followBtn.addEventListener("click", () => {
    const on = !(fb.followOn ?? true);
    fb.setFollow?.(on);
    toast(on ? "התלמיד רואה את הלוח בדיוק כמוך (זום ומיקום)" : "התלמיד מזיז ומגדיל את הלוח בעצמו");
    refresh();
  });
  const fileInput = h("input", { type: "file", accept: "application/pdf,image/*", hidden: true }) as HTMLInputElement;
  let favs = loadFavs();
  try {
    const px = Number(localStorage.getItem(ERASER_KEY));
    if (ERASER_SIZES.some((z) => z.px === px)) view.eraserPx = px;
  } catch { /* ignore */ }
  if (lv.lassoMode !== "rect") lv.lassoMode = "free";

  fileInput.addEventListener("change", async () => {
    const f = fileInput.files?.[0];
    fileInput.value = "";
    if (!f) return;
    if (f.size > 40 * 1024 * 1024) return toast("הקובץ גדול מדי (עד 40MB)");
    toast(`טוען את ${f.name}…`);
    try { await board.importFile(f); } catch (e) { console.error(e); toast("לא הצלחתי לפתוח את הקובץ"); }
  });

  // ---------- second row: one options panel per tool ----------
  const panels = new Map<BarTool, HTMLElement>();
  const optsRow = h("div", { class: "tb-opts", role: "group", "aria-label": "אפשרויות הכלי" });

  const refreshTools = () => {
    for (const [id, b] of toolBtns) {
      b.classList.toggle("on", id === view.tool);
      b.setAttribute("aria-pressed", String(id === view.tool));
    }
    const shapeBtn = toolBtns.get("shape");
    const shapeIc = shapeBtn?.querySelector(".tbtn-ic");
    if (shapeIc) shapeIc.replaceChildren(icon(SHAPES.find((s) => s.id === view.shape)?.icon ?? "line"));
    for (const [id, p] of panels) p.hidden = id !== view.tool;
    for (const s of syncs) s();
  };

  /** Student without permission to write: only the pointer. */
  const pointOnly = () => !opts.isStaff && board.state.lock.on;
  const setTool = (t: ViewTool) => {
    if (pointOnly() && !POINT_TOOLS.includes(t)) t = "laser";
    view.tool = t;
    if (t !== "lasso") view.clearSelection();
    if (t === "hl" && !HL_COLORS.includes(view.color)) view.color = HL_COLORS[0];
    if ((t === "pen" || t === "shape") && HL_COLORS.includes(view.color)) view.color = COLORS[0];
    refreshTools();
    optsRow.scrollLeft = 0;
  };
  view.onViewChange = () => refresh();

  /** A toggle-style button in the options row. `on` is re-read on every refresh. */
  const opt = (text: string | null, on: () => boolean, onclick: () => void, ic?: string, title?: string, extra = "") => {
    const b = h("button", { class: `optbtn ${extra} ${text ? "" : "icononly"}`, type: "button", title: title ?? text ?? "", "aria-label": title ?? text ?? "" },
      ic ? icon(ic, 18) : null, text ? h("span", null, text) : null);
    b.addEventListener("click", () => { onclick(); refreshTools(); });
    syncs.push(() => {
      const v = on();
      b.classList.toggle("on", v);
      b.setAttribute("aria-pressed", String(v));
    });
    return b;
  };
  const group = (...c: (Node | null)[]) => h("div", { class: "ogroup" }, ...c);
  const glabel = (t: string) => h("span", { class: "olabel" }, t);

  const swatches = (palette: string[], withCustom: boolean) => {
    const out: Node[] = palette.map((c) => {
      const b = h("button", { class: "oswatch", type: "button", title: "צבע", "aria-label": `צבע ${c}` }, h("span", { style: { background: c } }));
      b.addEventListener("click", () => { view.color = c; refreshTools(); });
      syncs.push(() => b.classList.toggle("on", view.color === c));
      return b;
    });
    if (withCustom) {
      const custom = h("input", { type: "color", class: "swatch custom", title: "צבע אחר", "aria-label": "צבע אחר", value: "#000000" }) as HTMLInputElement;
      custom.addEventListener("input", () => { view.color = custom.value; refreshTools(); });
      const wrap = h("label", { class: "oswatch customwrap", title: "צבע אחר" }, custom);
      syncs.push(() => {
        const isCustom = !palette.includes(view.color) && !HL_COLORS.includes(view.color);
        wrap.classList.toggle("on", isCustom);
        if (isCustom && view.color.length === 7 && document.activeElement !== custom) custom.value = view.color;
      });
      out.push(wrap);
    }
    return group(...out);
  };
  const sizes = () => group(...SIZES.map((s, i) => {
    const d = 3 + s * 1.3;
    const b = h("button", { class: "osize", type: "button", title: SIZE_NAMES[i], "aria-label": `עובי ${SIZE_NAMES[i]}` },
      h("span", { style: { width: `${d}px`, height: `${d}px` } }));
    b.addEventListener("click", () => { view.size = s; refreshTools(); });
    syncs.push(() => {
      b.classList.toggle("on", view.size === s);
      (b.firstElementChild as HTMLElement).style.background = view.color === "#ffffff" ? "#9aa3b5" : view.color;
    });
    return b;
  }));
  const dashed = () => opt("מקווקו", () => view.dash, () => { view.dash = !view.dash; }, "dash", "קו מקווקו");

  // favourites: tap to use, long-press (or right-click) to save the current pen into the slot
  const favBtns: HTMLButtonElement[] = [];
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
      try { localStorage.setItem(FAV_KEY, JSON.stringify(favs)); } catch { /* ignore */ }
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
    syncs.push(() => {
      const f = favs[i];
      b.classList.toggle("on", view.tool === f.tool && view.color === f.color && view.size === f.size && view.dash === f.dash);
    });
    draw();
    favBtns.push(b);
  }

  panels.set("pen", h("div", { class: "opanel" },
    group(glabel("מועדפים"), ...favBtns),
    swatches(COLORS, true),
    sizes(),
    group(dashed(), opt("זיהוי צורות", () => view.autoShape, () => { view.autoShape = !view.autoShape; }, "tri", "זיהוי צורות: מציירים צורה ומחזיקים רגע, והיא מתיישרת")),
  ));
  panels.set("hl", h("div", { class: "opanel" },
    swatches(HL_COLORS, false),
    sizes(),
  ));
  panels.set("shape", h("div", { class: "opanel shapes" },
    group(...SHAPES.map((s) => opt(null, () => view.shape === s.id, () => { view.shape = s.id; setTool("shape"); }, s.icon, s.label, "shapebtn"))),
    swatches(COLORS, true),
    sizes(),
    group(dashed(), opt("צירי x / y", () => false, () => view.insertAxes(), "axes", "הוסף צירי x / y לעמוד")),
  ));
  panels.set("eraser", h("div", { class: "opanel" },
    group(glabel("גודל"), ...ERASER_SIZES.map((z, i) => {
      const d = [10, 16, 24][i];
      return opt(z.label, () => view.eraserPx === z.px, () => {
        view.eraserPx = z.px;
        try { localStorage.setItem(ERASER_KEY, String(z.px)); } catch { /* ignore */ }
      }, undefined, `מחק ${z.label}`, `erasersz sz${d}`);
    })),
    group(
      opt("מוחק קו שלם", () => view.eraserMode === "stroke", () => { view.eraserMode = "stroke"; }),
      opt("מחיקה חלקית", () => view.eraserMode === "partial", () => { view.eraserMode = "partial"; }, undefined, "מוחק רק איפה שעוברים"),
    ),
  ));
  panels.set("lasso", h("div", { class: "opanel" },
    group(
      opt("סימון חופשי", () => lv.lassoMode !== "rect", () => { lv.lassoMode = "free"; }, "lasso", "סימון חופשי: מקיפים ביד את מה שרוצים לבחור"),
      opt("מלבן", () => lv.lassoMode === "rect", () => { lv.lassoMode = "rect"; }, "rect", "סימון במלבן: גוררים מלבן סביב מה שרוצים לבחור"),
    ),
    h("span", { class: "ohint" }, "אחרי הסימון: להזיז, להגדיל, לצבוע, להעתיק או למחוק"),
  ));
  panels.set("laser", h("div", { class: "opanel" },
    group(
      opt("עם שובל", () => !view.laserDot, () => { view.laserDot = false; }, "laser"),
      opt("נקודה בלבד", () => view.laserDot, () => { view.laserDot = true; }, "dot"),
    ),
  ));
  for (const p of panels.values()) optsRow.append(p);

  // ---------- first row ----------
  const toolBtn = (id: BarTool, ic: string, text: string, title: string, extra = "", aria = title) => {
    const b = h("button", { class: `tbtn ${extra}`, type: "button", title, "aria-label": aria },
      h("span", { class: "tbtn-ic" }, icon(ic, 22)), h("span", { class: "tbtn-lbl" }, text));
    b.addEventListener("click", () => { closePop(); setTool(id); });
    toolBtns.set(id, b);
    return b;
  };

  const pageMenu = () => h("div", null,
    choice("עמוד חדש", false, () => { closePop(); board.addPage(); }, "plus"),
    opts.isStaff ? choice("דף פרטי חדש (רק אתה רואה)", false, () => { closePop(); board.addPage(true); toast("דף פרטי: התלמיד לא רואה אותו"); }, "lock") : null,
    choice("שכפל עמוד", false, () => { closePop(); board.duplicatePage(); }, "copy"),
    board.canPaste ? choice("הדבק כאן", false, () => { closePop(); view.pasteHere(); }, "paste") : null,
    label("רקע לעמוד"),
    h("div", { class: "pop-grid tpl" }, ...TEMPLATES.map((t) =>
      choice(t.label, (board.currentPage.tpl ?? "grid") === t.id, () => { closePop(); if (board.currentPage.bg) toast("לעמוד עם PDF או תמונה אין רקע"); else board.setTemplate(t.id); }))),
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
  const pdfBtn = iconBtn("pdf", "ייצא את כל הלוח ל-PDF", () => void exportAll(), "pdfbtn");
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
    choice("העלה PDF או תמונה ללוח", false, () => { closePop(); fileInput.click(); }, "upload"),
    opts.pickSideFile ? choice(board.state.side ? "החלף את הקובץ שבצד המסך" : "הצג קובץ בצד המסך (תצוגה מפוצלת)", false, () => { closePop(); opts.pickSideFile!(); }, "split") : null,
    opts.isStaff ? choice("מחשבון גרפים Desmos", false, () => { closePop(); openDesmos((blob) => void board.importFile(blob, "desmos.png")); }, "graph") : null,
    choice("שמור את העמוד כתמונה", false, () => { closePop(); void exportPng(); }, "download"),
    choice("ייצא את כל הלוח ל-PDF", false, () => { closePop(); void exportAll(); }, "pdf"),
    opts.isTeacher ? h("hr") : null,
    opts.saveLessonNow ? choice("שמור עכשיו PDF של השיעור", false, () => { closePop(); opts.saveLessonNow!(); }, "pdf") : null,
    opts.openLessons ? choice("שיעורים קודמים (PDF)", false, () => { closePop(); opts.openLessons!(); }, "history") : null,
    opts.isTeacher ? choice("התחל שיעור חדש (הלוח הנוכחי נשמר)", false, () => {
      closePop();
      if (confirm("להתחיל שיעור חדש? הלוח הנוכחי יישמר כ-PDF ויתחיל לוח ריק.")) board.newLesson();
    }, "plus") : null,
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

  const row1 = h("div", { class: "tb-row" },
    h("div", { class: "tgroup tools" },
      toolBtn("pen", "pen", "עט", "עט (P)"),
      toolBtn("hl", "hl", "מרקר", "מרקר (H)"),
      toolBtn("shape", "line", "צורות", "צורות (S)"),
      toolBtn("eraser", "eraser", "מחק", "מחק (E)"),
      toolBtn("lasso", "lasso", "בחירה", "בחירה: סמן חלק מהלוח כדי להזיז, להגדיל או לצבוע (V)"),
    ),
    h("div", { class: "tgroup pointer-slot" },
      toolBtn("laser", "laser", "פוינטר", "פוינטר להצבעה (L)", "pointer", "לייזר להצבעה (L)"),
    ),
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
    opts.isTeacher ? h("div", { class: "tgroup" }, followBtn, lockBtn) : null,
  );

  const bar = h("div", { class: "toolbar", role: "toolbar", "aria-label": "כלי הלוח" }, row1, optsRow, fileInput);

  let wasLocked: boolean | null = null;
  function refresh() {
    const ps = board.pages;
    const i = ps.findIndex((p) => p.id === board.currentPage.id);
    pageLabel.textContent = `${board.currentPage.priv ? "🔒 " : ""}${i + 1}/${ps.length}`;
    zoomBtn.textContent = `${view.zoomPct}%`;
    const locked = board.state.lock.on;
    lockBtn.classList.toggle("on", !locked);
    lockBtn.replaceChildren(icon(locked ? "lock" : "unlock"));
    lockBtn.title = locked ? "התלמיד רק מצביע עם העכבר. לחץ כדי לאפשר לו לכתוב" : "התלמיד יכול לכתוב. לחץ כדי שרק יצביע";
    lockBtn.setAttribute("aria-label", lockBtn.title);
    const following = fb.followOn ?? true;
    followBtn.classList.toggle("on", following);
    followBtn.setAttribute("aria-pressed", String(following));
    followBtn.title = following
      ? "התלמיד רואה את הלוח בדיוק כמוך (זום ומיקום). לחץ כדי שיזיז בעצמו"
      : "התלמיד מזיז ומגדיל את הלוח בעצמו. לחץ כדי שיעקוב אחרי הזום שלך";
    // Student: drawing tools (and their options) are greyed out until the teacher allows writing.
    if (!opts.isStaff) {
      for (const [id, b] of toolBtns) b.disabled = locked && !POINT_TOOLS.includes(id);
      for (const [id, p] of panels) {
        const off = locked && !POINT_TOOLS.includes(id);
        p.classList.toggle("disabled", off);
        p.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button, input").forEach((el) => { el.disabled = off; });
      }
      if (locked !== wasLocked) setTool(locked ? "laser" : "pen");
      wasLocked = locked;
    }
    refreshTools();
  }

  const KEYS: Record<string, ViewTool> = { p: "pen", h: "hl", s: "shape", e: "eraser", v: "lasso", l: "laser" };
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
