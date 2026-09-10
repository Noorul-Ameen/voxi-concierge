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
import { configureApiBase, type Customer, type Lang } from "./lib/api";
import css from "./styles.css?inline";
import stateCss from "./concierge-state.css?inline";

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
  const closeHostLogin = () => { if (knownHost) document.querySelector<HTMLButtonElement>("#loginClose")?.click(); };
  const openAccount = (event: Event) => {
    if (!loginSelector) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    let matches = false;
    try { matches = !!target.closest(loginSelector) || (knownHost && event.type === "submit" && target.id === "siteLoginForm"); } catch { return; }
    if (!matches) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    closeHostLogin();
    window.dispatchEvent(new CustomEvent("voxi:login"));
  };
  const onAuth = (customer: Customer | null) => {
    if (!loginSelector) return;
    let button: Element | null = null;
    try { button = document.querySelector(loginSelector); } catch { return; }
    if (button) {
      const ar = window.VoxiConfig?.lang === "ar";
      button.textContent = customer ? customer.firstName : ar ? "تسجيل الدخول" : "Sign in";
      button.setAttribute("aria-label", customer ? ar ? "حسابك في فوكس" : "Your VOX profile" : ar ? "تسجيل الدخول" : "Sign in");
    }
  };
  if (loginSelector) {
    document.addEventListener("click", openAccount, true);
    document.addEventListener("submit", openAccount, true);
  }
  app.render(React.createElement(Concierge, { initialLang: window.VoxiConfig?.lang ?? "en", initialOpen: window.VoxiConfig?.open ?? false, onAuth }));
  window.Voxi = {
    open: () => window.dispatchEvent(new CustomEvent("voxi:open")),
    login: () => window.dispatchEvent(new CustomEvent("voxi:login")),
    logout: () => window.dispatchEvent(new CustomEvent("voxi:logout")),
    profile: () => window.dispatchEvent(new CustomEvent("voxi:profile")),
    unmount: () => {
      document.removeEventListener("click", openAccount, true);
      document.removeEventListener("submit", openAccount, true);
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
