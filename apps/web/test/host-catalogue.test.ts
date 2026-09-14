import { describe, expect, it, vi } from "vitest";
import { mountHostCatalogue } from "../src/lib/host-catalogue";

class Option {
  selected = false;
  constructor(public value = "", public textContent = "") {}
}
class Select extends EventTarget {
  tagName = "SELECT";
  observers = new Set<() => void>();
  writes = 0;
  constructor(public options: Option[]) { super(); this.options[0]!.selected = true; }
  get value() { return this.options.find((option) => option.selected)?.value ?? ""; }
  set value(value: string) { let chosen = false; for (const option of this.options) { option.selected = !chosen && option.value === value; chosen ||= option.selected; } }
  replaceChildren(...options: Option[]) {
    this.options = options;
    if (!options.some((option) => option.selected) && options[0]) options[0].selected = true;
    this.writes++;
    for (const notify of this.observers) notify();
  }
}
function fixture() {
  const deliveries = { count: 0 };
  class Observer {
    private target?: Select;
    private queued = false;
    constructor(private callback: () => void) {}
    private notify = () => {
      if (this.queued) return;
      this.queued = true;
      queueMicrotask(() => {
        if (!this.queued) return;
        this.queued = false;
        if (++deliveries.count > 20) throw new Error("Observer reconciliation loop");
        this.callback();
      });
    };
    observe(target: Select) { this.target = target; target.observers.add(this.notify); }
    disconnect() { this.target?.observers.delete(this.notify); this.target = undefined; this.queued = false; }
  }
  const cinemas = new Select([new Option("", "Select Cinema"), new Option("Mall of the Emirates", "Mall of the Emirates"), new Option("Legacy cinema", "Legacy cinema")]);
  const films = new Select([new Option("", "Any Movie"), new Option("The Odyssey", "The Odyssey (English)")]);
  const elements: Record<string, Select> = { "#cinemaSelect": cinemas, "#movieSelect": films };
  const document = { querySelector: (selector: string) => elements[selector] ?? null, createElement: () => new Option(), defaultView: { MutationObserver: Observer } } as unknown as Document;
  return { document, cinemas, films, elements, deliveries };
}
const settleMutations = async () => { for (let index = 0; index < 5; index++) await Promise.resolve(); };
const payloads = {
  cinemas: { cinemas: [{ cinemaId: "0001", name: "Mall of the Emirates" }, { cinemaId: "0023", name: "City Centre Meaisem", nameAlt: "سيتي سنتر معيصم" }] },
  films: { films: [{ hoCode: "new-film-id", title: "Red Flag", language: "Arabic", status: "now_showing" }, { hoCode: "other-film-id", title: "Runner", language: "Tamil", status: "now_showing" }, { title: "Later film", status: "coming_soon" }] },
};
const success = () => vi.fn(async (url: string | URL | Request) => new Response(JSON.stringify(String(url).endsWith("/cinemas") ? payloads.cinemas : payloads.films))) as unknown as ReturnType<typeof vi.fn> & typeof fetch;
const mount = (document: Document, fetcher: typeof fetch, hostname = "voxi.kris-pradip.workers.dev") => mountHostCatalogue({ document, hostname, apiBase: "https://catalogue.example.test/", fetcher });

describe("known-host catalogue options", () => {
  it("never fetches or changes any other hostname, including lookalike suffixes", async () => {
    const f = fixture(); const fetcher = success();
    for (const hostname of ["localhost", "voxi-demo.up.railway.app", "voxi.kris-pradip.workers.dev.example.test"]) await mount(f.document, fetcher, hostname).ready;
    expect(fetcher).not.toHaveBeenCalled();
    expect(f.cinemas.options).toHaveLength(3);
  });
  it("adds current Meaisem and films with host-compatible name/title values, not backend IDs", async () => {
    const f = fixture(); const fetcher = success(); const active = mount(f.document, fetcher); await active.ready;
    expect(f.cinemas.options.map((option) => option.value)).toEqual(["", "Mall of the Emirates", "City Centre Meaisem"]);
    expect(f.films.options.map((option) => [option.value, option.textContent])).toEqual([["", "Any Movie"], ["Red Flag", "Red Flag (Arabic)"], ["Runner", "Runner (Tamil)"]]);
    expect(f.cinemas.value).toBe("");
    expect(fetcher).toHaveBeenCalledWith("https://catalogue.example.test/demo/cinemas", expect.objectContaining({ credentials: "omit", signal: expect.any(AbortSignal) }));
    active.dispose();
  });
  it("preserves selected current and legacy values, including selections changed during a delayed fetch", async () => {
    const f = fixture(); let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; }); const read = success();
    const active = mount(f.document, (async (...args: Parameters<typeof fetch>) => { await gate; return read(...args); }) as typeof fetch);
    f.cinemas.value = "Legacy cinema"; f.films.value = "The Odyssey";
    release(); await active.ready;
    expect(f.cinemas.value).toBe("Legacy cinema"); expect(f.films.value).toBe("The Odyssey");
    expect(f.cinemas.options.some((option) => option.value === "City Centre Meaisem")).toBe(true);
    active.dispose();
    f.cinemas.value = "Mall of the Emirates";
    const again = mount(f.document, success()); await again.ready;
    expect(f.cinemas.value).toBe("Mall of the Emirates");
    expect(f.cinemas.options.filter((option) => option.value === "Mall of the Emirates")).toHaveLength(1);
    again.dispose();
  });
  it.each(["network", "http", "invalid", "empty"])("retains existing options on %s failure", async (kind) => {
    const f = fixture(); f.cinemas.value = "Legacy cinema";
    const before = f.cinemas.options;
    const fetcher = vi.fn(async () => { if (kind === "network") throw new Error("offline"); return kind === "http" ? new Response("no", { status: 503 }) : kind === "invalid" ? new Response("not json") : new Response(JSON.stringify({ cinemas: [], films: [] })); });
    const active = mount(f.document, fetcher); await active.ready;
    expect(f.cinemas.options).toBe(before); expect(f.cinemas.value).toBe("Legacy cinema"); active.dispose();
  });
  it("mounts once, keeps host elements/handlers, and emits no change or click during refresh", async () => {
    const f = fixture(); const fetcher = success(); const onChange = vi.fn(); const onClick = vi.fn();
    f.cinemas.addEventListener("change", onChange); f.films.addEventListener("click", onClick);
    const active = mount(f.document, fetcher); expect(mount(f.document, fetcher)).toBe(active); await active.ready;
    expect(fetcher).toHaveBeenCalledTimes(2); expect(onChange).not.toHaveBeenCalled(); expect(onClick).not.toHaveBeenCalled();
    expect(f.elements["#cinemaSelect"]).toBe(f.cinemas);
    f.cinemas.dispatchEvent(new Event("change")); f.films.dispatchEvent(new Event("click"));
    expect(onChange).toHaveBeenCalledTimes(1); expect(onClick).toHaveBeenCalledTimes(1); active.dispose();
  });
  it("ignores late responses after unmount or host element replacement", async () => {
    const f = fixture(); let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; }); const read = success();
    const active = mount(f.document, (async (...args: Parameters<typeof fetch>) => { await gate; return read(...args); }) as typeof fetch);
    const before = f.cinemas.options; active.dispose(); release(); await active.ready; expect(f.cinemas.options).toBe(before);
    const g = fixture(); const next = mount(g.document, success());
    delete g.elements["#cinemaSelect"]; await next.ready; expect(g.cinemas.options).toHaveLength(3); next.dispose();
  });
  it("reconciles late host population from cached data without observer loops, duplicate handlers or extra fetches", async () => {
    const f = fixture(); const fetcher = success(); const onChange = vi.fn();
    f.cinemas.addEventListener("change", onChange);
    const active = mount(f.document, fetcher); await active.ready;
    expect(mount(f.document, fetcher)).toBe(active);
    expect(f.deliveries.count).toBe(0);
    for (let index = 0; index < 2; index++) {
      f.cinemas.replaceChildren(new Option("", "Select Cinema"), new Option("Mall of the Emirates", "Mall of the Emirates"));
      f.films.replaceChildren(new Option("", "Any Movie"), new Option("The Odyssey", "The Odyssey (English)"));
      await settleMutations();
      expect(f.cinemas.options.map((option) => option.value)).toEqual(["", "Mall of the Emirates", "City Centre Meaisem"]);
      expect(f.films.options.map((option) => option.value)).toEqual(["", "Red Flag", "Runner"]);
    }
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(f.deliveries.count).toBe(4);
    expect(f.cinemas.writes).toBe(5); // One initial write, two host writes, two reconciliations.
    expect(f.films.writes).toBe(5);
    expect(onChange).not.toHaveBeenCalled();
    f.cinemas.value = "City Centre Meaisem"; f.cinemas.dispatchEvent(new Event("change"));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(f.elements["#cinemaSelect"]).toBe(f.cinemas);
    active.dispose();
  });
  it("retains selected current and legacy options removed by a host refresh, but respects a customer's later clear", async () => {
    const f = fixture(); f.films.value = "The Odyssey";
    const active = mount(f.document, success()); await active.ready;
    f.cinemas.value = "City Centre Meaisem"; f.cinemas.dispatchEvent(new Event("input"));
    f.cinemas.replaceChildren(new Option("", "Select Cinema"));
    f.films.replaceChildren(new Option("", "Any Movie"));
    await settleMutations();
    expect(f.cinemas.value).toBe("City Centre Meaisem");
    expect(f.films.value).toBe("The Odyssey");
    expect(f.films.options.find((option) => option.value === "The Odyssey")?.textContent).toBe("The Odyssey (English)");
    f.films.value = ""; f.films.dispatchEvent(new Event("change"));
    f.films.replaceChildren(new Option("", "Any Movie"), new Option("Old film", "Old film"));
    await settleMutations();
    expect(f.films.value).toBe("");
    expect(f.films.options.some((option) => option.value === "The Odyssey")).toBe(false);
    active.dispose();
  });
  it("does not rewrite an already matching population and disconnects observers/listeners on disposal", async () => {
    const f = fixture(); const remove = vi.spyOn(f.cinemas, "removeEventListener");
    const active = mount(f.document, success()); await active.ready;
    f.cinemas.replaceChildren(...f.cinemas.options);
    await settleMutations();
    expect(f.cinemas.writes).toBe(2); // Initial refresh and the host's equivalent write only.
    expect(f.deliveries.count).toBe(1);
    f.cinemas.replaceChildren(new Option("", "Late placeholder"));
    active.dispose();
    await settleMutations();
    expect(f.cinemas.options.map((option) => option.textContent)).toEqual(["Late placeholder"]);
    expect(f.cinemas.observers.size).toBe(0); expect(f.films.observers.size).toBe(0);
    expect(remove.mock.calls.map(([name]) => name)).toEqual(["change", "input"]);
    const again = mount(f.document, success()); await again.ready;
    expect(f.cinemas.observers.size).toBe(1); expect(f.films.observers.size).toBe(1);
    again.dispose();
  });
  it("stops observing a detached select without modifying its replacement", async () => {
    const f = fixture(); const active = mount(f.document, success()); await active.ready;
    const replacement = new Select([new Option("", "Host replacement")]);
    f.elements["#cinemaSelect"] = replacement;
    f.cinemas.replaceChildren(new Option("", "Detached"));
    await settleMutations();
    expect(f.cinemas.observers.size).toBe(0);
    expect(f.cinemas.options.map((option) => option.textContent)).toEqual(["Detached"]);
    expect(replacement.options.map((option) => option.textContent)).toEqual(["Host replacement"]);
    active.dispose();
  });
});
