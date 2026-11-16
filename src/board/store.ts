// Tiny IndexedDB wrapper: board state per room (the current lesson under the room id, earlier
// lessons under "room@lessonId"), file assets (PDFs, images) by content hash, and the saved
// end-of-lesson PDFs.

import type { BoardState } from "./model";

export interface Asset {
  id: string;
  mime: string;
  name: string;
  data: ArrayBuffer;
}

let dbp: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  if (!dbp) {
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open("shiur", 2);
      r.onupgradeneeded = () => {
        const names = r.result.objectStoreNames;
        for (const n of ["boards", "assets", "pdfs"]) if (!names.contains(n)) r.result.createObjectStore(n);
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  return dbp;
}

async function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  try {
    const d = await db();
    return await new Promise<T>((res, rej) => {
      const t = d.transaction(store, mode);
      const req = fn(t.objectStore(store));
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
  } catch (e) {
    console.warn("idb", e);
    return undefined;
  }
}

export const loadBoard = (room: string) => tx<BoardState>("boards", "readonly", (s) => s.get(room));
export const saveBoard = (room: string, st: BoardState) => tx("boards", "readwrite", (s) => s.put(st, room));
export const loadAsset = (id: string) => tx<Asset>("assets", "readonly", (s) => s.get(id));
export const saveAsset = (a: Asset) => tx("assets", "readwrite", (s) => s.put(a, a.id));
export const deleteBoard = (key: string) => tx("boards", "readwrite", (s) => s.delete(key));
export const boardKeys = () => tx<IDBValidKey[]>("boards", "readonly", (s) => s.getAllKeys());

/** A lesson PDF kept on this device (also uploaded to the server when lesson storage is enabled). */
export interface LessonPdf {
  room: string;
  lesson: string;
  name: string;
  started: number;
  saved: number;
  pages: number;
  blob: Blob;
  uploaded: boolean;
}

export const savePdf = (p: LessonPdf) => tx("pdfs", "readwrite", (s) => s.put(p, `${p.room}@${p.lesson}`));
export const loadPdf = (room: string, lesson: string) => tx<LessonPdf>("pdfs", "readonly", (s) => s.get(`${room}@${lesson}`));
export const deletePdf = (room: string, lesson: string) => tx("pdfs", "readwrite", (s) => s.delete(`${room}@${lesson}`));
export async function listPdfs(room: string): Promise<LessonPdf[]> {
  const all = (await tx<LessonPdf[]>("pdfs", "readonly", (s) => s.getAll())) ?? [];
  return all.filter((p) => p.room === room).sort((a, b) => b.started - a.started);
}

export async function hashBytes(buf: ArrayBuffer): Promise<string> {
  const h = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(h).slice(0, 12), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function toB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
