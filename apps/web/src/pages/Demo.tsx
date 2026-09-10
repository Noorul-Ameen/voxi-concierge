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
    <div className="backdrop vox-assistant-root" data-voxi-theme="navy">
      <header className="topbar">
        <div className="brand">
          <div className="logo">VOX</div>
          <span>CINEMAS</span>
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
            <a href="#" className="login" onClick={(e) => { e.preventDefault(); window.dispatchEvent(new CustomEvent("voxi:profile")); }}>
              {customer.firstName}
            </a>
          ) : (
            <a href="#" className="login" onClick={(e) => { e.preventDefault(); window.dispatchEvent(new CustomEvent("voxi:login")); }}>
              {ar ? "تسجيل الدخول" : "Log in"}
            </a>
          )}
        </nav>
      </header>
      <section className="hero">
        <span className="eyebrow">{ar ? "ليلتك السينمائية، على ذوقك" : "YOUR KIND OF MOVIE NIGHT"}</span>
        <h1>{ar ? <>مساعد فوكس سينما <em>الافتراضي</em></> : <>VOX Cinemas <em>Virtual Assistant</em></>}</h1>
        <p>{ar ? "فيلم يناسب ذوقك، مقاعد تحبها، وكل ما تحتاجه لأمسية رائعة. تحدث معنا أو اكتب لنبدأ." : "A film you'll love, seats that feel right, and everything for a great night out. Just tell us what you're in the mood for."}</p>
        <button className="btn cta" type="button" onClick={() => window.dispatchEvent(new CustomEvent("voxi:open"))}>{ar ? "لنخطط لليلتك" : "Plan my movie night"} <span aria-hidden="true">↗</span></button>
        <div className="chips">
          {(ar
            ? ["أفلام على ذوقك", "مقاعدك المعتادة", "عروض تناسبك"]
            : ["Films for you", "Your usual seats", "Offers that fit"]
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
      <Concierge initialLang={lang} onAuth={setCustomer} onLanguage={setLang} />
    </div>
  );
}
