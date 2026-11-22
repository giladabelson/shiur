// The student's own iPad: the student connects it from their screen ("חבר אייפד", a QR code with a
// one-time key, so it skips the waiting room), it writes only once the teacher allows writing, and
// then the teacher's computer follows what the iPad shows (scrolling and zoom), like the student
// follows the teacher. Locking again hands the lead back to the teacher.
// Usage: node tests/student-ipad.mjs [baseUrl] [outDir]
import { chromium } from "playwright";
import fs from "node:fs";
import { admitInto } from "./lib/admit.mjs";

const BASE = process.argv[2] || "http://127.0.0.1:8787";
const OUT = process.argv[3] || "./shots-student-ipad";
fs.mkdirSync(OUT, { recursive: true });
const ROOM = "sipd" + Math.random().toString(36).slice(2, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = [];
const check = (name, cond, extra = "") => { console.log(`${cond ? "OK  " : "BAD "} ${name}${extra ? "  " + extra : ""}`); if (!cond) problems.push(name); };
const until = async (fn, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await fn()) return true; } catch {} await sleep(200); }
  return false;
};

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || "/opt/pw-browsers/chromium",
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
});

async function newPage(name, vp, extra = {}) {
  const ctx = await browser.newContext({ permissions: ["camera", "microphone", "clipboard-read", "clipboard-write"], viewport: vp, ...extra });
  const page = await ctx.newPage();
  page.on("dialog", (d) => d.accept());
  page.on("pageerror", (e) => { console.log(`[${name}] PAGE ERROR ${e.message}`); problems.push(`${name}: ${e.message}`); });
  return page;
}
async function joinAt(page, url, name) {
  await page.goto(url);
  if (name) await page.fill(".prejoin input[type=text]", name);
  await sleep(300);
  await page.click(".prejoin .btn.big");
  await page.waitForSelector(".lesson");
}

const cdps = new Map();
const cdpFor = async (page) => {
  if (!cdps.has(page)) cdps.set(page, await page.context().newCDPSession(page));
  return cdps.get(page);
};
/** An Apple Pencil stroke (pointerType pen) across the board. */
async function pen(page, pts) {
  const cdp = await cdpFor(page);
  const b = await page.locator(".board-canvas").boundingBox();
  const ev = (type, [x, y], buttons) => cdp.send("Input.dispatchMouseEvent", {
    type, x: b.x + x, y: b.y + y, button: "left", buttons, clickCount: 1, pointerType: "pen", force: 0.6,
  });
  await ev("mousePressed", pts[0], 1);
  for (let i = 1; i < pts.length; i++) { await ev("mouseMoved", pts[i], 1); await sleep(10); }
  await ev("mouseReleased", pts[pts.length - 1], 0);
}
const line = (x1, y1, x2, y2, n = 14) => Array.from({ length: n + 1 }, (_, i) => [x1 + ((x2 - x1) * i) / n, y1 + ((y2 - y1) * i) / n]);
const strokes = (page) => page.evaluate(() => Object.values(window.__board.state.strokes).filter((s) => !s.del).length);
const connected = (page) => page.evaluate(() => [...window.__room.peers.values()].filter((p) => p.link.state === "connected").length);
const viewOf = (page) => page.evaluate(() => window.__view.viewMessage());
const watchOn = (page) => page.evaluate(() => window.__board.watchOn);
/** Same spot of the board in the middle of both screens (within a few board units). */
const sameCenter = (a, b, tol = 12) => !!a && !!b && a.page === b.page && Math.abs(a.cx - b.cx) < tol && Math.abs(a.cy - b.cy) < tol;

try {
  // ---------------- 1. teacher and student in the lesson ----------------
  const T = await newPage("teacher", { width: 1366, height: 768 });
  await joinAt(T, `${BASE}/r/${ROOM}?role=teacher&n=${encodeURIComponent("נועה")}`, "המורה");
  const S = await newPage("student", { width: 1280, height: 720 });
  await joinAt(S, `${BASE}/r/${ROOM}`, "נועה");
  await admitInto(T, S, "נועה");
  check("teacher and student connected", await until(async () => (await connected(T)) === 1 && (await connected(S)) === 1, 20000));
  check("teacher: no 'follow the student's iPad' button while there is no student iPad", await T.locator(".watchbtn").isHidden());
  check("teacher's iPad link has no 'connect your iPad' button for the teacher", (await T.locator(".student-ipad-btn").count()) === 0);

  // ---------------- 2. the student opens "connect my iPad" ----------------
  const ipadBtn = S.locator(".student-ipad-btn");
  check("student: 'חבר אייפד' button in the top bar", await ipadBtn.isVisible());
  await ipadBtn.click();
  check("student: dialog with a QR code", await until(() => S.locator(".student-ipad-dlg canvas.qr-sipad").isVisible()));
  const url = (await S.locator(".student-ipad-dlg .linkbox code").textContent()).trim();
  check("the link is for the student's iPad, with a key and the name", /[?&]role=sipad/.test(url) && /[?&]pair=[a-f0-9]{32}/.test(url) && url.includes("nm="), url);
  await sleep(400);
  await S.screenshot({ path: `${OUT}/01-student-connect-ipad.png` });
  await S.locator(".student-ipad-dlg button", { hasText: "סגור" }).click();

  // ---------------- 3. the iPad joins straight in (no waiting room) ----------------
  const I = await newPage("student-ipad", { width: 1180, height: 820 }, { hasTouch: true });
  await I.goto(url);
  check("student's iPad: name filled from the QR code", (await I.inputValue(".prejoin input[type=text]")) === "האייפד של נועה");
  check("student's iPad: mic and camera off by default", await I.evaluate(() => [...document.querySelectorAll(".prejoin .btn.ghost.off")].length >= 2));
  await joinAt(I, url, null);
  check("student's iPad goes straight into the lesson", await until(() => I.evaluate(() => window.__room.lobby.kind === "admitted"), 15000));
  check("teacher had nobody to let in", (await T.locator(".lobby-item").count()) === 0);
  check("everyone connected (3 devices)", await until(async () => (await connected(T)) === 2 && (await connected(S)) === 2 && (await connected(I)) === 2, 25000));
  check("student's iPad sends no microphone", await I.evaluate(() => !window.__room.localState().mic));
  check("teacher: 'follow the student's iPad' button appears", await until(() => T.locator(".watchbtn").isVisible()));
  check("student: the button now says the iPad is connected", await until(async () => (await ipadBtn.textContent()).includes("האייפד מחובר")));
  check("student's iPad: no side file panel and no tiles", await I.evaluate(() => !window.__side && document.querySelector(".tiles").hidden));

  // ---------------- 4. locked: the iPad can only point ----------------
  const before = await strokes(T);
  await pen(I, line(200, 200, 500, 260));
  await sleep(800);
  check("locked: the student's iPad doesn't write", (await strokes(T)) === before && (await strokes(I)) === before);
  check("locked: banner on the student's iPad", await I.locator(".lockbanner").isVisible());

  // ---------------- 5. the teacher lets the student write: now follows the iPad ----------------
  await T.locator(".toolbar .tgroup:last-child button").last().click();
  check("unlocking with a student iPad turns on following it (on every device)",
    await until(async () => (await watchOn(T)) && (await watchOn(S)) && (await watchOn(I))));
  check("teacher: the follow-the-iPad button is on", await T.locator(".watchbtn.on").isVisible());
  await pen(I, line(200, 200, 500, 260));
  check("the student's iPad writes, and the teacher gets it", await until(async () => (await strokes(T)) === before + 1));

  // The student zooms in and moves on the iPad: the teacher's computer shows the same spot.
  await I.evaluate(() => { window.__view.zoomBy(2.2, 300, 250); });
  await sleep(150);
  await I.evaluate(() => { window.__view.zoomBy(1.0, 300, 250); });
  await I.mouse.move(600, 400);
  for (let i = 0; i < 4; i++) await I.mouse.wheel(0, 120);
  check("teacher's computer shows what the student's iPad shows", await until(async () => sameCenter(await viewOf(I), await viewOf(T))),
    JSON.stringify({ ipad: await viewOf(I), teacher: await viewOf(T) }));
  check("the student's computer follows its iPad too", await until(async () => sameCenter(await viewOf(I), await viewOf(S))));
  const zi = await I.evaluate(() => window.__view.zoomPct), zt = await T.evaluate(() => window.__view.zoomPct);
  check("teacher zoomed in with it", zt > 120, `iPad ${zi}% teacher ${zt}%`);
  await sleep(500);
  await T.screenshot({ path: `${OUT}/02-teacher-follows-student-ipad.png` });
  await I.screenshot({ path: `${OUT}/03-student-ipad.png` });

  // The teacher scrolling here does not move the student's iPad.
  const iBefore = await viewOf(I);
  await T.mouse.move(600, 400);
  for (let i = 0; i < 4; i++) await T.mouse.wheel(0, 200);
  await sleep(700);
  check("while following, the teacher's scrolling doesn't move the student's iPad", sameCenter(iBefore, await viewOf(I), 2));

  // ---------------- 6. private pages never reach the student's iPad ----------------
  await T.evaluate(() => window.__board.addPage(true));
  await sleep(1200);
  const privOnIpad = await I.evaluate(() => window.__board.pages.some((p) => p.priv));
  check("a teacher-only page is not sent to the student's iPad", !privOnIpad);
  await T.evaluate(() => window.__board.goRelative(-1));
  await sleep(500);

  // ---------------- 7. locking again: the teacher leads again ----------------
  await T.locator(".toolbar .tgroup:last-child button").last().click();
  check("locking again stops following the iPad", await until(async () => !(await watchOn(T)) && !(await watchOn(I))));
  check("teacher: the 'student follows my zoom' button is back", await T.locator(".followbtn:not(.watchbtn)").isVisible());
  await T.evaluate(() => { window.__view.zoomBy(0.6); });
  await T.mouse.move(600, 400);
  for (let i = 0; i < 3; i++) await T.mouse.wheel(0, -150);
  check("the student's iPad follows the teacher again", await until(async () => sameCenter(await viewOf(T), await viewOf(I))),
    JSON.stringify({ ipad: await viewOf(I), teacher: await viewOf(T) }));

  // ---------------- 8. the watch button alone ----------------
  await T.locator(".watchbtn").click();
  check("teacher can follow the iPad with the button alone", await until(() => watchOn(I)));
  await T.locator(".watchbtn").click();
  check("...and stop", await until(async () => !(await watchOn(I))));

  // ---------------- 9. a wrong key: the iPad waits like any student ----------------
  const bad = url.replace(/pair=[a-f0-9]{32}/, "pair=" + "0".repeat(32));
  const X = await newPage("bad-key", { width: 1024, height: 768 }, { hasTouch: true });
  await joinAt(X, bad, "זר");
  check("an iPad with a wrong key waits in the waiting room", await until(() => X.evaluate(() => window.__room.lobby.kind === "waiting")));
  check("...and the teacher is asked to let it in", await until(async () => (await T.locator('.lobby-item[data-name="זר"]').count()) === 1));
  await T.locator('.lobby-item[data-name="זר"] button.deny').click();

  // ---------------- 10. the iPad leaves while followed: following stops ----------------
  await T.locator(".watchbtn").click();
  await until(() => watchOn(T));
  await I.evaluate(() => window.__room.leave());
  await I.close();
  check("the student's iPad left: following it stops, and its button goes away",
    await until(async () => !(await watchOn(T)) && (await T.locator(".watchbtn").isHidden()), 20000));
  check("student: the button says 'connect' again", await until(async () => (await ipadBtn.textContent()).includes("חבר אייפד"), 20000));
} catch (e) {
  console.error(e);
  problems.push(String(e));
} finally {
  await browser.close();
}

console.log(problems.length ? `\n${problems.length} problem(s):\n- ${problems.join("\n- ")}` : "\nall good");
process.exit(problems.length ? 1 : 0);
