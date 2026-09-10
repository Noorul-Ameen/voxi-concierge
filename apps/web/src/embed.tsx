/**
 * Embeddable VOX Cinemas Virtual Assistant. The legacy script URL and API remain compatible.
 *
 *   <script src="https://voxi-demo.up.railway.app/embed/voxi.js" charset="utf-8" defer></script>
 *
 * Optional attributes on the script tag: data-lang="en|ar", data-open="true" (start expanded instead of as the
 * launcher pill), data-theme="navy" (colour preset; see the theme blocks in styles.css), data-api="https://…/api"
 * (defaults to the origin the script was loaded from + /api). window.VoxiConfig.vars can override any CSS variable. Optional: window.VoxiConfig = { apiBase, lang } before the script.
 * The widget renders inside a Shadow DOM so the host page's CSS and the widget's CSS never interfere.
 * Exposes window.Voxi = { open(), login(), logout(), unmount() }.
 */
import React from "react";
import ReactDOM from "react-dom/client";
import { Concierge } from "./components/Concierge";
import { PageAccountDialog } from "./components/PageAccountDialog";
import { configureApiBase, type Lang } from "./lib/api";
import { notifyPageAccountActivity, pageSession } from "./lib/page-session";
import css from "./styles.css?inline";
import stateCss from "./concierge-state.css?inline";
import accountCss from "./page-account.css?inline";

const script = document.currentScript as HTMLScriptElement | null;
const scriptOrigin = (() => {
  try {
    return script?.src ? new URL(script.src).origin : location.origin;
  } catch {
    return location.origin;
  }
})();
window.VoxiConfig = {
  apiBase: window.VoxiConfig?.apiBase ?? script?.dataset.api ?? `${scriptOrigin}/api`,
  lang: (window.VoxiConfig?.lang ?? (script?.dataset.lang as Lang | undefined) ?? "en") as Lang,
  open: window.VoxiConfig?.open ?? script?.dataset.open === "true",
  theme: window.VoxiConfig?.theme ?? script?.dataset.theme ?? "navy",
  vars: window.VoxiConfig?.vars,
  hostLoginSelector: window.VoxiConfig?.hostLoginSelector,
};
configureApiBase(window.VoxiConfig.apiBase!);

const FONTS = "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Cairo:wght@400;600;700&display=swap";
if (!document.querySelector(`link[href="${FONTS}"]`)) {
  const l = document.createElement("link");
  l.rel = "stylesheet";
  l.href = FONTS;
  document.head.appendChild(l);
}

function mount() {
  if (document.getElementById("voxi-widget-host")) return;
  const host = document.createElement("div");
  host.id = "voxi-widget-host";
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  // Keep fixed widget controls above the host page's header without covering the page with an overlay.
  // Relative positioning creates a stacking context but preserves viewport positioning for fixed children.
  style.textContent = `${css.replace(/:root/g, ":host")}\n${stateCss}\n:host { all: initial; position: relative; z-index: 1000; font-family: var(--font); color: var(--ink); }`;
  shadow.appendChild(style);
  const root = document.createElement("div");
  root.className = "vox-assistant-root";
  root.dir = window.VoxiConfig?.lang === "ar" ? "rtl" : "ltr";
  // Theme: a named preset from styles.css ("navy", …) and/or individual CSS variables (e.g. { "--accent": "#19c4d3" }).
  if (window.VoxiConfig?.theme) root.dataset.voxiTheme = window.VoxiConfig.theme;
  for (const [k, v] of Object.entries(window.VoxiConfig?.vars ?? {})) if (k.startsWith("--")) root.style.setProperty(k, v);
  shadow.appendChild(root);
  const app = ReactDOM.createRoot(root);
  const knownHost = location.hostname === "voxi.kris-pradip.workers.dev";
  const loginSelector = window.VoxiConfig?.hostLoginSelector ?? (knownHost ? "#loginBtn" : undefined);
  const getLoginButton = () => {
    try { return loginSelector ? document.querySelector<HTMLElement>(loginSelector) : null; } catch { return null; }
  };
  const nativeForm = knownHost ? document.querySelector<HTMLFormElement>("#siteLoginForm") : null;
  const hasNativeLogin = !!(nativeForm && getLoginButton());
  const identifier = nativeForm?.querySelector<HTMLInputElement>("#siteLoginIdentifier");
  const password = nativeForm?.querySelector<HTMLInputElement>("#siteLoginPin");
  if (identifier && password) {
    identifier.type = "email"; identifier.autocomplete = "username";
    password.autocomplete = "current-password";
    for (const field of [identifier, password]) {
      for (const constraint of ["pattern", "minlength", "maxlength", "inputmode"]) field.removeAttribute(constraint);
    }
    password.maxLength = 256;
    const emailLabel = nativeForm?.querySelector<HTMLLabelElement>('label[for="siteLoginIdentifier"]');
    const passwordLabel = nativeForm?.querySelector<HTMLLabelElement>('label[for="siteLoginPin"]');
    const ar = window.VoxiConfig?.lang === "ar";
    if (emailLabel) emailLabel.textContent = ar ? "البريد الإلكتروني" : "Email";
    if (passwordLabel) passwordLabel.textContent = ar ? "كلمة المرور" : "Password";
    identifier.placeholder = ar ? "البريد الإلكتروني" : "Email";
    password.placeholder = ar ? "كلمة المرور" : "Password";
  }
  // The page account surface is a separate DOM root, never a card inside the assistant.
  const accountHost = document.createElement("div");
  accountHost.id = "voxi-page-account-host";
  document.body.appendChild(accountHost);
  const accountShadow = accountHost.attachShadow({ mode: "open" });
  const accountStyle = document.createElement("style");
  accountStyle.textContent = `${css.replace(/:root/g, ":host")}\n${accountCss}\n:host { all: initial; font-family: var(--font); color: var(--ink); }`;
  const accountRoot = document.createElement("div");
  accountShadow.append(accountStyle, accountRoot);
  const accountApp = ReactDOM.createRoot(accountRoot);
  let closingNative = false;
  let wasOpen = false;
  const closeNativeLogin = () => {
    if (!hasNativeLogin || closingNative) return;
    closingNative = true;
    if (password) password.value = "";
    document.querySelector<HTMLButtonElement>("#loginClose")?.click();
    closingNative = false;
  };
  const renderAccount = () => {
    const state = pageSession.getSnapshot();
    const ar = state.language === "ar";
    const button = getLoginButton();
    if (button) {
      button.textContent = state.customer ? state.customer.firstName : ar ? "تسجيل الدخول" : "Sign in";
      button.setAttribute("aria-label", state.customer ? ar ? "حسابك في فوكس" : "Your VOX account" : ar ? "تسجيل الدخول" : "Sign in");
    }
    const error = nativeForm?.querySelector<HTMLElement>("#siteLoginError");
    if (error) { error.textContent = state.error ?? ""; error.hidden = !state.error; error.setAttribute("role", "alert"); }
    const submit = nativeForm?.querySelector<HTMLButtonElement>("#siteLoginSubmit");
    if (submit) submit.disabled = state.busy || !state.ready;
    const shouldCloseNative = wasOpen && !state.open;
    wasOpen = state.open;
    if (shouldCloseNative) closeNativeLogin();
    accountApp.render(React.createElement(PageAccountDialog, { lang: state.language, enabled: !hasNativeLogin || !!state.customer }));
  };
  const unsubscribeAccount = pageSession.subscribe(renderAccount);
  pageSession.presentWith(() => {
    if (hasNativeLogin && !pageSession.getSnapshot().customer) getLoginButton()?.click();
  });
  const pageClick = (event: Event) => {
    const target = event.target;
    if (!(target instanceof Element) || closingNative) return;
    if (hasNativeLogin && (target.closest("#loginClose") || target.id === "loginModal")) pageSession.close();
    const button = getLoginButton();
    if (!button || !button.contains(target)) return;
    notifyPageAccountActivity();
    if (hasNativeLogin && !pageSession.getSnapshot().customer) {
      pageSession.update({ open: true, error: null });
      return; // Let the page open its own existing login form.
    }
    event.preventDefault(); event.stopImmediatePropagation();
    pageSession.requestAccount();
  };
  const pageSubmit = (event: Event) => {
    if (!nativeForm || event.target !== nativeForm) return;
    event.preventDefault(); event.stopImmediatePropagation();
    notifyPageAccountActivity();
    if (pageSession.getSnapshot().busy) return;
    const identifier = nativeForm.querySelector<HTMLInputElement>("#siteLoginIdentifier");
    const pin = nativeForm.querySelector<HTMLInputElement>("#siteLoginPin");
    if (!identifier || !pin || !nativeForm.reportValidity()) return;
    // Direct callback only: credentials never enter conversation messages or public events.
    void pageSession.login(identifier.value.trim(), pin.value).finally(() => { pin.value = ""; });
  };
  const pageActivity = (event: Event) => {
    if (event.target instanceof Node && nativeForm?.contains(event.target)) notifyPageAccountActivity();
    if (hasNativeLogin && event instanceof KeyboardEvent && event.key === "Escape") pageSession.close();
  };
  document.addEventListener("click", pageClick, true);
  document.addEventListener("submit", pageSubmit, true);
  document.addEventListener("input", pageActivity, true);
  document.addEventListener("keydown", pageActivity, true);
  renderAccount();
  app.render(React.createElement(Concierge, { initialLang: window.VoxiConfig?.lang ?? "en", initialOpen: window.VoxiConfig?.open ?? false }));
  window.Voxi = {
    open: () => window.dispatchEvent(new CustomEvent("voxi:open")),
    login: () => window.dispatchEvent(new CustomEvent("voxi:login")),
    logout: () => window.dispatchEvent(new CustomEvent("voxi:logout")),
    profile: () => window.dispatchEvent(new CustomEvent("voxi:profile")),
    unmount: () => {
      document.removeEventListener("click", pageClick, true);
      document.removeEventListener("submit", pageSubmit, true);
      document.removeEventListener("input", pageActivity, true);
      document.removeEventListener("keydown", pageActivity, true);
      unsubscribeAccount(); pageSession.presentWith(null);
      closeNativeLogin(); accountApp.unmount(); accountHost.remove();
      app.unmount();
      host.remove();
    },
  };
}

declare global {
  interface Window {
    Voxi?: { open: () => void; login: () => void; logout: () => void; profile: () => void; unmount: () => void };
  }
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
else mount();
