// Worker bindings. In production Clawnify injects the CREDENTIALS broker binding
// and CLAWNIFY_ORG_ID; provider keys (OPENROUTER_API_KEY) arrive as secrets. The
// GOOGLEADS_* / *_BEARER_TOKEN vars are local-dev fallbacks only — the SDK reads
// them when no broker is present so the template runs standalone.

import type { CredentialBinding } from "@clawnify/connections";

export type Bindings = {
  CREDENTIALS?: CredentialBinding;
  CLAWNIFY_ORG_ID?: string;
  /** Org service token — authorizes the platform queue that schedules the sync. */
  CLAWNIFY_TOKEN?: string;
  // The D1 warehouse binding (env.DB) is read by @clawnify/db through the
  // initDB middleware createApp({ db: true }) installs, so it isn't named here.
  OPENROUTER_API_KEY?: string;
  // Local-dev fallbacks:
  METAADS_BEARER_TOKEN?: string;
  GOOGLEADS_ACCESS_TOKEN?: string;
  GOOGLEADS_DEVELOPER_TOKEN?: string;
  GOOGLEADS_LOGIN_CUSTOMER_ID?: string;
  GOOGLEADS_API_VERSION?: string;
};
