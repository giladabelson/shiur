// Tests for: scrolling never loses the board, the student's pointer-only default, fast/ordered live
// ink from the iPad, split view (file pinned next to the board), one board per lesson + PDF at the
// end, and the background blur edges.
// Usage: node tests/lesson-features.mjs [baseUrl] [outDir]
// With a server that has lesson storage (npx wrangler dev -c tests/wrangler.r2.jsonc --port 8788)
// the cloud upload / list / download is checked as well.
import { chromium } from "playwright";
import fs from "node:fs";

const BASE = process.argv[2] || "http://127.0.0.1:8787";
const OUT = process.argv[3] || "./shots-lesson";
fs.mkdirSync(OUT, { recursive: true });
const PDF = new URL("./fixtures/worksheet.pdf", import.meta.url).pathname;
const ROOM = "less" + Math.random().toString(36).slice(2, 10);
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

async function join(role, name, vp, extra = {}) {
  const ctx = await browser.newContext({ permissions: ["camera", "microphone", "clipboard-read", "clipboard-write"], viewport: vp, ...extra });
  const page = await ctx.newPage();
  page.on("dialog", (d) => d.accept());
  page.on("pageerror", (e) => { console.log(`[${name}] PAGE ERROR ${e.message}`); problems.push(`${name}: ${e.message}`); });
  await page.goto(`${BASE}/r/${ROOM}${role === "student" ? "?n=x" : "?role=" + role + "&n=" + encodeURIComponent("דנה")}`);
  await page.fill(".prejoin input[type=text]", name);
  await sleep(300);
  await page.click(".prejoin .btn.big");
  await page.waitForSelector(".lesson");
  return page;
}

const cdps = new Map();
const cdpFor = async (page) => {
  if (!cdps.has(page)) cdps.set(page, await page.context().newCDPSession(page));
  return cdps.get(page);
};
async function box(page) { return page.locator(".board-canvas").boundingBox(); }
async function pen(page, pts, { up = true } = {}) {
  const cdp = await cdpFor(page);
  const b = await box(page);
  const ev = (type, [x, y], buttons) => cdp.send("Input.dispatchMouseEvent", {
    type, x: b.x + x, y: b.y + y, button: type === "mouseMoved" && !buttons ? "none" : "left", buttons, clickCount: 1, pointerType: "pen", force: 0.6,
  });
  await ev("mousePressed", pts[0], 1);
  for (let i = 1; i < pts.length; i++) { await ev("mouseMoved", pts[i], 1); await sleep(10); }
  if (up) await ev("mouseReleased", pts[pts.length - 1], 0);
}
async function touchDrag(page, from, to, steps = 12) {
  const cdp = await cdpFor(page);
  const b = await box(page);
  const at = (t) => [{ x: b.x + from[0] + (to[0] - from[0]) * t, y: b.y + from[1] + (to[1] - from[1]) * t, id: 1 }];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: at(0) });
  for (let i = 1; i <= steps; i++) { await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: at(i / steps) }); await sleep(10); }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}
async function mouseDraw(page, pts) {
  const b = await box(page);
  await page.mouse.move(b.x + pts[0][0], b.y + pts[0][1]);
  await page.mouse.down();
  for (const [x, y] of pts.slice(1)) await page.mouse.move(b.x + x, b.y + y, { steps: 4 });
  await page.mouse.up();
}
const strokes = (page) => page.evaluate(() => Object.values(window.__board.state.strokes).filter((s) => !s.del).length);
const connected = (page) => page.evaluate(() => [...window.__room.peers.values()].filter((p) => p.link.state === "connected").length);
/** How much of the current page is on screen, as a fraction of the screen's board area (0 = gone). */
const pageOnScreen = (page) => page.evaluate(() => {
  const v = window.__view, p = window.__board.currentPage;
  const x0 = Math.max(0, v.ox), y0 = Math.max(0, v.oy);
  const x1 = Math.min(v.cssW, v.ox + p.w * v.scale), y1 = Math.min(v.cssH, v.oy + p.h * v.scale);
  return Math.max(0, x1 - x0) * Math.max(0, y1 - y0) / (v.cssW * v.cssH);
});

try {
  const T = await join("teacher", "המורה", { width: 1366, height: 768 });
  const I = await join("ipad", "אייפד", { width: 1180, height: 820 }, { hasTouch: true });
  const S = await join("student", "דנה", { width: 1280, height: 720 });
  check("everyone connected", await until(async () => (await connected(T)) === 2 && (await connected(S)) === 2 && (await connected(I)) === 2, 25000));
  await sleep(800);

  // ---------------- 0. squared paper by default ----------------
  check("new board: squared paper by default", await S.evaluate(() => (window.__board.currentPage.tpl ?? "grid") === "grid"));
  {
    const px = await S.evaluate(() => {
      const c = [...document.querySelectorAll(".board-wrap canvas")].find((x) => x.width > 200);
      const ctx = c.getContext("2d"); const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let lines = 0, white = 0;
      for (let i = 0; i < d.length; i += 4 * 7) { if (d[i + 3] === 0) continue; const v = d[i] + d[i + 1] + d[i + 2]; if (v > 750) white++; else if (d[i + 2] > d[i] + 8) lines++; }
      return { lines, white };
    });
    check("new board: grid lines are drawn", px.lines > 50, JSON.stringify(px));
  }
  await T.click('.toolbar button[aria-label="עמודים ורקע"]');
  check("template menu marks squares as the current paper", await T.locator(".pop-item.on", { hasText: "משבצות" }).count() === 1);
  await T.click('.toolbar button[aria-label="עמודים ורקע"]'); // close the menu again
  await sleep(200);

  // ---------------- 1. scrolling never makes the board disappear ----------------
  for (const [name, page] of [["teacher", T], ["student", S]]) {
    const b = await box(page);
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    for (let i = 0; i < 60; i++) await page.mouse.wheel(0, 400); // a long scroll down
    await sleep(200);
    check(`${name}: long mouse-wheel scroll keeps the page on screen`, (await pageOnScreen(page)) > 0.3, `on screen ${(await pageOnScreen(page)).toFixed(2)}`);
    for (let i = 0; i < 60; i++) await page.mouse.wheel(0, -400);
    for (let i = 0; i < 30; i++) await page.mouse.wheel(600, 0);
    await sleep(200);
    check(`${name}: scrolling up / sideways keeps the page on screen`, (await pageOnScreen(page)) > 0.3);
  }
  // zoomed in, the wheel scrolls through the page but stops at its edge
  await T.evaluate(() => window.__view.zoomBy(3));
  const yBefore = await T.evaluate(() => window.__view.oy);
  const tb = await box(T);
  await T.mouse.move(tb.x + 300, tb.y + 300);
  for (let i = 0; i < 3; i++) await T.mouse.wheel(0, 100);
  await sleep(100);
  const yAfter = await T.evaluate(() => window.__view.oy);
  check("teacher: zoomed in, the wheel scrolls the page", yAfter < yBefore - 100, `${Math.round(yBefore)} -> ${Math.round(yAfter)}`);
  for (let i = 0; i < 80; i++) await T.mouse.wheel(0, 500);
  await sleep(100);
  const edge = await T.evaluate(() => { const v = window.__view, p = window.__board.currentPage; return v.oy + p.h * v.scale - v.cssH; });
  check("teacher: scrolling stops at the bottom of the page", edge >= -41 && edge <= 1, `bottom edge ${Math.round(edge)}px from screen bottom`);
  await T.screenshot({ path: `${OUT}/01-teacher-scrolled-to-bottom.png` });
  await T.evaluate(() => window.__view.fitPage());
  // iPad: once the Pencil was used, a finger moves the page; a long fling can't push it away
  await pen(I, [[200, 200], [260, 230]]);
  await sleep(700);
  for (let i = 0; i < 4; i++) await touchDrag(I, [600, 600], [600, -900]);
  check("iPad: finger scroll keeps the page on screen", (await pageOnScreen(I)) > 0.3, `on screen ${(await pageOnScreen(I)).toFixed(2)}`);
  for (let i = 0; i < 4; i++) await touchDrag(I, [300, 300], [1400, 1500]);
  check("iPad: finger scroll the other way too", (await pageOnScreen(I)) > 0.3);
  await I.screenshot({ path: `${OUT}/02-ipad-after-scroll.png` });
  // hidden board (shared screen on stage) and back: still there
  await T.evaluate(() => { document.querySelector(".board-wrap").hidden = true; });
  await sleep(150);
  await T.evaluate(() => { document.querySelector(".board-wrap").hidden = false; });
  await sleep(300);
  check("board comes back after being hidden", (await pageOnScreen(T)) > 0.3);
  check("clampAxis keeps a small page inside and a big page reachable", await T.evaluate(() => {
    const v = window.__view;
    // emulate: what the view does internally after a crazy offset
    v.ox = -99999; v.oy = 99999; v.zoomBy(1);
    const p = window.__board.currentPage;
    return v.ox >= -1 && v.oy + p.h * v.scale <= v.cssH + 1;
  }));
  await T.evaluate(() => window.__view.fitPage());
  await I.evaluate(() => window.__view.fitPage());
  // the iPad's first stroke above
  await until(async () => (await strokes(T)) === 1);

  // ---------------- 2. student: pointer only by default, only on a real movement ----------------
  check("student starts locked to the pointer", await S.evaluate(() => window.__board.state.lock.on && window.__view.tool === "laser"));
  check("student's pen tools are greyed out", await S.evaluate(() => document.querySelector('button[aria-label^="עט ("]').disabled));
  check("lock banner tells the student they can point", await S.locator(".lockbanner").isVisible());
  const sb = await box(S);
  await S.mouse.move(sb.x + 400, sb.y + 300);
  await sleep(500);
  await S.mouse.move(sb.x + 403, sb.y + 302); // a bump
  await sleep(100);
  await S.mouse.move(sb.x + 405, sb.y + 303);
  await sleep(600);
  check("a bumped / resting mouse shows no pointer to the teacher", await T.evaluate(() => window.__board.lasers.size === 0));
  await S.mouse.move(sb.x + 500, sb.y + 340, { steps: 8 }); // a deliberate movement
  check("moving the mouse shows the pointer to the teacher", await until(() => T.evaluate(() => window.__board.lasers.size === 1), 3000));
  await mouseDraw(S, [[300, 450], [500, 470], [650, 450]]);
  await sleep(600);
  check("pointer-only student leaves no ink", (await strokes(T)) === 1 && (await strokes(S)) === 1);
  check("student keyboard shortcut can't pick the pen", await S.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "p" }));
    return window.__view.tool === "laser";
  }));
  await T.click('button[aria-label^="התלמיד רק מצביע"]');
  check("teacher allows writing -> student gets the pen", await until(() => S.evaluate(() => !window.__board.state.lock.on && window.__view.tool === "pen")));
  await mouseDraw(S, [[300, 450], [500, 470], [650, 450]]);
  check("allowed student can write", await until(async () => (await strokes(T)) === 2));
  await T.click('button[aria-label^="התלמיד יכול לכתוב"]');
  check("teacher takes writing back", await until(() => S.evaluate(() => window.__board.state.lock.on && window.__view.tool === "laser")));
  await S.screenshot({ path: `${OUT}/03-student-pointer-only.png` });

  // ---------------- 3. live ink from the iPad: fast and in order ----------------
  const t0 = Date.now();
  await pen(I, [[300, 500], [340, 510], [380, 520], [420, 530], [460, 540]], { up: false });
  const seenLive = await until(() => T.evaluate(() => [...window.__board.live.values()].some((l) => l.pts.filter(Boolean).length >= 3)), 3000);
  check("teacher sees the iPad stroke while it is being written", seenLive, `${Date.now() - t0}ms`);
  const cdpI = await cdpFor(I);
  const ib = await box(I);
  await cdpI.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: ib.x + 460, y: ib.y + 540, button: "left", buttons: 0, clickCount: 1, pointerType: "pen" });
  check("committed iPad stroke reaches the teacher", await until(async () => (await strokes(T)) === 3));
  check("live points that arrive out of order land in the right place", await T.evaluate(() => {
    const b = window.__board;
    const base = { t: "b.live", id: "ooo1", page: b.currentPage.id, tool: "pen", color: "#000", size: 3, sp: false, rep: false };
    b.handleRemote("peerX", { ...base, o: 3, pts: [[3, 3, 0.5], [4, 4, 0.5]] });
    b.handleRemote("peerX", { ...base, o: 0, pts: [[0, 0, 0.5], [1, 1, 0.5], [2, 2, 0.5]] });
    const pts = b.live.get("ooo1").pts;
    b.live.delete("ooo1");
    return pts.length === 5 && pts.every((p, i) => p[0] === i);
  }));
  check("live channel retries lost packets briefly (no gaps)", await T.evaluate(() => {
    const p = [...window.__room.peers.values()][0];
    return p.link.live.maxPacketLifeTime > 0 && p.link.live.ordered === false;
  }));

  // ---------------- 4. split view: a file pinned next to the board ----------------
  await T.setInputFiles(".board-wrap > input[type=file]", PDF);
  check("teacher sees the side file", await until(() => T.evaluate(() => !document.querySelector(".sidefile").hidden && document.querySelectorAll(".sidefile-page").length === 2)));
  check("student sees the same side file", await until(() => S.evaluate(() => !document.querySelector(".sidefile").hidden && document.querySelectorAll(".sidefile-page").length === 2), 15000));
  check("side file pages are rendered on the student's screen", await until(() => S.evaluate(() => {
    const c = document.querySelector(".sidefile-page");
    if (!c || c.width < 100) return false;
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    for (let i = 0; i < d.length; i += 4 * 97) if (d[i] < 128) return true; // some dark text
    return false;
  }), 10000));
  check("iPad stays a writing screen: no side panel", await I.evaluate(() => !document.querySelector(".sidefile")));
  await sleep(1500);
  check("iPad doesn't download the side file", await I.evaluate(async () => {
    const id = window.__board.state.side?.asset;
    return !!id && !window.__board.haveAssets.has(id);
  }));
  check("board is unchanged next to the side file", (await strokes(S)) === 3 && (await S.evaluate(() => window.__board.pages.length)) === 1);
  check("student's board re-fits next to the side file (whole page visible)", await S.evaluate(() => {
    const v = window.__view, p = window.__board.currentPage;
    return v.ox >= 0 && v.oy >= 0 && v.ox + p.w * v.scale <= v.cssW + 1 && v.oy + p.h * v.scale <= v.cssH + 1;
  }));
  // zoom and scroll inside the file
  const viewBefore = await S.evaluate(() => ({ s: window.__view.zoomPct, ox: window.__view.ox, oy: window.__view.oy }));
  await S.click('.sidefile button[aria-label="הגדל"]');
  await S.click('.sidefile button[aria-label="הגדל"]');
  const sideScroll = S.locator(".sidefile-scroll");
  const sbox = await sideScroll.boundingBox();
  await S.mouse.move(sbox.x + sbox.width / 2, sbox.y + sbox.height / 2);
  for (let i = 0; i < 5; i++) await S.mouse.wheel(0, 300);
  await sleep(300);
  const afterSide = await S.evaluate(() => ({ z: window.__side.zoom, top: document.querySelector(".sidefile-scroll").scrollTop, s: window.__view.zoomPct }));
  check("zoom inside the side file", afterSide.z > 1.4, `zoom ${afterSide.z}`);
  check("scrolling inside the side file", afterSide.top > 200, `scrollTop ${afterSide.top}`);
  await S.keyboard.down("Control");
  await S.mouse.wheel(0, -200);
  await S.keyboard.up("Control");
  await sleep(200);
  check("Ctrl + wheel zooms the side file", (await S.evaluate(() => window.__side.zoom)) > afterSide.z);
  const viewAfter = await S.evaluate(() => ({ s: window.__view.zoomPct, ox: window.__view.ox, oy: window.__view.oy }));
  check("side file zoom/scroll doesn't touch the board", JSON.stringify(viewAfter) === JSON.stringify(viewBefore), `${JSON.stringify(viewBefore)} -> ${JSON.stringify(viewAfter)}`);
  check("side zoom is local (teacher's stays)", (await T.evaluate(() => window.__side.zoom)) === 1);
  await S.screenshot({ path: `${OUT}/04-student-split-view.png` });
  await T.screenshot({ path: `${OUT}/05-teacher-split-view.png` });
  // the teacher can still draw on the board next to it
  await mouseDraw(T, [[200, 300], [350, 330]]);
  check("teacher draws next to the side file", await until(async () => (await strokes(S)) === 4));
  // close / reopen for everyone
  await T.click('.sidefile button[aria-label^="סגור את הקובץ"]');
  check("teacher closes the side file -> closed for the student too", await until(() => S.evaluate(() => document.querySelector(".sidefile").hidden)));
  check("board gets the space back", await until(async () => (await S.evaluate(() => window.__view.cssW)) > 1000));
  await T.click(".side-reopen");
  check("teacher reopens -> student sees it again", await until(() => S.evaluate(() => !document.querySelector(".sidefile").hidden)));
  // student can hide it for themselves only
  await S.click('.sidefile button[aria-label="הסתר אצלי"]');
  check("student hides it locally", await S.evaluate(() => document.querySelector(".sidefile").hidden));
  check("...and it stays open for the teacher", await T.evaluate(() => !document.querySelector(".sidefile").hidden));
  await S.click(".side-reopen");
  check("student brings it back", await S.evaluate(() => !document.querySelector(".sidefile").hidden));
  // replace the file with an image
  const png = await T.evaluate(async () => {
    const c = document.createElement("canvas"); c.width = 400; c.height = 300;
    const x = c.getContext("2d"); x.fillStyle = "#16a34a"; x.fillRect(0, 0, 400, 300); x.fillStyle = "#fff"; x.font = "40px sans-serif"; x.fillText("F = ma", 90, 160);
    return c.toDataURL("image/png").split(",")[1];
  });
  await T.setInputFiles(".board-wrap > input[type=file]", { name: "formula.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") });
  check("replacing the side file reaches the student", await until(() => S.evaluate(() => {
    if (window.__side.zoom !== 1) return false; // a new file opens at "fit width"
    const img = document.querySelector(".sidefile-img");
    return !!img && img.complete && img.naturalWidth === 400 && document.querySelector(".sidefile-title").textContent === "formula.png";
  }), 15000));
  await S.screenshot({ path: `${OUT}/06-student-side-image.png` });
  // a late joiner gets it too
  const S2 = await join("student", "צופה", { width: 1100, height: 700 });
  check("a student who joins later sees the side file", await until(() => S2.evaluate(() => !!document.querySelector(".sidefile-img")?.naturalWidth), 20000));
  await S2.close();

  // ---------------- 5. one board per lesson, saved as PDF ----------------
  const lesson1 = await T.evaluate(() => window.__board.lesson.id);
  check("everyone is on the same lesson", (await S.evaluate(() => window.__board.lesson.id)) === lesson1 && (await I.evaluate(() => window.__board.lesson.id)) === lesson1);
  await T.reload();
  await T.fill(".prejoin input[type=text]", "המורה");
  await T.click(".prejoin .btn.big");
  await T.waitForSelector(".lesson");
  check("teacher reload mid-lesson keeps the same lesson and board", (await T.evaluate(() => window.__board.lesson.id)) === lesson1 && (await strokes(T)) === 4);
  check("teacher reconnects", await until(async () => (await connected(T)) === 2, 25000));
  await T.evaluate(() => window.__board.newLesson());
  check("new lesson: empty board for the teacher", (await strokes(T)) === 0);
  check("new lesson reaches the student and the iPad", await until(async () => (await strokes(S)) === 0 && (await strokes(I)) === 0
    && (await S.evaluate(() => window.__board.lesson.id)) !== lesson1 && (await I.evaluate(() => window.__board.lesson.id)) !== lesson1));
  check("new lesson starts pointer-only for the student", await S.evaluate(() => window.__board.state.lock.on && window.__view.tool === "laser"));
  check("new lesson has no side file", await S.evaluate(() => document.querySelector(".sidefile").hidden));
  check("old lesson's board is kept on the teacher's computer", await T.evaluate(async (id) => !!(await new Promise((res) => {
    const r = indexedDB.open("shiur");
    r.onsuccess = () => { const g = r.result.transaction("boards").objectStore("boards").get(location.pathname.split("/")[2] + "@" + id); g.onsuccess = () => res(g.result); };
  })), lesson1));
  check("old lesson saved as a PDF", await until(() => T.evaluate(async (id) => {
    const r = await new Promise((res) => { const o = indexedDB.open("shiur"); o.onsuccess = () => res(o.result); });
    const p = await new Promise((res) => { const g = r.transaction("pdfs").objectStore("pdfs").get(location.pathname.split("/")[2] + "@" + id); g.onsuccess = () => res(g.result); });
    if (!p) return false;
    const head = new TextDecoder().decode(await p.blob.slice(0, 5).arrayBuffer());
    return head === "%PDF-" && p.pages === 1;
  }, lesson1), 20000));
  // ink from the old lesson (a device that missed the switch) must not leak into the new one
  check("ops from an old lesson are ignored", await T.evaluate((old) => {
    const b = window.__board;
    b.handleRemote("peerX", { t: "b.stroke", L: old, s: { id: "stale1", page: b.currentPage.id, author: "x", tool: "pen", color: "#000", size: 3, sp: true, pts: [[1, 1, 0.5], [9, 9, 0.5]], del: false, dv: 0, ts: Date.now() } });
    return !b.state.strokes.stale1;
  }, lesson1));
  await pen(I, [[300, 300], [400, 320], [500, 300]]);
  check("new lesson board works (iPad ink reaches everyone)", await until(async () => (await strokes(T)) === 1 && (await strokes(S)) === 1));

  // a teacher coming back hours later starts a new lesson automatically
  const lesson2 = await T.evaluate(() => window.__board.lesson.id);
  await sleep(1500); // let the last stroke be written to the device first
  await T.evaluate(() => { window.__board.persist = () => {}; }); // keep our edit: don't let the open page overwrite it
  await T.evaluate(() => new Promise((res) => {
    const room = location.pathname.split("/")[2];
    const o = indexedDB.open("shiur");
    o.onsuccess = () => {
      const st = o.result.transaction("boards", "readwrite").objectStore("boards");
      const g = st.get(room);
      g.onsuccess = () => { const v = g.result; v.act = Date.now() - 4 * 3600_000; st.put(v, room).onsuccess = res; };
    };
  }));
  await T.reload();
  await T.fill(".prejoin input[type=text]", "המורה");
  await T.click(".prejoin .btn.big");
  await T.waitForSelector(".lesson");
  const lesson3 = await T.evaluate(() => window.__board.lesson.id);
  check("after a long break the teacher gets a fresh lesson", lesson3 !== lesson2 && (await strokes(T)) === 0);
  check("students follow the teacher's new lesson", await until(async () => (await S.evaluate(() => window.__board.lesson.id)) === lesson3 && (await strokes(S)) === 0, 25000));

  // teacher leaves: the lesson is saved as PDF
  await pen(I, [[200, 200], [300, 260]]);
  await until(async () => (await strokes(T)) === 1);
  await T.click("button.leave");
  check("leaving saves the lesson PDF", await until(() => T.locator(".saved-note").isVisible(), 30000));
  const cloud = await T.evaluate(async () => (await (await fetch(`/api/lessons/${location.pathname.split("/")[2]}`)).json()).enabled);
  const savedText = await T.locator(".saved-note").textContent();
  check(cloud ? "...and says it's in the cloud" : "...and says it's on this computer", cloud ? savedText.includes("בענן") : savedText.includes("במחשב הזה"));
  await T.screenshot({ path: `${OUT}/07-teacher-left.png` });

  // previous lessons on the home screen
  await T.evaluate((room) => localStorage.setItem("shiur.students", JSON.stringify([{ id: "s1", name: "דנה", room, created: Date.now() }])), ROOM);
  await T.goto(BASE);
  await T.click("text=שיעורים קודמים");
  check("previous lessons lists all 3 lessons", await until(async () => (await T.locator(".lesson-row").count()) === 3, 15000), `${await T.locator(".lesson-row").count()} rows`);
  await T.screenshot({ path: `${OUT}/08-previous-lessons.png` });
  await T.locator(".lesson-row >> nth=0").locator("text=הורד PDF").click();
  await sleep(500);
  check("downloading a lesson PDF", (await T.evaluate(() => window.__lastDownload || "")).includes("דנה"));
  await T.keyboard.press("Escape");
  // WhatsApp: save the student's number, then the button opens their chat with the lesson link
  await T.context().route("https://wa.me/**", (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<p>WhatsApp</p>" })); // no internet in tests
  await T.click("text=הוסף מספר וואטסאפ");
  await T.fill(".phone-dlg input", "abc");
  await T.click(".phone-dlg button[type=submit]");
  check("WhatsApp: a wrong number is refused", (await T.locator(".phone-dlg .err").textContent()).length > 0);
  await T.fill(".phone-dlg input", "050-123 4567");
  await T.click(".phone-dlg button[type=submit]");
  check("WhatsApp: number saved on the student's card", await until(() => T.locator(".phone-chip").textContent().then((t) => t.includes("050-123 4567"))));
  const [wa] = await Promise.all([T.context().waitForEvent("page"), T.click(".student .btn.wa")]);
  const waUrl = wa.url();
  await wa.close();
  const waText = decodeURIComponent(waUrl.split("text=")[1] || "");
  check("WhatsApp: opens the student's chat (972 number)", waUrl.startsWith("https://wa.me/972501234567?text="), waUrl.slice(0, 40));
  check("WhatsApp: message has the student's name and lesson link", waText.includes("דנה") && waText.includes(`/r/${ROOM}`));
  // new student: the phone is required, and adding opens their WhatsApp with the lesson link
  await T.fill("#new-student", "רון");
  await T.click(".add button[type=submit]");
  check("new student: refused without a phone", (await T.locator(".add-err").textContent()).length > 0 && (await T.locator(".student").count()) === 1);
  await T.fill(".add .phone-in", "12");
  await T.click(".add button[type=submit]");
  check("new student: refused with a wrong phone", (await T.locator(".student").count()) === 1);
  await T.fill(".add .phone-in", "054-7654321");
  const [wa3] = await Promise.all([T.context().waitForEvent("page"), T.click(".add button[type=submit]")]);
  const t3 = decodeURIComponent(wa3.url().split("text=")[1] || "");
  await wa3.close();
  check("new student: added with the phone on the card", (await T.locator(".student").count()) === 2 && (await T.locator(".phone-chip", { hasText: "054-7654321" }).count()) === 1);
  check("new student: WhatsApp opens their chat with the lesson link", wa3.url().startsWith("https://wa.me/972547654321?text=") && t3.includes("רון") && /\/r\/[\w-]+/.test(t3), wa3.url().slice(0, 40));
  await T.evaluate((room) => localStorage.setItem("shiur.students", JSON.stringify([{ id: "s1", name: "דנה", room, created: Date.now(), phone: "050-123 4567" }])), ROOM);
  await T.reload();

  if (cloud) {
    await T.click("text=שיעורים קודמים");
    await until(async () => (await T.locator(".lesson-row").count()) === 3, 15000);
    const [wa2] = await Promise.all([T.context().waitForEvent("page"), T.locator(".lesson-row >> nth=0").locator(".btn.wa").click()]);
    const t2 = decodeURIComponent(wa2.url().split("text=")[1] || "");
    await wa2.close();
    check("WhatsApp: lesson PDF link sent straight to the student's chat", wa2.url().startsWith("https://wa.me/972501234567") && t2.includes(`/api/lessons/${ROOM}/`));
    await T.keyboard.press("Escape");
  }
  if (cloud) {
    const list = await T.evaluate(async (room) => (await (await fetch(`/api/lessons/${room}`)).json()).items, ROOM);
    check("cloud: all 3 lesson PDFs uploaded", list.length === 3, `${list.length}`);
    const r = await T.evaluate(async (u) => { const x = await fetch(u); return { ok: x.ok, type: x.headers.get("content-type"), head: new TextDecoder().decode((await x.arrayBuffer()).slice(0, 5)), cd: x.headers.get("content-disposition") }; }, list[0].url);
    check("cloud: the PDF downloads from its link (to send to the student)", r.ok && r.type === "application/pdf" && r.head === "%PDF-" && r.cd.includes("UTF-8"));
    const bad = await T.evaluate(async (room) => (await fetch(`/api/lessons/${room}/zzzzzz`, { method: "PUT", body: "hello, this is not a pdf file" })).status, ROOM);
    check("cloud: rejects files that aren't PDFs", bad === 415);
    const badRoom = await T.evaluate(async () => (await fetch(`/api/lessons/a/zzzzzz`)).status);
    check("cloud: rejects bad room ids", badRoom === 400);
  }

  // the teacher opens the lesson on another computer (nothing saved there): it joins the running
  // lesson instead of wiping it
  const running = await I.evaluate(() => window.__board.lesson.id);
  const runningStrokes = await strokes(I);
  const T2 = await join("teacher", "המורה-מחשב2", { width: 1280, height: 720 });
  check("teacher on a new computer joins the running lesson", await until(async () => (await T2.evaluate(() => window.__board.state.lesson?.id)) === running && (await strokes(T2)) === runningStrokes, 20000));
  await sleep(5000);
  check("...and the iPad and student stay on it with their board", (await I.evaluate(() => window.__board.lesson.id)) === running && (await S.evaluate(() => window.__board.lesson.id)) === running && (await strokes(I)) === runningStrokes);
  await pen(I, [[500, 200], [600, 260]]);
  check("ink keeps flowing to the new computer", await until(async () => (await strokes(T2)) === runningStrokes + 1));

  // ---------------- 6. background blur edges ----------------
  const blur = await S.evaluate(() => {
    // mask math: soft, smooth edge; clean background and person
    const w = 64, h = 64, conf = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) conf[y * w + x] = x >= 32 ? 0.97 : 0.03;
    const rgba = new Uint8ClampedArray(w * h * 4);
    window.__refineMask(conf, null, w, h, rgba);
    const a = (x) => rgba[(32 * w + x) * 4 + 3];
    // the mask is enlarged ~5x to the video size: measure the edge there, as it is seen
    const mc = document.createElement("canvas"); mc.width = w; mc.height = h;
    mc.getContext("2d").putImageData(new ImageData(rgba, w, h), 0, 0);
    const up = document.createElement("canvas"); up.width = w * 5; up.height = h * 5;
    const ux = up.getContext("2d"); ux.imageSmoothingEnabled = true; ux.imageSmoothingQuality = "high";
    ux.drawImage(mc, 0, 0, w * 5, h * 5);
    const row = ux.getImageData(0, 160, w * 5, 1).data;
    let maxJump = 0;
    for (let x = 1; x < w * 5; x++) maxJump = Math.max(maxJump, Math.abs(row[x * 4 + 3] - row[(x - 1) * 4 + 3]));
    // flicker: a one-frame glitch is damped
    const flick = new Float32Array(w * h).fill(0.03);
    const prev = window.__refineMask(flick, null, w, h, new Uint8ClampedArray(w * h * 4));
    const glitch = new Float32Array(w * h).fill(0.6);
    const out2 = new Uint8ClampedArray(w * h * 4);
    window.__refineMask(glitch, prev, w, h, out2);

    // full composite: red person (circle) on a blue/white striped background
    const W = 640, H = 360;
    const src = document.createElement("canvas"); src.width = W; src.height = H;
    const sx = src.getContext("2d");
    for (let x = 0; x < W; x += 16) { sx.fillStyle = (x / 16) % 2 ? "#ffffff" : "#1d4ed8"; sx.fillRect(x, 0, 16, H); }
    sx.fillStyle = "#dc2626"; sx.beginPath(); sx.arc(320, 180, 100, 0, Math.PI * 2); sx.fill();
    const mask = document.createElement("canvas"); mask.width = 256; mask.height = 144;
    const mx = mask.getContext("2d"); mx.fillStyle = "#000"; mx.beginPath(); mx.arc(128, 72, 40, 0, Math.PI * 2); mx.fill();
    const bb = new window.__BackgroundBlur();
    bb.compose(src, mask, W, H);
    const out = bb.canvas.getContext("2d").getImageData(0, 0, W, H).data;
    const px = (x, y) => { const i = (y * W + x) * 4; return [out[i], out[i + 1], out[i + 2]]; };
    const inside = px(320, 180);
    // 30px outside the person's edge: how much of the person's red bled into the background
    const ring = [];
    for (let k = 0; k < 16; k++) {
      const t = (k / 16) * Math.PI * 2;
      ring.push(px(Math.round(320 + 130 * Math.cos(t)), Math.round(180 + 130 * Math.sin(t))));
    }
    const redness = ring.reduce((s, [r, g, b]) => s + (r - (g + b) / 2), 0) / ring.length;
    // background is blurred: stripes far from the person become smooth
    let varSum = 0;
    for (let x = 20; x < 120; x++) { const [r] = px(x, 40), [r2] = px(x + 1, 40); varSum += Math.abs(r - r2); }
    return { maxJump, bgA: a(0), personA: a(63), glitchA: out2[(32 * w + 32) * 4 + 3], inside, redness, stripeStep: varSum / 100 };
  });
  check("blur mask: background fully transparent, person fully opaque", blur.bgA === 0 && blur.personA === 255);
  check("blur mask: soft edge without a hard step (at video size)", blur.maxJump < 70, `largest step ${blur.maxJump}/255 per pixel`);
  check("blur mask: one-frame glitch is damped (no flicker)", blur.glitchA < 128, `alpha ${blur.glitchA}`);
  check("blur: person stays sharp and unchanged", blur.inside[0] > 200 && blur.inside[1] < 60 && blur.inside[2] < 60, JSON.stringify(blur.inside));
  check("blur: no red halo of the person around the edge", blur.redness < 25, `redness ${blur.redness.toFixed(1)}`);
  check("blur: background is really blurred", blur.stripeStep < 12, `avg step ${blur.stripeStep.toFixed(1)}`);
} catch (e) {
  console.log("CRASH", e);
  problems.push("crash: " + e.message);
} finally {
  await browser.close();
  console.log(problems.length ? `PROBLEMS (${problems.length}):\n - ${problems.join("\n - ")}` : "ALL GOOD");
  process.exit(problems.length ? 1 : 0);
}
