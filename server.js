// Punto de entrada del sistema de nomina de YES EMS.
// Sirve el panel de administracion, el checador (QR) publico y la API
// que ambos usan. Ver README.md para como instalarlo y desplegarlo.
"use strict";

require("dotenv").config({ quiet: true });
const path = require("path");
const express = require("express");
const session = require("express-session");

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
app.use(
  session({
    name: "yesems.sid",
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
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
