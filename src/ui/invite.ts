// Lesson links for the teacher: copy, WhatsApp, and QR codes (the iPad scans its QR off the computer screen).
// Used from the home screen ("חבר אייפד") and from inside the lesson ("הזמנה").

import QRCode from "qrcode";
import { h, icon, toast } from "./dom";
import { inviteText, openWhatsApp, roomUrl, studentByRoom, waNumber } from "./students";

export async function copy(text: string, done = "הקישור הועתק") {
  try {
    await navigator.clipboard.writeText(text);
    toast(done);
  } catch {
    prompt("העתק את הקישור:", text);
  }
}

/** A QR code of the link, with the link itself under it and a copy button. */
function qrBlock(url: string, size: number, cls: string, copyLabel = "העתק קישור"): HTMLElement {
  const canvas = h("canvas", { class: `qr ${cls}`, "aria-label": "קוד QR של הקישור", role: "img" });
  void QRCode.toCanvas(canvas, url, { width: size, margin: 1 });
  return h("div", { class: "qr-block" },
    canvas,
    h("div", { class: "linkbox" }, h("code", null, url)),
    h("button", { class: "btn ghost copy-link", type: "button", onclick: () => copy(url) }, icon("copy", 18), ` ${copyLabel}`),
  );
}

function openDialog(dlg: HTMLDialogElement) {
  dlg.addEventListener("close", () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
}

/** Home screen: connect the iPad to a student's room. */
export function ipadQrDialog(room: string, title: string) {
  const dlg = h("dialog", { class: "dlg" },
    h("h2", null, `חיבור האייפד: ${title}`),
    h("p", null, "סרוק עם המצלמה של האייפד, או פתח בו את הקישור ב-Safari:"),
    qrBlock(roomUrl(room, "ipad"), 260, "qr-ipad"),
    h("div", { class: "row end" }, h("button", { class: "btn ghost", type: "button", onclick: () => dlg.close() }, "סגור")),
  );
  openDialog(dlg);
}

/** In the lesson (teacher): the student's link (copy / WhatsApp / QR) and the iPad's QR. */
export function inviteDialog(room: string, fallbackName = "") {
  const student = studentByRoom(room);
  const who = student?.name || fallbackName;
  const studentUrl = roomUrl(room);
  const ipadUrl = roomUrl(room, "ipad");

  const studentPart = qrBlock(studentUrl, 220, "qr-student");
  if (student && waNumber(student.phone)) {
    studentPart.append(h("button", {
      class: "btn wa wa-invite", type: "button",
      onclick: () => openWhatsApp(student.phone, inviteText(who, room)),
    }, icon("wa", 18), ` שלח ל${student.name} בוואטסאפ`));
  }

  const dlg = h("dialog", { class: "dlg invite-dlg" },
    h("h2", null, icon("share", 22), " הזמנה לשיעור"),
    h("div", { class: "invite-cols" },
      h("section", { class: "invite-part invite-student" },
        h("h3", { class: "hand" }, who ? `לתלמיד: ${who}` : "לתלמיד"),
        h("p", { class: "muted small" }, "הקישור הקבוע לשיעורים. כשהתלמיד נכנס, תקבל הודעה ותכניס אותו."),
        studentPart,
      ),
      h("section", { class: "invite-part invite-ipad" },
        h("h3", { class: "hand" }, icon("ipad", 18), " לאייפד שלך"),
        h("p", { class: "muted small" }, "סרוק את הקוד מהמסך עם המצלמה של האייפד, או פתח את הקישור ב-Safari."),
        qrBlock(ipadUrl, 300, "qr-ipad"),
      ),
    ),
    h("div", { class: "row end" }, h("button", { class: "btn ghost", type: "button", onclick: () => dlg.close() }, "סגור")),
  );
  openDialog(dlg);
  return dlg;
}
