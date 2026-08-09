// This must remain index.ts's first import: dependency modules read several
// settings at module initialization, so the constrained project configuration
// has to land before those modules execute.

import { loadProjectEnv } from "./project-env";

loadProjectEnv();
