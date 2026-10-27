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
  private small = document.createElement("canvas");
  private maskCanvas = document.createElement("canvas");
  private maskData: ImageData | null = null;
  private segIn = document.createElement("canvas");
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
        const conf = mask.getAsFloat32Array();
        if (this.maskCanvas.width !== mw || this.maskCanvas.height !== mh || !this.maskData) {
          this.maskCanvas.width = mw;
          this.maskCanvas.height = mh;
          this.maskData = new ImageData(mw, mh);
        }
        const d = this.maskData.data;
        for (let i = 0, j = 3; i < conf.length; i++, j += 4) {
          // Slight contrast curve so hair/edges stay soft but the background goes fully transparent.
          const v = Math.min(1, Math.max(0, (conf[i] - 0.25) / 0.5));
          d[j] = v * 255;
        }
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

    // 1) blurred background: shrink then enlarge (works in every browser, cheap)
    const sw = Math.max(16, Math.round(w / 24)), sh = Math.max(9, Math.round(h / 24));
    if (this.small.width !== sw || this.small.height !== sh) { this.small.width = sw; this.small.height = sh; }
    const sctx = this.small.getContext("2d")!;
    sctx.imageSmoothingQuality = "high";
    sctx.drawImage(src, 0, 0, sw, sh);
    octx.imageSmoothingEnabled = true;
    octx.imageSmoothingQuality = "high";
    octx.drawImage(this.small, 0, 0, w, h);

    // 2) the person, sharp, cut out with the (smoothly enlarged) mask
    const pctx = this.person.getContext("2d")!;
    pctx.globalCompositeOperation = "copy";
    pctx.drawImage(src, 0, 0, w, h);
    pctx.globalCompositeOperation = "destination-in";
    pctx.imageSmoothingEnabled = true;
    pctx.imageSmoothingQuality = "high";
    pctx.drawImage(this.maskCanvas, 0, 0, w, h);
    pctx.globalCompositeOperation = "source-over";
    octx.drawImage(this.person, 0, 0);

    const dt = performance.now() - t0;
    this.msPerFrame = this.msPerFrame ? this.msPerFrame * 0.9 + dt * 0.1 : dt;
  }
}

// Exposed for automated tests.
(window as any).__BackgroundBlur = BackgroundBlur;
