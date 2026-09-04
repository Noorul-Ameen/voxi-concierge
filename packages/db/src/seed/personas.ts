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
  {
    id: "cust_sara",
    savedCards: [
      {
        token: "tok_saved_sara_3845",
        brand: "MASTERCARD",
        first6: "521334",
        last4: "3845",
        expiry: "09/2027",
        default: true,
      },
      { token: "tok_saved_sara_8258", brand: "VISA", first6: "455533", last4: "8258", expiry: "12/2029" },
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
      genres: ["Family", "Animation", "Adventure"],
      languages: ["English", "Arabic"],
      experiences: ["KIDS", "Standard", "MAX"],
      cinemas: ["0002", "0005"],
      timeOfDay: ["afternoon", "evening"],
      days: ["weekend"],
      dietary: ["vegetarian"],
      seatPreference: "middle",
    },
    persona: "Family, SHARE Gold, Arabic-preferred, home cinema Mall of the Emirates",
    pin: "1234",
    bookings: [
      {
        key: "sara_upcoming_family",
        when: "weekend",
        experience: "Standard",
        cinemaId: "0002",
        tickets: [
          { code: "0001", qty: 2 },
          { code: "0002", qty: 2 },
        ],
        concessions: [{ itemId: "9540", quantity: 1 }],
        payment: "CREDIT",
        bookingId: "VXA7K2M",
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
        key: "sara_past_max",
        when: "past",
        experience: "MAX",
        cinemaId: "0005",
        tickets: [{ code: "0001", qty: 2 }],
        concessions: [{ itemId: "7747", quantity: 2 }],
        payment: "CREDIT",
        status: "collected",
        collected: true,
      },
    ],
  },
  {
    id: "cust_rahul",
    savedCards: [
      {
        token: "tok_saved_rahul_2211",
        brand: "VISA",
        first6: "409255",
        last4: "2211",
        expiry: "03/2028",
        default: true,
      },
    ],
    firstName: "Rahul",
    lastName: "Menon",
    email: "rahul.menon@example.com",
    phone: "+971529876543",
    memberId: "SHR200877",
    tier: "Silver",
    sharePoints: 620,
    voxRewardsCents: 0,
    preferredLanguage: "en",
    homeCinemaId: "0013",
    preferences: {
      genres: ["Action", "Drama", "Thriller"],
      languages: ["Malayalam", "Hindi", "Tamil"],
      experiences: ["Standard", "MAX"],
      cinemas: ["0013", "0001", "0017"],
      timeOfDay: ["late", "evening"],
      days: ["weekday", "weekend"],
      seatPreference: "back",
    },
    persona: "South-Indian cinema fan, late shows, Burjuman / Deira",
    pin: "2468",
    bookings: [
      {
        key: "rahul_soon_cutoff",
        when: "soon",
        experience: "Standard",
        cinemaId: "0013",
        tickets: [{ code: "0001", qty: 2 }],
        payment: "CREDIT",
        bookingId: "RM3PQ9X",
        languageHint: "Malayalam",
      },
      {
        key: "rahul_bank_offer",
        when: "upcoming",
        experience: "MAX",
        tickets: [{ code: "0001", qty: 2 }],
        offerId: "BANK-ENBD-BOGO",
        payment: "CREDIT",
        bookingId: "RMB0GO1",
        languageHint: "Hindi",
      },
      {
        key: "rahul_past",
        when: "past",
        experience: "Standard",
        cinemaId: "0001",
        tickets: [{ code: "0001", qty: 3 }],
        payment: "CREDIT",
        status: "collected",
        collected: true,
        languageHint: "Tamil",
      },
    ],
  },
  {
    id: "cust_james",
    savedCards: [
      {
        token: "tok_saved_james_0099",
        brand: "VISA",
        first6: "424141",
        last4: "0099",
        expiry: "11/2028",
        default: true,
      },
      {
        token: "tok_saved_james_7712",
        brand: "MASTERCARD",
        first6: "472937",
        last4: "7712",
        expiry: "06/2027",
      },
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
    homeCinemaId: "0046",
    preferences: {
      genres: ["Drama", "Sci-fi", "Thriller"],
      languages: ["English"],
      experiences: ["GOLD", "THEATRE", "IMAX"],
      cinemas: ["0046", "0014", "0002"],
      timeOfDay: ["evening"],
      days: ["weekday"],
      seatPreference: "back",
    },
    persona: "Premium regular (GOLD/THEATRE/IMAX), Platinum member, Abu Dhabi",
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
        bookingId: "JWG0LD7",
      },
      {
        key: "james_imax",
        when: "tomorrow_evening",
        experience: "IMAX",
        tickets: [{ code: "0131", qty: 2 }],
        payment: "EWALLET",
        bookingId: "JWIMX42",
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
      },
      {
        key: "james_past_gold2",
        when: "past",
        experience: "GOLD",
        tickets: [{ code: "0001", qty: 1 }],
        payment: "LOYALTY",
        status: "collected",
        collected: true,
      },
    ],
  },
  {
    id: "cust_layla",
    firstName: "Layla",
    lastName: "Haddad",
    email: "layla.haddad@example.com",
    phone: "+971563334455",
    memberId: null,
    preferredLanguage: "ar",
    homeCinemaId: "0035",
    preferences: {
      genres: ["Comedy", "Romance"],
      languages: ["Arabic", "English"],
      experiences: ["Standard"],
      cinemas: ["0035", "0055"],
    },
    persona: "Guest (no SHARE account), Sharjah, Arabic-speaking",
    pin: "0000",
    bookings: [
      {
        key: "layla_guest_upcoming",
        when: "upcoming",
        experience: "Standard",
        cinemaId: "0035",
        tickets: [{ code: "0001", qty: 2 }],
        payment: "CREDIT",
        bookingId: "LHGUEST5",
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
        bookingId: "LHCANC01",
      },
    ],
  },
  {
    id: "cust_omar",
    savedCards: [
      {
        token: "tok_saved_omar_4410",
        brand: "VISA",
        first6: "437745",
        last4: "4410",
        expiry: "01/2029",
        default: true,
      },
    ],
    firstName: "Omar",
    lastName: "Khan",
    email: "omar.khan@example.com",
    phone: "+971544445566",
    memberId: "SHR400551",
    tier: "Blue",
    sharePoints: 106,
    voxRewardsCents: 2500,
    preferredLanguage: "en",
    homeCinemaId: "0105",
    preferences: {
      genres: ["Action", "Horror", "Sci-fi"],
      languages: ["English"],
      experiences: ["Standard", "4DX"],
      cinemas: ["0105", "0001"],
      timeOfDay: ["late"],
      days: ["weekend"],
      seatPreference: "front",
    },
    persona: "Student, budget-conscious, group bookings, Festival City",
    pin: "1111",
    bookings: [
      {
        key: "omar_group",
        when: "upcoming",
        experience: "Standard",
        cinemaId: "0105",
        tickets: [{ code: "0003", qty: 3 }],
        concessions: [{ itemId: "7747", quantity: 1 }],
        payment: "CREDIT",
        bookingId: "OKGRP33",
        genreHint: "Action",
      },
      {
        key: "omar_4dx_collected",
        when: "upcoming",
        experience: "4DX",
        tickets: [{ code: "0001", qty: 2 }],
        payment: "CREDIT",
        status: "collected",
        collected: true,
        bookingId: "OK4DXC0",
      },
    ],
  },
  {
    id: "cust_fatima",
    firstName: "Fatima",
    lastName: "Al Zaabi",
    email: "fatima.alzaabi@example.com",
    phone: "+971505556677",
    memberId: "SHR500002",
    tier: "Blue",
    sharePoints: 0,
    voxRewardsCents: 0,
    preferredLanguage: "ar",
    homeCinemaId: "0012",
    preferences: {},
    persona: "New SHARE member, no history (cold start), Abu Dhabi",
    pin: "5555",
    bookings: [],
  },
];
