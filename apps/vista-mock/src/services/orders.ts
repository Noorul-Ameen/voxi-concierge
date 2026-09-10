import type { Db } from "@voxi/db";
import {
  schema as S,
  type SeatStatusMap,
  bookingReference,
  generateSeatState,
  pickAdjacentSeats,
  seatKey,
  shortId,
} from "@voxi/db";
import { flattenLayout, nowLocalDate } from "@voxi/db";
import { centsToPoints } from "@voxi/domain";
/**
 * Order lifecycle (Vista V1 Ticketing/Order semantics) with real seat holds.
 * Every mutation runs in a transaction holding a Postgres advisory lock on the session's seat map,
 * so concurrent holds on the same seats are impossible.
 */
import { and, eq, sql } from "drizzle-orm";

export class VistaError extends Error {
  constructor(
    public result: number,
    public extended: number,
    message: string,
  ) {
    super(message);
  }
}

export const RC = {
  OK: 0,
  GENERAL: 1,
  ORDER_NOT_FOUND: 2,
  SESSION_NOT_FOUND: 50,
  TICKET_TYPE_INVALID: 51,
  SEATS_UNAVAILABLE: 52,
  ORDER_EXPIRED: 53,
  INVALID_STATE: 54,
  PAYMENT_DECLINED: 60,
  CONCESSION_INVALID: 70,
  OFFER_NOT_ELIGIBLE: 80,
  INSUFFICIENT_FUNDS: 81,
  BOOKING_NOT_FOUND: 100,
  BOOKING_ALREADY_CANCELLED: 101,
  BOOKING_NOT_REFUNDABLE: 102,
} as const;

export type OrderCfg = { expiryMinutes: number; bookingFeeCentsPerTicket: number; taxRate: number };
const DEFAULT_CFG: OrderCfg = { expiryMinutes: 6, bookingFeeCentsPerTicket: 250, taxRate: 0.05 };

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type OrderRow = typeof S.orders.$inferSelect;

const lockKey = (cinemaId: string, sessionId: string) => `hashtext(${`${cinemaId}-${sessionId}`})`;

export async function withSessionLock<T>(
  db: Db,
  cinemaId: string,
  sessionId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`${cinemaId}-${sessionId}`}))`);
    return fn(tx);
  });
}
void lockKey;

export async function loadSeatState(tx: Tx, cinemaId: string, sessionId: string) {
  const sess = (
    await tx
      .select()
      .from(S.sessions)
      .where(and(eq(S.sessions.cinemaId, cinemaId), eq(S.sessions.sessionId, sessionId)))
  )[0];
  if (!sess)
    throw new VistaError(
      RC.GENERAL,
      RC.SESSION_NOT_FOUND,
      `Session ${sessionId} not found for Cinema ${cinemaId}`,
    );
  const tpl = (
    await tx
      .select()
      .from(S.seatLayoutTemplates)
      .where(eq(S.seatLayoutTemplates.id, sess.seatLayoutTemplateId ?? "STD-M"))
  )[0];
  if (!tpl) throw new VistaError(RC.GENERAL, RC.SESSION_NOT_FOUND, "Seat layout missing");
  let state = (
    await tx
      .select()
      .from(S.sessionSeatState)
      .where(and(eq(S.sessionSeatState.cinemaId, cinemaId), eq(S.sessionSeatState.sessionId, sessionId)))
  )[0];
  if (!state) {
    const seats = generateSeatState(cinemaId, sessionId, tpl.layout, {
      soldOut: sess.soldoutStatus === 2,
      occupancy: sess.totalSeats ? 1 - sess.seatsAvailable / sess.totalSeats : undefined,
    });
    await tx
      .insert(S.sessionSeatState)
      .values({ cinemaId, sessionId, seats, version: 1 })
      .onConflictDoNothing();
    state = (
      await tx
        .select()
        .from(S.sessionSeatState)
        .where(and(eq(S.sessionSeatState.cinemaId, cinemaId), eq(S.sessionSeatState.sessionId, sessionId)))
    )[0]!;
  }
  return { sess, tpl, state };
}

async function saveSeatState(
  tx: Tx,
  cinemaId: string,
  sessionId: string,
  seats: SeatStatusMap,
  expectedVersion: number,
) {
  const res = await tx
    .update(S.sessionSeatState)
    .set({ seats, version: expectedVersion + 1, updatedAt: new Date() })
    .where(
      and(
        eq(S.sessionSeatState.cinemaId, cinemaId),
        eq(S.sessionSeatState.sessionId, sessionId),
        eq(S.sessionSeatState.version, expectedVersion),
      ),
    )
    .returning({ v: S.sessionSeatState.version });
  if (!res.length)
    throw new VistaError(RC.GENERAL, RC.SEATS_UNAVAILABLE, "Seat map changed concurrently; please retry");
  const available = Object.values(seats).filter((x) => x.status === 0).length;
  await tx
    .update(S.sessions)
    .set({ seatsAvailable: available, soldoutStatus: available === 0 ? 2 : available < 10 ? 1 : 0 })
    .where(and(eq(S.sessions.cinemaId, cinemaId), eq(S.sessions.sessionId, sessionId)));
}

function releaseHolds(seats: SeatStatusMap, userSessionId: string) {
  for (const k of Object.keys(seats))
    if (seats[k]!.status === 2 && seats[k]!.orderId === userSessionId) seats[k] = { status: 0 };
}

export function recalc(
  order: OrderRow,
  cfg: OrderCfg = DEFAULT_CFG,
): Pick<OrderRow, "totalValueCents" | "taxValueCents" | "bookingFeeValueCents" | "discountValueCents"> {
  const tickets = order.tickets.reduce((a, t) => a + t.FinalPriceCents, 0);
  const conc = order.concessions.reduce((a, c) => a + c.FinalPriceCents, 0);
  const discount =
    order.tickets.reduce((a, t) => a + t.DiscountPriceCents, 0) +
    order.concessions.reduce((a, c) => a + (c.PriceCents * c.Quantity - c.FinalPriceCents), 0);
  const fee = order.tickets.length * cfg.bookingFeeCentsPerTicket;
  const total = tickets + conc + fee - order.loyaltyPointsPayableValueInCents;
  return {
    totalValueCents: Math.max(0, total),
    // prices are VAT-inclusive, as on the VOX site ("Total before VAT 43.81 · 5% VAT 2.19 · Amount due 46.00")
    taxValueCents: Math.round(tickets + conc - (tickets + conc) / (1 + cfg.taxRate)),
    bookingFeeValueCents: fee,
    discountValueCents: discount,
  };
}

export async function getOrCreateOrder(
  tx: Tx,
  userSessionId: string,
  cinemaId: string,
  sessionId: string | null,
  cfg: OrderCfg,
  conversationId?: string,
): Promise<OrderRow> {
  const existing = (await tx.select().from(S.orders).where(eq(S.orders.userSessionId, userSessionId)))[0];
  if (existing) {
    if (
      existing.state === "expired" ||
      (existing.expiryAt.getTime() <= Date.now() && existing.state !== "paid")
    )
      throw new VistaError(RC.GENERAL, RC.ORDER_EXPIRED, "Order has expired");
    if (existing.state === "paid" || existing.state === "cancelled")
      throw new VistaError(RC.GENERAL, RC.INVALID_STATE, `Order is ${existing.state}`);
    return existing;
  }
  const [row] = await tx
    .insert(S.orders)
    .values({
      userSessionId,
      cinemaId,
      sessionId,
      state: "draft",
      conversationId: conversationId ?? null,
      // Only a new order starts a hold. Basket edits retain this original deadline.
      expiryAt: new Date(Date.now() + cfg.expiryMinutes * 60000),
    })
    .returning();
  return row!;
}

export async function addTickets(
  db: Db,
  req: {
    UserSessionId: string;
    CinemaId: string;
    SessionId: string;
    TicketTypes: { TicketTypeCode: string; Qty: number; OptionalAreaCategoryCode?: string }[];
    SkipAutoAllocation?: boolean;
    UserSelectedSeatingSupported?: boolean;
    ReorderSessionTickets?: boolean;
    SeatPreference?: "front" | "middle" | "back" | "aisle";
    ConversationId?: string;
  },
  cfg: OrderCfg = DEFAULT_CFG,
) {
  return withSessionLock(db, req.CinemaId, req.SessionId, async (tx) => {
    const order = await getOrCreateOrder(
      tx,
      req.UserSessionId,
      req.CinemaId,
      req.SessionId,
      cfg,
      req.ConversationId,
    );
    if (order.sessionId && order.sessionId !== req.SessionId)
      throw new VistaError(
        RC.GENERAL,
        RC.INVALID_STATE,
        "Order already contains tickets for a different session",
      );
    const { sess, tpl, state } = await loadSeatState(tx, req.CinemaId, req.SessionId);
    if (!sess.allowTicketSales || sess.soldoutStatus === 2)
      throw new VistaError(RC.GENERAL, RC.SEATS_UNAVAILABLE, "Session is sold out");
    if (sess.showtime.getTime() <= nowLocalDate().getTime())
      throw new VistaError(RC.GENERAL, RC.SESSION_NOT_FOUND, "Session has already started");
    const types = await tx
      .select()
      .from(S.ticketTypes)
      .where(and(eq(S.ticketTypes.cinemaId, req.CinemaId), eq(S.ticketTypes.experience, sess.experience)));
    const seats = state.seats;
    // Replace (Vista ReorderSessionTickets semantics): drop previous tickets & holds for this session
    releaseHolds(seats, req.UserSessionId);
    const tickets: OrderRow["tickets"] = [];
    let id = 1;
    for (const t of req.TicketTypes) {
      const type =
        types.find((x) => x.ticketTypeCode === t.TicketTypeCode) ??
        types.find((x) => x.ticketTypeCode.endsWith(t.TicketTypeCode));
      if (!type)
        throw new VistaError(
          RC.GENERAL,
          RC.TICKET_TYPE_INVALID,
          `Ticket type ${t.TicketTypeCode} is not valid for this session`,
        );
      if (t.Qty < 1 || t.Qty > (type.quantityAvailablePerOrder ?? 10))
        throw new VistaError(
          RC.GENERAL,
          RC.TICKET_TYPE_INVALID,
          `Quantity ${t.Qty} not allowed for ${type.description}`,
        );
      for (let q = 0; q < t.Qty; q++) {
        tickets.push({
          Id: String(id++),
          TicketTypeCode: type.ticketTypeCode,
          Description: type.description,
          DescriptionAlt: type.descriptionAlt ?? "",
          PriceCents: type.priceInCents,
          DiscountPriceCents: 0,
          FinalPriceCents: type.priceInCents,
          TaxCents: Math.round(type.priceInCents * cfg.taxRate),
          AreaCategoryCode: t.OptionalAreaCategoryCode ?? type.areaCategoryCode,
          SeatRowId: null,
          SeatNumber: null,
          SeatRowIndex: null,
          SeatColumnIndex: null,
          SeatAreaNumber: null,
          DealDescription: null,
          DealDefinitionId: null,
          LoyaltyRecognitionId: null,
        });
      }
    }
    if (tickets.length > 10)
      throw new VistaError(RC.GENERAL, RC.TICKET_TYPE_INVALID, "Maximum 10 tickets per order");
    let seatsAllocated = false;
    if (!req.SkipAutoAllocation && !req.UserSelectedSeatingSupported) {
      // auto-allocate per area category
      const byArea = new Map<string, OrderRow["tickets"]>();
      for (const t of tickets) byArea.set(t.AreaCategoryCode, [...(byArea.get(t.AreaCategoryCode) ?? []), t]);
      for (const [area, ts] of byArea) {
        const picked = pickAdjacentSeats(tpl.layout, seats, ts.length, req.SeatPreference ?? "middle", area);
        if (picked.length < ts.length)
          throw new VistaError(
            RC.GENERAL,
            RC.SEATS_UNAVAILABLE,
            `Not enough adjacent seats available (${ts.length} requested)`,
          );
        picked.forEach((p, i) => {
          const t = ts[i]!;
          t.SeatRowId = p.row;
          t.SeatNumber = p.number;
          t.SeatRowIndex = p.rowIndex;
          t.SeatColumnIndex = p.columnIndex;
          t.SeatAreaNumber = p.areaNumber;
          seats[seatKey(p.row, p.number)] = { status: 2, orderId: req.UserSessionId };
        });
      }
      seatsAllocated = true;
    }
    await saveSeatState(tx, req.CinemaId, req.SessionId, seats, state.version);
    const next = {
      ...order,
      sessionId: req.SessionId,
      tickets,
      seatsAllocated,
      appliedOffers: [],
      loyaltyPointsPayableValueInCents: 0,
      state: (seatsAllocated ? "seats_selected" : "tickets_added") as OrderRow["state"],
    };
    const totals = recalc(next, cfg);
    const [saved] = await tx
      .update(S.orders)
      .set({
        ...next,
        ...totals,
        version: order.version + 1,
        lastUpdatedAt: new Date(),
      })
      .where(and(eq(S.orders.userSessionId, req.UserSessionId), eq(S.orders.version, order.version)))
      .returning();
    if (!saved) throw new VistaError(RC.GENERAL, RC.INVALID_STATE, "Order was modified concurrently");
    return {
      order: saved,
      session: sess,
      availableSeats: Object.values(seats).filter((x) => x.status === 0).length,
    };
  });
}

export async function setSeats(
  db: Db,
  req: {
    UserSessionId: string;
    CinemaId: string;
    SessionId: string;
    SelectedSeats: {
      AreaCategoryCode?: string;
      AreaNumber?: number;
      RowIndex?: number;
      ColumnIndex?: number;
      Row?: string;
      Number?: string;
    }[];
  },
  cfg: OrderCfg = DEFAULT_CFG,
) {
  return withSessionLock(db, req.CinemaId, req.SessionId, async (tx) => {
    const order = await getOrCreateOrder(tx, req.UserSessionId, req.CinemaId, req.SessionId, cfg);
    if (!order.tickets.length)
      throw new VistaError(RC.GENERAL, RC.INVALID_STATE, "Add tickets before selecting seats");
    if (req.SelectedSeats.length !== order.tickets.length)
      throw new VistaError(
        RC.GENERAL,
        RC.SEATS_UNAVAILABLE,
        `Select exactly ${order.tickets.length} seat(s)`,
      );
    const { tpl, state, sess } = await loadSeatState(tx, req.CinemaId, req.SessionId);
    const flat = flattenLayout(tpl.layout);
    const seats = state.seats;
    releaseHolds(seats, req.UserSessionId);
    const chosen = req.SelectedSeats.map((s) => {
      const f =
        s.Row && s.Number
          ? flat.find((x) => x.row.toUpperCase() === s.Row!.toUpperCase() && x.number === String(s.Number))
          : flat.find(
              (x) =>
                x.rowIndex === s.RowIndex &&
                x.columnIndex === s.ColumnIndex &&
                (s.AreaNumber == null || x.areaNumber === s.AreaNumber),
            );
      if (!f)
        throw new VistaError(
          RC.GENERAL,
          RC.SEATS_UNAVAILABLE,
          `Seat ${s.Row ?? s.RowIndex}${s.Number ?? s.ColumnIndex} does not exist`,
        );
      return f;
    });
    for (const f of chosen) {
      const st = seats[seatKey(f.row, f.number)];
      if (!st || st.status !== 0)
        throw new VistaError(
          RC.GENERAL,
          RC.SEATS_UNAVAILABLE,
          `Seat ${f.row}${f.number} is no longer available`,
        );
    }
    // assign chosen seats to tickets by area category (premium view tickets get premium seats)
    const tickets = order.tickets.map((t) => ({ ...t }));
    const remaining = [...chosen];
    for (const t of tickets) {
      const idx = remaining.findIndex((c) => c.areaCategoryCode === t.AreaCategoryCode);
      const f = idx >= 0 ? remaining.splice(idx, 1)[0]! : remaining.shift();
      if (!f) break;
      if (f.areaCategoryCode !== t.AreaCategoryCode) {
        // re-price ticket for the area it landed in (e.g. premium view)
        const types = await tx
          .select()
          .from(S.ticketTypes)
          .where(
            and(
              eq(S.ticketTypes.cinemaId, req.CinemaId),
              eq(S.ticketTypes.experience, sess.experience),
              eq(S.ticketTypes.areaCategoryCode, f.areaCategoryCode),
            ),
          );
        const alt = types.find((x) => x.isChildOnlyTicket === /CHILD/.test(t.Description)) ?? types[0];
        if (alt) {
          t.TicketTypeCode = alt.ticketTypeCode;
          t.Description = alt.description;
          t.PriceCents = alt.priceInCents;
          t.FinalPriceCents = alt.priceInCents - t.DiscountPriceCents;
          t.AreaCategoryCode = alt.areaCategoryCode;
        }
      }
      t.SeatRowId = f.row;
      t.SeatNumber = f.number;
      t.SeatRowIndex = f.rowIndex;
      t.SeatColumnIndex = f.columnIndex;
      t.SeatAreaNumber = f.areaNumber;
      seats[seatKey(f.row, f.number)] = { status: 2, orderId: req.UserSessionId };
    }
    await saveSeatState(tx, req.CinemaId, req.SessionId, seats, state.version);
    const next = { ...order, tickets, seatsAllocated: true, state: "seats_selected" as OrderRow["state"] };
    const totals = recalc(next, cfg);
    const [saved] = await tx
      .update(S.orders)
      .set({
        ...next,
        ...totals,
        version: order.version + 1,
        lastUpdatedAt: new Date(),
      })
      .where(and(eq(S.orders.userSessionId, req.UserSessionId), eq(S.orders.version, order.version)))
      .returning();
    if (!saved) throw new VistaError(RC.GENERAL, RC.INVALID_STATE, "Order was modified concurrently");
    return { order: saved, session: sess };
  });
}

export async function addConcessions(
  db: Db,
  req: {
    UserSessionId: string;
    CinemaId: string;
    Concessions: { ItemId: string; Quantity: number; Modifiers?: { Id: string }[] | string[] }[];
    Replace?: boolean;
    /** Food-only orders (after the tickets are paid) are tied to the show they are collected for. */
    SessionId?: string;
  },
  cfg: OrderCfg = DEFAULT_CFG,
) {
  return db.transaction(async (tx) => {
    const order = await getOrCreateOrder(tx, req.UserSessionId, req.CinemaId, req.SessionId ?? null, cfg);
    const items = await tx.select().from(S.concessionItems).where(eq(S.concessionItems.active, true));
    const lines = req.Replace ? [] : [...order.concessions];
    const failed: { ItemId: string; Reason: string }[] = [];
    for (const c of req.Concessions) {
      const item = items.find((i) => i.id === c.ItemId);
      if (!item) {
        failed.push({ ItemId: c.ItemId, Reason: "Item not found" });
        continue;
      }
      if (c.Quantity < 1 || c.Quantity > 10) {
        failed.push({ ItemId: c.ItemId, Reason: "Quantity must be 1-10" });
        continue;
      }
      const modIds = (c.Modifiers ?? []).map((m) => (typeof m === "string" ? m : m.Id));
      const mods = (item.modifierGroups ?? []).flatMap((g) =>
        g.options
          .filter((o) => modIds.includes(o.id))
          .map((o) => ({ id: o.id, name: o.name, priceInCents: o.priceInCents })),
      );
      const unit = item.priceInCents + mods.reduce((a, m) => a + m.priceInCents, 0);
      const existing = lines.find(
        (l) =>
          l.ItemId === item.id &&
          JSON.stringify(l.Modifiers.map((m) => m.id)) === JSON.stringify(mods.map((m) => m.id)),
      );
      if (existing) {
        existing.Quantity += c.Quantity;
        existing.DealPriceCents = unit * existing.Quantity;
        existing.FinalPriceCents = unit * existing.Quantity;
        existing.TaxCents = Math.round(existing.FinalPriceCents * cfg.taxRate);
      } else {
        lines.push({
          Id: String(lines.length + 1),
          ItemId: item.id,
          Description: item.description,
          Quantity: c.Quantity,
          PriceCents: unit,
          DealPriceCents: unit * c.Quantity,
          FinalPriceCents: unit * c.Quantity,
          TaxCents: Math.round(unit * c.Quantity * cfg.taxRate),
          DeliveryOption: item.isAvailableForInSeatDelivery ? 1 : 2,
          Modifiers: mods,
          DealDefinitionId: null,
          DealDescription: null,
        });
      }
    }
    const next = { ...order, concessions: lines };
    const totals = recalc(next, cfg);
    const [saved] = await tx
      .update(S.orders)
      .set({
        concessions: lines,
        ...totals,
        version: order.version + 1,
        lastUpdatedAt: new Date(),
      })
      .where(and(eq(S.orders.userSessionId, req.UserSessionId), eq(S.orders.version, order.version)))
      .returning();
    if (!saved) throw new VistaError(RC.GENERAL, RC.INVALID_STATE, "Order was modified concurrently");
    return { order: saved, failed };
  });
}

export async function removeConcession(
  db: Db,
  req: { UserSessionId: string; LineId: string },
  cfg: OrderCfg = DEFAULT_CFG,
) {
  return db.transaction(async (tx) => {
    const order = (await tx.select().from(S.orders).where(eq(S.orders.userSessionId, req.UserSessionId)))[0];
    if (!order) throw new VistaError(RC.GENERAL, RC.ORDER_NOT_FOUND, "Order not found");
    const lines = order.concessions.filter((l) => l.Id !== req.LineId);
    const totals = recalc({ ...order, concessions: lines }, cfg);
    const [saved] = await tx
      .update(S.orders)
      .set({ concessions: lines, ...totals, version: order.version + 1, lastUpdatedAt: new Date() })
      .where(eq(S.orders.userSessionId, req.UserSessionId))
      .returning();
    return { order: saved! };
  });
}

export async function getOrder(db: Db, userSessionId: string, cfg: OrderCfg = DEFAULT_CFG) {
  const order = (await db.select().from(S.orders).where(eq(S.orders.userSessionId, userSessionId)))[0];
  if (!order) return null;
  if (
    order.state !== "paid" &&
    order.state !== "cancelled" &&
    order.state !== "expired" &&
    order.expiryAt.getTime() <= Date.now()
  ) {
    await expireOrder(db, userSessionId);
    return { ...order, state: "expired" as const };
  }
  return { ...order, ...recalc(order, cfg) };
}

export async function cancelOrder(db: Db, userSessionId: string) {
  const order = (await db.select().from(S.orders).where(eq(S.orders.userSessionId, userSessionId)))[0];
  if (!order) return { OrderNotFound: true };
  if (order.state === "paid")
    throw new VistaError(RC.GENERAL, RC.INVALID_STATE, "Order already completed; use booking refund");
  if (order.sessionId) {
    await withSessionLock(db, order.cinemaId, order.sessionId, async (tx) => {
      const { state } = await loadSeatState(tx, order.cinemaId, order.sessionId!);
      releaseHolds(state.seats, userSessionId);
      await saveSeatState(tx, order.cinemaId, order.sessionId!, state.seats, state.version);
      await tx
        .update(S.orders)
        .set({
          state: "cancelled",
          tickets: [],
          seatsAllocated: false,
          version: order.version + 1,
          lastUpdatedAt: new Date(),
        })
        .where(eq(S.orders.userSessionId, userSessionId));
    });
  } else {
    await db
      .update(S.orders)
      .set({ state: "cancelled", version: order.version + 1, lastUpdatedAt: new Date() })
      .where(eq(S.orders.userSessionId, userSessionId));
  }
  return { OrderNotFound: false };
}

export async function expireOrder(db: Db, userSessionId: string) {
  const order = (await db.select().from(S.orders).where(eq(S.orders.userSessionId, userSessionId)))[0];
  if (!order || order.state === "paid" || order.state === "cancelled" || order.state === "expired") return;
  if (order.sessionId) {
    await withSessionLock(db, order.cinemaId, order.sessionId, async (tx) => {
      const { state } = await loadSeatState(tx, order.cinemaId, order.sessionId!);
      releaseHolds(state.seats, userSessionId);
      await saveSeatState(tx, order.cinemaId, order.sessionId!, state.seats, state.version);
      await tx
        .update(S.orders)
        .set({ state: "expired", version: order.version + 1, lastUpdatedAt: new Date() })
        .where(eq(S.orders.userSessionId, userSessionId));
    });
  } else
    await db
      .update(S.orders)
      .set({ state: "expired", version: order.version + 1 })
      .where(eq(S.orders.userSessionId, userSessionId));
}

/** Sweep abandoned orders (worker cron). */
export async function expireAbandonedOrders(db: Db): Promise<number> {
  const rows = await db
    .select({ id: S.orders.userSessionId })
    .from(S.orders)
    .where(
      and(sql`${S.orders.state} not in ('paid','cancelled','expired')`, sql`${S.orders.expiryAt} <= now()`),
    );
  for (const r of rows) await expireOrder(db, r.id);
  return rows.length;
}

export type PaymentInfo = {
  PaymentValueCents: number;
  PaymentTenderCategory: string;
  CardNumber?: string;
  CardExpiryMonth?: string;
  CardExpiryYear?: string;
  BankReference?: string;
  PaymentToken?: string;
  UseAsBookingRef?: boolean;
  MemberId?: string;
  PointsRedeemed?: number;
};

export type CompleteReq = {
  UserSessionId: string;
  ExpectedVersion?: number;
  CustomerEmail: string;
  CustomerName: string;
  CustomerPhone: string;
  PerformPayment?: boolean;
  PaymentInfoCollection: PaymentInfo[];
  OptionalClientClass?: string;
  MemberId?: string;
  CustomerId?: string;
  Source?: string;
};

/** Card descriptor for the receipt: a tokenised PAN never reaches Vista, so derive brand + masked number from the token. */
function describeCard(
  p: PaymentInfo,
  savedCards: { token: string; brand: string; first6: string; last4: string }[],
): { brand: string; masked: string } | undefined {
  if (p.PaymentTenderCategory !== "CREDIT" && p.PaymentTenderCategory !== "CREDITCARD") return undefined;
  const saved = p.PaymentToken ? savedCards.find((c) => c.token === p.PaymentToken) : undefined;
  if (saved)
    return {
      brand: saved.brand,
      masked: `${saved.first6.slice(0, 4)} ${saved.first6.slice(4)}XX XXXX ${saved.last4}`,
    };
  const pan = (p.CardNumber ?? "").replace(/\D/g, "");
  if (pan)
    return {
      brand: pan.startsWith("4") ? "VISA" : pan.startsWith("3") ? "AMEX" : "MASTERCARD",
      masked: `${pan.slice(0, 4)} ${pan.slice(4, 6)}XX XXXX ${pan.slice(-4)}`,
    };
  const m = /^tok_(visa|mc|mastercard|amex|applepay|googlepay)_(\d{4})/.exec(p.PaymentToken ?? "");
  if (m) {
    const brand = {
      visa: "VISA",
      mc: "MASTERCARD",
      mastercard: "MASTERCARD",
      amex: "AMEX",
      applepay: "APPLE PAY",
      googlepay: "GOOGLE PAY",
    }[m[1]!]!;
    return { brand, masked: `XXXX XXXX XXXX ${m[2]}` };
  }
  return { brand: "CARD", masked: "XXXX XXXX XXXX XXXX" };
}

/** BIN of the card a tender pays with: saved-card token → stored first6; raw PAN → first 6; wallet tokens → none. */
function paidCardBin(p: PaymentInfo, savedCards: { token: string; first6: string }[]): string | undefined {
  const saved = p.PaymentToken ? savedCards.find((c) => c.token === p.PaymentToken) : undefined;
  if (saved) return saved.first6;
  const pan = (p.CardNumber ?? "").replace(/\D/g, "");
  if (pan.length >= 6) return pan.slice(0, 6);
  // widget tokens for new cards carry the BIN: tok_visa_<bin>_<last4>_<ts>
  const m = /^tok_(?:visa|mc|mastercard|amex)_(\d{6})_/.exec(p.PaymentToken ?? "");
  return m?.[1];
}

/** Simulated Checkout: card rules for the demo. Returns null when approved, else the decline reason. */
export function simulateCardDecision(p: PaymentInfo): string | null {
  const pan = (p.CardNumber ?? "").replace(/\D/g, "");
  if (p.PaymentToken?.startsWith("tok_declined")) return "Card declined by issuer";
  if (p.PaymentToken?.startsWith("tok_")) return null;
  if (!pan) return "Card number missing";
  if (pan.endsWith("0002")) return "Card declined by issuer";
  if (pan.endsWith("0069")) return "Card expired";
  if (pan.endsWith("0119")) return "Processing error — please try again";
  return null;
}

export async function completeOrder(db: Db, req: CompleteReq, cfg: OrderCfg = DEFAULT_CFG) {
  const order = await getOrder(db, req.UserSessionId, cfg);
  if (!order) throw new VistaError(RC.GENERAL, RC.ORDER_NOT_FOUND, "Order not found");
  if (order.state === "expired") throw new VistaError(RC.GENERAL, RC.ORDER_EXPIRED, "Order has expired");
  if (order.state === "paid") {
    // idempotent: return the existing booking
    const b = (
      await db
        .select()
        .from(S.bookings)
        .where(eq(S.bookings.vistaBookingId, order.completedBookingId ?? ""))
    )[0];
    if (b) return { booking: b, order, alreadyCompleted: true };
  }
  const fnbOnly = !order.tickets.length && order.concessions.length > 0;
  if (!order.tickets.length && !fnbOnly)
    throw new VistaError(RC.GENERAL, RC.INVALID_STATE, "Order has no tickets");
  if (!fnbOnly && !order.seatsAllocated)
    throw new VistaError(RC.GENERAL, RC.INVALID_STATE, "Seats not selected");
  if (fnbOnly && !order.sessionId)
    throw new VistaError(RC.GENERAL, RC.INVALID_STATE, "Food order needs the session it is collected for");
  const paid = req.PaymentInfoCollection.reduce((a, p) => a + p.PaymentValueCents, 0);
  if (paid !== order.totalValueCents)
    throw new VistaError(
      RC.GENERAL,
      RC.PAYMENT_DECLINED,
      `Payment ${paid} does not match order total ${order.totalValueCents}`,
    );
  for (const p of req.PaymentInfoCollection) {
    if (p.PaymentTenderCategory === "CREDIT" || p.PaymentTenderCategory === "CREDITCARD") {
      const declined = simulateCardDecision(p);
      if (declined) throw new VistaError(RC.GENERAL, RC.PAYMENT_DECLINED, declined);
    }
  }
  // Bank offers must be paid with a card from that bank — re-check the card actually used at payment.
  const bankOffers = order.appliedOffers.filter((o) => o.bankBins?.length);
  if (bankOffers.length) {
    const custId0 = req.CustomerId ?? order.customerId ?? null;
    const saved = custId0
      ? ((await db.select().from(S.customers).where(eq(S.customers.id, custId0)))[0]?.savedCards ?? [])
      : [];
    const bins = req.PaymentInfoCollection.map((p) => paidCardBin(p, saved)).filter((b): b is string => !!b);
    const cardTender = req.PaymentInfoCollection.some(
      (p) => p.PaymentTenderCategory === "CREDIT" || p.PaymentTenderCategory === "CREDITCARD",
    );
    for (const o of bankOffers) {
      const okCard = bins.some((b) => o.bankBins!.some((x) => b.startsWith(x)));
      if (cardTender && !okCard)
        throw new VistaError(
          RC.GENERAL,
          RC.OFFER_NOT_ELIGIBLE,
          `${o.title} must be paid with an eligible ${o.bankName ?? "bank"} card — pay with that card or remove the offer`,
        );
      if (
        !cardTender &&
        bins.length === 0 &&
        !req.PaymentInfoCollection.every(
          (p) => p.PaymentTenderCategory === "LOYALTY" || p.PaymentTenderCategory === "EWALLET",
        )
      )
        throw new VistaError(
          RC.GENERAL,
          RC.OFFER_NOT_ELIGIBLE,
          `${o.title} requires card payment with an eligible ${o.bankName ?? "bank"} card`,
        );
    }
  }
  return withSessionLock(db, order.cinemaId, order.sessionId!, async (tx) => {
    // A second payment can enter before the first commits; re-read under the session lock.
    const fresh = (await tx.select().from(S.orders).where(eq(S.orders.userSessionId, req.UserSessionId)))[0];
    if (fresh?.state === "paid") {
      const booking = (
        await tx
          .select()
          .from(S.bookings)
          .where(eq(S.bookings.vistaBookingId, fresh.completedBookingId ?? ""))
      )[0];
      if (booking) return { booking, order: fresh, alreadyCompleted: true };
    }
    if (
      !fresh ||
      fresh.version !== order.version ||
      (req.ExpectedVersion != null && fresh.version !== req.ExpectedVersion)
    )
      throw new VistaError(
        RC.GENERAL,
        RC.INVALID_STATE,
        "The order changed; review its current total before payment",
      );
    if (fresh.expiryAt.getTime() <= Date.now() || fresh.state === "expired")
      throw new VistaError(RC.GENERAL, RC.ORDER_EXPIRED, "Order has expired");
    const { state, sess } = await loadSeatState(tx, order.cinemaId, order.sessionId!);
    if (!fnbOnly && sess.showtime.getTime() <= nowLocalDate().getTime())
      throw new VistaError(RC.GENERAL, RC.SESSION_NOT_FOUND, "Session has already started");
    const film = (await tx.select().from(S.films).where(eq(S.films.hoCode, sess.hoCode)))[0]!;
    const custId = req.CustomerId ?? order.customerId ?? null;
    const savedCards = custId
      ? ((await tx.select().from(S.customers).where(eq(S.customers.id, custId)))[0]?.savedCards ?? [])
      : [];
    // Loyalty / wallet tenders debit the member account (with optimistic version check)
    const memberId = req.MemberId ?? req.PaymentInfoCollection.find((p) => p.MemberId)?.MemberId;
    for (const p of req.PaymentInfoCollection) {
      if (p.PaymentTenderCategory === "LOYALTY" || p.PaymentTenderCategory === "EWALLET") {
        if (!memberId)
          throw new VistaError(
            RC.GENERAL,
            RC.INSUFFICIENT_FUNDS,
            "Member id required for loyalty/wallet payments",
          );
        const acct = (
          await tx
            .select()
            .from(S.loyaltyAccounts)
            .where(eq(S.loyaltyAccounts.memberId, memberId))
            .for("update")
        )[0];
        if (!acct) throw new VistaError(RC.GENERAL, RC.INSUFFICIENT_FUNDS, "Loyalty account not found");
        if (p.PaymentTenderCategory === "LOYALTY") {
          const pts = centsToPoints(p.PaymentValueCents); // 10 points = AED 1
          if (p.PointsRedeemed != null && p.PointsRedeemed !== pts)
            throw new VistaError(
              RC.GENERAL,
              RC.PAYMENT_DECLINED,
              "Share Points do not match the payment amount",
            );
          if (acct.sharePointsBalance < pts)
            throw new VistaError(
              RC.GENERAL,
              RC.INSUFFICIENT_FUNDS,
              `Insufficient Share Points (${acct.sharePointsBalance} available)`,
            );
          await tx
            .update(S.loyaltyAccounts)
            .set({
              sharePointsBalance: acct.sharePointsBalance - pts,
              version: acct.version + 1,
              updatedAt: new Date(),
            })
            .where(
              and(eq(S.loyaltyAccounts.memberId, memberId), eq(S.loyaltyAccounts.version, acct.version)),
            );
          await tx.insert(S.loyaltyLedger).values({
            id: shortId(12),
            memberId,
            balanceType: "SHARE_POINTS",
            delta: -pts,
            reason: "Ticket purchase",
            reference: req.UserSessionId,
          });
        } else {
          if (acct.voxRewardsBalanceCents < p.PaymentValueCents)
            throw new VistaError(
              RC.GENERAL,
              RC.INSUFFICIENT_FUNDS,
              `Insufficient VOX credit (AED ${(acct.voxRewardsBalanceCents / 100).toFixed(2)} available)`,
            );
          await tx
            .update(S.loyaltyAccounts)
            .set({
              voxRewardsBalanceCents: acct.voxRewardsBalanceCents - p.PaymentValueCents,
              version: acct.version + 1,
              updatedAt: new Date(),
            })
            .where(
              and(eq(S.loyaltyAccounts.memberId, memberId), eq(S.loyaltyAccounts.version, acct.version)),
            );
          await tx.insert(S.loyaltyLedger).values({
            id: shortId(12),
            memberId,
            balanceType: "VOX_REWARDS",
            delta: -p.PaymentValueCents,
            reason: "Ticket purchase",
            reference: req.UserSessionId,
          });
        }
      }
    }
    // Seats: hold → sold
    let bookingId = bookingReference();
    while (
      (
        await tx
          .select({ id: S.bookings.vistaBookingId })
          .from(S.bookings)
          .where(eq(S.bookings.vistaBookingId, bookingId))
      ).length
    )
      bookingId = bookingReference();
    for (const t of order.tickets) {
      const k = seatKey(t.SeatRowId!, t.SeatNumber!);
      const st = state.seats[k];
      if (!st || (st.status === 2 && st.orderId !== req.UserSessionId) || st.status === 1)
        throw new VistaError(
          RC.GENERAL,
          RC.SEATS_UNAVAILABLE,
          `Seat ${t.SeatRowId}${t.SeatNumber} is no longer held for this order`,
        );
      state.seats[k] = { status: 1, bookingId };
    }
    await saveSeatState(tx, order.cinemaId, order.sessionId!, state.seats, state.version);
    const n = (
      await tx
        .select({ n: sql<number>`coalesce(max(${S.bookings.vistaBookingNumber}),100000)+1` })
        .from(S.bookings)
    )[0]!.n;
    const t = (
      await tx
        .select({ t: sql<number>`coalesce(max(${S.bookings.vistaTransNumber}),500000)+1` })
        .from(S.bookings)
    )[0]!.t;
    const [first, ...rest] = req.CustomerName.trim().split(/\s+/);
    const [booking] = await tx
      .insert(S.bookings)
      .values({
        vistaBookingId: bookingId,
        vistaBookingNumber: Number(n),
        vistaTransNumber: Number(t),
        cinemaId: order.cinemaId,
        sessionId: order.sessionId!,
        hoCode: sess.hoCode,
        filmTitle: film.title,
        filmTitleAlt: film.titleAlt ?? "",
        filmClassification: film.rating ?? "",
        experience: sess.experience,
        screenName: sess.screenName,
        showtime: sess.showtime,
        status: "confirmed",
        customerId: req.CustomerId ?? order.customerId ?? null,
        customer: {
          FirstName: first ?? "",
          LastName: rest.join(" "),
          Email: req.CustomerEmail,
          Phone: req.CustomerPhone,
          ...(memberId ? { MemberId: memberId } : {}),
        },
        tickets: order.tickets.map((tk, i) => ({
          ...tk,
          Barcode: `${bookingId}${String(i + 1).padStart(2, "0")}`,
          Status: "valid" as const,
        })),
        concessions: order.concessions,
        appliedOffers: order.appliedOffers,
        payments: req.PaymentInfoCollection.map((p, i) => {
          const card = describeCard(p, savedCards);
          return {
            PaymentTenderCategory: (p.PaymentTenderCategory === "CREDITCARD"
              ? "CREDIT"
              : p.PaymentTenderCategory) as "CREDIT",
            PaymentValueCents: p.PaymentValueCents,
            CardNumberMasked: card?.masked,
            CardType: card?.brand,
            BankReference: p.BankReference,
            PointsRedeemed: p.PointsRedeemed,
            Reference: `${p.PaymentTenderCategory.slice(0, 3)}${t}${i}`,
          };
        }),
        totalValueCents: order.totalValueCents,
        taxValueCents: order.taxValueCents,
        bookingFeeValueCents: order.bookingFeeValueCents,
        salesChannel: req.OptionalClientClass ?? "WWW",
        source: req.Source ?? "concierge",
        qrPayload: `VOX|${bookingId}|${order.cinemaId}|${order.sessionId}${fnbOnly ? "|FNB" : ""}`,
        bookedAt: new Date(),
        updatedAt: new Date(),
      })
      .returning();
    await tx
      .update(S.orders)
      .set({
        state: "paid",
        completedBookingId: bookingId,
        version: order.version + 1,
        lastUpdatedAt: new Date(),
      })
      .where(eq(S.orders.userSessionId, req.UserSessionId));
    // commit offer redemptions, earn points
    await tx
      .update(S.offerRedemptions)
      .set({ status: "committed", bookingId })
      .where(eq(S.offerRedemptions.orderUserSessionId, req.UserSessionId));
    if (memberId) {
      const acct = (
        await tx.select().from(S.loyaltyAccounts).where(eq(S.loyaltyAccounts.memberId, memberId))
      )[0];
      if (acct) {
        const multiplier = order.appliedOffers.find(
          (o) => o.type === "loyalty" && o.reference === "points_multiplier",
        )
          ? 2
          : 1;
        const earn = Math.round((order.totalValueCents / 100) * 1) * multiplier; // SHARE: 1 point per AED spent (demo)
        await tx
          .update(S.loyaltyAccounts)
          .set({
            sharePointsBalance: sql`${S.loyaltyAccounts.sharePointsBalance} + ${earn}`,
            version: sql`${S.loyaltyAccounts.version} + 1`,
          })
          .where(eq(S.loyaltyAccounts.memberId, memberId));
        await tx.insert(S.loyaltyLedger).values({
          id: shortId(12),
          memberId,
          balanceType: "SHARE_POINTS",
          delta: earn,
          reason: `Earned on booking ${bookingId}`,
          reference: bookingId,
        });
      }
    }
    if (booking!.customerId) {
      await tx.insert(S.purchaseHistory).values({
        id: `ph_${bookingId}`,
        customerId: booking!.customerId,
        bookingId,
        cinemaId: order.cinemaId,
        hoCode: sess.hoCode,
        filmTitle: film.title,
        genres: film.genreNames ?? [],
        language: film.language ?? "",
        experience: sess.experience,
        showtime: sess.showtime,
        ticketCount: order.tickets.length,
        concessionItemIds: order.concessions.map((c) => c.ItemId),
        spendCents: order.totalValueCents,
      });
    }
    return { booking: booking!, order: { ...order, state: "paid" as const }, alreadyCompleted: false };
  });
}
