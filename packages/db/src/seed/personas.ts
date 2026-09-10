import type { CustomerPreferences } from "../schema/customer.js";

export type Persona = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  memberId: string | null;
  tier?: "Blue" | "Silver" | "Gold" | "Platinum";
  sharePoints?: number;
  voxRewardsCents?: number;
  preferredLanguage: "en" | "ar";
  homeCinemaId: string;
  preferences: CustomerPreferences;
  persona: string;
  /** Short label used on the demo page ("UAE family member"). */
  profile?: "uae" | "india" | "uk" | "guest";
  /** false = not a demo account: a guest (non-member) booking record used for guest lookup/cancellation. */
  account?: boolean;
  pin: string;
  /** Cards stored on the account (masked, as on "Manage Saved Cards"). BINs match the seeded bank offers. */
  savedCards?: {
    token: string;
    brand: "VISA" | "MASTERCARD" | "AMEX";
    first6: string;
    last4: string;
    expiry: string;
    default?: boolean;
  }[];
  /** Booking scenarios to create for this customer. Sessions are picked from the live dataset at seed time. */
  bookings: BookingScenario[];
};

export type BookingScenario = {
  key: string; // stable id for the demo script
  when: "upcoming" | "soon" | "past" | "tomorrow_evening" | "weekend";
  experience?: string;
  cinemaId?: string;
  tickets: { code: string; qty: number }[];
  concessions?: { itemId: string; quantity: number }[];
  offerId?: string;
  payment: "CREDIT" | "EWALLET" | "LOYALTY" | "APPLEPAY";
  status?: "confirmed" | "cancelled" | "collected";
  collected?: boolean;
  bookingId?: string; // force a memorable reference
  genreHint?: string;
  languageHint?: string;
};

export const PERSONAS: Persona[] = [
  // ---------------------------------------------------------------------------------------------
  // 1. UAE customer — Arabic and English films, family (children's films), SHARE Gold, ENBD + FAB cards
  // ---------------------------------------------------------------------------------------------
  {
    id: "cust_sara",
    profile: "uae",
    savedCards: [
      {
        token: "tok_saved_sara_3845",
        brand: "MASTERCARD",
        first6: "521334",
        last4: "3845",
        expiry: "09/2027",
        default: true,
      }, // Emirates NBD
      { token: "tok_saved_sara_8258", brand: "VISA", first6: "417930", last4: "8258", expiry: "12/2029" }, // FAB
    ],
    firstName: "Sara",
    lastName: "Al Mansoori",
    email: "sara.almansoori@example.com",
    phone: "+971501234567",
    memberId: "SHR100234",
    tier: "Gold",
    sharePoints: 2450,
    voxRewardsCents: 12000,
    preferredLanguage: "ar",
    homeCinemaId: "0002",
    preferences: {
      genres: ["Family", "Animation", "Comedy", "Drama"],
      languages: ["Arabic"],
      experiences: ["KIDS", "Standard", "MAX"],
      cinemas: ["0002"],
      timeOfDay: ["afternoon", "evening"],
      days: ["weekend"],
      dietary: ["vegetarian"],
      seatPreference: "middle",
    },
    persona: "UAE family member — Arabic films, SHARE Gold, Mall of the Emirates",
    pin: "1234",
    bookings: [
      {
        key: "sara_upcoming_family",
        when: "weekend",
        experience: "Standard",
        cinemaId: "0002",
        tickets: [
          { code: "0001", qty: 1 },
          { code: "0002", qty: 1 },
        ],
        concessions: [{ itemId: "9540", quantity: 1 }],
        payment: "CREDIT",
        bookingId: "WXA7K2M",
        genreHint: "Family",
      },
      {
        key: "sara_past_kids",
        when: "past",
        experience: "KIDS",
        cinemaId: "0002",
        tickets: [
          { code: "0001", qty: 1 },
          { code: "0002", qty: 2 },
        ],
        payment: "LOYALTY",
        status: "collected",
        collected: true,
        genreHint: "Animation",
      },
      {
        key: "sara_past_arabic",
        when: "past",
        experience: "Standard",
        cinemaId: "0005",
        tickets: [{ code: "0001", qty: 2 }],
        payment: "CREDIT",
        status: "collected",
        collected: true,
        languageHint: "Arabic",
      },
      {
        key: "sara_past_max",
        when: "past",
        experience: "MAX",
        cinemaId: "0005",
        tickets: [{ code: "0001", qty: 2 }],
        concessions: [{ itemId: "7747", quantity: 2 }],
        payment: "CREDIT",
        status: "collected",
        collected: true,
        languageHint: "English",
      },
    ],
  },
  // ---------------------------------------------------------------------------------------------
  // 2. Indian customer — Tamil and Hindi films, late shows, SHARE Silver, ADCB + HSBC cards
  // ---------------------------------------------------------------------------------------------
  {
    id: "cust_rahul",
    profile: "india",
    savedCards: [
      {
        token: "tok_saved_rahul_2211",
        brand: "VISA",
        first6: "409255",
        last4: "2211",
        expiry: "03/2028",
        default: true,
      }, // ADCB
      { token: "tok_saved_rahul_6034", brand: "VISA", first6: "424141", last4: "6034", expiry: "08/2028" }, // HSBC
    ],
    firstName: "Rahul",
    lastName: "Menon",
    email: "rahul.menon@example.com",
    phone: "+971529876543",
    memberId: "SHR200877",
    tier: "Silver",
    sharePoints: 620,
    voxRewardsCents: 3500,
    preferredLanguage: "en",
    homeCinemaId: "0013",
    preferences: {
      genres: ["Action", "Drama", "Thriller"],
      languages: ["Tamil"],
      experiences: ["Standard", "MAX"],
      cinemas: ["0013"],
      timeOfDay: ["late", "evening"],
      days: ["weekday", "weekend"],
      seatPreference: "back",
    },
    persona: "Indian customer — Tamil films, late shows, SHARE Silver, Burjuman",
    pin: "2468",
    bookings: [
      {
        key: "rahul_soon_cutoff",
        when: "soon",
        experience: "Standard",
        cinemaId: "0013",
        tickets: [{ code: "0001", qty: 2 }],
        payment: "CREDIT",
        bookingId: "WM3PQ9X",
        languageHint: "Tamil",
      },
      {
        key: "rahul_bank_offer",
        when: "upcoming",
        experience: "MAX",
        tickets: [{ code: "0001", qty: 2 }],
        offerId: "BANK-ADCB-BOGO",
        payment: "CREDIT",
        bookingId: "WMB6GQ2",
        languageHint: "Hindi",
      },
      {
        key: "rahul_group",
        when: "upcoming",
        experience: "Standard",
        cinemaId: "0001",
        tickets: [{ code: "0001", qty: 3 }],
        concessions: [{ itemId: "7747", quantity: 1 }],
        payment: "CREDIT",
        bookingId: "WKGRP33",
        languageHint: "Tamil",
      },
      {
        key: "rahul_collected",
        when: "upcoming",
        experience: "Standard",
        cinemaId: "0017",
        tickets: [{ code: "0001", qty: 2 }],
        payment: "CREDIT",
        status: "collected",
        collected: true,
        bookingId: "WK4DXC9",
        languageHint: "Hindi",
      },
      {
        key: "rahul_past_tamil",
        when: "past",
        experience: "Standard",
        cinemaId: "0001",
        tickets: [{ code: "0001", qty: 3 }],
        payment: "CREDIT",
        status: "collected",
        collected: true,
        languageHint: "Tamil",
      },
      {
        key: "rahul_past_hindi",
        when: "past",
        experience: "MAX",
        cinemaId: "0017",
        tickets: [{ code: "0001", qty: 2 }],
        concessions: [{ itemId: "7747", quantity: 2 }],
        payment: "LOYALTY",
        status: "collected",
        collected: true,
        languageHint: "Hindi",
      },
    ],
  },
  // ---------------------------------------------------------------------------------------------
  // 3. UK customer — English films only, premium experiences, SHARE Platinum, Mashreq + CBD + UK card
  // ---------------------------------------------------------------------------------------------
  {
    id: "cust_james",
    profile: "uk",
    savedCards: [
      {
        token: "tok_saved_james_7712",
        brand: "MASTERCARD",
        first6: "472937",
        last4: "7712",
        expiry: "06/2027",
        default: true,
      }, // Mashreq
      { token: "tok_saved_james_0099", brand: "VISA", first6: "437745", last4: "0099", expiry: "11/2028" }, // CBD
      { token: "tok_saved_james_5501", brand: "VISA", first6: "465859", last4: "5501", expiry: "04/2029" }, // UK-issued Visa (no VOX offer)
    ],
    firstName: "James",
    lastName: "Whitfield",
    email: "james.whitfield@example.com",
    phone: "+971551112233",
    memberId: "SHR300019",
    tier: "Platinum",
    sharePoints: 8800,
    voxRewardsCents: 45000,
    preferredLanguage: "en",
    homeCinemaId: "0002",
    preferences: {
      genres: ["Drama", "Sci-fi", "Thriller", "Action"],
      languages: ["English"],
      experiences: ["GOLD", "IMAX", "THEATRE", "Standard"],
      cinemas: ["0002"],
      timeOfDay: ["evening"],
      days: ["weekday"],
      seatPreference: "back",
    },
    persona: "UK customer — English films, premium experiences, SHARE Platinum, Mall of the Emirates",
    pin: "9876",
    bookings: [
      {
        key: "james_gold_fnb",
        when: "upcoming",
        experience: "GOLD",
        tickets: [{ code: "0001", qty: 2 }],
        concessions: [
          { itemId: "170", quantity: 1 },
          { itemId: "173", quantity: 2 },
        ],
        payment: "CREDIT",
        bookingId: "WJG8LD7",
        languageHint: "English",
      },
      {
        key: "james_imax",
        when: "tomorrow_evening",
        experience: "IMAX",
        tickets: [{ code: "0131", qty: 2 }],
        payment: "CREDIT",
        offerId: "BANK-MASHREQ-50",
        bookingId: "WJMX42R",
        languageHint: "English",
      },
      {
        key: "james_past_theatre",
        when: "past",
        experience: "THEATRE",
        tickets: [{ code: "0001", qty: 2 }],
        concessions: [{ itemId: "171", quantity: 2 }],
        payment: "CREDIT",
        status: "collected",
        collected: true,
        languageHint: "English",
      },
      {
        key: "james_past_gold2",
        when: "past",
        experience: "GOLD",
        tickets: [{ code: "0001", qty: 1 }],
        payment: "LOYALTY",
        status: "collected",
        collected: true,
        languageHint: "English",
      },
      {
        key: "james_past_standard",
        when: "past",
        experience: "Standard",
        cinemaId: "0012",
        tickets: [{ code: "0001", qty: 2 }],
        payment: "APPLEPAY",
        status: "collected",
        collected: true,
        languageHint: "English",
      },
    ],
  },
  // ---------------------------------------------------------------------------------------------
  // Not an account: a guest (non-member) web booking, used for the guest lookup / verification journey
  // ---------------------------------------------------------------------------------------------
  {
    id: "cust_layla",
    profile: "guest",
    account: false,
    firstName: "Layla",
    lastName: "Haddad",
    email: "layla.haddad@example.com",
    phone: "+971563334455",
    memberId: null,
    preferredLanguage: "ar",
    homeCinemaId: "0035",
    preferences: {},
    persona: "Guest booking (no account) — used to demo find-by-reference with identity verification",
    pin: "0000",
    bookings: [
      {
        key: "layla_guest_upcoming",
        when: "upcoming",
        experience: "Standard",
        cinemaId: "0035",
        tickets: [{ code: "0001", qty: 2 }],
        payment: "CREDIT",
        bookingId: "WLHGST5",
        languageHint: "Arabic",
      },
      {
        key: "layla_cancelled",
        when: "upcoming",
        experience: "Standard",
        cinemaId: "0055",
        tickets: [{ code: "0001", qty: 1 }],
        payment: "CREDIT",
        status: "cancelled",
        bookingId: "WLHCNC2",
      },
    ],
  },
];
