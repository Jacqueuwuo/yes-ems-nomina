// Envio de correos del Portal del trabajador (la verificacion de correo
// cuando un administrador agrega el correo de alguien). Usa la cuenta de
// Gmail de la empresa (o la que sea) a traves de SMTP, con una
// "contrasena de aplicacion" (App Password) -- NUNCA la contrasena normal
// de esa cuenta de Gmail.
//
// Variables de entorno necesarias (ver .env.example):
//   GMAIL_USER          -- el correo de Gmail que envia (ej. tuempresa@gmail.com)
//   GMAIL_APP_PASSWORD   -- la contrasena de aplicacion generada en
//                           myaccount.google.com/apppasswords (requiere
//                           tener activada la verificacion en dos pasos)
//
// Si estas variables no estan configuradas, el sistema sigue funcionando
// para todo lo demas -- simplemente no se puede agregar el correo de un
// trabajador nuevo (se avisa con un error claro en vez de fallar en
// silencio).
"use strict";

const nodemailer = require("nodemailer");

function mailerConfigurado() {
  return Boolean(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
}

let transporter = null;
function getTransporter() {
  if (!mailerConfigurado()) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD,
      },
    });
  }
  return transporter;
}

// Nombre que aparece como remitente (ej. "YES EMS - Nomina <correo@gmail.com>").
function remitente() {
  const nombre = process.env.GMAIL_FROM_NAME || "YES EMS - Nomina";
  return `"${nombre}" <${process.env.GMAIL_USER}>`;
}

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      default: return "&#39;";
    }
  });
}

// Correo de verificacion inicial: un enlace de un solo uso que lleva al
// trabajador a la pagina donde elige su contrasena. El enlace incluye el
// token en texto plano (eso es lo normal -- es como funcionan todos los
// enlaces de verificacion); lo que NUNCA se guarda en texto plano es su
// hash en la base de datos (ver src/routes/worker-auth.js).
async function enviarCorreoVerificacion({ to, nombre, verifyUrl, horasExpiracion }) {
  const t = getTransporter();
  if (!t) {
    throw new Error("El envio de correos no esta configurado (faltan GMAIL_USER / GMAIL_APP_PASSWORD).");
  }

  const nombreSeguro = escapeHtml(nombre || "");
  const horas = horasExpiracion || 48;

  const html = `
    <div style="font-family: Arial, Helvetica, sans-serif; max-width: 480px; margin: 0 auto; color: #1B2926;">
      <div style="background: #123D38; padding: 20px 24px; border-radius: 10px 10px 0 0;">
        <h1 style="color: #EAE6D9; font-size: 18px; margin: 0;">YES EMS &middot; Nomina</h1>
      </div>
      <div style="border: 1px solid #DEDACB; border-top: none; border-radius: 0 0 10px 10px; padding: 24px;">
        <p style="font-size: 15px; margin-top: 0;">Hola${nombreSeguro ? ", " + nombreSeguro : ""}:</p>
        <p style="font-size: 15px;">
          Te estamos dando acceso al <strong>Portal del trabajador</strong>, donde vas a poder
          descargar tu propio recibo de nomina (o tu desglose de horas) directo desde tu
          celular o computadora.
        </p>
        <p style="font-size: 15px;">
          Para activar tu cuenta, confirma tu correo y elige tu contrasena aqui:
        </p>
        <p style="text-align: center; margin: 28px 0;">
          <a href="${verifyUrl}" style="background: #123D38; color: #EAE6D9; text-decoration: none;
             padding: 12px 28px; border-radius: 8px; font-size: 15px; display: inline-block;">
            Activar mi cuenta
          </a>
        </p>
        <p style="font-size: 13px; color: #5E6E69;">
          Si el boton no funciona, copia y pega este enlace en tu navegador:<br>
          <a href="${verifyUrl}" style="color: #123D38;">${verifyUrl}</a>
        </p>
        <p style="font-size: 13px; color: #5E6E69;">
          Este enlace es de un solo uso y expira en ${horas} horas. Si tu no pediste esto,
          puedes ignorar este correo.
        </p>
      </div>
    </div>
  `;

  const text =
    `Hola${nombre ? ", " + nombre : ""}:\n\n` +
    `Te estamos dando acceso al Portal del trabajador de YES EMS, donde puedes descargar tu ` +
    `recibo de nomina (o tu desglose de horas).\n\n` +
    `Activa tu cuenta y elige tu contrasena aqui:\n${verifyUrl}\n\n` +
    `Este enlace expira en ${horas} horas. Si tu no pediste esto, puedes ignorar este correo.\n`;

  await t.sendMail({
    from: remitente(),
    to,
    subject: "Activa tu cuenta del Portal del trabajador - YES EMS",
    text,
    html,
  });
}

module.exports = { mailerConfigurado, enviarCorreoVerificacion };
