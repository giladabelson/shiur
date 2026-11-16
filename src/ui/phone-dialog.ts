// Small dialog to enter / change a student's WhatsApp number.

import { h, icon } from "./dom";
import { setStudentPhone, studentByRoom, waNumber } from "./students";

/** Resolves with the saved phone, or null if the teacher cancelled. */
export function askPhone(room: string, name: string): Promise<string | null> {
  return new Promise((resolve) => {
    const cur = studentByRoom(room)?.phone ?? "";
    const input = h("input", { class: "input", type: "tel", inputmode: "tel", dir: "ltr", value: cur, placeholder: "050-1234567", autocomplete: "off" }) as HTMLInputElement;
    const err = h("div", { class: "err" });
    let result: string | null = null;
    const dlg = h("dialog", { class: "dlg phone-dlg" },
      h("form", {
        method: "dialog",
        onsubmit: (e: Event) => {
          e.preventDefault();
          const v = input.value.trim();
          if (v && !waNumber(v)) { err.textContent = "המספר לא נראה תקין. למשל 050-1234567 או 44-7700-900123+"; return; }
          setStudentPhone(room, v);
          result = v || null;
          dlg.close();
        },
      },
        h("h2", null, icon("phone", 20), ` הוואטסאפ של ${name}`),
        h("p", { class: "muted" }, "המספר נשמר רק במחשב הזה, כדי לפתוח את הצ'אט איתו בלחיצה."),
        input, err,
        h("div", { class: "row" },
          h("button", { class: "btn wa", type: "submit" }, "שמור"),
          h("button", { class: "btn ghost", type: "button", onclick: () => dlg.close() }, "ביטול"),
        ),
      ),
    );
    dlg.addEventListener("close", () => { dlg.remove(); resolve(result); });
    document.body.append(dlg);
    dlg.showModal();
    input.focus();
  });
}
