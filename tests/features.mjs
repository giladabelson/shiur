// Feature test for the Notability-style tools: teacher (laptop) + iPad (pen) + student.
// Usage: node tests/features.mjs [baseUrl] [outDir]
import { chromium } from "playwright";
import fs from "node:fs";

const BASE = process.argv[2] || "http://127.0.0.1:8787";
const OUT = process.argv[3] || "./shots-features";
fs.mkdirSync(OUT, { recursive: true });
const ROOM = "feat" + Math.random().toString(36).slice(2, 9);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = [];
const check = (name, cond, extra = "") => { console.log(`${cond ? "OK  " : "BAD "} ${name}${extra ? "  " + extra : ""}`); if (!cond) problems.push(name); };
const until = async (fn, ms = 10000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await fn()) return true; } catch {} await sleep(200); }
  return false;
};

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || "/opt/pw-browsers/chromium",
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
});
async function join(role, name, vp) {
  const ctx = await browser.newContext({ permissions: ["camera", "microphone"], viewport: vp, hasTouch: role === "ipad" });
  const page = await ctx.newPage();
  page.on("dialog", (d) => d.accept());
  page.on("pageerror", (e) => { console.log(`[${name}] PAGE ERROR ${e.message}`); problems.push(`${name}: ${e.message}`); });
  await page.goto(`${BASE}/r/${ROOM}${role === "student" ? "" : "?role=" + role}`);
  await page.fill(".prejoin input[type=text]", name);
  await sleep(400);
  await page.click(".prejoin .btn.big");
  await page.waitForSelector(".lesson");
  return page;
}
const cdps = new Map();
async function pen(page, pts, { hold = 0 } = {}) {
  if (!cdps.has(page)) cdps.set(page, await page.context().newCDPSession(page));
  const cdp = cdps.get(page);
  const box = await page.locator(".board-canvas").boundingBox();
  const ev = (type, [x, y], buttons) => cdp.send("Input.dispatchMouseEvent", {
    type, x: box.x + x, y: box.y + y, button: type === "mouseMoved" && !buttons ? "none" : "left", buttons, clickCount: 1, pointerType: "pen", force: 0.6,
  });
  await ev("mousePressed", pts[0], 1);
  for (const p of pts.slice(1)) { await ev("mouseMoved", p, 1); await sleep(6); }
  if (hold) {
    const last = pts[pts.length - 1];
    for (let t = 0; t < hold; t += 50) { await ev("mouseMoved", [last[0] + 0.5, last[1]], 1); await sleep(50); }
  }
  await ev("mouseReleased", pts[pts.length - 1], 0);
}
const circle = (cx, cy, r, n = 48) => Array.from({ length: n + 1 }, (_, i) => [cx + r * Math.cos((i / n) * 2 * Math.PI), cy + r * Math.sin((i / n) * 2 * Math.PI)]);
const line = (x0, y0, x1, y1, n = 20) => Array.from({ length: n + 1 }, (_, i) => [x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n]);
const visible = (page) => page.evaluate(() => Object.values(window.__board.state.strokes).filter((s) => !s.del));
const tool = (page, label) => page.click(`.toolbar button[aria-label^="${label}"]`);
const menuItem = (page, text) => page.click(`.pop .pop-item:has-text("${text}")`);
const openToolMenu = async (page, label) => {
  const sel = `.toolbar button[aria-label^="${label}"]`;
  if (!(await page.locator(sel).first().evaluate((b) => b.classList.contains("on")))) await page.click(sel);
  await page.click(sel);
  await page.waitForSelector(".pop");
};

try {
  const T = await join("teacher", "המורה", { width: 1366, height: 768 });
  const I = await join("ipad", "אייפד", { width: 1180, height: 820 });
  const S = await join("student", "דנה", { width: 1280, height: 720 });
  check("all connected", await until(() => S.evaluate(() => [...window.__room.peers.values()].filter((p) => p.link.state === "connected").length === 2), 20000));
  await sleep(1000);
  await I.screenshot({ path: `${OUT}/00-ipad-toolbar.png` });

  // favourites
  await I.click('.toolbar button[aria-label="עט מועדף 2"]');
  await pen(I, line(100, 100, 300, 120));
  check("favourite pen (blue) used", await until(async () => (await visible(S)).some((s) => s.color === "#2563eb")));

  // dashed
  await openToolMenu(I, "עט (P)");
  await menuItem(I, "קו מקווקו");
  await pen(I, line(100, 160, 400, 160));
  check("dashed line synced", await until(async () => (await visible(S)).some((s) => s.dash)));
  await openToolMenu(I, "עט (P)");
  await menuItem(I, "קו מקווקו");

  // shape recognition: circle + hold
  await I.click('.toolbar button[aria-label="עט מועדף 1"]');
  await pen(I, circle(550, 250, 70), { hold: 800 });
  check("draw-and-hold circle -> ellipse", await until(async () => (await visible(S)).some((s) => s.tool === "ellipse")));
  await pen(I, [[100, 330], [180, 333], [260, 329], [340, 332], [420, 330]], { hold: 800 });
  const ln = (await visible(S)).find((s) => s.tool === "line" && Math.abs(s.pts[0][1] - s.pts[1][1]) < 0.5);
  check("draw-and-hold wobbly line -> straight horizontal line", !!ln);

  // shapes tool: arrow + triangle
  await openToolMenu(I, "צורות");
  await I.click('.pop button[aria-label="חץ"]');
  await pen(I, line(700, 400, 850, 330, 6));
  await openToolMenu(I, "צורות");
  await I.click('.pop button[aria-label="משולש"]');
  await pen(I, line(700, 450, 820, 560, 6));
  check("arrow + triangle synced", await until(async () => { const v = await visible(S); return v.some((s) => s.tool === "arrow") && v.some((s) => s.tool === "poly" && s.pts.length === 3); }));

  // disappearing ink
  await tool(I, "דיו נעלם");
  await pen(I, line(150, 450, 400, 480));
  check("disappearing ink shown to student", await until(() => S.evaluate(() => window.__board.temps.size === 1), 3000));
  const nBefore = (await visible(S)).length;
  await sleep(300);
  await S.screenshot({ path: `${OUT}/01-student-fade.png` });
  check("disappearing ink gone after a few seconds (and never stored)", await until(() => S.evaluate(() => window.__board.temps.size === 0), 7000) && (await visible(S)).length === nBefore);

  // laser dot
  await openToolMenu(I, "לייזר");
  await menuItem(I, "נקודה בלבד");
  await pen(I, line(300, 300, 360, 320, 5));
  check("laser dot mode seen by student", await until(() => S.evaluate(() => [...window.__board.lasers.values()].some((l) => l.dot)), 3000));

  // partial eraser
  await I.click('.toolbar button[aria-label="עט מועדף 3"]');
  await pen(I, line(100, 600, 600, 600, 60));
  await sleep(300);
  const redBefore = (await visible(S)).filter((s) => s.color === "#dc2626").length;
  await openToolMenu(I, "מחק");
  await menuItem(I, "מחק חלקי");
  await pen(I, line(350, 570, 350, 630, 6));
  check("partial eraser cuts the line into 2 pieces", await until(async () => (await visible(S)).filter((s) => s.color === "#dc2626").length === redBefore + 1), `${redBefore} -> ${(await visible(S)).filter((s) => s.color === "#dc2626").length}`);
  await I.click('.toolbar button[aria-label^="בטל"]');
  check("undo restores the whole line", await until(async () => (await visible(S)).filter((s) => s.color === "#dc2626").length === redBefore));
  await I.screenshot({ path: `${OUT}/02-ipad-drawings.png` });

  // axes + lasso (teacher on the laptop with the mouse)
  await openToolMenu(T, "צורות");
  await menuItem(T, "צירי x / y");
  check("axes inserted (2 arrows + 16 ticks) and selected", await until(async () => (await T.evaluate(() => document.querySelector(".sel-menu").hidden === false)) && (await visible(S)).filter((s) => s.tool === "arrow").length >= 3));
  await sleep(300);
  await T.screenshot({ path: `${OUT}/03-teacher-axes-selected.png` });
  // move the selection by dragging inside it
  const before = await T.evaluate(() => { const b = window.__board; const a = Object.values(b.state.strokes).filter((s) => !s.del && s.tool === "arrow"); return a[a.length - 1].pts[0][0]; });
  const box = await T.locator(".board-canvas").boundingBox();
  const selBox = await T.evaluate(() => { const v = window.__view; const ids = v.selection; const b = window.__board; const pts = ids.flatMap((id) => b.state.strokes[id].pts); return { x: pts.reduce((a, p) => a + p[0], 0) / pts.length, y: pts.reduce((a, p) => a + p[1], 0) / pts.length }; });
  const [sx, sy] = await T.evaluate(({ x, y }) => window.__view.toScreen(x, y), selBox);
  await T.mouse.move(box.x + sx + 3, box.y + sy + 3);
  await T.mouse.down();
  for (let i = 1; i <= 10; i++) await T.mouse.move(box.x + sx + 3 - i * 12, box.y + sy + 3 + i * 4);
  check("student sees live preview while dragging", await until(() => S.evaluate(() => window.__board.previews.size > 0), 3000));
  await T.mouse.up();
  const moved = await until(async () => {
    const x = await S.evaluate(() => { const a = Object.values(window.__board.state.strokes).filter((s) => !s.del && s.tool === "arrow"); return a[a.length - 1].pts[0][0]; });
    return Math.abs(x - before) > 50;
  });
  check("lasso move synced to student", moved);
  // recolour selection
  await T.click('.sel-menu .swatch >> nth=2');
  check("lasso recolour synced", await until(async () => (await visible(S)).filter((s) => s.tool === "arrow" && s.color === "#dc2626").length >= 2));
  // copy -> new page -> paste
  await T.click('.sel-menu button[aria-label^="העתק"]');
  await T.click('.toolbar button[aria-label="עמודים ורקע"]');
  await menuItem(T, "עמוד חדש");
  await T.click('.toolbar button[aria-label="עמודים ורקע"]');
  await menuItem(T, "הדבק כאן");
  check("paste on another page synced", await until(() => S.evaluate(() => { const b = window.__board; return b.strokes(b.currentPage.id).length === 18; })));
  // template
  await T.click('.toolbar button[aria-label="עמודים ורקע"]');
  await menuItem(T, "משבצות");
  check("grid background synced", await until(() => S.evaluate(() => window.__board.currentPage.tpl === "grid")));
  // duplicate page
  const pagesBefore = await S.evaluate(() => window.__board.pages.length);
  await T.click('.toolbar button[aria-label="עמודים ורקע"]');
  await menuItem(T, "שכפל עמוד");
  check("duplicate page synced with its content", await until(() => S.evaluate((n) => { const b = window.__board; return b.pages.length === n + 1 && b.strokes(b.currentPage.id).length === 18 && b.currentPage.tpl === "grid"; }, pagesBefore)));
  await S.screenshot({ path: `${OUT}/04-student-grid-axes.png` });

  // private page
  const studentPage = await S.evaluate(() => window.__board.currentPage.id);
  await T.click('.toolbar button[aria-label="עמודים ורקע"]');
  await menuItem(T, "דף פרטי");
  await I.click('.toolbar button[aria-label="עט מועדף 1"]');
  await pen(I, line(200, 200, 500, 260));
  check("iPad sees the private page and writes on it", await until(() => I.evaluate(() => window.__board.currentPage.priv === true && window.__board.strokes(window.__board.currentPage.id).length === 1)));
  await sleep(1500);
  check("student never receives the private page or its ink", await S.evaluate((sp) => {
    const b = window.__board;
    return Object.values(b.state.pages).every((p) => !p.priv) && b.currentPage.id === sp;
  }, studentPage));
  await I.screenshot({ path: `${OUT}/05-ipad-private.png` });
  // a late-joining student also doesn't get it
  const S2 = await join("student", "צופה", { width: 1000, height: 700 });
  await sleep(4000);
  check("snapshot to a new student skips private pages", await S2.evaluate(() => Object.values(window.__board.state.pages).every((p) => !p.priv) && Object.keys(window.__board.state.pages).length > 1));
  await T.click('.toolbar button[aria-label="עמוד קודם"]');
  check("leaving the private page: student follows again", await until(() => S.evaluate(() => !window.__board.currentPage.priv)));

  // image insert path (what "add Desmos graph to board" uses)
  const pagesNow = await S.evaluate(() => window.__board.pages.length);
  await T.evaluate(async () => {
    const c = document.createElement("canvas"); c.width = 800; c.height = 560;
    const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, 800, 560); g.strokeStyle = "#c00"; g.lineWidth = 4;
    g.beginPath(); for (let x = 0; x < 800; x++) g.lineTo(x, 280 - 200 * Math.sin(x / 60)); g.stroke();
    const blob = await new Promise((r) => c.toBlob(r, "image/png"));
    await window.__board.importFile(blob, "desmos.png");
  });
  check("graph image page reaches student with the image", await until(() => S.evaluate(async (n) => {
    const b = window.__board;
    return b.pages.length === n + 1 && b.currentPage.bg?.kind === "image" && document.querySelector(".board-canvas") && !(await new Promise((r) => r(false)));
  }, pagesNow), 15000));
  await sleep(1500);
  await S.screenshot({ path: `${OUT}/07-student-graph.png` });

  // PDF export on the iPad (teacher device) includes private page
  const [dl] = await Promise.all([T.waitForEvent("download", { timeout: 30000 }), T.click('.toolbar button[aria-label="ייצא את כל הלוח ל-PDF"]')]);
  await dl.saveAs(`${OUT}/board.pdf`);
  const txt = fs.readFileSync(`${OUT}/board.pdf`, "latin1");
  const n = (txt.match(/\/Type\s*\/Page[^s]/g) || []).length;
  check(`PDF export (${n} pages)`, txt.startsWith("%PDF") && n === (await T.evaluate(() => window.__board.pages.length)));
  await T.screenshot({ path: `${OUT}/06-teacher.png` });
} catch (e) {
  console.log("CRASH", e);
  problems.push("crash: " + e.message);
} finally {
  await browser.close();
  console.log(problems.length ? `\nPROBLEMS (${problems.length}):\n - ${problems.join("\n - ")}` : "\nALL GOOD");
  process.exit(problems.length ? 1 : 0);
}
