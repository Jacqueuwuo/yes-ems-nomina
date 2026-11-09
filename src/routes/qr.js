// Genera la imagen del codigo QR del checador en el propio servidor (no
// depende de ningun servicio externo). Requiere sesion iniciada.
"use strict";

const express = require("express");
const QRCode = require("qrcode");

const router = express.Router();

function checadorUrl(req) {
  return `${req.protocol}://${req.get("host")}/checador`;
}

router.get("/qr-url", (req, res) => {
  res.json({ url: checadorUrl(req) });
});

router.get("/qr.png", async (req, res) => {
  try {
    const buffer = await QRCode.toBuffer(checadorUrl(req), {
      type: "png",
      width: 480,
      margin: 2,
      color: { dark: "#123D38", light: "#FFFFFF" },
    });
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store");
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: "No se pudo generar el codigo QR." });
  }
});

module.exports = router;
