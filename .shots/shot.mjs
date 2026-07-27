import puppeteer from "puppeteer-core";
import { writeFileSync } from "node:fs";

const EXE = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const URL = "http://localhost:5173/";
const OUT = "./.shots/";

// A realistic finished package, in the exact shape Studio persists/restores.
// Used to screenshot the "ready" state (+ drawer) without spending Groq quota.
const SESSION = {
  request: "Prep the Q4 board pack for Friday.",
  genRequest: "Prep the Q4 board pack for Friday.",
  clarify: null,
  clarifyAnswers: {},
  phase: "ready",
  plan: {
    packageName: "Board pack",
    packageTitle: "Q4 board review",
    reply: "On it. Assembling your Q4 board pack: a deck, summary, model, and action items.",
    assets: [
      { id: "a1", kind: "deck", title: "Q4 board presentation", summary: "14-slide review of Q4 results, the AI triage launch, and the decisions needed today." },
      { id: "a2", kind: "document", title: "Executive summary", summary: "One-page summary of Q4 performance and the board decisions requested." },
      { id: "a3", kind: "sheet", title: "Q4 financial model", summary: "Q4 actuals vs plan with a Q1 forecast." },
      { id: "a4", kind: "actions", title: "Action items", summary: "Decisions to confirm and tasks to assign after the meeting." },
    ],
  },
  drafts: {
    a1: {
      done: true,
      draft: {
        kind: "deck", title: "Q4 board presentation",
        blurb: "A 14-slide Q4 review for the board: results, drivers, risks, and the decision needed. Figures are illustrative starting points; replace with your actuals.",
        slides: [
          { eyebrow: "Board pack", title: "Lumen Health Q4 board review", bullets: ["Q4 results, the key drivers, and the decision needed today", "Prepared for the board | Friday, Nov 14"] },
          { eyebrow: "Q4 results", title: "Revenue beat plan on enterprise expansion", bullets: ["Revenue $4.2M, +18% vs the $3.55M plan", "Enterprise segment +34%; self-serve +6%", "Net new logos: 42, above the 35 target"] },
          { eyebrow: "Q4 results", title: "Margins held despite the hiring wave", bullets: ["Gross margin 71% vs 69% plan", "Operating loss $0.3M, better than the $0.6M plan", "Cash runway extended from Q2 to Q3 next year"] },
          { eyebrow: "Risks", title: "Two risks to flag for the board", bullets: ["Enterprise sales cycle lengthened to 62 days, up from 48", "One mid-market competitor cut pricing 15% this quarter"] },
        ],
      },
    },
    a2: {
      done: true,
      draft: {
        kind: "document", title: "Executive summary",
        blurb: "A one-page executive summary of Q4 performance and the board decisions requested. Figures are illustrative starting points; replace with your actuals.",
        sections: [
          { heading: "The quarter in one line", body: ["Q4 came in ahead of plan on revenue and gross margin, driven by enterprise expansion, while operating loss narrowed and cash runway extended.", "The board is asked to confirm the Q1 AI triage launch budget and the Q2 usage-based pricing direction."] },
          { heading: "Results vs plan", body: ["Revenue was $4.2M, 18% above the $3.55M plan, with enterprise up 34% and self-serve up 6%.", "Gross margin reached 71% against a 69% plan, and operating loss was $0.3M versus a $0.6M plan."] },
          { heading: "The ask", body: ["Approve $480K in Q1 launch spend across marketing, enablement, and on-call coverage.", "Confirm the Q2 usage-based pricing direction so engineering can build metering now."] },
        ],
      },
    },
    a3: {
      done: true,
      draft: {
        kind: "sheet", title: "Q4 financial model",
        blurb: "Q4 SaaS metrics with a Q1 forecast. Figures are illustrative starting points; replace with your actuals.",
        table: {
          columns: ["Metric", "Q3 actual", "Q4 plan", "Q4 actual", "Variance", "Q1 forecast"],
          rows: [
            ["ARR", "$11.2M", "$12.5M", "$13.4M", "+7.2%", "$15.0M"],
            ["Net new ARR", "$0.9M", "$1.3M", "$2.2M", "+69%", "$1.6M"],
            ["Logo count", "412", "445", "478", "+7.4%", "512"],
            ["Net new logos", "18", "33", "42", "+27%", "34"],
            ["Gross churn", "2.1%", "1.8%", "1.6%", "-0.2pp", "1.5%"],
            ["Gross margin", "69%", "69%", "71%", "+2pp", "72%"],
            ["Cash balance", "$8.0M", "$7.2M", "$9.2M", "+$2.0M", "$8.6M"],
          ],
        },
      },
    },
    a4: {
      done: true,
      draft: {
        kind: "actions", title: "Action items",
        blurb: "Decisions to confirm and tasks to assign after the board meeting.",
        actions: [
          { task: "Approve the $480K Q1 AI triage launch budget", owner: "Board", due: "Today" },
          { task: "Confirm Q2 usage-based pricing direction", owner: "CFO", due: "Fri this week" },
          { task: "Brief the exec team on the Q4 results", owner: "CEO", due: "Nov 17" },
          { task: "Open the Q1 launch plan in werk", owner: "Head of Product", due: "Nov 18" },
        ],
      },
    },
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: EXE,
  headless: "new",
  args: ["--no-sandbox", "--disable-gpu", "--force-device-scale-factor=1", "--hide-scrollbars"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });

const clearStorage = async () => {
  await page.evaluate(() => { localStorage.clear(); });
};
const setStudioSession = async () => {
  await page.evaluate((s) => {
    localStorage.setItem("werk.view", "studio");
    localStorage.setItem("werk.session.v1", s);
  }, JSON.stringify(SESSION));
};

// ---- A: landing page ----
await page.goto(URL, { waitUntil: "networkidle2" });
await sleep(1200);
await page.screenshot({ path: OUT + "01-landing.png" });
await page.screenshot({ path: OUT + "01b-landing-full.png", fullPage: true });

// ---- B: studio empty state ----
await clearStorage();
await page.goto(URL, { waitUntil: "networkidle2" });
await page.evaluate(() => localStorage.setItem("werk.view", "studio"));
await page.reload({ waitUntil: "networkidle2" });
await sleep(900);
await page.screenshot({ path: OUT + "02-studio-empty.png" });

// ---- C: studio ready with restored package (verifies persistence + download UI) ----
await page.goto(URL, { waitUntil: "networkidle2" });
await setStudioSession();
await page.reload({ waitUntil: "networkidle2" });
await sleep(1100);
await page.screenshot({ path: OUT + "03-studio-ready.png" });

// ---- D: drawer open on the deck (verifies regenerate + download footer) ----
await page.evaluate(() => {
  const item = document.querySelector(".cx__side-item");
  if (item) item.click();
});
await sleep(700);
await page.screenshot({ path: OUT + "04-drawer-deck.png" });

// drawer on the sheet (table render)
await page.keyboard.press("Escape");
await sleep(300);
await page.evaluate(() => {
  const items = document.querySelectorAll(".cx__side-item");
  const sheet = Array.from(items).find((i) => /model/i.test(i.textContent));
  if (sheet) sheet.click();
});
await sleep(600);
await page.screenshot({ path: OUT + "05-drawer-sheet.png" });

// ---- E: mobile ready (narrow viewport -> sidebar hidden, inline pack + chip) ----
await page.keyboard.press("Escape");
await sleep(250);
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
await sleep(500);
await page.screenshot({ path: OUT + "06-mobile-ready.png", fullPage: true });

await browser.close();
console.log("screenshots written to", OUT);
