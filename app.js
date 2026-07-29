/* ConectaNOS — Monitoramento de Ruído (F5, v0.1)
 * PWA estático sobre a API do ThingsBoard (CORS aberto verificado).
 * Telas: login, Início (cards de locais), Dashboard (limites NBR,
 * minutos dentro/fora, gráficos SVG), Perfil. Poll de 15 s. */
'use strict';

var TB = 'https://thingsboard.nosconectados.com.br';
var APP_VERSION = 'v0.1.0 — 2026-07-29';
var POLL_MS = 15000;

var S = {
  token: localStorage.getItem('cn_token') || null,
  user: null,
  devices: [],           // {id, name, label, attrs{}, latest{}}
  current: null,         // deviceId selecionado
  filtroEmp: '',
  filtroSit: '',
  timer: null
};

/* ---------------- API ---------------- */
function api(path, opts) {
  opts = opts || {};
  opts.headers = Object.assign({'Content-Type': 'application/json'},
    S.token ? {'X-Authorization': 'Bearer ' + S.token} : {}, opts.headers || {});
  return fetch(TB + path, opts).then(function (r) {
    if (r.status === 401) { logout(); throw new Error('sessao expirada'); }
    if (!r.ok) { return r.text().then(function (t) { throw new Error(t || r.status); }); }
    return r.status === 200 ? r.json() : null;
  });
}

function login(email, pass) {
  return fetch(TB + '/api/auth/login', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({username: email, password: pass})
  }).then(function (r) {
    if (!r.ok) { throw new Error('login'); }
    return r.json();
  }).then(function (j) {
    S.token = j.token;
    localStorage.setItem('cn_token', j.token);
  });
}

function logout() {
  S.token = null; S.user = null; S.devices = []; S.current = null;
  localStorage.removeItem('cn_token');
  stopPoll();
  location.hash = '#/login';
}

function loadUser() {
  return api('/api/auth/user').then(function (u) { S.user = u; return u; });
}

function loadDevices() {
  var p = (S.user.authority === 'CUSTOMER_USER')
    ? '/api/customer/' + S.user.customerId.id + '/deviceInfos?pageSize=100&page=0&type=DNMS'
    : '/api/tenant/deviceInfos?pageSize=100&page=0&type=DNMS';
  return api(p).then(function (page) {
    var list = page.data || [];
    return Promise.all(list.map(function (d) {
      var id = d.id.id;
      return Promise.all([
        api('/api/plugins/telemetry/DEVICE/' + id +
            '/values/timeseries?keys=laeq,lamin,lamax,fora_limite,limite_atual_db').catch(function () { return {}; }),
        api('/api/plugins/telemetry/DEVICE/' + id +
            '/values/attributes/SERVER_SCOPE').catch(function () { return []; })
      ]).then(function (rr) {
        var latest = {};
        Object.keys(rr[0] || {}).forEach(function (k) {
          latest[k] = rr[0][k] && rr[0][k].length ? Number(rr[0][k][0].value) : null;
          if (k === 'laeq' && rr[0][k] && rr[0][k].length) { latest.laeq_ts = rr[0][k][0].ts; }
        });
        var attrs = {};
        (rr[1] || []).forEach(function (a) { attrs[a.key] = a.value; });
        return {id: id, name: d.name, label: d.label || d.name, attrs: attrs, latest: latest};
      });
    }));
  }).then(function (devs) { S.devices = devs; return devs; });
}

/* -------------- util -------------- */
function el(html) { var d = document.createElement('div'); d.innerHTML = html; return d; }
function esc(s) { return String(s == null ? '' : s).replace(/[<>&"]/g, function (c) {
  return {'<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;'}[c]; }); }
function fmt1(v) { return (v == null || !isFinite(v)) ? '--' : Number(v).toFixed(1).replace('.', ','); }
function hoje0() { var d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }
function waves() {
  return '<svg class="waves" viewBox="0 0 100 100" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round">' +
    '<path d="M46 35 a22 22 0 0 1 0 30"/><path d="M58 25 a34 34 0 0 1 0 50"/><path d="M70 15 a46 46 0 0 1 0 70"/></svg>';
}
function hdr(title) {
  var h = new Date();
  var hh = ('0' + h.getHours()).slice(-2) + ':' + ('0' + h.getMinutes()).slice(-2);
  return '<div class="hdr">' + waves() +
    '<div class="clock">' + hh + '</div>' +
    '<div class="hdr-row"><h1>' + title + '</h1>' +
    '<img class="logo" src="./icons/icon-192.png" alt="ConectaNOS"/></div></div>';
}
function statusHtml(d) {
  var f = d.latest.fora_limite;
  if (f === 1) { return '<span class="st-bad">&#9650; acima do limite</span>'; }
  if (f === 0) { return '<span class="st-ok">&#10003; dentro do limite</span>'; }
  return '<span class="st-na">sem avalia&ccedil;&atilde;o</span>';
}

/* -------------- telas -------------- */
function screen() { return document.getElementById('screen'); }
function tabbar(show, active) {
  var tb = document.getElementById('tabbar');
  tb.hidden = !show;
  tb.querySelectorAll('.tab').forEach(function (b) {
    b.classList.toggle('active', b.getAttribute('data-nav') === active);
  });
}

function viewLogin(msg) {
  stopPoll(); tabbar(false);
  screen().innerHTML =
    '<div class="login-wrap">' +
      '<img class="login-logo" src="./icons/icon-192.png" alt="ConectaNOS"/>' +
      '<div class="login-title">Monitoramento de Ru&iacute;do</div>' +
      '<div class="login-sub">ConectaNOS Lab &middot; acesse com sua conta</div>' +
      '<div class="field"><label>E-mail:</label><input id="lg-mail" type="email" autocomplete="username"/></div>' +
      '<div class="field"><label>Senha:</label><input id="lg-pass" type="password" autocomplete="current-password"/></div>' +
      '<div class="login-err" id="lg-err">' + (msg || '') + '</div>' +
      '<button class="btn btn-pri" id="lg-go">Entrar</button>' +
      '<div class="version">' + APP_VERSION + '</div>' +
    '</div>';
  var go = function () {
    document.getElementById('lg-err').textContent = '';
    login(document.getElementById('lg-mail').value.trim(),
          document.getElementById('lg-pass').value)
      .then(function () { location.hash = '#/inicio'; })
      .catch(function () {
        document.getElementById('lg-err').textContent = 'E-mail ou senha inválidos.';
      });
  };
  document.getElementById('lg-go').onclick = go;
  document.getElementById('lg-pass').onkeydown = function (e) { if (e.key === 'Enter') { go(); } };
}

function viewInicio() {
  tabbar(true, 'inicio');
  var emps = {};
  S.devices.forEach(function (d) { if (d.attrs.empreendimento) { emps[d.attrs.empreendimento] = 1; } });
  var opts = Object.keys(emps).map(function (e) {
    return '<option' + (S.filtroEmp === e ? ' selected' : '') + '>' + esc(e) + '</option>';
  }).join('');
  var devs = S.devices.filter(function (d) {
    if (S.filtroEmp && d.attrs.empreendimento !== S.filtroEmp) { return false; }
    if (S.filtroSit === 'acima' && d.latest.fora_limite !== 1) { return false; }
    if (S.filtroSit === 'dentro' && d.latest.fora_limite !== 0) { return false; }
    return true;
  });
  var cards = devs.map(function (d) {
    return '<div class="card loc-card" data-dev="' + d.id + '">' +
      '<div class="loc-name">' + esc(d.label) + '</div>' +
      '<div class="loc-addr"><span class="pin">&#9906;</span> ' + esc(d.attrs.empreendimento || '') +
        (d.attrs.descricao ? ' &middot; ' + esc(d.attrs.descricao) : '') + '</div>' +
      '<div class="loc-level"><b>' + fmt1(d.latest.laeq) + '</b><span class="un">dB(A)</span>' +
        (d.latest.limite_atual_db != null ? '<span class="lim">limite ' + d.latest.limite_atual_db + '</span>' : '') + '</div>' +
      '<div class="loc-status">' + statusHtml(d) +
        (d.attrs.ambiente ? '<span class="chip">' + esc(d.attrs.ambiente) + '</span>' : '') + '</div>' +
    '</div>';
  }).join('') || '<div class="muted">Nenhum sensor encontrado.</div>';

  screen().innerHTML = hdr('In&iacute;cio') +
    '<div class="wrap">' +
      '<p class="lead">Acompanhe seus locais de monitoramento sonoro. Selecione um sensor para ver os resultados de hoje.</p>' +
      '<div class="filters">' +
        '<div class="field"><label>Empreendimento:</label><select id="f-emp"><option value="">Todos</option>' + opts + '</select></div>' +
        '<div class="field"><label>Situa&ccedil;&atilde;o:</label><select id="f-sit">' +
          '<option value="">Todas</option>' +
          '<option value="dentro"' + (S.filtroSit === 'dentro' ? ' selected' : '') + '>Dentro do limite</option>' +
          '<option value="acima"' + (S.filtroSit === 'acima' ? ' selected' : '') + '>Acima do limite</option>' +
        '</select></div>' +
        '<div class="btn-row">' +
          '<button class="btn btn-sec" id="f-clear">Limpar filtros</button>' +
          '<button class="btn btn-pri" id="f-go">Pesquisar</button>' +
        '</div>' +
      '</div>' + cards +
    '</div>';
  document.getElementById('f-go').onclick = function () {
    S.filtroEmp = document.getElementById('f-emp').value;
    S.filtroSit = document.getElementById('f-sit').value;
    viewInicio();
  };
  document.getElementById('f-clear').onclick = function () {
    S.filtroEmp = ''; S.filtroSit = ''; viewInicio();
  };
  screen().querySelectorAll('.loc-card').forEach(function (c) {
    c.onclick = function () { location.hash = '#/dash/' + c.getAttribute('data-dev'); };
  });
}

/* ---- gráficos SVG ---- */
function chartLine(series, limSteps, w, h) {
  // series: [[ts,val]...] · limSteps: [[ts,val]...] (degrau)
  var L = 34, R = 8, T = 8, B = 22;
  var t0 = hoje0(), t1 = Date.now();
  var lo = 20, hi = 90;
  function x(t) { return L + (w - L - R) * (t - t0) / (t1 - t0); }
  function y(v) { return T + (h - T - B) * (hi - Math.max(lo, Math.min(hi, v))) / (hi - lo); }
  var s = '<svg class="chart" viewBox="0 0 ' + w + ' ' + h + '">';
  for (var g = 20; g <= 90; g += 10) {
    s += '<line x1="' + L + '" y1="' + y(g) + '" x2="' + (w - R) + '" y2="' + y(g) +
         '" stroke="#243144"/><text x="' + (L - 5) + '" y="' + (y(g) + 3) +
         '" text-anchor="end" font-size="9.5" fill="#8296ab">' + g + '</text>';
  }
  for (var hh = 0; hh <= 24; hh += 3) {
    var tt = t0 + hh * 3600000;
    if (tt > t1) { break; }
    s += '<text x="' + x(tt) + '" y="' + (h - 8) + '" text-anchor="middle" font-size="9.5" fill="#8296ab">' +
         ('0' + hh).slice(-2) + '</text>';
  }
  if (limSteps.length) {
    var lp = limSteps.map(function (p, i) {
      var seg = (i ? 'L' : 'M') + x(p[0]) + ' ' + y(p[1]);
      if (limSteps[i + 1]) { seg += ' L' + x(limSteps[i + 1][0]) + ' ' + y(p[1]); }
      else { seg += ' L' + x(t1) + ' ' + y(p[1]); }
      return seg;
    }).join(' ');
    s += '<path d="' + lp + '" fill="none" stroke="#ff5a5a" stroke-width="2.5"/>';
  }
  if (series.length > 1) {
    var pts = series.map(function (p) { return x(p[0]) + ',' + y(p[1]); });
    s += '<defs><linearGradient id="ga" x1="0" y1="0" x2="0" y2="1">' +
         '<stop offset="0" stop-color="#4FB8FF" stop-opacity=".35"/>' +
         '<stop offset="1" stop-color="#4FB8FF" stop-opacity="0"/></linearGradient></defs>';
    s += '<polygon points="' + x(series[0][0]) + ',' + y(lo) + ' ' + pts.join(' ') + ' ' +
         x(series[series.length - 1][0]) + ',' + y(lo) + '" fill="url(#ga)"/>';
    s += '<polyline points="' + pts.join(' ') + '" fill="none" stroke="#4FB8FF" stroke-width="2"/>';
  }
  return s + '</svg>';
}

function chartBars(hours, w, h) {
  // hours: [{h, min}] minutos fora por hora de hoje
  var L = 34, R = 8, T = 8, B = 22, hi = 60;
  var s = '<svg class="chart" viewBox="0 0 ' + w + ' ' + h + '">';
  function y(v) { return T + (h - T - B) * (hi - Math.min(hi, v)) / hi; }
  for (var g = 0; g <= 60; g += 20) {
    s += '<line x1="' + L + '" y1="' + y(g) + '" x2="' + (w - R) + '" y2="' + y(g) +
         '" stroke="#243144"/><text x="' + (L - 5) + '" y="' + (y(g) + 3) +
         '" text-anchor="end" font-size="9.5" fill="#8296ab">' + g + '</text>';
  }
  var bw = (w - L - R) / 24;
  for (var i = 0; i < 24; i++) {
    var m = hours[i] || 0;
    if (m > 0) {
      s += '<rect x="' + (L + i * bw + 1.5) + '" y="' + y(m) + '" width="' + (bw - 3) +
           '" height="' + (y(0) - y(m)) + '" rx="2" fill="#ff5a5a"/>';
    }
    if (i % 3 === 0) {
      s += '<text x="' + (L + i * bw + bw / 2) + '" y="' + (h - 8) +
           '" text-anchor="middle" font-size="9.5" fill="#8296ab">' + ('0' + i).slice(-2) + '</text>';
    }
  }
  s += '<line x1="' + L + '" y1="' + y(0) + '" x2="' + (w - R) + '" y2="' + y(0) + '" stroke="#3c4d69" stroke-width="1.5"/>';
  return s + '</svg>';
}

function limSchedule(d) {
  // degrau de limites de HOJE a partir dos atributos
  var a = d.attrs;
  var ld = Number(a.limite_diurno_db), ln = Number(a.limite_noturno_db);
  var hd = a.hora_ini_diurno != null ? Number(a.hora_ini_diurno) : 7;
  var hn = a.hora_ini_noturno != null ? Number(a.hora_ini_noturno) : 22;
  if (!isFinite(ld) || !isFinite(ln)) { return []; }
  var t0 = hoje0();
  return [[t0, ln], [t0 + hd * 3600000, ld], [t0 + hn * 3600000, ln]]
    .filter(function (p) { return p[0] <= Date.now(); });
}

function viewDash(devId) {
  tabbar(true, 'dash');
  var d = S.devices.filter(function (x) { return x.id === devId; })[0] || S.devices[0];
  if (!d) { screen().innerHTML = hdr('Dashboard') + '<div class="wrap"><div class="muted">Nenhum sensor.</div></div>'; return; }
  S.current = d.id;
  var t0 = hoje0(), t1 = Date.now();
  // TB limita a ~700 intervalos por consulta agregada: intervalo dinâmico
  var iv = Math.max(60000, Math.ceil((t1 - t0) / 480 / 60000) * 60000);
  Promise.all([
    api('/api/plugins/telemetry/DEVICE/' + d.id + '/values/timeseries?keys=laeq&startTs=' + t0 +
        '&endTs=' + t1 + '&interval=' + iv + '&agg=AVG&limit=600').catch(function () { return {}; }),
    api('/api/plugins/telemetry/DEVICE/' + d.id + '/values/timeseries?keys=fora_limite&startTs=' + t0 +
        '&endTs=' + t1 + '&interval=3600000&agg=SUM&limit=25').catch(function () { return {}; }),
    api('/api/plugins/telemetry/DEVICE/' + d.id + '/values/timeseries?keys=laeq&startTs=' + t0 +
        '&endTs=' + t1 + '&interval=' + (t1 - t0) + '&agg=COUNT&limit=1').catch(function () { return {}; }),
    api('/api/plugins/telemetry/DEVICE/' + d.id + '/values/timeseries?keys=lamax&startTs=' + t0 +
        '&endTs=' + t1 + '&interval=' + (t1 - t0) + '&agg=MAX&limit=1').catch(function () { return {}; })
  ]).then(function (rr) {
    var serie = (rr[0].laeq || []).map(function (p) { return [p.ts, Number(p.value)]; })
      .sort(function (a, b) { return a[0] - b[0]; });
    var hours = {};
    (rr[1].fora_limite || []).forEach(function (p) {
      hours[new Date(p.ts).getHours()] = Number(p.value) / 60;
    });
    var minMon = (rr[2].laeq && rr[2].laeq.length) ? Math.round(Number(rr[2].laeq[0].value) / 60) : 0;
    var minFora = 0;
    Object.keys(hours).forEach(function (k) { minFora += hours[k]; });
    minFora = Math.round(minFora);
    var pctOk = minMon > 0 ? (100 * (minMon - minFora) / minMon) : 100;
    var lamaxDia = (rr[3].lamax && rr[3].lamax.length) ? Number(rr[3].lamax[0].value) : null;
    var a = d.attrs;
    var normaTxt = a.norma ? esc(a.norma) + (a.zona_ou_tipo && a.zona_ou_tipo.indexOf('definir') < 0 ?
        ' &middot; ' + esc(a.zona_ou_tipo) : '') : 'limites do contrato';
    var hd2 = a.hora_ini_diurno != null ? a.hora_ini_diurno : 7;
    var hn2 = a.hora_ini_noturno != null ? a.hora_ini_noturno : 22;
    var hasGeo = isFinite(Number(a.latitude)) && isFinite(Number(a.longitude));

    screen().innerHTML = hdr('Dashboard') +
      '<div class="wrap">' +
        '<p class="lead">Resultados de monitoramento sonoro de hoje para o sensor selecionado.</p>' +
        '<h2 class="place"><span class="pin">&#9906;</span> ' + esc(d.label) + '</h2>' +
        '<div class="map-box" id="mapbox">' + (hasGeo ? '<div id="map"></div>' : 'sem coordenadas cadastradas') + '</div>' +
        '<div class="card"><h3 class="card-t">Limites estabelecidos</h3>' +
          '<div class="muted" style="text-align:left;font-size:12.5px;margin-bottom:4px;">' + normaTxt + '</div>' +
          '<div class="limits-line"><span>' + hd2 + 'h</span><b>L<sub>Aeq</sub> ' + esc(a.limite_diurno_db || '?') +
          ' dB</b><span>' + hn2 + 'h</span><b>L<sub>Aeq</sub> ' + esc(a.limite_noturno_db || '?') +
          ' dB</b><span>' + hd2 + 'h</span></div></div>' +
        '<div class="card"><h3 class="card-t">' + minMon + ' minutos monitorados hoje</h3>' +
          '<div class="bar-split"><div class="ok" style="width:' + pctOk.toFixed(1) + '%"></div>' +
          '<div class="bad" style="flex:1"></div></div>' +
          '<div class="legend"><span><span class="dot" style="background:var(--cn-ok)"></span>' +
          (minMon - minFora) + ' min abaixo do limite</span><span><span class="dot" style="background:var(--cn-alert)"></span>' +
          minFora + ' min acima</span></div></div>' +
        '<div class="card"><h3 class="card-t">Minutos acima do limite ao longo do dia</h3>' +
          chartBars(hours, 420, 170) + '<div class="chart-note">Minuto x Hora (hoje)</div></div>' +
        '<div class="card"><h3 class="card-t">N&iacute;vel de press&atilde;o sonora ao longo do dia</h3>' +
          chartLine(serie, limSchedule(d), 420, 220) +
          '<div class="chart-note">L<sub>Aeq</sub> [dB] m&eacute;dia por intervalo &middot; linha vermelha = limite vigente</div></div>' +
        '<div class="card"><div class="kpi-row">' +
          '<div class="kpi"><div class="v">' + fmt1(d.latest.laeq) + '</div><div class="l">LAeq agora dB(A)</div></div>' +
          '<div class="kpi"><div class="v">' + fmt1(lamaxDia) + '</div><div class="l">LAmax hoje dB(A)</div></div>' +
          '<div class="kpi"><div class="v">' + (d.latest.limite_atual_db != null ? d.latest.limite_atual_db : '--') +
            '</div><div class="l">limite agora dB(A)</div></div>' +
        '</div></div>' +
      '</div>';
    if (hasGeo) { loadMap(Number(a.latitude), Number(a.longitude), d.label); }
  });
}

function loadMap(lat, lng, label) {
  function draw() {
    var map = L.map('map', {zoomControl: false, attributionControl: false}).setView([lat, lng], 16);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {maxZoom: 19}).addTo(map);
    L.marker([lat, lng]).addTo(map).bindPopup(label);
  }
  if (window.L) { draw(); return; }
  var css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
  document.head.appendChild(css);
  var js = document.createElement('script');
  js.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
  js.onload = draw;
  document.head.appendChild(js);
}

function viewPerfil() {
  tabbar(true, 'perfil');
  var u = S.user || {};
  var nome = ((u.firstName || '') + ' ' + (u.lastName || '')).trim() || u.email || '';
  function item(icon, t, s2) {
    return '<div class="prof-item">' + icon +
      '<div><div class="t">' + t + '</div><div class="s">' + s2 + '</div></div>' +
      '<div class="chev">&rsaquo;</div></div>';
  }
  var icUser = '<svg viewBox="0 0 24 24"><circle cx="12" cy="8.5" r="3.6"/><path d="M4.8 20c1.4-3.4 4-5 7.2-5s5.8 1.6 7.2 5"/></svg>';
  var icBiz = '<svg viewBox="0 0 24 24"><rect x="4" y="7" width="16" height="13" rx="2"/><path d="M9 7V5a3 3 0 0 1 6 0v2"/></svg>';
  var icSensor = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M6.3 6.3a8 8 0 0 0 0 11.4M17.7 6.3a8 8 0 0 1 0 11.4"/></svg>';
  var icBell = '<svg viewBox="0 0 24 24"><path d="M6 10a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6"/><path d="M10 20a2.2 2.2 0 0 0 4 0"/></svg>';
  screen().innerHTML = hdr('Perfil') +
    '<div class="wrap">' +
      '<div class="prof-head">' +
        '<img class="login-logo" src="./icons/icon-192.png" alt=""/>' +
        '<div class="prof-name">' + esc(nome) + '</div>' +
        '<div class="prof-mail">' + esc(u.email || '') + '</div>' +
        '<div><span class="badge-ok"><span class="dot"></span>Conectado ao ThingsBoard</span></div>' +
      '</div>' +
      item(icUser, 'Dados da conta', esc(u.authority === 'TENANT_ADMIN' ? 'Administrador' : 'Cliente')) +
      item(icBiz, 'Empresas e projetos', 'Empreendimentos monitorados') +
      item(icSensor, 'Sensores vinculados', S.devices.length + ' sensor(es) DNMS') +
      item(icBell, 'Alertas e notifica&ccedil;&otilde;es', 'Alarme de sensor mudo ativo') +
      '<button class="logout" id="bt-out">Sair da conta</button>' +
      '<div class="version">ConectaNOS Monitoramento ' + APP_VERSION + '</div>' +
    '</div>';
  document.getElementById('bt-out').onclick = logout;
}

/* -------------- router + poll -------------- */
function stopPoll() { if (S.timer) { clearInterval(S.timer); S.timer = null; } }
function startPoll() {
  stopPoll();
  S.timer = setInterval(function () {
    if (!S.token) { return; }
    loadDevices().then(route).catch(function () {});
  }, POLL_MS);
}

function route() {
  var h = location.hash || '#/inicio';
  if (!S.token) { viewLogin(); return; }
  if (h.indexOf('#/login') === 0) { viewLogin(); return; }
  var boot = S.user ? Promise.resolve() :
    loadUser().then(loadDevices).then(startPoll);
  boot.then(function () {
    if (h.indexOf('#/dash') === 0) {
      var id = h.split('/')[2] || S.current || (S.devices[0] && S.devices[0].id);
      viewDash(id);
    } else if (h.indexOf('#/perfil') === 0) {
      viewPerfil();
    } else {
      viewInicio();
    }
  }).catch(function () { viewLogin('Não foi possível carregar seus dados.'); });
}

document.getElementById('tabbar').addEventListener('click', function (e) {
  var b = e.target.closest('.tab');
  if (!b) { return; }
  var nav = b.getAttribute('data-nav');
  location.hash = (nav === 'dash') ? '#/dash/' + (S.current || '') : '#/' + nav;
});
window.addEventListener('hashchange', route);
route();
