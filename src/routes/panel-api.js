// Rutas de los apartados nuevos del panel: Incidencias, Percepciones,
// Deducciones, estatus de pago, el dashboard de "Inicio", el historial de
// "Reportes" y las exportaciones en CSV de Asistencias/Incidencias/
// Personal (la de Nomina ya existia en export.js/export-pdf.js). Todas
// requieren haber iniciado sesion (requireAuth se aplica donde se monta
// este router, en server.js) -- las que CAMBIAN algo ademas requieren
// requireFullAdmin, para que una cuenta de "solo lectura" pueda seguir
// viendo y descargando todo, pero nunca modificar nada.
"use strict";

const express = require("express");
const { db } = require("../db");
const { quincenaFromId, quincenaIdForDate, quincenasEnRango } = require("../periodos");
const { listTipos, tiposMap, clavesPagadas } = require("../tipos");
const { requireFullAdmin } = require("../auth");

const router = express.Router();

// Crea la fila de "periodos" para esta quincena si todavia no existe --
// hace falta antes de poder insertar en nomina_entries (tiene llave
// foranea a periodos). Misma logica que admin-api.js (duplicada aqui a
// proposito para no acoplar los dos routers entre si).
async function ensurePeriodo(periodId) {
  const existing = await db.execute({ sql: `SELECT * FROM periodos WHERE id = ?`, args: [periodId] });
  if (existing.rows.length) return existing.rows[0];
  const q = quincenaFromId(periodId);
  await db.execute({
    sql: `INSERT INTO periodos (id, inicio, fin, cerrada) VALUES (?, ?, ?, 0)`,
    args: [periodId, q.inicio, q.fin],
  });
  const created = await db.execute({ sql: `SELECT * FROM periodos WHERE id = ?`, args: [periodId] });
  return created.rows[0];
}

/* ------------------------------ Incidencias ------------------------------ */
// Retardos, faltas, permisos, justificantes... Son solo un registro para
// llevar el control y el historial: aprobar o rechazar una incidencia aqui
// NO descuenta ni ajusta horas/pago solo -- eso lo sigue decidiendo el
// administrador a mano (por ejemplo, en Asistencias o en Pagos y recibos),
// igual que ya se hacia antes de que existiera este apartado.
const TIPOS_INCIDENCIA = ["retardo", "falta", "permiso", "justificante", "otro"];
const ESTATUS_INCIDENCIA = ["pendiente", "aprobada", "rechazada"];

function toIncidenciaJson(row) {
  return {
    id: row.id,
    workerId: row.worker_id,
    workerNombre: row.worker_nombre || "",
    workerTipo: row.worker_tipo || "",
    tipo: row.tipo,
    descripcion: row.descripcion || "",
    fecha: row.fecha,
    estatus: row.estatus,
    creadoEn: row.creado_en,
    actualizadoEn: row.actualizado_en,
  };
}

router.get("/incidencias", async (req, res) => {
  const where = [];
  const args = [];
  if (req.query.workerId) { where.push("i.worker_id = ?"); args.push(Number(req.query.workerId)); }
  if (req.query.estatus && ESTATUS_INCIDENCIA.includes(req.query.estatus)) { where.push("i.estatus = ?"); args.push(req.query.estatus); }
  if (req.query.tipo && TIPOS_INCIDENCIA.includes(req.query.tipo)) { where.push("i.tipo = ?"); args.push(req.query.tipo); }
  if (req.query.desde && /^\d{4}-\d{2}-\d{2}$/.test(req.query.desde)) { where.push("i.fecha >= ?"); args.push(req.query.desde); }
  if (req.query.hasta && /^\d{4}-\d{2}-\d{2}$/.test(req.query.hasta)) { where.push("i.fecha <= ?"); args.push(req.query.hasta); }
  const sql = `SELECT i.*, w.nombre as worker_nombre, w.tipo as worker_tipo
                 FROM incidencias i JOIN workers w ON w.id = i.worker_id
                ${where.length ? "WHERE " + where.join(" AND ") : ""}
                ORDER BY i.fecha DESC, i.id DESC`;
  const { rows } = await db.execute({ sql, args });
  res.json(rows.map(toIncidenciaJson));
});

async function validateIncidenciaBody(body) {
  const workerId = Number(body && body.workerId);
  const tipo = String((body && body.tipo) || "").trim();
  const descripcion = String((body && body.descripcion) || "").trim();
  const fecha = String((body && body.fecha) || "").trim();
  if (!workerId) return { error: "Selecciona un trabajador." };
  if (!TIPOS_INCIDENCIA.includes(tipo)) return { error: "Tipo de incidencia invalido." };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return { error: "Fecha invalida." };
  if (descripcion.length > 500) return { error: "La descripcion es demasiado larga (maximo 500 caracteres)." };
  const worker = await db.execute({ sql: `SELECT id FROM workers WHERE id = ?`, args: [workerId] });
  if (!worker.rows.length) return { error: "Trabajador no encontrado." };
  return { data: { workerId, tipo, descripcion, fecha } };
}

router.post("/incidencias", requireFullAdmin, async (req, res) => {
  const v = await validateIncidenciaBody(req.body);
  if (v.error) return res.status(400).json({ error: v.error });
  const ahora = new Date().toISOString();
  const result = await db.execute({
    sql: `INSERT INTO incidencias (worker_id, tipo, descripcion, fecha, estatus, creado_en, actualizado_en)
          VALUES (?, ?, ?, ?, 'pendiente', ?, ?)`,
    args: [v.data.workerId, v.data.tipo, v.data.descripcion, v.data.fecha, ahora, ahora],
  });
  const { rows } = await db.execute({
    sql: `SELECT i.*, w.nombre as worker_nombre, w.tipo as worker_tipo FROM incidencias i JOIN workers w ON w.id = i.worker_id WHERE i.id = ?`,
    args: [Number(result.lastInsertRowid)],
  });
  res.status(201).json(toIncidenciaJson(rows[0]));
});

router.put("/incidencias/:id", requireFullAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const existing = await db.execute({ sql: `SELECT id FROM incidencias WHERE id = ?`, args: [id] });
  if (!existing.rows.length) return res.status(404).json({ error: "Incidencia no encontrada." });
  const v = await validateIncidenciaBody(req.body);
  if (v.error) return res.status(400).json({ error: v.error });
  await db.execute({
    sql: `UPDATE incidencias SET worker_id=?, tipo=?, descripcion=?, fecha=?, actualizado_en=? WHERE id=?`,
    args: [v.data.workerId, v.data.tipo, v.data.descripcion, v.data.fecha, new Date().toISOString(), id],
  });
  const { rows } = await db.execute({
    sql: `SELECT i.*, w.nombre as worker_nombre, w.tipo as worker_tipo FROM incidencias i JOIN workers w ON w.id = i.worker_id WHERE i.id = ?`,
    args: [id],
  });
  res.json(toIncidenciaJson(rows[0]));
});

router.put("/incidencias/:id/estatus", requireFullAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const estatus = String((req.body && req.body.estatus) || "");
  if (!ESTATUS_INCIDENCIA.includes(estatus)) return res.status(400).json({ error: "Estatus invalido." });
  const existing = await db.execute({ sql: `SELECT id FROM incidencias WHERE id = ?`, args: [id] });
  if (!existing.rows.length) return res.status(404).json({ error: "Incidencia no encontrada." });
  await db.execute({ sql: `UPDATE incidencias SET estatus=?, actualizado_en=? WHERE id=?`, args: [estatus, new Date().toISOString(), id] });
  res.json({ ok: true });
});

router.delete("/incidencias/:id", requireFullAdmin, async (req, res) => {
  const result = await db.execute({ sql: `DELETE FROM incidencias WHERE id = ?`, args: [Number(req.params.id)] });
  if (Number(result.rowsAffected) === 0) return res.status(404).json({ error: "Incidencia no encontrada." });
  res.json({ ok: true });
});

/* ------------------------ Percepciones / Deducciones ------------------------ */
// Catalogo de referencia: nombre, tipo y a que trabajadores aplica cada
// concepto. Es solo para tenerlos organizados y documentados -- NO se
// suman ni se restan solos del total a pagar (eso sigue siendo horas x
// tarifa, como ya funcionaba).
const CATEGORIAS = ["percepcion", "deduccion"];

function toConceptoJson(row) {
  return {
    id: row.id,
    clave: row.clave,
    concepto: row.concepto,
    categoria: row.categoria,
    tipo: row.tipo || "",
    aplicaA: row.aplica_a === "todas" ? ["todas"] : String(row.aplica_a || "").split(",").filter(Boolean),
    activo: !!row.activo,
  };
}

router.get("/conceptos", async (req, res) => {
  const categoria = String(req.query.categoria || "");
  const where = [];
  const args = [];
  if (CATEGORIAS.includes(categoria)) { where.push("categoria = ?"); args.push(categoria); }
  const { rows } = await db.execute({
    sql: `SELECT * FROM conceptos_nomina ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY orden ASC, id ASC`,
    args,
  });
  res.json(rows.map(toConceptoJson));
});

async function validateConceptoBody(body) {
  const clave = String((body && body.clave) || "").trim().toUpperCase();
  const concepto = String((body && body.concepto) || "").trim();
  const categoria = String((body && body.categoria) || "").trim();
  const tipo = String((body && body.tipo) || "").trim();
  let aplicaA = body && body.aplicaA;
  const activo = body && body.activo === false ? 0 : 1;

  if (!clave) return { error: "Escribe una clave para el concepto." };
  if (clave.length > 20) return { error: "La clave es demasiado larga (maximo 20 caracteres)." };
  if (!concepto) return { error: "Escribe el nombre del concepto." };
  if (concepto.length > 120) return { error: "El nombre es demasiado largo (maximo 120 caracteres)." };
  if (!CATEGORIAS.includes(categoria)) return { error: "Categoria invalida." };
  if (tipo.length > 40) return { error: "El tipo es demasiado largo (maximo 40 caracteres)." };

  if (!Array.isArray(aplicaA) || !aplicaA.length) aplicaA = ["todas"];
  if (aplicaA.includes("todas")) aplicaA = ["todas"];
  else {
    const tipos = await tiposMap();
    for (const t of aplicaA) if (!tipos[t]) return { error: "Uno de los tipos de trabajador seleccionados ya no existe." };
  }

  return { data: { clave, concepto, categoria, tipo, aplicaA: aplicaA.join(","), activo } };
}

router.post("/conceptos", requireFullAdmin, async (req, res) => {
  const v = await validateConceptoBody(req.body);
  if (v.error) return res.status(400).json({ error: v.error });
  const existente = await db.execute({ sql: `SELECT id FROM conceptos_nomina WHERE clave = ?`, args: [v.data.clave] });
  if (existente.rows.length) return res.status(409).json({ error: "Ya existe un concepto con esa clave." });
  const { rows: maxRows } = await db.execute(`SELECT COALESCE(MAX(orden), 0) as m FROM conceptos_nomina`);
  const result = await db.execute({
    sql: `INSERT INTO conceptos_nomina (clave, concepto, categoria, tipo, aplica_a, activo, orden, creado_en)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [v.data.clave, v.data.concepto, v.data.categoria, v.data.tipo, v.data.aplicaA, v.data.activo, Number(maxRows[0].m) + 1, new Date().toISOString()],
  });
  const { rows } = await db.execute({ sql: `SELECT * FROM conceptos_nomina WHERE id = ?`, args: [Number(result.lastInsertRowid)] });
  res.status(201).json(toConceptoJson(rows[0]));
});

router.put("/conceptos/:id", requireFullAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const existing = await db.execute({ sql: `SELECT id FROM conceptos_nomina WHERE id = ?`, args: [id] });
  if (!existing.rows.length) return res.status(404).json({ error: "Concepto no encontrado." });
  const v = await validateConceptoBody(req.body);
  if (v.error) return res.status(400).json({ error: v.error });
  const otra = await db.execute({ sql: `SELECT id FROM conceptos_nomina WHERE clave = ? AND id != ?`, args: [v.data.clave, id] });
  if (otra.rows.length) return res.status(409).json({ error: "Ya existe otro concepto con esa clave." });
  await db.execute({
    sql: `UPDATE conceptos_nomina SET clave=?, concepto=?, categoria=?, tipo=?, aplica_a=?, activo=? WHERE id=?`,
    args: [v.data.clave, v.data.concepto, v.data.categoria, v.data.tipo, v.data.aplicaA, v.data.activo, id],
  });
  const { rows } = await db.execute({ sql: `SELECT * FROM conceptos_nomina WHERE id = ?`, args: [id] });
  res.json(toConceptoJson(rows[0]));
});

router.delete("/conceptos/:id", requireFullAdmin, async (req, res) => {
  const result = await db.execute({ sql: `DELETE FROM conceptos_nomina WHERE id = ?`, args: [Number(req.params.id)] });
  if (Number(result.rowsAffected) === 0) return res.status(404).json({ error: "Concepto no encontrado." });
  res.json({ ok: true });
});

/* --------------------------- Estatus de pago --------------------------- */
// Marca si a un trabajador ya se le genero/entrego el recibo de esa
// quincena ("Pagado") o todavia no ("Pendiente"). Es solo una bandera de
// seguimiento -- no cambia el calculo del total, que sigue siendo horas x
// tarifa.
router.put("/periods/:id/entries/:workerId/pagado", requireFullAdmin, async (req, res) => {
  if (!quincenaFromId(req.params.id)) return res.status(400).json({ error: "Periodo invalido." });
  // Hay que asegurar primero la fila de "periodos" (llave foranea) --
  // si no, insertar una entrada nueva (trabajador sin horas capturadas
  // todavia) fallaba con "FOREIGN KEY constraint failed".
  await ensurePeriodo(req.params.id);
  const workerId = Number(req.params.workerId);
  const pagado = req.body && req.body.pagado ? 1 : 0;
  await db.execute({
    sql: `INSERT INTO nomina_entries (periodo_id, worker_id, horas_normales, horas_extra, pagado)
          VALUES (?, ?, 0, 0, ?)
          ON CONFLICT(periodo_id, worker_id) DO UPDATE SET pagado = excluded.pagado`,
    args: [req.params.id, workerId, pagado],
  });
  res.json({ ok: true });
});

// "Procesar pago": marca como pagados de un solo golpe a todos los
// trabajadores de tipo pagado que tengan horas capturadas (> 0) en esta
// quincena.
router.post("/periods/:id/procesar-pago", requireFullAdmin, async (req, res) => {
  if (!quincenaFromId(req.params.id)) return res.status(400).json({ error: "Periodo invalido." });
  const pagadas = await clavesPagadas();
  const marks = pagadas.map(() => "?").join(",");
  const result = await db.execute({
    sql: `UPDATE nomina_entries SET pagado = 1
            WHERE periodo_id = ? AND horas_normales > 0
              AND worker_id IN (SELECT id FROM workers WHERE tipo IN (${marks}))`,
    args: [req.params.id, ...pagadas],
  });
  res.json({ ok: true, actualizados: Number(result.rowsAffected) });
});

/* --------------------------------- Inicio --------------------------------- */
// Resumen para el dashboard: cuantos trabajadores hay por tipo, como va la
// quincena activa (la de HOY, segun el calendario ya establecido) y las
// alertas que vale la pena mostrar de entrada.
router.get("/dashboard", async (req, res) => {
  const tipos = await listTipos();
  const { rows: porTipoRows } = await db.execute(
    `SELECT tipo, COUNT(*) as c FROM workers WHERE activo = 1 GROUP BY tipo`
  );
  const countMap = {};
  porTipoRows.forEach((r) => (countMap[r.tipo] = Number(r.c)));
  const porTipo = tipos.map((t) => ({ clave: t.clave, nombre: t.nombre, pagado: t.pagado, total: countMap[t.clave] || 0 }));
  const totalPersonal = porTipo.reduce((a, t) => a + t.total, 0);

  const hoy = new Date();
  const periodoId = quincenaIdForDate(hoy);
  const q = quincenaFromId(periodoId);
  const periodoRow = await db.execute({ sql: `SELECT cerrada FROM periodos WHERE id = ?`, args: [periodoId] });
  const cerrada = periodoRow.rows.length ? !!periodoRow.rows[0].cerrada : false;

  const pagadas = await clavesPagadas();
  const marksPagadas = pagadas.map(() => "?").join(",");
  const totalesRes = await db.execute({
    sql: `SELECT SUM(e.horas_normales * w.tarifa_normal) as total, SUM(e.horas_normales) as horas,
                 SUM(CASE WHEN e.horas_normales > 0 THEN 1 ELSE 0 END) as trabajadores
            FROM nomina_entries e JOIN workers w ON w.id = e.worker_id
           WHERE e.periodo_id = ? AND w.tipo IN (${marksPagadas})`,
    args: [periodoId, ...pagadas],
  });
  const tot = totalesRes.rows[0] || {};

  const incidenciasRes = await db.execute(`SELECT COUNT(*) as c FROM incidencias WHERE estatus = 'pendiente'`);
  const incidenciasPendientes = Number(incidenciasRes.rows[0].c) || 0;

  const startISO = `${q.inicio}T00:00:00.000Z`;
  const endISO = `${q.fin}T23:59:59.999Z`;
  const incompletosRes = await db.execute({
    sql: `SELECT COUNT(*) as c FROM turnos WHERE salida IS NULL AND entrada >= ? AND entrada <= ?`,
    args: [startISO, endISO],
  });
  const asistenciasIncompletas = Number(incompletosRes.rows[0].c) || 0;

  const hoyYMD = hoy.toISOString().slice(0, 10);
  const diasRestantes = Math.ceil((new Date(q.fin + "T00:00:00Z") - new Date(hoyYMD + "T00:00:00Z")) / 86400000);
  const periodoProximoACerrar = !cerrada && diasRestantes >= 0 && diasRestantes <= 3;

  res.json({
    personal: { total: totalPersonal, porTipo },
    periodoActivo: {
      id: periodoId,
      inicio: q.inicio,
      fin: q.fin,
      cerrada,
      trabajadores: Number(tot.trabajadores) || 0,
      horas: Number(tot.horas) || 0,
      total: Number(tot.total) || 0,
    },
    alertas: { incidenciasPendientes, periodoProximoACerrar, diasRestantes, asistenciasIncompletas },
  });
});

/* -------------------------------- Reportes -------------------------------- */
router.get("/reportes/recientes", async (req, res) => {
  const { rows } = await db.execute(`SELECT * FROM reportes_log ORDER BY id DESC LIMIT 8`);
  res.json(rows.map((r) => ({ id: r.id, tipo: r.tipo, descripcion: r.descripcion, formato: r.formato, creadoPor: r.creado_por, creadoEn: r.creado_en })));
});

router.post("/reportes/log", async (req, res) => {
  const tipo = String((req.body && req.body.tipo) || "").trim();
  const descripcion = String((req.body && req.body.descripcion) || "").trim();
  const formato = String((req.body && req.body.formato) || "").trim();
  if (!tipo || !descripcion || !formato) return res.status(400).json({ error: "Faltan datos del reporte." });
  let usuario = "";
  if (req.session && req.session.adminId) {
    const { rows } = await db.execute({ sql: `SELECT usuario FROM admins WHERE id = ?`, args: [req.session.adminId] });
    if (rows.length) usuario = rows[0].usuario;
  }
  await db.execute({
    sql: `INSERT INTO reportes_log (tipo, descripcion, formato, creado_por, creado_en) VALUES (?, ?, ?, ?, ?)`,
    args: [tipo, descripcion, formato, usuario, new Date().toISOString()],
  });
  res.status(201).json({ ok: true });
});

/* ------------------------- Exportaciones en CSV ------------------------- */
// Asistencias, Incidencias y Personal no tenian todavia una exportacion
// propia (la de Nomina ya existia como PDF/Excel en export.js y
// export-pdf.js) -- estas se generan como CSV, que abre directo en Excel,
// para el apartado "Reportes".
function csvCell(v) {
  const s = v == null ? "" : String(v);
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
function csvRow(arr) { return arr.map(csvCell).join(",") + "\r\n"; }
function sendCsv(res, filename, header, rows) {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.write("﻿" + csvRow(header));
  rows.forEach((r) => res.write(csvRow(r)));
  res.end();
}

router.get("/export/asistencias.csv", async (req, res) => {
  const start = String(req.query.start || "");
  const end = String(req.query.end || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    return res.status(400).json({ error: "Parametros start/end invalidos (YYYY-MM-DD)." });
  }
  const { rows } = await db.execute({
    sql: `SELECT t.*, w.nombre as worker_nombre, w.tipo as worker_tipo
            FROM turnos t JOIN workers w ON w.id = t.worker_id
           WHERE t.entrada >= ? AND t.entrada <= ? ORDER BY t.entrada ASC`,
    args: [`${start}T00:00:00.000Z`, `${end}T23:59:59.999Z`],
  });
  const tipos = await tiposMap();
  sendCsv(
    res,
    `asistencias_${start}_${end}.csv`,
    ["Trabajador", "Modalidad", "Entrada", "Salida", "Horas", "Estatus"],
    rows.map((r) => [
      r.worker_nombre,
      (tipos[r.worker_tipo] && tipos[r.worker_tipo].nombre) || r.worker_tipo,
      r.entrada,
      r.salida || "",
      r.horas != null ? r.horas : "",
      r.salida ? "Completa" : "Sin registro de salida",
    ])
  );
});

router.get("/export/incidencias.csv", async (req, res) => {
  const where = [];
  const args = [];
  if (req.query.estatus && ESTATUS_INCIDENCIA.includes(req.query.estatus)) { where.push("i.estatus = ?"); args.push(req.query.estatus); }
  if (req.query.desde && /^\d{4}-\d{2}-\d{2}$/.test(req.query.desde)) { where.push("i.fecha >= ?"); args.push(req.query.desde); }
  if (req.query.hasta && /^\d{4}-\d{2}-\d{2}$/.test(req.query.hasta)) { where.push("i.fecha <= ?"); args.push(req.query.hasta); }
  const { rows } = await db.execute({
    sql: `SELECT i.*, w.nombre as worker_nombre FROM incidencias i JOIN workers w ON w.id = i.worker_id
           ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY i.fecha DESC`,
    args,
  });
  sendCsv(
    res,
    "incidencias.csv",
    ["Trabajador", "Tipo", "Descripcion", "Fecha", "Estatus"],
    rows.map((r) => [r.worker_nombre, r.tipo, r.descripcion, r.fecha, r.estatus])
  );
});

router.get("/export/personal.csv", async (req, res) => {
  const { rows } = await db.execute(`SELECT * FROM workers WHERE activo = 1 ORDER BY orden ASC`);
  const tipos = await tiposMap();
  sendCsv(
    res,
    "personal.csv",
    ["No. empleado", "Nombre", "Puesto", "Modalidad", "Tarifa/h", "Correo"],
    rows.map((r) => [
      r.id_empleado,
      r.nombre,
      r.puesto || "",
      (tipos[r.tipo] && tipos[r.tipo].nombre) || r.tipo,
      (tipos[r.tipo] && tipos[r.tipo].pagado) ? r.tarifa_normal : "",
      r.email || "",
    ])
  );
});

module.exports = router;
