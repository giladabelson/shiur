// One RTCPeerConnection per remote device, using the W3C "perfect negotiation" pattern.
// Each side sends on three fixed sendonly transceivers (mic, camera, screen) and swaps tracks with
// replaceTrack, so toggling camera/screen never renegotiates. The remote tells us which mid is which.

import type { Role } from "./signaling";

export type Slot = "mic" | "cam" | "screen";

export interface LocalTracks {
  mic: MediaStreamTrack | null;
  cam: MediaStreamTrack | null;
  screen: MediaStreamTrack | null;
}

export interface Quality {
  level: "good" | "fair" | "poor" | "unknown";
  rttMs?: number;
  lossPct?: number;
  path?: string;
  inKbps?: number;
  outKbps?: number;
  fps?: number;
  res?: string;
  limit?: string;
}

const ENCODING: Record<"cam" | "screen", RTCRtpEncodingParameters> = {
  cam: { maxBitrate: 1_200_000, maxFramerate: 30 },
  screen: { maxBitrate: 2_500_000, maxFramerate: 15 },
};

export class PeerLink {
  readonly pc: RTCPeerConnection;
  readonly polite: boolean;
  ops: RTCDataChannel | null = null;
  live: RTCDataChannel | null = null;
  private tx: Record<Slot, RTCRtpTransceiver> | null = null;
  private local: LocalTracks;
  private initTimer: number | undefined;
  private notConnectedSince = performance.now();
  private watchdogRestarted = false;
  private makingOffer = false;
  private ignoreOffer = false;
  private srdAnswerPending = false;
  private remoteLabels: Record<string, Slot> = {};
  private remoteByMid: Record<string, MediaStreamTrack> = {};
  private restartTimer: number | undefined;
  private failedSince = 0;
  private statsTimer: number | undefined;
  private prevStats = new Map<string, any>();
  private closed = false;
  quality: Quality = { level: "unknown" };
  /** Random id of this RTCPeerConnection instance, sent with every signal. */
  readonly pcId = Math.random().toString(36).slice(2, 10);
  /** pcId of the remote connection we are negotiating with (learned from its first message). */
  remotePcId: string | null = null;
  remoteRole: Role;
  remoteName: string;

  onRemoteTracks: () => void = () => {};
  onData: (msg: any, channel: "ops" | "live") => void = () => {};
  onOpsOpen: () => void = () => {};
  onConnState: () => void = () => {};
  onQuality: () => void = () => {};
  /** Asks the room to throw this link away and build a fresh one (epoch + 1). */
  onNeedsReset: () => void = () => {};

  constructor(
    readonly myPeerId: string,
    readonly remotePeerId: string,
    readonly remoteSessionId: string,
    readonly epoch: number,
    remoteRole: Role,
    remoteName: string,
    iceServers: RTCIceServer[],
    private sendSignal: (data: object) => void,
    local: LocalTracks,
    forceRelay = false,
    /** Created because the remote sent us an offer: answer it before adding our own media. */
    answering = false,
  ) {
    this.remoteRole = remoteRole;
    this.remoteName = remoteName;
    this.polite = myPeerId < remotePeerId;
    const pc = new RTCPeerConnection({
      iceServers,
      bundlePolicy: "max-bundle",
      iceTransportPolicy: forceRelay ? "relay" : "all",
    });
    this.pc = pc;

    this.local = local;
    // Only the impolite side offers first. The polite side adds its own media after the first
    // offer/answer, which avoids an initial offer collision (Chrome can get stuck gathering ICE
    // candidates after rolling back a colliding offer).
    if (!this.polite && !answering) this.initLocal();
    else this.initTimer = window.setTimeout(() => this.initLocal(), 3000);

    pc.onicecandidate = ({ candidate }) => this.signal({ candidate });
    pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true;
        await pc.setLocalDescription();
        this.signal({ description: pc.localDescription });
      } catch (e) {
        console.warn("offer failed", e);
      } finally {
        this.makingOffer = false;
      }
    };
    pc.ontrack = ({ transceiver, track }) => {
      if (transceiver.mid) this.remoteByMid[transceiver.mid] = track;
      track.onmute = track.onunmute = () => this.onRemoteTracks();
      this.onRemoteTracks();
    };
    pc.onsignalingstatechange = () => {
      if (pc.signalingState === "stable") {
        this.sendLabels();
        void this.applyEncodings();
      }
    };
    pc.oniceconnectionstatechange = () => this.handleIce();
    pc.onconnectionstatechange = () => {
      this.handleIce();
      this.onConnState();
    };

    this.statsTimer = window.setInterval(() => void this.pollStats(), 2000);
  }

  private initLocal() {
    clearTimeout(this.initTimer);
    if (this.tx || this.closed) return;
    const pc = this.pc;
    this.tx = {
      mic: pc.addTransceiver("audio", { direction: "sendonly" }),
      cam: pc.addTransceiver("video", { direction: "sendonly" }),
      screen: pc.addTransceiver("video", { direction: "sendonly" }),
    };
    const ops = pc.createDataChannel("ops", { negotiated: true, id: 0, ordered: true });
    const live = pc.createDataChannel("live", { negotiated: true, id: 1, ordered: false, maxRetransmits: 0 });
    ops.bufferedAmountLowThreshold = 256 * 1024;
    ops.onopen = () => this.onOpsOpen();
    ops.onmessage = (e) => this.handleData(e.data, "ops");
    live.onmessage = (e) => this.handleData(e.data, "live");
    this.ops = ops;
    this.live = live;
    void this.setTracks(this.local);
  }

  get state(): RTCPeerConnectionState {
    return this.pc.connectionState;
  }

  /** Remote tracks that are currently live, keyed by slot. */
  remoteTracks(): Partial<Record<Slot, MediaStreamTrack>> {
    const out: Partial<Record<Slot, MediaStreamTrack>> = {};
    for (const [mid, slot] of Object.entries(this.remoteLabels)) {
      const t = this.remoteByMid[mid];
      if (t && t.readyState === "live") out[slot] = t;
    }
    return out;
  }

  async setTracks(local: LocalTracks) {
    this.local = local;
    if (!this.tx) return;
    for (const slot of ["mic", "cam", "screen"] as Slot[]) {
      const sender = this.tx[slot].sender;
      const next = local[slot];
      if (sender.track !== next) {
        try { await sender.replaceTrack(next); } catch (e) { console.warn("replaceTrack", slot, e); }
      }
    }
    await this.applyEncodings();
  }

  private async applyEncodings() {
    if (!this.tx) return;
    for (const slot of ["cam", "screen"] as const) {
      const sender = this.tx[slot].sender;
      if (!sender.track) continue;
      const p = sender.getParameters();
      if (!p.encodings || p.encodings.length === 0) continue; // not negotiated yet
      p.encodings[0] = { ...p.encodings[0], ...ENCODING[slot] };
      if (slot === "screen") {
        p.encodings[0].priority = "high";
        p.encodings[0].networkPriority = "high";
        (p as any).degradationPreference = "maintain-resolution";
      }
      try { await sender.setParameters(p); } catch (e) { console.warn("setParameters", slot, e); }
    }
  }

  private signal(data: object) {
    if (this.closed) return;
    this.sendSignal({ ...data, epoch: this.epoch, src: this.pcId });
  }

  private sendLabels() {
    if (!this.tx) return;
    const labels: Record<string, Slot> = {};
    for (const [slot, t] of Object.entries(this.tx) as [Slot, RTCRtpTransceiver][]) {
      if (t.mid) labels[t.mid] = slot;
    }
    this.signal({ labels });
  }

  async handleSignal(data: { description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit; labels?: Record<string, Slot> }) {
    const pc = this.pc;
    if (this.closed) return;
    if (data.labels) {
      this.remoteLabels = data.labels;
      this.onRemoteTracks();
      return;
    }
    try {
      if (data.description) {
        const d = data.description;
        const ready = !this.makingOffer && (pc.signalingState === "stable" || this.srdAnswerPending);
        const collision = d.type === "offer" && !ready;
        this.ignoreOffer = !this.polite && collision;
        if (this.ignoreOffer) return;
        this.srdAnswerPending = d.type === "answer";
        await pc.setRemoteDescription(d);
        this.srdAnswerPending = false;
        if (d.type === "offer") {
          await pc.setLocalDescription();
          this.signal({ description: pc.localDescription });
          if (!this.tx) this.initLocal(); // now it's our turn to add our media
        }
        // ontrack may have fired before mids were known on our side.
        for (const t of pc.getTransceivers()) {
          if (t.mid && t.receiver.track && !(this.tx && Object.values(this.tx).includes(t))) {
            this.remoteByMid[t.mid] = t.receiver.track;
          }
        }
        this.onRemoteTracks();
      } else if (data.candidate) {
        try {
          await pc.addIceCandidate(data.candidate);
        } catch (e) {
          if (!this.ignoreOffer) console.warn("addIceCandidate", e);
        }
      }
    } catch (e) {
      console.warn("handleSignal", e);
    }
  }

  private handleIce() {
    if (this.closed) return;
    const s = this.pc.iceConnectionState;
    const c = this.pc.connectionState;
    if (s === "connected" || s === "completed") {
      this.failedSince = 0;
      clearTimeout(this.restartTimer);
      return;
    }
    if (s === "failed" || c === "failed") {
      if (!this.failedSince) this.failedSince = Date.now();
      this.pc.restartIce();
      clearTimeout(this.restartTimer);
      // If ICE restarts don't bring it back, rebuild the whole connection.
      this.restartTimer = window.setTimeout(() => {
        if (this.pc.connectionState !== "connected") this.onNeedsReset();
      }, 15_000);
    } else if (s === "disconnected") {
      clearTimeout(this.restartTimer);
      this.restartTimer = window.setTimeout(() => {
        if (this.pc.iceConnectionState === "disconnected") this.pc.restartIce();
        this.restartTimer = window.setTimeout(() => {
          if (this.pc.connectionState !== "connected") this.onNeedsReset();
        }, 20_000);
      }, 3000);
    }
  }

  /** Called when the network changes (online event) or TURN creds are refreshed. */
  restart(iceServers?: RTCIceServer[]) {
    if (this.closed) return;
    if (iceServers) {
      try { this.pc.setConfiguration({ ...this.pc.getConfiguration(), iceServers }); } catch { /* ignore */ }
    }
    if (this.pc.connectionState !== "connected") this.pc.restartIce();
  }

  private handleData(raw: unknown, channel: "ops" | "live") {
    if (typeof raw !== "string") return;
    try { this.onData(JSON.parse(raw), channel); } catch (e) { console.warn("bad dc msg", e); }
  }

  sendOps(msg: object): boolean {
    if (!this.ops || this.ops.readyState !== "open") return false;
    try { this.ops.send(JSON.stringify(msg)); return true; } catch { return false; }
  }

  sendLive(msg: object) {
    if (!this.live || this.live.readyState !== "open") return;
    if (this.live.bufferedAmount > 64 * 1024) return; // drop transient data when congested
    try { this.live.send(JSON.stringify(msg)); } catch { /* ignore */ }
  }

  /** Reliable send that waits for the buffer to drain (used for file transfers). */
  async sendOpsPaced(msg: object): Promise<boolean> {
    const ops = this.ops;
    if (!ops) return false;
    while (ops.readyState === "open" && ops.bufferedAmount > 1024 * 1024) {
      await new Promise<void>((res) => {
        const done = () => { ops.removeEventListener("bufferedamountlow", done); res(); };
        ops.addEventListener("bufferedamountlow", done);
        setTimeout(done, 1000);
      });
    }
    return this.sendOps(msg);
  }

  /** Connections stuck in "new"/"connecting" are not covered by ICE failure events. */
  private watchdog() {
    const st = this.pc.connectionState;
    const now = performance.now();
    if (st === "connected") {
      this.notConnectedSince = now;
      this.watchdogRestarted = false;
      return;
    }
    if (st !== "new" && st !== "connecting") return;
    const waited = now - this.notConnectedSince;
    if (waited > 10_000 && !this.watchdogRestarted && this.pc.remoteDescription) {
      this.watchdogRestarted = true;
      this.pc.restartIce();
    } else if (waited > 25_000) {
      this.notConnectedSince = now;
      this.onNeedsReset();
    }
  }

  private async pollStats() {
    if (this.closed || this.pc.connectionState === "closed") return;
    this.watchdog();
    let report: RTCStatsReport;
    try { report = await this.pc.getStats(); } catch { return; }
    const q: Quality = { level: "unknown" };
    let lost = 0, recv = 0, inBytes = 0, dt = 0;
    report.forEach((s: any) => {
      if (s.type === "candidate-pair" && (s.selected || s.nominated) && s.state === "succeeded") {
        if (s.currentRoundTripTime != null) q.rttMs = Math.round(s.currentRoundTripTime * 1000);
        if (s.availableOutgoingBitrate) q.outKbps = Math.round(s.availableOutgoingBitrate / 1000);
        const lc = report.get(s.localCandidateId);
        const rc = report.get(s.remoteCandidateId);
        if (lc) q.path = lc.candidateType === "relay" || rc?.candidateType === "relay" ? "relay" : lc.candidateType;
      }
      if (s.type === "inbound-rtp") {
        const p = this.prevStats.get(s.id);
        if (p) {
          lost += Math.max(0, (s.packetsLost ?? 0) - (p.packetsLost ?? 0));
          recv += Math.max(0, (s.packetsReceived ?? 0) - (p.packetsReceived ?? 0));
          inBytes += Math.max(0, (s.bytesReceived ?? 0) - (p.bytesReceived ?? 0));
          dt = Math.max(dt, s.timestamp - p.timestamp);
        }
        if (s.kind === "video" && s.framesPerSecond) {
          q.fps = Math.max(q.fps ?? 0, Math.round(s.framesPerSecond));
          if (s.frameWidth) q.res = `${s.frameWidth}x${s.frameHeight}`;
        }
        this.prevStats.set(s.id, s);
      }
      if (s.type === "outbound-rtp" && s.kind === "video" && s.qualityLimitationReason && s.qualityLimitationReason !== "none") {
        q.limit = s.qualityLimitationReason;
      }
    });
    // "bandwidth" is reported briefly whenever the encoder ramps up; only surface it when the link is really thin.
    if (q.limit === "bandwidth" && (q.outKbps ?? 0) > 1200) delete q.limit;
    if (lost + recv > 0) q.lossPct = Math.round((1000 * lost) / (lost + recv)) / 10;
    if (dt > 0) q.inKbps = Math.round((8 * inBytes) / dt);
    const connected = this.pc.connectionState === "connected";
    if (!connected) q.level = "poor";
    else if ((q.rttMs ?? 0) > 400 || (q.lossPct ?? 0) > 8) q.level = "poor";
    else if ((q.rttMs ?? 0) > 200 || (q.lossPct ?? 0) > 2 || q.limit === "cpu") q.level = "fair";
    else q.level = "good";
    this.quality = q;
    this.onQuality();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.initTimer);
    clearTimeout(this.restartTimer);
    clearInterval(this.statsTimer);
    this.pc.onnegotiationneeded = this.pc.onicecandidate = this.pc.ontrack = null;
    this.pc.oniceconnectionstatechange = this.pc.onconnectionstatechange = this.pc.onsignalingstatechange = null;
    try { this.pc.close(); } catch { /* ignore */ }
  }
}
