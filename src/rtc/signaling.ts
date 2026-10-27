// WebSocket signaling client: auto-reconnect with backoff, heartbeat, and an outbox while offline.

export type Role = "teacher" | "student" | "ipad";

export interface PeerInfo {
  peerId: string;
  sessionId: string;
  role: Role;
  name: string;
}

export type SignalMsg =
  | { type: "welcome"; you: PeerInfo; peers: PeerInfo[] }
  | { type: "peer-joined"; peer: PeerInfo }
  | { type: "peer-left"; peerId: string; sessionId: string }
  | { type: "signal"; from: string; fromSession: string; fromRole: Role; fromName: string; data: any };

export type SignalingState = "connecting" | "open" | "closed";

const PING_EVERY = 20_000;
const DEAD_AFTER = 50_000;

export class Signaling {
  private ws: WebSocket | null = null;
  private outbox: string[] = [];
  private backoff = 500;
  private lastPong = Date.now();
  private timer: number | undefined;
  private reconnectTimer: number | undefined;
  private stopped = false;
  state: SignalingState = "connecting";

  onMessage: (m: SignalMsg) => void = () => {};
  onState: (s: SignalingState) => void = () => {};

  constructor(private url: string) {}

  start() {
    this.stopped = false;
    this.connect();
    this.timer = window.setInterval(() => this.heartbeat(), PING_EVERY / 4);
    window.addEventListener("online", this.onOnline);
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    clearTimeout(this.reconnectTimer);
    window.removeEventListener("online", this.onOnline);
    this.ws?.close(1000, "bye");
    this.ws = null;
  }

  send(msg: object) {
    const s = JSON.stringify(msg);
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(s);
    else {
      this.outbox.push(s);
      if (this.outbox.length > 500) this.outbox.splice(0, this.outbox.length - 500);
    }
  }

  private onOnline = () => {
    if (this.ws?.readyState !== WebSocket.OPEN) this.reconnectNow();
  };

  private lastPing = 0;
  private heartbeat() {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const now = Date.now();
    if (now - this.lastPing >= PING_EVERY) {
      this.lastPing = now;
      ws.send("ping");
    }
    if (now - this.lastPong > DEAD_AFTER) {
      // No pong for too long: the socket is dead even if the browser hasn't noticed.
      ws.close();
      this.reconnectNow();
    }
  }

  private reconnectNow() {
    clearTimeout(this.reconnectTimer);
    this.backoff = 500;
    this.connect();
  }

  private setState(s: SignalingState) {
    if (this.state === s) return;
    this.state = s;
    this.onState(s);
  }

  private connect() {
    if (this.stopped) return;
    const old = this.ws;
    if (old) {
      old.onclose = old.onmessage = old.onopen = old.onerror = null;
      try { old.close(); } catch { /* ignore */ }
    }
    this.setState("connecting");
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = 500;
      this.lastPong = Date.now();
      this.lastPing = 0;
      this.setState("open");
      for (const s of this.outbox.splice(0)) ws.send(s);
    };
    ws.onmessage = (e) => {
      this.lastPong = Date.now();
      if (e.data === "pong") return;
      try { this.onMessage(JSON.parse(e.data)); } catch (err) { console.error("signal msg", err); }
    };
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.setState("closed");
      if (this.stopped || e.code === 4001) return; // 4001: replaced by a newer tab of this device
      this.reconnectTimer = window.setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 8000);
    };
    ws.onerror = () => { /* onclose follows */ };
  }
}
