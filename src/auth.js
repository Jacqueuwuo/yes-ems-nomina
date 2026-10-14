// Inicio de sesion del panel de administracion, y manejo de las cuentas de
// administrador (una o varias). Las contrasenas NUNCA se guardan en texto
// plano: se cifran con bcrypt (un "hash" de un solo sentido, que no se
// puede revertir) tanto al crear una cuenta como al cambiar su contrasena.
// La sesion en si se guarda en una cookie firmada con SESSION_SECRET.
"use strict";

const express = require("express");
const bcrypt = require("bcryptjs");
const { db } = require("./db");
const { BCRYPT_ROUNDS, errorDeFortaleza } = require("./password-policy");

const router = express.Router();

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
// Las reglas de fortaleza de contrasena (minimo 8 caracteres, letras y
// numeros, etc.) viven en src/password-policy.js, compartidas con las
// cuentas del Portal del trabajador.

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

// Para las acciones que modifican datos (agregar/editar/eliminar
// trabajadores, nomina, asistencia, tipos, u otros administradores): un
// administrador de "solo lectura" puede ver todo y descargar PDFs, pero
// nunca puede cambiar nada. Se revisa el rol directo en la base de datos
// (no el que quedo guardado en la sesion al iniciar sesion) para que, si
// a alguien le cambian el rol mientras sigue con la sesion abierta en
// otro lado, el cambio aplique de inmediato sin esperar a que vuelva a
// entrar.
async function requireFullAdmin(req, res, next) {
  if (!req.session || !req.session.loggedIn) {
    return res.status(401).json({ error: "No autorizado. Inicia sesion de nuevo." });
  }
  const { rows } = await db.execute({ sql: `SELECT rol FROM admins WHERE id = ?`, args: [req.session.adminId] });
  const rol = rows[0] ? rows[0].rol : null;
  if (rol !== "admin") {
    return res.status(403).json({ error: "Tu cuenta es de solo lectura -- no puedes hacer cambios." });
  }
  next();
}

function errorDeRol(rol) {
  if (rol !== "admin" && rol !== "lectura") return "Rol invalido.";
  return null;
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

router.get("/api/session", async (req, res) => {
  const loggedIn = !!(req.session && req.session.loggedIn);
  if (!loggedIn) return res.json({ loggedIn: false });
  // El rol se lee de la base de datos (no de la sesion) por la misma
  // razon que en requireFullAdmin: si se lo cambian mientras tiene la
  // sesion abierta, el panel debe reflejarlo de inmediato.
  const { rows } = await db.execute({ sql: `SELECT rol FROM admins WHERE id = ?`, args: [req.session.adminId] });
  res.json({ loggedIn: true, usuario: req.session.usuario, rol: (rows[0] && rows[0].rol) || "admin" });
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
// Gestionar administradores (verlos, agregarlos, cambiarles el rol, o
// eliminarlos) es cosa solo de un administrador con permisos completos --
// alguien de "solo lectura" ni siquiera puede ver esta lista.

async function contarAdminsCompletos() {
  const { rows } = await db.execute(`SELECT COUNT(*) as c FROM admins WHERE rol = 'admin'`);
  return rows[0].c;
}

router.get("/api/admins", requireAuth, requireFullAdmin, async (req, res) => {
  const { rows } = await db.execute(`SELECT id, usuario, rol, creado_en FROM admins ORDER BY creado_en ASC`);
  res.json(rows);
});

router.post("/api/admins", requireAuth, requireFullAdmin, async (req, res) => {
  const usuario = String((req.body && req.body.usuario) || "").trim();
  const password = (req.body && req.body.password) || "";
  const rol = String((req.body && req.body.rol) || "admin").trim();
  const usuarioError = errorDeUsuario(usuario);
  if (usuarioError) return res.status(400).json({ error: usuarioError });
  const fortalezaError = errorDeFortaleza(password);
  if (fortalezaError) return res.status(400).json({ error: fortalezaError });
  const rolError = errorDeRol(rol);
  if (rolError) return res.status(400).json({ error: rolError });

  const existing = await db.execute({ sql: `SELECT id FROM admins WHERE usuario = ?`, args: [usuario] });
  if (existing.rows.length) return res.status(409).json({ error: "Ese usuario ya existe." });

  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const result = await db.execute({
    sql: `INSERT INTO admins (usuario, password_hash, rol, creado_en) VALUES (?, ?, ?, ?)`,
    args: [usuario, hash, rol, new Date().toISOString()],
  });
  res.status(201).json({ id: Number(result.lastInsertRowid), usuario, rol });
});

// Cambia el rol de OTRO administrador (completo <-> solo lectura). No se
// puede usar sobre uno mismo (para que nadie se quite el acceso completo
// por accidente a media sesion -- que lo haga otro administrador
// completo), y no se puede dejar el sistema sin ningun administrador
// completo (nadie podria volver a gestionar nada).
router.put("/api/admins/:id/rol", requireAuth, requireFullAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const rol = String((req.body && req.body.rol) || "").trim();
  const rolError = errorDeRol(rol);
  if (rolError) return res.status(400).json({ error: rolError });

  if (id === req.session.adminId) {
    return res.status(400).json({ error: "No puedes cambiar tu propio rol -- pidele a otro administrador completo que lo haga." });
  }
  const { rows } = await db.execute({ sql: `SELECT * FROM admins WHERE id = ?`, args: [id] });
  if (!rows.length) return res.status(404).json({ error: "Administrador no encontrado." });
  const actual = rows[0];

  if (actual.rol === "admin" && rol === "lectura") {
    const completos = await contarAdminsCompletos();
    if (completos <= 1) {
      return res.status(400).json({ error: "No puedes quitarle el acceso completo al unico administrador que lo tiene." });
    }
  }

  await db.execute({ sql: `UPDATE admins SET rol = ? WHERE id = ?`, args: [rol, id] });
  res.json({ ok: true, id, rol });
});

router.delete("/api/admins/:id", requireAuth, requireFullAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const { rows } = await db.execute({ sql: `SELECT * FROM admins WHERE id = ?`, args: [id] });
  if (!rows.length) return res.status(404).json({ error: "Administrador no encontrado." });

  if (rows[0].rol === "admin") {
    const completos = await contarAdminsCompletos();
    if (completos <= 1) {
      return res.status(400).json({ error: "No puedes eliminar al unico administrador con permisos completos -- nadie podria volver a gestionar el sistema." });
    }
  }

  await db.execute({ sql: `DELETE FROM admins WHERE id = ?`, args: [id] });

  // Si te acabas de eliminar a ti misma (y queda al menos otro
  // administrador completo), se cierra tu sesion actual para que tengas
  // que volver a entrar con una cuenta que siga existiendo.
  if (req.session.adminId === id) {
    req.session.destroy(() => {});
  }
  res.json({ ok: true });
});

module.exports = { router, requireAuth, requireFullAdmin, guardAdminPage };
