// Sending a lesson PDF to the student's WhatsApp chat.
//
// WhatsApp can only be opened straight into a given chat with text (wa.me/<number>?text=…), not with a
// file. So:
// - PDF in the cloud: the chat opens with a link to the PDF in the message. One tap, nothing else.
// - Only on this device, on a computer: the PDF is downloaded and the chat opens; the teacher drags the
//   file in. (The computer's "share" window is never used: it asks which app instead of opening the chat.)
// - Only on this device, on an iPad / phone: the system share sheet is the only way to hand over a file.

import { downloadBlob } from "../board/export";
import { toast } from "./dom";
import { pdfText, waLink } from "./students";

/**
 * Opens an empty tab right away, while the click still counts as the user's: a tab opened later
 * (after the PDF is made and uploaded) would be blocked as a popup. It is pointed at WhatsApp afterwards.
 */
export function reserveTab(): Window | null {
  try {
    const w = window.open("", "_blank");
    if (w) {
      w.document.title = "WhatsApp";
      w.document.body.innerHTML = '<p dir="rtl" style="font:18px system-ui;text-align:center;margin-top:30vh;color:#475569">מכין את ה-PDF ופותח את וואטסאפ…</p>';
    }
    return w;
  } catch {
    return null;
  }
}

function openIn(tab: Window | null, url: string) {
  if (tab && !tab.closed) {
    try {
      tab.opener = null;
      tab.location.href = url;
      return;
    } catch { /* fall through */ }
  }
  window.open(url, "_blank", "noopener");
}

/** A phone or tablet (where the share sheet is the natural way to hand over a file). */
export const isTouchDevice = () => matchMedia("(pointer: coarse)").matches && navigator.maxTouchPoints > 0;

export async function sendPdfToStudent(o: {
  phone: string;
  studentName: string;
  /** Absolute link to the PDF in the cloud, if it was uploaded. */
  url?: string;
  blob?: Blob | null;
  fileName: string;
  /** A tab reserved with reserveTab() inside the click. */
  tab?: Window | null;
}) {
  if (o.url) {
    const link = waLink(o.phone, pdfText(o.studentName, o.url));
    if (link) return openIn(o.tab ?? null, link);
  }
  if (!o.blob) {
    o.tab?.close();
    return toast("הקובץ לא נמצא");
  }
  const file = new File([o.blob], o.fileName || "lesson.pdf", { type: "application/pdf" });
  if (isTouchDevice() && (navigator as any).canShare?.({ files: [file] })) {
    o.tab?.close();
    try { await navigator.share({ files: [file], title: o.fileName }); } catch { /* cancelled */ }
    return;
  }
  downloadBlob(o.blob, o.fileName || "lesson.pdf");
  const link = waLink(o.phone, pdfText(o.studentName));
  if (link) openIn(o.tab ?? null, link);
  else o.tab?.close();
  toast("ה-PDF ירד למחשב. גרור אותו לצ'אט שנפתח בוואטסאפ", 7000);
}
