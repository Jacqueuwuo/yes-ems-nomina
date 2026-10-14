// Genera el PDF individual de UN trabajador para UNA quincena: su recibo
// de nomina si es de un tipo pagado, o solo su desglose de horas si es de
// un tipo que solo lleva asistencia. Esta pieza esta separada de
// src/routes/export-pdf.js para que el panel de administracion (que puede
// pedir el PDF de cualquier trabajador) y el Portal del trabajador (que
// solo puede pedir el PDF de SI MISMO, resuelto desde su propia sesion,
// nunca desde un id que mande el navegador) compartan exactamente el
// mismo PDF -- no dos versiones que con el tiempo podrian ir
// desacomodandose.
"use strict";

const PDFDocument = require("pdfkit");
const {
  PAGE_MARGIN,
  INK_COLOR,
  MUTED_COLOR,
  fmtMoneyPdf,
  fmtHorasPdf,
  fmtFecha,
  fmtHora,
  drawBrandHeader,
  drawTable,
} = require("./pdf-common");

function nombreArchivoSeguro(nombre) {
  return (
    String(nombre || "trabajador")
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase()
      .slice(0, 40) || "trabajador"
  );
}

// worker: fila de la tabla workers (nombre, puesto, id_empleado, tarifa_normal, tipo, ...).
// esPagado: boolean (segun tipos_trabajador.pagado para worker.tipo).
// turnos: arreglo de filas de turnos (entrada, salida, horas) ya filtradas a la quincena.
// horasTotales / totalPagar: ya resueltos por quien llama (de nomina_entries si es pagado,
//   o la suma de turnos si no).
// periodId, rango: id de la quincena ("2026-Q1-02" por ejemplo) y su texto "DD de mes - DD de mes".
function enviarReciboPdf(res, { worker, esPagado, turnos, horasTotales, totalPagar, periodId, rango }) {
  const doc = new PDFDocument({ size: "letter", margins: { top: PAGE_MARGIN, bottom: PAGE_MARGIN, left: PAGE_MARGIN, right: PAGE_MARGIN } });
  const nombreArchivo = nombreArchivoSeguro(worker.nombre);
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
}

module.exports = { enviarReciboPdf };
