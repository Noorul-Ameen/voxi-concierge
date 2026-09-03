#!/usr/bin/env node
/**
 * Generates Postman collections from infra/openapi.json (concierge tool API) and a hand-curated
 * Vista-mock collection (Apigee OAuth + OData + Ticketing flows).
 *
 *   node infra/gen-postman.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const openapi = JSON.parse(readFileSync(join(here, "openapi.json"), "utf8"));

const READ_TOOLS = new Set([
  "search_films",
  "get_film",
  "search_sessions",
  "list_cinemas",
  "get_cinema",
  "nearest_cinemas",
  "get_age_rules",
  "list_offers",
  "check_offer_eligibility",
  "how_to_book",
  "find_booking",
  "check_cancellation_eligibility",
  "prepare_cancellation",
  "prepare_swap",
  "get_action_result",
  "browse_menu",
  "get_ticket_types",
  "get_seat_plan",
  "get_order",
  "prepare_payment",
  "get_loyalty_balance",
  "get_session_context",
  "login_customer",
  "list_my_bookings",
  "get_recommendations",
]);

function exampleFor(schema) {
  if (!schema || typeof schema !== "object") return {};
  if (schema.example !== undefined) return schema.example;
  if (schema.type === "object" && schema.properties) {
    const out = {};
    for (const [k, v] of Object.entries(schema.properties)) {
      if (v.example !== undefined) out[k] = v.example;
      else if (v.enum) out[k] = v.enum[0];
      else if (v.type === "string") out[k] = "";
      else if (v.type === "number" || v.type === "integer") out[k] = 0;
      else if (v.type === "boolean") out[k] = false;
      else if (v.type === "array") out[k] = [];
      else if (v.type === "object") out[k] = exampleFor(v);
    }
    return out;
  }
  return {};
}

const toolItems = Object.entries(openapi.paths).map(([path, ops]) => {
  const op = ops.post;
  const name = path.replace("/tools/", "");
  const schema = op?.requestBody?.content?.["application/json"]?.schema;
  const body = { conversationId: "{{conversationId}}", ...exampleFor(schema) };
  return {
    name,
    request: {
      method: "POST",
      header: [
        { key: "content-type", value: "application/json" },
        {
          key: "x-voxi-key",
          value: "{{toolSecret}}",
          description:
            "TOOL_HMAC_SECRET (static secret header, as configured on the ElevenLabs tools). Alternative: x-voxi-timestamp + x-voxi-signature = HMAC-SHA256(secret, `${ts}.${rawBody}`) hex.",
        },
      ],
      url: {
        raw: `{{conciergeBase}}${path}`,
        host: ["{{conciergeBase}}"],
        path: path.split("/").filter(Boolean),
      },
      body: { mode: "raw", raw: JSON.stringify(body, null, 2), options: { raw: { language: "json" } } },
      description: op?.description ?? op?.summary ?? "",
    },
  };
});

const widget = [
  {
    name: "POST /widget/session",
    method: "POST",
    path: "/widget/session",
    body: { language: "en", modality: "text", channel: "web" },
    auth: false,
  },
  { name: "GET /widget/state", method: "GET", path: "/widget/state", auth: true },
  {
    name: "POST /widget/command (confirm)",
    method: "POST",
    path: "/widget/command",
    body: { type: "confirm", confirmationId: "{{confirmationId}}" },
    auth: true,
  },
  {
    name: "GET /widget/events (SSE)",
    method: "GET",
    path: "/widget/events?token={{widgetToken}}&after=0",
    auth: false,
  },
  { name: "GET /widget/signed-url", method: "GET", path: "/widget/signed-url", auth: true },
  {
    name: "POST /widget/dev-tool (DEV_TOOL_BRIDGE)",
    method: "POST",
    path: "/widget/dev-tool",
    body: { name: "search_films", input: { query: "" } },
    auth: true,
  },
].map((w) => ({
  name: w.name,
  request: {
    method: w.method,
    header: [
      { key: "content-type", value: "application/json" },
      ...(w.auth ? [{ key: "authorization", value: "Bearer {{widgetToken}}" }] : []),
    ],
    url: { raw: `{{conciergeBase}}${w.path}` },
    ...(w.body
      ? {
          body: { mode: "raw", raw: JSON.stringify(w.body, null, 2), options: { raw: { language: "json" } } },
        }
      : {}),
  },
}));

const reporting = ["summary?days=30", "conversations", "complaints", "feedback", "transfers", "actions"].map(
  (p) => ({
    name: `GET /reporting/${p}`,
    request: { method: "GET", url: { raw: `{{conciergeBase}}/reporting/${p}` } },
  }),
);

const webhooks = [
  {
    name: "POST /webhooks/elevenlabs",
    request: {
      method: "POST",
      header: [
        { key: "content-type", value: "application/json" },
        { key: "elevenlabs-signature", value: "t={{ts}},v0={{hmac}}" },
      ],
      url: { raw: "{{conciergeBase}}/webhooks/elevenlabs" },
      body: {
        mode: "raw",
        raw: JSON.stringify(
          {
            type: "post_call_transcription",
            data: {
              conversation_id: "{{elConversationId}}",
              agent_id: "{{agentId}}",
              analysis: { data_collection_results: {} },
              transcript: [],
            },
          },
          null,
          2,
        ),
      },
    },
  },
  {
    name: "POST /webhooks/genesys",
    request: {
      method: "POST",
      header: [{ key: "content-type", value: "application/json" }],
      url: { raw: "{{conciergeBase}}/webhooks/genesys" },
      body: {
        mode: "raw",
        raw: JSON.stringify(
          {
            type: "Text",
            text: "Hello from agent",
            channel: { to: { id: "{{transferId}}" }, from: { nickname: "Agent" } },
          },
          null,
          2,
        ),
      },
    },
  },
];

const concierge = {
  info: {
    name: "Voxi Concierge API",
    description:
      "Generated from infra/openapi.json. Tool endpoints are the ElevenLabs webhook tools; the widget/reporting/webhook endpoints are hand-curated.",
    schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
  },
  variable: [
    { key: "conciergeBase", value: "http://localhost:4020" },
    { key: "conversationId", value: "" },
    { key: "widgetToken", value: "" },
    { key: "confirmationId", value: "" },
    { key: "toolSecret", value: "change-me-tool-secret" },
    { key: "agentId", value: "agent_1001m1m6rghcfsr8nrpj5x08g16e" },
  ],
  item: [
    { name: "Widget", item: widget },
    { name: "Tools — read", item: toolItems.filter((i) => READ_TOOLS.has(i.name)) },
    {
      name: "Tools — write (confirmation-gated / ledgered)",
      item: toolItems.filter((i) => !READ_TOOLS.has(i.name)),
    },
    { name: "Reporting", item: reporting },
    { name: "Webhooks", item: webhooks },
  ],
};

// ---- Vista mock (Apigee-shaped) ----
const v = (name, method, path, opts = {}) => ({
  name,
  request: {
    method,
    header: [
      { key: "x-api-key", value: "{{apiKey}}" },
      { key: "Authorization", value: "Bearer {{accessToken}}" },
      { key: "content-type", value: "application/json" },
    ],
    url: { raw: `{{vistaBase}}${path}` },
    ...(opts.body
      ? {
          body: {
            mode: "raw",
            raw: JSON.stringify(opts.body, null, 2),
            options: { raw: { language: "json" } },
          },
        }
      : {}),
    description: opts.description ?? "",
  },
});

const vista = {
  info: {
    name: "Voxi Vista Mock (Apigee / Connect V1 shape)",
    description:
      "Mirrors the VOX partner API structure: 2-step OAuth (Basic secret → Bearer + x-api-key), OData reference data, Ticketing order flow, RESTBooking search/refund/cancel, RESTLoyalty, Offers Engine, Customer profile. Swap vistaBase/apiKey/basicSecret for the real gateway — the paths and bodies stay the same.",
    schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
  },
  variable: [
    { key: "vistaBase", value: "http://localhost:4010/vistatickets/vista/v2" },
    { key: "oauthBase", value: "http://localhost:4010" },
    { key: "apiKey", value: "demo-api-key" },
    {
      key: "basicSecret",
      value: "ZGVtby1hcGkta2V5OmRlbW8tc2VjcmV0",
      description: "base64(apiKey:secret) — VISTA_MOCK_BASIC_SECRET",
    },
    { key: "accessToken", value: "" },
    { key: "userSessionId", value: "usid_postman_1" },
    { key: "cinemaId", value: "0005" },
    { key: "sessionId", value: "" },
    { key: "bookingId", value: "" },
    { key: "memberId", value: "" },
  ],
  item: [
    {
      name: "Auth",
      item: [
        {
          name: "Generate token",
          event: [
            {
              listen: "test",
              script: {
                exec: [
                  "const j = pm.response.json(); if (j.access_token) pm.collectionVariables.set('accessToken', j.access_token);",
                ],
              },
            },
          ],
          request: {
            method: "GET",
            header: [{ key: "Authorization", value: "Basic {{basicSecret}}" }],
            url: { raw: "{{oauthBase}}/v1/oauth/generate?grant_type=client_credentials" },
          },
        },
      ],
    },
    {
      name: "OData reference data",
      item: [
        v("Cinemas", "GET", "/OData/Cinemas?$format=json"),
        v(
          "CinemaOperators (experiences)",
          "GET",
          "/OData/CinemaOperators?$format=json&$select=ID,Code,Name,ShortName,CinemaId,Experience",
        ),
        v("FilmGenres", "GET", "/OData/FilmGenres?$format=json"),
        v("SessionAttributes", "GET", "/OData/SessionAttributes?$format=json"),
        v("Films", "GET", "/OData/Films?$format=json&$top=20"),
        v(
          "ScheduledFilms with sessions",
          "GET",
          "/OData/ScheduledFilms?$format=json&$filter=CinemaId eq '{{cinemaId}}'&$expand=Sessions",
        ),
        v(
          "Sessions for a cinema",
          "GET",
          "/OData/Sessions?$format=json&$filter=CinemaId eq '{{cinemaId}}'&$orderby=Showtime&$top=50",
        ),
        v("Ticket types for session", "GET", "/Data/Cinemas/{{cinemaId}}/sessions/{{sessionId}}/tickets"),
        v("Seat plan", "GET", "/Data/Cinemas/{{cinemaId}}/sessions/{{sessionId}}/seat-plan"),
        v(
          "Concessions grouped by tabs",
          "GET",
          "/Data/concession-items-grouped-by-tabs?cinemaId={{cinemaId}}",
        ),
      ],
    },
    {
      name: "Ticketing (order lifecycle) — V1: HTTP 200 + Result code",
      item: [
        v("Add tickets (creates order)", "POST", "/Ticketing/Order/tickets", {
          body: {
            UserSessionId: "{{userSessionId}}",
            CinemaId: "{{cinemaId}}",
            SessionId: "{{sessionId}}",
            TicketTypes: [{ TicketTypeCode: "0001", Qty: 2 }],
            ReturnOrder: true,
            ReturnSeatData: false,
            ProcessOrderValue: false,
            ReorderSessionTickets: true,
            IncludeSeatNumbers: true,
          },
        }),
        v("Set selected seats", "POST", "/Ticketing/Order/seats", {
          body: {
            UserSessionId: "{{userSessionId}}",
            CinemaId: "{{cinemaId}}",
            SessionId: "{{sessionId}}",
            SelectedSeats: [{ AreaCategoryCode: "0000000001", AreaNumber: 1, RowIndex: 5, ColumnIndex: 7 }],
            ReturnOrder: true,
            SeatData: null,
          },
        }),
        v("Add concessions", "POST", "/Ticketing/Order/concessions", {
          body: {
            UserSessionId: "{{userSessionId}}",
            CinemaId: "{{cinemaId}}",
            Concessions: [{ ItemId: "", Quantity: 1 }],
          },
        }),
        v("Apply offer / promo", "POST", "/Ticketing/Order/offers", {
          body: { UserSessionId: "{{userSessionId}}", PromoCode: "", CardBin: "", MemberId: "" },
        }),
        v("Redeem loyalty points", "POST", "/Ticketing/Order/loyalty-redeem", {
          body: {
            UserSessionId: "{{userSessionId}}",
            MemberId: "{{memberId}}",
            Points: 500,
            BalanceType: "SHARE_POINTS",
          },
        }),
        v("Get order", "GET", "/Ticketing/order/{{userSessionId}}"),
        v("Complete order (payment)", "POST", "/Ticketing/order/payment", {
          body: {
            UserSessionId: "{{userSessionId}}",
            CustomerEmail: "guest@example.com",
            CustomerName: "Guest User",
            CustomerPhone: "+971500000000",
            PerformPayment: true,
            ReturnPrintStream: false,
            PaymentInfoCollection: [
              {
                PaymentValueCents: 0,
                PaymentTenderCategory: "CREDIT",
                PaymentToken: "tok_visa_demo",
                CardNumber: "411111******1111",
              },
            ],
          },
          description: "PaymentValueCents must equal order total. tok_declined_* simulates a decline.",
        }),
        v("Cancel order", "POST", "/Ticketing/order/cancel", {
          body: { UserSessionId: "{{userSessionId}}" },
        }),
      ],
    },
    {
      name: "RESTBooking (post-purchase)",
      item: [
        v("Search bookings", "POST", "/RESTBooking.svc/booking/search", {
          body: { BookingId: "{{bookingId}}", Email: "", Phone: "", UpcomingOnly: true, Limit: 10 },
        }),
        v("Get booking", "GET", "/RESTBooking.svc/booking/{{bookingId}}"),
        v("Refund booking (partial/full)", "POST", "/RESTBooking.svc/booking/refund", {
          body: {
            BookingId: "{{bookingId}}",
            RefundTenderCategory: "EWALLET",
            TicketIds: [],
            RefundConcessions: true,
            RefundBookingFee: false,
            Reason: "customer request",
            Reference: "ref-{{$guid}}",
          },
          description:
            "Idempotent by Reference; EWALLET=VOX credit, LOYALTY=Share Points, CREDIT=original card (guests).",
        }),
        v("Cancel booking (full)", "POST", "/RESTBooking.svc/booking/cancel", {
          body: {
            BookingId: "{{bookingId}}",
            RefundTenderCategory: "EWALLET",
            Reason: "customer request",
            Reference: "ref-{{$guid}}",
          },
        }),
        v("Link swapped bookings", "POST", "/RESTBooking.svc/booking/link", {
          body: { FromBookingId: "", ToBookingId: "" },
        }),
        v("Mark collected", "POST", "/RESTBooking.svc/booking/collect", {
          body: { BookingId: "{{bookingId}}" },
        }),
      ],
    },
    {
      name: "RESTLoyalty / Offers / Customer",
      item: [
        v("Validate member (login)", "POST", "/RESTLoyalty.svc/member/validate", {
          body: { Email: "", Phone: "", Pin: "" },
        }),
        v("Member balances", "GET", "/RESTLoyalty.svc/member/{{memberId}}/balances"),
        v("Member ledger", "GET", "/RESTLoyalty.svc/member/{{memberId}}/ledger"),
        v("Offers Engine — list", "GET", "/offers/v1/offers?cinemaId={{cinemaId}}"),
        v("Offers Engine — eligibility", "POST", "/offers/v1/offers/{{offerId}}/eligibility", {
          body: { CardBin: "", MemberId: "", CinemaId: "{{cinemaId}}" },
        }),
        v("Customer profile", "GET", "/customer/v1/customers/{{memberId}}"),
        v("Customer history", "GET", "/customer/v1/customers/{{memberId}}/history"),
      ],
    },
    {
      name: "Admin (mock only)",
      item: [v("Expire stale orders", "POST", "/admin/expire-orders", { body: {} })],
    },
  ],
};

writeFileSync(join(here, "postman-voxi-concierge.json"), JSON.stringify(concierge, null, 2));
writeFileSync(join(here, "postman-vista-mock.json"), JSON.stringify(vista, null, 2));
console.log(`wrote postman-voxi-concierge.json (${toolItems.length} tools) and postman-vista-mock.json`);
