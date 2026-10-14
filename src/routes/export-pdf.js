// Exportacion a PDF de la nomina de una quincena: un PDF general con el
// resumen de todos (nomina + asistencia de los que no se les paga), y un
// PDF individual por cada trabajador -- con su recibo de pago si es de un
// tipo pagado, o solo su desglose de horas si es de un tipo que solo lleva
// asistencia (residencias profesionales, sistema dual, o cualquier tipo
// nuevo que se agregue sin pago). Requiere sesion iniciada (se protege al
// montar en server.js), igual que la exportacion a Excel.
"use strict";

const express = require("express");
const path = require("path");
const fs = require("fs");
const PDFDocument = require("pdfkit");
const { db } = require("../db");
const { quincenaFromId, fmtRangeEs } = require("../periodos");
const { clavesPagadas } = require("../tipos");
const { periodRangeISO, getWorker, nominaRows, nominaRowForWorker, turnosForWorker, asistenciaRows } = require("../nomina-data");

const router = express.Router();

const LOGO_PATH = path.join(__dirname, "..", "..", "public", "assets", "logo.png");
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
// columns: [{ header, width, align, money, hours }]
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

/* ---------------------------- PDF general (resumen) ---------------------------- */
router.get("/export/periodo/:id/resumen.pdf", async (req, res) => {
  const periodId = req.params.id;
  const q = quincenaFromId(periodId);
  if (!q) return res.status(400).json({ error: "Periodo invalido." });
  const rango = fmtRangeEs(periodId);

  const nomRows = await nominaRows(periodId);
  const asisRows = await asistenciaRows(periodId);

  // Para la tabla de asistencia, el resumen general muestra el total de
  // horas por persona (no cada entrada/salida individual, que ya se puede
  // ver con detalle en su PDF individual) -- asi el resumen se queda
  // compacto aunque alguien marque varias veces al dia.
  const asisPorTrabajador = {};
  const ordenAsis = [];
  asisRows.forEach((r) => {
    if (!asisPorTrabajador[r.nombre]) {
      asisPorTrabajador[r.nombre] = { nombre: r.nombre, idEmpleado: r.idEmpleado, puesto: r.puesto, tipo: r.tipo, horas: 0 };
      ordenAsis.push(r.nombre);
    }
    asisPorTrabajador[r.nombre].horas += r.horas || 0;
  });

  const doc = new PDFDocument({ size: "letter", margins: { top: PAGE_MARGIN, bottom: PAGE_MARGIN, left: PAGE_MARGIN, right: PAGE_MARGIN } });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="resumen-nomina-yesems-${periodId}.pdf"`);
  doc.pipe(res);

  drawBrandHeader(doc, "Resumen de nómina quincenal", rango);

  doc.font("Helvetica-Bold").fontSize(11).fillColor(INK_COLOR).text("Nómina");
  doc.moveDown(0.3);
  let totalPago = 0;
  const nomColumns = [
    { header: "Trabajador", width: 158 },
    { header: "No. empleado", width: 72, align: "center" },
    { header: "Puesto", width: 110 },
    { header: "Horas", width: 62, align: "right" },
    { header: "Tarifa/h", width: 62, align: "right" },
    { header: "Total", width: 68, align: "right" },
  ];
  const nomTableRows = nomRows.map((r) => {
    totalPago += r.total;
    return [
      r.nombre + (r.activo ? "" : " (baja)"),
      r.idEmpleado || "—",
      r.puesto || "—",
      fmtHorasPdf(r.horas),
      fmtMoneyPdf(r.tarifa),
      fmtMoneyPdf(r.total),
    ];
  });
  drawTable(doc, nomColumns, nomTableRows, { emptyText: "Sin trabajadores de nómina, o sin horas capturadas en esta quincena." });

  doc.font("Helvetica-Bold").fontSize(10.5).fillColor(INK_COLOR)
    .text(`Total de la quincena: ${fmtMoneyPdf(totalPago)}`, { align: "right" });
  doc.moveDown(1.2);

  doc.font("Helvetica-Bold").fontSize(11).fillColor(INK_COLOR).text("Asistencia (trabajadores sin nómina)");
  doc.moveDown(0.3);
  const asisColumns = [
    { header: "Trabajador", width: 160 },
    { header: "No. empleado", width: 78, align: "center" },
    { header: "Puesto", width: 112 },
    { header: "Tipo", width: 110 },
    { header: "Horas totales", width: 72, align: "right" },
  ];
  const asisTableRows = ordenAsis.map((nombre) => {
    const r = asisPorTrabajador[nombre];
    return [r.nombre, r.idEmpleado || "—", r.puesto || "—", r.tipo, fmtHorasPdf(r.horas)];
  });
  drawTable(doc, asisColumns, asisTableRows, {
    emptyText: "Sin registros de asistencia para este tipo de trabajador en esta quincena.",
  });

  doc.font("Helvetica").fontSize(8).fillColor(MUTED_COLOR)
    .text(`Generado el ${new Date().toLocaleDateString("es-MX", { day: "numeric", month: "long", year: "numeric" })}.`, { align: "right" });

  doc.end();
});

/* ------------------------------ PDF individual ------------------------------ */
router.get("/export/periodo/:id/trabajador/:workerId.pdf", async (req, res) => {
  const periodId = req.params.id;
  const q = quincenaFromId(periodId);
  if (!q) return res.status(400).json({ error: "Periodo invalido." });
  const workerId = Number(req.params.workerId);

  const worker = await getWorker(workerId);
  if (!worker) return res.status(404).json({ error: "Trabajador no encontrado." });

  const pagadas = await clavesPagadas();
  const esPagado = pagadas.includes(worker.tipo);
  const range = periodRangeISO(periodId);
  const turnos = range ? await turnosForWorker(workerId, range) : [];
  const rango = fmtRangeEs(periodId);

  const doc = new PDFDocument({ size: "letter", margins: { top: PAGE_MARGIN, bottom: PAGE_MARGIN, left: PAGE_MARGIN, right: PAGE_MARGIN } });
  const nombreArchivo = String(worker.nombre || "trabajador").normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase().slice(0, 40) || "trabajador";
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${esPagado ? "nomina" : "asistencia"}-${nombreArchivo}-${periodId}.pdf"`
  );
  doc.pipe(res);

  drawBrandHeader(doc, esPagado ? "Recibo de nómina individual" : "Desglose de horas trabajadas", worker.nombre + " — " + rango);

  doc.font("Helvetica-Bold").fontSize(9.5).fillColor(INK_COLOR);
  const infoY = doc.y;
  doc.text("Puesto:", PAGE_MARGIN, infoY, { continued: true, width: 400 }).font("Helvetica").text(" " + (worker.puesto || "—"));
  doc.font("Helvetica-Bold").text("No. de empleado:", PAGE_MARGIN, doc.y, { continued: true }).font("Helvetica").text(" " + (worker.id_empleado || "—"));
  if (esPagado) {
    doc.font("Helvetica-Bold").text("Tarifa por hora:", PAGE_MARGIN, doc.y, { continued: true }).font("Helvetica").text(" " + fmtMoneyPdf(worker.tarifa_normal));
  }
  doc.moveDown(1);

  doc.font("Helvetica-Bold").fontSize(11).fillColor(INK_COLOR).text("Entradas y salidas de la quincena");
  doc.moveDown(0.3);
  const columns = [
    { header: "Fecha", width: 110 },
    { header: "Entrada", width: 100, align: "center" },
    { header: "Salida", width: 130, align: "center" },
    { header: "Horas", width: 90, align: "right" },
  ];
  const tableRows = turnos.map((t) => {
    const entradaD = new Date(t.entrada);
    const salidaD = t.salida ? new Date(t.salida) : null;
    return [
      fmtFecha(entradaD),
      fmtHora(entradaD),
      salidaD ? fmtHora(salidaD) : "Turno abierto",
      t.horas != null ? fmtHorasPdf(t.horas) : "—",
    ];
  });
  drawTable(doc, columns, tableRows, { emptyText: "Sin registros de entrada/salida en esta quincena." });

  let horasTotales;
  let totalPagar = null;
  if (esPagado) {
    const row = await nominaRowForWorker(periodId, workerId);
    horasTotales = row ? row.horas : 0;
    totalPagar = row ? row.total : 0;
  } else {
    horasTotales = turnos.reduce((s, t) => s + (t.horas || 0), 0);
  }

  doc.font("Helvetica-Bold").fontSize(10.5).fillColor(INK_COLOR)
    .text(`Horas ${esPagado ? "capturadas en nómina" : "trabajadas"}: ${fmtHorasPdf(horasTotales)}`, { align: "right" });
  if (esPagado) {
    doc.moveDown(0.2);
    doc.fontSize(12.5).text(`Total a pagar: ${fmtMoneyPdf(totalPagar)}`, { align: "right" });
  }
  doc.moveDown(1);
  doc.font("Helvetica").fontSize(8).fillColor(MUTED_COLOR)
    .text(`Generado el ${new Date().toLocaleDateString("es-MX", { day: "numeric", month: "long", year: "numeric" })}.`, { align: "right" });

  doc.end();
});

module.exports = router;
