// End-to-end test: teacher + student (+ iPad) in real Chromium with fake camera/mic.
// Usage: node tests/e2e.mjs [baseUrl]
import { chromium } from "playwright";

const BASE = process.argv[2] || "http://127.0.0.1:8787";
const ROOM = "test" + Math.random().toString(36).slice(2, 10);
const results = [];
const ok = (name, cond, extra = "") => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || "/opt/pw-browsers/chromium",
  args: [
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    "--auto-select-desktop-capture-source=Entire screen",
    "--autoplay-policy=no-user-gesture-required",
  ],
});

async function join(role, name) {
  const ctx = await browser.newContext({ permissions: ["camera", "microphone"], viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  page.on("dialog", (d) => d.accept());
  page.on("pageerror", (e) => console.log(`[${name} pageerror]`, e.message));
  page.on("console", (m) => { if (m.type() === "error") console.log(`[${name} console]`, m.text()); });
  await page.goto(`${BASE}/r/${ROOM}${role === "student" ? "" : "?role=" + role}`);
  await page.fill(".prejoin input[type=text]", name);
  await page.waitForTimeout(800);
  await page.click(".prejoin .btn.big");
  await page.waitForSelector(".lesson");
  return { ctx, page };
}

// frames decoded for remote video from a given slot, summed over peers
const frames = (page, slot) => page.evaluate(async (slot) => {
  const room = window.__room;
  let n = 0;
  for (const p of room.peers.values()) {
    const t = p.link.remoteTracks()[slot];
    if (!t) continue;
    const st = await p.link.pc.getStats(t);
    st.forEach((s) => { if (s.type === "inbound-rtp") n += s.framesDecoded ?? s.packetsReceived ?? 0; });
  }
  return n;
}, slot);

const until = async (fn, ms = 20000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if (await fn()) return true; } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
};

const connectedCount = (page) => page.evaluate(() => [...window.__room.peers.values()].filter((p) => p.link.state === "connected").length);

async function drawLine(page, x1, y1, x2, y2) {
  const box = await page.locator(".board-canvas").boundingBox();
  await page.mouse.move(box.x + x1, box.y + y1);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(box.x + x1 + ((x2 - x1) * i) / 12, box.y + y1 + ((y2 - y1) * i) / 12);
  await page.mouse.up();
}

const strokeCount = (page) => page.evaluate(() => Object.values(window.__board.state.strokes).filter((s) => !s.del).length);

try {
  const t0 = Date.now();
  const teacher = await join("teacher", "המורה");
  const student = await join("student", "דני");

  ok("teacher and student connect P2P", await until(async () => (await connectedCount(teacher.page)) === 1 && (await connectedCount(student.page)) === 1),
    `${Date.now() - t0}ms`);
  ok("student receives teacher camera", await until(async () => (await frames(student.page, "cam")) > 20));
  ok("teacher receives student camera", await until(async () => (await frames(teacher.page, "cam")) > 20));
  ok("student receives teacher audio", await until(async () => (await frames(student.page, "mic")) > 20));

  // whiteboard
  await drawLine(teacher.page, 200, 200, 500, 300);
  ok("teacher stroke reaches student", await until(async () => (await strokeCount(student.page)) === 1));
  await drawLine(student.page, 300, 400, 600, 350);
  ok("student stroke reaches teacher", await until(async () => (await strokeCount(teacher.page)) === 2));
  await teacher.page.keyboard.press("Control+z");
  ok("undo syncs", await until(async () => (await strokeCount(student.page)) === 1));

  // lock
  await teacher.page.evaluate(() => window.__board.setLock(true));
  ok("lock reaches student", await until(() => student.page.evaluate(() => window.__board.state.lock.on === true)));
  await drawLine(student.page, 300, 450, 600, 450);
  ok("locked student cannot draw", (await strokeCount(student.page)) === 1);
  await teacher.page.evaluate(() => window.__board.setLock(false));

  // pages
  await teacher.page.evaluate(() => window.__board.addPage());
  ok("new page followed by student", await until(() => student.page.evaluate(() => window.__board.pages.length === 2 && window.__board.currentPage.id === window.__board.pages[1].id)));

  // chat
  await teacher.page.click('button[aria-label="צ\'אט"]');
  await teacher.page.fill(".chat-form input", "שלום דני");
  await teacher.page.click(".chat-form .btn");
  ok("chat message delivered", await until(() => student.page.evaluate(() => document.querySelector(".chat-log")?.textContent?.includes("שלום דני"))));

  // screen share
  await teacher.page.click('button[aria-label="שיתוף מסך"]');
  const shared = await until(async () => (await frames(student.page, "screen")) > 5, 15000);
  ok("teacher screen share reaches student", shared);
  ok("student stage switches to screen", await until(() => student.page.evaluate(() => !document.querySelector(".screen-wrap")?.hidden)));
  await teacher.page.click('button[aria-label="שיתוף מסך"]');
  ok("screen share stops and stage returns to board", await until(() => student.page.evaluate(() => !!document.querySelector(".screen-wrap")?.hidden)));

  // camera off/on
  await teacher.page.click('button[aria-label="מצלמה"]');
  ok("camera-off state reaches student", await until(() => student.page.evaluate(() => [...window.__room.peers.values()][0].state.cam === false)));
  await teacher.page.click('button[aria-label="מצלמה"]');
  ok("camera back on", await until(() => student.page.evaluate(() => [...window.__room.peers.values()][0].state.cam === true)));

  // student reload -> reconnect + board resync from IndexedDB/peer
  await student.page.reload();
  await student.page.fill(".prejoin input[type=text]", "דני");
  await student.page.waitForTimeout(500);
  await student.page.click(".prejoin .btn.big");
  const dump = (p) => p.evaluate(() => JSON.stringify([...window.__room.peers.values()].map((x) => [x.info.name, x.info.sessionId.slice(0, 4), x.link.epoch, x.link.state, x.link.pc.signalingState])));
  const rc = await until(async () => (await connectedCount(teacher.page)) === 1 && (await connectedCount(student.page)) === 1);
  if (!rc) console.log("teacher:", await dump(teacher.page), "student:", await dump(student.page));
  ok("reconnects after student reload (dbg)", rc);
  ok("reconnects after student reload", await until(async () => (await connectedCount(teacher.page)) === 1 && (await connectedCount(student.page)) === 1));
  ok("video flows again after reload", await until(async () => (await frames(teacher.page, "cam")) > 20 && (await frames(student.page, "cam")) > 20));
  ok("teacher sees exactly 1 peer (old session dropped)", (await teacher.page.evaluate(() => window.__room.peers.size)) === 1);

  // fresh device (empty storage) gets full board via snapshot
  const fresh = await join("student", "צופה");
  ok("third device connects to both", await until(async () => (await connectedCount(fresh.page)) === 2));
  ok("snapshot syncs board to new device", await until(async () => (await strokeCount(fresh.page)) === 1 && (await fresh.page.evaluate(() => window.__board.pages.length)) === 2));
  await fresh.ctx.close();
  ok("closed tab is removed from teacher", await until(() => teacher.page.evaluate(() => window.__room.peers.size === 1), 15000));

  // iPad role: no mic, speaker muted
  const ipad = await join("ipad", "אייפד");
  const ic = await until(async () => (await connectedCount(ipad.page)) === 2);
  if (!ic) for (const [n, pg] of [["teacher", teacher.page], ["student", student.page], ["ipad", ipad.page]]) console.log(n, await dump(pg));
  ok("iPad connects", ic);
  ok("iPad sends no audio", (await ipad.page.evaluate(() => window.__room.localState().mic)) === false);
  await drawLine(ipad.page, 100, 100, 400, 200);
  ok("iPad stroke reaches student and teacher", await until(async () => (await strokeCount(student.page)) === 2 && (await strokeCount(teacher.page)) === 2));

  // signaling drop: media should survive
  await student.page.evaluate(() => window.__room["sig"].ws.close());
  await new Promise((r) => setTimeout(r, 3000));
  ok("media survives signaling reconnect", (await connectedCount(student.page)) === 2);
} catch (e) {
  console.error("TEST CRASH", e);
  results.push({ name: "crash", pass: false });
} finally {
  await browser.close();
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}
