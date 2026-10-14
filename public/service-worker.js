// Service worker minimo: NO guarda copia de nada (los datos de nomina y
// asistencia siempre tienen que venir del servidor, nunca de una copia
// vieja). Solo existe para que el navegador permita "Instalar" la app
// como si fuera un programa aparte, con su propio icono.
"use strict";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  event.respondWith(fetch(event.request));
});
