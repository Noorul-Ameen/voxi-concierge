/**
 * Build the knowledge base (Markdown with frontmatter) from:
 *  - the captured VOX UAE web pages (FAQ, refunds, T&Cs, experiences, offers, app, contact…)
 *  - the seed dataset (cinema pages: hours, directions, parking, accessibility, experiences)
 *  - policy docs generated from packages/db catalog (age rules)
 * Output: packages/agent/kb/*.md — reviewed before separate candidate KB upload and seeded into kb_documents.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(here, "../kb");
const RAW = path.resolve(here, "../../../apps/scraper/out/vox-uae-kb-raw.json");
const SEED = path.resolve(here, "../../db/src/seed/data/vox-uae.json");

type Page = { title: string; md?: string; error?: string };
const PAGES: Record<string, { id: string; category: string; title?: string }> = {
  "/faq": { id: "faq", category: "faq", title: "Frequently asked questions" },
  "/refunds": {
    id: "refund-policy",
    category: "policy",
    title: "Refunds, cancellations and VOX credit policy",
  },
  "/terms-and-conditions": { id: "terms-and-conditions", category: "policy" },
  "/about": { id: "about-vox", category: "faq", title: "About VOX Cinemas" },
  "/contact-us": { id: "contact-customer-care", category: "faq", title: "Contact VOX Customer Care" },
  "/health-safety": { id: "health-safety", category: "faq" },
  "/ways-to-watch/summary": {
    id: "experiences-overview",
    category: "experiences",
    title: "Ways to watch — experiences overview",
  },
  "/ways-to-watch/imax": { id: "experience-imax", category: "experiences", title: "IMAX experience" },
  "/ways-to-watch/max": { id: "experience-max", category: "experiences", title: "MAX experience" },
  "/ways-to-watch/theatre": {
    id: "experience-theatre",
    category: "experiences",
    title: "THEATRE experience",
  },
  "/ways-to-watch/theatre-pods-in-imax": {
    id: "experience-theatre-pods",
    category: "experiences",
    title: "THEATRE PODS in IMAX",
  },
  "/ways-to-watch/premier": {
    id: "experience-premier",
    category: "experiences",
    title: "PREMIER experience",
  },
  "/ways-to-watch/gold": { id: "experience-gold", category: "experiences", title: "GOLD experience" },
  "/ways-to-watch/kids": { id: "experience-kids", category: "experiences", title: "KIDS experience" },
  "/ways-to-watch/moonlight": {
    id: "experience-moonlight",
    category: "experiences",
    title: "VOX Moonlight outdoor cinema",
  },
  "/ways-to-watch/private-cinemas": {
    id: "experience-private-cinemas",
    category: "experiences",
    title: "Private cinemas",
  },
  "/ways-to-watch/4dx": { id: "experience-4dx", category: "experiences", title: "4DX experience" },
  "/ticket-offer/summary": {
    id: "offers-and-bank-offers",
    category: "offers",
    title: "Promotions and bank offers",
  },
  "/food-and-drinks": { id: "food-and-drinks-online", category: "faq", title: "Order food & drinks online" },
  "/vox-eats": { id: "vox-eats", category: "faq", title: "VOX EATS delivery" },
  "/vox-cinemas-app": { id: "vox-app", category: "how_to", title: "VOX Cinemas mobile app" },
  "/corporate-events": {
    id: "corporate-events",
    category: "faq",
    title: "Groups, corporate events and private screenings",
  },
  "/movie-genres": { id: "movie-genres", category: "faq" },
};

const clean = (md: string) =>
  md
    .replace(/^\s*MORE INFO\s*$/gm, "")
    .replace(/^#+\s*$/gm, "")
    .replace(/\*\*\*\*/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const fm = (o: Record<string, string>) =>
  `---\n${Object.entries(o)
    .map(([k, v]) => `${k}: "${v.replace(/"/g, "'")}"`)
    .join("\n")}\n---\n`;

async function main() {
  await mkdir(OUT, { recursive: true });
  const raw = JSON.parse(await readFile(RAW, "utf8")) as Record<string, Page>;
  const seed = JSON.parse(await readFile(SEED, "utf8")) as {
    cinemas: any[];
    films: any[];
    experiences: string[];
  };
  // These reviewed sources contain the approved demo policy and must not be replaced by an older scrape.
  const curated = new Set([
    "refund-policy",
    "checkout-payments-and-receipts",
    "how-to-book-and-manage",
    "terms-and-conditions",
    "faq",
    "offers-and-bank-offers",
  ]);
  let n = 0;
  for (const [route, meta] of Object.entries(PAGES)) {
    if (curated.has(meta.id)) continue;
    const p = raw[route];
    if (!p?.md) continue;
    const title = meta.title ?? p.title;
    const body = clean(p.md).replace(/^# .*\n/, "");
    await writeFile(
      path.join(OUT, `${meta.id}.md`),
      `${fm({ title, language: "en", category: meta.category, source: `https://uae.voxcinemas.com${route}` })}\n# ${title}\n\n${body}\n`,
    );
    n++;
  }
  // ---- cinema pages ----
  const DAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const catalog = await import("../../db/src/seed/catalog.js");
  for (const c of seed.cinemas) {
    const extra = catalog.CINEMA_EXTRAS[c.id] ?? catalog.DEFAULT_EXTRA(c.cinemaLocation, c.parkingInfo);
    const late = c.experiences.includes("MAX") || c.experiences.includes("IMAX");
    const hours = [0, 1, 2, 3, 4, 5, 6]
      .map(
        (d) =>
          `- ${DAY[d]}: 10:00 – ${late || d === 4 || d === 5 ? "02:00" : "01:00"} (last show starts before closing)`,
      )
      .join("\n");
    const body = `# VOX Cinemas ${c.name} (${c.emirate})

Arabic name: ${c.nameAlt}
Cinema ID: ${c.id}
Address: ${c.address1}${c.address1.includes("UAE") ? "" : ", UAE"}
Website: ${c.websiteUrl}
Map coordinates: ${c.latitude}, ${c.longitude}

## Experiences available
${c.experiences.map((e: string) => `- ${e}`).join("\n")}

## Opening hours
${hours}

## Where the cinema is inside the mall
${extra.directions}
${c.cinemaLocation ? `Cinema location: ${c.cinemaLocation}.` : ""}

## Best parking
${c.parkingInfo ? `Nearest parking: ${c.parkingInfo}.` : extra.parking}

## Accessibility
${extra.accessibility}

## About
${c.description || `VOX Cinemas at ${c.mallName}.`}

## Contact
VOX Customer Care: 600 599 905 (UAE), customercare@voxcinemas.com. Ticket collection: scan the QR code from your email or app at the entrance; kiosks are available in the foyer.
`;
    await writeFile(
      path.join(OUT, `cinema-${c.slug}.md`),
      `${fm({ title: `VOX Cinemas ${c.name} — location, hours, parking, accessibility`, language: "en", category: "in_mall", source: c.websiteUrl })}\n${body}`,
    );
    n++;
  }
  // ---- age restrictions (from catalog) ----
  const age = `# Age restrictions and movie ratings (UAE)

Ratings are set by the UAE Media Regulatory Office. It is against the law for underage guests to enter restricted movies, even with their parents; staff may ask for ID.

${catalog.AGE_RULES.map((r) => `- **${r.rating}** — ${r.text}`).join("\n")}

## Experience-specific age rules
${Object.entries(catalog.EXPERIENCE_AGE_RULES)
  .map(([k, v]) => `- **${k}** — ${v}`)
  .join("\n")}

## Quick answers
- Can a 10-year-old watch a PG13 movie? Yes, if accompanied by someone aged 13 or older; parents decide if the content is suitable.
- Can a 16-year-old watch an 18+ movie with a parent? No. 18+ means nobody under 18 is admitted, even with parents.
- Are babies allowed? Not in 15+, 18+ or 21+ movies. In G/PG/PG13/PG15 sessions, infants are welcome but need a ticket if they occupy a seat; KIDS screens have booster seats.
- Is GOLD adults only? GOLD is 18+ except at Mall of the Emirates, City Centre Mirdif and Yas Mall, where children 8+ may attend with an adult. THEATRE is 18+ everywhere.
`;
  await writeFile(
    path.join(OUT, "age-restrictions.md"),
    `${fm({ title: "Age restrictions and movie ratings", language: "en", category: "age_restrictions", source: "https://uae.voxcinemas.com/faq" })}\n${age}`,
  );
  // how-to-book-and-manage.md is a reviewed source, not a generated scrape/template.
  // ---- Arabic glossary ----
  const glossary = `# مصطلحات فوكس سينما — Arabic glossary for Voxi

| English | العربية |
|---|---|
| VOX Cinemas | فوكس سينما |
| Voxi (the concierge) | فوكسي |
| SHARE / Share Points | شير / نقاط شير |
| VOX credit / VOX Rewards wallet | رصيد فوكس / محفظة فوكس |
| Booking reference | الرقم المرجعي للحجز |
| Showtime | موعد العرض |
| Seat map | خريطة المقاعد |
| Premium view seats | مقاعد بريميوم فيو |
| Standard | ستاندرد |
| MAX | ماكس |
| IMAX | آيماكس |
| GOLD (with waiter service) | غولد (مع خدمة النادل) |
| THEATRE | ثياتر |
| KIDS | كيدز |
| 4DX (motion seats) | 4DX (مقاعد متحركة) |
| Premier | بريمير |
| Couch (2-seater sofa) | كاوتش (أريكة لشخصين) |
| Private cinema | سينما خاصة |
| Refund | استرداد |
| Cancellation cut-off (30 minutes) | مهلة الإلغاء (30 دقيقة) |
| Swap a showtime | تبديل الموعد |
| Food & drinks / concessions | المأكولات والمشروبات |
| Combo | كومبو |
| Popcorn | فشار |
| Bank offer / Buy one get one | عرض البنك / اشترِ واحدة واحصل على الثانية مجاناً |
| Promo code | رمز العرض |
| Age rating | التصنيف العمري |
| Customer care agent | موظف خدمة العملاء |
| Mall of the Emirates | مول الإمارات |
| City Centre Deira | سيتي سنتر ديرة |
| City Centre Mirdif | سيتي سنتر مردف |
| Yas Mall | ياس مول |
| The Galleria Al Maryah Island | الغاليريا جزيرة المارية |
`;
  await writeFile(
    path.join(OUT, "arabic-glossary.md"),
    `${fm({ title: "Arabic glossary of VOX terms", language: "ar", category: "faq", source: "" })}\n${glossary}`,
  );
  console.log(`wrote ${n + 2} KB documents to ${OUT}`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
