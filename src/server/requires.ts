// What this app needs to run at full capability. Drives describe() in
// /api/state so a Clawnify agent (or Claude Code) can see exactly what to wire
// before writing code — and gets the dashboard step for anything missing.
// Declaring a requirement never provisions it; connections + keys are added in
// the Clawnify dashboard.

import type { RequireSpec } from "@clawnify/connections";

export const REQUIRES: RequireSpec[] = [
  { service: "metaads", as: "integration" },
  { service: "googleads", as: "integration" },
  // Landing Page Analysis only — the rest of the app works without it.
  { service: "google_analytics", as: "integration" },
  { name: "OPENROUTER_API_KEY", as: "key" },
];
