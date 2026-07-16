import { createRoot } from "react-dom/client";
import { Shell } from "./components/Shell";
import { FleetView } from "./components/FleetView";
import "highlight.js/styles/github-dark.css";
// Palettes: base.css (pinned tokens) + every theme file, loaded by glob so a
// new theme stays "one CSS file + one manifest row" with no import wiring
// (S.5). Theme files scope to :root[data-theme=id] with disjoint token sets,
// so load order between them can't matter. Structure (styles.css) consumes
// tokens via var(...) only (S.1).
import.meta.glob("./themes/*.css", { eager: true });
import "./styles.css";

// Routing is the URL contract from 4.2/4.6: /s/<id> is a session viewport,
// everything else is mission control (the fleet page at /).
const isSession = /^\/s\/[\w-]+/.test(location.pathname);
createRoot(document.getElementById("root")!).render(isSession ? <Shell /> : <FleetView />);
