// Exportacion a Excel (.xlsx) de la nomina: una quincena especifica, o el
// historial completo con todas las quincenas que existan en la base de
// datos. Requiere sesion iniciada (se protege al montar en server.js).
//
// El Excel de UNA quincena especifica (/export/periodo/:id.xlsx) trae:
//   - "Nomina": resumen de todos los trabajadores de tipo "nomina" -- horas
//     totales, tarifa y el salario que les corresponde.
//   - Una hoja POR CADA trabajador de nomina, con su detalle de entradas y
//     salidas de esa quincena (para poder revisar de donde sale su pago).
//   - "Asistencia (sin nomina)": UNA sola hoja combinada con el horario de
//     los trabajadores de los tipos "solo asistencia" (residencias
//     profesionales, sistema dual y cualquier tipo nuevo que se agregue
//     sin pago), sin ninguna columna de salario porque no se les paga.
// El Excel de historial (/export/historial.xlsx) solo trae el resumen y la
// asistencia combinada de cada quincena (sin hoja por persona), para que
// el archivo no crezca sin control al acumular muchas quincenas.
"use strict";

const express = require("express");
const path = require("path");
const fs = require("fs");
const ExcelJS = require("exceljs");
const { db } = require("../db");
const { quincenaFromId, fmtRangeEs, quincenasEnRango, parsePeriodIds } = require("../periodos");
const { tiposMap, clavesPagadas } = require("../tipos");

const router = express.Router();

const LOGO_PATH = path.join(__dirname, "..", "..", "public", "assets", "logo.png");
const BRAND_COLOR = "FF123D38"; // ARGB
const HEADER_FILL = "FFEAE6D9";

function periodRangeISO(periodId) {
  const q = quincenaFromId(periodId);
  if (!q) return null;
  return { startISO: `${q.inicio}T00:00:00.000Z`, endISO: `${q.fin}T23:59:59.999Z` };
}

/* --------------------------- Filas: nomina (con sueldo) --------------------------- */
async function nominaRows(periodId) {
  const pagadas = await clavesPagadas();
  const workersRes = await db.execute({
    sql: `SELECT * FROM workers WHERE tipo IN (${pagadas.map(() => "?").join(",")}) ORDER BY orden ASC`,
    args: pagadas,
  });
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
        id: w.id,
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

/* ---------------- Turnos de UN trabajador (para su hoja individual) ---------------- */
async function turnosForWorker(workerId, range) {
  const { rows } = await db.execute({
    sql: `SELECT * FROM turnos WHERE worker_id = ? AND entrada >= ? AND entrada <= ? ORDER BY entrada ASC`,
    args: [workerId, range.startISO, range.endISO],
  });
  return rows;
}

/* ------------------------ Filas: asistencia (sin sueldo) ------------------------ */
async function asistenciaRows(periodId) {
  const range = periodRangeISO(periodId);
  if (!range) return [];
  const tipos = await tiposMap();
  const pagadas = await clavesPagadas();
  const workersRes = await db.execute({
    sql: `SELECT * FROM workers WHERE tipo NOT IN (${pagadas.map(() => "?").join(",")})`,
    args: pagadas,
  });
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
      tipo: (tipos[w.tipo] && tipos[w.tipo].nombre) || w.tipo,
      entrada: t.entrada,
      salida: t.salida,
      horas: t.horas,
    });
  });
  // Ordena por nombre del trabajador y despues por fecha de entrada.
  rows.sort((a, b) => (a.nombre === b.nombre ? (a.entrada < b.entrada ? -1 : 1) : a.nombre.localeCompare(b.nombre, "es")));
  return rows;
}

// Los nombres de hoja en Excel no pueden llevar : \ / ? * [ ] , tienen que
// medir 31 caracteres o menos, y no pueden repetirse dentro del mismo
// archivo -- estas dos funciones garantizan eso al nombrar cada hoja
// individual con el nombre del trabajador.
function sanitizeSheetName(base) {
  let s = String(base || "").replace(/[\\/?*[\]:]/g, "").trim();
  if (!s) s = "Hoja";
  if (s.length > 31) s = s.slice(0, 31).trim();
  return s;
}
function uniqueSheetName(base, usedNames) {
  const name = sanitizeSheetName(base);
  if (!usedNames.has(name)) {
    usedNames.add(name);
    return name;
  }
  let i = 2;
  while (true) {
    const suffix = ` (${i})`;
    const candidate = name.slice(0, 31 - suffix.length).trim() + suffix;
    if (!usedNames.has(candidate)) {
      usedNames.add(candidate);
      return candidate;
    }
    i++;
  }
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

const WORKER_TURNOS_COLUMNS = [
  { header: "Fecha", width: 13 },
  { header: "Entrada", width: 11 },
  { header: "Salida", width: 11 },
  { header: "Horas", width: 10 },
];

// Hoja individual de un trabajador de nomina: sus datos, el detalle de sus
// entradas/salidas registradas en la quincena, y al final las horas y el
// total que realmente se le va a pagar (el mismo numero que sale en la
// hoja resumen -- el detalle de turnos es solo para que se pueda revisar
// de donde salio ese numero).
function writeWorkerSheet(sheet, row, turnos, rango) {
  addBrandHeader(sheet, "Nomina individual", row.nombre + " -- " + rango);

  sheet.getCell(6, 1).value = "Puesto:";
  sheet.getCell(6, 1).font = { bold: true };
  sheet.getCell(6, 2).value = row.puesto || "--";
  sheet.getCell(7, 1).value = "No. de empleado:";
  sheet.getCell(7, 1).font = { bold: true };
  sheet.getCell(7, 2).value = row.idEmpleado || "--";
  sheet.getCell(8, 1).value = "Tarifa por hora:";
  sheet.getCell(8, 1).font = { bold: true };
  sheet.getCell(8, 2).value = row.tarifa;
  sheet.getCell(8, 2).numFmt = '"$"#,##0.00';

  let r = 10;
  if (turnos.length === 0) {
    sheet.getCell(r, 1).value = "Sin registros de entrada/salida en esta quincena.";
    sheet.getCell(r, 1).font = { italic: true, color: { argb: "FF5E6E69" } };
    r += 2;
  } else {
    writeHeaderRow(sheet, WORKER_TURNOS_COLUMNS, r);
    r += 1;
    turnos.forEach((t) => {
      const entradaD = new Date(t.entrada);
      const salidaD = t.salida ? new Date(t.salida) : null;
      sheet.getCell(r, 1).value = fmtFecha(entradaD);
      sheet.getCell(r, 2).value = fmtHora(entradaD);
      sheet.getCell(r, 3).value = salidaD ? fmtHora(salidaD) : "Turno abierto";
      sheet.getCell(r, 4).value = t.horas != null ? t.horas : "";
      if (t.horas != null) sheet.getCell(r, 4).numFmt = "0.00";
      r++;
    });
    r += 1;
  }

  sheet.getCell(r, 1).value = "Horas capturadas en nomina:";
  sheet.getCell(r, 1).font = { bold: true };
  sheet.getCell(r, 2).value = row.horas;
  sheet.getCell(r, 2).numFmt = "0.00";
  r++;
  sheet.getCell(r, 1).value = "Total a pagar:";
  sheet.getCell(r, 1).font = { bold: true };
  sheet.getCell(r, 2).value = row.total;
  sheet.getCell(r, 2).numFmt = '"$"#,##0.00';
  sheet.getCell(r, 2).font = { bold: true };

  sheet.getColumn(1).width = 26;
  sheet.getColumn(2).width = 13;
  sheet.getColumn(3).width = 13;
  sheet.getColumn(4).width = 12;
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

  // Ademas del resumen, una hoja por cada persona de nomina con el
  // detalle de sus entradas/salidas de la quincena -- solo se activa para
  // el Excel de una quincena especifica (opts.perWorkerSheets), no para el
  // historial completo, porque ahi multiplicaria demasiado el numero de
  // hojas (trabajadores x quincenas).
  if (opts.perWorkerSheets && nomRows.length > 0) {
    const range = periodRangeISO(periodId);
    const usedNames = new Set([
      sanitizeSheetName(opts.nominaSheetName || "Nomina"),
      sanitizeSheetName(opts.asistenciaSheetName || "Asistencia (sin nomina)"),
    ]);
    for (const row of nomRows) {
      const turnos = range ? await turnosForWorker(row.id, range) : [];
      const sheetName = uniqueSheetName(row.nombre, usedNames);
      const workerSheet = workbook.addWorksheet(sheetName, {
        pageSetup: { orientation: "landscape", fitToPage: true },
      });
      writeWorkerSheet(workerSheet, row, turnos, rango);
    }
  }

  const asisRows = await asistenciaRows(periodId);
  const asisSheet = workbook.addWorksheet(opts.asistenciaSheetName || "Asistencia (sin nomina)", {
    pageSetup: { orientation: "landscape", fitToPage: true },
  });
  addBrandHeader(asisSheet, "Asistencia (trabajadores sin nomina)", rango);
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
  await buildPeriodSheets(workbook, periodId, {
    nominaSheetName: "Nomina",
    asistenciaSheetName: "Asistencia (sin nomina)",
    perWorkerSheets: true,
  });

  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="nomina-yesems-${periodId}.xlsx"`);
  await workbook.xlsx.write(res);
  res.end();
});

// Historial de varias quincenas en un solo Excel. Se puede filtrar:
//   ?ids=2026-08-1,2026-08-2   -> solo esas quincenas
//   ?desde=YYYY-MM-DD&hasta=YYYY-MM-DD -> las quincenas de ese rango
//   (sin parametros)           -> todas las quincenas registradas
router.get("/export/historial.xlsx", async (req, res) => {
  const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));
  let periodos;
  let fileSuffix = "";
  let subtitulo = "Solo se paga a los trabajadores de nomina";
  if (req.query.ids) {
    const ids = parsePeriodIds(req.query.ids);
    if (!ids.length) return res.status(400).json({ error: "No se selecciono ninguna quincena valida." });
    if (ids.length > 72) return res.status(400).json({ error: "Demasiadas quincenas (maximo 72 por archivo)." });
    periodos = ids.map((id) => ({ id }));
    fileSuffix = ids.length === 1 ? `-${ids[0]}` : `-${ids[0]}_a_${ids[ids.length - 1]}`;
    subtitulo = `Quincenas seleccionadas: ${ids.length}`;
  } else if (isDate(req.query.desde) && isDate(req.query.hasta)) {
    if (req.query.desde > req.query.hasta) return res.status(400).json({ error: "Rango de fechas invalido." });
    const lista = quincenasEnRango(req.query.desde, req.query.hasta);
    if (lista.length > 72) return res.status(400).json({ error: "Rango demasiado grande (maximo 72 quincenas por archivo)." });
    periodos = lista.map((q) => ({ id: q.id }));
    fileSuffix = `-${req.query.desde}_a_${req.query.hasta}`;
    subtitulo = `Del ${req.query.desde} al ${req.query.hasta}`;
  } else {
    const all = await db.execute(`SELECT id FROM periodos ORDER BY id ASC`);
    periodos = all.rows;
  }

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "YES EMS";
  workbook.created = new Date();

  const resumen = workbook.addWorksheet("Resumen", { pageSetup: { orientation: "landscape" } });
  addBrandHeader(resumen, "Historial de quincenas", subtitulo);
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
  let granTotal = 0;
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
    granTotal += totalPago;
    r++;
  }

  if (periodos.length > 1) {
    resumen.getCell(r, 3).value = "Total";
    resumen.getCell(r, 3).font = { bold: true };
    resumen.getCell(r, 4).value = granTotal;
    resumen.getCell(r, 4).numFmt = '"$"#,##0.00';
    resumen.getCell(r, 4).font = { bold: true };
    resumen.getCell(r, 4).border = { top: { style: "thin", color: { argb: "FFDEDACB" } } };
  }

  if (periodos.length === 0) {
    resumen.getCell(7, 1).value = "No hay quincenas en el rango seleccionado.";
    resumen.getCell(7, 1).font = { italic: true };
  }

  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="nomina-yesems-historial${fileSuffix}.xlsx"`);
  await workbook.xlsx.write(res);
  res.end();
});

module.exports = router;
