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
const bcrypt = require("bcryptjs");

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
  tipo TEXT NOT NULL DEFAULT 'nomina',
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

CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  creado_en TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_turnos_worker ON turnos(worker_id);
CREATE INDEX IF NOT EXISTS idx_turnos_entrada ON turnos(entrada);
CREATE UNIQUE INDEX IF NOT EXISTS idx_workers_pin_activo
  ON workers(pin) WHERE activo = 1;
CREATE UNIQUE INDEX IF NOT EXISTS idx_admins_usuario ON admins(usuario);
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

  // Migracion suave: columna "tipo" (nomina / residencias / dual). En una
  // base de datos nueva ya viene en el CREATE TABLE de arriba; en una que
  // ya existia, este ALTER falla con "duplicate column" y se ignora. Todo
  // trabajador que ya existiera queda como 'nomina' (el valor por default),
  // que es el comportamiento que ya tenia antes de este cambio.
  try {
    await db.execute("ALTER TABLE workers ADD COLUMN tipo TEXT NOT NULL DEFAULT 'nomina'");
  } catch (err) {
    // La columna ya existe: no hay nada que hacer.
  }

  // Catalogo de tipos de trabajador. Antes los tipos (nomina / residencias
  // / dual) estaban fijos en el codigo; ahora viven en esta tabla para que
  // desde el panel se puedan agregar tipos nuevos. "pagado" indica si a
  // ese tipo se le calcula salario (aparece en la pestana Nomina) o si
  // solo lleva asistencia. Los tres tipos originales se crean siempre y
  // quedan marcados como "fijo" (no se pueden eliminar).
  await db.execute(`
    CREATE TABLE IF NOT EXISTS tipos_trabajador (
      clave TEXT PRIMARY KEY,
      nombre TEXT NOT NULL,
      pagado INTEGER NOT NULL DEFAULT 0,
      fijo INTEGER NOT NULL DEFAULT 0,
      orden INTEGER NOT NULL,
      creado_en TEXT NOT NULL
    )`);
  const TIPOS_BASE = [
    ["nomina", "Nómina", 1, 1],
    ["residencias", "Residencias profesionales", 0, 2],
    ["dual", "Sistema dual", 0, 3],
  ];
  for (const [clave, nombre, pagado, orden] of TIPOS_BASE) {
    await db.execute({
      sql: `INSERT OR IGNORE INTO tipos_trabajador (clave, nombre, pagado, fijo, orden, creado_en)
            VALUES (?, ?, ?, 1, ?, ?)`,
      args: [clave, nombre, pagado, orden, new Date().toISOString()],
    });
  }

  // Arranque de seguridad: si todavia no existe NINGUN administrador en la
  // base de datos (por ejemplo, la primera vez que corre este codigo sobre
  // una instalacion que antes solo usaba ADMIN_USER/ADMIN_PASSWORD como
  // variables de entorno), se crea uno a partir de esas mismas variables,
  // pero con la contrasena ya cifrada (nunca se guarda en texto plano).
  // Una vez que existe al menos un administrador, el inicio de sesion deja
  // de leer esas variables por completo -- todo se maneja desde el panel
  // ("Mi cuenta"), donde la contrasena se puede cambiar cuando se quiera y
  // se pueden agregar mas administradores, cada uno con su propia
  // contrasena cifrada.
  const { rows: adminCountRows } = await db.execute(`SELECT COUNT(*) as c FROM admins`);
  if (adminCountRows[0].c === 0 && process.env.ADMIN_USER && process.env.ADMIN_PASSWORD) {
    const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 12);
    await db.execute({
      sql: `INSERT INTO admins (usuario, password_hash, creado_en) VALUES (?, ?, ?)`,
      args: [process.env.ADMIN_USER, hash, new Date().toISOString()],
    });
  }
}

module.exports = { db, migrate, isRemote };
