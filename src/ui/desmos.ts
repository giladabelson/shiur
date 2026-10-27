// Desmos graphing calculator in a dialog; "add to board" inserts the graph as an image page.
// The key below is Desmos' public demo key; for regular use request a free key at desmos.com/api.

import { h, toast } from "./dom";

const DESMOS_KEY = "dcb31709b452b1cf9dc26972add0fda6";
const DESMOS_SRC = `https://www.desmos.com/api/v1.11/calculator.js?apiKey=${DESMOS_KEY}`;
const STATE_KEY = "shiur.desmos";

let loading: Promise<any> | null = null;
function loadDesmos(): Promise<any> {
  if ((window as any).Desmos) return Promise.resolve((window as any).Desmos);
  if (!loading) {
    loading = new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = DESMOS_SRC;
      s.async = true;
      s.onload = () => res((window as any).Desmos);
      s.onerror = () => { loading = null; rej(new Error("desmos load failed")); };
      document.head.append(s);
    });
  }
  return loading;
}

export function openDesmos(onInsert: (png: Blob) => void) {
  const host = h("div", { class: "desmos-host", dir: "ltr" });
  const status = h("div", { class: "muted" }, "טוען את Desmos…");
  const addBtn = h("button", { class: "btn", type: "button", disabled: true }, "הוסף ללוח כעמוד חדש");
  const dlg = h("dialog", { class: "dlg desmos-dlg" },
    h("div", { class: "row desmos-head" },
      h("strong", null, "מחשבון גרפים"),
      status,
      h("span", { style: { flex: "1" } }),
      addBtn,
      h("button", { class: "btn ghost", type: "button", onclick: () => dlg.close() }, "סגור"),
    ),
    host,
  );
  let calc: any = null;
  dlg.addEventListener("close", () => {
    try { if (calc) localStorage.setItem(STATE_KEY, JSON.stringify(calc.getState())); } catch { /* ignore */ }
    calc?.destroy?.();
    dlg.remove();
  });
  document.body.append(dlg);
  dlg.showModal();

  loadDesmos().then((Desmos) => {
    status.textContent = "";
    calc = Desmos.GraphingCalculator(host, { keypad: true, expressions: true, settingsMenu: true, language: "he", border: false });
    try {
      const saved = localStorage.getItem(STATE_KEY);
      if (saved) calc.setState(JSON.parse(saved));
    } catch { /* ignore */ }
    addBtn.disabled = false;
  }).catch(() => {
    status.textContent = "לא הצלחתי לטעון את Desmos (בדוק חיבור לאינטרנט)";
  });

  addBtn.addEventListener("click", () => {
    if (!calc) return;
    addBtn.disabled = true;
    calc.asyncScreenshot({ width: 1000, height: 700, targetPixelRatio: 2, showLabels: true }, async (dataUrl: string) => {
      try {
        const blob = await (await fetch(dataUrl)).blob();
        onInsert(blob);
        toast("הגרף נוסף ללוח כעמוד חדש");
        dlg.close();
      } catch {
        toast("לא הצלחתי להוסיף את הגרף");
        addBtn.disabled = false;
      }
    });
  });
}
