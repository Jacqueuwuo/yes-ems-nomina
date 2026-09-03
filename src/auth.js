// Inicio de sesion muy simple para el panel de administracion. Un solo
// usuario/contrasena (definidos en variables de entorno) es suficiente
// para una herramienta interna de una sola empresa; la sesion se guarda
// en una cookie firmada con SESSION_SECRET.
"use strict";

const express = require("express");
const router = express.Router();

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

router.post("/api/login", (req, res) => {
  const { usuario, password } = req.body || {};
  const okUser = typeof usuario === "string" && usuario === process.env.ADMIN_USER;
  const okPass = typeof password === "string" && password === process.env.ADMIN_PASSWORD;
  if (okUser && okPass) {
    req.session.loggedIn = true;
    req.session.usuario = usuario;
    return res.json({ ok: true });
  }
  return res.status(401).json({ error: "Usuario o contrasena incorrectos." });
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

module.exports = { router, requireAuth, guardAdminPage };
