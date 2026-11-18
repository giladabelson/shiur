// Board canvas: rendering, Apple Pencil / mouse / touch input, pan & zoom, and all the tools
// (pen, highlighter, shapes + draw-and-hold recognition, stroke/partial eraser,
// lasso / rectangle select, move, resize, laser). All pages are stacked in one long, scrollable document.

import { getStroke } from "perfect-freehand";
import { applyMat, LASER_FADE_MS, LASER_HOLD_MS, TEMP_FADE_MS, TEMP_HOLD_MS, type Board, type LaserPt, type Mat, type ViewMsg } from "./board";
import { uid, PAGE_W, type BoardState, type Page, type Pt, type Stroke, type Tool, type Template } from "./model";
import { getBackground } from "./pdf";
import { recognize } from "./recognize";

/** "fade" (disappearing ink) has no button any more; peers' disappearing ink is still shown. */
export type ViewTool = "pen" | "hl" | "fade" | "shape" | "eraser" | "lasso" | "laser" | "pan";
export type LassoMode = "free" | "rect";
export type ShapeKind = "line" | "arrow" | "rect" | "ellipse" | "tri";

const PEN_GRACE_MS = 600;
/** Hover laser: the mouse must move this many screen pixels before the pointer appears. */
const LASER_START_PX = 12;
const LASER_WINDOW_MS = 350;
const HOLD_MS = 550;
const HL_ALPHA = 0.35;
const SEL_COLOR = "#2563eb";
/** Two-finger tap: both fingers down and up within this time, each moving less than TAP_MOVE_PX. */
const TAP_MS = 300;
const TAP_MOVE_PX = 15;
/** The second finger must land this soon after the first one for a two-finger tap. */
const TAP_LAND_MS = 150;
/** After writing / touching here, another device's view doesn't move this one for this long. */
const LOCAL_HOLD_MS = 4000;
/** Fingers must move this much (screen px) before the page pans: a resting hand doesn't move it. */
const PAN_START_PX = 10;
/** A pinch must change the finger distance by this much (or move PAN_START_PX) before it zooms. */
const PINCH_START = 0.06;

interface Drawable {
  tool: Tool;
  color: string;
  size: number;
  sp: boolean;
  dash?: boolean;
  pts: Pt[];
  /** Version of the stroke's points / size (bumped by every move, resize or restyle). */
  pv?: number;
}

/** Outline paths of freehand strokes, by stroke id, valid for one version of the stroke. */
export type PathCache = Map<string, { pv: number; path: Path2D }>;

function svgPath(points: number[][]): string {
  if (points.length < 4) return "";
  const avg = (a: number, b: number) => (a + b) / 2;
  let a = points[0], b = points[1];
  const c = points[2];
  let d = `M${a[0].toFixed(2)},${a[1].toFixed(2)} Q${b[0].toFixed(2)},${b[1].toFixed(2)} ${avg(b[0], c[0]).toFixed(2)},${avg(b[1], c[1]).toFixed(2)} T`;
  for (let i = 2; i < points.length - 1; i++) {
    a = points[i];
    b = points[i + 1];
    d += `${avg(a[0], b[0]).toFixed(2)},${avg(a[1], b[1]).toFixed(2)} `;
  }
  return d + "Z";
}

function freehandPath(s: Drawable, last: boolean): Path2D {
  const hl = s.tool === "hl";
  const outline = getStroke(s.pts, {
    size: hl ? s.size * 4 : s.size,
    thinning: hl ? 0 : 0.55,
    smoothing: 0.5,
    streamline: 0.35,
    simulatePressure: s.sp && !hl,
    last,
  });
  return new Path2D(svgPath(outline));
}

const isShape = (t: Tool) => t !== "pen" && t !== "hl";

/** Outline of a shape as a polyline (also used for hit-testing and selection). */
export function shapePolyline(s: Drawable): [number, number][] {
  const [a, b] = [s.pts[0], s.pts[s.pts.length - 1]];
  if (!a || !b) return [];
  switch (s.tool) {
    case "line":
    case "arrow":
      return [[a[0], a[1]], [b[0], b[1]]];
    case "rect":
      return [[a[0], a[1]], [b[0], a[1]], [b[0], b[1]], [a[0], b[1]], [a[0], a[1]]];
    case "poly":
      return [...s.pts.map((p) => [p[0], p[1]] as [number, number]), [s.pts[0][0], s.pts[0][1]]];
    case "ellipse": {
      const cx = (a[0] + b[0]) / 2, cy = (a[1] + b[1]) / 2, rx = Math.abs(b[0] - a[0]) / 2, ry = Math.abs(b[1] - a[1]) / 2;
      const out: [number, number][] = [];
      for (let i = 0; i <= 64; i++) {
        const t = (i / 64) * Math.PI * 2;
        out.push([cx + rx * Math.cos(t), cy + ry * Math.sin(t)]);
      }
      return out;
    }
    default:
      return s.pts.map((p) => [p[0], p[1]]);
  }
}

export function drawStroke(ctx: CanvasRenderingContext2D, s: Drawable, cache?: PathCache, id?: string, last = true) {
  if (!s.pts.length) return;
  if ((s.tool === "pen" || s.tool === "hl") && !s.dash) {
    // The cached outline is only valid for the version it was made from: a moved / resized
    // stroke must never be drawn at its old place.
    const pv = s.pv ?? 0;
    const hit = id ? cache?.get(id) : undefined;
    let path = hit && hit.pv === pv ? hit.path : undefined;
    if (!path) {
      path = freehandPath(s, last);
      if (id && cache) cache.set(id, { pv, path });
    }
    ctx.globalAlpha = s.tool === "hl" ? HL_ALPHA : 1;
    ctx.fillStyle = s.color;
    ctx.fill(path);
    ctx.globalAlpha = 1;
    return;
  }
  const poly = shapePolyline(s);
  if (poly.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(poly[0][0], poly[0][1]);
  for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i][0], poly[i][1]);
  ctx.strokeStyle = s.color;
  ctx.lineWidth = s.tool === "hl" ? s.size * 4 : s.size;
  ctx.globalAlpha = s.tool === "hl" ? HL_ALPHA : 1;
  ctx.lineCap = ctx.lineJoin = "round";
  if (s.dash) ctx.setLineDash([s.size * 3, s.size * 2.5]);
  ctx.stroke();
  ctx.setLineDash([]);
  if (s.tool === "arrow") {
    const [ax, ay] = poly[0], [bx, by] = poly[1];
    const ang = Math.atan2(by - ay, bx - ax);
    const head = Math.max(10, s.size * 4);
    ctx.beginPath();
    ctx.moveTo(bx - head * Math.cos(ang - 0.45), by - head * Math.sin(ang - 0.45));
    ctx.lineTo(bx, by);
    ctx.lineTo(bx - head * Math.cos(ang + 0.45), by - head * Math.sin(ang + 0.45));
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

/** Paper templates, drawn under the ink (only on pages without a PDF/image background). */
export function drawTemplate(ctx: CanvasRenderingContext2D, p: Page, scale: number) {
  const tpl: Template = p.tpl ?? "grid"; // squared paper unless the teacher picks another
  if (tpl === "blank" || p.bg) return;
  const hair = 1 / scale;
  ctx.save();
  if (tpl === "grid" || tpl === "mm") {
    const minor = tpl === "mm" ? 10 : 40;
    const major = tpl === "mm" ? 50 : 0;
    for (const [step, color, width] of [[minor, tpl === "mm" ? "#cfe3f5" : "#d6e2ee", hair], ...(major ? [[major, "#9fc3e6", hair * 1.6]] : [])] as [number, string, number][]) {
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(width, 0.4);
      ctx.beginPath();
      for (let x = step; x < p.w; x += step) { ctx.moveTo(x, 0); ctx.lineTo(x, p.h); }
      for (let y = step; y < p.h; y += step) { ctx.moveTo(0, y); ctx.lineTo(p.w, y); }
      ctx.stroke();
    }
  } else if (tpl === "lines") {
    ctx.strokeStyle = "#c8d6e5";
    ctx.lineWidth = Math.max(hair, 0.6);
    ctx.beginPath();
    for (let y = 60; y < p.h; y += 36) { ctx.moveTo(0, y); ctx.lineTo(p.w, y); }
    ctx.stroke();
    ctx.strokeStyle = "#f2a5a5";
    ctx.beginPath();
    ctx.moveTo(p.w - 70, 0);
    ctx.lineTo(p.w - 70, p.h);
    ctx.stroke();
  } else if (tpl === "dots") {
    ctx.fillStyle = "#b8c4d1";
    const r = Math.max(1.4, 1.2 / scale);
    for (let x = 30; x < p.w; x += 30) for (let y = 30; y < p.h; y += 30) {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

function distToSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const x = ax + t * dx - px, y = ay + t * dy - py;
  return Math.sqrt(x * x + y * y);
}

function strokeReach(s: Stroke) {
  return s.tool === "hl" ? s.size * 2 : s.size / 2;
}

function hitStroke(s: Stroke, x: number, y: number, r: number): boolean {
  const pts: [number, number][] = isShape(s.tool) || s.dash ? shapePolyline(s) : s.pts.map((p) => [p[0], p[1]]);
  const rr = r + strokeReach(s);
  if (pts.length === 1) return Math.hypot(pts[0][0] - x, pts[0][1] - y) <= rr;
  for (let i = 1; i < pts.length; i++) {
    if (distToSeg(x, y, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]) <= rr) return true;
  }
  return false;
}

/** Adds points so consecutive points are at most `step` apart (needed before splitting a stroke). */
function densify(pts: Pt[], step: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    if (i > 0) {
      const b = pts[i - 1];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      const n = Math.floor(d / step);
      for (let k = 1; k < n; k++) {
        const t = k / n;
        out.push([b[0] + (a[0] - b[0]) * t, b[1] + (a[1] - b[1]) * t, b[2] + (a[2] - b[2]) * t]);
      }
    }
    out.push(a);
  }
  return out;
}

function pointInPoly(x: number, y: number, poly: [number, number][]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-9) + xi) inside = !inside;
  }
  return inside;
}

function bboxOf(strokes: Stroke[]) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of strokes) {
    const pts = isShape(s.tool) ? shapePolyline(s) : s.pts.map((p) => [p[0], p[1]]);
    const pad = strokeReach(s) + (s.tool === "arrow" ? Math.max(10, s.size * 4) : 0);
    for (const [x, y] of pts) {
      x0 = Math.min(x0, x - pad); y0 = Math.min(y0, y - pad);
      x1 = Math.max(x1, x + pad); y1 = Math.max(y1, y + pad);
    }
  }
  return { x0, y0, x1, y1 };
}

/** Renders one page (template, background, ink) onto a canvas, used for PNG/PDF export. */
export function renderPage(board: Pick<Board, "strokes">, page: Page, widthPx: number): Promise<HTMLCanvasElement> {
  return new Promise((resolve) => {
    const c = document.createElement("canvas");
    const s = widthPx / page.w;
    c.width = Math.round(page.w * s);
    c.height = Math.round(page.h * s);
    let done = false;
    const paint = (final: boolean) => {
      if (done) return;
      const ctx = c.getContext("2d")!;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.setTransform(s, 0, 0, s, 0, 0);
      drawTemplate(ctx, page, s);
      let ready = true;
      if (page.bg) {
        const img = getBackground(page.bg, widthPx, () => paint(true));
        if (img) ctx.drawImage(img, 0, 0, page.w, page.h);
        else ready = false;
      }
      for (const st of board.strokes(page.id)) drawStroke(ctx, st);
      if (ready || final) {
        done = true;
        resolve(c);
      }
    };
    paint(false);
    setTimeout(() => paint(true), 6000);
  });
}

/** Space between pages in the continuous (notebook) layout, in page units. */
export const PAGE_GAP = 24;
const FIT_PAD = 12;
/** A teacher's device sends its view at most this often while it moves, plus once when it settles. */
const VIEW_SEND_MS = 60;
const VIEW_SETTLE_MS = 160;

export class BoardView {
  readonly el: HTMLDivElement;
  private base: HTMLCanvasElement;
  private top: HTMLCanvasElement;
  private bctx: CanvasRenderingContext2D;
  private tctx: CanvasRenderingContext2D;
  private selMenu: HTMLDivElement;
  private tapMenu: HTMLDivElement;
  /** Where the last one-finger tap was (for "paste here" / "select all" in the tap menu). */
  private tapAt: { page: string; x: number; y: number } | null = null;
  private privBadge: HTMLDivElement;
  private dpr = 1;
  private cssW = 0;
  private cssH = 0;
  private scale = 1;
  /** Offset of the document (all pages stacked) on screen, in CSS pixels. */
  private ox = 0;
  private oy = 0;
  private fit = true;
  private paths: PathCache = new Map();
  private baseDirty = true;
  private topDirty = true;
  private raf = 0;
  private pendingAdds: string[] = [];

  // continuous layout: every live page stacked vertically
  private layout = new Map<string, number>();
  private layoutPages: Page[] = [];
  private docW = PAGE_W;
  private docH = 1;
  private layoutDirty = true;
  /** The board state object we laid out (a new one = a new board / lesson: start at page 1). */
  private stateRef: BoardState | null = null;
  private needsHome = true;
  /** Version of the last "go" we scrolled to (scrolling ourselves doesn't change it). */
  private goTs = -1;
  private viewSentAt = 0;
  private viewSettle: number | undefined;
  private pendingView: { v: ViewMsg; at: number } | null = null;
  /** The teacher's view we're showing, until this user moves the view themselves (kept across resizes). */
  private followed: ViewMsg | null = null;

  tool: ViewTool = "pen";
  shape: ShapeKind = "line";
  color = "#1f2937";
  size = 3.5;
  dash = false;
  eraserMode: "stroke" | "partial" = "stroke";
  /** Eraser radius in screen pixels (the same on every zoom level). */
  eraserPx = 18;
  laserDot = false;
  /** Lasso: draw around the selection freehand, or drag a rectangle. */
  lassoMode: LassoMode = "free";
  autoShape = true;
  /** Whether this user may draw right now (lock). */
  canDraw: () => boolean = () => true;
  onViewChange: () => void = () => {};
  onSelectionChange: () => void = () => {};

  // input state
  private penActive = false;
  private penSeenAt = 0;
  private penMode = false;
  /** Fingers draw (only before a Pencil is seen). Off: fingers only scroll and zoom, the pen writes. */
  fingersDraw = false;
  /** The view when the first finger of the current touch landed: a pen landing after a palm puts it back. */
  private touchView: { scale: number; ox: number; oy: number; fit: boolean } | null = null;
  /** Last time the pen / mouse / a finger was used on this device. */
  private localAt = -Infinity;
  private drawing: (Drawable & {
    id: string; page: string; kind: ViewTool; pointerId: number; sentUpTo: number; snapped: boolean; origin: [number, number];
    /** Touch strokes are streamed only after a moment (a two-finger tap / pinch cancels them first). */
    streamAt: number;
    /** A snapped closed shape: moving the pen resizes it around its center (until the pen lifts). */
    resize?: { cx: number; cy: number; d0: number; base: Pt[] };
  }) | null = null;
  private holdTimer: number | undefined;
  private holdAnchor: [number, number] = [0, 0];
  private predicted: Pt[] = [];
  /** last: previous eraser position in document units */
  private erasing: { pointerId: number; ids: Set<string>; added: string[]; last: [number, number] | null } | null = null;
  /** rect: a rectangle from pts[0] to the last point instead of a freehand outline. */
  private lasso: { pointerId: number; page: string; pts: [number, number][]; rect: boolean } | null = null;
  private sel: { ids: string[]; page: string; box: { x0: number; y0: number; x1: number; y1: number } } | null = null;
  private selDrag: { pointerId: number; mode: "move" | "scale"; start: [number, number]; anchor: [number, number]; m: Mat; lastSent: number; drag: { g: string; v: number } } | null = null;
  private touches = new Map<number, { x: number; y: number }>();
  private gesture: { startDist: number; startScale: number; cx: number; cy: number; ox: number; oy: number; px: number; py: number; live: boolean } | null = null;
  /** live: false until the finger moved enough (a hand resting on the screen doesn't move the page). */
  private panning: { pointerId: number; x: number; y: number; ox: number; oy: number; live: boolean } | null = null;
  private hover: { x: number; y: number; on: boolean } = { x: 0, y: 0, on: false };
  private spaceDown = false;
  /** Laser samples since the last frame (all on one page, one segment, one hover state). */
  private laserQueued: { page: string; pts: LaserPt[] } | null = null;
  /** Laser segment: a new one starts at every press and when it ends (a hovering mouse after it). */
  private laserSeg = 0;
  /** Two-finger tap in progress (cleared as soon as it turns into a pinch / pan or a third finger). */
  private tap: { t0: number; n: number; start: Map<number, { x: number; y: number }>; view: { scale: number; ox: number; oy: number; fit: boolean } } | null = null;
  /** Where a hovering mouse last came to rest; the pointer only shows once it really moves. */
  private laserRest: { x: number; y: number; at: number } | null = null;
  private laserDown: number | null = null;

  constructor(private board: Board) {
    this.el = document.createElement("div");
    this.el.className = "board-canvas";
    this.base = document.createElement("canvas");
    this.top = document.createElement("canvas");
    this.base.className = "layer";
    this.top.className = "layer";
    this.selMenu = document.createElement("div");
    this.selMenu.className = "sel-menu";
    this.selMenu.hidden = true;
    this.privBadge = document.createElement("div");
    this.privBadge.className = "priv-badge";
    this.privBadge.textContent = "🔒 דף פרטי: התלמיד לא רואה אותו";
    this.privBadge.hidden = true;
    this.tapMenu = document.createElement("div");
    this.tapMenu.className = "sel-menu tap-menu";
    this.tapMenu.hidden = true;
    this.el.append(this.base, this.top, this.selMenu, this.tapMenu, this.privBadge);
    this.bctx = this.base.getContext("2d")!;
    this.tctx = this.top.getContext("2d", { desynchronized: true } as CanvasRenderingContext2DSettings)!;
    new ResizeObserver(() => this.resize()).observe(this.el);
    this.bindInput();
    this.loop();
  }

  invalidate(what: "all" | "live" | "page" | "lock" | "stroke" | "side" | "lesson", strokeId?: string) {
    if (what === "side") return; // the side file is drawn by its own panel
    if (what === "lesson") {
      this.clearSelection();
      this.needsHome = true; // start the new lesson at its first page
      what = "all";
    }
    if (what === "stroke" && strokeId) {
      // A new stroke is drawn on top of the existing base layer instead of redrawing everything.
      if (!this.baseDirty) this.pendingAdds.push(strokeId);
      this.topDirty = true;
      return;
    }
    if (what === "all" || what === "page") {
      this.layoutDirty = true;
      this.baseDirty = true;
      if (this.paths.size > 5000) this.paths.clear();
      if (this.sel) this.refreshSelection();
    }
    this.topDirty = true;
  }

  // ---------- layout ----------
  /** The current page (the one at the center of the screen, or the one the teacher went to). */
  private get page(): Page {
    return this.board.currentPage;
  }

  private ensureLayout() {
    if (!this.layoutDirty) return;
    this.layoutDirty = false;
    // Keep what's on screen in place when pages are added / removed above it.
    const anchor = this.board.state.current.page;
    const before = this.layout.get(anchor);
    const ps = this.board.pages;
    this.layout.clear();
    let y = 0, w = 1;
    for (const p of ps) {
      this.layout.set(p.id, y);
      y += p.h + PAGE_GAP;
      w = Math.max(w, p.w);
    }
    this.layoutPages = ps;
    this.docH = Math.max(1, y - PAGE_GAP);
    this.docW = w;
    const after = this.layout.get(anchor);
    if (before !== undefined && after !== undefined && before !== after && !this.needsHome) {
      this.oy -= (after - before) * this.scale;
      this.clampView();
      this.baseDirty = this.topDirty = true;
      this.placeSelMenu();
    }
  }

  /** Top of a page in document units (undefined if it isn't on the board). */
  private topOf(pageId: string): number | undefined {
    this.ensureLayout();
    return this.layout.get(pageId);
  }

  /** The page at a document y, or the nearest one (e.g. in the gap between two pages). */
  private pageAtY(y: number): Page {
    this.ensureLayout();
    let best: Page | null = null, bd = Infinity;
    for (const p of this.layoutPages) {
      const t = this.layout.get(p.id)!;
      const d = y < t ? t - y : y > t + p.h ? y - t - p.h : 0;
      if (d < bd) { bd = d; best = p; }
      if (d === 0 || t > y) break;
    }
    return best ?? this.board.currentPage;
  }

  /** Pages that are (at least partly) on screen. */
  private visiblePages(): Page[] {
    this.ensureLayout();
    const y0 = -this.oy / this.scale, y1 = (this.cssH - this.oy) / this.scale;
    return this.layoutPages.filter((p) => {
      const t = this.layout.get(p.id)!;
      return t < y1 && t + p.h > y0;
    });
  }

  /** Where a page is on screen (CSS pixels relative to the board element); for the tests and overlays. */
  pageRect(pageId = this.page.id): { x: number; y: number; w: number; h: number } | null {
    const p = this.board.state.pages[pageId];
    const t = this.topOf(pageId);
    if (!p || t === undefined) return null;
    return { x: this.ox, y: this.oy + t * this.scale, w: p.w * this.scale, h: p.h * this.scale };
  }

  // ---------- view transform ----------
  private resize() {
    const r = this.el.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    // If the whole current page was on screen before (not zoomed in), keep it whole in the new
    // size, e.g. when the side file opens and the board gets narrower.
    const pr = this.cssW > 1 ? this.pageRect() : null;
    const wasWhole = !!pr && pr.w <= this.cssW + 1 && pr.h <= this.cssH + 1;
    if (wasWhole) this.fit = true;
    this.cssW = Math.max(1, r.width);
    this.cssH = Math.max(1, r.height);
    for (const c of [this.base, this.top]) {
      c.width = Math.round(this.cssW * this.dpr);
      c.height = Math.round(this.cssH * this.dpr);
    }
    if (this.followed && !this.busy && this.board.followOn && this.layout.has(this.followed.page)) {
      // Following the teacher: keep showing the same region when this window changes size.
      this.applyRemoteView(this.followed);
      return;
    }
    if (this.fit) this.fitTo(this.page);
    this.viewChanged(false);
    // The teacher's board changed size (e.g. a video tile was added): the student follows the new view.
    if (this.cssW > 1) this.queueViewSend();
  }

  /**
   * Fit the page on screen, its top at the top: a landscape page as wide as possible while the
   * whole page fits; a portrait page as wide as the screen (scroll down to write further, like a notebook).
   */
  private fitTo(p: Page) {
    this.ensureLayout();
    const top = this.layout.get(p.id) ?? 0;
    const byW = (this.cssW - FIT_PAD * 2) / p.w, byH = (this.cssH - FIT_PAD * 2) / p.h;
    this.scale = Math.max(0.05, p.h > p.w ? byW : Math.min(byW, byH));
    this.ox = (this.cssW - p.w * this.scale) / 2;
    this.oy = this.docH * this.scale <= this.cssH ? (this.cssH - this.docH * this.scale) / 2 : FIT_PAD - top * this.scale;
    this.fit = true;
  }

  /** "Fit to screen" (toolbar). */
  fitPage() {
    this.fitTo(this.page);
    this.viewChanged(true);
  }

  zoomBy(f: number, cx = this.cssW / 2, cy = this.cssH / 2) {
    const ns = Math.max(0.1, Math.min(12, this.scale * f));
    const k = ns / this.scale;
    this.ox = cx - (cx - this.ox) * k;
    this.oy = cy - (cy - this.oy) * k;
    this.scale = ns;
    this.fit = false;
    this.viewChanged(true);
  }

  /** Keeps the board on screen: scrolling, panning or zooming can never push it out of view. */
  private clampView() {
    if (this.cssW <= 1 || this.cssH <= 1) return; // hidden (e.g. a shared screen is on stage)
    this.ensureLayout();
    this.ox = clampAxis(this.ox, this.docW * this.scale, this.cssW);
    this.oy = clampAxis(this.oy, this.docH * this.scale, this.cssH);
  }

  /** user: the user moved the view here (not a page switch or the teacher's view arriving). */
  private viewChanged(user: boolean) {
    this.clampView();
    this.baseDirty = this.topDirty = true;
    if (user) {
      this.hideTapMenu();
      this.pendingView = null;
      this.followed = null;
      this.updateCurrentFromCenter();
      // While two fingers may still be a tap (undo), the view isn't sent: a tap puts it back.
      if (!this.tap) this.queueViewSend();
    }
    this.placeSelMenu();
    this.onViewChange();
  }

  /** Scrolling: the page at the center of the screen becomes the current one (on this device only). */
  private updateCurrentFromCenter() {
    if (this.cssW <= 1) return;
    const p = this.pageAtY((this.cssH / 2 - this.oy) / this.scale);
    if (p && p.id !== this.board.state.current.page) this.board.setCurrentLocal(p.id);
  }

  /** Brings a page into view after a page switch (toolbar, new page, imported file, the teacher). */
  private showPage(p: Page) {
    if (this.cssW <= 1) return;
    if (this.fit) this.fitTo(p);
    else this.oy = FIT_PAD - (this.topOf(p.id) ?? 0) * this.scale;
    this.clearSelection();
    this.viewChanged(false);
  }

  get zoomPct() {
    return Math.round(this.scale * 100);
  }

  /** Page units -> CSS pixels relative to the board element. */
  toScreen(x: number, y: number, pageId = this.sel?.page ?? this.page.id): [number, number] {
    const t = this.topOf(pageId) ?? 0;
    return [this.ox + x * this.scale, this.oy + (t + y) * this.scale];
  }

  /** Client coordinates -> document units (all pages stacked). */
  private toDoc(clientX: number, clientY: number): [number, number] {
    const r = this.el.getBoundingClientRect();
    return [(clientX - r.left - this.ox) / this.scale, (clientY - r.top - this.oy) / this.scale];
  }

  /** Client coordinates -> units of the given page. */
  private toLocal(clientX: number, clientY: number, pageId: string): [number, number] {
    const [x, y] = this.toDoc(clientX, clientY);
    return [x, y - (this.topOf(pageId) ?? 0)];
  }

  /** Center of what's visible, in units of the current page (where new things get inserted). */
  visibleCenter(): [number, number] {
    const p = this.page;
    const t = this.topOf(p.id) ?? 0;
    const cx = (this.cssW / 2 - this.ox) / this.scale, cy = (this.cssH / 2 - this.oy) / this.scale - t;
    return [Math.min(p.w - 50, Math.max(50, cx)), Math.min(p.h - 50, Math.max(50, cy))];
  }

  // ---------- following the teacher's view ----------
  /** What this device shows, relative to the page at the center of the screen. */
  viewMessage(): ViewMsg | null {
    if (this.cssW <= 1 || this.cssH <= 1) return null;
    const dx = (this.cssW / 2 - this.ox) / this.scale, dy = (this.cssH / 2 - this.oy) / this.scale;
    const p = this.pageAtY(dy);
    const t = this.layout.get(p.id) ?? 0;
    const r = (n: number) => Math.round(n * 10) / 10;
    return { page: p.id, cx: r(dx), cy: r(dy - t), w: r(this.cssW / this.scale), h: r(this.cssH / this.scale) };
  }

  /** Teacher's devices: send the view while it moves (throttled) and once more when it settles. */
  private queueViewSend() {
    if (!this.board.isStaff || !this.board.followOn) return;
    const now = performance.now();
    if (now - this.viewSentAt >= VIEW_SEND_MS) this.sendViewNow();
    clearTimeout(this.viewSettle);
    this.viewSettle = window.setTimeout(() => this.sendViewNow(), VIEW_SETTLE_MS);
  }

  /** Sends this device's view to everyone (or one peer that just connected). */
  sendViewNow(peerId?: string) {
    if (!peerId) this.viewSentAt = performance.now();
    const m = this.viewMessage();
    if (m) this.board.sendView(m, peerId);
  }

  /** True while the user is drawing, selecting or moving the board on this device. */
  private get busy() {
    return !!(this.drawing || this.lasso || this.selDrag || this.erasing || this.panning || this.gesture || this.touches.size);
  }

  /** Show the same part of the board as the teacher (never sent on: no loops). */
  applyRemoteView(v: ViewMsg) {
    // While writing here (e.g. on the iPad between strokes), the other device's view never moves the page.
    if (this.busy || (this.board.isStaff && performance.now() - this.localAt < LOCAL_HOLD_MS)) return;
    const top = this.board.state === this.stateRef ? this.topOf(v.page) : undefined;
    if (top === undefined || this.cssW <= 1 || this.cssH <= 1) {
      // The page hasn't arrived yet (or the board is hidden): apply it when it can be.
      this.pendingView = { v, at: performance.now() };
      return;
    }
    this.pendingView = null;
    this.followed = v;
    // This is newer than a page switch that may still be waiting to be shown (e.g. from the snapshot).
    this.needsHome = false;
    this.goTs = this.board.state.current.ts;
    this.scale = Math.max(0.1, Math.min(12, Math.min(this.cssW / v.w, this.cssH / v.h)));
    this.ox = this.cssW / 2 - v.cx * this.scale;
    this.oy = this.cssH / 2 - (top + v.cy) * this.scale;
    this.fit = false;
    this.board.setCurrentLocal(v.page);
    this.viewChanged(false);
  }

  // ---------- rendering ----------
  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    if (this.board.state !== this.stateRef) {
      // A different board: loaded from storage, or a new lesson.
      this.stateRef = this.board.state;
      this.layoutDirty = true;
      this.needsHome = true;
      this.clearSelection();
    }
    this.ensureLayout();
    if (this.needsHome && this.cssW > 1 && this.followed && this.layout.has(this.followed.page)) {
      // The board was (re)loaded while following the teacher: stay on the teacher's view.
      this.needsHome = false;
      this.applyRemoteView(this.followed);
    } else if (this.needsHome && this.cssW > 1) {
      // Opening a board: show its first page.
      this.needsHome = false;
      this.goTs = this.board.state.current.ts;
      const first = this.board.pages[0];
      if (first) {
        this.board.setCurrentLocal(first.id);
        this.fitTo(first);
      }
      this.viewChanged(false);
    } else if (this.board.state.current.ts !== this.goTs && this.cssW > 1) {
      // Someone went to a page (toolbar, new page, imported file, the teacher's other device).
      this.goTs = this.board.state.current.ts;
      this.showPage(this.page);
    }
    if (this.pendingView) {
      if (performance.now() - this.pendingView.at > 10_000) this.pendingView = null;
      else if (this.layout.has(this.pendingView.v.page) && this.cssW > 1) this.applyRemoteView(this.pendingView.v);
    }
    const priv = !!this.page.priv;
    if (this.privBadge.hidden === priv) this.privBadge.hidden = !priv;
    if (this.board.tick(performance.now()) || this.board.lasers.size) this.topDirty = true;
    this.flushLive();
    if (this.baseDirty) {
      this.pendingAdds = [];
      this.drawBase();
    } else if (this.pendingAdds.length) this.drawAdds();
    if (this.topDirty) this.drawTop();
  };

  destroy() {
    cancelAnimationFrame(this.raf);
    clearTimeout(this.viewSettle);
  }

  /** Document transform, shifted down to a page's top (page units from there on). */
  private applyTransform(ctx: CanvasRenderingContext2D, top = 0) {
    const k = this.dpr * this.scale;
    ctx.setTransform(k, 0, 0, k, this.dpr * this.ox, this.dpr * (this.oy + top * this.scale));
  }

  /** Sets the transform for drawing on a page; false if that page isn't on the board. */
  private onPage(ctx: CanvasRenderingContext2D, pageId: string): boolean {
    const t = this.layout.get(pageId);
    if (t === undefined) return false;
    this.applyTransform(ctx, t);
    return true;
  }

  /** Strokes not drawn on the base layer because they're being moved (by us or a peer). */
  private hiddenIds(): Set<string> {
    const out = new Set<string>(this.board.previews.keys());
    if (this.selDrag && this.sel) for (const id of this.sel.ids) out.add(id);
    return out;
  }

  private drawBase() {
    this.baseDirty = false;
    const ctx = this.bctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.base.width, this.base.height);
    const pages = this.visiblePages();
    if (!pages.length) return;
    // Group the ink of the visible pages in one pass over all strokes.
    const byPage = new Map<string, Stroke[]>(pages.map((p) => [p.id, []]));
    for (const s of Object.values(this.board.state.strokes)) {
      if (!s.del) byPage.get(s.page)?.push(s);
    }
    const hidden = this.hiddenIds();
    for (const p of pages) {
      this.onPage(ctx, p.id);
      ctx.shadowColor = "rgba(0,0,0,0.18)";
      ctx.shadowBlur = 12;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, p.w, p.h);
      ctx.shadowBlur = 0;
      ctx.shadowColor = "transparent";
      drawTemplate(ctx, p, this.scale);
      if (p.bg) {
        const img = getBackground(p.bg, p.w * this.scale * this.dpr, () => { this.baseDirty = true; });
        if (img) ctx.drawImage(img, 0, 0, p.w, p.h);
        else {
          ctx.fillStyle = "#94a3b8";
          ctx.font = "24px system-ui";
          ctx.textAlign = "center";
          ctx.fillText("טוען את הקובץ…", p.w / 2, p.h / 2);
        }
      }
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, p.w, p.h);
      ctx.clip();
      const list = byPage.get(p.id)!.sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1));
      for (const s of list) if (!hidden.has(s.id)) drawStroke(ctx, s, this.paths, s.id);
      ctx.restore();
    }
  }

  private drawAdds() {
    const ctx = this.bctx;
    for (const id of this.pendingAdds) {
      const s = this.board.state.strokes[id];
      const p = s && this.board.state.pages[s.page];
      if (!s || s.del || !p || !this.onPage(ctx, s.page)) continue;
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, p.w, p.h);
      ctx.clip();
      drawStroke(ctx, s, this.paths, s.id);
      ctx.restore();
    }
    this.pendingAdds = [];
  }

  private drawTop() {
    this.topDirty = false;
    const ctx = this.tctx;
    const now = performance.now();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.top.width, this.top.height);

    // strokes being moved: by us (lasso drag) or by a peer (preview transform)
    const moved: [Stroke, Mat][] = [];
    for (const [id, m] of this.board.previews) {
      const s = this.board.state.strokes[id];
      if (s && !s.del) moved.push([s, m]);
    }
    if (this.selDrag && this.sel) {
      for (const id of this.sel.ids) {
        const s = this.board.state.strokes[id];
        if (s) moved.push([s, this.selDrag.m]);
      }
    }
    for (const [s, m] of moved) {
      if (!this.onPage(ctx, s.page)) continue;
      ctx.save();
      ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
      // The cached outline under the drag's matrix: no perfect-freehand work on every frame.
      drawStroke(ctx, s, this.paths, s.id);
      ctx.restore();
    }

    for (const ls of this.board.live.values()) {
      // A live stroke can have a hole where a packet is still on its way; draw what arrived.
      if (this.onPage(ctx, ls.page)) drawStroke(ctx, { ...ls, pts: ls.pts.filter(Boolean) }, undefined, undefined, false);
    }
    for (const t of this.board.temps.values()) {
      if (!this.onPage(ctx, t.s.page)) continue;
      const age = now - t.at;
      const alpha = age < TEMP_HOLD_MS ? 1 : Math.max(0, 1 - (age - TEMP_HOLD_MS) / TEMP_FADE_MS);
      ctx.globalAlpha = alpha;
      drawStroke(ctx, t.s);
      ctx.globalAlpha = 1;
    }
    if (this.drawing && this.onPage(ctx, this.drawing.page)) {
      const d = this.drawing;
      const pts = !isShape(d.tool) && !d.snapped ? d.pts.concat(this.predicted) : d.pts;
      drawStroke(ctx, { ...d, pts }, undefined, undefined, false);
    }
    // lasers
    for (const l of this.board.lasers.values()) {
      if (!this.onPage(ctx, l.page)) continue;
      if (!l.dot) this.drawLaserTrail(ctx, l.trail, now);
      // The red dot: in dot mode, or where a hovering pointer is (so the student sees where it
      // points). While a trail is being drawn only the trail shows.
      if (l.head.show) {
        const h = l.head;
        const r = (l.dot ? 9 : 6) / this.scale;
        ctx.fillStyle = "rgba(239,68,68,0.25)";
        ctx.beginPath();
        ctx.arc(h.x, h.y, r * 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "rgba(239,68,68,0.95)";
        ctx.beginPath();
        ctx.arc(h.x, h.y, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // lasso outline
    if (this.lasso && this.lasso.pts.length > 1 && this.onPage(ctx, this.lasso.page)) {
      const poly = this.lassoPoly(this.lasso);
      ctx.beginPath();
      ctx.moveTo(poly[0][0], poly[0][1]);
      for (const [x, y] of poly) ctx.lineTo(x, y);
      ctx.closePath();
      ctx.fillStyle = "rgba(37,99,235,0.06)";
      ctx.fill();
      ctx.strokeStyle = SEL_COLOR;
      ctx.lineWidth = 1.5 / this.scale;
      ctx.setLineDash([6 / this.scale, 4 / this.scale]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // selection box + handles
    if (this.sel && this.onPage(ctx, this.sel.page)) {
      const b = this.selBoxNow();
      ctx.strokeStyle = SEL_COLOR;
      ctx.lineWidth = 1.5 / this.scale;
      ctx.setLineDash([6 / this.scale, 4 / this.scale]);
      ctx.strokeRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
      ctx.setLineDash([]);
      const hr = 7 / this.scale;
      for (const [x, y] of [[b.x0, b.y0], [b.x1, b.y0], [b.x0, b.y1], [b.x1, b.y1]]) {
        ctx.fillStyle = "#fff";
        ctx.beginPath();
        ctx.arc(x, y, hr, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
    // hover cursor (document units)
    if (this.hover.on && !this.drawing && !this.lasso) {
      this.applyTransform(ctx);
      const [x, y] = this.toDoc(this.hover.x, this.hover.y);
      ctx.beginPath();
      if (this.tool === "eraser") {
        ctx.arc(x, y, this.eraserRadius(), 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(100,116,139,0.8)";
        ctx.lineWidth = 1 / this.scale;
        ctx.stroke();
      } else if (this.tool === "pen" || this.tool === "hl" || this.tool === "fade") {
        ctx.arc(x, y, Math.max(1.5 / this.scale, this.tool === "hl" ? this.size * 2 : this.size / 2), 0, Math.PI * 2);
        ctx.fillStyle = this.tool === "hl" ? this.color + "66" : this.color;
        ctx.fill();
      }
    }
  }

  private eraserRadius() {
    return this.eraserPx / this.scale;
  }

  /**
   * A laser trail: smooth curves (through the midpoints) joining only the points of the same
   * segment. Each point stays for LASER_HOLD_MS, then fades; points of about the same opacity are
   * drawn as one path, so the trail has no darker beads where pieces overlap.
   */
  private drawLaserTrail(ctx: CanvasRenderingContext2D, trail: { x: number; y: number; at: number; seg: number }[], now: number) {
    const LEVELS = 8;
    const level = (at: number) => {
      const age = now - at;
      if (age <= LASER_HOLD_MS) return LEVELS;
      return Math.max(0, Math.ceil(LEVELS * (1 - (age - LASER_HOLD_MS) / LASER_FADE_MS)));
    };
    const paths = new Map<number, Path2D>();
    const pathFor = (lv: number) => {
      let p = paths.get(lv);
      if (!p) paths.set(lv, (p = new Path2D()));
      return p;
    };
    const w = 7 / this.scale;
    let i = 0;
    while (i < trail.length) {
      let j = i;
      while (j + 1 < trail.length && trail[j + 1].seg === trail[i].seg) j++;
      const run = trail.slice(i, j + 1);
      i = j + 1;
      if (run.length === 1) {
        const lv = level(run[0].at);
        if (lv) {
          const p = pathFor(lv);
          p.moveTo(run[0].x, run[0].y);
          p.lineTo(run[0].x + 0.01, run[0].y); // a dot (round caps)
        }
        continue;
      }
      const mid = (a: { x: number; y: number }, b: { x: number; y: number }) => [(a.x + b.x) / 2, (a.y + b.y) / 2];
      for (let k = 0; k < run.length - 1; k++) {
        // Piece k: from the midpoint before point k (or the start) to the midpoint after it,
        // curving through point k.
        const lv = level(run[k + 1].at);
        if (!lv) continue;
        const p = pathFor(lv);
        const a = run[k], b = run[k + 1];
        if (k === 0) {
          const [mx, my] = run.length === 2 ? [b.x, b.y] : mid(a, b);
          p.moveTo(a.x, a.y);
          p.lineTo(mx, my);
        } else {
          const [sx, sy] = mid(run[k - 1], a);
          const [ex, ey] = k === run.length - 2 ? [b.x, b.y] : mid(a, b);
          p.moveTo(sx, sy);
          p.quadraticCurveTo(a.x, a.y, ex, ey);
        }
      }
    }
    ctx.save();
    ctx.lineWidth = w;
    ctx.lineCap = ctx.lineJoin = "round";
    for (const [lv, p] of paths) {
      const alpha = (0.85 * lv) / LEVELS;
      ctx.strokeStyle = `rgba(239,68,68,${alpha})`;
      ctx.stroke(p);
    }
    ctx.restore();
  }

  /** The lasso as a closed polygon (a rectangle in rectangle mode). */
  private lassoPoly(l: NonNullable<BoardView["lasso"]>): [number, number][] {
    if (!l.rect) return l.pts;
    const [x0, y0] = l.pts[0], [x1, y1] = l.pts[l.pts.length - 1];
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  }

  // ---------- selection ----------
  get selection(): string[] {
    return this.sel?.ids ?? [];
  }

  select(ids: string[]) {
    const all = ids.map((id) => this.board.state.strokes[id]).filter((s): s is Stroke => !!s && !s.del);
    // A selection lives on one page.
    const strokes = all.filter((s) => s.page === all[0]?.page);
    if (!strokes.length) return this.clearSelection();
    this.sel = { ids: strokes.map((s) => s.id), page: strokes[0].page, box: bboxOf(strokes) };
    this.topDirty = true;
    this.placeSelMenu();
    this.onSelectionChange();
  }

  clearSelection() {
    if (!this.sel) return;
    this.sel = null;
    this.selDrag = null;
    this.selMenu.hidden = true;
    this.topDirty = true;
    this.onSelectionChange();
  }

  private refreshSelection() {
    if (!this.sel || this.selDrag) return;
    const alive = this.sel.ids.filter((id) => { const s = this.board.state.strokes[id]; return s && !s.del; });
    if (!alive.length) this.clearSelection();
    else this.select(alive);
  }

  private selBoxNow() {
    const b = this.sel!.box;
    if (!this.selDrag) return b;
    const [x0, y0] = applyMat(this.selDrag.m, b.x0, b.y0);
    const [x1, y1] = applyMat(this.selDrag.m, b.x1, b.y1);
    return { x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1) };
  }

  /** The floating menu next to a selection (colours, dashed, copy, duplicate, delete). */
  setSelectionMenu(content: HTMLElement) {
    this.selMenu.replaceChildren(content);
  }

  private placeSelMenu() {
    if (!this.sel) {
      this.selMenu.hidden = true;
      return;
    }
    const b = this.selBoxNow();
    const oy = this.oy + (this.topOf(this.sel.page) ?? 0) * this.scale;
    const left = this.ox + ((b.x0 + b.x1) / 2) * this.scale;
    let top = oy + b.y0 * this.scale - 52;
    if (top < 4) top = oy + b.y1 * this.scale + 12;
    this.selMenu.hidden = !!this.selDrag;
    this.selMenu.style.left = `${Math.max(8, Math.min(this.cssW - 8, left))}px`;
    this.selMenu.style.top = `${Math.max(4, Math.min(this.cssH - 50, top))}px`;
  }

  /** x, y in units of the selection's page. */
  private selHit(x: number, y: number): "move" | [number, number] | null {
    if (!this.sel) return null;
    const b = this.sel.box;
    const hr = 16 / this.scale;
    const corners: [number, number, number, number][] = [[b.x0, b.y0, b.x1, b.y1], [b.x1, b.y0, b.x0, b.y1], [b.x0, b.y1, b.x1, b.y0], [b.x1, b.y1, b.x0, b.y0]];
    for (const [cx, cy, ax, ay] of corners) if (Math.hypot(x - cx, y - cy) <= hr) return [ax, ay];
    const pad = 6 / this.scale;
    if (x >= b.x0 - pad && x <= b.x1 + pad && y >= b.y0 - pad && y <= b.y1 + pad) return "move";
    return null;
  }

  /** Inserts x/y axes with tick marks at the visible center, selected so they can be moved right away. */
  insertAxes() {
    const p = this.page;
    const [cx, cy] = this.visibleCenter();
    const L = Math.min(p.w, p.h) * 0.3;
    const color = "#334155";
    const base = { page: p.id, color, size: 2.2, sp: true };
    const list: Omit<Stroke, "author" | "del" | "dv" | "ts">[] = [
      { ...base, id: uid(), tool: "arrow", pts: [[cx - L, cy, 0.5], [cx + L, cy, 0.5]] },
      { ...base, id: uid(), tool: "arrow", pts: [[cx, cy + L, 0.5], [cx, cy - L, 0.5]] },
    ];
    const step = L / 5, t = 7;
    for (let k = -4; k <= 4; k++) {
      if (!k) continue;
      list.push({ ...base, size: 1.6, id: uid(), tool: "line", pts: [[cx + k * step, cy - t, 0.5], [cx + k * step, cy + t, 0.5]] });
      list.push({ ...base, size: 1.6, id: uid(), tool: "line", pts: [[cx - t, cy + k * step, 0.5], [cx + t, cy + k * step, 0.5]] });
    }
    const ids = this.board.addStrokes(list);
    this.tool = "lasso";
    this.onViewChange();
    this.select(ids);
  }

  // ---------- input ----------
  private bindInput() {
    const el = this.top;
    // Non-passive touch listeners stop iOS gestures, the magnifier and Scribble from stealing strokes.
    for (const t of ["touchstart", "touchmove"] as const) {
      el.addEventListener(t, (e) => e.preventDefault(), { passive: false });
    }
    el.addEventListener("contextmenu", (e) => e.preventDefault());
    el.addEventListener("pointerdown", (e) => this.down(e));
    el.addEventListener("pointermove", (e) => this.move(e));
    el.addEventListener("pointerup", (e) => this.up(e));
    el.addEventListener("pointercancel", (e) => this.up(e, true));
    el.addEventListener("pointerleave", (e) => {
      if (e.pointerType !== "touch") {
        this.hover.on = false;
        this.topDirty = true;
      }
    });
    el.addEventListener("wheel", (e) => {
      e.preventDefault();
      const r = this.el.getBoundingClientRect();
      // Firefox reports lines/pages instead of pixels.
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.cssH : 1;
      const dx = e.deltaX * unit, dy = e.deltaY * unit;
      if (e.ctrlKey || e.metaKey) {
        this.zoomBy(Math.exp(-dy * 0.01), e.clientX - r.left, e.clientY - r.top);
      } else {
        // Shift + wheel scrolls sideways (Windows mice have no horizontal wheel).
        this.ox -= e.shiftKey && !dx ? dy : dx;
        this.oy -= e.shiftKey && !dx ? 0 : dy;
        this.fit = false;
        this.viewChanged(true);
      }
    }, { passive: false });
    window.addEventListener("keydown", (e) => {
      if (isTyping()) return;
      if (e.code === "Space") this.spaceDown = true;
      if (!this.sel) return;
      const mod = e.ctrlKey || e.metaKey;
      if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); this.deleteSelection(); }
      else if (e.key === "Escape") this.clearSelection();
      else if (mod && e.key.toLowerCase() === "c") { e.preventDefault(); this.copySelection(); }
      else if (mod && e.key.toLowerCase() === "d") { e.preventDefault(); this.duplicateSelection(); }
    });
    window.addEventListener("keyup", (e) => {
      if (e.code === "Space") this.spaceDown = false;
    });
  }

  deleteSelection() {
    if (!this.sel) return;
    this.board.erase(this.sel.ids);
    this.clearSelection();
  }

  copySelection() {
    if (this.sel) this.board.copy(this.sel.ids);
  }

  duplicateSelection() {
    if (!this.sel) return;
    // Duplicate on the selection's page (the current page may be another one after scrolling).
    if (this.sel.page !== this.board.state.current.page) this.board.setCurrentLocal(this.sel.page);
    this.board.copy(this.sel.ids);
    this.select(this.board.paste());
  }

  pasteHere() {
    const ids = this.board.paste();
    if (ids.length) {
      this.tool = "lasso";
      this.onViewChange();
      this.select(ids);
    }
  }

  restyleSelection(patch: { color?: string; dash?: boolean }) {
    if (!this.sel) return;
    this.board.restyleStrokes(this.sel.ids, patch);
  }

  private down(e: PointerEvent) {
    this.hideTapMenu();
    this.localAt = performance.now();
    if (e.pointerType === "pen") {
      this.penActive = true;
      this.penSeenAt = performance.now();
      this.penMode = true;
      if (this.touches.size) this.dropPalm();
    }
    if (e.pointerType === "touch") {
      // Palm rejection: ignore touches while / right after the Pencil is used.
      if (this.penActive || performance.now() - this.penSeenAt < PEN_GRACE_MS) return;
      if (!this.touches.size) this.touchView = { scale: this.scale, ox: this.ox, oy: this.oy, fit: this.fit };
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.tapDown(e);
      if (this.touches.size >= 2) {
        this.cancelDrawing();
        this.panning = null;
        this.startGesture();
        return;
      }
      // Fingers scroll and zoom; only the pen writes (unless this device draws with fingers).
      if (!this.fingersDraw || this.penMode || this.tool === "pan" || !this.canDraw()) {
        this.startPan(e);
        return;
      }
    }
    const wantsPan = this.tool === "pan" || e.button === 1 || e.button === 2 || this.spaceDown || (!this.canDraw() && this.tool !== "laser");
    if (wantsPan) {
      this.startPan(e);
      return;
    }
    if (e.button !== 0 && e.pointerType === "mouse") return;
    e.preventDefault();
    (document.activeElement as HTMLElement | null)?.blur?.();
    try { this.top.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    // The page under the pointer (or the nearest one): the whole stroke / lasso stays on it.
    const [dx, dy] = this.toDoc(e.clientX, e.clientY);
    const pg = this.pageAtY(dy);
    const x = dx, y = dy - (this.layout.get(pg.id) ?? 0);

    // The eraser end / eraser button of a Windows stylus (Lenovo, Surface) erases whatever tool is selected.
    const penEraser = e.pointerType === "pen" && (e.buttons & 32) !== 0;
    if (this.tool === "laser" && !penEraser) {
      // Every press starts a new piece of trail: it's never joined to the previous one.
      this.laserSeg++;
      this.laserDown = e.pointerId;
      this.queueLaser(pg.id, { x, y, seg: this.laserSeg });
      return;
    }
    if (this.sel && !penEraser) {
      // Grabbing the selection (with any tool: a finger tap may have selected it) moves / resizes it.
      const sp = this.sel.page;
      const [sx, sy] = this.toLocal(e.clientX, e.clientY, sp);
      const hit = this.selHit(sx, sy);
      if (hit) {
        const anchor: [number, number] = hit === "move" ? [sx, sy] : hit;
        const drag = { g: uid(), v: this.board.state.strokes[this.sel!.ids[0]]?.pv ?? 0 };
        this.selDrag = { pointerId: e.pointerId, mode: hit === "move" ? "move" : "scale", start: [sx, sy], anchor, m: [1, 0, 0, 1, 0, 0], lastSent: 0, drag };
        this.selMenu.hidden = true;
        this.baseDirty = this.topDirty = true;
        return;
      }
    }
    if (this.tool === "lasso" && !penEraser) {
      this.clearSelection();
      this.lasso = { pointerId: e.pointerId, page: pg.id, pts: [[x, y]], rect: this.lassoMode === "rect" };
      return;
    }
    if (this.sel) this.clearSelection();
    if (this.tool === "eraser" || penEraser) {
      this.erasing = { pointerId: e.pointerId, ids: new Set(), added: [], last: null };
      this.eraseAt(dx, dy);
      return;
    }
    const pressure = e.pointerType === "pen" ? e.pressure || 0.5 : 0.5;
    const kind = this.tool;
    let tool: Tool = kind === "hl" ? "hl" : "pen";
    if (kind === "shape") tool = this.shape === "tri" ? "poly" : this.shape;
    this.drawing = {
      id: uid(),
      page: pg.id,
      kind,
      tool,
      color: this.color,
      size: this.size,
      dash: (kind === "pen" || kind === "shape") && this.dash ? true : undefined,
      sp: e.pointerType !== "pen",
      pts: [[x, y, pressure]],
      pointerId: e.pointerId,
      sentUpTo: 0,
      snapped: false,
      origin: [x, y],
      streamAt: e.pointerType === "touch" ? performance.now() + 120 : 0,
    };
    this.armHold(e.clientX, e.clientY);
    this.topDirty = true;
  }

  /** Draw-and-hold: if the pen stays still for a moment, snap the stroke to a clean shape. */
  private armHold(cx: number, cy: number) {
    clearTimeout(this.holdTimer);
    this.holdAnchor = [cx, cy];
    const d = this.drawing;
    if (!d || !this.autoShape || d.snapped || (d.kind !== "pen" && d.kind !== "hl")) return;
    this.holdTimer = window.setTimeout(() => {
      const cur = this.drawing;
      if (!cur || cur !== d || cur.pts.length < 6) return;
      const r = recognize(cur.pts);
      if (!r) return;
      if (cur.kind === "hl") {
        // Highlighter: only straighten into a line (keeps the highlighter look).
        if (r.tool !== "line") return;
        cur.pts = r.pts.map((p) => [p[0], p[1], 0.5] as Pt);
      } else {
        const pen = cur.pts[cur.pts.length - 1];
        cur.tool = r.tool;
        cur.pts = r.pts;
        if (r.tool === "ellipse" || r.tool === "rect" || r.tool === "poly") {
          // Like Apple Notes: while the pen stays down, moving it resizes the shape around its
          // center, by how much farther from the center the pen is than when the shape snapped.
          let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
          for (const [px, py] of r.pts) { x0 = Math.min(x0, px); y0 = Math.min(y0, py); x1 = Math.max(x1, px); y1 = Math.max(y1, py); }
          const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
          const d0 = Math.hypot(pen[0] - cx, pen[1] - cy);
          if (d0 > 8) cur.resize = { cx, cy, d0, base: r.pts.map((q) => [q[0], q[1], q[2]] as Pt) };
        }
      }
      cur.snapped = true;
      this.predicted = [];
      this.topDirty = true;
      navigator.vibrate?.(10);
    }, HOLD_MS);
  }

  private move(e: PointerEvent) {
    // A hovering Pencil (iPad Pro) is about to write: keep ignoring the hand.
    if (e.pointerType === "pen") this.penSeenAt = performance.now();
    // Touches that aren't tracked are a resting hand (ignored by palm rejection).
    if (e.pointerType === "touch" && !this.touches.has(e.pointerId)) return;
    if (e.pointerType === "touch") {
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.tapMove(e);
      if (this.gesture) {
        this.updateGesture();
        return;
      }
    }
    if (this.panning && this.panning.pointerId === e.pointerId) {
      const pn = this.panning;
      if (!pn.live) {
        // A finger (or a resting hand) that barely moves doesn't move the page.
        if (e.pointerType === "touch" && Math.hypot(e.clientX - pn.x, e.clientY - pn.y) < PAN_START_PX) return;
        pn.live = true;
        pn.x = e.clientX;
        pn.y = e.clientY;
        pn.ox = this.ox;
        pn.oy = this.oy;
        return;
      }
      this.ox = pn.ox + (e.clientX - pn.x);
      this.oy = pn.oy + (e.clientY - pn.y);
      this.fit = false;
      this.viewChanged(true);
      return;
    }
    if (e.pointerType !== "touch") {
      this.hover = { x: e.clientX, y: e.clientY, on: true };
      this.topDirty = true;
    }
    if (this.tool === "laser" && (e.buttons || e.pointerType === "pen" || e.pointerType === "mouse")) {
      // The laser follows the mouse / Pencil hover even without pressing, but only once the user
      // actually moves it (a resting or slightly bumped mouse shows nothing).
      if (e.buttons || this.laserMoved(e.clientX, e.clientY)) {
        // Pressed: a trail. A hovering mouse: a trail and the dot. A hovering Pencil: only the dot.
        const hover = !e.buttons;
        const noTrail = hover && e.pointerType === "pen";
        const evs = !hover ? (e.getCoalescedEvents?.() ?? [e]) : [e];
        for (const ev of evs.length ? evs : [e]) {
          const [dx, dy] = this.toDoc(ev.clientX, ev.clientY);
          const pg = this.pageAtY(dy);
          this.queueLaser(pg.id, { x: dx, y: dy - (this.layout.get(pg.id) ?? 0), seg: this.laserSeg, hover, noTrail });
        }
      }
      return;
    }
    if (this.selDrag && this.selDrag.pointerId === e.pointerId && this.sel) {
      const g = this.selDrag;
      const [x, y] = this.toLocal(e.clientX, e.clientY, this.sel.page);
      if (g.mode === "move") {
        g.m = [1, 0, 0, 1, x - g.start[0], y - g.start[1]];
      } else {
        const [ax, ay] = g.anchor;
        const d0 = Math.hypot(g.start[0] - ax, g.start[1] - ay) || 1;
        const k = Math.max(0.1, Math.min(10, Math.hypot(x - ax, y - ay) / d0));
        g.m = [k, 0, 0, k, ax - k * ax, ay - k * ay];
      }
      this.topDirty = true;
      return;
    }
    if (this.lasso && this.lasso.pointerId === e.pointerId) {
      if (this.lasso.rect) this.lasso.pts = [this.lasso.pts[0], this.toLocal(e.clientX, e.clientY, this.lasso.page)];
      else {
        const evs = e.getCoalescedEvents?.() ?? [e];
        for (const ev of evs) this.lasso.pts.push(this.toLocal(ev.clientX, ev.clientY, this.lasso.page));
      }
      this.topDirty = true;
      return;
    }
    if (this.erasing && this.erasing.pointerId === e.pointerId) {
      const evs = e.getCoalescedEvents?.() ?? [e];
      for (const ev of evs) {
        const [ex, ey] = this.toDoc(ev.clientX, ev.clientY);
        this.eraseAt(ex, ey);
      }
      return;
    }
    const d = this.drawing;
    if (!d || d.pointerId !== e.pointerId) return;
    const [x, y] = this.toLocal(e.clientX, e.clientY, d.page);
    if (Math.hypot(e.clientX - this.holdAnchor[0], e.clientY - this.holdAnchor[1]) > 4) this.armHold(e.clientX, e.clientY);
    if (d.snapped) {
      // After snapping, a line keeps following the pen so its end can be adjusted, and a closed
      // shape grows / shrinks around its center with the pen.
      if (d.resize) {
        const { cx, cy, d0, base } = d.resize;
        const k = Math.max(0.05, Math.min(20, Math.hypot(x - cx, y - cy) / d0));
        d.pts = base.map((q) => [Math.round((cx + (q[0] - cx) * k) * 10) / 10, Math.round((cy + (q[1] - cy) * k) * 10) / 10, q[2]] as Pt);
      } else if (d.pts.length === 2 && (d.tool === "line" || d.tool === "hl")) d.pts[1] = [x, y, 0.5];
      this.topDirty = true;
      return;
    }
    const evs = e.getCoalescedEvents?.() ?? [e];
    const shape = d.kind === "shape";
    for (const ev of evs.length ? evs : [e]) {
      const [px, py] = this.toLocal(ev.clientX, ev.clientY, d.page);
      const pr = ev.pointerType === "pen" ? ev.pressure || 0.5 : 0.5;
      if (shape) this.shapeTo(d, px, py, ev.shiftKey);
      else d.pts.push([px, py, pr]);
    }
    this.predicted = shape ? [] : (e.getPredictedEvents?.() ?? []).slice(0, 2).map((ev) => {
      const [px, py] = this.toLocal(ev.clientX, ev.clientY, d.page);
      return [px, py, ev.pressure || 0.5] as Pt;
    });
    this.topDirty = true;
  }

  /**
   * Hover laser: true once the mouse makes a deliberate movement (LASER_START_PX within
   * LASER_WINDOW_MS). A resting, bumped or slowly drifting mouse shows nothing.
   */
  private laserMoved(cx: number, cy: number): boolean {
    if (this.board.lasers.has(this.board.me)) return true; // already showing: keep following
    const now = performance.now();
    const r = this.laserRest;
    if (!r || now - r.at > LASER_WINDOW_MS) {
      this.laserRest = { x: cx, y: cy, at: now };
      return false;
    }
    return Math.hypot(cx - r.x, cy - r.y) >= LASER_START_PX;
  }

  /** Shape tools: build the shape from the drag start to the current point. */
  private shapeTo(d: NonNullable<BoardView["drawing"]>, x: number, y: number, square: boolean) {
    const [ox, oy] = d.origin;
    if (square && (d.tool === "rect" || d.tool === "ellipse")) {
      const s = Math.max(Math.abs(x - ox), Math.abs(y - oy));
      x = ox + Math.sign(x - ox || 1) * s;
      y = oy + Math.sign(y - oy || 1) * s;
    }
    if (d.tool === "poly") {
      // triangle: apex top-center of the dragged box
      const x0 = Math.min(ox, x), x1 = Math.max(ox, x), y0 = Math.min(oy, y), y1 = Math.max(oy, y);
      d.pts = [[(x0 + x1) / 2, y0, 0.5], [x1, y1, 0.5], [x0, y1, 0.5]];
    } else {
      d.pts = [[ox, oy, 0.5], [x, y, 0.5]];
    }
  }

  private up(e: PointerEvent, cancelled = false) {
    this.localAt = performance.now();
    if (e.pointerType === "pen") {
      this.penActive = false;
      this.penSeenAt = performance.now();
    }
    if (this.laserDown === e.pointerId) {
      // The press ended: a hovering mouse after it draws its own, separate piece of trail.
      this.laserDown = null;
      this.laserSeg++;
    }
    if (e.pointerType === "touch") {
      const had = this.touches.delete(e.pointerId);
      if (!this.touches.size) this.touchView = null;
      if (had && !this.touches.size && this.tap) this.tapEnd(cancelled);
      if (this.gesture && this.touches.size < 2) {
        this.gesture = null;
        const rest = [...this.touches.entries()][0];
        if (rest) this.panning = { pointerId: rest[0], x: rest[1].x, y: rest[1].y, ox: this.ox, oy: this.oy, live: false };
        return;
      }
    }
    if (this.panning && this.panning.pointerId === e.pointerId) {
      this.panning = null;
      return;
    }
    if (this.selDrag && this.selDrag.pointerId === e.pointerId) {
      const g = this.selDrag;
      const ids = this.sel!.ids;
      this.selDrag = null;
      const moved = Math.abs(g.m[4]) > 0.5 || Math.abs(g.m[5]) > 0.5 || Math.abs(g.m[0] - 1) > 0.005;
      // Even when the system cancels the pointer (iOS can cancel the Pencil mid-drag), keep the
      // move the user made: it is on screen already.
      if (moved) this.board.transformStrokes(ids, g.m);
      this.board.previewTransform(ids, null, g.drag);
      this.baseDirty = true;
      this.select(ids);
      return;
    }
    if (this.lasso && this.lasso.pointerId === e.pointerId) {
      const l = this.lasso;
      const poly = this.lassoPoly(l);
      const page = l.page;
      this.lasso = null;
      this.topDirty = true;
      if (l.rect) {
        const [a, b] = [poly[0], poly[2]];
        if (Math.abs(a[0] - b[0]) < 2 || Math.abs(a[1] - b[1]) < 2) return;
      } else if (poly.length < 3) return;
      const ids: string[] = [];
      for (const s of this.board.strokes(page)) {
        const pts = isShape(s.tool) ? shapePolyline(s) : s.pts.map((p) => [p[0], p[1]] as [number, number]);
        const inside = pts.filter(([x, y]) => pointInPoly(x, y, poly)).length;
        if (pts.length && inside / pts.length >= 0.5) ids.push(s.id);
      }
      this.select(ids);
      return;
    }
    if (this.erasing && this.erasing.pointerId === e.pointerId) {
      const er = this.erasing;
      this.erasing = null;
      if (this.eraserMode === "partial") this.board.recordReplace([...er.ids], er.added);
      else this.board.recordErase([...er.ids]);
      return;
    }
    const d = this.drawing;
    if (!d || d.pointerId !== e.pointerId) return;
    clearTimeout(this.holdTimer);
    this.drawing = null;
    this.predicted = [];
    this.topDirty = true;
    if (cancelled && d.pts.length < 3) return;
    if (d.kind === "shape" && Math.hypot(d.pts[d.pts.length - 1][0] - d.origin[0], d.pts[d.pts.length - 1][1] - d.origin[1]) < 2) return;
    const s = { id: d.id, page: d.page, tool: d.tool, color: d.color, size: d.size, sp: d.sp, dash: d.dash, pts: d.pts };
    if (d.kind === "fade") this.board.commitTemp(s);
    else this.board.commitStroke(s);
  }

  private cancelDrawing() {
    clearTimeout(this.holdTimer);
    if (this.drawing) {
      this.drawing = null;
      this.predicted = [];
      this.topDirty = true;
    }
  }

  private startPan(e: PointerEvent) {
    try { this.top.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    this.panning = { pointerId: e.pointerId, x: e.clientX, y: e.clientY, ox: this.ox, oy: this.oy, live: false };
  }

  /**
   * The pen came down while fingers were on the screen: those were the hand resting on it.
   * Forget them (until they lift) and put the page back where it was before they landed.
   */
  private dropPalm() {
    const v = this.touchView;
    this.touches.clear();
    this.tap = null;
    this.gesture = null;
    this.panning = null;
    this.touchView = null;
    if (v && (v.scale !== this.scale || v.ox !== this.ox || v.oy !== this.oy)) {
      this.scale = v.scale;
      this.ox = v.ox;
      this.oy = v.oy;
      this.fit = v.fit;
      this.viewChanged(true);
    }
  }

  private startGesture() {
    const [a, b] = [...this.touches.values()];
    const r = this.el.getBoundingClientRect();
    this.gesture = {
      startDist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
      startScale: this.scale,
      cx: (a.x + b.x) / 2 - r.left,
      cy: (a.y + b.y) / 2 - r.top,
      ox: this.ox,
      oy: this.oy,
      px: (a.x + b.x) / 2,
      py: (a.y + b.y) / 2,
      live: false,
    };
  }

  private updateGesture() {
    const g = this.gesture!;
    const [a, b] = [...this.touches.values()];
    if (!a || !b) return;
    const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    if (!g.live) {
      // Two fingers (or a hand) resting on the screen don't zoom or move the page until they really move.
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      if (Math.abs(dist / g.startDist - 1) < PINCH_START && Math.hypot(mx - g.px, my - g.py) < PAN_START_PX) return;
      const r = this.el.getBoundingClientRect();
      Object.assign(g, { live: true, startDist: dist, startScale: this.scale, cx: mx - r.left, cy: my - r.top, ox: this.ox, oy: this.oy, px: mx, py: my });
      return;
    }
    const ns = Math.max(0.1, Math.min(12, (g.startScale * dist) / g.startDist));
    const k = ns / g.startScale;
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    this.scale = ns;
    this.ox = g.cx - (g.cx - g.ox) * k + (mx - g.px);
    this.oy = g.cy - (g.cy - g.oy) * k + (my - g.py);
    this.fit = false;
    this.viewChanged(true);
  }

  /** x, y in document units: the eraser works on whichever page is under each sample. */
  private eraseAt(x: number, y: number) {
    const er = this.erasing;
    if (!er) return;
    const r = this.eraserRadius();
    // Sample along the path since the last event so a fast swipe doesn't skip strokes.
    const from = er.last ?? [x, y];
    er.last = [x, y];
    const dist = Math.hypot(x - from[0], y - from[1]);
    const steps = Math.max(1, Math.ceil(dist / (r * 0.75)));
    const byPage = new Map<string, [number, number][]>();
    for (let i = 1; i <= steps; i++) {
      const sx = from[0] + ((x - from[0]) * i) / steps, sy = from[1] + ((y - from[1]) * i) / steps;
      const pg = this.pageAtY(sy);
      const t = this.layout.get(pg.id) ?? 0;
      if (sy < t - r || sy > t + pg.h + r) continue; // in the gap between pages
      let list = byPage.get(pg.id);
      if (!list) byPage.set(pg.id, (list = []));
      list.push([sx, sy - t]);
    }
    for (const [pageId, samples] of byPage) this.eraseOnPage(er, pageId, samples, r);
  }

  private eraseOnPage(er: NonNullable<BoardView["erasing"]>, pageId: string, samples: [number, number][], r: number) {
    const hits: Stroke[] = [];
    for (const s of this.board.strokes(pageId)) {
      if (er.ids.has(s.id)) continue;
      if (samples.some(([sx, sy]) => hitStroke(s, sx, sy, r))) hits.push(s);
    }
    if (!hits.length) return;
    if (this.eraserMode === "stroke") {
      for (const s of hits) er.ids.add(s.id);
      this.board.erase(hits.map((s) => s.id), false);
      return;
    }
    // Partial eraser: cut freehand strokes where the eraser passes; shapes are removed whole.
    for (const s of hits) {
      er.ids.add(s.id);
      if (isShape(s.tool) || s.dash) {
        this.board.erase([s.id], false);
        continue;
      }
      const reach = r + strokeReach(s);
      const pts = densify(s.pts, Math.max(1, r / 3));
      const pieces: Pt[][] = [];
      let cur: Pt[] = [];
      for (const p of pts) {
        const gone = samples.some(([sx, sy]) => Math.hypot(p[0] - sx, p[1] - sy) <= reach);
        if (gone) {
          if (cur.length > 1) pieces.push(cur);
          cur = [];
        } else cur.push(p);
      }
      if (cur.length > 1) pieces.push(cur);
      er.added.push(...this.board.splitStroke(s.id, pieces));
    }
  }

  /** Once per frame: stream the stroke being drawn, the lasso drag, and the laser position. */
  private flushLive() {
    const d = this.drawing;
    if (d && performance.now() >= d.streamAt) {
      const meta = { id: d.id, page: d.page, tool: d.tool, color: d.color, size: d.size, sp: d.sp, dash: d.dash };
      if (d.kind === "shape" || d.snapped) {
        if (d.pts.length >= 2) this.board.sendLive(meta, d.pts, true);
      } else if (d.pts.length > d.sentUpTo) {
        // Each batch says where its points go, so batches that arrive out of order still draw correctly.
        const from = d.sentUpTo;
        this.board.sendLive(meta, d.pts.slice(from).map((p) => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10, Math.round(p[2] * 100) / 100] as Pt), false, from);
        d.sentUpTo = d.pts.length;
      }
    }
    const g = this.selDrag;
    if (g && this.sel && performance.now() - g.lastSent > 50) {
      g.lastSent = performance.now();
      this.board.previewTransform(this.sel.ids, g.m, g.drag);
    }
    this.sendLaser();
  }

  private sendLaser() {
    const q = this.laserQueued;
    if (!q) return;
    this.laserQueued = null;
    this.board.laser(q.pts, this.laserDot, q.page);
  }

  /** Collects laser samples for this frame; a change of page / segment / hover sends what's queued. */
  private queueLaser(page: string, p: LaserPt) {
    const q = this.laserQueued;
    const prev = q?.pts[q.pts.length - 1];
    if (q && prev && (q.page !== page || prev.seg !== p.seg || !!prev.hover !== !!p.hover || !!prev.noTrail !== !!p.noTrail)) this.sendLaser();
    if (this.laserQueued) this.laserQueued.pts.push(p);
    else this.laserQueued = { page, pts: [p] };
  }

  // ---------- one-finger tap = select / copy-paste menu ----------
  /** Builds the content of the menu a one-finger tap on an empty spot opens (set by the toolbar). */
  buildTapMenu: (page: string) => HTMLElement | null = () => null;

  private fingerTap(cx: number, cy: number) {
    const r = this.el.getBoundingClientRect();
    const [dx, dy] = this.toDoc(cx, cy);
    const pg = this.pageAtY(dy);
    const x = dx, y = dy - (this.layout.get(pg.id) ?? 0);
    if (this.sel) {
      const [sx, sy] = this.toLocal(cx, cy, this.sel.page);
      if (this.selHit(sx, sy)) return;
    }
    const near = 14 / this.scale;
    const strokes = this.board.strokes(pg.id);
    for (let i = strokes.length - 1; i >= 0; i--) {
      if (hitStroke(strokes[i], x, y, near)) {
        this.select([strokes[i].id]);
        return;
      }
    }
    if (this.sel) {
      this.clearSelection();
      return;
    }
    if (x < 0 || x > pg.w || y < 0 || y > pg.h) return;
    const menu = this.buildTapMenu(pg.id);
    if (!menu) return;
    this.tapAt = { page: pg.id, x, y };
    this.tapMenu.replaceChildren(menu);
    const left = cx - r.left, top = cy - r.top;
    this.tapMenu.style.left = `${Math.max(8, Math.min(this.cssW - 8, left))}px`;
    this.tapMenu.style.top = `${Math.max(4, Math.min(this.cssH - 50, top > 70 ? top - 60 : top + 20))}px`;
    this.tapMenu.hidden = false;
  }

  hideTapMenu() {
    if (!this.tapMenu.hidden) this.tapMenu.hidden = true;
  }

  /** Pastes what was copied centered where the finger tapped, and selects it. */
  pasteAtTap() {
    const t = this.tapAt;
    this.hideTapMenu();
    if (!t || !this.board.state.pages[t.page]) return;
    const ids = this.board.pasteAt(t.page, t.x, t.y);
    if (ids.length) this.select(ids);
  }

  /** Selects all the ink on the page where the finger tapped. */
  selectAllAtTap() {
    const t = this.tapAt;
    this.hideTapMenu();
    if (t) this.select(this.board.strokes(t.page).map((s) => s.id));
  }

  // ---------- two-finger tap = undo ----------
  private tapDown(e: PointerEvent) {
    const now = performance.now();
    const pos = { x: e.clientX, y: e.clientY };
    if (this.touches.size === 1) {
      this.tap = { t0: now, n: 1, start: new Map([[e.pointerId, pos]]), view: { scale: this.scale, ox: this.ox, oy: this.oy, fit: this.fit } };
    } else if (this.tap && this.touches.size === 2 && this.tap.n === 1 && now - this.tap.t0 <= TAP_LAND_MS) {
      this.tap.n = 2;
      this.tap.start.set(e.pointerId, pos);
    } else this.dropTap();
  }

  private tapMove(e: PointerEvent) {
    const t = this.tap;
    if (!t) return;
    const s = t.start.get(e.pointerId);
    if (performance.now() - t.t0 > TAP_MS || (s && Math.hypot(e.clientX - s.x, e.clientY - s.y) > TAP_MOVE_PX)) return this.dropTap();
    if (t.n === 2 && this.touches.size === 2) {
      const [a, b] = [...t.start.values()], [c, d] = [...this.touches.values()];
      const k = (Math.hypot(c.x - d.x, c.y - d.y) || 1) / (Math.hypot(a.x - b.x, a.y - b.y) || 1);
      if (k < 0.85 || k > 1.15) this.dropTap();
    }
  }

  /** Not a tap after all (a pinch, a pan, a third finger): send the view if the fingers moved it. */
  private dropTap() {
    const t = this.tap;
    if (!t) return;
    this.tap = null;
    if (t.view.scale !== this.scale || t.view.ox !== this.ox || t.view.oy !== this.oy) this.queueViewSend();
  }

  private tapEnd(cancelled: boolean) {
    const t = this.tap!;
    const now = performance.now();
    if (!cancelled && t.n === 1 && now - t.t0 <= TAP_MS && this.panning && !this.panning.live) {
      // One finger, tapped (not drawing): select the ink under it, or open the copy / paste menu.
      this.tap = null;
      const p = [...t.start.values()][0];
      if (this.canDraw()) this.fingerTap(p.x, p.y);
      return;
    }
    if (cancelled || t.n !== 2 || now - t.t0 > TAP_MS) return this.dropTap();
    this.tap = null;
    // Put back the view as it was before the tap (the pinch logic may have nudged it a little).
    if (t.view.scale !== this.scale || t.view.ox !== this.ox || t.view.oy !== this.oy) {
      this.scale = t.view.scale;
      this.ox = t.view.ox;
      this.oy = t.view.oy;
      this.fit = t.view.fit;
      this.viewChanged(false);
    }
    if (this.canDraw()) this.board.undo();
  }
}

/**
 * Allowed offset on one axis. A page smaller than the screen stays fully visible; a larger
 * (zoomed-in) page can be scrolled until its edge, plus a small margin, but never off screen.
 */
export function clampAxis(offset: number, size: number, view: number, margin = 40): number {
  if (!Number.isFinite(offset)) return 0;
  if (size <= view) return Math.min(Math.max(offset, 0), view - size);
  return Math.min(Math.max(offset, view - size - margin), margin);
}

function isTyping() {
  const a = document.activeElement;
  return !!a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || (a as HTMLElement).isContentEditable);
}
