// Lesson archive: every lesson has its own board, and at the end the board is saved as a PDF.
// The PDF is always kept on the teacher's computer (IndexedDB) and, when lesson storage is enabled
// on the server (Cloudflare R2), uploaded there too so it can be downloaded or sent to the student.

import { boardOf, exportPdf } from "../board/export";
import { hasContent, type BoardState } from "../board/model";
import { boardKeys, deleteBoard, deletePdf, listPdfs, loadBoard, loadPdf, savePdf, type LessonPdf } from "../board/store";

/** Lesson PDFs and old boards are kept at least this long on this computer. */
export const KEEP_DAYS = 30;
const DAY = 86400_000;

export interface LessonEntry {
  lesson: string;
  name: string;
  started: number;
  pages: number;
  /** Server link (when lesson storage is enabled), relative to the site. */
  url?: string;
  /** Local copy on this device. */
  local?: LessonPdf;
}

const fmtDate = (t: number) => new Date(t).toLocaleDateString("he-IL").replace(/[^\d.]/g, "").replace(/\./g, "-");

/** "שיעור-יואב-16-11-2026.pdf" */
export function lessonPdfName(roomName: string, started: number) {
  return `${roomName}-${fmtDate(started || Date.now())}.pdf`;
}

/**
 * Saves a lesson's board as a PDF: on this device, and on the server if it's enabled.
 * Does nothing for an empty board. Returns what was saved.
 */
export async function saveLessonPdf(room: string, roomName: string, state: BoardState): Promise<LessonPdf | null> {
  if (!hasContent(state)) return null;
  const lesson = state.lesson?.id ?? "legacy";
  const started = state.lesson?.started || Date.now();
  const board = boardOf(state);
  if (!board.pages.length) return null;
  const blob = await exportPdf(board);
  const entry: LessonPdf = {
    room, lesson, name: lessonPdfName(roomName, started), started, saved: Date.now(), pages: board.pages.length, blob, uploaded: false,
  };
  await savePdf(entry);
  entry.uploaded = await upload(entry);
  if (entry.uploaded) await savePdf(entry);
  return entry;
}

async function upload(p: LessonPdf): Promise<boolean> {
  try {
    const q = new URLSearchParams({ name: p.name, started: String(p.started), pages: String(p.pages) });
    const r = await fetch(`/api/lessons/${p.room}/${p.lesson}?${q}`, { method: "PUT", body: p.blob, headers: { "Content-Type": "application/pdf" } });
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * Housekeeping when the teacher opens a lesson: saves PDFs of earlier lessons that were closed
 * without one (e.g. the tab was just closed), retries uploads, and forgets things older than KEEP_DAYS.
 */
export async function tidyLessons(room: string, roomName: string, currentLesson: string) {
  const keys = ((await boardKeys()) ?? []).map(String).filter((k) => k.startsWith(room + "@"));
  for (const key of keys) {
    const lesson = key.slice(room.length + 1);
    if (lesson === currentLesson) continue;
    const st = (await loadBoard(key)) as (BoardState & { act?: number }) | undefined;
    if (!st) continue;
    const when = st.act || st.lesson?.started || 0;
    if (Date.now() - when > KEEP_DAYS * DAY) {
      await deleteBoard(key);
      continue;
    }
    const id = st.lesson?.id ?? "legacy";
    const have = await loadPdf(room, id);
    if (!have) await saveLessonPdf(room, roomName, st).catch((e) => console.warn("lesson pdf", e));
    else if (!have.uploaded && (await upload(have))) await savePdf({ ...have, uploaded: true });
  }
  for (const p of await listPdfs(room)) {
    if (Date.now() - p.saved > KEEP_DAYS * DAY) await deletePdf(room, p.lesson);
  }
}

/** Lessons for a room: from the server (if enabled) and from this device. Newest first. */
export async function listLessons(room: string): Promise<{ cloud: boolean; items: LessonEntry[] }> {
  const byId = new Map<string, LessonEntry>();
  let cloud = false;
  try {
    const r = await fetch(`/api/lessons/${room}`, { cache: "no-store" });
    if (r.ok) {
      const j = await r.json();
      cloud = !!j.enabled;
      for (const it of j.items ?? []) byId.set(it.lesson, { lesson: it.lesson, name: it.name, started: it.started, pages: it.pages, url: it.url });
    }
  } catch { /* offline: local copies only */ }
  for (const p of await listPdfs(room)) {
    const e = byId.get(p.lesson);
    if (e) e.local = p;
    else byId.set(p.lesson, { lesson: p.lesson, name: p.name, started: p.started, pages: p.pages, local: p });
  }
  return { cloud, items: [...byId.values()].sort((a, b) => b.started - a.started) };
}
