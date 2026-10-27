// Board controller: owns the state, applies local actions, syncs with peers, persists to IndexedDB.

import {
  applyOp, emptyState, livePages, pageStrokes, uid, compactPts, PAGE_W, BLANK_H,
  type BoardOp, type BoardState, type Page, type Pt, type Stroke, type Tool,
} from "./model";
import { loadBoard, saveBoard, loadAsset, saveAsset, hashBytes, toB64, fromB64 } from "./store";
import { pdfPageSizes, imageSize, assetArrived } from "./pdf";

export interface BoardTransport {
  broadcastOps(msg: object): void;
  broadcastLive(msg: object): void;
  sendTo(peerId: string, msg: object): Promise<boolean>;
}

export interface LiveStroke {
  id: string;
  page: string;
  author: string;
  tool: Tool;
  color: string;
  size: number;
  sp: boolean;
  pts: Pt[];
  at: number;
}

export interface Laser {
  page: string;
  trail: { x: number; y: number; at: number }[];
}

type UndoEntry = { kind: "add" | "erase"; ids: string[] };

const CHUNK = 16 * 1024;
const SYNC_BATCH = 120_000; // bytes of JSON per sync message (SCTP messages must stay small)

export class Board {
  state: BoardState = emptyState();
  readonly live = new Map<string, LiveStroke>();
  readonly lasers = new Map<string, Laser>();
  private undoStack: UndoEntry[] = [];
  private redoStack: UndoEntry[] = [];
  private saveTimer: number | undefined;
  private incoming = new Map<string, { mime: string; name: string; n: number; parts: (Uint8Array | undefined)[]; got: number }>();
  private requested = new Map<string, number>();
  private haveAssets = new Set<string>();
  /** Called with what changed so the view can redraw only what it needs. */
  onChange: (what: "all" | "live" | "page" | "lock") => void = () => {};
  onNotice: (text: string) => void = () => {};

  constructor(readonly roomId: string, readonly me: string, private net: BoardTransport) {}

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

  private local(op: BoardOp) {
    if (applyOp(this.state, op)) {
      this.persist();
      this.onChange(op.t === "b.go" ? "page" : op.t === "b.lock" ? "lock" : "all");
    }
    this.net.broadcastOps(op);
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

  addPage() {
    const [p] = this.insertPages([{ w: PAGE_W, h: BLANK_H }]);
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

  // ---------- strokes ----------
  canDraw(role: string) {
    return role === "teacher" || role === "ipad" || !this.state.lock.on;
  }

  setLock(on: boolean) {
    this.local({ t: "b.lock", on, ts: Math.max(Date.now(), this.state.lock.ts + 1) });
  }

  /** Streams an in-progress stroke. `replace` sends the whole point list (used for shapes). */
  sendLive(ls: Omit<LiveStroke, "at" | "author" | "pts">, pts: Pt[], replace = false) {
    this.net.broadcastLive({ t: "b.live", ...ls, pts, rep: replace });
  }

  /** One undo step for a whole eraser drag. */
  recordErase(ids: string[]) {
    if (ids.length) this.pushUndo({ kind: "erase", ids });
  }

  commitStroke(s: Omit<Stroke, "author" | "del" | "dv" | "ts">) {
    const stroke: Stroke = { ...s, pts: compactPts(s.pts), author: this.me, del: false, dv: 0, ts: Date.now() };
    this.local({ t: "b.stroke", s: stroke });
    this.pushUndo({ kind: "add", ids: [stroke.id] });
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

  clearPage() {
    this.erase(this.strokes(this.currentPage.id).map((s) => s.id));
  }

  private pushUndo(e: UndoEntry) {
    this.undoStack.push(e);
    if (this.undoStack.length > 300) this.undoStack.shift();
    this.redoStack = [];
  }

  undo() {
    const e = this.undoStack.pop();
    if (!e) return;
    if (e.kind === "add") this.erase(e.ids, false);
    else this.restore(e.ids);
    this.redoStack.push(e);
  }

  redo() {
    const e = this.redoStack.pop();
    if (!e) return;
    if (e.kind === "add") this.restore(e.ids);
    else this.erase(e.ids, false);
    this.undoStack.push(e);
  }

  laser(x: number, y: number) {
    const msg = { t: "b.laser", page: this.currentPage.id, x, y };
    this.addLaser(this.me, msg.page, x, y);
    this.net.broadcastLive(msg);
  }

  private addLaser(who: string, page: string, x: number, y: number) {
    let l = this.lasers.get(who);
    if (!l || l.page !== page) {
      l = { page, trail: [] };
      this.lasers.set(who, l);
    }
    l.trail.push({ x, y, at: performance.now() });
    if (l.trail.length > 40) l.trail.shift();
    this.onChange("live");
  }

  // ---------- files ----------
  async importFile(file: File) {
    const data = await file.arrayBuffer();
    const mime = file.type || (file.name.toLowerCase().endsWith(".pdf") ? "application/pdf" : "");
    const id = await hashBytes(data);
    await saveAsset({ id, mime, name: file.name, data });
    this.haveAssets.add(id);
    let defs: Omit<Page, "id" | "order" | "del" | "dv">[];
    if (mime === "application/pdf") {
      const sizes = await pdfPageSizes(data);
      if (sizes.length > 200) this.onNotice("הקובץ ארוך, נטענים 200 העמודים הראשונים");
      defs = sizes.slice(0, 200).map((s, index) => ({
        w: PAGE_W, h: Math.round((PAGE_W * s.h) / s.w), bg: { asset: id, kind: "pdf" as const, index },
      }));
    } else if (mime.startsWith("image/")) {
      const s = await imageSize(data, mime);
      defs = [{ w: PAGE_W, h: Math.round((PAGE_W * s.h) / s.w), bg: { asset: id, kind: "image", index: 0 } }];
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

  private async sendAsset(peerId: string, id: string) {
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
  /** Send our full state to a peer that just connected, in small pieces. */
  async sendSnapshot(peerId: string) {
    const { pages, current, lock } = this.state;
    await this.net.sendTo(peerId, { t: "b.sync", state: { pages, strokes: {}, current, lock } });
    let batch: Record<string, Stroke> = {};
    let size = 0;
    for (const s of Object.values(this.state.strokes)) {
      batch[s.id] = s;
      size += 60 + s.pts.length * 18;
      if (size > SYNC_BATCH) {
        await this.net.sendTo(peerId, { t: "b.sync", state: { pages: {}, strokes: batch, current: { page: "", ts: -1 }, lock: { on: false, ts: -1 } } });
        batch = {};
        size = 0;
      }
    }
    if (size > 0) {
      await this.net.sendTo(peerId, { t: "b.sync", state: { pages: {}, strokes: batch, current: { page: "", ts: -1 }, lock: { on: false, ts: -1 } } });
    }
  }

  handleRemote(peerId: string, msg: any) {
    switch (msg.t) {
      case "b.live": {
        let ls = this.live.get(msg.id);
        if (!ls) {
          if (this.state.strokes[msg.id]) return; // already committed
          ls = { id: msg.id, page: msg.page, author: peerId, tool: msg.tool, color: msg.color, size: msg.size, sp: msg.sp, pts: [], at: 0 };
          this.live.set(msg.id, ls);
        }
        if (msg.rep) ls.pts = msg.pts;
        else ls.pts.push(...msg.pts);
        ls.at = performance.now();
        this.onChange("live");
        return;
      }
      case "b.laser":
        this.addLaser(peerId, msg.page, msg.x, msg.y);
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
      if (applyOp(this.state, op)) {
        this.persist();
        this.onChange(op.t === "b.go" ? "page" : op.t === "b.lock" ? "lock" : "all");
        if (op.t === "b.page" || op.t === "b.sync") void this.checkAssets();
      }
    }
  }

  /** Remove stale remote live strokes and faded laser trails. */
  tick(now: number): boolean {
    let changed = false;
    for (const [id, ls] of this.live) {
      if (now - ls.at > 8000) { this.live.delete(id); changed = true; }
    }
    for (const [who, l] of this.lasers) {
      while (l.trail.length && now - l.trail[0].at > 900) { l.trail.shift(); changed = true; }
      if (!l.trail.length) this.lasers.delete(who);
    }
    return changed;
  }
}
