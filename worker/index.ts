import { DurableObject } from "cloudflare:workers";

export interface Env {
  ROOM: DurableObjectNamespace<Room>;
  ASSETS: Fetcher;
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
}

type Role = "teacher" | "student" | "ipad";
interface Att {
  peerId: string;
  sessionId: string;
  role: Role;
  name: string;
  joinedAt: number;
}

interface RTCIceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

const MAX_PEERS = 6;
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

    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;

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

/** One Durable Object per lesson room. It only relays signaling; media goes peer to peer. */
export class Room extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Answered by the runtime without waking the object.
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  private attachments(exceptPeerId?: string): Att[] {
    const out: Att[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as Att | null;
      if (a && a.peerId !== exceptPeerId) out.push(a);
    }
    return out;
  }

  private broadcast(msg: unknown, exceptPeerId?: string) {
    const s = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as Att | null;
      if (a && a.peerId !== exceptPeerId) {
        try { ws.send(s); } catch { /* socket already closing */ }
      }
    }
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

    // Same device reconnecting (network drop or a duplicate tab): drop the old socket quietly.
    for (const old of this.ctx.getWebSockets(`peer:${peerId}`)) {
      old.serializeAttachment(null);
      try { old.close(4001, "replaced"); } catch { /* ignore */ }
    }

    const others = this.attachments(peerId);
    if (others.length >= MAX_PEERS) return new Response("room full", { status: 403 });

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, [`peer:${peerId}`]);
    const me: Att = { peerId, sessionId, role, name, joinedAt: Date.now() };
    server.serializeAttachment(me);
    server.send(JSON.stringify({ type: "welcome", you: me, peers: others }));
    this.broadcast({ type: "peer-joined", peer: me }, peerId);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    if (typeof raw !== "string" || raw.length > 512 * 1024) return;
    const from = ws.deserializeAttachment() as Att | null;
    if (!from) return;
    let msg: { type?: string; to?: string; data?: unknown };
    try { msg = JSON.parse(raw); } catch { return; }

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
        try { t.send(out); } catch { /* ignore */ }
      }
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string) {
    const a = ws.deserializeAttachment() as Att | null;
    if (a) this.broadcast({ type: "peer-left", peerId: a.peerId, sessionId: a.sessionId }, a.peerId);
    try { ws.close(code === 1005 ? 1000 : code, reason); } catch { /* already closed */ }
  }

  async webSocketError(ws: WebSocket) {
    const a = ws.deserializeAttachment() as Att | null;
    if (a) this.broadcast({ type: "peer-left", peerId: a.peerId, sessionId: a.sessionId }, a.peerId);
    try { ws.close(1011, "error"); } catch { /* ignore */ }
  }
}
