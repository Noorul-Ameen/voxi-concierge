import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Concierge } from "../components/Concierge";
import { API_BASE, type Lang } from "../lib/api";

type Film = { hoCode: string; title: string; posterUrl: string; rating: string };

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
          <Link to="/dashboard">{ar ? "لوحة التحكم" : "Dashboard"}</Link>
          <a href="#" onClick={(e) => { e.preventDefault(); setLang(ar ? "en" : "ar"); }}>
            {ar ? "English" : "العربية"}
          </a>
        </nav>
      </header>
      <section className="hero">
        <h1>{ar ? "تعرّف على فوكسي — مساعدك الذكي في فوكس سينما" : "Meet Voxi — your VOX Cinemas concierge"}</h1>
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
        <details style={{ marginTop: 16, fontSize: 13, color: "rgba(255,255,255,0.7)" }}>
          <summary>{ar ? "بيانات العرض التجريبي" : "Demo accounts"}</summary>
          <ul>
            <li>Sara Al Mansoori — +971 50 123 4567 / PIN 1234 — SHARE Gold, booking VXA7K2M (refundable), Arabic-preferred</li>
            <li>Rahul Menon — SHR200877 / PIN 2468 — booking RM3PQ9X starts in 20 min (cut-off), RMB0GO1 bank offer (non-refundable)</li>
            <li>James Whitfield — james.whitfield@example.com / PIN 9876 — Platinum; GOLD booking JWG0LD7 with F&B; IMAX JWIMX42</li>
            <li>Layla Haddad — guest — booking LHGUEST5 (verify last 4 digits 4455)</li>
            <li>Omar Khan — omar.khan@example.com / PIN 1111 — group booking OKGRP33 (partial cancel), OK4DXC0 collected</li>
            <li>Cards: 4111 1111 1111 1111 approved · 4000 0000 0000 0002 declined · Promo MONDAY30 · ENBD BIN 455533</li>
          </ul>
        </details>
      </section>
      <section className="posters">
        {films.slice(0, 18).map((f) => (
          <div key={f.hoCode} className="poster" style={{ backgroundImage: `url(${f.posterUrl})` }}>
            <span>
              {f.title} · {f.rating}
            </span>
          </div>
        ))}
      </section>
      <Concierge initialLang={lang} />
    </div>
  );
}
