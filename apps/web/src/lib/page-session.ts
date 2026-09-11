import { useSyncExternalStore } from "react";
import type { BookingHistory, Customer, CustomerProfile, Lang } from "./api";

export type PageSessionSnapshot = {
  customer: Customer | null;
  profile: CustomerProfile | null;
  history: BookingHistory[];
  loading: boolean;
  busy: boolean;
  error: string | null;
  open: boolean;
  ready: boolean;
  language: Lang;
};
export type PageSessionRuntime = {
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
};

/** One page account surface shares the existing, serialized widget/voice session lifecycle.
 * Credentials travel through direct callbacks; status events never carry identity or tokens. */
export class PageSessionController {
  private snapshot: PageSessionSnapshot = { customer: null, profile: null, history: [], loading: false, busy: false, error: null, open: false, ready: false, language: "en" };
  private listeners = new Set<() => void>();
  private runtime: PageSessionRuntime | null = null;
  private presenter: (() => void) | null = null;
  private operation: Promise<void> | null = null;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.snapshot;
  update = (patch: Partial<PageSessionSnapshot>) => {
    if (Object.entries(patch).every(([key, value]) => this.snapshot[key as keyof PageSessionSnapshot] === value)) return;
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  };
  attach = (runtime: PageSessionRuntime) => {
    if (this.runtime !== runtime) this.operation = null;
    this.runtime = runtime;
    this.update({ ready: true, busy: false });
    return () => {
      if (this.runtime !== runtime) return;
      this.runtime = null;
      this.operation = null;
      this.update({ customer: null, profile: null, history: [], loading: false, busy: false, error: null, ready: false });
    };
  };
  presentWith = (presenter: (() => void) | null) => { this.presenter = presenter; };
  requestLogin = () => { this.update({ open: true, error: null }); this.presenter?.(); };
  requestAccount = () => { this.update({ open: true, error: null }); this.presenter?.(); };
  close = () => this.update({ open: false, error: null });
  private run = (action: (runtime: PageSessionRuntime) => Promise<void>) => {
    if (this.operation) return this.operation;
    const runtime = this.runtime;
    if (!runtime) {
      this.update({ error: this.snapshot.language === "ar" ? "الحساب يستعد. حاول بعد لحظة." : "Your account is getting ready. Try again in a moment." });
      return Promise.resolve();
    }
    this.update({ busy: true, error: null });
    const pending = Promise.resolve().then(() => { if (this.runtime === runtime && this.operation === pending) return action(runtime); }).catch(() => {
      if (this.runtime === runtime) this.update({ error: this.snapshot.language === "ar" ? "تعذر تحديث حسابك. حاول مرة أخرى." : "Your account could not be updated. Please try again." });
    }).finally(() => {
      if (this.operation !== pending || this.runtime !== runtime) return;
      this.operation = null;
      this.update({ busy: false });
    });
    this.operation = pending;
    return pending;
  };
  login = (email: string, password: string) => this.run((runtime) => runtime.login(email, password));
  logout = () => this.run((runtime) => runtime.logout());
}

export const pageSession = new PageSessionController();
export function usePageSession() {
  const state = useSyncExternalStore(pageSession.subscribe, pageSession.getSnapshot, pageSession.getSnapshot);
  return { ...state, requestLogin: pageSession.requestLogin, requestAccount: pageSession.requestAccount, close: pageSession.close, login: pageSession.login, logout: pageSession.logout };
}

export const AUTH_CHANGE_SIGNAL = "voxi.auth-changed";
export const ACCOUNT_ACTIVITY_EVENT = "voxi:account-activity";
export function notifyPageAccountActivity() { window.dispatchEvent(new Event(ACCOUNT_ACTIVITY_EVENT)); }
export function notifyPageAuthChange() {
  try { localStorage.setItem(AUTH_CHANGE_SIGNAL, `${Date.now()}:${crypto.randomUUID()}`); } catch { /* The current page remains usable without cross-tab storage. */ }
}
