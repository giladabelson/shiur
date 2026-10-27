// PDF and image backgrounds. pdf.js "legacy" build is the one that supports Safari/iPad.

import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import { loadAsset } from "./store";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const docs = new Map<string, Promise<pdfjs.PDFDocumentProxy | null>>();
const images = new Map<string, Promise<ImageBitmap | null>>();

function getDoc(assetId: string) {
  let p = docs.get(assetId);
  if (!p) {
    p = (async () => {
      const a = await loadAsset(assetId);
      if (!a) return null;
      // pdf.js transfers the buffer to its worker, so give it a copy.
      return pdfjs.getDocument({ data: new Uint8Array(a.data.slice(0)) }).promise;
    })().catch((e) => { console.warn("pdf", e); return null; });
    docs.set(assetId, p);
    p.then((d) => { if (!d) docs.delete(assetId); });
  }
  return p;
}

/** Page sizes (in PDF points) of every page, used when importing. */
export async function pdfPageSizes(data: ArrayBuffer): Promise<{ w: number; h: number }[]> {
  const task = pdfjs.getDocument({ data: new Uint8Array(data.slice(0)) });
  const doc = await task.promise;
  const out: { w: number; h: number }[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const pg = await doc.getPage(i);
    const v = pg.getViewport({ scale: 1 });
    out.push({ w: v.width, h: v.height });
  }
  await task.destroy();
  return out;
}

export async function imageSize(data: ArrayBuffer, mime: string) {
  const bmp = await createImageBitmap(new Blob([data], { type: mime }));
  const s = { w: bmp.width, h: bmp.height };
  bmp.close();
  return s;
}

// Rendered backgrounds, kept small: iPad Safari has a tight total canvas memory budget.
const cache = new Map<string, { canvas: HTMLCanvasElement | ImageBitmap; width: number }>();
const pending = new Map<string, Promise<void>>();
const MAX_CACHE = 6;

function remember(key: string, v: { canvas: HTMLCanvasElement | ImageBitmap; width: number }) {
  cache.delete(key);
  cache.set(key, v);
  while (cache.size > MAX_CACHE) {
    const [k, old] = cache.entries().next().value!;
    cache.delete(k);
    if (old.canvas instanceof HTMLCanvasElement) old.canvas.width = old.canvas.height = 0;
  }
}

/**
 * Returns a rendered background if one is ready (at roughly `wantPx` width), otherwise starts
 * rendering it and calls `onReady` when done.
 */
export function getBackground(
  bg: { asset: string; kind: "pdf" | "image"; index: number },
  wantPx: number,
  onReady: () => void,
): HTMLCanvasElement | ImageBitmap | null {
  const key = `${bg.asset}:${bg.index}`;
  const bucket = Math.min(3200, Math.max(800, 2 ** Math.ceil(Math.log2(wantPx))));
  const hit = cache.get(key);
  if (hit && (hit.width >= bucket || bg.kind === "image")) {
    remember(key, hit);
    return hit.canvas;
  }
  const pkey = `${key}@${bucket}`;
  if (!pending.has(pkey)) {
    const job = (async () => {
      if (bg.kind === "image") {
        let ip = images.get(bg.asset);
        if (!ip) {
          ip = loadAsset(bg.asset).then((a) => (a ? createImageBitmap(new Blob([a.data], { type: a.mime })) : null)).catch(() => null);
          images.set(bg.asset, ip);
        }
        const bmp = await ip;
        if (!bmp) { images.delete(bg.asset); return; }
        remember(key, { canvas: bmp, width: bmp.width });
      } else {
        const doc = await getDoc(bg.asset);
        if (!doc) return;
        const pg = await doc.getPage(bg.index + 1);
        const v1 = pg.getViewport({ scale: 1 });
        const scale = bucket / v1.width;
        const v = pg.getViewport({ scale });
        const c = document.createElement("canvas");
        c.width = Math.floor(v.width);
        c.height = Math.floor(v.height);
        await pg.render({ canvas: c, canvasContext: c.getContext("2d")!, viewport: v }).promise;
        remember(key, { canvas: c, width: c.width });
      }
      onReady();
    })().catch((e) => console.warn("bg render", e)).finally(() => pending.delete(pkey));
    pending.set(pkey, job);
  }
  return hit?.canvas ?? null;
}

/** Forget a failed asset so it can be retried after the file arrives from a peer. */
export function assetArrived(id: string) {
  docs.delete(id);
  images.delete(id);
  for (const k of [...cache.keys()]) if (k.startsWith(id + ":")) cache.delete(k);
}
