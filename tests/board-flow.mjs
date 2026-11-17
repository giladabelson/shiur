// Tests for the continuous board: pages stacked in one long scrollable document with a blank page
// always waiting after the last written one, the student's view following the teacher's
// scroll / zoom (and the switch to turn that off), and a new board when a lesson is started
// from the home screen after a break (but not on a reload).
// Usage: node tests/board-flow.mjs [baseUrl] [outDir]
import { chromium } from "playwright";
import fs from "node:fs";

const BASE = process.argv[2] || "http://127.0.0.1:8787";
const OUT = process.argv[3] || "./shots-flow";
fs.mkdirSync(OUT, { recursive: true });
const ROOM = "flow" + Math.random().toString(36).slice(2, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = [];
const check = (name, cond, extra = "") => { console.log(`${cond ? "OK  " : "BAD "} ${name}${extra ? "  " + extra : ""}`); if (!cond) problems.push(name); };
const until = async (fn, ms = 12000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await fn()) return true; } catch {} await sleep(200); }
  return false;
};

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || "/opt/pw-browsers/chromium",
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
});

const query = (role, extra = "") => (role === "student" ? "?n=x" : `?role=${role}&n=${encodeURIComponent("דנה")}`) + extra;
async function enter(page, name) {
  await page.fill(".prejoin input[type=text]", name);
  await sleep(300);
  await page.click(".prejoin .btn.big");
  await page.waitForSelector(".lesson");
  await page.waitForFunction(() => !!window.__view && !!window.__board);
}
async function join(role, name, vp, extra = {}, urlExtra = "") {
  const ctx = await browser.newContext({ permissions: ["camera", "microphone"], viewport: vp, ...extra });
  const page = await ctx.newPage();
  page.on("dialog", (d) => d.accept());
  page.on("pageerror", (e) => { console.log(`[${name}] PAGE ERROR ${e.message}`); problems.push(`${name}: ${e.message}`); });
  await page.goto(`${BASE}/r/${ROOM}${query(role, urlExtra)}`);
  await enter(page, name);
  return page;
}

const cdps = new Map();
const cdpFor = async (page) => {
  if (!cdps.has(page)) cdps.set(page, await page.context().newCDPSession(page));
  return cdps.get(page);
};
async function box(page) { return page.locator(".board-canvas").boundingBox(); }
async function pen(page, pts) {
  const cdp = await cdpFor(page);
  const b = await box(page);
  const ev = (type, [x, y], buttons) => cdp.send("Input.dispatchMouseEvent", {
    type, x: b.x + x, y: b.y + y, button: "left", buttons, clickCount: 1, pointerType: "pen", force: 0.6,
  });
  await ev("mousePressed", pts[0], 1);
  for (let i = 1; i < pts.length; i++) { await ev("mouseMoved", pts[i], 1); await sleep(10); }
  await ev("mouseReleased", pts[pts.length - 1], 0);
}
async function mouseDraw(page, pts) {
  const b = await box(page);
  await page.mouse.move(b.x + pts[0][0], b.y + pts[0][1]);
  await page.mouse.down();
  for (const [x, y] of pts.slice(1)) await page.mouse.move(b.x + x, b.y + y, { steps: 4 });
  await page.mouse.up();
}
const line = (x0, y0, x1, y1, n = 16) => Array.from({ length: n + 1 }, (_, i) => [x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n]);
const connected = (page) => page.evaluate(() => [...window.__room.peers.values()].filter((p) => p.link.state === "connected").length);
const pageIds = (page) => page.evaluate(() => window.__board.pages.map((p) => p.id));
const allPageIds = (page) => page.evaluate(() => Object.keys(window.__board.state.pages).sort());
const inkCount = (page) => page.evaluate(() => Object.values(window.__board.state.strokes).filter((s) => !s.del).length);
const viewOf = (page) => page.evaluate(() => ({ ...window.__view.viewMessage(), zoom: window.__view.zoomPct }));
const lessonOf = (page) => page.evaluate(() => window.__board.lesson.id);

try {
  const T = await join("teacher", "המורה", { width: 1366, height: 768 });
  const I = await join("ipad", "אייפד", { width: 1180, height: 820 }, { hasTouch: true });
  const S = await join("student", "דנה", { width: 1280, height: 720 });
  check("everyone connected", await until(async () => (await connected(T)) === 2 && (await connected(S)) === 2 && (await connected(I)) === 2, 25000));
  await sleep(800);

  // ---------------- (a) writing on the last page adds a blank page after it ----------------
  check("fresh board: one page", (await pageIds(T)).length === 1 && (await pageIds(S)).length === 1);
  // the computer and the iPad write on page 1 at the same moment: both add "the next page"
  await Promise.all([pen(T, line(150, 150, 450, 200)), pen(I, line(150, 300, 450, 350))]);
  check("page 2 appears for the teacher and the iPad", await until(async () => (await pageIds(T)).length === 2 && (await pageIds(I)).length === 2));
  check("page 2 reaches the student", await until(async () => (await pageIds(S)).length === 2));
  await sleep(1500);
  const [tp, ip, sp] = [await allPageIds(T), await allPageIds(I), await allPageIds(S)];
  check("only one page 2 (both devices made the same page)", tp.length === 2 && JSON.stringify(tp) === JSON.stringify(ip) && JSON.stringify(tp) === JSON.stringify(sp), JSON.stringify({ tp, ip, sp }));
  check("both strokes on page 1", await T.evaluate(() => { const b = window.__board; return b.strokes(b.pages[0].id).length === 2 && b.strokes(b.pages[1].id).length === 0; }));
  check("the new page has the same paper and isn't in undo", await T.evaluate(() => {
    const b = window.__board, [p1, p2] = b.pages;
    return (p2.tpl ?? "grid") === (p1.tpl ?? "grid") && !p2.priv && p2.order === p1.order + 1;
  }));
  // undo only takes back the stroke, never the new page
  await T.evaluate(() => window.__board.undo());
  check("undo removes the stroke, keeps page 2", await until(async () => (await inkCount(S)) === 1 && (await pageIds(S)).length === 2));
  await T.evaluate(() => window.__board.redo());
  check("redo", await until(async () => (await inkCount(S)) === 2));
  check("the view shows page 1 first, page 2 below it", await T.evaluate(() => {
    const v = window.__view, b = window.__board, r1 = v.pageRect(b.pages[0].id), r2 = v.pageRect(b.pages[1].id);
    return r1.y >= 0 && r1.y < 40 && r2.y > r1.y + r1.h && Math.abs(r2.x - r1.x) < 1 && b.currentPage.id === b.pages[0].id;
  }));

  // ---------------- (b) scrolling down reaches page 2, writing there lands on page 2 ----------------
  const tb = await box(T);
  await T.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2);
  for (let i = 0; i < 40; i++) {
    if (await T.evaluate(() => { const v = window.__view, b = window.__board, r = v.pageRect(b.pages[1].id); return r.y < v.cssH * 0.25; })) break;
    await T.mouse.wheel(0, 120);
    await sleep(30);
  }
  await sleep(300);
  const p2 = (await pageIds(T))[1];
  check("wheel scroll makes page 2 the current page", await T.evaluate((id) => window.__board.currentPage.id === id, p2));
  check("toolbar-style page info follows the scroll (current page is 2 of 2)", await T.evaluate(() => {
    const b = window.__board; return b.pages.findIndex((p) => p.id === b.currentPage.id) === 1;
  }));
  const r2 = await T.evaluate((id) => window.__view.pageRect(id), p2);
  const cy = Math.max(r2.y + 120, 140);
  await mouseDraw(T, line(r2.x + 200, cy, r2.x + 520, cy + 40, 10));
  check("the stroke drawn there is on page 2", await until(() => S.evaluate((id) => {
    const b = window.__board;
    const s = b.strokes(id);
    return s.length === 1 && s[0].pts.every((p) => p[1] > 0 && p[1] < b.state.pages[id].h);
  }, p2)));
  check("writing on page 2 adds page 3", await until(async () => (await pageIds(T)).length === 3 && (await pageIds(I)).length === 3 && (await pageIds(S)).length === 3));
  await sleep(600);
  await T.screenshot({ path: `${OUT}/01-teacher-pages-stacked.png` });
  // the "go to page" buttons still work: back to page 1 scrolls up to it
  await T.evaluate(() => window.__board.goRelative(-1));
  check("going to the previous page scrolls to its top", await until(() => T.evaluate(() => {
    const v = window.__view, b = window.__board, r = v.pageRect(b.pages[0].id);
    return b.currentPage.id === b.pages[0].id && r.y >= -1 && r.y < 60;
  })));
  // eraser: works on whichever page is under it
  await T.evaluate(() => window.__view.fitPage());
  await sleep(400);

  // ---------------- (c) the student's view follows the teacher's zoom / scroll ----------------
  check("follow is on by default", await S.evaluate(() => window.__board.followOn === true) && await T.evaluate(() => window.__board.followOn === true));
  await sleep(500);
  const sBefore = await viewOf(S);
  await T.mouse.move(tb.x + tb.width / 2 + 100, tb.y + tb.height / 2);
  await T.keyboard.down("Control");
  for (let i = 0; i < 4; i++) { await T.mouse.wheel(0, -25); await sleep(40); }
  await T.keyboard.up("Control");
  await sleep(800);
  const tAfter = await viewOf(T), sAfter = await viewOf(S);
  check("teacher zoomed in", tAfter.zoom > sBefore.zoom, `${sBefore.zoom}% -> ${tAfter.zoom}%`);
  check("student's zoom follows the teacher", sAfter.zoom > sBefore.zoom * 1.3, `${sBefore.zoom}% -> ${sAfter.zoom}%`);
  const fits = sAfter.w >= tAfter.w - 2 && sAfter.h >= tAfter.h - 2 && (Math.abs(sAfter.w - tAfter.w) < tAfter.w * 0.03 || Math.abs(sAfter.h - tAfter.h) < tAfter.h * 0.03);
  check("student sees the teacher's region (same page, same center, fitted)", sAfter.page === tAfter.page && Math.abs(sAfter.cx - tAfter.cx) < 6 && Math.abs(sAfter.cy - tAfter.cy) < 6 && fits, JSON.stringify({ tAfter, sAfter }));
  check("the iPad follows the computer too", await until(async () => { const v = await viewOf(I); return v.page === tAfter.page && Math.abs(v.cx - tAfter.cx) < 6 && Math.abs(v.cy - tAfter.cy) < 6; }, 3000));
  await S.screenshot({ path: `${OUT}/02-student-follows-zoom.png` });
  // scrolling (no zoom) is followed too
  for (let i = 0; i < 5; i++) { await T.mouse.wheel(0, 150); await sleep(30); }
  await sleep(700);
  {
    const t = await viewOf(T), s = await viewOf(S);
    check("student follows the teacher's scrolling", t.page === s.page && Math.abs(t.cy - s.cy) < 6, `${JSON.stringify(t)} / ${JSON.stringify(s)}`);
  }
  // the student moving their own view doesn't move the teacher
  const tFixed = await viewOf(T);
  const sb = await box(S);
  await S.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2);
  for (let i = 0; i < 4; i++) { await S.mouse.wheel(0, 150); await sleep(30); }
  await sleep(700);
  check("the student's scrolling never moves the teacher", JSON.stringify(await viewOf(T)) === JSON.stringify(tFixed));

  // follow off: the teacher's zoom stays on the teacher's screen
  await T.evaluate(() => window.__board.setFollow(false));
  check("follow off reaches the student and the iPad", await until(async () => !(await S.evaluate(() => window.__board.followOn)) && !(await I.evaluate(() => window.__board.followOn))));
  const sOff = await viewOf(S), tOffBefore = await viewOf(T);
  await T.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2);
  await T.keyboard.down("Control");
  for (let i = 0; i < 4; i++) { await T.mouse.wheel(0, 80); await sleep(40); }
  await T.keyboard.up("Control");
  await sleep(800);
  const tOff = await viewOf(T);
  check("teacher zoomed out", tOff.zoom < tOffBefore.zoom, `${tOffBefore.zoom}% -> ${tOff.zoom}%`);
  check("with follow off the student's view stays", JSON.stringify(await viewOf(S)) === JSON.stringify(sOff));
  // and back on: the student catches up right away
  await T.evaluate(() => window.__board.setFollow(true));
  check("follow back on: the student jumps to the teacher's view", await until(async () => {
    const t = await viewOf(T), s = await viewOf(S);
    return s.page === t.page && Math.abs(s.cx - t.cx) < 6 && Math.abs(s.cy - t.cy) < 6;
  }, 5000));
  // a student who joins later gets the teacher's view right away
  await T.evaluate(() => window.__view.zoomBy(1.6));
  await sleep(500);
  const S2 = await join("student", "צופה", { width: 1000, height: 700 });
  check("a late student starts on the teacher's view", await until(async () => {
    const t = await viewOf(T), s = await viewOf(S2);
    // Same zoom (the teacher's region fits the student's screen on one axis) and the same spot.
    // A screen with other proportions may be clamped at the edge of the document, so the center
    // can shift a little vertically, but the teacher's center must stay well inside the student's view.
    const sameZoom = Math.abs(s.w - t.w) / t.w < 0.05 || Math.abs(s.h - t.h) / t.h < 0.05;
    return s.page === t.page && sameZoom && Math.abs(s.cx - t.cx) < 6 && Math.abs(s.cy - t.cy) < s.h * 0.15;
  }, 15000));
  await S2.context().close();
  await T.evaluate(() => window.__view.fitPage());

  // ---------------- (d) a new lesson from the home screen, but not on a reload ----------------
  const oldLesson = await lessonOf(T);
  const inkBefore = await inkCount(T);
  // started again from the home screen soon after: same lesson
  await T.goto(`${BASE}/r/${ROOM}${query("teacher", "&fresh=1")}`);
  await enter(T, "המורה");
  await sleep(1500);
  check("fresh start right after activity keeps the board", (await lessonOf(T)) === oldLesson && (await inkCount(T)) === inkBefore);
  check("the fresh flag is removed from the address", !(await T.evaluate(() => location.search.includes("fresh"))));
  // the board's last activity was 20 minutes ago (as if the teacher left)
  const tctx = T.context();
  await T.close();
  await sleep(500);
  const H = await tctx.newPage();
  H.on("pageerror", (e) => { console.log(`[home] PAGE ERROR ${e.message}`); problems.push(`home: ${e.message}`); });
  await H.goto(`${BASE}/`);
  const aged = await H.evaluate((room) => new Promise((res) => {
    const r = indexedDB.open("shiur", 2);
    r.onsuccess = () => {
      const tx = r.result.transaction("boards", "readwrite");
      const st = tx.objectStore("boards");
      const g = st.get(room);
      g.onsuccess = () => {
        const v = g.result;
        if (!v) return res(false);
        v.act = Date.now() - 20 * 60 * 1000;
        st.put(v, room);
        tx.oncomplete = () => res(true);
      };
    };
    r.onerror = () => res(false);
  }), ROOM);
  check("saved board made 20 minutes old", aged);
  // a plain reload (no fresh flag) still keeps it
  await H.goto(`${BASE}/r/${ROOM}${query("teacher")}`);
  H.on("dialog", (d) => d.accept());
  await enter(H, "המורה");
  await sleep(1500);
  check("reload without the flag keeps the board even after a break", (await lessonOf(H)) === oldLesson && (await inkCount(H)) === inkBefore);
  await H.close();
  await sleep(500);
  const H2 = await tctx.newPage();
  H2.on("dialog", (d) => d.accept());
  H2.on("pageerror", (e) => { console.log(`[teacher2] PAGE ERROR ${e.message}`); problems.push(`teacher2: ${e.message}`); });
  await H2.goto(`${BASE}/`);
  await H2.evaluate((room) => new Promise((res) => {
    const r = indexedDB.open("shiur", 2);
    r.onsuccess = () => {
      const tx = r.result.transaction("boards", "readwrite");
      const st = tx.objectStore("boards");
      const g = st.get(room);
      g.onsuccess = () => { const v = g.result; v.act = Date.now() - 20 * 60 * 1000; st.put(v, room); tx.oncomplete = () => res(true); };
    };
  }), ROOM);
  // "התחל שיעור" on the home screen opens the link with the fresh flag
  await H2.evaluate((room) => {
    localStorage.setItem("shiur.students", JSON.stringify([{ id: "s1", name: "דנה", room, created: Date.now(), phone: "0501234567" }]));
  }, ROOM);
  await H2.reload();
  const href = await H2.locator(".student-actions a.btn").first().getAttribute("href").catch(() => "");
  check("home screen's start link asks for a fresh lesson", (href || "").includes("fresh=1"), href || "(no link: students key differs?)");
  await H2.goto(`${BASE}/r/${ROOM}${query("teacher", "&fresh=1")}`);
  await enter(H2, "המורה");
  await sleep(1200);
  const newLesson = await lessonOf(H2);
  check("fresh start after 20 minutes: a new, empty lesson", newLesson !== oldLesson && (await inkCount(H2)) === 0 && (await pageIds(H2)).length === 1);
  check("the old board is kept on the computer", await H2.evaluate((key) => new Promise((res) => {
    const r = indexedDB.open("shiur", 2);
    r.onsuccess = () => { const g = r.result.transaction("boards").objectStore("boards").get(key); g.onsuccess = () => res(!!g.result && Object.values(g.result.strokes).some((s) => !s.del)); };
  }), `${ROOM}@${oldLesson}`));
  check("the iPad and the student follow the new lesson", await until(async () =>
    (await lessonOf(I)) === newLesson && (await lessonOf(S)) === newLesson && (await inkCount(I)) === 0 && (await inkCount(S)) === 0, 20000));
  check("flag removed: the address has no fresh=1", !(await H2.evaluate(() => location.search.includes("fresh"))));
  // write something, then reload mid-lesson: same lesson, same ink
  await pen(H2, line(200, 200, 400, 260));
  check("ink on the new board", await until(async () => (await inkCount(S)) === 1));
  await sleep(1200);
  await H2.reload();
  await enter(H2, "המורה");
  await sleep(1500);
  check("reload mid-lesson keeps the lesson and its board", (await lessonOf(H2)) === newLesson && (await inkCount(H2)) === 1);
  await I.screenshot({ path: `${OUT}/03-ipad-new-lesson.png` });
} catch (e) {
  console.log("CRASH", e);
  problems.push("crash: " + e.message);
} finally {
  await browser.close();
  console.log(problems.length ? `\nPROBLEMS (${problems.length}):\n - ${problems.join("\n - ")}` : "\nALL GOOD");
  process.exit(problems.length ? 1 : 0);
}
