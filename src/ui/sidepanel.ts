// Split view: a PDF or image pinned next to the board. The file and whether the panel is open are
// synced (the teacher decides); scrolling and zooming inside the file are local to each viewer and
// never touch the board. The iPad never shows this panel: it stays a pure writing surface.

import type { Board } from "../board/board";
import { getDoc } from "../board/pdf";
import { loadAsset } from "../board/store";
import { h, icon, iconBtn } from "./dom";

const WIDTH_KEY = "shiur.sideW";
const MIN_W = 220;
const MAX_ZOOM = 5;
const MIN_ZOOM = 0.3;

export interface SidePanel {
  el: HTMLElement;
  /** Small button on the stage to bring a closed / hidden panel back. */
  reopen: HTMLElement;
  refresh(): void;
  readonly zoom: number;
  setZoom(z: number): void;
}

export function buildSidePanel(board: Board, opts: { isTeacher: boolean; pickFile: () => void }): SidePanel {
  let zoom = 1;
  let localHidden = false;
  let shown = ""; // asset currently rendered
  let loading = "";
  let observer: IntersectionObserver | null = null;
  let imgUrl = "";
  const rendered = new Map<number, number>(); // pdf page index -> width rendered at
  let renderTimer: number | undefined;

  const title = h("span", { class: "sidefile-title" });
  const zoomLbl = h("span", { class: "zoomlbl static" }, "100%");
  const pages = h("div", { class: "sidefile-pages" });
  const scroll = h("div", { class: "sidefile-scroll" }, pages);
  const resizer = h("div", { class: "sidefile-resizer", title: "גרור כדי לשנות רוחב", role: "separator", "aria-orientation": "vertical" });
  const el = h("aside", { class: "sidefile", hidden: true, "aria-label": "קובץ בצד" },
    resizer,
    h("div", { class: "sidefile-head" },
      icon("file", 16), title,
      h("div", { class: "sidefile-tools" },
        iconBtn("zoomOut", "הקטן", () => setZoom(zoom / 1.25)),
        zoomLbl,
        iconBtn("zoomIn", "הגדל", () => setZoom(zoom * 1.25)),
        iconBtn("fit", "התאם לרוחב", () => setZoom(1)),
        opts.isTeacher ? iconBtn("upload", "החלף את הקובץ שבצד", () => opts.pickFile()) : null,
        iconBtn("close", opts.isTeacher ? "סגור את הקובץ שבצד (גם אצל התלמיד)" : "הסתר אצלי", () => {
          if (opts.isTeacher) board.setSideOpen(false);
          else { localHidden = true; refresh(); }
        }),
      ),
    ),
    scroll,
  );
  const reopen = h("button", {
    class: "btn ghost side-reopen", type: "button", hidden: true,
    onclick: () => {
      localHidden = false;
      if (opts.isTeacher && board.state.side && !board.state.side.open) board.setSideOpen(true);
      refresh();
    },
  }, icon("split", 16), " קובץ בצד");

  try {
    const w = Number(localStorage.getItem(WIDTH_KEY));
    if (w >= MIN_W) el.style.width = `${w}px`;
  } catch { /* ignore */ }

  // ---------- resize by dragging the edge next to the board ----------
  resizer.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    resizer.setPointerCapture(e.pointerId);
    const startX = e.clientX, startW = el.getBoundingClientRect().width;
    const rtl = getComputedStyle(el).direction === "rtl";
    const maxW = Math.max(MIN_W, (el.parentElement?.getBoundingClientRect().width ?? 1200) * 0.7);
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const w = Math.round(Math.min(maxW, Math.max(MIN_W, startW + (rtl ? dx : -dx))));
      el.style.width = `${w}px`;
    };
    const up = () => {
      resizer.removeEventListener("pointermove", move);
      resizer.removeEventListener("pointerup", up);
      resizer.removeEventListener("pointercancel", up);
      try { localStorage.setItem(WIDTH_KEY, String(Math.round(el.getBoundingClientRect().width))); } catch { /* ignore */ }
      scheduleRender();
    };
    resizer.addEventListener("pointermove", move);
    resizer.addEventListener("pointerup", up);
    resizer.addEventListener("pointercancel", up);
  });

  // ---------- zoom: buttons, Ctrl/⌘ + wheel, two-finger pinch. Plain scrolling stays native. ----------
  function setZoom(z: number, cx?: number, cy?: number) {
    const nz = Math.round(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z)) * 100) / 100;
    if (nz === zoom) return;
    const r = scroll.getBoundingClientRect();
    const px = cx ?? r.width / 2, py = cy ?? r.height / 2;
    const fx = (scroll.scrollLeft + px) / Math.max(1, pages.scrollWidth);
    const fy = (scroll.scrollTop + py) / Math.max(1, pages.scrollHeight);
    zoom = nz;
    pages.style.width = `${zoom * 100}%`;
    zoomLbl.textContent = `${Math.round(zoom * 100)}%`;
    // keep the point under the cursor / fingers in place
    scroll.scrollLeft = fx * pages.scrollWidth - px;
    scroll.scrollTop = fy * pages.scrollHeight - py;
    scheduleRender();
  }
  scroll.addEventListener("wheel", (e) => {
    if (!e.ctrlKey && !e.metaKey) return; // normal scrolling inside the file
    e.preventDefault();
    const r = scroll.getBoundingClientRect();
    setZoom(zoom * Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });
  const touches = new Map<number, { x: number; y: number }>();
  let pinch: { d: number; z: number } | null = null;
  scroll.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "touch") return;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size === 2) {
      const [a, b] = [...touches.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, z: zoom };
    }
  });
  scroll.addEventListener("pointermove", (e) => {
    if (!touches.has(e.pointerId)) return;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && touches.size === 2) {
      const [a, b] = [...touches.values()];
      const r = scroll.getBoundingClientRect();
      setZoom((pinch.z * Math.hypot(a.x - b.x, a.y - b.y)) / pinch.d, (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top);
    }
  });
  for (const t of ["pointerup", "pointercancel"]) {
    scroll.addEventListener(t, (e) => {
      touches.delete((e as PointerEvent).pointerId);
      if (touches.size < 2) pinch = null;
    });
  }
  // Safari's own pinch gesture would zoom the whole page instead of the file.
  scroll.addEventListener("gesturestart", (e) => e.preventDefault());

  new ResizeObserver(() => scheduleRender()).observe(scroll);

  // ---------- content ----------
  function scheduleRender() {
    clearTimeout(renderTimer);
    renderTimer = window.setTimeout(renderVisible, 120);
  }

  function renderVisible() {
    if (el.hidden) return;
    for (const c of pages.querySelectorAll<HTMLCanvasElement>("canvas[data-page]")) {
      if (c.dataset.visible === "1") void renderPdfPage(c);
    }
  }

  async function renderPdfPage(c: HTMLCanvasElement) {
    const asset = shown;
    const index = Number(c.dataset.page);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const want = Math.min(2600, Math.round(c.getBoundingClientRect().width * dpr));
    if (want < 50 || (rendered.get(index) ?? 0) >= want * 0.9) return;
    rendered.set(index, want);
    const doc = await getDoc(asset);
    if (!doc || asset !== shown) return;
    const pg = await doc.getPage(index + 1);
    const v1 = pg.getViewport({ scale: 1 });
    const v = pg.getViewport({ scale: want / v1.width });
    const tmp = document.createElement("canvas");
    tmp.width = Math.floor(v.width);
    tmp.height = Math.floor(v.height);
    await pg.render({ canvas: tmp, canvasContext: tmp.getContext("2d")!, viewport: v }).promise;
    if (asset !== shown) return;
    c.width = tmp.width;
    c.height = tmp.height;
    c.getContext("2d")!.drawImage(tmp, 0, 0);
    tmp.width = tmp.height = 0;
  }

  function reset() {
    observer?.disconnect();
    observer = null;
    rendered.clear();
    if (imgUrl) URL.revokeObjectURL(imgUrl);
    imgUrl = "";
    pages.replaceChildren();
  }

  async function load(side: NonNullable<Board["state"]["side"]>) {
    if (loading === side.asset) return;
    loading = side.asset;
    reset();
    // a new file opens at "fit width", scrolled to the top
    zoom = 1;
    pages.style.width = "100%";
    zoomLbl.textContent = "100%";
    scroll.scrollTop = scroll.scrollLeft = 0;
    pages.append(h("p", { class: "sidefile-wait" }, "טוען את הקובץ…"));
    try {
      if (side.kind === "image") {
        const a = await loadAsset(side.asset);
        if (!a) return; // still on its way from the teacher; refresh() retries when it arrives
        if (loading !== side.asset) return;
        imgUrl = URL.createObjectURL(new Blob([a.data], { type: a.mime }));
        pages.replaceChildren(h("img", { class: "sidefile-img", src: imgUrl, alt: side.name, draggable: false }));
      } else {
        const doc = (await loadAsset(side.asset)) ? await getDoc(side.asset) : null;
        if (!doc) return;
        if (loading !== side.asset) return;
        observer = new IntersectionObserver((entries) => {
          for (const en of entries) {
            const c = en.target as HTMLCanvasElement;
            c.dataset.visible = en.isIntersecting ? "1" : "0";
            if (en.isIntersecting) void renderPdfPage(c);
          }
        }, { root: scroll, rootMargin: "300px" });
        const list: HTMLElement[] = [];
        const n = Math.min(doc.numPages, 300);
        for (let i = 0; i < n; i++) {
          const pg = await doc.getPage(i + 1);
          const v = pg.getViewport({ scale: 1 });
          const c = h("canvas", { class: "sidefile-page", "data-page": String(i) });
          c.style.aspectRatio = `${v.width} / ${v.height}`;
          list.push(c);
        }
        if (loading !== side.asset) return;
        shown = side.asset;
        pages.replaceChildren(...list);
        for (const c of list) observer.observe(c);
      }
      shown = side.asset;
    } catch (e) {
      console.warn("side file", e);
      pages.replaceChildren(h("p", { class: "sidefile-wait" }, "לא הצלחתי לפתוח את הקובץ"));
    } finally {
      if (shown !== side.asset) loading = ""; // not ready yet: try again on the next refresh
    }
  }

  function refresh() {
    const side = board.state.side;
    const visible = !!side && side.open && !localHidden;
    el.hidden = !visible;
    reopen.hidden = !side || visible || (!opts.isTeacher && !side.open);
    reopen.title = opts.isTeacher ? "פתח שוב את הקובץ שבצד (גם אצל התלמיד)" : "הצג את הקובץ שבצד";
    if (!side) {
      if (shown || loading) { reset(); shown = loading = ""; }
      return;
    }
    title.textContent = side.name;
    title.title = side.name;
    if (visible && side.asset !== shown) void load(side);
    else if (visible) scheduleRender();
  }

  return {
    el, reopen, refresh,
    get zoom() { return zoom; },
    setZoom: (z: number) => setZoom(z),
  };
}
