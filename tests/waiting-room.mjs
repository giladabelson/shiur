// Waiting room: students wait until a teacher device lets them in (enforced by the server), the
// teacher's notice with "הכנס" / "דחה", remembered admission on reload, and the in-lesson invite
// dialog (student link + QR, iPad QR).
// Usage: node tests/waiting-room.mjs [baseUrl] [outDir]
import { chromium } from "playwright";
import fs from "node:fs";
import { admit, inLesson } from "./lib/admit.mjs";

const BASE = process.argv[2] || "http://127.0.0.1:8787";
const OUT = process.argv[3] || "./shots-waiting";
fs.mkdirSync(OUT, { recursive: true });
const ROOM = "wait" + Math.random().toString(36).slice(2, 10);
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

async function open(role, name, vp = { width: 1280, height: 760 }, extra = {}) {
  const ctx = await browser.newContext({ permissions: ["camera", "microphone", "clipboard-read", "clipboard-write"], viewport: vp, ...extra });
  const page = await ctx.newPage();
  page.on("dialog", (d) => d.accept());
  page.on("pageerror", (e) => { console.log(`[${name}] PAGE ERROR ${e.message}`); problems.push(`${name}: ${e.message}`); });
  await page.goto(`${BASE}/r/${ROOM}${role === "student" ? "" : "?role=" + role}`);
  await page.fill(".prejoin input[type=text]", name);
  await sleep(300);
  await page.click(".prejoin .btn.big");
  await page.waitForSelector(".lesson");
  return page;
}
/** Record every signaling message a page receives (window.__sigLog). */
const tapSignaling = (page) => page.evaluate(() => {
  window.__sigLog = [];
  const sig = window.__room["sig"];
  const orig = sig.onMessage;
  sig.onMessage = (m) => { window.__sigLog.push(m); orig(m); };
});
const strokes = (page) => page.evaluate(() => Object.values(window.__board.state.strokes).filter((s) => !s.del).length);
const connected = (page) => page.evaluate(() => [...window.__room.peers.values()].filter((p) => p.link.state === "connected").length);
const peerNames = (page) => page.evaluate(() => [...window.__room.peers.values()].map((p) => p.info.name));
const lobbyNames = (page) => page.evaluate(() => [...document.querySelectorAll(".lobby-item")].map((e) => e.dataset.name));
const waitingText = (page) => page.evaluate(() => { const w = document.querySelector(".waiting-room"); return w && !w.hidden ? w.textContent : ""; });
const camFrames = (page) => page.evaluate(async () => {
  let n = 0;
  for (const p of window.__room.peers.values()) {
    const t = p.link.remoteTracks().cam;
    if (!t) continue;
    (await p.link.pc.getStats(t)).forEach((s) => { if (s.type === "inbound-rtp") n += s.framesDecoded ?? 0; });
  }
  return n;
});
async function drawLine(page, x1, y1, x2, y2) {
  const box = await page.locator(".board-canvas").boundingBox();
  await page.mouse.move(box.x + x1, box.y + y1);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(box.x + x1 + ((x2 - x1) * i) / 12, box.y + y1 + ((y2 - y1) * i) / 12);
  await page.mouse.up();
}

try {
  // ---------------- 1. a student comes first: waits, with no teacher ----------------
  const S = await open("student", "נועה");
  check("student sees the waiting screen", await until(async () => (await waitingText(S)).includes("ממתינים שהמורה יכניס אותך לשיעור")));
  const w1 = await waitingText(S);
  check("waiting screen: says the teacher isn't here yet, and shows the name", w1.includes("המורה עוד לא בשיעור") && w1.includes("נועה"));
  check("waiting screen: own camera preview", await S.evaluate(() => !!document.querySelector(".wait-self")?.srcObject));
  await sleep(1200);
  await S.screenshot({ path: `${OUT}/01-student-waiting-no-teacher.png` });

  // ---------------- 2. the teacher joins: sees the student waiting, nothing flows yet ----------------
  const T = await open("teacher", "המורה", { width: 1366, height: 768 });
  check("teacher is never put in the waiting room", await until(() => T.evaluate(() => window.__room.lobby.kind === "admitted")) && !(await T.locator(".waiting-room").count()));
  await tapSignaling(T);
  check("teacher sees the waiting student right away", await until(async () => (await lobbyNames(T)).includes("נועה")));
  check("student is told the teacher is here", await until(async () => { const t = await waitingText(S); return t.includes("ממתינים") && !t.includes("המורה עוד לא בשיעור"); }));
  await drawLine(T, 200, 200, 500, 300);
  await sleep(3000);
  check("before admit: student not in the teacher's peers", (await T.evaluate(() => window.__room.peers.size)) === 0);
  check("before admit: student has no peers (no video, no board link)", (await S.evaluate(() => window.__room.peers.size)) === 0 && (await camFrames(S)) === 0);
  check("before admit: the board did not reach the student", (await strokes(S)) === 0);
  check("before admit: no video tile for the student on the teacher", (await T.locator(".tile:not(.self)").count()) === 0);
  await T.screenshot({ path: `${OUT}/02-teacher-lobby.png` });

  // the server enforces it: a raw socket without a role (a student) can't signal or let itself in
  const teacherPeer = await T.evaluate(() => window.__room.peerId);
  const raw = await S.evaluate(async ({ to }) => {
    const id = crypto.randomUUID();
    const ws = new WebSocket(`${location.origin.replace("http", "ws")}/api/ws/${location.pathname.split("/")[2]}?peerId=${id}&sessionId=${crypto.randomUUID()}&name=sneaky`);
    const got = [];
    ws.onmessage = (e) => got.push(JSON.parse(e.data).type);
    await new Promise((r) => { ws.onopen = r; });
    await new Promise((r) => setTimeout(r, 500));
    ws.send(JSON.stringify({ type: "admit", peerId: id }));
    ws.send(JSON.stringify({ type: "signal", to, data: { description: { type: "offer", sdp: "x" }, epoch: 0 } }));
    await new Promise((r) => setTimeout(r, 1500));
    window.__rawWs = ws;
    return { id, got };
  }, { to: teacherPeer });
  check("raw socket (no role) is put in the waiting room", raw.got.includes("waiting") && !raw.got.includes("welcome"), raw.got.join(","));
  check("a waiting student can't admit itself or signal the teacher", await T.evaluate((id) =>
    !window.__sigLog.some((m) => (m.type === "signal" && m.from === id) || (m.type === "peer-joined" && m.peer.peerId === id)) && !window.__room.peers.has(id), raw.id));
  await S.evaluate(() => window.__rawWs.close());
  check("a waiting student who leaves disappears from the notice", await until(async () => !(await lobbyNames(T)).includes("sneaky")));

  // ---------------- 3. admit: the student comes in, board and video flow ----------------
  await admit(T, "נועה");
  await inLesson(S);
  check("admitted: waiting screen gone", await until(async () => (await waitingText(S)) === ""));
  check("admitted: teacher and student connect", await until(async () => (await connected(T)) === 1 && (await connected(S)) === 1, 20000));
  check("admitted: board syncs to the student", await until(async () => (await strokes(S)) === 1));
  check("admitted: video flows", await until(async () => (await camFrames(S)) > 10 && (await camFrames(T)) > 10, 20000));
  check("admitted: the notice is empty again", await until(() => T.evaluate(() => document.querySelector(".lobby").hidden)));

  // ---------------- 4. the student reloads: straight back in, no waiting ----------------
  const mark = await T.evaluate(() => window.__sigLog.length);
  const sPeer = await S.evaluate(() => window.__room.peerId);
  await S.reload();
  await S.fill(".prejoin input[type=text]", "נועה");
  await sleep(300);
  await S.click(".prejoin .btn.big");
  check("reload: back in the lesson without the teacher", await until(() => S.evaluate(() => window.__room?.lobby?.kind === "admitted"), 10000));
  check("reload: connected again", await until(async () => (await connected(T)) === 1 && (await connected(S)) === 1, 20000));
  check("reload: board is there", (await strokes(S)) === 1);
  check("reload: never showed up as waiting on the teacher", await T.evaluate(({ mark, sPeer }) =>
    !window.__sigLog.slice(mark).some((m) => m.type === "pending" && m.list.some((p) => p.peerId === sPeer || p.name === "נועה")), { mark, sPeer }));

  // ---------------- 5. a second student is turned away ----------------
  const R = await open("student", "רון");
  check("second student waits", await until(async () => (await waitingText(R)).includes("ממתינים")));
  check("teacher sees the second student", await until(async () => (await lobbyNames(T)).includes("רון")));
  await sleep(600);
  await T.screenshot({ path: `${OUT}/03-teacher-lobby-second.png` });
  await T.locator('.lobby-item[data-name="רון"] button.deny').click();
  check("denied student sees the refusal", await until(async () => (await waitingText(R)).includes("המורה לא אישר את הכניסה")));
  check("denied student is disconnected (and doesn't reconnect)", await until(() => R.evaluate(() => window.__room.signalingState === "closed")) && (await sleep(2500), await R.evaluate(() => window.__room.signalingState === "closed")));
  check("denied student can try again later", await R.locator(".waiting-room button:has-text('נסה שוב')").isVisible());
  check("denied student never reached the teacher", !(await peerNames(T)).includes("רון") && !(await lobbyNames(T)).includes("רון"));
  await R.screenshot({ path: `${OUT}/04-student-denied.png` });
  await R.context().close();

  // ---------------- 6. the iPad: never waits, and can let students in too ----------------
  const I = await open("ipad", "אייפד", { width: 1180, height: 820 }, { hasTouch: true });
  check("iPad goes straight in", await until(async () => (await I.evaluate(() => window.__room.lobby.kind)) === "admitted" && (await connected(I)) === 2, 20000));

  // ---------------- 7. a student joining while the teacher is here still waits ----------------
  const M = await open("student", "מיכל", { width: 1000, height: 700 });
  check("late student waits (teacher here)", await until(async () => (await waitingText(M)).includes("ממתינים")) && !(await waitingText(M)).includes("המורה עוד לא בשיעור"));
  check("teacher and iPad both see her waiting", await until(async () => (await lobbyNames(T)).includes("מיכל") && (await lobbyNames(I)).includes("מיכל")));
  await sleep(2500);
  check("still waiting until admitted", (await waitingText(M)).includes("ממתינים") && !(await peerNames(T)).includes("מיכל") && (await M.evaluate(() => window.__room.peers.size)) === 0);
  await admit(I, "מיכל"); // from the iPad this time
  await inLesson(M);
  check("admitted from the iPad: connects to everyone", await until(async () => (await connected(M)) === 3, 20000));
  check("admitted from the iPad: board syncs", await until(async () => (await strokes(M)) === 1));
  check("notice cleared on both teacher devices", await until(() => T.evaluate(() => document.querySelector(".lobby").hidden)) && await until(() => I.evaluate(() => document.querySelector(".lobby").hidden)));
  check("student / iPad have no invite button", !(await M.locator(".invite-btn").count()) && !(await I.locator(".invite-btn").count()));

  // ---------------- 8. the teacher's invite dialog: student link + QR, iPad QR ----------------
  await T.evaluate((room) => localStorage.setItem("shiur.students", JSON.stringify([{ id: "s1", name: "נועה", room, created: Date.now(), phone: "050-1234567" }])), ROOM);
  await T.context().route("https://wa.me/**", (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<p>WhatsApp</p>" }));
  await T.click(".topbar .invite-btn");
  await T.waitForSelector("dialog.invite-dlg canvas.qr-ipad");
  await sleep(400);
  const qrs = await T.evaluate(() => [...document.querySelectorAll("dialog.invite-dlg canvas.qr")].map((c) => {
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let dark = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] < 80) dark++;
    return { cls: c.className, w: c.width, dark: dark / (d.length / 4) };
  }));
  check("invite dialog: two QR codes (student + iPad), both drawn", qrs.length === 2 && qrs.every((q) => q.dark > 0.2 && q.dark < 0.8), JSON.stringify(qrs));
  check("invite dialog: the iPad QR is big enough to scan off the screen", (qrs.find((q) => q.cls.includes("qr-ipad"))?.w ?? 0) >= 280);
  await T.screenshot({ path: `${OUT}/05-invite-dialog.png` });
  await T.click("dialog.invite-dlg .invite-student button.copy-link");
  check("copy: student link", await until(async () => (await T.evaluate(() => navigator.clipboard.readText())) === `${BASE}/r/${ROOM}`));
  await T.click("dialog.invite-dlg .invite-ipad button.copy-link");
  check("copy: iPad link", await until(async () => (await T.evaluate(() => navigator.clipboard.readText())) === `${BASE}/r/${ROOM}?role=ipad`));
  const shownLinks = await T.evaluate(() => [...document.querySelectorAll("dialog.invite-dlg .linkbox code")].map((c) => c.textContent));
  check("invite dialog shows both links", shownLinks[0] === `${BASE}/r/${ROOM}` && shownLinks[1] === `${BASE}/r/${ROOM}?role=ipad`);
  const [wa] = await Promise.all([T.context().waitForEvent("page"), T.click("dialog.invite-dlg .wa-invite")]);
  const waUrl = wa.url();
  await wa.close();
  check("invite dialog: WhatsApp to the student's number with the link", waUrl.startsWith("https://wa.me/972501234567?text=") && decodeURIComponent(waUrl).includes(`/r/${ROOM}`));
  await T.click("dialog.invite-dlg >> text=סגור");
  check("invite dialog closes", await until(async () => (await T.locator("dialog.invite-dlg").count()) === 0));

  // ---------------- 9. teacher's phone width: the dialog still fits ----------------
  await T.setViewportSize({ width: 420, height: 800 });
  await T.click(".topbar .invite-btn");
  await sleep(400);
  check("invite dialog fits a narrow screen", await T.evaluate(() => { const d = document.querySelector("dialog.invite-dlg"); return d.getBoundingClientRect().width <= 420 && document.documentElement.scrollWidth <= 420; }));
  await T.screenshot({ path: `${OUT}/06-invite-dialog-narrow.png` });
  await T.keyboard.press("Escape");
  await T.setViewportSize({ width: 1366, height: 768 });

  // ---------------- 10. the teacher leaves: a new student waits with "not here yet" ----------------
  await I.context().close();
  await T.context().close();
  const L = await open("student", "יעל");
  check("with no teacher device connected, a new student is told the teacher isn't here", await until(async () => (await waitingText(L)).includes("המורה עוד לא בשיעור")));
  check("the admitted student stays in the lesson", (await S.evaluate(() => window.__room.lobby.kind)) === "admitted");
} catch (e) {
  console.log("CRASH", e);
  problems.push("crash: " + e.message);
} finally {
  await browser.close();
  console.log(problems.length ? `\nPROBLEMS (${problems.length}):\n - ${problems.join("\n - ")}` : "\nALL GOOD");
  process.exit(problems.length ? 1 : 0);
}
