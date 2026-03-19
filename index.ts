import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const API_TOKEN = process.env.CALLRAIL_API_TOKEN || "";
const ACCOUNT_ID = process.env.CALLRAIL_ACCOUNT_ID || "";
const BASE_URL = "https://api.callrail.com/v3";
const PORT = parseInt(process.env.PORT || "3000", 10);

if (!API_TOKEN) console.warn("[callrail-mcp] WARNING: CALLRAIL_API_TOKEN not set");
if (!ACCOUNT_ID) console.warn("[callrail-mcp] WARNING: CALLRAIL_ACCOUNT_ID not set");

// ---------------------------------------------------------------------------
// CallRail API helper
// ---------------------------------------------------------------------------

async function callrailRequest(
  method: string,
  path: string,
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
    Authorization: `Token token=${API_TOKEN}`,
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

// ---------------------------------------------------------------------------
// MCP Server factory
// ---------------------------------------------------------------------------

function createServer(): McpServer {
  const server = new McpServer({
    name: "callrail-mcp",
    version: "1.0.0",
  });

  // =========================================================================
  // CALLS
  // =========================================================================

  server.tool(
    "list_calls",
    "List all calls for the account. Supports filtering by company, date, direction, lead status, tags, source, and more.",
    {
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
    async (args) => {
      const data = await callrailRequest("GET", `/a/${ACCOUNT_ID}/calls.json`, args as Record<string, string | number | boolean | undefined>);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "get_call",
    "Retrieve a single call by ID with optional extra fields like transcription, milestones, AI summaries, etc.",
    {
      call_id: z.string().describe("Call ID (e.g. CAL8154748ae6bd4e278a7cddd38a662f4f)"),
      fields: z.string().optional().describe("Comma-separated extra fields: keywords_spotted, milestones, transcription, call_type, campaign, tags, conversational_transcript, call_summary, call_highlights, lead_score, lead_score_explanation, agent_email, company_id, company_name, company_time_zone, created_at, device_type, fbclid, first_call, formatted_call_type, formatted_customer_location, formatted_business_phone_number, formatted_customer_name, formatted_customer_name_or_phone_number, formatted_customer_phone_number, formatted_duration, formatted_tracking_phone_number, formatted_tracking_source, formatted_value, ga, gclid, good_lead_call_id, good_lead_call_time, integration_data, keypad_entries, keywords, landing_page_url, last_requested_url, lead_status, medium, msclkid, note, person_id, prior_calls, referrer_domain, referring_url, sentiment, session_uuid, source, source_name, speaker_percent, timeline_url, total_calls, tracker_id, utm_campaign, utm_content, utm_medium, utm_source, utm_term, value, voice_assist_message, waveforms, zip_code"),
    },
    async ({ call_id, fields }) => {
      const params: Record<string, string> = {};
      if (fields) params.fields = fields;
      const data = await callrailRequest("GET", `/a/${ACCOUNT_ID}/calls/${call_id}.json`, params);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "create_outbound_call",
    "Initiate an outbound call. US/Canada numbers only. Rate limited.",
    {
      caller_id: z.number().describe("Tracking phone number ID or verified external number ID to use as caller ID"),
      customer_phone_number: z.string().describe("10-digit US or Canadian customer phone number"),
      business_phone_number: z.string().describe("10-digit US or Canadian business phone number"),
      recording_enabled: z.boolean().optional().describe("Whether to record the call"),
      outbound_greeting_recording_url: z.string().optional().describe("URL of MP3 to play when call answered"),
      outbound_greeting_text: z.string().optional().describe("Text to read to customer when call answered"),
      agent_id: z.string().optional().describe("User ID of the agent to assign to the call"),
    },
    async (args) => {
      const { caller_id, customer_phone_number, business_phone_number, ...optional } = args;
      const data = await callrailRequest("POST", `/a/${ACCOUNT_ID}/calls.json`, undefined, { caller_id, customer_phone_number, business_phone_number, ...optional });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "update_call",
    "Update a call: set tags, note, value, lead status, customer name, or mark as spam.",
    {
      call_id: z.string().describe("The call ID to update"),
      tags: z.array(z.string()).optional().describe("Tag names — new tags are created if they don't exist"),
      note: z.string().optional().describe("Text notes. Pass empty string to clear."),
      value: z.string().optional().describe("Monetary value, e.g. '1.00'. Pass empty string to clear."),
      lead_status: z.enum(["good_lead", "not_a_lead"]).optional().describe("Lead status"),
      append_tags: z.boolean().optional().describe("If true, add tags to existing. If false/omitted, replace existing tags."),
      customer_name: z.string().optional().describe("Update the lead name on this call"),
      spam: z.boolean().optional().describe("Mark as spam (removes from log, reports, billing for current cycle)"),
    },
    async ({ call_id, ...body }) => {
      const data = await callrailRequest("PUT", `/a/${ACCOUNT_ID}/calls/${call_id}.json`, undefined, body);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "summarize_calls",
    "Return summarized call data, optionally grouped by source, campaign, referrer, landing_page, keywords, company, or company_id.",
    {
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
    async (args) => {
      const data = await callrailRequest("GET", `/a/${ACCOUNT_ID}/calls/summary.json`, args as Record<string, string | number | boolean | undefined>);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "get_call_timeseries",
    "Retrieve aggregate call data grouped by date. Max 200 data points — use larger intervals for longer ranges.",
    {
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
    async (args) => {
      const data = await callrailRequest("GET", `/a/${ACCOUNT_ID}/calls/timeseries.json`, args as Record<string, string | number | boolean | undefined>);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "get_call_recording",
    "Get the MP3 recording URL for a call. For HIPAA accounts URL expires in ~24 hours — do not store it.",
    {
      call_id: z.string().describe("The call ID"),
    },
    async ({ call_id }) => {
      const data = await callrailRequest("GET", `/a/${ACCOUNT_ID}/calls/${call_id}/recording.json`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "get_call_page_views",
    "Retrieve the browsing history (page views) associated with a call. Only available for session tracker calls. Returned in reverse chronological order.",
    {
      call_id: z.string().describe("The call ID"),
      page: z.number().optional(),
      per_page: z.number().optional(),
    },
    async ({ call_id, ...params }) => {
      const data = await callrailRequest("GET", `/a/${ACCOUNT_ID}/calls/${call_id}/page_views.json`, params as Record<string, number | undefined>);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  // =========================================================================
  // TAGS
  // =========================================================================

  server.tool(
    "list_tags",
    "List tags in the account. Filter by company, status, or tag level.",
    {
      company_id: z.string().optional(),
      status: z.enum(["enabled", "disabled"]).optional(),
      tag_level: z.enum(["company", "account"]).optional().describe("Cannot combine account with company_id"),
      page: z.number().optional(),
      per_page: z.number().optional(),
      sort_by: z.string().optional(),
      sort_dir: z.enum(["asc", "desc"]).optional(),
    },
    async (args) => {
      const data = await callrailRequest("GET", `/a/${ACCOUNT_ID}/tags.json`, args as Record<string, string | number | boolean | undefined>);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "create_tag",
    "Create a tag in a company or account.",
    {
      name: z.string().describe("Tag name"),
      company_id: z.string().optional().describe("Required for company-level tags (default)"),
      color: z.string().optional().describe("Color name: gray1, gray2, blue1, blue2, cyan1, cyan2, purple1, purple2, pink1-4, red1-2, orange1-4, yellow1-2, green1-4"),
      tag_level: z.enum(["account", "company"]).optional().describe("'account' creates a tag for all companies (admin only)"),
    },
    async (args) => {
      const data = await callrailRequest("POST", `/a/${ACCOUNT_ID}/tags.json`, undefined, args);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "update_tag",
    "Update a tag's name, color, or enabled/disabled status.",
    {
      tag_id: z.string().describe("Tag ID to update"),
      name: z.string().optional().describe("New name — updates everywhere the tag is assigned"),
      color: z.string().optional().describe("Color name: gray1, gray2, blue1, blue2, cyan1, cyan2, purple1, purple2, pink1-4, red1-2, orange1-4, yellow1-2, green1-4"),
      disabled: z.string().optional().describe("'true' to disable, 'false' to re-enable"),
    },
    async ({ tag_id, ...body }) => {
      const data = await callrailRequest("PUT", `/a/${ACCOUNT_ID}/tags/${tag_id}.json`, undefined, body);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "delete_tag",
    "Permanently delete a tag. Removes from all call flows and interactions. Use update_tag to disable instead of removing history.",
    {
      tag_id: z.string().describe("Tag ID to delete"),
    },
    async ({ tag_id }) => {
      await callrailRequest("DELETE", `/a/${ACCOUNT_ID}/tags/${tag_id}.json`);
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
      status: z.enum(["active", "disabled"]).optional(),
      search: z.string().optional().describe("Search by name"),
      sort_by: z.string().optional(),
      sort_dir: z.enum(["asc", "desc"]).optional(),
      page: z.number().optional(),
      per_page: z.number().optional(),
    },
    async (args) => {
      const data = await callrailRequest("GET", `/a/${ACCOUNT_ID}/companies.json`, args as Record<string, string | number | boolean | undefined>);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "get_company",
    "Get a single company by ID.",
    {
      company_id: z.string().describe("Company ID (e.g. COM8154748ae6bd4e278a7cddd38a662f4f)"),
      fields: z.string().optional().describe("Extra fields: verified_caller_ids"),
    },
    async ({ company_id, fields }) => {
      const params: Record<string, string> = {};
      if (fields) params.fields = fields;
      const data = await callrailRequest("GET", `/a/${ACCOUNT_ID}/companies/${company_id}.json`, params);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "create_company",
    "Create a new company in the account.",
    {
      name: z.string().describe("Company name"),
      time_zone: z.string().optional().describe("e.g. 'America/New_York'"),
    },
    async (args) => {
      const data = await callrailRequest("POST", `/a/${ACCOUNT_ID}/companies.json`, undefined, args);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "update_company",
    "Update a company. Only provided fields change.",
    {
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
    async ({ company_id, ...body }) => {
      const data = await callrailRequest("PUT", `/a/${ACCOUNT_ID}/companies/${company_id}.json`, undefined, body);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "bulk_update_companies",
    "Enable or disable external form capture for multiple or all companies.",
    {
      company_ids: z.array(z.string()).describe("Array of company IDs, or ['all'] to update all"),
      external_form_capture: z.boolean().optional(),
    },
    async (args) => {
      const data = await callrailRequest("POST", `/a/${ACCOUNT_ID}/companies/bulk_update.json`, undefined, args as Record<string, unknown>);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "disable_company",
    "Disable a company. All tracking numbers disabled, swap.js deactivated. Cannot disable the last company.",
    {
      company_id: z.string().describe("Company ID to disable"),
    },
    async ({ company_id }) => {
      await callrailRequest("DELETE", `/a/${ACCOUNT_ID}/companies/${company_id}.json`);
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
    async (args) => {
      const data = await callrailRequest("GET", `/a/${ACCOUNT_ID}/form_submissions.json`, args as Record<string, string | number | boolean | undefined>);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "create_form_submission",
    "Create a form submission. CallRail parses phone numbers in form_data to associate with a customer.",
    {
      company_id: z.string().describe("Company ID"),
      referrer: z.string().describe("Referring entity name, e.g. 'google_paid'"),
      referring_url: z.string().describe("Referring entity URL"),
      landing_page_url: z.string().describe("Page user landed on"),
      form_url: z.string().describe("URL the form was submitted to"),
      form_data: z.record(z.unknown()).describe("All form fields and values"),
      session_id: z.string().optional().describe("Session ID — can replace referrer/referring_url/landing_page_url"),
    },
    async (args) => {
      const data = await callrailRequest("POST", `/a/${ACCOUNT_ID}/form_submissions.json`, undefined, { form_submission: args });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "update_form_submission",
    "Update a form submission: add tags, note, value, or set lead status.",
    {
      form_submission_id: z.string().describe("Form submission ID to update"),
      tags: z.array(z.string()).optional(),
      note: z.string().optional(),
      value: z.string().optional().describe("e.g. '1.00'. Empty string to clear."),
      lead_status: z.enum(["good_lead", "not_a_lead"]).optional(),
      append_tags: z.boolean().optional().describe("If true, add tags to existing. If false/omitted, replace."),
    },
    async ({ form_submission_id, ...body }) => {
      const data = await callrailRequest("PUT", `/a/${ACCOUNT_ID}/form_submissions/${form_submission_id}.json`, undefined, body);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "ignore_form_fields",
    "Exclude specific fields from form submissions (retroactively too). CallRail auto-excludes passwords and credit card fields.",
    {
      company_ids: z.array(z.string()).describe("Company IDs to configure, or ['all']"),
      field_names: z.array(z.string()).describe("Field names to ignore"),
    },
    async (args) => {
      const data = await callrailRequest("POST", `/a/${ACCOUNT_ID}/form_submissions/ignored_fields.json`, undefined, args as Record<string, unknown>);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "summarize_forms",
    "Summarized form data grouped by source, keywords, campaign, referrer, landing_page, form_name, or company.",
    {
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
    async (args) => {
      const data = await callrailRequest("GET", `/a/${ACCOUNT_ID}/forms/summary.json`, args as Record<string, string | number | boolean | undefined>);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  // =========================================================================
  // INTEGRATIONS
  // =========================================================================

  server.tool(
    "list_integrations",
    "List all integrations for a company. Only Webhooks and Custom types can be created/updated via API.",
    {
      company_id: z.string().describe("Required — filter to this company"),
      page: z.number().optional(),
      per_page: z.number().optional(),
    },
    async (args) => {
      const data = await callrailRequest("GET", `/a/${ACCOUNT_ID}/integrations.json`, args as Record<string, string | number | boolean | undefined>);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "get_integration",
    "Get a single integration. Use fields='signing_key' to retrieve the webhook signing secret.",
    {
      integration_id: z.string().describe("Integration ID"),
      fields: z.string().optional().describe("Extra fields: signing_key (Webhooks only — store this value)"),
    },
    async ({ integration_id, fields }) => {
      const params: Record<string, string> = {};
      if (fields) params.fields = fields;
      const data = await callrailRequest("GET", `/a/${ACCOUNT_ID}/integrations/${integration_id}.json`, params);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "create_integration",
    "Create a Webhooks or Custom integration for a company. Only one of each type per company.",
    {
      company_id: z.string().describe("Company ID"),
      type: z.enum(["Webhooks", "Custom"]).describe("Integration type"),
      config: z.record(z.unknown()).describe("For Webhooks: { pre_call_webhook, answered_call_webhook, post_call_webhook, updated_call_webhook, sms_received_webhook, sms_sent_webhook, form_captured_webhook, post_outbound_call_webhook, updated_outbound_call_webhook } — each an array of URLs. For Custom: { grab_cookies: ['cookie1', 'cookie2'] }"),
    },
    async (args) => {
      const data = await callrailRequest("POST", `/a/${ACCOUNT_ID}/integrations.json`, undefined, args as Record<string, unknown>);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "update_integration",
    "Update a Webhooks or Custom integration.",
    {
      integration_id: z.string().describe("Integration ID to update"),
      state: z.enum(["active", "disabled"]).optional(),
      config: z.record(z.unknown()).optional().describe("Updated config object (same format as create_integration)"),
    },
    async ({ integration_id, ...body }) => {
      const data = await callrailRequest("PUT", `/a/${ACCOUNT_ID}/integrations/${integration_id}.json`, undefined, body);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "disable_integration",
    "Disable an integration.",
    {
      integration_id: z.string().describe("Integration ID to disable"),
    },
    async ({ integration_id }) => {
      await callrailRequest("DELETE", `/a/${ACCOUNT_ID}/integrations/${integration_id}.json`);
      return { content: [{ type: "text", text: JSON.stringify({ success: true, disabled_integration_id: integration_id }) }] };
    }
  );

  // =========================================================================
  // INTEGRATION FILTERS
  // =========================================================================

  server.tool(
    "list_integration_filters",
    "List all integration filters for a company. Each filter is associated with one integration.",
    {
      company_id: z.string().describe("Required — filter to this company"),
      page: z.number().optional(),
      per_page: z.number().optional(),
    },
    async (args) => {
      const data = await callrailRequest("GET", `/a/${ACCOUNT_ID}/integration_triggers.json`, args as Record<string, string | number | boolean | undefined>);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "get_integration_filter",
    "Get a single integration filter.",
    {
      integration_trigger_id: z.string().describe("Integration filter ID"),
    },
    async ({ integration_trigger_id }) => {
      const data = await callrailRequest("GET", `/a/${ACCOUNT_ID}/integration_triggers/${integration_trigger_id}.json`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "create_integration_filter",
    "Create an integration filter. Each integration can have one filter. Attributes are additive — null means not used as criteria.",
    {
      company_id: z.string().describe("Company ID"),
      integration_id: z.number().describe("Integration ID to associate with"),
      tracker_ids: z.array(z.string()).optional().describe("Scope filter to specific trackers"),
      call_type: z.enum(["null", "first_call", "vm", "missed_and_vm"]).optional().describe("null=all, vm=voicemail"),
      min_duration: z.number().optional().describe("Min call duration in seconds"),
      max_duration: z.number().optional().describe("Max call duration in seconds"),
      lead_status: z.number().optional().describe("1=good_lead, 2=not_a_lead"),
    },
    async (args) => {
      const data = await callrailRequest("POST", `/a/${ACCOUNT_ID}/integration_triggers.json`, undefined, args as Record<string, unknown>);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "update_integration_filter",
    "Update an integration filter.",
    {
      integration_trigger_id: z.string().describe("Integration filter ID to update"),
      tracker_ids: z.array(z.string()).optional(),
      call_type: z.enum(["null", "first_call", "vm", "missed_and_vm"]).optional(),
      min_duration: z.string().optional().describe("Min duration in seconds"),
      max_duration: z.string().optional().describe("Max duration in seconds"),
      lead_status: z.number().optional().describe("1=good_lead, 2=not_a_lead"),
    },
    async ({ integration_trigger_id, ...body }) => {
      const data = await callrailRequest("PUT", `/a/${ACCOUNT_ID}/integration_triggers/${integration_trigger_id}.json`, undefined, body);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "delete_integration_filter",
    "Delete an integration filter. Integration continues functioning without any filtering.",
    {
      integration_trigger_id: z.string().describe("Integration filter ID to delete"),
    },
    async ({ integration_trigger_id }) => {
      await callrailRequest("DELETE", `/a/${ACCOUNT_ID}/integration_triggers/${integration_trigger_id}.json`);
      return { content: [{ type: "text", text: JSON.stringify({ success: true, deleted_id: integration_trigger_id }) }] };
    }
  );

  // =========================================================================
  // NOTIFICATIONS
  // =========================================================================

  server.tool(
    "list_notifications",
    "List notifications (user alerts for calls/texts). Filter by user, email, or type.",
    {
      user_id: z.string().optional(),
      email: z.string().optional(),
      notification_type: z.enum(["send_desktop", "send_email", "send_push"]).optional(),
      page: z.number().optional(),
      per_page: z.number().optional(),
    },
    async (args) => {
      const data = await callrailRequest("GET", `/a/${ACCOUNT_ID}/notifications.json`, args as Record<string, string | number | boolean | undefined>);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "create_notification",
    "Create a notification for a user. Can be scoped to a tracker, company, or all trackers.",
    {
      user_id: z.string().optional().describe("User to receive notifications. Defaults to authorized user if neither user_id nor email is specified."),
      email: z.string().optional().describe("Email-only user. Requires company_id or tracker_id. Only send_email type allowed."),
      agent_id: z.string().optional().describe("Limit to calls/SMS for this agent (does not assign notification to agent)"),
      company_id: z.string().optional().describe("Limit to this company"),
      tracker_id: z.string().optional().describe("Limit to this tracker"),
      send_email: z.boolean().optional(),
      send_push: z.boolean().optional(),
      send_desktop: z.boolean().optional(),
      alert_type: z.enum(["all", "first_call", "missed_and_vm", "vm_only"]).optional().describe("Required when call_enabled is true"),
      sms_enabled: z.boolean().optional().describe("Enable alerts for incoming texts"),
      call_enabled: z.boolean().optional().describe("Enable call alerts. When true, alert_type is required."),
    },
    async (args) => {
      const data = await callrailRequest("POST", `/a/${ACCOUNT_ID}/notifications.json`, undefined, args as Record<string, unknown>);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "update_notification",
    "Update a notification. To change scope or user, delete and recreate.",
    {
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
    async ({ notification_id, ...body }) => {
      const data = await callrailRequest("PUT", `/a/${ACCOUNT_ID}/notifications/${notification_id}.json`, undefined, body);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "delete_notification",
    "Delete a notification.",
    {
      notification_id: z.string().describe("Notification ID to delete"),
    },
    async ({ notification_id }) => {
      await callrailRequest("DELETE", `/a/${ACCOUNT_ID}/notifications/${notification_id}.json`);
      return { content: [{ type: "text", text: JSON.stringify({ success: true, deleted_notification_id: notification_id }) }] };
    }
  );

  // =========================================================================
  // OUTBOUND CALLER IDs
  // =========================================================================

  server.tool(
    "list_caller_ids",
    "List all outbound caller IDs for a company. After creation, the number is called and prompted for a validation code.",
    {
      company_id: z.string().describe("Required — filter to this company"),
      page: z.number().optional(),
      per_page: z.number().optional(),
    },
    async (args) => {
      const data = await callrailRequest("GET", `/a/${ACCOUNT_ID}/caller_ids.json`, args as Record<string, string | number | boolean | undefined>);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "get_caller_id",
    "Get a single outbound caller ID.",
    {
      caller_id: z.string().describe("Caller ID object ID"),
    },
    async ({ caller_id }) => {
      const data = await callrailRequest("GET", `/a/${ACCOUNT_ID}/caller_ids/${caller_id}.json`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "create_caller_id",
    "Register an external phone number as an outbound caller ID. After creation, the number is called with a validation_code that must be entered on the keypad.",
    {
      company_id: z.string().describe("Company ID"),
      phone_number: z.string().describe("Phone number to verify (will receive a validation call)"),
      name: z.string().describe("Descriptive name for this caller ID"),
    },
    async (args) => {
      const data = await callrailRequest("POST", `/a/${ACCOUNT_ID}/caller_ids.json`, undefined, args);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "delete_caller_id",
    "Delete an outbound caller ID.",
    {
      caller_id: z.string().describe("Caller ID object ID to delete"),
    },
    async ({ caller_id }) => {
      await callrailRequest("DELETE", `/a/${ACCOUNT_ID}/caller_ids/${caller_id}.json`);
      return { content: [{ type: "text", text: JSON.stringify({ success: true, deleted_caller_id: caller_id }) }] };
    }
  );

  // =========================================================================
  // SMS THREADS
  // =========================================================================

  server.tool(
    "list_sms_threads",
    "List SMS threads ordered by most recent message. Supports filtering by date range and searching by phone number, name, or tag.",
    {
      company_id: z.string().optional().describe("Limit to a single company"),
      date_range: z.string().optional().describe("recent, today, yesterday, last_7_days, last_30_days, this_month, last_month, this_year, last_year, all_time"),
      start_date: z.string().optional().describe("YYYY-MM-DD format. Must be used with end_date."),
      end_date: z.string().optional().describe("YYYY-MM-DD format. Must be used with start_date."),
      search: z.string().optional().describe("Search by customer phone number, customer name, or tag name"),
      page: z.number().optional(),
      per_page: z.number().optional(),
      fields: z.string().optional().describe("Extra fields: last_message_at, formatted_customer_phone_number, formatted_initial_tracking_number, formatted_current_tracking_number, formatted_customer_name"),
    },
    async (args) => {
      const data = await callrailRequest("GET", `/a/${ACCOUNT_ID}/sms-threads.json`, args as Record<string, string | number | boolean | undefined>);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "get_sms_thread",
    "Retrieve a single SMS thread with its messages (newest first).",
    {
      thread_id: z.string().describe("SMS thread ID"),
      page: z.number().optional().describe("Default: 1"),
      per_page: z.number().optional().describe("Default: 100, max: 100"),
      with_msg_errors: z.boolean().optional().describe("If true, include error details for failed messages"),
    },
    async ({ thread_id, ...params }) => {
      const data = await callrailRequest("GET", `/a/${ACCOUNT_ID}/sms-threads/${thread_id}.json`, params as Record<string, number | boolean | undefined>);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "update_sms_thread",
    "Update an SMS thread: set notes, value, tags, or lead qualification.",
    {
      thread_id: z.string().describe("SMS thread ID to update"),
      notes: z.string().optional().describe("Notes associated with the thread"),
      value: z.string().optional().describe("Monetary value, e.g. '$5.00'"),
      tags: z.array(z.string()).optional().describe("Tag names to assign"),
      append_tags: z.boolean().optional().describe("If true, add to existing tags. If false/omitted, replace."),
      lead_qualification: z.string().optional().describe("Lead status: 'good_lead', 'not_a_lead', or null"),
    },
    async ({ thread_id, ...body }) => {
      const data = await callrailRequest("PUT", `/a/${ACCOUNT_ID}/sms-threads/${thread_id}.json`, undefined, body);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  // =========================================================================
  // TEXT MESSAGES
  // =========================================================================

  server.tool(
    "list_text_conversations",
    "List all text message conversations ordered by most recent message.",
    {
      company_id: z.string().optional(),
      date_range: z.string().optional(),
      start_date: z.string().optional(),
      end_date: z.string().optional(),
      search: z.string().optional().describe("Search by customer_phone_number or customer_name"),
      page: z.number().optional(),
      per_page: z.number().optional(),
      fields: z.string().optional().describe("Extra fields: lead_status, source"),
    },
    async (args) => {
      const data = await callrailRequest("GET", `/a/${ACCOUNT_ID}/text-messages.json`, args as Record<string, string | number | boolean | undefined>);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "get_text_conversation",
    "Retrieve a single text message conversation with its messages.",
    {
      conversation_id: z.string().describe("Text conversation ID"),
      fields: z.string().optional().describe("Extra fields: lead_status, source"),
    },
    async ({ conversation_id, fields }) => {
      const params: Record<string, string> = {};
      if (fields) params.fields = fields;
      const data = await callrailRequest("GET", `/a/${ACCOUNT_ID}/text-messages/${conversation_id}.json`, params);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "send_text_message",
    "Send an outbound SMS/MMS text message. Person-to-person only — bulk/automated messaging is prohibited. Rate limited. Business must be registered for 10DLC compliance.",
    {
      company_id: z.string().describe("Company ID"),
      tracking_number: z.number().describe("Tracking number ID to send from. Optional if existing conversation with customer_phone_number exists."),
      customer_phone_number: z.string().describe("10-digit US or Canadian customer phone number"),
      content: z.string().describe("Message body (max 140 characters)"),
    },
    async (args) => {
      const data = await callrailRequest("POST", `/a/${ACCOUNT_ID}/text-messages.json`, undefined, args as Record<string, unknown>);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  // =========================================================================
  // SUMMARY EMAILS
  // =========================================================================

  server.tool(
    "list_summary_emails",
    "List summary email subscriptions (periodic activity emails). Only admins can manage other users' subscriptions.",
    {
      frequency: z.array(z.enum(["daily", "weekly", "monthly"])).optional(),
      company_id: z.string().optional().describe("Filter to company-level subscriptions"),
      user_id: z.string().optional(),
      email: z.string().optional(),
      page: z.number().optional(),
      per_page: z.number().optional(),
    },
    async (args) => {
      const data = await callrailRequest("GET", `/a/${ACCOUNT_ID}/summary_emails`, args as Record<string, string | number | boolean | undefined>);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "get_summary_email",
    "Retrieve a single summary email subscription.",
    {
      summary_email_id: z.string().describe("Summary email subscription ID"),
    },
    async ({ summary_email_id }) => {
      const data = await callrailRequest("GET", `/a/${ACCOUNT_ID}/summary_emails/${summary_email_id}.json`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "create_summary_email",
    "Create a summary email subscription. Daily=every morning, weekly=every Monday, monthly=1st of month. Admins only for other users.",
    {
      frequency: z.array(z.enum(["daily", "weekly", "monthly"])).describe("Frequencies to subscribe to"),
      config: z.object({
        summary_statistics: z.boolean().optional(),
        top_sources: z.boolean().optional(),
        top_keywords: z.boolean().optional(),
        call_log: z.boolean().optional(),
      }).describe("Which sections to include in the email"),
      company_id: z.string().optional().describe("Company scope. If blank (non-email-only), uses account-level."),
      user_id: z.string().optional().describe("User to receive emails"),
      email: z.string().optional().describe("Email-only user. Requires company_id."),
      filters: z.object({
        lead_status: z.string().optional().describe("'Lead', 'Not a Lead', 'Not Scored', or 'All'"),
      }).optional(),
    },
    async (args) => {
      const data = await callrailRequest("POST", `/a/${ACCOUNT_ID}/summary_emails.json`, undefined, args as Record<string, unknown>);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "update_summary_email",
    "Update a summary email subscription. Only frequency and config may be changed. To change scope/user, delete and recreate.",
    {
      summary_email_id: z.string().describe("Summary email subscription ID to update"),
      frequency: z.array(z.enum(["daily", "weekly", "monthly"])).optional().describe("New frequencies. Only listed frequencies will be subscribed; others unsubscribed."),
      config: z.object({
        summary_statistics: z.boolean().optional(),
        top_sources: z.boolean().optional(),
        top_keywords: z.boolean().optional(),
        call_log: z.boolean().optional(),
      }).describe("Required — which sections to include"),
      filters: z.object({
        lead_status: z.string().optional(),
      }).optional(),
    },
    async ({ summary_email_id, ...body }) => {
      const data = await callrailRequest("PUT", `/a/${ACCOUNT_ID}/summary_emails/${summary_email_id}.json`, undefined, body);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "delete_summary_email",
    "Delete a summary email subscription, unsubscribing the user from future deliveries.",
    {
      summary_email_id: z.string().describe("Summary email subscription ID to delete"),
    },
    async ({ summary_email_id }) => {
      await callrailRequest("DELETE", `/a/${ACCOUNT_ID}/summary_emails/${summary_email_id}.json`);
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
      company_id: z.string().optional().describe("Filter to a specific company"),
      page: z.number().optional(),
      per_page: z.number().optional(),
    },
    async (args) => {
      const data = await callrailRequest("GET", `/a/${ACCOUNT_ID}/message-flows.json`, args as Record<string, string | number | boolean | undefined>);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "get_message_flow",
    "Get a single message flow with its full step configuration.",
    {
      message_flow_id: z.string().describe("Message flow ID"),
    },
    async ({ message_flow_id }) => {
      const data = await callrailRequest("GET", `/a/${ACCOUNT_ID}/message-flows/${message_flow_id}.json`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "create_message_flow",
    "Create a message flow. Each step type has its own format — see CallRail docs for Configuring message flows. Step IDs are generated by you (e.g. 'tag-01', 'response-01') and replaced by system IDs on creation.",
    {
      company_id: z.string().describe("Company ID that owns the message flow"),
      name: z.string().describe("Unique name for the message flow"),
      initial_step_id: z.string().describe("ID of the first step in the flow"),
      steps: z.record(z.unknown()).describe("Object where each key is a step ID. Step types: tag, sms_response, schedule. Each step has type, next_step_id (null for terminal), and type-specific fields."),
    },
    async (args) => {
      const data = await callrailRequest("POST", `/a/${ACCOUNT_ID}/message-flows.json`, undefined, args as Record<string, unknown>);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "update_message_flow",
    "Update an existing message flow.",
    {
      message_flow_id: z.string().describe("Message flow ID to update"),
      name: z.string().optional(),
      initial_step_id: z.string().optional(),
      steps: z.record(z.unknown()).optional().describe("Updated steps object"),
    },
    async ({ message_flow_id, ...body }) => {
      const data = await callrailRequest("PUT", `/a/${ACCOUNT_ID}/message-flows/${message_flow_id}.json`, undefined, body);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  // =========================================================================
  // TRACKERS
  // =========================================================================

  server.tool(
    "list_trackers",
    "List all trackers (tracking numbers). Filter by company, type (session/source), or status.",
    {
      company_id: z.string().optional(),
      type: z.enum(["session", "source"]).optional(),
      status: z.enum(["active", "disabled"]).optional(),
      search: z.string().optional().describe("Search by name"),
      sort_by: z.string().optional().describe("e.g. 'name'"),
      sort_dir: z.enum(["asc", "desc"]).optional(),
      page: z.number().optional(),
      per_page: z.number().optional(),
      fields: z.string().optional().describe("Extra fields: campaign_name, swap_targets"),
    },
    async (args) => {
      const data = await callrailRequest("GET", `/a/${ACCOUNT_ID}/trackers.json`, args as Record<string, string | number | boolean | undefined>);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "get_tracker",
    "Get a single tracker (tracking number).",
    {
      tracker_id: z.string().describe("Tracker ID (e.g. TRK8154748ae6bd4e278a7cddd38a662f4f)"),
      fields: z.string().optional().describe("Extra fields: campaign_name, swap_targets"),
    },
    async ({ tracker_id, fields }) => {
      const params: Record<string, string> = {};
      if (fields) params.fields = fields;
      const data = await callrailRequest("GET", `/a/${ACCOUNT_ID}/trackers/${tracker_id}.json`, params);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "create_tracker",
    "Create a source or session tracker. Requires call_flow, tracking_number, and source objects. See CallRail docs for Configuring Call Flows and Call Sources.",
    {
      name: z.string().describe("Tracker name"),
      type: z.enum(["source", "session"]).describe("'source' for a standard tracking number, 'session' for a website session tracker pool"),
      company_id: z.string().describe("Company ID"),
      call_flow: z.record(z.unknown()).describe("Call flow config. Basic: { type: 'basic', recording_enabled: bool, destination_number: '+1...', greeting_text: '...' }. Advanced: assign existing call flow UUID via { type: 'advanced', id: 'UUID' }"),
      tracking_number: z.record(z.unknown()).describe("Phone number config. Local: { local: '+1XXXXXXXXXX' } or { area_code: '303' }. Toll-free: { toll_free: true } or { area_code: '888', toll_free: true }"),
      source: z.record(z.unknown()).describe("Source config. Search: { type: 'search', search_engine: 'google', search_type: 'organic' }. Other types: offline, direct, referral, google_ad_extension, mobile_ad_extension, google_my_business"),
      message_flow: z.record(z.unknown()).optional().describe("Message flow config. Auto-reply: { type: 'auto-reply', message: '...' }. Advanced existing: { type: 'advanced', id: 'MFL...' }. Remove: null"),
      campaign_name: z.string().optional().describe("Campaign name (source trackers only)"),
      sms_enabled: z.boolean().optional().describe("US/Canada only"),
      swap_targets: z.array(z.string()).optional().describe("Phone numbers to replace on website"),
      whisper_message: z.string().optional().describe("Message played to call recipient before connection"),
    },
    async (args) => {
      const data = await callrailRequest("POST", `/a/${ACCOUNT_ID}/trackers.json`, undefined, args as Record<string, unknown>);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "update_tracker",
    "Update an existing tracker. Only provided fields change.",
    {
      tracker_id: z.string().describe("Tracker ID to update"),
      name: z.string().optional(),
      pool_size: z.number().optional().describe("Session tracker pool size — can only be increased"),
      whisper_message: z.string().optional().describe("If contains '[source]', will whisper the detected source"),
      swap_targets: z.array(z.string()).optional(),
      call_flow: z.record(z.unknown()).optional(),
      message_flow: z.record(z.unknown()).optional().describe("Set to null to remove message flow"),
      source: z.string().optional().describe("String or object for call sources"),
      sms_enabled: z.boolean().optional(),
      replace_tracking_number: z.string().optional().describe("E.164 number in pool to replace (spam/robodialer mitigation)"),
    },
    async ({ tracker_id, ...body }) => {
      const data = await callrailRequest("PUT", `/a/${ACCOUNT_ID}/trackers/${tracker_id}.json`, undefined, body);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "disable_tracker",
    "Disable a tracker (tracking number).",
    {
      tracker_id: z.string().describe("Tracker ID to disable"),
    },
    async ({ tracker_id }) => {
      await callrailRequest("DELETE", `/a/${ACCOUNT_ID}/trackers/${tracker_id}.json`);
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
      page: z.number().optional(),
      per_page: z.number().optional(),
      sort_by: z.string().optional(),
      sort_dir: z.enum(["asc", "desc"]).optional(),
    },
    async (args) => {
      const data = await callrailRequest("GET", `/a/${ACCOUNT_ID}/users.json`, args as Record<string, string | number | boolean | undefined>);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "get_user",
    "Get a single user by ID.",
    {
      user_id: z.string().describe("User ID (e.g. USR8154748ae6bd4e278a7cddd38a662f4f)"),
    },
    async ({ user_id }) => {
      const data = await callrailRequest("GET", `/a/${ACCOUNT_ID}/users/${user_id}.json`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "create_user",
    "Create a new user. Role determines access level. Notification users also require a companies array.",
    {
      first_name: z.string().describe("User's first name"),
      last_name: z.string().describe("User's last name"),
      email: z.string().describe("Email address for login and notifications"),
      role: z.enum(["admin", "reporting", "manager"]).describe("Access level: admin=full access, reporting=view only, manager=company-scoped"),
      companies: z.array(z.string()).optional().describe("Array of company IDs the user can access (required for notification users)"),
    },
    async (args) => {
      const data = await callrailRequest("POST", `/a/${ACCOUNT_ID}/users.json`, undefined, args as Record<string, unknown>);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "update_user",
    "Update a user. Only admins can update other users. first_name, last_name, email can only be changed for the API key owner. Passwords cannot be managed via API.",
    {
      user_id: z.string().describe("User ID to update"),
      first_name: z.string().optional(),
      last_name: z.string().optional(),
      email: z.string().optional(),
      role: z.enum(["admin", "reporting", "manager"]).optional(),
      companies: z.array(z.string()).optional().describe("Updated list of company IDs"),
    },
    async ({ user_id, ...body }) => {
      const data = await callrailRequest("PUT", `/a/${ACCOUNT_ID}/users/${user_id}.json`, undefined, body);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "delete_user",
    "Delete a user from the account.",
    {
      user_id: z.string().describe("User ID to delete"),
    },
    async ({ user_id }) => {
      await callrailRequest("DELETE", `/a/${ACCOUNT_ID}/users/${user_id}.json`);
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
  res.json({ status: "ok", service: "callrail-mcp" });
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
  console.log(`[callrail-mcp] Account ID: ${ACCOUNT_ID || "(not set)"}`);
});
