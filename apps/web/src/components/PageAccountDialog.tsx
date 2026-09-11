import { useEffect, useRef } from "react";
import type { Lang } from "../lib/api";
import { notifyPageAccountActivity, usePageSession } from "../lib/page-session";
import { AccountPanel } from "./AccountPanel";

/** Page-level account UI. It is intentionally mounted outside the assistant panel. */
export function PageAccountDialog({ lang, enabled = true }: { lang: Lang; enabled?: boolean }) {
  const account = usePageSession();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (enabled && account.open && !element.open) element.showModal();
    if ((!enabled || !account.open) && element.open) element.close();
  }, [account.open, enabled]);
  return <dialog ref={dialog} className="page-account-dialog" dir={lang === "ar" ? "rtl" : "ltr"} aria-label={lang === "ar" ? "حساب فوكس" : "Your VOX account"} onPointerDownCapture={notifyPageAccountActivity} onKeyDownCapture={notifyPageAccountActivity} onInputCapture={notifyPageAccountActivity} onCancel={account.close} onClose={() => { if (enabled) account.close(); }} onClick={(event) => {
    if (event.target !== event.currentTarget) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) account.close();
  }}>
    {account.open && enabled ? <AccountPanel lang={lang} customer={account.customer} profile={account.profile} history={account.history} loading={account.loading} busy={account.busy || !account.ready} error={account.error} onLogin={account.login} onLogout={account.logout} onClose={account.close} /> : null}
  </dialog>;
}
