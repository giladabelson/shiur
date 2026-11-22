// Room orchestration: signaling + one PeerLink per remote device (full mesh, at most a few devices).

import { PeerLink } from "./peer";
import { Signaling, isStudentSide, type PeerInfo, type PendingInfo, type Role, type SignalMsg, type SignalingState } from "./signaling";
import type { LocalMedia } from "./media";

export interface RemoteState {
  mic: boolean;
  cam: boolean;
  screen: boolean;
}

export interface Peer {
  link: PeerLink;
  info: PeerInfo;
  state: RemoteState;
}

const TURN_REFRESH_MS = 3 * 3600 * 1000;

export function deviceIds() {
  // sessionStorage: stable across reloads of this tab, different for each tab.
  let peerId = sessionStorage.getItem("shiur.peerId");
  if (!peerId) {
    peerId = crypto.randomUUID();
    sessionStorage.setItem("shiur.peerId", peerId);
  }
  return { peerId, sessionId: crypto.randomUUID() };
}

/**
 * This browser, stable across reloads and tabs (localStorage). The server remembers that the
 * teacher let it in, so a reload or reconnect mid-lesson doesn't go back to the waiting room.
 * (peerId is per tab and sessionId per page load, so neither can be used for that.)
 */
export function clientId(): string {
  try {
    let id = localStorage.getItem("shiur.clientId");
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem("shiur.clientId", id);
    }
    return id;
  } catch {
    return crypto.randomUUID();
  }
}

/** Where a student stands in the waiting room. */
export type LobbyState =
  | { kind: "connecting" }
  | { kind: "waiting"; teacherHere: boolean }
  | { kind: "admitted" }
  | { kind: "denied" };

export class Room {
  readonly peerId: string;
  readonly sessionId: string;
  readonly peers = new Map<string, Peer>();
  private roster = new Set<string>();
  /** Highest connection epoch used per remote page (peerId:sessionId), so rebuilt links never reuse one. */
  private epochs = new Map<string, number>();
  private sig: Signaling;
  private iceServers: RTCIceServer[] = [{ urls: "stun:stun.cloudflare.com:3478" }];
  private turnTimer: number | undefined;
  private forceRelay: boolean;

  onPeersChanged: () => void = () => {};
  onSignaling: (s: SignalingState) => void = () => {};
  /** Data-channel message from a peer. */
  onData: (peer: Peer, msg: any, channel: "ops" | "live") => void = () => {};
  /** A peer's reliable channel just opened (send it snapshots here). */
  onPeerReady: (peer: Peer) => void = () => {};
  /** Waiting room (students): waiting for the teacher, let in, or turned away. */
  onLobby: (s: LobbyState) => void = () => {};
  /** Waiting room (teacher devices): who is waiting to be let in. */
  onPending: (list: PendingInfo[]) => void = () => {};
  /** Teacher devices: a student couldn't be let in (the room is full). */
  onAdmitFailed: (peerId: string) => void = () => {};
  /** Student's computer: the key its own iPad joins with (from the server, once let in). */
  onPairToken: (token: string) => void = () => {};
  pairToken = "";
  lobby: LobbyState = { kind: "connecting" };
  pending: PendingInfo[] = [];

  constructor(
    readonly roomId: string,
    readonly role: Role,
    readonly name: string,
    readonly media: LocalMedia,
  ) {
    const ids = deviceIds();
    this.peerId = ids.peerId;
    this.sessionId = ids.sessionId;
    this.forceRelay = new URLSearchParams(location.search).has("relay");
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const q = new URLSearchParams({ peerId: this.peerId, sessionId: this.sessionId, role, name, client: clientId() });
    // The student's iPad: the key from the student's QR code lets it in without the waiting room.
    const pair = new URLSearchParams(location.search).get("pair");
    if (role === "sipad" && pair) q.set("pair", pair);
    this.sig = new Signaling(`${proto}//${location.host}/api/ws/${encodeURIComponent(roomId)}?${q}`);
    this.sig.onMessage = (m) => this.handleSignal(m);
    this.sig.onState = (s) => this.onSignaling(s);
  }

  async start() {
    await this.refreshTurn();
    this.turnTimer = window.setInterval(() => void this.refreshTurn(true), TURN_REFRESH_MS);
    this.sig.start();
    window.addEventListener("online", this.onOnline);
    window.addEventListener("pagehide", this.onPageHide);
  }

  leave() {
    this.broadcastOps({ t: "bye" });
    clearInterval(this.turnTimer);
    window.removeEventListener("online", this.onOnline);
    window.removeEventListener("pagehide", this.onPageHide);
    for (const p of this.peers.values()) p.link.close();
    this.peers.clear();
    this.sig.stop();
  }

  get signalingState() {
    return this.sig.state;
  }

  /** Teacher devices: let a waiting student into the lesson. */
  admit(peerId: string) {
    this.sig.send({ type: "admit", peerId });
  }

  /** Teacher devices: turn a waiting student away. */
  deny(peerId: string) {
    this.sig.send({ type: "deny", peerId });
  }

  /** Student's computer: ask the server for the key that lets this student's iPad in. */
  requestPairToken() {
    this.sig.send({ type: "pair" });
  }

  private setLobby(s: LobbyState) {
    this.lobby = s;
    this.onLobby(s);
  }

  private onOnline = () => {
    for (const p of this.peers.values()) p.link.restart();
  };

  private onPageHide = () => {
    this.broadcastOps({ t: "bye" });
  };

  private async refreshTurn(applyToLinks = false) {
    try {
      const r = await fetch("/api/turn", { cache: "no-store" });
      if (r.ok) {
        const j = await r.json();
        if (Array.isArray(j.iceServers) && j.iceServers.length) this.iceServers = j.iceServers;
      }
    } catch { /* keep the old servers */ }
    if (applyToLinks) for (const p of this.peers.values()) p.link.restart(this.iceServers);
  }

  /** Push the current local tracks and on/off state to every peer. */
  syncLocal() {
    const t = this.media.tracks();
    for (const p of this.peers.values()) void p.link.setTracks(t);
    this.broadcastOps({ t: "state", ...this.localState() });
  }

  localState(): RemoteState {
    return { mic: !!this.media.mic && !this.media.micMuted, cam: !!this.media.cam, screen: !!this.media.screen };
  }

  /** staffOnly: skip students (used for the teacher's private pages). */
  broadcastOps(msg: object, staffOnly = false) {
    for (const p of this.peers.values()) if (!staffOnly || !isStudentSide(p.info.role)) p.link.sendOps(msg);
  }

  broadcastLive(msg: object, staffOnly = false) {
    for (const p of this.peers.values()) if (!staffOnly || !isStudentSide(p.info.role)) p.link.sendLive(msg);
  }

  private handleSignal(m: SignalMsg) {
    switch (m.type) {
      case "waiting":
        this.setLobby({ kind: "waiting", teacherHere: m.teacherHere });
        break;
      case "denied":
        this.setLobby({ kind: "denied" });
        this.sig.stop();
        break;
      case "pending":
        this.pending = Array.isArray(m.list) ? m.list : [];
        this.onPending(this.pending);
        break;
      case "pair":
        if (typeof m.token === "string") {
          this.pairToken = m.token;
          this.onPairToken(m.token);
        }
        break;
      case "admit-failed":
        this.onAdmitFailed(m.peerId);
        break;
      case "welcome": {
        if (this.lobby.kind !== "admitted") this.setLobby({ kind: "admitted" });
        this.roster = new Set(m.peers.map((p) => p.peerId));
        for (const info of m.peers) this.ensurePeer(info, 0);
        // Peers we still have links to but that vanished while we were offline.
        for (const [id, p] of this.peers) {
          if (!this.roster.has(id) && p.link.state !== "connected") this.dropPeer(id);
        }
        break;
      }
      case "peer-joined":
        this.roster.add(m.peer.peerId);
        this.ensurePeer(m.peer, 0);
        break;
      case "peer-left": {
        const p = this.peers.get(m.peerId);
        if (p && p.info.sessionId === m.sessionId) {
          this.roster.delete(m.peerId);
          // Keep a still-working P2P link: losing signaling isn't losing media.
          if (p.link.state !== "connected") this.dropPeer(m.peerId);
        }
        break;
      }
      case "signal": {
        const epoch = Number(m.data?.epoch ?? 0);
        this.roster.add(m.from);
        const peer = this.ensurePeer(
          { peerId: m.from, sessionId: m.fromSession, role: m.fromRole, name: m.fromName },
          epoch,
          m.data?.description?.type === "offer",
        );
        if (!peer || epoch < peer.link.epoch) return; // stale message from an older connection
        const src = m.data?.src as string | undefined;
        if (src) {
          if (!peer.link.remotePcId) peer.link.remotePcId = src;
          else if (peer.link.remotePcId !== src) {
            // Remote rebuilt its connection without bumping the epoch: rebuild both sides at a new epoch.
            this.rebuild(peer);
            return;
          }
        }
        void peer.link.handleSignal(m.data);
        break;
      }
    }
  }

  private ensurePeer(info: PeerInfo, epoch: number, answering = false): Peer | null {
    if (info.peerId === this.peerId) return null;
    const existing = this.peers.get(info.peerId);
    if (existing) {
      const sameSession = existing.info.sessionId === info.sessionId;
      if (sameSession && epoch <= existing.link.epoch) return existing;
      // Remote reloaded (new session) or rebuilt its connection (higher epoch): start over.
      existing.link.close();
      this.peers.delete(info.peerId);
    }
    const key = `${info.peerId}:${info.sessionId}`;
    const used = this.epochs.get(key);
    // Re-creating a link to the same remote page (after we dropped it) must use a fresh epoch,
    // otherwise the remote would mix our new connection with its old one.
    if (used !== undefined && epoch <= used) epoch = used + 1;
    return this.createPeer(info, epoch, answering);
  }

  private rebuild(peer: Peer) {
    if (this.peers.get(peer.info.peerId) !== peer) return;
    peer.link.close();
    this.peers.delete(peer.info.peerId);
    this.createPeer(peer.info, peer.link.epoch + 1);
  }

  private createPeer(info: PeerInfo, epoch: number, answering = false): Peer {
    this.epochs.set(`${info.peerId}:${info.sessionId}`, Math.max(epoch, this.epochs.get(`${info.peerId}:${info.sessionId}`) ?? -1));
    const link = new PeerLink(
      this.peerId,
      info.peerId,
      info.sessionId,
      epoch,
      info.role,
      info.name,
      this.iceServers,
      (data) => this.sig.send({ type: "signal", to: info.peerId, data }),
      this.media.tracks(),
      this.forceRelay,
      answering,
    );
    const peer: Peer = { link, info, state: { mic: false, cam: false, screen: false } };
    link.onRemoteTracks = () => this.onPeersChanged();
    link.onConnState = () => this.onPeersChanged();
    link.onQuality = () => this.onPeersChanged();
    link.onOpsOpen = () => {
      link.sendOps({ t: "state", ...this.localState() });
      this.onPeerReady(peer);
      this.onPeersChanged();
    };
    link.onData = (msg, channel) => {
      if (msg.t === "state") {
        peer.state = { mic: !!msg.mic, cam: !!msg.cam, screen: !!msg.screen };
        this.onPeersChanged();
        return;
      }
      if (msg.t === "bye") {
        this.roster.delete(info.peerId);
        this.dropPeer(info.peerId);
        return;
      }
      this.onData(peer, msg, channel);
    };
    link.onNeedsReset = () => {
      if (this.peers.get(info.peerId)?.link !== link) return;
      if (!this.roster.has(info.peerId)) {
        this.dropPeer(info.peerId);
        return;
      }
      this.rebuild(peer);
    };
    this.peers.set(info.peerId, peer);
    this.onPeersChanged();
    return peer;
  }

  private dropPeer(peerId: string) {
    const p = this.peers.get(peerId);
    if (!p) return;
    p.link.close();
    this.peers.delete(peerId);
    this.onPeersChanged();
  }
}
