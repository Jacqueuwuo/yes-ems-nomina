// Reglas de contrasena compartidas entre las cuentas de administrador
// (src/auth.js) y las cuentas del Portal del trabajador
// (src/routes/worker-auth.js). Vivir en un solo archivo evita que las dos
// partes del sistema terminen con reglas distintas por accidente.
"use strict";

const BCRYPT_ROUNDS = 12;

// Requisito minimo para cualquier contrasena nueva: al menos 8 caracteres,
// con letras y numeros. No es infalible, pero evita las contrasenas mas
// debiles ("1234", "admin", etc.) sin pedir algo imposible de recordar.
function errorDeFortaleza(pw) {
  if (typeof pw !== "string" || pw.length < 8) {
    return "La contrasena debe tener al menos 8 caracteres.";
  }
  // Tope superior: bcrypt solo usa los primeros 72 caracteres de todos
  // modos, y sin este limite alguien podria mandar un texto enorme para
  // hacer que el servidor gaste tiempo de mas cifrandolo (un pequeno
  // ataque de negacion de servicio).
  if (pw.length > 72) {
    return "La contrasena es demasiado larga (maximo 72 caracteres).";
  }
  if (!/[a-zA-Z]/.test(pw) || !/[0-9]/.test(pw)) {
    return "La contrasena debe incluir letras y numeros.";
  }
  return null;
}

module.exports = { BCRYPT_ROUNDS, errorDeFortaleza };
