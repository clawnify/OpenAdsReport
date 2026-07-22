import { createApp } from "@clawnify/app";
import type { Bindings } from "./env";
import api from "./routes";

// Credentials are resolved per-request by @clawnify/connections straight off
// `env` (the CREDENTIALS broker binding + injected secrets), so there's no
// credential bootstrapping middleware to run here anymore.
const app = createApp<{ Bindings: Bindings }>({
  title: "Open Ads Report",
  version: "1.0.0",
  description:
    "Live cross-platform ads dashboard. Pulls spend, ROAS, conversions and CPA from Meta and Google Ads into Account and Portfolio views, surfaces the top issues hurting performance, and exposes everything as a clean JSON API for Clawnify agents.",
  db: false,
});

app.route("/", api);

export default app;
