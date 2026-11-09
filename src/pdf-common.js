// Piezas compartidas para generar PDFs con la marca de YES EMS: colores,
// formato de dinero/horas/fechas, el encabezado con el logo, y una tabla
// generica con alto de fila dinamico (para que el texto que se envuelve a
// varias lineas nunca se encime con la fila de abajo). Usado tanto por el
// PDF general/individual del panel de administracion
// (src/routes/export-pdf.js) como por el recibo que descarga cada
// trabajador desde su propio Portal (src/pdf-worker-receipt.js).
"use strict";

const path = require("path");
const fs = require("fs");

const LOGO_PATH = path.join(__dirname, "..", "public", "assets", "logo.png");
const BRAND_COLOR = "#123D38";
const MUTED_COLOR = "#5E6E69";
const INK_COLOR = "#1B2926";
const HEADER_FILL = "#EAE6D9";
const LINE_COLOR = "#DEDACB";
const PAGE_MARGIN = 46;

function fmtMoneyPdf(n) {
  return new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(n || 0);
}
function fmtHorasPdf(n) {
  n = Math.max(0, Number(n) || 0);
  const h = Math.floor(n);
  let m = Math.round((n - h) * 60);
  let hh = h;
  if (m === 60) { m = 0; hh += 1; }
  if (hh === 0 && m === 0) return "0 min";
  if (hh === 0) return `${m} min`;
  if (m === 0) return `${hh} h`;
  return `${hh} h ${m} min`;
}
function fmtFecha(d) {
  return d.toLocaleDateString("es-MX", { day: "2-digit", month: "2-digit", year: "numeric" });
}
function fmtHora(d) {
  return d.toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" });
}

/* ----------------------------- Encabezado de marca ----------------------------- */
function drawBrandHeader(doc, titulo, subtitulo) {
  const top = doc.y;
  if (fs.existsSync(LOGO_PATH)) {
    doc.image(LOGO_PATH, PAGE_MARGIN, top, { width: 40, height: 40 });
  }
  const textX = PAGE_MARGIN + 52;
  const textWidth = doc.page.width - PAGE_MARGIN - textX;
  doc.font("Helvetica-Bold").fontSize(15).fillColor(BRAND_COLOR).text("YES EMS", textX, top, { width: textWidth });
  doc.font("Helvetica-Oblique").fontSize(9).fillColor(MUTED_COLOR)
    .text("Centro de Capacitación y Servicios Educativos", textX, doc.y, { width: textWidth });
  doc.font("Helvetica-Bold").fontSize(11).fillColor(INK_COLOR).text(titulo, textX, doc.y + 2, { width: textWidth });
  doc.font("Helvetica").fontSize(9.5).fillColor(MUTED_COLOR).text(subtitulo, textX, doc.y, { width: textWidth });
  doc.y = Math.max(doc.y, top + 44) + 16;
  doc.x = PAGE_MARGIN;
}

/* --------------------------------- Tabla generica --------------------------------- */
// columns: [{ header, width, align }]
// rows: arreglo de arreglos de valores ya en el mismo orden que columns.
function drawTable(doc, columns, rows, opts) {
  opts = opts || {};
  const minRowHeight = opts.rowHeight || 20;
  const padV = 6;
  const totalWidth = columns.reduce((s, c) => s + c.width, 0);

  // Las celdas pueden envolver a mas de una linea (nombres de tipo largos,
  // encabezados como "Horas totales"), asi que el alto de cada fila/
  // encabezado se calcula segun el texto mas alto de esa fila -- nunca un
  // numero fijo -- para que el texto nunca se encime con la fila de abajo.
  function rowNeededHeight(cells) {
    let maxH = 0;
    cells.forEach((text, i) => {
      const h = doc.heightOfString(String(text == null ? "" : text), { width: columns[i].width - 10 });
      if (h > maxH) maxH = h;
    });
    return Math.max(minRowHeight, maxH + padV * 2);
  }

  function drawHeader() {
    const headers = columns.map((c) => c.header);
    const h = rowNeededHeight(headers);
    const y = doc.y;
    doc.rect(PAGE_MARGIN, y, totalWidth, h).fill(HEADER_FILL);
    let x = PAGE_MARGIN;
    doc.font("Helvetica-Bold").fontSize(9).fillColor(INK_COLOR);
    columns.forEach((c) => {
      doc.text(c.header, x + 6, y + padV, { width: c.width - 10, align: c.align || "left" });
      x += c.width;
    });
    doc.y = y + h;
    doc.x = PAGE_MARGIN;
  }

  function ensureSpace(need) {
    const bottom = doc.page.height - doc.page.margins.bottom;
    if (doc.y + need > bottom) {
      doc.addPage();
      doc.x = PAGE_MARGIN;
      drawHeader();
    }
  }

  drawHeader();
  doc.font("Helvetica").fontSize(9).fillColor(INK_COLOR);
  rows.forEach((row) => {
    const h = rowNeededHeight(row);
    ensureSpace(h);
    const y = doc.y;
    let x = PAGE_MARGIN;
    row.forEach((val, i) => {
      doc.text(String(val == null ? "" : val), x + 6, y + padV, { width: columns[i].width - 10, align: columns[i].align || "left" });
      x += columns[i].width;
    });
    doc.y = y + h;
    doc.x = PAGE_MARGIN;
    doc.moveTo(PAGE_MARGIN, doc.y).lineTo(PAGE_MARGIN + totalWidth, doc.y).strokeColor(LINE_COLOR).lineWidth(0.5).stroke();
  });

  if (rows.length === 0) {
    ensureSpace(minRowHeight);
    doc.font("Helvetica-Oblique").fontSize(9.5).fillColor(MUTED_COLOR)
      .text(opts.emptyText || "Sin registros.", PAGE_MARGIN + 6, doc.y + padV, { width: totalWidth - 12 });
    doc.y += minRowHeight;
  }
  doc.x = PAGE_MARGIN;
  doc.moveDown(1);
}

module.exports = {
  LOGO_PATH,
  BRAND_COLOR,
  MUTED_COLOR,
  INK_COLOR,
  HEADER_FILL,
  LINE_COLOR,
  PAGE_MARGIN,
  fmtMoneyPdf,
  fmtHorasPdf,
  fmtFecha,
  fmtHora,
  drawBrandHeader,
  drawTable,
};
