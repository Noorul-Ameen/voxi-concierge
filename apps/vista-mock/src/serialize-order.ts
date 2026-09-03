import type { schema as S } from "@voxi/db";
import type { SeatLayoutTemplate } from "@voxi/db";
import { localIso, msJsonDate, offsetIso } from "./serialize.js";

type Order = typeof S.orders.$inferSelect;
type Session = typeof S.sessions.$inferSelect;
type Booking = typeof S.bookings.$inferSelect;

export function ticketLineJson(t: Order["tickets"][number] & { Barcode?: string; Status?: string }) {
  return {
    Id: t.Id,
    TicketTypeCode: t.TicketTypeCode,
    TicketTypeHOPK: t.TicketTypeCode,
    TicketCode: t.Id,
    PriceCents: t.PriceCents,
    Barcode: t.Barcode ?? "",
    SeatData: t.SeatRowId ? `${t.SeatRowId}${t.SeatNumber}` : "",
    Description: t.Description,
    AltDescription: t.DescriptionAlt,
    DescriptionTranslations: [],
    IsTicketPackage: false,
    DiscountsAvailable: [],
    PackageId: null,
    LoyaltyRecognitionId: t.LoyaltyRecognitionId,
    LoyaltyRecognitionSequence: 0,
    PackageTickets: null,
    PackageConcessions: null,
    DiscountPriceCents: t.DiscountPriceCents,
    PromotionTicketTypeId: null,
    PromotionInstanceGroupNumber: null,
    SeatNumber: t.SeatNumber,
    SeatRowId: t.SeatRowId,
    SeatIsDeliverable: null,
    SeatAreaCatCode: t.AreaCategoryCode,
    SeatAreaNumber: t.SeatAreaNumber != null ? String(t.SeatAreaNumber) : null,
    SeatRowIndex: t.SeatRowIndex,
    SeatColumnIndex: t.SeatColumnIndex,
    DealPriceCents: t.FinalPriceCents,
    DealDefinitionId: t.DealDefinitionId,
    DealDescription: t.DealDescription,
    FinalPriceCents: t.FinalPriceCents,
    TaxCents: t.TaxCents,
    BookingStatus: t.Status === "refunded" ? 2 : t.Status === "used" ? 1 : 0,
    BookingFee: null,
    Status: t.Status ?? "pending",
  };
}

export function concessionLineJson(c: Order["concessions"][number]) {
  return {
    Id: c.Id,
    ItemId: c.ItemId,
    Description: c.Description,
    Quantity: c.Quantity,
    PromoCode: null,
    RecognitionId: null,
    RecognitionSequenceNumber: 0,
    IsLoyaltyMembershipActivation: false,
    HeadOfficeItemCode: null,
    GetBarcodeFromVGC: false,
    ParentSaleItem: null,
    PackageChildItems: null,
    IsParentSaleChildItem: false,
    DeliveryInfo: null,
    Modifiers: c.Modifiers.map((m) => ({ Id: m.id, Description: m.name, PriceInCents: m.priceInCents })),
    SmartModifiers: [],
    SmartModifierExtras: [],
    RecipeItems: [],
    VoucherBarcode: null,
    DeliveryOption: c.DeliveryOption,
    VariablePriceInCents: null,
    UnitPriceCents: c.PriceCents,
    DealPriceCents: c.DealPriceCents,
    DealDefinitionId: c.DealDefinitionId,
    DealDescription: c.DealDescription,
    GiftCardNumber: "",
    FinalPriceCents: c.FinalPriceCents,
    TaxCents: c.TaxCents,
    SessionId: null,
    BookingStatus: 0,
  };
}

export function orderJson(
  o: Order,
  session: Session | null,
  film: { title: string; titleAlt: string | null; rating: string | null } | null,
) {
  return {
    UserSessionId: o.userSessionId,
    CinemaId: o.cinemaId,
    TotalValueCents: o.totalValueCents,
    TaxValueCents: o.taxValueCents,
    BookingFeeValueCents: o.bookingFeeValueCents,
    BookingFeeTaxValueCents: 0,
    DiscountValueCents: o.discountValueCents,
    TotalOrderCount: o.tickets.length + o.concessions.length,
    Sessions: session
      ? [
          {
            CinemaId: o.cinemaId,
            SessionId: Number.isNaN(Number(session.sessionId))
              ? session.sessionId
              : Number(session.sessionId),
            AllocatedSeating: true,
            SeatsAllocated: o.seatsAllocated,
            Tickets: o.tickets.map(ticketLineJson),
            FilmTitle: film?.title ?? "",
            AltFilmTitle: film?.titleAlt ?? "",
            FilmTitleTranslations: [],
            FilmClassification: film?.rating ?? "",
            AltFilmClassification: "",
            ShowingRealDateTime: msJsonDate(session.showtime),
            ShowingRealDateTimeOffset: offsetIso(session.showtime),
            ScreenName: session.screenName,
            Experience: session.experience,
          },
        ]
      : [],
    Concessions: o.concessions.length ? o.concessions.map(concessionLineJson) : null,
    BookingFees: o.bookingFeeValueCents
      ? [{ Description: "Booking fee", ValueCents: o.bookingFeeValueCents }]
      : [],
    Customer: {
      FirstName: o.customer?.FirstName ?? "",
      LastName: o.customer?.LastName ?? "",
      ID: o.customerId,
      Email: o.customer?.Email ?? "",
      Phone: o.customer?.Phone ?? "",
      MobilePhone: null,
      Gender: "",
      DateOfBirth: null,
      Address: {
        State: null,
        ZipCode: "",
        Suburb: null,
        Address1: null,
        Address2: null,
        City: null,
        ValidationReference: null,
      },
    },
    VistaTransactionNumber: 0,
    VistaBookingNumber: 0,
    LastUpdated: msJsonDate(o.lastUpdatedAt),
    LastUpdatedUtc: o.lastUpdatedAt.toISOString(),
    CreatedDateUtc: o.createdAt.toISOString(),
    ExpiryDate: msJsonDate(o.expiryAt),
    ExpiryDateUtc: o.expiryAt.toISOString(),
    TotalTicketFeeValueInCents: o.bookingFeeValueCents,
    LoyaltyPointsCost: null,
    LoyaltyPointsPayableValueInCents: o.loyaltyPointsPayableValueInCents,
    AppliedLoyaltyPointsPayments: o.appliedOffers
      .filter((a) => a.pointsRedeemed)
      .map((a) => ({ PointsRedeemed: a.pointsRedeemed, ValueCents: a.discountCents })),
    AppliedGiftCards: [],
    AppliedPaymentVouchers: [],
    SuggestedDeals: [],
    DealVouchers: [],
    AppliedOffers: o.appliedOffers,
    HasCardPaymentPromotionTickets: o.appliedOffers.some((a) => a.type === "bank"),
    PromotionCards: [],
    State: o.state,
  };
}

export function bookingJson(b: Booking) {
  return {
    VistaBookingId: b.vistaBookingId,
    VistaBookingNumber: b.vistaBookingNumber,
    VistaTransNumber: b.vistaTransNumber,
    CinemaId: b.cinemaId,
    SessionId: b.sessionId,
    ScheduledFilmId: b.hoCode,
    FilmTitle: b.filmTitle,
    AltFilmTitle: b.filmTitleAlt ?? "",
    FilmClassification: b.filmClassification ?? "",
    Experience: b.experience,
    ScreenName: b.screenName,
    Showtime: localIso(b.showtime),
    ShowingRealDateTimeOffset: offsetIso(b.showtime),
    Status: b.status,
    BookingStatus: b.status === "confirmed" ? 0 : b.status === "collected" ? 1 : 2,
    Customer: {
      FirstName: b.customer.FirstName,
      LastName: b.customer.LastName,
      Email: b.customer.Email,
      Phone: b.customer.Phone,
      MemberId: b.customer.MemberId ?? null,
      ID: b.customerId,
    },
    Tickets: b.tickets.map(ticketLineJson),
    Concessions: b.concessions.map(concessionLineJson),
    AppliedOffers: b.appliedOffers,
    PaymentInfoCollection: b.payments.map((p) => ({
      PaymentTenderCategory: p.PaymentTenderCategory,
      PaymentValueCents: p.PaymentValueCents,
      CardNumber: p.CardNumberMasked ?? "",
      CardType: p.CardType ?? "",
      BankReference: p.BankReference ?? null,
      PointsRedeemed: p.PointsRedeemed ?? null,
      Reference: p.Reference,
    })),
    TotalValueCents: b.totalValueCents,
    TaxValueCents: b.taxValueCents,
    BookingFeeValueCents: b.bookingFeeValueCents,
    RefundedValueCents: b.refundedValueCents,
    SalesChannel: b.salesChannel,
    Source: b.source,
    QrPayload: b.qrPayload ?? "",
    TicketsCollected: b.ticketsCollected,
    IsThirdParty: b.isThirdParty,
    SwappedFromBookingId: b.swappedFromBookingId,
    SwappedToBookingId: b.swappedToBookingId,
    Version: b.version,
    BookedAtUtc: b.bookedAt.toISOString(),
    LastUpdatedUtc: b.updatedAt.toISOString(),
  };
}

/** Vista GetSessionSeatPlan shape from a template + occupancy map. */
export function seatPlanJson(
  layout: SeatLayoutTemplate,
  seats: Record<string, { status: number; orderId?: string }>,
  forUserSessionId?: string,
) {
  let rowIndexGlobal = 0;
  const areas = layout.areas.map((a) => {
    const rows = a.rows.map((r) => {
      const ri = rowIndexGlobal++;
      return {
        RowIndexZeroBased: ri,
        PhysicalName: r.name,
        Seats: r.seats.map((s) => {
          const st = seats[`${r.name}:${s.id}`] ?? { status: 0 };
          // Vista: 0 empty, 1 sold, 2 selected by this session, 3 unavailable/held by others
          const Status =
            st.status === 0
              ? 0
              : st.status === 1
                ? 1
                : st.status === 2 && st.orderId === forUserSessionId
                  ? 2
                  : 3;
          return {
            Position: { AreaNumber: a.number, RowIndex: ri, ColumnIndex: s.columnIndex },
            Priority: 1,
            Id: s.id,
            Status,
            SeatStyle: s.style ?? 0,
            SeatsInGroup: null,
            OriginalStatus: st.status === 1 ? 1 : 0,
          };
        }),
      };
    });
    return {
      Number: a.number,
      AreaCategoryCode: a.areaCategoryCode,
      Description: a.description,
      DescriptionAlt: "",
      NumberOfSeats: a.rows.reduce((n, r) => n + r.seats.length, 0),
      IsAllocatedSeating: true,
      HasSofaSeatingEnabled: a.rows.some((r) => r.seats.some((s) => s.style === 2)),
      Left: a.left,
      Top: a.top,
      Height: a.height,
      Width: a.width,
      Rows: rows,
      RowCount: rows.length,
      ColumnCount: layout.columnCount,
    };
  });
  return {
    SeatLayoutData: {
      Areas: areas,
      AreaCategories: layout.areas.map((a) => ({
        AreaCategoryCode: a.areaCategoryCode,
        Name: a.description,
        NameTranslations: [],
        Hopk: a.description,
        SeatsToAllocate: 0,
        SeatsAllocatedCount: 0,
        SeatsNotAllocatedCount: 0,
        SelectedSeats: [],
        IsInSeatDeliveryEnabled: true,
      })),
      BoundaryRight: 100,
      BoundaryLeft: 0,
      BoundaryTop: 20,
      ScreenStart: 0,
      ScreenWidth: 100,
      RowCount: layout.rowCount,
      ColumnCount: layout.columnCount,
    },
    ResponseCode: 0,
    ErrorDescription: null,
  };
}
