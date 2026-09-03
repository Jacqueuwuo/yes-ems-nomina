// Helpers para trabajar con "periodos" (quincenas: 1-15 y 16-fin de mes)
// a partir de su id, con el mismo formato que genera el panel:
// "YYYY-MM-1" (dias 1-15) o "YYYY-MM-2" (16 a fin de mes).
"use strict";

function pad(n) {
  return String(n).padStart(2, "0");
}

function lastDayOfMonth(year, monthIndex0) {
  return new Date(Date.UTC(year, monthIndex0 + 1, 0)).getUTCDate();
}

const MESES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

// Devuelve { year, monthIndex, half, inicio, fin } con inicio/fin como
// "YYYY-MM-DD", o null si el id no tiene un formato valido.
function quincenaFromId(id) {
  const m = /^(\d{4})-(\d{2})-([12])$/.exec(String(id || ""));
  if (!m) return null;
  const year = Number(m[1]);
  const monthNum = Number(m[2]);
  const monthIndex = monthNum - 1;
  const half = Number(m[3]);
  if (monthIndex < 0 || monthIndex > 11) return null;

  if (half === 1) {
    return { year, monthIndex, half, inicio: `${m[1]}-${m[2]}-01`, fin: `${m[1]}-${m[2]}-15` };
  }
  const last = lastDayOfMonth(year, monthIndex);
  return { year, monthIndex, half, inicio: `${m[1]}-${m[2]}-16`, fin: `${m[1]}-${m[2]}-${pad(last)}` };
}

function fmtRangeEs(periodId) {
  const q = quincenaFromId(periodId);
  if (!q) return periodId;
  const mes = MESES[q.monthIndex];
  const dIni = Number(q.inicio.slice(-2));
  const dFin = Number(q.fin.slice(-2));
  return `${dIni}-${dFin} de ${mes} de ${q.year}`;
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

module.exports = { quincenaFromId, fmtRangeEs, round2, pad, lastDayOfMonth };
