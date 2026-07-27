import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";

const EXE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const URL = process.env.WERK_URL ?? "http://localhost:5173/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, label, timeout = 15000, interval = 100) => {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error(`Timed out waiting for ${label}`);
    await sleep(interval);
  }
};
const text = async (page, sel) => page.$eval(sel, (el) => el.textContent?.trim() ?? null).catch(() => null);
const lastText = async (page, sel) => page.$$eval(sel, (els) => els.at(-1)?.textContent?.trim() ?? null).catch(() => null);
const disabled = async (page, sel) => page.$eval(sel, (el) => !!el.disabled).catch(() => null);
const replace = async (page, sel, value) => {
  await page.click(sel);
  await page.keyboard.down("Control");
  await page.keyboard.press("KeyA");
  await page.keyboard.up("Control");
  await page.type(sel, value);
};

const browser = await puppeteer.launch({
  executablePath: EXE,
  headless: "new",
  args: ["--no-sandbox", "--disable-gpu"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });

let clarifyBodies = [];
let generateBodies = [];
let regenerateBodies = [];

await page.setRequestInterception(true);
page.on("request", async (request) => {
  const url = request.url();
  if (url.endsWith("/api/clarify")) {
    const body = JSON.parse(request.postData() || "{}");
    clarifyBodies.push(body);
    await request.respond({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ mode: "ready", reply: "", questions: [] }),
    });
    return;
  }
  if (url.endsWith("/api/generate")) {
    const body = JSON.parse(request.postData() || "{}");
    generateBodies.push(body);
    const org = body?.workspaceContext?.organizationName ?? "Unknown";
    const period = body?.request?.includes("Q2") ? "Q2" : "Q1";
    const plan = {
      packageName: "Board pack",
      packageTitle: `${org} ${period} review`,
      reply: `On it. Assembling your ${org} ${period} board pack.`,
      assets: [
        {
          id: "a1",
          kind: "deck",
          title: `${org} board presentation`,
          summary: `${period} review for ${org}.`,
        },
      ],
    };
    const draft = {
      kind: "deck",
      title: `${org} board presentation`,
      blurb: `A ${period} board pack for ${org}. Figures are illustrative starting points; replace with your actuals.`,
      slides: [
        {
          eyebrow: "Board pack",
          title: `${org} ${period} review`,
          bullets: [`Results for ${org}`, "Decision needed"],
        },
      ],
    };
    const frames = [
      { type: "plan", plan },
      { type: "draft", id: "a1", draft },
      { type: "done" },
    ].map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("");
    await request.respond({
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no-cache",
      },
      body: frames,
    });
    return;
  }
  if (url.endsWith("/api/draft")) {
    const body = JSON.parse(request.postData() || "{}");
    regenerateBodies.push(body);
    await request.respond({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        kind: body.kind,
        title: body.title,
        blurb: "A revised board pack with a sharper decision path.",
        slides: [{ eyebrow: "Board pack", title: "Revised Q2 decision", bullets: ["Approve the revised plan"] }],
        metadata: { evidenceIds: [], assumptions: [], gaps: [], quality: [], revision: 2 },
      }),
    });
    return;
  }
  request.continue();
});

await page.goto(URL, { waitUntil: "networkidle2" });
await page.evaluate(() => {
  localStorage.clear();
  localStorage.setItem("werk.view", "studio");
});
await page.reload({ waitUntil: "networkidle2" });

assert.equal(await text(page, ".cx__setup-title"), "Set the workspace context");
assert.equal(await disabled(page, ".cx__setup-actions .btn--primary"), true);

await page.type('input[placeholder="Acme Finance"]', "Acme Finance");
assert.equal(await disabled(page, ".cx__setup-actions .btn--primary"), true);
await page.type('textarea[placeholder="B2B expense software for finance teams"]', "B2B expense software for finance teams");
await page.type('textarea[placeholder="Board packs, Q1 budgets, launch docs, and leadership updates"]', "Board packs, Q1 budgets, launch docs, and leadership updates");
assert.equal(await disabled(page, ".cx__setup-actions .btn--primary"), false);
await page.evaluate(() => Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.includes("Save workspace"))?.click());
await page.waitForSelector(".cx__greeting");
assert.equal(await text(page, ".cx__workspace-name"), "Acme Finance");
assert.equal(await text(page, ".cx__greeting"), "What do you need?");

await page.type(".cx__input", "Create the Q1 budget");
await page.keyboard.press("Enter");
await waitFor(() => generateBodies.length === 1, "first generation request");
await page.waitForFunction(() => document.querySelector(".cx__bar-name")?.textContent?.includes("Acme Finance Q1 review"));
assert.equal(clarifyBodies.length, 1);
assert.equal(clarifyBodies[0].workspaceContext.organizationName, "Acme Finance");
assert.equal(clarifyBodies[0].workspaceContext.workspacePurpose, "Board packs, Q1 budgets, launch docs, and leadership updates");
assert.equal(generateBodies[0].workspaceContext.organizationName, "Acme Finance");
assert.equal(generateBodies[0].workspaceContext.workspacePurpose, "Board packs, Q1 budgets, launch docs, and leadership updates");
assert.equal(generateBodies[0].request.includes("Workspace context:\nCompany or team: Acme Finance"), true);
assert.equal(await text(page, ".cx__bar-name"), "Acme Finance Q1 review");
assert.equal((await text(page, ".cx__card-name"))?.includes("Acme Finance board presentation"), true);

await page.evaluate(() => Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.includes("Edit workspace context"))?.click());
await page.waitForSelector(".cx__setup-title");
assert.equal(await text(page, ".cx__setup-title"), "Edit the workspace context");
await replace(page, 'input[placeholder="Acme Finance"]', "Beta Labs");
await replace(page, 'textarea[placeholder="B2B expense software for finance teams"]', "B2B analytics software for finance teams");
await replace(page, 'textarea[placeholder="Board packs, Q1 budgets, launch docs, and leadership updates"]', "Q2 budgets, board packs, and launch docs");
await page.evaluate(() => Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.includes("Update workspace"))?.click());
await page.waitForSelector(".cx__msg--user .cx__bubble");
assert.equal(await text(page, ".cx__workspace-name"), "Beta Labs");
assert.equal((await lastText(page, ".cx__msg--user .cx__bubble"))?.includes("Create the Q1 budget"), true);

await page.type(".cx__input", "Create the Q2 budget");
await page.keyboard.press("Enter");
await waitFor(() => generateBodies.length === 2, "second generation request");
await page.waitForFunction(() => document.querySelector(".cx__bar-name")?.textContent?.includes("Beta Labs Q2 review"));
assert.equal(generateBodies[1].workspaceContext.organizationName, "Beta Labs");
assert.equal(generateBodies[1].workspaceContext.workspacePurpose, "Q2 budgets, board packs, and launch docs");
assert.equal(generateBodies[1].request.includes("Workspace context:\nCompany or team: Beta Labs"), true);
assert.equal(await text(page, ".cx__bar-name"), "Beta Labs Q2 review");
assert.equal((await lastText(page, ".cx__msg--user .cx__bubble"))?.includes("Create the Q2 budget"), true);

await page.click(".cx__side-item");
await page.waitForSelector(".cx__drawer.is-open");
await page.evaluate(() => Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.includes("Regenerate"))?.click());
await waitFor(() => regenerateBodies.length === 1, "asset regeneration request");
await page.waitForFunction(() => document.querySelectorAll(".cx__drawer-version option").length === 2);
assert.equal(regenerateBodies[0].previousDraft?.metadata?.revision ?? 1, 1);
assert.equal(await page.$$eval(".cx__drawer-version option", (options) => options.length), 2);

await page.reload({ waitUntil: "networkidle2" });
await page.waitForSelector(".cx__main", { visible: true });
assert.equal(await text(page, ".cx__workspace-name"), "Beta Labs");
assert.equal(await text(page, ".cx__bar-name"), "Beta Labs Q2 review");
assert.equal((await lastText(page, ".cx__msg--user .cx__bubble"))?.includes("Create the Q2 budget"), true);
await page.click(".cx__side-item");
await page.waitForSelector(".cx__drawer.is-open");
assert.equal(await page.$$eval(".cx__drawer-version option", (options) => options.length), 2);
assert.equal(await text(page, ".cx__setup-title"), null);

await browser.close();
console.log(JSON.stringify({ clarifyCalls: clarifyBodies.length, generateCalls: generateBodies.length }, null, 2));
