// The teacher's students (kept in this browser) and WhatsApp links to them.

export interface Student {
  id: string;
  name: string;
  room: string;
  created: number;
  /** WhatsApp number as typed by the teacher (e.g. 050-1234567). */
  phone?: string;
}

const KEY = "shiur.students";

export function loadStudents(): Student[] {
  try { return JSON.parse(localStorage.getItem(KEY) || "[]"); } catch { return []; }
}

export function saveStudents(list: Student[]) {
  localStorage.setItem(KEY, JSON.stringify(list));
}

export function studentByRoom(room: string): Student | undefined {
  return loadStudents().find((s) => s.room === room);
}

export function setStudentPhone(room: string, phone: string) {
  const list = loadStudents();
  const s = list.find((x) => x.room === room);
  if (s) {
    s.phone = phone.trim() || undefined;
    saveStudents(list);
  }
}

export const roomUrl = (room: string, role?: string) =>
  `${location.origin}/r/${room}${role ? `?role=${role}` : ""}`;

/**
 * Number in the international form WhatsApp wants (digits only, country code first).
 * Israeli numbers can be typed the usual way: 050-1234567 → 972501234567.
 */
export function waNumber(phone: string | undefined): string | null {
  if (!phone) return null;
  let d = phone.replace(/[^\d+]/g, "");
  if (d.startsWith("+")) d = d.slice(1);
  else if (d.startsWith("00")) d = d.slice(2);
  else if (d.startsWith("0")) d = "972" + d.slice(1);
  else if (/^5\d{8}$/.test(d)) d = "972" + d;
  d = d.replace(/\D/g, "");
  return d.length >= 10 && d.length <= 15 ? d : null;
}

/** Link that opens the chat with this student in WhatsApp (app on a phone, WhatsApp Web / desktop on a computer). */
export function waLink(phone: string | undefined, text: string): string | null {
  const n = waNumber(phone);
  return n ? `https://wa.me/${n}?text=${encodeURIComponent(text)}` : null;
}

export function openWhatsApp(phone: string | undefined, text: string): boolean {
  const url = waLink(phone, text);
  if (!url) return false;
  window.open(url, "_blank", "noopener");
  return true;
}

export const inviteText = (name: string, room: string) =>
  `היי ${name}! זה הקישור הקבוע לשיעורים שלנו:\n${roomUrl(room)}\nבזמן השיעור פשוט נכנסים לקישור, לא צריך להתקין כלום.`;

export const pdfText = (name: string, url?: string) =>
  url ? `היי ${name}, הנה הלוח מהשיעור שלנו (PDF):\n${url}` : `היי ${name}, מצרף את הלוח מהשיעור שלנו (PDF).`;
