/** Only the existing linked demo uses title/name values in its own booking handlers. */
const LINKED_HOST = "vox.kris-pradip.workers.dev";
type Choice = { value: string; label: string };
type CatalogueMount = { ready: Promise<void>; dispose: () => void };
const mounts = new WeakMap<Document, CatalogueMount>();
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

function choices(payload: unknown, kind: "cinemas" | "films"): Choice[] {
  if (!payload || typeof payload !== "object") return [];
  const rows = (payload as Record<string, unknown>)[kind];
  if (!Array.isArray(rows)) return [];
  const result: Choice[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const value = kind === "cinemas" ? row.name : row.title;
    if (!text(value) || (kind === "films" && row.status && row.status !== "now_showing")) continue;
    const label = kind === "films" && text(row.language) ? `${value} (${row.language})` : value;
    const key = `${value}\u0000${label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ value, label });
  }
  return result;
}

function selectedChoice(select: HTMLSelectElement): Choice {
  const option = Array.from(select.options).find((item) => item.selected);
  return { value: select.value, label: option?.textContent ?? select.value };
}

function updateOptions(document: Document, select: HTMLSelectElement, values: Choice[], selection: Choice, placeholder: HTMLOptionElement[]) {
  const previous = Array.from(select.options);
  const selectedLegacy = selection.value && !values.some((choice) => choice.value === selection.value)
    ? [selection]
    : [];
  const desired = [...placeholder.map((option) => ({ value: option.value, label: option.textContent ?? "" })), ...selectedLegacy, ...values];
  // Idempotence also protects against a queued observer callback after our own reconciliation.
  if (previous.length === desired.length && previous.every((option, index) => option.value === desired[index]!.value && option.textContent === desired[index]!.label)) {
    if (select.value !== selection.value) select.value = selection.value;
    return;
  }
  const options = [...selectedLegacy, ...values].map((choice) => {
    const legacy = selectedLegacy.includes(choice) && previous.find((option) => option.value === choice.value);
    if (legacy) return legacy;
    const option = document.createElement("option");
    // Public names/titles, not IDs: the host's existing handler consumes select.value.
    option.value = choice.value;
    option.textContent = choice.label;
    return option;
  });
  // Retain the select node itself and do not emit change/click events or replace host handlers.
  select.replaceChildren(...placeholder, ...options);
  select.value = selection.value;
}

/** Refresh the known host's options only. No account/session data or booking commands are used. */
export function mountHostCatalogue({ document, hostname, apiBase, fetcher = fetch }: {
  document: Document;
  hostname: string;
  apiBase: string;
  fetcher?: typeof fetch;
}): CatalogueMount {
  if (hostname !== LINKED_HOST) return { ready: Promise.resolve(), dispose: () => undefined };
  const existing = mounts.get(document);
  if (existing) return existing;
  const controller = new AbortController();
  let disposed = false;
  const cleanups: Array<() => void> = [];
  const refresh = async (selector: string, kind: "cinemas" | "films") => {
    const select = document.querySelector<HTMLSelectElement>(selector);
    if (!select || select.tagName !== "SELECT") return;
    let selection = selectedChoice(select);
    let customerChangedSelection = false;
    let placeholders = Array.from(select.options).filter((option) => option.value === "");
    const rememberSelection = () => {
      selection = selectedChoice(select);
      customerChangedSelection = true;
    };
    // Observe choices without dispatching events or replacing the host's listeners.
    select.addEventListener("change", rememberSelection);
    select.addEventListener("input", rememberSelection);
    let observer: MutationObserver | undefined;
    cleanups.push(() => {
      observer?.disconnect();
      select.removeEventListener("change", rememberSelection);
      select.removeEventListener("input", rememberSelection);
    });
    try {
      const response = await fetcher(`${apiBase.replace(/\/$/, "")}/demo/${kind}`, {
        signal: controller.signal,
        credentials: "omit",
      });
      if (!response.ok) return;
      const values = choices(await response.json(), kind);
      if (disposed || controller.signal.aborted || document.querySelector(selector) !== select || !values.length) return;
      // Include a selection made while fetching, even if the host changed it without an event.
      const current = selectedChoice(select);
      if (!customerChangedSelection && (current.value || !selection.value)) selection = current;
      const reconcile = () => {
        if (disposed || controller.signal.aborted || document.querySelector(selector) !== select) {
          observer?.disconnect();
          return;
        }
        const currentPlaceholders = Array.from(select.options).filter((option) => option.value === "");
        if (currentPlaceholders.length) placeholders = currentPlaceholders;
        // The host populates these selects asynchronously. Reuse the fetched catalogue only.
        // Disconnect around our writes so they never schedule another observer delivery.
        observer?.disconnect();
        updateOptions(document, select, values, selection, placeholders);
        observer?.observe(select, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["value", "label"] });
      };
      const Observer = document.defaultView?.MutationObserver;
      if (Observer) observer = new Observer(reconcile);
      reconcile();
    } catch {
      // The host remains usable during network/catalogue errors; existing options are untouched.
    }
  };
  const mount: CatalogueMount = {
    ready: Promise.all([refresh("#cinemaSelect", "cinemas"), refresh("#movieSelect", "films")]).then(() => undefined),
    dispose: () => {
      disposed = true;
      controller.abort();
      for (const cleanup of cleanups) cleanup();
      if (mounts.get(document) === mount) mounts.delete(document);
    },
  };
  mounts.set(document, mount);
  return mount;
}
