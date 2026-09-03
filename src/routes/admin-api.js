// Rutas del panel de administracion: trabajadores, nomina por quincena y
// turnos de asistencia. Todas requieren haber iniciado sesion (el
// middleware requireAuth se aplica donde se monta este router, en
// server.js).
"use strict";

const express = require("express");
const { db } = require("../db");
const { quincenaFromId, round2 } = require("../periodos");

const router = express.Router();

/* ------------------------------ Trabajadores ------------------------------ */

router.get("/workers", async (req, res) => {
  const { rows } = await db.execute(`SELECT * FROM workers ORDER BY orden ASC`);
  res.json(rows.map(toWorkerJson));
});

router.post("/workers", async (req, res) => {
  const v = validateWorkerBody(req.body);
  if (v.error) return res.status(400).json({ error: v.error });

  const pinTaken = await db.execute({
    sql: `SELECT id FROM workers WHERE pin = ? AND activo = 1`,
    args: [v.data.pin],
  });
  if (pinTaken.rows.length) {
    return res.status(409).json({ error: "Ese PIN ya lo usa otro trabajador activo." });
  }

  const orden = Date.now();
  const creadoEn = new Date().toISOString();
  const result = await db.execute({
    sql: `INSERT INTO workers (nombre, puesto, tarifa_normal, tarifa_extra, pin, activo, orden, creado_en)
          VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
    args: [v.data.nombre, v.data.puesto, v.data.tarifaNormal, v.data.tarifaExtra, v.data.pin, orden, creadoEn],
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

  const v = validateWorkerBody(req.body);
  if (v.error) return res.status(400).json({ error: v.error });

  const pinTaken = await db.execute({
    sql: `SELECT id FROM workers WHERE pin = ? AND activo = 1 AND id != ?`,
    args: [v.data.pin, id],
  });
  if (pinTaken.rows.length) {
    return res.status(409).json({ error: "Ese PIN ya lo usa otro trabajador activo." });
  }

  await db.execute({
    sql: `UPDATE workers SET nombre=?, puesto=?, tarifa_normal=?, tarifa_extra=?, pin=? WHERE id=?`,
    args: [v.data.nombre, v.data.puesto, v.data.tarifaNormal, v.data.tarifaExtra, v.data.pin, id],
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

function validateWorkerBody(body) {
  const nombre = String((body && body.nombre) || "").trim();
  const puesto = String((body && body.puesto) || "").trim();
  const tarifaNormal = Number(body && body.tarifaNormal);
  const tarifaExtra = Number(body && body.tarifaExtra);
  const pin = String((body && body.pin) || "").trim();

  if (!nombre) return { error: "Escribe el nombre del trabajador." };
  if (!Number.isFinite(tarifaNormal) || tarifaNormal < 0)
    return { error: "Escribe una tarifa normal valida." };
  if (!Number.isFinite(tarifaExtra) || tarifaExtra < 0)
    return { error: "Escribe una tarifa extra valida." };
  if (!/^\d{4}$/.test(pin)) return { error: "El PIN debe tener exactamente 4 digitos." };

  return { data: { nombre, puesto, tarifaNormal, tarifaExtra, pin } };
}

function toWorkerJson(row) {
  return {
    id: row.id,
    nombre: row.nombre,
    puesto: row.puesto || "",
    tarifaNormal: row.tarifa_normal,
    tarifaExtra: row.tarifa_extra,
    pin: row.pin,
    activo: !!row.activo,
    orden: row.orden,
  };
}

/* -------------------------------- Periodos -------------------------------- */

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
  const horasNormales = round2(Number(req.body && req.body.horasNormales) || 0);
  const horasExtra = round2(Number(req.body && req.body.horasExtra) || 0);

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

  const horas = salida ? round2((new Date(salida) - new Date(entrada)) / 3600000) : null;
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
  const horas = salida ? round2((new Date(salida) - new Date(entrada)) / 3600000) : null;

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
