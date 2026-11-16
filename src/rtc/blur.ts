// Background blur for the camera: MediaPipe's selfie segmenter finds the person, the rest of the
// frame is blurred. Everything runs locally in the browser; files are served from /mp.
//
// Chrome/Edge use MediaStreamTrackProcessor/Generator, which keeps running while the tab is in the
// background (e.g. while the teacher shares another window). Other browsers fall back to a canvas
// loop, which pauses when the tab is hidden.

import type { ImageSegmenter } from "@mediapipe/tasks-vision";

const WASM_BASE = "/mp/wasm";
const MODEL = "/mp/selfie_segmenter.tflite";

let segmenterP: Promise<ImageSegmenter> | null = null;

async function getSegmenter(): Promise<ImageSegmenter> {
  if (!segmenterP) {
    segmenterP = (async () => {
      const { FilesetResolver, ImageSegmenter } = await import("@mediapipe/tasks-vision");
      const fileset = await FilesetResolver.forVisionTasks(WASM_BASE);
      const make = (delegate: "GPU" | "CPU") => ImageSegmenter.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL, delegate },
        runningMode: "VIDEO",
        outputCategoryMask: false,
        outputConfidenceMasks: true,
      });
      try {
        return await make("GPU");
      } catch {
        return await make("CPU");
      }
    })();
    segmenterP.catch(() => { segmenterP = null; });
  }
  return segmenterP;
}

/** Start loading the model early (e.g. on the pre-join screen) so turning blur on is instant. */
export function preloadBlur() {
  void getSegmenter().catch(() => {});
}

const hasProcessor = () =>
  typeof (window as any).MediaStreamTrackProcessor === "function" && typeof (window as any).MediaStreamTrackGenerator === "function";

type Source = CanvasImageSource & TexImageSource;

export class BackgroundBlur {
  private out = document.createElement("canvas");
  private person = document.createElement("canvas");
  private maskCanvas = document.createElement("canvas");
  private maskData: ImageData | null = null;
  private segIn = document.createElement("canvas");
  private bgOnly = document.createElement("canvas");
  private coarse = document.createElement("canvas");
  private bgFill = document.createElement("canvas");
  private bgBlur = document.createElement("canvas");
  private bgTiny = document.createElement("canvas");
  private prevMask: Float32Array | null = null;
  private lastTs = 0;
  private haveMask = false;
  private frameNo = 0;
  private segEvery = 1;
  private segMs = 0;
  private stopped = false;
  private cleanup: (() => void) | null = null;
  /** Average processing time per frame, for diagnostics. */
  msPerFrame = 0;
  mode: "processor" | "canvas" | "" = "";

  /** Returns a new video track with the background blurred. The input track stays owned by the caller. */
  async apply(input: MediaStreamTrack): Promise<MediaStreamTrack> {
    const seg = await getSegmenter();
    return hasProcessor() ? this.viaProcessor(input, seg) : this.viaCanvas(input, seg);
  }

  stop() {
    this.stopped = true;
    this.cleanup?.();
    this.cleanup = null;
  }

  private viaProcessor(input: MediaStreamTrack, seg: ImageSegmenter): MediaStreamTrack {
    this.mode = "processor";
    const W = window as any;
    const processor = new W.MediaStreamTrackProcessor({ track: input });
    const generator = new W.MediaStreamTrackGenerator({ kind: "video" });
    const reader = processor.readable.getReader();
    const writer = generator.writable.getWriter();
    this.cleanup = () => {
      void reader.cancel().catch(() => {});
      void writer.close().catch(() => {});
      generator.stop();
    };
    const pump = async () => {
      while (!this.stopped) {
        const { value: frame, done } = await reader.read();
        if (done || !frame) break;
        try {
          const w = frame.displayWidth, h = frame.displayHeight;
          this.render(seg, frame, w, h);
          const outFrame = new VideoFrame(this.out, { timestamp: frame.timestamp });
          await writer.write(outFrame);
        } catch (e) {
          console.warn("blur frame", e);
        } finally {
          frame.close();
        }
      }
    };
    void pump();
    return generator as MediaStreamTrack;
  }

  private viaCanvas(input: MediaStreamTrack, seg: ImageSegmenter): MediaStreamTrack {
    this.mode = "canvas";
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = new MediaStream([input]);
    void video.play();
    const fps = input.getSettings().frameRate || 30;
    const stream = this.out.captureStream(fps);
    const track = stream.getVideoTracks()[0];
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      if (video.readyState >= 2 && video.videoWidth) this.render(seg, video, video.videoWidth, video.videoHeight);
    };
    loop();
    this.cleanup = () => {
      cancelAnimationFrame(raf);
      video.srcObject = null;
      track.stop();
    };
    return track;
  }

  private render(seg: ImageSegmenter, src: Source, w: number, h: number) {
    const t0 = performance.now();
    for (const c of [this.out, this.person]) if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const octx = this.out.getContext("2d")!;

    // Segment a small copy of the frame (the model works at 256px anyway). On slow machines the
    // mask is refreshed only every few frames, while the video itself keeps its full frame rate.
    if (!this.haveMask || this.frameNo++ % this.segEvery === 0) {
      const t1 = performance.now();
      const iw = 256, ih = Math.max(1, Math.round((256 * h) / w));
      if (this.segIn.width !== iw || this.segIn.height !== ih) { this.segIn.width = iw; this.segIn.height = ih; }
      this.segIn.getContext("2d")!.drawImage(src, 0, 0, iw, ih);
      // MediaPipe needs strictly increasing timestamps.
      const ts = Math.max(this.lastTs + 1, performance.now());
      this.lastTs = ts;
      const result = seg.segmentForVideo(this.segIn, ts);
      const mask = result.confidenceMasks?.[0];
      if (mask) {
        const mw = mask.width, mh = mask.height;
        if (this.maskCanvas.width !== mw || this.maskCanvas.height !== mh || !this.maskData) {
          this.maskCanvas.width = mw;
          this.maskCanvas.height = mh;
          this.maskData = new ImageData(mw, mh);
          this.prevMask = null;
        }
        this.prevMask = refineMask(mask.getAsFloat32Array(), this.prevMask, mw, mh, this.maskData.data);
        this.maskCanvas.getContext("2d")!.putImageData(this.maskData, 0, 0);
        this.haveMask = true;
      }
      result.close();
      const sm = performance.now() - t1;
      this.segMs = this.segMs ? this.segMs * 0.8 + sm * 0.2 : sm;
      this.segEvery = Math.min(6, Math.max(1, Math.ceil(this.segMs / 25)));
    }
    if (!this.haveMask) {
      octx.drawImage(src, 0, 0, w, h);
      return;
    }
    this.compose(src, this.maskCanvas, w, h);
    const dt = performance.now() - t0;
    this.msPerFrame = this.msPerFrame ? this.msPerFrame * 0.9 + dt * 0.1 : dt;
  }

  /**
   * Draws the output frame from the camera frame and the person mask (alpha = person).
   * 1) The background is blurred from background pixels only, so the person's colours don't
   *    bleed out as a halo; the hole where the person stands is filled with the average colour.
   * 2) The person is cut out with the feathered mask and drawn sharp on top.
   */
  compose(src: CanvasImageSource, mask: CanvasImageSource, w: number, h: number) {
    for (const c of [this.out, this.person]) if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const octx = this.out.getContext("2d")!;
    const bw = Math.max(32, Math.round(w / 8)), bh = Math.max(18, Math.round(h / 8));
    const cw = Math.max(4, Math.round(w / 80)), ch = Math.max(3, Math.round(h / 80));
    const size = (c: HTMLCanvasElement, cw2: number, ch2: number) => {
      if (c.width !== cw2 || c.height !== ch2) { c.width = cw2; c.height = ch2; }
      const x = c.getContext("2d")!;
      x.imageSmoothingEnabled = true;
      x.imageSmoothingQuality = "high";
      return x;
    };

    // background pixels only (the person is cut out)
    const actx = size(this.bgOnly, bw, bh);
    actx.globalCompositeOperation = "copy";
    actx.drawImage(src, 0, 0, bw, bh);
    actx.globalCompositeOperation = "destination-out";
    actx.drawImage(mask, 0, 0, bw, bh);
    actx.globalCompositeOperation = "source-over";
    // a very coarse copy of the whole frame fills the hole behind the person
    const cctx = size(this.coarse, cw, ch);
    cctx.drawImage(src, 0, 0, cw, ch);
    const fctx = size(this.bgFill, bw, bh);
    fctx.globalCompositeOperation = "copy";
    fctx.drawImage(this.coarse, 0, 0, bw, bh);
    fctx.globalCompositeOperation = "source-over";
    fctx.drawImage(this.bgOnly, 0, 0);
    // blur: a real Gaussian where the browser has canvas filters, else a smooth down/up scale
    const bctx = size(this.bgBlur, bw, bh);
    bctx.globalCompositeOperation = "copy";
    if (HAS_FILTER) {
      bctx.filter = `blur(${Math.max(2, Math.round(bw / 60))}px)`;
      bctx.drawImage(this.bgFill, 0, 0);
      bctx.filter = "none";
    } else {
      const tw = Math.max(8, Math.round(bw / 3)), th = Math.max(5, Math.round(bh / 3));
      const tctx = size(this.bgTiny, tw, th);
      tctx.drawImage(this.bgFill, 0, 0, tw, th);
      bctx.drawImage(this.bgTiny, 0, 0, bw, bh);
    }
    bctx.globalCompositeOperation = "source-over";
    octx.globalCompositeOperation = "copy";
    octx.imageSmoothingEnabled = true;
    octx.imageSmoothingQuality = "high";
    octx.drawImage(this.bgBlur, 0, 0, w, h);
    octx.globalCompositeOperation = "source-over";

    // the person, sharp, cut out with the smoothly enlarged, feathered mask
    const pctx = this.person.getContext("2d")!;
    pctx.globalCompositeOperation = "copy";
    pctx.drawImage(src, 0, 0, w, h);
    pctx.globalCompositeOperation = "destination-in";
    pctx.imageSmoothingEnabled = true;
    pctx.imageSmoothingQuality = "high";
    pctx.drawImage(mask, 0, 0, w, h);
    pctx.globalCompositeOperation = "source-over";
    octx.drawImage(this.person, 0, 0);
  }

  /** The output canvas (for tests). */
  get canvas() {
    return this.out;
  }
}

const HAS_FILTER = typeof CanvasRenderingContext2D !== "undefined" && "filter" in CanvasRenderingContext2D.prototype;

/**
 * Turns the model's raw person confidence into a clean alpha mask (written to `rgba`, alpha only):
 * - temporal smoothing against the previous mask, so edges don't flicker frame to frame;
 * - a small blur (feathering), so the low-resolution mask doesn't show stair steps when enlarged;
 * - a soft threshold (smoothstep), so the background goes fully transparent and the person fully
 *   opaque, with a narrow soft band at the edge (hair).
 * Returns the smoothed confidence to pass as `prev` next time.
 */
export function refineMask(conf: Float32Array, prev: Float32Array | null, w: number, h: number, rgba: Uint8ClampedArray): Float32Array {
  const n = w * h;
  const cur = new Float32Array(n);
  if (prev && prev.length === n) {
    for (let i = 0; i < n; i++) cur[i] = prev[i] * 0.35 + conf[i] * 0.65;
  } else cur.set(conf.subarray(0, n));
  // separable 5-tap binomial blur [1 4 6 4 1] (horizontal, then vertical)
  const tmp = new Float32Array(n);
  const k = (a: number, b: number, c: number, d: number, e: number) => (a + 4 * b + 6 * c + 4 * d + e) / 16;
  for (let y = 0; y < h; y++) {
    const r = y * w;
    for (let x = 0; x < w; x++) {
      const at = (dx: number) => cur[r + Math.min(w - 1, Math.max(0, x + dx))];
      tmp[r + x] = k(at(-2), at(-1), at(0), at(1), at(2));
    }
  }
  for (let y = 0; y < h; y++) {
    const row = (dy: number) => Math.min(h - 1, Math.max(0, y + dy)) * w;
    const r0 = row(-2), r1 = row(-1), r2 = y * w, r3 = row(1), r4 = row(2);
    for (let x = 0; x < w; x++) {
      const v = k(tmp[r0 + x], tmp[r1 + x], tmp[r2 + x], tmp[r3 + x], tmp[r4 + x]);
      const t = Math.min(1, Math.max(0, (v - 0.3) / 0.45));
      rgba[(r2 + x) * 4 + 3] = Math.round(t * t * (3 - 2 * t) * 255);
    }
  }
  return cur;
}

// Exposed for automated tests.
(window as any).__BackgroundBlur = BackgroundBlur;
(window as any).__refineMask = refineMask;
