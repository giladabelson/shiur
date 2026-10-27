// Lesson screen: pre-join check, then the call (video tiles, stage with board / shared screen, chat).

import { Board } from "../board/board";
import { BoardView } from "../board/view";
import { LocalMedia, listDevices, savePrefs, canShareScreen } from "../rtc/media";
import { Room, type Peer } from "../rtc/room";
import type { Role } from "../rtc/signaling";
import { buildToolbar } from "./toolbar";
import { h, icon, iconBtn, toast, clear, fmtDuration } from "./dom";

const ROLE_TITLE: Record<Role, string> = { teacher: "מורה", student: "תלמיד", ipad: "אייפד" };

export function renderLesson(root: HTMLElement, roomId: string, role: Role) {
  const media = new LocalMedia();
  const wantsAv = role !== "ipad";
  let micOn = wantsAv;
  let camOn = wantsAv;
  let name = localStorage.getItem("shiur.name." + role) || (role === "teacher" ? "המורה" : role === "ipad" ? "אייפד" : "");

  document.title = role === "student" ? "שיעור" : `שיעור (${ROLE_TITLE[role]})`;
  clear(root);

  // ---------- pre-join ----------
  const preview = h("video", { class: "preview mirror", autoplay: true, playsInline: true, muted: true });
  const meter = h("div", { class: "meter" }, h("span"));
  const err = h("div", { class: "err" });
  const nameInput = h("input", { class: "input", type: "text", value: name, maxlength: 40, placeholder: "השם שלך" });
  const micSel = h("select", { class: "input" });
  const camSel = h("select", { class: "input" });
  const micBtn = h("button", { class: "btn ghost", type: "button" });
  const camBtn = h("button", { class: "btn ghost", type: "button" });
  const joinBtn = h("button", { class: "btn big", type: "submit" }, "הצטרף לשיעור");
  let meterStop: (() => void) | null = null;

  const drawToggles = () => {
    micBtn.replaceChildren(icon(micOn ? "mic" : "micOff", 18), micOn ? " מיקרופון פועל" : " מיקרופון כבוי");
    camBtn.replaceChildren(icon(camOn ? "cam" : "camOff", 18), camOn ? " מצלמה פועלת" : " מצלמה כבויה");
    micBtn.classList.toggle("off", !micOn);
    camBtn.classList.toggle("off", !camOn);
  };

  const fillDevices = async () => {
    const d = await listDevices();
    micSel.replaceChildren(...d.mics.map((m, i) => h("option", { value: m.deviceId }, m.label || `מיקרופון ${i + 1}`)));
    camSel.replaceChildren(...d.cams.map((c, i) => h("option", { value: c.deviceId }, c.label || `מצלמה ${i + 1}`)));
    if (media.mic) micSel.value = media.mic.getSettings().deviceId ?? "";
    if (media.cam) camSel.value = media.cam.getSettings().deviceId ?? "";
  };

  const refreshPreview = async () => {
    err.textContent = "";
    if (micOn) {
      const e = await media.startMic();
      if (e) { err.textContent = "מיקרופון: " + e; micOn = false; }
    } else if (media.mic) {
      media.mic.stop();
      media.mic = null;
    }
    if (camOn) {
      const e = await media.startCam();
      if (e) { err.textContent += (err.textContent ? " · " : "") + "מצלמה: " + e; camOn = false; }
    } else media.stopCam();
    preview.srcObject = media.cam ? new MediaStream([media.cam]) : null;
    meterStop?.();
    meterStop = media.mic ? startMeter(media.mic, meter.firstElementChild as HTMLElement) : null;
    drawToggles();
    await fillDevices();
  };

  micBtn.onclick = () => { micOn = !micOn; void refreshPreview(); };
  camBtn.onclick = () => { camOn = !camOn; void refreshPreview(); };
  micSel.onchange = () => { media.prefs.micId = micSel.value; savePrefs(media.prefs); void refreshPreview(); };
  camSel.onchange = () => { media.prefs.camId = camSel.value; media.prefs.facing = undefined; savePrefs(media.prefs); void refreshPreview(); };

  const pre = h("main", { class: "prejoin" },
    h("form", {
      class: "card prejoin-card",
      onsubmit: (e: Event) => {
        e.preventDefault();
        name = nameInput.value.trim();
        if (!name) { nameInput.focus(); err.textContent = "צריך לכתוב שם"; return; }
        localStorage.setItem("shiur.name." + role, name);
        meterStop?.();
        joinBtn.disabled = true;
        void enterCall();
      },
    },
      h("h1", null, role === "ipad" ? "חיבור האייפד לשיעור" : "בדיקה לפני השיעור"),
      role === "ipad"
        ? h("div", { class: "muted ipad-tips" },
          h("p", null, "באייפד המיקרופון והרמקול כבויים כדי שלא יהיה הד עם המחשב. כאן כותבים על הלוח עם העט."),
          h("p", null, "חשוב: כדי שהעט לא יפספס קווים, כבה את Scribble: הגדרות ← Apple Pencil ← Scribble (כבוי)."),
          h("p", null, "טיפ: נעילה אוטומטית ← אף פעם, והאייפד מחובר לחשמל."),
        )
        : null,
      h("div", { class: "preview-wrap" }, preview, meter),
      h("label", { class: "field" }, h("span", null, "שם"), nameInput),
      h("div", { class: "row" }, micBtn, camBtn),
      h("label", { class: "field" }, h("span", null, "מיקרופון"), micSel),
      h("label", { class: "field" }, h("span", null, "מצלמה"), camSel),
      err,
      joinBtn,
    ),
  );
  root.append(pre);
  drawToggles();
  void refreshPreview();

  // ---------- in call ----------
  async function enterCall() {
    const room = new Room(roomId, role, name, media);
    (window as any).__room = room;
    const board = new Board(roomId, room.peerId, {
      broadcastOps: (m) => room.broadcastOps(m),
      broadcastLive: (m) => room.broadcastLive(m),
      sendTo: async (peerId, m) => room.peers.get(peerId)?.link.sendOpsPaced(m) ?? false,
    });
    (window as any).__board = board;
    board.onNotice = (t) => toast(t);
    const view = new BoardView(board);
    view.canDraw = () => board.canDraw(role);
    const toolbar = buildToolbar(board, view, { isTeacher: role === "teacher", roomName: "שיעור" });
    board.onChange = (what, strokeId) => {
      view.invalidate(what, strokeId);
      if (what !== "live" && what !== "stroke") toolbar.refresh();
      if (what === "lock") {
        updateLockBanner();
        if (role === "student") toast(board.state.lock.on ? "המורה נעל את הלוח" : "אפשר לכתוב על הלוח");
      }
    };
    await board.load();

    const started = Date.now();
    const timerEl = h("span", { class: "timer", title: "זמן השיעור" }, "00:00");
    const netEl = h("span", { class: "net" });
    const lockBanner = h("div", { class: "lockbanner", hidden: true }, icon("lock", 16), " המורה נעל את הלוח");
    const updateLockBanner = () => { lockBanner.hidden = !(role === "student" && board.state.lock.on); };
    updateLockBanner();

    // stage: board or a shared screen
    let stageSel: "board" | string = "board";
    let manualStage = false;
    const tabs = h("div", { class: "stage-tabs" });
    const boardWrap = h("div", { class: "board-wrap" }, toolbar.el, h("div", { class: "board-host" }, view.el, lockBanner));
    const screenVideo = h("video", { class: "screen-video", autoplay: true, playsInline: true, muted: true });
    const screenWrap = h("div", { class: "screen-wrap", hidden: true },
      screenVideo,
      iconBtn("full", "מסך מלא", () => void (screenWrap.requestFullscreen?.() ?? (screenVideo as any).webkitEnterFullscreen?.()), "floating"),
    );
    const stage = h("section", { class: "stage" }, tabs, h("div", { class: "stage-body" }, boardWrap, screenWrap));

    // tiles
    const tiles = h("aside", { class: "tiles" });
    const selfVideo = h("video", { class: "mirror", autoplay: true, playsInline: true, muted: true });
    const selfTile = h("div", { class: "tile self" }, selfVideo, h("div", { class: "tile-name" }, `${name} (אני)`));
    const audioBox = h("div", { hidden: true });
    let speakerOn = role !== "ipad";
    let speakerSink = "";

    // chat
    const chatLog = h("div", { class: "chat-log" });
    const chatInput = h("input", { class: "input", type: "text", placeholder: "הודעה…", maxlength: 1000 });
    const chatBadge = h("span", { class: "badge", hidden: true });
    let unread = 0;
    const chatPanel = h("aside", { class: "chat", hidden: true },
      h("div", { class: "chat-head" }, h("strong", null, "צ'אט"), iconBtn("prev", "סגור", () => toggleChat(false))),
      chatLog,
      h("form", {
        class: "chat-form",
        onsubmit: (e: Event) => {
          e.preventDefault();
          const text = chatInput.value.trim();
          if (!text) return;
          chatInput.value = "";
          const msg = { t: "chat", text, name, ts: Date.now() };
          room.broadcastOps(msg);
          addChat(msg, true);
        },
      }, chatInput, h("button", { class: "btn", type: "submit" }, "שלח")),
    );
    const addChat = (m: { text: string; name: string; ts: number }, mine: boolean) => {
      const time = new Date(m.ts).toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" });
      const text = h("div", { class: "chat-text" });
      // Linkify without innerHTML.
      for (const part of String(m.text).split(/(https?:\/\/\S+)/g)) {
        if (/^https?:\/\//.test(part)) text.append(h("a", { href: part, target: "_blank", rel: "noopener" }, part));
        else if (part) text.append(part);
      }
      chatLog.append(h("div", { class: `chat-msg ${mine ? "mine" : ""}` },
        h("div", { class: "chat-meta" }, `${m.name} · ${time}`), text));
      while (chatLog.children.length > 300) chatLog.firstElementChild?.remove();
      chatLog.scrollTop = chatLog.scrollHeight;
      if (!mine && chatPanel.hidden) {
        unread++;
        chatBadge.textContent = String(unread);
        chatBadge.hidden = false;
        toast(`${m.name}: ${String(m.text).slice(0, 80)}`);
      }
    };
    const toggleChat = (show = chatPanel.hidden) => {
      chatPanel.hidden = !show;
      if (show) {
        unread = 0;
        chatBadge.hidden = true;
        chatInput.focus();
      }
    };

    // controls
    const micCtl = iconBtn("mic", "מיקרופון", () => {
      if (!media.mic) {
        void media.startMic().then((e) => { if (e) toast(e); room.syncLocal(); drawControls(); });
        return;
      }
      media.setMicMuted(!media.micMuted);
      room.syncLocal();
      drawControls();
    }, "ctl");
    const camCtl = iconBtn("cam", "מצלמה", () => {
      if (media.cam) media.stopCam();
      else {
        void media.startCam().then((e) => { if (e) toast(e); room.syncLocal(); drawControls(); });
        return;
      }
      room.syncLocal();
      drawControls();
    }, "ctl");
    const flipCtl = iconBtn("flip", "החלף מצלמה (קדמית / אחורית)", () => {
      media.prefs.facing = media.prefs.facing === "environment" ? "user" : "environment";
      media.prefs.camId = undefined;
      savePrefs(media.prefs);
      void media.startCam().then((e) => { if (e) toast(e); room.syncLocal(); drawControls(); });
    }, "ctl");
    const screenCtl = iconBtn("screen", "שיתוף מסך", () => {
      if (media.screen) {
        media.stopScreen();
        room.syncLocal();
        drawControls();
        return;
      }
      void media.startScreen().then((e) => {
        if (e) toast(e);
        if (media.screen) toast(role === "ipad" ? "מסך האייפד משותף. אפשר לעבור לאפליקציה אחרת." : "המסך משותף");
        room.syncLocal();
        drawControls();
      });
    }, "ctl");
    const speakerCtl = iconBtn("speaker", "רמקול", () => {
      speakerOn = !speakerOn;
      for (const a of audioBox.querySelectorAll("audio")) (a as HTMLAudioElement).muted = !speakerOn;
      drawControls();
    }, "ctl");
    const chatCtl = iconBtn("chat", "צ'אט", () => toggleChat(), "ctl");
    chatCtl.append(chatBadge);
    const tilesCtl = iconBtn("cam", "הצג / הסתר וידאו", () => { tiles.hidden = !tiles.hidden; }, "ctl");
    const infoCtl = iconBtn("gear", "הגדרות ואיכות חיבור", () => openSettings(), "ctl");
    const leaveCtl = h("button", { class: "btn danger leave", type: "button", onclick: () => leave() }, icon("leave", 18), " יציאה");

    const drawControls = () => {
      const micLive = !!media.mic && !media.micMuted;
      micCtl.replaceChildren(icon(micLive ? "mic" : "micOff"));
      micCtl.classList.toggle("off", !micLive);
      camCtl.replaceChildren(icon(media.cam ? "cam" : "camOff"));
      camCtl.classList.toggle("off", !media.cam);
      screenCtl.classList.toggle("on", !!media.screen);
      screenCtl.title = media.screen ? "הפסק שיתוף" : role === "ipad" ? "שתף את מסך האייפד" : "שתף מסך או חלון";
      speakerCtl.replaceChildren(icon(speakerOn ? "speaker" : "speakerOff"));
      speakerCtl.classList.toggle("off", !speakerOn);
      selfVideo.srcObject = media.cam ? new MediaStream([media.cam]) : null;
      selfTile.classList.toggle("nocam", !media.cam);
    };
    media.onScreenEnded = () => { room.syncLocal(); drawControls(); };

    const controls = h("footer", { class: "controls" },
      micCtl, camCtl,
      role === "ipad" ? flipCtl : null,
      canShareScreen() ? screenCtl : null,
      speakerCtl, chatCtl,
      role === "ipad" ? tilesCtl : null,
      infoCtl, leaveCtl,
    );
    if (role === "ipad") tiles.hidden = true;

    const topbar = h("header", { class: "topbar" },
      h("strong", null, role === "student" ? "שיעור" : `שיעור · ${ROLE_TITLE[role]}`),
      timerEl, netEl,
    );
    const statusBanner = h("div", { class: "status-banner", hidden: true });
    const unlockAudio = h("button", { class: "btn audio-unlock", hidden: true, onclick: () => playAll() }, icon("speaker", 18), " לחץ כאן כדי לשמוע");

    clear(root);
    root.append(h("div", { class: `lesson role-${role}` },
      topbar, statusBanner,
      h("div", { class: "lesson-body" }, stage, tiles, chatPanel),
      controls, audioBox, unlockAudio,
    ));
    tiles.append(selfTile);

    // ---------- peers ----------
    const tileEls = new Map<string, { tile: HTMLElement; video: HTMLVideoElement; audio: HTMLAudioElement; nameEl: HTMLElement; dot: HTMLElement; micIcon: HTMLElement }>();

    const playAll = () => {
      let blocked = false;
      for (const v of document.querySelectorAll("video, audio")) {
        const m = v as HTMLMediaElement;
        if (m.srcObject && m.paused) m.play().catch(() => { if (m.tagName === "AUDIO" && !m.muted) blocked = true; unlockAudio.hidden = !blocked; });
      }
      if (!blocked) unlockAudio.hidden = true;
    };

    const setSrc = (el: HTMLMediaElement, track: MediaStreamTrack | undefined) => {
      const cur = (el.srcObject as MediaStream | null)?.getTracks()[0];
      if (cur === track) return;
      el.srcObject = track ? new MediaStream([track]) : null;
      if (track) el.play().catch(() => { if (el.tagName === "AUDIO" && !el.muted) unlockAudio.hidden = false; });
    };

    const screenOf = (p: Peer) => (p.state.screen ? p.link.remoteTracks().screen : undefined);

    const updatePeers = () => {
      const peers = [...room.peers.values()];
      // tiles: everyone except iPads with no camera
      for (const p of peers) {
        let t = tileEls.get(p.info.peerId);
        if (!t) {
          const video = h("video", { autoplay: true, playsInline: true, muted: true });
          const audio = h("audio", { autoplay: true });
          audio.muted = !speakerOn;
          const nameEl = h("span");
          const dot = h("span", { class: "qdot" });
          const micIcon = h("span", { class: "tile-mic" }, icon("micOff", 14));
          const tile = h("div", { class: "tile" }, video, h("div", { class: "tile-name" }, dot, nameEl, micIcon));
          tiles.insertBefore(tile, selfTile);
          audioBox.append(audio);
          if (speakerSink) void (audio as any).setSinkId?.(speakerSink).catch(() => {});
          t = { tile, video, audio, nameEl, dot, micIcon };
          tileEls.set(p.info.peerId, t);
        }
        const rt = p.link.remoteTracks();
        setSrc(t.video, p.state.cam ? rt.cam : undefined);
        setSrc(t.audio, rt.mic);
        t.nameEl.textContent = p.info.name || ROLE_TITLE[p.info.role];
        t.tile.classList.toggle("nocam", !p.state.cam || !rt.cam);
        t.tile.hidden = p.info.role === "ipad" && !p.state.cam;
        t.micIcon.hidden = p.state.mic;
        const q = p.link.quality;
        const conn = p.link.state;
        t.dot.className = `qdot ${conn === "connected" ? q.level : conn === "failed" || conn === "disconnected" ? "poor" : "unknown"}`;
        t.dot.title = conn !== "connected" ? "מתחבר…" : qualityText(q);
        t.tile.classList.toggle("reconnecting", conn !== "connected");
      }
      for (const [id, t] of tileEls) {
        if (!room.peers.has(id)) {
          t.tile.remove();
          t.audio.remove();
          tileEls.delete(id);
        }
      }
      // stage tabs
      const sharers = peers.filter((p) => screenOf(p));
      if (stageSel !== "board" && !sharers.some((p) => p.info.peerId === stageSel)) {
        if (stageSel !== "board") toast("שיתוף המסך הסתיים");
        stageSel = "board";
        manualStage = false;
      }
      if (stageSel === "board" && sharers.length && !manualStage) {
        const s = sharers[sharers.length - 1];
        stageSel = s.info.peerId;
        toast(`${s.info.name || ROLE_TITLE[s.info.role]} משתף מסך`);
      }
      tabs.replaceChildren(
        h("button", { class: `tab ${stageSel === "board" ? "on" : ""}`, type: "button", onclick: () => { stageSel = "board"; manualStage = true; updatePeers(); } }, icon("board", 16), " לוח"),
        ...sharers.map((p) => h("button", {
          class: `tab ${stageSel === p.info.peerId ? "on" : ""}`, type: "button",
          onclick: () => { stageSel = p.info.peerId; manualStage = false; updatePeers(); },
        }, icon("screen", 16), ` המסך של ${p.info.name || ROLE_TITLE[p.info.role]}`)),
      );
      tabs.hidden = sharers.length === 0;
      const sel = sharers.find((p) => p.info.peerId === stageSel);
      boardWrap.hidden = !!sel;
      screenWrap.hidden = !sel;
      setSrc(screenVideo, sel ? screenOf(sel) : undefined);
      updateStatus();
    };

    const updateStatus = () => {
      const peers = [...room.peers.values()];
      const connected = peers.filter((p) => p.link.state === "connected");
      const others = connected.filter((p) => p.info.role !== "ipad" || role === "ipad");
      let text = "";
      if (room.signalingState !== "open" && connected.length === 0) text = "מתחבר לשרת…";
      else if (peers.some((p) => p.link.state !== "connected" && p.link.state !== "new")) text = "החיבור נחלש, מתחבר מחדש…";
      else if (peers.length === 0) text = role === "student" ? "מחכים למורה…" : "מחכים שהתלמיד יצטרף…";
      statusBanner.textContent = text;
      statusBanner.hidden = !text;
      netEl.textContent = others.length ? `${others.length + 1} בשיעור` : "";
    };

    room.onPeersChanged = updatePeers;
    room.onSignaling = updateStatus;
    room.onPeerReady = (p) => void board.sendSnapshot(p.info.peerId);
    room.onData = (p, msg) => {
      if (msg.t === "chat") addChat(msg, false);
      else if (typeof msg.t === "string" && msg.t.startsWith("b.")) board.handleRemote(p.info.peerId, msg);
    };
    media.onChange = () => drawControls();

    drawControls();
    await room.start();
    room.syncLocal();
    updatePeers();
    playAll();

    // timer + keep-awake
    const timer = setInterval(() => { timerEl.textContent = fmtDuration(Date.now() - started); }, 1000);
    let wake: any = null;
    const keepAwake = async () => {
      try { wake = await (navigator as any).wakeLock?.request("screen"); } catch { /* not supported / denied */ }
    };
    void keepAwake();
    const onVis = () => {
      if (document.visibilityState === "visible") {
        void keepAwake();
        playAll();
        // iOS may have stopped the camera while we were in the background.
        if (camOn && media.cam?.readyState === "ended") void media.startCam().then(() => room.syncLocal());
      }
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("beforeunload", (e) => {
      if (room.peers.size) e.preventDefault();
    });

    // ---------- settings ----------
    function openSettings() {
      const body = h("div", { class: "settings" });
      const dlg = h("dialog", { class: "dlg" }, h("h2", null, "הגדרות וחיבור"), body,
        h("div", { class: "row" }, h("button", { class: "btn", type: "button", onclick: () => dlg.close() }, "סגור")));
      dlg.addEventListener("close", () => { clearInterval(iv); dlg.remove(); });
      const draw = async () => {
        const d = await listDevices();
        const mk = (label: string, list: MediaDeviceInfo[], cur: string, on: (id: string) => void) => {
          if (!list.length) return null;
          const s = h("select", { class: "input", onchange: () => on(s.value) },
            ...list.map((x, i) => h("option", { value: x.deviceId, selected: x.deviceId === cur }, x.label || `${label} ${i + 1}`)));
          return h("label", { class: "field" }, h("span", null, label), s);
        };
        const conn = [...room.peers.values()].map((p) =>
          h("div", { class: "connrow" },
            h("strong", null, p.info.name || ROLE_TITLE[p.info.role]), " ",
            h("span", { class: `qdot ${p.link.quality.level}` }), " ",
            p.link.state === "connected" ? qualityText(p.link.quality) : `מצב: ${p.link.state}`,
          ));
        body.replaceChildren(
          mk("מיקרופון", d.mics, media.mic?.getSettings().deviceId ?? "", (id) => {
            media.prefs.micId = id; savePrefs(media.prefs);
            void media.startMic().then(() => room.syncLocal());
          }) ?? "",
          mk("מצלמה", d.cams, media.cam?.getSettings().deviceId ?? "", (id) => {
            media.prefs.camId = id; savePrefs(media.prefs);
            void media.startCam().then(() => room.syncLocal());
          }) ?? "",
          ("setSinkId" in HTMLMediaElement.prototype ? mk("רמקול", d.speakers, speakerSink, (id) => {
            speakerSink = id;
            for (const a of audioBox.querySelectorAll("audio")) void (a as any).setSinkId(id).catch(() => {});
          }) : null) ?? "",
          h("h3", null, "איכות החיבור"),
          ...(conn.length ? conn : [h("p", { class: "muted" }, "אין עדיין משתתפים מחוברים")]),
          h("p", { class: "muted small" }, "\"ישיר\" = הווידאו עובר ישר ביניכם (הכי מהיר). \"דרך שרת\" = עובר דרך שרת עזר כי הרשת חוסמת חיבור ישיר."),
        );
      };
      const iv = setInterval(() => void draw(), 2000);
      void draw();
      document.body.append(dlg);
      dlg.showModal();
    }

    function leave() {
      if (!confirm("לצאת מהשיעור?")) return;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVis);
      room.leave();
      media.stopAll();
      view.destroy();
      try { wake?.release?.(); } catch { /* ignore */ }
      clear(root);
      root.append(h("main", { class: "prejoin" }, h("div", { class: "card prejoin-card" },
        h("h1", null, "יצאת מהשיעור"),
        h("p", { class: "muted" }, `משך: ${fmtDuration(Date.now() - started)}`),
        h("button", { class: "btn", onclick: () => location.reload() }, "חזרה לשיעור"),
        role === "teacher" ? h("a", { class: "btn ghost", href: "/" }, "למסך הראשי") : null,
      )));
    }
  }
}

function qualityText(q: Peer["link"]["quality"]): string {
  const parts: string[] = [];
  parts.push(q.level === "good" ? "חיבור טוב" : q.level === "fair" ? "חיבור בינוני" : q.level === "poor" ? "חיבור חלש" : "בודק…");
  if (q.rttMs != null) parts.push(`השהיה ${q.rttMs}ms`);
  if (q.lossPct != null) parts.push(`איבוד ${q.lossPct}%`);
  if (q.path) parts.push(q.path === "relay" ? "דרך שרת" : "ישיר");
  if (q.res) parts.push(`${q.res}${q.fps ? `@${q.fps}` : ""}`);
  if (q.limit === "cpu") parts.push("המחשב עמוס");
  else if (q.limit === "bandwidth") parts.push("רוחב פס מוגבל");
  return parts.join(" · ");
}

function startMeter(track: MediaStreamTrack, bar: HTMLElement): () => void {
  let ctx: AudioContext | null = null;
  let raf = 0;
  try {
    ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(new MediaStream([track]));
    const an = ctx.createAnalyser();
    an.fftSize = 512;
    src.connect(an);
    const buf = new Uint8Array(an.fftSize);
    const loop = () => {
      an.getByteTimeDomainData(buf);
      let peak = 0;
      for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
      bar.style.width = `${Math.min(100, (peak / 128) * 160)}%`;
      raf = requestAnimationFrame(loop);
    };
    loop();
  } catch { /* no meter */ }
  return () => {
    cancelAnimationFrame(raf);
    void ctx?.close();
  };
}
