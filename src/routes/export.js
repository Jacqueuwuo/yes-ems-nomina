// Exportacion a Excel (.xlsx) de la nomina: una quincena especifica, o el
// historial completo con todas las quincenas que existan en la base de
// datos. Requiere sesion iniciada (se protege al montar en server.js).
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

async function periodoRows(periodId) {
  const workersRes = await db.execute(`SELECT * FROM workers ORDER BY orden ASC`);
  const entriesRes = await db.execute({
    sql: `SELECT worker_id, horas_normales, horas_extra FROM nomina_entries WHERE periodo_id = ?`,
    args: [periodId],
  });
  const workers = workersRes.rows;
  const entryMap = {};
  entriesRes.rows.forEach((e) => (entryMap[e.worker_id] = e));

  // Incluye a todos los trabajadores activos, mas cualquier trabajador
  // dado de baja que aun tenga horas capturadas en esta quincena.
  const rows = [];
  workers.forEach((w) => {
    const e = entryMap[w.id];
    if (w.activo || e) {
      const hn = e ? e.horas_normales : 0;
      const he = e ? e.horas_extra : 0;
      rows.push({
        nombre: w.nombre,
        puesto: w.puesto || "",
        horasNormales: hn,
        tarifaNormal: w.tarifa_normal,
        horasExtra: he,
        tarifaExtra: w.tarifa_extra,
        total: hn * w.tarifa_normal + he * w.tarifa_extra,
        activo: !!w.activo,
      });
    }
  });
  return rows;
}

function addBrandHeader(sheet, subtitle) {
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
  sheet.getCell("C3").value = "Nomina quincenal";
  sheet.getCell("C3").font = { bold: true, size: 11 };
  sheet.mergeCells("C4:H4");
  sheet.getCell("C4").value = subtitle;
  sheet.getCell("C4").font = { size: 10, color: { argb: "FF5E6E69" } };
  sheet.getRow(5).values = [];
}

const COLUMNS = [
  { header: "Trabajador", key: "nombre", width: 26 },
  { header: "Puesto", key: "puesto", width: 22 },
  { header: "Horas normales", key: "horasNormales", width: 15 },
  { header: "Tarifa normal", key: "tarifaNormal", width: 14 },
  { header: "Horas extra", key: "horasExtra", width: 13 },
  { header: "Tarifa extra", key: "tarifaExtra", width: 13 },
  { header: "Total a pagar", key: "total", width: 15 },
];

function writeTable(sheet, rows, startRow) {
  const headerRow = sheet.getRow(startRow);
  COLUMNS.forEach((c, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = c.header;
    cell.font = { bold: true, color: { argb: "FF1B2926" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_FILL } };
    cell.border = { bottom: { style: "thin", color: { argb: "FFDEDACB" } } };
    sheet.getColumn(i + 1).width = c.width;
  });
  headerRow.commit();

  let r = startRow + 1;
  let totalPago = 0;
  rows.forEach((row) => {
    const excelRow = sheet.getRow(r);
    excelRow.getCell(1).value = row.nombre + (row.activo ? "" : " (baja)");
    excelRow.getCell(2).value = row.puesto;
    excelRow.getCell(3).value = row.horasNormales;
    excelRow.getCell(4).value = row.tarifaNormal;
    excelRow.getCell(5).value = row.horasExtra;
    excelRow.getCell(6).value = row.tarifaExtra;
    excelRow.getCell(7).value = row.total;
    [4, 6, 7].forEach((c) => (excelRow.getCell(c).numFmt = '"$"#,##0.00'));
    totalPago += row.total;
    r++;
  });

  const totalRow = sheet.getRow(r);
  totalRow.getCell(1).value = "Total de la quincena";
  totalRow.getCell(1).font = { bold: true };
  sheet.mergeCells(`A${r}:F${r}`);
  totalRow.getCell(7).value = totalPago;
  totalRow.getCell(7).numFmt = '"$"#,##0.00';
  totalRow.getCell(7).font = { bold: true };
  totalRow.getCell(7).border = { top: { style: "thin", color: { argb: "FFDEDACB" } } };

  return r;
}

async function buildPeriodSheet(workbook, periodId, sheetName) {
  const q = quincenaFromId(periodId);
  const sheet = workbook.addWorksheet(sheetName || periodId, {
    pageSetup: { orientation: "landscape", fitToPage: true },
  });
  addBrandHeader(sheet, q ? fmtRangeEs(periodId) : periodId);
  const rows = await periodoRows(periodId);
  if (rows.length === 0) {
    sheet.getCell(6, 1).value = "Sin trabajadores o sin horas capturadas en esta quincena.";
    sheet.getCell(6, 1).font = { italic: true, color: { argb: "FF5E6E69" } };
    return sheet;
  }
  writeTable(sheet, rows, 6);
  return sheet;
}

router.get("/export/periodo/:id.xlsx", async (req, res) => {
  const periodId = req.params.id;
  if (!quincenaFromId(periodId)) return res.status(400).json({ error: "Periodo invalido." });

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "YES EMS";
  workbook.created = new Date();
  await buildPeriodSheet(workbook, periodId, "Nomina");

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
  addBrandHeader(resumen, "Historial de quincenas");
  resumen.getRow(6).values = ["Quincena", "Periodo", "Estado", "Total pagado"];
  resumen.getRow(6).font = { bold: true };
  resumen.getRow(6).eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_FILL } };
  });
  resumen.getColumn(1).width = 14;
  resumen.getColumn(2).width = 28;
  resumen.getColumn(3).width = 14;
  resumen.getColumn(4).width = 16;

  let r = 7;
  for (const p of periodos) {
    const rows = await periodoRows(p.id);
    const total = rows.reduce((sum, row) => sum + row.total, 0);
    const { rows: periodoRowRes } = await db.execute({
      sql: `SELECT cerrada FROM periodos WHERE id = ?`,
      args: [p.id],
    });
    const periodoRow = periodoRowRes[0];
    resumen.getRow(r).values = [
      p.id,
      fmtRangeEs(p.id),
      periodoRow && periodoRow.cerrada ? "Pagada" : "Abierta",
      total,
    ];
    resumen.getCell(r, 4).numFmt = '"$"#,##0.00';
    r++;
    await buildPeriodSheet(workbook, p.id, p.id);
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
