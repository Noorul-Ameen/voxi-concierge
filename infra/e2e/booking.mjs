// Full guided booking through the UI: order → seat map click → payment sheet → QR ticket.
import { chromium } from "playwright";
const base = process.env.WEB_URL ?? "http://127.0.0.1:5173";
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium",
});
const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
await page.goto(`${base}/?dev=1`, { waitUntil: "networkidle" });
await page.click(".widget .iconbtn");
const run = async (name, input) => {
  await page.fill('[data-testid="devpanel"] input >> nth=0', name);
  await page.fill('[data-testid="devpanel"] input >> nth=1', JSON.stringify(input));
  await page.click('[data-testid="devpanel"] button');
  await page.waitForTimeout(2200);
};
await run("login_customer", { phone: "0501234567", pin: "1234" });
await run("search_sessions", {
  cinemaName: "Mirdif",
  experience: "Standard",
  dateTo: "2099-01-01",
  limit: 40,
});
// pick a session key from the rendered showtimes (data attr via title = screen name, so read from API instead)
const sessions = await page.evaluate(async () => {
  const s = JSON.parse(sessionStorage.getItem("voxi.debug") ?? "null");
  return s;
});
// use the tool output through the concierge directly for the key
const key = await page.evaluate(async () => {
  const r = await fetch("/api/widget/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  }).then((r) => r.json());
  const t = await fetch("/api/widget/dev-tool", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${r.token}` },
    body: JSON.stringify({
      name: "search_sessions",
      input: { cinemaName: "Mirdif", experience: "Standard", dateTo: "2099-01-01", limit: 60 },
    }),
  }).then((r) => r.json());
  const now = new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 19);
  return t.data.sessions.find((s) => s.seatsAvailable > 10 && s.showtime > now)?.sessionKey;
});
await run("start_order", { sessionKey: key });
const usid = await page.evaluate(() => {
  const m = [...document.querySelectorAll(".msg.agent")].map((x) => x.textContent);
  return m[m.length - 1];
});
console.log("start_order →", usid?.slice(0, 80));
// read userSessionId via the API (widget shows it in speech only) — call get_session_context
const ctx = await page.evaluate(async () => {
  const r = await fetch("/api/widget/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  }).then((r) => r.json());
  return r;
});
void ctx;
await run("add_tickets", { userSessionId: "__ACTIVE__", tickets: [{ ticketTypeCode: "STD0001", qty: 2 }] });
await run("get_seat_plan", { sessionKey: key, userSessionId: "__ACTIVE__" });
await page.screenshot({ path: "/tmp/book-1.png" });
// click two free adjacent seats in a row and confirm
const picked = await page.evaluate(() => {
  const rows = [...document.querySelectorAll(".seatmap .row")];
  for (const r of rows) {
    const free = [...r.querySelectorAll("button.seat")].filter(
      (b) => !b.disabled && !b.className.includes("mine") && !b.className.includes("gap"),
    );
    if (free.length >= 4) {
      free[1].click();
      free[2].click();
      return [free[1].title, free[2].title];
    }
  }
  return null;
});
console.log("picked", picked);
await page.click("text=/Confirm seats/");
await page.waitForTimeout(2500);
await run("add_concessions", {
  userSessionId: "__ACTIVE__",
  items: [{ itemId: "160", quantity: 1, modifierIds: ["COKEZ"] }],
});
await run("prepare_payment", { userSessionId: "__ACTIVE__", method: "CARD" });
await page.screenshot({ path: "/tmp/book-2.png" });
await page.fill(".sheet input >> nth=0", "4111 1111 1111 1111");
await page.click(".sheet .btn.primary");
await page.waitForSelector(".qr img", { timeout: 15000 });
await page.waitForTimeout(800);
await page.screenshot({ path: "/tmp/book-3.png" });
const ref = await page.evaluate(() => document.querySelector(".qr .ref")?.textContent);
console.log("booking ref", ref);
await browser.close();
