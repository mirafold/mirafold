import { createRoot } from "react-dom/client";
import { Shell } from "./components/Shell";
import { FleetView } from "./components/FleetView";
import "highlight.js/styles/github-dark.css";
import "./styles.css";

// Routing is the URL contract from 4.2/4.6: /s/<id> is a session viewport,
// everything else is mission control (the fleet page at /).
const isSession = /^\/s\/[\w-]+/.test(location.pathname);
createRoot(document.getElementById("root")!).render(isSession ? <Shell /> : <FleetView />);
