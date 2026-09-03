// Acceso a la base de datos. Usa libSQL (un motor 100% compatible con
// SQLite), que funciona en dos modos sin cambiar ni una linea de codigo:
//
//   - En tu computadora: guarda todo en un archivo local
//     (./data/nomina.db). No necesitas crear ninguna cuenta ni configurar
//     nada para probar el sistema.
//
//   - En un servidor gratuito como Render: el disco de la version gratis
//     se borra cada vez que el servicio se reinicia o se actualiza, asi
//     que ahi NO se usa un archivo local -- se usa una base de datos
//     libSQL gratuita y permanente en Turso (turso.tech), configurada con
//     las variables de entorno TURSO_DATABASE_URL y TURSO_AUTH_TOKEN.
//     Eso es lo que hace que la base de datos sea "fija": los datos viven
//     en Turso, no en el disco del servidor, y sobreviven cualquier
//     reinicio o nuevo despliegue.
//
// Ver README.md, seccion "Base de datos (Turso)", para como crear esa
// base de datos gratuita paso a paso.
"use strict";

const fs = require("fs");
const path = require("path");
const { createClient } = require("@libsql/client");

const REMOTE_URL = process.env.TURSO_DATABASE_URL || "";
const isRemote = REMOTE_URL.length > 0;

let connectionUrl;
if (isRemote) {
  connectionUrl = REMOTE_URL;
} else {
  const localPath = process.env.DB_PATH || "./data/nomina.db";
  const dir = path.dirname(localPath);
  if (dir && dir !== "." && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  connectionUrl = "file:" + path.resolve(localPath);
}

const db = createClient({
  url: connectionUrl,
  authToken: process.env.TURSO_AUTH_TOKEN || undefined,
  // Forzamos numeros normales de JavaScript (en vez de BigInt) para las
  // columnas INTEGER. Nuestros valores (ids, PINs, marcas de tiempo) caben
  // sin problema, y evita que res.json() truene al intentar convertir un
  // BigInt a JSON.
  intMode: "number",
});

const SCHEMA = `
${isRemote ? "" : "PRAGMA journal_mode = WAL;"}
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS workers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL,
  puesto TEXT,
  tarifa_normal REAL NOT NULL,
  tarifa_extra REAL NOT NULL,
  id_empleado TEXT NOT NULL DEFAULT '',
  pin TEXT NOT NULL,
  activo INTEGER NOT NULL DEFAULT 1,
  orden INTEGER NOT NULL,
  creado_en TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS turnos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  worker_id INTEGER NOT NULL REFERENCES workers(id),
  entrada TEXT NOT NULL,
  salida TEXT,
  horas REAL,
  origen TEXT NOT NULL DEFAULT 'qr'
);

CREATE TABLE IF NOT EXISTS periodos (
  id TEXT PRIMARY KEY,
  inicio TEXT NOT NULL,
  fin TEXT NOT NULL,
  cerrada INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS nomina_entries (
  periodo_id TEXT NOT NULL REFERENCES periodos(id),
  worker_id INTEGER NOT NULL REFERENCES workers(id),
  horas_normales REAL NOT NULL DEFAULT 0,
  horas_extra REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (periodo_id, worker_id)
);

CREATE INDEX IF NOT EXISTS idx_turnos_worker ON turnos(worker_id);
CREATE INDEX IF NOT EXISTS idx_turnos_entrada ON turnos(entrada);
CREATE UNIQUE INDEX IF NOT EXISTS idx_workers_pin_activo
  ON workers(pin) WHERE activo = 1;
`;

// Crea las tablas si todavia no existen. Se llama una vez al arrancar el
// servidor (ver server.js), antes de aceptar peticiones.
async function migrate() {
  await db.executeMultiple(SCHEMA);

  // Migracion suave: si el archivo de base de datos ya existia de una
  // version anterior a la columna id_empleado, la agregamos ahora. En una
  // base de datos nueva la columna ya viene incluida en el CREATE TABLE de
  // arriba, asi que este ALTER falla con "duplicate column" -- lo cual es
  // normal y simplemente se ignora.
  try {
    await db.execute("ALTER TABLE workers ADD COLUMN id_empleado TEXT NOT NULL DEFAULT ''");
  } catch (err) {
    // La columna ya existe: no hay nada que hacer.
  }
  await db.execute(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_workers_idempleado_activo
       ON workers(id_empleado) WHERE activo = 1 AND id_empleado != ''`
  );
}

module.exports = { db, migrate, isRemote };
