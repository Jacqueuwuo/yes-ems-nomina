(function () {
  "use strict";

  var root = document.getElementById("checadorApp");

  var step = "id"; // id | pin | loading | confirm | success
  var idValue = "";
  var pin = "";
  var error = "";
  var worker = null;
  var turnoAbierto = null;
  var pendingAction = null; // entrada | salida
  var resultText = "";
  var resetTimer = null;

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function fmtTime(d) {
    return d.toLocaleTimeString("es-MX", { hour: "numeric", minute: "2-digit" });
  }
  // Muestra "1 h 50 min" en vez de "1.83 h" en el mensaje de salida.
  function fmtHours(n) {
    n = Math.max(0, Number(n) || 0);
    var h = Math.floor(n);
    var m = Math.round((n - h) * 60);
    if (m === 60) { m = 0; h += 1; }
    if (h === 0 && m === 0) return "0 min";
    if (h === 0) return m + " min";
    if (m === 0) return h + " h";
    return h + " h " + m + " min";
  }
  function initials(name) {
    var parts = String(name || "").trim().split(/\s+/);
    var a = parts[0] ? parts[0][0] : "";
    var b = parts[1] ? parts[1][0] : "";
    return (a + b).toUpperCase();
  }

  function shell(inner) {
    return (
      '<div class="ch-card"><div class="ch-brand"><img src="/assets/logo.png" alt="YES EMS"><span>YES EMS</span></div>' +
      inner +
      "</div>"
    );
  }
  function pinDots() {
    var s = "";
    for (var i = 0; i < 4; i++) s += '<span class="pin-dot' + (i < pin.length ? " filled" : "") + '"></span>';
    return s;
  }
  function keypadHtml() {
    var keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "back"];
    return (
      '<div class="keypad">' +
      keys
        .map(function (k) {
          if (k === "") return "<span></span>";
          if (k === "back") return '<button type="button" class="key key-back" data-key="back" aria-label="Borrar">⌫</button>';
          return '<button type="button" class="key" data-key="' + k + '">' + k + "</button>";
        })
        .join("") +
      "</div>"
    );
  }

  function render() {
    if (step === "loading") {
      root.innerHTML = shell('<div class="ch-msg"><p class="ch-sub">Buscando…</p></div>');
      return;
    }
    if (step === "id") {
      root.innerHTML = shell(
        '<div class="ch-pin">' +
          "<h1>Marca tu entrada o salida</h1>" +
          '<p class="ch-sub">Escribe tu número de empleado</p>' +
          '<div class="id-display">' + (idValue ? escapeHtml(idValue) : '<span class="id-placeholder">Número de empleado</span>') + "</div>" +
          '<p class="ch-error">' + (error ? escapeHtml(error) : "&nbsp;") + "</p>" +
          keypadHtml() +
          '<button type="button" class="ch-btn ch-btn-in" id="chIdContinueBtn"' + (idValue.length === 0 ? " disabled" : "") + ">Continuar</button>" +
          "</div>"
      );
      document.getElementById("chIdContinueBtn").addEventListener("click", goToPinStep);
      return;
    }
    if (step === "pin") {
      root.innerHTML = shell(
        '<div class="ch-pin">' +
          "<h1>Ingresa tu PIN</h1>" +
          '<p class="ch-sub">Tu PIN de 4 dígitos</p>' +
          '<div class="pin-dots">' + pinDots() + "</div>" +
          '<p class="ch-error">' + (error ? escapeHtml(error) : "&nbsp;") + "</p>" +
          keypadHtml() +
          '<button type="button" class="ch-link" id="chBackToIdBtn">‹ Cambiar número de empleado</button>' +
          "</div>"
      );
      document.getElementById("chBackToIdBtn").addEventListener("click", function () {
        pin = "";
        error = "";
        step = "id";
        render();
      });
      return;
    }
    if (step === "confirm") {
      var isEntrada = pendingAction === "entrada";
      var extra = "";
      if (!isEntrada && turnoAbierto) {
        extra = '<p class="ch-detail">Entraste a las ' + fmtTime(new Date(turnoAbierto.entrada)) + "</p>";
      }
      root.innerHTML = shell(
        '<div class="ch-msg">' +
          '<div class="ch-avatar">' + escapeHtml(initials(worker.nombre)) + "</div>" +
          "<h1>Hola, " + escapeHtml(worker.nombre.split(" ")[0]) + "</h1>" +
          '<p class="ch-sub">' + (isEntrada ? "Vas a marcar tu ENTRADA" : "Vas a marcar tu SALIDA") + "</p>" +
          extra +
          '<div class="ch-now">' + fmtTime(new Date()) + "</div>" +
          '<button type="button" class="ch-btn ' + (isEntrada ? "ch-btn-in" : "ch-btn-out") + '" id="chConfirmBtn">' +
          (isEntrada ? "Marcar entrada" : "Marcar salida") +
          "</button>" +
          '<button type="button" class="ch-link" id="chCancelBtn">Cancelar</button>' +
          "</div>"
      );
      document.getElementById("chConfirmBtn").addEventListener("click", confirmAction);
      document.getElementById("chCancelBtn").addEventListener("click", reset);
      return;
    }
    if (step === "success") {
      root.innerHTML = shell(
        '<div class="ch-msg">' +
          '<div class="ch-check">✓</div>' +
          "<h1>" + escapeHtml(resultText) + "</h1>" +
          '<p class="ch-sub">' + fmtTime(new Date()) + "</p>" +
          '<button type="button" class="ch-link" id="chDoneBtn">Listo</button>' +
          "</div>"
      );
      document.getElementById("chDoneBtn").addEventListener("click", reset);
      return;
    }
  }

  // Un solo lugar que mete un digito (o borra uno) para el paso actual,
  // sin importar si vino de tocar el teclado numerico en pantalla o de
  // escribir con un teclado fisico -- los dos deben funcionar igual.
  function handleKeyInput(k) {
    if (step === "id") {
      if (k === "back") {
        idValue = idValue.slice(0, -1);
      } else if (idValue.length < 8) {
        idValue += k;
      }
      error = "";
      render();
      return;
    }
    if (step !== "pin") return;
    if (k === "back") {
      pin = pin.slice(0, -1);
      error = "";
      render();
      return;
    }
    if (pin.length >= 4) return;
    pin += k;
    error = "";
    render();
    if (pin.length === 4) lookup();
  }

  root.addEventListener("click", function (e) {
    var key = e.target.closest("[data-key]");
    if (!key || (step !== "id" && step !== "pin")) return;
    handleKeyInput(key.dataset.key);
  });

  // Ademas de tocar el teclado numerico en pantalla, tambien se puede
  // escribir con un teclado fisico (por ejemplo si el celular o la
  // tablet del checador tiene uno conectado, o se abre desde una
  // computadora): los digitos 0-9 y Backspace hacen exactamente lo mismo
  // que tocar esos mismos botones, y Enter avanza al PIN una vez que ya
  // se escribio el numero de empleado.
  document.addEventListener("keydown", function (e) {
    if (step !== "id" && step !== "pin") return;
    if (e.key >= "0" && e.key <= "9") {
      handleKeyInput(e.key);
      e.preventDefault();
    } else if (e.key === "Backspace") {
      handleKeyInput("back");
      e.preventDefault();
    } else if (e.key === "Enter" && step === "id") {
      goToPinStep();
      e.preventDefault();
    }
  });

  function goToPinStep() {
    if (idValue.length === 0) return;
    pin = "";
    error = "";
    step = "pin";
    render();
  }

  function api(path, body) {
    return fetch("/api/checador/" + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    }).then(function (r) {
      return r.json().then(function (data) {
        if (!r.ok) throw data && data.error ? new Error(data.error) : new Error("Error de red");
        return data;
      });
    });
  }

  function lookup() {
    step = "loading";
    render();
    api("estado", { idEmpleado: idValue, pin: pin })
      .then(function (data) {
        worker = data.worker;
        turnoAbierto = data.turnoAbierto;
        pendingAction = turnoAbierto ? "salida" : "entrada";
        step = "confirm";
        render();
      })
      .catch(function (err) {
        pin = "";
        error = err.message || "No se pudo consultar tu estado. Intenta de nuevo.";
        step = "pin";
        render();
      });
  }

  function confirmAction() {
    var btn = document.getElementById("chConfirmBtn");
    if (btn) btn.disabled = true;
    var body = { idEmpleado: idValue, pin: pin };
    if (pendingAction === "entrada") {
      api("entrada", body)
        .then(function () {
          resultText = "Entrada registrada";
          step = "success";
          render();
          scheduleReset();
        })
        .catch(fail);
    } else {
      api("salida", body)
        .then(function (data) {
          resultText = "Salida registrada (" + fmtHours(data.horas) + ")";
          step = "success";
          render();
          scheduleReset();
        })
        .catch(fail);
    }
  }
  function fail(err) {
    error = err.message || "No se pudo guardar. Intenta de nuevo.";
    pin = "";
    step = "pin";
    render();
  }
  function reset() {
    clearTimeout(resetTimer);
    idValue = "";
    pin = "";
    error = "";
    worker = null;
    turnoAbierto = null;
    pendingAction = null;
    step = "id";
    render();
  }
  function scheduleReset() {
    clearTimeout(resetTimer);
    resetTimer = setTimeout(reset, 4000);
  }

  render();
})();