// Teacher home: a permanent lesson link per student, plus the iPad link (with QR code).

import QRCode from "qrcode";
import { h, icon, toast, clear } from "./dom";

interface Student {
  id: string;
  name: string;
  room: string;
  created: number;
}

const KEY = "shiur.students";

function load(): Student[] {
  try { return JSON.parse(localStorage.getItem(KEY) || "[]"); } catch { return []; }
}
function save(list: Student[]) {
  localStorage.setItem(KEY, JSON.stringify(list));
}

export function newRoomId(): string {
  const a = new Uint8Array(9);
  crypto.getRandomValues(a);
  const abc = "abcdefghijkmnpqrstuvwxyz23456789";
  return Array.from(a, (b) => abc[b % abc.length]).join("");
}

export const roomUrl = (room: string, role?: string) =>
  `${location.origin}/r/${room}${role ? `?role=${role}` : ""}`;

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast("הקישור הועתק");
  } catch {
    prompt("העתק את הקישור:", text);
  }
}

function qrDialog(room: string, title: string) {
  const url = roomUrl(room, "ipad");
  const canvas = h("canvas", { class: "qr" });
  void QRCode.toCanvas(canvas, url, { width: 260, margin: 1 });
  const dlg = h("dialog", { class: "dlg" },
    h("h2", null, `חיבור האייפד: ${title}`),
    h("p", null, "סרוק עם המצלמה של האייפד, או פתח בו את הקישור ב-Safari:"),
    canvas,
    h("div", { class: "linkbox" }, h("code", null, url)),
    h("div", { class: "row" },
      h("button", { class: "btn", onclick: () => copy(url) }, "העתק קישור"),
      h("button", { class: "btn ghost", onclick: () => dlg.close() }, "סגור"),
    ),
  );
  dlg.addEventListener("close", () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
}

export function renderHome(root: HTMLElement) {
  document.title = "שיעור פרטי";
  let list = load();
  const listEl = h("div", { class: "students" });

  const draw = () => {
    clear(listEl);
    if (!list.length) {
      listEl.append(h("p", { class: "muted" }, "עוד אין תלמידים. הוסף תלמיד כדי לקבל לינק קבוע לשיעורים שלו."));
    }
    for (const s of list) {
      listEl.append(
        h("div", { class: "student card" },
          h("div", { class: "student-name" }, s.name),
          h("div", { class: "student-actions" },
            h("a", { class: "btn", href: `${roomUrl(s.room, "teacher")}&n=${encodeURIComponent(s.name)}` }, icon("cam", 18), " התחל שיעור"),
            h("button", { class: "btn ghost", onclick: () => copy(roomUrl(s.room)) }, icon("copy", 18), " לינק לתלמיד"),
            h("button", { class: "btn ghost", onclick: () => qrDialog(s.room, s.name) }, icon("ipad", 18), " חבר אייפד"),
            h("button", {
              class: "btn ghost danger",
              title: "מחק",
              onclick: () => {
                if (!confirm(`למחוק את ${s.name}? הלינק שלו יפסיק להופיע כאן.`)) return;
                list = list.filter((x) => x.id !== s.id);
                save(list);
                draw();
              },
            }, icon("trash", 18)),
          ),
        ),
      );
    }
  };

  const nameInput = h("input", { type: "text", placeholder: "שם התלמיד", maxlength: 40, class: "input" });
  const add = (e: Event) => {
    e.preventDefault();
    const name = nameInput.value.trim();
    if (!name) return nameInput.focus();
    list.unshift({ id: newRoomId(), name, room: newRoomId(), created: Date.now() });
    save(list);
    nameInput.value = "";
    draw();
  };

  clear(root);
  root.append(
    h("main", { class: "home" },
      h("header", { class: "home-head" },
        h("h1", null, "השיעורים שלי"),
        h("p", { class: "muted" }, "שיחת וידאו ישירה עם התלמיד, לוח משותף לעט של האייפד, ושיתוף מסך."),
      ),
      h("form", { class: "add card", onsubmit: add },
        nameInput,
        h("button", { class: "btn", type: "submit" }, icon("plus", 18), " הוסף תלמיד"),
      ),
      listEl,
      h("section", { class: "card quick" },
        h("h2", null, "שיעור מהיר"),
        h("p", { class: "muted" }, "חדר חד-פעמי בלי לשמור תלמיד."),
        h("button", { class: "btn ghost", onclick: () => { location.href = roomUrl(newRoomId(), "teacher"); } }, "פתח חדר חדש"),
      ),
      h("section", { class: "card tips" },
        h("h2", null, "לפני השיעור"),
        h("ul", null,
          h("li", null, "המחשב מחובר בכבל רשת אם אפשר, והאייפד על רשת 5GHz."),
          h("li", null, "האייפד מחובר לחשמל, ונעילה אוטומטית כבויה (הגדרות ← תצוגה ובהירות)."),
          h("li", null, "פתח במחשב את \"התחל שיעור\", ובאייפד את \"חבר אייפד\". האייפד נכנס בלי מיקרופון ורמקול כדי שלא יהיה הד."),
          h("li", null, "שלח לתלמיד את הלינק הקבוע שלו. הוא לא צריך להתקין כלום."),
        ),
      ),
    ),
  );
  draw();
}
