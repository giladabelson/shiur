// "Previous lessons" dialog: one row per lesson with its PDF (download, share / copy link).

import { downloadBlob } from "../board/export";
import { h, icon, toast } from "./dom";
import { KEEP_DAYS, listLessons, type LessonEntry } from "./lessons";

export function openLessonsDialog(room: string, studentName: string) {
  const body = h("div", { class: "lessons" }, h("p", { class: "muted" }, "טוען…"));
  const dlg = h("dialog", { class: "dlg lessons-dlg" },
    h("h2", null, `שיעורים קודמים: ${studentName}`),
    body,
    h("div", { class: "row" }, h("button", { class: "btn ghost", type: "button", onclick: () => dlg.close() }, "סגור")),
  );
  dlg.addEventListener("close", () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();

  void listLessons(room).then(({ cloud, items }) => {
    const note = cloud
      ? `כל שיעור נשמר כ-PDF בענן ל-${KEEP_DAYS} יום. אפשר להוריד או לשלוח לתלמיד קישור.`
      : `ה-PDF של כל שיעור נשמר במחשב הזה ל-${KEEP_DAYS} יום. (שמירה בענן עוד לא הופעלה.)`;
    if (!items.length) {
      body.replaceChildren(h("p", { class: "muted" }, "עוד אין שיעורים שמורים. בסוף כל שיעור (ביציאה) הלוח נשמר כאן כ-PDF."), h("p", { class: "muted small" }, note));
      return;
    }
    body.replaceChildren(h("p", { class: "muted small" }, note), ...items.map((it) => row(it)));
  });

  function row(it: LessonEntry) {
    const date = new Date(it.started).toLocaleString("he-IL", { weekday: "short", day: "numeric", month: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" });
    const abs = it.url ? new URL(it.url, location.origin).toString() : "";
    const getBlob = async (): Promise<Blob | null> => {
      if (it.local) return it.local.blob;
      if (!abs) return null;
      const r = await fetch(abs);
      return r.ok ? await r.blob() : null;
    };
    return h("div", { class: "lesson-row card" },
      h("div", null,
        h("div", { class: "lesson-date" }, date),
        h("div", { class: "muted small" }, `${it.pages === 1 ? "עמוד אחד · " : it.pages ? `${it.pages} עמודים · ` : ""}${it.url ? "בענן" : "במחשב הזה"}`),
      ),
      h("div", { class: "student-actions" },
        h("button", {
          class: "btn", type: "button",
          onclick: async () => {
            const b = await getBlob();
            if (b) downloadBlob(b, it.name || "lesson.pdf");
            else toast("הקובץ לא נמצא");
          },
        }, icon("download", 18), " הורד PDF"),
        h("button", {
          class: "btn ghost", type: "button",
          onclick: async () => {
            const b = await getBlob();
            const file = b ? new File([b], it.name || "lesson.pdf", { type: "application/pdf" }) : null;
            // Phone / iPad / Mac: the system share sheet (WhatsApp, mail…). Otherwise copy the link.
            if (file && (navigator as any).canShare?.({ files: [file] })) {
              try { await navigator.share({ files: [file], title: it.name }); return; } catch { /* cancelled */ return; }
            }
            if (abs) {
              try { await navigator.clipboard.writeText(abs); toast("הקישור ל-PDF הועתק. אפשר להדביק לתלמיד בוואטסאפ"); }
              catch { prompt("העתק את הקישור:", abs); }
            } else {
              if (b) downloadBlob(b, it.name || "lesson.pdf");
              toast("הקובץ ירד למחשב. אפשר לצרף אותו בוואטסאפ או במייל");
            }
          },
        }, icon("share", 18), " שלח לתלמיד"),
      ),
    );
  }
}
