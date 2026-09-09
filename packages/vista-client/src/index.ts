/**
 * Typed client for the VOX/Apigee-wrapped Vista Connect API.
 * This is the ONLY module that changes at go-live: point VISTA_BASE_URL / VISTA_OAUTH_URL / VISTA_API_KEY /
 * VISTA_CLIENT_SECRET at the production Apigee host and the rest of the platform is unchanged.
 *
 * Behaviours reproduced from the partner document + Vista Connect conventions:
 *  - two-step OAuth (Basic secret → Bearer), token cached and refreshed early, retried once on expiry fault
 *  - x-api-key on every call
 *  - V1 endpoints return HTTP 200 on failure → we inspect Result / ExtendedResultCode / ErrorDescription
 */
export type VistaConfig = {
  baseUrl: string; // https://api-prod.maflec.com/vistatickets/vista/v2
  oauthUrl: string; // https://api-prod.maflec.com/v1/oauth/generate
  apiKey: string;
  clientSecret: string; // value for `Authorization: Basic {secret}`
  salesChannel?: string; // WWW | CELL | CALL
  clientId?: string; // OptionalClientId
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

export class VistaClientError extends Error {
  constructor(
    public readonly kind: "http" | "auth" | "result" | "network" | "timeout",
    message: string,
    public readonly status?: number,
    public readonly result?: number,
    public readonly extendedResultCode?: number,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "VistaClientError";
  }
  get retryable() {
    return (
      this.kind === "network" ||
      this.kind === "timeout" ||
      (this.kind === "http" && (this.status ?? 0) >= 500)
    );
  }
}

export type V1Envelope = { Result: number; ExtendedResultCode?: number; ErrorDescription?: string | null };

export function loadVistaConfig(env = process.env): VistaConfig {
  return {
    baseUrl: (env.VISTA_BASE_URL ?? "http://localhost:4010/vistatickets/vista/v2").replace(/\/$/, ""),
    oauthUrl: env.VISTA_OAUTH_URL ?? "http://localhost:4010/v1/oauth/generate",
    apiKey: env.VISTA_API_KEY ?? "demo-api-key",
    clientSecret: env.VISTA_CLIENT_SECRET ?? "ZGVtby1hcGkta2V5OmRlbW8tc2VjcmV0",
    salesChannel: env.VISTA_SALES_CHANNEL ?? "WWW",
    clientId: env.VISTA_CLIENT_ID ?? "10.10.10.1",
    timeoutMs: Number(env.VISTA_TIMEOUT_MS ?? 15000),
  };
}

export class VistaClient {
  private token: { value: string; expiresAt: number } | null = null;
  private refreshing: Promise<string> | null = null;
  private readonly f: typeof fetch;
  constructor(private readonly cfg: VistaConfig) {
    this.f = cfg.fetchImpl ?? fetch;
  }

  // ---------- auth ----------
  private async getToken(force = false): Promise<string> {
    if (!force && this.token && this.token.expiresAt - 60_000 > Date.now()) return this.token.value;
    if (!this.refreshing) {
      this.refreshing = (async () => {
        const res = await this.f(`${this.cfg.oauthUrl}?grant_type=client_credentials`, {
          headers: { authorization: `Basic ${this.cfg.clientSecret}` },
          signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 15000),
        });
        const body = (await res.json().catch(() => ({}))) as {
          access_token?: string;
          expires_in?: string;
          fault?: { faultstring: string };
        };
        if (!res.ok || !body.access_token)
          throw new VistaClientError(
            "auth",
            body.fault?.faultstring ?? `OAuth failed (${res.status})`,
            res.status,
            undefined,
            undefined,
            body,
          );
        this.token = {
          value: body.access_token,
          expiresAt: Date.now() + Number(body.expires_in ?? 3600) * 1000,
        };
        return body.access_token;
      })().finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    opts: { v1?: boolean; retry?: boolean } = {},
  ): Promise<T> {
    const token = await this.getToken();
    const url = path.startsWith("http") ? path : `${this.cfg.baseUrl}${path}`;
    let res: Response;
    try {
      res = await this.f(url, {
        method,
        headers: {
          "x-api-key": this.cfg.apiKey,
          authorization: `Bearer ${token}`,
          ...(body ? { "content-type": "application/json" } : {}),
          accept: "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 15000),
      });
    } catch (e) {
      const isTimeout = (e as Error).name === "TimeoutError" || (e as Error).name === "AbortError";
      throw new VistaClientError(
        isTimeout ? "timeout" : "network",
        `${method} ${path}: ${(e as Error).message}`,
      );
    }
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    if (res.status === 401 && opts.retry !== false) {
      const code = (json as { fault?: { detail?: { errorcode?: string } } })?.fault?.detail?.errorcode ?? "";
      if (/access_token_expired|invalid_access_token/.test(code)) {
        await this.getToken(true);
        return this.request<T>(method, path, body, { ...opts, retry: false });
      }
    }
    if (!res.ok) {
      const msg =
        (
          json as {
            fault?: { faultstring?: string };
            ErrorDescription?: string;
            error?: { message?: { value?: string } };
          }
        )?.fault?.faultstring ??
        (json as { ErrorDescription?: string })?.ErrorDescription ??
        (json as { error?: { message?: { value?: string } } })?.error?.message?.value ??
        `HTTP ${res.status}`;
      throw new VistaClientError(
        res.status === 401 || res.status === 403 ? "auth" : "http",
        `${method} ${path}: ${msg}`,
        res.status,
        undefined,
        undefined,
        json,
      );
    }
    if (opts.v1 !== false && json && typeof json === "object" && "Result" in (json as object)) {
      const env = json as V1Envelope;
      if (env.Result !== 0)
        throw new VistaClientError(
          "result",
          env.ErrorDescription ?? `Vista result ${env.Result}`,
          res.status,
          env.Result,
          env.ExtendedResultCode,
          json,
        );
    }
    return json as T;
  }

  private q(params: Record<string, string | number | boolean | undefined>): string {
    const parts = Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== "")
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
    return parts.length ? `?${parts.join("&")}` : "";
  }

  // ---------- OData reference data ----------
  cinemas(filter?: string) {
    return this.request<{ value: Record<string, any>[] }>(
      "GET",
      `/OData/Cinemas${this.q({ $format: "json", $filter: filter })}`,
    );
  }
  films(filter?: string, expandCast = false) {
    return this.request<{ value: Record<string, any>[] }>(
      "GET",
      `/OData/Films${this.q({ $format: "json", $filter: filter, $expand: expandCast ? "Cast" : undefined })}`,
    );
  }
  scheduledFilms(cinemaId: string) {
    return this.request<{ value: Record<string, any>[] }>(
      "GET",
      `/OData/ScheduledFilms${this.q({ $format: "json", $filter: `CinemaId eq '${cinemaId}'` })}`,
    );
  }
  sessions(filter: string, opts: { top?: number; orderby?: string } = {}) {
    return this.request<{ value: Record<string, any>[] }>(
      "GET",
      `/OData/Sessions${this.q({ $format: "json", $filter: filter, $expand: "Attributes", $top: opts.top, $orderby: opts.orderby })}`,
    );
  }
  cinemaOperators() {
    return this.request<{ value: Record<string, any>[] }>(
      "GET",
      "/OData/CinemaOperators?$format=json&$select=ID,Code,Name,ShortName,CinemaId,Experience",
    );
  }
  filmGenres() {
    return this.request<{ value: Record<string, any>[] }>("GET", "/OData/FilmGenres?$format=json");
  }

  // ---------- Data ----------
  ticketTypes(cinemaId: string, sessionId: string) {
    return this.request<{ ResponseCode: number; Tickets: Record<string, any>[]; ErrorDescription?: string }>(
      "GET",
      `/Data/Cinemas/${cinemaId}/sessions/${sessionId}/tickets?salesChannel=${this.cfg.salesChannel ?? "WWW"}`,
      undefined,
      { v1: false },
    );
  }
  seatPlan(cinemaId: string, sessionId: string, userSessionId?: string) {
    return this.request<{
      SeatLayoutData: Record<string, any> | null;
      ResponseCode: number;
      ErrorDescription: string | null;
    }>(
      "GET",
      `/Data/Cinemas/${cinemaId}/sessions/${sessionId}/seat-plan${this.q({ userSessionId })}`,
      undefined,
      { v1: false },
    );
  }
  concessions(cinemaId: string, userSessionId?: string) {
    return this.request<{
      ResponseCode: number;
      ConcessionTabs: { Name: string; Items: Record<string, any>[] }[];
    }>(
      "GET",
      `/Data/concession-items-grouped-by-tabs${this.q({ cinemaId, clientId: this.cfg.clientId, userSessionId })}`,
      undefined,
      { v1: false },
    );
  }

  // ---------- Ticketing ----------
  private clientFields() {
    return { OptionalClientId: this.cfg.clientId, OptionalClientClass: this.cfg.salesChannel };
  }
  addTickets(req: {
    UserSessionId: string;
    CinemaId: string;
    SessionId: string;
    TicketTypes: { TicketTypeCode: string; Qty: number; OptionalAreaCategoryCode?: string }[];
    UserSelectedSeatingSupported?: boolean;
    SkipAutoAllocation?: boolean;
    SeatPreference?: string;
    ConversationId?: string;
  }) {
    return this.request<{ Order: Record<string, any>; AvailableSeats: number } & V1Envelope>(
      "POST",
      "/Ticketing/Order/tickets",
      {
        ReturnOrder: true,
        ReturnSeatData: false,
        ProcessOrderValue: false,
        ReorderSessionTickets: true,
        IncludeSeatNumbers: true,
        ...this.clientFields(),
        ...req,
      },
    );
  }
  setSeats(req: {
    UserSessionId: string;
    CinemaId: string;
    SessionId: string;
    SelectedSeats:
      | { Row: string; Number: string }[]
      | { AreaCategoryCode: string; AreaNumber: number; RowIndex: number; ColumnIndex: number }[];
  }) {
    return this.request<{ Order: Record<string, any> } & V1Envelope>("POST", "/Ticketing/Order/seats", {
      ReturnOrder: true,
      SeatData: null,
      ...this.clientFields(),
      ...req,
    });
  }
  addConcessions(req: {
    UserSessionId: string;
    CinemaId: string;
    Concessions: { ItemId: string; Quantity: number; Modifiers?: string[] }[];
    /** food-only order for a paid booking: the show it is collected for */
    SessionId?: string;
  }) {
    return this.request<{ Order: Record<string, any>; FailedConcessions: unknown } & V1Envelope>(
      "POST",
      "/Ticketing/Order/concessions",
      { ReturnOrder: true, GiftStoreOrder: false, ...this.clientFields(), ...req },
    );
  }
  removeConcession(userSessionId: string, lineId: string) {
    return this.request<{ Order: Record<string, any> } & V1Envelope>(
      "DELETE",
      `/Ticketing/Order/concessions/${lineId}?userSessionId=${encodeURIComponent(userSessionId)}`,
    );
  }
  getOrder(userSessionId: string) {
    return this.request<{ Order: Record<string, any> | null; OrderNotFound?: boolean } & V1Envelope>(
      "POST",
      "/Ticketing/order",
      { UserSessionId: userSessionId, ...this.clientFields() },
    );
  }
  applyOffer(req: {
    UserSessionId: string;
    OfferId?: string;
    PromoCode?: string;
    CardBin?: string;
    MemberId?: string;
    Remove?: boolean;
  }) {
    return this.request<
      {
        Order: Record<string, any>;
        AppliedOffer?: { Id: string; Title: string; DiscountCents: number };
      } & V1Envelope
    >("POST", "/Ticketing/Order/offers", req);
  }
  redeemLoyalty(req: {
    UserSessionId: string;
    MemberId: string;
    Points?: number;
    BalanceType?: "SHARE_POINTS" | "VOX_REWARDS";
  }) {
    return this.request<
      { Order: Record<string, any>; Redeemed: { Type: string; Amount: number } } & V1Envelope
    >("POST", "/Ticketing/Order/loyalty-redeem", req);
  }
  completeOrder(req: {
    UserSessionId: string;
    CustomerEmail: string;
    CustomerName: string;
    CustomerPhone: string;
    PaymentInfoCollection: Record<string, unknown>[];
    MemberId?: string;
    CustomerId?: string;
    PerformPayment?: boolean;
    Source?: string;
  }) {
    return this.request<
      {
        VistaBookingId: string;
        VistaBookingNumber: string;
        VistaTransNumber: string;
        QrPayload?: string;
        Booking?: Record<string, any>;
        AlreadyCompleted?: boolean;
      } & V1Envelope
    >("POST", "/Ticketing/order/payment", {
      PerformPayment: true,
      ReturnPrintStream: false,
      ...this.clientFields(),
      ...req,
    });
  }
  cancelOrder(userSessionId: string) {
    return this.request<{ OrderNotFound: boolean } & V1Envelope>("POST", "/Ticketing/order/cancel", {
      UserSessionId: userSessionId,
    });
  }

  // ---------- Bookings ----------
  searchBookings(req: {
    BookingId?: string;
    Email?: string;
    Phone?: string;
    MemberId?: string;
    CustomerId?: string;
    UpcomingOnly?: boolean;
    Limit?: number;
  }) {
    return this.request<{ Bookings: Record<string, any>[]; Count: number } & V1Envelope>(
      "POST",
      "/RESTBooking.svc/booking/search",
      req,
    );
  }
  getBooking(bookingId: string) {
    return this.request<{ Booking: Record<string, any> } & V1Envelope>(
      "GET",
      `/RESTBooking.svc/booking/${encodeURIComponent(bookingId)}`,
    );
  }
  refundBooking(req: {
    BookingId: string;
    RefundTenderCategory: "EWALLET" | "LOYALTY" | "CREDIT";
    TicketIds?: string[];
    RefundConcessions?: boolean;
    RefundBookingFee?: boolean;
    Reason?: string;
    Reference: string;
    InitiatedBy?: string;
    ConversationId?: string;
    ExpectedVersion?: number;
  }) {
    return this.request<
      { Refund: Record<string, any>; Booking: Record<string, any>; Idempotent: boolean } & V1Envelope
    >("POST", "/RESTBooking.svc/booking/refund", req);
  }
  cancelBooking(req: {
    BookingId: string;
    RefundTenderCategory: "EWALLET" | "LOYALTY" | "CREDIT";
    Reason?: string;
    Reference: string;
    InitiatedBy?: string;
    ConversationId?: string;
    ExpectedVersion?: number;
  }) {
    return this.request<
      { Booking: Record<string, any>; Refund: Record<string, any>; Idempotent: boolean } & V1Envelope
    >("POST", "/RESTBooking.svc/booking/cancel", req);
  }
  linkSwappedBookings(fromBookingId: string, toBookingId: string) {
    return this.request<V1Envelope>("POST", "/RESTBooking.svc/booking/link", {
      FromBookingId: fromBookingId,
      ToBookingId: toBookingId,
    });
  }
  markCollected(bookingId: string) {
    return this.request<{ Booking: Record<string, any> } & V1Envelope>(
      "POST",
      "/RESTBooking.svc/booking/collect",
      { BookingId: bookingId },
    );
  }

  // ---------- Loyalty ----------
  validateMember(req: { MemberId?: string; Email?: string; Phone?: string; Pin?: string }) {
    return this.request<{ Member: Record<string, any>; LoyaltySessionToken: string } & V1Envelope>(
      "POST",
      "/RESTLoyalty.svc/member/validate",
      req,
    );
  }
  balances(memberId: string) {
    return this.request<
      {
        MemberId: string;
        Tier: string;
        Balances: { BalanceTypeId: string; Name: string; Points: number | null; ValueCents: number }[];
      } & V1Envelope
    >("GET", `/RESTLoyalty.svc/member/${encodeURIComponent(memberId)}/balances`);
  }

  // ---------- Offers Engine ----------
  offers(params: {
    cinemaId?: string;
    sessionKey?: string;
    experience?: string;
    type?: string;
    memberId?: string;
    eligibleOnly?: boolean;
    bank?: string;
    cardBin?: string;
    ticketCount?: number;
  }) {
    return this.request<{ offers: Record<string, any>[] }>(
      "GET",
      `/offers/v1/offers${this.q(params)}`,
      undefined,
      { v1: false },
    );
  }
  offerEligibility(offerId: string, body: Record<string, unknown>) {
    return this.request<{ offerId: string; eligible: boolean; reasons: string[]; requires: string[] }>(
      "POST",
      `/offers/v1/offers/${encodeURIComponent(offerId)}/eligibility`,
      body,
      { v1: false },
    );
  }

  // ---------- Customer ----------
  customer(id: string) {
    return this.request<Record<string, any>>(
      "GET",
      `/customer/v1/customers/${encodeURIComponent(id)}`,
      undefined,
      { v1: false },
    );
  }
  customerHistory(id: string) {
    return this.request<{ history: Record<string, any>[] }>(
      "GET",
      `/customer/v1/customers/${encodeURIComponent(id)}/history`,
      undefined,
      { v1: false },
    );
  }
}
