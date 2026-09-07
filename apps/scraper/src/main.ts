/**
 * VOX website scraper.
 *
 *   pnpm scrape                      # live scrape (needs network access to uae.voxcinemas.com)
 *   pnpm scrape --from-snapshot      # rebuild seed dataset from out/vox-uae-raw.json (frozen capture)
 *   pnpm scrape --site https://ksa.voxcinemas.com --market SA   # other markets share the same markup
 *
 * Output: packages/db/src/seed/data/vox-<market>.json (consumed by `pnpm db:seed`).
 *
 * When the scraper host is blocked by the site's bot protection (503/403), capture from a real browser instead:
 *   1. open https://uae.voxcinemas.com/movies/whatson and run `browser-capture.js` in the console (same-origin fetches);
 *   2. export `JSON.stringify({sess: __packed.sess, names: __cap.cinemaNames, films: __cap.films, capturedAt, today})`;
 *   3. `node merge-capture.cjs <export.json> capturedAt.txt` rebuilds out/vox-uae-raw.json (cinema pages are kept);
 *   4. `pnpm scrape --from-snapshot --captured-at "$(cat capturedAt.txt)"`, then re-apply any manual cinema fixes.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pLimit from "p-limit";
import { type RawCapture, normalize } from "./normalize.js";
import {
  type RawCinema,
  type RawFilm,
  parseCinemaPage,
  parseMovieList,
  parseMovieMeta,
  parseShowtimes,
} from "./parse.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]!;
  if (a.startsWith("--"))
    args.set(
      a.slice(2),
      process.argv[i + 1]?.startsWith("--") || process.argv[i + 1] === undefined
        ? "true"
        : process.argv[++i]!,
    );
}
const SITE = args.get("site") ?? "https://uae.voxcinemas.com";
const MARKET = (args.get("market") ?? "uae").toLowerCase();
const OUT_RAW = path.resolve(here, `../out/vox-${MARKET}-raw.json`);
const OUT_SEED = path.resolve(here, `../../../packages/db/src/seed/data/vox-${MARKET}.json`);

const UA = "Mozilla/5.0 (compatible; VoxiScraper/1.0; +internal MAF demo)";
async function get(pathname: string): Promise<string> {
  const res = await fetch(`${SITE}${pathname}`, { headers: { "user-agent": UA, accept: "text/html" } });
  if (!res.ok) throw new Error(`GET ${pathname} -> ${res.status}`);
  return res.text();
}

function todayYmd(): string {
  const d = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Dubai" }));
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

async function liveCapture(): Promise<RawCapture> {
  const lists = {
    now_showing: parseMovieList(await get("/movies/whatson")),
    coming_soon: await get("/movies/comingsoon").then(parseMovieList, () => []),
    advance: await get("/movies/advance").then(parseMovieList, () => []),
  } as const;
  const queue: (RawFilm["status"] extends infer S ? { status: S } : never)[] = [];
  const seen = new Set<string>();
  const items: {
    slug: string;
    ho: string;
    title: string;
    rating: string;
    language: string;
    status: RawFilm["status"];
  }[] = [];
  for (const [status, arr] of Object.entries(lists) as [
    RawFilm["status"],
    ReturnType<typeof parseMovieList>,
  ][]) {
    for (const m of arr) {
      if (seen.has(m.slug)) continue;
      seen.add(m.slug);
      items.push({ ...m, status });
    }
  }
  void queue;
  const limit = pLimit(4);
  const films: RawFilm[] = [];
  const sessions: RawCapture["sessions"] = [];
  const cinemaNames: Record<string, string> = {};
  const today = todayYmd();
  await Promise.all(
    items.map((m) =>
      limit(async () => {
        const html = await get(`/movies/${m.slug}`);
        const meta = parseMovieMeta(html);
        let rows = parseShowtimes(html, today);
        for (const d of meta.dates)
          rows = rows.concat(parseShowtimes(await get(`/movies/${m.slug}?d=${d}`), d));
        const ho = m.ho || meta.poster.replace("P_", "");
        const { dates: _d, ...metaNoDates } = meta;
        films.push({ ...m, ho, meta: metaNoDates, sessionCount: rows.length });
        for (const r of rows) {
          cinemaNames[r.cinemaId] = r.cinema;
          sessions.push([ho, r.cinemaId, r.sessionId, r.experience, r.date, r.time, r.soldOut ? 1 : 0]);
        }
        console.error(`✓ ${m.slug} (${rows.length} sessions)`);
      }),
    ),
  );
  const cinemasHtml = await get("/cinemas");
  const hrefs = [...new Set([...cinemasHtml.matchAll(/href="(\/cinemas\/[a-z0-9-]+)"/g)].map((x) => x[1]!))];
  const cinemas: RawCinema[] = [];
  for (const href of hrefs) cinemas.push(parseCinemaPage(href, await get(href)));
  return { films, sessions, cinemaNames, cinemas };
}

async function main() {
  let raw: RawCapture;
  if (args.get("from-snapshot") === "true") {
    raw = JSON.parse(await readFile(OUT_RAW, "utf8"));
    console.error(`loaded snapshot ${OUT_RAW}`);
  } else {
    raw = await liveCapture();
    await mkdir(path.dirname(OUT_RAW), { recursive: true });
    await writeFile(OUT_RAW, JSON.stringify(raw));
    console.error(`wrote ${OUT_RAW}`);
  }
  const seed = normalize(raw, args.get("captured-at") ?? new Date().toISOString());
  await mkdir(path.dirname(OUT_SEED), { recursive: true });
  await writeFile(OUT_SEED, JSON.stringify(seed, null, 1));
  console.error(
    `wrote ${OUT_SEED}: ${seed.cinemas.length} cinemas, ${seed.films.length} films, ${seed.sessions.length} sessions, experiences=${seed.experiences.join(",")}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
