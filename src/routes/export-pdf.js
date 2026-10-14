// Exportacion a PDF de la nomina de una quincena: un PDF general con el
// resumen de todos (nomina + asistencia de los que no se les paga), y un
// PDF individual por cada trabajador -- con su recibo de pago si es de un
// tipo pagado, o solo su desglose de horas si es de un tipo que solo lleva
// asistencia (residencias profesionales, sistema dual, o cualquier tipo
// nuevo que se agregue sin pago). Requiere sesion iniciada (se protege al
// montar en server.js), igual que la exportacion a Excel.
//
// El PDF individual (recibo/desglose de un solo trabajador) se dibuja con
// src/pdf-worker-receipt.js, compartido con el Portal del trabajador
// (src/routes/worker-auth.js) -- asi los dos lados siempre muestran
// exactamente el mismo documento.
"use strict";

const express = require("express");
const { quincenaFromId, fmtRangeEs } = require("../periodos");
const { clavesPagadas } = require("../tipos");
const { periodRangeISO, getWorker, nominaRows, nominaRowForWorker, turnosForWorker, asistenciaRows } = require("../nomina-data");
const { PAGE_MARGIN, INK_COLOR, MUTED_COLOR, fmtMoneyPdf, fmtHorasPdf, drawBrandHeader, drawTable } = require("../pdf-common");
const { enviarReciboPdf } = require("../pdf-worker-receipt");
const PDFDocument = require("pdfkit");

const router = express.Router();

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

  let horasTotales;
  let totalPagar = null;
  if (esPagado) {
    const row = await nominaRowForWorker(periodId, workerId);
    horasTotales = row ? row.horas : 0;
    totalPagar = row ? row.total : 0;
  } else {
    horasTotales = turnos.reduce((s, t) => s + (t.horas || 0), 0);
  }

  enviarReciboPdf(res, { worker, esPagado, turnos, horasTotales, totalPagar, periodId, rango });
});

module.exports = router;
