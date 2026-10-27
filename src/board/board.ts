// Board controller: owns the state, applies local actions, syncs with peers, persists to IndexedDB.

import {
  applyOp, emptyState, livePages, pageStrokes, uid, compactPts, opPage, isPrivate, PAGE_W, BLANK_H,
  type BoardOp, type BoardState, type Page, type Pt, type Stroke, type Tool, type Template,
} from "./model";
import { loadBoard, saveBoard, loadAsset, saveAsset, hashBytes, toB64, fromB64 } from "./store";
import { pdfPageSizes, imageSize, assetArrived } from "./pdf";

export interface BoardTransport {
  /** staffOnly: send only to the teacher's devices (teacher + iPad), never to students. */
  broadcastOps(msg: object, staffOnly?: boolean): void;
  broadcastLive(msg: object, staffOnly?: boolean): void;
  sendTo(peerId: string, msg: object): Promise<boolean>;
  peerIsStudent(peerId: string): boolean;
}

export interface LiveStroke {
  id: string;
  page: string;
  author: string;
  tool: Tool;
  color: string;
  size: number;
  sp: boolean;
  dash?: boolean;
  pts: Pt[];
  at: number;
}

export interface Laser {
  page: string;
  dot: boolean;
  trail: { x: number; y: number; at: number }[];
}

/** 2D affine matrix [a, b, c, d, e, f]: x' = a*x + c*y + e, y' = b*x + d*y + f */
export type Mat = [number, number, number, number, number, number];

type StyleItem = { id: string; pts: Pt[]; color: string; size: number; dash?: boolean };
type UndoEntry =
  | { kind: "add"; ids: string[] }
  | { kind: "erase"; ids: string[] }
  | { kind: "replace"; removed: string[]; added: string[] }
  | { kind: "upd"; before: StyleItem[]; after: StyleItem[] };

const CHUNK = 16 * 1024;
const SYNC_BATCH = 120_000; // bytes of JSON per sync message (SCTP messages must stay small)
export const TEMP_HOLD_MS = 3500;
export const TEMP_FADE_MS = 900;

export function applyMat(m: Mat, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export class Board {
  state: BoardState = emptyState();
  readonly live = new Map<string, LiveStroke>();
  readonly lasers = new Map<string, Laser>();
  /** Disappearing ink: shown for a few seconds, never stored. */
  readonly temps = new Map<string, { s: Stroke; at: number }>();
  /** Strokes being dragged by someone's lasso right now (rendered transformed until committed). */
  readonly previews = new Map<string, Mat>();
  private previewAt = new Map<string, number>();
  private clip: Stroke[] = [];
  private undoStack: UndoEntry[] = [];
  private redoStack: UndoEntry[] = [];
  private saveTimer: number | undefined;
  private incoming = new Map<string, { mime: string; name: string; n: number; parts: (Uint8Array | undefined)[]; got: number }>();
  private requested = new Map<string, number>();
  private haveAssets = new Set<string>();
  /** Called with what changed so the view can redraw only what it needs. */
  onChange: (what: "all" | "live" | "page" | "lock" | "stroke", strokeId?: string) => void = () => {};
  onNotice: (text: string) => void = () => {};

  constructor(readonly roomId: string, readonly me: string, readonly role: string, private net: BoardTransport) {}

  get isStaff() {
    return this.role !== "student";
  }

  async load() {
    const saved = await loadBoard(this.roomId);
    if (saved && saved.pages) {
      this.state = saved;
      if (!this.state.lock) this.state.lock = { on: false, ts: 0 };
    }
    this.onChange("all");
    void this.checkAssets();
  }

  private persist() {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => void saveBoard(this.roomId, this.state), 800);
  }

  private privateOp(op: object) {
    return isPrivate(this.state, opPage(this.state, op));
  }

  private local(op: BoardOp) {
    if (applyOp(this.state, op)) {
      this.persist();
      this.notify(op);
    }
    this.net.broadcastOps(op, this.privateOp(op));
  }

  private notify(op: BoardOp) {
    if (op.t === "b.go") this.onChange("page");
    else if (op.t === "b.lock") this.onChange("lock");
    else if (op.t === "b.stroke") this.onChange("stroke", op.s.id);
    else this.onChange("all");
  }

  // ---------- pages ----------
  get pages(): Page[] {
    return livePages(this.state);
  }

  get currentPage(): Page {
    const p = this.state.pages[this.state.current.page];
    if (p && !p.del) return p;
    return this.pages[0] ?? this.ensureAPage();
  }

  private ensureAPage(): Page {
    const p: Page = { id: uid(), order: 0, w: PAGE_W, h: BLANK_H, del: false, dv: 0 };
    this.local({ t: "b.page", page: p });
    return p;
  }

  strokes(pageId: string): Stroke[] {
    return pageStrokes(this.state, pageId);
  }

  go(pageId: string) {
    if (!this.state.pages[pageId]) return;
    this.local({ t: "b.go", page: pageId, ts: Math.max(Date.now(), this.state.current.ts + 1) });
  }

  goRelative(delta: number) {
    const ps = this.pages;
    const i = ps.findIndex((p) => p.id === this.currentPage.id);
    const next = ps[Math.min(ps.length - 1, Math.max(0, i + delta))];
    if (next && next.id !== this.currentPage.id) this.go(next.id);
  }

  /** Inserts pages right after the current one and returns them. */
  private insertPages(defs: Omit<Page, "id" | "order" | "del" | "dv">[]): Page[] {
    const ps = this.pages;
    const i = ps.findIndex((p) => p.id === this.currentPage.id);
    const lo = ps[i]?.order ?? 0;
    const hi = ps[i + 1]?.order ?? lo + defs.length + 1;
    const step = (hi - lo) / (defs.length + 1);
    const out = defs.map((d, k) => ({ ...d, id: uid(), order: lo + step * (k + 1), del: false, dv: 0 }));
    for (const p of out) this.local({ t: "b.page", page: p });
    return out;
  }

  addPage(priv = false) {
    const tpl = this.currentPage.bg ? undefined : this.currentPage.tpl;
    const [p] = this.insertPages([{ w: PAGE_W, h: BLANK_H, tpl, tv: tpl ? 1 : undefined, priv: priv || undefined }]);
    this.go(p.id);
  }

  duplicatePage() {
    const cur = this.currentPage;
    const [p] = this.insertPages([{ w: cur.w, h: cur.h, bg: cur.bg, tpl: cur.tpl, tv: cur.tpl ? 1 : undefined, priv: cur.priv }]);
    const copies = this.strokes(cur.id).map((s) => this.cloneStroke(s, p.id, 0, 0));
    for (const s of copies) this.local({ t: "b.stroke", s });
    this.go(p.id);
  }

  deletePage() {
    const ps = this.pages;
    const cur = this.currentPage;
    if (ps.length <= 1) {
      this.clearPage();
      return;
    }
    const i = ps.findIndex((p) => p.id === cur.id);
    const next = ps[i + 1] ?? ps[i - 1];
    this.local({ t: "b.page", page: { ...cur, del: true, dv: cur.dv + 1 } });
    this.go(next.id);
  }

  setTemplate(tpl: Template) {
    const p = this.currentPage;
    this.local({ t: "b.tpl", page: p.id, tpl, tv: (p.tv ?? 0) + 1 });
  }

  // ---------- strokes ----------
  canDraw(role: string) {
    return role === "teacher" || role === "ipad" || !this.state.lock.on;
  }

  setLock(on: boolean) {
    this.local({ t: "b.lock", on, ts: Math.max(Date.now(), this.state.lock.ts + 1) });
  }

  /** Streams an in-progress stroke. `replace` sends the whole point list (used for shapes). */
  sendLive(ls: Omit<LiveStroke, "at" | "author" | "pts">, pts: Pt[], replace = false) {
    this.net.broadcastLive({ t: "b.live", ...ls, pts, rep: replace }, isPrivate(this.state, ls.page));
  }

  /** One undo step for a whole eraser drag. */
  recordErase(ids: string[]) {
    if (ids.length) this.pushUndo({ kind: "erase", ids });
  }

  private makeStroke(s: Omit<Stroke, "author" | "del" | "dv" | "ts">): Stroke {
    return { ...s, pts: compactPts(s.pts), author: this.me, del: false, dv: 0, ts: Date.now() };
  }

  commitStroke(s: Omit<Stroke, "author" | "del" | "dv" | "ts">) {
    const stroke = this.makeStroke(s);
    this.local({ t: "b.stroke", s: stroke });
    this.pushUndo({ kind: "add", ids: [stroke.id] });
  }

  /** Adds several strokes as one undo step (axes, paste). */
  addStrokes(list: Omit<Stroke, "author" | "del" | "dv" | "ts">[]): string[] {
    const ids: string[] = [];
    for (const s of list) {
      const st = this.makeStroke(s);
      this.local({ t: "b.stroke", s: st });
      ids.push(st.id);
    }
    if (ids.length) this.pushUndo({ kind: "add", ids });
    return ids;
  }

  /** Disappearing ink: everyone sees it for a few seconds, nothing is stored. */
  commitTemp(s: Omit<Stroke, "author" | "del" | "dv" | "ts">) {
    const stroke = this.makeStroke(s);
    this.temps.set(stroke.id, { s: stroke, at: performance.now() });
    this.net.broadcastOps({ t: "b.temp", s: stroke }, isPrivate(this.state, stroke.page));
    this.onChange("live");
  }

  erase(ids: string[], recordUndo = true) {
    const items = ids
      .map((id) => this.state.strokes[id])
      .filter((s): s is Stroke => !!s && !s.del)
      .map((s) => ({ id: s.id, del: true, dv: s.dv + 1 }));
    if (!items.length) return;
    this.local({ t: "b.vis", items });
    if (recordUndo) this.pushUndo({ kind: "erase", ids: items.map((i) => i.id) });
  }

  private restore(ids: string[]) {
    const items = ids
      .map((id) => this.state.strokes[id])
      .filter((s): s is Stroke => !!s && s.del)
      .map((s) => ({ id: s.id, del: false, dv: s.dv + 1 }));
    if (items.length) this.local({ t: "b.vis", items });
  }

  /** Partial eraser: replace a stroke with the pieces that survive. Returns the new piece ids. */
  splitStroke(id: string, pieces: Pt[][]): string[] {
    const s = this.state.strokes[id];
    if (!s || s.del) return [];
    this.erase([id], false);
    const ids: string[] = [];
    for (const pts of pieces) {
      if (pts.length < 2) continue;
      const piece: Stroke = { ...s, id: uid(), pts, del: false, dv: 0, pv: 0, ts: s.ts };
      this.local({ t: "b.stroke", s: piece });
      ids.push(piece.id);
    }
    return ids;
  }

  recordReplace(removed: string[], added: string[]) {
    const rm = new Set(removed), ad = new Set(added);
    // Pieces created and erased within the same drag are neither "original" nor "final".
    const removedOriginal = removed.filter((id) => !ad.has(id));
    const addedFinal = added.filter((id) => !rm.has(id));
    if (removedOriginal.length || addedFinal.length) this.pushUndo({ kind: "replace", removed: removedOriginal, added: addedFinal });
  }

  clearPage() {
    this.erase(this.strokes(this.currentPage.id).map((s) => s.id));
  }

  // ---------- lasso: move / resize / recolour / copy ----------
  private styleOf(s: Stroke): StyleItem {
    return { id: s.id, pts: s.pts, color: s.color, size: s.size, dash: s.dash };
  }

  private applyStyles(items: StyleItem[]) {
    const out = items
      .map((it) => {
        const s = this.state.strokes[it.id];
        return s ? { ...it, pv: (s.pv ?? 0) + 1 } : null;
      })
      .filter((x): x is StyleItem & { pv: number } => !!x);
    if (out.length) this.local({ t: "b.upd", items: out });
  }

  /** Live preview of a lasso drag for everyone else (no state change). */
  previewTransform(ids: string[], m: Mat | null) {
    const page = this.state.strokes[ids[0]]?.page;
    if (!page) return;
    this.net.broadcastLive({ t: "b.xf", ids, m, page }, isPrivate(this.state, page));
  }

  transformStrokes(ids: string[], m: Mat) {
    const scale = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
    const before: StyleItem[] = [];
    const after: StyleItem[] = [];
    for (const id of ids) {
      const s = this.state.strokes[id];
      if (!s || s.del) continue;
      before.push(this.styleOf(s));
      const pts = s.pts.map(([x, y, p]) => {
        const [nx, ny] = applyMat(m, x, y);
        return [Math.round(nx * 10) / 10, Math.round(ny * 10) / 10, p] as Pt;
      });
      after.push({ id, pts, color: s.color, size: Math.max(0.5, Math.round(s.size * scale * 100) / 100), dash: s.dash });
    }
    this.applyStyles(after);
    if (after.length) this.pushUndo({ kind: "upd", before, after });
  }

  restyleStrokes(ids: string[], patch: { color?: string; dash?: boolean }) {
    const before: StyleItem[] = [];
    const after: StyleItem[] = [];
    for (const id of ids) {
      const s = this.state.strokes[id];
      if (!s || s.del) continue;
      before.push(this.styleOf(s));
      after.push({ ...this.styleOf(s), ...patch });
    }
    this.applyStyles(after);
    if (after.length) this.pushUndo({ kind: "upd", before, after });
  }

  private cloneStroke(s: Stroke, page: string, dx: number, dy: number): Stroke {
    return {
      ...s, id: uid(), page, author: this.me, del: false, dv: 0, pv: 0, ts: Date.now(),
      pts: s.pts.map(([x, y, p]) => [x + dx, y + dy, p] as Pt),
    };
  }

  copy(ids: string[]) {
    this.clip = ids.map((id) => this.state.strokes[id]).filter((s): s is Stroke => !!s && !s.del).map((s) => ({ ...s }));
    return this.clip.length;
  }

  get canPaste() {
    return this.clip.length > 0;
  }

  /** Pastes the clipboard on the current page; offset a little if it's the same page. Returns new ids. */
  paste(): string[] {
    if (!this.clip.length) return [];
    const page = this.currentPage.id;
    const off = this.clip[0].page === page ? 24 : 0;
    const copies = this.clip.map((s) => this.cloneStroke(s, page, off, off));
    for (const s of copies) this.local({ t: "b.stroke", s });
    this.pushUndo({ kind: "add", ids: copies.map((s) => s.id) });
    return copies.map((s) => s.id);
  }

  // ---------- undo ----------
  private pushUndo(e: UndoEntry) {
    this.undoStack.push(e);
    if (this.undoStack.length > 300) this.undoStack.shift();
    this.redoStack = [];
  }

  undo() {
    const e = this.undoStack.pop();
    if (!e) return;
    this.applyUndo(e, true);
    this.redoStack.push(e);
  }

  redo() {
    const e = this.redoStack.pop();
    if (!e) return;
    this.applyUndo(e, false);
    this.undoStack.push(e);
  }

  private applyUndo(e: UndoEntry, undo: boolean) {
    switch (e.kind) {
      case "add": undo ? this.erase(e.ids, false) : this.restore(e.ids); break;
      case "erase": undo ? this.restore(e.ids) : this.erase(e.ids, false); break;
      case "replace":
        if (undo) { this.erase(e.added, false); this.restore(e.removed); }
        else { this.erase(e.removed, false); this.restore(e.added); }
        break;
      case "upd": this.applyStyles(undo ? e.before : e.after); break;
    }
  }

  // ---------- pointer ----------
  laser(x: number, y: number, dot: boolean) {
    const msg = { t: "b.laser", page: this.currentPage.id, x, y, dot };
    this.addLaser(this.me, msg.page, x, y, dot);
    this.net.broadcastLive(msg, isPrivate(this.state, msg.page));
  }

  private addLaser(who: string, page: string, x: number, y: number, dot: boolean) {
    let l = this.lasers.get(who);
    if (!l || l.page !== page || l.dot !== dot) {
      l = { page, dot, trail: [] };
      this.lasers.set(who, l);
    }
    l.trail.push({ x, y, at: performance.now() });
    if (l.trail.length > 40) l.trail.shift();
    this.onChange("live");
  }

  // ---------- files ----------
  async importFile(file: File | Blob, name = (file as File).name ?? "image.png") {
    const data = await file.arrayBuffer();
    const mime = file.type || (name.toLowerCase().endsWith(".pdf") ? "application/pdf" : "");
    const id = await hashBytes(data);
    await saveAsset({ id, mime, name, data });
    this.haveAssets.add(id);
    let defs: Omit<Page, "id" | "order" | "del" | "dv">[];
    const priv = this.currentPage.priv || undefined;
    if (mime === "application/pdf") {
      const sizes = await pdfPageSizes(data);
      if (sizes.length > 200) this.onNotice("הקובץ ארוך, נטענים 200 העמודים הראשונים");
      defs = sizes.slice(0, 200).map((s, index) => ({
        w: PAGE_W, h: Math.round((PAGE_W * s.h) / s.w), bg: { asset: id, kind: "pdf" as const, index }, priv,
      }));
    } else if (mime.startsWith("image/")) {
      const s = await imageSize(data, mime);
      defs = [{ w: PAGE_W, h: Math.round((PAGE_W * s.h) / s.w), bg: { asset: id, kind: "image", index: 0 }, priv }];
    } else {
      this.onNotice("אפשר להעלות רק PDF או תמונה");
      return;
    }
    const pages = this.insertPages(defs);
    this.go(pages[0].id);
  }

  private async checkAssets() {
    const needed = new Set<string>();
    for (const p of this.pages) if (p.bg) needed.add(p.bg.asset);
    for (const id of needed) {
      if (this.haveAssets.has(id)) continue;
      if (await loadAsset(id)) {
        this.haveAssets.add(id);
        continue;
      }
      const last = this.requested.get(id) ?? 0;
      if (Date.now() - last > 8000) {
        this.requested.set(id, Date.now());
        this.net.broadcastOps({ t: "b.assetReq", id });
      }
    }
  }

  /** Students may only fetch files used on pages they can see. */
  private assetVisibleToStudents(id: string) {
    return this.pages.some((p) => p.bg?.asset === id && !p.priv);
  }

  private async sendAsset(peerId: string, id: string) {
    if (this.net.peerIsStudent(peerId) && !this.assetVisibleToStudents(id)) return;
    const a = await loadAsset(id);
    if (!a) return;
    const bytes = new Uint8Array(a.data);
    const n = Math.ceil(bytes.length / CHUNK) || 1;
    for (let i = 0; i < n; i++) {
      const data = toB64(bytes.subarray(i * CHUNK, (i + 1) * CHUNK));
      const ok = await this.net.sendTo(peerId, { t: "b.asset", id, mime: a.mime, name: a.name, i, n, data });
      if (!ok) return;
    }
  }

  private async receiveChunk(m: { id: string; mime: string; name: string; i: number; n: number; data: string }) {
    if (this.haveAssets.has(m.id)) return;
    let inc = this.incoming.get(m.id);
    if (!inc) {
      inc = { mime: m.mime, name: m.name, n: m.n, parts: new Array(m.n), got: 0 };
      this.incoming.set(m.id, inc);
    }
    if (inc.parts[m.i]) return;
    inc.parts[m.i] = fromB64(m.data);
    inc.got++;
    if (inc.got < inc.n) return;
    this.incoming.delete(m.id);
    const total = inc.parts.reduce((s, p) => s + (p?.length ?? 0), 0);
    const all = new Uint8Array(total);
    let off = 0;
    for (const p of inc.parts) { all.set(p!, off); off += p!.length; }
    const data = all.buffer;
    if ((await hashBytes(data)) !== m.id) return; // corrupted; it will be requested again
    await saveAsset({ id: m.id, mime: inc.mime, name: inc.name, data });
    this.haveAssets.add(m.id);
    assetArrived(m.id);
    this.onChange("all");
  }

  // ---------- networking ----------
  /** Send our full state to a peer that just connected, in small pieces (without private pages for students). */
  async sendSnapshot(peerId: string) {
    const student = this.net.peerIsStudent(peerId);
    const visible = (pageId: string) => !student || !this.state.pages[pageId]?.priv;
    const pages: Record<string, Page> = {};
    for (const p of Object.values(this.state.pages)) if (visible(p.id)) pages[p.id] = p;
    const current = visible(this.state.current.page) ? this.state.current : { page: "", ts: -1 };
    await this.net.sendTo(peerId, { t: "b.sync", state: { pages, strokes: {}, current, lock: this.state.lock } });
    let batch: Record<string, Stroke> = {};
    let size = 0;
    const flush = () => this.net.sendTo(peerId, { t: "b.sync", state: { pages: {}, strokes: batch, current: { page: "", ts: -1 }, lock: { on: false, ts: -1 } } });
    for (const s of Object.values(this.state.strokes)) {
      if (!visible(s.page)) continue;
      batch[s.id] = s;
      size += 60 + s.pts.length * 18;
      if (size > SYNC_BATCH) {
        await flush();
        batch = {};
        size = 0;
      }
    }
    if (size > 0) await flush();
  }

  handleRemote(peerId: string, msg: any) {
    switch (msg.t) {
      case "b.live": {
        let ls = this.live.get(msg.id);
        if (!ls) {
          if (this.state.strokes[msg.id]) return; // already committed
          ls = { id: msg.id, page: msg.page, author: peerId, tool: msg.tool, color: msg.color, size: msg.size, sp: msg.sp, dash: msg.dash, pts: [], at: 0 };
          this.live.set(msg.id, ls);
        }
        if (msg.rep) ls.pts = msg.pts;
        else ls.pts.push(...msg.pts);
        ls.at = performance.now();
        this.onChange("live");
        return;
      }
      case "b.laser":
        this.addLaser(peerId, msg.page, msg.x, msg.y, !!msg.dot);
        return;
      case "b.temp":
        this.live.delete(msg.s.id);
        this.temps.set(msg.s.id, { s: msg.s, at: performance.now() });
        this.onChange("live");
        return;
      case "b.xf":
        for (const id of msg.ids as string[]) {
          if (msg.m) { this.previews.set(id, msg.m); this.previewAt.set(id, performance.now()); }
          else this.previews.delete(id);
        }
        this.onChange("all");
        return;
      case "b.assetReq":
        if (this.haveAssets.has(msg.id)) void this.sendAsset(peerId, msg.id);
        else void loadAsset(msg.id).then((a) => { if (a) { this.haveAssets.add(a.id); void this.sendAsset(peerId, a.id); } });
        return;
      case "b.asset":
        void this.receiveChunk(msg);
        return;
    }
    if (typeof msg.t === "string" && msg.t.startsWith("b.")) {
      const op = msg as BoardOp;
      if (op.t === "b.stroke") this.live.delete(op.s.id);
      if (op.t === "b.upd") for (const it of op.items) this.previews.delete(it.id);
      if (applyOp(this.state, op)) {
        this.persist();
        this.notify(op);
        if (op.t === "b.page" || op.t === "b.sync") void this.checkAssets();
      }
    }
  }

  /** Remove stale remote live strokes, faded laser trails and expired disappearing ink. */
  tick(now: number): boolean {
    let changed = false;
    for (const [id, ls] of this.live) {
      if (now - ls.at > 8000) { this.live.delete(id); changed = true; }
    }
    for (const [who, l] of this.lasers) {
      const keep = l.dot ? 1500 : 900;
      while (l.trail.length && now - l.trail[0].at > keep) { l.trail.shift(); changed = true; }
      if (!l.trail.length) this.lasers.delete(who);
    }
    if (this.temps.size) changed = true;
    for (const [id, t] of this.temps) if (now - t.at > TEMP_HOLD_MS + TEMP_FADE_MS) this.temps.delete(id);
    for (const [id, at] of this.previewAt) {
      if (now - at > 5000) { this.previews.delete(id); this.previewAt.delete(id); changed = true; }
    }
    return changed;
  }
}
