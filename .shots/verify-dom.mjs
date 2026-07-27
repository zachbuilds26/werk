import puppeteer from "puppeteer-core";

const EXE = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const URL = "http://localhost:5173/";
const SESSION = JSON.stringify({
  request: "Prep the Q4 board pack for Friday.",
  genRequest: "Prep the Q4 board pack for Friday.",
  clarify: null, clarifyAnswers: {}, phase: "ready",
  plan: {
    packageName: "Board pack", packageTitle: "Q4 board review",
    reply: "On it. Assembling your Q4 board pack.",
    assets: [
      { id: "a1", kind: "deck", title: "Q4 board presentation", summary: "14-slide review." },
      { id: "a2", kind: "document", title: "Executive summary", summary: "One-page summary." },
      { id: "a3", kind: "sheet", title: "Q4 financial model", summary: "Q4 actuals vs plan." },
      { id: "a4", kind: "actions", title: "Action items", summary: "Tasks to assign." },
    ],
  },
  drafts: {
    a1: { done: true, draft: { kind: "deck", title: "Q4 board presentation", blurb: "A 14-slide review.", slides: [{ eyebrow: "Board pack", title: "Q4 board review", bullets: ["Results", "Decision needed"] }] } },
    a2: { done: true, draft: { kind: "document", title: "Executive summary", blurb: "Summary.", sections: [{ heading: "Overview", body: ["Para one."] }] } },
    a3: { done: true, draft: { kind: "sheet", title: "Q4 financial model", blurb: "Model.", table: { columns: ["Metric", "Q4"], rows: [["ARR", "$13.4M"]] } } },
    a4: { done: true, draft: { kind: "actions", title: "Action items", blurb: "Tasks.", actions: [{ task: "Approve budget", owner: "Board", due: "Today" }] } },
  },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: EXE, headless: "new", args: ["--no-sandbox", "--disable-gpu"] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });

const log = (...a) => console.log(...a);

// --- restore session + reload (verifies persistence path on mount) ---
await page.goto(URL, { waitUntil: "networkidle2" });
await page.evaluate((s) => { localStorage.setItem("werk.view", "studio"); localStorage.setItem("werk.session.v1", s); }, SESSION);
await page.reload({ waitUntil: "networkidle2" });
await sleep(900);

const r = await page.evaluate(() => {
  const q = (s) => document.querySelector(s);
  const qa = (s) => Array.from(document.querySelectorAll(s));
  return {
    barName: q(".cx__bar-name")?.textContent?.trim() ?? null,
    sideItems: qa(".cx__side-item").map((e) => e.textContent?.trim()),
    doneCount: qa(".cx__side-status .cx__done").length,
    pkgBtn: q(".cx__side-pkg")?.textContent?.trim() ?? null,
    chipPkg: q(".cx__chip--pkg")?.textContent?.trim() ?? null,
    openChip: q(".cx__chip")?.textContent?.trim() ?? null,
    readyComposer: q(".cx__new-request")?.textContent?.trim() ?? null,
  };
});
log("READY STATE:", JSON.stringify(r, null, 2));

// --- open drawer on first asset (verifies regenerate + download footer) ---
await page.evaluate(() => document.querySelector(".cx__side-item")?.click());
await sleep(500);
const d = await page.evaluate(() => {
  const q = (s) => document.querySelector(s);
  const qa = (s) => Array.from(document.querySelectorAll(s));
  return {
    drawerOpen: !!q(".cx__drawer.is-open"),
    drawerName: q(".cx__drawer-name")?.textContent?.trim() ?? null,
    regenBtn: q(".cx__drawer-regen")?.textContent?.trim() ?? null,
    footRight: qa(".cx__drawer-foot-right .btn").map((e) => e.textContent?.trim()),
    draftBody: !!q(".cx__drawer-body .cx__draft"),
  };
});
log("DRAWER:", JSON.stringify(d, null, 2));

// --- reload again, confirm persistence survived (plan + drafts still there) ---
await page.reload({ waitUntil: "networkidle2" });
await sleep(800);
const p = await page.evaluate(() => ({
  barName: document.querySelector(".cx__bar-name")?.textContent?.trim() ?? null,
  sideItems: document.querySelectorAll(".cx__side-item").length,
  doneCount: document.querySelectorAll(".cx__side-status .cx__done").length,
  pkgBtn: document.querySelector(".cx__side-pkg")?.textContent?.trim() ?? null,
}));
log("AFTER RELOAD (persistence):", JSON.stringify(p, null, 2));

// --- landing nav sticky check: scroll, read nav bounding rect top ---
await page.evaluate(() => { localStorage.clear(); });
await page.goto(URL, { waitUntil: "networkidle2" });
await sleep(700);
const nav = await page.evaluate(() => {
  const el = document.querySelector(".nav");
  const r = el.getBoundingClientRect();
  window.scrollTo(0, 600);
  return { beforeTop: Math.round(r.top), position: getComputedStyle(el).position };
});
await sleep(400);
const navAfter = await page.evaluate(() => {
  const el = document.querySelector(".nav");
  return { afterTop: Math.round(el.getBoundingClientRect().top) };
});
log("NAV sticky:", JSON.stringify({ ...nav, ...navAfter }, null, 2));

await browser.close();
