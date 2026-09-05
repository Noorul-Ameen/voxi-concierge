/** Rich cards driven by the agent (ui hints). Every button routes back through the conversation. */
import { useEffect, useState } from "react";
import QRCode from "qrcode";
import type { Lang, UiHint } from "../lib/api";
import { money, t } from "../lib/i18n";

export type CardActions = {
  say: (text: string) => void; // send a user message to the agent
  command: (cmd: Record<string, unknown>) => Promise<{ ok: boolean; action?: any; error?: string }>;
  openLink: (url: string) => void;
  playTrailer: (youtubeId: string, title?: string) => void;
};

export function Cards({ ui, lang, act }: { ui: UiHint; lang: Lang; act: CardActions }) {
  const items = ui.items ?? [];
  const body = (() => {
    switch (ui.type) {
      case "movie":
      case "recommendation":
        return <MovieRow items={items} lang={lang} act={act} />;
      case "showtimes":
        return <Showtimes items={items} lang={lang} act={act} film={ui.meta?.film} groupBy={ui.meta?.groupBy} />;
      case "cinema":
        return items.map((c, i) => <CinemaCard key={i} c={c} lang={lang} act={act} />);
      case "offer":
        return items.map((o, i) => <OfferCard key={i} o={o} lang={lang} act={act} />);
      case "menu":
        return <Menu items={items} lang={lang} act={act} />;
      case "booking":
        return items.map((b, i) => <BookingCard key={i} b={b} lang={lang} act={act} confirmationId={ui.meta?.confirmationId} />);
      case "order":
        return items[0] && "tickets" in items[0] ? <OrderSummary o={items[0]} lang={lang} act={act} hideActions={!!ui.actions?.length} /> : <TicketTypes items={items} lang={lang} act={act} sessionKey={ui.meta?.sessionKey} />;
      case "seatmap":
        return <SeatMap rows={items} meta={ui.meta ?? {}} lang={lang} act={act} />;
      case "payment":
        return <PaymentSheet o={items[0] ?? {}} meta={ui.meta ?? {}} lang={lang} act={act} />;
      case "qr":
        return items.map((b, i) => <QRTicket key={i} b={b} lang={lang} qr={ui.meta?.qrPayload ?? b.qrPayload} />);
      case "loyalty":
        return <Loyalty l={items[0] ?? {}} lang={lang} />;
      case "complaint":
        return items.map((c, i) => (
          <div key={i} className="booking">
            <div className="head">
              <span className="ref">{c.id}</span>
              <span className="badge warn">{c.category}</span>
            </div>
            <div style={{ marginTop: 6 }}>{c.description}</div>
            <div className="grid" style={{ marginTop: 8 }}>
              <span>{lang === "ar" ? "الخطوة التالية" : "Next step"}</span>
              <b>{c.resolution}</b>
            </div>
          </div>
        ));
      case "transfer":
        return <TransferCard tr={items[0] ?? {}} lang={lang} />;
      case "feedback":
        return <Feedback lang={lang} act={act} />;
      default:
        return <pre style={{ fontSize: 11, overflow: "auto" }}>{JSON.stringify(items, null, 1)}</pre>;
    }
  })();
  return (
    <div className="cards" data-type={ui.type}>
      {ui.title && !(ui.type === "showtimes" && ui.meta?.film?.posterUrl) && <h4>{ui.title}</h4>}
      {body}
      {ui.actions?.length ? (
        <div className="actionsrow">
          {ui.actions.map((a, i) => (
            <button key={i} className={`btn ${a.style === "primary" ? "primary" : a.style === "danger" ? "danger" : "ghost"}`} onClick={() => routeAction(a.value, a.label, act, lang)}>
              {a.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Card buttons are translated into natural-language messages so the agent stays in control. */
export function routeAction(value: string, label: string, act: CardActions, lang: Lang) {
  const [kind, ...rest] = value.split(":");
  const arg = rest.join(":");
  const ar = lang === "ar";
  void act.command({ type: "card.action", value });
  switch (kind) {
    case "showtimes":
      return act.say(ar ? `أريد مواعيد عرض الفيلم ${label}` : `Show me showtimes for ${label}`);
    case "trailer":
      return act.playTrailer(arg, label);
    case "link":
      return act.openLink(arg);
    case "sessions":
      return act.say(ar ? `ما هي العروض في ${label}؟` : `What's showing at ${label}?`);
    case "booking":
      return act.say(ar ? `أريد إدارة الحجز ${arg}` : `Let's manage booking ${arg}`);
    case "cancel":
      return act.say(ar ? `أريد إلغاء الحجز ${arg} واسترداد المبلغ` : `I'd like to cancel booking ${arg} and get a refund`);
    case "swap":
      return act.say(ar ? `أريد تبديل موعد الحجز ${arg}` : `I'd like to swap booking ${arg} to another showtime`);
    case "confirm":
      return act.say(ar ? "نعم، أؤكد. تابع." : "Yes, I confirm. Go ahead.");
    case "abort":
      return act.say(ar ? "لا، توقف من فضلك." : "No, please don't.");
    case "book":
      return act.say(ar ? `أريد حجز هذا العرض ${arg ? `(${arg})` : ""}` : `I'd like to book this showtime${arg ? ` (${arg})` : ""}`);
    case "offer":
      return act.say(ar ? `طبّق العرض ${label}` : `Apply the offer ${label}`);
    case "add_item":
      return act.say(ar ? `أضف ${label.replace(/^أضف /, "")} إلى طلبي` : `Add ${label.replace(/^Add /, "")} to my order`);
    case "seatmap":
      return act.say(ar ? "أريد اختيار المقاعد من الخريطة" : "I want to choose my seats on the map");
    case "menu":
      return act.say(ar ? "أرني قائمة المأكولات والمشروبات" : "Show me the food and drinks menu");
    case "pay":
      return act.say(ar ? "أريد الدفع الآن بالبطاقة" : "I'd like to pay now by card");
    default:
      return act.say(label);
  }
}

function MovieRow({ items, lang, act }: { items: any[]; lang: Lang; act: CardActions }) {
  return (
    <div className="hscroll">
      {items
        .filter((m) => m.hoCode)
        .map((m) => (
          <div className="movie" key={m.hoCode}>
            <div className="p" style={{ backgroundImage: m.posterUrl ? `url(${m.posterUrl})` : undefined }} />
            <div className="t">
              <b>{m.title}</b>
              <small>
                {m.rating} · {m.runTime ? `${m.runTime}m` : ""} · {m.language}
              </small>
              {m.why?.length ? <div style={{ marginTop: 4, fontSize: 11, color: "#6b6b76" }}>{m.why.join(", ")}</div> : null}
              {m.suggestedSession ? (
                <div style={{ marginTop: 4, fontSize: 11 }}>
                  {m.suggestedSession.dateLabel} {m.suggestedSession.time} · {m.suggestedSession.experience}
                </div>
              ) : null}
              <div className="row">
                <button className="btn primary" onClick={() => routeAction(`showtimes:${m.hoCode}`, m.titleEn ?? m.title, act, lang)}>
                  {t(lang, "showtimes")}
                </button>
                {m.youtubeId ? (
                  <button className="btn ghost" onClick={() => act.playTrailer(m.youtubeId, m.title)}>
                    ▶
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        ))}
    </div>
  );
}

function Showtimes({ items, lang, act, film, groupBy }: { items: any[]; lang: Lang; act: CardActions; film?: any; groupBy?: string }) {
  const ar = lang === "ar";
  const days = [...new Set(items.map((s) => s.date))].sort();
  const [day, setDay] = useState<string>(days[0] ?? "");
  const activeDay = days.includes(day) ? day : (days[0] ?? "");
  const dayLabel = (d: string) => items.find((s) => s.date === d)?.dateLabel ?? d;
  const visible = items.filter((s) => s.date === activeDay);
  const byFilm = groupBy === "film" || !film;
  const groups = new Map<string, any[]>();
  for (const s of visible) {
    const k = byFilm ? s.filmTitle : (s.cinemaName ?? s.cinemaId);
    groups.set(k, [...(groups.get(k) ?? []), s]);
  }
  const book = (s: any) => act.say(ar ? `احجز ${s.filmTitle} في ${s.cinemaName} ${s.dateLabel} الساعة ${s.time} (${s.experience})` : `Book ${s.filmTitle} at ${s.cinemaName} ${s.dateLabel} at ${s.time} (${s.experience})`);
  return (
    <div className="showtimes">
      {film?.posterUrl ? (
        <div className="filmhead" style={{ backgroundImage: film.heroUrl ? `linear-gradient(90deg, rgba(31,36,40,0.92) 30%, rgba(31,36,40,0.55)), url(${film.heroUrl})` : undefined }}>
          <div className="p" style={{ backgroundImage: `url(${film.posterUrl})` }} />
          <div className="fh">
            <b>{film.title}</b>
            <span>{[film.rating, film.runTime ? `${film.runTime} min` : null, film.language].filter(Boolean).join(" · ")}</span>
            {film.youtubeId ? (
              <button className="btn ghost small light" onClick={() => act.playTrailer(film.youtubeId, film.title)}>▶ {t(lang, "trailer")}</button>
            ) : null}
          </div>
        </div>
      ) : null}
      {days.length > 1 ? (
        <div className="daytabs" role="tablist">
          {days.map((d) => (
            <button key={d} type="button" role="tab" aria-selected={d === activeDay} className={d === activeDay ? "on" : ""} onClick={() => setDay(d)}>
              {dayLabel(d)}
            </button>
          ))}
        </div>
      ) : null}
      {[...groups.entries()].map(([k, ss]) => (
        <div className="showgroup" key={k}>
          {byFilm ? (
            <div className="sg-film">
              {ss[0]?.posterUrl ? <span className="mini" style={{ backgroundImage: `url(${ss[0].posterUrl})` }} /> : null}
              <div>
                <b>{k}</b>
                <small>
                  {[ss[0]?.rating, ss[0]?.filmLanguage, ss[0]?.cinemaName].filter(Boolean).join(" · ")}
                  {ss[0]?.distanceKm != null ? <span className="dist"> · {ss[0].distanceKm} km</span> : null}
                  {ss[0]?.mapUrl ? <a href={ss[0].mapUrl} className="maplink" onClick={(e) => { e.preventDefault(); act.openLink(ss[0].mapUrl); }}>{ar ? "الخريطة" : "Map"}</a> : null}
                </small>
              </div>
            </div>
          ) : (
            <div className="sg-cinema">
              <b>📍 {k}</b>
              {ss[0]?.distanceKm != null ? <span className="dist">{ss[0].distanceKm} km</span> : null}
              {ss[0]?.mapUrl ? (
                <a href={ss[0].mapUrl} target="_blank" rel="noreferrer" className="maplink" onClick={(e) => { e.preventDefault(); act.openLink(ss[0].mapUrl); }}>
                  {ar ? "الخريطة" : "Map"}
                </a>
              ) : null}
            </div>
          )}
          <div className="times">
            {ss.map((s) => (
              <button key={s.sessionKey} type="button" className={`time ${s.soldOut ? "soldout" : ""} ${s.seatsAvailable > 0 && s.seatsAvailable <= 10 ? "few" : ""}`} disabled={s.soldOut} title={`${s.screenName ?? ""} · ${s.seatsAvailable} ${ar ? "مقعد" : "seats"}`} onClick={() => book(s)}>
                <span>{s.time}</span>
                <small>{s.experience}{byFilm && !film ? "" : ""}</small>
                {s.seatsAvailable > 0 && s.seatsAvailable <= 10 ? <em>{ar ? "مقاعد قليلة" : "few left"}</em> : null}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function CinemaCard({ c, lang, act }: { c: any; lang: Lang; act: CardActions }) {
  return (
    <div className="cinema">
      <b>{c.name}</b> {c.distanceKm != null ? <span className="badge soft">{c.distanceKm} {t(lang, "km")}</span> : null}
      <div className="meta">{c.address}</div>
      {c.hoursToday ? <div className="meta">⏰ {c.hoursToday}</div> : null}
      <div className="exps">
        {(c.experiences ?? []).map((e: string) => (
          <span key={e} className="badge soft">
            {e}
          </span>
        ))}
      </div>
      {c.directions ? (
        <div className="meta">
          🧭 {t(lang, "directions")}: {c.directions}
        </div>
      ) : null}
      {c.parking ? (
        <div className="meta">
          🅿️ {t(lang, "parking")}: {c.parking}
        </div>
      ) : null}
      <div className="row">
        <button className="btn primary" onClick={() => routeAction(`sessions:${c.cinemaId}`, c.name, act, lang)}>
          {t(lang, "showtimes")}
        </button>
        {c.mapUrl ? (
          <button className="btn ghost" onClick={() => act.openLink(c.mapUrl)}>
            {t(lang, "openMaps")}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function OfferCard({ o, lang, act }: { o: any; lang: Lang; act: CardActions }) {
  return (
    <div className="offer">
      <div className="img" style={{ backgroundImage: `url(${o.imageUrl})` }} />
      <div className="b">
        <b>{o.title}</b>
        <div>{o.benefit}</div>
        <div style={{ color: "#6b6b76", marginTop: 2 }}>{o.description}</div>
        <div style={{ marginTop: 6, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <span className={`badge ${o.eligible ? "ok" : o.requires?.length ? "warn" : "soft"}`}>{o.eligible ? (lang === "ar" ? "مؤهل" : "Eligible") : o.requires?.length ? (lang === "ar" ? `يتطلب ${o.requires.join("، ")}` : `Needs ${o.requires.join(", ")}`) : o.type}</span>
          <button className="btn ghost" style={{ padding: "4px 8px" }} onClick={() => routeAction(`offer:${o.offerId}`, o.titleEn ?? o.title, act, lang)}>
            {lang === "ar" ? "تطبيق" : "Apply"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Food & drinks — sticky category tabs and square image tiles, as on the real "Food & Drinks" step. */
function Menu({ items, lang, act }: { items: any[]; lang: Lang; act: CardActions }) {
  const tabs = [...new Set(items.map((m) => String(m.tab ?? "")))].filter(Boolean);
  const [tab, setTab] = useState<string>("ALL");
  const shown = tab === "ALL" ? items : items.filter((m) => m.tab === tab);
  return (
    <div className="fnb">
      {tabs.length > 1 ? (
        <div className="cattabs">
          <button className={tab === "ALL" ? "on" : ""} onClick={() => setTab("ALL")}>
            {lang === "ar" ? "الكل" : "ALL"}
          </button>
          {tabs.map((x) => (
            <button key={x} className={tab === x ? "on" : ""} onClick={() => setTab(x)}>
              {x}
            </button>
          ))}
        </div>
      ) : null}
      <div className="fnbgrid">
        {shown.map((m, i) => (
          <MenuItem key={m.itemId ?? i} m={m} lang={lang} act={act} />
        ))}
      </div>
    </div>
  );
}

function MenuItem({ m, lang, act }: { m: any; lang: Lang; act: CardActions }) {
  const sizes = (m.modifiers ?? []).find((g: any) => /size/i.test(g.name));
  const from = sizes?.options?.length ? Math.min(...sizes.options.map((o: any) => (m.priceCents ?? 0) + (o.priceCents ?? 0))) : null;
  return (
    <div className="fnbcard">
      <div className="img" style={{ backgroundImage: `url(${m.imageUrl})` }}>
        {m.isBestSeller ? <span className="best">{lang === "ar" ? "الأكثر مبيعاً" : "BEST SELLER"}</span> : null}
      </div>
      <div className="b">
        <b title={m.description}>{m.name}</b>
        <div className="tags">
          {(m.dietaryTags ?? []).slice(0, 2).map((d: string) => (
            <span key={d} className="badge soft">
              {d.replace("_", " ")}
            </span>
          ))}
        </div>
        <div className="pr">
          <span className="price">
            {from !== null && from < (m.priceCents ?? 0) ? <small>{lang === "ar" ? "من " : "FROM "}</small> : null}
            {from !== null && from < (m.priceCents ?? 0) ? money(from, lang) : m.price}
          </span>
          <button className="plus" aria-label="add" onClick={() => routeAction(`add_item:${m.itemId}`, `Add ${m.nameEn ?? m.name}`, act, lang)}>
            +
          </button>
        </div>
      </div>
    </div>
  );
}

function BookingCard({ b, lang, act, confirmationId }: { b: any; lang: Lang; act: CardActions; confirmationId?: string }) {
  const e = b.eligibility;
  return (
    <div className="booking">
      <div className="head">
        <span className="ref">{b.bookingId}</span>
        <span className={`badge ${b.status === "confirmed" ? "ok" : b.status === "collected" ? "soft" : "danger"}`}>{b.status}</span>
      </div>
      <div style={{ marginTop: 6 }}>
        <b>{b.filmTitle}</b> · {b.experience}
      </div>
      <div className="grid">
        <span>{lang === "ar" ? "السينما" : "Cinema"}</span>
        <b>{b.cinemaName ?? b.cinemaId}</b>
        <span>{lang === "ar" ? "الموعد" : "When"}</span>
        <b>{b.showtimeLabel}</b>
        <span>{t(lang, "seats")}</span>
        <b>
          {b.seats} ({b.ticketCount})
        </b>
        <span>{t(lang, "total")}</span>
        <b>{b.total}</b>
        {b.concessions?.length ? (
          <>
            <span>F&B</span>
            <b>{b.concessions.map((c: any) => `${c.quantity}× ${c.description}`).join(", ")}</b>
          </>
        ) : null}
        {b.refund ? (
          <>
            <span>{t(lang, "refund")}</span>
            <b>
              {money(b.refund.amountCents, lang)} → {b.refund.method.replace("_", " ")} {b.refund.reference ? `(${b.refund.reference})` : ""}
            </b>
          </>
        ) : null}
        {b.swapTo ? (
          <>
            <span>→</span>
            <b>
              {b.swapTo.showtimeLabel} · {b.swapTo.experience} · {b.swapTo.cinemaName}
            </b>
          </>
        ) : null}
      </div>
      {e ? <div style={{ marginTop: 8 }}>{e.eligible ? <span className="badge ok">{t(lang, "eligible")}</span> : <span className="badge danger" title={e.reasons?.[0]}>{t(lang, "notEligible")}</span>}{!e.eligible && e.reasons?.[0] ? <span style={{ fontSize: 11, color: "#6b6b76", marginInlineStart: 6 }}>{e.reasons[0]}</span> : null}</div> : null}
      {!confirmationId && e?.eligible && b.status === "confirmed" ? (
        <div className="actions">
          <button className="btn danger" onClick={() => routeAction(`cancel:${b.bookingId}`, "", act, lang)}>
            {lang === "ar" ? "إلغاء واسترداد" : "Cancel & refund"}
          </button>
          <button className="btn ghost" onClick={() => routeAction(`swap:${b.bookingId}`, "", act, lang)}>
            {lang === "ar" ? "تبديل الموعد" : "Swap showtime"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

const TIER = {
  premium: { en: "Premium", ar: "بريميوم", cls: "premium" },
  preferred_view: { en: "Preferred View", ar: "إطلالة مفضلة", cls: "preferred" },
  regular: { en: "Regular", ar: "عادي", cls: "regular" },
} as const;

function TicketTypes({ items, lang, act }: { items: any[]; lang: Lang; act: CardActions; sessionKey?: string }) {
  return (
    <div className="order tickettypes">
      {items.map((tt) => {
        const tier = TIER[(tt.area as keyof typeof TIER) ?? "regular"] ?? TIER.regular;
        return (
          <div className="line" key={tt.code}>
            <span>
              <i className={`seatdot ${tier.cls}`} />
              {tt.description}
              {tt.isChild ? <span className="badge soft">{lang === "ar" ? "٣–١٢ سنة" : "3–12 yrs"}</span> : null}
              {tt.membersOnly ? <span className="badge soft">SHARE</span> : null}
            </span>
            <span>
              <b>{tt.price}</b>{" "}
              <button className="btn ghost" style={{ padding: "3px 8px", marginInlineStart: 6 }} onClick={() => act.say(lang === "ar" ? `أضف تذكرة ${tt.description}` : `Add one ${tt.description} ticket`)}>
                +1
              </button>
            </span>
          </div>
        );
      })}
      <small className="vatnote">{lang === "ar" ? "الأسعار شاملة ضريبة القيمة المضافة ٥٪. لا رسوم حجز." : "Prices include 5% VAT. No booking fee."}</small>
    </div>
  );
}

export function OrderSummary({ o, lang, act, hideActions }: { o: any; lang: Lang; act: CardActions; hideActions?: boolean }) {
  return (
    <div className="order">
      <div style={{ marginBottom: 6 }}>
        <b>{o.filmTitle}</b> · {o.experience} · {o.showtimeLabel} · {o.cinemaName}
      </div>
      {(o.tickets ?? []).map((tk: any) => (
        <div className="line" key={tk.id}>
          <span>
            {tk.description} {tk.seat ? <span className="badge soft">{tk.seat}</span> : null}
          </span>
          <span>{tk.discountCents ? <s style={{ color: "#999", marginInlineEnd: 4 }}>{money(tk.priceCents, lang)}</s> : null}{money(tk.finalCents, lang)}</span>
        </div>
      ))}
      {(o.concessions ?? []).map((c: any) => (
        <div className="line" key={`c${c.id}`}>
          <span>
            {c.quantity}× {c.description} {c.modifiers?.length ? <small>({c.modifiers.join(", ")})</small> : null}
          </span>
          <span>{money(c.finalCents, lang)}</span>
        </div>
      ))}
      {(o.offers ?? []).map((of: any) => (
        <div className="line" key={of.id} style={{ color: "#1f8a4c" }}>
          <span>🎁 {of.title}</span>
          <span>−{money(of.discountCents, lang)}</span>
        </div>
      ))}
      {o.bookingFeeCents ? (
        <div className="line">
          <span>{lang === "ar" ? "رسوم الحجز" : "Booking fee"}</span>
          <span>{money(o.bookingFeeCents, lang)}</span>
        </div>
      ) : null}
      <div className="line total">
        <span>{t(lang, "total")}</span>
        <span>{o.total ?? money(o.totalCents, lang)}</span>
      </div>
      {hideActions ? null : (
      <div className="actions">
        <button className="btn ghost" onClick={() => routeAction("seatmap:open", "", act, lang)}>
          {lang === "ar" ? "المقاعد" : "Seats"}
        </button>
        <button className="btn ghost" onClick={() => routeAction("menu:open", "", act, lang)}>
          {lang === "ar" ? "مأكولات" : "Food & drinks"}
        </button>
        <button className="btn primary" onClick={() => routeAction("pay:start", "", act, lang)}>
          {t(lang, "pay")}
        </button>
      </div>
      )}
    </div>
  );
}

/** Seat plan mirroring the real booking step: curved screen, tiered colours, "Your Selected Seats" price list. */
function SeatMap({ rows, meta, lang, act }: { rows: any[]; meta: Record<string, any>; lang: Lang; act: CardActions }) {
  // seats already held for this order start out selected, as on the site after auto-allocation
  const [picked, setPicked] = useState<{ row: string; number: string; area: string }[]>(() =>
    rows.flatMap((r) => r.seats.filter((s: any) => s.status === 2).map((s: any) => ({ row: r.row, number: String(s.id), area: r.areaCategoryCode }))),
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const held = rows.flatMap((r) => r.seats.filter((s: any) => s.status === 2).map(() => 1)).length;
  const need = held || Number(meta.ticketCount ?? 0) || picked.length || 1;
  const cols = Number(meta.columnCount ?? Math.max(...rows.map((r) => Math.max(...r.seats.map((s: any) => s.col)) + 1)));
  const tiers: { area: string; label: string; priceCents: number | null; price: string | null }[] = meta.tiers ?? [];
  const tierOf = (code: string) => (code === "0000000001" ? "premium" : code === "0000000003" ? "preferred" : "regular");
  const tierName = (code: string) => {
    const k = tierOf(code) === "preferred" ? "preferred_view" : tierOf(code);
    return TIER[k as keyof typeof TIER][lang];
  };
  const priceOf = (code: string) => tiers.find((x) => x.area === code)?.priceCents ?? null;
  // rows are drawn back-to-front so row A sits nearest the screen, as on the site
  const ordered = [...rows].sort((a, b) => (b.rowIndex ?? 0) - (a.rowIndex ?? 0));
  const toggle = (row: string, id: string, area: string) => {
    setErr(null);
    setPicked((p) => (p.some((x) => x.row === row && x.number === id) ? p.filter((x) => !(x.row === row && x.number === id)) : p.length >= need ? [...p.slice(1), { row, number: id, area }] : [...p, { row, number: id, area }]));
  };
  const confirm = async () => {
    setBusy(true);
    const r = await act.command({ type: "seat.select", userSessionId: meta.userSessionId, seats: picked.map((p) => ({ row: p.row, number: p.number })) });
    setBusy(false);
    if (!r.ok) setErr(r.action?.error?.message ?? r.error ?? "Could not hold those seats");
    else act.say(lang === "ar" ? `اخترت المقاعد ${picked.map((p) => p.row + p.number).join("، ")}` : `I've picked seats ${picked.map((p) => p.row + p.number).join(", ")} on the map`);
  };
  const groups = picked.reduce<Record<string, number>>((m, p) => ({ ...m, [p.area]: (m[p.area] ?? 0) + 1 }), {});
  const subtotal = picked.reduce((n, p) => n + (priceOf(p.area) ?? 0), 0);
  return (
    <div className="seatmap">
      {meta.filmTitle ? (
        <div className="seathead">
          <b>{meta.filmTitle}</b>
          <span>
            {meta.experience ? <em>{meta.experience}</em> : null}
            {meta.screenName ? ` · ${meta.screenName}` : ""}
          </span>
        </div>
      ) : null}
      <div className="screen">{t(lang, "screen")}</div>
      <div className="rows" style={{ gridTemplateColumns: "1fr" }}>
        {ordered.map((r) => {
          const byCol = new Map<number, any>(r.seats.map((s: any) => [s.col, s]));
          return (
            <div className="row" key={`${r.area}-${r.row}`}>
              <span className="rl">{r.row}</span>
              {Array.from({ length: cols }, (_, c) => {
                const s = byCol.get(c);
                if (!s) return <span key={c} className="seat gap" />;
                const mine = picked.some((p) => p.row === r.row && p.number === s.id);
                const cls = ["seat", tierOf(r.areaCategoryCode), s.style === 1 ? "wheelchair" : "", s.status === 1 ? "sold" : s.status === 3 ? "held" : s.status === 2 ? "mine" : "", mine ? "picked" : ""].join(" ");
                return <button key={c} className={cls} title={`${r.row}-${s.id} · ${tierName(r.areaCategoryCode)}`} disabled={s.status === 1 || s.status === 3} onClick={() => toggle(r.row, s.id, r.areaCategoryCode)} />;
              })}
              <span className="rl">{r.row}</span>
            </div>
          );
        })}
      </div>
      <div className="legend">
        <span>
          <i className="seat sold" />
          {lang === "ar" ? "غير متاح" : "Unavailable"}
        </span>
        <span>
          <i className="seat picked" />
          {lang === "ar" ? "مقعدك" : "Your Seat"}
        </span>
        {(["regular", "premium", "preferred"] as const)
          .filter((k) => rows.some((r) => tierOf(r.areaCategoryCode) === k))
          .map((k) => (
            <span key={k}>
              <i className={`seat ${k}`} />
              {TIER[k === "preferred" ? "preferred_view" : k][lang]}
            </span>
          ))}
        {held ? (
          <span>
            <i className="seat mine" />
            {lang === "ar" ? "محجوز لك" : "Held for you"}
          </span>
        ) : null}
      </div>
      <div className="selseats">
        <b>{lang === "ar" ? "مقاعدك المختارة:" : "Your Selected Seats:"}</b>
        {picked.length ? (
          Object.entries(groups).map(([area, n]) => (
            <div key={area}>
              x{n} {tierName(area)}
              {priceOf(area) !== null ? ` – ${money(priceOf(area)!, lang)} ${lang === "ar" ? "لكل تذكرة" : "per ticket"}` : ""}
            </div>
          ))
        ) : (
          <div className="muted">{lang === "ar" ? `اختر ${need} ${need === 1 ? "مقعداً" : "مقاعد"} على الخريطة` : `Tap ${need} seat${need === 1 ? "" : "s"} on the map`}</div>
        )}
        {picked.length && subtotal ? (
          <div className="sub">
            <span>{picked.map((p) => `${p.row}-${p.number}`).join(", ")}</span>
            <b>{money(subtotal, lang)}</b>
          </div>
        ) : null}
      </div>
      {err ? <div className="sheet err" style={{ marginTop: 6 }}>{err}</div> : null}
      <div className="actionsrow">
        <button className="btn cta" disabled={!picked.length || busy} onClick={confirm}>
          {busy ? t(lang, "processing") : `${t(lang, "confirmSeats")} (${picked.length}/${need})`}
        </button>
        <button className="btn ghost" onClick={() => act.say(lang === "ar" ? "اختر أفضل المقاعد المتاحة" : "Pick the best available seats for me")}>
          {lang === "ar" ? "الأفضل المتاح" : "Best available"}
        </button>
      </div>
    </div>
  );
}

function CardBrand({ brand }: { brand: string }) {
  const b = String(brand ?? "").toUpperCase();
  return <span className={`cardbrand ${b === "VISA" ? "visa" : b === "AMEX" ? "amex" : "mc"}`}>{b === "MASTERCARD" ? <i /> : b === "VISA" ? "VISA" : b === "AMEX" ? "AMEX" : "CARD"}</span>;
}

/**
 * "Review & pay" — mirrors the real site: bank-offer / voucher tabs, SHARE points redeem, VAT breakdown,
 * then "Choose your payment method" (saved cards, ADCB TouchPoints, Credit and Debit Cards, Apple Pay).
 * Card numbers are tokenised in the browser; only a token reaches the server.
 */
function PaymentSheet({ o, meta, lang, act }: { o: any; meta: Record<string, any>; lang: Lang; act: CardActions }) {
  const ar = lang === "ar";
  const saved: any[] = meta.savedCards ?? [];
  const bankOffers: any[] = meta.bankOffers ?? [];
  const wallet = meta.wallet as { sharePoints: number; sharePointsValueCents: number; voxCreditCents: number } | undefined;
  const [tab, setTab] = useState<"bank" | "voucher">("bank");
  const guest = !!meta.guest;
  const [method, setMethod] = useState<string>(
    meta.method === "APPLE_PAY" ? "applepay" : meta.method === "SAMSUNG_PAY" ? "samsungpay" : meta.method === "SAVED_CARD" && saved[0] ? `saved:${saved[0].token}` : meta.method === "CARD" && !saved.length ? "new" : "",
  );
  const [pan, setPan] = useState("4111 1111 1111 1111");
  const [exp, setExp] = useState("12/29");
  const [cvv, setCvv] = useState("123");
  const [store, setStore] = useState(true);
  const [offerId, setOfferId] = useState<string>("");
  const [digits, setDigits] = useState({ first: "", last: "" });
  const [promo, setPromo] = useState("");
  const [redeem, setRedeem] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [showVat, setShowVat] = useState(false);
  const [showItems, setShowItems] = useState(false);
  if (!meta.requiresSheet) return <OrderSummary o={o} lang={lang} act={act} />;
  const amount = Number(meta.amountCents ?? o.totalCents ?? 0);
  const vat = meta.vat as { beforeVatCents: number; vatCents: number; rate: number } | undefined;
  const saveable = wallet ? Math.min(wallet.sharePointsValueCents, amount) : 0;
  const pay = async () => {
    setBusy(true);
    setErr(null);
    let token: string;
    if (!method) {
      setBusy(false);
      setErr(ar ? "اختر طريقة الدفع أولاً." : "Please choose a payment method first.");
      return;
    }
    if (method.startsWith("saved:")) token = method.slice(6);
    else if (method === "applepay") token = `tok_applepay_0000_${Date.now()}`;
    else if (method === "samsungpay") token = `tok_samsungpay_0000_${Date.now()}`;
    else if (method === "touchpoints") token = `tok_mc_0000_${Date.now()}`;
    else {
      // Simulated Checkout tokenisation: the PAN never leaves the browser; only a token (brand + BIN + last 4) is sent,
      // so bank offers can still be checked against the card actually used.
      const d = pan.replace(/\D/g, "");
      token = d.endsWith("0002") ? `tok_declined_${Date.now()}` : `tok_${d.startsWith("4") ? "visa" : d.startsWith("3") ? "amex" : "mc"}_${d.slice(0, 6)}_${d.slice(-4)}_${Date.now()}`;
    }
    const r = await act.command({ type: "payment.token", userSessionId: meta.userSessionId, confirmationId: meta.confirmationId, token });
    setBusy(false);
    if (r.ok) {
      setDone(true);
      const ref = r.action?.result?.bookingId as string | undefined;
      act.say(
        ar
          ? `أكملت الدفع في نافذة الدفع${ref ? ` — رقم الحجز ${ref}` : ""}.`
          : `I've completed the payment in the payment sheet${ref ? ` — my booking reference is ${ref}` : ""}.`,
      );
    } else setErr(r.action?.error?.message ?? r.error ?? "Payment failed");
  };
  if (done) return <div className="sheet">✅ {ar ? "تم الدفع" : "Payment received"}</div>;
  const chosenOffer = bankOffers.find((b) => b.offerId === offerId);
  return (
    <div className="sheet reviewpay">
      <div className="steps">
        <span className="done">{ar ? "المقاعد" : "Seats"}</span>
        <span className="done">{ar ? "المأكولات" : "Food & Drinks"}</span>
        <span className="done">{ar ? "بياناتك" : "Your Details"}</span>
        <span className="cur">{ar ? "المراجعة والدفع" : "Review & Pay"}</span>
      </div>

      {guest ? (
        <div className="loginnudge">
          <b>{ar ? "سجّل الدخول أو أنشئ حساباً" : "Log in or create an account"}</b>
          <span>{ar ? "لعرض العروض المؤهلة وكسب نقاط شير على هذا الحجز." : "to view eligible offers and earn SHARE points on this booking."}</span>
          <button className="btn ghost" onClick={() => act.say(ar ? "أريد تسجيل الدخول إلى حسابي" : "I'd like to log in to my account")}>
            {ar ? "تسجيل الدخول" : "Log in"}
          </button>
        </div>
      ) : null}
      {!guest && bankOffers.length ? (
        <>
          <div className="tabs2">
            <button className={tab === "bank" ? "on" : ""} onClick={() => setTab("bank")}>
              {ar ? "عروض البنوك" : "BANK OFFERS"}
            </button>
            <button className={tab === "voucher" ? "on" : ""} onClick={() => setTab("voucher")}>
              {ar ? "قسيمة ورمز ترويجي" : "VOUCHER & PROMO"}
            </button>
          </div>
          {tab === "bank" ? (
            <div className="bankoffers">
              {bankOffers.map((b) => (
                <button key={b.offerId} className={`bank ${offerId === b.offerId ? "on" : ""}`} onClick={() => setOfferId(offerId === b.offerId ? "" : b.offerId)} title={b.title}>
                  {b.imageUrl ? <img src={b.imageUrl} alt="" onError={(e) => { e.currentTarget.hidden = true; }} /> : null}
                  <b>{b.bankName}</b>
                  <small>{b.benefit}</small>
                </button>
              ))}
              {chosenOffer ? (
                <div className="verify">
                  <div className="muted">
                    {ar
                      ? `أدخل أول ${chosenOffer.cardDigits.first} وآخر ${chosenOffer.cardDigits.last} أرقام من بطاقة ${chosenOffer.bankName}${chosenOffer.monthlyLimit ? ` · حد ${chosenOffer.monthlyLimit} تذاكر شهرياً` : ""}`
                      : `Enter the first ${chosenOffer.cardDigits.first} and last ${chosenOffer.cardDigits.last} digits of your ${chosenOffer.bankName} card${chosenOffer.monthlyLimit ? ` · limit ${chosenOffer.monthlyLimit} tickets a month` : ""}`}
                  </div>
                  <div className="row3">
                    <input inputMode="numeric" placeholder={"0".repeat(chosenOffer.cardDigits.first)} maxLength={chosenOffer.cardDigits.first} value={digits.first} onChange={(e) => setDigits({ ...digits, first: e.target.value.replace(/\D/g, "") })} />
                    <span>XXXX</span>
                    <input inputMode="numeric" placeholder={"0".repeat(chosenOffer.cardDigits.last)} maxLength={chosenOffer.cardDigits.last} value={digits.last} onChange={(e) => setDigits({ ...digits, last: e.target.value.replace(/\D/g, "") })} />
                    <button
                      className="btn cta"
                      disabled={digits.first.length < chosenOffer.cardDigits.first}
                      onClick={() => act.say(ar ? `طبّق عرض ${chosenOffer.bankName}، أول أرقام بطاقتي ${digits.first}` : `Apply the ${chosenOffer.bankName} bank offer, my card starts with ${digits.first}`)}
                    >
                      {ar ? "تطبيق" : "Apply Bank Offer"}
                    </button>
                  </div>
                  <small className="muted">{ar ? "تذاكر عروض البنوك غير قابلة للاسترداد أو التبديل. ادفع بنفس البطاقة." : "Bank-offer tickets are non-refundable and non-exchangeable. Pay with the same card."}</small>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="row3 voucher">
              <input placeholder={ar ? "رمز القسيمة أو الرمز الترويجي" : "Your voucher or promo code"} value={promo} onChange={(e) => setPromo(e.target.value)} />
              <button className="btn cta" disabled={!promo.trim()} onClick={() => act.say(ar ? `طبّق الرمز الترويجي ${promo.trim()}` : `Apply promo code ${promo.trim()}`)}>
                {ar ? "تطبيق" : "Apply code"}
              </button>
            </div>
          )}
        </>
      ) : null}

      {wallet && saveable > 0 ? (
        <div className="shareblock">
          <div className="sharemark">
            SHARE <span>شير</span>
          </div>
          <div className="b">
            <div>{ar ? `يمكنك توفير ${money(saveable, lang)} على هذا الحجز باستخدام نقاط شير!` : `You could save ${money(saveable, lang)} on this booking by applying your SHARE points!`}</div>
            <div className="row3">
              <input inputMode="decimal" placeholder={(saveable / 100).toFixed(2)} value={redeem} onChange={(e) => setRedeem(e.target.value)} />
              <span>AED</span>
              <button className="btn cta" onClick={() => act.say(ar ? `استخدم ${redeem || (saveable / 100).toFixed(2)} درهم من نقاط شير` : `Redeem ${redeem || (saveable / 100).toFixed(2)} AED of my Share Points`)}>
                {ar ? "استبدال" : "Redeem"}
              </button>
            </div>
            <small className="muted">{ar ? `${wallet.sharePoints} نقطة = ${money(wallet.sharePointsValueCents, lang)}` : `${wallet.sharePoints} points = ${money(wallet.sharePointsValueCents, lang)} · 10 points = 1 AED`}</small>
          </div>
        </div>
      ) : null}

      <div className="summary">
        <button className="disc" onClick={() => setShowItems(!showItems)}>
          {ar ? "معلومات الفيلم" : "Movie info"} <i className={showItems ? "up" : ""} />
        </button>
        {showItems ? (
          <div className="items">
            <div className="muted">
              {o.filmTitle} · {o.experience} · {o.showtimeLabel} · {o.cinemaName}
            </div>
            {(o.tickets ?? []).map((tk: any) => (
              <div className="line" key={tk.id}>
                <span>
                  1 x {tk.description} {tk.seat ? <span className="badge soft">{tk.seat}</span> : null}
                </span>
                <span>{money(tk.finalCents ?? tk.priceCents, lang)}</span>
              </div>
            ))}
            {(o.concessions ?? []).map((c: any) => (
              <div className="line" key={`c${c.id}`}>
                <span>
                  {c.quantity} x {c.description}
                </span>
                <span>{money(c.finalCents, lang)}</span>
              </div>
            ))}
            {(o.offers ?? []).map((of: any) => (
              <div className="line" key={of.id} style={{ color: "var(--ok)" }}>
                <span>{of.title}</span>
                <span>−{money(of.discountCents, lang)}</span>
              </div>
            ))}
          </div>
        ) : null}
        <div className="due">
          <span>{ar ? "المبلغ المستحق" : "AMOUNT DUE"}</span>
          <b>{money(amount, lang)}</b>
        </div>
        {vat ? (
          <>
            <button className="disc" onClick={() => setShowVat(!showVat)}>
              {ar ? "معلومات الضريبة" : "VAT info"} <i className={showVat ? "up" : ""} />
            </button>
            {showVat ? (
              <div className="items">
                <div className="line">
                  <span>{ar ? "الإجمالي قبل الضريبة" : "Total before VAT"}</span>
                  <span>{money(vat.beforeVatCents, lang)}</span>
                </div>
                <div className="line">
                  <span>{vat.rate}% {ar ? "ضريبة القيمة المضافة" : "VAT"}</span>
                  <span>{money(vat.vatCents, lang)}</span>
                </div>
                <div className="line">
                  <span>{ar ? "المبلغ المستحق" : "Amount due"}</span>
                  <span>{money(amount, lang)}</span>
                </div>
              </div>
            ) : null}
          </>
        ) : null}
      </div>

      <h5>{ar ? "اختر طريقة الدفع" : "Choose your payment method"}{!method ? <small className="muted"> — {ar ? "لم يتم الاختيار بعد" : "nothing selected yet"}</small> : null}</h5>
      <div className="methods">
        {saved.map((c) => (
          <label key={c.token} className={`method ${method === `saved:${c.token}` ? "on" : ""}`}>
            <input type="radio" name="pm" checked={method === `saved:${c.token}`} onChange={() => setMethod(`saved:${c.token}`)} />
            <CardBrand brand={c.brand} />
            <span className="mono">
              {c.masked} <small>({c.expiry})</small>
            </span>
          </label>
        ))}
        <label className={`method ${method === "touchpoints" ? "on" : ""}`}>
          <input type="radio" name="pm" checked={method === "touchpoints"} onChange={() => setMethod("touchpoints")} />
          <span className="cardbrand adcb">ADCB</span>
          <span>ADCB TouchPoints</span>
        </label>
        <label className={`method ${method === "new" ? "on" : ""}`}>
          <input type="radio" name="pm" checked={method === "new"} onChange={() => setMethod("new")} />
          <span className="cardbrand generic">💳</span>
          <span>{ar ? "بطاقات الائتمان والخصم" : "Credit and Debit Cards"}</span>
        </label>
        {method === "new" ? (
          <div className="newcard">
            <div className="field">
              <label>{t(lang, "cardNumber")}</label>
              <input value={pan} onChange={(e) => setPan(e.target.value)} inputMode="numeric" autoComplete="cc-number" />
            </div>
            <div className="row2">
              <div className="field">
                <label>{t(lang, "expiry")}</label>
                <input value={exp} onChange={(e) => setExp(e.target.value)} autoComplete="cc-exp" />
              </div>
              <div className="field">
                <label>{t(lang, "cvv")}</label>
                <input value={cvv} onChange={(e) => setCvv(e.target.value)} autoComplete="cc-csc" type="password" />
              </div>
            </div>
            <label className="check">
              <input type="checkbox" checked={store} onChange={(e) => setStore(e.target.checked)} /> {ar ? "حفظ البطاقة للاستخدام لاحقاً؟" : "Store card for future use?"}
            </label>
            <small className="muted">{ar ? "بيئة تجريبية: بطاقة تنتهي بـ 0002 تُرفض." : "Sandbox: a card ending 0002 is declined; any other test card is approved."}</small>
          </div>
        ) : null}
        <label className={`method ${method === "applepay" ? "on" : ""}`}>
          <input type="radio" name="pm" checked={method === "applepay"} onChange={() => setMethod("applepay")} />
          <span className="cardbrand apple"> Pay</span>
          <span>Apple Pay</span>
        </label>
        <label className={`method ${method === "samsungpay" ? "on" : ""}`}>
          <input type="radio" name="pm" checked={method === "samsungpay"} onChange={() => setMethod("samsungpay")} />
          <span className="cardbrand samsung">Pay</span>
          <span>Samsung Pay</span>
        </label>
      </div>
      {meta.customer?.email ? <small className="muted">{ar ? `سيتم الحجز باسم ${meta.customer.name} (${meta.customer.email}${meta.customer.phone ? ` · ${meta.customer.phone}` : ""})` : `Your booking will be made as ${meta.customer.name} (${meta.customer.email}${meta.customer.phone ? ` · ${meta.customer.phone}` : ""})`}{guest ? (ar ? " — كضيف" : " — as a guest") : ""}</small> : null}
      {err ? <div className="err" style={{ marginTop: 6 }}>{err}</div> : null}
      <div className="actionsrow">
        <button className={`btn ${method === "applepay" ? "apple" : method === "samsungpay" ? "samsung" : "cta"}`} disabled={busy || !method} onClick={pay}>
          {busy ? t(lang, "processing") : method === "applepay" ? ` Pay ${money(amount, lang)}` : method === "samsungpay" ? `Samsung Pay ${money(amount, lang)}` : `${t(lang, "payButton")} ${money(amount, lang)}`}
        </button>
        <button className="btn ghost" onClick={() => act.say(ar ? "ألغِ الدفع" : "Cancel the payment")}>
          {ar ? "إلغاء" : "Cancel"}
        </button>
      </div>
      <div className="secure">
        <span>🔒 {ar ? "تتم معالجة المدفوعات عبر checkout.com" : "Payments are processed by checkout.com"}</span>
        <span className="pci">PCI DSS</span>
      </div>
    </div>
  );
}

/** Receipt + e-ticket: the same fields the real "Your receipt" / "How to collect" tabs show. */
function QRTicket({ b, lang, qr }: { b: any; lang: Lang; qr?: string }) {
  const ar = lang === "ar";
  const [src, setSrc] = useState("");
  const [tab, setTab] = useState<"receipt" | "collect">("receipt");
  useEffect(() => {
    QRCode.toDataURL(qr ?? b.qrPayload ?? b.bookingId ?? "VOX", { width: 360, margin: 1, color: { dark: "#1f2428", light: "#ffffff" } }).then(setSrc).catch(() => setSrc(""));
  }, [qr, b.qrPayload, b.bookingId]);
  const purchased = b.bookedAt ? new Date(b.bookedAt).toLocaleDateString(ar ? "ar-AE" : "en-GB", { day: "2-digit", month: "short", year: "2-digit", timeZone: "Asia/Dubai" }) : new Date().toLocaleDateString(ar ? "ar-AE" : "en-GB", { day: "2-digit", month: "short", year: "2-digit", timeZone: "Asia/Dubai" });
  return (
    <div className="ticket">
      <div className="t-top">
        <div className="t-brand">VOX <span>CINEMAS</span></div>
        <div className="t-exp">{b.experience}</div>
      </div>
      <div className="t-tabs">
        <button className={tab === "receipt" ? "on" : ""} onClick={() => setTab("receipt")}>
          {ar ? "إيصالك" : "Your receipt"}
        </button>
        <button className={tab === "collect" ? "on" : ""} onClick={() => setTab("collect")}>
          {ar ? "كيفية الاستلام" : "How to collect"}
        </button>
      </div>
      {tab === "receipt" ? (
        <>
          <div className="t-main">
            <div className="t-film">
              {b.filmTitle}
              {b.rating ? <span className="badge soft">{b.rating}</span> : null}
            </div>
            <div className="t-grid">
              <div><small>{ar ? "تاريخ الشراء" : "Purchase date"}</small><b>{purchased}</b></div>
              <div><small>{ar ? "المكان" : "Venue"}</small><b>{b.cinemaName ?? b.cinemaId}{b.screenName ? ` · ${b.screenName}` : ""}</b></div>
              <div><small>{ar ? "الموعد" : "When"}</small><b>{b.showtimeLabel}</b></div>
              <div><small>{t(lang, "seats")}</small><b>{b.seats}</b></div>
              <div><small>{ar ? "رقم الطلب" : "Order reference"}</small><b className="mono">{b.bookingId}</b></div>
              {b.payment ? <div><small>{ar ? "الدفع" : "Paid with"}</small><b>{b.payment}</b></div> : null}
            </div>
            {b.concessions?.length ? <div className="t-fnb">{b.concessions.map((c: any) => `${c.quantity}× ${c.description}`).join(", ")}</div> : null}
          </div>
          <div className="t-tear"><i /><i /></div>
          <div className="t-qr">
            {src ? <img src={src} alt="QR" /> : null}
            <div className="t-paid">
              <small>{ar ? "المبلغ المدفوع" : "AMOUNT PAID"}</small>
              <b>{b.total ?? money(b.totalCents, lang)}</b>
            </div>
          </div>
        </>
      ) : (
        <div className="t-collect">
          <h6>{ar ? "هذه تذكرتك" : "This is your ticket"}</h6>
          <p>{ar ? "امسح رمز QR عند منصة التذاكر وادخل مباشرة إلى الصالة. لا طوابير ولا طباعة. تحتوي تذكرتك الإلكترونية على جميع التذاكر في هذا الطلب — تأكد من وصول جميع ضيوفك قبل مسح الرمز." : "Scan this QR code at the ticket podium and head straight into the cinema. No ticket queues. No print outs. No hassles. Your e-ticket holds all of the tickets purchased with this order. Make sure all of your guests have arrived before scanning the code."}</p>
          <h6>{ar ? "المأكولات والمشروبات" : "Food & Drinks"}</h6>
          <p>{ar ? "بعد اختيار «تحضير طلبي» أو مسح رمز QR عند الكشك، يبدأ المطبخ تحضير طلبك فوراً. يظهر رقم استلام طلبك على شاشات استلام الأطعمة الساخنة في الكاندي بار." : "After you have selected 'Prepare my order' or scanned your QR code at a kiosk, the kitchen will start to prepare your order immediately. Your order collection number will display on the hot food collection screens at the Candy Bar."}</p>
          <small className="muted">{ar ? "أُرسلت التذاكر أيضاً إلى بريدك الإلكتروني." : "Your tickets have also been emailed to you."}</small>
        </div>
      )}
    </div>
  );
}

function Loyalty({ l, lang }: { l: any; lang: Lang }) {
  return (
    <div className="loyalty">
      <div className="tile">
        <small>{lang === "ar" ? "نقاط شير" : "Share Points"}</small>
        <b>{l.sharePoints ?? 0}</b>
        {l.tier ? <span className="badge soft">{l.tier}</span> : null}
      </div>
      <div className="tile">
        <small>{lang === "ar" ? "رصيد فوكس" : "VOX credit"}</small>
        <b>{money(l.voxCreditCents ?? 0, lang)}</b>
      </div>
    </div>
  );
}

function TransferCard({ tr, lang }: { tr: any; lang: Lang }) {
  return (
    <div className="transfer">
      {tr.status === "connected" ? `${t(lang, "connectedTo")} ${tr.agentName ?? ""}` : t(lang, "transferring")}
      {tr.summary ? <pre style={{ whiteSpace: "pre-wrap", fontSize: 11, marginTop: 6, color: "#6b6b76" }}>{tr.summary}</pre> : null}
    </div>
  );
}

export function Feedback({ lang, act }: { lang: Lang; act: CardActions }) {
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState("");
  const [sent, setSent] = useState(false);
  if (sent) return <div className="sheet">🙏 {t(lang, "thanks")}</div>;
  return (
    <div className="sheet" style={{ textAlign: "center" }}>
      <b>{t(lang, "rateUs")}</b>
      <div className="stars">
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} className={n <= rating ? "on" : ""} onClick={() => setRating(n)} aria-label={`${n} stars`}>
            ★
          </button>
        ))}
      </div>
      <input style={{ width: "100%", border: "1px solid #e6e6ea", borderRadius: 8, padding: 8 }} placeholder={t(lang, "comment")} value={comment} onChange={(e) => setComment(e.target.value)} />
      <div className="actionsrow" style={{ justifyContent: "center" }}>
        <button className="btn primary" disabled={!rating} onClick={async () => { await act.command({ type: "feedback", rating, comment }); setSent(true); }}>
          {t(lang, "submit")}
        </button>
      </div>
    </div>
  );
}
