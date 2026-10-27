import "./style.css";
import { renderHome } from "./ui/home";
import { renderLesson } from "./ui/lesson";
import type { Role } from "./rtc/signaling";

const root = document.getElementById("app")!;
const m = location.pathname.match(/^\/r\/([\w-]{6,64})\/?$/);

if (m) {
  const r = new URLSearchParams(location.search).get("role");
  const role: Role = r === "teacher" || r === "ipad" ? r : "student";
  renderLesson(root, m[1], role);
} else {
  renderHome(root);
}
