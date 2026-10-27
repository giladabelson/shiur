// Whiteboard state. Every device holds a full copy; ops are broadcast over the data channel and
// merged with simple rules (union of ids, higher version wins), so any peer can rejoin and catch up.

export type Tool = "pen" | "hl" | "line" | "rect" | "ellipse";
/** x, y in page units, pressure 0..1 */
export type Pt = [number, number, number];

export interface Stroke {
  id: string;
  page: string;
  author: string;
  tool: Tool;
  color: string;
  size: number;
  /** true when the input had no real pressure (mouse / finger) */
  sp: boolean;
  pts: Pt[];
  del: boolean;
  /** version of the visibility flag; higher wins */
  dv: number;
  ts: number;
}

export interface PageBg {
  asset: string;
  kind: "pdf" | "image";
  index: number;
}

export interface Page {
  id: string;
  order: number;
  w: number;
  h: number;
  bg?: PageBg;
  del: boolean;
  dv: number;
}

export interface BoardState {
  pages: Record<string, Page>;
  strokes: Record<string, Stroke>;
  current: { page: string; ts: number };
  lock: { on: boolean; ts: number };
}

export const PAGE_W = 1000;
export const BLANK_H = 625;

export const uid = () => crypto.randomUUID().replace(/-/g, "").slice(0, 16);

export function emptyState(): BoardState {
  const first: Page = { id: "p-first", order: 0, w: PAGE_W, h: BLANK_H, del: false, dv: 0 };
  return { pages: { [first.id]: first }, strokes: {}, current: { page: first.id, ts: 0 }, lock: { on: false, ts: 0 } };
}

export type BoardOp =
  | { t: "b.page"; page: Page }
  | { t: "b.stroke"; s: Stroke }
  | { t: "b.vis"; items: { id: string; del: boolean; dv: number }[] }
  | { t: "b.go"; page: string; ts: number }
  | { t: "b.lock"; on: boolean; ts: number }
  | { t: "b.sync"; state: BoardState };

/** Applies an op; returns true if anything changed. */
export function applyOp(st: BoardState, op: BoardOp): boolean {
  switch (op.t) {
    case "b.page": return mergePage(st, op.page);
    case "b.stroke": return mergeStroke(st, op.s);
    case "b.vis": {
      let changed = false;
      for (const it of op.items) {
        const s = st.strokes[it.id];
        if (s && newer(it.dv, it.del, s.dv, s.del)) {
          s.del = it.del;
          s.dv = it.dv;
          changed = true;
        }
      }
      return changed;
    }
    case "b.go":
      if (op.ts > st.current.ts && st.pages[op.page]) {
        st.current = { page: op.page, ts: op.ts };
        return true;
      }
      return false;
    case "b.lock":
      if (op.ts > st.lock.ts) {
        st.lock = { on: op.on, ts: op.ts };
        return true;
      }
      return false;
    case "b.sync": return mergeState(st, op.state);
  }
}

function newer(dv: number, del: boolean, curDv: number, curDel: boolean) {
  return dv > curDv || (dv === curDv && del && !curDel);
}

function mergePage(st: BoardState, p: Page): boolean {
  const cur = st.pages[p.id];
  if (!cur) {
    st.pages[p.id] = { ...p };
    return true;
  }
  if (newer(p.dv, p.del, cur.dv, cur.del)) {
    cur.del = p.del;
    cur.dv = p.dv;
    return true;
  }
  return false;
}

function mergeStroke(st: BoardState, s: Stroke): boolean {
  const cur = st.strokes[s.id];
  if (!cur) {
    st.strokes[s.id] = { ...s, pts: s.pts.slice() };
    return true;
  }
  if (newer(s.dv, s.del, cur.dv, cur.del)) {
    cur.del = s.del;
    cur.dv = s.dv;
    return true;
  }
  return false;
}

export function mergeState(st: BoardState, other: BoardState): boolean {
  let changed = false;
  for (const p of Object.values(other.pages ?? {})) changed = mergePage(st, p) || changed;
  for (const s of Object.values(other.strokes ?? {})) changed = mergeStroke(st, s) || changed;
  if (other.current && other.current.ts > st.current.ts && st.pages[other.current.page]) {
    st.current = { ...other.current };
    changed = true;
  }
  if (other.lock && other.lock.ts > st.lock.ts) {
    st.lock = { ...other.lock };
    changed = true;
  }
  return changed;
}

export function livePages(st: BoardState): Page[] {
  return Object.values(st.pages).filter((p) => !p.del).sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1));
}

export function pageStrokes(st: BoardState, pageId: string): Stroke[] {
  return Object.values(st.strokes).filter((s) => s.page === pageId && !s.del).sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1));
}

/** Rounds points so a 3-hour board doesn't bloat storage or sync messages. */
export function compactPts(pts: Pt[]): Pt[] {
  const out: Pt[] = [];
  let last: Pt | null = null;
  for (const p of pts) {
    const q: Pt = [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10, Math.round(p[2] * 100) / 100];
    if (last && Math.abs(q[0] - last[0]) < 0.15 && Math.abs(q[1] - last[1]) < 0.15) continue;
    out.push(q);
    last = q;
  }
  if (out.length === 0 && pts.length) out.push(pts[0]);
  return out;
}
