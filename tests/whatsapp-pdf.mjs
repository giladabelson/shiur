// Tests for sending the lesson PDF to the student's WhatsApp:
// - ending the lesson opens the student's WhatsApp chat right away (no popup blocker, no share window),
// - "Previous lessons" → "שלח בוואטסאפ" opens the chat too, and never the system share window on a computer,
// - without a cloud copy the PDF is downloaded so it can be dragged into the chat.
// Usage: node tests/whatsapp-pdf.mjs [baseUrl] [outDir]
// With cloud storage (npm run dev:cloud, port 8788) the message carries a link to the PDF instead.
import { chromium } from "playwright";
import fs from "node:fs";

const BASE = process.argv[2] || "http://127.0.0.1:8787";
const OUT = process.argv[3] || "./shots-wa";
fs.mkdirSync(OUT, { recursive: true });
const ROOM = "wapd" + Math.random().toString(36).slice(2, 10);
const PHONE = "050-1234567";
const WA = "972501234567";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = [];
const check = (name, cond, extra = "") => { console.log(`${cond ? "OK  " : "BAD "} ${name}${extra ? "  " + extra : ""}`); if (!cond) problems.push(name); };

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || "/opt/pw-browsers/chromium",
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
});

try {
  const ctx = await browser.newContext({ permissions: ["camera", "microphone"], viewport: { width: 1366, height: 768 }, acceptDownloads: true });
  // The teacher's saved student, with a WhatsApp number. wa.me is never really loaded.
  await ctx.addInitScript(([room, phone]) => {
    localStorage.setItem("shiur.students", JSON.stringify([{ id: "s1", name: "נועה", room, created: Date.now(), phone }]));
    // A share window on a computer would ask "how to share" instead of opening the chat: record any use.
    window.__shared = 0;
    Object.defineProperty(navigator, "share", { value: async () => { window.__shared++; }, configurable: true });
    Object.defineProperty(navigator, "canShare", { value: () => true, configurable: true });
  }, [ROOM, PHONE]);
  await ctx.route(/wa\.me|whatsapp\.com/, (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<title>wa</title>ok" }));
  const T = await ctx.newPage();
  T.on("dialog", (d) => d.accept());
  T.on("pageerror", (e) => { console.log(`PAGE ERROR ${e.message}`); problems.push(e.message); });
  await T.goto(`${BASE}/r/${ROOM}?role=teacher&n=${encodeURIComponent("נועה")}`);
  await T.fill(".prejoin input[type=text]", "המורה");
  await T.click(".prejoin .btn.big");
  await T.waitForSelector(".lesson");
  await T.waitForFunction(() => !!window.__board);

  // write something
  const b = await T.locator(".board-canvas").boundingBox();
  await T.mouse.move(b.x + 300, b.y + 200);
  await T.mouse.down();
  for (let i = 1; i <= 12; i++) await T.mouse.move(b.x + 300 + i * 20, b.y + 200 + i * 6);
  await T.mouse.up();
  await sleep(600);

  // ---- 1. end the lesson: the chat opens by itself ----
  const tabP = ctx.waitForEvent("page", { timeout: 30000 });
  const dlP = T.waitForEvent("download", { timeout: 30000 }).catch(() => null);
  await T.click("button.leave");
  const tab = await tabP;
  await tab.waitForURL(/wa\.me|whatsapp/, { timeout: 30000 }).catch(() => {});
  const url = tab.url();
  check("ending the lesson opens WhatsApp in a new tab", /wa\.me|whatsapp/.test(url), url.slice(0, 90));
  check("…straight to the student's chat", url.includes(WA));
  const text = decodeURIComponent(new URL(url).searchParams.get("text") || "");
  check("…with a message to the student", text.includes("נועה") && text.includes("PDF"), JSON.stringify(text.slice(0, 60)));
  const cloud = /\/api\/lessons\/.+\.pdf/.test(text);
  if (cloud) check("cloud: the message links to the PDF", true);
  else {
    const dl = await dlP;
    const name = await T.evaluate(() => window.__lastDownload || "");
    check("no cloud: the PDF is downloaded to drag into the chat", !!dl && name.endsWith(".pdf"), name);
  }
  check("the computer's share window was not used", (await T.evaluate(() => window.__shared)) === 0);
  await T.waitForSelector("text=יצאת מהשיעור");
  check("the end screen has a 'send to the student' button", (await T.locator("button", { hasText: "שלח לתלמיד בוואטסאפ" }).count()) === 1);
  await T.screenshot({ path: `${OUT}/01-end-screen.png` });
  await tab.close();

  // ---- 2. previous lessons → send on WhatsApp ----
  await T.goto(`${BASE}/`);
  await T.waitForSelector("text=שיעורים קודמים", { timeout: 15000 });
  await T.locator("button", { hasText: "שיעורים קודמים" }).first().click();
  await T.waitForSelector(".lesson-row", { timeout: 15000 });
  await T.screenshot({ path: `${OUT}/02-previous-lessons.png` });
  const tab2P = ctx.waitForEvent("page", { timeout: 20000 });
  await T.locator(".lesson-row button", { hasText: "שלח בוואטסאפ" }).first().click();
  const tab2 = await tab2P;
  await tab2.waitForURL(/wa\.me|whatsapp/, { timeout: 20000 }).catch(() => {});
  check("previous lessons: WhatsApp opens on the student's chat", tab2.url().includes(WA), tab2.url().slice(0, 90));
  check("previous lessons: no share window on a computer", (await T.evaluate(() => window.__shared)) === 0);
  await tab2.close();
} catch (e) {
  console.log("CRASH", e);
  problems.push(String(e));
} finally {
  await browser.close();
}
console.log(problems.length ? `\n${problems.length} PROBLEM(S)` : "\nALL GOOD");
process.exit(problems.length ? 1 : 0);
