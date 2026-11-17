import { DurableObject } from "cloudflare:workers";

export interface Env {
  ROOM: DurableObjectNamespace<Room>;
  ASSETS: Fetcher;
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
  /** Optional R2 bucket for end-of-lesson PDFs (see README: "Lesson PDFs"). */
  LESSONS?: R2Bucket;
  /** How many days lesson PDFs are kept (default 30). */
  LESSON_KEEP_DAYS?: string;
}

type Role = "teacher" | "student" | "ipad";
interface Att {
  peerId: string;
  sessionId: string;
  role: Role;
  name: string;
  joinedAt: number;
  /**
   * Waiting room: a student is only announced to the others, and only gets signaling relayed,
   * once a teacher device lets them in. Teacher and iPad are always in.
   */
  admitted: boolean;
  /** Stable per browser (localStorage), so a reload or reconnect of an admitted student goes straight in. */
  clientId: string;
}

/** What other browsers see of a device (not its browser id). */
type PeerInfo = Omit<Att, "clientId">;

/** What the browser sees of a student in the waiting room. */
interface Pending {
  peerId: string;
  name: string;
  since: number;
}

interface RTCIceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

const MAX_PEERS = 6;
/** Students waiting to be let in at the same time (beyond that, new ones are turned away). */
const MAX_WAITING = 12;
/** How long "the teacher let this browser in" is remembered (a lesson day). */
const ADMIT_TTL = 12 * 3600_000;
const isStaff = (r: Role) => r === "teacher" || r === "ipad";
const ID_RE = /^[\w-]{6,64}$/;
const TURN_TTL = 6 * 3600;

export default {
  async fetch(req, env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname.startsWith("/api/ws/")) {
      if (req.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected websocket", { status: 426 });
      }
      const roomId = url.pathname.split("/")[3] ?? "";
      if (!ID_RE.test(roomId)) return new Response("bad room", { status: 400 });
      return env.ROOM.getByName(roomId).fetch(req);
    }

    if (url.pathname === "/api/turn") {
      return Response.json({ iceServers: await iceServers(env) }, {
        headers: { "Cache-Control": "no-store" },
      });
    }

    if (url.pathname === "/api/health") return new Response("ok");

    if (url.pathname.startsWith("/api/lessons/")) return lessons(req, env, url);

    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;

const LESSON_RE = /^[\w-]{4,40}$/;
const MAX_PDF = 40 * 1024 * 1024;
const MAX_LESSONS_PER_ROOM = 200;

/**
 * End-of-lesson PDFs, one per lesson, kept for LESSON_KEEP_DAYS:
 *   GET  /api/lessons/<room>                 list (JSON)
 *   PUT  /api/lessons/<room>/<lesson>        upload (body = PDF; ?name=&started=)
 *   GET  /api/lessons/<room>/<lesson>.pdf    download
 * The room id in the link is the key, like the lesson link itself.
 */
async function lessons(req: Request, env: Env, url: URL): Promise<Response> {
  const [, , , room = "", file = ""] = url.pathname.split("/");
  if (!ID_RE.test(room)) return new Response("bad room", { status: 400 });
  const bucket = env.LESSONS;
  if (!bucket) return Response.json({ enabled: false, items: [] }, { status: req.method === "GET" && !file ? 200 : 501 });
  const keepMs = (Number(env.LESSON_KEEP_DAYS) || 30) * 86400_000;

  if (!file && req.method === "GET") {
    const listed = await bucket.list({ prefix: `${room}/`, include: ["customMetadata"] });
    const items = [];
    const expired: string[] = [];
    for (const o of listed.objects) {
      if (Date.now() - o.uploaded.getTime() > keepMs) { expired.push(o.key); continue; }
      const lesson = o.key.slice(room.length + 1).replace(/\.pdf$/, "");
      items.push({
        lesson,
        name: o.customMetadata?.name ?? "",
        started: Number(o.customMetadata?.started) || o.uploaded.getTime(),
        pages: Number(o.customMetadata?.pages) || 0,
        size: o.size,
        uploaded: o.uploaded.getTime(),
        url: `/api/lessons/${room}/${lesson}.pdf`,
      });
    }
    if (expired.length) await bucket.delete(expired);
    items.sort((a, b) => b.started - a.started);
    return Response.json({ enabled: true, keepDays: keepMs / 86400_000, items }, { headers: { "Cache-Control": "no-store" } });
  }

  const lesson = file.replace(/\.pdf$/, "");
  if (!LESSON_RE.test(lesson)) return new Response("bad lesson", { status: 400 });
  const key = `${room}/${lesson}.pdf`;

  if (req.method === "PUT") {
    const len = Number(req.headers.get("Content-Length") || 0);
    if (len > MAX_PDF) return new Response("too large", { status: 413 });
    const body = await req.arrayBuffer();
    if (body.byteLength > MAX_PDF || body.byteLength < 8) return new Response("bad size", { status: 413 });
    if (new TextDecoder().decode(body.slice(0, 5)) !== "%PDF-") return new Response("not a pdf", { status: 415 });
    const count = (await bucket.list({ prefix: `${room}/`, limit: MAX_LESSONS_PER_ROOM + 1 })).objects.length;
    if (count >= MAX_LESSONS_PER_ROOM && !(await bucket.head(key))) return new Response("too many lessons", { status: 429 });
    await bucket.put(key, body, {
      httpMetadata: { contentType: "application/pdf" },
      customMetadata: {
        name: (url.searchParams.get("name") ?? "").slice(0, 120),
        started: String(Number(url.searchParams.get("started")) || Date.now()),
        pages: String(Number(url.searchParams.get("pages")) || 0),
      },
    });
    return Response.json({ ok: true, url: `/api/lessons/${room}/${lesson}.pdf` });
  }

  if (req.method === "GET") {
    const obj = await bucket.get(key);
    if (!obj || Date.now() - obj.uploaded.getTime() > keepMs) return new Response("not found", { status: 404 });
    const name = obj.customMetadata?.name || `lesson-${lesson}.pdf`;
    return new Response(obj.body, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="lesson.pdf"; filename*=UTF-8''${encodeURIComponent(name)}`,
        "Cache-Control": "private, max-age=300",
      },
    });
  }

  if (req.method === "DELETE") {
    await bucket.delete(key);
    return Response.json({ ok: true });
  }
  return new Response("method not allowed", { status: 405 });
}

async function iceServers(env: Env): Promise<RTCIceServer[]> {
  const stun: RTCIceServer[] = [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }];
  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) return stun;
  try {
    const r = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ttl: TURN_TTL }),
      },
    );
    if (!r.ok) return stun;
    const { iceServers } = (await r.json()) as { iceServers: RTCIceServer[] };
    // Browsers block port 53, which only causes slow ICE timeouts.
    for (const s of iceServers) {
      const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
      s.urls = urls.filter((u: string) => !/:53(\?|$)/.test(u));
    }
    return iceServers;
  } catch {
    return stun;
  }
}

/**
 * One Durable Object per lesson room. It only relays signaling; media goes peer to peer.
 * Students start in a waiting room: until a teacher device admits them they are invisible to the
 * others and nothing is relayed to or from them (so no WebRTC link, no video, no board).
 */
export class Room extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Answered by the runtime without waking the object.
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  private all(): { ws: WebSocket; a: Att }[] {
    const out: { ws: WebSocket; a: Att }[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as Att | null;
      if (a) out.push({ ws, a });
    }
    return out;
  }

  /** Devices in the lesson (admitted), except one. */
  private attachments(exceptPeerId?: string): PeerInfo[] {
    return this.all().filter(({ a }) => a.admitted && a.peerId !== exceptPeerId).map(({ a }) => publicInfo(a));
  }

  private broadcast(msg: unknown, exceptPeerId?: string) {
    const s = JSON.stringify(msg);
    for (const { ws, a } of this.all()) {
      if (a.admitted && a.peerId !== exceptPeerId) send(ws, s);
    }
  }

  private pendingList(): Pending[] {
    return this.all()
      .filter(({ a }) => !a.admitted)
      .map(({ a }) => ({ peerId: a.peerId, name: a.name, since: a.joinedAt }))
      .sort((x, y) => x.since - y.since);
  }

  /** Tell every teacher device who is waiting, and every waiting student whether a teacher is here. */
  private lobbyUpdate() {
    const all = this.all();
    const staffHere = all.some(({ a }) => isStaff(a.role));
    const pending = JSON.stringify({ type: "pending", list: this.pendingList() });
    const waiting = JSON.stringify({ type: "waiting", teacherHere: staffHere });
    for (const { ws, a } of all) {
      if (isStaff(a.role)) send(ws, pending);
      else if (!a.admitted) send(ws, waiting);
    }
  }

  private async wasAdmitted(clientId: string): Promise<boolean> {
    const at = await this.ctx.storage.get<number>(`admit:${clientId}`);
    if (!at) return false;
    if (Date.now() - at > ADMIT_TTL) {
      await this.ctx.storage.delete(`admit:${clientId}`);
      return false;
    }
    return true;
  }

  private async rememberAdmitted(clientId: string) {
    await this.ctx.storage.put(`admit:${clientId}`, Date.now());
    // Forget old admissions (a room is reused for every lesson with the same student).
    const old: string[] = [];
    for (const [k, v] of await this.ctx.storage.list<number>({ prefix: "admit:" })) {
      if (Date.now() - v > ADMIT_TTL) old.push(k);
    }
    if (old.length) await this.ctx.storage.delete(old.slice(0, 128));
  }

  /** Bring a socket into the lesson: welcome it and announce it to the others. */
  private enter(ws: WebSocket, me: Att) {
    me.admitted = true;
    ws.serializeAttachment(me);
    send(ws, JSON.stringify({ type: "welcome", you: publicInfo(me), peers: this.attachments(me.peerId) }));
    this.broadcast({ type: "peer-joined", peer: publicInfo(me) }, me.peerId);
  }

  async fetch(req: Request): Promise<Response> {
    const q = new URL(req.url).searchParams;
    const peerId = q.get("peerId") ?? "";
    const sessionId = q.get("sessionId") ?? "";
    const roleParam = q.get("role");
    const role: Role = roleParam === "teacher" || roleParam === "ipad" ? roleParam : "student";
    const name = (q.get("name") ?? "").slice(0, 40);
    if (!ID_RE.test(peerId) || !ID_RE.test(sessionId)) {
      return new Response("bad ids", { status: 400 });
    }
    // No (valid) browser id: still allowed, but the admission can't be remembered across page loads.
    const clientParam = q.get("client") ?? "";
    const clientId = ID_RE.test(clientParam) ? clientParam : `s-${sessionId}`;

    // Same device reconnecting (network drop or a duplicate tab): drop the old socket quietly.
    let replaced = false;
    for (const old of this.ctx.getWebSockets(`peer:${peerId}`)) {
      old.serializeAttachment(null);
      try { old.close(4001, "replaced"); } catch { /* ignore */ }
      replaced = true;
    }

    const admitted = isStaff(role) || (await this.wasAdmitted(clientId));
    if (admitted && this.attachments(peerId).length >= MAX_PEERS) return new Response("room full", { status: 403 });
    if (!admitted && this.pendingList().length >= MAX_WAITING) return new Response("room full", { status: 403 });

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, [`peer:${peerId}`]);
    const me: Att = { peerId, sessionId, role, name, joinedAt: Date.now(), admitted: false, clientId };
    server.serializeAttachment(me);
    if (admitted) this.enter(server, me);
    // Staff need the waiting list right away; waiting students need to know if a teacher is here.
    if (isStaff(role) || !admitted || replaced) this.lobbyUpdate();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    if (typeof raw !== "string" || raw.length > 512 * 1024) return;
    const from = ws.deserializeAttachment() as Att | null;
    if (!from) return;
    let msg: { type?: string; to?: string; peerId?: string; data?: unknown };
    try { msg = JSON.parse(raw); } catch { return; }

    // Nothing is relayed from someone still in the waiting room.
    if (!from.admitted) return;

    if (msg.type === "signal" && typeof msg.to === "string") {
      const out = JSON.stringify({
        type: "signal",
        from: from.peerId,
        fromSession: from.sessionId,
        fromRole: from.role,
        fromName: from.name,
        data: msg.data,
      });
      for (const t of this.ctx.getWebSockets(`peer:${msg.to}`)) {
        const ta = t.deserializeAttachment() as Att | null;
        if (ta?.admitted) send(t, out); // ...and nothing is relayed to them either
      }
      return;
    }

    // A teacher device lets a waiting student in, or turns them away.
    if ((msg.type === "admit" || msg.type === "deny") && isStaff(from.role) && typeof msg.peerId === "string") {
      for (const t of this.ctx.getWebSockets(`peer:${msg.peerId}`)) {
        const ta = t.deserializeAttachment() as Att | null;
        if (!ta || ta.admitted) continue;
        if (msg.type === "admit") {
          if (this.attachments(ta.peerId).length >= MAX_PEERS) {
            send(ws, JSON.stringify({ type: "admit-failed", peerId: ta.peerId, reason: "full" }));
            continue;
          }
          await this.rememberAdmitted(ta.clientId);
          this.enter(t, ta);
          // Other tabs of the same browser that are waiting too come in with it.
          for (const o of this.all()) {
            if (!o.a.admitted && o.a.clientId === ta.clientId && this.attachments(o.a.peerId).length < MAX_PEERS) this.enter(o.ws, o.a);
          }
        } else {
          send(t, JSON.stringify({ type: "denied" }));
          t.serializeAttachment(null);
          try { t.close(4003, "denied"); } catch { /* ignore */ }
        }
      }
      this.lobbyUpdate();
    }
  }

  private gone(a: Att) {
    if (a.admitted) this.broadcast({ type: "peer-left", peerId: a.peerId, sessionId: a.sessionId }, a.peerId);
    // A waiting student left, or the last teacher device did: update the waiting room.
    if (!a.admitted || isStaff(a.role)) this.lobbyUpdate();
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string) {
    const a = ws.deserializeAttachment() as Att | null;
    forget(ws);
    if (a) this.gone(a);
    try { ws.close(code === 1005 ? 1000 : code, reason); } catch { /* already closed */ }
  }

  async webSocketError(ws: WebSocket) {
    const a = ws.deserializeAttachment() as Att | null;
    forget(ws);
    if (a) this.gone(a);
    try { ws.close(1011, "error"); } catch { /* ignore */ }
  }
}

/** What other browsers see of a device (not its browser id or admission bookkeeping). */
function publicInfo(a: Att): PeerInfo {
  const { clientId: _c, ...rest } = a;
  return rest;
}

/** A closing socket no longer counts as being in the room (or as a teacher being here). */
function forget(ws: WebSocket) {
  try { ws.serializeAttachment(null); } catch { /* ignore */ }
}

function send(ws: WebSocket, s: string) {
  try { ws.send(s); } catch { /* socket already closing */ }
}
