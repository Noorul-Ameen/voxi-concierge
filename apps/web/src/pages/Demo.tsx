import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Concierge } from "../components/Concierge";
import { API_BASE, type Customer, type Lang } from "../lib/api";

type Film = { hoCode: string; title: string; posterUrl: string; rating: string };

export function Demo() {
  const [lang, setLang] = useState<Lang>((localStorage.getItem("voxi.lang") as Lang) || "en");
  const [films, setFilms] = useState<Film[]>([]);
  const [customer, setCustomer] = useState<Customer | null>(null);
  useEffect(() => {
    localStorage.setItem("voxi.lang", lang);
    document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
  }, [lang]);
  useEffect(() => {
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
          {customer ? (
            <a href="#" className="login" onClick={(e) => { e.preventDefault(); window.dispatchEvent(new CustomEvent("voxi:logout")); }}>
              {ar ? `مرحباً ${customer.firstName} · خروج` : `Hi ${customer.firstName} · Log out`}
            </a>
          ) : (
            <a href="#" className="login" onClick={(e) => { e.preventDefault(); window.dispatchEvent(new CustomEvent("voxi:login")); }}>
              {ar ? "تسجيل الدخول" : "Log in"}
            </a>
          )}
        </nav>
      </header>
      <section className="hero">
        <h1>{ar ? <>مساعد فوكس سينما <em>الافتراضي</em></> : <>VOX Cinemas <em>Virtual Assistant</em></>}</h1>
        <p>{ar ? "اسأل بالصوت أو الكتابة: مواعيد العرض، الحجز واختيار المقاعد، الإلغاء والاسترداد، العروض، المأكولات والمشروبات، والتحويل إلى موظف خدمة العملاء." : "Talk or type: showtimes, booking with seat selection, cancellations and refunds, offers, food & drinks, and a hand-over to Customer Care — in English or Arabic."}</p>
        <div className="chips">
          {(ar
            ? ["ما الذي يُعرض في مول الإمارات الليلة؟", "احجز تذكرتين لفيلم سبايدرمان في ماكس", "هل يمكن لطفل عمره 10 سنوات مشاهدة فيلم PG13؟", "أين السينما داخل ياس مول؟", "ما هي عروض البنوك اليوم؟"]
            : ["What's on at Mall of the Emirates tonight?", "Book two MAX tickets for Spider-Man", "Can my 10-year-old watch a PG13 movie?", "Where is the cinema inside Yas Mall?", "Which bank offers are on today?"]
          ).map((c) => (
            <span key={c} className="chip">
              {c}
            </span>
          ))}
        </div>
      </section>

      <div className="posters" style={{ paddingBottom: 8 }}>
        <div className="section-title" style={{ gridColumn: "1 / -1", margin: "0 0 4px" }}>{ar ? "يُعرض الآن" : "Now showing"}</div>
        {films.slice(0, 12).map((f) => (
          <div key={f.hoCode} className="poster" style={{ backgroundImage: `url(${f.posterUrl})` }}>
            <span>
              {f.title} · {f.rating}
            </span>
          </div>
        ))}
      </div>

      <footer className="footer">
        <div className="inner">
          <span>VOX Cinemas · Majid Al Futtaim Entertainment</span>
          <span><a href="https://uae.voxcinemas.com" target="_blank" rel="noreferrer">uae.voxcinemas.com</a></span>
        </div>
      </footer>
      <Concierge initialLang={lang} onAuth={setCustomer} />
    </div>
  );
}
