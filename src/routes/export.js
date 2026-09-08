// Exportacion a Excel (.xlsx) de la nomina: una quincena especifica, o el
// historial completo con todas las quincenas que existan en la base de
// datos. Requiere sesion iniciada (se protege al montar en server.js).
//
// Cada quincena se exporta en DOS tablas separadas, porque no todos los
// trabajadores tienen sueldo:
//   - "Nomina": solo trabajadores de tipo "nomina" -- horas totales,
//     tarifa y el salario que les corresponde.
//   - "Asistencia (sin nomina)": trabajadores de "residencias
//     profesionales" y "sistema dual" -- solo su horario (entrada/salida
//     de cada dia), sin ninguna columna de salario, porque no se les paga.
"use strict";

const express = require("express");
const path = require("path");
const fs = require("fs");
const ExcelJS = require("exceljs");
const { db } = require("../db");
const { quincenaFromId, fmtRangeEs } = require("../periodos");

const router = express.Router();

const LOGO_PATH = path.join(__dirname, "..", "..", "public", "assets", "logo.png");
const BRAND_COLOR = "FF123D38"; // ARGB
const HEADER_FILL = "FFEAE6D9";

const TIPO_LABEL = {
  nomina: "Nomina",
  residencias: "Residencias profesionales",
  dual: "Sistema dual",
};

function periodRangeISO(periodId) {
  const q = quincenaFromId(periodId);
  if (!q) return null;
  return { startISO: `${q.inicio}T00:00:00.000Z`, endISO: `${q.fin}T23:59:59.999Z` };
}

/* --------------------------- Filas: nomina (con sueldo) --------------------------- */
async function nominaRows(periodId) {
  const workersRes = await db.execute(`SELECT * FROM workers WHERE tipo = 'nomina' ORDER BY orden ASC`);
  const entriesRes = await db.execute({
    sql: `SELECT worker_id, horas_normales FROM nomina_entries WHERE periodo_id = ?`,
    args: [periodId],
  });
  const entryMap = {};
  entriesRes.rows.forEach((e) => (entryMap[e.worker_id] = e));

  // Incluye a todos los trabajadores activos de tipo "nomina", mas
  // cualquiera dado de baja que aun tenga horas capturadas en esta
  // quincena (para no perder su registro historico).
  const rows = [];
  workersRes.rows.forEach((w) => {
    const e = entryMap[w.id];
    if (w.activo || e) {
      const hn = e ? e.horas_normales : 0;
      rows.push({
        nombre: w.nombre,
        idEmpleado: w.id_empleado || "",
        puesto: w.puesto || "",
        horas: hn,
        tarifa: w.tarifa_normal,
        total: hn * w.tarifa_normal,
        activo: !!w.activo,
      });
    }
  });
  return rows;
}

/* ------------------------ Filas: asistencia (sin sueldo) ------------------------ */
async function asistenciaRows(periodId) {
  const range = periodRangeISO(periodId);
  if (!range) return [];
  const workersRes = await db.execute(`SELECT * FROM workers WHERE tipo != 'nomina'`);
  const workerMap = {};
  workersRes.rows.forEach((w) => (workerMap[w.id] = w));
  if (workersRes.rows.length === 0) return [];

  const turnosRes = await db.execute({
    sql: `SELECT * FROM turnos WHERE entrada >= ? AND entrada <= ? ORDER BY worker_id ASC, entrada ASC`,
    args: [range.startISO, range.endISO],
  });

  const rows = [];
  turnosRes.rows.forEach((t) => {
    const w = workerMap[t.worker_id];
    if (!w) return; // es de tipo "nomina", o el trabajador ya no existe
    rows.push({
      nombre: w.nombre,
      idEmpleado: w.id_empleado || "",
      puesto: w.puesto || "",
      tipo: TIPO_LABEL[w.tipo] || w.tipo,
      entrada: t.entrada,
      salida: t.salida,
      horas: t.horas,
    });
  });
  // Ordena por nombre del trabajador y despues por fecha de entrada.
  rows.sort((a, b) => (a.nombre === b.nombre ? (a.entrada < b.entrada ? -1 : 1) : a.nombre.localeCompare(b.nombre, "es")));
  return rows;
}

function addBrandHeader(sheet, titulo, subtitle) {
  sheet.mergeCells("A1:B4");
  if (fs.existsSync(LOGO_PATH)) {
    const imgId = sheet.workbook.addImage({ filename: LOGO_PATH, extension: "png" });
    sheet.addImage(imgId, { tl: { col: 0.15, row: 0.15 }, ext: { width: 64, height: 64 } });
  }
  sheet.mergeCells("C1:H1");
  sheet.getCell("C1").value = "YES EMS";
  sheet.getCell("C1").font = { bold: true, size: 16, color: { argb: BRAND_COLOR } };
  sheet.mergeCells("C2:H2");
  sheet.getCell("C2").value = "Centro de Capacitacion y Servicios Educativos";
  sheet.getCell("C2").font = { italic: true, size: 10, color: { argb: "FF5E6E69" } };
  sheet.mergeCells("C3:H3");
  sheet.getCell("C3").value = titulo;
  sheet.getCell("C3").font = { bold: true, size: 11 };
  sheet.mergeCells("C4:H4");
  sheet.getCell("C4").value = subtitle;
  sheet.getCell("C4").font = { size: 10, color: { argb: "FF5E6E69" } };
  sheet.getRow(5).values = [];
}

const NOMINA_COLUMNS = [
  { header: "Trabajador", width: 26 },
  { header: "No. empleado", width: 13 },
  { header: "Puesto", width: 22 },
  { header: "Horas totales", width: 14 },
  { header: "Tarifa/hora", width: 13 },
  { header: "Total a pagar", width: 15 },
];

const ASISTENCIA_COLUMNS = [
  { header: "Trabajador", width: 26 },
  { header: "No. empleado", width: 13 },
  { header: "Puesto", width: 20 },
  { header: "Tipo", width: 22 },
  { header: "Fecha", width: 13 },
  { header: "Entrada", width: 11 },
  { header: "Salida", width: 11 },
  { header: "Horas", width: 10 },
];

function writeHeaderRow(sheet, columns, startRow) {
  const headerRow = sheet.getRow(startRow);
  columns.forEach((c, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = c.header;
    cell.font = { bold: true, color: { argb: "FF1B2926" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_FILL } };
    cell.border = { bottom: { style: "thin", color: { argb: "FFDEDACB" } } };
    sheet.getColumn(i + 1).width = c.width;
  });
  headerRow.commit();
}

function writeNominaTable(sheet, rows, startRow) {
  writeHeaderRow(sheet, NOMINA_COLUMNS, startRow);

  let r = startRow + 1;
  let totalPago = 0;
  rows.forEach((row) => {
    const excelRow = sheet.getRow(r);
    excelRow.getCell(1).value = row.nombre + (row.activo ? "" : " (baja)");
    excelRow.getCell(2).value = row.idEmpleado;
    excelRow.getCell(3).value = row.puesto;
    excelRow.getCell(4).value = row.horas;
    excelRow.getCell(4).numFmt = "0.00";
    excelRow.getCell(5).value = row.tarifa;
    excelRow.getCell(6).value = row.total;
    [5, 6].forEach((c) => (excelRow.getCell(c).numFmt = '"$"#,##0.00'));
    totalPago += row.total;
    r++;
  });

  const totalRow = sheet.getRow(r);
  totalRow.getCell(1).value = "Total de la quincena";
  totalRow.getCell(1).font = { bold: true };
  sheet.mergeCells(`A${r}:E${r}`);
  totalRow.getCell(6).value = totalPago;
  totalRow.getCell(6).numFmt = '"$"#,##0.00';
  totalRow.getCell(6).font = { bold: true };
  totalRow.getCell(6).border = { top: { style: "thin", color: { argb: "FFDEDACB" } } };

  return { lastRow: r, totalPago };
}

function fmtFecha(d) {
  return d.toLocaleDateString("es-MX", { day: "2-digit", month: "2-digit", year: "numeric" });
}
function fmtHora(d) {
  return d.toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" });
}

function writeAsistenciaTable(sheet, rows, startRow) {
  writeHeaderRow(sheet, ASISTENCIA_COLUMNS, startRow);

  let r = startRow + 1;
  rows.forEach((row) => {
    const excelRow = sheet.getRow(r);
    const entradaD = new Date(row.entrada);
    const salidaD = row.salida ? new Date(row.salida) : null;
    excelRow.getCell(1).value = row.nombre;
    excelRow.getCell(2).value = row.idEmpleado;
    excelRow.getCell(3).value = row.puesto;
    excelRow.getCell(4).value = row.tipo;
    excelRow.getCell(5).value = fmtFecha(entradaD);
    excelRow.getCell(6).value = fmtHora(entradaD);
    excelRow.getCell(7).value = salidaD ? fmtHora(salidaD) : "Turno abierto";
    excelRow.getCell(8).value = row.horas != null ? row.horas : "";
    if (row.horas != null) excelRow.getCell(8).numFmt = "0.00";
    r++;
  });

  return r;
}

async function buildPeriodSheets(workbook, periodId, opts) {
  opts = opts || {};
  const q = quincenaFromId(periodId);
  const rango = q ? fmtRangeEs(periodId) : periodId;

  const nomRows = await nominaRows(periodId);
  const nomSheet = workbook.addWorksheet(opts.nominaSheetName || "Nomina", {
    pageSetup: { orientation: "landscape", fitToPage: true },
  });
  addBrandHeader(nomSheet, "Nomina quincenal", rango);
  let totalPago = 0;
  if (nomRows.length === 0) {
    nomSheet.getCell(6, 1).value = "Sin trabajadores de nomina, o sin horas capturadas en esta quincena.";
    nomSheet.getCell(6, 1).font = { italic: true, color: { argb: "FF5E6E69" } };
  } else {
    const res = writeNominaTable(nomSheet, nomRows, 6);
    totalPago = res.totalPago;
  }

  const asisRows = await asistenciaRows(periodId);
  const asisSheet = workbook.addWorksheet(opts.asistenciaSheetName || "Asistencia (sin nomina)", {
    pageSetup: { orientation: "landscape", fitToPage: true },
  });
  addBrandHeader(asisSheet, "Asistencia (residencias profesionales y sistema dual)", rango);
  if (asisRows.length === 0) {
    asisSheet.getCell(6, 1).value = "Sin registros de asistencia para este tipo de trabajador en esta quincena.";
    asisSheet.getCell(6, 1).font = { italic: true, color: { argb: "FF5E6E69" } };
  } else {
    writeAsistenciaTable(asisSheet, asisRows, 6);
  }

  return { totalPago };
}

router.get("/export/periodo/:id.xlsx", async (req, res) => {
  const periodId = req.params.id;
  if (!quincenaFromId(periodId)) return res.status(400).json({ error: "Periodo invalido." });

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "YES EMS";
  workbook.created = new Date();
  await buildPeriodSheets(workbook, periodId, { nominaSheetName: "Nomina", asistenciaSheetName: "Asistencia (sin nomina)" });

  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="nomina-yesems-${periodId}.xlsx"`);
  await workbook.xlsx.write(res);
  res.end();
});

router.get("/export/historial.xlsx", async (req, res) => {
  const { rows: periodos } = await db.execute(`SELECT id FROM periodos ORDER BY id ASC`);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "YES EMS";
  workbook.created = new Date();

  const resumen = workbook.addWorksheet("Resumen", { pageSetup: { orientation: "landscape" } });
  addBrandHeader(resumen, "Historial de quincenas", "Solo se paga a los trabajadores de nomina");
  resumen.getRow(6).values = ["Quincena", "Periodo", "Estado", "Total pagado (nomina)"];
  resumen.getRow(6).font = { bold: true };
  resumen.getRow(6).eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_FILL } };
  });
  resumen.getColumn(1).width = 14;
  resumen.getColumn(2).width = 28;
  resumen.getColumn(3).width = 14;
  resumen.getColumn(4).width = 18;

  let r = 7;
  for (const p of periodos) {
    const { rows: periodoRowRes } = await db.execute({
      sql: `SELECT cerrada FROM periodos WHERE id = ?`,
      args: [p.id],
    });
    const periodoRow = periodoRowRes[0];

    // Los nombres de hoja en Excel tienen que ser unicos y de max 31
    // caracteres, y no pueden repetirse entre quincenas -- por eso cada
    // par de hojas del historial se nombra con el id de la quincena.
    const { totalPago } = await buildPeriodSheets(workbook, p.id, {
      nominaSheetName: `${p.id} Nomina`,
      asistenciaSheetName: `${p.id} Asistencia`,
    });

    resumen.getRow(r).values = [
      p.id,
      fmtRangeEs(p.id),
      periodoRow && periodoRow.cerrada ? "Pagada" : "Abierta",
      totalPago,
    ];
    resumen.getCell(r, 4).numFmt = '"$"#,##0.00';
    r++;
  }

  if (periodos.length === 0) {
    resumen.getCell(7, 1).value = "Aun no hay quincenas registradas.";
    resumen.getCell(7, 1).font = { italic: true };
  }

  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="nomina-yesems-historial.xlsx"`);
  await workbook.xlsx.write(res);
  res.end();
});

module.exports = router;
