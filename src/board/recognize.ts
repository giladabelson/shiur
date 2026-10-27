// Draw-and-hold shape recognition: turns a freehand stroke into a clean line, ellipse/circle,
// triangle or rectangle. Returns null when the stroke doesn't look like any of them.

import type { Pt, Tool } from "./model";

export interface Recognized {
  tool: Tool;
  pts: Pt[];
}

type P = [number, number];

function pathLength(p: P[]) {
  let l = 0;
  for (let i = 1; i < p.length; i++) l += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
  return l;
}

function distToLine(p: P, a: P, b: P) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  return Math.abs(dy * p[0] - dx * p[1] + b[0] * a[1] - b[1] * a[0]) / len;
}

/** Ramer–Douglas–Peucker simplification. */
function rdp(p: P[], eps: number): P[] {
  if (p.length < 3) return p.slice();
  let maxD = 0, idx = 0;
  for (let i = 1; i < p.length - 1; i++) {
    const d = distToLine(p[i], p[0], p[p.length - 1]);
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD <= eps) return [p[0], p[p.length - 1]];
  const left = rdp(p.slice(0, idx + 1), eps);
  const right = rdp(p.slice(idx), eps);
  return left.slice(0, -1).concat(right);
}

function angleAt(a: P, b: P, c: P) {
  const v1 = [a[0] - b[0], a[1] - b[1]], v2 = [c[0] - b[0], c[1] - b[1]];
  const cos = (v1[0] * v2[0] + v1[1] * v2[1]) / ((Math.hypot(v1[0], v1[1]) * Math.hypot(v2[0], v2[1])) || 1);
  return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
}

/** Merge vertices that are closer than `minDist` (RDP leaves clusters at rounded corners). */
function mergeClose(v: P[], minDist: number): P[] {
  const out: P[] = [];
  for (const p of v) {
    const last = out[out.length - 1];
    if (last && Math.hypot(p[0] - last[0], p[1] - last[1]) < minDist) continue;
    out.push(p);
  }
  return out;
}

const pt = (p: P): Pt => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10, 0.5];

export function recognize(input: Pt[]): Recognized | null {
  const p: P[] = input.map((q) => [q[0], q[1]]);
  if (p.length < 4) return null;
  const L = pathLength(p);
  if (L < 20) return null;
  const first = p[0], last = p[p.length - 1];
  const gap = Math.hypot(last[0] - first[0], last[1] - first[1]);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of p) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
  const w = maxX - minX, h = maxY - minY;
  const diag = Math.hypot(w, h);

  // Straight line: every point close to the chord.
  if (gap > 0.8 * L) {
    const maxDev = Math.max(...p.map((q) => distToLine(q, first, last)));
    if (maxDev < Math.max(4, 0.06 * gap)) {
      // Snap to horizontal / vertical / 45° when close.
      let [x2, y2] = last;
      const ang = (Math.atan2(y2 - first[1], x2 - first[0]) * 180) / Math.PI;
      const snap = Math.round(ang / 45) * 45;
      if (Math.abs(ang - snap) < 6) {
        const r = Math.hypot(x2 - first[0], y2 - first[1]);
        x2 = first[0] + r * Math.cos((snap * Math.PI) / 180);
        y2 = first[1] + r * Math.sin((snap * Math.PI) / 180);
      }
      return { tool: "line", pts: [pt(first), pt([x2, y2])] };
    }
    return null;
  }

  // Closed shapes: the end comes back near the start.
  if (gap > Math.max(0.3 * diag, 30)) return null;
  // RDP needs distinct endpoints: split the loop at the point farthest from the start.
  let far = 0, farD = 0;
  p.forEach((q, i) => { const d = Math.hypot(q[0] - first[0], q[1] - first[1]); if (d > farD) { farD = d; far = i; } });
  const eps = Math.max(6, 0.045 * L);
  const loop = rdp(p.slice(0, far + 1), eps).concat(rdp(p.slice(far).concat([first]), eps).slice(1));
  const verts = mergeClose(loop, 0.12 * diag);
  // drop the duplicated closing vertex
  if (verts.length > 1 && Math.hypot(verts[0][0] - verts[verts.length - 1][0], verts[0][1] - verts[verts.length - 1][1]) < 0.15 * diag) verts.pop();

  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, rx = w / 2 || 1, ry = h / 2 || 1;
  const rs = p.map(([x, y]) => Math.hypot((x - cx) / rx, (y - cy) / ry));
  const mean = rs.reduce((a, b) => a + b, 0) / rs.length;
  const dev = Math.sqrt(rs.reduce((a, b) => a + (b - mean) ** 2, 0) / rs.length);
  const ellipse = (): Recognized => {
    let a = rx, b = ry;
    if (Math.abs(rx - ry) / Math.max(rx, ry) < 0.15) a = b = (rx + ry) / 2; // circle
    return { tool: "ellipse", pts: [pt([cx - a, cy - b]), pt([cx + a, cy + b])] };
  };
  // A rectangle's normalised radius varies ~0.12, a triangle's much more; an ellipse's very little.
  if (dev < 0.085) return ellipse();

  if (verts.length === 3) {
    const angs = [angleAt(verts[2], verts[0], verts[1]), angleAt(verts[0], verts[1], verts[2]), angleAt(verts[1], verts[2], verts[0])];
    if (angs.every((a) => a > 12)) return { tool: "poly", pts: verts.map(pt) };
  }
  if (verts.length === 4) {
    const angs = verts.map((_, i) => angleAt(verts[(i + 3) % 4], verts[i], verts[(i + 1) % 4]));
    if (angs.every((a) => Math.abs(a - 90) < 25)) {
      // Rectangle: axis-aligned if its edges are nearly horizontal/vertical, otherwise keep the rotation.
      const e = Math.atan2(verts[1][1] - verts[0][1], verts[1][0] - verts[0][0]) * 180 / Math.PI;
      const off = Math.abs(((e % 90) + 90) % 90);
      if (off < 10 || off > 80) return { tool: "rect", pts: [pt([minX, minY]), pt([maxX, maxY])] };
      return { tool: "poly", pts: verts.map(pt) };
    }
    return { tool: "poly", pts: verts.map(pt) };
  }

  if (dev < 0.14 && verts.length >= 5) return ellipse();
  return null;
}
