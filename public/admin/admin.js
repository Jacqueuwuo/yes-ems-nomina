(function () {
  "use strict";

  /* ============ Helpers ============ */
  function pad(n) { return String(n).padStart(2, "0"); }
  function ymd(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function round2(n) { return Math.round(n * 100) / 100; }
  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  var moneyFmt = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" });
  function fmtMoney(n) { return moneyFmt.format(n || 0); }
  // Muestra las horas como "1 h 50 min" en vez de "1.83 h" -- mismo dato,
  // nada mas presentado de forma natural (se usa en Asistencia y en los
  // totales, que se calculan solos a partir de la entrada/salida real).
  function fmtHours(n) {
    var hm = decToHM(n);
    if (hm.h === 0 && hm.m === 0) return "0 min";
    if (hm.h === 0) return hm.m + " min";
    if (hm.m === 0) return hm.h + " h";
    return hm.h + " h " + hm.m + " min";
  }
  function fmtDateTime(d) { return d.toLocaleString("es-MX", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }); }
  // Convierte horas decimales (como se guardan) a horas y minutos enteros
  // para capturarlas de forma natural ("1 hora, 48 minutos") en vez de
  // pedirle a quien captura que haga la conversion a decimal ella misma.
  function decToHM(dec) {
    dec = Math.max(0, Number(dec) || 0);
    var h = Math.floor(dec);
    var m = Math.round((dec - h) * 60);
    if (m === 60) { m = 0; h += 1; }
    return { h: h, m: m };
  }
  // OJO: aqui NO se redondea a centesimas de hora. "1 hora 10 minutos" debe
  // guardarse como 70/60 horas exacto (1.16666...), no como "1.17" -- si se
  // redondeara a centesimas antes de multiplicar por la tarifa, el sueldo
  // podria salir con unos centavos de mas o de menos. El resultado se
  // vuelve a convertir a horas y minutos enteros sin ningun error (ver
  // decToHM), y el total en pesos ya se muestra correctamente redondeado a
  // centavos al formatearlo con fmtMoney.
  function hmToDec(h, m) {
    h = Math.max(0, Math.floor(Number(h) || 0));
    m = Math.max(0, Math.min(59, Math.floor(Number(m) || 0)));
    return h + m / 60;
  }
  function toLocalInputValue(d) {
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "T" + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }

  // Quincenas por dia de pago (15 y ultimo dia del mes, que segun el mes
  // puede ser 28, 29, 30 o 31): quincena 1 va del ultimo dia del mes
  // ANTERIOR al 14 de este mes (se paga el 15); quincena 2 va del 15 al
  // dia antes del ultimo dia de este mes (se paga el ultimo dia del mes).
  // El ultimo dia de cada mes siempre cae en la quincena 1 del mes
  // siguiente, nunca en la quincena 2 de su propio mes.
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
  function fmtRange(q) {
    var a = q.inicio.toLocaleDateString("es-MX", { day: "numeric", month: "short" });
    var b = q.fin.toLocaleDateString("es-MX", { day: "numeric", month: "short", year: "numeric" });
    return a + " – " + b;
  }

  /* ============ API client ============ */
  function api(method, path, body) {
    return fetch(path, {
      method: method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) {
      if (r.status === 401) {
        window.location.href = "/login";
        throw new Error("No autorizado");
      }
      if (r.status === 204) return null;
      return r.json().then(function (data) {
        if (!r.ok) throw new Error((data && data.error) || "Ocurrió un error.");
        return data;
      });
    });
  }

  /* ============ State ============ */
  var workers = [];
  // Catalogo de tipos de trabajador (se carga de /api/tipos). Los tres
  // originales vienen de fabrica; se pueden agregar mas desde la ventana
  // de "Nuevo trabajador".
  var tipos = [
    { clave: "nomina", nombre: "Nómina", pagado: true, fijo: true },
    { clave: "residencias", nombre: "Residencias profesionales", pagado: false, fijo: true },
    { clave: "dual", nombre: "Sistema dual", pagado: false, fijo: true },
  ];
  function tipoInfo(clave) {
    clave = clave || "nomina";
    for (var i = 0; i < tipos.length; i++) if (tipos[i].clave === clave) return tipos[i];
    return { clave: clave, nombre: clave, pagado: clave === "nomina", fijo: false };
  }
  function esPagado(w) { return tipoInfo(w && w.tipo).pagado; }
  function tipoLabel(clave) { return tipoInfo(clave).nombre; }
  var periodAnchor = new Date();
  var currentPeriodData = null;
  var currentTurnos = [];
  var adminView = "nomina"; // nomina | asistencia
  var deleteConfirmId = null;
  var turnoDeleteConfirmId = null;
  var saveTimers = {};
  var currentClosed = false;
  var asistenciaSubtotals = {};

  /* ============ DOM refs ============ */
  var el = {
    workerList: document.getElementById("workerList"),
    btnAddSide: document.getElementById("btnAddSide"),
    btnAccount: document.getElementById("btnAccount"),
    btnLogout: document.getElementById("btnLogout"),
    sideUser: document.getElementById("sideUser"),
    periodLabel: document.getElementById("periodLabel"),
    periodSub: document.getElementById("periodSub"),
    btnPrev: document.getElementById("btnPrev"),
    btnNext: document.getElementById("btnNext"),
    statusPill: document.getElementById("statusPill"),
    statusText: document.getElementById("statusText"),
    saveStatus: document.getElementById("saveStatus"),
    statLabel1: document.getElementById("statLabel1"),
    statLabel2: document.getElementById("statLabel2"),
    statLabel3: document.getElementById("statLabel3"),
    statTrabajadores: document.getElementById("statTrabajadores"),
    statHoras: document.getElementById("statHoras"),
    statTotal: document.getElementById("statTotal"),
    tableWrap: document.getElementById("tableWrap"),
    modalBackdrop: document.getElementById("modalBackdrop"),
    modal: document.getElementById("modal"),
    btnExport: document.getElementById("btnExport"),
    btnExportHistorial: document.getElementById("btnExportHistorial"),
    btnQr: document.getElementById("btnQr"),
    tabNomina: document.getElementById("tabNomina"),
    tabAsistencia: document.getElementById("tabAsistencia"),
    toastStack: document.getElementById("toastStack"),
  };

  /* ============ Toasts ============ */
  function showToast(msg, type) {
    var t = document.createElement("div");
    t.className = "toast" + (type ? " " + type : "");
    t.textContent = msg;
    el.toastStack.appendChild(t);
    setTimeout(function () { t.remove(); }, 3800);
  }

  /* ============ Sidebar ============ */

  function workerChipHtml(w) {
    return '<button class="worker-chip" type="button" data-open-worker="' + w.id + '">' +
      '<span class="wc-top"><span class="wc-name">' + escapeHtml(w.nombre) + '</span>' +
      (esPagado(w) ? '<span class="wc-rate">' + fmtMoney(w.tarifaNormal) + '/h</span>' : '') + '</span>' +
      (w.puesto ? '<span class="wc-puesto">' + escapeHtml(w.puesto) + '</span>' : '') +
      '<span class="wc-id">No. ' + escapeHtml(w.idEmpleado || "—") + '</span>' +
      '</button>';
  }

  function renderSidebar() {
    var active = workers.filter(function (w) { return w.activo; });
    if (active.length === 0) {
      el.workerList.innerHTML = '<div class="side-empty">Aún no hay trabajadores registrados.</div>';
      return;
    }
    var html = "";
    var orden = tipos.map(function (t) { return t.clave; });
    // Por si algun trabajador tiene un tipo que ya no esta en el catalogo.
    active.forEach(function (w) { var c = w.tipo || "nomina"; if (orden.indexOf(c) === -1) orden.push(c); });
    orden.forEach(function (tipo) {
      var group = active.filter(function (w) { return (w.tipo || "nomina") === tipo; });
      if (group.length === 0) return;
      html += '<div class="wc-group-label">' + escapeHtml(tipoLabel(tipo)) + '</div>';
      html += group.map(workerChipHtml).join("");
    });
    el.workerList.innerHTML = html;
  }
  el.workerList.addEventListener("click", function (e) {
    var btn = e.target.closest("[data-open-worker]");
    if (btn) openWorkerModal(Number(btn.getAttribute("data-open-worker")));
  });
  el.btnAddSide.addEventListener("click", function () { openWorkerModal(null); });

  /* ============ Session / logout ============ */
  api("GET", "/api/session").then(function (data) {
    el.sideUser.textContent = data.usuario ? "Sesión: " + data.usuario : "";
  }).catch(function () {});
  el.btnLogout.addEventListener("click", function () {
    api("POST", "/api/logout").then(function () { window.location.href = "/login"; });
  });

  /* ============ View tabs ============ */
  function setView(view) {
    adminView = view;
    el.tabNomina.classList.toggle("active", view === "nomina");
    el.tabAsistencia.classList.toggle("active", view === "asistencia");
    el.btnExport.hidden = view !== "nomina";
    if (view === "nomina") {
      el.statLabel1.textContent = "Trabajadores";
      el.statLabel2.textContent = "Horas registradas";
      el.statLabel3.textContent = "Total a pagar";
      renderTable(currentPeriodData);
      stopAsistenciaPolling();
    } else {
      el.statLabel1.textContent = "Turnos registrados";
      el.statLabel2.textContent = "Horas totales";
      el.statLabel3.textContent = "Turnos abiertos";
      renderAsistencia();
      refreshTurnos();
      startAsistenciaPolling();
    }
  }
  el.tabNomina.addEventListener("click", function () { setView("nomina"); });
  el.tabAsistencia.addEventListener("click", function () { setView("asistencia"); });

  /* ============ Period nav ============ */
  function renderTopbarLabels() {
    var q = quincenaFor(periodAnchor);
    el.periodLabel.textContent = fmtRange(q);
    el.periodSub.textContent = "Quincena " + q.half + (q.half === 1 ? " (fin de mes anterior–14, se paga el 15)" : " (15–un día antes de fin de mes, se paga el último día)");
  }
  el.btnPrev.addEventListener("click", function () {
    var q = quincenaFor(periodAnchor);
    var d = new Date(q.inicio); d.setDate(d.getDate() - 1);
    periodAnchor = d;
    loadPeriod();
  });
  el.btnNext.addEventListener("click", function () {
    var q = quincenaFor(periodAnchor);
    var d = new Date(q.fin); d.setDate(d.getDate() + 1);
    periodAnchor = d;
    loadPeriod();
  });

  function updateStatusPill(closed) {
    currentClosed = closed;
    el.statusPill.className = "status-pill " + (closed ? "closed" : "open");
    el.statusText.textContent = closed ? "Pagada" : "Abierta";
  }
  el.statusPill.addEventListener("click", function () {
    var q = quincenaFor(periodAnchor);
    var pid = periodIdFor(q);
    var next = !currentClosed;
    updateStatusPill(next);
    setInputsDisabled(next);
    api("PUT", "/api/periods/" + pid + "/cerrada", { cerrada: next }).catch(function () {
      showToast("No se pudo actualizar el estado de la quincena.", "error");
      updateStatusPill(!next);
      setInputsDisabled(!next);
    });
  });
  function setInputsDisabled(disabled) {
    document.querySelectorAll(".hours-input").forEach(function (inp) { inp.disabled = disabled; });
  }

  /* ============ Nómina table ============ */
  // Solo los trabajadores de tipo "nomina" tienen sueldo y aparecen en esta
  // pestaña; los de residencias profesionales y sistema dual solo marcan
  // asistencia (pestaña "Asistencia") y no tienen tarifa ni total a pagar.
  function displayWorkersFor(entries) {
    var active = workers.filter(function (w) { return w.activo && esPagado(w); });
    var ids = {};
    active.forEach(function (w) { ids[w.id] = true; });
    var extra = [];
    if (entries) {
      Object.keys(entries).forEach(function (wid) {
        if (!ids[wid]) {
          var w = workers.find(function (x) { return String(x.id) === String(wid) && esPagado(x); });
          if (w) extra.push(w);
        }
      });
    }
    return active.concat(extra);
  }

  function renderTable(periodData) {
    if (adminView !== "nomina") return;
    var list = displayWorkersFor(periodData && periodData.entries);
    if (list.length === 0) {
      el.tableWrap.innerHTML =
        '<div class="empty-state">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>' +
        "<h2>Aún no hay trabajadores</h2>" +
        "<p>Agrega a tu primer instructor, coordinador o administrativo para empezar a registrar sus horas de esta quincena.</p>" +
        '<button class="btn btn-primary" type="button" id="btnEmptyAdd">Agregar primer trabajador</button>' +
        "</div>";
      var btn = document.getElementById("btnEmptyAdd");
      if (btn) btn.addEventListener("click", function () { openWorkerModal(null); });
      return;
    }

    var entries = (periodData && periodData.entries) || {};
    var closed = !!(periodData && periodData.cerrada);

    var rows = list.map(function (w) {
      var e = entries[w.id] || {};
      var hn = e.horasNormales || 0;
      var hm = decToHM(hn);
      var inactive = !w.activo;
      return '<tr data-worker="' + w.id + '" data-tn="' + w.tarifaNormal + '" class="' + (inactive ? "inactive" : "") + '">' +
        '<td class="cell-name"><div class="name">' + escapeHtml(w.nombre) + (inactive ? ' <span style="font-weight:400;color:var(--ink-soft);">(baja)</span>' : '') + '</div>' +
        (w.puesto ? '<div class="puesto">' + escapeHtml(w.puesto) + '</div>' : '') + '</td>' +
        '<td class="cell-num cell-hours">' +
        '<input class="hours-input hours-h" type="number" min="0" step="1" data-field="horasH" value="' + hm.h + '" ' + (closed ? "disabled" : "") + ' aria-label="Horas de ' + escapeHtml(w.nombre) + '"><span class="hm-sep">h</span>' +
        '<input class="hours-input hours-m" type="number" min="0" max="59" step="1" data-field="horasM" value="' + hm.m + '" ' + (closed ? "disabled" : "") + ' aria-label="Minutos de ' + escapeHtml(w.nombre) + '"><span class="hm-sep">min</span>' +
        '</td>' +
        '<td class="cell-num rate">' + fmtMoney(w.tarifaNormal) + '</td>' +
        '<td class="cell-num total"><span class="row-total">' + fmtMoney(hn * w.tarifaNormal) + '</span></td>' +
        '<td class="cell-actions">' + actionsHtml(w.id, false) + '</td>' +
        '</tr>';
    }).join("");

    el.tableWrap.innerHTML =
      '<div class="table-scroll"><table id="payTable">' +
      '<thead><tr>' +
      '<th>Trabajador</th><th class="cell-num">Horas y minutos</th><th class="cell-num">Tarifa/h</th>' +
      '<th class="cell-num">Total</th><th></th>' +
      '</tr></thead>' +
      '<tbody>' + rows + '</tbody>' +
      '<tfoot><tr>' +
      '<td colspan="3" class="foot-label">Total de la quincena</td>' +
      '<td class="cell-num" id="footTotal">$0.00</td><td></td>' +
      '</tr></tfoot>' +
      '</table></div>';

    recomputeAll();
  }

  function actionsHtml(workerId, confirming) {
    if (confirming) {
      return '<span class="confirm-text">¿Eliminar?</span>' +
        '<button class="confirm-btn" type="button" data-action="cancel-delete">No</button>' +
        '<button class="confirm-btn yes" type="button" data-action="confirm-delete">Sí</button>';
    }
    return '<button class="icon-btn" type="button" data-action="edit" title="Editar" aria-label="Editar trabajador">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>' +
      '</button>' +
      '<button class="icon-btn danger" type="button" data-action="delete" title="Eliminar" aria-label="Eliminar trabajador">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L4 6"/></svg>' +
      '</button>';
  }

  function updateRowTotal(row) {
    var h = parseFloat(row.querySelector('[data-field="horasH"]').value) || 0;
    var m = parseFloat(row.querySelector('[data-field="horasM"]').value) || 0;
    var hn = hmToDec(h, m);
    var tn = parseFloat(row.dataset.tn) || 0;
    var total = hn * tn;
    var totalEl = row.querySelector(".row-total");
    if (totalEl) totalEl.textContent = fmtMoney(total);
    return { hn: hn, total: total };
  }

  function recomputeAll() {
    var rows = document.querySelectorAll("#payTable tbody tr");
    var totalHoras = 0, totalPago = 0;
    rows.forEach(function (row) {
      var r = updateRowTotal(row);
      totalHoras += r.hn;
      totalPago += r.total;
    });
    var footTotal = document.getElementById("footTotal");
    if (footTotal) footTotal.textContent = fmtMoney(totalPago);
    el.statTrabajadores.textContent = rows.length;
    el.statHoras.textContent = fmtHours(totalHoras);
    el.statTotal.textContent = fmtMoney(totalPago);
  }

  function scheduleSave(workerId) {
    var q = quincenaFor(periodAnchor);
    var pid = periodIdFor(q);
    clearTimeout(saveTimers[workerId]);
    el.saveStatus.textContent = "Guardando…";
    el.saveStatus.classList.remove("err");
    saveTimers[workerId] = setTimeout(function () {
      var row = document.querySelector('tr[data-worker="' + CSS.escape(String(workerId)) + '"]');
      if (!row) return;
      var h = parseFloat(row.querySelector('[data-field="horasH"]').value) || 0;
      var m = parseFloat(row.querySelector('[data-field="horasM"]').value) || 0;
      var hn = hmToDec(h, m);
      api("PUT", "/api/periods/" + pid + "/entries/" + workerId, { horasNormales: hn })
        .then(function () {
          el.saveStatus.textContent = "Guardado";
          setTimeout(function () { if (el.saveStatus.textContent === "Guardado") el.saveStatus.textContent = ""; }, 1800);
        })
        .catch(function () {
          el.saveStatus.textContent = "Error al guardar";
          el.saveStatus.classList.add("err");
          showToast("No se pudieron guardar las horas. Verifica tu conexión e inténtalo de nuevo.", "error");
        });
    }, 500);
  }

  el.tableWrap.addEventListener("input", function (e) {
    var input = e.target.closest(".hours-input");
    if (!input) return;
    var v = parseFloat(input.value);
    if (v < 0) input.value = 0;
    // Los minutos son de 0 a 59 -- si se pasa (por ejemplo escribe "75"),
    // lo dejamos en 59 para que no se guarde una hora invalida.
    if (input.classList.contains("hours-m") && v > 59) input.value = 59;
    var row = input.closest("tr");
    updateRowTotal(row);
    recomputeAll();
    scheduleSave(row.dataset.worker);
  });

  el.tableWrap.addEventListener("click", function (e) {
    if (adminView === "nomina") {
      var btn = e.target.closest("[data-action]");
      if (!btn) return;
      var row = btn.closest("tr");
      var workerId = row ? Number(row.dataset.worker) : null;
      var action = btn.dataset.action;
      if (action === "edit") {
        openWorkerModal(workerId);
      } else if (action === "delete") {
        deleteConfirmId = workerId;
        row.querySelector(".cell-actions").innerHTML = actionsHtml(workerId, true);
      } else if (action === "cancel-delete") {
        deleteConfirmId = null;
        row.querySelector(".cell-actions").innerHTML = actionsHtml(workerId, false);
      } else if (action === "confirm-delete") {
        deleteConfirmId = null;
        api("DELETE", "/api/workers/" + workerId).then(function () {
          showToast("Trabajador dado de baja.", "ok");
          loadWorkers();
        }).catch(function () {
          showToast("No se pudo eliminar al trabajador.", "error");
          row.querySelector(".cell-actions").innerHTML = actionsHtml(workerId, false);
        });
      }
    } else {
      handleAsistenciaClick(e);
    }
  });

  /* ============ Loaders ============ */
  function loadTipos() {
    return api("GET", "/api/tipos").then(function (data) {
      if (Array.isArray(data) && data.length) tipos = data;
    }).catch(function () {});
  }

  function loadWorkers() {
    return api("GET", "/api/workers").then(function (data) {
      workers = data;
      renderSidebar();
      if (adminView === "nomina") renderTable(currentPeriodData);
      else renderAsistencia();
    }).catch(function () {
      showToast("No se pudo cargar la lista de trabajadores.", "error");
    });
  }

  function loadPeriod() {
    renderTopbarLabels();
    var q = quincenaFor(periodAnchor);
    var pid = periodIdFor(q);
    var startStr = ymd(q.inicio), endStr = ymd(q.fin);

    return Promise.all([
      api("GET", "/api/periods/" + pid),
      api("GET", "/api/turnos?start=" + startStr + "&end=" + endStr),
    ]).then(function (res) {
      currentPeriodData = res[0];
      currentTurnos = res[1];
      updateStatusPill(!!currentPeriodData.cerrada);
      if (adminView === "nomina") renderTable(currentPeriodData);
      else renderAsistencia();
    }).catch(function () {
      showToast("No se pudo cargar esta quincena.", "error");
    });
  }

  // La asistencia la registran los propios trabajadores desde su celular
  // (checador por QR), en cualquier momento -- no solo cuando este panel
  // hace su primera carga. Por eso, cada vez que se entra a la pestaña
  // "Asistencia" se vuelve a pedir la lista de turnos al servidor (en vez
  // de reusar la que ya estaba en memoria), y mientras esa pestaña sigue
  // abierta se refresca sola cada 15 segundos para reflejar entradas o
  // salidas nuevas sin que alguien tenga que recargar la página.
  var asistenciaPollTimer = null;
  function refreshTurnos(opts) {
    opts = opts || {};
    var q = quincenaFor(periodAnchor);
    var startStr = ymd(q.inicio), endStr = ymd(q.fin);
    return api("GET", "/api/turnos?start=" + startStr + "&end=" + endStr).then(function (data) {
      currentTurnos = data;
      if (adminView === "asistencia") renderAsistencia();
    }).catch(function () {
      if (!opts.silent) showToast("No se pudo actualizar la asistencia.", "error");
    });
  }
  function startAsistenciaPolling() {
    stopAsistenciaPolling();
    asistenciaPollTimer = setInterval(function () {
      if (adminView === "asistencia" && document.visibilityState === "visible") {
        refreshTurnos({ silent: true });
      }
    }, 15000);
  }
  function stopAsistenciaPolling() {
    if (asistenciaPollTimer) { clearInterval(asistenciaPollTimer); asistenciaPollTimer = null; }
  }

  /* ============ Asistencia (attendance) view ============ */
  function groupTurnosByWorker(turnos) {
    var byWorker = {};
    turnos.forEach(function (t) { (byWorker[t.workerId] = byWorker[t.workerId] || []).push(t); });
    return byWorker;
  }
  function turnoActionsHtml(turnoId, confirming) {
    if (confirming) {
      return '<span class="confirm-text">¿Eliminar?</span>' +
        '<button class="confirm-btn" type="button" data-taction="cancel-delete">No</button>' +
        '<button class="confirm-btn yes" type="button" data-taction="confirm-delete">Sí</button>';
    }
    return '<button class="icon-btn" type="button" data-taction="edit" title="Editar turno" aria-label="Editar turno">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>' +
      '</button>' +
      '<button class="icon-btn danger" type="button" data-taction="delete" title="Eliminar turno" aria-label="Eliminar turno">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L4 6"/></svg>' +
      '</button>';
  }

  function renderAsistencia() {
    if (adminView !== "asistencia") return;
    var byWorker = groupTurnosByWorker(currentTurnos);
    var activeWorkers = workers.filter(function (w) { return w.activo; });
    var ids = {}; activeWorkers.forEach(function (w) { ids[w.id] = true; });
    var extraWorkers = Object.keys(byWorker).filter(function (id) { return !ids[id]; })
      .map(function (id) { return workers.find(function (w) { return String(w.id) === String(id); }); }).filter(Boolean);
    var list = activeWorkers.concat(extraWorkers);

    el.tableWrap.innerHTML = '<div class="table-toolbar">' +
      '<button class="btn btn-ghost" type="button" id="btnAddTurno">+ Registrar turno manual</button>' +
      '<button class="btn btn-primary" type="button" id="btnApplyAsistencia">Aplicar horas a nómina</button>' +
      '</div><div id="asistenciaTableHolder"></div>';
    document.getElementById("btnAddTurno").addEventListener("click", function () { openTurnoModal(null, null); });
    document.getElementById("btnApplyAsistencia").addEventListener("click", applyAsistenciaToNomina);

    var holder = document.getElementById("asistenciaTableHolder");

    if (currentTurnos.length === 0) {
      holder.innerHTML =
        '<div class="empty-state">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/></svg>' +
        '<h2>Sin registros en esta quincena</h2>' +
        '<p>Comparte el código QR con tus trabajadores para que marquen su entrada y salida, o registra un turno manualmente.</p>' +
        '</div>';
      el.statTrabajadores.textContent = 0;
      el.statHoras.textContent = fmtHours(0);
      el.statTotal.textContent = 0;
      return;
    }

    var totalHoras = 0, abiertos = 0, totalTurnos = 0;
    asistenciaSubtotals = {};
    var rowsHtml = list.map(function (w) {
      var turnos = (byWorker[w.id] || []).slice().sort(function (a, b) { return a.entrada < b.entrada ? -1 : (a.entrada > b.entrada ? 1 : 0); });
      if (turnos.length === 0) return "";
      var subtotal = 0;
      var body = turnos.map(function (t) {
        totalTurnos++;
        var open = !t.salida;
        if (open) abiertos++;
        if (t.horas != null) subtotal += t.horas;
        var entradaD = new Date(t.entrada);
        var salidaD = t.salida ? new Date(t.salida) : null;
        var tipoTag = !esPagado(w) ? ' <span class="wc-type-tag">' + escapeHtml(tipoLabel(w.tipo)) + '</span>' : "";
        return '<tr data-turno="' + t.id + '" data-worker="' + w.id + '">' +
          '<td class="cell-name"><div class="name">' + escapeHtml(w.nombre) + tipoTag + '</div></td>' +
          '<td>' + fmtDateTime(entradaD) + '</td>' +
          '<td>' + (salidaD ? fmtDateTime(salidaD) : '<span class="badge-open">Turno abierto</span>') + '</td>' +
          '<td class="cell-num">' + (t.horas != null ? fmtHours(t.horas) : "—") + '</td>' +
          '<td class="cell-actions">' + turnoActionsHtml(t.id, false) + '</td>' +
          '</tr>';
      }).join("");
      totalHoras += subtotal;
      asistenciaSubtotals[w.id] = subtotal;
      return body + '<tr class="subtotal-row"><td colspan="3">Subtotal — ' + escapeHtml(w.nombre) + '</td><td class="cell-num">' + fmtHours(subtotal) + '</td><td></td></tr>';
    }).join("");

    holder.innerHTML =
      '<div class="table-scroll"><table id="asistenciaTable">' +
      '<thead><tr><th>Trabajador</th><th>Entrada</th><th>Salida</th><th class="cell-num">Horas</th><th></th></tr></thead>' +
      '<tbody>' + rowsHtml + '</tbody>' +
      '</table></div>';

    el.statTrabajadores.textContent = totalTurnos;
    el.statHoras.textContent = fmtHours(totalHoras);
    el.statTotal.textContent = abiertos;
  }

  function handleAsistenciaClick(e) {
    var btn = e.target.closest("[data-taction]");
    if (!btn) return;
    var row = btn.closest("tr");
    var turnoId = row ? Number(row.dataset.turno) : null;
    var action = btn.dataset.taction;
    if (action === "edit") {
      openTurnoModal(turnoId, row.dataset.worker);
    } else if (action === "delete") {
      turnoDeleteConfirmId = turnoId;
      row.querySelector(".cell-actions").innerHTML = turnoActionsHtml(turnoId, true);
    } else if (action === "cancel-delete") {
      turnoDeleteConfirmId = null;
      row.querySelector(".cell-actions").innerHTML = turnoActionsHtml(turnoId, false);
    } else if (action === "confirm-delete") {
      turnoDeleteConfirmId = null;
      api("DELETE", "/api/turnos/" + turnoId).then(function () {
        showToast("Turno eliminado.", "ok");
        loadPeriod();
      }).catch(function () {
        showToast("No se pudo eliminar el turno.", "error");
      });
    }
  }

  function applyAsistenciaToNomina() {
    var q = quincenaFor(periodAnchor);
    var pid = periodIdFor(q);
    // Solo tiene sentido "aplicar a nomina" para trabajadores de tipo
    // "nomina" -- los de residencias profesionales y sistema dual no
    // tienen entradas de nomina, su asistencia ya queda registrada tal
    // cual en esta misma pestaña y en el Excel de asistencia.
    var workerIds = Object.keys(asistenciaSubtotals).filter(function (wid) {
      var w = workers.find(function (x) { return String(x.id) === String(wid); });
      return w && esPagado(w);
    });
    if (workerIds.length === 0) {
      showToast("No hay horas de trabajadores de nómina que aplicar.", "error");
      return;
    }
    Promise.all(workerIds.map(function (wid) {
      // Sin round2 aqui tampoco -- el subtotal ya viene exacto (suma de
      // horas calculadas al minuto en el servidor).
      return api("PUT", "/api/periods/" + pid + "/entries/" + wid, { horasNormales: asistenciaSubtotals[wid] });
    })).then(function () {
      showToast("Horas aplicadas a la nómina de esta quincena.", "ok");
      loadPeriod();
    }).catch(function () {
      showToast("No se pudieron aplicar todas las horas. Intenta de nuevo.", "error");
    });
  }

  /* ============ Worker modal ============ */
  function tipoOptionsHtml(selected) {
    return tipos.map(function (t) {
      return '<option value="' + escapeHtml(t.clave) + '"' + (t.clave === selected ? " selected" : "") + '>' +
        escapeHtml(t.nombre) + (t.pagado ? " (se le paga)" : " (solo asistencia)") + '</option>';
    }).join("");
  }

  function tiposCustomListHtml() {
    var custom = tipos.filter(function (t) { return !t.fijo; });
    if (!custom.length) return "";
    return '<div class="tipo-list">' + custom.map(function (t) {
      return '<div class="tipo-row"><span>' + escapeHtml(t.nombre) +
        ' <span class="tipo-row-kind">' + (t.pagado ? "se le paga" : "solo asistencia") + '</span></span>' +
        '<button type="button" class="tipo-del" data-del-tipo="' + escapeHtml(t.clave) + '" title="Eliminar tipo" aria-label="Eliminar tipo ' + escapeHtml(t.nombre) + '">×</button></div>';
    }).join("") + '</div>';
  }

  function openWorkerModal(workerId) {
    var w = workerId ? workers.find(function (x) { return x.id === workerId; }) : null;
    var isNew = !w;
    var tipoActual = w ? (w.tipo || "nomina") : "nomina";
    if (w && !tipos.some(function (t) { return t.clave === tipoActual; })) {
      tipos.push(tipoInfo(tipoActual));
    }

    el.modal.innerHTML =
      '<h2>' + (isNew ? "Nuevo trabajador" : "Editar trabajador") + '</h2>' +
      '<div class="field"><label for="fNombre">Nombre completo</label>' +
      '<input id="fNombre" type="text" value="' + (w ? escapeHtml(w.nombre) : "") + '" placeholder="Ej. Ana Torres Medina" autocomplete="off"></div>' +
      '<div class="field"><label for="fPuesto">Puesto (opcional)</label>' +
      '<input id="fPuesto" type="text" value="' + (w ? escapeHtml(w.puesto || "") : "") + '" placeholder="Ej. Instructor, Coordinador, Administrativo" autocomplete="off"></div>' +
      '<div class="field"><label for="fTipo">Tipo de trabajador</label>' +
      '<div class="field-pin-row">' +
      '<select id="fTipo">' + tipoOptionsHtml(tipoActual) + '</select>' +
      '<button type="button" class="btn btn-ghost" id="btnNuevoTipo" title="Agregar un tipo de trabajador nuevo">+ Nuevo tipo</button>' +
      '</div>' +
      '<div class="tipo-new" id="tipoNewBox" hidden>' +
      '<input id="ntNombre" type="text" maxlength="60" placeholder="Ej. Prácticas profesionales, Honorarios, Servicio social" autocomplete="off">' +
      '<label class="tipo-check"><input id="ntPagado" type="checkbox"> Se le paga (lleva tarifa por hora y aparece en la pestaña Nómina)</label>' +
      '<div class="field-error" id="ntError"></div>' +
      '<div class="tipo-new-actions">' +
      '<button type="button" class="btn btn-ghost" id="btnNtCancel">Cancelar</button>' +
      '<button type="button" class="btn btn-primary" id="btnNtSave">Guardar tipo</button>' +
      '</div>' +
      '<div id="tipoCustomList">' + tiposCustomListHtml() + '</div>' +
      '</div>' +
      '<div class="field-hint">Solo a los tipos marcados "se le paga" se les calcula un salario y aparecen en la pestaña Nómina. Los de "solo asistencia" únicamente marcan entrada/salida.</div>' +
      '</div>' +
      '<div class="field" id="fTarifaWrap"' + (tipoInfo(tipoActual).pagado ? "" : " hidden") + '>' +
      '<label for="fTarifa">Tarifa por hora</label>' +
      '<input id="fTarifa" class="money" type="number" min="0" step="0.5" value="' + (w ? w.tarifaNormal : "") + '" placeholder="0.00"></div>' +
      '<div class="field"><label for="fIdEmpleado">Número de empleado (hasta 8 dígitos)</label>' +
      '<div class="field-pin-row">' +
      '<input id="fIdEmpleado" class="money" type="text" inputmode="numeric" maxlength="8" value="' + (w ? escapeHtml(w.idEmpleado || "") : "") + '" placeholder="00000001">' +
      '<button type="button" class="btn btn-ghost" id="btnGenId">Generar</button>' +
      '</div>' +
      '<div class="field-hint">Su número de identificación dentro de YES EMS. Puedes usar el mismo que ya tenga en nómina o recursos humanos.</div>' +
      '</div>' +
      '<div class="field"><label for="fPin">PIN de acceso (4 dígitos)</label>' +
      '<div class="field-pin-row">' +
      '<input id="fPin" class="money" type="text" inputmode="numeric" maxlength="4" value="' + (w ? escapeHtml(w.pin || "") : "") + '" placeholder="0000">' +
      '<button type="button" class="btn btn-ghost" id="btnGenPin">Generar</button>' +
      '</div>' +
      '<div class="field-hint">Junto con su número de empleado, lo usará para marcar su entrada y salida desde el código QR. Compártelos solo con este trabajador.</div>' +
      '</div>' +
      '<div class="field-error" id="fError"></div>' +
      '<div class="modal-actions">' +
      '<button class="btn btn-ghost" type="button" id="btnCancelModal">Cancelar</button>' +
      '<button class="btn btn-primary" type="button" id="btnSaveModal">' + (isNew ? "Agregar" : "Guardar cambios") + '</button>' +
      '</div>';

    el.modalBackdrop.hidden = false;
    document.getElementById("fNombre").focus();

    document.getElementById("btnCancelModal").addEventListener("click", closeModal);
    document.getElementById("fTipo").addEventListener("change", function () {
      document.getElementById("fTarifaWrap").hidden = !tipoInfo(this.value).pagado;
    });

    // --- Agregar / eliminar tipos de trabajador ---
    var tipoBox = document.getElementById("tipoNewBox");
    function refreshTipoSelect(selectClave) {
      var sel = document.getElementById("fTipo");
      var current = selectClave || sel.value;
      sel.innerHTML = tipoOptionsHtml(current);
      if (!tipos.some(function (t) { return t.clave === current; })) sel.value = "nomina";
      document.getElementById("fTarifaWrap").hidden = !tipoInfo(sel.value).pagado;
      document.getElementById("tipoCustomList").innerHTML = tiposCustomListHtml();
    }
    document.getElementById("btnNuevoTipo").addEventListener("click", function () {
      tipoBox.hidden = !tipoBox.hidden;
      if (!tipoBox.hidden) document.getElementById("ntNombre").focus();
    });
    document.getElementById("btnNtCancel").addEventListener("click", function () {
      tipoBox.hidden = true;
      document.getElementById("ntNombre").value = "";
      document.getElementById("ntPagado").checked = false;
      document.getElementById("ntError").textContent = "";
    });
    document.getElementById("btnNtSave").addEventListener("click", function () {
      var nombreTipo = document.getElementById("ntNombre").value.trim();
      var pagado = document.getElementById("ntPagado").checked;
      var ntErr = document.getElementById("ntError");
      ntErr.textContent = "";
      if (!nombreTipo) { ntErr.textContent = "Escribe el nombre del nuevo tipo."; return; }
      api("POST", "/api/tipos", { nombre: nombreTipo, pagado: pagado }).then(function (nuevo) {
        return loadTipos().then(function () {
          refreshTipoSelect(nuevo.clave);
          document.getElementById("ntNombre").value = "";
          document.getElementById("ntPagado").checked = false;
          showToast('Tipo "' + nuevo.nombre + '" agregado.', "ok");
          renderSidebar();
        });
      }).catch(function (err) {
        ntErr.textContent = err.message || "No se pudo agregar el tipo.";
      });
    });
    document.getElementById("ntNombre").addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); document.getElementById("btnNtSave").click(); }
    });
    document.getElementById("tipoCustomList").addEventListener("click", function (e) {
      var btn = e.target.closest("[data-del-tipo]");
      if (!btn) return;
      var clave = btn.getAttribute("data-del-tipo");
      var ntErr = document.getElementById("ntError");
      ntErr.textContent = "";
      if (btn.dataset.confirm !== "1") {
        btn.dataset.confirm = "1";
        btn.textContent = "¿Eliminar?";
        btn.classList.add("confirming");
        return;
      }
      api("DELETE", "/api/tipos/" + encodeURIComponent(clave)).then(function () {
        return loadTipos().then(function () {
          refreshTipoSelect();
          showToast("Tipo eliminado.", "ok");
          renderSidebar();
        });
      }).catch(function (err) {
        ntErr.textContent = err.message || "No se pudo eliminar el tipo.";
        document.getElementById("tipoCustomList").innerHTML = tiposCustomListHtml();
      });
    });
    document.getElementById("btnGenId").addEventListener("click", function () {
      document.getElementById("fIdEmpleado").value = generateLocalIdGuess();
    });
    document.getElementById("btnGenPin").addEventListener("click", function () {
      document.getElementById("fPin").value = generateLocalPinGuess();
    });

    document.getElementById("btnSaveModal").addEventListener("click", function () {
      var nombre = document.getElementById("fNombre").value.trim();
      var puesto = document.getElementById("fPuesto").value.trim();
      var tipo = document.getElementById("fTipo").value;
      var tarifaNormal = tipoInfo(tipo).pagado ? parseFloat(document.getElementById("fTarifa").value) : 0;
      var idEmpleado = document.getElementById("fIdEmpleado").value.trim();
      var pin = document.getElementById("fPin").value.trim();
      var errEl = document.getElementById("fError");

      if (!nombre) { errEl.textContent = "Escribe el nombre del trabajador."; return; }
      if (tipoInfo(tipo).pagado && !(tarifaNormal >= 0)) { errEl.textContent = "Escribe una tarifa por hora válida."; return; }
      if (!/^\d{1,8}$/.test(idEmpleado)) { errEl.textContent = "El número de empleado debe tener solo dígitos (máximo 8)."; return; }
      if (!/^\d{4}$/.test(pin)) { errEl.textContent = "El PIN debe tener exactamente 4 dígitos."; return; }

      var payload = { nombre: nombre, puesto: puesto, tipo: tipo, tarifaNormal: tarifaNormal, idEmpleado: idEmpleado, pin: pin };
      var req = isNew ? api("POST", "/api/workers", payload) : api("PUT", "/api/workers/" + w.id, payload);
      req.then(function () {
        closeModal();
        showToast(isNew ? "Trabajador agregado." : "Cambios guardados.", "ok");
        loadWorkers();
      }).catch(function (err) {
        errEl.textContent = err.message || "No se pudo guardar. Intenta de nuevo.";
      });
    });
  }

  function generateLocalPinGuess() {
    var used = {};
    workers.forEach(function (w) { if (w.pin) used[w.pin] = true; });
    var pin;
    do { pin = String(Math.floor(1000 + Math.random() * 9000)); } while (used[pin]);
    return pin;
  }

  function generateLocalIdGuess() {
    var used = {};
    workers.forEach(function (w) { if (w.idEmpleado) used[w.idEmpleado] = true; });
    var id;
    do { id = String(Math.floor(1000 + Math.random() * 9000)); } while (used[id]);
    return id;
  }

  /* ============ Turno modal (attendance) ============ */
  function openTurnoModal(turnoId, presetWorkerId) {
    var turno = turnoId ? currentTurnos.find(function (t) { return t.id === turnoId; }) : null;
    var isNew = !turno;
    var activeWorkers = workers.filter(function (w) { return w.activo; });
    var entradaDate = turno ? new Date(turno.entrada) : new Date();
    var salidaDate = turno && turno.salida ? new Date(turno.salida) : null;

    var workerFieldHtml;
    if (isNew) {
      var options = activeWorkers.map(function (w) {
        return '<option value="' + w.id + '" ' + (String(w.id) === String(presetWorkerId) ? "selected" : "") + '>' + escapeHtml(w.nombre) + '</option>';
      }).join("");
      workerFieldHtml = '<div class="field"><label for="tWorker">Trabajador</label><select id="tWorker">' + options + '</select></div>';
    } else {
      var w = workers.find(function (x) { return String(x.id) === String(turno.workerId); });
      workerFieldHtml = '<div class="field-hint">' + escapeHtml(w ? w.nombre : "Trabajador") + '</div>';
    }

    el.modal.innerHTML =
      '<h2>' + (isNew ? "Registrar turno" : "Editar turno") + '</h2>' +
      workerFieldHtml +
      '<div class="field"><label for="tEntrada">Entrada</label><input id="tEntrada" type="datetime-local" value="' + toLocalInputValue(entradaDate) + '"></div>' +
      '<div class="field"><label for="tSalida">Salida (déjalo vacío si el turno sigue abierto)</label><input id="tSalida" type="datetime-local" value="' + (salidaDate ? toLocalInputValue(salidaDate) : "") + '"></div>' +
      '<div class="field-error" id="tError"></div>' +
      '<div class="modal-actions">' +
      '<button class="btn btn-ghost" type="button" id="btnCancelTurno">Cancelar</button>' +
      '<button class="btn btn-primary" type="button" id="btnSaveTurno">Guardar</button>' +
      '</div>';

    el.modalBackdrop.hidden = false;
    document.getElementById("btnCancelTurno").addEventListener("click", closeModal);

    document.getElementById("btnSaveTurno").addEventListener("click", function () {
      var errEl = document.getElementById("tError");
      var entradaVal = document.getElementById("tEntrada").value;
      var salidaVal = document.getElementById("tSalida").value;
      if (!entradaVal) { errEl.textContent = "Indica la hora de entrada."; return; }
      var eDate = new Date(entradaVal);
      var sDate = salidaVal ? new Date(salidaVal) : null;
      if (sDate && sDate <= eDate) { errEl.textContent = "La salida debe ser después de la entrada."; return; }

      if (isNew) {
        var workerId = document.getElementById("tWorker") ? document.getElementById("tWorker").value : presetWorkerId;
        if (!workerId) { errEl.textContent = "Selecciona un trabajador."; return; }
        api("POST", "/api/turnos", { workerId: Number(workerId), entrada: eDate.toISOString(), salida: sDate ? sDate.toISOString() : null })
          .then(function () { closeModal(); showToast("Turno registrado.", "ok"); loadPeriod(); })
          .catch(function (err) { errEl.textContent = err.message || "No se pudo guardar."; });
      } else {
        api("PUT", "/api/turnos/" + turno.id, { entrada: eDate.toISOString(), salida: sDate ? sDate.toISOString() : null })
          .then(function () { closeModal(); showToast("Turno actualizado.", "ok"); loadPeriod(); })
          .catch(function (err) { errEl.textContent = err.message || "No se pudo guardar."; });
      }
    });
  }

  function closeModal() { el.modalBackdrop.hidden = true; el.modal.innerHTML = ""; el.modal.classList.remove("modal-wide"); }
  el.modalBackdrop.addEventListener("click", function (e) { if (e.target === el.modalBackdrop) closeModal(); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !el.modalBackdrop.hidden) closeModal(); });

  /* ============ QR modal ============ */
  function openQrModal() {
    el.modal.innerHTML =
      '<h2>Código QR de asistencia</h2>' +
      '<div class="qr-wrap">' +
      '<div class="qr-canvas-box"><img id="qrImg" src="/api/qr.png" alt="Código QR del checador"></div>' +
      '<div class="qr-url" id="qrUrlText">Cargando enlace…</div>' +
      '<button class="btn btn-primary" type="button" id="btnCopyQr" style="width:100%;justify-content:center;">Copiar enlace</button>' +
      '<p class="field-hint">Cualquier persona con este enlace puede abrir la pantalla de entrada/salida; solo podrá marcar si conoce el PIN de un trabajador activo. Imprime el código o compártelo por WhatsApp.</p>' +
      '</div>' +
      '<div class="modal-actions"><button class="btn btn-ghost" type="button" id="btnCloseQr">Cerrar</button></div>';
    el.modalBackdrop.hidden = false;

    var qrUrl = "";
    api("GET", "/api/qr-url").then(function (data) {
      qrUrl = data.url;
      document.getElementById("qrUrlText").textContent = qrUrl;
    }).catch(function () {
      document.getElementById("qrUrlText").textContent = "No se pudo obtener el enlace.";
    });

    document.getElementById("btnCopyQr").addEventListener("click", function () {
      if (!qrUrl) return;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(qrUrl).then(function () {
          showToast("Enlace copiado.", "ok");
        }).catch(function () { showToast("No se pudo copiar. Selecciona el enlace manualmente.", "error"); });
      } else {
        showToast("Selecciona el enlace manualmente para copiarlo.", "error");
      }
    });
    document.getElementById("btnCloseQr").addEventListener("click", closeModal);
  }
  el.btnQr.addEventListener("click", openQrModal);

  /* ============ Mi cuenta / administradores ============ */
  function openAccountModal() {
    el.modal.innerHTML =
      '<h2>Mi cuenta y administradores</h2>' +
      '<h3 class="modal-subhead">Cambiar mi contraseña</h3>' +
      '<div class="field"><label for="pwActual">Contraseña actual</label><input id="pwActual" type="password" autocomplete="current-password"></div>' +
      '<div class="field"><label for="pwNueva">Contraseña nueva</label><input id="pwNueva" type="password" autocomplete="new-password"></div>' +
      '<div class="field"><label for="pwConfirmar">Confirmar contraseña nueva</label><input id="pwConfirmar" type="password" autocomplete="new-password"></div>' +
      '<p class="field-hint">Mínimo 8 caracteres, con letras y números.</p>' +
      '<div class="field-error" id="pwError"></div>' +
      '<div class="modal-actions"><button class="btn btn-primary" type="button" id="btnSavePassword">Guardar contraseña</button></div>' +
      '<hr class="modal-sep">' +
      '<h3 class="modal-subhead">Administradores</h3>' +
      '<div id="adminList" class="admin-list"><div class="field-hint">Cargando…</div></div>' +
      '<div class="field"><label for="aUsuario">Nuevo usuario</label><input id="aUsuario" type="text" autocomplete="off"></div>' +
      '<div class="field"><label for="aPassword">Contraseña</label><input id="aPassword" type="password" autocomplete="new-password"></div>' +
      '<div class="field-error" id="aError"></div>' +
      '<div class="modal-actions"><button class="btn btn-ghost" type="button" id="btnAddAdmin">Agregar administrador</button></div>' +
      '<div class="modal-actions"><button class="btn btn-ghost" type="button" id="btnCloseAccount">Cerrar</button></div>';
    el.modalBackdrop.hidden = false;

    document.getElementById("btnCloseAccount").addEventListener("click", closeModal);

    document.getElementById("btnSavePassword").addEventListener("click", function () {
      var errEl = document.getElementById("pwError");
      var actual = document.getElementById("pwActual").value;
      var nueva = document.getElementById("pwNueva").value;
      var confirmar = document.getElementById("pwConfirmar").value;
      errEl.textContent = "";
      if (!actual || !nueva) { errEl.textContent = "Completa los dos campos de contraseña."; return; }
      if (nueva !== confirmar) { errEl.textContent = "La confirmación no coincide con la contraseña nueva."; return; }
      api("PUT", "/api/account/password", { passwordActual: actual, passwordNueva: nueva }).then(function () {
        showToast("Contraseña actualizada.", "ok");
        document.getElementById("pwActual").value = "";
        document.getElementById("pwNueva").value = "";
        document.getElementById("pwConfirmar").value = "";
      }).catch(function (err) {
        errEl.textContent = err.message || "No se pudo cambiar la contraseña.";
      });
    });

    // Confirmacion de "eliminar administrador" en dos pasos (igual que al
    // dar de baja a un trabajador): primer clic pide confirmar, segundo
    // clic ya elimina -- para que no se borre a nadie por accidente.
    var confirmDeleteId = null;
    function renderAdminList(admins) {
      var listEl = document.getElementById("adminList");
      if (!listEl) return;
      if (!admins.length) { listEl.innerHTML = '<div class="field-hint">No hay administradores.</div>'; return; }
      listEl.innerHTML = admins.map(function (a) {
        var confirming = confirmDeleteId === a.id;
        return '<div class="admin-row">' +
          '<span>' + escapeHtml(a.usuario) + '</span>' +
          (confirming
            ? '<span><button class="ch-link-btn" type="button" data-cancel-admin="' + a.id + '">Cancelar</button>&nbsp; ' +
              '<button class="ch-link-btn" type="button" data-confirm-admin="' + a.id + '">¿Eliminar?</button></span>'
            : '<button class="ch-link-btn" type="button" data-del-admin="' + a.id + '">Eliminar</button>') +
          '</div>';
      }).join("");
    }

    function loadAdmins() {
      return api("GET", "/api/admins").then(function (admins) {
        renderAdminList(admins);
      }).catch(function () {
        var listEl = document.getElementById("adminList");
        if (listEl) listEl.innerHTML = '<div class="field-hint">No se pudo cargar la lista.</div>';
      });
    }

    document.getElementById("adminList").addEventListener("click", function (e) {
      var del = e.target.closest("[data-del-admin]");
      var cancel = e.target.closest("[data-cancel-admin]");
      var confirmBtn = e.target.closest("[data-confirm-admin]");
      if (del) {
        confirmDeleteId = Number(del.getAttribute("data-del-admin"));
        loadAdmins();
      } else if (cancel) {
        confirmDeleteId = null;
        loadAdmins();
      } else if (confirmBtn) {
        var id = Number(confirmBtn.getAttribute("data-confirm-admin"));
        confirmDeleteId = null;
        api("DELETE", "/api/admins/" + id).then(function () {
          showToast("Administrador eliminado.", "ok");
          loadAdmins();
        }).catch(function (err) {
          showToast(err.message || "No se pudo eliminar.", "error");
          loadAdmins();
        });
      }
    });

    document.getElementById("btnAddAdmin").addEventListener("click", function () {
      var errEl = document.getElementById("aError");
      var usuario = document.getElementById("aUsuario").value.trim();
      var password = document.getElementById("aPassword").value;
      errEl.textContent = "";
      if (!usuario) { errEl.textContent = "Escribe un nombre de usuario."; return; }
      api("POST", "/api/admins", { usuario: usuario, password: password }).then(function () {
        showToast("Administrador agregado.", "ok");
        document.getElementById("aUsuario").value = "";
        document.getElementById("aPassword").value = "";
        loadAdmins();
      }).catch(function (err) {
        errEl.textContent = err.message || "No se pudo agregar.";
      });
    });

    loadAdmins();
  }
  el.btnAccount.addEventListener("click", openAccountModal);

  /* ============ Export ============ */
  el.btnExport.addEventListener("click", function () {
    var q = quincenaFor(periodAnchor);
    window.location.href = "/api/export/periodo/" + periodIdFor(q) + ".xlsx";
  });
  el.btnExportHistorial.addEventListener("click", openHistorialModal);

  /* ============ Historial por fechas ============ */
  // Ventana para escoger que quincenas descargar: se elige un rango de
  // fechas, aparecen todas las quincenas de ese rango con su total, y se
  // puede descargar una sola (Excel completo con hoja por trabajador) o
  // varias seleccionadas juntas en un solo archivo.
  var historialRango = null;
  function openHistorialModal() {
    if (!historialRango) {
      var hoy = new Date();
      var desde = new Date(hoy.getFullYear(), hoy.getMonth() - 2, 1);
      historialRango = { desde: ymd(desde), hasta: ymd(hoy) };
    }
    el.modal.innerHTML =
      '<h2>Historial de nómina</h2>' +
      '<p class="field-hint">Escoge un rango de fechas para ver las quincenas que caen en él. Puedes descargar una sola o marcar varias y bajarlas juntas en un solo Excel.</p>' +
      '<div class="hist-range">' +
      '<div class="field"><label for="hDesde">Desde</label><input id="hDesde" type="date" value="' + historialRango.desde + '"></div>' +
      '<div class="field"><label for="hHasta">Hasta</label><input id="hHasta" type="date" value="' + historialRango.hasta + '"></div>' +
      '<button class="btn btn-ghost" type="button" id="btnHistBuscar">Buscar</button>' +
      '</div>' +
      '<div class="hist-presets">' +
      '<button type="button" class="hist-chip" data-preset="mes">Este mes</button>' +
      '<button type="button" class="hist-chip" data-preset="3m">Últimos 3 meses</button>' +
      '<button type="button" class="hist-chip" data-preset="anio">Este año</button>' +
      '<button type="button" class="hist-chip" data-preset="anio-ant">Año pasado</button>' +
      '</div>' +
      '<div class="field-error" id="hError"></div>' +
      '<div id="histList" class="hist-list"><div class="field-hint">Cargando…</div></div>' +
      '<div class="modal-actions">' +
      '<button class="btn btn-ghost" type="button" id="btnHistClose">Cerrar</button>' +
      '<button class="btn btn-primary" type="button" id="btnHistDownload" disabled>Descargar seleccionadas</button>' +
      '</div>';
    el.modal.classList.add("modal-wide");
    el.modalBackdrop.hidden = false;

    var listEl = document.getElementById("histList");
    var errEl = document.getElementById("hError");
    var btnDownload = document.getElementById("btnHistDownload");
    var periodos = [];

    function updateDownloadBtn() {
      var n = listEl.querySelectorAll("input[data-hist-id]:checked").length;
      btnDownload.disabled = n === 0;
      btnDownload.textContent = n === 0 ? "Descargar seleccionadas" : "Descargar " + n + (n === 1 ? " quincena" : " quincenas");
      var all = document.getElementById("hAll");
      if (all) {
        var total = listEl.querySelectorAll("input[data-hist-id]").length;
        all.checked = total > 0 && n === total;
        all.indeterminate = n > 0 && n < total;
      }
    }

    function fmtCorta(s) {
      var p = s.split("-");
      return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2])).toLocaleDateString("es-MX", { day: "numeric", month: "short", year: "numeric" });
    }

    function renderLista() {
      if (!periodos.length) {
        listEl.innerHTML = '<div class="field-hint">No hay quincenas en ese rango.</div>';
        updateDownloadBtn();
        return;
      }
      var granTotal = 0;
      var rows = periodos.slice().reverse().map(function (p) {
        granTotal += p.total;
        var sinDatos = p.total === 0 && p.horas === 0;
        return '<tr class="' + (sinDatos ? "hist-empty" : "") + '">' +
          '<td><input type="checkbox" data-hist-id="' + p.id + '"' + (sinDatos ? "" : " checked") + ' aria-label="Seleccionar quincena ' + p.id + '"></td>' +
          '<td><div class="name">' + fmtCorta(p.inicio) + ' – ' + fmtCorta(p.fin) + '</div><div class="puesto">Quincena ' + p.quincena + '</div></td>' +
          '<td><span class="hist-status ' + (p.cerrada ? "closed" : "open") + '">' + (p.cerrada ? "Pagada" : "Abierta") + '</span></td>' +
          '<td class="cell-num">' + p.trabajadores + '</td>' +
          '<td class="cell-num">' + fmtMoney(p.total) + '</td>' +
          '<td class="cell-actions"><button type="button" class="btn btn-ghost btn-sm" data-hist-one="' + p.id + '" title="Descargar solo esta quincena (con hoja por trabajador)">Descargar</button></td>' +
          '</tr>';
      }).join("");
      listEl.innerHTML =
        '<div class="table-scroll"><table class="hist-table">' +
        '<thead><tr><th><input type="checkbox" id="hAll" aria-label="Seleccionar todas"></th><th>Quincena</th><th>Estado</th><th class="cell-num">Trab.</th><th class="cell-num">Total pagado</th><th></th></tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
        '<tfoot><tr><td></td><td colspan="3" class="foot-label">Total del rango</td><td class="cell-num">' + fmtMoney(granTotal) + '</td><td></td></tr></tfoot>' +
        '</table></div>';
      document.getElementById("hAll").addEventListener("change", function () {
        var checked = this.checked;
        listEl.querySelectorAll("input[data-hist-id]").forEach(function (c) { c.checked = checked; });
        updateDownloadBtn();
      });
      updateDownloadBtn();
    }

    function buscar() {
      var desde = document.getElementById("hDesde").value;
      var hasta = document.getElementById("hHasta").value;
      errEl.textContent = "";
      if (!desde || !hasta) { errEl.textContent = "Escoge las dos fechas."; return; }
      if (desde > hasta) { errEl.textContent = "La fecha \"Desde\" debe ser anterior a \"Hasta\"."; return; }
      historialRango = { desde: desde, hasta: hasta };
      listEl.innerHTML = '<div class="field-hint">Cargando…</div>';
      api("GET", "/api/periods?desde=" + desde + "&hasta=" + hasta).then(function (data) {
        periodos = data;
        renderLista();
      }).catch(function (err) {
        listEl.innerHTML = "";
        errEl.textContent = err.message || "No se pudo cargar el historial.";
        periodos = [];
        updateDownloadBtn();
      });
    }

    document.getElementById("btnHistBuscar").addEventListener("click", buscar);
    ["hDesde", "hHasta"].forEach(function (id) {
      document.getElementById(id).addEventListener("change", buscar);
    });
    el.modal.querySelector(".hist-presets").addEventListener("click", function (e) {
      var b = e.target.closest("[data-preset]");
      if (!b) return;
      var hoy = new Date(), d, h = hoy;
      var preset = b.getAttribute("data-preset");
      if (preset === "mes") d = new Date(hoy.getFullYear(), hoy.getMonth(), 1);
      else if (preset === "3m") d = new Date(hoy.getFullYear(), hoy.getMonth() - 2, 1);
      else if (preset === "anio") d = new Date(hoy.getFullYear(), 0, 1);
      else { d = new Date(hoy.getFullYear() - 1, 0, 1); h = new Date(hoy.getFullYear() - 1, 11, 31); }
      document.getElementById("hDesde").value = ymd(d);
      document.getElementById("hHasta").value = ymd(h);
      buscar();
    });
    listEl.addEventListener("change", function (e) {
      if (e.target.matches("input[data-hist-id]")) updateDownloadBtn();
    });
    listEl.addEventListener("click", function (e) {
      var one = e.target.closest("[data-hist-one]");
      if (one) window.location.href = "/api/export/periodo/" + one.getAttribute("data-hist-one") + ".xlsx";
    });
    btnDownload.addEventListener("click", function () {
      var ids = Array.prototype.map.call(listEl.querySelectorAll("input[data-hist-id]:checked"), function (c) {
        return c.getAttribute("data-hist-id");
      });
      if (!ids.length) return;
      // Una sola quincena -> el Excel completo (con hoja por trabajador).
      // Varias -> un solo archivo con el resumen y las hojas de cada una.
      if (ids.length === 1) window.location.href = "/api/export/periodo/" + ids[0] + ".xlsx";
      else window.location.href = "/api/export/historial.xlsx?ids=" + encodeURIComponent(ids.sort().join(","));
    });
    document.getElementById("btnHistClose").addEventListener("click", closeModal);

    buscar();
  }

  /* ============ Init ============ */
  setView("nomina");
  loadTipos().then(loadWorkers);
  loadPeriod();
})();