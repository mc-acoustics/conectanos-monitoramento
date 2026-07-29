/* ConectaNOS — Monitoramento de Ruído (F5, v0.1)
 * PWA estático sobre a API do ThingsBoard (CORS aberto verificado).
 * Telas: login, Início (cards de locais), Dashboard (limites NBR,
 * minutos dentro/fora, gráficos SVG), Perfil. Poll de 15 s. */
'use strict';

var TB = 'https://thingsboard.nosconectados.com.br';
var APP_VERSION = 'v0.2.0 — 2026-07-29';
var POLL_MS = 15000;

var S = {
  token: localStorage.getItem('cn_token') || null,
  user: null,
  devices: [],           // {id, name, label, attrs{}, latest{}}
  current: null,         // deviceId selecionado
  filtroEmp: '',
  filtroSit: '',
  timer: null,
  dashT10: null,         // espectro/KPIs a 10 s (só na tela do sensor)
  dashT60: null          // re-render do dashboard a 60 s
};

/* ---- bandas de 1/3 de oitava e curvas NC (NBR 10152) ---- */
var T31 = [
  ['t20', '20'], ['t25', '25'], ['t31_5', '31.5'], ['t40', '40'],
  ['t50', '50'], ['t63', '63'], ['t80', '80'], ['t100', '100'],
  ['t125', '125'], ['t160', '160'], ['t200', '200'], ['t250', '250'],
  ['t315', '315'], ['t400', '400'], ['t500', '500'], ['t630', '630'],
  ['t800', '800'], ['t1000', '1k'], ['t1250', '1.25k'], ['t1600', '1.6k'],
  ['t2000', '2k'], ['t2500', '2.5k'], ['t3150', '3.15k'], ['t4000', '4k'],
  ['t5000', '5k'], ['t6300', '6.3k'], ['t8000', '8k'], ['t10000', '10k'],
  ['t12500', '12.5k'], ['t16000', '16k'], ['t20000', '20k']
];
// Tabela 2 da NBR 10152:2017 (bandas 63 Hz..8 kHz)
var NC_TABLE = {
  15: [47, 36, 28, 22, 18, 14, 12, 11], 20: [50, 40, 33, 26, 22, 20, 17, 16],
  25: [54, 44, 37, 31, 27, 24, 22, 22], 30: [57, 48, 41, 35, 32, 29, 28, 27],
  35: [60, 52, 45, 40, 36, 34, 33, 32], 40: [64, 56, 50, 44, 41, 39, 38, 37],
  45: [67, 60, 54, 49, 46, 44, 43, 42], 50: [71, 64, 58, 54, 51, 49, 48, 47],
  55: [74, 67, 62, 58, 56, 54, 53, 52], 60: [77, 71, 66, 63, 60, 59, 58, 57],
  65: [80, 75, 71, 68, 65, 64, 63, 62], 70: [84, 79, 75, 72, 71, 70, 68, 68]
};
var NC_STEPS = [15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70];
var OCT8 = [
  {label: '63', keys: ['t50', 't63', 't80']},
  {label: '125', keys: ['t100', 't125', 't160']},
  {label: '250', keys: ['t200', 't250', 't315']},
  {label: '500', keys: ['t400', 't500', 't630']},
  {label: '1k', keys: ['t800', 't1000', 't1250']},
  {label: '2k', keys: ['t1600', 't2000', 't2500']},
  {label: '4k', keys: ['t3150', 't4000', 't5000']},
  {label: '8k', keys: ['t6300', 't8000', 't10000']}
];
function ncForBand(level, b) {
  if (level <= NC_TABLE[15][b]) { return 15; }
  if (level >= NC_TABLE[70][b]) { return 71; }
  for (var i = 1; i < NC_STEPS.length; i++) {
    var lo = NC_STEPS[i - 1], hi = NC_STEPS[i];
    if (level <= NC_TABLE[hi][b]) {
      return lo + 5 * (level - NC_TABLE[lo][b]) / (NC_TABLE[hi][b] - NC_TABLE[lo][b]);
    }
  }
  return 71;
}

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

function chartSpectrum(vals, w, h) {
  // vals: 31 níveis (ou null) na ordem T31 — barras estilo ConectaNOS
  var L = 30, R = 6, T2 = 8, B = 22, lo = 20, hi = 80;
  function y(v) { return T2 + (h - T2 - B) * (hi - Math.max(lo, Math.min(hi, v))) / (hi - lo); }
  var s = '<svg class="chart" viewBox="0 0 ' + w + ' ' + h + '">' +
    '<defs><linearGradient id="gb" x1="0" y1="0" x2="0" y2="1">' +
    '<stop offset="0" stop-color="#4FB8FF"/><stop offset="1" stop-color="#4FB8FF" stop-opacity=".3"/></linearGradient></defs>';
  for (var g = lo; g <= hi; g += 20) {
    s += '<line x1="' + L + '" y1="' + y(g) + '" x2="' + (w - R) + '" y2="' + y(g) +
         '" stroke="#243144"/><text x="' + (L - 5) + '" y="' + (y(g) + 3) +
         '" text-anchor="end" font-size="9" fill="#8296ab">' + g + '</text>';
  }
  var bw = (w - L - R) / 31;
  for (var i = 0; i < 31; i++) {
    var v = vals[i];
    if (v != null && isFinite(v)) {
      s += '<rect x="' + (L + i * bw + bw * 0.15) + '" y="' + y(v) + '" width="' + (bw * 0.7) +
           '" height="' + Math.max(1.5, y(lo) - y(v)) + '" rx="1.6" fill="url(#gb)">' +
           '<title>' + T31[i][1] + ' Hz: ' + fmt1(v) + ' dB</title></rect>';
    }
    if (i % 2 === 0) {
      s += '<text x="' + (L + i * bw + bw / 2) + '" y="' + (h - 8) +
           '" text-anchor="middle" font-size="7.6" fill="#8296ab">' + T31[i][1] + '</text>';
    }
  }
  return s + '</svg>';
}

function chartNC(oct, ncRef, w, h) {
  var L = 34, R = 56, T2 = 8, B = 22, lo = 10, hi = 90;
  var pw = w - L - R, ph = h - T2 - B;
  function px(b) { return L + pw * (b + 0.5) / 8; }
  function py(v) { return T2 + ph * (hi - Math.max(lo, Math.min(hi, v))) / (hi - lo); }
  var s = '<svg class="chart" viewBox="0 0 ' + w + ' ' + h + '">';
  for (var g = 10; g <= 90; g += 20) {
    s += '<line x1="' + L + '" y1="' + py(g) + '" x2="' + (w - R) + '" y2="' + py(g) +
         '" stroke="#243144"/><text x="' + (L - 5) + '" y="' + (py(g) + 3) +
         '" text-anchor="end" font-size="9" fill="#8296ab">' + g + '</text>';
  }
  var lnc = null, crit = -1;
  for (var b2 = 0; b2 < 8; b2++) {
    if (oct[b2] == null) { continue; }
    var nb = ncForBand(oct[b2], b2);
    if (lnc === null || nb > lnc) { lnc = nb; crit = b2; }
  }
  for (var i = 0; i < NC_STEPS.length; i++) {
    var nc = NC_STEPS[i];
    var isRef = (ncRef != null && nc === Number(ncRef));
    var pts = [];
    for (b2 = 0; b2 < 8; b2++) { pts.push(px(b2) + ',' + py(NC_TABLE[nc][b2])); }
    s += '<polyline points="' + pts.join(' ') + '" fill="none" stroke="' +
         (isRef ? '#ffd35a' : '#3c4d69') + '" stroke-width="' + (isRef ? 2 : 1) + '"' +
         (isRef ? ' stroke-dasharray="5 4"' : '') + '/>' +
         '<text x="' + (w - R + 5) + '" y="' + (py(NC_TABLE[nc][7]) + 3) +
         '" font-size="8.6" font-weight="' + (isRef ? '800' : '600') + '" fill="' +
         (isRef ? '#ffd35a' : '#5b6f8b') + '">NC-' + nc + '</text>';
  }
  var sp = [];
  for (b2 = 0; b2 < 8; b2++) {
    if (oct[b2] != null) { sp.push(px(b2) + ',' + py(oct[b2])); }
    s += '<text x="' + px(b2) + '" y="' + (h - 8) + '" text-anchor="middle" font-size="9.4" ' +
         'fill="#8296ab" font-weight="600">' + OCT8[b2].label + '</text>';
  }
  if (sp.length > 1) {
    s += '<polyline points="' + sp.join(' ') + '" fill="none" stroke="#4FB8FF" stroke-width="2.4" stroke-linejoin="round"/>';
  }
  for (b2 = 0; b2 < 8; b2++) {
    if (oct[b2] == null) { continue; }
    s += '<circle cx="' + px(b2) + '" cy="' + py(oct[b2]) + '" r="' + (b2 === crit ? 4.6 : 3.2) +
         '" fill="' + (b2 === crit ? '#ff5a5a' : '#4FB8FF') + '" stroke="#0c1118" stroke-width="1.3"/>';
  }
  return {svg: s + '</svg>', lnc: lnc, crit: crit};
}

function ncVerdictHtml(lnc, crit, ncRef) {
  if (lnc == null) { return '<div class="muted">aguardando dados do dia&hellip;</div>'; }
  var ncShow = Math.ceil(Math.min(lnc, 71));
  var head = 'L<sub style="font-size:9px;">NC</sub> do dia = ' +
             (lnc > 70 ? '&gt; NC-70' : 'NC-' + ncShow) +
             ' <span style="color:var(--cn-text-mute);font-size:12px;">(determinante ' +
             OCT8[crit].label + ' Hz)</span>';
  if (ncRef == null || !isFinite(Number(ncRef))) {
    return '<div style="font-size:15px;font-weight:700;margin-top:10px;">' + head + '</div>';
  }
  var ref = Number(ncRef), diff = ncShow - ref;
  var badge = (diff <= 0)
    ? '<span style="display:inline-block;background:rgba(46,207,127,.12);border:1px solid rgba(46,207,127,.35);' +
      'color:var(--cn-ok);font-weight:800;border-radius:999px;padding:7px 16px;margin-top:8px;">' +
      '&#10003; ATENDE o alvo NC-' + ref + (diff < 0 ? ' (folga de ' + (-diff) + ' dB)' : '') + '</span>'
    : '<span style="display:inline-block;background:rgba(255,90,90,.12);border:1px solid rgba(255,90,90,.4);' +
      'color:var(--cn-alert);font-weight:800;border-radius:999px;padding:7px 16px;margin-top:8px;">' +
      '&#9650; EXCEDE o alvo NC-' + ref + ' em ' + diff + ' dB</span>';
  return '<div style="font-size:15px;font-weight:700;margin-top:10px;">' + head + '</div>' + badge;
}

function fetchSpectrumLatest(devId) {
  var keys = T31.map(function (t) { return t[0]; }).join(',');
  return api('/api/plugins/telemetry/DEVICE/' + devId + '/values/timeseries?keys=' + keys)
    .then(function (j) {
      return T31.map(function (t) {
        var a = j[t[0]];
        return (a && a.length) ? Number(a[0].value) : null;
      });
    });
}

function fetchDayOctaves(devId) {
  // média de ENERGIA do dia por terço (60 baldes AVG-dB energizados) → oitavas
  var t0 = hoje0(), t1 = Date.now();
  var iv = Math.max(60000, Math.ceil((t1 - t0) / 60 / 60000) * 60000);
  var keys = [];
  OCT8.forEach(function (o) { keys = keys.concat(o.keys); });
  return api('/api/plugins/telemetry/DEVICE/' + devId + '/values/timeseries?keys=' + keys.join(',') +
             '&startTs=' + t0 + '&endTs=' + t1 + '&interval=' + iv + '&agg=AVG&limit=100')
    .then(function (j) {
      function eMean(arr) {
        if (!arr || !arr.length) { return null; }
        var e = 0, n = 0;
        arr.forEach(function (p) {
          var v = Number(p.value);
          if (isFinite(v)) { e += Math.pow(10, v / 10); n++; }
        });
        return n ? 10 * Math.log10(e / n) : null;
      }
      return OCT8.map(function (o) {
        var e = 0, ok = true;
        o.keys.forEach(function (k) {
          var v = eMean(j[k]);
          if (v == null) { ok = false; return; }
          e += Math.pow(10, v / 10);
        });
        return ok ? 10 * Math.log10(e) : null;
      });
    });
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
  stopDashTimers();
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
          '<div class="kpi"><div class="v" id="kpi-laeq">' + fmt1(d.latest.laeq) + '</div><div class="l">LAeq agora dB(A)</div></div>' +
          '<div class="kpi"><div class="v">' + fmt1(lamaxDia) + '</div><div class="l">LAmax hoje dB(A)</div></div>' +
          '<div class="kpi"><div class="v" id="kpi-lim">' + (d.latest.limite_atual_db != null ? d.latest.limite_atual_db : '--') +
            '</div><div class="l">limite agora dB(A)</div></div>' +
        '</div></div>' +
        '<div class="card"><h3 class="card-t">Espectro 1/3 de oitava &mdash; L<sub>Zeq,10s</sub> [dB]</h3>' +
          '<div id="spec-box"><div class="muted">carregando&hellip;</div></div>' +
          '<div class="chart-note">31 bandas &middot; atualiza a cada 10 s</div></div>' +
        '<div class="card"><h3 class="card-t">Curvas NC (NBR 10152) &mdash; acumulado de hoje</h3>' +
          '<div id="nc-box"><div class="muted">carregando&hellip;</div></div>' +
          '<div id="nc-verdict"></div>' +
          '<div class="chart-note">oitavas 63 Hz&ndash;8 kHz somadas dos ter&ccedil;os (&sect;7.5.5) &middot; alvo do ambiente: ' +
            (a.ambiente ? esc(a.ambiente) : '?') + '</div></div>' +
      '</div>';
    if (hasGeo) { loadMap(Number(a.latitude), Number(a.longitude), d.label); }

    function upSpec() {
      Promise.all([
        fetchSpectrumLatest(d.id),
        api('/api/plugins/telemetry/DEVICE/' + d.id + '/values/timeseries?keys=laeq,limite_atual_db')
          .catch(function () { return {}; })
      ]).then(function (rr) {
        var box = document.getElementById('spec-box');
        if (box) { box.innerHTML = chartSpectrum(rr[0], 420, 170); }
        var k1 = document.getElementById('kpi-laeq');
        if (k1 && rr[1].laeq && rr[1].laeq.length) { k1.textContent = fmt1(Number(rr[1].laeq[0].value)); }
        var k2 = document.getElementById('kpi-lim');
        if (k2 && rr[1].limite_atual_db && rr[1].limite_atual_db.length) { k2.textContent = rr[1].limite_atual_db[0].value; }
      }).catch(function () {});
    }
    function upNC() {
      fetchDayOctaves(d.id).then(function (oct) {
        var box = document.getElementById('nc-box');
        if (!box) { return; }
        var r2 = chartNC(oct, a.nc_referencia, 420, 230);
        box.innerHTML = r2.svg;
        var vv = document.getElementById('nc-verdict');
        if (vv) { vv.innerHTML = ncVerdictHtml(r2.lnc, r2.crit, a.nc_referencia); }
      }).catch(function () {});
    }
    upSpec();
    upNC();
    S.dashT10 = setInterval(upSpec, 10000);
    S.dashT60 = setInterval(function () { if (location.hash.indexOf('#/dash') === 0) { viewDash(d.id); } }, 60000);
  });
}

function stopDashTimers() {
  if (S.dashT10) { clearInterval(S.dashT10); S.dashT10 = null; }
  if (S.dashT60) { clearInterval(S.dashT60); S.dashT60 = null; }
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
function stopPoll() {
  if (S.timer) { clearInterval(S.timer); S.timer = null; }
  stopDashTimers();
}
function startPoll() {
  stopPoll();
  S.timer = setInterval(function () {
    if (!S.token) { return; }
    // na tela do sensor quem atualiza são os timers próprios (10 s/60 s)
    if (location.hash.indexOf('#/dash') === 0) { return; }
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
    } else {
      stopDashTimers();
      if (h.indexOf('#/perfil') === 0) { viewPerfil(); } else { viewInicio(); }
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
