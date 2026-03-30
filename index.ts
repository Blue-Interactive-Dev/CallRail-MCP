import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Multi-account configuration
// ---------------------------------------------------------------------------
// Single account (legacy):
//   CALLRAIL_API_TOKEN=xxx
//   CALLRAIL_ACCOUNT_ID=yyy
//
// Multi-account:
//   CALLRAIL_ACCOUNTS={"blue interactive":{"account_id":"ACC...","api_key":"xxx"},"thomas homes":{"account_id":"ACC...","api_key":"xxx"}}

interface AccountConfig {
  account_id: string;
  api_key: string;
}

type AccountsMap = Record<string, AccountConfig>;

function loadAccounts(): AccountsMap {
  const multiEnv = process.env.CALLRAIL_ACCOUNTS;
  if (multiEnv) {
    try {
      const parsed = JSON.parse(multiEnv) as AccountsMap;
      console.log(`[callrail-mcp] Loaded ${Object.keys(parsed).length} accounts: ${Object.keys(parsed).join(", ")}`);
      return parsed;
    } catch (e) {
      console.error("[callrail-mcp] ERROR: CALLRAIL_ACCOUNTS is not valid JSON:", e);
      process.exit(1);
    }
  }

  const token = process.env.CALLRAIL_API_TOKEN || "";
  const accountId = process.env.CALLRAIL_ACCOUNT_ID || "";
  if (!token) console.warn("[callrail-mcp] WARNING: CALLRAIL_API_TOKEN not set");
  if (!accountId) console.warn("[callrail-mcp] WARNING: CALLRAIL_ACCOUNT_ID not set");

  return { default: { account_id: accountId, api_key: token } };
}

const ACCOUNTS: AccountsMap = loadAccounts();
const PORT = parseInt(process.env.PORT || "3000", 10);
const BASE_URL = "https://api.callrail.com/v3";

// ---------------------------------------------------------------------------
// Fuzzy account resolver
// Mirrors the _resolve_property pattern from the GA4 MCP:
//   1. Exact match (case-insensitive)
//   2. Substring match
//   3. Fuzzy match via Levenshtein distance
// ---------------------------------------------------------------------------

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function resolveAccount(input: string): { config: AccountConfig; matchedName: string } | null {
  const names = Object.keys(ACCOUNTS);
  if (names.length === 0) return null;

  // If only one account, always use it (no need to match)
  if (names.length === 1) return { config: ACCOUNTS[names[0]], matchedName: names[0] };

  const key = input.trim().toLowerCase();
  const lowerNames = names.map(n => n.toLowerCase());

  // 1. Exact match
  const exactIdx = lowerNames.indexOf(key);
  if (exactIdx !== -1) return { config: ACCOUNTS[names[exactIdx]], matchedName: names[exactIdx] };

  // 2. Substring match
  for (let i = 0; i < lowerNames.length; i++) {
    if (lowerNames[i].includes(key) || key.includes(lowerNames[i])) {
      return { config: ACCOUNTS[names[i]], matchedName: names[i] };
    }
  }

  // 3. Fuzzy match — pick closest by Levenshtein, accept if distance <= 40% of name length
  let bestIdx = -1;
  let bestScore = Infinity;
  for (let i = 0; i < lowerNames.length; i++) {
    const dist = levenshtein(key, lowerNames[i]);
    const threshold = Math.max(lowerNames[i].length, key.length) * 0.4;
    if (dist < bestScore && dist <= threshold) {
      bestScore = dist;
      bestIdx = i;
    }
  }
  if (bestIdx !== -1) return { config: ACCOUNTS[names[bestIdx]], matchedName: names[bestIdx] };

  return null;
}

function accountNotFoundError(input: string): { content: { type: "text"; text: string }[] } {
  const available = Object.keys(ACCOUNTS);
  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        error: `Could not match "${input}" to any CallRail account.`,
        available_accounts: available,
        tip: "Try a partial name like 'blue', 'thomas', or 'clarity'. Leave account blank to query all accounts."
      }, null, 2)
    }]
  };
}

// Run a GET request across all accounts and merge results
async function allAccountsRequest(
  pathTemplate: (accountId: string) => string,
  params?: Record<string, string | number | boolean | undefined>
): Promise<{ content: { type: "text"; text: string }[] }> {
  const results: Record<string, unknown> = {};
  for (const [name, cfg] of Object.entries(ACCOUNTS)) {
    try {
      const data = await callrailRequest("GET", pathTemplate(cfg.account_id), cfg.api_key, params);
      results[name] = data;
    } catch (e: unknown) {
      results[name] = { error: e instanceof Error ? e.message : String(e) };
    }
  }
  return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
}

// ---------------------------------------------------------------------------
// CallRail API helper — now accepts per-request credentials
// ---------------------------------------------------------------------------

async function callrailRequest(
  method: string,
  path: string,
  apiToken: string,
  params?: Record<string, string | number | boolean | undefined>,
  body?: Record<string, unknown>
): Promise<unknown> {
  let url = `${BASE_URL}${path}`;

  if (params && method === "GET") {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") {
        qs.set(k, String(v));
      }
    }
    const qstr = qs.toString();
    if (qstr) url += `?${qstr}`;
  }

  const headers: Record<string, string> = {
    Authorization: `Token token=${apiToken}`,
    "Content-Type": "application/json",
  };

  const fetchOptions: RequestInit = { method, headers };
  if (body && method !== "GET") {
    fetchOptions.body = JSON.stringify(body);
  }

  const res = await fetch(url, fetchOptions);
  const text = await res.text();

  if (!res.ok) {
    throw new Error(`CallRail API error ${res.status}: ${text}`);
  }

  return text ? JSON.parse(text) : {};
}

// Shorthand used inside tools: resolves account, then fires request
// If accountInput is undefined/empty and only one account exists, uses it automatically.
async function acctRequest(
  accountInput: string | undefined,
  method: string,
  pathTemplate: (accountId: string) => string,
  params?: Record<string, string | number | boolean | undefined>,
  body?: Record<string, unknown>
): Promise<{ data: unknown; matchedName: string } | { notFound: ReturnType<typeof accountNotFoundError> }> {
  if (!accountInput) {
    const names = Object.keys(ACCOUNTS);
    if (names.length === 1) {
      const cfg = ACCOUNTS[names[0]];
      const data = await callrailRequest(method, pathTemplate(cfg.account_id), cfg.api_key, params, body);
      return { data, matchedName: names[0] };
    }
    return { notFound: accountNotFoundError("(none specified)") };
  }
  const resolved = resolveAccount(accountInput);
  if (!resolved) return { notFound: accountNotFoundError(accountInput) };
  const { config, matchedName } = resolved;
  const data = await callrailRequest(method, pathTemplate(config.account_id), config.api_key, params, body);
  return { data, matchedName };
}

// ---------------------------------------------------------------------------
// MCP Server factory
// ---------------------------------------------------------------------------

function createServer(): McpServer {
  const accountNames = Object.keys(ACCOUNTS).join(", ") || "default";
  const server = new McpServer({
    name: `callrail-mcp (accounts: ${accountNames})`,
    version: "2.0.0",
  });

  // =========================================================================
  // ACCOUNT MANAGEMENT
  // =========================================================================

  server.tool(
    "list_accounts",
    `List all configured CallRail accounts. Available accounts: ${Object.keys(ACCOUNTS).join(", ")}. Use any account name (or a fuzzy partial) in the 'account' argument of all other tools — e.g. 'blue', 'thomas', 'clarity'. Leave 'account' blank on any tool to query all accounts at once.`,
    {},
    async () => {
      const accounts = Object.entries(ACCOUNTS).map(([name, cfg]) => ({
        name,
        account_id: cfg.account_id,
      }));
      return { content: [{ type: "text", text: JSON.stringify({ accounts }, null, 2) }] };
    }
  );

  // =========================================================================
  // CALLS
  // =========================================================================

  server.tool(
    "list_calls",
    "List all calls for a CallRail account. Fuzzy matches the account name — 'blue', 'thomas', 'clarity' all work. Supports filtering by company, date, direction, lead status, tags, source, and more.",
    {
      account: z.string().optional().describe("Account name — fuzzy matched. Available accounts: blue interactive, moment of clarity, thomas homes. Leave blank to query all accounts."),
      company_id: z.string().optional().describe("Filter to a specific Company ID"),
      start_date: z.string().optional().describe("Start date (ISO 8601, e.g. 2024-01-01)"),
      end_date: z.string().optional().describe("End date (ISO 8601, e.g. 2024-01-31)"),
      date_range: z.string().optional().describe("Predefined range: recent, today, yesterday, last_7_days, last_30_days, this_month, last_month, this_year, last_year, all_time"),
      direction: z.enum(["inbound", "outbound"]).optional().describe("Filter by call direction"),
      answered: z.boolean().optional().describe("Filter by whether call was answered"),
      lead_status: z.enum(["good_lead", "not_a_lead", "previously_marked_good_lead"]).optional().describe("Filter by lead status"),
      tags: z.string().optional().describe("Filter by tag names (comma-separated)"),
      source: z.string().optional().describe("Filter by marketing source"),
      search: z.string().optional().describe("Full-text search across calls"),
      tracker_ids: z.string().optional().describe("Filter by tracker IDs (comma-separated)"),
      page: z.number().optional().describe("Page number"),
      per_page: z.number().optional().describe("Results per page (max 100)"),
      sort_by: z.string().optional().describe("Field to sort by"),
      sort_dir: z.enum(["asc", "desc"]).optional().describe("Sort direction"),
      fields: z.string().optional().describe("Comma-separated extra fields: call_type, campaign, tags, transcription, conversational_transcript, call_summary, call_highlights, lead_score, agent_email, company_id, company_name, device_type, first_call, keywords, landing_page_url, lead_status, medium, note, source, utm_campaign, utm_content, utm_medium, utm_source, utm_term, value, milestones, sentiment"),
    },
    async ({ account, ...rest }) => {
      if (!account) return allAccountsRequest((id) => `/a/${id}/calls.json`, rest as Record<string, string | number | boolean | undefined>);
      const result = await acctRequest(account, "GET", (id) => `/a/${id}/calls.json`, rest as Record<string, string | number | boolean | undefined>);
      if ("notFound" in result) return result.notFound;
      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  server.tool(
    "get_call",
    "Retrieve a single call by ID with optional extra fields like transcription, milestones, AI summaries, etc.",
    {
      account: z.string().optional().describe("Account name — fuzzy matched. Available accounts: blue interactive, moment of clarity, thomas homes. Leave blank to query all accounts."),
      call_id: z.string().describe("Call ID (e.g. CAL8154748ae6bd4e278a7cddd38a662f4f)"),
      fields: z.string().optional().describe("Comma-separated extra fields: keywords_spotted, milestones, transcription, call_type, campaign, tags, conversational_transcript, call_summary, call_highlights, lead_score, lead_score_explanation, agent_email, company_id, company_name, company_time_zone, created_at, device_type, fbclid, first_call, formatted_call_type, formatted_customer_location, formatted_business_phone_number, formatted_customer_name, formatted_customer_name_or_phone_number, formatted_customer_phone_number, formatted_duration, formatted_tracking_phone_number, formatted_tracking_source, formatted_value, ga, gclid, good_lead_call_id, good_lead_call_time, integration_data, keypad_entries, keywords, landing_page_url, last_requested_url, lead_status, medium, msclkid, note, person_id, prior_calls, referrer_domain, referring_url, sentiment, session_uuid, source, source_name, speaker_percent, timeline_url, total_calls, tracker_id, utm_campaign, utm_content, utm_medium, utm_source, utm_term, value, voice_assist_message, waveforms, zip_code"),
    },
    async ({ account, call_id, fields }) => {
      const params: Record<string, string> = {};
      if (fields) params.fields = fields;
      const result = await acctRequest(account, "GET", (id) => `/a/${id}/calls/${call_id}.json`, params);
      if ("notFound" in result) return result.notFound;
      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  server.tool(
    "create_outbound_call",
    "Initiate an outbound call. US/Canada numbers only. Rate limited.",
    {
      account: z.string().optional().describe("Account name — fuzzy matched. Available accounts: blue interactive, moment of clarity, thomas homes. Leave blank to query all accounts."),
      caller_id: z.number().describe("Tracking phone number ID or verified external number ID to use as caller ID"),
      customer_phone_number: z.string().describe("10-digit US or Canadian customer phone number"),
      business_phone_number: z.string().describe("10-digit US or Canadian business phone number"),
      recording_enabled: z.boolean().optional().describe("Whether to record the call"),
      outbound_greeting_recording_url: z.string().optional().describe("URL of MP3 to play when call answered"),
      outbound_greeting_text: z.string().optional().describe("Text to read to customer when call answered"),
      agent_id: z.string().optional().describe("User ID of the agent to assign to the call"),
    },
    async ({ account, caller_id, customer_phone_number, business_phone_number, ...optional }) => {
      const result = await acctRequest(account, "POST", (id) => `/a/${id}/calls.json`, undefined, { caller_id, customer_phone_number, business_phone_number, ...optional });
      if ("notFound" in result) return result.notFound;
      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  server.tool(
    "update_call",
    "Update a call: set tags, note, value, lead status, customer name, or mark as spam.",
    {
      account: z.string().optional().describe("Account name — fuzzy matched. Available accounts: blue interactive, moment of clarity, thomas homes. Leave blank to query all accounts."),
      call_id: z.string().describe("The call ID to update"),
      tags: z.array(z.string()).optional().describe("Tag names — new tags are created if they don't exist"),
      note: z.string().optional().describe("Text notes. Pass empty string to clear."),
      value: z.string().optional().describe("Monetary value, e.g. '1.00'. Pass empty string to clear."),
      lead_status: z.enum(["good_lead", "not_a_lead"]).optional().describe("Lead status"),
      append_tags: z.boolean().optional().describe("If true, add tags to existing. If false/omitted, replace existing tags."),
      customer_name: z.string().optional().describe("Update the lead name on this call"),
      spam: z.boolean().optional().describe("Mark as spam (removes from log, reports, billing for current cycle)"),
    },
    async ({ account, call_id, ...body }) => {
      const result = await acctRequest(account, "PUT", (id) => `/a/${id}/calls/${call_id}.json`, undefined, body);
      if ("notFound" in result) return result.notFound;
      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  server.tool(
    "summarize_calls",
    "Return summarized call data, optionally grouped by source, campaign, referrer, landing_page, keywords, company, or company_id.",
    {
      account: z.string().optional().describe("Account name — fuzzy matched. Available accounts: blue interactive, moment of clarity, thomas homes. Leave blank to query all accounts."),
      company_id: z.string().optional().describe("Filter to a specific company"),
      start_date: z.string().optional().describe("Start date (ISO 8601)"),
      end_date: z.string().optional().describe("End date (ISO 8601)"),
      group_by: z.enum(["source", "keywords", "campaign", "referrer", "landing_page", "company", "company_id"]).optional().describe("Group results by this field"),
      fields: z.string().optional().describe("Fields: total_calls, missed_calls, answered_calls, first_time_callers, average_duration, formatted_average_duration, leads. Default: total_calls"),
      device: z.enum(["desktop", "mobile", "all"]).optional(),
      min_duration: z.number().optional().describe("Min call duration in seconds"),
      max_duration: z.number().optional().describe("Max call duration in seconds"),
      tags: z.string().optional(),
      tracker_ids: z.string().optional(),
      direction: z.enum(["inbound", "outbound", "all"]).optional(),
      answer_status: z.enum(["answered", "missed", "voicemail", "all"]).optional(),
      first_time_callers: z.boolean().optional(),
      lead_status: z.enum(["good_lead", "not_a_lead", "not_scored"]).optional(),
      agent: z.number().optional().describe("Filter to a specific agent User ID"),
    },
    async ({ account, ...rest }) => {
      if (!account) return allAccountsRequest((id) => `/a/${id}/calls/summary.json`, rest as Record<string, string | number | boolean | undefined>);
      const result = await acctRequest(account, "GET", (id) => `/a/${id}/calls/summary.json`, rest as Record<string, string | number | boolean | undefined>);
      if ("notFound" in result) return result.notFound;
      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  server.tool(
    "get_call_timeseries",
    "Retrieve aggregate call data grouped by date. Max 200 data points — use larger intervals for longer ranges.",
    {
      account: z.string().optional().describe("Account name — fuzzy matched. Available accounts: blue interactive, moment of clarity, thomas homes. Leave blank to query all accounts."),
      company_id: z.string().optional(),
      start_date: z.string().optional(),
      end_date: z.string().optional(),
      interval: z.enum(["hour", "day", "week", "month", "year"]).optional().describe("Default: day. Use week/month/year for ranges > 3 months."),
      fields: z.string().optional().describe("Fields: total_calls, missed_calls, answered_calls, first_time_callers, average_duration, formatted_average_duration, leads"),
      device: z.enum(["desktop", "mobile", "all"]).optional(),
      min_duration: z.number().optional(),
      max_duration: z.number().optional(),
      tags: z.string().optional(),
      tracker_ids: z.string().optional(),
      direction: z.enum(["inbound", "outbound", "all"]).optional(),
      answer_status: z.enum(["answered", "missed", "voicemail", "all"]).optional(),
      first_time_callers: z.boolean().optional(),
      lead_status: z.enum(["good_lead", "not_a_lead", "not_scored"]).optional(),
      agent: z.number().optional(),
    },
    async ({ account, ...rest }) => {
      const result = await acctRequest(account, "GET", (id) => `/a/${id}/calls/timeseries.json`, rest as Record<string, string | number | boolean | undefined>);
      if ("notFound" in result) return result.notFound;
      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  server.tool(
    "get_call_recording",
    "Get the MP3 recording URL for a call. For HIPAA accounts URL expires in ~24 hours — do not store it.",
    {
      account: z.string().optional().describe("Account name — fuzzy matched. Available accounts: blue interactive, moment of clarity, thomas homes. Leave blank to query all accounts."),
      call_id: z.string().describe("The call ID"),
    },
    async ({ account, call_id }) => {
      const result = await acctRequest(account, "GET", (id) => `/a/${id}/calls/${call_id}/recording.json`);
      if ("notFound" in result) return result.notFound;
      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  server.tool(
    "get_call_page_views",
    "Retrieve the browsing history (page views) associated with a call. Only available for session tracker calls. Returned in reverse chronological order.",
    {
      account: z.string().optional().describe("Account name — fuzzy matched. Available accounts: blue interactive, moment of clarity, thomas homes. Leave blank to query all accounts."),
      call_id: z.string().describe("The call ID"),
      page: z.number().optional(),
      per_page: z.number().optional(),
    },
    async ({ account, call_id, ...params }) => {
      const result = await acctRequest(account, "GET", (id) => `/a/${id}/calls/${call_id}/page_views.json`, params as Record<string, number | undefined>);
      if ("notFound" in result) return result.notFound;
      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  // =========================================================================
  // TAGS
  // =========================================================================

  server.tool(
    "list_tags",
    "List tags in the account. Filter by company, status, or tag level.",
    {
      account: z.string().optional().describe("Account name — fuzzy matched. Available accounts: blue interactive, moment of clarity, thomas homes. Leave blank to query all accounts."),
      company_id: z.string().optional(),
      status: z.enum(["enabled", "disabled"]).optional(),
      tag_level: z.enum(["company", "account"]).optional().describe("Cannot combine account with company_id"),
      page: z.number().optional(),
      per_page: z.number().optional(),
      sort_by: z.string().optional(),
      sort_dir: z.enum(["asc", "desc"]).optional(),
    },
    async ({ account, ...rest }) => {
      if (!account) return allAccountsRequest((id) => `/a/${id}/tags.json`, rest as Record<string, string | number | boolean | undefined>);
      const result = await acctRequest(account, "GET", (id) => `/a/${id}/tags.json`, rest as Record<string, string | number | boolean | undefined>);
      if ("notFound" in result) return result.notFound;
      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  server.tool(
    "create_tag",
    "Create a tag in a company or account.",
    {
      account: z.string().optional().describe("Account name — fuzzy matched. Available accounts: blue interactive, moment of clarity, thomas homes. Leave blank to query all accounts."),
      name: z.string().describe("Tag name"),
      company_id: z.string().optional().describe("Required for company-level tags (default)"),
      color: z.string().optional().describe("Color name: gray1, gray2, blue1, blue2, cyan1, cyan2, purple1, purple2, pink1-4, red1-2, orange1-4, yellow1-2, green1-4"),
      tag_level: z.enum(["account", "company"]).optional().describe("'account' creates a tag for all companies (admin only)"),
    },
    async ({ account, ...rest }) => {
      const result = await acctRequest(account, "POST", (id) => `/a/${id}/tags.json`, undefined, rest);
      if ("notFound" in result) return result.notFound;
      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  server.tool(
    "update_tag",
    "Update a tag's name, color, or enabled/disabled status.",
    {
      account: z.string().optional().describe("Account name — fuzzy matched. Available accounts: blue interactive, moment of clarity, thomas homes. Leave blank to query all accounts."),
      tag_id: z.string().describe("Tag ID to update"),
      name: z.string().optional().describe("New name — updates everywhere the tag is assigned"),
      color: z.string().optional().describe("Color name: gray1, gray2, blue1, blue2, cyan1, cyan2, purple1, purple2, pink1-4, red1-2, orange1-4, yellow1-2, green1-4"),
      disabled: z.string().optional().describe("'true' to disable, 'false' to re-enable"),
    },
    async ({ account, tag_id, ...body }) => {
      const result = await acctRequest(account, "PUT", (id) => `/a/${id}/tags/${tag_id}.json`, undefined, body);
      if ("notFound" in result) return result.notFound;
      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  server.tool(
    "delete_tag",
    "Permanently delete a tag. Removes from all call flows and interactions. Use update_tag to disable instead of removing history.",
    {
      account: z.string().optional().describe("Account name — fuzzy matched. Available accounts: blue interactive, moment of clarity, thomas homes. Leave blank to query all accounts."),
      tag_id: z.string().describe("Tag ID to delete"),
    },
    async ({ account, tag_id }) => {
      const resolved = resolveAccount(account);
      if (!resolved) return accountNotFoundError(account);
      await callrailRequest("DELETE", `/a/${resolved.config.account_id}/tags/${tag_id}.json`, resolved.config.api_key);
      return { content: [{ type: "text", text: JSON.stringify({ success: true, deleted_tag_id: tag_id }) }] };
    }
  );

  // =========================================================================
  // COMPANIES
  // =========================================================================

  server.tool(
    "list_companies",
    "List all companies in the account.",
    {
      account: z.string().optional().describe("Account name — fuzzy matched. Available accounts: blue interactive, moment of clarity, thomas homes. Leave blank to query all accounts."),
      status: z.enum(["active", "disabled"]).optional(),
      search: z.string().optional().describe("Search by name"),
      sort_by: z.string().optional(),
      sort_dir: z.enum(["asc", "desc"]).optional(),
      page: z.number().optional(),
      per_page: z.number().optional(),
    },
    async ({ account, ...rest }) => {
      if (!account) return allAccountsRequest((id) => `/a/${id}/companies.json`, rest as Record<string, string | number | boolean | undefined>);
      const result = await acctRequest(account, "GET", (id) => `/a/${id}/companies.json`, rest as Record<string, string | number | boolean | undefined>);
      if ("notFound" in result) return result.notFound;
      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  server.tool(
    "get_company",
    "Get a single company by ID.",
    {
      account: z.string().optional().describe("Account name — fuzzy matched. Available accounts: blue interactive, moment of clarity, thomas homes. Leave blank to query all accounts."),
      company_id: z.string().describe("Company ID (e.g. COM8154748ae6bd4e278a7cddd38a662f4f)"),
      fields: z.string().optional().describe("Extra fields: verified_caller_ids"),
    },
    async ({ account, company_id, fields }) => {
      const params: Record<string, string> = {};
      if (fields) params.fields = fields;
      const result = await acctRequest(account, "GET", (id) => `/a/${id}/companies/${company_id}.json`, params);
      if ("notFound" in result) return result.notFound;
      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  server.tool(
    "create_company",
    "Create a new company in the account.",
    {
      account: z.string().optional().describe("Account name — fuzzy matched. Available accounts: blue interactive, moment of clarity, thomas homes. Leave blank to query all accounts."),
      name: z.string().describe("Company name"),
      time_zone: z.string().optional().describe("e.g. 'America/New_York'"),
    },
    async ({ account, ...rest }) => {
      const result = await acctRequest(account, "POST", (id) => `/a/${id}/companies.json`, undefined, rest);
      if ("notFound" in result) return result.notFound;
      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  server.tool(
    "update_company",
    "Update a company. Only provided fields change.",
    {
      account: z.string().optional().describe("Account name — fuzzy matched. Available accounts: blue interactive, moment of clarity, thomas homes. Leave blank to query all accounts."),
      company_id: z.string().describe("Company ID to update"),
      name: z.string().optional(),
      callscore_enabled: z.boolean().optional(),
      callscribe_enabled: z.boolean().optional(),
      time_zone: z.string().optional(),
      swap_ppc_override: z.boolean().optional(),
      swap_landing_override: z.string().optional().describe("URL param to override source on landing. Pass null to disable."),
      swap_cookie_duration: z.number().optional().describe("Max cookie duration (max 6 months)"),
      swap_cookie_duration_unit: z.enum(["months", "weeks", "days"]).optional(),
      external_form_capture: z.boolean().optional(),
    },
    async ({ account, company_id, ...body }) => {
      const result = await acctRequest(account, "PUT", (id) => `/a/${id}/companies/${company_id}.json`, undefined, body);
      if ("notFound" in result) return result.notFound;
      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  server.tool(
    "bulk_update_companies",
    "Enable or disable external form capture for multiple or all companies.",
    {
      account: z.string().optional().describe("Account name — fuzzy matched. Available accounts: blue interactive, moment of clarity, thomas homes. Leave blank to query all accounts."),
      company_ids: z.array(z.string()).describe("Array of company IDs, or ['all'] to update all"),
      external_form_capture: z.boolean().optional(),
    },
    async ({ account, ...rest }) => {
      const result = await acctRequest(account, "POST", (id) => `/a/${id}/companies/bulk_update.json`, undefined, rest as Record<string, unknown>);
      if ("notFound" in result) return result.notFound;
      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  server.tool(
    "disable_company",
    "Disable a company. All tracking numbers disabled, swap.js deactivated. Cannot disable the last company.",
    {
      account: z.string().optional().describe("Account name — fuzzy matched. Available accounts: blue interactive, moment of clarity, thomas homes. Leave blank to query all accounts."),
      company_id: z.string().describe("Company ID to disable"),
    },
    async ({ account, company_id }) => {
      const resolved = resolveAccount(account);
      if (!resolved) return accountNotFoundError(account);
      await callrailRequest("DELETE", `/a/${resolved.config.account_id}/companies/${company_id}.json`, resolved.config.api_key);
      return { content: [{ type: "text", text: JSON.stringify({ success: true, disabled_company_id: company_id }) }] };
    }
  );

  // =========================================================================
  // FORM SUBMISSIONS
  // =========================================================================

  server.tool(
    "list_form_submissions",
    "List all form submissions. Supports filtering by company, date, lead status, tags.",
    {
      account: z.string().optional().describe("Account name — fuzzy matched. Available accounts: blue interactive, moment of clarity, thomas homes. Leave blank to query all accounts."),
      company_id: z.string().optional(),
      start_date: z.string().optional(),
      end_date: z.string().optional(),
      person_lead: z.boolean().optional().describe("Only return submissions with a lead associated"),
      lead_status: z.enum(["good_lead", "not_a_lead", "not_scored"]).optional(),
      tags: z.string().optional(),
      sort_by: z.enum(["created_at", "submitted_at", "form_url"]).optional().describe("Prefer submitted_at"),
      sort_dir: z.enum(["asc", "desc"]).optional(),
      page: z.number().optional(),
      per_page: z.number().optional(),
      fields: z.string().optional().describe("Extra fields: company_name, lead_status, value, note, tags, utm_source, utm_medium, utm_campaign, form_name, timeline_url, milestones"),
    },
    async ({ account, ...rest }) => {
      const result = await acctRequest(account, "GET", (id) => `/a/${id}/form_submissions.json`, rest as Record<string, string | number | boolean | undefined>);
      if ("notFound" in result) return result.notFound;
      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  server.tool(
    "create_form_submission",
    "Create a form submission. CallRail parses phone numbers in form_data to associate with a customer.",
    {
      account: z.string().optional().describe("Account name — fuzzy matched. Available accounts: blue interactive, moment of clarity, thomas homes. Leave blank to query all accounts."),
      company_id: z.string().describe("Company ID"),
      referrer: z.string().describe("Referring entity name, e.g. 'google_paid'"),
      referring_url: z.string().describe("Referring entity URL"),
      landing_page_url: z.string().describe("Page user landed on"),
      form_url: z.string().describe("URL the form was submitted to"),
      form_data: z.record(z.unknown()).describe("All form fields and values"),
      session_id: z.string().optional().describe("Session ID — can replace referrer/referring_url/landing_page_url"),
    },
    async ({ account, ...rest }) => {
      const result = await acctRequest(account, "POST", (id) => `/a/${id}/form_submissions.json`, undefined, { form_submission: rest });
      if ("notFound" in result) return result.notFound;
      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  server.tool(
    "update_form_submission",
    "Update a form submission: add tags, note, value, or set lead status.",
    {
      account: z.string().optional().describe("Account name — fuzzy matched. Available accounts: blue interactive, moment of clarity, thomas homes. Leave blank to query all accounts."),
      form_submission_id: z.string().describe("Form submission ID to update"),
      tags: z.array(z.string()).optional(),
      note: z.string().optional(),
      value: z.string().optional().describe("e.g. '1.00'. Empty string to clear."),
      lead_status: z.enum(["good_lead", "not_a_lead"]).optional(),
      append_tags: z.boolean().optional().describe("If true, add tags to existing. If false/omitted, replace."),
    },
    async ({ account, form_submission_id, ...body }) => {
      const result = await acctRequest(account, "PUT", (id) => `/a/${id}/form_submissions/${form_submission_id}.json`, undefined, body);
      if ("notFound" in result) return result.notFound;
      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  server.tool(
    "ignore_form_fields",
    "Exclude specific fields from form submissions (retroactively too). CallRail auto-excludes passwords and credit card fields.",
    {
      account: z.string().optional().describe("Account name — fuzzy matched. Available accounts: blue interactive, moment of clarity, thomas homes. Leave blank to query all accounts."),
      company_ids: z.array(z.string()).describe("Company IDs to configure, or ['all']"),
      field_names: z.array(z.string()).describe("Field names to ignore"),
    },
    async ({ account, ...rest }) => {
      const result = await acctRequest(account, "POST", (id) => `/a/${id}/form_submissions/ignored_fields.json`, undefined, rest as Record<string, unknown>);
      if ("notFound" in result) return result.notFound;
      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  server.tool(
    "summarize_forms",
    "Summarized form data grouped by source, keywords, campaign, referrer, landing_page, form_name, or company.",
    {
      account: z.string().optional().describe("Account name — fuzzy matched. Available accounts: blue interactive, moment of clarity, thomas homes. Leave blank to query all accounts."),
      company_id: z.string().optional(),
      start_date: z.string().optional(),
      end_date: z.string().optional(),
      group_by: z.enum(["source", "keywords", "campaign", "referrer", "landing_page", "form_name", "company"]).optional(),
      fields: z.string().optional().describe("Fields: total_forms, first_forms, leads. Default: total_forms"),
      tags: z.string().optional(),
      custom_form_ids: z.string().optional(),
      form_URL: z.string().optional(),
      lead_status: z.enum(["good_lead", "not_a_lead", "not_scored"]).optional(),
    },
    async ({ account, ...rest }) => {
      const result = await acctRequest(account, "GET", (id) => `/a/${id}/forms/summary.json`, rest as Record<string, string | number | boolean | undefined>);
      if ("notFound" in result) return result.notFound;
      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  // =========================================================================
  // INTEGRATIONS
  // =========================================================================

  server.tool(
    "list_integrations",
    "List all integrations for a company. Only Webhooks and Custom types can be created/updated via API.",
    {
      account: z.string().optional().describe("Account name — fuzzy matched. Available accounts: blue interactive, moment of clarity, thomas homes. Leave blank to query all accounts."),
      company_id: z.string().describe("Required — filter to this company"),
      page: z.number().optional(),
      per_page: z.number().optional(),
    },
    async ({ account, ...rest }) => {
      const result = await acctRequest(account, "GET", (id) => `/a/${id}/integrations.json`, rest as Record<string, string | number | boolean | undefined>);
      if ("notFound" in result) return result.notFound;
      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  server.tool(
    "get_integration",
    "Get a single integration. Use fields='signing_key' to retrieve the webhook signing secret.",
    {
      account: z.string().optional().describe("Account name — fuzzy matched. Available accounts: blue interactive, moment of clarity, thomas homes. Leave blank to query all accounts."),
      integration_id: z.string().describe("Integration ID"),
      fields: z.string().optional().describe("Extra fields: signing_key (Webhooks only — store this value)"),
    },
    async ({ account, integration_id, fields }) => {
      const params: Record<string, string> = {};
      if (fields) params.fields = fields;
      const result = await acctRequest(account, "GET", (id) => `/a/${id}/integrations/${integration_id}.json`, params);
      if ("notFound" in result) return result.notFound;
      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  server.tool(
    "create_integration",
    "Create a Webhooks or Custom integration for a company. Only one of each type per company.",
    {
      account: z.string().optional().describe("Account name — fuzzy matched. Available accounts: blue interactive, moment of clarity, thomas homes. Leave blank to query all accounts."),
      company_id: z.string().describe("Company ID"),
      type: z.enum(["Webhooks", "Custom"]).describe("Integration type"),
      config: z.record(z.unknown()).describe("For Webhooks: { pre_call_webhook, answered_call_webhook, post_call_webhook, updated_call_webhook, sms_received_webhook, sms_sent_webhook, form_captured_webhook, post_outbound_call_webhook, updated_outbound_call_webhook } — each an array of URLs. For Custom: { grab_cookies: ['cookie1', 'cookie2'] }"),
    },
    async ({ account, ...rest }) => {
      const result = await acctRequest(account, "POST", (id) => `/a/${id}/integrations.json`, undefined, rest as Record<string, unknown>);
      if ("notFound" in result) return result.notFound;
      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  server.tool(
    "update_integration",
    "Update a Webhooks or Custom integration.",
    {
      account: z.string().optional().describe("Account name — fuzzy matched. Available accounts: blue interactive, moment of clarity, thomas homes. Leave blank to query all accounts."),
      integration_id: z.string().describe("Integration ID to update"),
      state: z.enum(["active", "disabled"]).optional(),
      config: z.record(z.unknown()).optional().describe("Updated config object (same format as create_integration)"),
    },
    async ({ account, integration_id, ...body }) => {
      const result = await acctRequest(account, "PUT", (id) => `/a/${id}/integrations/${integration_id}.json`, undefined, body);
      if ("notFound" in result) return result.notFound;
      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  server.tool(
    "disable_integration",
    "Disable an integration.",
    {
      account: z.string().optional().describe("Account name — fuzzy matched. Available accounts: blue interactive, moment of clarity, thomas homes. Leave blank to query all accounts."),
      integration_id: z.string().describe("Integration ID to disable"),
    },
    async ({ account, integration_id }) => {
      const resolved = resolveAccount(account);
      if (!resolved) return accountNotFoundError(account);
      await callrailRequest("DELETE", `/a/${resolved.config.account_id}/integrations/${integration_id}.json`, resolved.config.api_key);
      return { content: [{ type: "text", text: JSON.stringify({ success: true, disabled_integration_id: integration_id }) }] };
    }
  );

  // =========================================================================
  // INTEGRATION FILTERS
  // =========================================================================

  server.tool(
    "list_integration_filters",
    "List all integration filters for a company.",
    {
      account: z.string().optional().describe("Account name — fuzzy matched. Available accounts: blue interactive, moment of clarity, thomas homes. Leave blank to query all accounts."),
      company_id: z.string().describe("Required — filter to this company"),
      page: z.number().optional(),
      per_page: z.number().optional(),
    },
    async ({ account, ...rest }) => {
      const result = await acctRequest(account, "GET", (id) => `/a/${id}/integration_triggers.json`, rest as Record<string, string | number | boolean | undefined>);
      if ("notFound" in result) return result.notFound;
      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  server.tool(
    "get_integration_filter",
    "Get a single integration filter.",
    {
      account: z.string().optional().describe("Account name — fuzzy matched. Available accounts: blue interactive, moment of clarity, thomas homes. Leave blank to query all accounts."),
      integration_trigger_id: z.string().describe("Integration filter ID"),
    },
    async ({ account, integration_trigger_id }) => {
      const result = await acctRequest(account, "GET", (id) => `/a/${id}/integration_triggers/${integration_trigger_id}.json`);
      if ("notFound" in result) return result.notFound;
      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  server.tool(
    "create_integration_filter",
    "Create an integration filter. Each integration can have one filter.",
    {
      account: z.string().optional().describe("Account name — fuzzy matched. Available accounts: blue interactive, moment of clarity, thomas homes. Leave blank to query all accounts."),
      company_id: z.string().describe("Company ID"),
      integration_id: z.number().describe("Integration ID to associate with"),
      tracker_ids: z.array(z.string()).optional().describe("Scope filter to specific trackers"),
      call_type: z.enum(["null", "first_call", "vm", "missed_and_vm"]).optional().describe("null=all, vm=voicemail"),
      min_duration: z.number().optional().describe("Min call duration in seconds"),
      max_duration: z.number().optional().describe("Max call duration in seconds"),
      lead_status: z.number().optional().describe("1=good_lead, 2=not_a_lead"),
    },
    async ({ account, ...rest }) => {
      const result = await acctRequest(account, "POST", (id) => `/a/${id}/integration_triggers.json`, undefined, rest as Record<string, unknown>);
      if ("notFound" in result) return result.notFound;
      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  server.tool(
    "update_integration_filter",
    "Update an integration filter.",
    {
      account: z.string().optional().describe("Account name — fuzzy matched. Available accounts: blue interactive, moment of clarity, thomas homes. Leave blank to query all accounts."),
      integration_trigger_id: z.string().describe("Integration filter ID to update"),
      tracker_ids: z.array(z.string()).optional(),
      call_type: z.enum(["null", "first_call", "vm", "missed_and_vm"]).optional(),
      min_duration: z.string().optional(),
      max_duration: z.string().optional(),
      lead_status: z.number().optional().describe("1=good_lead, 2=not_a_lead"),
    },
    async ({ account, integration_trigger_id, ...body }) => {
      const result = await acctRequest(account, "PUT", (id) => `/a/${id}/integration_triggers/${integration_trigger_id}.json`, undefined, body);
      if ("notFound" in result) return result.notFound;
      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  server.tool(
    "delete_integration_filter",
    "Delete an integration filter. Integration continues functioning without any filtering.",
    {
      account: z.string().optional().describe("Account name — fuzzy matched. Available accounts: blue interactive, moment of clarity, thomas homes. Leave blank to query all accounts."),
      integration_trigger_id: z.string().describe("Integration filter ID to delete"),
    },
    async ({ account, integration_trigger_id }) => {
      const resolved = resolveAccount(account);
      if (!resolved) return accountNotFoundError(account);
      await callrailRequest("DELETE", `/a/${resolved.config.account_id}/integration_triggers/${integration_trigger_id}.json`, resolved.config.api_key);
      return { content: [{ type: "text", text: JSON.stringify({ success: true, deleted_id: integration_trigger_id }) }] };
    }
  );

  // =========================================================================
  // NOTIFICATIONS
  // =========================================================================

  server.tool(
    "list_notifications",
    "List notifications (user alerts for calls/texts).",
    {
      account: z.string().optional().describe("Account name — fuzzy matched. Available accounts: blue interactive, moment of clarity, thomas homes. Leave blank to query all accounts."),
      user_id: z.string().optional(),
      email: z.string().optional(),
      notification_type: z.enum(["send_desktop", "send_email", "send_push"]).optional(),
      page: z.number().optional(),
      per_page: z.number().optional(),
    },
    async ({ account, ...rest }) => {
      const result = await acctRequest(account, "GET", (id) => `/a/${id}/notifications.json`, rest as Record<string, string | number | boolean | undefined>);
      if ("notFound" in result) return result.notFound;
      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  server.tool(
    "create_notification",
    "Create a notification for a user.",
    {
      account: z.string().optional().describe("Account name — fuzzy matched. Available accounts: blue interactive, moment of clarity, thomas homes. Leave blank to query all accounts."),
      user_id: z.string().optional(),
      email: z.string().optional(),
      agent_id: z.string().optional(),
      company_id: z.string().optional(),
      tracker_id: z.string().optional(),
      send_email: z.boolean().optional(),
      send_push: z.boolean().optional(),
      send_desktop: z.boolean().optional(),
      alert_type: z.enum(["all", "first_call", "missed_and_vm", "vm_only"]).optional(),
      sms_enabled: z.boolean().optional(),
      call_enabled: z.boolean().optional(),
    },
    async ({ account, ...rest }) => {
      const result = await acctRequest(account, "POST", (id) => `/a/${id}/notifications.json`, undefined, rest as Record<string, unknown>);
      if ("notFound" in result) return result.notFound;
      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  server.tool(
    "update_notification",
    "Update a notification.",
    {
      account: z.string().optional().describe("Account name — fuzzy matched. Available accounts: blue interactive, moment of clarity, thomas homes. Leave blank to query all accounts."),
      notification_id: z.string().describe("Notification ID to update"),
      company_id: z.string().optional(),
      tracker_id: z.string().optional(),
      call_enabled: z.boolean().optional(),
      sms_enabled: z.boolean().optional(),
      alert_type: z.enum(["all", "first_call", "missed_and_vm", "vm_only"]).optional(),
      send_desktop: z.boolean().optional(),
      send_email: z.boolean().optional(),
      send_push: z.boolean().optional(),
    },
    async ({ account, notification_id, ...body }) => {
      const result = await acctRequest(account, "PUT", (id) => `/a/${id}/notifications/${notification_id}.json`, undefined, body);
      if ("notFound" in result) return result.notFound;
      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  server.tool(
    "delete_notification",
    "Delete a notification.",
    {
      account: z.string().optional().describe("Account name — fuzzy matched. Available accounts: blue interactive, moment of clarity, thomas homes. Leave blank to query all accounts."),
      notification_id: z.string().describe("Notification ID to delete"),
    },
    async ({ account, notification_id }) => {
      const resolved = resolveAccount(account);
      if (!resolved) return accountNotFoundError(account);
      await callrailRequest("DELETE", `/a/${resolved.config.account_id}/notifications/${notification_id}.json`, resolved.config.api_key);
      return { content: [{ type: "text", text: JSON.stringify({ success: true, deleted_notification_id: notification_id }) }] };
    }
  );

  // =========================================================================
  // OUTBOUND CALLER IDs
  // =========================================================================

  server.tool(
    "list_caller_ids",
    "List all outbound caller IDs for a company.",
    {
      account: z.string().optional().describe("Account name — fuzzy matched. Available accounts: blue interactive, moment of clarity, thomas homes. Leave blank to query all accounts."),
      company_id: z.string().describe("Required — filter to this company"),
      page: z.number().optional(),
      per_page: z.number().optional(),
    },
    async ({ account, ...rest }) => {
      const result = await acctRequest(account, "GET", (id) => `/a/${id}/caller_ids.json`, rest as Record<string, string | number | boolean | undefined>);
      if ("notFound" in result) return result.notFound;
      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  server.tool(
    "get_caller_id",
    "Get a single outbound caller ID.",
    {
      account: z.string().optional().describe("Account name — fuzzy matched. Available accounts: blue interactive, moment of clarity, thomas homes. Leave blank to query all accounts."),
      caller_id: z.string().describe("Caller ID object ID"),
    },
    async ({ account, caller_id }) => {
      const result = await acctRequest(account, "GET", (id) => `/a/${id}/caller_ids/${caller_id}.json`);
      if ("notFound" in result) return result.notFound;
      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  server.tool(
    "create_caller_id",
    "Register an external phone number as an outbound caller ID.",
    {
      account: z.string().optional().describe("Account name — fuzzy matched. Available accounts: blue interactive, moment of clarity, thomas homes. Leave blank to query all accounts."),
      company_id: z.string().describe("Company ID"),
      phone_number: z.string().describe("Phone number to verify"),
      name: z.string().describe("Descriptive name for this caller ID"),
    },
    async ({ account, ...rest }) => {
      const result = await acctRequest(account, "POST", (id) => `/a/${id}/caller_ids.json`, undefined, rest);
      if ("notFound" in result) return result.notFound;
      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  server.tool(
    "delete_caller_id",
    "Delete an outbound caller ID.",
    {
      account: z.string().optional().describe("Account name — fuzzy matched. Available accounts: blue interactive, moment of clarity, thomas homes. Leave blank to query all accounts."),
      caller_id: z.string().describe("Caller ID object ID to delete"),
    },
    async ({ account, caller_id }) => {
      const resolved = resolveAccount(account);
      if (!resolved) return accountNotFoundError(account);
      await callrailRequest("DELETE", `/a/${resolved.config.account_id}/caller_ids/${caller_id}.json`, resolved.config.api_key);
      return { content: [{ type: "text", text: JSON.stringify({ success: true, deleted_caller_id: caller_id }) }] };
    }
  );

  // =========================================================================
  // SMS THREADS
  // =========================================================================

  server.tool(
    "list_sms_threads",
    "List SMS threads ordered by most recent message.",
    {
      account: z.string().optional().describe("Account name — fuzzy matched. Available accounts: blue interactive, moment of clarity, thomas homes. Leave blank to query all accounts."),
      company_id: z.string().optional(),
      date_range: z.string().optional(),
      start_date: z.string().optional(),
      end_date: z.string().optional(),
      search: z.string().optional(),
      page: z.number().optional(),
      per_page: z.number().optional(),
      fields: z.string().optional(),
    },
    async ({ account, ...rest }) => {
      const result = await acctRequest(account, "GET", (id) => `/a/${id}/sms-threads.json`, rest as Record<string, string | number | boolean | undefined>);
      if ("notFound" in result) return result.notFound;
      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  server.tool(
    "get_sms_thread",
    "Retrieve a single SMS thread with its messages (newest first).",
    {
      account: z.string().optional().describe("Account name — fuzzy matched. Available accounts: blue interactive, moment of clarity, thomas homes. Leave blank to query all accounts."),
      thread_id: z.string().describe("SMS thread ID"),
      page: z.number().optional(),
      per_page: z.number().optional(),
      with_msg_errors: z.boolean().optional(),
    },
    async ({ account, thread_id, ...params }) => {
      const result = await acctRequest(account, "GET", (id) => `/a/${id}/sms-threads/${thread_id}.json`, params as Record<string, number | boolean | undefined>);
      if ("notFound" in result) return result.notFound;
      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  server.tool(
    "update_sms_thread",
    "Update an SMS thread: set notes, value, tags, or lead qualification.",
    {
      account: z.string().optional().describe("Account name — fuzzy matched. Available accounts: blue interactive, moment of clarity, thomas homes. Leave blank to query all accounts."),
      thread_id: z.string().describe("SMS thread ID to update"),
      notes: z.string().optional(),
      value: z.string().optional(),
      tags: z.array(z.string()).optional(),
      append_tags: z.boolean().optional(),
      lead_qualification: z.string().optional(),
    },
    async ({ account, thread_id, ...body }) => {
      const result = await acctRequest(account, "PUT", (id) => `/a/${id}/sms-threads/${thread_id}.json`, undefined, body);
      if ("notFound" in result) return result.notFound;
      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  // =========================================================================
  // TEXT MESSAGES
  // =========================================================================

  server.tool(
    "list_text_conversations",
    "List all text message conversations ordered by most recent message.",
    {
      account: z.string().optional().describe("Account name — fuzzy matched. Available accounts: blue interactive, moment of clarity, thomas homes. Leave blank to query all accounts."),
      company_id: z.string().optional(),
      date_range: z.string().optional(),
      start_date: z.string().optional(),
      end_date: z.string().optional(),
      search: z.string().optional(),
      page: z.number().optional(),
      per_page: z.number().optional(),
      fields: z.string().optional(),
    },
    async ({ account, ...rest }) => {
      const result = await acctRequest(account, "GET", (id) => `/a/${id}/text-messages.json`, rest as Record<string, string | number | boolean | undefined>);
      if ("notFound" in result) return result.notFound;
      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  server.tool(
    "get_text_conversation",
    "Retrieve a single text message conversation with its messages.",
    {
      account: z.string().optional().describe("Account name — fuzzy matched. Available accounts: blue interactive, moment of clarity, thomas homes. Leave blank to query all accounts."),
      conversation_id: z.string().describe("Text conversation ID"),
      fields: z.string().optional(),
    },
    async ({ account, conversation_id, fields }) => {
      const params: Record<string, string> = {};
      if (fields) params.fields = fields;
      const result = await acctRequest(account, "GET", (id) => `/a/${id}/text-messages/${conversation_id}.json`, params);
      if ("notFound" in result) return result.notFound;
      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  server.tool(
    "send_text_message",
    "Send an outbound SMS/MMS text message. Person-to-person only — bulk/automated messaging is prohibited.",
    {
      account: z.string().optional().describe("Account name — fuzzy matched. Available accounts: blue interactive, moment of clarity, thomas homes. Leave blank to query all accounts."),
      company_id: z.string().describe("Company ID"),
      tracking_number: z.number().describe("Tracking number ID to send from"),
      customer_phone_number: z.string().describe("10-digit US or Canadian customer phone number"),
      content: z.string().describe("Message body (max 140 characters)"),
    },
    async ({ account, ...rest }) => {
      const result = await acctRequest(account, "POST", (id) => `/a/${id}/text-messages.json`, undefined, rest as Record<string, unknown>);
      if ("notFound" in result) return result.notFound;
      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  // =========================================================================
  // SUMMARY EMAILS
  // =========================================================================

  server.tool(
    "list_summary_emails",
    "List summary email subscriptions (periodic activity emails).",
    {
      account: z.string().optional().describe("Account name — fuzzy matched. Available accounts: blue interactive, moment of clarity, thomas homes. Leave blank to query all accounts."),
      frequency: z.array(z.enum(["daily", "weekly", "monthly"])).optional(),
      company_id: z.string().optional(),
      user_id: z.string().optional(),
      email: z.string().optional(),
      page: z.number().optional(),
      per_page: z.number().optional(),
    },
    async ({ account, ...rest }) => {
      const result = await acctRequest(account, "GET", (id) => `/a/${id}/summary_emails`, rest as Record<string, string | number | boolean | undefined>);
      if ("notFound" in result) return result.notFound;
      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  server.tool(
    "get_summary_email",
    "Retrieve a single summary email subscription.",
    {
      account: z.string().optional().describe("Account name — fuzzy matched. Available accounts: blue interactive, moment of clarity, thomas homes. Leave blank to query all accounts."),
      summary_email_id: z.string().describe("Summary email subscription ID"),
    },
    async ({ account, summary_email_id }) => {
      const result = await acctRequest(account, "GET", (id) => `/a/${id}/summary_emails/${summary_email_id}.json`);
      if ("notFound" in result) return result.notFound;
      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  server.tool(
    "create_summary_email",
    "Create a summary email subscription.",
    {
      account: z.string().optional().describe("Account name — fuzzy matched. Available accounts: blue interactive, moment of clarity, thomas homes. Leave blank to query all accounts."),
      frequency: z.array(z.enum(["daily", "weekly", "monthly"])).describe("Frequencies to subscribe to"),
      config: z.object({
        summary_statistics: z.boolean().optional(),
        top_sources: z.boolean().optional(),
        top_keywords: z.boolean().optional(),
        call_log: z.boolean().optional(),
      }).describe("Which sections to include in the email"),
      company_id: z.string().optional(),
      user_id: z.string().optional(),
      email: z.string().optional(),
      filters: z.object({ lead_status: z.string().optional() }).optional(),
    },
    async ({ account, ...rest }) => {
      const result = await acctRequest(account, "POST", (id) => `/a/${id}/summary_emails.json`, undefined, rest as Record<string, unknown>);
      if ("notFound" in result) return result.notFound;
      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  server.tool(
    "update_summary_email",
    "Update a summary email subscription.",
    {
      account: z.string().optional().describe("Account name — fuzzy matched. Available accounts: blue interactive, moment of clarity, thomas homes. Leave blank to query all accounts."),
      summary_email_id: z.string().describe("Summary email subscription ID to update"),
      frequency: z.array(z.enum(["daily", "weekly", "monthly"])).optional(),
      config: z.object({
        summary_statistics: z.boolean().optional(),
        top_sources: z.boolean().optional(),
        top_keywords: z.boolean().optional(),
        call_log: z.boolean().optional(),
      }),
      filters: z.object({ lead_status: z.string().optional() }).optional(),
    },
    async ({ account, summary_email_id, ...body }) => {
      const result = await acctRequest(account, "PUT", (id) => `/a/${id}/summary_emails/${summary_email_id}.json`, undefined, body);
      if ("notFound" in result) return result.notFound;
      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  server.tool(
    "delete_summary_email",
    "Delete a summary email subscription.",
    {
      account: z.string().optional().describe("Account name — fuzzy matched. Available accounts: blue interactive, moment of clarity, thomas homes. Leave blank to query all accounts."),
      summary_email_id: z.string().describe("Summary email subscription ID to delete"),
    },
    async ({ account, summary_email_id }) => {
      const resolved = resolveAccount(account);
      if (!resolved) return accountNotFoundError(account);
      await callrailRequest("DELETE", `/a/${resolved.config.account_id}/summary_emails/${summary_email_id}.json`, resolved.config.api_key);
      return { content: [{ type: "text", text: JSON.stringify({ success: true, deleted_id: summary_email_id }) }] };
    }
  );

  // =========================================================================
  // MESSAGE FLOWS
  // =========================================================================

  server.tool(
    "list_message_flows",
    "List all message flows (automated SMS reply configurations) for a company.",
    {
      account: z.string().optional().describe("Account name — fuzzy matched. Available accounts: blue interactive, moment of clarity, thomas homes. Leave blank to query all accounts."),
      company_id: z.string().optional(),
      page: z.number().optional(),
      per_page: z.number().optional(),
    },
    async ({ account, ...rest }) => {
      const result = await acctRequest(account, "GET", (id) => `/a/${id}/message-flows.json`, rest as Record<string, string | number | boolean | undefined>);
      if ("notFound" in result) return result.notFound;
      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  server.tool(
    "get_message_flow",
    "Get a single message flow with its full step configuration.",
    {
      account: z.string().optional().describe("Account name — fuzzy matched. Available accounts: blue interactive, moment of clarity, thomas homes. Leave blank to query all accounts."),
      message_flow_id: z.string().describe("Message flow ID"),
    },
    async ({ account, message_flow_id }) => {
      const result = await acctRequest(account, "GET", (id) => `/a/${id}/message-flows/${message_flow_id}.json`);
      if ("notFound" in result) return result.notFound;
      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  server.tool(
    "create_message_flow",
    "Create a message flow.",
    {
      account: z.string().optional().describe("Account name — fuzzy matched. Available accounts: blue interactive, moment of clarity, thomas homes. Leave blank to query all accounts."),
      company_id: z.string().describe("Company ID that owns the message flow"),
      name: z.string().describe("Unique name for the message flow"),
      initial_step_id: z.string().describe("ID of the first step in the flow"),
      steps: z.record(z.unknown()).describe("Object where each key is a step ID."),
    },
    async ({ account, ...rest }) => {
      const result = await acctRequest(account, "POST", (id) => `/a/${id}/message-flows.json`, undefined, rest as Record<string, unknown>);
      if ("notFound" in result) return result.notFound;
      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  server.tool(
    "update_message_flow",
    "Update an existing message flow.",
    {
      account: z.string().optional().describe("Account name — fuzzy matched. Available accounts: blue interactive, moment of clarity, thomas homes. Leave blank to query all accounts."),
      message_flow_id: z.string().describe("Message flow ID to update"),
      name: z.string().optional(),
      initial_step_id: z.string().optional(),
      steps: z.record(z.unknown()).optional(),
    },
    async ({ account, message_flow_id, ...body }) => {
      const result = await acctRequest(account, "PUT", (id) => `/a/${id}/message-flows/${message_flow_id}.json`, undefined, body);
      if ("notFound" in result) return result.notFound;
      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  // =========================================================================
  // TRACKERS
  // =========================================================================

  server.tool(
    "list_trackers",
    "List all trackers (tracking numbers). Filter by company, type, or status.",
    {
      account: z.string().optional().describe("Account name — fuzzy matched. Available accounts: blue interactive, moment of clarity, thomas homes. Leave blank to query all accounts."),
      company_id: z.string().optional(),
      type: z.enum(["session", "source"]).optional(),
      status: z.enum(["active", "disabled"]).optional(),
      search: z.string().optional(),
      sort_by: z.string().optional(),
      sort_dir: z.enum(["asc", "desc"]).optional(),
      page: z.number().optional(),
      per_page: z.number().optional(),
      fields: z.string().optional(),
    },
    async ({ account, ...rest }) => {
      if (!account) return allAccountsRequest((id) => `/a/${id}/trackers.json`, rest as Record<string, string | number | boolean | undefined>);
      const result = await acctRequest(account, "GET", (id) => `/a/${id}/trackers.json`, rest as Record<string, string | number | boolean | undefined>);
      if ("notFound" in result) return result.notFound;
      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  server.tool(
    "get_tracker",
    "Get a single tracker (tracking number).",
    {
      account: z.string().optional().describe("Account name — fuzzy matched. Available accounts: blue interactive, moment of clarity, thomas homes. Leave blank to query all accounts."),
      tracker_id: z.string().describe("Tracker ID"),
      fields: z.string().optional(),
    },
    async ({ account, tracker_id, fields }) => {
      const params: Record<string, string> = {};
      if (fields) params.fields = fields;
      const result = await acctRequest(account, "GET", (id) => `/a/${id}/trackers/${tracker_id}.json`, params);
      if ("notFound" in result) return result.notFound;
      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  server.tool(
    "create_tracker",
    "Create a source or session tracker.",
    {
      account: z.string().optional().describe("Account name — fuzzy matched. Available accounts: blue interactive, moment of clarity, thomas homes. Leave blank to query all accounts."),
      name: z.string().describe("Tracker name"),
      type: z.enum(["source", "session"]),
      company_id: z.string().describe("Company ID"),
      call_flow: z.record(z.unknown()),
      tracking_number: z.record(z.unknown()),
      source: z.record(z.unknown()),
      message_flow: z.record(z.unknown()).optional(),
      campaign_name: z.string().optional(),
      sms_enabled: z.boolean().optional(),
      swap_targets: z.array(z.string()).optional(),
      whisper_message: z.string().optional(),
    },
    async ({ account, ...rest }) => {
      const result = await acctRequest(account, "POST", (id) => `/a/${id}/trackers.json`, undefined, rest as Record<string, unknown>);
      if ("notFound" in result) return result.notFound;
      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  server.tool(
    "update_tracker",
    "Update an existing tracker.",
    {
      account: z.string().optional().describe("Account name — fuzzy matched. Available accounts: blue interactive, moment of clarity, thomas homes. Leave blank to query all accounts."),
      tracker_id: z.string().describe("Tracker ID to update"),
      name: z.string().optional(),
      pool_size: z.number().optional(),
      whisper_message: z.string().optional(),
      swap_targets: z.array(z.string()).optional(),
      call_flow: z.record(z.unknown()).optional(),
      message_flow: z.record(z.unknown()).optional(),
      source: z.string().optional(),
      sms_enabled: z.boolean().optional(),
      replace_tracking_number: z.string().optional(),
    },
    async ({ account, tracker_id, ...body }) => {
      const result = await acctRequest(account, "PUT", (id) => `/a/${id}/trackers/${tracker_id}.json`, undefined, body);
      if ("notFound" in result) return result.notFound;
      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  server.tool(
    "disable_tracker",
    "Disable a tracker (tracking number).",
    {
      account: z.string().optional().describe("Account name — fuzzy matched. Available accounts: blue interactive, moment of clarity, thomas homes. Leave blank to query all accounts."),
      tracker_id: z.string().describe("Tracker ID to disable"),
    },
    async ({ account, tracker_id }) => {
      const resolved = resolveAccount(account);
      if (!resolved) return accountNotFoundError(account);
      await callrailRequest("DELETE", `/a/${resolved.config.account_id}/trackers/${tracker_id}.json`, resolved.config.api_key);
      return { content: [{ type: "text", text: JSON.stringify({ success: true, disabled_tracker_id: tracker_id }) }] };
    }
  );

  // =========================================================================
  // USERS
  // =========================================================================

  server.tool(
    "list_users",
    "List all users in the account.",
    {
      account: z.string().optional().describe("Account name — fuzzy matched. Available accounts: blue interactive, moment of clarity, thomas homes. Leave blank to query all accounts."),
      page: z.number().optional(),
      per_page: z.number().optional(),
      sort_by: z.string().optional(),
      sort_dir: z.enum(["asc", "desc"]).optional(),
    },
    async ({ account, ...rest }) => {
      const result = await acctRequest(account, "GET", (id) => `/a/${id}/users.json`, rest as Record<string, string | number | boolean | undefined>);
      if ("notFound" in result) return result.notFound;
      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  server.tool(
    "get_user",
    "Get a single user by ID.",
    {
      account: z.string().optional().describe("Account name — fuzzy matched. Available accounts: blue interactive, moment of clarity, thomas homes. Leave blank to query all accounts."),
      user_id: z.string().describe("User ID"),
    },
    async ({ account, user_id }) => {
      const result = await acctRequest(account, "GET", (id) => `/a/${id}/users/${user_id}.json`);
      if ("notFound" in result) return result.notFound;
      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  server.tool(
    "create_user",
    "Create a new user.",
    {
      account: z.string().optional().describe("Account name — fuzzy matched. Available accounts: blue interactive, moment of clarity, thomas homes. Leave blank to query all accounts."),
      first_name: z.string(),
      last_name: z.string(),
      email: z.string(),
      role: z.enum(["admin", "reporting", "manager"]),
      companies: z.array(z.string()).optional(),
    },
    async ({ account, ...rest }) => {
      const result = await acctRequest(account, "POST", (id) => `/a/${id}/users.json`, undefined, rest as Record<string, unknown>);
      if ("notFound" in result) return result.notFound;
      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  server.tool(
    "update_user",
    "Update a user.",
    {
      account: z.string().optional().describe("Account name — fuzzy matched. Available accounts: blue interactive, moment of clarity, thomas homes. Leave blank to query all accounts."),
      user_id: z.string().describe("User ID to update"),
      first_name: z.string().optional(),
      last_name: z.string().optional(),
      email: z.string().optional(),
      role: z.enum(["admin", "reporting", "manager"]).optional(),
      companies: z.array(z.string()).optional(),
    },
    async ({ account, user_id, ...body }) => {
      const result = await acctRequest(account, "PUT", (id) => `/a/${id}/users/${user_id}.json`, undefined, body);
      if ("notFound" in result) return result.notFound;
      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  server.tool(
    "delete_user",
    "Delete a user from the account.",
    {
      account: z.string().optional().describe("Account name — fuzzy matched. Available accounts: blue interactive, moment of clarity, thomas homes. Leave blank to query all accounts."),
      user_id: z.string().describe("User ID to delete"),
    },
    async ({ account, user_id }) => {
      const resolved = resolveAccount(account);
      if (!resolved) return accountNotFoundError(account);
      await callrailRequest("DELETE", `/a/${resolved.config.account_id}/users/${user_id}.json`, resolved.config.api_key);
      return { content: [{ type: "text", text: JSON.stringify({ success: true, deleted_user_id: user_id }) }] };
    }
  );

  return server;
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "callrail-mcp", accounts: Object.keys(ACCOUNTS) });
});

app.all("/mcp", async (req, res) => {
  try {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("[callrail-mcp] Error handling /mcp request:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

app.listen(PORT, () => {
  console.log(`[callrail-mcp] Server running on port ${PORT}`);
  console.log(`[callrail-mcp] Accounts loaded: ${Object.keys(ACCOUNTS).join(", ") || "(none)"}`);
});