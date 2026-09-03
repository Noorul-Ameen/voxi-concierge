import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Concierge } from "../components/Concierge";
import { API_BASE, type Lang } from "../lib/api";

type Film = { hoCode: string; title: string; posterUrl: string; rating: string };

/** Demo personas: what each account is for and what to say to Voxi to exercise it. */
const PERSONAS = [
  {
    name: "Sara Al Mansoori",
    tier: "SHARE Gold",
    login: "+971 50 123 4567 · PIN 1234",
    shows: "The happy path. Logged-in member with a refundable booking. Exercises login, booking status, cancellation with refund to VOX credit or Share Points, Share balance, personalised recommendations. Prefers Arabic — switch languages mid-conversation.",
    say: "Hi, I'm Sara. Cancel my booking VXA7K2M and refund it to Share Points.",
  },
  {
    name: "Rahul Menon",
    tier: "SHARE member",
    login: "Member SHR200877 · PIN 2468",
    shows: "The policy edge cases. Booking RM3PQ9X starts in 20 minutes (inside the 30-minute cut-off → cancellation refused, swap offered, human agent offered). RMB0GO1 was bought with a bank offer → non-refundable per policy.",
    say: "Can I cancel RM3PQ9X? … Then what about RMB0GO1?",
  },
  {
    name: "James Whitfield",
    tier: "SHARE Platinum",
    login: "james.whitfield@example.com · PIN 9876",
    shows: "Premium experiences. GOLD booking JWG0LD7 includes pre-ordered F&B (partial cancellation keeps the meal); IMAX booking JWIMX42 is the swap demo — move it to another IMAX showtime and pay/refund the difference.",
    say: "Swap JWIMX42 to tomorrow's 9 pm IMAX show.",
  },
  {
    name: "Layla Haddad",
    tier: "Guest",
    login: "No account · booking LHGUEST5 · verify with last 4 digits 4455",
    shows: "The guest flow. Not logged in, so Voxi finds the booking by reference and must verify identity (last 4 digits of phone or the email) before it touches anything. Refunds go back to the original card.",
    say: "I don't have an account. My booking is LHGUEST5, phone ending 4455.",
  },
  {
    name: "Omar Khan",
    tier: "SHARE member",
    login: "omar.khan@example.com · PIN 1111",
    shows: "Group and collected tickets. OKGRP33 has 6 seats — cancel just two (partial refund with proportional fee). OK4DXC0's tickets were already collected at the kiosk → cannot be refunded; Voxi explains why and offers a complaint or human agent.",
    say: "Cancel two of the six seats on OKGRP33.",
  },
  {
    name: "New guest",
    tier: "Anyone",
    login: "Just start talking — no login needed",
    shows: "Guided booking end to end: find a movie → showtimes → tickets → seat map → food & drinks → promo / bank offer → payment sheet → QR code. Also movie, cinema, offers, age-rating and in-mall questions from the real VOX catalogue.",
    say: "Book two MAX tickets for tonight at Mall of the Emirates.",
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
            ? ["ما الذي يُعرض في مول الإمارات الليلة؟", "ألغِ حجزي VXA7K2M", "احجز تذكرتين لفيلم سبايدرمان في ماكس", "هل يمكن لطفل عمره 10 سنوات مشاهدة فيلم PG13؟", "أين السينما داخل ياس مول؟", "ما هي عروض البنوك اليوم؟"]
            : ["What's on at Mall of the Emirates tonight?", "Cancel my booking VXA7K2M", "Book two MAX tickets for Spider-Man", "Can my 10-year-old watch a PG13 movie?", "Where is the cinema inside Yas Mall?", "Which bank offers are on today?"]
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
                <span className="avatar">{p.name.split(" ").map((w) => w[0]).slice(0, 2).join("")}</span>
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
          <div><b>Test cards (simulated Checkout)</b><code>4111 1111 1111 1111</code> approved · <code>4000 0000 0000 0002</code> declined · any future expiry, any CVV</div>
          <div><b>Promo code</b><code>MONDAY30</code> — 30% off Standard tickets (Mondays)</div>
          <div><b>Bank offer</b>ENBD card BIN <code>455533</code> — buy one get one on Standard/MAX; cannot combine with promo codes</div>
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
