// Helpers para el catalogo de tipos de trabajador (tabla tipos_trabajador,
// ver src/db.js). Se usa tanto en la API del panel como en la exportacion
// a Excel.
"use strict";

const { db } = require("./db");

async function listTipos() {
  const { rows } = await db.execute(`SELECT * FROM tipos_trabajador ORDER BY orden ASC, creado_en ASC`);
  return rows.map((r) => ({
    clave: r.clave,
    nombre: r.nombre,
    pagado: !!r.pagado,
    fijo: !!r.fijo,
  }));
}

// { clave: { nombre, pagado } }
async function tiposMap() {
  const map = {};
  (await listTipos()).forEach((t) => (map[t.clave] = t));
  return map;
}

// Lista de claves de los tipos a los que se les paga (para filtrar la
// nomina). Siempre incluye "nomina" aunque alguien la hubiera cambiado.
async function clavesPagadas() {
  const claves = (await listTipos()).filter((t) => t.pagado).map((t) => t.clave);
  if (!claves.includes("nomina")) claves.push("nomina");
  return claves;
}

// Convierte "Prácticas Profesionales" en "practicas-profesionales".
function slugify(nombre) {
  return String(nombre || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

module.exports = { listTipos, tiposMap, clavesPagadas, slugify };
