import { useEffect, useState } from "react";
import { CinemaPage } from "../components/CinemaPage";
import { Concierge } from "../components/Concierge";
import { PageAccountDialog } from "../components/PageAccountDialog";
import type { Lang } from "../lib/api";
import { usePageSession } from "../lib/page-session";

export function Demo() {
  const [lang, setLang] = useState<Lang>(() => localStorage.getItem("voxi.lang") === "ar" ? "ar" : "en");
  const session = usePageSession();
  useEffect(() => {
    localStorage.setItem("voxi.lang", lang);
    document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
    document.documentElement.lang = lang;
  }, [lang]);
  return <CinemaPage lang={lang} onLanguage={setLang} customerName={session.customer?.firstName} authBusy={session.busy} onAccount={session.customer ? session.requestAccount : session.requestLogin}>
    <PageAccountDialog lang={lang} />
    <Concierge initialLang={lang} initialOpen={false} onLanguage={setLang} />
  </CinemaPage>;
}
