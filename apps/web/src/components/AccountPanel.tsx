import { useId, useState } from "react";
import type { BookingHistory, Customer, CustomerProfile, Lang } from "../lib/api";
import { money } from "../lib/i18n";
import { cinemaDate } from "../lib/cinema-time";

export type AccountPanelProps = {
  lang: Lang;
  customer: Customer | null;
  profile?: CustomerProfile | null;
  history?: BookingHistory[];
  loading?: boolean;
  busy?: boolean;
  error?: string | null;
  onLogin: (email: string, password: string) => Promise<void>;
  onLogout: () => Promise<void>;
  onClose: () => void;
};

function timeLabel(time: string | undefined, lang: Lang) {
  if (!time || !/^\d{2}:\d{2}$/.test(time)) return lang === "ar" ? "نتعرف على ذوقك" : "Getting to know you";
  return new Intl.DateTimeFormat(lang === "ar" ? "ar-AE" : "en-AE", { hour: "numeric", minute: time.endsWith(":00") ? undefined : "2-digit", timeZone: "Asia/Dubai" }).format(new Date(`2026-01-01T${time}:00+04:00`));
}

export function AccountPanel({ lang, customer, profile: suppliedProfile, history = [], loading, busy, error, onLogin, onLogout, onClose }: AccountPanelProps) {
  const id = useId();
  const ar = lang === "ar";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const profile = suppliedProfile ?? customer?.profile;
  const card = customer?.savedCards?.find((c) => c.default) ?? customer?.savedCards?.[0];
  const seatNames: Record<string, [string, string]> = { front: ["Front", "الأمام"], middle: ["Centre", "الوسط"], back: ["Back", "الخلف"], aisle: ["Aisle", "الممر"] };
  const languageNames: Record<string, [string, string]> = { ar: ["Arabic", "العربية"], Arabic: ["Arabic", "العربية"], en: ["English", "الإنجليزية"], English: ["English", "الإنجليزية"], ta: ["Tamil", "التاميلية"], Tamil: ["Tamil", "التاميلية"] };
  const label = (name: string | null | undefined, names: Record<string, [string, string]>) => name ? names[name]?.[ar ? 1 : 0] ?? name : ar ? "نتعرف على ذوقك" : "Getting to know you";

  return (
    <section className="account-panel" aria-labelledby={`${id}-title`} onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}>
      <header className="account-head">
        <div><span className="eyebrow">{ar ? "حساب فوكس" : "Your VOX"}</span><h3 id={`${id}-title`}>{customer ? customer.firstName : ar ? "أهلاً بعودتك" : "Welcome back"}</h3></div>
        <button className="account-close" type="button" onClick={onClose} aria-label={ar ? "إغلاق الحساب" : "Close account"}>×</button>
      </header>
      {!customer ? (
        <form className="account-form" onSubmit={async (e) => {
          e.preventDefault();
          setLocalError(null);
          try { await onLogin(email.trim(), password); setPassword(""); }
          catch { setLocalError(ar ? "تعذر تسجيل الدخول. حاول مرة أخرى." : "We couldn't sign you in. Try again."); }
        }}>
          <p>{ar ? "أفلامك المفضلة، مقاعدك المعتادة وحجز أسرع." : "Your kind of films. Your usual seats. A quicker way to book."}</p>
          <label htmlFor={`${id}-email`}>{ar ? "البريد الإلكتروني" : "Email"}</label>
          <input id={`${id}-email`} name="email" type="email" autoComplete="username" autoFocus required value={email} onChange={(e) => setEmail(e.target.value)} dir="ltr" />
          <label htmlFor={`${id}-password`}>{ar ? "كلمة المرور" : "Password"}</label>
          <input id={`${id}-password`} name="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} dir="ltr" />
          {error || localError ? <p className="err" role="alert">{error || localError}</p> : null}
          <button className="btn cta" type="submit" disabled={busy}>{busy ? ar ? "جارٍ تسجيل الدخول…" : "Signing in…" : ar ? "تسجيل الدخول" : "Sign in"}</button>
          <button className="btn ghost" type="button" onClick={onClose}>{ar ? "المتابعة كضيف" : "Continue as a guest"}</button>
        </form>
      ) : (
        <div className="account-details">
          <p className="account-email">{customer.email}</p>
          {loading ? <p className="muted" role="status">{ar ? "جارٍ تحميل حسابك…" : "Loading your account…"}</p> : null}
          {error ? <p className="err" role="alert">{error}</p> : null}
          {profile ? <>
            <dl className="profile-grid">
              <div><dt>{ar ? "الأفلام" : "Movies"}</dt><dd>{label(profile.movieLanguage, languageNames)}</dd></div>
              <div><dt>{ar ? "السينما المعتادة" : "Usual cinema"}</dt><dd>{profile.cinemaName ?? (ar ? "لم تحدد بعد" : "Still exploring")}</dd></div>
              <div className="wide"><dt>{ar ? "أوقاتك المعتادة" : "Usually watches"}</dt><dd className="profile-times"><span><small>{ar ? "أيام الأسبوع" : "Weekdays"}</small>{timeLabel(profile.weekday?.around, lang)}</span><span><small>{ar ? "نهاية الأسبوع" : "Weekends"}</small>{timeLabel(profile.weekend?.around, lang)}</span></dd></div>
              <div><dt>{ar ? "المقاعد" : "Seats"}</dt><dd>{label(profile.seatPreference, seatNames)}</dd></div>
              <div><dt>{ar ? "الدفع" : "Payment"}</dt><dd>{card ? <>{card.label ?? card.brand ?? (ar ? "بطاقة محفوظة" : "Saved card")}<small dir="ltr">{card.masked ?? (card.last4 ? `•••• ${card.last4}` : "")}</small></> : ar ? "اختر عند الدفع" : "Choose at checkout"}</dd></div>
            </dl>
            <p className="profile-explainer">{ar ? "من زياراتك السابقة. يمكنك دائماً اختيار شيء مختلف." : "From your past visits. You're always free to try something different."}</p>
          </> : !loading ? <p className="muted">{ar ? "ستظهر تفضيلاتك هنا مع زياراتك للسينما." : "Your cinema preferences will appear here as you visit."}</p> : null}
          <div className="profile-wallet"><div><span>VOX Credit</span><b>{money(customer.voxCreditCents ?? customer.voxRewardsCents ?? 0, lang)}</b></div><div><span>SHARE</span><b>{new Intl.NumberFormat(ar ? "ar-AE" : "en-AE").format(customer.sharePoints ?? 0)} <small>{ar ? "نقطة" : "points"}</small></b></div></div>
          <details className="profile-history">
            <summary>{ar ? "زياراتك للسينما" : "Your cinema visits"}<span>{history.length}</span></summary>
            <p>{ar ? "هذه الزيارات تساعدنا على معرفة الأفلام والمواعيد التي تحبها." : "These visits help us find the films, cinemas and times you enjoy."}</p>
            {history.length ? <ol>{history.map((booking, index) => <li key={`${booking.showtime}-${booking.filmTitle}-${index}`}>
              <b>{booking.filmTitle}</b><span>{[label(booking.language, languageNames), booking.cinemaName ?? booking.cinemaId].filter(Boolean).join(" · ")}</span>
              <small>{Number.isNaN(cinemaDate(booking.showtime).getTime()) ? booking.showtime : new Intl.DateTimeFormat(ar ? "ar-AE" : "en-AE", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: profile?.timeZone ?? "Asia/Dubai" }).format(cinemaDate(booking.showtime))}{booking.ticketCount ? ` · ${booking.ticketCount} ${ar ? "تذاكر" : "tickets"}` : ""}</small>
            </li>)}</ol> : <p className="muted">{ar ? "لا توجد زيارات بعد." : "No visits yet."}</p>}
          </details>
          <button className="btn ghost account-signout" type="button" disabled={busy} onClick={() => { void onLogout(); }}>{ar ? "تسجيل الخروج" : "Sign out"}</button>
        </div>
      )}
    </section>
  );
}
