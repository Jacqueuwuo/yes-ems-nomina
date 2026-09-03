// Rutas publicas del checador (pantalla de QR). No requieren haber
// iniciado sesion -- el propio PIN de 4 digitos identifica al
// trabajador. Pensadas para llamarse desde el celular de cada persona.
"use strict";

const express = require("express");
const { db } = require("../db");
const { round2 } = require("../periodos");

const router = express.Router();

async function findActiveWorkerByPin(pin) {
  const { rows } = await db.execute({
    sql: `SELECT * FROM workers WHERE pin = ? AND activo = 1`,
    args: [pin],
  });
  return rows[0] || null;
}
async function findOpenTurno(workerId) {
  const { rows } = await db.execute({
    sql: `SELECT * FROM turnos WHERE worker_id = ? AND salida IS NULL ORDER BY entrada DESC LIMIT 1`,
    args: [workerId],
  });
  return rows[0] || null;
}

function validatePin(req, res) {
  const pin = String((req.body && req.body.pin) || "");
  if (!/^\d{4}$/.test(pin)) {
    res.status(400).json({ error: "PIN invalido." });
    return null;
  }
  return pin;
}

router.post("/estado", async (req, res) => {
  const pin = validatePin(req, res);
  if (!pin) return;
  const worker = await findActiveWorkerByPin(pin);
  if (!worker) return res.status(404).json({ error: "PIN no encontrado. Verifica con tu supervisor." });
  const turno = await findOpenTurno(worker.id);
  res.json({
    worker: { id: worker.id, nombre: worker.nombre },
    turnoAbierto: turno ? { id: turno.id, entrada: turno.entrada } : null,
  });
});

router.post("/entrada", async (req, res) => {
  const pin = validatePin(req, res);
  if (!pin) return;
  const worker = await findActiveWorkerByPin(pin);
  if (!worker) return res.status(404).json({ error: "PIN no encontrado. Verifica con tu supervisor." });
  if (await findOpenTurno(worker.id)) {
    return res.status(409).json({ error: "Ya tienes una entrada sin salida registrada." });
  }
  const entrada = new Date().toISOString();
  await db.execute({
    sql: `INSERT INTO turnos (worker_id, entrada, salida, horas, origen) VALUES (?, ?, NULL, NULL, 'qr')`,
    args: [worker.id, entrada],
  });
  res.json({ ok: true, nombre: worker.nombre, entrada });
});

router.post("/salida", async (req, res) => {
  const pin = validatePin(req, res);
  if (!pin) return;
  const worker = await findActiveWorkerByPin(pin);
  if (!worker) return res.status(404).json({ error: "PIN no encontrado. Verifica con tu supervisor." });
  const turno = await findOpenTurno(worker.id);
  if (!turno) return res.status(409).json({ error: "No tienes una entrada abierta." });

  const salida = new Date().toISOString();
  const horas = round2((new Date(salida) - new Date(turno.entrada)) / 3600000);
  await db.execute({
    sql: `UPDATE turnos SET salida = ?, horas = ? WHERE id = ?`,
    args: [salida, horas, turno.id],
  });
  res.json({ ok: true, nombre: worker.nombre, horas });
});

module.exports = router;
