/**
 * Commerce: ticket types, seat layouts, concessions, orders, bookings, payments, refunds.
 * Shapes follow Vista Connect V1 so the mock can serialise them faithfully.
 */
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { customers } from "./customer.js";
import { cinemas } from "./reference.js";

/** Ticket types per cinema + experience + area category (Vista GetTicketsForSession). */
export const ticketTypes = pgTable(
  "ticket_types",
  {
    id: varchar("id", { length: 32 }).primaryKey(), // `${cinemaId}-${ticketTypeCode}`
    cinemaId: varchar("cinema_id", { length: 8 })
      .notNull()
      .references(() => cinemas.id),
    ticketTypeCode: varchar("ticket_type_code", { length: 8 }).notNull(),
    experience: varchar("experience", { length: 32 }).notNull(),
    areaCategoryCode: varchar("area_category_code", { length: 10 }).notNull(),
    description: text("description").notNull(),
    descriptionAlt: text("description_alt").default(""),
    longDescription: text("long_description").default(""),
    priceInCents: integer("price_in_cents").notNull(),
    hopk: varchar("hopk", { length: 8 }).default(""),
    headOfficeGroupingCode: varchar("head_office_grouping_code", { length: 12 }).default(""),
    isChildOnlyTicket: boolean("is_child_only").default(false),
    isPackageTicket: boolean("is_package").default(false),
    isAvailableForLoyaltyMembersOnly: boolean("loyalty_only").default(false),
    loyaltyPointsCost: integer("loyalty_points_cost"),
    quantityAvailablePerOrder: integer("qty_per_order").default(10),
    displaySequence: integer("display_sequence").default(1),
    priceGroupCode: text("price_group_code").default(""),
    salesChannels: jsonb("sales_channels")
      .$type<string[]>()
      .default(["CALL", "CELL", "KIOSK", "POS", "POSBK", "WWW"]),
  },
  (t) => [index("ticket_types_cinema_exp_idx").on(t.cinemaId, t.experience)],
);

export type SeatCell = {
  row: string; // physical row name "A"
  rowIndex: number;
  columnIndex: number;
  id: string; // seat number label "5"
  areaNumber: number;
  areaCategoryCode: string;
  style: number; // 0 normal, 1 wheelchair, 2 sofa/couch, 3 companion
  priority: number;
};
export type SeatLayoutTemplate = {
  areas: {
    number: number;
    areaCategoryCode: string;
    description: string;
    rows: { name: string; seats: { id: string; columnIndex: number; style?: number }[] }[];
    left: number;
    top: number;
    width: number;
    height: number;
  }[];
  rowCount: number;
  columnCount: number;
};

export const seatLayoutTemplates = pgTable("seat_layout_templates", {
  id: varchar("id", { length: 32 }).primaryKey(), // e.g. "STD-M", "MAX-L", "GOLD-S"
  experience: varchar("experience", { length: 32 }).notNull(),
  name: text("name").notNull(),
  totalSeats: integer("total_seats").notNull(),
  layout: jsonb("layout").$type<SeatLayoutTemplate>().notNull(),
});

/**
 * Per-session seat occupancy. Status codes follow Vista: 0 = available, 1 = sold, 2 = held/reserved,
 * 3 = unavailable (broken/social). Keyed by "row:col". Versioned for optimistic concurrency.
 */
export const sessionSeatState = pgTable(
  "session_seat_state",
  {
    cinemaId: varchar("cinema_id", { length: 8 }).notNull(),
    sessionId: varchar("session_id", { length: 16 }).notNull(),
    seats: jsonb("seats")
      .$type<Record<string, { status: number; orderId?: string; bookingId?: string }>>()
      .notNull(),
    version: integer("version").notNull().default(1),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.cinemaId, t.sessionId] })],
);

export type ModifierGroup = {
  name: string;
  required: boolean;
  options: { id: string; name: string; priceInCents: number }[];
};

export const concessionItems = pgTable(
  "concession_items",
  {
    id: varchar("id", { length: 16 }).primaryKey(),
    cinemaId: varchar("cinema_id", { length: 8 }), // null = all cinemas
    tab: text("tab").notNull(), // Combos | Popcorn | Drinks | Snacks | Hot Food | Desserts | Kids | GOLD Menu
    headOfficeItemCode: varchar("head_office_item_code", { length: 16 }).default(""),
    hopk: varchar("hopk", { length: 8 }).default(""),
    description: text("description").notNull(),
    descriptionAlt: text("description_alt").default(""),
    extendedDescription: text("extended_description").default(""),
    extendedDescriptionAlt: text("extended_description_alt").default(""),
    priceInCents: integer("price_in_cents").notNull(),
    taxInCents: integer("tax_in_cents").notNull().default(0),
    itemClassCode: varchar("item_class_code", { length: 8 }).default("BOX"),
    imageUrl: text("image_url").default(""),
    dietaryTags: jsonb("dietary_tags").$type<string[]>().default([]), // vegetarian | vegan | gluten_free | nut_free | halal | contains_dairy
    allergens: jsonb("allergens").$type<string[]>().default([]),
    calories: integer("calories"),
    isCombo: boolean("is_combo").default(false),
    packageChildItems: jsonb("package_child_items")
      .$type<{ itemId: string; quantity: number }[]>()
      .default([]),
    modifierGroups: jsonb("modifier_groups").$type<ModifierGroup[]>().default([]),
    experiences: jsonb("experiences").$type<string[]>().default([]), // empty = all
    isAvailableForInSeatDelivery: boolean("in_seat_delivery").default(false),
    isAvailableForPickupAtCounter: boolean("pickup_at_counter").default(true),
    isBestSeller: boolean("is_best_seller").default(false),
    displaySequence: integer("display_sequence").default(100),
    active: boolean("active").notNull().default(true),
  },
  (t) => [index("concession_tab_idx").on(t.tab)],
);

export type OrderTicketLine = {
  Id: string;
  TicketTypeCode: string;
  Description: string;
  DescriptionAlt: string;
  PriceCents: number;
  DiscountPriceCents: number;
  FinalPriceCents: number;
  TaxCents: number;
  AreaCategoryCode: string;
  SeatRowId: string | null;
  SeatNumber: string | null;
  SeatRowIndex: number | null;
  SeatColumnIndex: number | null;
  SeatAreaNumber: number | null;
  DealDescription: string | null;
  DealDefinitionId: string | null;
  LoyaltyRecognitionId: string | null;
};
export type OrderConcessionLine = {
  Id: string;
  ItemId: string;
  Description: string;
  Quantity: number;
  PriceCents: number;
  DealPriceCents: number;
  FinalPriceCents: number;
  TaxCents: number;
  DeliveryOption: number;
  Modifiers: { id: string; name: string; priceInCents: number }[];
  DealDefinitionId: string | null;
  DealDescription: string | null;
};
export type AppliedOffer = {
  offerId: string;
  title: string;
  type: string;
  discountCents: number;
  pointsRedeemed?: number;
  reference?: string;
};

export type OrderState =
  | "draft"
  | "tickets_added"
  | "seats_selected"
  | "awaiting_payment"
  | "paid"
  | "expired"
  | "cancelled";

/** In-progress order / cart (Vista Order). Keyed by client-generated UserSessionId. */
export const orders = pgTable(
  "orders",
  {
    userSessionId: varchar("user_session_id", { length: 64 }).primaryKey(),
    cinemaId: varchar("cinema_id", { length: 8 })
      .notNull()
      .references(() => cinemas.id),
    sessionId: varchar("session_id", { length: 16 }),
    state: varchar("state", { length: 24 }).$type<OrderState>().notNull().default("draft"),
    tickets: jsonb("tickets").$type<OrderTicketLine[]>().notNull().default([]),
    concessions: jsonb("concessions").$type<OrderConcessionLine[]>().notNull().default([]),
    appliedOffers: jsonb("applied_offers").$type<AppliedOffer[]>().notNull().default([]),
    totalValueCents: integer("total_value_cents").notNull().default(0),
    taxValueCents: integer("tax_value_cents").notNull().default(0),
    bookingFeeValueCents: integer("booking_fee_value_cents").notNull().default(0),
    discountValueCents: integer("discount_value_cents").notNull().default(0),
    loyaltyPointsPayableValueInCents: integer("loyalty_points_payable_cents").notNull().default(0),
    customerId: varchar("customer_id", { length: 32 }).references(() => customers.id),
    customer: jsonb("customer").$type<{
      FirstName: string;
      LastName: string;
      Email: string;
      Phone: string;
      MemberId?: string;
    }>(),
    conversationId: varchar("conversation_id", { length: 64 }),
    optionalClientClass: varchar("client_class", { length: 8 }).default("WWW"),
    seatsAllocated: boolean("seats_allocated").notNull().default(false),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUpdatedAt: timestamp("last_updated_at", { withTimezone: true }).notNull().defaultNow(),
    expiryAt: timestamp("expiry_at", { withTimezone: true }).notNull(),
    completedBookingId: varchar("completed_booking_id", { length: 16 }),
  },
  (t) => [
    index("orders_state_expiry_idx").on(t.state, t.expiryAt),
    index("orders_conversation_idx").on(t.conversationId),
  ],
);

export type BookingStatus =
  | "confirmed"
  | "cancelled"
  | "refunded"
  | "partially_refunded"
  | "swapped"
  | "collected";
export type BookingTicket = OrderTicketLine & { Barcode: string; Status: "valid" | "refunded" | "used" };
export type BookingPayment = {
  PaymentTenderCategory: "CREDIT" | "EWALLET" | "LOYALTY" | "VOUCHER" | "APPLEPAY" | "GOOGLEPAY";
  PaymentValueCents: number;
  CardNumberMasked?: string;
  CardType?: string;
  BankReference?: string;
  PointsRedeemed?: number;
  Reference: string;
};

/** Completed order = booking. Cannot be amended; can be searched, refunded, cancelled, swapped. */
export const bookings = pgTable(
  "bookings",
  {
    vistaBookingId: varchar("vista_booking_id", { length: 16 }).primaryKey(), // e.g. "WL59LFJ"
    vistaBookingNumber: integer("vista_booking_number").notNull(),
    vistaTransNumber: integer("vista_trans_number").notNull(),
    cinemaId: varchar("cinema_id", { length: 8 })
      .notNull()
      .references(() => cinemas.id),
    sessionId: varchar("session_id", { length: 16 }).notNull(),
    hoCode: varchar("ho_code", { length: 12 }).notNull(),
    filmTitle: text("film_title").notNull(),
    filmTitleAlt: text("film_title_alt").default(""),
    filmClassification: varchar("film_classification", { length: 12 }).default(""),
    experience: varchar("experience", { length: 32 }).notNull(),
    screenName: text("screen_name").notNull(),
    showtime: timestamp("showtime").notNull(), // cinema-local
    status: varchar("status", { length: 24 }).$type<BookingStatus>().notNull().default("confirmed"),
    customerId: varchar("customer_id", { length: 32 }).references(() => customers.id),
    customer: jsonb("customer")
      .$type<{ FirstName: string; LastName: string; Email: string; Phone: string; MemberId?: string }>()
      .notNull(),
    tickets: jsonb("tickets").$type<BookingTicket[]>().notNull(),
    concessions: jsonb("concessions").$type<OrderConcessionLine[]>().notNull().default([]),
    appliedOffers: jsonb("applied_offers").$type<AppliedOffer[]>().notNull().default([]),
    payments: jsonb("payments").$type<BookingPayment[]>().notNull(),
    totalValueCents: integer("total_value_cents").notNull(),
    taxValueCents: integer("tax_value_cents").notNull().default(0),
    bookingFeeValueCents: integer("booking_fee_value_cents").notNull().default(0),
    refundedValueCents: integer("refunded_value_cents").notNull().default(0),
    salesChannel: varchar("sales_channel", { length: 8 }).notNull().default("WWW"),
    source: varchar("source", { length: 16 }).notNull().default("seed"), // seed | concierge | website
    qrPayload: text("qr_payload").default(""),
    swappedFromBookingId: varchar("swapped_from_booking_id", { length: 16 }),
    swappedToBookingId: varchar("swapped_to_booking_id", { length: 16 }),
    isThirdParty: boolean("is_third_party").notNull().default(false),
    ticketsCollected: boolean("tickets_collected").notNull().default(false),
    version: integer("version").notNull().default(1),
    bookedAt: timestamp("booked_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("bookings_customer_idx").on(t.customerId),
    index("bookings_email_idx").on(t.customer),
    index("bookings_session_idx").on(t.cinemaId, t.sessionId),
    uniqueIndex("bookings_number_idx").on(t.cinemaId, t.vistaBookingNumber),
  ],
);

export const refunds = pgTable(
  "refunds",
  {
    id: varchar("id", { length: 32 }).primaryKey(),
    bookingId: varchar("booking_id", { length: 16 })
      .notNull()
      .references(() => bookings.vistaBookingId),
    amountCents: integer("amount_cents").notNull(),
    method: varchar("method", { length: 24 }).notNull(), // VOX_CREDIT | SHARE_POINTS | ORIGINAL_PAYMENT
    tenderCategory: varchar("tender_category", { length: 16 }).notNull(), // EWALLET | LOYALTY | CREDIT
    ticketIds: jsonb("ticket_ids").$type<string[]>().notNull().default([]),
    reason: text("reason").default(""),
    reference: varchar("reference", { length: 32 }).notNull(),
    status: varchar("status", { length: 16 }).notNull().default("completed"), // completed | pending | failed
    initiatedBy: varchar("initiated_by", { length: 32 }).notNull().default("concierge"),
    conversationId: varchar("conversation_id", { length: 64 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("refunds_booking_idx").on(t.bookingId)],
);
