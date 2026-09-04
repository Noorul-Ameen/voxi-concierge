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
        return items.map((m, i) => <MenuItem key={i} m={m} lang={lang} act={act} />);
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
                <small>{[ss[0]?.rating, ss[0]?.filmLanguage, ss[0]?.cinemaName].filter(Boolean).join(" · ")}</small>
              </div>
            </div>
          ) : (
            <b className="sg-cinema">📍 {k}</b>
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

function MenuItem({ m, lang, act }: { m: any; lang: Lang; act: CardActions }) {
  return (
    <div className="menuitem">
      <div className="img" style={{ backgroundImage: `url(${m.imageUrl})` }} />
      <div className="b">
        <b>
          {m.name} {m.isBestSeller ? <span className="badge">★</span> : null}
        </b>
        <div style={{ color: "#6b6b76" }}>{m.description}</div>
        <div className="tags">
          {(m.dietaryTags ?? []).map((d: string) => (
            <span key={d} className="badge soft">
              {d.replace("_", " ")}
            </span>
          ))}
          {m.calories ? <span className="badge soft">{m.calories} kcal</span> : null}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span className="price">{m.price}</span>
          <button className="btn primary" style={{ padding: "5px 10px" }} onClick={() => routeAction(`add_item:${m.itemId}`, `Add ${m.nameEn ?? m.name}`, act, lang)}>
            + {lang === "ar" ? "أضف" : "Add"}
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

function TicketTypes({ items, lang, act }: { items: any[]; lang: Lang; act: CardActions; sessionKey?: string }) {
  return (
    <div className="order">
      {items.map((tt) => (
        <div className="line" key={tt.code}>
          <span>
            {tt.description} {tt.area === "premium_view" ? <span className="badge soft">Premium view</span> : null}
          </span>
          <span>
            <b>{tt.price}</b>{" "}
            <button className="btn ghost" style={{ padding: "3px 8px", marginInlineStart: 6 }} onClick={() => act.say(lang === "ar" ? `أضف تذكرة ${tt.description}` : `Add one ${tt.description} ticket`)}>
              +1
            </button>
          </span>
        </div>
      ))}
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

function SeatMap({ rows, meta, lang, act }: { rows: any[]; meta: Record<string, any>; lang: Lang; act: CardActions }) {
  const [picked, setPicked] = useState<{ row: string; number: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const held = rows.flatMap((r) => r.seats.filter((s: any) => s.status === 2).map(() => 1)).length;
  const need = held || Number(meta.ticketCount ?? 0) || picked.length || 1;
  const cols = Number(meta.columnCount ?? Math.max(...rows.map((r) => Math.max(...r.seats.map((s: any) => s.col)) + 1)));
  const toggle = (row: string, id: string) => {
    setErr(null);
    setPicked((p) => (p.some((x) => x.row === row && x.number === id) ? p.filter((x) => !(x.row === row && x.number === id)) : p.length >= need ? [...p.slice(1), { row, number: id }] : [...p, { row, number: id }]));
  };
  const confirm = async () => {
    setBusy(true);
    const r = await act.command({ type: "seat.select", userSessionId: meta.userSessionId, seats: picked });
    setBusy(false);
    if (!r.ok) setErr(r.action?.error?.message ?? r.error ?? "Could not hold those seats");
    else act.say(lang === "ar" ? `اخترت المقاعد ${picked.map((p) => p.row + p.number).join("، ")}` : `I've picked seats ${picked.map((p) => p.row + p.number).join(", ")} on the map`);
  };
  return (
    <div className="seatmap">
      <div className="screen">{t(lang, "screen")}</div>
      <div className="rows" style={{ gridTemplateColumns: "1fr" }}>
        {rows.map((r) => {
          const byCol = new Map<number, any>(r.seats.map((s: any) => [s.col, s]));
          return (
            <div className="row" key={`${r.area}-${r.row}`}>
              <span className="rl">{r.row}</span>
              {Array.from({ length: cols }, (_, c) => {
                const s = byCol.get(c);
                if (!s) return <span key={c} className="seat gap" />;
                const mine = picked.some((p) => p.row === r.row && p.number === s.id);
                const cls = ["seat", r.areaCategoryCode === "0000000001" ? "premium" : "", s.style === 1 ? "wheelchair" : "", s.status === 1 ? "sold" : s.status === 3 ? "held" : s.status === 2 ? "mine" : "", mine ? "picked" : ""].join(" ");
                return <button key={c} className={cls} title={`${r.row}${s.id}`} disabled={s.status === 1 || s.status === 3} onClick={() => toggle(r.row, s.id)} />;
              })}
              <span className="rl">{r.row}</span>
            </div>
          );
        })}
      </div>
      <div className="legend">
        <span>
          <i style={{ background: "#fff", border: "1px solid #c9c9d0" }} />
          {t(lang, "available")}
        </span>
        <span>
          <i style={{ background: "#fff8e1", border: "1px solid #b8860b" }} />
          Premium view
        </span>
        <span>
          <i style={{ background: "var(--vox-blue)" }} />
          {lang === "ar" ? "محجوز لك" : "Held for you"}
        </span>
        <span>
          <i style={{ background: "#111" }} />
          {t(lang, "selected")}
        </span>
        <span>
          <i style={{ background: "#d0d0d6" }} />
          {t(lang, "taken")}
        </span>
      </div>
      {err ? <div className="sheet err" style={{ marginTop: 6 }}>{err}</div> : null}
      <div className="actionsrow">
        <button className="btn primary" disabled={!picked.length || busy} onClick={confirm}>
          {busy ? t(lang, "processing") : `${t(lang, "confirmSeats")} (${picked.length}/${need})`}
        </button>
        <button className="btn ghost" onClick={() => act.say(lang === "ar" ? "اختر أفضل المقاعد المتاحة" : "Pick the best available seats for me")}>
          {lang === "ar" ? "الأفضل المتاح" : "Best available"}
        </button>
      </div>
    </div>
  );
}

function PaymentSheet({ o, meta, lang, act }: { o: any; meta: Record<string, any>; lang: Lang; act: CardActions }) {
  const [pan, setPan] = useState("4111 1111 1111 1111");
  const [exp, setExp] = useState("12/29");
  const [cvv, setCvv] = useState("123");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  if (!meta.requiresSheet) return <OrderSummary o={o} lang={lang} act={act} />;
  const pay = async () => {
    setBusy(true);
    setErr(null);
    // Simulated Checkout tokenisation: the PAN never leaves the browser; only a token is sent.
    const digits = pan.replace(/\D/g, "");
    const token = digits.endsWith("0002") ? `tok_declined_${Date.now()}` : `tok_${digits.startsWith("4") ? "visa" : "mc"}_${digits.slice(-4)}_${Date.now()}`;
    const r = await act.command({ type: "payment.token", userSessionId: meta.userSessionId, confirmationId: meta.confirmationId, token });
    setBusy(false);
    if (r.ok) {
      setDone(true);
      act.say(lang === "ar" ? "أكملت الدفع في نافذة الدفع." : "I've completed the payment in the payment sheet.");
    } else setErr(r.action?.error?.message ?? r.error ?? "Payment failed");
  };
  if (done) return <div className="sheet">✅ {lang === "ar" ? "تم الدفع" : "Payment received"}</div>;
  return (
    <div className="sheet">
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
        <b>{meta.method === "APPLE_PAY" ? "Apple Pay" : meta.method === "GOOGLE_PAY" ? "Google Pay" : lang === "ar" ? "الدفع بالبطاقة" : "Card payment"}</b>
        <b>{money(meta.amountCents, lang)}</b>
      </div>
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
      <small style={{ color: "#6b6b76" }}>{lang === "ar" ? "بيئة تجريبية: بطاقة تنتهي بـ 0002 تُرفض." : "Sandbox: a card ending 0002 is declined; any other test card is approved."}</small>
      {err ? <div className="err" style={{ marginTop: 6 }}>{err}</div> : null}
      <div className="actionsrow">
        <button className="btn primary" disabled={busy} onClick={pay}>
          {busy ? t(lang, "processing") : `${t(lang, "payButton")} ${money(meta.amountCents, lang)}`}
        </button>
        <button className="btn ghost" onClick={() => act.say(lang === "ar" ? "ألغِ الدفع" : "Cancel the payment")}>
          {lang === "ar" ? "إلغاء" : "Cancel"}
        </button>
      </div>
    </div>
  );
}

function QRTicket({ b, lang, qr }: { b: any; lang: Lang; qr?: string }) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    QRCode.toDataURL(qr ?? b.qrPayload ?? b.bookingId ?? "VOX", { width: 360, margin: 1, color: { dark: "#1f2428", light: "#ffffff" } }).then(setSrc).catch(() => setSrc(""));
  }, [qr, b.qrPayload, b.bookingId]);
  return (
    <div className="ticket">
      <div className="t-top">
        <div className="t-brand">VOX <span>CINEMAS</span></div>
        <div className="t-exp">{b.experience}</div>
      </div>
      <div className="t-main">
        <div className="t-film">{b.filmTitle}</div>
        <div className="t-grid">
          <div><small>{lang === "ar" ? "السينما" : "Cinema"}</small><b>{b.cinemaName ?? b.cinemaId}</b></div>
          <div><small>{lang === "ar" ? "الموعد" : "When"}</small><b>{b.showtimeLabel}</b></div>
          <div><small>{t(lang, "seats")}</small><b>{b.seats}</b></div>
          <div><small>{t(lang, "bookingRef")}</small><b className="mono">{b.bookingId}</b></div>
        </div>
      </div>
      <div className="t-tear"><i /><i /></div>
      <div className="t-qr">
        {src ? <img src={src} alt="QR" /> : null}
        <small>{t(lang, "scanQr")}</small>
      </div>
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
