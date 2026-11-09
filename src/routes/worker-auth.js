// Portal del trabajador ("mi-nomina"): cada trabajador entra con su
// propio correo y contrasena (nada que ver con su PIN del checador, ni
// con las cuentas de administrador) y solo puede ver/descargar SU PROPIO
// recibo de nomina o desglose de horas -- nunca el de otra persona.
//
// Flujo:
//   1. Un administrador le agrega el correo desde el panel -- eso crea la
//      cuenta y le manda un enlace de un solo uso (ver src/routes/admin-api.js).
//   2. El trabajador abre ese enlace (/mi-nomina?token=...), confirma su
//      correo y elige su contrasena (POST /verify/:token).
//   3. De ahi en adelante entra normal con correo + contrasena
//      (POST /login).
//
// El workerId SIEMPRE se resuelve desde la sesion del propio trabajador
// (req.session.workerId), nunca desde algo que mande el navegador --
// asi nadie puede pedir el PDF de otra persona solo cambiando un numero
// en la URL.
"use strict";

const express = require("express");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { db } = require("../db");
const { BCRYPT_ROUNDS, errorDeFortaleza } = require("../password-policy");
const { quincenaFromId, fmtRangeEs } = require("../periodos");
const { clavesPagadas } = require("../tipos");
const { periodRangeISO, nominaRowForWorker, turnosForWorker } = require("../nomina-data");
const { fmtHorasPdf, fmtMoneyPdf, fmtFecha, fmtHora } = require("../pdf-common");
const { enviarReciboPdf } = require("../pdf-worker-receipt");

const router = express.Router();

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/* ------------------------- Limite de intentos de inicio de sesion ------------------------- */
// Igual que /api/login (ver src/auth.js), pero contado por correo en vez
// de por IP -- aqui cada trabajador entra desde su propio celular, asi
// que contar por IP no tendria sentido (cada uno ya tiene la suya).
const MAX_INTENTOS = 8;
const VENTANA_MS = 15 * 60 * 1000; // 15 minutos
const intentosPorCorreo = new Map();

function estaBloqueado(email) {
  const entry = intentosPorCorreo.get(email);
  if (!entry) return false;
  if (Date.now() - entry.desde > VENTANA_MS) {
    intentosPorCorreo.delete(email);
    return false;
  }
  return entry.count >= MAX_INTENTOS;
}
function registrarIntentoFallido(email) {
  const entry = intentosPorCorreo.get(email);
  if (!entry || Date.now() - entry.desde > VENTANA_MS) {
    intentosPorCorreo.set(email, { count: 1, desde: Date.now() });
  } else {
    entry.count++;
  }
}
function limpiarIntentos(email) {
  intentosPorCorreo.delete(email);
}

// Hash de relleno para que intentar con un correo que no existe tarde lo
// mismo que intentar con uno que si existe (misma razon que DUMMY_HASH en
// src/auth.js: evita que la diferencia de tiempo delate que correos
// existen).
const DUMMY_HASH = bcrypt.hashSync("ningun-trabajador-usa-esta-contrasena", BCRYPT_ROUNDS);

function requireWorkerAuth(req, res, next) {
  if (req.session && req.session.workerLoggedIn) return next();
  return res.status(401).json({ error: "No autorizado. Inicia sesion de nuevo." });
}

/* --------------------------- Activar cuenta (token) --------------------------- */

async function buscarCuentaPorToken(token) {
  if (!token || typeof token !== "string") return null;
  const tokenHash = hashToken(token);
  const { rows } = await db.execute({
    sql: `SELECT wa.*, w.nombre as worker_nombre, w.activo as worker_activo
            FROM worker_accounts wa JOIN workers w ON w.id = wa.worker_id
           WHERE wa.verify_token_hash = ?`,
    args: [tokenHash],
  });
  const cuenta = rows[0];
  if (!cuenta) return null;
  if (!cuenta.worker_activo) return null;
  if (!cuenta.verify_token_expires || new Date(cuenta.verify_token_expires) < new Date()) return null;
  return cuenta;
}

// Permite ver, antes de pedir la contrasena, de quien es el enlace (para
// mostrar "Hola, <nombre>" en la pantalla de activacion).
router.get("/verify/:token", async (req, res) => {
  const cuenta = await buscarCuentaPorToken(req.params.token);
  if (!cuenta) return res.status(400).json({ error: "Este enlace ya no es valido. Pide que te manden uno nuevo." });
  res.json({ nombre: cuenta.worker_nombre, email: cuenta.email });
});

router.post("/verify/:token", async (req, res) => {
  const cuenta = await buscarCuentaPorToken(req.params.token);
  if (!cuenta) return res.status(400).json({ error: "Este enlace ya no es valido. Pide que te manden uno nuevo." });

  const password = (req.body && req.body.password) || "";
  const fortalezaError = errorDeFortaleza(password);
  if (fortalezaError) return res.status(400).json({ error: fortalezaError });

  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  await db.execute({
    sql: `UPDATE worker_accounts SET password_hash = ?, verify_token_hash = NULL, verify_token_expires = NULL WHERE id = ?`,
    args: [hash, cuenta.id],
  });

  req.session.workerLoggedIn = true;
  req.session.workerId = cuenta.worker_id;
  res.json({ ok: true, nombre: cuenta.worker_nombre });
});

/* --------------------------------- Login --------------------------------- */

router.post("/login", async (req, res) => {
  const email = String((req.body && req.body.email) || "").trim().toLowerCase();
  const password = (req.body && req.body.password) || "";
  if (!email || typeof password !== "string") {
    return res.status(400).json({ error: "Escribe tu correo y tu contrasena." });
  }
  if (estaBloqueado(email)) {
    return res.status(429).json({ error: "Demasiados intentos fallidos. Espera unos minutos e intenta de nuevo." });
  }

  const { rows } = await db.execute({
    sql: `SELECT wa.*, w.nombre as worker_nombre, w.activo as worker_activo
            FROM worker_accounts wa JOIN workers w ON w.id = wa.worker_id
           WHERE wa.email = ?`,
    args: [email],
  });
  const cuenta = rows[0];
  // Si la cuenta todavia no activo su contrasena (password_hash NULL) se
  // trata igual que "no existe" -- el mensaje de error no distingue los
  // casos, para no revelar que correos si estan registrados.
  const hashAComparar = cuenta && cuenta.password_hash ? cuenta.password_hash : DUMMY_HASH;
  const passOk = await bcrypt.compare(password, hashAComparar);

  if (!cuenta || !cuenta.password_hash || !cuenta.worker_activo || !passOk) {
    registrarIntentoFallido(email);
    return res.status(401).json({ error: "Correo o contrasena incorrectos." });
  }

  limpiarIntentos(email);
  req.session.workerLoggedIn = true;
  req.session.workerId = cuenta.worker_id;
  res.json({ ok: true, nombre: cuenta.worker_nombre });
});

router.post("/logout", (req, res) => {
  // No se usa req.session.destroy() aqui: la sesion es la misma cookie
  // que la del panel de administracion (por si algun dia se abren los
  // dos en el mismo navegador), asi que solo se borran las llaves del
  // Portal del trabajador, sin tocar una sesion de administrador que
  // pudiera estar activa en la misma sesion.
  if (req.session) {
    req.session.workerLoggedIn = false;
    delete req.session.workerId;
  }
  res.json({ ok: true });
});

router.get("/session", async (req, res) => {
  if (!req.session || !req.session.workerLoggedIn) return res.json({ loggedIn: false });
  const { rows } = await db.execute({ sql: `SELECT nombre, activo FROM workers WHERE id = ?`, args: [req.session.workerId] });
  const worker = rows[0];
  if (!worker || !worker.activo) {
    req.session.workerLoggedIn = false;
    delete req.session.workerId;
    return res.json({ loggedIn: false });
  }
  res.json({ loggedIn: true, nombre: worker.nombre });
});

/* ------------------------------ Datos / PDF propio ------------------------------ */

// Resuelve TODO lo necesario para mostrar/descargar el recibo de un
// periodo, siempre a partir del workerId de la sesion -- nunca de un
// parametro que mande el navegador.
async function datosDelPeriodo(req, res, periodId) {
  const q = quincenaFromId(periodId);
  if (!q) {
    res.status(400).json({ error: "Periodo invalido." });
    return null;
  }
  const { rows } = await db.execute({ sql: `SELECT * FROM workers WHERE id = ?`, args: [req.session.workerId] });
  const worker = rows[0];
  if (!worker || !worker.activo) {
    res.status(401).json({ error: "No autorizado. Inicia sesion de nuevo." });
    return null;
  }

  const pagadas = await clavesPagadas();
  const esPagado = pagadas.includes(worker.tipo);
  const range = periodRangeISO(periodId);
  const turnos = range ? await turnosForWorker(worker.id, range) : [];
  const rango = fmtRangeEs(periodId);

  let horasTotales;
  let totalPagar = null;
  if (esPagado) {
    const row = await nominaRowForWorker(periodId, worker.id);
    horasTotales = row ? row.horas : 0;
    totalPagar = row ? row.total : 0;
  } else {
    horasTotales = turnos.reduce((s, t) => s + (t.horas || 0), 0);
  }

  return { worker, esPagado, turnos, horasTotales, totalPagar, rango };
}

router.get("/resumen", requireWorkerAuth, async (req, res) => {
  const periodId = String(req.query.periodo || "");
  const d = await datosDelPeriodo(req, res, periodId);
  if (!d) return; // ya se respondio el error adentro

  res.json({
    periodId,
    rango: d.rango,
    esPagado: d.esPagado,
    puesto: d.worker.puesto || "",
    tarifaNormal: d.esPagado ? d.worker.tarifa_normal : null,
    horas: d.horasTotales,
    horasTexto: fmtHorasPdf(d.horasTotales),
    total: d.totalPagar,
    totalTexto: d.esPagado ? fmtMoneyPdf(d.totalPagar) : null,
    turnos: d.turnos.map((t) => {
      const entradaD = new Date(t.entrada);
      const salidaD = t.salida ? new Date(t.salida) : null;
      return {
        fecha: fmtFecha(entradaD),
        entrada: fmtHora(entradaD),
        salida: salidaD ? fmtHora(salidaD) : null,
        horasTexto: t.horas != null ? fmtHorasPdf(t.horas) : null,
      };
    }),
  });
});

router.get("/pdf", requireWorkerAuth, async (req, res) => {
  const periodId = String(req.query.periodo || "");
  const d = await datosDelPeriodo(req, res, periodId);
  if (!d) return;
  enviarReciboPdf(res, { worker: d.worker, esPagado: d.esPagado, turnos: d.turnos, horasTotales: d.horasTotales, totalPagar: d.totalPagar, periodId, rango: d.rango });
});

module.exports = { router, requireWorkerAuth };
