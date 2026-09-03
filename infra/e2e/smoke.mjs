// Playwright smoke: demo page renders posters + widget; dashboard renders KPIs after seeding activity through the API.
import { chromium } from "playwright";
const base = process.env.WEB_URL ?? "http://127.0.0.1:5173";
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium",
});
const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
page.on("console", (m) => m.type() === "error" && console.log("console:", m.text()));
await page.goto(base, { waitUntil: "networkidle" });
await page.waitForSelector(".poster", { timeout: 15000 });
const posters = await page.locator(".poster").count();
await page.screenshot({ path: "/tmp/demo.png" });
await page.click("text=العربية");
await page.waitForTimeout(300);
const dir = await page.evaluate(() => document.documentElement.dir);
await page.screenshot({ path: "/tmp/demo-ar.png" });
await page.goto(`${base}/dashboard`, { waitUntil: "networkidle" });
await page.waitForSelector(".kpi", { timeout: 15000 });
const kpis = await page.locator(".kpi").count();
await page.screenshot({ path: "/tmp/dashboard.png", fullPage: true });
console.log(JSON.stringify({ posters, dir, kpis }));
await browser.close();
