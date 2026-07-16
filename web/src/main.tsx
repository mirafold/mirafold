import { createRoot } from "react-dom/client";
import { Shell } from "./components/Shell";
import { FleetView } from "./components/FleetView";
import "highlight.js/styles/github-dark.css";
// Palettes first (base pinned tokens, then one file per theme), structure
// after — styles.css consumes tokens via var(...) only (S.1).
import "./themes/base.css";
import "./themes/dark.css";
import "./themes/light.css";
import "./styles.css";

// Routing is the URL contract from 4.2/4.6: /s/<id> is a session viewport,
// everything else is mission control (the fleet page at /).
const isSession = /^\/s\/[\w-]+/.test(location.pathname);
createRoot(document.getElementById("root")!).render(isSession ? <Shell /> : <FleetView />);
