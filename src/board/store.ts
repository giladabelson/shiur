// Tiny IndexedDB wrapper: board state per room, and file assets (PDFs, images) by content hash.

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
      const r = indexedDB.open("shiur", 1);
      r.onupgradeneeded = () => {
        r.result.createObjectStore("boards");
        r.result.createObjectStore("assets");
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
