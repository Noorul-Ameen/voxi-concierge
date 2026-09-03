/** Customers, loyalty (Share Points / VOX Rewards), offers engine, purchase history. */
import { boolean, index, integer, jsonb, pgTable, text, timestamp, varchar } from "drizzle-orm/pg-core";

export type CustomerPreferences = {
  genres?: string[];
  languages?: string[];
  experiences?: string[];
  cinemas?: string[];
  timeOfDay?: ("morning" | "afternoon" | "evening" | "late")[];
  days?: ("weekday" | "weekend")[];
  dietary?: string[];
  seatPreference?: "front" | "middle" | "back" | "aisle";
};

export const customers = pgTable(
  "customers",
  {
    id: varchar("id", { length: 32 }).primaryKey(),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    email: text("email").notNull(),
    phone: text("phone").notNull(),
    memberId: varchar("member_id", { length: 24 }), // loyalty member id (Share)
    preferredLanguage: varchar("preferred_language", { length: 4 }).default("en"),
    dateOfBirth: text("date_of_birth"),
    preferences: jsonb("preferences").$type<CustomerPreferences>().default({}),
    homeCinemaId: varchar("home_cinema_id", { length: 8 }),
    persona: text("persona").default(""), // seed label for demo personas
    demoPin: varchar("demo_pin", { length: 8 }).default("0000"), // simulated login
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("customers_email_idx").on(t.email),
    index("customers_phone_idx").on(t.phone),
    index("customers_member_idx").on(t.memberId),
  ],
);

export const loyaltyAccounts = pgTable("loyalty_accounts", {
  memberId: varchar("member_id", { length: 24 }).primaryKey(),
  customerId: varchar("customer_id", { length: 32 })
    .notNull()
    .references(() => customers.id),
  tier: varchar("tier", { length: 16 }).notNull().default("Blue"), // Blue | Silver | Gold | Platinum
  sharePointsBalance: integer("share_points_balance").notNull().default(0), // 1 point = AED 0.01 (100 pts = AED 1) — demo assumption
  voxRewardsBalanceCents: integer("vox_rewards_balance_cents").notNull().default(0), // VOX credit wallet
  version: integer("version").notNull().default(1),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const loyaltyLedger = pgTable(
  "loyalty_ledger",
  {
    id: varchar("id", { length: 32 }).primaryKey(),
    memberId: varchar("member_id", { length: 24 })
      .notNull()
      .references(() => loyaltyAccounts.memberId),
    balanceType: varchar("balance_type", { length: 16 }).notNull(), // SHARE_POINTS | VOX_REWARDS
    delta: integer("delta").notNull(),
    reason: text("reason").notNull(),
    reference: varchar("reference", { length: 32 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("loyalty_ledger_member_idx").on(t.memberId)],
);

export type OfferRules = {
  cinemaIds?: string[]; // empty/undefined = all
  experiences?: string[];
  days?: number[]; // 0..6 (0 = Sunday)
  timeFrom?: string; // "10:00"
  timeTo?: string;
  hoCodes?: string[];
  minTickets?: number;
  maxTicketsPerRedemption?: number;
  ticketTypeCodes?: string[];
  membersOnly?: boolean;
  tiers?: string[];
  bankBins?: string[]; // first 6 digits of card
  bankName?: string;
  promoCode?: string;
  validFrom?: string; // ISO date
  validTo?: string;
  channels?: string[];
};
export type OfferBenefit =
  | { type: "percent_off"; percent: number; appliesTo: "tickets" | "concessions" | "order" }
  | { type: "amount_off_cents"; amountCents: number; appliesTo: "tickets" | "concessions" | "order" }
  | { type: "bogo"; buy: number; get: number }
  | { type: "fixed_price_cents"; priceCents: number; appliesTo: "tickets" }
  | { type: "points_multiplier"; multiplier: number }
  | { type: "free_item"; itemId: string };

export const offers = pgTable(
  "offers",
  {
    id: varchar("id", { length: 32 }).primaryKey(),
    title: text("title").notNull(),
    titleAlt: text("title_alt").default(""),
    shortDescription: text("short_description").notNull(),
    shortDescriptionAlt: text("short_description_alt").default(""),
    terms: text("terms").default(""),
    termsAlt: text("terms_alt").default(""),
    type: varchar("type", { length: 16 }).notNull(), // bank | promo | loyalty | member | partner
    imageUrl: text("image_url").default(""),
    rules: jsonb("rules").$type<OfferRules>().notNull().default({}),
    benefit: jsonb("benefit").$type<OfferBenefit>().notNull(),
    totalBudget: integer("total_budget"), // remaining redemptions budget (null = unlimited)
    remainingBudget: integer("remaining_budget"),
    perMemberLimit: integer("per_member_limit"),
    howToRedeem: text("how_to_redeem").default(""),
    active: boolean("active").notNull().default(true),
    priority: integer("priority").notNull().default(100),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("offers_type_idx").on(t.type)],
);

export const offerRedemptions = pgTable(
  "offer_redemptions",
  {
    id: varchar("id", { length: 32 }).primaryKey(),
    offerId: varchar("offer_id", { length: 32 })
      .notNull()
      .references(() => offers.id),
    memberId: varchar("member_id", { length: 24 }),
    orderUserSessionId: varchar("order_user_session_id", { length: 64 }),
    bookingId: varchar("booking_id", { length: 16 }),
    discountCents: integer("discount_cents").notNull(),
    status: varchar("status", { length: 16 }).notNull().default("applied"), // applied | committed | released
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("offer_redemptions_member_idx").on(t.memberId)],
);

/** Purchase history for personalisation (denormalised so recommendations don't need bookings joins). */
export const purchaseHistory = pgTable(
  "purchase_history",
  {
    id: varchar("id", { length: 32 }).primaryKey(),
    customerId: varchar("customer_id", { length: 32 })
      .notNull()
      .references(() => customers.id),
    bookingId: varchar("booking_id", { length: 16 }),
    cinemaId: varchar("cinema_id", { length: 8 }).notNull(),
    hoCode: varchar("ho_code", { length: 12 }),
    filmTitle: text("film_title").notNull(),
    genres: jsonb("genres").$type<string[]>().default([]),
    language: text("language").default(""),
    experience: varchar("experience", { length: 32 }).notNull(),
    showtime: timestamp("showtime").notNull(),
    ticketCount: integer("ticket_count").notNull().default(1),
    concessionItemIds: jsonb("concession_item_ids").$type<string[]>().default([]),
    spendCents: integer("spend_cents").notNull().default(0),
  },
  (t) => [index("purchase_history_customer_idx").on(t.customerId)],
);
