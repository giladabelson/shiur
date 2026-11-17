// Gesture / tool tests: lasso move really moves the ink on screen (teacher and student) and can
// be moved again, rectangle selection, laser trail pieces that are never joined across presses,
// two-finger double tap = undo on the iPad, and draw-and-hold circle that then grows with the pen.
// Usage: node tests/gestures.mjs [baseUrl] [outDir]
import { chromium } from "playwright";
import fs from "node:fs";

const BASE = process.argv[2] || "http://127.0.0.1:8787";
const OUT = process.argv[3] || "./shots-gestures";
fs.mkdirSync(OUT, { recursive: true });
const ROOM = "gest" + Math.random().toString(36).slice(2, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = [];
const check = (name, cond, extra = "") => { console.log(`${cond ? "OK  " : "BAD "} ${name}${extra ? "  " + extra : ""}`); if (!cond) problems.push(name); };
const until = async (fn, ms = 10000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await fn()) return true; } catch {} await sleep(150); }
  return false;
};

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || "/opt/pw-browsers/chromium",
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
});

async function join(role, name, vp, extra = {}) {
  const ctx = await browser.newContext({ permissions: ["camera", "microphone"], viewport: vp, ...extra });
  const page = await ctx.newPage();
  page.on("dialog", (d) => d.accept());
  page.on("pageerror", (e) => { console.log(`[${name}] PAGE ERROR ${e.message}`); problems.push(`${name}: ${e.message}`); });
  await page.goto(`${BASE}/r/${ROOM}${role === "student" ? "?n=x" : `?role=${role}&n=x`}`);
  await page.fill(".prejoin input[type=text]", name);
  await sleep(300);
  await page.click(".prejoin .btn.big");
  await page.waitForSelector(".lesson");
  await page.waitForFunction(() => !!window.__view && !!window.__board);
  return page;
}

const cdps = new Map();
const cdpFor = async (page) => {
  if (!cdps.has(page)) cdps.set(page, await page.context().newCDPSession(page));
  return cdps.get(page);
};
const box = (page) => page.locator(".board-canvas").first().boundingBox();
/** Apple Pencil: pressed moves along pts; `hold` ms of tiny moves at the end; `then`: more points before lifting. */
async function pen(page, pts, { hold = 0, then = [], beforeUp } = {}) {
  const cdp = await cdpFor(page);
  const b = await box(page);
  const ev = (type, [x, y], buttons) => cdp.send("Input.dispatchMouseEvent", {
    type, x: b.x + x, y: b.y + y, button: type === "mouseMoved" && !buttons ? "none" : "left", buttons, clickCount: 1, pointerType: "pen", force: 0.6,
  });
  await ev("mousePressed", pts[0], 1);
  for (const p of pts.slice(1)) { await ev("mouseMoved", p, 1); await sleep(8); }
  let last = pts[pts.length - 1];
  for (let t = 0; t < hold; t += 50) { await ev("mouseMoved", [last[0] + 0.5, last[1]], 1); await sleep(50); }
  for (const p of then) { await ev("mouseMoved", p, 1); await sleep(16); last = p; }
  if (beforeUp) await beforeUp();
  await ev("mouseReleased", last, 0);
}
async function penHover(page, pts) {
  const cdp = await cdpFor(page);
  const b = await box(page);
  for (const [x, y] of pts) {
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: b.x + x, y: b.y + y, button: "none", buttons: 0, pointerType: "pen" });
    await sleep(15);
  }
}
async function touch(page, type, points) {
  const cdp = await cdpFor(page);
  const b = await box(page);
  await cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map(([x, y], id) => ({ x: b.x + x, y: b.y + y, id })) });
}
async function twoFingerTap(page, a = [400, 400], c = [500, 400]) {
  await touch(page, "touchStart", [a, c]);
  await sleep(60);
  await touch(page, "touchEnd", []);
}
async function mouseDrag(page, pts, steps = 3) {
  const b = await box(page);
  await page.mouse.move(b.x + pts[0][0], b.y + pts[0][1]);
  await page.mouse.down();
  for (const [x, y] of pts.slice(1)) await page.mouse.move(b.x + x, b.y + y, { steps });
  await page.mouse.up();
}
const line = (x0, y0, x1, y1, n = 16) => Array.from({ length: n + 1 }, (_, i) => [x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n]);
const circle = (cx, cy, r, n = 48) => Array.from({ length: n + 1 }, (_, i) => [cx + r * Math.cos((i / n) * 2 * Math.PI), cy + r * Math.sin((i / n) * 2 * Math.PI)]);
const connected = (page) => page.evaluate(() => [...window.__room.peers.values()].filter((p) => p.link.state === "connected").length);
const visible = (page) => page.evaluate(() => Object.values(window.__board.state.strokes).filter((s) => !s.del));
const toScreen = (page, x, y, pageId) => page.evaluate(([x, y, p]) => window.__view.toScreen(x, y, p), [x, y, pageId]);

/**
 * Whether there's ink of a colour near a point (CSS px relative to the board), looking at both
 * canvas layers (the base layer with the ink and the top layer with what's moving).
 */
const colorNear = (page, [x, y], rgb, r = 3) => page.evaluate(({ x, y, rgb, r }) => {
  const cs = [...document.querySelector(".board-canvas").querySelectorAll("canvas.layer")];
  const dpr = cs[0].width / cs[0].getBoundingClientRect().width;
  for (const c of cs) {
    const d = c.getContext("2d").getImageData(Math.round((x - r) * dpr), Math.round((y - r) * dpr), Math.round(2 * r * dpr) + 1, Math.round(2 * r * dpr) + 1).data;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] > 150 && Math.abs(d[i] - rgb[0]) < 40 && Math.abs(d[i + 1] - rgb[1]) < 40 && Math.abs(d[i + 2] - rgb[2]) < 40) return true;
    }
  }
  return false;
}, { x, y, rgb, r });
const RED = [220, 38, 38];
const BLUE_SEL = [37, 99, 235];
const LASER = [239, 68, 68];

try {
  const T = await join("teacher", "המורה", { width: 1366, height: 768 });
  const I = await join("ipad", "אייפד", { width: 1180, height: 820 }, { hasTouch: true });
  const S = await join("student", "דנה", { width: 1280, height: 720 });
  check("everyone connected", await until(async () => (await connected(T)) === 2 && (await connected(S)) === 2 && (await connected(I)) === 2, 25000));
  await sleep(800);

  // ---------------- lasso move: the ink itself moves, on every screen, and can be moved again ----------------
  await T.evaluate(() => { const v = window.__view; v.tool = "pen"; v.color = "#dc2626"; v.size = 10; });
  await mouseDrag(T, line(300, 250, 500, 250, 10));
  await T.evaluate(() => { const v = window.__view; v.color = "#2563eb"; v.size = 3.5; });
  await mouseDrag(T, line(300, 480, 500, 480, 10)); // a second stroke that is never selected
  check("strokes reach the student", await until(async () => (await visible(S)).length === 2));
  const red = async (pg) => (await visible(pg)).find((s) => s.color === "#dc2626");
  const mid = (s) => [s.pts.reduce((a, p) => a + p[0], 0) / s.pts.length, s.pts.reduce((a, p) => a + p[1], 0) / s.pts.length];
  const s0 = await red(T);
  const [m0x, m0y] = mid(s0);
  await T.click('.toolbar .tb-row button[aria-label^="בחירה"]');
  check("free lasso is the default", await T.evaluate(() => window.__view.lassoMode === "free"));
  await mouseDrag(T, [[270, 210], [530, 210], [530, 300], [270, 300], [270, 212]], 6);
  check("lasso selects the red stroke only", await T.evaluate((id) => { const s = window.__view.selection; return s.length === 1 && s[0] === id; }, s0.id));
  const scr0 = await toScreen(T, m0x, m0y, s0.page);
  check("before: red ink at its place (teacher)", await colorNear(T, scr0, RED));
  // drag it: 160 px right, 120 px down
  const DX = 160, DY = 120;
  await mouseDrag(T, [[scr0[0], scr0[1]], [scr0[0] + DX / 2, scr0[1] + DY / 2], [scr0[0] + DX, scr0[1] + DY]], 6);
  check("the move is committed", await until(async () => { const s = await red(T); return Math.abs(mid(s)[0] - m0x) > 50; }));
  await sleep(300);
  const s1 = await red(T);
  const [m1x, m1y] = mid(s1);
  const scr1 = await toScreen(T, m1x, m1y, s1.page);
  check("teacher: ink drawn at the new place", await colorNear(T, scr1, RED), JSON.stringify(scr1));
  check("teacher: no ink left at the old place", !(await colorNear(T, scr0, RED, 4)));
  // the student: same
  check("student: the move arrives", await until(async () => { const s = await red(S); return s && Math.abs(mid(s)[0] - m1x) < 1 && Math.abs(mid(s)[1] - m1y) < 1; }));
  check("student: no preview left over", await until(() => S.evaluate(() => window.__board.previews.size === 0), 3000));
  await sleep(300);
  {
    const a = await toScreen(S, m0x, m0y, s1.page), b = await toScreen(S, m1x, m1y, s1.page);
    check("student: ink drawn at the new place", await colorNear(S, b, RED));
    check("student: no ink left at the old place", !(await colorNear(S, a, RED, 4)));
  }
  await T.screenshot({ path: `${OUT}/01-teacher-after-move.png` });
  // and again: grab it where it is now
  check("still selected after the move", await T.evaluate(() => window.__view.selection.length === 1));
  await mouseDrag(T, [[scr1[0], scr1[1]], [scr1[0] - 60, scr1[1] - 40], [scr1[0] - 120, scr1[1] - 80]], 6);
  check("second move is committed", await until(async () => { const s = await red(T); return Math.abs(mid(s)[0] - m1x) > 40; }));
  await sleep(300);
  {
    const s2 = await red(T);
    const [m2x, m2y] = mid(s2);
    const scr2 = await toScreen(T, m2x, m2y, s2.page);
    check("teacher: ink at the second new place", await colorNear(T, scr2, RED));
    check("teacher: nothing at the first new place", !(await colorNear(T, scr1, RED, 4)));
    check("student: second move arrives", await until(async () => { const s = await red(S); return Math.abs(mid(s)[0] - m2x) < 1; }));
    await sleep(400);
    check("student: ink at the second new place", await colorNear(S, await toScreen(S, m2x, m2y, s2.page), RED));
    check("student: nothing at the first new place", !(await colorNear(S, await toScreen(S, m1x, m1y, s2.page), RED, 4)));
    check("undo history: one undo puts it back at the first new place", await T.evaluate(([x]) => {
      window.__board.undo();
      const s = Object.values(window.__board.state.strokes).find((s) => s.color === "#dc2626");
      return Math.abs(s.pts.reduce((a, p) => a + p[0], 0) / s.pts.length - x) < 1;
    }, [m1x]));
    await sleep(300);
    check("teacher: after undo the ink is drawn at the first new place again", await colorNear(T, scr1, RED) && !(await colorNear(T, scr2, RED, 4)));
  }
  // a late (stale) preview packet must not displace the strokes again on the student
  await S.evaluate(([id, v]) => window.__board.handleRemote("x", { t: "b.xf", ids: [id], m: [1, 0, 0, 1, 200, 0], page: "", g: "old-drag", v }), [s0.id, 0]);
  check("student ignores a preview older than the committed move", await S.evaluate(() => window.__board.previews.size === 0));
  await S.evaluate(([id]) => {
    const b = window.__board;
    b.handleRemote("x", { t: "b.xf", ids: [id], m: null, g: "ended-drag" });
    b.handleRemote("x", { t: "b.xf", ids: [id], m: [1, 0, 0, 1, 200, 0], g: "ended-drag", v: 1e9 });
  }, [s0.id]);
  check("student ignores a preview that arrives after its drag ended", await S.evaluate(() => window.__board.previews.size === 0));
  await T.evaluate(() => window.__view.clearSelection());

  // ---------------- rectangle selection ----------------
  await T.click('.tb-opts .opanel:not([hidden]) button[aria-label^="סימון במלבן"]');
  check("rectangle mode on", await T.evaluate(() => window.__view.lassoMode === "rect"));
  {
    const s = await red(T);
    const [x0, y0] = await toScreen(T, Math.min(...s.pts.map((p) => p[0])) - 20, Math.min(...s.pts.map((p) => p[1])) - 25, s.page);
    const [x1, y1] = await toScreen(T, Math.max(...s.pts.map((p) => p[0])) + 20, Math.max(...s.pts.map((p) => p[1])) + 25, s.page);
    const b = await box(T);
    await T.mouse.move(b.x + x0, b.y + y0);
    await T.mouse.down();
    await T.mouse.move(b.x + (x0 + x1) / 2, b.y + (y0 + y1) / 2, { steps: 4 });
    await T.mouse.move(b.x + x1, b.y + y1, { steps: 4 });
    await sleep(100);
    check("the dashed rectangle is drawn while dragging", await colorNear(T, [(x0 + x1) / 2, y0], BLUE_SEL, 6) && await colorNear(T, [x1, (y0 + y1) / 2], BLUE_SEL, 6));
    await T.mouse.up();
    check("rectangle selects the stroke inside it only", await T.evaluate((id) => { const s = window.__view.selection; return s.length === 1 && s[0] === id; }, s.id));
    // a rectangle around nothing selects nothing
    await T.evaluate(() => window.__view.clearSelection());
    await mouseDrag(T, [[1000, 600], [1100, 680]], 4);
    check("an empty rectangle selects nothing", await T.evaluate(() => window.__view.selection.length === 0));
  }
  await T.click('.tb-opts .opanel:not([hidden]) button[aria-label^="סימון חופשי"]');
  await T.evaluate(() => { window.__view.tool = "pen"; });

  // ---------------- laser: pieces are not joined across presses ----------------
  await I.click('.toolbar .tb-row button[aria-label^="לייזר"]');
  check("trail mode is the default", await I.evaluate(() => window.__view.laserDot === false));
  await pen(I, line(150, 300, 260, 300, 12));
  await pen(I, line(420, 300, 530, 300, 12));
  await sleep(150);
  const me = await I.evaluate(() => window.__board.me);
  const lsr = await S.evaluate((me) => { const l = window.__board.lasers.get(me); return l && { page: l.page, trail: l.trail, head: l.head }; }, me);
  const segs = lsr ? [...new Set(lsr.trail.map((p) => p.seg))] : [];
  check("student gets two separate laser pieces", segs.length === 2, JSON.stringify(segs));
  check("each piece is continuous (no interleaving)", !!lsr && lsr.trail.every((p, i, a) => i === 0 || p.seg === a[i - 1].seg || a.slice(i).every((q) => q.seg !== a[i - 1].seg)));
  check("no laser dot while drawing a trail", !!lsr && !lsr.head.show);
  if (lsr && segs.length === 2) {
    const A = lsr.trail.filter((p) => p.seg === segs[0]), B = lsr.trail.filter((p) => p.seg === segs[1]);
    const gap = [(A[A.length - 1].x + B[0].x) / 2, (A[A.length - 1].y + B[0].y) / 2];
    const inA = A[Math.floor(A.length / 2)];
    check("student: trail drawn along the first piece", await colorNear(S, await toScreen(S, inA.x, inA.y, lsr.page), LASER));
    check("student: nothing drawn between the pieces", !(await colorNear(S, await toScreen(S, gap[0], gap[1], lsr.page), LASER, 4)));
    await S.screenshot({ path: `${OUT}/02-student-laser-pieces.png` });
  }
  check("the trail stays for a while (long enough to write a word)", await I.evaluate((me) => window.__board.lasers.get(me)?.trail.length > 10, me));
  // Pencil hover moves only the dot
  const before = await I.evaluate(() => window.__board.lasers.get(window.__board.me)?.trail.length ?? 0);
  await penHover(I, line(600, 400, 700, 420, 12));
  await sleep(100);
  const after = await I.evaluate(() => { const l = window.__board.lasers.get(window.__board.me); return l && { n: l.trail.length, head: l.head }; });
  check("Pencil hover adds no trail, but shows the dot", !!after && after.n <= before && after.head.show && after.head.x > 0);
  check("the trail fades away after a couple of seconds", await until(() => S.evaluate((me) => !(window.__board.lasers.get(me)?.trail.length), me), 5000));
  // a mouse hovering (student pointing) still draws a trail
  {
    const sb = await box(S);
    await S.mouse.move(sb.x + 300, sb.y + 300);
    for (let i = 0; i < 12; i++) { await S.mouse.move(sb.x + 300 + i * 15, sb.y + 300 + i * 3); await sleep(20); }
    const sl = await S.evaluate(() => { const l = window.__board.lasers.get(window.__board.me); return l && { n: l.trail.length, show: l.head.show, segs: new Set(l.trail.map((p) => p.seg)).size }; });
    check("mouse hover: a trail (one piece) and the dot", !!sl && sl.n > 3 && sl.show && sl.segs === 1, JSON.stringify(sl));
  }

  // ---------------- two-finger double tap = undo (iPad) ----------------
  await I.click('.toolbar .tb-row button[aria-label^="עט (P)"]');
  await pen(I, line(150, 600, 400, 620, 12));
  check("iPad stroke synced", await until(async () => (await visible(S)).length === 3));
  await sleep(800); // past the palm-rejection time after the Pencil
  const viewBefore = await I.evaluate(() => JSON.stringify(window.__view.viewMessage()));
  await twoFingerTap(I);
  await sleep(500);
  check("one two-finger tap does nothing", (await visible(I)).length === 3);
  await sleep(300);
  await twoFingerTap(I);
  await sleep(120);
  await twoFingerTap(I);
  check("two-finger double tap undoes the last stroke", await until(async () => (await visible(I)).length === 2 && (await visible(S)).length === 2, 4000));
  check("the view is unchanged by the taps", (await I.evaluate(() => JSON.stringify(window.__view.viewMessage()))) === viewBefore);
  await I.screenshot({ path: `${OUT}/03-ipad-after-undo.png` });
  // a pinch (fingers move apart) is a zoom, never an undo
  await sleep(600);
  const zoom0 = await I.evaluate(() => window.__view.zoomPct);
  for (let k = 0; k < 2; k++) {
    await touch(I, "touchStart", [[500, 400], [600, 400]]);
    for (let i = 1; i <= 6; i++) { await touch(I, "touchMove", [[500 - i * 12, 400], [600 + i * 12, 400]]); await sleep(16); }
    await touch(I, "touchEnd", []);
    await sleep(100);
  }
  check("pinch zooms and doesn't undo", (await I.evaluate(() => window.__view.zoomPct)) > zoom0 && (await visible(I)).length === 2);
  await I.evaluate(() => window.__view.fitPage());
  await sleep(300);
  // palm rejection: taps right after the Pencil are ignored
  await pen(I, line(150, 520, 400, 530, 10));
  await twoFingerTap(I);
  await sleep(100);
  await twoFingerTap(I);
  await sleep(500);
  check("taps right after the Pencil are ignored (palm)", (await visible(I)).length === 3, `${(await visible(I)).length} strokes; board ${JSON.stringify(await box(I))}`);
  // the student (pointer only) can't undo with a double tap — no touch there; the rule is canDraw

  // ---------------- draw-and-hold circle, then the pen resizes it ----------------
  const scaleI = await I.evaluate(() => window.__view.zoomPct / 100);
  const R = 60;
  let liveGrew = false;
  await pen(I, circle(600, 350, R), {
    hold: 800,
    then: line(600 + R + 0.5, 350, 600 + 2 * R, 350, 8).slice(1),
    beforeUp: async () => {
      liveGrew = await until(() => S.evaluate((min) => [...window.__board.live.values()].some((l) => l.tool === "ellipse" && l.pts.length === 2 && Math.abs(l.pts[1][0] - l.pts[0][0]) > min), (2 * R * 1.6) / scaleI), 2000);
    },
  });
  check("while resizing, the student sees the circle grow live", liveGrew);
  check("the circle is committed", await until(async () => (await visible(S)).some((s) => s.tool === "ellipse")));
  {
    const e = (await visible(S)).find((s) => s.tool === "ellipse");
    const w = Math.abs(e.pts[1][0] - e.pts[0][0]), h = Math.abs(e.pts[1][1] - e.pts[0][1]);
    const expected = (2 * 2 * R) / scaleI; // radius doubled: the pen went from R to 2R from the center
    check("snapped to a perfect circle", Math.abs(w - h) < 0.5, `${w} x ${h}`);
    check("its size followed the pen (radius doubled)", Math.abs(w - expected) / expected < 0.15, `w=${w.toFixed(1)} expected≈${expected.toFixed(1)}`);
    const cx = (e.pts[0][0] + e.pts[1][0]) / 2;
    const [ccx] = await I.evaluate(([x, y]) => { const v = window.__view; return [v.toScreen(x, y)[0]]; }, [cx, 0]);
    check("resized around its center", Math.abs(ccx - 600) < 6, `center x on screen ${ccx.toFixed(1)}`);
  }
  await S.screenshot({ path: `${OUT}/04-student-resized-circle.png` });
} catch (e) {
  console.log("CRASH", e);
  problems.push("crash: " + e.message);
} finally {
  await browser.close();
  console.log(problems.length ? `\nPROBLEMS (${problems.length}):\n - ${problems.join("\n - ")}` : "\nALL GOOD");
  process.exit(problems.length ? 1 : 0);
}
