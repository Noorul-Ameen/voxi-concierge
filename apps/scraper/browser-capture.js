// Runs inside uae.voxcinemas.com (same-origin fetches). Mirrors apps/scraper/src/parse.ts.
window.__cap = { status: "running", log: [], films: [], sessions: [], cinemaNames: {}, done: 0, total: 0 };
(async () => {
  const C = window.__cap;
  const txt = (s) => (s ?? "").replace(/\s+/g, " ").trim();
  const get = async (p) => {
    for (let i = 0; i < 3; i++) {
      const r = await fetch(p, { headers: { accept: "text/html" }, credentials: "same-origin" });
      if (r.ok) return r.text();
      await new Promise((x) => setTimeout(x, 800 * (i + 1)));
    }
    throw new Error(`GET ${p}`);
  };
  const dom = (html) => new DOMParser().parseFromString(html, "text/html");
  const parseMovieList = (html) => {
    const d = dom(html);
    const out = new Map();
    for (const a of d.querySelectorAll('a[href^="/movies/"]')) {
      const href = (a.getAttribute("href") || "").split("#")[0];
      if (/whatson|comingsoon|advance/.test(href) || href === "/movies/") continue;
      const card = a.closest("li, article, div") || a;
      const img = card.querySelector("img");
      const src = (img && (img.getAttribute("src") || img.getAttribute("data-src"))) || "";
      const ho = (src.match(/HO\d{8}/) || [""])[0];
      const prev = out.get(href);
      out.set(href, {
        slug: href.replace("/movies/", ""),
        ho: ho || prev?.ho || "",
        title: txt(card.querySelector("h3")?.textContent) || prev?.title || "",
        rating: txt(card.querySelector(".classification")?.textContent) || prev?.rating || "",
        language:
          txt(card.querySelector(".language")?.textContent).replace(/^Language:\s*/i, "") ||
          prev?.language ||
          "",
      });
    }
    return [...out.values()];
  };
  const parseShowtimes = (html, dateStr) => {
    const d = dom(html);
    const rows = [];
    const container = d.querySelector("#showtimes .dates") || d.querySelector("#showtimes");
    if (!container) return rows;
    let cinema = "";
    for (const el of container.children) {
      const tag = el.tagName.toUpperCase();
      if (tag === "H3") {
        cinema = txt(el.textContent);
        continue;
      }
      if (tag === "OL" && el.classList.contains("showtimes")) {
        for (const li of el.children) {
          if (li.tagName !== "LI") continue;
          const exp = txt(li.querySelector(":scope > strong")?.textContent);
          for (const s of li.querySelectorAll("li[data-id]")) {
            const id = s.getAttribute("data-id") || "";
            const [cinemaId, sessionId] = id.split("-");
            if (!cinemaId || !sessionId) continue;
            const a = s.querySelector("a");
            rows.push({
              cinema,
              cinemaId,
              sessionId,
              experience: exp,
              time: txt(a?.textContent),
              date: dateStr,
              soldOut: /sold/i.test(`${s.getAttribute("class") || ""} ${a?.getAttribute("class") || ""}`),
            });
          }
        }
      }
    }
    return rows;
  };
  const parseMovieMeta = (html) => {
    const d = dom(html);
    let ld = {};
    for (const s of d.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const j = JSON.parse(s.textContent);
        if (j && j["@type"] === "Movie") ld = j;
      } catch {}
    }
    const aside = {};
    for (const p of d.querySelectorAll("aside p")) {
      const st = p.querySelector("strong");
      if (st) aside[txt(st.textContent).replace(/:$/, "")] = txt(p.textContent.replace(st.textContent, ""));
    }
    const yt = html.match(/youtube(?:-nocookie)?\.com\/embed\/([A-Za-z0-9_-]{6,})/)?.[1] ?? "";
    const dates = [
      ...new Set(
        [...d.querySelectorAll('#showtimes nav a[href*="d="]')]
          .map((a) => (a.getAttribute("href") || "").match(/d=(\d{8})/)?.[1] ?? "")
          .filter(Boolean),
      ),
    ];
    const actor = ld.actor || [];
    const director = ld.director;
    return {
      name: ld.name || "",
      duration: ld.duration || "",
      actors: actor.map((a) => a.name),
      genre: ld.genre || "",
      description: ld.description || "",
      inLanguage: ld.inLanguage || "",
      contentRating: ld.contentRating || "",
      aside,
      yt,
      poster: (html.match(/P_HO\d{8}/) || [""])[0],
      hero: (html.match(/B_HO\d{8}/) || [""])[0],
      dates,
      director: Array.isArray(director) ? director.map((x) => x.name).join(", ") : director?.name || "",
    };
  };
  const today = (() => {
    const d = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Dubai" }));
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  })();
  C.today = today;
  const lists = {
    now_showing: parseMovieList(await get("/movies/whatson")),
    coming_soon: await get("/movies/comingsoon").then(parseMovieList, () => []),
    advance: await get("/movies/advance").then(parseMovieList, () => []),
  };
  const seen = new Set();
  const items = [];
  for (const [status, arr] of Object.entries(lists))
    for (const m of arr) {
      if (seen.has(m.slug)) continue;
      seen.add(m.slug);
      items.push({ ...m, status });
    }
  C.total = items.length;
  const active = 0;
  const queue = [...items];
  const worker = async () => {
    while (queue.length) {
      const m = queue.shift();
      try {
        const html = await get(`/movies/${m.slug}`);
        const meta = parseMovieMeta(html);
        let rows = parseShowtimes(html, today);
        for (const dd of meta.dates)
          rows = rows.concat(parseShowtimes(await get(`/movies/${m.slug}?d=${dd}`), dd));
        const ho = m.ho || meta.poster.replace("P_", "");
        const { dates: _d, ...metaNoDates } = meta;
        C.films.push({ ...m, ho, meta: metaNoDates, sessionCount: rows.length });
        for (const r of rows) {
          C.cinemaNames[r.cinemaId] = r.cinema;
          C.sessions.push([ho, r.cinemaId, r.sessionId, r.experience, r.date, r.time, r.soldOut ? 1 : 0]);
        }
      } catch (e) {
        C.log.push(`${m.slug}: ${e.message}`);
      }
      C.done++;
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  C.status = "done";
})().catch((e) => {
  window.__cap.status = `error: ${e.message}`;
});
("started");
