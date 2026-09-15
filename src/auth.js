// Inicio de sesion del panel de administracion, y manejo de las cuentas de
// administrador (una o varias). Las contrasenas NUNCA se guardan en texto
// plano: se cifran con bcrypt (un "hash" de un solo sentido, que no se
// puede revertir) tanto al crear una cuenta como al cambiar su contrasena.
// La sesion en si se guarda en una cookie firmada con SESSION_SECRET.
"use strict";

const express = require("express");
const bcrypt = require("bcryptjs");
const { db } = require("./db");

const router = express.Router();

const BCRYPT_ROUNDS = 12;

// Hash de relleno (de una contrasena que nadie usa) contra el que se
// compara cuando el usuario escrito no existe. Sin esto, un inicio de
// sesion con un usuario que SI existe tardaria un poquito mas en responder
// que uno con un usuario que NO existe (porque bcrypt.compare es lento a
// proposito) -- alguien podria usar esa diferencia de tiempo para
// adivinar, uno por uno, que usuarios existen. Comparando siempre contra
// algo, ese tiempo queda parejo.
const DUMMY_HASH = bcrypt.hashSync("ningun-usuario-usa-esta-contrasena", BCRYPT_ROUNDS);

/* ------------------------- Limite de intentos de inicio de sesion ------------------------- */
// Sin esto, alguien podria escribir miles de contrasenas por segundo
// contra /api/login hasta acertar. Se cuenta por direccion IP: despues de
// varios intentos fallidos seguidos, esa IP tiene que esperar unos minutos
// antes de poder intentar de nuevo. Se guarda en memoria (no en la base de
// datos) porque solo importa mientras el servidor sigue prendido -- si se
// reinicia, el conteo empieza de cero, lo cual esta bien para este caso.
const MAX_INTENTOS = 8;
const VENTANA_MS = 15 * 60 * 1000; // 15 minutos
const intentosPorIp = new Map();

function estaBloqueada(ip) {
  const entry = intentosPorIp.get(ip);
  if (!entry) return false;
  if (Date.now() - entry.desde > VENTANA_MS) {
    intentosPorIp.delete(ip);
    return false;
  }
  return entry.count >= MAX_INTENTOS;
}
function registrarIntentoFallido(ip) {
  const entry = intentosPorIp.get(ip);
  if (!entry || Date.now() - entry.desde > VENTANA_MS) {
    intentosPorIp.set(ip, { count: 1, desde: Date.now() });
  } else {
    entry.count++;
  }
}
function limpiarIntentos(ip) {
  intentosPorIp.delete(ip);
}

/* ------------------------------- Contrasenas ------------------------------- */
// Requisito minimo para cualquier contrasena nueva (la propia, o la de un
// administrador que se agregue): al menos 8 caracteres, con letras y
// numeros. No es infalible, pero evita las contrasenas mas debiles
// ("1234", "admin", etc.) sin pedir algo imposible de recordar.
function errorDeFortaleza(pw) {
  if (typeof pw !== "string" || pw.length < 8) {
    return "La contrasena debe tener al menos 8 caracteres.";
  }
  // Tope superior: bcrypt solo usa los primeros 72 caracteres de todos
  // modos, y sin este limite alguien podria mandar un texto enorme para
  // hacer que el servidor gaste tiempo de mas cifrandolo (un pequeno
  // ataque de negacion de servicio).
  if (pw.length > 72) {
    return "La contrasena es demasiado larga (maximo 72 caracteres).";
  }
  if (!/[a-zA-Z]/.test(pw) || !/[0-9]/.test(pw)) {
    return "La contrasena debe incluir letras y numeros.";
  }
  return null;
}

// Tope de longitud para el nombre de usuario de un administrador -- misma
// idea que los topes de nombre/puesto de los trabajadores: es validacion
// del lado del servidor, no solo del formulario.
function errorDeUsuario(usuario) {
  if (!usuario) return "Escribe un nombre de usuario.";
  if (usuario.length > 60) return "El usuario es demasiado largo (maximo 60 caracteres).";
  return null;
}

function requireAuth(req, res, next) {
  if (req.session && req.session.loggedIn) return next();
  return res.status(401).json({ error: "No autorizado. Inicia sesion de nuevo." });
}

// Protege las paginas HTML del panel (no solo la API): si alguien entra
// directo a /admin sin haber iniciado sesion, lo mandamos a /login.
function guardAdminPage(req, res, next) {
  if (req.session && req.session.loggedIn) return next();
  return res.redirect("/login");
}

/* --------------------------------- Login --------------------------------- */

router.post("/api/login", async (req, res) => {
  const ip = req.ip || "desconocida";
  if (estaBloqueada(ip)) {
    return res.status(429).json({ error: "Demasiados intentos fallidos. Espera unos minutos e intenta de nuevo." });
  }

  const { usuario, password } = req.body || {};
  if (typeof usuario !== "string" || typeof password !== "string") {
    registrarIntentoFallido(ip);
    return res.status(401).json({ error: "Usuario o contrasena incorrectos." });
  }

  const { rows } = await db.execute({ sql: `SELECT * FROM admins WHERE usuario = ?`, args: [usuario] });
  const admin = rows[0];
  const hashAComparar = admin ? admin.password_hash : DUMMY_HASH;
  const passOk = await bcrypt.compare(password, hashAComparar);

  if (!admin || !passOk) {
    registrarIntentoFallido(ip);
    return res.status(401).json({ error: "Usuario o contrasena incorrectos." });
  }

  limpiarIntentos(ip);
  req.session.loggedIn = true;
  req.session.usuario = admin.usuario;
  req.session.adminId = admin.id;
  res.json({ ok: true });
});

router.post("/api/logout", (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

router.get("/api/session", (req, res) => {
  const loggedIn = !!(req.session && req.session.loggedIn);
  res.json({ loggedIn, usuario: loggedIn ? req.session.usuario : null });
});

/* ------------------------------ Mi cuenta ------------------------------ */

// Cambiar mi propia contrasena. Pide la contrasena actual (para
// confirmar que de verdad eres tu quien la esta cambiando, no alguien que
// dejaste con la sesion abierta), valida que la nueva sea razonablemente
// fuerte, y la guarda ya cifrada.
router.put("/api/account/password", requireAuth, async (req, res) => {
  const { passwordActual, passwordNueva } = req.body || {};
  if (typeof passwordActual !== "string" || typeof passwordNueva !== "string") {
    return res.status(400).json({ error: "Completa los dos campos de contrasena." });
  }
  const fortalezaError = errorDeFortaleza(passwordNueva);
  if (fortalezaError) return res.status(400).json({ error: fortalezaError });

  const { rows } = await db.execute({ sql: `SELECT * FROM admins WHERE id = ?`, args: [req.session.adminId] });
  const admin = rows[0];
  if (!admin) return res.status(401).json({ error: "No autorizado. Inicia sesion de nuevo." });

  const ok = await bcrypt.compare(passwordActual, admin.password_hash);
  if (!ok) return res.status(401).json({ error: "Tu contrasena actual no es correcta." });

  const nuevoHash = await bcrypt.hash(passwordNueva, BCRYPT_ROUNDS);
  await db.execute({ sql: `UPDATE admins SET password_hash = ? WHERE id = ?`, args: [nuevoHash, admin.id] });
  res.json({ ok: true });
});

/* --------------------------- Otros administradores --------------------------- */
// Cualquiera que ya haya iniciado sesion puede ver la lista y agregar o
// quitar administradores -- es una herramienta interna de una sola
// organizacion, no hay "roles" distintos entre administradores.

router.get("/api/admins", requireAuth, async (req, res) => {
  const { rows } = await db.execute(`SELECT id, usuario, creado_en FROM admins ORDER BY creado_en ASC`);
  res.json(rows);
});

router.post("/api/admins", requireAuth, async (req, res) => {
  const usuario = String((req.body && req.body.usuario) || "").trim();
  const password = (req.body && req.body.password) || "";
  const usuarioError = errorDeUsuario(usuario);
  if (usuarioError) return res.status(400).json({ error: usuarioError });
  const fortalezaError = errorDeFortaleza(password);
  if (fortalezaError) return res.status(400).json({ error: fortalezaError });

  const existing = await db.execute({ sql: `SELECT id FROM admins WHERE usuario = ?`, args: [usuario] });
  if (existing.rows.length) return res.status(409).json({ error: "Ese usuario ya existe." });

  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const result = await db.execute({
    sql: `INSERT INTO admins (usuario, password_hash, creado_en) VALUES (?, ?, ?)`,
    args: [usuario, hash, new Date().toISOString()],
  });
  res.status(201).json({ id: Number(result.lastInsertRowid), usuario });
});

router.delete("/api/admins/:id", requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const { rows: countRows } = await db.execute(`SELECT COUNT(*) as c FROM admins`);
  if (countRows[0].c <= 1) {
    return res.status(400).json({ error: "No puedes eliminar al unico administrador -- nadie podria volver a entrar." });
  }
  const result = await db.execute({ sql: `DELETE FROM admins WHERE id = ?`, args: [id] });
  if (Number(result.rowsAffected) === 0) return res.status(404).json({ error: "Administrador no encontrado." });

  // Si te acabas de eliminar a ti misma (y queda al menos otro
  // administrador), se cierra tu sesion actual para que tengas que volver
  // a entrar con una cuenta que siga existiendo.
  if (req.session.adminId === id) {
    req.session.destroy(() => {});
  }
  res.json({ ok: true });
});

module.exports = { router, requireAuth, guardAdminPage };
