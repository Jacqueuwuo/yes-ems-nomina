// Rutas publicas del checador (pantalla de QR). No requieren haber
// iniciado sesion -- cada trabajador se identifica con su numero de
// empleado (hasta 8 digitos) MAS su PIN de 4 digitos, los dos juntos.
// Pensadas para llamarse desde el celular de cada persona.
"use strict";

const express = require("express");
const { db } = require("../db");
const { hoursBetween } = require("../periodos");

const router = express.Router();

async function findActiveWorker(idEmpleado, pin) {
  const { rows } = await db.execute({
    sql: `SELECT * FROM workers WHERE id_empleado = ? AND pin = ? AND activo = 1`,
    args: [idEmpleado, pin],
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

// No revelamos si el numero de empleado existe por separado del PIN --
// solo la combinacion correcta de ambos identifica a alguien. Asi, ver el
// mensaje de error no le dice a nadie si acerto la mitad de los datos.
function validateCreds(req, res) {
  const idEmpleado = String((req.body && req.body.idEmpleado) || "");
  const pin = String((req.body && req.body.pin) || "");
  if (!/^\d{1,8}$/.test(idEmpleado) || !/^\d{4}$/.test(pin)) {
    res.status(400).json({ error: "Numero de empleado o PIN invalido." });
    return null;
  }
  return { idEmpleado, pin };
}

router.post("/estado", async (req, res) => {
  const creds = validateCreds(req, res);
  if (!creds) return;
  const worker = await findActiveWorker(creds.idEmpleado, creds.pin);
  if (!worker) return res.status(404).json({ error: "Numero de empleado o PIN incorrectos." });
  const turno = await findOpenTurno(worker.id);
  res.json({
    worker: { id: worker.id, nombre: worker.nombre },
    turnoAbierto: turno ? { id: turno.id, entrada: turno.entrada } : null,
  });
});

router.post("/entrada", async (req, res) => {
  const creds = validateCreds(req, res);
  if (!creds) return;
  const worker = await findActiveWorker(creds.idEmpleado, creds.pin);
  if (!worker) return res.status(404).json({ error: "Numero de empleado o PIN incorrectos." });
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
  const creds = validateCreds(req, res);
  if (!creds) return;
  const worker = await findActiveWorker(creds.idEmpleado, creds.pin);
  if (!worker) return res.status(404).json({ error: "Numero de empleado o PIN incorrectos." });
  const turno = await findOpenTurno(worker.id);
  if (!turno) return res.status(409).json({ error: "No tienes una entrada abierta." });

  const salida = new Date().toISOString();
  const horas = hoursBetween(turno.entrada, salida);
  await db.execute({
    sql: `UPDATE turnos SET salida = ?, horas = ? WHERE id = ?`,
    args: [salida, horas, turno.id],
  });
  res.json({ ok: true, nombre: worker.nombre, horas });
});

module.exports = router;
