import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Concierge } from "../components/Concierge";
import { API_BASE, type Lang } from "../lib/api";

type Film = { hoCode: string; title: string; posterUrl: string; rating: string };

/** Demo personas: what each account is for and what to say to Voxi to exercise it. */
const PERSONAS = [
  {
    name: "Sara Al Mansoori",
    flag: "🇦🇪",
    tier: "UAE · SHARE Gold",
    login: "+971 50 123 4567 · PIN 1234",
    shows: "Arabic and English films, family history (KIDS shows, children's tickets). Saved cards: Emirates NBD Mastercard ending 3845 (BOGO offer) and FAB Visa ending 8258 (weekend BOGO). 2,450 Share Points (AED 245) · AED 120 VOX credit. Home cinemas Mall of the Emirates and Mirdif. Prefers Arabic. Refundable family booking WXA7K2M.",
    say: "Suggest a movie for this weekend. / Cancel my booking WXA7K2M and refund it to Share Points.",
  },
  {
    name: "Rahul Menon",
    flag: "🇮🇳",
    tier: "India · SHARE Silver",
    login: "Member SHR200877 · PIN 2468",
    shows: "Tamil and Hindi films, late shows at Burjuman, Deira and Shindagha. Saved cards: ADCB Visa ending 2211 (BOGO) and HSBC Visa ending 6034 (BOGO + 25% F&B). 620 Share Points (AED 62) · AED 35 VOX credit. Policy edge cases: WM3PQ9X starts within the 30-minute cut-off, WMB6GQ2 was bought with a bank offer, WK4DXC9 tickets already collected, WKGRP33 is a group of 3 (partial cancellation).",
    say: "Any Tamil movies tonight near me? / Can I cancel WM3PQ9X?",
  },
  {
    name: "James Whitfield",
    flag: "🇬🇧",
    tier: "UK · SHARE Platinum",
    login: "james.whitfield@example.com · PIN 9876",
    shows: "English films only — GOLD, IMAX and THEATRE regular at Mall of the Emirates, Yas Mall and the Galleria. Saved cards: Mashreq Mastercard ending 7712 (50% off), CBD Visa ending 0099 (50% off) and a UK-issued Visa ending 5501 (no offer). 8,800 Share Points (AED 880) · AED 450 VOX credit. GOLD booking WJG8LD7 with pre-ordered food; IMAX booking WJMX42R for the swap demo.",
    say: "What should I watch tonight? / Swap WJMX42R to tomorrow's 9 pm IMAX show.",
  },
  {
    name: "Guest checkout",
    flag: "👤",
    tier: "No account",
    login: "Just start talking — name, email and mobile are asked before payment",
    shows: "Guided booking end to end without logging in: movie → nearest cinema and showtimes → tickets → seat map → food & drinks → payment (card, Apple Pay or Samsung Pay) → QR receipt. Guests see no bank offers and earn no Share Points — Voxi suggests logging in. A guest booking WLHGST5 (phone ending 4455) exists for the find-and-verify journey.",
    say: "Book two tickets for Spider-Man tonight near Deira. / My booking is WLHGST5, phone ending 4455.",
  },
] as const;

export function Demo() {
  const [lang, setLang] = useState<Lang>((localStorage.getItem("voxi.lang") as Lang) || "en");
  const [films, setFilms] = useState<Film[]>([]);
  useEffect(() => {
    localStorage.setItem("voxi.lang", lang);
    document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
  }, [lang]);
  useEffect(() => {
    // public read of now-showing posters through the concierge (no auth needed for the demo backdrop)
    fetch(`${API_BASE}/demo/films`).then((r) => (r.ok ? r.json() : { films: [] })).then((j) => setFilms(j.films ?? [])).catch(() => undefined);
  }, []);
  const ar = lang === "ar";
  return (
    <div className="backdrop">
      <header className="topbar">
        <div className="brand">
          <div className="logo">V</div>
          <span>VOX CINEMAS</span>
        </div>
        <nav>
          <Link to="/" className="active">
            {ar ? "الأفلام" : "Movies"}
          </Link>
          <a href="#demo-accounts">{ar ? "حسابات تجريبية" : "Demo accounts"}</a>
          <Link to="/dashboard">{ar ? "لوحة التحكم" : "Dashboard"}</Link>
          <a href="#" onClick={(e) => { e.preventDefault(); setLang(ar ? "en" : "ar"); }}>
            {ar ? "English" : "العربية"}
          </a>
        </nav>
      </header>
      <section className="hero">
        <h1>{ar ? <>تعرّف على <em>فوكسي</em> — مساعدك الذكي في فوكس سينما</> : <>Meet <em>Voxi</em> — your VOX Cinemas concierge</>}</h1>
        <p>{ar ? "اسأل بالصوت أو الكتابة: مواعيد العرض، الحجز واختيار المقاعد، الإلغاء والاسترداد، العروض، المأكولات والمشروبات، والتحويل إلى موظف خدمة العملاء." : "Talk or type: showtimes, guided booking with seat selection, cancellations and refunds, offers, food & drinks, and a seamless hand-over to Customer Care — in English or Arabic."}</p>
        <div className="chips">
          {(ar
            ? ["ما الذي يُعرض في مول الإمارات الليلة؟", "ألغِ حجزي WXA7K2M", "احجز تذكرتين لفيلم سبايدرمان في ماكس", "هل يمكن لطفل عمره 10 سنوات مشاهدة فيلم PG13؟", "أين السينما داخل ياس مول؟", "ما هي عروض البنوك اليوم؟"]
            : ["What's on at Mall of the Emirates tonight?", "Cancel my booking WXA7K2M", "Book two MAX tickets for Spider-Man", "Can my 10-year-old watch a PG13 movie?", "Where is the cinema inside Yas Mall?", "Which bank offers are on today?"]
          ).map((c) => (
            <span key={c} className="chip">
              {c}
            </span>
          ))}
        </div>
      </section>

      <div className="posters" style={{ paddingBottom: 8 }}>
        <div className="section-title" style={{ gridColumn: "1 / -1", margin: "0 0 4px" }}>{ar ? "يُعرض الآن — من موقع فوكس سينما" : "Now showing — real catalogue from uae.voxcinemas.com"}</div>
        {films.slice(0, 12).map((f) => (
          <div key={f.hoCode} className="poster" style={{ backgroundImage: `url(${f.posterUrl})` }}>
            <span>
              {f.title} · {f.rating}
            </span>
          </div>
        ))}
      </div>

      <section className="personas" id="demo-accounts">
        <div className="section-title">{ar ? "حسابات تجريبية — ماذا يوضح كل حساب" : "Demo accounts — what each one demonstrates"}</div>
        <p style={{ color: "var(--muted)", fontSize: 13, marginTop: 0, maxWidth: 760 }}>
          {ar
            ? "الأفلام والصالات ومواعيد العرض حقيقية. أما العملاء والحجوزات والمدفوعات فهي بيانات تجريبية داخل نظام فيستا الوهمي. كل حساب مصمم لإظهار مسار مختلف من نطاق المرحلتين 1 و2."
            : "Movies, cinemas and showtimes are real. Customers, bookings, loyalty balances and payments are dummy data in the Vista-shaped mock, so nothing you do here touches a real system. Each persona is built to exercise a different part of the Phase 1 & 2 scope — say the suggested line to Voxi, or improvise."}
        </p>
        <div className="grid">
          {PERSONAS.map((p) => (
            <div className="persona" key={p.name}>
              <div className="name">
                <span className="avatar">{p.flag}</span>
                {p.name}
                <span className="badge blue tier">{p.tier}</span>
              </div>
              <div className="login">{p.login}</div>
              <div className="shows">{p.shows}</div>
              <div className="say">“{p.say}”</div>
            </div>
          ))}
        </div>
        <div className="testdata">
          <div><b>Payment</b>Saved cards (members), new card, Apple Pay, Samsung Pay. Test cards: <code>4111 1111 1111 1111</code> approved · <code>4000 0000 0000 0002</code> declined · any future expiry, any CVV</div>
          <div><b>Promo code</b><code>MONDAY30</code> — 30% off Standard tickets (Mondays)</div>
          <div><b>Bank offers</b>Members only. Buy-one-get-one applies to exactly 2 tickets and must be paid with the same bank's card — e.g. Sara's ENBD card (BIN <code>521334</code>), Rahul's ADCB card (<code>409255</code>). New-card BINs for testing: ENBD <code>455533</code>, HSBC <code>424141</code>, Mashreq <code>472937</code></div>
          <div><b>Location</b>Tap 📍 in the widget to share your location or pick an area — "near me" showtimes and nearest-cinema answers use it, never the booking history</div>
          <div><b>Share Points</b>Members can redeem points at checkout or receive refunds as points (Sara has the largest balance)</div>
          <div><b>Voice vs text</b>Click the 🎙 button in the composer to talk; press 💬 to switch back to typing. Same tools either way</div>
          <div><b>Reset</b>Demo bookings return to their starting state whenever the database is reseeded (<code>pnpm db:seed</code>)</div>
        </div>
      </section>

      <footer className="footer">
        <div className="inner">
          <span>VOX 2.0 Digital Concierge — Phase 1 &amp; 2 demo · Majid Al Futtaim Entertainment</span>
          <span><a href="/dashboard">Insights dashboard</a><a href={`${API_BASE}/openapi.json`}>API</a><a href="https://uae.voxcinemas.com" target="_blank" rel="noreferrer">uae.voxcinemas.com</a></span>
        </div>
      </footer>
      <Concierge initialLang={lang} />
    </div>
  );
}
