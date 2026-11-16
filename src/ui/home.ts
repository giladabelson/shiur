// Teacher home: a permanent lesson link per student, plus the iPad link (with QR code).

import QRCode from "qrcode";
import { h, icon, toast, clear } from "./dom";
import { openLessonsDialog } from "./lessons-dialog";
import { askPhone } from "./phone-dialog";
import { inviteText, loadStudents, openWhatsApp, roomUrl, saveStudents, waNumber, type Student } from "./students";

export { roomUrl } from "./students";

export function newRoomId(): string {
  const a = new Uint8Array(9);
  crypto.getRandomValues(a);
  const abc = "abcdefghijkmnpqrstuvwxyz23456789";
  return Array.from(a, (b) => abc[b % abc.length]).join("");
}

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

/** Hand-drawn physics doodles in the notebook's margin (decoration only). */
function doodles(): HTMLElement {
  const wrap = h("div", { class: "doodles", "aria-hidden": "true" });
  wrap.innerHTML = `
  <svg direction="ltr" class="d1" viewBox="0 0 160 90" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M6 70 L150 70"/><path d="M144 65 L151 70 L144 75"/>
    <path d="M10 70 C 25 18, 40 18, 55 70 S 85 122, 100 70 S 130 18, 145 70" opacity=".9"/>
  </svg>
  <svg direction="ltr" class="d2" viewBox="0 0 120 130" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
    <path d="M20 10 L100 10"/><path d="M60 10 L88 92"/><circle cx="92" cy="104" r="11"/>
    <path d="M60 10 L60 70" stroke-dasharray="4 6" opacity=".6"/><path d="M60 40 A 30 30 0 0 0 70 38" />
    <text x="70" y="52" font-size="16" fill="currentColor" stroke="none" font-family="inherit">θ</text>
  </svg>
  <svg direction="ltr" class="d3" viewBox="0 0 150 60" fill="currentColor">
    <text x="4" y="40" font-size="34" font-family="inherit">F = ma</text>
    <path d="M6 50 C 40 56, 90 44, 140 50" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity=".5"/>
  </svg>
  <svg direction="ltr" class="d4" viewBox="0 0 120 120" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M14 106 L106 106"/><path d="M14 106 L100 40"/><rect x="48" y="58" width="26" height="18" transform="rotate(-37 61 67)"/>
    <path d="M58 70 L50 92"/><path d="M47 86 L50 93 L55 87"/>
  </svg>`;
  return wrap;
}

export function renderHome(root: HTMLElement) {
  document.title = "השיעורים שלי";
  document.documentElement.classList.add("on-home");
  let list = loadStudents();
  const listEl = h("div", { class: "students" });
  const persist = () => saveStudents(list);

  const draw = () => {
    clear(listEl);
    if (!list.length) {
      listEl.append(h("div", { class: "empty" },
        h("p", { class: "hand" }, "עוד אין כאן תלמידים."),
        h("p", { class: "muted" }, "מוסיפים תלמיד, ומקבלים לינק קבוע לשיעורים שלו. שולחים לו אותו פעם אחת בוואטסאפ, וזהו."),
      ));
    }
    list.forEach((s, i) => listEl.append(card(s, i)));
  };

  const card = (s: Student, i: number) => {
    const phoneBtn = h("button", {
      class: "phone-chip", type: "button", title: "מספר הוואטסאפ של התלמיד",
      onclick: async () => { await askPhone(s.room, s.name); list = loadStudents(); draw(); },
    }, icon("phone", 14), s.phone ? ` ${s.phone}` : " הוסף מספר וואטסאפ");
    return h("article", { class: `student card tab-${i % 5}` },
      h("div", { class: "student-head" },
        h("div", { class: "student-name" }, s.name),
        phoneBtn,
        h("button", {
          class: "ibtn del-student",
          type: "button",
          title: "מחק",
          "aria-label": `מחק את ${s.name}`,
          onclick: () => {
            if (!confirm(`למחוק את ${s.name}? הלינק שלו יפסיק להופיע כאן.`)) return;
            list = list.filter((x) => x.id !== s.id);
            persist();
            draw();
          },
        }, icon("trash", 18)),
      ),
      h("div", { class: "student-actions" },
        h("a", { class: "btn", href: `${roomUrl(s.room, "teacher")}&n=${encodeURIComponent(s.name)}` }, icon("cam", 18), " התחל שיעור"),
        h("button", {
          class: "btn wa", type: "button", title: "פותח את הצ'אט עם התלמיד בוואטסאפ, עם הלינק לשיעור",
          onclick: async () => {
            let phone = s.phone;
            if (!phone) { phone = (await askPhone(s.room, s.name)) ?? undefined; list = loadStudents(); draw(); }
            if (phone) openWhatsApp(phone, inviteText(s.name, s.room));
          },
        }, icon("wa", 18), " לינק בוואטסאפ"),
        h("button", { class: "btn ghost", type: "button", onclick: () => copy(roomUrl(s.room)) }, icon("copy", 18), " לינק לתלמיד"),
        h("button", { class: "btn ghost", type: "button", onclick: () => qrDialog(s.room, s.name) }, icon("ipad", 18), " חבר אייפד"),
        h("button", { class: "btn ghost", type: "button", onclick: () => openLessonsDialog(s.room, s.name) }, icon("history", 18), " שיעורים קודמים"),
      ),
    );
  };

  const nameInput = h("input", { type: "text", placeholder: "שם התלמיד", maxlength: 40, class: "input" });
  const phoneInput = h("input", { type: "tel", inputmode: "tel", dir: "ltr", placeholder: "טלפון (וואטסאפ)", maxlength: 20, required: true, class: "input phone-in" });
  const addErr = h("div", { class: "err add-err", role: "alert" });
  const add = (e: Event) => {
    e.preventDefault();
    const name = nameInput.value.trim();
    if (!name) return nameInput.focus();
    const phone = phoneInput.value.trim();
    if (!waNumber(phone)) {
      addErr.textContent = phone ? "המספר לא נראה תקין. למשל 050-1234567" : "צריך את הטלפון של התלמיד, כדי לשלוח לו את הלינק בוואטסאפ";
      return phoneInput.focus();
    }
    addErr.textContent = "";
    const room = newRoomId();
    list.unshift({ id: newRoomId(), name, room, created: Date.now(), phone });
    persist();
    nameInput.value = "";
    phoneInput.value = "";
    draw();
    // straight to the student's WhatsApp chat with the lesson link ready to send
    openWhatsApp(phone, inviteText(name, room));
  };

  clear(root);
  root.append(
    h("main", { class: "home" },
      h("header", { class: "home-head" },
        doodles(),
        h("p", { class: "eyebrow" }, new Date().toLocaleDateString("he-IL", { weekday: "long", day: "numeric", month: "long" })),
        h("h1", null, h("span", { class: "hl" }, "השיעורים שלי")),
        h("p", { class: "lead" }, "וידאו עם התלמיד, לוח משותף שכותבים עליו עם העט של האייפד, ודף עבודה פתוח בצד."),
      ),
      h("form", { class: "add card", onsubmit: add, novalidate: true },
        h("label", { class: "add-label hand", for: "new-student" }, "תלמיד חדש"),
        h("div", { class: "add-row" },
          Object.assign(nameInput, { id: "new-student" }),
          phoneInput,
          h("button", { class: "btn", type: "submit" }, icon("plus", 18), " הוסף ושלח בוואטסאפ"),
        ),
        addErr,
      ),
      listEl,
      h("div", { class: "notes" },
        h("section", { class: "note quick" },
          h("h2", { class: "hand" }, "שיעור מהיר"),
          h("p", null, "חדר חד-פעמי, בלי לשמור תלמיד."),
          h("button", { class: "btn ghost", type: "button", onclick: () => { location.href = roomUrl(newRoomId(), "teacher"); } }, icon("plus", 18), " פתח חדר חדש"),
        ),
        h("section", { class: "note tips" },
          h("h2", { class: "hand" }, "לפני השיעור"),
          h("ul", null,
            h("li", null, "המחשב בכבל רשת אם אפשר, והאייפד על רשת 5GHz."),
            h("li", null, "האייפד מחובר לחשמל, ונעילה אוטומטית כבויה."),
            h("li", null, "במחשב: \"התחל שיעור\". באייפד: \"חבר אייפד\" (בלי מיקרופון ורמקול, כדי שלא יהיה הד)."),
            h("li", null, "התלמיד נכנס מהלינק הקבוע שלו. לא צריך להתקין כלום."),
          ),
        ),
      ),
    ),
  );
  draw();
}
