// Rutas del panel de administracion: trabajadores, nomina por quincena y
// turnos de asistencia. Todas requieren haber iniciado sesion (el
// middleware requireAuth se aplica donde se monta este router, en
// server.js).
"use strict";

const express = require("express");
const { db } = require("../db");
const { quincenaFromId, hoursBetween, quincenasEnRango } = require("../periodos");
const { listTipos, tiposMap, clavesPagadas, slugify } = require("../tipos");

const router = express.Router();

/* ------------------------------ Trabajadores ------------------------------ */

router.get("/workers", async (req, res) => {
  const { rows } = await db.execute(`SELECT * FROM workers ORDER BY orden ASC`);
  res.json(rows.map(toWorkerJson));
});

router.post("/workers", async (req, res) => {
  const v = await validateWorkerBody(req.body);
  if (v.error) return res.status(400).json({ error: v.error });

  const pinTaken = await db.execute({
    sql: `SELECT id FROM workers WHERE pin = ? AND activo = 1`,
    args: [v.data.pin],
  });
  if (pinTaken.rows.length) {
    return res.status(409).json({ error: "Ese PIN ya lo usa otro trabajador activo." });
  }
  const idTaken = await db.execute({
    sql: `SELECT id FROM workers WHERE id_empleado = ? AND activo = 1`,
    args: [v.data.idEmpleado],
  });
  if (idTaken.rows.length) {
    return res.status(409).json({ error: "Ese numero de empleado ya lo usa otro trabajador activo." });
  }

  const orden = Date.now();
  const creadoEn = new Date().toISOString();
  const result = await db.execute({
    sql: `INSERT INTO workers (nombre, puesto, tarifa_normal, tarifa_extra, id_empleado, pin, tipo, activo, orden, creado_en)
          VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    args: [v.data.nombre, v.data.puesto, v.data.tarifaNormal, v.data.tarifaExtra, v.data.idEmpleado, v.data.pin, v.data.tipo, orden, creadoEn],
  });

  const { rows } = await db.execute({
    sql: `SELECT * FROM workers WHERE id = ?`,
    args: [Number(result.lastInsertRowid)],
  });
  res.status(201).json(toWorkerJson(rows[0]));
});

router.put("/workers/:id", async (req, res) => {
  const id = Number(req.params.id);
  const existing = await db.execute({ sql: `SELECT id FROM workers WHERE id = ?`, args: [id] });
  if (!existing.rows.length) return res.status(404).json({ error: "Trabajador no encontrado." });

  const v = await validateWorkerBody(req.body);
  if (v.error) return res.status(400).json({ error: v.error });

  const pinTaken = await db.execute({
    sql: `SELECT id FROM workers WHERE pin = ? AND activo = 1 AND id != ?`,
    args: [v.data.pin, id],
  });
  if (pinTaken.rows.length) {
    return res.status(409).json({ error: "Ese PIN ya lo usa otro trabajador activo." });
  }
  const idTaken = await db.execute({
    sql: `SELECT id FROM workers WHERE id_empleado = ? AND activo = 1 AND id != ?`,
    args: [v.data.idEmpleado, id],
  });
  if (idTaken.rows.length) {
    return res.status(409).json({ error: "Ese numero de empleado ya lo usa otro trabajador activo." });
  }

  await db.execute({
    sql: `UPDATE workers SET nombre=?, puesto=?, tarifa_normal=?, tarifa_extra=?, id_empleado=?, pin=?, tipo=? WHERE id=?`,
    args: [v.data.nombre, v.data.puesto, v.data.tarifaNormal, v.data.tarifaExtra, v.data.idEmpleado, v.data.pin, v.data.tipo, id],
  });

  const { rows } = await db.execute({ sql: `SELECT * FROM workers WHERE id = ?`, args: [id] });
  res.json(toWorkerJson(rows[0]));
});

router.delete("/workers/:id", async (req, res) => {
  const id = Number(req.params.id);
  const result = await db.execute({ sql: `UPDATE workers SET activo = 0 WHERE id = ?`, args: [id] });
  if (Number(result.rowsAffected) === 0) return res.status(404).json({ error: "Trabajador no encontrado." });
  res.json({ ok: true });
});

// Solo a los trabajadores cuyo tipo esta marcado como "pagado" (por
// default solo "nomina") se les paga: llevan tarifa por hora y aparecen en
// la pestana de Nomina y en el Excel con su salario. Los demas tipos
// (residencias profesionales, sistema dual, o cualquiera que se agregue
// como "solo asistencia") solo marcan entrada/salida para llevar su
// asistencia -- no tienen tarifa ni aparecen en el total a pagar.
async function validateWorkerBody(body) {
  const nombre = String((body && body.nombre) || "").trim();
  const puesto = String((body && body.puesto) || "").trim();
  const tipo = String((body && body.tipo) || "nomina").trim();
  const idEmpleado = String((body && body.idEmpleado) || "").trim();
  const pin = String((body && body.pin) || "").trim();

  if (!nombre) return { error: "Escribe el nombre del trabajador." };
  // Topes de longitud como capa extra de validacion en el backend (nunca
  // solo en el frontend): evitan que alguien guarde textos absurdamente
  // largos en la base de datos, por error o a proposito.
  if (nombre.length > 120) return { error: "El nombre es demasiado largo (maximo 120 caracteres)." };
  if (puesto.length > 120) return { error: "El puesto es demasiado largo (maximo 120 caracteres)." };
  const tipos = await tiposMap();
  if (!tipos[tipo]) return { error: "Tipo de trabajador invalido." };
  const pagado = tipos[tipo].pagado;

  let tarifaNormal = 0;
  if (pagado) {
    tarifaNormal = Number(body && body.tarifaNormal);
    if (!Number.isFinite(tarifaNormal) || tarifaNormal < 0)
      return { error: "Escribe una tarifa por hora valida." };
  }
  // Ya no se captura hora extra (se paga todo a la misma tarifa por ahora);
  // dejamos tarifa_extra igual a la tarifa normal solo para no romper la
  // columna existente en la base de datos.
  const tarifaExtra = tarifaNormal;

  if (!/^\d{1,8}$/.test(idEmpleado))
    return { error: "El numero de empleado debe tener solo digitos (maximo 8)." };
  if (!/^\d{4}$/.test(pin)) return { error: "El PIN debe tener exactamente 4 digitos." };

  return { data: { nombre, puesto, tarifaNormal, tarifaExtra, idEmpleado, pin, tipo } };
}

function toWorkerJson(row) {
  return {
    id: row.id,
    nombre: row.nombre,
    puesto: row.puesto || "",
    tarifaNormal: row.tarifa_normal,
    tarifaExtra: row.tarifa_extra,
    idEmpleado: row.id_empleado || "",
    pin: row.pin,
    tipo: row.tipo || "nomina",
    activo: !!row.activo,
    orden: row.orden,
  };
}

/* --------------------------- Tipos de trabajador --------------------------- */

router.get("/tipos", async (req, res) => {
  res.json(await listTipos());
});

router.post("/tipos", async (req, res) => {
  const nombre = String((req.body && req.body.nombre) || "").trim();
  const pagado = req.body && req.body.pagado ? 1 : 0;
  if (!nombre) return res.status(400).json({ error: "Escribe el nombre del tipo de trabajador." });
  if (nombre.length > 60) return res.status(400).json({ error: "El nombre es demasiado largo (maximo 60 caracteres)." });

  const existentes = await listTipos();
  if (existentes.some((t) => t.nombre.toLowerCase() === nombre.toLowerCase())) {
    return res.status(409).json({ error: "Ya existe un tipo de trabajador con ese nombre." });
  }
  let base = slugify(nombre) || "tipo";
  let clave = base;
  let i = 2;
  while (existentes.some((t) => t.clave === clave)) clave = `${base}-${i++}`;

  await db.execute({
    sql: `INSERT INTO tipos_trabajador (clave, nombre, pagado, fijo, orden, creado_en) VALUES (?, ?, ?, 0, ?, ?)`,
    args: [clave, nombre, pagado, Date.now(), new Date().toISOString()],
  });
  res.status(201).json({ clave, nombre, pagado: !!pagado, fijo: false });
});

router.delete("/tipos/:clave", async (req, res) => {
  const clave = String(req.params.clave);
  const { rows } = await db.execute({ sql: `SELECT * FROM tipos_trabajador WHERE clave = ?`, args: [clave] });
  if (!rows.length) return res.status(404).json({ error: "Tipo no encontrado." });
  if (rows[0].fijo) return res.status(400).json({ error: "Este tipo viene con el sistema y no se puede eliminar." });
  // No se borra un tipo que todavia tenga trabajadores (activos o dados de
  // baja) -- se perderia la etiqueta en su historial de asistencia.
  const usados = await db.execute({ sql: `SELECT COUNT(*) as c FROM workers WHERE tipo = ?`, args: [clave] });
  if (usados.rows[0].c > 0) {
    return res.status(409).json({ error: "No se puede eliminar: hay trabajadores registrados con este tipo." });
  }
  await db.execute({ sql: `DELETE FROM tipos_trabajador WHERE clave = ?`, args: [clave] });
  res.json({ ok: true });
});

/* -------------------------------- Periodos -------------------------------- */

// Lista de quincenas que caen (aunque sea en parte) entre dos fechas, con
// su estado y el total pagado de cada una -- la usa la ventana de
// "Historial" para escoger que quincenas descargar.
router.get("/periods", async (req, res) => {
  const desde = String(req.query.desde || "");
  const hasta = String(req.query.hasta || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(desde) || !/^\d{4}-\d{2}-\d{2}$/.test(hasta)) {
    return res.status(400).json({ error: "Fechas invalidas (YYYY-MM-DD)." });
  }
  if (desde > hasta) return res.status(400).json({ error: "La fecha inicial debe ser anterior a la final." });
  const lista = quincenasEnRango(desde, hasta);
  if (lista.length > 240) return res.status(400).json({ error: "El rango es demasiado grande (maximo 10 anos)." });
  if (!lista.length) return res.json([]);

  const ids = lista.map((q) => q.id);
  const marks = ids.map(() => "?").join(",");
  const pagadas = await clavesPagadas();
  const tipoMarks = pagadas.map(() => "?").join(",");

  const periodosRes = await db.execute({ sql: `SELECT id, cerrada FROM periodos WHERE id IN (${marks})`, args: ids });
  const cerradaMap = {};
  periodosRes.rows.forEach((p) => (cerradaMap[p.id] = !!p.cerrada));

  const totalesRes = await db.execute({
    sql: `SELECT e.periodo_id as id, SUM(e.horas_normales * w.tarifa_normal) as total,
                 SUM(e.horas_normales) as horas,
                 SUM(CASE WHEN e.horas_normales > 0 THEN 1 ELSE 0 END) as trabajadores
            FROM nomina_entries e JOIN workers w ON w.id = e.worker_id
           WHERE e.periodo_id IN (${marks}) AND w.tipo IN (${tipoMarks})
           GROUP BY e.periodo_id`,
    args: [...ids, ...pagadas],
  });
  const totalMap = {};
  totalesRes.rows.forEach((t) => (totalMap[t.id] = t));

  res.json(
    lista.map((q) => ({
      id: q.id,
      inicio: q.inicio,
      fin: q.fin,
      quincena: q.half,
      cerrada: !!cerradaMap[q.id],
      total: totalMap[q.id] ? Number(totalMap[q.id].total) || 0 : 0,
      horas: totalMap[q.id] ? Number(totalMap[q.id].horas) || 0 : 0,
      trabajadores: totalMap[q.id] ? Number(totalMap[q.id].trabajadores) || 0 : 0,
    }))
  );
});

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

router.get("/periods/:id", async (req, res) => {
  if (!quincenaFromId(req.params.id)) return res.status(400).json({ error: "Periodo invalido." });
  const periodo = await ensurePeriodo(req.params.id);
  const { rows: entries } = await db.execute({
    sql: `SELECT worker_id, horas_normales, horas_extra FROM nomina_entries WHERE periodo_id = ?`,
    args: [req.params.id],
  });
  const entriesObj = {};
  entries.forEach((e) => {
    entriesObj[e.worker_id] = { horasNormales: e.horas_normales, horasExtra: e.horas_extra };
  });
  res.json({ id: periodo.id, inicio: periodo.inicio, fin: periodo.fin, cerrada: !!periodo.cerrada, entries: entriesObj });
});

router.put("/periods/:id/cerrada", async (req, res) => {
  if (!quincenaFromId(req.params.id)) return res.status(400).json({ error: "Periodo invalido." });
  await ensurePeriodo(req.params.id);
  const cerrada = req.body && req.body.cerrada ? 1 : 0;
  await db.execute({ sql: `UPDATE periodos SET cerrada = ? WHERE id = ?`, args: [cerrada, req.params.id] });
  res.json({ ok: true });
});

router.put("/periods/:id/entries/:workerId", async (req, res) => {
  if (!quincenaFromId(req.params.id)) return res.status(400).json({ error: "Periodo invalido." });
  await ensurePeriodo(req.params.id);
  const workerId = Number(req.params.workerId);
  // No redondeamos a centesimas de hora aqui -- el valor que manda el panel
  // ya viene calculado exacto a partir de horas y minutos enteros (por
  // ejemplo 1 hora 10 minutos = 70/60 horas). Redondear de mas aqui es lo
  // que causaba que el sueldo saliera con unos centavos de diferencia.
  const horasNormales = Math.max(0, Number(req.body && req.body.horasNormales) || 0);
  const horasExtra = Math.max(0, Number(req.body && req.body.horasExtra) || 0);

  await db.execute({
    sql: `INSERT INTO nomina_entries (periodo_id, worker_id, horas_normales, horas_extra)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(periodo_id, worker_id) DO UPDATE SET
            horas_normales = excluded.horas_normales,
            horas_extra = excluded.horas_extra`,
    args: [req.params.id, workerId, horasNormales, horasExtra],
  });

  res.json({ ok: true });
});

/* --------------------------------- Turnos --------------------------------- */

router.get("/turnos", async (req, res) => {
  const start = String(req.query.start || "");
  const end = String(req.query.end || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    return res.status(400).json({ error: "Parametros start/end invalidos (YYYY-MM-DD)." });
  }
  const startISO = `${start}T00:00:00.000Z`;
  const endISO = `${end}T23:59:59.999Z`;
  const { rows } = await db.execute({
    sql: `SELECT * FROM turnos WHERE entrada >= ? AND entrada <= ? ORDER BY entrada ASC`,
    args: [startISO, endISO],
  });
  res.json(rows.map(toTurnoJson));
});

router.post("/turnos", async (req, res) => {
  const workerId = Number(req.body && req.body.workerId);
  const entrada = req.body && req.body.entrada;
  const salida = req.body && req.body.salida;
  if (!workerId || !entrada) return res.status(400).json({ error: "Faltan datos del turno." });
  const workerRes = await db.execute({ sql: `SELECT id FROM workers WHERE id = ?`, args: [workerId] });
  if (!workerRes.rows.length) return res.status(404).json({ error: "Trabajador no encontrado." });

  const horas = salida ? hoursBetween(entrada, salida) : null;
  const result = await db.execute({
    sql: `INSERT INTO turnos (worker_id, entrada, salida, horas, origen) VALUES (?, ?, ?, ?, 'manual')`,
    args: [workerId, entrada, salida || null, horas],
  });
  const { rows } = await db.execute({
    sql: `SELECT * FROM turnos WHERE id = ?`,
    args: [Number(result.lastInsertRowid)],
  });
  res.status(201).json(toTurnoJson(rows[0]));
});

router.put("/turnos/:id", async (req, res) => {
  const id = Number(req.params.id);
  const existing = await db.execute({ sql: `SELECT id FROM turnos WHERE id = ?`, args: [id] });
  if (!existing.rows.length) return res.status(404).json({ error: "Turno no encontrado." });

  const entrada = req.body && req.body.entrada;
  const salida = req.body && req.body.salida;
  if (!entrada) return res.status(400).json({ error: "Falta la hora de entrada." });
  const horas = salida ? hoursBetween(entrada, salida) : null;

  await db.execute({
    sql: `UPDATE turnos SET entrada = ?, salida = ?, horas = ? WHERE id = ?`,
    args: [entrada, salida || null, horas, id],
  });
  const { rows } = await db.execute({ sql: `SELECT * FROM turnos WHERE id = ?`, args: [id] });
  res.json(toTurnoJson(rows[0]));
});

router.delete("/turnos/:id", async (req, res) => {
  const result = await db.execute({ sql: `DELETE FROM turnos WHERE id = ?`, args: [Number(req.params.id)] });
  if (Number(result.rowsAffected) === 0) return res.status(404).json({ error: "Turno no encontrado." });
  res.json({ ok: true });
});

function toTurnoJson(row) {
  return {
    id: row.id,
    workerId: row.worker_id,
    entrada: row.entrada,
    salida: row.salida,
    horas: row.horas,
    origen: row.origen,
  };
}

module.exports = router;
