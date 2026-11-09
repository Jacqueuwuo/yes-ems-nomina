(function () {
  "use strict";

  /* ============ Helpers generales ============ */
  function pad(n) { return String(n).padStart(2, "0"); }
  function ymd(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  var moneyFmt = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" });
  function fmtMoney(n) { return moneyFmt.format(n || 0); }
  // Muestra las horas como "1 h 50 min" en vez de "1.83 h" -- mismo dato,
  // nada mas presentado de forma natural.
  function fmtHours(n) {
    var hm = decToHM(n);
    if (hm.h === 0 && hm.m === 0) return "0 min";
    if (hm.h === 0) return hm.m + " min";
    if (hm.m === 0) return hm.h + " h";
    return hm.h + " h " + hm.m + " min";
  }
  function fmtDateTime(d) { return d.toLocaleString("es-MX", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }); }
  function fmtFecha(s) {
    if (!s) return "—";
    var p = String(s).split("-");
    if (p.length !== 3) return s;
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2])).toLocaleDateString("es-MX", { day: "numeric", month: "short", year: "numeric" });
  }
  // Convierte horas decimales (como se guardan) a horas y minutos enteros
  // para capturarlas de forma natural ("1 hora, 48 minutos").
  function decToHM(dec) {
    dec = Math.max(0, Number(dec) || 0);
    var h = Math.floor(dec);
    var m = Math.round((dec - h) * 60);
    if (m === 60) { m = 0; h += 1; }
    return { h: h, m: m };
  }
  // OJO: aqui NO se redondea a centesimas de hora -- ver nota historica en
  // git. "1 hora 10 minutos" se guarda como 70/60 horas exacto.
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
  // ESTE CALENDARIO ES EL QUE YA ESTABA ESTABLECIDO -- ningun apartado
  // nuevo lo cambia; Periodos de nomina y Reportes solo lo consultan.
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

  /* ============ Estado global ============ */
  var workers = [];
  var tipos = [
    { clave: "nomina", nombre: "Nómina", pagado: true, fijo: true },
    { clave: "residencias", nombre: "Residencias profesionales", pagado: false, fijo: true },
    { clave: "dual", nombre: "Sistema dual", pagado: false, fijo: true },
    { clave: "practicantes", nombre: "Practicantes", pagado: false, fijo: true },
  ];
  function tipoInfo(clave) {
    clave = clave || "nomina";
    for (var i = 0; i < tipos.length; i++) if (tipos[i].clave === clave) return tipos[i];
    return { clave: clave, nombre: clave, pagado: clave === "nomina", fijo: false };
  }
  function esPagado(w) { return tipoInfo(w && w.tipo).pagado; }
  function tipoLabel(clave) { return tipoInfo(clave).nombre; }
  // "admin" (permisos completos) o "lectura" (solo puede ver trabajadores,
  // su nomina/asistencia/incidencias, y descargar PDFs/reportes -- nada de
  // crear, editar ni eliminar). Se confirma con el servidor al arrancar
  // (ver "Init" al final del archivo) antes de dibujar nada.
  var miRol = "admin";
  function esSoloLectura() { return miRol === "lectura"; }

  var currentSection = "inicio";
  var sectionParams = {};
  var periodAnchor = new Date();
  var currentPeriodData = null;
  var currentTurnos = [];
  var saveTimers = {};
  var currentClosed = false;
  var asistenciaSubtotals = {};
  var asistenciaPollTimer = null;

  // Filtros (se reinician a sus valores por default cada vez que se
  // entra al apartado, salvo que vengan precargados desde otro apartado,
  // por ejemplo al dar clic en una tarjeta de Inicio).
  var filtroPersonal = { q: "", tipo: "", estatus: "activos" };
  var filtroAsistencias = { q: "", tipo: "", estatus: "" };
  var filtroIncidencias = { q: "", tipo: "", estatus: "", desde: "", hasta: "" };
  var historialRango = null; // { desde, hasta } -- Periodos de nómina

  /* ============ DOM refs ============ */
  var el = {
    sideNav: document.getElementById("sideNav"),
    btnAccount: document.getElementById("btnAccount"),
    btnLogout: document.getElementById("btnLogout"),
    sideUser: document.getElementById("sideUser"),
    sectionTitle: document.getElementById("sectionTitle"),
    sectionToolbar: document.getElementById("sectionToolbar"),
    saveStatus: document.getElementById("saveStatus"),
    viewBody: document.getElementById("viewBody"),
    modalBackdrop: document.getElementById("modalBackdrop"),
    modal: document.getElementById("modal"),
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

  /* ============ Modal (compartido por todos los apartados) ============ */
  function closeModal() { el.modalBackdrop.hidden = true; el.modal.innerHTML = ""; el.modal.classList.remove("modal-wide"); }
  el.modalBackdrop.addEventListener("click", function (e) { if (e.target === el.modalBackdrop) closeModal(); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !el.modalBackdrop.hidden) closeModal(); });
  function openModal(html, wide) {
    el.modal.innerHTML = html;
    el.modal.classList.toggle("modal-wide", !!wide);
    el.modalBackdrop.hidden = false;
  }

  /* ============ Icono PDF (reusado en Personal/Asistencias/Pagos) ============ */
  var ICON_PDF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>';
  var ICON_EDIT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
  var ICON_DELETE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L4 6"/></svg>';
  var ICON_EYE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
  var ICON_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
  var ICON_X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';

  // Dos clics para confirmar un borrado (primero marca "confirming" en el
  // boton, segundo clic ya ejecuta) -- mismo patron en toda la app para
  // que nada se borre por accidente con un solo clic.
  function confirmDeleteHtml(idAttr, id, label) {
    label = label || "Eliminar";
    return '<button class="icon-btn danger" type="button" data-del="' + idAttr + '" data-id="' + id + '" title="' + label + '" aria-label="' + label + '">' + ICON_DELETE + '</button>';
  }
  function wireConfirmDelete(container, selector, onConfirm) {
    container.addEventListener("click", function (e) {
      var btn = e.target.closest(selector);
      if (!btn) return;
      if (btn.dataset.confirm !== "1") {
        btn.dataset.confirm = "1";
        btn.innerHTML = ICON_CHECK;
        btn.title = "¿Confirmar eliminar?";
        setTimeout(function () {
          if (btn.dataset.confirm === "1") { btn.dataset.confirm = "0"; btn.innerHTML = ICON_DELETE; btn.title = "Eliminar"; }
        }, 3500);
        return;
      }
      onConfirm(btn.getAttribute("data-id"), btn);
    });
  }

  /* ============ Navegación lateral ============ */
  var SECTION_TITLES = {
    inicio: "Inicio",
    personal: "Personal",
    asistencias: "Asistencias",
    incidencias: "Incidencias",
    periodos: "Periodos de nómina",
    percepciones: "Percepciones",
    deducciones: "Deducciones",
    pagos: "Pagos y recibos",
    reportes: "Reportes",
  };
  var SECTION_RENDERERS = {}; // se llenan mas abajo, uno por apartado

  function goToSection(section, params) {
    currentSection = section;
    sectionParams = params || {};
    el.sectionTitle.textContent = SECTION_TITLES[section] || "";
    Array.prototype.forEach.call(el.sideNav.querySelectorAll(".nav-item"), function (btn) {
      btn.classList.toggle("active", btn.getAttribute("data-section") === section);
    });
    el.sectionToolbar.innerHTML = "";
    el.saveStatus.textContent = "";
    stopAsistenciaPolling();
    var fn = SECTION_RENDERERS[section];
    if (fn) fn();
  }
  el.sideNav.addEventListener("click", function (e) {
    var btn = e.target.closest("[data-section]");
    if (btn) goToSection(btn.getAttribute("data-section"));
  });

  /* ============ Sesión / logout ============ */
  el.btnLogout.addEventListener("click", function () {
    api("POST", "/api/logout").then(function () { window.location.href = "/login"; });
  });

  /* ============ Loaders compartidos ============ */
  function loadTipos() {
    return api("GET", "/api/tipos").then(function (data) {
      if (Array.isArray(data) && data.length) tipos = data;
    }).catch(function () {});
  }
  function loadWorkers() {
    return api("GET", "/api/workers").then(function (data) { workers = data; }).catch(function () {
      showToast("No se pudo cargar la lista de trabajadores.", "error");
    });
  }

  /* ======================================================================
     INICIO (dashboard)
     ====================================================================== */
  function renderInicio() {
    el.viewBody.innerHTML = '<div class="loading-state">Cargando…</div>';
    Promise.all([api("GET", "/api/dashboard"), api("GET", "/api/session").catch(function () { return {}; })])
      .then(function (res) {
        pintarInicio(res[0]);
      }).catch(function () {
        el.viewBody.innerHTML = '<div class="empty-state"><h2>No se pudo cargar el inicio</h2><p>Intenta de nuevo en unos segundos.</p></div>';
      });
  }

  function pintarInicio(data) {
    var p = data.personal, per = data.periodoActivo, al = data.alertas;
    var cards = p.porTipo.map(function (t) {
      return '<div class="dash-card" data-goto-personal="' + escapeHtml(t.clave) + '">' +
        '<div class="label">' + escapeHtml(t.nombre) + '</div><div class="value">' + t.total + '</div></div>';
    }).join("");

    var alerts = "";
    var hayAlerta = false;
    if (al.incidenciasPendientes > 0) {
      hayAlerta = true;
      alerts += '<div class="alert-item" data-goto="incidencias">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.9 18a2 2 0 0 0 1.7 3h16.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>' +
        al.incidenciasPendientes + (al.incidenciasPendientes === 1 ? " incidencia por revisar" : " incidencias por revisar") + '</div>';
    }
    if (al.periodoProximoACerrar) {
      hayAlerta = true;
      alerts += '<div class="alert-item" data-goto="pagos">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>' +
        "La quincena activa " + (al.diasRestantes <= 0 ? "cierra hoy" : "cierra en " + al.diasRestantes + (al.diasRestantes === 1 ? " día" : " días")) + '</div>';
    }
    if (al.asistenciasIncompletas > 0) {
      hayAlerta = true;
      alerts += '<div class="alert-item" data-goto="asistencias">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/></svg>' +
        al.asistenciasIncompletas + (al.asistenciasIncompletas === 1 ? " asistencia incompleta (sin salida)" : " asistencias incompletas (sin salida)") + '</div>';
    }
    if (!hayAlerta) alerts = '<div class="alert-item alert-ok">' + ICON_CHECK + " Todo al día: no hay pendientes que revisar.</div>";

    el.viewBody.innerHTML =
      '<div class="dash-hero">' +
      '<div><h2>Quincena activa</h2><p>' + fmtFecha(per.inicio) + ' – ' + fmtFecha(per.fin) + (per.cerrada ? " · Pagada" : " · Abierta") + '</p>' +
      '<p>' + per.trabajadores + ' trabajadores con horas · ' + fmtHours(per.horas) + '</p></div>' +
      '<div><div class="dash-hero-total">' + fmtMoney(per.total) + '</div><p>Total a pagar</p></div>' +
      '</div>' +
      '<div class="dash-section-title">Personal (' + p.total + ')</div>' +
      '<div class="dash-grid">' + cards + '</div>' +
      '<div class="dash-section-title">Alertas</div>' +
      '<div class="alert-list">' + alerts + '</div>';

    Array.prototype.forEach.call(el.viewBody.querySelectorAll("[data-goto-personal]"), function (c) {
      c.addEventListener("click", function () { goToSection("personal", { tipo: c.getAttribute("data-goto-personal") }); });
    });
    Array.prototype.forEach.call(el.viewBody.querySelectorAll("[data-goto]"), function (c) {
      c.addEventListener("click", function () {
        var dest = c.getAttribute("data-goto");
        if (dest === "incidencias") goToSection("incidencias", { estatus: "pendiente" });
        else goToSection(dest);
      });
    });
  }
  SECTION_RENDERERS.inicio = renderInicio;

  /* ======================================================================
     PERSONAL (directorio completo)
     ====================================================================== */
  function renderPersonal() {
    if (sectionParams.tipo != null) { filtroPersonal.tipo = sectionParams.tipo; filtroPersonal.estatus = "activos"; }
    el.sectionToolbar.innerHTML = esSoloLectura() ? "" :
      '<button class="btn btn-primary" type="button" id="btnNuevoPersonal">+ Registrar personal</button>';
    if (!esSoloLectura()) document.getElementById("btnNuevoPersonal").addEventListener("click", function () { openWorkerModal(null); });

    el.viewBody.innerHTML = '<div class="loading-state">Cargando…</div>';
    loadWorkers().then(function () { loadTipos().then(pintarPersonal); });
  }

  function tipoFilterOptionsHtml(selected) {
    var opts = '<option value=""' + (selected === "" ? " selected" : "") + '>Todas las modalidades</option>';
    opts += tipos.map(function (t) {
      return '<option value="' + escapeHtml(t.clave) + '"' + (t.clave === selected ? " selected" : "") + '>' + escapeHtml(t.nombre) + '</option>';
    }).join("");
    return opts;
  }

  function pintarPersonal() {
    el.viewBody.innerHTML =
      '<div class="filter-bar">' +
      '<input class="search-input" type="search" id="pQ" placeholder="Buscar por nombre, No. empleado o puesto…" value="' + escapeHtml(filtroPersonal.q) + '">' +
      '<select id="pTipo">' + tipoFilterOptionsHtml(filtroPersonal.tipo) + '</select>' +
      '<select id="pEstatus">' +
      '<option value="activos"' + (filtroPersonal.estatus === "activos" ? " selected" : "") + '>Activos</option>' +
      '<option value="inactivos"' + (filtroPersonal.estatus === "inactivos" ? " selected" : "") + '>Dados de baja</option>' +
      '<option value="todos"' + (filtroPersonal.estatus === "todos" ? " selected" : "") + '>Todos</option>' +
      '</select>' +
      '</div>' +
      '<div id="personalTableHolder"></div>';

    document.getElementById("pQ").addEventListener("input", function () { filtroPersonal.q = this.value; pintarPersonalTabla(); });
    document.getElementById("pTipo").addEventListener("change", function () { filtroPersonal.tipo = this.value; pintarPersonalTabla(); });
    document.getElementById("pEstatus").addEventListener("change", function () { filtroPersonal.estatus = this.value; pintarPersonalTabla(); });
    pintarPersonalTabla();
  }

  function pintarPersonalTabla() {
    var holder = document.getElementById("personalTableHolder");
    if (!holder) return;
    var q = filtroPersonal.q.trim().toLowerCase();
    var list = workers.filter(function (w) {
      if (filtroPersonal.estatus === "activos" && !w.activo) return false;
      if (filtroPersonal.estatus === "inactivos" && w.activo) return false;
      if (filtroPersonal.tipo && w.tipo !== filtroPersonal.tipo) return false;
      if (q && (w.nombre + " " + w.idEmpleado + " " + (w.puesto || "")).toLowerCase().indexOf(q) === -1) return false;
      return true;
    });

    if (!list.length) {
      holder.innerHTML = '<div class="empty-state"><h2>Sin resultados</h2><p>No hay trabajadores que coincidan con esta búsqueda o filtro.</p></div>';
      return;
    }

    var rows = list.map(function (w) {
      return '<tr data-worker="' + w.id + '" class="' + (w.activo ? "" : "inactive") + '">' +
        '<td class="cell-num">' + escapeHtml(w.idEmpleado || "—") + '</td>' +
        '<td class="cell-name"><div class="name">' + escapeHtml(w.nombre) + '</div></td>' +
        '<td>' + escapeHtml(w.puesto || "—") + '</td>' +
        '<td><span class="concept-tag">' + escapeHtml(tipoLabel(w.tipo)) + '</span></td>' +
        '<td class="cell-num">' + (esPagado(w) ? fmtMoney(w.tarifaNormal) : "—") + '</td>' +
        '<td>' + (w.activo ? '<span class="pill pill-aprobada">Activo</span>' : '<span class="pill pill-rechazada">Baja</span>') + '</td>' +
        '<td class="cell-actions">' +
        '<button class="icon-btn" type="button" data-ver="' + w.id + '" title="Ver">' + ICON_EYE + '</button>' +
        (esSoloLectura() ? "" :
          '<button class="icon-btn" type="button" data-editar="' + w.id + '" title="Editar">' + ICON_EDIT + '</button>' +
          (w.activo ? confirmDeleteHtml("worker", w.id, "Dar de baja") : "")) +
        '</td></tr>';
    }).join("");

    holder.innerHTML =
      '<div class="table-scroll"><table>' +
      '<thead><tr><th class="cell-num">No.</th><th>Nombre</th><th>Puesto</th><th>Modalidad</th><th class="cell-num">Tarifa/h</th><th>Estatus</th><th></th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table></div>';

    holder.querySelectorAll("[data-ver], [data-editar]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        openWorkerModal(Number(btn.getAttribute("data-ver") || btn.getAttribute("data-editar")));
      });
    });
    wireConfirmDelete(holder, "[data-del='worker']", function (id) {
      api("DELETE", "/api/workers/" + id).then(function () {
        showToast("Trabajador dado de baja.", "ok");
        loadWorkers().then(pintarPersonalTabla);
      }).catch(function () { showToast("No se pudo dar de baja al trabajador.", "error"); });
    });
  }
  SECTION_RENDERERS.personal = renderPersonal;

  /* ======================================================================
     Worker modal (crear/editar/ver un trabajador) -- se usa desde Personal
     y desde Asistencias/Pagos y recibos.
     ====================================================================== */
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
  function portalHintHtml(w, soloLectura) {
    if (!w || !w.email) {
      return "Si le pones un correo, le llega un enlace para que active su cuenta y pueda descargar su propio recibo o desglose de horas desde su celular.";
    }
    var boton = soloLectura ? "" : ' <button type="button" class="btn btn-ghost" id="btnResendVerify" style="margin-top:6px;">' +
      (w.cuentaPortal === "activa" ? "Reenviar enlace (para restablecer su acceso)" : "Reenviar enlace de activación") + '</button>';
    if (w.cuentaPortal === "activa") return "Ya activó su cuenta del Portal del trabajador." + boton;
    return "Todavía no confirma su correo." + boton;
  }

  function openWorkerModal(workerId) {
    var w = workerId ? workers.find(function (x) { return x.id === workerId; }) : null;
    var isNew = !w;
    var soloLectura = esSoloLectura();
    if (soloLectura && isNew) return;
    var dis = soloLectura ? " disabled" : "";
    var tipoActual = w ? (w.tipo || "nomina") : (sectionParams.tipo || "nomina");
    if (w && !tipos.some(function (t) { return t.clave === tipoActual; })) {
      tipos.push(tipoInfo(tipoActual));
    }

    openModal(
      '<h2>' + (soloLectura ? "Trabajador" : isNew ? "Nuevo trabajador" : "Editar trabajador") + '</h2>' +
      '<div class="field"><label for="fNombre">Nombre completo</label>' +
      '<input id="fNombre" type="text" value="' + (w ? escapeHtml(w.nombre) : "") + '" placeholder="Ej. Ana Torres Medina" autocomplete="off"' + dis + '></div>' +
      '<div class="field"><label for="fPuesto">Puesto (opcional)</label>' +
      '<input id="fPuesto" type="text" value="' + (w ? escapeHtml(w.puesto || "") : "") + '" placeholder="Ej. Instructor, Coordinador, Administrativo" autocomplete="off"' + dis + '></div>' +
      '<div class="field"><label for="fEmail">Correo (opcional) — Portal del trabajador</label>' +
      '<input id="fEmail" type="email" value="' + (w ? escapeHtml(w.email || "") : "") + '" placeholder="correo@ejemplo.com" autocomplete="off"' + dis + '>' +
      '<div class="field-hint">' + portalHintHtml(w, soloLectura) + '</div>' +
      '</div>' +
      '<div class="field"><label for="fTipo">Modalidad</label>' +
      '<div class="field-pin-row">' +
      '<select id="fTipo"' + dis + '>' + tipoOptionsHtml(tipoActual) + '</select>' +
      (soloLectura ? "" : '<button type="button" class="btn btn-ghost" id="btnNuevoTipo" title="Agregar una modalidad nueva">+ Nueva modalidad</button>') +
      '</div>' +
      (soloLectura ? "" :
      '<div class="tipo-new" id="tipoNewBox" hidden>' +
      '<input id="ntNombre" type="text" maxlength="60" placeholder="Ej. Prácticas profesionales, Honorarios, Servicio social" autocomplete="off">' +
      '<label class="tipo-check"><input id="ntPagado" type="checkbox"> Se le paga (lleva tarifa por hora y aparece en Pagos y recibos)</label>' +
      '<div class="field-error" id="ntError"></div>' +
      '<div class="tipo-new-actions">' +
      '<button type="button" class="btn btn-ghost" id="btnNtCancel">Cancelar</button>' +
      '<button type="button" class="btn btn-primary" id="btnNtSave">Guardar modalidad</button>' +
      '</div>' +
      '<div id="tipoCustomList">' + tiposCustomListHtml() + '</div>' +
      '</div>' +
      '<div class="field-hint">Solo a las modalidades marcadas "se le paga" se les calcula un salario. Las de "solo asistencia" únicamente marcan entrada/salida (así son hoy Residencias, Sistema dual y Practicantes).</div>') +
      '</div>' +
      '<div class="field" id="fTarifaWrap"' + (tipoInfo(tipoActual).pagado ? "" : " hidden") + '>' +
      '<label for="fTarifa">Tarifa por hora</label>' +
      '<input id="fTarifa" class="money" type="number" min="0" step="0.5" value="' + (w ? w.tarifaNormal : "") + '" placeholder="0.00"' + dis + '></div>' +
      '<div class="field"><label for="fIdEmpleado">Número de empleado (hasta 8 dígitos)</label>' +
      '<div class="field-pin-row">' +
      '<input id="fIdEmpleado" class="money" type="text" inputmode="numeric" maxlength="8" value="' + (w ? escapeHtml(w.idEmpleado || "") : "") + '" placeholder="00000001"' + dis + '>' +
      (soloLectura ? "" : '<button type="button" class="btn btn-ghost" id="btnGenId">Generar</button>') +
      '</div>' +
      '<div class="field-hint">Su número de identificación dentro de YES EMS.</div>' +
      '</div>' +
      '<div class="field"><label for="fPin">PIN de acceso (4 dígitos)</label>' +
      '<div class="field-pin-row">' +
      '<input id="fPin" class="money" type="text" inputmode="numeric" maxlength="4" value="' + (w ? escapeHtml(w.pin || "") : "") + '" placeholder="0000"' + dis + '>' +
      (soloLectura ? "" : '<button type="button" class="btn btn-ghost" id="btnGenPin">Generar</button>') +
      '</div>' +
      '<div class="field-hint">Junto con su número de empleado, lo usará para marcar su entrada y salida desde el código QR.</div>' +
      '</div>' +
      '<div class="field-error" id="fError"></div>' +
      '<div class="modal-actions">' +
      (soloLectura
        ? '<button class="btn btn-primary" type="button" id="btnCancelModal">Cerrar</button>'
        : '<button class="btn btn-ghost" type="button" id="btnCancelModal">Cancelar</button>' +
          '<button class="btn btn-primary" type="button" id="btnSaveModal">' + (isNew ? "Agregar" : "Guardar cambios") + '</button>') +
      '</div>'
    );
    document.getElementById("fNombre").focus();
    document.getElementById("btnCancelModal").addEventListener("click", closeModal);
    if (soloLectura) return;

    document.getElementById("fTipo").addEventListener("change", function () {
      document.getElementById("fTarifaWrap").hidden = !tipoInfo(this.value).pagado;
    });

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
      if (!nombreTipo) { ntErr.textContent = "Escribe el nombre de la nueva modalidad."; return; }
      api("POST", "/api/tipos", { nombre: nombreTipo, pagado: pagado }).then(function (nuevo) {
        return loadTipos().then(function () {
          refreshTipoSelect(nuevo.clave);
          document.getElementById("ntNombre").value = "";
          document.getElementById("ntPagado").checked = false;
          showToast('Modalidad "' + nuevo.nombre + '" agregada.', "ok");
        });
      }).catch(function (err) { ntErr.textContent = err.message || "No se pudo agregar."; });
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
        btn.dataset.confirm = "1"; btn.textContent = "¿Eliminar?"; btn.classList.add("confirming");
        return;
      }
      api("DELETE", "/api/tipos/" + encodeURIComponent(clave)).then(function () {
        return loadTipos().then(function () { refreshTipoSelect(); showToast("Modalidad eliminada.", "ok"); });
      }).catch(function (err) {
        ntErr.textContent = err.message || "No se pudo eliminar.";
        document.getElementById("tipoCustomList").innerHTML = tiposCustomListHtml();
      });
    });
    document.getElementById("btnGenId").addEventListener("click", function () { document.getElementById("fIdEmpleado").value = generateLocalIdGuess(); });
    document.getElementById("btnGenPin").addEventListener("click", function () { document.getElementById("fPin").value = generateLocalPinGuess(); });
    var resendBtn = document.getElementById("btnResendVerify");
    if (resendBtn) {
      resendBtn.addEventListener("click", function () {
        resendBtn.disabled = true;
        api("POST", "/api/workers/" + w.id + "/resend-verification").then(function (data) {
          if (data.avisoCorreo) {
            showToast(data.avisoCorreo, "error");
            window.prompt("Copia este enlace y mándaselo a " + w.nombre + " (por WhatsApp, SMS, etc.):", data.enlaceActivacion);
          } else {
            showToast("Enlace reenviado a " + w.email + ".", "ok");
          }
        }).catch(function (err) { showToast(err.message || "No se pudo reenviar el enlace.", "error"); })
          .then(function () { resendBtn.disabled = false; });
      });
    }

    document.getElementById("btnSaveModal").addEventListener("click", function () {
      var nombre = document.getElementById("fNombre").value.trim();
      var puesto = document.getElementById("fPuesto").value.trim();
      var email = document.getElementById("fEmail").value.trim();
      var tipo = document.getElementById("fTipo").value;
      var tarifaNormal = tipoInfo(tipo).pagado ? parseFloat(document.getElementById("fTarifa").value) : 0;
      var idEmpleado = document.getElementById("fIdEmpleado").value.trim();
      var pin = document.getElementById("fPin").value.trim();
      var errEl = document.getElementById("fError");

      if (!nombre) { errEl.textContent = "Escribe el nombre del trabajador."; return; }
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { errEl.textContent = "Escribe un correo electrónico válido (o déjalo vacío)."; return; }
      if (tipoInfo(tipo).pagado && !(tarifaNormal >= 0)) { errEl.textContent = "Escribe una tarifa por hora válida."; return; }
      if (!/^\d{1,8}$/.test(idEmpleado)) { errEl.textContent = "El número de empleado debe tener solo dígitos (máximo 8)."; return; }
      if (!/^\d{4}$/.test(pin)) { errEl.textContent = "El PIN debe tener exactamente 4 dígitos."; return; }

      var payload = { nombre: nombre, puesto: puesto, email: email, tipo: tipo, tarifaNormal: tarifaNormal, idEmpleado: idEmpleado, pin: pin };
      var req = isNew ? api("POST", "/api/workers", payload) : api("PUT", "/api/workers/" + w.id, payload);
      req.then(function (saved) {
        closeModal();
        if (saved && saved.avisoCorreo) {
          showToast(saved.avisoCorreo, "error");
          if (saved.enlaceActivacion) window.prompt("Copia este enlace y mándaselo a " + nombre + " (por WhatsApp, SMS, etc.):", saved.enlaceActivacion);
        } else {
          showToast(isNew ? "Trabajador agregado." : "Cambios guardados.", "ok");
        }
        loadWorkers().then(function () {
          if (currentSection === "personal") pintarPersonalTabla();
          else if (currentSection === "asistencias") pintarAsistenciasTabla();
          else if (currentSection === "pagos") loadPeriod();
        });
      }).catch(function (err) { errEl.textContent = err.message || "No se pudo guardar. Intenta de nuevo."; });
    });
  }

  function generateLocalPinGuess() {
    var used = {}; workers.forEach(function (w) { if (w.pin) used[w.pin] = true; });
    var pin; do { pin = String(Math.floor(1000 + Math.random() * 9000)); } while (used[pin]);
    return pin;
  }
  function generateLocalIdGuess() {
    var used = {}; workers.forEach(function (w) { if (w.idEmpleado) used[w.idEmpleado] = true; });
    var id; do { id = String(Math.floor(1000 + Math.random() * 9000)); } while (used[id]);
    return id;
  }

  /* ======================================================================
     ASISTENCIAS
     ====================================================================== */
  function renderAsistencias() {
    el.sectionToolbar.innerHTML =
      '<div class="period-nav">' +
      '<button class="nav-btn" id="aPrev" type="button" aria-label="Quincena anterior"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6"/></svg></button>' +
      '<div><div class="period-label" id="aPeriodLabel">Cargando…</div><div class="period-sub" id="aPeriodSub">&nbsp;</div></div>' +
      '<button class="nav-btn" id="aNext" type="button" aria-label="Quincena siguiente"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg></button>' +
      '</div>' +
      '<button class="btn btn-ghost" type="button" id="btnQr">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/></svg>Código QR</button>' +
      (esSoloLectura() ? "" : '<button class="btn btn-primary" type="button" id="btnAddTurno">+ Registrar turno</button>');

    document.getElementById("aPrev").addEventListener("click", function () {
      var q = quincenaFor(periodAnchor); var d = new Date(q.inicio); d.setDate(d.getDate() - 1); periodAnchor = d; loadPeriod();
    });
    document.getElementById("aNext").addEventListener("click", function () {
      var q = quincenaFor(periodAnchor); var d = new Date(q.fin); d.setDate(d.getDate() + 1); periodAnchor = d; loadPeriod();
    });
    document.getElementById("btnQr").addEventListener("click", openQrModal);
    if (!esSoloLectura()) document.getElementById("btnAddTurno").addEventListener("click", function () { openTurnoModal(null, null); });

    el.viewBody.innerHTML = '<div class="loading-state">Cargando…</div>';
    loadWorkers().then(loadTipos).then(loadPeriod);
    startAsistenciaPolling();
  }

  function loadPeriod() {
    var q = quincenaFor(periodAnchor);
    var pid = periodIdFor(q);
    var startStr = ymd(q.inicio), endStr = ymd(q.fin);
    return Promise.all([
      api("GET", "/api/periods/" + pid),
      api("GET", "/api/turnos?start=" + startStr + "&end=" + endStr),
    ]).then(function (res) {
      currentPeriodData = res[0];
      currentTurnos = res[1];
      currentClosed = !!currentPeriodData.cerrada;
      if (currentSection === "asistencias") pintarAsistencias();
      else if (currentSection === "pagos") pintarPagos();
    }).catch(function () {
      showToast("No se pudo cargar esta quincena.", "error");
    });
  }

  function refreshTurnos(opts) {
    opts = opts || {};
    var q = quincenaFor(periodAnchor);
    return api("GET", "/api/turnos?start=" + ymd(q.inicio) + "&end=" + ymd(q.fin)).then(function (data) {
      currentTurnos = data;
      if (currentSection === "asistencias") pintarAsistenciasTabla();
    }).catch(function () { if (!opts.silent) showToast("No se pudo actualizar la asistencia.", "error"); });
  }
  function startAsistenciaPolling() {
    stopAsistenciaPolling();
    asistenciaPollTimer = setInterval(function () {
      if (currentSection === "asistencias" && document.visibilityState === "visible") refreshTurnos({ silent: true });
    }, 15000);
  }
  function stopAsistenciaPolling() { if (asistenciaPollTimer) { clearInterval(asistenciaPollTimer); asistenciaPollTimer = null; } }

  function pintarAsistencias() {
    var q = quincenaFor(periodAnchor);
    var lbl = document.getElementById("aPeriodLabel");
    if (lbl) {
      lbl.textContent = fmtRange(q);
      document.getElementById("aPeriodSub").textContent = "Quincena " + q.half;
    }
    el.viewBody.innerHTML =
      '<div class="filter-bar">' +
      '<input class="search-input" type="search" id="asQ" placeholder="Buscar trabajador…" value="' + escapeHtml(filtroAsistencias.q) + '">' +
      '<select id="asTipo">' + tipoFilterOptionsHtml(filtroAsistencias.tipo) + '</select>' +
      '<select id="asEstatus">' +
      '<option value=""' + (filtroAsistencias.estatus === "" ? " selected" : "") + '>Todos los turnos</option>' +
      '<option value="completa"' + (filtroAsistencias.estatus === "completa" ? " selected" : "") + '>Completa</option>' +
      '<option value="abierto"' + (filtroAsistencias.estatus === "abierto" ? " selected" : "") + '>Sin registro de salida</option>' +
      '</select>' +
      '</div>' +
      '<div class="stats" id="asStats">' +
      '<div class="stat-tile"><div class="label">Turnos registrados</div><div class="value" id="asStatTurnos">–</div></div>' +
      '<div class="stat-tile"><div class="label">Horas totales</div><div class="value" id="asStatHoras">–</div></div>' +
      '<div class="stat-tile accent"><div class="label">Turnos abiertos</div><div class="value" id="asStatAbiertos">–</div></div>' +
      '</div>' +
      (esSoloLectura() ? "" : '<div class="table-toolbar"><button class="btn btn-primary" type="button" id="btnApplyAsistencia">Aplicar horas a nómina</button></div>') +
      '<div id="asistenciaTableHolder"></div>';

    document.getElementById("asQ").addEventListener("input", function () { filtroAsistencias.q = this.value; pintarAsistenciasTabla(); });
    document.getElementById("asTipo").addEventListener("change", function () { filtroAsistencias.tipo = this.value; pintarAsistenciasTabla(); });
    document.getElementById("asEstatus").addEventListener("change", function () { filtroAsistencias.estatus = this.value; pintarAsistenciasTabla(); });
    var btnApply = document.getElementById("btnApplyAsistencia");
    if (btnApply) btnApply.addEventListener("click", applyAsistenciaToNomina);

    pintarAsistenciasTabla();
  }

  function turnoActionsHtml(turnoId) {
    if (esSoloLectura()) return "";
    return '<button class="icon-btn" type="button" data-taction="edit" data-id="' + turnoId + '" title="Editar turno">' + ICON_EDIT + '</button>' +
      confirmDeleteHtml("turno", turnoId, "Eliminar turno");
  }

  function pintarAsistenciasTabla() {
    var holder = document.getElementById("asistenciaTableHolder");
    if (!holder) return;
    var byWorker = {};
    currentTurnos.forEach(function (t) { (byWorker[t.workerId] = byWorker[t.workerId] || []).push(t); });

    var q = filtroAsistencias.q.trim().toLowerCase();
    var activeWorkers = workers.filter(function (w) {
      if (!w.activo) return false;
      if (filtroAsistencias.tipo && w.tipo !== filtroAsistencias.tipo) return false;
      if (q && w.nombre.toLowerCase().indexOf(q) === -1) return false;
      return true;
    });
    var ids = {}; activeWorkers.forEach(function (w) { ids[w.id] = true; });
    var extraWorkers = Object.keys(byWorker).filter(function (id) { return !ids[id]; })
      .map(function (id) { return workers.find(function (w) { return String(w.id) === String(id); }); })
      .filter(function (w) {
        if (!w) return false;
        if (filtroAsistencias.tipo && w.tipo !== filtroAsistencias.tipo) return false;
        if (q && w.nombre.toLowerCase().indexOf(q) === -1) return false;
        return true;
      });
    var list = activeWorkers.concat(extraWorkers);

    if (currentTurnos.length === 0 || list.length === 0) {
      holder.innerHTML = '<div class="empty-state">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/></svg>' +
        '<h2>Sin registros</h2><p>Comparte el código QR con tus trabajadores para que marquen su entrada y salida, o registra un turno manualmente.</p></div>';
      setText("asStatTurnos", 0); setText("asStatHoras", fmtHours(0)); setText("asStatAbiertos", 0);
      return;
    }

    var totalHoras = 0, abiertos = 0, totalTurnos = 0;
    asistenciaSubtotals = {};
    var rowsHtml = list.map(function (w) {
      var turnos = (byWorker[w.id] || []).slice().sort(function (a, b) { return a.entrada < b.entrada ? -1 : (a.entrada > b.entrada ? 1 : 0); });
      if (filtroAsistencias.estatus) {
        turnos = turnos.filter(function (t) { return filtroAsistencias.estatus === "completa" ? !!t.salida : !t.salida; });
      }
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
          '<td class="cell-actions">' + turnoActionsHtml(t.id) + '</td>' +
          '</tr>';
      }).join("");
      totalHoras += subtotal;
      asistenciaSubtotals[w.id] = subtotal;
      return body + '<tr class="subtotal-row"><td colspan="3">Subtotal — ' + escapeHtml(w.nombre) + '</td><td class="cell-num">' + fmtHours(subtotal) + '</td>' +
        '<td class="cell-actions"><button class="icon-btn" type="button" data-dl-worker="' + w.id + '" title="Descargar PDF">' + ICON_PDF + '</button></td></tr>';
    }).join("");

    holder.innerHTML = '<div class="table-scroll"><table id="asistenciaTable">' +
      '<thead><tr><th>Trabajador</th><th>Entrada</th><th>Salida</th><th class="cell-num">Horas</th><th></th></tr></thead>' +
      '<tbody>' + rowsHtml + '</tbody></table></div>';

    setText("asStatTurnos", totalTurnos); setText("asStatHoras", fmtHours(totalHoras)); setText("asStatAbiertos", abiertos);

    holder.querySelectorAll("[data-dl-worker]").forEach(function (b) { b.addEventListener("click", function () { downloadWorkerPdf(Number(b.getAttribute("data-dl-worker"))); }); });
    holder.querySelectorAll("[data-taction='edit']").forEach(function (b) {
      b.addEventListener("click", function () { openTurnoModal(Number(b.getAttribute("data-id")), b.closest("tr").dataset.worker); });
    });
    wireConfirmDelete(holder, "[data-del='turno']", function (id) {
      api("DELETE", "/api/turnos/" + id).then(function () { showToast("Turno eliminado.", "ok"); loadPeriod(); })
        .catch(function () { showToast("No se pudo eliminar el turno.", "error"); });
    });
  }

  function setText(id, val) { var e = document.getElementById(id); if (e) e.textContent = val; }

  function applyAsistenciaToNomina() {
    var q = quincenaFor(periodAnchor);
    var pid = periodIdFor(q);
    var workerIds = Object.keys(asistenciaSubtotals).filter(function (wid) {
      var w = workers.find(function (x) { return String(x.id) === String(wid); });
      return w && esPagado(w);
    });
    if (workerIds.length === 0) { showToast("No hay horas de trabajadores de nómina que aplicar.", "error"); return; }
    Promise.all(workerIds.map(function (wid) {
      return api("PUT", "/api/periods/" + pid + "/entries/" + wid, { horasNormales: asistenciaSubtotals[wid] });
    })).then(function () { showToast("Horas aplicadas a la nómina de esta quincena.", "ok"); loadPeriod(); })
      .catch(function () { showToast("No se pudieron aplicar todas las horas. Intenta de nuevo.", "error"); });
  }

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
    openModal(
      '<h2>' + (isNew ? "Registrar turno" : "Editar turno") + '</h2>' + workerFieldHtml +
      '<div class="field"><label for="tEntrada">Entrada</label><input id="tEntrada" type="datetime-local" value="' + toLocalInputValue(entradaDate) + '"></div>' +
      '<div class="field"><label for="tSalida">Salida (déjalo vacío si el turno sigue abierto)</label><input id="tSalida" type="datetime-local" value="' + (salidaDate ? toLocalInputValue(salidaDate) : "") + '"></div>' +
      '<div class="field-error" id="tError"></div>' +
      '<div class="modal-actions"><button class="btn btn-ghost" type="button" id="btnCancelTurno">Cancelar</button><button class="btn btn-primary" type="button" id="btnSaveTurno">Guardar</button></div>'
    );
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
  SECTION_RENDERERS.asistencias = renderAsistencias;

  /* ============ Código QR ============ */
  function openQrModal() {
    openModal(
      '<h2>Código QR de asistencia</h2>' +
      '<div class="qr-wrap"><div class="qr-canvas-box"><img id="qrImg" src="/api/qr.png" alt="Código QR del checador"></div>' +
      '<div class="qr-url" id="qrUrlText">Cargando enlace…</div>' +
      '<button class="btn btn-primary" type="button" id="btnCopyQr" style="width:100%;justify-content:center;">Copiar enlace</button>' +
      '<p class="field-hint">Cualquier persona con este enlace puede abrir la pantalla de entrada/salida; solo podrá marcar si conoce el PIN de un trabajador activo.</p></div>' +
      '<div class="modal-actions"><button class="btn btn-ghost" type="button" id="btnCloseQr">Cerrar</button></div>'
    );
    var qrUrl = "";
    api("GET", "/api/qr-url").then(function (data) { qrUrl = data.url; document.getElementById("qrUrlText").textContent = qrUrl; })
      .catch(function () { document.getElementById("qrUrlText").textContent = "No se pudo obtener el enlace."; });
    document.getElementById("btnCopyQr").addEventListener("click", function () {
      if (!qrUrl) return;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(qrUrl).then(function () { showToast("Enlace copiado.", "ok"); })
          .catch(function () { showToast("No se pudo copiar. Selecciona el enlace manualmente.", "error"); });
      } else showToast("Selecciona el enlace manualmente para copiarlo.", "error");
    });
    document.getElementById("btnCloseQr").addEventListener("click", closeModal);
  }

  /* ======================================================================
     INCIDENCIAS
     ====================================================================== */
  var TIPOS_INCIDENCIA = [
    ["retardo", "Retardo"], ["falta", "Falta"], ["permiso", "Permiso"], ["justificante", "Justificante"], ["otro", "Otro"],
  ];
  function incidenciaTipoLabel(clave) { var f = TIPOS_INCIDENCIA.find(function (t) { return t[0] === clave; }); return f ? f[1] : clave; }

  function renderIncidencias() {
    if (sectionParams.estatus != null) filtroIncidencias.estatus = sectionParams.estatus;
    el.sectionToolbar.innerHTML = esSoloLectura() ? "" : '<button class="btn btn-primary" type="button" id="btnNuevaIncidencia">+ Registrar incidencia</button>';
    el.viewBody.innerHTML = '<div class="loading-state">Cargando…</div>';
    loadWorkers().then(function () {
      if (!esSoloLectura()) document.getElementById("btnNuevaIncidencia").addEventListener("click", function () { openIncidenciaModal(null); });
      pintarIncidencias();
    });
  }

  function pintarIncidencias() {
    el.viewBody.innerHTML =
      '<div class="filter-bar">' +
      '<input class="search-input" type="search" id="iQ" placeholder="Buscar por trabajador o descripción…" value="' + escapeHtml(filtroIncidencias.q) + '">' +
      '<select id="iTipo"><option value="">Todos los tipos</option>' + TIPOS_INCIDENCIA.map(function (t) {
        return '<option value="' + t[0] + '"' + (filtroIncidencias.tipo === t[0] ? " selected" : "") + '>' + t[1] + '</option>';
      }).join("") + '</select>' +
      '<select id="iEstatus"><option value="">Todos los estatus</option>' +
      '<option value="pendiente"' + (filtroIncidencias.estatus === "pendiente" ? " selected" : "") + '>Pendiente</option>' +
      '<option value="aprobada"' + (filtroIncidencias.estatus === "aprobada" ? " selected" : "") + '>Aprobada</option>' +
      '<option value="rechazada"' + (filtroIncidencias.estatus === "rechazada" ? " selected" : "") + '>Rechazada</option>' +
      '</select>' +
      '</div><div id="incidenciasHolder"><div class="loading-state">Cargando…</div></div>';

    document.getElementById("iQ").addEventListener("input", function () { filtroIncidencias.q = this.value; cargarIncidencias(); });
    document.getElementById("iTipo").addEventListener("change", function () { filtroIncidencias.tipo = this.value; cargarIncidencias(); });
    document.getElementById("iEstatus").addEventListener("change", function () { filtroIncidencias.estatus = this.value; cargarIncidencias(); });
    cargarIncidencias();
  }

  function cargarIncidencias() {
    var params = [];
    if (filtroIncidencias.tipo) params.push("tipo=" + encodeURIComponent(filtroIncidencias.tipo));
    if (filtroIncidencias.estatus) params.push("estatus=" + encodeURIComponent(filtroIncidencias.estatus));
    api("GET", "/api/incidencias" + (params.length ? "?" + params.join("&") : "")).then(function (data) {
      var q = filtroIncidencias.q.trim().toLowerCase();
      if (q) data = data.filter(function (i) { return (i.workerNombre + " " + i.descripcion).toLowerCase().indexOf(q) !== -1; });
      pintarIncidenciasTabla(data);
    }).catch(function () {
      document.getElementById("incidenciasHolder").innerHTML = '<div class="empty-state"><h2>No se pudo cargar</h2></div>';
    });
  }

  function pintarIncidenciasTabla(list) {
    var holder = document.getElementById("incidenciasHolder");
    if (!list.length) {
      holder.innerHTML = '<div class="empty-state"><h2>Sin incidencias</h2><p>No hay incidencias registradas con estos filtros.</p></div>';
      return;
    }
    var rows = list.map(function (i) {
      var acciones = '<button class="icon-btn" type="button" data-ver-inc="' + i.id + '" title="Ver / editar">' + (esSoloLectura() ? ICON_EYE : ICON_EDIT) + '</button>';
      if (!esSoloLectura()) {
        if (i.estatus !== "aprobada") acciones += '<button class="icon-btn" type="button" data-estatus-inc="' + i.id + '" data-nuevo="aprobada" title="Aprobar">' + ICON_CHECK + '</button>';
        if (i.estatus !== "rechazada") acciones += '<button class="icon-btn" type="button" data-estatus-inc="' + i.id + '" data-nuevo="rechazada" title="Rechazar">' + ICON_X + '</button>';
        acciones += confirmDeleteHtml("incidencia", i.id, "Eliminar incidencia");
      }
      return '<tr>' +
        '<td class="cell-name"><div class="name">' + escapeHtml(i.workerNombre) + '</div></td>' +
        '<td>' + escapeHtml(incidenciaTipoLabel(i.tipo)) + '</td>' +
        '<td>' + escapeHtml(i.descripcion || "—") + '</td>' +
        '<td>' + fmtFecha(i.fecha) + '</td>' +
        '<td><span class="pill pill-' + i.estatus + '">' + i.estatus.charAt(0).toUpperCase() + i.estatus.slice(1) + '</span></td>' +
        '<td class="cell-actions">' + acciones + '</td>' +
        '</tr>';
    }).join("");
    holder.innerHTML = '<div class="table-scroll"><table>' +
      '<thead><tr><th>Empleado</th><th>Tipo</th><th>Descripción</th><th>Fecha</th><th>Estatus</th><th></th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table></div>';

    holder.querySelectorAll("[data-ver-inc]").forEach(function (b) {
      b.addEventListener("click", function () { openIncidenciaModal(Number(b.getAttribute("data-ver-inc"))); });
    });
    holder.querySelectorAll("[data-estatus-inc]").forEach(function (b) {
      b.addEventListener("click", function () {
        api("PUT", "/api/incidencias/" + b.getAttribute("data-estatus-inc") + "/estatus", { estatus: b.getAttribute("data-nuevo") })
          .then(function () { showToast("Estatus actualizado.", "ok"); cargarIncidencias(); })
          .catch(function (err) { showToast(err.message || "No se pudo actualizar.", "error"); });
      });
    });
    wireConfirmDelete(holder, "[data-del='incidencia']", function (id) {
      api("DELETE", "/api/incidencias/" + id).then(function () { showToast("Incidencia eliminada.", "ok"); cargarIncidencias(); })
        .catch(function () { showToast("No se pudo eliminar.", "error"); });
    });
  }

  function openIncidenciaModal(id) {
    var soloLectura = esSoloLectura();
    var inc = null;
    var activeWorkers = workers.filter(function (w) { return w.activo; });
    function build(incidencia) {
      inc = incidencia;
      var isNew = !inc;
      var dis = soloLectura ? " disabled" : "";
      var workerOpts = activeWorkers.map(function (w) {
        return '<option value="' + w.id + '"' + (inc && String(inc.workerId) === String(w.id) ? " selected" : "") + '>' + escapeHtml(w.nombre) + '</option>';
      }).join("");
      openModal(
        '<h2>' + (isNew ? "Registrar incidencia" : "Incidencia") + '</h2>' +
        '<div class="field"><label for="icWorker">Trabajador</label><select id="icWorker"' + dis + '>' + workerOpts + '</select></div>' +
        '<div class="field"><label for="icTipo">Tipo</label><select id="icTipo"' + dis + '>' + TIPOS_INCIDENCIA.map(function (t) {
          return '<option value="' + t[0] + '"' + (inc && inc.tipo === t[0] ? " selected" : "") + '>' + t[1] + '</option>';
        }).join("") + '</select></div>' +
        '<div class="field"><label for="icFecha">Fecha</label><input id="icFecha" type="date" value="' + (inc ? inc.fecha : ymd(new Date())) + '"' + dis + '></div>' +
        '<div class="field"><label for="icDesc">Descripción (opcional)</label><input id="icDesc" type="text" maxlength="500" value="' + (inc ? escapeHtml(inc.descripcion) : "") + '" placeholder="Ej. Llegó 15 min tarde"' + dis + '></div>' +
        (inc ? '<div class="field-hint">Estatus actual: <span class="pill pill-' + inc.estatus + '">' + inc.estatus.charAt(0).toUpperCase() + inc.estatus.slice(1) + '</span></div>' : "") +
        '<div class="field-error" id="icError"></div>' +
        '<div class="modal-actions">' +
        (soloLectura
          ? '<button class="btn btn-primary" type="button" id="btnCancelIc">Cerrar</button>'
          : '<button class="btn btn-ghost" type="button" id="btnCancelIc">Cancelar</button><button class="btn btn-primary" type="button" id="btnSaveIc">' + (isNew ? "Registrar" : "Guardar cambios") + '</button>')
        + '</div>'
      );
      document.getElementById("btnCancelIc").addEventListener("click", closeModal);
      if (soloLectura) return;
      document.getElementById("btnSaveIc").addEventListener("click", function () {
        var errEl = document.getElementById("icError");
        var payload = {
          workerId: Number(document.getElementById("icWorker").value),
          tipo: document.getElementById("icTipo").value,
          fecha: document.getElementById("icFecha").value,
          descripcion: document.getElementById("icDesc").value.trim(),
        };
        if (!payload.fecha) { errEl.textContent = "Indica la fecha."; return; }
        var req = isNew ? api("POST", "/api/incidencias", payload) : api("PUT", "/api/incidencias/" + inc.id, payload);
        req.then(function () {
          closeModal();
          showToast(isNew ? "Incidencia registrada." : "Cambios guardados.", "ok");
          cargarIncidencias();
        }).catch(function (err) { errEl.textContent = err.message || "No se pudo guardar."; });
      });
    }
    if (id) {
      api("GET", "/api/incidencias").then(function (list) {
        build(list.find(function (i) { return i.id === id; }));
      });
    } else build(null);
  }
  SECTION_RENDERERS.incidencias = renderIncidencias;

  /* ======================================================================
     PERIODOS DE NÓMINA
     ====================================================================== */
  function renderPeriodos() {
    if (!historialRango) {
      var hoy = new Date();
      var desde = new Date(hoy.getFullYear(), hoy.getMonth() - 2, 1);
      var hasta = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 0);
      historialRango = { desde: ymd(desde), hasta: ymd(hasta) };
    }
    el.sectionToolbar.innerHTML = "";
    el.viewBody.innerHTML =
      '<p class="field-hint">Las quincenas las genera solo el calendario ya establecido (del 15 al 14, y del resto del mes) -- aquí solo se consultan y se abren, no se crean a mano.</p>' +
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
      '<div id="periodosHolder"><div class="loading-state">Cargando…</div></div>';

    function buscar() {
      var desdeV = document.getElementById("hDesde").value;
      var hastaV = document.getElementById("hHasta").value;
      var errEl = document.getElementById("hError");
      errEl.textContent = "";
      if (!desdeV || !hastaV) { errEl.textContent = "Escoge las dos fechas."; return; }
      if (desdeV > hastaV) { errEl.textContent = "La fecha \"Desde\" debe ser anterior a \"Hasta\"."; return; }
      historialRango = { desde: desdeV, hasta: hastaV };
      var holder = document.getElementById("periodosHolder");
      holder.innerHTML = '<div class="loading-state">Cargando…</div>';
      api("GET", "/api/periods?desde=" + desdeV + "&hasta=" + hastaV).then(function (periodos) {
        pintarPeriodos(periodos);
      }).catch(function (err) { holder.innerHTML = ""; errEl.textContent = err.message || "No se pudo cargar."; });
    }

    document.getElementById("btnHistBuscar").addEventListener("click", buscar);
    ["hDesde", "hHasta"].forEach(function (id) { document.getElementById(id).addEventListener("change", buscar); });
    el.viewBody.querySelector(".hist-presets").addEventListener("click", function (e) {
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
    buscar();
  }

  function pintarPeriodos(periodos) {
    var holder = document.getElementById("periodosHolder");
    if (!periodos.length) { holder.innerHTML = '<div class="empty-state"><h2>No hay quincenas en ese rango</h2></div>'; return; }
    var rows = periodos.slice().reverse().map(function (p) {
      return '<tr>' +
        '<td><div class="name">' + fmtFecha(p.inicio) + ' – ' + fmtFecha(p.fin) + '</div><div class="puesto">Quincena ' + p.quincena + '</div></td>' +
        '<td>' + fmtFecha(p.inicio) + '</td><td>' + fmtFecha(p.fin) + '</td>' +
        '<td>' + (p.cerrada ? '<span class="pill pill-aprobada">Pagada</span>' : '<span class="pill pill-pendiente">Abierta</span>') + '</td>' +
        '<td class="cell-num">' + p.trabajadores + '</td>' +
        '<td class="cell-actions"><button class="btn btn-ghost btn-sm" type="button" data-abrir="' + p.id + '">Abrir</button></td>' +
        '</tr>';
    }).join("");
    holder.innerHTML = '<div class="table-scroll"><table>' +
      '<thead><tr><th>Periodo</th><th>Fecha inicio</th><th>Fecha fin</th><th>Estatus</th><th class="cell-num">Personal</th><th></th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table></div>';
    holder.querySelectorAll("[data-abrir]").forEach(function (b) {
      b.addEventListener("click", function () {
        var q = quincenaFromIdClient(b.getAttribute("data-abrir"));
        if (q) { periodAnchor = q.inicio; goToSection("pagos"); }
      });
    });
  }
  // Version cliente de quincenaFromId (solo para "Abrir" -> convertir el id
  // de vuelta a una fecha dentro de esa quincena).
  function quincenaFromIdClient(id) {
    var m = /^(\d{4})-(\d{2})-([12])$/.exec(String(id || ""));
    if (!m) return null;
    var year = Number(m[1]), monthIndex = Number(m[2]) - 1, half = Number(m[3]);
    var day = half === 1 ? 10 : 20;
    return { inicio: new Date(year, monthIndex, day) };
  }
  SECTION_RENDERERS.periodos = renderPeriodos;

  /* ======================================================================
     PERCEPCIONES / DEDUCCIONES (catálogo)
     ====================================================================== */
  function renderConceptos(categoria) {
    el.sectionToolbar.innerHTML = esSoloLectura() ? "" :
      '<button class="btn btn-primary" type="button" id="btnNuevoConcepto">+ Registrar ' + (categoria === "percepcion" ? "percepción" : "deducción") + '</button>';
    el.viewBody.innerHTML =
      '<p class="field-hint">Catálogo de referencia: documenta los conceptos de ' + (categoria === "percepcion" ? "percepciones (ingresos)" : "deducciones (descuentos)") +
      ' para tenerlos organizados. No se suman ni se restan solos del total a pagar -- el cálculo sigue siendo horas × tarifa, igual que en Pagos y recibos.</p>' +
      '<div class="filter-bar"><input class="search-input" type="search" id="cQ" placeholder="Buscar por clave o concepto…"></div>' +
      '<div id="conceptosHolder"><div class="loading-state">Cargando…</div></div>';
    if (!esSoloLectura()) document.getElementById("btnNuevoConcepto").addEventListener("click", function () { openConceptoModal(null, categoria); });
    var cargar = function () {
      api("GET", "/api/conceptos?categoria=" + categoria).then(function (data) {
        var q = document.getElementById("cQ").value.trim().toLowerCase();
        if (q) data = data.filter(function (c) { return (c.clave + " " + c.concepto).toLowerCase().indexOf(q) !== -1; });
        pintarConceptos(data, categoria, cargar);
      }).catch(function () { document.getElementById("conceptosHolder").innerHTML = '<div class="empty-state"><h2>No se pudo cargar</h2></div>'; });
    };
    document.getElementById("cQ").addEventListener("input", cargar);
    cargar();
  }

  function pintarConceptos(list, categoria, recargar) {
    var holder = document.getElementById("conceptosHolder");
    if (!list.length) { holder.innerHTML = '<div class="empty-state"><h2>Sin conceptos</h2><p>Todavía no hay ninguno registrado.</p></div>'; return; }
    var rows = list.map(function (c) {
      var aplicaHtml = c.aplicaA.indexOf("todas") !== -1
        ? '<span class="concept-tag">Todas</span>'
        : c.aplicaA.map(function (clave) { return '<span class="concept-tag">' + escapeHtml(tipoLabel(clave)) + '</span>'; }).join("");
      var acciones = '<button class="icon-btn" type="button" data-editar-concepto="' + c.id + '" title="' + (esSoloLectura() ? "Ver" : "Editar") + '">' + (esSoloLectura() ? ICON_EYE : ICON_EDIT) + '</button>';
      if (!esSoloLectura()) acciones += confirmDeleteHtml("concepto", c.id, "Eliminar concepto");
      return '<tr><td><strong>' + escapeHtml(c.clave) + '</strong></td><td>' + escapeHtml(c.concepto) + '</td>' +
        '<td>' + escapeHtml(c.tipo || "—") + '</td><td>' + aplicaHtml + '</td>' +
        '<td>' + (c.activo ? '<span class="pill pill-aprobada">Activo</span>' : '<span class="pill pill-rechazada">Inactivo</span>') + '</td>' +
        '<td class="cell-actions">' + acciones + '</td></tr>';
    }).join("");
    holder.innerHTML = '<div class="table-scroll"><table>' +
      '<thead><tr><th>Clave</th><th>Concepto</th><th>Tipo</th><th>Aplica a</th><th>Estatus</th><th></th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table></div>';
    holder.querySelectorAll("[data-editar-concepto]").forEach(function (b) {
      b.addEventListener("click", function () { openConceptoModal(Number(b.getAttribute("data-editar-concepto")), categoria, list); });
    });
    wireConfirmDelete(holder, "[data-del='concepto']", function (id) {
      api("DELETE", "/api/conceptos/" + id).then(function () { showToast("Concepto eliminado.", "ok"); recargar(); })
        .catch(function (err) { showToast(err.message || "No se pudo eliminar.", "error"); });
    });
  }

  function openConceptoModal(id, categoria, cachedList) {
    var soloLectura = esSoloLectura();
    function build(c) {
      var isNew = !c;
      var dis = soloLectura ? " disabled" : "";
      var aplicaActual = c ? c.aplicaA : ["todas"];
      var esTodas = aplicaActual.indexOf("todas") !== -1;
      var checksHtml = '<label class="tipo-check"><input type="checkbox" id="cpTodas"' + (esTodas ? " checked" : "") + dis + '> Todas las modalidades</label>' +
        '<div id="cpTiposBox" style="display:' + (esTodas ? "none" : "flex") + ';flex-direction:column;gap:4px;margin-top:4px;">' +
        tipos.map(function (t) {
          return '<label class="tipo-check"><input type="checkbox" class="cpTipoChk" value="' + escapeHtml(t.clave) + '"' + (aplicaActual.indexOf(t.clave) !== -1 ? " checked" : "") + dis + '> ' + escapeHtml(t.nombre) + '</label>';
        }).join("") + '</div>';
      openModal(
        '<h2>' + (isNew ? (categoria === "percepcion" ? "Registrar percepción" : "Registrar deducción") : (categoria === "percepcion" ? "Percepción" : "Deducción")) + '</h2>' +
        '<div class="field"><label for="cpClave">Clave</label><input id="cpClave" type="text" maxlength="20" value="' + (c ? escapeHtml(c.clave) : "") + '" placeholder="Ej. ' + (categoria === "percepcion" ? "P005" : "D005") + '"' + dis + '></div>' +
        '<div class="field"><label for="cpConcepto">Concepto</label><input id="cpConcepto" type="text" maxlength="120" value="' + (c ? escapeHtml(c.concepto) : "") + '" placeholder="Ej. ' + (categoria === "percepcion" ? "Bono de puntualidad" : "Préstamo") + '"' + dis + '></div>' +
        '<div class="field"><label for="cpTipo">Tipo</label><input id="cpTipo" type="text" maxlength="40" value="' + (c ? escapeHtml(c.tipo) : "") + '" placeholder="' + (categoria === "percepcion" ? "Fijo o variable" : "Legal u operativa") + '"' + dis + '></div>' +
        '<div class="field"><label>Aplica a</label>' + checksHtml + '</div>' +
        (soloLectura ? "" : '<label class="tipo-check"><input type="checkbox" id="cpActivo"' + (!c || c.activo ? " checked" : "") + '> Activo</label>') +
        '<div class="field-error" id="cpError"></div>' +
        '<div class="modal-actions">' +
        (soloLectura ? '<button class="btn btn-primary" type="button" id="btnCancelCp">Cerrar</button>'
          : '<button class="btn btn-ghost" type="button" id="btnCancelCp">Cancelar</button><button class="btn btn-primary" type="button" id="btnSaveCp">' + (isNew ? "Registrar" : "Guardar cambios") + '</button>')
        + '</div>'
      );
      document.getElementById("btnCancelCp").addEventListener("click", closeModal);
      if (soloLectura) return;
      document.getElementById("cpTodas").addEventListener("change", function () {
        document.getElementById("cpTiposBox").style.display = this.checked ? "none" : "flex";
      });
      document.getElementById("btnSaveCp").addEventListener("click", function () {
        var errEl = document.getElementById("cpError");
        var todas = document.getElementById("cpTodas").checked;
        var aplicaA = todas ? ["todas"] : Array.prototype.filter.call(document.querySelectorAll(".cpTipoChk"), function (i) { return i.checked; }).map(function (i) { return i.value; });
        var payload = {
          clave: document.getElementById("cpClave").value.trim(),
          concepto: document.getElementById("cpConcepto").value.trim(),
          categoria: categoria,
          tipo: document.getElementById("cpTipo").value.trim(),
          aplicaA: aplicaA,
          activo: document.getElementById("cpActivo").checked,
        };
        var req = isNew ? api("POST", "/api/conceptos", payload) : api("PUT", "/api/conceptos/" + c.id, payload);
        req.then(function () {
          closeModal();
          showToast(isNew ? "Concepto registrado." : "Cambios guardados.", "ok");
          renderConceptos(categoria);
        }).catch(function (err) { errEl.textContent = err.message || "No se pudo guardar."; });
      });
    }
    if (!id) { build(null); return; }
    var cached = cachedList && cachedList.find(function (x) { return x.id === id; });
    if (cached) { build(cached); return; }
    api("GET", "/api/conceptos?categoria=" + categoria).then(function (list) { build(list.find(function (x) { return x.id === id; })); });
  }
  SECTION_RENDERERS.percepciones = function () { renderConceptos("percepcion"); };
  SECTION_RENDERERS.deducciones = function () { renderConceptos("deduccion"); };

  /* ======================================================================
     PAGOS Y RECIBOS (antes "Nómina")
     ====================================================================== */
  function renderPagos() {
    el.sectionToolbar.innerHTML =
      '<div class="period-nav">' +
      '<button class="nav-btn" id="pgPrev" type="button" aria-label="Quincena anterior"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6"/></svg></button>' +
      '<div><div class="period-label" id="pgPeriodLabel">Cargando…</div><div class="period-sub" id="pgPeriodSub">&nbsp;</div></div>' +
      '<button class="nav-btn" id="pgNext" type="button" aria-label="Quincena siguiente"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg></button>' +
      '</div>' +
      '<button class="status-pill open" id="pgStatusPill" type="button"><span class="dot"></span><span id="pgStatusText">Abierta</span></button>' +
      (esSoloLectura() ? "" :
        '<button class="btn btn-ghost" type="button" id="btnProcesarPago">Procesar pago</button>' +
        '<button class="btn btn-ghost" type="button" id="btnGenerarRecibos">Generar recibos</button>') +
      '<button class="btn btn-primary" type="button" id="btnExportResumen">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12m0 0l-4-4m4 4l4-4M4 17v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/></svg>Exportar PDF</button>';

    document.getElementById("pgPrev").addEventListener("click", function () { var q = quincenaFor(periodAnchor); var d = new Date(q.inicio); d.setDate(d.getDate() - 1); periodAnchor = d; loadPeriod(); });
    document.getElementById("pgNext").addEventListener("click", function () { var q = quincenaFor(periodAnchor); var d = new Date(q.fin); d.setDate(d.getDate() + 1); periodAnchor = d; loadPeriod(); });
    document.getElementById("btnExportResumen").addEventListener("click", function () {
      var q = quincenaFor(periodAnchor);
      logReporte("nomina", "Resumen PDF de la quincena " + periodIdFor(q), "pdf");
      window.location.href = "/api/export/periodo/" + periodIdFor(q) + "/resumen.pdf";
    });
    document.getElementById("pgStatusPill").addEventListener("click", function () {
      if (esSoloLectura()) { showToast("Tu cuenta es de solo lectura -- no puedes hacer cambios.", "error"); return; }
      var q = quincenaFor(periodAnchor); var pid = periodIdFor(q); var next = !currentClosed;
      updatePgStatusPill(next);
      api("PUT", "/api/periods/" + pid + "/cerrada", { cerrada: next }).then(function () { pintarPagosTabla(); })
        .catch(function () { showToast("No se pudo actualizar el estado de la quincena.", "error"); updatePgStatusPill(!next); });
    });
    var btnProcesar = document.getElementById("btnProcesarPago");
    if (btnProcesar) btnProcesar.addEventListener("click", function () {
      var q = quincenaFor(periodAnchor); var pid = periodIdFor(q);
      api("POST", "/api/periods/" + pid + "/procesar-pago").then(function (r) {
        showToast(r.actualizados > 0 ? "Pago procesado para " + r.actualizados + " trabajador(es)." : "No había trabajadores pendientes de pago en esta quincena.", "ok");
        loadPeriod();
      }).catch(function () { showToast("No se pudo procesar el pago.", "error"); });
    });
    var btnRecibos = document.getElementById("btnGenerarRecibos");
    if (btnRecibos) btnRecibos.addEventListener("click", function () {
      var q = quincenaFor(periodAnchor);
      logReporte("nomina", "Recibos (Excel detallado) de la quincena " + periodIdFor(q), "excel");
      window.location.href = "/api/export/periodo/" + periodIdFor(q) + ".xlsx";
    });

    el.viewBody.innerHTML = '<div class="loading-state">Cargando…</div>';
    loadWorkers().then(loadTipos).then(loadPeriod);
  }

  function updatePgStatusPill(closed) {
    currentClosed = closed;
    var pill = document.getElementById("pgStatusPill");
    if (!pill) return;
    pill.className = "status-pill " + (closed ? "closed" : "open");
    document.getElementById("pgStatusText").textContent = closed ? "Pagada" : "Abierta";
  }

  function displayWorkersFor(entries) {
    var active = workers.filter(function (w) { return w.activo && esPagado(w); });
    var ids = {}; active.forEach(function (w) { ids[w.id] = true; });
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

  function pintarPagos() {
    var q = quincenaFor(periodAnchor);
    var lbl = document.getElementById("pgPeriodLabel");
    if (lbl) { lbl.textContent = fmtRange(q); document.getElementById("pgPeriodSub").textContent = "Quincena " + q.half; }
    updatePgStatusPill(!!(currentPeriodData && currentPeriodData.cerrada));
    el.viewBody.innerHTML =
      '<div class="stats">' +
      '<div class="stat-tile"><div class="label">Trabajadores</div><div class="value" id="pgStatTrab">–</div></div>' +
      '<div class="stat-tile"><div class="label">Horas registradas</div><div class="value" id="pgStatHoras">–</div></div>' +
      '<div class="stat-tile accent"><div class="label">Total a pagar</div><div class="value" id="pgStatTotal">–</div></div>' +
      '</div><div id="pagosTableHolder"></div>';
    pintarPagosTabla();
  }

  function pagoActionsHtml(workerId) {
    var html = '<button class="icon-btn" type="button" data-pdf-worker="' + workerId + '" title="Descargar PDF">' + ICON_PDF + '</button>';
    if (esSoloLectura()) return html;
    return html + '<button class="icon-btn" type="button" data-editar-worker="' + workerId + '" title="Editar">' + ICON_EDIT + '</button>' + confirmDeleteHtml("pagoWorker", workerId, "Eliminar");
  }

  function pintarPagosTabla() {
    var holder = document.getElementById("pagosTableHolder");
    if (!holder) return;
    var list = displayWorkersFor(currentPeriodData && currentPeriodData.entries);
    if (list.length === 0) {
      holder.innerHTML = '<div class="empty-state">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>' +
        '<h2>Aún no hay trabajadores de nómina</h2><p>' + (esSoloLectura() ? "Todavía no hay trabajadores registrados." : "Agrega a tu primer trabajador de modalidad pagada desde Personal.") + '</p></div>';
      return;
    }
    var entries = (currentPeriodData && currentPeriodData.entries) || {};
    var closed = !!(currentPeriodData && currentPeriodData.cerrada);
    var inputsDisabled = closed || esSoloLectura();
    var rows = list.map(function (w) {
      var e = entries[w.id] || {};
      var hn = e.horasNormales || 0;
      var hm = decToHM(hn);
      var pagado = !!e.pagado;
      return '<tr data-worker="' + w.id + '" data-tn="' + w.tarifaNormal + '" class="' + (w.activo ? "" : "inactive") + '">' +
        '<td class="cell-name"><div class="name">' + escapeHtml(w.nombre) + (w.activo ? "" : ' <span style="font-weight:400;color:var(--ink-soft);">(baja)</span>') + '</div>' +
        (w.puesto ? '<div class="puesto">' + escapeHtml(w.puesto) + '</div>' : '') + '</td>' +
        '<td class="cell-num cell-hours">' +
        '<input class="hours-input hours-h" type="number" min="0" step="1" data-field="horasH" value="' + hm.h + '" ' + (inputsDisabled ? "disabled" : "") + '><span class="hm-sep">h</span>' +
        '<input class="hours-input hours-m" type="number" min="0" max="59" step="1" data-field="horasM" value="' + hm.m + '" ' + (inputsDisabled ? "disabled" : "") + '><span class="hm-sep">min</span></td>' +
        '<td class="cell-num rate">' + fmtMoney(w.tarifaNormal) + '</td>' +
        '<td class="cell-num total"><span class="row-total">' + fmtMoney(hn * w.tarifaNormal) + '</span></td>' +
        '<td>' + (esSoloLectura()
          ? '<span class="pill pill-pagado-' + (pagado ? "si" : "no") + '">' + (pagado ? "Pagado" : "Pendiente") + '</span>'
          : '<button type="button" class="pill pill-btn pill-pagado-' + (pagado ? "si" : "no") + '" data-toggle-pagado="' + w.id + '">' + (pagado ? "Pagado" : "Pendiente") + '</button>') + '</td>' +
        '<td class="cell-actions">' + pagoActionsHtml(w.id) + '</td>' +
        '</tr>';
    }).join("");
    holder.innerHTML = '<div class="table-scroll"><table id="payTable">' +
      '<thead><tr><th>Trabajador</th><th class="cell-num">Horas y minutos</th><th class="cell-num">Tarifa/h</th><th class="cell-num">Total</th><th>Estatus</th><th></th></tr></thead>' +
      '<tbody>' + rows + '</tbody>' +
      '<tfoot><tr><td colspan="3" class="foot-label">Total de la quincena</td><td class="cell-num" id="footTotal">$0.00</td><td colspan="2"></td></tr></tfoot>' +
      '</table></div>';
    recomputeAllPagos();

    holder.querySelectorAll("[data-pdf-worker]").forEach(function (b) { b.addEventListener("click", function () { downloadWorkerPdf(Number(b.getAttribute("data-pdf-worker"))); }); });
    holder.querySelectorAll("[data-editar-worker]").forEach(function (b) { b.addEventListener("click", function () { openWorkerModal(Number(b.getAttribute("data-editar-worker"))); }); });
    holder.querySelectorAll("[data-toggle-pagado]").forEach(function (b) {
      b.addEventListener("click", function () {
        var wid = b.getAttribute("data-toggle-pagado");
        var q = quincenaFor(periodAnchor); var pid = periodIdFor(q);
        var nuevo = b.textContent.trim() !== "Pagado";
        api("PUT", "/api/periods/" + pid + "/entries/" + wid + "/pagado", { pagado: nuevo }).then(function () { loadPeriod(); })
          .catch(function () { showToast("No se pudo actualizar el estatus de pago.", "error"); });
      });
    });
    wireConfirmDelete(holder, "[data-del='pagoWorker']", function (id) {
      api("DELETE", "/api/workers/" + id).then(function () { showToast("Trabajador dado de baja.", "ok"); loadWorkers().then(loadPeriod); })
        .catch(function () { showToast("No se pudo eliminar al trabajador.", "error"); });
    });

    holder.addEventListener("input", function (e) {
      var input = e.target.closest(".hours-input");
      if (!input) return;
      var v = parseFloat(input.value);
      if (v < 0) input.value = 0;
      if (input.classList.contains("hours-m") && v > 59) input.value = 59;
      var row = input.closest("tr");
      updateRowTotal(row);
      recomputeAllPagos();
      scheduleSave(row.dataset.worker);
    });
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
  function recomputeAllPagos() {
    var rows = document.querySelectorAll("#payTable tbody tr");
    var totalHoras = 0, totalPago = 0;
    rows.forEach(function (row) { var r = updateRowTotal(row); totalHoras += r.hn; totalPago += r.total; });
    var footTotal = document.getElementById("footTotal");
    if (footTotal) footTotal.textContent = fmtMoney(totalPago);
    setText("pgStatTrab", rows.length);
    setText("pgStatHoras", fmtHours(totalHoras));
    setText("pgStatTotal", fmtMoney(totalPago));
  }
  function scheduleSave(workerId) {
    var q = quincenaFor(periodAnchor); var pid = periodIdFor(q);
    clearTimeout(saveTimers[workerId]);
    el.saveStatus.textContent = "Guardando…";
    el.saveStatus.classList.remove("err");
    saveTimers[workerId] = setTimeout(function () {
      var row = document.querySelector('tr[data-worker="' + CSS.escape(String(workerId)) + '"]');
      if (!row) return;
      var h = parseFloat(row.querySelector('[data-field="horasH"]').value) || 0;
      var m = parseFloat(row.querySelector('[data-field="horasM"]').value) || 0;
      var hn = hmToDec(h, m);
      api("PUT", "/api/periods/" + pid + "/entries/" + workerId, { horasNormales: hn }).then(function () {
        el.saveStatus.textContent = "Guardado";
        setTimeout(function () { if (el.saveStatus.textContent === "Guardado") el.saveStatus.textContent = ""; }, 1800);
      }).catch(function () {
        el.saveStatus.textContent = "Error al guardar";
        el.saveStatus.classList.add("err");
        showToast("No se pudieron guardar las horas. Verifica tu conexión e inténtalo de nuevo.", "error");
      });
    }, 500);
  }
  function downloadWorkerPdf(workerId) {
    var q = quincenaFor(periodAnchor);
    window.location.href = "/api/export/periodo/" + periodIdFor(q) + "/trabajador/" + workerId + ".pdf";
  }
  SECTION_RENDERERS.pagos = renderPagos;

  /* ======================================================================
     REPORTES
     ====================================================================== */
  function logReporte(tipo, descripcion, formato) {
    api("POST", "/api/reportes/log", { tipo: tipo, descripcion: descripcion, formato: formato }).catch(function () {});
  }

  function renderReportes() {
    el.sectionToolbar.innerHTML = "";
    var q = quincenaFor(periodAnchor);
    var defaultDesde = ymd(q.inicio), defaultHasta = ymd(q.fin);
    el.viewBody.innerHTML =
      '<div class="dash-section-title">Generar reporte</div>' +
      '<div class="field"><label for="rpTipo">Tipo de reporte</label><select id="rpTipo">' +
      '<option value="nomina">Nómina</option><option value="asistencias">Asistencias</option>' +
      '<option value="incidencias">Incidencias</option><option value="personal">Personal</option>' +
      '</select></div>' +
      '<div id="rpCampos"></div>' +
      '<div class="modal-actions" style="justify-content:flex-start;margin-top:0;"><button class="btn btn-primary" type="button" id="btnGenerarReporte">Generar</button></div>' +
      '<div class="dash-section-title">Reportes recientes</div>' +
      '<div id="rpRecientes"><div class="loading-state">Cargando…</div></div>';

    function pintarCampos() {
      var tipo = document.getElementById("rpTipo").value;
      var campos = document.getElementById("rpCampos");
      if (tipo === "nomina") {
        campos.innerHTML =
          '<div class="field"><label for="rpPeriodo">Quincena (usa la que estás viendo en Pagos y recibos)</label>' +
          '<input id="rpPeriodo" type="text" value="' + periodIdFor(q) + ' (' + fmtRange(q) + ')" disabled></div>' +
          '<div class="field"><label for="rpFormato">Formato</label><select id="rpFormato"><option value="pdf">PDF (resumen)</option><option value="excel">Excel (detallado, con hoja por trabajador)</option></select></div>';
      } else if (tipo === "personal") {
        campos.innerHTML = '<p class="field-hint">Incluye a todo el personal activo, de todas las modalidades.</p>';
      } else {
        campos.innerHTML =
          '<div class="field-row">' +
          '<div class="field"><label for="rpDesde">Desde</label><input id="rpDesde" type="date" value="' + defaultDesde + '"></div>' +
          '<div class="field"><label for="rpHasta">Hasta</label><input id="rpHasta" type="date" value="' + defaultHasta + '"></div>' +
          '</div><p class="field-hint">Formato: Excel (CSV).</p>';
      }
    }
    document.getElementById("rpTipo").addEventListener("change", pintarCampos);
    pintarCampos();

    document.getElementById("btnGenerarReporte").addEventListener("click", function () {
      var tipo = document.getElementById("rpTipo").value;
      if (tipo === "nomina") {
        var formato = document.getElementById("rpFormato").value;
        var pid = periodIdFor(q);
        if (formato === "pdf") {
          logReporte("nomina", "Resumen PDF de la quincena " + pid, "pdf");
          window.location.href = "/api/export/periodo/" + pid + "/resumen.pdf";
        } else {
          logReporte("nomina", "Excel detallado de la quincena " + pid, "excel");
          window.location.href = "/api/export/periodo/" + pid + ".xlsx";
        }
      } else if (tipo === "personal") {
        logReporte("personal", "Directorio de personal activo", "excel");
        window.location.href = "/api/export/personal.csv";
      } else if (tipo === "asistencias") {
        var d1 = document.getElementById("rpDesde").value, h1 = document.getElementById("rpHasta").value;
        logReporte("asistencias", "Asistencias del " + fmtFecha(d1) + " al " + fmtFecha(h1), "excel");
        window.location.href = "/api/export/asistencias.csv?start=" + d1 + "&end=" + h1;
      } else {
        var d2 = document.getElementById("rpDesde").value, h2 = document.getElementById("rpHasta").value;
        logReporte("incidencias", "Incidencias del " + fmtFecha(d2) + " al " + fmtFecha(h2), "excel");
        window.location.href = "/api/export/incidencias.csv?desde=" + d2 + "&hasta=" + h2;
      }
      setTimeout(cargarRecientes, 800);
    });

    function cargarRecientes() {
      api("GET", "/api/reportes/recientes").then(function (list) {
        var holder = document.getElementById("rpRecientes");
        if (!holder) return;
        if (!list.length) { holder.innerHTML = '<p class="field-hint">Todavía no has generado ningún reporte.</p>'; return; }
        holder.innerHTML = '<div class="table-scroll"><table><thead><tr><th>Tipo</th><th>Descripción</th><th>Formato</th><th>Generado por</th><th>Fecha</th></tr></thead><tbody>' +
          list.map(function (r) {
            return '<tr><td>' + escapeHtml(r.tipo) + '</td><td>' + escapeHtml(r.descripcion) + '</td><td>' + escapeHtml(r.formato.toUpperCase()) + '</td>' +
              '<td>' + escapeHtml(r.creadoPor || "—") + '</td><td>' + new Date(r.creadoEn).toLocaleString("es-MX", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) + '</td></tr>';
          }).join("") + '</tbody></table></div>';
      }).catch(function () {});
    }
    cargarRecientes();
  }
  SECTION_RENDERERS.reportes = renderReportes;

  /* ============ Mi cuenta / administradores ============ */
  function openAccountModal() {
    var soloLectura = esSoloLectura();
    openModal(
      '<h2>Mi cuenta' + (soloLectura ? "" : " y administradores") + '</h2>' +
      '<h3 class="modal-subhead">Cambiar mi contraseña</h3>' +
      '<div class="field"><label for="pwActual">Contraseña actual</label><input id="pwActual" type="password" autocomplete="current-password"></div>' +
      '<div class="field"><label for="pwNueva">Contraseña nueva</label><input id="pwNueva" type="password" autocomplete="new-password"></div>' +
      '<div class="field"><label for="pwConfirmar">Confirmar contraseña nueva</label><input id="pwConfirmar" type="password" autocomplete="new-password"></div>' +
      '<p class="field-hint">Mínimo 8 caracteres, con letras y números.</p>' +
      '<div class="field-error" id="pwError"></div>' +
      '<div class="modal-actions"><button class="btn btn-primary" type="button" id="btnSavePassword">Guardar contraseña</button></div>' +
      (soloLectura
        ? '<hr class="modal-sep"><p class="field-hint">Gestionar administradores es solo para cuentas con permisos completos.</p>'
        : '<hr class="modal-sep">' +
          '<h3 class="modal-subhead">Administradores</h3>' +
          '<p class="field-hint">"Completo" puede editar todo. "Solo lectura" solo puede ver y descargar (trabajadores, asistencias, incidencias, reportes). Al agregar uno nuevo, es él o ella quien elige su propia contraseña al activar su cuenta -- tú nunca la escribes.</p>' +
          '<div id="adminList" class="admin-list"><div class="field-hint">Cargando…</div></div>' +
          '<div class="field"><label for="aUsuario">Usuario</label><input id="aUsuario" type="text" autocomplete="off"></div>' +
          '<div class="field"><label for="aEmail">Correo (para mandarle el enlace de activación)</label><input id="aEmail" type="email" autocomplete="off"></div>' +
          '<div class="field"><label for="aRol">Tipo de acceso</label><select id="aRol"><option value="admin" selected>Completo</option><option value="lectura">Solo lectura</option></select></div>' +
          '<div class="field-error" id="aError"></div>' +
          '<div class="modal-actions"><button class="btn btn-ghost" type="button" id="btnAddAdmin">Agregar administrador</button></div>') +
      '<div class="modal-actions"><button class="btn btn-ghost" type="button" id="btnCloseAccount">Cerrar</button></div>'
    );

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
        document.getElementById("pwActual").value = ""; document.getElementById("pwNueva").value = ""; document.getElementById("pwConfirmar").value = "";
      }).catch(function (err) { errEl.textContent = err.message || "No se pudo cambiar la contraseña."; });
    });
    if (soloLectura) return;

    var confirmDeleteId = null;
    function renderAdminList(admins) {
      var listEl = document.getElementById("adminList");
      if (!listEl) return;
      if (!admins.length) { listEl.innerHTML = '<div class="field-hint">No hay administradores.</div>'; return; }
      listEl.innerHTML = admins.map(function (a) {
        var confirming = confirmDeleteId === a.id;
        var pendiente = a.estatus === "pendiente";
        return '<div class="admin-row"><span>' + escapeHtml(a.usuario) +
          (pendiente
            ? ' <span class="pill pill-pendiente" title="Todavía no activa su cuenta">Pendiente</span>'
            : ' <span class="pill pill-aprobada">Activa</span>') +
          (a.email ? '<div class="admin-row-email">' + escapeHtml(a.email) + '</div>' : '') +
          '</span><span class="admin-row-controls">' +
          '<select class="admin-rol-select" data-admin-rol="' + a.id + '">' +
          '<option value="admin"' + (a.rol !== "lectura" ? " selected" : "") + '>Completo</option>' +
          '<option value="lectura"' + (a.rol === "lectura" ? " selected" : "") + '>Solo lectura</option></select>' +
          (pendiente ? '<button class="ch-link-btn" type="button" data-resend-admin="' + a.id + '">Reenviar enlace</button>&nbsp; ' : "") +
          (confirming
            ? '<button class="ch-link-btn" type="button" data-cancel-admin="' + a.id + '">Cancelar</button>&nbsp; <button class="ch-link-btn" type="button" data-confirm-admin="' + a.id + '">¿Eliminar?</button>'
            : '<button class="ch-link-btn" type="button" data-del-admin="' + a.id + '">Eliminar</button>') + '</span></div>';
      }).join("");
    }
    function loadAdmins() {
      return api("GET", "/api/admins").then(renderAdminList).catch(function () {
        var listEl = document.getElementById("adminList");
        if (listEl) listEl.innerHTML = '<div class="field-hint">No se pudo cargar la lista.</div>';
      });
    }
    document.getElementById("adminList").addEventListener("click", function (e) {
      var del = e.target.closest("[data-del-admin]");
      var cancel = e.target.closest("[data-cancel-admin]");
      var confirmBtn = e.target.closest("[data-confirm-admin]");
      var resendBtn = e.target.closest("[data-resend-admin]");
      if (del) { confirmDeleteId = Number(del.getAttribute("data-del-admin")); loadAdmins(); }
      else if (cancel) { confirmDeleteId = null; loadAdmins(); }
      else if (confirmBtn) {
        var id = Number(confirmBtn.getAttribute("data-confirm-admin"));
        confirmDeleteId = null;
        api("DELETE", "/api/admins/" + id).then(function () { showToast("Administrador eliminado.", "ok"); loadAdmins(); })
          .catch(function (err) { showToast(err.message || "No se pudo eliminar.", "error"); loadAdmins(); });
      } else if (resendBtn) {
        resendBtn.disabled = true;
        api("POST", "/api/admins/" + resendBtn.getAttribute("data-resend-admin") + "/resend-activacion").then(function (data) {
          showToast("Nuevo enlace generado.", "ok");
          window.prompt("Copia este enlace y mándaselo a la persona (por WhatsApp, SMS, etc.):", data.enlaceActivacion);
        }).catch(function (err) { showToast(err.message || "No se pudo generar el enlace.", "error"); })
          .then(function () { loadAdmins(); });
      }
    });
    document.getElementById("adminList").addEventListener("change", function (e) {
      var sel = e.target.closest("[data-admin-rol]");
      if (!sel) return;
      api("PUT", "/api/admins/" + sel.getAttribute("data-admin-rol") + "/rol", { rol: sel.value }).then(function () {
        showToast("Tipo de acceso actualizado.", "ok"); loadAdmins();
      }).catch(function (err) { showToast(err.message || "No se pudo cambiar el tipo de acceso.", "error"); loadAdmins(); });
    });
    document.getElementById("btnAddAdmin").addEventListener("click", function () {
      var errEl = document.getElementById("aError");
      var usuario = document.getElementById("aUsuario").value.trim();
      var email = document.getElementById("aEmail").value.trim();
      var rol = document.getElementById("aRol").value;
      errEl.textContent = "";
      if (!usuario) { errEl.textContent = "Escribe un nombre de usuario."; return; }
      if (!email) { errEl.textContent = "Escribe el correo del nuevo administrador."; return; }
      api("POST", "/api/admins", { usuario: usuario, email: email, rol: rol }).then(function (nuevo) {
        showToast("Administrador agregado. Todavía necesita activar su cuenta.", "ok");
        document.getElementById("aUsuario").value = ""; document.getElementById("aEmail").value = ""; document.getElementById("aRol").value = "admin";
        window.prompt("Copia este enlace y mándaselo a " + usuario + " (por WhatsApp, SMS, etc.) para que active su cuenta y elija su contraseña:", nuevo.enlaceActivacion);
        loadAdmins();
      }).catch(function (err) { errEl.textContent = err.message || "No se pudo agregar."; });
    });
    loadAdmins();
  }
  el.btnAccount.addEventListener("click", openAccountModal);

  /* ============ Init ============ */
  // Primero averiguamos el rol real de la sesion (admin completo o solo
  // lectura) y SOLO DESPUES dibujamos nada -- si renderizaramos antes de
  // conocer el rol, una cuenta de solo lectura veria por un instante los
  // botones de editar/agregar/borrar que no deberia tener.
  api("GET", "/api/session").then(function (data) {
    miRol = data.rol || "admin";
    el.sideUser.textContent = data.usuario ? "Sesión: " + data.usuario : "";
  }).catch(function () {}).then(function () {
    goToSection("inicio");
  });
})();
