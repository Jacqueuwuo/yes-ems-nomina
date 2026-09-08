// Helpers para trabajar con "periodos" (quincenas de pago) a partir de su
// id, con el mismo formato que genera el panel: "YYYY-MM-1" o "YYYY-MM-2".
//
// Las quincenas se cuentan por dia de pago (15 y ultimo dia del mes, que
// puede ser 28, 29, 30 o 31 segun el mes):
//   Quincena 1: del ultimo dia del mes ANTERIOR al 14 de este mes. Se paga
//               el 15.
//   Quincena 2: del 15 al dia antes del ultimo dia de este mes. Se paga el
//               ultimo dia del mes (30, 31, o 28/29 en febrero).
// Es decir, el ultimo dia de cada mes siempre es el primer dia de la
// quincena 1 del mes siguiente (nunca el ultimo dia de la quincena 2 de su
// propio mes).
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
    // Quincena 1: del ultimo dia del mes anterior al 14 de este mes.
    let prevMonthIndex = monthIndex - 1;
    let prevYear = year;
    if (prevMonthIndex < 0) { prevMonthIndex = 11; prevYear = year - 1; }
    const prevLast = lastDayOfMonth(prevYear, prevMonthIndex);
    const inicio = `${prevYear}-${pad(prevMonthIndex + 1)}-${pad(prevLast)}`;
    return { year, monthIndex, half, inicio, fin: `${m[1]}-${m[2]}-14` };
  }
  // Quincena 2: del 15 al dia antes del ultimo dia de este mes.
  const last = lastDayOfMonth(year, monthIndex);
  return { year, monthIndex, half, inicio: `${m[1]}-${m[2]}-15`, fin: `${m[1]}-${m[2]}-${pad(last - 1)}` };
}

function fmtRangeEs(periodId) {
  const q = quincenaFromId(periodId);
  if (!q) return periodId;
  const mes = MESES[q.monthIndex];
  const dFin = Number(q.fin.slice(-2));
  if (q.half === 1) {
    // La quincena 1 empieza en el mes anterior (ver quincenaFromId).
    const iniParts = q.inicio.split("-");
    const mesIni = MESES[Number(iniParts[1]) - 1];
    const dIni = Number(iniParts[2]);
    return `${dIni} de ${mesIni}–${dFin} de ${mes} de ${q.year}`;
  }
  const dIni = Number(q.inicio.slice(-2));
  return `${dIni}-${dFin} de ${mes} de ${q.year}`;
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

module.exports = { quincenaFromId, fmtRangeEs, round2, pad, lastDayOfMonth };
