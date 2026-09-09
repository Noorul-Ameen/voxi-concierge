const fs = require("node:fs");
const wrapped = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
let text = wrapped[0].text;
const cut = text.indexOf("\n\n(captured at origin");
if (cut > 0) text = text.slice(0, cut);
text = text.trim();
let cap = JSON.parse(text);
if (typeof cap === "string") cap = JSON.parse(cap);
const sessMap = JSON.parse(cap.sess);
const sessions = [];
for (const [ho, byCin] of Object.entries(sessMap))
  for (const [cid, byDate] of Object.entries(byCin))
    for (const [date, byExp] of Object.entries(byDate))
      for (const [exp, list] of Object.entries(byExp))
        for (const s of list) {
          const so = s.endsWith("!");
          const [time, sid] = s.replace(/!$/, "").split("@");
          if (!time) continue; // private cinema sessions without a time
          sessions.push([ho, cid, sid, exp, date, time, so ? 1 : 0]);
        }
const old = JSON.parse(fs.readFileSync("apps/scraper/out/vox-uae-raw.json", "utf8"));
const raw = {
  films: cap.films.map((f) => ({
    slug: f.slug,
    ho: f.ho,
    title: f.title,
    rating: f.rating,
    language: f.language,
    status: f.status,
    meta: f.meta,
    sessionCount: f.sessionCount,
  })),
  sessions,
  cinemaNames: { ...old.cinemaNames, ...cap.names },
  cinemas: old.cinemas,
};
fs.writeFileSync("apps/scraper/out/vox-uae-raw.json", JSON.stringify(raw));
fs.writeFileSync(process.argv[3], cap.capturedAt);
console.log(
  "films",
  raw.films.length,
  "sessions",
  sessions.length,
  "capturedAt",
  cap.capturedAt,
  "dates",
  [...new Set(sessions.map((s) => s[4]))].sort().join(","),
);
