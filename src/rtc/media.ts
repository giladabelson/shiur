// Local camera / mic / screen capture, with device selection.

export interface MediaPrefs {
  micId?: string;
  camId?: string;
  speakerId?: string;
  facing?: "user" | "environment";
}

const PREFS_KEY = "shiur.media";

export function loadPrefs(): MediaPrefs {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY) || "{}"); } catch { return {}; }
}

export function savePrefs(p: MediaPrefs) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* ignore */ }
}

export const canShareScreen = () =>
  !!navigator.mediaDevices && "getDisplayMedia" in navigator.mediaDevices;

export class LocalMedia {
  mic: MediaStreamTrack | null = null;
  cam: MediaStreamTrack | null = null;
  screen: MediaStreamTrack | null = null;
  micMuted = false;
  prefs: MediaPrefs = loadPrefs();
  onChange: () => void = () => {};
  /** Fired when the browser's own "stop sharing" control ends the screen share. */
  onScreenEnded: () => void = () => {};

  async startMic(): Promise<string | null> {
    this.stopTrack("mic");
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: this.prefs.micId ? { ideal: this.prefs.micId } : undefined,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
      this.mic = s.getAudioTracks()[0];
      this.mic.enabled = !this.micMuted;
      this.mic.onended = () => { this.mic = null; this.onChange(); };
      this.onChange();
      return null;
    } catch (e) {
      return errText(e);
    }
  }

  async startCam(): Promise<string | null> {
    this.stopTrack("cam");
    try {
      const video: MediaTrackConstraints = {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30, max: 30 },
      };
      if (this.prefs.camId) video.deviceId = { ideal: this.prefs.camId };
      else if (this.prefs.facing) video.facingMode = this.prefs.facing;
      const s = await navigator.mediaDevices.getUserMedia({ video });
      this.cam = s.getVideoTracks()[0];
      this.cam.contentHint = "motion";
      this.cam.onended = () => { this.cam = null; this.onChange(); };
      this.onChange();
      return null;
    } catch (e) {
      return errText(e);
    }
  }

  stopCam() {
    this.stopTrack("cam");
    this.onChange();
  }

  setMicMuted(m: boolean) {
    this.micMuted = m;
    if (this.mic) this.mic.enabled = !m;
    this.onChange();
  }

  /** Must be called directly from a click/tap handler. */
  async startScreen(): Promise<string | null> {
    if (!canShareScreen()) return "הדפדפן הזה לא תומך בשיתוף מסך";
    try {
      const s = await navigator.mediaDevices.getDisplayMedia({
        video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 15, max: 30 } },
        audio: false,
      });
      this.stopTrack("screen");
      this.screen = s.getVideoTracks()[0];
      this.screen.contentHint = "detail";
      this.screen.onended = () => {
        this.screen = null;
        this.onChange();
        this.onScreenEnded();
      };
      this.onChange();
      return null;
    } catch (e) {
      if ((e as DOMException)?.name === "NotAllowedError") return null; // user cancelled the picker
      return errText(e);
    }
  }

  stopScreen() {
    this.stopTrack("screen");
    this.onChange();
  }

  private stopTrack(k: "mic" | "cam" | "screen") {
    const t = this[k];
    if (t) {
      t.onended = null;
      t.stop();
    }
    this[k] = null;
  }

  stopAll() {
    this.stopTrack("mic");
    this.stopTrack("cam");
    this.stopTrack("screen");
  }

  tracks() {
    return { mic: this.mic, cam: this.cam, screen: this.screen };
  }
}

export async function listDevices() {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    return {
      mics: all.filter((d) => d.kind === "audioinput"),
      cams: all.filter((d) => d.kind === "videoinput"),
      speakers: all.filter((d) => d.kind === "audiooutput"),
    };
  } catch {
    return { mics: [], cams: [], speakers: [] };
  }
}

function errText(e: unknown): string {
  const name = (e as DOMException)?.name;
  if (name === "NotAllowedError") return "לא ניתנה הרשאה. צריך לאשר גישה בדפדפן (סמל המנעול ליד הכתובת).";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "לא נמצא מכשיר מתאים";
  if (name === "NotReadableError") return "המכשיר תפוס על ידי תוכנה אחרת (זום? טימס?)";
  return String((e as Error)?.message || e);
}
