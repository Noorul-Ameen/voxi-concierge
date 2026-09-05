// Drive the widget through the dev bridge and screenshot every card type (no ElevenLabs needed).
import { chromium } from "playwright";
const base = process.env.WEB_URL ?? "http://127.0.0.1:5173";
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium",
});
const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
await page.goto(`${base}/?dev=1`, { waitUntil: "networkidle" });
await page.click(".widget .iconbtn"); // expand
const run = async (name, input) => {
  await page.fill('[data-testid="devpanel"] input >> nth=0', name);
  await page.fill('[data-testid="devpanel"] input >> nth=1', JSON.stringify(input));
  await page.click('[data-testid="devpanel"] button');
  await page.waitForTimeout(1800);
};
await run("search_films", { query: "spider" });
await run("search_sessions", { title: "spider-man", cinemaName: "MOE", dateTo: "2099-01-01", limit: 12 });
await page.screenshot({ path: "/tmp/cards-1.png" });
await run("nearest_cinemas", {});
await run("list_offers", { experience: "MAX", limit: 3 });
await page.screenshot({ path: "/tmp/cards-2.png" });
await run("login_customer", { phone: "0501234567", pin: "1234" });
await run("find_booking", { bookingId: "WXA7K2M" });
await run("browse_menu", { tab: "Combos", limit: 3 });
await page.screenshot({ path: "/tmp/cards-3.png" });
// guided booking to seat map + payment
await run("search_sessions", {
  cinemaName: "Mirdif",
  experience: "Standard",
  dateTo: "2099-01-01",
  limit: 40,
});
const key = await page.evaluate(() => {
  const b = [...document.querySelectorAll(".time")].find((x) => !x.disabled);
  return b ? b.getAttribute("title") : null;
});
const sessions = await page.evaluate(async () => {
  const r = await fetch("/api/demo/films");
  return r.ok;
});
console.log("sessions api ok", sessions, "first time btn", key);
await browser.close();
