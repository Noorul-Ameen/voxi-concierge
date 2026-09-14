/** Only the existing linked demo uses title/name values in its own booking handlers. */
const LINKED_HOST = "voxi.kris-pradip.workers.dev";
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

function updateOptions(document: Document, select: HTMLSelectElement, values: Choice[]) {
  // Read at completion, so a choice made while the request was in flight is also retained.
  const selectedValue = select.value;
  const previous = Array.from(select.options);
  const placeholder = previous.filter((option) => option.value === "");
  const selectedLegacy = selectedValue && !values.some((choice) => choice.value === selectedValue)
    ? previous.filter((option) => option.selected && option.value === selectedValue)
    : [];
  const options = values.map((choice) => {
    const option = document.createElement("option");
    // Public names/titles, not IDs: the host's existing handler consumes select.value.
    option.value = choice.value;
    option.textContent = choice.label;
    return option;
  });
  // Retain the select node itself and do not emit change/click events or replace host handlers.
  select.replaceChildren(...placeholder, ...selectedLegacy, ...options);
  select.value = selectedValue;
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
  const refresh = async (selector: string, kind: "cinemas" | "films") => {
    const select = document.querySelector<HTMLSelectElement>(selector);
    if (!select || select.tagName !== "SELECT") return;
    try {
      const response = await fetcher(`${apiBase.replace(/\/$/, "")}/demo/${kind}`, {
        signal: controller.signal,
        credentials: "omit",
      });
      if (!response.ok) return;
      const values = choices(await response.json(), kind);
      if (disposed || controller.signal.aborted || document.querySelector(selector) !== select || !values.length) return;
      updateOptions(document, select, values);
    } catch {
      // The host remains usable during network/catalogue errors; existing options are untouched.
    }
  };
  const mount: CatalogueMount = {
    ready: Promise.all([refresh("#cinemaSelect", "cinemas"), refresh("#movieSelect", "films")]).then(() => undefined),
    dispose: () => {
      disposed = true;
      controller.abort();
      if (mounts.get(document) === mount) mounts.delete(document);
    },
  };
  mounts.set(document, mount);
  return mount;
}
