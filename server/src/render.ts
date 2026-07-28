// Render an AssetDraft into a real downloadable file: markdown, PDF, PPTX, or
// XLSX. Each asset kind maps naturally to one or two formats, but every kind
// can render to every format so the client can offer a download menu without
// the server special-casing it.
//
// Brand palette (hex, no leading # for pptxgenjs, with # for pdfkit/css):
//   ink #15395C  ink-2 #3F5A78  muted #6F8093  accent #7DD3FC
//   line #D7E6F3  bg-2 #F2F8FD  white #FFFFFF  green #5B7A4E

import PDFDocument from "pdfkit";
import pptxgen from "pptxgenjs";
import ExcelJS from "exceljs";
import type { AssetDraft } from "./types.js";

// pptxgenjs ships `export default PptxGenJS` + `export as namespace PptxGenJS`;
// under NodeNext the default import binds to the namespace, so `new pptxgen()`
// is not seen as constructable even though it is at runtime. Construct via a
// cast and keep the instance type so the rest of the builder stays checked.
type PptxPres = import("pptxgenjs").default;

export type RenderFormat = "md" | "pdf" | "pptx" | "xlsx";

export interface RenderResult {
  ext: string;
  mime: string;
  bytes: Buffer;
}

const HEX = {
  ink: "15395C",
  ink2: "3F5A78",
  muted: "6F8093",
  accent: "7DD3FC",
  line: "D7E6F3",
  bg2: "F2F8FD",
  white: "FFFFFF",
  green: "5B7A4E",
};

/* ------------------------------------------------------------------ *
 * Shared markdown (every kind) — also the cheapest, always-available
 * representation.
 * ------------------------------------------------------------------ */
function openInputNote(d: AssetDraft): string[] {
  const gaps = d.metadata?.gaps ?? [];
  return gaps.length
    ? ["## Details to confirm", "", ...gaps.map((gap) => `- ${gap}`), "", "This is a draft until these details are confirmed.", ""]
    : [];
}

function toMarkdown(d: AssetDraft): string {
  const out: string[] = [`# ${d.title}`, "", d.blurb, "", ...openInputNote(d)];
  switch (d.kind) {
    case "deck":
      for (const s of d.slides ?? []) {
        out.push(`## ${s.eyebrow} — ${s.title}`, "");
        for (const b of s.bullets) out.push(`- ${b}`);
        out.push("");
      }
      break;
    case "document":
      for (const s of d.sections ?? []) {
        out.push(`## ${s.heading}`, "");
        for (const p of s.body) out.push(p, "");
      }
      break;
    case "sheet": {
      const t = d.table;
      if (t) {
        out.push(`| ${t.columns.join(" | ")} |`);
        out.push(`| ${t.columns.map(() => "---").join(" | ")} |`);
        for (const row of t.rows) out.push(`| ${row.join(" | ")} |`);
        out.push("");
      }
      break;
    }
    case "agenda":
      out.push("| Time | Topic | Owner |", "| --- | --- | --- |");
      for (const a of d.agenda ?? []) out.push(`| ${a.time} | ${a.topic} | ${a.owner} |`);
      out.push("");
      break;
    case "actions":
      for (const a of d.actions ?? []) out.push(`- [ ] ${a.task} — _${a.owner}_ — **${a.due}**`);
      out.push("");
      break;
    case "timeline":
      for (const p of d.timeline ?? []) out.push(`## ${p.phase} (${p.window})`, "", p.detail, "");
      break;
  }
  return out.join("\n").trim() + "\n";
}

/* ------------------------------------------------------------------ *
 * PDF — pdfkit. Clean editorial layout: brand header band, title,
 * blurb, then the content for the kind. Sheets render in landscape
 * with a hairline table; everything else in portrait.
 * ------------------------------------------------------------------ */
// Draw a table that preserves complete cell values. Rows grow to fit wrapped
// text, break across pages before the footer, and repeat their header after a
// page break so exports stay usable as the generated detail increases.
function drawPdfTable(
  doc: PDFKit.PDFDocument,
  columns: string[],
  rows: string[][],
  left: number,
  top: number,
  width: number
): number {
  const n = Math.max(columns.length, 1);
  const colW = width / n;
  const fs = n > 6 ? 7.5 : 9;
  const padding = 6;
  const cellW = colW - padding * 2;
  const bottomMargin = 56;

  const cellHeight = (text: string, bold = false) => {
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(fs);
    return doc.heightOfString(text || " ", { width: cellW, lineGap: 1 });
  };
  const headerH = Math.max(22, ...columns.map((column) => cellHeight(column, true) + padding * 2));
  const rowHeight = (row: string[]) =>
    Math.max(22, ...columns.map((_, index) => cellHeight(row[index] ?? "") + padding * 2));

  let y = top;
  let tableStart = y;
  const drawHeader = () => {
    doc.rect(left, y, width, headerH).fillColor(HEX.bg2).fill();
    doc.fillColor(HEX.ink).fontSize(fs).font("Helvetica-Bold");
    columns.forEach((column, index) => {
      doc.text(column, left + index * colW + padding, y + padding, {
        width: cellW,
        lineGap: 1,
      });
    });
    y += headerH;
  };
  const nextPage = () => {
    doc.rect(left, tableStart, width, y - tableStart).strokeColor(HEX.line).lineWidth(0.75).stroke();
    doc.addPage();
    y = bottomMargin;
    tableStart = y;
    drawHeader();
  };

  if (y + headerH > doc.page.height - bottomMargin) {
    doc.addPage();
    y = bottomMargin;
    tableStart = y;
  }
  drawHeader();

  rows.forEach((row, rowIndex) => {
    const height = rowHeight(row);
    if (y + height > doc.page.height - bottomMargin) nextPage();

    if (rowIndex % 2 === 1) doc.rect(left, y, width, height).fillColor("F7FBFE").fill();
    doc.fillColor(HEX.ink2).fontSize(fs).font("Helvetica");
    row.forEach((cell, index) => {
      doc.text(cell ?? "", left + index * colW + padding, y + padding, {
        width: cellW,
        lineGap: 1,
      });
    });
    y += height;
    doc.moveTo(left, y).lineTo(left + width, y).strokeColor(HEX.line).lineWidth(0.5).stroke();
  });

  doc.rect(left, tableStart, width, y - tableStart).strokeColor(HEX.line).lineWidth(0.75).stroke();
  return y;
}

function toPdf(d: AssetDraft): Promise<Buffer> {
  const landscape = d.kind === "sheet";
  const doc = new PDFDocument({
    size: "LETTER",
    layout: landscape ? "landscape" : "portrait",
    margin: 56,
    bufferPages: true,
    info: { Title: d.title, Author: "Werk" },
  });
  const bufs: Buffer[] = [];
  doc.on("data", (b: Buffer) => bufs.push(b));

  const pageW = doc.page.width;
  const pageH = doc.page.height;
  const margin = 56;
  const contentW = pageW - margin * 2;

  // brand header band
  doc.rect(0, 0, pageW, 6).fillColor(HEX.accent).fill();
  doc
    .font("Helvetica-Bold")
    .fontSize(8)
    .fillColor(HEX.muted)
    .text("Werk", margin, 26, { lineBreak: false });
  doc
    .font("Helvetica")
    .fontSize(8)
    .fillColor(HEX.muted)
    .text(d.kind.toUpperCase(), pageW - margin, 26, { align: "right", lineBreak: false });

  // title
  let y = 54;
  doc
    .font("Helvetica-Bold")
    .fontSize(22)
    .fillColor(HEX.ink)
    .text(d.title, margin, y, { width: contentW });
  y = doc.y + 6;

  // blurb
  doc
    .font("Helvetica")
    .fontSize(10.5)
    .fillColor(HEX.ink2)
    .text(d.blurb, margin, y, { width: contentW });
  y = doc.y + 8;

  const gaps = d.metadata?.gaps ?? [];
  if (gaps.length) {
    doc.font("Helvetica-Bold").fontSize(9).fillColor(HEX.ink).text("DETAILS TO CONFIRM", margin, y, { width: contentW });
    y = doc.y + 3;
    doc.font("Helvetica").fontSize(9).fillColor(HEX.ink2).text(gaps.map((gap) => `• ${gap}`).join("\n"), margin, y, { width: contentW });
    y = doc.y + 10;
  } else {
    y += 6;
  }

  // hairline under the header block
  doc.moveTo(margin, y).lineTo(margin + contentW, y).strokeColor(HEX.line).lineWidth(1).stroke();
  y += 16;

  switch (d.kind) {
    case "deck":
      for (const s of d.slides ?? []) {
        if (y > pageH - margin - 90) {
          doc.addPage({ size: "LETTER", layout: "portrait" });
          y = margin;
        }
        doc
          .font("Helvetica-Bold")
          .fontSize(8)
          .fillColor(HEX.muted)
          .text(s.eyebrow.toUpperCase(), margin, y, { width: contentW });
        y = doc.y + 2;
        doc
          .font("Helvetica-Bold")
          .fontSize(14)
          .fillColor(HEX.ink)
          .text(s.title, margin, y, { width: contentW });
        y = doc.y + 6;
        doc.font("Helvetica").fontSize(11).fillColor(HEX.ink2);
        for (const b of s.bullets) {
          doc.text(`•  ${b}`, margin + 12, y, { width: contentW - 12 });
          y = doc.y + 3;
        }
        y += 14;
      }
      break;

    case "document":
      for (const s of d.sections ?? []) {
        if (y > pageH - margin - 80) {
          doc.addPage({ size: "LETTER", layout: "portrait" });
          y = margin;
        }
        doc
          .font("Helvetica-Bold")
          .fontSize(13)
          .fillColor(HEX.ink)
          .text(s.heading, margin, y, { width: contentW });
        y = doc.y + 6;
        doc.font("Helvetica").fontSize(11).fillColor(HEX.ink2);
        for (const p of s.body) {
          doc.text(p, margin, y, { width: contentW });
          y = doc.y + 6;
        }
        y += 12;
      }
      break;

    case "sheet": {
      const t = d.table;
      if (t) {
        if (y > pageH - margin - 120) {
          doc.addPage({ size: "LETTER", layout: "landscape" });
          y = margin;
        }
        drawPdfTable(doc, t.columns, t.rows, margin, y, contentW);
      }
      break;
    }

    case "agenda": {
      const rows = (d.agenda ?? []).map((a) => [a.time, a.topic, a.owner]);
      y = drawPdfTable(doc, ["Time", "Topic", "Owner"], rows, margin, y, contentW);
      break;
    }

    case "actions": {
      const rows = (d.actions ?? []).map((a) => [a.task, a.owner, a.due]);
      y = drawPdfTable(doc, ["Task", "Owner", "Due"], rows, margin, y, contentW);
      break;
    }

    case "timeline": {
      const rows = (d.timeline ?? []).map((p) => [p.phase, p.window, p.detail]);
      y = drawPdfTable(doc, ["Phase", "Window", "Detail"], rows, margin, y, contentW);
      break;
    }
  }

  // footer page numbers
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(i);
    doc
      .font("Helvetica")
      .fontSize(8)
      .fillColor(HEX.muted)
      .text(`${i + 1} / ${range.count}`, margin, pageH - 34, {
        width: contentW,
        align: "center",
        lineBreak: false,
      });
  }

  doc.end();
  // pdfkit emits its data/end events on later ticks; resolve when done.
  return new Promise<Buffer>((resolve) => {
    doc.on("end", () => resolve(Buffer.concat(bufs)));
  });
}

/* ------------------------------------------------------------------ *
 * PPTX — pptxgenjs. Deck becomes real slides; every other kind becomes
 * a title slide plus one or two content slides so the file is still
 * useful when someone asks for a deck as pptx.
 * ------------------------------------------------------------------ */
function hex(s: string): string {
  return s.replace("#", "").toUpperCase();
}

async function toPptx(d: AssetDraft): Promise<Buffer> {
  const pres = new (pptxgen as unknown as new () => PptxPres)();
  pres.layout = "LAYOUT_WIDE";
  pres.author = "Werk";
  pres.title = d.title;

  const INK = hex("#15395C");
  const INK2 = hex("#3F5A78");
  const MUTED = hex("#6F8093");
  const ACCENT = hex("#7DD3FC");
  const LINE = hex("#D7E6F3");
  const BG2 = hex("#F2F8FD");

  const titleSlide = (eyebrow: string, title: string, sub: string) => {
    const s = pres.addSlide();
    s.background = { color: hex("#FFFFFF") };
    s.addShape("rect", { x: 0, y: 0, w: "100%", h: 0.12, fill: { color: ACCENT } });
    s.addText(eyebrow.toUpperCase(), {
      x: 0.7, y: 1.5, w: 11, h: 0.4, fontSize: 14, color: MUTED,
      fontFace: "Arial", bold: false, charSpacing: 2,
    });
    s.addText(title, {
      x: 0.7, y: 1.95, w: 11.5, h: 1.6, fontSize: 40, color: INK,
      fontFace: "Arial", bold: true, align: "left", valign: "top",
    });
    const confirmationNote = (d.metadata?.gaps?.length ?? 0) ? `\nDetails to confirm: ${d.metadata!.gaps.join(" · ")}` : "";
    s.addText(`${sub}${confirmationNote}`, {
      x: 0.7, y: 3.7, w: 10.5, h: 1.25, fontSize: 16, color: INK2,
      fontFace: "Arial", align: "left", valign: "top",
    });
    return s;
  };

  const contentSlide = (eyebrow: string, title: string, bullets: string[]) => {
    const s = pres.addSlide();
    s.background = { color: hex("#FFFFFF") };
    s.addText(eyebrow.toUpperCase(), {
      x: 0.7, y: 0.45, w: 11.5, h: 0.3, fontSize: 11, color: MUTED,
      fontFace: "Arial", charSpacing: 2,
    });
    s.addText(title, {
      x: 0.7, y: 0.8, w: 11.5, h: 0.9, fontSize: 26, color: INK,
      fontFace: "Arial", bold: true, align: "left", valign: "top",
    });
    s.addShape("line", { x: 0.7, y: 1.75, w: 11.9, h: 0, line: { color: LINE, width: 1 } });
    s.addText(
      bullets.map((b) => ({ text: b, options: { bullet: { code: "2022" }, indentLevel: 0 } })),
      {
        x: 0.9, y: 2.0, w: 11.5, h: 4.6, fontSize: 17, color: INK2,
        fontFace: "Arial", align: "left", valign: "top", lineSpacingMultiple: 1.3, fit: "shrink",
      }
    );
    return s;
  };

  const tableSlide = (
    eyebrow: string,
    title: string,
    columns: string[],
    rows: string[][]
  ) => {
    const s = pres.addSlide();
    s.background = { color: hex("#FFFFFF") };
    s.addText(eyebrow.toUpperCase(), {
      x: 0.7, y: 0.45, w: 11.5, h: 0.3, fontSize: 11, color: MUTED,
      fontFace: "Arial", charSpacing: 2,
    });
    s.addText(title, {
      x: 0.7, y: 0.8, w: 11.5, h: 0.8, fontSize: 26, color: INK,
      fontFace: "Arial", bold: true, align: "left", valign: "top",
    });
    const headRow = columns.map((c) => ({
      text: c, options: { fill: { color: BG2 }, color: INK, bold: true, fontSize: 11, align: "left" as const },
    }));
    const bodyRows = rows.map((r) =>
      r.map((c) => ({ text: c, options: { color: INK2, fontSize: 11, align: "left" as const } }))
    );
    s.addTable([headRow, ...bodyRows], {
      x: 0.7, y: 1.8, w: 11.9, colW: 11.9 / Math.max(columns.length, 1),
      rowH: 0.4, border: { type: "solid", pt: 0.5, color: LINE },
      fontFace: "Arial", valign: "middle",
    });
    return s;
  };

  switch (d.kind) {
    case "deck": {
      const slides = d.slides ?? [];
      if (slides.length === 0) {
        titleSlide(d.kind, d.title, d.blurb);
        break;
      }
      const first = slides[0];
      titleSlide(first.eyebrow || "Deck", first.title, first.bullets.join("  ·  ") || d.blurb);
      for (let i = 1; i < slides.length; i++) {
        contentSlide(slides[i].eyebrow, slides[i].title, slides[i].bullets);
      }
      break;
    }
    case "document": {
      titleSlide("Document", d.title, d.blurb);
      for (const sec of d.sections ?? []) {
        contentSlide("Section", sec.heading, sec.body);
      }
      break;
    }
    case "sheet": {
      const t = d.table;
      if (t) {
        titleSlide("Spreadsheet", d.title, d.blurb);
        // pptxgenjs table rows are capped; chunk to keep each slide readable
        const chunk = 14;
        for (let i = 0; i < t.rows.length; i += chunk) {
          tableSlide("Data", d.title, t.columns, t.rows.slice(i, i + chunk));
        }
      } else titleSlide("Spreadsheet", d.title, d.blurb);
      break;
    }
    case "agenda": {
      const rows = (d.agenda ?? []).map((a) => [a.time, a.topic, a.owner]);
      titleSlide("Agenda", d.title, d.blurb);
      if (rows.length) tableSlide("Agenda", d.title, ["Time", "Topic", "Owner"], rows);
      break;
    }
    case "actions": {
      const rows = (d.actions ?? []).map((a) => [a.task, a.owner, a.due]);
      titleSlide("Action items", d.title, d.blurb);
      if (rows.length) tableSlide("Actions", d.title, ["Task", "Owner", "Due"], rows);
      break;
    }
    case "timeline": {
      const rows = (d.timeline ?? []).map((p) => [p.phase, p.window, p.detail]);
      titleSlide("Timeline", d.title, d.blurb);
      if (rows.length) tableSlide("Timeline", d.title, ["Phase", "Window", "Detail"], rows);
      break;
    }
  }

  const out = (await pres.write({ outputType: "nodebuffer" })) as Buffer;
  return out;
}

/* ------------------------------------------------------------------ *
 * XLSX — exceljs. Sheet becomes a real worksheet with a styled header
 * row; agenda / actions / timeline become tidy three-column sheets;
 * deck / document become a labelled two-column sheet (label, content).
 * ------------------------------------------------------------------ */
async function toXlsx(d: AssetDraft): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Werk";
  const ws = wb.addWorksheet("Asset");
  ws.views = [{ showGridLines: false }];

  const headerFill = {
    type: "pattern" as const,
    pattern: "solid" as const,
    fgColor: { argb: "FFF2F8FD" },
  };
  const headFont = { bold: true, color: { argb: "FF15395C" }, size: 11, name: "Arial" };
  const bodyFont = { color: { argb: "FF3F5A78" }, size: 11, name: "Arial" };
  const thin = { style: "thin" as const, color: { argb: "FFD7E6F3" } };
  const border = { top: thin, left: thin, bottom: thin, right: thin };

  // title rows
  ws.getCell("A1").value = d.title;
  ws.getCell("A1").font = { bold: true, color: { argb: "FF15395C" }, size: 16, name: "Arial" };
  ws.getCell("A2").value = d.blurb;
  ws.getCell("A2").font = { color: { argb: "FF6F8093" }, size: 10, name: "Arial" };
  if (d.metadata?.gaps.length) {
    ws.getCell("A3").value = `Details to confirm: ${d.metadata.gaps.join(" | ")}`;
    ws.getCell("A3").font = { color: { argb: "FF15395C" }, size: 10, bold: true, name: "Arial" };
  }

  const writeTable = (columns: string[], rows: string[][], startRow: number) => {
    const headerRow = ws.getRow(startRow);
    columns.forEach((c, i) => {
      const cell = headerRow.getCell(i + 1);
      cell.value = c;
      cell.font = headFont;
      cell.fill = headerFill;
      cell.border = border;
      cell.alignment = { vertical: "middle", horizontal: "left" };
    });
    headerRow.height = 22;
    rows.forEach((row, ri) => {
      const r = ws.getRow(startRow + 1 + ri);
      row.forEach((cell, i) => {
        const cl = r.getCell(i + 1);
        cl.value = cell;
        cl.font = bodyFont;
        cl.border = border;
        cl.alignment = { vertical: "middle", horizontal: "left", wrapText: true };
      });
      // Let wrapped analytical text expand instead of being hidden in a fixed-height row.
      const longestLine = Math.max(
        1,
        ...row.map((cell) =>
          String(cell ?? "")
            .split("\n")
            .reduce((max, line) => Math.max(max, line.length), 0)
        )
      );
      r.height = Math.max(20, Math.ceil(longestLine / 38) * 15);
    });
    // column widths
    const widths = columns.map((c, i) =>
      Math.max(
        c.length + 2,
        ...rows.map((r) => (r[i] ? String(r[i]).length + 2 : 0)),
        10
      )
    );
    ws.columns.forEach((col, i) => {
      if (!col.width) col.width = 18;
      if (widths[i]) col.width = Math.min(widths[i], 48);
    });
    return startRow + 1 + rows.length;
  };

  let row = d.metadata?.gaps.length ? 5 : 4;
  switch (d.kind) {
    case "sheet": {
      const t = d.table;
      if (t) writeTable(t.columns, t.rows, row);
      break;
    }
    case "agenda":
      writeTable(["Time", "Topic", "Owner"], (d.agenda ?? []).map((a) => [a.time, a.topic, a.owner]), row);
      break;
    case "actions":
      writeTable(["Task", "Owner", "Due"], (d.actions ?? []).map((a) => [a.task, a.owner, a.due]), row);
      break;
    case "timeline":
      writeTable(
        ["Phase", "Window", "Detail"],
        (d.timeline ?? []).map((p) => [p.phase, p.window, p.detail]),
        row
      );
      break;
    case "deck": {
      const rows: string[][] = [];
      for (const s of d.slides ?? []) {
        rows.push([`${s.eyebrow} — ${s.title}`, s.bullets.join("\n")]);
      }
      writeTable(["Slide", "Bullets"], rows, row);
      ws.getColumn(2).width = 60;
      break;
    }
    case "document": {
      const rows: string[][] = [];
      for (const s of d.sections ?? []) rows.push([s.heading, s.body.join("\n\n")]);
      writeTable(["Section", "Body"], rows, row);
      ws.getColumn(2).width = 70;
      break;
    }
  }

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

/* ------------------------------------------------------------------ *
 * Public entry — dispatch by format, validate the draft defensively.
 * ------------------------------------------------------------------ */
export function renderMarkdown(d: AssetDraft): RenderResult {
  return { ext: "md", mime: "text/markdown; charset=utf-8", bytes: Buffer.from(toMarkdown(d), "utf8") };
}

export async function renderPdf(d: AssetDraft): Promise<RenderResult> {
  return { ext: "pdf", mime: "application/pdf", bytes: await toPdf(d) };
}

export async function renderPptx(d: AssetDraft): Promise<RenderResult> {
  return {
    ext: "pptx",
    mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    bytes: await toPptx(d),
  };
}

export async function renderXlsx(d: AssetDraft): Promise<RenderResult> {
  return {
    ext: "xlsx",
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    bytes: await toXlsx(d),
  };
}

export async function renderDraft(d: AssetDraft, format: RenderFormat): Promise<RenderResult> {
  switch (format) {
    case "md":
      return renderMarkdown(d);
    case "pdf":
      return renderPdf(d);
    case "pptx":
      return renderPptx(d);
    case "xlsx":
      return renderXlsx(d);
  }
}
