// Board controller: owns the state, applies local actions, syncs with peers, persists to IndexedDB.

import {
  applyOp, emptyState, livePages, pageStrokes, uid, compactPts, opPage, isPrivate, newerLesson, hasContent, nextPageId, PAGE_W, BLANK_H,
  type BoardOp, type BoardState, type LessonInfo, type Page, type Pt, type Stroke, type Tool, type Template,
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
  /** Where the pointer is now; `show`: draw the red dot there (dot mode, or a hovering pointer). */
  head: { x: number; y: number; at: number; show: boolean };
  /**
   * Trail points. Only consecutive points of the same segment are joined: a new segment starts at
   * every press, so a word written with the laser doesn't get lines between its letters.
   */
  trail: { x: number; y: number; at: number; seg: number }[];
}

/** One laser sample: a press (trail), a mouse hover (trail + dot) or a Pencil hover (dot only). */
export interface LaserPt {
  x: number;
  y: number;
  /** Segment id: points are joined only within the same segment. */
  seg: number;
  /** Hovering (no button pressed): show the pointer's dot. */
  hover?: boolean;
  /** Moves only the dot, adds nothing to the trail (Apple Pencil hover). */
  noTrail?: boolean;
}

/** Laser trail: each point stays this long, then fades out over LASER_FADE_MS. */
export const LASER_HOLD_MS = 1600;
export const LASER_FADE_MS = 600;
const LASER_DOT_MS = 1500;
const LASER_MAX_PTS = 800;
/** A lasso drag preview (b.xf) for strokes that were committed (b.upd) this recently is stale. */
const XF_STALE_MS = 1500;

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
/** A teacher who comes back after this long without any board activity starts a new lesson. */
export const LESSON_GAP_MS = 3 * 3600 * 1000;
/** Starting a lesson from the home screen starts a new board if the saved one was idle this long. */
export const FRESH_GAP_MS = 10 * 60 * 1000;
/** A teacher device with no saved board waits this long for a lesson already running on another device. */
const ADOPT_WAIT_MS = 4000;
/** State-changing ops are tagged with the lesson id, so ink from an old lesson never leaks into a new one. */
const LESSON_OPS = new Set(["b.page", "b.stroke", "b.vis", "b.upd", "b.tpl", "b.go", "b.lock", "b.follow", "b.side"]);

/** Board state as stored on this device, with the time of the last change. */
type Saved = BoardState & { act?: number };

/**
 * The visible part of the board, relative to the page at the screen's center: page-local center
 * and visible width / height in page units. Sent by the teacher's devices so the student sees the same.
 */
export interface ViewMsg {
  page: string;
  cx: number;
  cy: number;
  w: number;
  h: number;
}

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
  /** Lasso drags (by their id) whose end we already got: late previews from them are ignored. */
  private endedDrags = new Set<string>();
  /** When a stroke last got a b.upd from a peer (old peers' previews carry no version). */
  private updAt = new Map<string, number>();
  private clip: Stroke[] = [];
  private undoStack: UndoEntry[] = [];
  private redoStack: UndoEntry[] = [];
  private saveTimer: number | undefined;
  private incoming = new Map<string, { mime: string; name: string; n: number; parts: (Uint8Array | undefined)[]; got: number }>();
  private requested = new Map<string, number>();
  private haveAssets = new Set<string>();
  private lastAct = 0;
  /** Teacher device that had no saved board: may still join a lesson that is already running on another device. */
  private adoptable = false;
  private adoptTimer: number | undefined;
  /** This device loaded a board saved before lessons had ids: it must never mix into a lesson. */
  private legacyLoaded = false;
  /** Called with what changed so the view can redraw only what it needs. */
  onChange: (what: "all" | "live" | "page" | "lock" | "stroke" | "side" | "lesson", strokeId?: string) => void = () => {};
  onNotice: (text: string) => void = () => {};
  /** A finished lesson was put aside (its board is kept on this device and should be saved as PDF). */
  onLessonArchived: (state: BoardState) => void = () => {};
  /** Another device (the teacher's) moved its view and this device should follow. */
  onRemoteView: (v: ViewMsg) => void = () => {};
  /** This device just turned "follow the teacher" on: send our view so everyone catches up. */
  onFollowEnabled: () => void = () => {};

  constructor(readonly roomId: string, readonly me: string, readonly role: string, private net: BoardTransport) {}

  get isStaff() {
    return this.role !== "student";
  }

  get lesson(): LessonInfo {
    return this.state.lesson ?? { id: "legacy", started: 0 };
  }

  /**
   * Loads this room's board. The teacher's device decides when a new lesson starts: when nothing
   * was saved, or when the saved board has been idle for a few hours. The previous board is kept.
   */
  async load(now = Date.now(), opts: { fresh?: boolean } = {}) {
    const saved = (await loadBoard(this.roomId)) as Saved | undefined;
    if (saved && saved.pages) {
      this.state = saved;
      if (!this.state.lock) this.state.lock = { on: true, ts: 0 };
      if (this.state.side === undefined) this.state.side = null;
      this.lastAct = saved.act ?? Math.max(0, ...Object.values(saved.strokes).map((s) => s.ts));
      this.legacyLoaded = !saved.lesson && hasContent(saved);
    }
    if (this.role === "teacher") {
      if (!saved?.pages) {
        // A new computer / cleared browser: join the lesson the iPad or student is already on, if any.
        this.state = emptyState();
        this.adoptable = true;
        this.adoptTimer = window.setTimeout(() => this.ensureLesson(), ADOPT_WAIT_MS);
      } else if (
        !this.state.lesson || now - this.lastAct > LESSON_GAP_MS ||
        // The teacher started the lesson from the home screen and the board has been idle for a while.
        (opts.fresh && hasContent(this.state) && now - this.lastAct > FRESH_GAP_MS)
      ) {
        this.archiveAndReset({ id: uid(), started: now });
      }
      this.persist();
    }
    this.ensureTrailingPage();
    this.onChange("all");
    void this.checkAssets();
  }

  /** Teacher: if no lesson was found on another device, start one. */
  private ensureLesson() {
    clearTimeout(this.adoptTimer);
    this.adoptable = false;
    if (this.state.lesson || this.role !== "teacher") return;
    const lesson = { id: uid(), started: Date.now() };
    this.state.lesson = lesson;
    this.persist();
    this.net.broadcastOps({ t: "b.lesson", lesson });
  }

  /** Teacher: start a new lesson now. The current board is kept and saved as PDF. */
  newLesson() {
    clearTimeout(this.adoptTimer);
    const lesson = { id: uid(), started: Math.max(Date.now(), this.lesson.started + 1) };
    this.archiveAndReset(lesson);
    this.adoptable = false;
    this.persist();
    this.net.broadcastOps({ t: "b.lesson", lesson });
    this.onChange("lesson");
    this.onChange("all");
  }

  private archiveAndReset(lesson: LessonInfo) {
    const old = this.state;
    if (hasContent(old)) {
      const key = `${this.roomId}@${old.lesson?.id ?? "legacy-" + (this.lastAct || Date.now())}`;
      void saveBoard(key, { ...old, act: this.lastAct } as Saved);
      this.onLessonArchived(old);
    }
    this.state = emptyState(lesson);
    this.live.clear();
    this.previews.clear();
    this.temps.clear();
    this.undoStack = [];
    this.redoStack = [];
    this.lastAct = Date.now();
  }

  /** Another device is on a newer lesson: put ours aside and follow it. */
  private followLesson(lesson: LessonInfo) {
    if (this.role === "teacher") this.archiveAndReset(lesson);
    else {
      // Students and the iPad don't keep old lessons; the teacher's device does.
      this.state = emptyState(lesson);
      this.live.clear();
      this.previews.clear();
      this.undoStack = [];
      this.redoStack = [];
    }
    this.persist();
    this.onChange("lesson");
  }

  private persist() {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => void saveBoard(this.roomId, { ...this.state, act: this.lastAct } as Saved), 800);
  }

  private privateOp(op: object) {
    return isPrivate(this.state, opPage(this.state, op));
  }

  private local(op: BoardOp) {
    if (!this.state.lesson && this.role === "teacher") this.ensureLesson();
    if (applyOp(this.state, op)) {
      if (op.t !== "b.go") this.lastAct = Date.now();
      this.persist();
      this.notify(op);
    }
    this.net.broadcastOps({ ...op, L: this.state.lesson?.id }, this.privateOp(op));
  }

  private notify(op: BoardOp) {
    if (op.t === "b.go") this.onChange("page");
    else if (op.t === "b.lock" || op.t === "b.follow") this.onChange("lock");
    else if (op.t === "b.side") this.onChange("side");
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

  /**
   * The page at the center of this device's screen became the current one because the user
   * scrolled there. Only local: not sent to anyone and not a "go" (no version bump).
   */
  setCurrentLocal(pageId: string) {
    const p = this.state.pages[pageId];
    if (!p || p.del || this.state.current.page === pageId) return;
    this.state.current = { page: pageId, ts: this.state.current.ts };
    this.onChange("page");
  }

  /**
   * Continuous board: as soon as there's ink on the last page, a blank page follows it, so the
   * teacher can just scroll down and keep writing. Only the teacher's devices add it; its id is
   * derived from the last page's, so the computer and the iPad adding it at once make one page.
   */
  private ensureTrailingPage(strokePage?: string) {
    // strokePage: ink was just committed there. Without it (load / sync), only check the board.
    if (!this.isStaff) return;
    if (this.role === "teacher" && !this.state.lesson) return; // still waiting to join a running lesson
    const ps = this.pages;
    const last = ps[ps.length - 1];
    if (!last) return;
    if (strokePage !== undefined && strokePage !== last.id) return;
    if (!Object.values(this.state.strokes).some((s) => s.page === last.id && !s.del)) return;
    const id = nextPageId(last.id);
    const old = this.state.pages[id];
    if (old && !old.del) return;
    // The teacher deleted that page: bring it back only when there's new ink on the last page.
    if (old && strokePage === undefined) return;
    const tpl = last.bg ? undefined : last.tpl;
    const page: Page = {
      id, order: last.order + 1, w: PAGE_W, h: BLANK_H, tpl, tv: tpl ? 1 : undefined, priv: last.priv || undefined,
      del: false, dv: old ? old.dv + 1 : 0,
    };
    this.local({ t: "b.page", page });
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
    this.ensureTrailingPage(p.id);
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

  /** Whether the student's view follows the teacher's scrolling and zoom (on by default). */
  get followOn(): boolean {
    return this.state.follow?.on ?? true;
  }

  setFollow(on: boolean) {
    this.local({ t: "b.follow", on, ts: Math.max(Date.now(), (this.state.follow?.ts ?? 0) + 1) });
    if (on) this.onFollowEnabled();
  }

  /** Teacher's devices: tell everyone (or one peer) what part of the board is on screen. */
  sendView(v: ViewMsg, peerId?: string) {
    if (!this.isStaff || !this.followOn || !this.state.pages[v.page]) return;
    const priv = isPrivate(this.state, v.page);
    const msg = { t: "b.view", page: v.page, cx: v.cx, cy: v.cy, w: v.w, h: v.h };
    if (peerId) {
      if (priv && this.net.peerIsStudent(peerId)) return;
      void this.net.sendTo(peerId, msg);
    } else this.net.broadcastLive(msg, priv);
  }

  /** Streams an in-progress stroke. `replace` sends the whole point list (used for shapes). */
  sendLive(ls: Omit<LiveStroke, "at" | "author" | "pts">, pts: Pt[], replace = false, offset?: number) {
    this.net.broadcastLive({ t: "b.live", ...ls, pts, rep: replace, o: offset }, isPrivate(this.state, ls.page));
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
    this.ensureTrailingPage(stroke.page);
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
    if (list.length) this.ensureTrailingPage(list[0].page);
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

  /**
   * Live preview of a lasso drag for everyone else (no state change). `drag.g` identifies this
   * drag and `drag.v` is the version the first stroke had when it started, so a preview that
   * arrives late (after the move was committed, or after the drag ended) is recognised and ignored.
   */
  previewTransform(ids: string[], m: Mat | null, drag?: { g: string; v: number }) {
    const page = this.state.strokes[ids[0]]?.page;
    if (!page) return;
    this.net.broadcastLive({ t: "b.xf", ids, m, page, g: drag?.g, v: drag?.v }, isPrivate(this.state, page));
  }

  private remotePreview(msg: { ids: string[]; m: Mat | null; g?: string; v?: number }) {
    if (!Array.isArray(msg.ids)) return;
    const now = performance.now();
    if (!msg.m) {
      if (msg.g) this.endedDrags.add(msg.g);
      if (this.endedDrags.size > 200) this.endedDrags.clear();
    } else if (msg.g && this.endedDrags.has(msg.g)) return; // the drag already ended: a late packet
    if (msg.m) {
      // Stale: the strokes were already moved (committed) since this drag started.
      const first = this.state.strokes[msg.ids[0]];
      if (typeof msg.v === "number" ? (first?.pv ?? 0) > msg.v : msg.ids.some((id) => now - (this.updAt.get(id) ?? -Infinity) < XF_STALE_MS)) return;
    }
    let membership = false;
    for (const id of msg.ids) {
      if (msg.m) {
        if (!this.previews.has(id)) membership = true;
        this.previews.set(id, msg.m);
        this.previewAt.set(id, now);
      } else if (this.previews.delete(id)) {
        this.previewAt.delete(id);
        membership = true;
      }
    }
    // Strokes being moved are left out of the base layer: redraw it only when that set changes.
    this.onChange(membership ? "all" : "live");
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
    this.ensureTrailingPage(page);
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
  /**
   * The laser pointer moved (one or more samples since the last frame, all with the same
   * segment / hover state). Old peers read only x, y, dot (the last sample).
   */
  laser(pts: LaserPt[], dot: boolean, page = this.currentPage.id) {
    const last = pts[pts.length - 1];
    if (!last) return;
    const r = (n: number) => Math.round(n * 10) / 10;
    const msg = {
      t: "b.laser", page, x: r(last.x), y: r(last.y), dot, s: last.seg, hv: last.hover ? 1 : 0, nt: last.noTrail ? 1 : 0,
      pts: pts.length > 1 ? pts.map((p) => [r(p.x), r(p.y)]) : undefined,
    };
    for (const p of pts) this.addLaser(this.me, page, p, dot);
    this.onChange("live");
    this.net.broadcastLive(msg, isPrivate(this.state, msg.page));
  }

  private addLaser(who: string, page: string, p: LaserPt, dot: boolean) {
    const now = performance.now();
    let l = this.lasers.get(who);
    if (!l || l.page !== page || l.dot !== dot) {
      l = { page, dot, head: { x: p.x, y: p.y, at: now, show: false }, trail: [] };
      this.lasers.set(who, l);
    }
    l.head = { x: p.x, y: p.y, at: now, show: dot || !!p.hover };
    if (!dot && !p.noTrail) {
      l.trail.push({ x: p.x, y: p.y, at: now, seg: p.seg });
      if (l.trail.length > LASER_MAX_PTS) l.trail.shift();
    }
  }

  private remoteLaser(peerId: string, msg: any) {
    if (typeof msg.page !== "string") return;
    // Old peers send no segment (every point joined) and no hover flag (the dot always shows).
    const seg = typeof msg.s === "number" ? msg.s : -1;
    const hover = msg.hv === undefined ? true : !!msg.hv;
    const noTrail = !!msg.nt;
    const list: [number, number][] = Array.isArray(msg.pts) ? msg.pts : [[msg.x, msg.y]];
    for (const [x, y] of list) {
      if (Number.isFinite(x) && Number.isFinite(y)) this.addLaser(peerId, msg.page, { x, y, seg, hover, noTrail }, !!msg.dot);
    }
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

  /** Split view: pin a PDF or image next to the board for the teacher and the student. */
  async setSideFile(file: File | Blob, name = (file as File).name ?? "image.png") {
    const data = await file.arrayBuffer();
    const mime = file.type || (name.toLowerCase().endsWith(".pdf") ? "application/pdf" : "");
    const kind = mime === "application/pdf" ? "pdf" : mime.startsWith("image/") ? "image" : null;
    if (!kind) {
      this.onNotice("אפשר להציג בצד רק PDF או תמונה");
      return;
    }
    const id = await hashBytes(data);
    await saveAsset({ id, mime, name, data });
    this.haveAssets.add(id);
    this.local({ t: "b.side", side: { asset: id, kind, name, open: true, v: this.nextSideV() } });
  }

  /** Open or close the side panel for everyone. */
  setSideOpen(open: boolean) {
    const cur = this.state.side;
    if (!cur || cur.open === open) return;
    this.local({ t: "b.side", side: { ...cur, open, v: this.nextSideV() } });
  }

  private nextSideV() {
    return Math.max(Date.now(), (this.state.side?.v ?? 0) + 1);
  }

  private async checkAssets() {
    const needed = new Set<string>();
    for (const p of this.pages) if (p.bg) needed.add(p.bg.asset);
    // The iPad is a writing surface only: it never shows the side file, so it doesn't download it.
    if (this.state.side && this.role !== "ipad") needed.add(this.state.side.asset);
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
    return this.state.side?.asset === id || this.pages.some((p) => p.bg?.asset === id && !p.priv);
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
    const lesson = this.state.lesson;
    await this.net.sendTo(peerId, { t: "b.sync", state: { pages, strokes: {}, current, lock: this.state.lock, follow: this.state.follow, side: this.state.side ?? null, lesson } });
    let batch: Record<string, Stroke> = {};
    let size = 0;
    const flush = () => this.net.sendTo(peerId, { t: "b.sync", state: { pages: {}, strokes: batch, current: { page: "", ts: -1 }, lock: { on: false, ts: -1 }, lesson } });
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

  /** Decides what to do with a board snapshot / lesson switch from a peer. Returns false to drop it. */
  private acceptLesson(lesson: LessonInfo | undefined): boolean {
    const mine = this.state.lesson;
    // A device without a lesson id (an old version, or a teacher device still deciding) never
    // pushes its board into a lesson.
    if (!lesson) return !mine && this.role !== "teacher";
    if (lesson.id === mine?.id) return true;
    if (!mine && this.role === "teacher") {
      if (!this.adoptable || Date.now() - lesson.started > LESSON_GAP_MS) return false;
      // Join the lesson that is already running (our board is still empty).
      clearTimeout(this.adoptTimer);
      this.adoptable = false;
      this.state.lesson = lesson;
      this.persist();
      return true;
    }
    if (!mine && !this.legacyLoaded) {
      // We just hadn't heard the lesson id yet (e.g. ink written in the first seconds): keep it.
      this.state.lesson = lesson;
      this.persist();
      return true;
    }
    if (newerLesson(lesson, mine)) {
      this.legacyLoaded = false;
      this.followLesson(lesson);
      return true;
    }
    return false; // an older lesson: the peer will follow ours when it gets our snapshot
  }

  handleRemote(peerId: string, msg: any) {
    switch (msg.t) {
      case "b.lesson":
        if (this.acceptLesson(msg.lesson)) this.onChange("all");
        return;
      case "b.live": {
        let ls = this.live.get(msg.id);
        if (!ls) {
          if (this.state.strokes[msg.id]) return; // already committed
          ls = { id: msg.id, page: msg.page, author: peerId, tool: msg.tool, color: msg.color, size: msg.size, sp: msg.sp, dash: msg.dash, pts: [], at: 0 };
          this.live.set(msg.id, ls);
        }
        // A stroke can change tool while it's drawn (draw-and-hold snaps it to a shape).
        if (typeof msg.tool === "string") ls.tool = msg.tool;
        if (msg.rep) ls.pts = msg.pts;
        else if (typeof msg.o === "number") {
          // Points carry their index, so messages that arrive late or out of order land in the right place.
          for (let i = 0; i < msg.pts.length; i++) ls.pts[msg.o + i] = msg.pts[i];
        } else ls.pts.push(...msg.pts);
        ls.at = performance.now();
        this.onChange("live");
        return;
      }
      case "b.laser":
        this.remoteLaser(peerId, msg);
        return;
      case "b.temp":
        this.live.delete(msg.s.id);
        this.temps.set(msg.s.id, { s: msg.s, at: performance.now() });
        this.onChange("live");
        return;
      case "b.xf":
        this.remotePreview(msg);
        return;
      case "b.assetReq":
        if (this.haveAssets.has(msg.id)) void this.sendAsset(peerId, msg.id);
        else void loadAsset(msg.id).then((a) => { if (a) { this.haveAssets.add(a.id); void this.sendAsset(peerId, a.id); } });
        return;
      case "b.asset":
        void this.receiveChunk(msg);
        return;
      case "b.view":
        if (this.followOn && typeof msg.page === "string" && [msg.cx, msg.cy, msg.w, msg.h].every((n) => Number.isFinite(n)) && msg.w > 0 && msg.h > 0) {
          this.onRemoteView({ page: msg.page, cx: msg.cx, cy: msg.cy, w: msg.w, h: msg.h });
        }
        return;
    }
    if (typeof msg.t === "string" && msg.t.startsWith("b.")) {
      if (msg.t === "b.sync" && !this.acceptLesson(msg.state?.lesson)) return;
      // From another lesson (a device that missed the switch): never mix it into this one.
      if (LESSON_OPS.has(msg.t) && msg.L && this.state.lesson && msg.L !== this.state.lesson.id) return;
      const op = msg as BoardOp;
      if (op.t === "b.stroke") this.live.delete(op.s.id);
      if (op.t === "b.upd") {
        const now = performance.now();
        for (const it of op.items) {
          this.previews.delete(it.id);
          this.previewAt.delete(it.id);
          this.updAt.set(it.id, now);
        }
      }
      if (applyOp(this.state, op)) {
        if (op.t !== "b.go") this.lastAct = Date.now();
        this.persist();
        this.notify(op);
        if (op.t === "b.page" || op.t === "b.sync" || op.t === "b.side") void this.checkAssets();
        if (op.t === "b.stroke") this.ensureTrailingPage(op.s.page);
        else if (op.t === "b.sync") this.ensureTrailingPage();
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
      while (l.trail.length && now - l.trail[0].at > LASER_HOLD_MS + LASER_FADE_MS) { l.trail.shift(); changed = true; }
      if (!l.trail.length && now - l.head.at > LASER_DOT_MS) { this.lasers.delete(who); changed = true; }
    }
    if (this.temps.size) changed = true;
    for (const [id, t] of this.temps) if (now - t.at > TEMP_HOLD_MS + TEMP_FADE_MS) this.temps.delete(id);
    let expired = false;
    for (const [id, at] of this.previewAt) {
      if (now - at > 5000) { this.previews.delete(id); this.previewAt.delete(id); expired = true; }
    }
    if (expired) this.onChange("all"); // the base layer drew without those strokes
    for (const [id, at] of this.updAt) if (now - at > XF_STALE_MS) this.updAt.delete(id);
    return changed || expired;
  }
}
