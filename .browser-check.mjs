import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";

const EXE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const URL = process.env.WERK_URL ?? "http://localhost:5173/";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (fn, label, timeout = 15000) => {
  const start = Date.now();
  while (!await fn()) {
    if (Date.now() - start > timeout) throw new Error(`Timed out waiting for ${label}`);
    await sleep(100);
  }
};
const text = (page, selector) => page.$eval(selector, (el) => el.textContent?.trim() ?? "").catch(() => "");

const plan = {
  packageName: "Client proposal",
  packageTitle: "Website redesign proposal",
  reply: "I suggest this focused output for your review.",
  brief: {
    objective: "Present a clear website redesign proposal.",
    audience: "Needs your input: audience",
    decision: "Needs your input: desired next step",
    timing: "Needs your input: timing",
    knownDetails: ["The request is for a website redesign proposal."],
    openInputs: ["Needs your input: Who will use this?"],
    sharedTerms: ["website redesign"],
    consistencyRules: ["Use only supplied facts"],
  },
  assets: [{
    id: "a1", kind: "deck", title: "Website redesign proposal", summary: "A clear proposal for a new client.",
    purpose: "Present the proposed scope.", audience: "Needs your input: audience", decision: "Needs your input: desired next step",
    requiredAnalysis: ["Explain the supplied need"], acceptanceCriteria: ["Keep open inputs visible"], evidenceIds: [], dependencies: [],
  }],
};
const draft = {
  kind: "deck", title: "Website redesign proposal", blurb: "A draft proposal with details that still need confirmation.",
  slides: Array.from({ length: 7 }, (_, index) => ({ eyebrow: "Proposal", title: `Proposal section ${index + 1}`, bullets: ["Needs your input: final client detail"] })),
  metadata: { evidenceIds: [], assumptions: [], gaps: ["Needs your input: Who will use this?"], quality: [], revision: 1 },
};

const browser = await puppeteer.launch({ executablePath: EXE, headless: "new", args: ["--disable-gpu"] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
let clarifyCalls = 0;
let planCalls = 0;
let generateCalls = 0;
await page.setRequestInterception(true);
page.on("request", async (request) => {
  const url = request.url();
  if (url.endsWith("/api/clarify")) {
    clarifyCalls++;
    await request.respond({ status: 200, contentType: "application/json", body: JSON.stringify({
      mode: "clarify", reply: "One detail will help me shape this.",
      questions: [{ key: "audience", question: "Who will use this?", placeholder: "e.g. a new client", required: true }],
    }) });
    return;
  }
  if (url.endsWith("/api/plan")) {
    planCalls++;
    await request.respond({ status: 200, contentType: "application/json", body: JSON.stringify(plan) });
    return;
  }
  if (url.endsWith("/api/generate")) {
    generateCalls++;
    const body = JSON.parse(request.postData() || "{}");
    assert.equal(body.plan.packageTitle, "Website redesign proposal");
    const frames = [
      { type: "job-started" }, { type: "plan", plan }, { type: "asset-status", id: "a1", status: "drafting" },
      { type: "draft", id: "a1", draft }, { type: "done" },
    ].map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("");
    await request.respond({ status: 200, headers: { "Content-Type": "text/event-stream; charset=utf-8" }, body: frames });
    return;
  }
  request.continue();
});

await page.goto(URL, { waitUntil: "networkidle2" });
await page.evaluate(() => { localStorage.clear(); localStorage.setItem("werk.view", "studio"); });
await page.reload({ waitUntil: "networkidle2" });
await page.type('input[placeholder="Maya Studio"]', "Maya Studio");
await page.type('textarea[placeholder="Independent web designer for small businesses"]', "Independent web designer for small businesses");
await page.type('textarea[placeholder="Client proposals, launch plans, and project handovers"]', "Client proposals and project handovers");
await page.evaluate(() => Array.from(document.querySelectorAll("button")).find((button) => button.textContent?.includes("Save workspace"))?.click());
await page.waitForSelector(".cx__greeting");
await page.waitForSelector(".cx__first-use-guide");
assert.equal((await text(page, ".cx__first-use-guide")).includes("How Werk works"), true);
await page.screenshot({ path: ".shots/werk-first-use.png", fullPage: true });
await page.evaluate(() => Array.from(document.querySelectorAll("button")).find((button) => button.textContent?.includes("Got it"))?.click());
await page.waitForFunction(() => !document.querySelector(".cx__first-use-guide"));
await page.reload({ waitUntil: "networkidle2" });
await page.waitForSelector(".cx__greeting");
assert.equal(await page.$(".cx__first-use-guide"), null);
await page.type(".cx__input", "Create a proposal for a new website client");
await page.keyboard.press("Enter");
await page.waitForSelector(".cx__clarify");
assert.equal(await text(page, ".cx__clarify-q"), "Who will use this? *");
await page.evaluate(() => Array.from(document.querySelectorAll("button")).find((button) => button.textContent?.includes("Keep unanswered"))?.click());
await page.waitForSelector(".cx__review-card");
assert.equal(generateCalls, 0);
assert.equal(await text(page, ".cx__setup-title"), "Review before Werk writes");
await page.evaluate(() => Array.from(document.querySelectorAll("button")).find((button) => button.textContent?.includes("Create 1 draft"))?.click());
await waitFor(() => generateCalls === 1, "approved generation");
await page.waitForSelector(".cx__side-item");
await page.click(".cx__side-item");
await page.waitForSelector(".cx__drawer.is-open");
assert.equal((await text(page, ".cx__review-list--open")).includes("Who will use this?"), true);
assert.equal(clarifyCalls, 1);
assert.equal(planCalls, 1);
await page.screenshot({ path: ".shots/werk-smoke.png", fullPage: true });
await browser.close();
console.log(JSON.stringify({ clarifyCalls, planCalls, generateCalls }, null, 2));
