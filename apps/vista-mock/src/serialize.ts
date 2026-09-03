/** DB rows → Vista Connect V1 JSON shapes (as in the VOX partner integration document). */
import type { schema as S } from "@voxi/db";

type Cinema = typeof S.cinemas.$inferSelect;
type Film = typeof S.films.$inferSelect;
type Session = typeof S.sessions.$inferSelect;
type Attr = typeof S.sessionAttributes.$inferSelect;
type TicketType = typeof S.ticketTypes.$inferSelect;
type Concession = typeof S.concessionItems.$inferSelect;

/** Vista returns cinema-local wall time without offset, e.g. "2021-04-06T03:05:00". */
export const localIso = (d: Date) => d.toISOString().slice(0, 19);
/** Legacy Microsoft JSON date: /Date(ms+0400)/ */
export const msJsonDate = (d: Date, offsetMinutes = 240) => {
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const utcMs = d.getTime() - offsetMinutes * 60000; // stored as local wall time in UTC fields
  return `/Date(${utcMs}${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}${String(abs % 60).padStart(2, "0")})/`;
};
export const offsetIso = (d: Date, offset = "+04:00") => `${d.toISOString().slice(0, 19)}.0000000${offset}`;

export function cinemaJson(c: Cinema) {
  return {
    ID: c.id,
    CinemaNationalId: c.cinemaNationalId ?? "",
    Name: c.name,
    NameAlt: c.nameAlt ?? "",
    PhoneNumber: c.phoneNumber ?? "",
    EmailAddress: c.emailAddress ?? "",
    Address1: c.address1 ?? "",
    Address2: c.address2 ?? "",
    City: c.city ?? "",
    Latitude: c.latitude ?? "",
    Longitude: c.longitude ?? "",
    ParkingInfo: c.parkingInfo ?? "",
    LoyaltyCode: c.loyaltyCode ?? "",
    IsGiftStore: c.isGiftStore ?? false,
    Description: c.description ?? "",
    DescriptionAlt: c.descriptionAlt,
    PublicTransport: c.publicTransport ?? "",
    CurrencyCode: c.currencyCode,
    AllowPrintAtHomeBookings: c.allowPrintAtHomeBookings ?? false,
    AllowOnlineVoucherValidation: c.allowOnlineVoucherValidation ?? true,
    DisplaySofaSeats: c.displaySofaSeats ?? false,
    TimeZoneId: c.timeZoneId ?? "Arabian Standard Time",
    HOPK: c.hopk ?? c.id,
    NameTranslations: [{ Language: "ar", Text: c.nameAlt ?? "" }],
    DescriptionTranslations: [],
    ParkingInfoTranslations: [],
    PublicTransportTranslations: [],
    TipsCompulsory: false,
    TipPercentages: "0.00,0.00,0.00,0.00",
    ServerName: c.serverName ?? "",
    IsInTouchEnabled: false,
    IsGetHelpEnabled: false,
    PrimaryDataLanguage: null,
    AlternateDataLanguage1: null,
    AlternateDataLanguage2: null,
    AlternateDataLanguage3: null,
    // ---- extensions (not in Vista; harmless for real consumers, used by the concierge) ----
    Extensions: {
      Slug: c.slug,
      MallName: c.mallName,
      Emirate: c.emirate,
      ShortCode: c.shortCode,
      OpeningHours: c.openingHours,
      AccessibilityInfo: c.accessibilityInfo,
      InMallDirections: c.inMallDirections,
      InMallDirectionsAlt: c.inMallDirectionsAlt,
      BestParking: c.bestParking,
      Experiences: c.experiences,
      WebsiteUrl: c.websiteUrl,
    },
  };
}

export function filmJson(f: Film, cinemaId?: string) {
  return {
    Cast: f.cast ?? [],
    ID: cinemaId ? `${cinemaId}-${f.hoCode}` : f.hoCode,
    ScheduledFilmId: f.hoCode,
    CinemaId: cinemaId ?? null,
    Title: f.title,
    TitleAlt: f.titleAlt ?? "",
    Rating: f.rating ?? "",
    RatingDescription: f.ratingDescription ?? "",
    RatingDescriptionAlt: f.ratingDescriptionAlt ?? "",
    Synopsis: f.synopsis ?? "",
    SynopsisAlt: f.synopsisAlt ?? "",
    OpeningDate: f.openingDate ? localIso(f.openingDate) : null,
    RunTime: String(f.runTime ?? 0),
    TrailerUrl: f.trailerUrl ?? "",
    GenreId: f.genreIds?.[0] ?? null,
    GenreId2: f.genreIds?.[1] ?? null,
    GenreId3: f.genreIds?.[2] ?? null,
    Genres: (f.genreNames ?? []).map((n, i) => ({ ID: f.genreIds?.[i] ?? "", Name: n })),
    IsScheduledAtCinema: f.isScheduledAtCinema,
    IsComingSoon: f.status === "coming_soon",
    IsAdvanceSale: f.status === "advance",
    Language: f.language ?? "",
    Subtitles: f.subtitles ?? "",
    PosterUrl: f.posterUrl ?? "",
    HeroUrl: f.heroUrl ?? "",
    WebsiteUrl: f.websiteUrl ?? "",
    Slug: f.slug ?? "",
    Status: f.status,
    ...((f.cast ?? []).filter((c) => c.PersonType === "Director").length
      ? {
          Director: (f.cast ?? [])
            .filter((c) => c.PersonType === "Director")
            .map((c) => `${c.FirstName} ${c.LastName}`.trim())
            .join(", "),
        }
      : {}),
  };
}

export function attributeJson(a: Attr) {
  return {
    ID: a.id,
    Description: a.description,
    ShortName: a.shortName,
    AltDescription: a.altDescription ?? "",
    AltShortName: a.altShortName ?? "",
    Message: a.message ?? "",
    MessageAlt: "",
    WarningMessage: null,
    WarningMessageAlt: null,
    SalesChannels: a.salesChannels,
    IsUsedForConcepts: a.isUsedForConcepts,
    IsUsedForSessionAdvertising: a.isUsedForSessionAdvertising,
    DisplayPriority: a.displayPriority,
    DescriptionTranslations: [],
    ShortNameTranslations: [],
    MessageTranslations: [],
    SessionAttributeCinemaIDs: [],
    IsPromoted: false,
  };
}

export function sessionJson(s: Session, attrs: Attr[], film?: Film) {
  const sessionAttrs = (s.attributeIds ?? [])
    .map((id) => attrs.find((a) => a.id === id))
    .filter((a): a is Attr => !!a);
  return {
    Attributes: sessionAttrs.map(attributeJson),
    ID: `${s.cinemaId}-${s.sessionId}`,
    CinemaId: s.cinemaId,
    ScheduledFilmId: s.hoCode,
    SessionId: s.sessionId,
    AreaCategoryCodes: s.areaCategoryCodes ?? [],
    MinimumTicketPriceInCents: null,
    Showtime: localIso(s.showtime),
    IsAllocatedSeating: s.isAllocatedSeating ?? true,
    AllowChildAdmits: s.allowChildAdmits ?? true,
    SeatsAvailable: s.seatsAvailable,
    AllowComplimentaryTickets: false,
    EventId: "",
    GlobalEventId: null,
    PriceGroupCode: s.priceGroupCode ?? "",
    ScreenName: s.screenName,
    ScreenNameAlt: "",
    ScreenNumber: s.screenNumber,
    CinemaOperatorCode: s.cinemaOperatorCode,
    FormatCode: s.formatCode ?? "0000000001",
    FormatHOPK: s.formatCode ?? "0000000001",
    SalesChannels: s.salesChannels,
    SessionAttributesNames: sessionAttrs.map((a) => a.shortName),
    ConceptAttributesNames: [],
    AllowTicketSales: s.allowTicketSales ?? true,
    HasDynamicallyPricedTicketsAvailable: false,
    PlayThroughId: null,
    SessionBusinessDate: `${s.sessionBusinessDate}T00:00:00`,
    SessionDisplayPriority: 0,
    GroupSessionsByAttribute: false,
    SoldoutStatus: s.soldoutStatus ?? 0,
    TypeCode: s.typeCode ?? "01",
    // extensions
    Experience: s.experience,
    TotalSeats: s.totalSeats,
    FilmTitle: film?.title ?? null,
    FilmRating: film?.rating ?? null,
    Language: s.language ?? film?.language ?? "",
    BookingUrl: s.bookingUrl ?? "",
  };
}

export function ticketTypeJson(t: TicketType) {
  return {
    AreaCategoryCode: t.areaCategoryCode,
    CinemaId: t.cinemaId,
    Description: t.description,
    DescriptionAlt: t.descriptionAlt ?? "",
    DescriptionTranslations: [],
    DiscountsAvailable: null,
    DisplaySequence: t.displaySequence ?? 1,
    HOPK: t.hopk ?? "",
    HeadOfficeGroupingCode: t.headOfficeGroupingCode ?? "",
    IsAllocatableSeating: true,
    IsAvailableAsLoyaltyRecognitionOnly: false,
    IsAvailableForLoyaltyMembersOnly: t.isAvailableForLoyaltyMembersOnly ?? false,
    IsChildOnlyTicket: t.isChildOnlyTicket ?? false,
    IsComplimentaryTicket: false,
    IsDynamicallyPriced: false,
    IsPackageTicket: t.isPackageTicket ?? false,
    IsRedemptionTicket: false,
    IsThirdPartyMemberTicket: false,
    LongDescription: t.longDescription ?? "",
    LongDescriptionAlt: "",
    LongDescriptionTranslations: [],
    LoyaltyBalanceTypeId: null,
    LoyaltyPointsCost: t.loyaltyPointsCost ?? null,
    LoyaltyQuantityAvailable: null,
    LoyaltyRecognitionId: null,
    MaxServiceFeeInCents: null,
    MinServiceFeeInCents: null,
    PackageContent: { Concessions: [], Tickets: [] },
    PriceGroupCode: t.priceGroupCode ?? "",
    PriceInCents: t.priceInCents,
    ProductCodeForVoucher: "",
    QuantityAvailablePerOrder: t.quantityAvailablePerOrder ?? 10,
    ResalePriceInCents: null,
    SalesChannels: t.salesChannels ?? [],
    SurchargeAmount: 0,
    ThirdPartyMembershipName: "",
    TicketTypeCode: t.ticketTypeCode,
    TotalTicketFeeAmountInCents: 250,
    Experience: t.experience,
  };
}

export function concessionJson(c: Concession) {
  return {
    Id: c.id,
    HeadOfficeItemCode: c.headOfficeItemCode ?? "",
    HOPK: c.hopk ?? "",
    Description: c.description,
    DescriptionAlt: c.descriptionAlt ?? "",
    ExtendedDescription: c.extendedDescription ?? "",
    ExtendedDescriptionAlt: c.extendedDescriptionAlt ?? "",
    PriceInCents: c.priceInCents,
    TaxInCents: c.taxInCents,
    IsVariablePriceItem: false,
    MinimumVariablePriceInCents: null,
    MaximumVariablePriceInCents: null,
    ItemClassCode: c.itemClassCode ?? "BOX",
    RequiresPickup: c.isAvailableForPickupAtCounter ?? true,
    CanGetBarcode: false,
    ShippingMethod: "N",
    RestrictToLoyalty: false,
    LoyaltyDiscountCode: "",
    RecognitionMaxQuantity: 0,
    RecognitionPointsCost: 0,
    IsRecognitionOnly: false,
    RecognitionId: 0,
    RecognitionSequenceNumber: 0,
    RecognitionExpiryDate: null,
    RedeemableType: 1,
    IsAvailableForInSeatDelivery: c.isAvailableForInSeatDelivery ?? false,
    IsAvailableForPickupAtCounter: c.isAvailableForPickupAtCounter ?? true,
    VoucherSaleType: "",
    DescriptionTranslations: [],
    AlternateItems: [],
    PackageChildItems: (c.packageChildItems ?? []).map((p) => ({ ItemId: p.itemId, Quantity: p.quantity })),
    ModifierGroups: (c.modifierGroups ?? []).map((g) => ({
      Name: g.name,
      IsRequired: g.required,
      Modifiers: g.options.map((o) => ({ Id: o.id, Description: o.name, PriceInCents: o.priceInCents })),
    })),
    SmartModifiers: [],
    DiscountsAvailable: [],
    // extensions
    ImageUrl: c.imageUrl ?? "",
    DietaryTags: c.dietaryTags ?? [],
    Allergens: c.allergens ?? [],
    Calories: c.calories,
    IsCombo: c.isCombo ?? false,
    IsBestSeller: c.isBestSeller ?? false,
    Experiences: c.experiences ?? [],
  };
}
