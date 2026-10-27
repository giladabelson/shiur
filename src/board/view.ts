// Board canvas: rendering, Apple Pencil / mouse / touch input, pan & zoom, and all the tools
// (pen, highlighter, disappearing ink, shapes + draw-and-hold recognition, stroke/partial eraser,
// lasso select/move/resize, laser).

import { getStroke } from "perfect-freehand";
import { applyMat, TEMP_FADE_MS, TEMP_HOLD_MS, type Board, type Mat } from "./board";
import { uid, type Page, type Pt, type Stroke, type Tool, type Template } from "./model";
import { getBackground } from "./pdf";
import { recognize } from "./recognize";

export type ViewTool = "pen" | "hl" | "fade" | "shape" | "eraser" | "lasso" | "laser" | "pan";
export type ShapeKind = "line" | "arrow" | "rect" | "ellipse" | "tri";

const PEN_GRACE_MS = 600;
const HOLD_MS = 550;
const HL_ALPHA = 0.35;
const SEL_COLOR = "#2563eb";

interface Drawable {
  tool: Tool;
  color: string;
  size: number;
  sp: boolean;
  dash?: boolean;
  pts: Pt[];
}

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

export function drawStroke(ctx: CanvasRenderingContext2D, s: Drawable, cache?: Map<string, Path2D>, id?: string, last = true) {
  if (!s.pts.length) return;
  if ((s.tool === "pen" || s.tool === "hl") && !s.dash) {
    let path = id ? cache?.get(id) : undefined;
    if (!path) {
      path = freehandPath(s, last);
      if (id && cache) cache.set(id, path);
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
  const tpl: Template = p.tpl ?? "blank";
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
export function renderPage(board: Board, page: Page, widthPx: number): Promise<HTMLCanvasElement> {
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

export class BoardView {
  readonly el: HTMLDivElement;
  private base: HTMLCanvasElement;
  private top: HTMLCanvasElement;
  private bctx: CanvasRenderingContext2D;
  private tctx: CanvasRenderingContext2D;
  private selMenu: HTMLDivElement;
  private privBadge: HTMLDivElement;
  private dpr = 1;
  private cssW = 0;
  private cssH = 0;
  private scale = 1;
  private ox = 0;
  private oy = 0;
  private fit = true;
  private pageId = "";
  private paths = new Map<string, Path2D>();
  private baseDirty = true;
  private topDirty = true;
  private raf = 0;
  private pendingAdds: string[] = [];

  tool: ViewTool = "pen";
  shape: ShapeKind = "line";
  color = "#1f2937";
  size = 3.5;
  dash = false;
  eraserMode: "stroke" | "partial" = "stroke";
  laserDot = false;
  autoShape = true;
  /** Whether this user may draw right now (lock). */
  canDraw: () => boolean = () => true;
  onViewChange: () => void = () => {};
  onSelectionChange: () => void = () => {};

  // input state
  private penActive = false;
  private penSeenAt = 0;
  private penMode = false;
  private drawing: (Drawable & { id: string; page: string; kind: ViewTool; pointerId: number; sentUpTo: number; snapped: boolean; origin: [number, number] }) | null = null;
  private holdTimer: number | undefined;
  private holdAnchor: [number, number] = [0, 0];
  private predicted: Pt[] = [];
  private erasing: { pointerId: number; ids: Set<string>; added: string[]; last: [number, number] | null } | null = null;
  private lasso: { pointerId: number; pts: [number, number][] } | null = null;
  private sel: { ids: string[]; box: { x0: number; y0: number; x1: number; y1: number } } | null = null;
  private selDrag: { pointerId: number; mode: "move" | "scale"; start: [number, number]; anchor: [number, number]; m: Mat; lastSent: number } | null = null;
  private touches = new Map<number, { x: number; y: number }>();
  private gesture: { startDist: number; startScale: number; cx: number; cy: number; ox: number; oy: number; px: number; py: number } | null = null;
  private panning: { pointerId: number; x: number; y: number; ox: number; oy: number } | null = null;
  private hover: { x: number; y: number; on: boolean } = { x: 0, y: 0, on: false };
  private spaceDown = false;
  private laserQueued: { x: number; y: number } | null = null;

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
    this.el.append(this.base, this.top, this.selMenu, this.privBadge);
    this.bctx = this.base.getContext("2d")!;
    this.tctx = this.top.getContext("2d", { desynchronized: true } as CanvasRenderingContext2DSettings)!;
    new ResizeObserver(() => this.resize()).observe(this.el);
    this.bindInput();
    this.loop();
  }

  invalidate(what: "all" | "live" | "page" | "lock" | "stroke", strokeId?: string) {
    if (what === "stroke" && strokeId) {
      // A new stroke is drawn on top of the existing base layer instead of redrawing everything.
      if (!this.baseDirty) this.pendingAdds.push(strokeId);
      this.topDirty = true;
      return;
    }
    if (what === "all" || what === "page") {
      this.baseDirty = true;
      if (this.paths.size > 5000) this.paths.clear();
      if (this.sel) this.refreshSelection();
    }
    this.topDirty = true;
  }

  // ---------- view transform ----------
  private get page(): Page {
    return this.board.currentPage;
  }

  private resize() {
    const r = this.el.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.cssW = Math.max(1, r.width);
    this.cssH = Math.max(1, r.height);
    for (const c of [this.base, this.top]) {
      c.width = Math.round(this.cssW * this.dpr);
      c.height = Math.round(this.cssH * this.dpr);
    }
    if (this.fit) this.fitPage();
    this.baseDirty = this.topDirty = true;
  }

  fitPage() {
    const p = this.page;
    const pad = 12;
    this.scale = Math.max(0.05, Math.min((this.cssW - pad * 2) / p.w, (this.cssH - pad * 2) / p.h));
    this.ox = (this.cssW - p.w * this.scale) / 2;
    this.oy = (this.cssH - p.h * this.scale) / 2;
    this.fit = true;
    this.viewChanged();
  }

  zoomBy(f: number, cx = this.cssW / 2, cy = this.cssH / 2) {
    const ns = Math.max(0.1, Math.min(12, this.scale * f));
    const k = ns / this.scale;
    this.ox = cx - (cx - this.ox) * k;
    this.oy = cy - (cy - this.oy) * k;
    this.scale = ns;
    this.fit = false;
    this.viewChanged();
  }

  private viewChanged() {
    this.baseDirty = this.topDirty = true;
    this.placeSelMenu();
    this.onViewChange();
  }

  get zoomPct() {
    return Math.round(this.scale * 100);
  }

  /** Page units -> CSS pixels relative to the board element. */
  toScreen(x: number, y: number): [number, number] {
    return [this.ox + x * this.scale, this.oy + y * this.scale];
  }

  private toPage(clientX: number, clientY: number): [number, number] {
    const r = this.el.getBoundingClientRect();
    return [(clientX - r.left - this.ox) / this.scale, (clientY - r.top - this.oy) / this.scale];
  }

  /** Center of what's visible, in page units (where new things get inserted). */
  visibleCenter(): [number, number] {
    const p = this.page;
    const cx = (this.cssW / 2 - this.ox) / this.scale, cy = (this.cssH / 2 - this.oy) / this.scale;
    return [Math.min(p.w - 50, Math.max(50, cx)), Math.min(p.h - 50, Math.max(50, cy))];
  }

  // ---------- rendering ----------
  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    if (this.board.currentPage.id !== this.pageId) {
      this.pageId = this.board.currentPage.id;
      this.clearSelection();
      this.fitPage();
      this.privBadge.hidden = !this.page.priv;
    }
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
  }

  private applyTransform(ctx: CanvasRenderingContext2D) {
    const k = this.dpr * this.scale;
    ctx.setTransform(k, 0, 0, k, this.dpr * this.ox, this.dpr * this.oy);
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
    const p = this.page;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.base.width, this.base.height);
    this.applyTransform(ctx);
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
    const hidden = this.hiddenIds();
    for (const s of this.board.strokes(p.id)) if (!hidden.has(s.id)) drawStroke(ctx, s, this.paths, s.id);
    ctx.restore();
  }

  private drawAdds() {
    const ctx = this.bctx;
    const p = this.page;
    this.applyTransform(ctx);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, p.w, p.h);
    ctx.clip();
    for (const id of this.pendingAdds) {
      const s = this.board.state.strokes[id];
      if (s && !s.del && s.page === p.id) drawStroke(ctx, s, this.paths, s.id);
    }
    ctx.restore();
    this.pendingAdds = [];
  }

  private drawTop() {
    this.topDirty = false;
    const ctx = this.tctx;
    const p = this.page;
    const now = performance.now();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.top.width, this.top.height);
    this.applyTransform(ctx);

    // strokes being moved: by us (lasso drag) or by a peer (preview transform)
    const moved: [Stroke, Mat][] = [];
    for (const [id, m] of this.board.previews) {
      const s = this.board.state.strokes[id];
      if (s && !s.del && s.page === p.id) moved.push([s, m]);
    }
    if (this.selDrag && this.sel) {
      for (const id of this.sel.ids) {
        const s = this.board.state.strokes[id];
        if (s) moved.push([s, this.selDrag.m]);
      }
    }
    for (const [s, m] of moved) {
      ctx.save();
      ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
      drawStroke(ctx, s);
      ctx.restore();
    }

    for (const ls of this.board.live.values()) if (ls.page === p.id) drawStroke(ctx, ls, undefined, undefined, false);
    for (const t of this.board.temps.values()) {
      if (t.s.page !== p.id) continue;
      const age = now - t.at;
      const alpha = age < TEMP_HOLD_MS ? 1 : Math.max(0, 1 - (age - TEMP_HOLD_MS) / TEMP_FADE_MS);
      ctx.globalAlpha = alpha;
      drawStroke(ctx, t.s);
      ctx.globalAlpha = 1;
    }
    if (this.drawing && this.drawing.page === p.id) {
      const d = this.drawing;
      const pts = !isShape(d.tool) && !d.snapped ? d.pts.concat(this.predicted) : d.pts;
      drawStroke(ctx, { ...d, pts }, undefined, undefined, false);
    }
    // lasers
    for (const l of this.board.lasers.values()) {
      if (l.page !== p.id || !l.trail.length) continue;
      if (!l.dot) {
        for (let i = 1; i < l.trail.length; i++) {
          const a = l.trail[i - 1], b = l.trail[i];
          const age = Math.min(1, (now - b.at) / 900);
          ctx.strokeStyle = `rgba(239,68,68,${(1 - age) * 0.8})`;
          ctx.lineWidth = 6 / this.scale;
          ctx.lineCap = "round";
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }
      const h = l.trail[l.trail.length - 1];
      const r = (l.dot ? 9 : 7) / this.scale;
      ctx.fillStyle = "rgba(239,68,68,0.25)";
      ctx.beginPath();
      ctx.arc(h.x, h.y, r * 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(239,68,68,0.95)";
      ctx.beginPath();
      ctx.arc(h.x, h.y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    // lasso outline
    if (this.lasso && this.lasso.pts.length > 1) {
      ctx.beginPath();
      ctx.moveTo(this.lasso.pts[0][0], this.lasso.pts[0][1]);
      for (const [x, y] of this.lasso.pts) ctx.lineTo(x, y);
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
    if (this.sel) {
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
    // hover cursor
    if (this.hover.on && !this.drawing && !this.lasso) {
      const [x, y] = this.toPage(this.hover.x, this.hover.y);
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
    return (this.eraserMode === "partial" ? 8 : 10) / this.scale;
  }

  // ---------- selection ----------
  get selection(): string[] {
    return this.sel?.ids ?? [];
  }

  select(ids: string[]) {
    const strokes = ids.map((id) => this.board.state.strokes[id]).filter((s): s is Stroke => !!s && !s.del);
    if (!strokes.length) return this.clearSelection();
    this.sel = { ids: strokes.map((s) => s.id), box: bboxOf(strokes) };
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
    const left = this.ox + ((b.x0 + b.x1) / 2) * this.scale;
    let top = this.oy + b.y0 * this.scale - 52;
    if (top < 4) top = this.oy + b.y1 * this.scale + 12;
    this.selMenu.hidden = !!this.selDrag;
    this.selMenu.style.left = `${Math.max(8, Math.min(this.cssW - 8, left))}px`;
    this.selMenu.style.top = `${Math.max(4, Math.min(this.cssH - 50, top))}px`;
  }

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
      if (e.ctrlKey || e.metaKey) {
        this.zoomBy(Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top);
      } else {
        this.ox -= e.deltaX;
        this.oy -= e.deltaY;
        this.fit = false;
        this.viewChanged();
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
    if (e.pointerType === "pen") {
      this.penActive = true;
      this.penSeenAt = performance.now();
      this.penMode = true;
    }
    if (e.pointerType === "touch") {
      // Palm rejection: ignore touches while / right after the Pencil is used.
      if (this.penActive || performance.now() - this.penSeenAt < PEN_GRACE_MS) return;
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.touches.size >= 2) {
        this.cancelDrawing();
        this.panning = null;
        this.startGesture();
        return;
      }
      if (this.penMode || this.tool === "pan" || !this.canDraw()) {
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
    const [x, y] = this.toPage(e.clientX, e.clientY);

    // The eraser end / eraser button of a Windows stylus (Lenovo, Surface) erases whatever tool is selected.
    const penEraser = e.pointerType === "pen" && (e.buttons & 32) !== 0;
    if (this.tool === "laser" && !penEraser) {
      this.laserQueued = { x, y };
      return;
    }
    if (this.tool === "lasso" && !penEraser) {
      const hit = this.selHit(x, y);
      if (hit) {
        const anchor: [number, number] = hit === "move" ? [x, y] : hit;
        this.selDrag = { pointerId: e.pointerId, mode: hit === "move" ? "move" : "scale", start: [x, y], anchor, m: [1, 0, 0, 1, 0, 0], lastSent: 0 };
        this.selMenu.hidden = true;
        this.baseDirty = this.topDirty = true;
        return;
      }
      this.clearSelection();
      this.lasso = { pointerId: e.pointerId, pts: [[x, y]] };
      return;
    }
    if (this.sel) this.clearSelection();
    if (this.tool === "eraser" || penEraser) {
      this.erasing = { pointerId: e.pointerId, ids: new Set(), added: [], last: null };
      this.eraseAt(x, y);
      return;
    }
    const pressure = e.pointerType === "pen" ? e.pressure || 0.5 : 0.5;
    const kind = this.tool;
    let tool: Tool = kind === "hl" ? "hl" : "pen";
    if (kind === "shape") tool = this.shape === "tri" ? "poly" : this.shape;
    this.drawing = {
      id: uid(),
      page: this.page.id,
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
        cur.tool = r.tool;
        cur.pts = r.pts;
      }
      cur.snapped = true;
      this.predicted = [];
      this.topDirty = true;
      navigator.vibrate?.(10);
    }, HOLD_MS);
  }

  private move(e: PointerEvent) {
    if (e.pointerType === "touch" && this.touches.has(e.pointerId)) {
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.gesture) {
        this.updateGesture();
        return;
      }
    }
    if (this.panning && this.panning.pointerId === e.pointerId) {
      this.ox = this.panning.ox + (e.clientX - this.panning.x);
      this.oy = this.panning.oy + (e.clientY - this.panning.y);
      this.fit = false;
      this.viewChanged();
      return;
    }
    if (e.pointerType !== "touch") {
      this.hover = { x: e.clientX, y: e.clientY, on: true };
      this.topDirty = true;
    }
    const [x, y] = this.toPage(e.clientX, e.clientY);
    if (this.tool === "laser" && (e.buttons || e.pointerType === "pen" || e.pointerType === "mouse")) {
      // The laser follows the mouse / Pencil hover even without pressing.
      this.laserQueued = { x, y };
      return;
    }
    if (this.selDrag && this.selDrag.pointerId === e.pointerId) {
      const g = this.selDrag;
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
      const evs = e.getCoalescedEvents?.() ?? [e];
      for (const ev of evs) this.lasso.pts.push(this.toPage(ev.clientX, ev.clientY));
      this.topDirty = true;
      return;
    }
    if (this.erasing && this.erasing.pointerId === e.pointerId) {
      const evs = e.getCoalescedEvents?.() ?? [e];
      for (const ev of evs) {
        const [ex, ey] = this.toPage(ev.clientX, ev.clientY);
        this.eraseAt(ex, ey);
      }
      return;
    }
    const d = this.drawing;
    if (!d || d.pointerId !== e.pointerId) return;
    if (Math.hypot(e.clientX - this.holdAnchor[0], e.clientY - this.holdAnchor[1]) > 4) this.armHold(e.clientX, e.clientY);
    if (d.snapped) {
      // After snapping, a line keeps following the pen so its end can be adjusted.
      if (d.pts.length === 2 && (d.tool === "line" || d.tool === "hl")) d.pts[1] = [x, y, 0.5];
      this.topDirty = true;
      return;
    }
    const evs = e.getCoalescedEvents?.() ?? [e];
    const shape = d.kind === "shape";
    for (const ev of evs.length ? evs : [e]) {
      const [px, py] = this.toPage(ev.clientX, ev.clientY);
      const pr = ev.pointerType === "pen" ? ev.pressure || 0.5 : 0.5;
      if (shape) this.shapeTo(d, px, py, ev.shiftKey);
      else d.pts.push([px, py, pr]);
    }
    this.predicted = shape ? [] : (e.getPredictedEvents?.() ?? []).slice(0, 2).map((ev) => {
      const [px, py] = this.toPage(ev.clientX, ev.clientY);
      return [px, py, ev.pressure || 0.5] as Pt;
    });
    this.topDirty = true;
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
    if (e.pointerType === "pen") {
      this.penActive = false;
      this.penSeenAt = performance.now();
    }
    if (e.pointerType === "touch") {
      this.touches.delete(e.pointerId);
      if (this.gesture && this.touches.size < 2) {
        this.gesture = null;
        const rest = [...this.touches.entries()][0];
        if (rest) this.panning = { pointerId: rest[0], x: rest[1].x, y: rest[1].y, ox: this.ox, oy: this.oy };
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
      if (moved && !cancelled) this.board.transformStrokes(ids, g.m);
      this.board.previewTransform(ids, null);
      this.baseDirty = true;
      this.select(ids);
      return;
    }
    if (this.lasso && this.lasso.pointerId === e.pointerId) {
      const poly = this.lasso.pts;
      this.lasso = null;
      this.topDirty = true;
      if (poly.length < 3) return;
      const ids: string[] = [];
      for (const s of this.board.strokes(this.page.id)) {
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
    this.panning = { pointerId: e.pointerId, x: e.clientX, y: e.clientY, ox: this.ox, oy: this.oy };
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
    };
  }

  private updateGesture() {
    const g = this.gesture!;
    const [a, b] = [...this.touches.values()];
    if (!a || !b) return;
    const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    const ns = Math.max(0.1, Math.min(12, (g.startScale * dist) / g.startDist));
    const k = ns / g.startScale;
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    this.scale = ns;
    this.ox = g.cx - (g.cx - g.ox) * k + (mx - g.px);
    this.oy = g.cy - (g.cy - g.oy) * k + (my - g.py);
    this.fit = false;
    this.viewChanged();
  }

  private eraseAt(x: number, y: number) {
    const er = this.erasing;
    if (!er) return;
    const r = this.eraserRadius();
    // Sample along the path since the last event so a fast swipe doesn't skip strokes.
    const from = er.last ?? [x, y];
    er.last = [x, y];
    const dist = Math.hypot(x - from[0], y - from[1]);
    const steps = Math.max(1, Math.ceil(dist / (r * 0.75)));
    const samples: [number, number][] = [];
    for (let i = 1; i <= steps; i++) samples.push([from[0] + ((x - from[0]) * i) / steps, from[1] + ((y - from[1]) * i) / steps]);
    const hits: Stroke[] = [];
    for (const s of this.board.strokes(this.page.id)) {
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
    if (d) {
      const meta = { id: d.id, page: d.page, tool: d.tool, color: d.color, size: d.size, sp: d.sp, dash: d.dash };
      if (d.kind === "shape" || d.snapped) {
        if (d.pts.length >= 2) this.board.sendLive(meta, d.pts, true);
      } else if (d.pts.length > d.sentUpTo) {
        // Overlap one point so lost packets leave small gaps rather than jumps.
        const from = Math.max(0, d.sentUpTo - 1);
        this.board.sendLive(meta, d.pts.slice(from).map((p) => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10, Math.round(p[2] * 100) / 100] as Pt));
        d.sentUpTo = d.pts.length;
      }
    }
    const g = this.selDrag;
    if (g && this.sel && performance.now() - g.lastSent > 50) {
      g.lastSent = performance.now();
      this.board.previewTransform(this.sel.ids, g.m);
    }
    if (this.laserQueued) {
      this.board.laser(this.laserQueued.x, this.laserQueued.y, this.laserDot);
      this.laserQueued = null;
    }
  }
}

function isTyping() {
  const a = document.activeElement;
  return !!a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || (a as HTMLElement).isContentEditable);
}
