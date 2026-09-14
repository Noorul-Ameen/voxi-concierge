/** Location control: share GPS or pick an area. The concierge uses it for "near me" — never the booking history. */
import { useState } from "react";
import type { Lang } from "../lib/api";
import AREAS from "../lib/location-areas.json";

export type Loc = { lat: number; lng: number; label: string; source: "gps" | "manual"; accuracyM?: number };

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
