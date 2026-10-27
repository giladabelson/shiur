// "Real user" walkthrough: a teacher (Windows laptop), a student (laptop) and the teacher's iPad
// with an Apple Pencil (pen pointer events with pressure via CDP), palm touches and pinch zoom.
// Saves screenshots at each step. Usage: node tests/user-session.mjs [baseUrl] [outDir] [pdfPath]
import { chromium } from "playwright";
import fs from "node:fs";

const BASE = process.argv[2] || "http://127.0.0.1:8787";
const OUT = process.argv[3] || "./shots";
const PDF = process.argv[4];
fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const problems = [];
const check = (name, cond) => { log(cond ? "OK  " : "BAD ", name); if (!cond) problems.push(name); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await fn()) return true; } catch {} await sleep(250); }
  return false;
};

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || "/opt/pw-browsers/chromium",
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--auto-select-desktop-capture-source=Entire screen"],
});

async function device(name, opts) {
  const ctx = await browser.newContext({ permissions: ["camera", "microphone", "clipboard-read", "clipboard-write"], ...opts });
  const page = await ctx.newPage();
  page.on("dialog", (d) => d.accept());
  page.on("pageerror", (e) => { log(`[${name}] PAGE ERROR`, e.message); problems.push(`${name}: ${e.message}`); });
  page.on("console", (m) => { if (m.type() === "error") log(`[${name}] console.error`, m.text()); });
  return { ctx, page, shot: (n) => page.screenshot({ path: `${OUT}/${n}-${name}.png` }) };
}

// ---- Pencil via CDP (pointerType "pen" with pressure) ----
const sessions = new Map();
async function cdpFor(page) {
  if (!sessions.has(page)) sessions.set(page, await page.context().newCDPSession(page));
  return sessions.get(page);
}
async function penStroke(page, pts, { pressure = (i, n) => 0.3 + 0.6 * Math.sin((Math.PI * i) / n) } = {}) {
  const cdp = await cdpFor(page);
  const box = await page.locator(".board-canvas").boundingBox();
  const n = pts.length - 1;
  const ev = (type, [x, y], i, buttons) => cdp.send("Input.dispatchMouseEvent", {
    type, x: box.x + x, y: box.y + y, button: type === "mouseMoved" && !buttons ? "none" : "left", buttons, clickCount: 1,
    pointerType: "pen", force: pressure(i, n), tiltX: 20, tiltY: 10,
  });
  await ev("mousePressed", pts[0], 0, 1);
  for (let i = 1; i <= n; i++) { await ev("mouseMoved", pts[i], i, 1); await sleep(8); }
  await ev("mouseReleased", pts[n], n, 0);
}
async function penHover(page, pts) {
  const cdp = await cdpFor(page);
  const box = await page.locator(".board-canvas").boundingBox();
  for (const [x, y] of pts) {
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x + x, y: box.y + y, button: "none", buttons: 0, pointerType: "pen" });
    await sleep(15);
  }
}
async function touch(page, type, points) {
  const cdp = await cdpFor(page);
  const box = await page.locator(".board-canvas").boundingBox();
  await cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map(([x, y], id) => ({ x: box.x + x, y: box.y + y, id })) });
}
const curve = (x0, y0, w, h, n = 30) => Array.from({ length: n + 1 }, (_, i) => [x0 + (w * i) / n, y0 + h * Math.sin((Math.PI * 2 * i) / n)]);
const strokes = (page) => page.evaluate(() => Object.values(window.__board.state.strokes).filter((s) => !s.del).length);
const connected = (page) => page.evaluate(() => [...window.__room.peers.values()].filter((p) => p.link.state === "connected").length);

try {
  // 1. Teacher opens the home page on a Windows laptop and adds a student
  const T = await device("teacher", { viewport: { width: 1366, height: 768 } });
  await T.page.goto(BASE);
  await T.page.fill(".add input", "יואב");
  await T.page.click(".add .btn");
  await T.shot("01");
  await T.page.click("text=חבר אייפד");
  await T.page.waitForSelector("dialog canvas.qr");
  await sleep(300);
  await T.shot("02-qr");
  const ipadUrl = await T.page.locator("dialog .linkbox code").textContent();
  check("iPad link has role=ipad", ipadUrl?.includes("role=ipad"));
  await T.page.click("dialog >> text=סגור");
  await T.page.click("text=לינק לתלמיד");
  const studentUrl = await T.page.evaluate(() => navigator.clipboard.readText());
  check("student link copied", /\/r\/\w+$/.test(studentUrl));
  await T.page.click("text=התחל שיעור");
  await T.page.waitForSelector(".prejoin");
  await sleep(800);
  await T.shot("03-prejoin");
  await T.page.click(".prejoin .btn.big");
  await T.page.waitForSelector(".lesson");
  await sleep(500);
  await T.shot("04-waiting");
  check("waiting banner shown", await T.page.locator(".status-banner").isVisible());

  // 2. iPad joins through the QR link
  const I = await device("ipad", { viewport: { width: 1180, height: 820 }, hasTouch: true, userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Safari/605.1.15" });
  await I.page.goto(ipadUrl);
  await I.page.waitForSelector(".prejoin");
  await sleep(600);
  await I.shot("05-prejoin");
  await I.page.click(".prejoin .btn.big");
  await I.page.waitForSelector(".lesson");
  check("iPad <-> teacher connected", await until(async () => (await connected(I.page)) === 1));

  // 3. Student joins from the copied link
  const S = await device("student", { viewport: { width: 1280, height: 720 } });
  await S.page.goto(studentUrl);
  await S.page.fill(".prejoin input[type=text]", "יואב");
  await sleep(600);
  await S.page.click(".prejoin .btn.big");
  await S.page.waitForSelector(".lesson");
  check("everyone connected", await until(async () => (await connected(S.page)) === 2 && (await connected(T.page)) === 2));
  check("student hears teacher (audio track)", await until(() => S.page.evaluate(() => [...window.__room.peers.values()].some((p) => p.info.role === "teacher" && p.link.remoteTracks().mic))));
  check("iPad not shown as a video tile for student", await S.page.evaluate(() => document.querySelectorAll(".tile:not(.self):not([hidden])").length === 1));

  // 4. Teacher writes on the iPad with the Pencil
  await penStroke(I.page, curve(150, 200, 300, 40));
  await penStroke(I.page, [[500, 160], [520, 260]]);
  await penStroke(I.page, [[480, 210], [560, 210]]);
  check("pen strokes reach student", await until(async () => (await strokes(S.page)) === 3));
  const st = await S.page.evaluate(() => Object.values(window.__board.state.strokes)[0]);
  check("pen pressure recorded (not simulated)", st && st.sp === false && st.pts.some((p) => p[2] > 0.7) && st.pts.some((p) => p[2] < 0.5));

  // palm on the screen while writing must not draw
  await touch(I.page, "touchStart", [[700, 500]]);
  await penStroke(I.page, [[600, 300], [700, 320], [800, 300]]);
  await touch(I.page, "touchMove", [[720, 520]]);
  await touch(I.page, "touchEnd", []);
  await sleep(500);
  check("palm touch ignored while writing", (await strokes(I.page)) === 4);

  // pinch zoom with two fingers (after a pen was seen: fingers navigate, never draw)
  const before = await I.page.evaluate(() => document.querySelector(".zoomlbl").textContent);
  await sleep(700);
  await touch(I.page, "touchStart", [[500, 400], [600, 400]]);
  for (let i = 1; i <= 8; i++) { await touch(I.page, "touchMove", [[500 - i * 15, 400], [600 + i * 15, 400]]); await sleep(16); }
  await touch(I.page, "touchEnd", []);
  const after = await I.page.evaluate(() => document.querySelector(".zoomlbl").textContent);
  check(`pinch zoom works (${before} -> ${after})`, parseInt(after) > parseInt(before));
  check("finger did not draw", (await strokes(I.page)) === 4);
  await I.page.click('button[aria-label="התאם למסך"]');

  // pencil hover shows cursor; laser with the pen
  await penHover(I.page, [[300, 400], [320, 410]]);
  await I.page.click('button[aria-label="לייזר להצבעה (L)"]');
  await penStroke(I.page, curve(200, 450, 400, 30, 20));
  check("laser seen by student", await until(() => S.page.evaluate(() => window.__board.lasers.size > 0), 3000));
  await sleep(150);
  await S.shot("06-laser");
  check("laser leaves no stroke", (await strokes(S.page)) === 4);

  // shapes + colors from the iPad
  await I.page.click('button[aria-label="מלבן"]');
  await I.page.click(".swatch >> nth=2");
  await penStroke(I.page, [[150, 480], [250, 560], [350, 620]]);
  await I.page.click('button[aria-label="עט (P)"]');
  await I.page.click(".swatch >> nth=1");
  await penStroke(I.page, curve(700, 450, 200, 50));
  check("shape + colored stroke synced", await until(async () => (await strokes(S.page)) === 6));
  await sleep(300);
  await I.shot("07-ipad-writing");
  await S.shot("08-student-sees");
  await T.shot("09-teacher-sees");

  // eraser with the pen
  await I.page.click('button[aria-label="מחק (E)"]');
  await penStroke(I.page, [[690, 440], [900, 470]]);
  check("eraser removes stroke on all devices", await until(async () => (await strokes(S.page)) === 5));
  await I.page.click('button[aria-label="עט (P)"]');

  // 5. Teacher uploads a PDF worksheet from the laptop
  if (PDF) {
    await T.page.setInputFiles('.toolbar input[type=file]', PDF);
    check("PDF pages added", await until(() => T.page.evaluate(() => window.__board.pages.length === 3)));
    check("PDF file transferred to student", await until(() => S.page.evaluate(async () => {
      const bg = window.__board.currentPage.bg;
      return !!bg && !(window.__board.haveAssets ?? new Set()).size === false;
    }), 15000));
    await sleep(2500);
    await penStroke(I.page, curve(120, 260, 250, 25));
    await sleep(800);
    await S.shot("10-student-pdf");
    await I.shot("11-ipad-pdf");
    await S.page.click('button[aria-label="עמוד הבא"]');
    await sleep(800);
    check("page navigation syncs to iPad", await until(() => I.page.evaluate(() => window.__board.pages.findIndex((p) => p.id === window.__board.currentPage.id) === 2)));
  }

  // 6. Teacher shares the screen (e.g. an AirPlay receiver window)
  await T.page.click('button[aria-label="שיתוף מסך"]');
  check("student switches to shared screen", await until(() => S.page.evaluate(() => !document.querySelector(".screen-wrap").hidden)));
  await sleep(1500);
  await S.shot("12-student-screen");
  await S.page.click(".stage-tabs .tab >> nth=0");
  check("student can go back to the board during share", await S.page.evaluate(() => !document.querySelector(".board-wrap").hidden));
  await T.page.click('button[aria-label="שיתוף מסך"]');

  // 7. Student on a phone joins too, and chat
  const P = await device("phone", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await P.page.goto(studentUrl);
  await P.page.fill(".prejoin input[type=text]", "יואב-טלפון");
  await sleep(500);
  await P.page.click(".prejoin .btn.big");
  check("phone connected to all 3", await until(async () => (await connected(P.page)) === 3, 20000));
  await sleep(1500);
  await P.shot("13-phone");
  await S.page.click('button[aria-label="צ\'אט"]');
  await S.page.fill(".chat-form input", "לא הבנתי את שאלה 2");
  await S.page.click(".chat-form .btn");
  check("teacher gets chat", await until(() => T.page.evaluate(() => document.querySelector(".chat-log").textContent.includes("שאלה 2"))));
  await sleep(500);
  await T.shot("14-teacher-chat");

  // 8. Network blip on the student's side (offline 6s) -> must recover by itself
  await S.ctx.setOffline(true);
  await sleep(6000);
  await S.ctx.setOffline(false);
  check("student recovers after network blip", await until(async () => (await connected(S.page)) === 3, 30000));
  await penStroke(I.page, [[300, 650], [500, 660]]);
  check("board still syncing after blip", await until(() => S.page.evaluate((n) => Object.values(window.__board.state.strokes).filter((s) => !s.del).length >= n, 7), 8000));

  // 9. Settings dialog shows connection quality
  await T.page.click('button[aria-label="הגדרות ואיכות חיבור"]');
  await sleep(2500);
  await T.shot("15-settings");
  await T.page.keyboard.press("Escape");
} catch (e) {
  log("CRASH", e);
  problems.push("crash: " + e.message);
} finally {
  await browser.close();
  log(problems.length ? `PROBLEMS (${problems.length}):\n - ${problems.join("\n - ")}` : "ALL GOOD");
  process.exit(problems.length ? 1 : 0);
}
