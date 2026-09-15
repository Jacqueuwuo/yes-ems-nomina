// Punto de entrada del sistema de nomina de YES EMS.
// Sirve el panel de administracion, el checador (QR) publico y la API
// que ambos usan. Ver README.md para como instalarlo y desplegarlo.
"use strict";

require("dotenv").config({ quiet: true });
const path = require("path");
const express = require("express");
const session = require("express-session");
const rateLimit = require("express-rate-limit");

// ADMIN_USER/ADMIN_PASSWORD solo se usan UNA vez, para crear el primer
// administrador en la base de datos la primera vez que corre el servidor
// (ver src/db.js). Despues de eso, las contrasenas se manejan cifradas
// desde el panel ("Mi cuenta"), y estas dos variables ya no se vuelven a
// leer -- pero se piden aqui igual para no romper instalaciones existentes
// que ya las tenian configuradas.
const required = ["ADMIN_USER", "ADMIN_PASSWORD", "SESSION_SECRET"];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(
    "\nFaltan variables de entorno: " + missing.join(", ") +
      "\nCopia .env.example a .env y completa esos valores (o configuralos" +
      "\ncomo 'Environment Variables' en Render) antes de iniciar el servidor.\n"
  );
  process.exit(1);
}

const { migrate } = require("./src/db");
const { router: authRouter, requireAuth, guardAdminPage } = require("./src/auth");
const checadorApi = require("./src/routes/checador-api");
const adminApi = require("./src/routes/admin-api");
const exportApi = require("./src/routes/export");
const qrApi = require("./src/routes/qr");

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");

app.set("trust proxy", 1);
app.use(express.json());

// Este sistema es de uso interno (nomina y checador de un solo lugar de
// trabajo) -- no tiene ningun motivo para aparecer en buscadores como
// Google. Este encabezado le pide a los buscadores que no indexen nada.
app.use((req, res, next) => {
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  next();
});

// Limite general de peticiones por IP a toda la API, ademas de los limites
// mas estrictos que ya tienen /api/login y /api/checador/* especificamente
// (ver src/auth.js y src/routes/checador-api.js). Este es solo una red de
// seguridad adicional contra un uso abusivo o automatizado del sistema en
// general -- el limite es amplio a proposito para no estorbar el uso
// normal del panel (que hace varias peticiones por segundo al escribir
// horas, por ejemplo).
const limitadorApi = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutos
  limit: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Demasiadas peticiones. Espera unos minutos e intenta de nuevo." },
});
app.use("/api", limitadorApi);

app.use(
  session({
    name: "yesems.sid",
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      // "auto" hace que la cookie de sesion solo se envie por HTTPS cuando
      // la peticion en si llego por HTTPS (Render siempre usa HTTPS de
      // cara al publico) y funcione igual en http://localhost al probar en
      // tu computadora. Junto con "trust proxy" de arriba, detecta esto
      // correctamente aunque Render este como intermediario.
      secure: "auto",
      sameSite: "lax",
      maxAge: 1000 * 60 * 60 * 12, // 12 horas
    },
  })
);

/* --------------------------------- API --------------------------------- */
app.use(authRouter);
app.use("/api/checador", checadorApi);
app.use("/api", requireAuth, adminApi);
app.use("/api", requireAuth, exportApi);
app.use("/api", requireAuth, qrApi);

/* ------------------------------- Paginas -------------------------------- */
app.get("/", (req, res) => {
  res.redirect(req.session && req.session.loggedIn ? "/admin" : "/login");
});

app.get("/login", (req, res) => {
  if (req.session && req.session.loggedIn) return res.redirect("/admin");
  res.sendFile(path.join(PUBLIC_DIR, "login", "index.html"));
});

app.get("/admin", guardAdminPage, (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "admin", "index.html"));
});

// El checador es publico: cualquiera con el enlace (o el QR impreso)
// puede abrirlo, pero solo puede marcar entrada/salida si conoce el PIN
// de un trabajador activo.
app.get("/checador", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "checador", "index.html"));
});

app.use(express.static(PUBLIC_DIR));

/* ------------------------------- Errores -------------------------------- */
app.use("/api", (req, res) => {
  res.status(404).json({ error: "Ruta no encontrada." });
});
app.use((err, req, res, next) => {
  console.error(err);
  if (req.path.startsWith("/api")) {
    return res.status(500).json({ error: "Error interno del servidor." });
  }
  res.status(500).send("Error interno del servidor.");
});

migrate()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`YES EMS Nomina escuchando en http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error("\nNo se pudo preparar la base de datos:\n", err);
    process.exit(1);
  });
