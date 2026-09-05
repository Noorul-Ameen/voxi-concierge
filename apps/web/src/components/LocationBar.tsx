/** Location control: share GPS or pick an area. The concierge uses it for "near me" — never the booking history. */
import { useState } from "react";
import type { Lang } from "../lib/api";

export type Loc = { lat: number; lng: number; label: string; source: "gps" | "manual"; accuracyM?: number };

const AREAS: { label: string; labelAr: string; lat: number; lng: number; group: string }[] = [
  { group: "Dubai", label: "Deira", labelAr: "ديرة", lat: 25.2697, lng: 55.3095 },
  { group: "Dubai", label: "Bur Dubai", labelAr: "بر دبي", lat: 25.2537, lng: 55.3033 },
  { group: "Dubai", label: "Downtown Dubai", labelAr: "داون تاون دبي", lat: 25.1972, lng: 55.2744 },
  { group: "Dubai", label: "Jumeirah", labelAr: "جميرا", lat: 25.2048, lng: 55.245 },
  { group: "Dubai", label: "Al Barsha", labelAr: "البرشاء", lat: 25.1181, lng: 55.2004 },
  { group: "Dubai", label: "Dubai Marina / JBR", labelAr: "مرسى دبي", lat: 25.0805, lng: 55.1403 },
  { group: "Dubai", label: "Palm Jumeirah", labelAr: "نخلة جميرا", lat: 25.1124, lng: 55.139 },
  { group: "Dubai", label: "Mirdif", labelAr: "مردف", lat: 25.22, lng: 55.42 },
  { group: "Dubai", label: "Festival City", labelAr: "فستيفال سيتي", lat: 25.222, lng: 55.352 },
  { group: "Dubai", label: "Al Nahda", labelAr: "النهدة", lat: 25.287, lng: 55.37 },
  { group: "Dubai", label: "Silicon Oasis", labelAr: "واحة السيليكون", lat: 25.1215, lng: 55.3773 },
  { group: "Abu Dhabi", label: "Abu Dhabi city", labelAr: "مدينة أبوظبي", lat: 24.4539, lng: 54.3773 },
  { group: "Abu Dhabi", label: "Al Maryah / Reem Island", labelAr: "جزيرة المارية / الريم", lat: 24.498, lng: 54.395 },
  { group: "Abu Dhabi", label: "Yas Island", labelAr: "جزيرة ياس", lat: 24.488, lng: 54.608 },
  { group: "Abu Dhabi", label: "Khalifa City", labelAr: "مدينة خليفة", lat: 24.42, lng: 54.58 },
  { group: "Abu Dhabi", label: "Al Ain", labelAr: "العين", lat: 24.2075, lng: 55.7447 },
  { group: "Northern Emirates", label: "Sharjah city", labelAr: "مدينة الشارقة", lat: 25.3463, lng: 55.4209 },
  { group: "Northern Emirates", label: "Al Zahia / Muwaileh", labelAr: "الزاهية / مويلح", lat: 25.304, lng: 55.466 },
  { group: "Northern Emirates", label: "Ajman", labelAr: "عجمان", lat: 25.4052, lng: 55.5136 },
  { group: "Northern Emirates", label: "Ras Al Khaimah", labelAr: "رأس الخيمة", lat: 25.7895, lng: 55.9432 },
  { group: "Northern Emirates", label: "Fujairah", labelAr: "الفجيرة", lat: 25.1288, lng: 56.3265 },
];

export function LocationBar({ lang, loc, onChange }: { lang: Lang; loc: Loc | null; onChange: (l: Loc | null) => void }) {
  const ar = lang === "ar";
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const useGps = async () => {
    setBusy(true);
    setErr(null);
    try {
      const pos = await new Promise<GeolocationPosition>((res, rej) => navigator.geolocation.getCurrentPosition(res, rej, { timeout: 8000 }));
      onChange({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracyM: pos.coords.accuracy, label: ar ? "موقعي الحالي" : "My current location", source: "gps" });
      setOpen(false);
    } catch {
      setErr(ar ? "تعذر الوصول إلى الموقع — اختر منطقة بدلاً من ذلك." : "Couldn't get your location — pick an area instead.");
    }
    setBusy(false);
  };
  const groups = [...new Set(AREAS.map((a) => a.group))];
  return (
    <div className={`locbar ${loc ? "set" : ""}`}>
      <button className="locbtn" onClick={() => setOpen((x) => !x)} title={ar ? "الموقع" : "Location"}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z" /><circle cx="12" cy="10" r="2.5" /></svg>
        <span>{loc ? (loc.source === "gps" ? (ar ? "موقعي الحالي" : "My current location") : loc.label) : ar ? "حدد موقعك لعرض أقرب السينمات" : "Set your location for nearby cinemas"}</span>
        <i className={open ? "up" : ""} />
      </button>
      {loc ? (
        <button className="locclear" onClick={() => onChange(null)} title={ar ? "مسح" : "Clear"} aria-label="clear location">
          ×
        </button>
      ) : null}
      {open ? (
        <div className="locsheet">
          <button className="btn cta gps" disabled={busy} onClick={useGps}>
            {busy ? (ar ? "جارٍ التحديد…" : "Locating…") : ar ? "استخدم موقعي الحالي" : "Use my current location"}
          </button>
          {err ? <small className="err">{err}</small> : null}
          <div className="areas">
            {groups.map((g) => (
              <div key={g}>
                <small>{g}</small>
                <div className="chips">
                  {AREAS.filter((a) => a.group === g).map((a) => (
                    <button
                      key={a.label}
                      className={loc?.label === (ar ? a.labelAr : a.label) ? "on" : ""}
                      onClick={() => {
                        onChange({ lat: a.lat, lng: a.lng, label: ar ? a.labelAr : a.label, source: "manual" });
                        setOpen(false);
                      }}
                    >
                      {ar ? a.labelAr : a.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
