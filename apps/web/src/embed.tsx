/**
 * Embeddable Voxi widget. Built as a single self-contained script (`dist/embed/voxi.js`) that any page can load:
 *
 *   <script src="https://voxi-demo.up.railway.app/embed/voxi.js" charset="utf-8" defer></script>
 *
 * Optional attributes on the script tag: data-lang="en|ar", data-open="true" (start expanded instead of as the
 * launcher pill), data-api="https://…/api" (defaults to the origin the script was loaded from + /api). Optional: window.VoxiConfig = { apiBase, lang } before the script.
 * The widget renders inside a Shadow DOM so the host page's CSS and the widget's CSS never interfere.
 * Exposes window.Voxi = { open(), login(), logout(), unmount() }.
 */
import React from "react";
import ReactDOM from "react-dom/client";
import { Concierge } from "./components/Concierge";
import type { Lang } from "./lib/api";
import css from "./styles.css?inline";

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
};

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
  // The app stylesheet scopes its variables on :root; inside a shadow tree the equivalent scope is :host.
  style.textContent = `${css.replace(/:root/g, ":host")}\n:host { all: initial; font-family: var(--font); color: var(--ink); }`;
  shadow.appendChild(style);
  const root = document.createElement("div");
  root.dir = window.VoxiConfig?.lang === "ar" ? "rtl" : "ltr";
  shadow.appendChild(root);
  const app = ReactDOM.createRoot(root);
  app.render(React.createElement(Concierge, { initialLang: window.VoxiConfig?.lang ?? "en", initialOpen: window.VoxiConfig?.open ?? false }));
  window.Voxi = {
    open: () => window.dispatchEvent(new CustomEvent("voxi:open")),
    login: () => window.dispatchEvent(new CustomEvent("voxi:login")),
    logout: () => window.dispatchEvent(new CustomEvent("voxi:logout")),
    unmount: () => {
      app.unmount();
      host.remove();
    },
  };
}

declare global {
  interface Window {
    Voxi?: { open: () => void; login: () => void; logout: () => void; unmount: () => void };
  }
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
else mount();
