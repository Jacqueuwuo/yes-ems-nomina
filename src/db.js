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

-- "rol" distingue dos niveles de acceso al panel: 'admin' (completo --
-- puede editar trabajadores, nomina, asistencia, tipos, y a otros
-- administradores) y 'lectura' (solo puede ver trabajadores, su nomina/
-- asistencia, y descargar sus PDFs -- no puede modificar ni eliminar
-- nada). Los administradores ya existentes quedan como 'admin' (el
-- comportamiento que ya tenian antes de que existiera este campo).
CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  rol TEXT NOT NULL DEFAULT 'admin',
  creado_en TEXT NOT NULL
);

-- Cuenta del "Portal del trabajador" (mi-nomina): una por trabajador, ligada
-- a su correo real. Es independiente de su PIN del checador (eso sigue
-- siendo solo para marcar entrada/salida) y de la tabla de administradores
-- (eso sigue siendo solo para el panel completo). Aqui password_hash queda
-- NULL hasta que el trabajador confirma su correo y elige una contrasena;
-- mientras tanto, verify_token_hash/verify_token_expires guardan (cifrado,
-- nunca en texto plano) el enlace de verificacion que se le mando.
CREATE TABLE IF NOT EXISTS worker_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  worker_id INTEGER NOT NULL UNIQUE REFERENCES workers(id),
  email TEXT NOT NULL,
  password_hash TEXT,
  verify_token_hash TEXT,
  verify_token_expires TEXT,
  creado_en TEXT NOT NULL
);

-- Incidencias (retardos, faltas, permisos, justificantes...) de un
-- trabajador. Son solo un REGISTRO informativo: aprobar o rechazar una
-- incidencia aqui NO cambia sola las horas ni el pago de nadie -- eso lo
-- sigue decidiendo el administrador a mano, como ya se hacia antes. Sirven
-- para llevar un historial ordenado y consultable de quien llego tarde,
-- falto, pidio permiso, etc.
CREATE TABLE IF NOT EXISTS incidencias (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  worker_id INTEGER NOT NULL REFERENCES workers(id),
  tipo TEXT NOT NULL,
  descripcion TEXT NOT NULL DEFAULT '',
  fecha TEXT NOT NULL,
  estatus TEXT NOT NULL DEFAULT 'pendiente',
  creado_en TEXT NOT NULL,
  actualizado_en TEXT NOT NULL
);

-- Catalogo de conceptos de percepciones (bonos, apoyos, becas) y
-- deducciones (ISR, IMSS, Infonavit, etc.). Por ahora es solo un catalogo
-- de REFERENCIA para tenerlos organizados y documentados -- no se suman ni
-- se restan solos del total a pagar, que sigue siendo horas x tarifa como
-- ya funcionaba.
CREATE TABLE IF NOT EXISTS conceptos_nomina (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clave TEXT NOT NULL,
  concepto TEXT NOT NULL,
  categoria TEXT NOT NULL,
  tipo TEXT NOT NULL DEFAULT '',
  aplica_a TEXT NOT NULL DEFAULT 'todas',
  activo INTEGER NOT NULL DEFAULT 1,
  orden INTEGER NOT NULL,
  creado_en TEXT NOT NULL
);

-- Historial de reportes generados desde el apartado "Reportes" (solo para
-- mostrar la lista de "Reportes recientes" -- el archivo en si no se
-- guarda, se vuelve a generar al momento si se necesita otra vez).
CREATE TABLE IF NOT EXISTS reportes_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tipo TEXT NOT NULL,
  descripcion TEXT NOT NULL,
  formato TEXT NOT NULL,
  creado_por TEXT NOT NULL DEFAULT '',
  creado_en TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_turnos_worker ON turnos(worker_id);
CREATE INDEX IF NOT EXISTS idx_turnos_entrada ON turnos(entrada);
CREATE UNIQUE INDEX IF NOT EXISTS idx_workers_pin_activo
  ON workers(pin) WHERE activo = 1;
CREATE UNIQUE INDEX IF NOT EXISTS idx_admins_usuario ON admins(usuario);
CREATE UNIQUE INDEX IF NOT EXISTS idx_worker_accounts_email ON worker_accounts(email);
CREATE INDEX IF NOT EXISTS idx_incidencias_worker ON incidencias(worker_id);
CREATE INDEX IF NOT EXISTS idx_incidencias_fecha ON incidencias(fecha);
CREATE UNIQUE INDEX IF NOT EXISTS idx_conceptos_clave ON conceptos_nomina(clave);
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

  // Migracion suave: columna "email" en workers (correo real del
  // trabajador, para el Portal del trabajador). Igual que las anteriores,
  // en una base de datos nueva ya viene en el CREATE TABLE de arriba.
  try {
    await db.execute("ALTER TABLE workers ADD COLUMN email TEXT NOT NULL DEFAULT ''");
  } catch (err) {
    // La columna ya existe: no hay nada que hacer.
  }

  // Migracion suave: columna "rol" en admins ('admin' completo, o
  // 'lectura' solo para ver). Los administradores que ya existieran
  // quedan como 'admin' (el valor por default), igual que se comportaban
  // antes de que existiera este campo.
  try {
    await db.execute("ALTER TABLE admins ADD COLUMN rol TEXT NOT NULL DEFAULT 'admin'");
  } catch (err) {
    // La columna ya existe: no hay nada que hacer.
  }

  // Migracion suave: columnas para que un administrador NUEVO active su
  // propia cuenta y elija su propia contrasena (igual que ya funciona en
  // el Portal del trabajador), en vez de que quien lo agrega le escriba
  // una contrasena por el. "activada" en 1 significa que ya eligio su
  // contrasena y puede iniciar sesion; los administradores que ya
  // existieran (incluido el que se crea desde ADMIN_USER/ADMIN_PASSWORD)
  // quedan con activada=1 por default, sin ningun cambio en su
  // comportamiento. Mientras una cuenta este pendiente (activada=0),
  // password_hash guarda un relleno al que nadie conoce la contrasena
  // real -- asi la columna sigue sin aceptar NULL, pero el inicio de
  // sesion de todos modos queda bloqueado hasta que se active (ver
  // src/auth.js).
  try {
    await db.execute("ALTER TABLE admins ADD COLUMN email TEXT NOT NULL DEFAULT ''");
  } catch (err) {
    // La columna ya existe: no hay nada que hacer.
  }
  try {
    await db.execute("ALTER TABLE admins ADD COLUMN verify_token_hash TEXT");
  } catch (err) {
    // La columna ya existe: no hay nada que hacer.
  }
  try {
    await db.execute("ALTER TABLE admins ADD COLUMN verify_token_expires TEXT");
  } catch (err) {
    // La columna ya existe: no hay nada que hacer.
  }
  try {
    await db.execute("ALTER TABLE admins ADD COLUMN activada INTEGER NOT NULL DEFAULT 1");
  } catch (err) {
    // La columna ya existe: no hay nada que hacer.
  }
  await db.execute(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_admins_email ON admins(email) WHERE email != ''`
  );

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
    ["practicantes", "Practicantes", 0, 4],
  ];
  for (const [clave, nombre, pagado, orden] of TIPOS_BASE) {
    await db.execute({
      sql: `INSERT OR IGNORE INTO tipos_trabajador (clave, nombre, pagado, fijo, orden, creado_en)
            VALUES (?, ?, ?, 1, ?, ?)`,
      args: [clave, nombre, pagado, orden, new Date().toISOString()],
    });
  }

  // Migracion suave: columna "pagado" en nomina_entries (si ya se le
  // generó/entregó el recibo de esa quincena a ese trabajador). Se usa en
  // el apartado "Pagos y recibos"; no afecta el calculo del total, que
  // sigue siendo horas x tarifa igual que siempre.
  try {
    await db.execute("ALTER TABLE nomina_entries ADD COLUMN pagado INTEGER NOT NULL DEFAULT 0");
  } catch (err) {
    // La columna ya existe: no hay nada que hacer.
  }

  // Catalogo inicial de percepciones y deducciones (apartados
  // "Percepciones"/"Deducciones"): solo se crea si el catalogo esta
  // totalmente vacio, para no reinsertar nada si el administrador ya
  // borro o modifico estas filas de ejemplo.
  const { rows: conceptosCountRows } = await db.execute(`SELECT COUNT(*) as c FROM conceptos_nomina`);
  if (conceptosCountRows[0].c === 0) {
    const CONCEPTOS_BASE = [
      ["P001", "Sueldo base", "percepcion", "fijo", "nomina"],
      ["P002", "Bono de desempeño", "percepcion", "variable", "nomina,dual"],
      ["P003", "Apoyo de residencia", "percepcion", "fijo", "residencias"],
      ["P004", "Beca de practicante", "percepcion", "fijo", "practicantes"],
      ["D001", "ISR", "deduccion", "legal", "nomina"],
      ["D002", "IMSS", "deduccion", "legal", "nomina"],
      ["D003", "Infonavit", "deduccion", "legal", "nomina"],
      ["D004", "Faltas", "deduccion", "operativa", "todas"],
    ];
    let orden = 1;
    for (const [clave, concepto, categoria, tipo, aplicaA] of CONCEPTOS_BASE) {
      await db.execute({
        sql: `INSERT OR IGNORE INTO conceptos_nomina (clave, concepto, categoria, tipo, aplica_a, activo, orden, creado_en)
              VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
        args: [clave, concepto, categoria, tipo, aplicaA, orden++, new Date().toISOString()],
      });
    }
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
