/**
 * Vista reference data (browse layer). Column names follow Vista Connect OData entities so the
 * mock can serialise rows to the exact JSON the VOX partner API returns.
 */
import { boolean, date, index, integer, jsonb, pgTable, primaryKey, text, timestamp, varchar } from "drizzle-orm/pg-core";

export type Translation = { Language: string; Text: string };
export type CastMember = {
  ID: string;
  FirstName: string;
  LastName: string;
  UrlToDetails: string;
  UrlToPicture: string;
  PersonType: "Actor" | "Director";
};
export type OpeningHours = { day: number; open: string; close: string }[]; // 0=Sunday, "10:00"

export const cinemas = pgTable("cinemas", {
  id: varchar("id", { length: 8 }).primaryKey(), // Vista CinemaId e.g. "0002"
  cinemaNationalId: varchar("cinema_national_id", { length: 32 }).default(""),
  name: text("name").notNull(),
  nameAlt: text("name_alt").default(""),
  phoneNumber: text("phone_number").default(""),
  emailAddress: text("email_address").default(""),
  address1: text("address1").default(""),
  address2: text("address2").default(""),
  city: text("city").default(""),
  latitude: text("latitude").default(""),
  longitude: text("longitude").default(""),
  parkingInfo: text("parking_info").default(""),
  loyaltyCode: varchar("loyalty_code", { length: 8 }).default(""),
  isGiftStore: boolean("is_gift_store").default(false),
  description: text("description").default(""),
  descriptionAlt: text("description_alt"),
  publicTransport: text("public_transport").default(""),
  currencyCode: varchar("currency_code", { length: 3 }).notNull().default("AED"),
  allowPrintAtHomeBookings: boolean("allow_print_at_home").default(false),
  allowOnlineVoucherValidation: boolean("allow_online_voucher").default(true),
  displaySofaSeats: boolean("display_sofa_seats").default(false),
  timeZoneId: text("time_zone_id").default("Arabian Standard Time"),
  hopk: varchar("hopk", { length: 8 }).default(""),
  serverName: text("server_name").default(""),
  // --- concierge extensions (not part of Vista; surfaced by concierge only) ---
  slug: text("slug").notNull(),
  mallName: text("mall_name").default(""),
  emirate: text("emirate").default(""),
  shortCode: varchar("short_code", { length: 8 }).default(""), // e.g. MOE, DCC
  openingHours: jsonb("opening_hours").$type<OpeningHours>().default([]),
  accessibilityInfo: text("accessibility_info").default(""),
  inMallDirections: text("in_mall_directions").default(""),
  inMallDirectionsAlt: text("in_mall_directions_alt").default(""),
  bestParking: text("best_parking").default(""),
  experiences: jsonb("experiences").$type<string[]>().default([]),
  websiteUrl: text("website_url").default(""),
  active: boolean("active").notNull().default(true),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const filmGenres = pgTable("film_genres", {
  id: varchar("id", { length: 10 }).primaryKey(), // "0000000001"
  name: text("name").notNull(),
  nameTranslations: jsonb("name_translations").$type<Translation[]>().default([]),
  description: text("description").default(""),
});

/** Head-office film (OData Films entity). One row per HO film id. */
export const films = pgTable(
  "films",
  {
    hoCode: varchar("ho_code", { length: 12 }).primaryKey(), // "HO00013356"
    title: text("title").notNull(),
    titleAlt: text("title_alt").default(""),
    rating: varchar("rating", { length: 12 }).default(""),
    ratingDescription: text("rating_description").default(""),
    ratingDescriptionAlt: text("rating_description_alt").default(""),
    synopsis: text("synopsis").default(""),
    synopsisAlt: text("synopsis_alt").default(""),
    openingDate: timestamp("opening_date", { withTimezone: false }),
    runTime: integer("run_time").default(0),
    trailerUrl: text("trailer_url").default(""),
    genreIds: jsonb("genre_ids").$type<string[]>().default([]),
    genreNames: jsonb("genre_names").$type<string[]>().default([]),
    cast: jsonb("cast").$type<CastMember[]>().default([]),
    language: text("language").default(""),
    subtitles: text("subtitles").default(""),
    posterUrl: text("poster_url").default(""),
    heroUrl: text("hero_url").default(""),
    slug: text("slug").default(""),
    websiteUrl: text("website_url").default(""),
    status: varchar("status", { length: 16 }).notNull().default("now_showing"), // now_showing | coming_soon | advance
    isScheduledAtCinema: boolean("is_scheduled_at_cinema").notNull().default(true),
    sourceHash: text("source_hash").default(""),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("films_status_idx").on(t.status), index("films_title_idx").on(t.title)],
);

/** Film scheduled at a specific cinema (OData ScheduledFilms). ID = `${cinemaId}-${hoCode}`. */
export const scheduledFilms = pgTable(
  "scheduled_films",
  {
    cinemaId: varchar("cinema_id", { length: 8 })
      .notNull()
      .references(() => cinemas.id),
    hoCode: varchar("ho_code", { length: 12 })
      .notNull()
      .references(() => films.hoCode),
    firstShowtime: timestamp("first_showtime"),
    lastShowtime: timestamp("last_showtime"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.cinemaId, t.hoCode] })],
);

/** Experience / cinema operator codes (OData CinemaOperators). ID = `${cinemaId}-${code}`. */
export const cinemaOperators = pgTable(
  "cinema_operators",
  {
    cinemaId: varchar("cinema_id", { length: 8 })
      .notNull()
      .references(() => cinemas.id),
    code: varchar("code", { length: 16 }).notNull(), // MOESTD, MOEMAX, MOEVG...
    name: text("name").notNull(),
    shortName: text("short_name").notNull(),
    experience: varchar("experience", { length: 32 }).notNull(), // Standard | MAX | GOLD | KIDS | 4DX | THEATRE | ...
  },
  (t) => [primaryKey({ columns: [t.cinemaId, t.code] })],
);

export const sessionAttributes = pgTable("session_attributes", {
  id: varchar("id", { length: 10 }).primaryKey(),
  description: text("description").notNull(),
  shortName: text("short_name").notNull(),
  altDescription: text("alt_description").default(""),
  altShortName: text("alt_short_name").default(""),
  message: text("message").default(""),
  salesChannels: text("sales_channels").default("|IVR|CALL|WWW|KIOSK|CELL|PDA|POS|POSBK|RSP|"),
  isUsedForConcepts: boolean("is_used_for_concepts").default(false),
  isUsedForSessionAdvertising: boolean("is_used_for_session_advertising").default(true),
  displayPriority: integer("display_priority").default(100),
});

/** Showtime (OData Sessions). ID = `${cinemaId}-${sessionId}`. */
export const sessions = pgTable(
  "sessions",
  {
    cinemaId: varchar("cinema_id", { length: 8 })
      .notNull()
      .references(() => cinemas.id),
    sessionId: varchar("session_id", { length: 16 }).notNull(), // Vista SessionId, e.g. "627470"
    hoCode: varchar("ho_code", { length: 12 })
      .notNull()
      .references(() => films.hoCode),
    showtime: timestamp("showtime").notNull(), // cinema-local wall time (no tz), as Vista returns it
    sessionBusinessDate: date("session_business_date").notNull(),
    screenName: text("screen_name").notNull(),
    screenNumber: integer("screen_number").notNull().default(1),
    cinemaOperatorCode: varchar("cinema_operator_code", { length: 16 }).notNull(),
    experience: varchar("experience", { length: 32 }).notNull(),
    formatCode: varchar("format_code", { length: 10 }).default("0000000001"),
    attributeIds: jsonb("attribute_ids").$type<string[]>().default([]),
    areaCategoryCodes: jsonb("area_category_codes").$type<string[]>().default(["0000000001", "0000000002"]),
    seatsAvailable: integer("seats_available").notNull().default(0),
    totalSeats: integer("total_seats").notNull().default(0),
    isAllocatedSeating: boolean("is_allocated_seating").default(true),
    allowChildAdmits: boolean("allow_child_admits").default(true),
    allowTicketSales: boolean("allow_ticket_sales").default(true),
    soldoutStatus: integer("soldout_status").default(0),
    priceGroupCode: text("price_group_code").default(""),
    salesChannels: text("sales_channels").default(";UNO;SAPP;POS;POSBK;IVR;KIOSK;WWW;PDA;CELL;CALL;RSP;GSALE;"),
    typeCode: varchar("type_code", { length: 4 }).default("01"),
    seatLayoutTemplateId: varchar("seat_layout_template_id", { length: 32 }),
    bookingUrl: text("booking_url").default(""),
    language: text("language").default(""),
    sourceHash: text("source_hash").default(""),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.cinemaId, t.sessionId] }),
    index("sessions_film_idx").on(t.hoCode),
    index("sessions_showtime_idx").on(t.showtime),
    index("sessions_cinema_date_idx").on(t.cinemaId, t.sessionBusinessDate),
  ],
);
