// Board canvas: rendering, Apple Pencil / mouse / touch input, pan & zoom, tools.

import { getStroke } from "perfect-freehand";
import type { Board, LiveStroke } from "./board";
import { uid, type Page, type Pt, type Stroke, type Tool } from "./model";
import { getBackground } from "./pdf";

export type ViewTool = Tool | "eraser" | "laser" | "pan";

const PEN_GRACE_MS = 600;
const HL_ALPHA = 0.35;

interface Drawable {
  tool: Tool;
  color: string;
  size: number;
  sp: boolean;
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

function shapePolyline(s: Drawable): [number, number][] {
  const [a, b] = [s.pts[0], s.pts[s.pts.length - 1]];
  if (!a || !b) return [];
  if (s.tool === "line") return [[a[0], a[1]], [b[0], b[1]]];
  if (s.tool === "rect") return [[a[0], a[1]], [b[0], a[1]], [b[0], b[1]], [a[0], b[1]], [a[0], a[1]]];
  const cx = (a[0] + b[0]) / 2, cy = (a[1] + b[1]) / 2, rx = Math.abs(b[0] - a[0]) / 2, ry = Math.abs(b[1] - a[1]) / 2;
  const out: [number, number][] = [];
  for (let i = 0; i <= 48; i++) {
    const t = (i / 48) * Math.PI * 2;
    out.push([cx + rx * Math.cos(t), cy + ry * Math.sin(t)]);
  }
  return out;
}

export function drawStroke(ctx: CanvasRenderingContext2D, s: Drawable, cache?: Map<string, Path2D>, id?: string, last = true) {
  if (!s.pts.length) return;
  if (s.tool === "pen" || s.tool === "hl") {
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
  ctx.lineWidth = s.size;
  ctx.lineCap = ctx.lineJoin = "round";
  ctx.stroke();
}

function distToSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const x = ax + t * dx - px, y = ay + t * dy - py;
  return Math.sqrt(x * x + y * y);
}

function hitStroke(s: Stroke, x: number, y: number, r: number): boolean {
  const pts: [number, number][] = s.tool === "pen" || s.tool === "hl" ? s.pts.map((p) => [p[0], p[1]]) : shapePolyline(s);
  const rr = r + (s.tool === "hl" ? s.size * 2 : s.size / 2);
  if (pts.length === 1) return Math.hypot(pts[0][0] - x, pts[0][1] - y) <= rr;
  for (let i = 1; i < pts.length; i++) {
    if (distToSeg(x, y, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]) <= rr) return true;
  }
  return false;
}

/** Renders one page (background + strokes) onto a canvas, used for PNG export. */
export function renderPage(board: Board, page: Page, widthPx: number): Promise<HTMLCanvasElement> {
  return new Promise((resolve) => {
    const c = document.createElement("canvas");
    const s = widthPx / page.w;
    c.width = Math.round(page.w * s);
    c.height = Math.round(page.h * s);
    const paint = (final: boolean) => {
      const ctx = c.getContext("2d")!;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.setTransform(s, 0, 0, s, 0, 0);
      let ready = true;
      if (page.bg) {
        const img = getBackground(page.bg, widthPx, () => { if (!final) paint(true); });
        if (img) ctx.drawImage(img, 0, 0, page.w, page.h);
        else ready = false;
      }
      for (const st of board.strokes(page.id)) drawStroke(ctx, st);
      if (ready || final) resolve(c);
    };
    paint(false);
    setTimeout(() => paint(true), 4000);
  });
}

export class BoardView {
  readonly el: HTMLDivElement;
  private base: HTMLCanvasElement;
  private top: HTMLCanvasElement;
  private bctx: CanvasRenderingContext2D;
  private tctx: CanvasRenderingContext2D;
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

  tool: ViewTool = "pen";
  color = "#1f2937";
  size = 3;
  /** Whether this user may draw right now (lock). */
  canDraw: () => boolean = () => true;
  onViewChange: () => void = () => {};

  // input state
  private penActive = false;
  private penSeenAt = 0;
  private penMode = false;
  private drawing: (LiveStroke & { pointerId: number; sentUpTo: number; startedAt: number; pointerType: string }) | null = null;
  private predicted: Pt[] = [];
  private erasing: { pointerId: number; ids: Set<string>; last: [number, number] | null } | null = null;
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
    this.el.append(this.base, this.top);
    this.bctx = this.base.getContext("2d")!;
    this.tctx = this.top.getContext("2d", { desynchronized: true } as CanvasRenderingContext2DSettings)!;
    new ResizeObserver(() => this.resize()).observe(this.el);
    this.bindInput();
    this.loop();
  }

  private pendingAdds: string[] = [];

  invalidate(what: "all" | "live" | "page" | "lock" | "stroke", strokeId?: string) {
    if (what === "stroke" && strokeId) {
      // A new stroke is drawn on top of the existing base layer instead of redrawing everything.
      if (!this.baseDirty) this.pendingAdds.push(strokeId);
      this.topDirty = true;
      return;
    }
    if (what === "all" || what === "page") {
      this.baseDirty = true;
      // Strokes can change visibility; drop cached paths for strokes no longer visible.
      if (this.paths.size > 5000) this.paths.clear();
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
    this.baseDirty = this.topDirty = true;
    this.onViewChange();
  }

  fitWidth() {
    const p = this.page;
    this.scale = (this.cssW - 24) / p.w;
    this.ox = 12;
    this.oy = 12;
    this.fit = false;
    this.baseDirty = this.topDirty = true;
    this.onViewChange();
  }

  zoomBy(f: number, cx = this.cssW / 2, cy = this.cssH / 2) {
    const ns = Math.max(0.1, Math.min(12, this.scale * f));
    const k = ns / this.scale;
    this.ox = cx - (cx - this.ox) * k;
    this.oy = cy - (cy - this.oy) * k;
    this.scale = ns;
    this.fit = false;
    this.baseDirty = this.topDirty = true;
    this.onViewChange();
  }

  get zoomPct() {
    return Math.round(this.scale * 100);
  }

  private toPage(clientX: number, clientY: number): [number, number] {
    const r = this.el.getBoundingClientRect();
    return [(clientX - r.left - this.ox) / this.scale, (clientY - r.top - this.oy) / this.scale];
  }

  // ---------- rendering ----------
  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    if (this.board.currentPage.id !== this.pageId) {
      this.pageId = this.board.currentPage.id;
      this.fitPage();
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
    for (const s of this.board.strokes(p.id)) drawStroke(ctx, s, this.paths, s.id);
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
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.top.width, this.top.height);
    this.applyTransform(ctx);
    for (const ls of this.board.live.values()) if (ls.page === p.id) drawStroke(ctx, ls, undefined, undefined, false);
    if (this.drawing && this.drawing.page === p.id) {
      const d = this.drawing;
      const pts = d.tool === "pen" || d.tool === "hl" ? d.pts.concat(this.predicted) : d.pts;
      drawStroke(ctx, { ...d, pts }, undefined, undefined, false);
    }
    const now = performance.now();
    for (const l of this.board.lasers.values()) {
      if (l.page !== p.id || !l.trail.length) continue;
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
      const h = l.trail[l.trail.length - 1];
      ctx.fillStyle = "rgba(239,68,68,0.95)";
      ctx.beginPath();
      ctx.arc(h.x, h.y, 7 / this.scale, 0, Math.PI * 2);
      ctx.fill();
    }
    if (this.hover.on && !this.drawing) {
      const [x, y] = this.toPage(this.hover.x, this.hover.y);
      ctx.beginPath();
      if (this.tool === "eraser") {
        ctx.arc(x, y, this.eraserRadius(), 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(100,116,139,0.8)";
        ctx.lineWidth = 1 / this.scale;
        ctx.stroke();
      } else if (this.tool === "pen" || this.tool === "hl") {
        ctx.arc(x, y, Math.max(1.5 / this.scale, (this.tool === "hl" ? this.size * 2 : this.size / 2)), 0, Math.PI * 2);
        ctx.fillStyle = this.tool === "hl" ? this.color + "66" : this.color;
        ctx.fill();
      }
    }
  }

  private eraserRadius() {
    return 10 / this.scale;
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
        this.baseDirty = this.topDirty = true;
        this.onViewChange();
      }
    }, { passive: false });
    window.addEventListener("keydown", (e) => {
      if (e.code === "Space" && !isTyping()) this.spaceDown = true;
    });
    window.addEventListener("keyup", (e) => {
      if (e.code === "Space") this.spaceDown = false;
    });
  }

  private isDrawTool() {
    return this.tool !== "pan" && this.tool !== "eraser" && this.tool !== "laser";
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
    if (this.tool === "laser") {
      this.laserQueued = { x, y };
      this.panning = null;
      this.drawing = null;
      this.erasing = null;
      return;
    }
    if (this.tool === "eraser") {
      this.erasing = { pointerId: e.pointerId, ids: new Set(), last: null };
      this.eraseAt(x, y);
      return;
    }
    if (!this.isDrawTool()) return;
    const pressure = e.pointerType === "pen" ? e.pressure || 0.5 : 0.5;
    this.drawing = {
      id: uid(),
      page: this.page.id,
      author: this.board.me,
      tool: this.tool as Tool,
      color: this.color,
      size: this.size,
      sp: e.pointerType !== "pen",
      pts: [[x, y, pressure]],
      at: performance.now(),
      pointerId: e.pointerId,
      sentUpTo: 0,
      startedAt: performance.now(),
      pointerType: e.pointerType,
    };
    this.topDirty = true;
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
      this.baseDirty = this.topDirty = true;
      this.onViewChange();
      return;
    }
    if (e.pointerType !== "touch") {
      const r = this.el.getBoundingClientRect();
      this.hover = { x: e.clientX - r.left + r.left, y: e.clientY, on: true };
      this.topDirty = true;
    }
    const [x, y] = this.toPage(e.clientX, e.clientY);
    if (this.tool === "laser" && (e.buttons || e.pointerType === "pen" || e.pointerType === "mouse")) {
      // The laser follows the mouse / Pencil hover even without pressing.
      this.laserQueued = { x, y };
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
    const evs = e.getCoalescedEvents?.() ?? [e];
    const shape = d.tool === "line" || d.tool === "rect" || d.tool === "ellipse";
    for (const ev of evs.length ? evs : [e]) {
      const [px, py] = this.toPage(ev.clientX, ev.clientY);
      const pr = ev.pointerType === "pen" ? ev.pressure || 0.5 : 0.5;
      if (shape) d.pts[1] = [px, py, pr];
      else d.pts.push([px, py, pr]);
    }
    this.predicted = shape ? [] : (e.getPredictedEvents?.() ?? []).slice(0, 2).map((ev) => {
      const [px, py] = this.toPage(ev.clientX, ev.clientY);
      return [px, py, ev.pressure || 0.5] as Pt;
    });
    this.topDirty = true;
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
        // Continue panning with the remaining finger.
        const rest = [...this.touches.entries()][0];
        if (rest) this.panning = { pointerId: rest[0], x: rest[1].x, y: rest[1].y, ox: this.ox, oy: this.oy };
        return;
      }
    }
    if (this.panning && this.panning.pointerId === e.pointerId) {
      this.panning = null;
      return;
    }
    if (this.erasing && this.erasing.pointerId === e.pointerId) {
      this.board.recordErase([...this.erasing.ids]);
      this.erasing = null;
      return;
    }
    const d = this.drawing;
    if (!d || d.pointerId !== e.pointerId) return;
    this.drawing = null;
    this.predicted = [];
    if (cancelled && d.pts.length < 3) {
      this.topDirty = true;
      return;
    }
    if (d.tool === "pen" || d.tool === "hl" || d.pts.length >= 2) {
      this.board.commitStroke({ id: d.id, page: d.page, tool: d.tool, color: d.color, size: d.size, sp: d.sp, pts: d.pts });
    }
    this.topDirty = true;
  }

  private cancelDrawing() {
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
    this.baseDirty = this.topDirty = true;
    this.onViewChange();
  }

  private eraseAt(x: number, y: number) {
    if (!this.erasing) return;
    const r = this.eraserRadius();
    // Sample along the path since the last event so a fast swipe doesn't skip strokes.
    const from = this.erasing.last ?? [x, y];
    this.erasing.last = [x, y];
    const dist = Math.hypot(x - from[0], y - from[1]);
    const steps = Math.max(1, Math.ceil(dist / (r * 0.75)));
    const samples: [number, number][] = [];
    for (let i = 1; i <= steps; i++) samples.push([from[0] + ((x - from[0]) * i) / steps, from[1] + ((y - from[1]) * i) / steps]);
    const hits: string[] = [];
    for (const s of this.board.strokes(this.page.id)) {
      if (this.erasing.ids.has(s.id)) continue;
      if (samples.some(([sx, sy]) => hitStroke(s, sx, sy, r))) hits.push(s.id);
    }
    if (hits.length) {
      for (const id of hits) this.erasing.ids.add(id);
      this.board.erase(hits, false);
    }
  }

  /** Once per frame: stream new points of the stroke being drawn, and the laser position. */
  private flushLive() {
    const d = this.drawing;
    if (d) {
      const meta = { id: d.id, page: d.page, tool: d.tool, color: d.color, size: d.size, sp: d.sp };
      const shape = d.tool === "line" || d.tool === "rect" || d.tool === "ellipse";
      if (shape) {
        if (d.pts.length >= 2) this.board.sendLive(meta, d.pts, true);
      } else if (d.pts.length > d.sentUpTo) {
        // Overlap one point so lost packets leave small gaps rather than jumps.
        const from = Math.max(0, d.sentUpTo - 1);
        this.board.sendLive(meta, d.pts.slice(from).map((p) => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10, Math.round(p[2] * 100) / 100] as Pt));
        d.sentUpTo = d.pts.length;
      }
    }
    if (this.laserQueued) {
      this.board.laser(this.laserQueued.x, this.laserQueued.y);
      this.laserQueued = null;
    }
  }
}

function isTyping() {
  const a = document.activeElement;
  return !!a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || (a as HTMLElement).isContentEditable);
}
