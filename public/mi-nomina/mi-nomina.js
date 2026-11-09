(function () {
  "use strict";

  var app = document.getElementById("miNominaApp");

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function pad(n) { return String(n).padStart(2, "0"); }

  function api(method, path, body) {
    return fetch(path, {
      method: method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) {
      if (r.status === 204) return null;
      return r.json().then(function (data) {
        if (!r.ok) throw new Error((data && data.error) || "Ocurrió un error.");
        return data;
      });
    });
  }

  /* ----------------- Quincenas (mismo calculo que el panel) ----------------- */
  function lastDayOfMonth(y, m) { return new Date(y, m + 1, 0).getDate(); }
  function quincenaFor(date) {
    var y = date.getFullYear(), m = date.getMonth(), day = date.getDate();
    var lastDay = lastDayOfMonth(y, m);
    if (day === lastDay) {
      var nm = m + 1, ny = y;
      if (nm > 11) { nm = 0; ny = y + 1; }
      return { inicio: new Date(y, m, day), fin: new Date(ny, nm, 14), half: 1, idYear: ny, idMonth: nm };
    }
    if (day >= 15) {
      return { inicio: new Date(y, m, 15), fin: new Date(y, m, lastDay - 1), half: 2, idYear: y, idMonth: m };
    }
    var pm = m - 1, py = y;
    if (pm < 0) { pm = 11; py = y - 1; }
    var prevLast = lastDayOfMonth(py, pm);
    return { inicio: new Date(py, pm, prevLast), fin: new Date(y, m, 14), half: 1, idYear: y, idMonth: m };
  }
  function periodIdFor(q) { return q.idYear + "-" + pad(q.idMonth + 1) + "-" + q.half; }
  function shiftQuincena(anchor, dir) {
    var q = quincenaFor(anchor);
    var mid = new Date((q.inicio.getTime() + q.fin.getTime()) / 2);
    mid.setDate(mid.getDate() + dir * 16);
    return mid;
  }

  var ICON_DOWNLOAD =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="M7 11l5 5 5-5"/><path d="M5 20h14"/></svg>';

  /* ================================ Vistas ================================ */

  function renderLoading() {
    app.innerHTML = '<div class="mn-card"><p class="mn-loading">Cargando…</p></div>';
  }

  function brandBlock(titulo, sub) {
    return (
      '<div class="mn-brand"><img src="/assets/logo.png" alt=""><span>YES EMS</span></div>' +
      '<h1 class="mn-title">' + escapeHtml(titulo) + "</h1>" +
      (sub ? '<p class="mn-sub">' + escapeHtml(sub) + "</p>" : "")
    );
  }

  /* -------------------------- Activar cuenta (token) -------------------------- */
  function renderActivar(token) {
    renderLoading();
    api("GET", "/api/worker/verify/" + encodeURIComponent(token))
      .then(function (data) {
        app.innerHTML =
          '<div class="mn-card">' +
          brandBlock("Activa tu cuenta", "Hola, " + data.nombre + ". Elige tu contraseña para entrar al Portal del trabajador.") +
          '<form class="mn-form" id="activarForm">' +
          '<div class="field"><label>Correo</label><input type="text" value="' + escapeHtml(data.email) + '" disabled></div>' +
          '<div class="field"><label for="mnPass1">Nueva contraseña</label><input id="mnPass1" type="password" autocomplete="new-password" required></div>' +
          '<div class="field"><label for="mnPass2">Repite la contraseña</label><input id="mnPass2" type="password" autocomplete="new-password" required></div>' +
          '<p class="field-hint">Al menos 8 caracteres, con letras y números.</p>' +
          '<p class="mn-error" id="activarError">&nbsp;</p>' +
          '<button class="mn-btn" type="submit">Activar mi cuenta</button>' +
          "</form>" +
          "</div>";

        document.getElementById("activarForm").addEventListener("submit", function (e) {
          e.preventDefault();
          var errEl = document.getElementById("activarError");
          errEl.textContent = "";
          var p1 = document.getElementById("mnPass1").value;
          var p2 = document.getElementById("mnPass2").value;
          if (p1 !== p2) { errEl.textContent = "Las contraseñas no coinciden."; return; }
          api("POST", "/api/worker/verify/" + encodeURIComponent(token), { password: p1 })
            .then(function () {
              window.history.replaceState({}, "", "/mi-nomina");
              renderPortal();
            })
            .catch(function (err) { errEl.textContent = err.message; });
        });
      })
      .catch(function (err) {
        app.innerHTML =
          '<div class="mn-card">' +
          brandBlock("Enlace no válido", err.message) +
          '<button class="mn-link" id="irLogin">Ir a iniciar sesión</button>' +
          "</div>";
        document.getElementById("irLogin").addEventListener("click", function () {
          window.history.replaceState({}, "", "/mi-nomina");
          renderLogin();
        });
      });
  }

  /* --------------------------------- Login --------------------------------- */
  function renderLogin(mensaje) {
    app.innerHTML =
      '<div class="mn-card">' +
      brandBlock("Mi nómina", "Entra con el correo que te dio tu administrador.") +
      '<form class="mn-form" id="loginForm">' +
      '<div class="field"><label for="mnEmail">Correo</label><input id="mnEmail" type="email" autocomplete="username" required></div>' +
      '<div class="field"><label for="mnLoginPass">Contraseña</label><input id="mnLoginPass" type="password" autocomplete="current-password" required></div>' +
      '<p class="mn-error" id="loginError">' + (mensaje ? escapeHtml(mensaje) : "&nbsp;") + "</p>" +
      '<button class="mn-btn" type="submit">Entrar</button>' +
      "</form>" +
      "</div>";

    document.getElementById("loginForm").addEventListener("submit", function (e) {
      e.preventDefault();
      var errEl = document.getElementById("loginError");
      errEl.textContent = "";
      var email = document.getElementById("mnEmail").value.trim();
      var password = document.getElementById("mnLoginPass").value;
      api("POST", "/api/worker/login", { email: email, password: password })
        .then(function () { renderPortal(); })
        .catch(function (err) { errEl.textContent = err.message; });
    });
  }

  /* --------------------------------- Portal --------------------------------- */
  function renderPortal() {
    renderLoading();
    var anchor = new Date();
    var nombre = "";

    api("GET", "/api/worker/session")
      .then(function (s) {
        if (!s.loggedIn) { renderLogin(); return Promise.reject({ handled: true }); }
        nombre = s.nombre;
        return cargarPeriodo(anchor, nombre);
      })
      .catch(function (err) {
        if (!err || !err.handled) renderLogin((err && err.message) || "");
      });
  }

  function cargarPeriodo(anchor, nombre) {
    var q = quincenaFor(anchor);
    var pid = periodIdFor(q);
    return api("GET", "/api/worker/resumen?periodo=" + encodeURIComponent(pid))
      .then(function (data) { pintarPortal(anchor, nombre, data); })
      .catch(function (err) {
        app.innerHTML = '<div class="mn-card">' + brandBlock("No se pudo cargar", err.message) + "</div>";
      });
  }

  function pintarPortal(anchor, nombre, data) {
    var q = quincenaFor(anchor);
    var pid = periodIdFor(q);
    var hoy = new Date();
    var esActual = quincenaFor(hoy).idYear === q.idYear && quincenaFor(hoy).idMonth === q.idMonth && quincenaFor(hoy).half === q.half;

    var turnosHtml = data.turnos.length
      ? data.turnos
          .map(function (t) {
            return (
              '<div class="mn-turno-row"><span class="mn-turno-fecha">' + escapeHtml(t.fecha) + "</span>" +
              '<span class="mn-turno-horario">' + escapeHtml(t.entrada) + " – " + (t.salida ? escapeHtml(t.salida) : "turno abierto") + "</span>" +
              '<span class="mn-turno-horas">' + (t.horasTexto ? escapeHtml(t.horasTexto) : "—") + "</span></div>"
            );
          })
          .join("")
      : '<div class="mn-turnos-empty">Sin registros de entrada/salida en esta quincena.</div>';

    app.innerHTML =
      '<div class="mn-portal">' +
      '<div class="mn-topbar"><div class="mn-hello"><strong>Hola, ' + escapeHtml(nombre) + "</strong>" +
      '<span>' + escapeHtml(data.puesto || "") + "</span></div>" +
      '<button class="mn-logout" id="mnLogout">Salir</button></div>' +

      '<div class="mn-nav">' +
      '<button class="mn-nav-btn" id="mnPrev" aria-label="Quincena anterior">‹</button>' +
      '<div class="mn-nav-range">' + escapeHtml(data.rango) + "</div>" +
      '<button class="mn-nav-btn" id="mnNext" aria-label="Quincena siguiente"' + (esActual ? " disabled" : "") + ">›</button>" +
      "</div>" +

      '<div class="mn-summary">' +
      (data.esPagado
        ? '<p class="total-label">Total a pagar</p><p class="total">' + escapeHtml(data.totalTexto) + "</p>" +
          '<p class="horas">' + escapeHtml(data.horasTexto) + "</p><p class=\"puesto\">Horas capturadas en nómina</p>"
        : '<p class="total-label">Horas trabajadas</p><p class="horas" style="font-size:1.9rem;color:var(--brand);">' + escapeHtml(data.horasTexto) + "</p>") +
      "</div>" +

      '<a class="mn-download" href="/api/worker/pdf?periodo=' + encodeURIComponent(pid) + '">' + ICON_DOWNLOAD +
      (data.esPagado ? "Descargar mi recibo (PDF)" : "Descargar mi desglose (PDF)") + "</a>" +

      '<div class="mn-turnos"><h3>Entradas y salidas</h3>' + turnosHtml + "</div>" +
      "</div>";

    document.getElementById("mnLogout").addEventListener("click", function () {
      api("POST", "/api/worker/logout").then(function () { renderLogin(); });
    });
    document.getElementById("mnPrev").addEventListener("click", function () {
      cargarPeriodo(shiftQuincena(anchor, -1), nombre);
    });
    var nextBtn = document.getElementById("mnNext");
    if (!nextBtn.disabled) {
      nextBtn.addEventListener("click", function () {
        cargarPeriodo(shiftQuincena(anchor, 1), nombre);
      });
    }
  }

  /* ================================= Arranque ================================= */
  var params = new URLSearchParams(window.location.search);
  var token = params.get("token");
  if (token) renderActivar(token);
  else renderPortal();
})();
