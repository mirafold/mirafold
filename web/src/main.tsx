import { createRoot } from "react-dom/client";
import { Shell } from "./Shell";
import "highlight.js/styles/github-dark.css";
import "./styles.css";

createRoot(document.getElementById("root")!).render(<Shell />);
