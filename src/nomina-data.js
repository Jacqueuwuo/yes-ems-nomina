// Helpers compartidos para armar los datos de una quincena (nomina de los
// trabajadores pagados, y asistencia de los que no se les paga), usados
// tanto por la exportacion a Excel (src/routes/export.js) como por la
// exportacion a PDF (src/routes/export-pdf.js) -- para que ambas siempre
// muestren exactamente los mismos numeros, calculados en un solo lugar.
"use strict";

const { db } = require("./db");
const { quincenaFromId } = require("./periodos");
const { tiposMap, clavesPagadas } = require("./tipos");

function periodRangeISO(periodId) {
  const q = quincenaFromId(periodId);
  if (!q) return null;
  return { startISO: `${q.inicio}T00:00:00.000Z`, endISO: `${q.fin}T23:59:59.999Z` };
}

async function getWorker(workerId) {
  const { rows } = await db.execute({ sql: `SELECT * FROM workers WHERE id = ?`, args: [workerId] });
  return rows[0] || null;
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

  // Incluye a todos los trabajadores activos de tipo pagado, mas cualquiera
  // dado de baja que aun tenga horas capturadas en esta quincena (para no
  // perder su registro historico).
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

async function nominaRowForWorker(periodId, workerId) {
  const rows = await nominaRows(periodId);
  return rows.find((r) => String(r.id) === String(workerId)) || null;
}

/* ---------------- Turnos de UN trabajador (para su detalle individual) ---------------- */
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
    if (!w) return; // es de tipo pagado, o el trabajador ya no existe
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

module.exports = {
  periodRangeISO,
  getWorker,
  nominaRows,
  nominaRowForWorker,
  turnosForWorker,
  asistenciaRows,
};
