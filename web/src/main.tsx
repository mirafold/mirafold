import { createRoot } from "react-dom/client";
import { Shell } from "./components/Shell";
import { FleetView } from "./components/FleetView";
import { sessionHintFromFragment } from "./relay-pairing";
import "highlight.js/styles/github-dark.css";
// Palettes: base.css (pinned tokens) + every theme file, loaded by glob so a
// new theme stays "one CSS file + one manifest row" with no import wiring.
// Theme files scope to :root[data-theme=id] with disjoint token sets,
// so load order between them can't matter. Structure (styles.css) consumes
// tokens via var(...) only.
import.meta.glob("./themes/*.css", { eager: true });
import "./styles.css";
import { sessionIdFromPath, sessionPath } from "./session-url";

// index.html painted the canvas inline before any stylesheet existed (the
// anti-white-flash script); the imports above own the pixels from here, so
// clear the inline values on BOTH routes — left in place they'd override the
// theme files' background propagation and color-scheme on later switches.
document.documentElement.style.backgroundColor = "";
document.documentElement.style.colorScheme = "";

// Pairing lands IN the session the QR was made from: the fragment may carry a
// session hint beside the code (`&s=<id>`) — rewrite the path so the router
// below sees a session URL, exactly the URL a fleet-row tap produces. The
// hash MUST ride along in the rewrite: the pairing code still lives there
// unconsumed (the socket client reads and scrubs it later, at connect), and
// dropping it would strand the device dialing a relay it has no credential
// for. An explicit /s/ path wins over the hint.
const hint = sessionHintFromFragment(location.hash);
if (hint && !location.pathname.startsWith("/s/")) {
  history.replaceState(null, "", `${sessionPath(hint)}${location.search}${location.hash}`);
}

const isSession = sessionIdFromPath(location.pathname) !== null;
createRoot(document.getElementById("root")!).render(isSession ? <Shell /> : <FleetView />);
