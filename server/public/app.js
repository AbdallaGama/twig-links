/* Twig dashboard — vanilla JS single-page app served by the Twig server. */
(function () {
  'use strict';

  var view = document.getElementById('view');
  var nav = document.getElementById('nav');
  var state = { user: null, apps: [], range: 30 };

  // ------------------------------------------------------------ helpers

  function h(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function api(method, path, body) {
    var options = { method: method, credentials: 'same-origin', headers: { 'x-twig-client': 'dashboard' } };
    if (body !== undefined) {
      options.headers['content-type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    return fetch(path, options).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (json) {
        if (response.status === 401 && path.indexOf('/api/auth/') !== 0) { boot(); throw new Error('Signed out'); }
        if (!response.ok) throw new Error(json.message && json.message !== json.error ? json.message : (json.error || 'HTTP ' + response.status));
        return json;
      });
    });
  }

  var toastTimer;
  function toast(message, kind) {
    var el = document.getElementById('toast');
    document.getElementById('toast-text').textContent = message;
    el.className = kind === 'error' ? 'error' : '';
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, kind === 'error' ? 5000 : 2600);
  }

  // Lucide paths (the icon set Forui ships).
  var ICONS = {
    copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    plus: '<path d="M5 12h14M12 5v14"/>',
    back: '<path d="m12 19-7-7 7-7M19 12H5"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4m4-5 5 5 5-5m-5 5V3"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  };

  function icon(name, cls) {
    return '<svg class="icon' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" aria-hidden="true">' + ICONS[name] + '</svg>';
  }

  function copyButton(text, label, variant) {
    return '<button type="button" class="' + (variant || 'outline') + ' sm" data-copy="' + h(text) + '">' + icon('copy', 'when-idle') + icon('check', 'when-copied') + '<span>' + h(label || 'Copy') + '</span></button>';
  }

  /** Copies by selecting a hidden textarea; works where the async Clipboard API is missing or denied. */
  function copyWithSelection(text) {
    var active = document.activeElement;
    var area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0';
    document.body.appendChild(area);
    area.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(area);
    if (active && active.focus) active.focus();
    return ok;
  }

  // navigator.clipboard is undefined on plain-HTTP origins and rejects when the browser denies
  // clipboard-write (embedded browsers, webviews, privacy settings), so fall back to execCommand.
  function copy(text, button) {
    var copied = function () {
      toast('Copied to clipboard');
      if (!button) return;
      button.classList.add('copied');
      setTimeout(function () { button.classList.remove('copied'); }, 1500);
    };
    var fallback = function () {
      if (copyWithSelection(text)) copied();
      else toast('Your browser blocked the clipboard. Select the text and press Ctrl+C (⌘C on Mac).', 'error');
    };
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(copied, fallback);
    else fallback();
  }

  document.addEventListener('click', function (e) {
    var el = e.target.closest && e.target.closest('[data-copy]');
    if (el) copy(el.getAttribute('data-copy'), el);
  });

  /** Forui-style confirmation dialog; resolves true when the action button is pressed. */
  function confirmDialog(title, body, action, destructive) {
    var dialog = document.getElementById('dialog');
    var ok = document.getElementById('dialog-ok');
    document.getElementById('dialog-title').textContent = title;
    document.getElementById('dialog-body').textContent = body;
    ok.textContent = action;
    ok.className = destructive ? 'danger' : '';
    dialog.returnValue = '';
    dialog.showModal();
    return new Promise(function (resolve) {
      dialog.addEventListener('close', function () { resolve(dialog.returnValue === 'ok'); }, { once: true });
    });
  }

  document.getElementById('dialog').addEventListener('click', function (e) {
    if (e.target === e.currentTarget) e.currentTarget.close();
  });

  function fmtDate(ms) { return new Date(ms).toLocaleString(); }
  function num(n) { return Number(n || 0).toLocaleString(); }
  function $(selector) { return view.querySelector(selector); }
  function $all(selector) { return Array.prototype.slice.call(view.querySelectorAll(selector)); }

  function formError(form, error) {
    var el = form.querySelector('.error');
    if (el) el.textContent = error.message;
    else toast(error.message, 'error');
  }

  function getPath(obj, path) {
    return path.split('.').reduce(function (acc, key) { return acc == null ? acc : acc[key]; }, obj);
  }

  function setPath(obj, path, value) {
    var keys = path.split('.');
    var last = keys.pop();
    var target = keys.reduce(function (acc, key) { return (acc[key] = acc[key] || {}); }, obj);
    target[last] = value;
  }

  function primaryDomain(app) {
    var d = (app.domains || []).filter(function (x) { return x.kind === 'primary'; })[0];
    return d ? d.host : null;
  }

  // ------------------------------------------------------------ theme

  var THEME_KEY = 'twig-theme';

  function markTheme(theme) {
    Array.prototype.forEach.call(document.querySelectorAll('[data-theme-option]'), function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-theme-option') === theme));
    });
  }

  function setTheme(theme) {
    if (theme === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
    try {
      if (theme === 'system') localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, theme);
    } catch (e) { /* storage blocked: the choice lasts until reload */ }
    markTheme(theme);
  }

  markTheme(document.documentElement.getAttribute('data-theme') || 'system');
  Array.prototype.forEach.call(document.querySelectorAll('[data-theme-option]'), function (b) {
    b.addEventListener('click', function () { setTheme(b.getAttribute('data-theme-option')); });
  });

  // ------------------------------------------------------------ boot + routing

  function boot() {
    api('GET', '/api/auth/state').then(function (s) {
      state.user = s.user;
      nav.hidden = !s.user;
      document.getElementById('logout').hidden = !s.user;
      if (s.setup_required) return renderSetup();
      if (!s.user) return renderLogin();
      route();
    }).catch(function (e) { view.innerHTML = '<p class="error">' + h(e.message) + '</p>'; });
  }

  function route() {
    if (!state.user) return boot();
    var parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
    var section = parts[0] === 'team' ? 'team' : 'apps';
    Array.prototype.forEach.call(nav.querySelectorAll('[data-nav]'), function (a) {
      if (a.getAttribute('data-nav') === section) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    if (parts[0] === 'team') return renderTeam();
    if (parts[0] === 'apps' && parts[1] === 'new') return renderNewApp();
    if (parts[0] === 'apps' && parts[1]) return renderApp(parts[1], parts[2] || 'overview', parts.slice(3));
    renderApps();
  }

  window.addEventListener('hashchange', route);
  document.getElementById('logout').addEventListener('click', function () {
    api('POST', '/api/auth/logout').finally(function () { state.user = null; location.hash = ''; boot(); });
  });

  // ------------------------------------------------------------ auth

  function authCard(inner) {
    return '<div class="auth"><div class="auth-brand"><img src="/dashboard/icon.svg" alt="" width="44" height="44"></div><div class="panel">' + inner + '</div></div>';
  }

  function renderSetup() {
    view.innerHTML = authCard('<h1>Welcome to Twig</h1><p class="muted">Create the owner account. The setup token is printed in the server log on first start.</p>' +
      '<form id="setup"><div class="field"><label>Setup token</label><input name="setup_token" required autocomplete="off"></div>' +
      '<div class="field"><label>Name</label><input name="name" required></div>' +
      '<div class="field"><label>Email</label><input name="email" type="email" required autocomplete="username"></div>' +
      '<div class="field"><label>Password <span class="muted">(10+ characters)</span></label><input name="password" type="password" minlength="10" required autocomplete="new-password"></div>' +
      '<button class="block">Create owner</button><p class="error"></p></form>');
    $('#setup').addEventListener('submit', function (e) {
      e.preventDefault();
      var f = e.target;
      api('POST', '/api/auth/setup', { setup_token: f.setup_token.value, name: f.name.value, email: f.email.value, password: f.password.value })
        .then(boot).catch(function (err) { formError(f, err); });
    });
  }

  function renderLogin() {
    view.innerHTML = authCard('<h1>Sign in</h1><p class="muted">Use your Twig dashboard account.</p><form id="login">' +
      '<div class="field"><label>Email</label><input name="email" type="email" required autocomplete="username"></div>' +
      '<div class="field"><label>Password</label><input name="password" type="password" required autocomplete="current-password"></div>' +
      '<button class="block">Sign in</button><p class="error"></p></form>');
    $('#login').addEventListener('submit', function (e) {
      e.preventDefault();
      var f = e.target;
      api('POST', '/api/auth/login', { email: f.email.value, password: f.password.value }).then(boot).catch(function (err) { formError(f, err); });
    });
  }

  // ------------------------------------------------------------ apps list

  function renderApps() {
    view.innerHTML = '<p class="muted">Loading…</p>';
    api('GET', '/api/apps').then(function (res) {
      state.apps = res.apps;
      var canEdit = state.user.role !== 'member';
      var rows = res.apps.map(function (app) {
        return '<tr><td><a href="#/apps/' + h(app.id) + '">' + h(app.name) + '</a></td><td class="mono">' + h(primaryDomain(app) || '—') + '</td>' +
          '<td class="mono small">' + h(app.public_key) + '</td><td class="small muted">' + h(fmtDate(app.created_at)) + '</td></tr>';
      }).join('');
      view.innerHTML = '<div class="row spread page-head"><div><h1>Apps</h1><p class="muted">Each app has its own link domains, keys, links and analytics.</p></div>' +
        (canEdit ? '<a class="btn" href="#/apps/new">' + icon('plus') + 'New app</a>' : '') + '</div>' +
        '<div class="panel table-wrap">' + (rows ? '<table><thead><tr><th>Name</th><th>Link domain</th><th>Public key</th><th>Created</th></tr></thead><tbody>' + rows + '</tbody></table>'
          : '<div class="empty"><h3>No apps yet</h3><p>Create an app to get link domains, SDK keys and analytics.</p>' + (canEdit ? '<a class="btn" href="#/apps/new">' + icon('plus') + 'Create the first app</a>' : '') + '</div>') + '</div>';
    }).catch(function (e) { view.innerHTML = '<p class="error">' + h(e.message) + '</p>'; });
  }

  function renderNewApp() {
    view.innerHTML = '<div class="page-head"><h1>New app</h1><p class="muted">You can fill in store details later in Settings.</p></div><form id="new-app" class="panel">' +
      '<div class="fields"><div class="field"><label>App name</label><input name="name" required></div>' +
      '<div class="field"><label>Link domain <span class="muted">(e.g. links.example.com)</span></label><input name="primary" required placeholder="links.example.com"></div>' +
      '<div class="field"><label>Alternate domain <span class="muted">(recommended for iOS, e.g. open.example.com)</span></label><input name="alternate" placeholder="open.example.com"></div></div>' +
      '<button>Create app</button><p class="error"></p></form>';
    $('#new-app').addEventListener('submit', function (e) {
      e.preventDefault();
      var f = e.target;
      var domains = [{ host: f.primary.value, kind: 'primary' }];
      if (f.alternate.value.trim()) domains.push({ host: f.alternate.value, kind: 'alternate' });
      api('POST', '/api/apps', { name: f.name.value, domains: domains }).then(function (res) {
        view.innerHTML = '<div class="panel"><h1 style="margin-bottom:8px">' + h(res.app.name) + ' created</h1><p>Copy the <b>secret key</b> now; it is shown only once. Use it for server-to-server API calls (never in apps).</p>' +
          '<div class="secret mono">' + h(res.secret_key) + '</div><div class="row" style="margin-top:16px">' + copyButton(res.secret_key, 'Copy secret', 'primary') +
          '<a class="btn outline sm" href="#/apps/' + h(res.app.id) + '/settings">Continue to settings</a></div></div>';
      }).catch(function (err) { formError(f, err); });
    });
  }

  // ------------------------------------------------------------ single app

  var TABS = [['overview', 'Overview'], ['links', 'Links'], ['settings', 'Settings'], ['domains', 'Domains'], ['webhooks', 'Webhooks'], ['integrate', 'Integrate']];

  function renderApp(id, tab, rest) {
    view.innerHTML = '<p class="muted">Loading…</p>';
    api('GET', '/api/apps/' + encodeURIComponent(id)).then(function (res) {
      var app = res.app;
      var tabs = TABS.map(function (t) {
        return '<a href="#/apps/' + h(app.id) + '/' + t[0] + '" class="' + (t[0] === tab ? 'active' : '') + '">' + t[1] + '</a>';
      }).join('');
      view.innerHTML = '<div class="row"><h1>' + h(app.name) + '</h1><span class="badge outline mono">' + h(primaryDomain(app) || 'no domain yet') + '</span></div>' +
        '<nav class="tabs" aria-label="App sections">' + tabs + '</nav><section id="tab"></section>';
      var target = $('#tab');
      var renderers = { overview: tabOverview, links: tabLinks, settings: tabSettings, domains: tabDomains, webhooks: tabWebhooks, integrate: tabIntegrate };
      (renderers[tab] || tabOverview)(app, target, rest);
    }).catch(function (e) { view.innerHTML = '<p class="error">' + h(e.message) + '</p>'; });
  }

  // ---- overview

  // CSS variables rather than resolved colors, so charts follow theme switches without re-rendering.
  var CHART_COLORS = ['var(--c1)', 'var(--c2)', 'var(--c3)'];

  // The SVG stretches to its box (preserveAspectRatio="none"), so axis labels are HTML, not SVG text.
  function chart(series, keys, colors) {
    var w = 800, hgt = 220, pad = 10;
    var max = Math.max(1, Math.max.apply(null, series.map(function (d) { return Math.max.apply(null, keys.map(function (k) { return d[k] || 0; })); })));
    var x = function (i) { return series.length <= 1 ? 0 : i * w / (series.length - 1); };
    var y = function (v) { return hgt - pad - v * (hgt - pad * 2) / max; };
    var ticks = [0, 0.5, 1].map(function (t) { return Math.round(max * t); }).filter(function (v, i, all) { return all.indexOf(v) === i; });
    var grid = ticks.map(function (v) {
      return '<line class="grid-line" vector-effect="non-scaling-stroke" x1="0" x2="' + w + '" y1="' + y(v) + '" y2="' + y(v) + '"/>';
    }).join('');
    var yLabels = ticks.map(function (v) { return '<span class="chart-y" style="top:' + y(v) + 'px">' + num(v) + '</span>'; }).join('');
    var area = series.length > 1 ? '<polygon style="fill:' + colors[0] + ';opacity:.08" points="0,' + y(0) + ' ' +
      series.map(function (d, i) { return x(i) + ',' + y(d[keys[0]] || 0); }).join(' ') + ' ' + w + ',' + y(0) + '"/>' : '';
    var lines = keys.map(function (k, ki) {
      var pts = series.map(function (d, i) { return x(i) + ',' + y(d[k] || 0); }).join(' ');
      return '<polyline fill="none" style="stroke:' + colors[ki] + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" points="' + pts + '"><title>' + k + '</title></polyline>';
    }).join('');
    var xLabels = series.length ? '<div class="chart-x"><span>' + h(series[0].day) + '</span><span>' + h(series[series.length - 1].day) + '</span></div>' : '';
    var legend = keys.map(function (k, i) { return '<span><i style="background:' + colors[i] + '"></i>' + k + '</span>'; }).join('');
    return '<div class="chart-box">' + yLabels + '<svg class="chart" viewBox="0 0 ' + w + ' ' + hgt + '" preserveAspectRatio="none" role="img" aria-label="Daily activity">' + grid + area + lines + '</svg></div>' +
      xLabels + '<div class="legend">' + legend + '</div>';
  }

  function tabOverview(app, el) {
    var base = '/api/apps/' + encodeURIComponent(app.id);
    var q = '?days=' + state.range;
    el.innerHTML = '<div class="row spread" style="margin-bottom:16px"><h2 style="margin:0">Last ' + state.range + ' days</h2>' +
      '<select id="range" style="width:auto" aria-label="Date range">' + [7, 30, 90].map(function (d) { return '<option value="' + d + '"' + (d === state.range ? ' selected' : '') + '>' + d + ' days</option>'; }).join('') + '</select></div><div id="ov">Loading…</div>';
    el.querySelector('#range').addEventListener('change', function (e) { state.range = Number(e.target.value); tabOverview(app, el); });
    Promise.all([
      api('GET', base + '/analytics/summary' + q),
      api('GET', base + '/analytics/timeseries' + q),
      api('GET', base + '/analytics/top-links' + q),
      api('GET', base + '/analytics/breakdown' + q + '&by=channel&kind=install'),
      api('GET', base + '/events/recent?limit=25'),
    ]).then(function (r) {
      var s = r[0].summary;
      var stats = [['Clicks', s.click], ['Installs', s.install], ['Reinstalls', s.reinstall], ['Opens', s.open], ['Web sessions', s.web_open], ['Events', s.event], ['Revenue', s.revenue], ['Links', s.links]];
      var top = r[2].links.map(function (l) {
        return '<tr><td><a href="#/apps/' + h(app.id) + '/links/' + h(l.code) + '" class="mono">/' + h(l.code) + '</a></td><td>' + h(l.channel || '—') + '</td><td>' + h(l.campaign || '—') + '</td>' +
          '<td class="num">' + num(l.clicks) + '</td><td class="num">' + num(l.installs) + '</td><td class="num">' + num(l.opens) + '</td><td class="num">' + num(l.revenue) + '</td></tr>';
      }).join('');
      var channels = r[3].rows.map(function (c) { return '<tr><td>' + h(c.value || '(none)') + '</td><td class="num">' + num(c.count) + '</td></tr>'; }).join('');
      var events = r[4].events.map(function (e) {
        return '<tr><td class="small muted">' + h(fmtDate(e.created_at)) + '</td><td><span class="badge' + (e.kind === 'click' ? ' gray' : '') + '">' + h(e.kind) + '</span></td><td>' + h(e.name) + '</td>' +
          '<td>' + h(e.platform || '') + '</td><td>' + h(e.channel || '') + '</td><td class="num">' + (e.revenue == null ? '' : h(e.revenue + ' ' + (e.currency || ''))) + '</td></tr>';
      }).join('');
      el.querySelector('#ov').innerHTML =
        '<div class="grid">' + stats.map(function (st) { return '<div class="stat"><div class="label">' + st[0] + '</div><div class="value">' + num(st[1]) + '</div></div>'; }).join('') + '</div>' +
        '<div class="panel"><h2>Daily activity</h2>' + chart(r[1].series, ['click', 'install', 'open'], CHART_COLORS) + '</div>' +
        '<div class="grid-2"><div class="panel table-wrap"><h2>Top links</h2>' + (top ? '<table><thead><tr><th>Link</th><th>Channel</th><th>Campaign</th><th class="num">Clicks</th><th class="num">Installs</th><th class="num">Opens</th><th class="num">Revenue</th></tr></thead><tbody>' + top + '</tbody></table>' : '<p class="muted">No link activity yet.</p>') + '</div>' +
        '<div class="panel table-wrap"><h2>Installs by channel</h2>' + (channels ? '<table><tbody>' + channels + '</tbody></table>' : '<p class="muted">No installs yet.</p>') + '</div></div>' +
        '<div class="panel table-wrap"><div class="row spread"><h2>Recent activity</h2><a class="btn outline sm" href="' + base + '/export/events.csv?days=' + state.range + '">' + icon('download') + 'Export CSV</a></div>' +
        (events ? '<table><thead><tr><th>Time</th><th>Kind</th><th>Name</th><th>Platform</th><th>Channel</th><th class="num">Revenue</th></tr></thead><tbody>' + events + '</tbody></table>' : '<p class="muted">Nothing yet.</p>') + '</div>';
    }).catch(function (e) { el.innerHTML = '<p class="error">' + h(e.message) + '</p>'; });
  }

  // ---- links

  function tabLinks(app, el, rest) {
    if (rest[0]) return linkDetail(app, el, rest[0]);
    var base = '/api/apps/' + encodeURIComponent(app.id) + '/links';
    el.innerHTML = '<div class="panel"><h2>Create link</h2><form id="create-link">' +
      '<div class="fields"><div class="field"><label>In-app path <span class="muted">($deeplink_path)</span></label><input name="path" placeholder="product/42"></div>' +
      '<div class="field"><label>Alias <span class="muted">(optional vanity path)</span></label><input name="alias" placeholder="summer-sale"></div>' +
      '<div class="field"><label>Channel</label><input name="channel" placeholder="whatsapp"></div>' +
      '<div class="field"><label>Campaign</label><input name="campaign" placeholder="summer"></div>' +
      '<div class="field"><label>Feature</label><input name="feature" placeholder="referral"></div>' +
      '<div class="field"><label>Tags <span class="muted">(comma separated)</span></label><input name="tags"></div>' +
      '<div class="field"><label>Preview title <span class="muted">($og_title)</span></label><input name="og_title"></div>' +
      '<div class="field"><label>Preview image URL <span class="muted">($og_image_url)</span></label><input name="og_image" type="url"></div>' +
      '<div class="field"><label>Desktop URL <span class="muted">($desktop_url)</span></label><input name="desktop" type="url"></div>' +
      '<div class="field"><label>iOS web fallback <span class="muted">($ios_url)</span></label><input name="ios_url" type="url"></div>' +
      '<div class="field"><label>Android web fallback <span class="muted">($android_url)</span></label><input name="android_url" type="url"></div>' +
      '<div class="field"><label>Preview description <span class="muted">($og_description)</span></label><input name="og_description"></div></div>' +
      '<div class="field"><label>Custom data <span class="muted">(JSON delivered to the app)</span></label><textarea name="data" placeholder=\'{"product_id": "42"}\'></textarea></div>' +
      '<label class="check"><input type="checkbox" class="switch" name="web_only"> Web only <span class="muted">($web_only — never opens the app)</span></label>' +
      '<div class="row" style="margin-top:20px"><button>' + icon('link') + 'Create link</button></div><p class="error"></p></form><div id="created"></div></div>' +
      '<div class="panel table-wrap"><div class="row spread"><h2>Links</h2><input id="search" type="search" placeholder="Search links…" aria-label="Search links" style="max-width:260px"></div><div id="list" class="muted">Loading…</div></div>';

    function load(search) {
      api('GET', base + '?limit=100' + (search ? '&search=' + encodeURIComponent(search) : '')).then(function (res) {
        var rows = res.links.map(function (l) {
          return '<tr><td><a class="mono" href="#/apps/' + h(app.id) + '/links/' + h(l.code) + '">/' + h(l.code) + '</a>' + (l.disabled ? ' <span class="badge gray">disabled</span>' : '') + '</td>' +
            '<td class="small mono">' + h(l.data.$deeplink_path || '') + '</td><td>' + h(l.channel || '') + '</td><td>' + h(l.campaign || '') + '</td>' +
            '<td><span class="badge gray">' + h(l.source) + '</span></td><td class="small muted">' + h(fmtDate(l.created_at)) + '</td>' +
            '<td class="num">' + copyButton(l.url, 'Copy', 'ghost') + '</td></tr>';
        }).join('');
        var list = el.querySelector('#list');
        list.className = rows ? '' : 'muted';
        list.innerHTML = rows ? '<table><thead><tr><th>Link</th><th>Path</th><th>Channel</th><th>Campaign</th><th>Source</th><th>Created</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>' : '<p>No links yet.</p>';
      });
    }
    load('');
    var timer;
    el.querySelector('#search').addEventListener('input', function (e) { clearTimeout(timer); timer = setTimeout(function () { load(e.target.value.trim()); }, 250); });

    el.querySelector('#create-link').addEventListener('submit', function (e) {
      e.preventDefault();
      var f = e.target;
      var data;
      try { data = f.data.value.trim() ? JSON.parse(f.data.value) : {}; } catch (err) { return formError(f, new Error('Custom data must be valid JSON')); }
      var map = { path: '$deeplink_path', og_title: '$og_title', og_description: '$og_description', og_image: '$og_image_url', desktop: '$desktop_url', ios_url: '$ios_url', android_url: '$android_url' };
      Object.keys(map).forEach(function (k) { if (f[k].value.trim()) data[map[k]] = f[k].value.trim(); });
      if (f.web_only.checked) data.$web_only = 'true';
      var body = { data: data, alias: f.alias.value.trim() || undefined, channel: f.channel.value.trim() || undefined, campaign: f.campaign.value.trim() || undefined,
        feature: f.feature.value.trim() || undefined, tags: f.tags.value.split(',').map(function (t) { return t.trim(); }).filter(Boolean) };
      api('POST', base, body).then(function (res) {
        f.reset();
        f.querySelector('.error').textContent = '';
        el.querySelector('#created').innerHTML = '<div class="secret row spread" style="margin-top:16px"><span class="mono">' + h(res.link.url) + '</span>' + copyButton(res.link.url) + '</div>';
        load('');
      }).catch(function (err) { formError(f, err); });
    });
  }

  function linkDetail(app, el, code) {
    var base = '/api/apps/' + encodeURIComponent(app.id) + '/links/' + encodeURIComponent(code);
    el.innerHTML = '<p class="muted">Loading…</p>';
    api('GET', base + '/stats?days=90').then(function (res) {
      var l = res.link, s = res.stats, c = s.counts;
      var routes = s.routes.map(function (r) { return '<tr><td class="mono small">' + h(r.route) + '</td><td>' + h(r.os || '') + '</td><td class="num">' + num(r.n) + '</td></tr>'; }).join('');
      var qr = '/v1/qr?format=svg&url=' + encodeURIComponent(l.url);
      el.innerHTML = '<p><a class="btn ghost sm" href="#/apps/' + h(app.id) + '/links">' + icon('back') + 'All links</a></p>' +
        '<div class="panel"><div class="row spread"><div><h2 class="mono" style="margin-bottom:4px">' + h(l.url) + '</h2><p class="muted small" style="margin:0">Created ' + h(fmtDate(l.created_at)) + ' · ' + h(l.source) +
        (l.disabled ? ' · <span class="badge gray">disabled</span>' : '') + '</p></div>' +
        '<div class="row">' + copyButton(l.url) + '<button type="button" class="outline sm" id="toggle">' + (l.disabled ? 'Enable' : 'Disable') + '</button>' +
        '<button type="button" class="danger sm" id="delete">Delete</button></div></div>' +
        '<div class="row" style="align-items:flex-start;gap:24px"><div class="qr"><img src="' + h(qr) + '" alt="QR code"><div class="small"><a href="' + h(qr.replace('format=svg', 'format=png')) + '" download>PNG</a> · <a href="' + h(qr) + '" download>SVG</a></div></div>' +
        '<div style="flex:1;min-width:min(100%,260px)"><h3>Link data</h3><pre>' + h(JSON.stringify(l.data, null, 2)) + '</pre></div></div></div>' +
        '<div class="grid">' + [['Clicks', c.click], ['Installs', (c.install || 0) + (c.reinstall || 0)], ['Opens', c.open], ['Web sessions', c.web_open], ['Events', c.event], ['Revenue', s.revenue]]
          .map(function (st) { return '<div class="stat"><div class="label">' + st[0] + '</div><div class="value">' + num(st[1]) + '</div></div>'; }).join('') + '</div>' +
        '<div class="panel"><h2>Last 90 days</h2>' + chart(s.timeseries, ['click', 'install', 'open'], CHART_COLORS) + '</div>' +
        '<div class="panel table-wrap"><h2>How clicks were routed</h2>' + (routes ? '<table><thead><tr><th>Decision</th><th>Platform</th><th class="num">Clicks</th></tr></thead><tbody>' + routes + '</tbody></table>' : '<p class="muted">No clicks yet.</p>') + '</div>';
      el.querySelector('#toggle').addEventListener('click', function () {
        api('PATCH', base, { disabled: !l.disabled }).then(function () { linkDetail(app, el, code); });
      });
      el.querySelector('#delete').addEventListener('click', function () {
        confirmDialog('Delete this link?', 'Existing shares will fall back to the app defaults.', 'Delete link', true).then(function (ok) {
          if (ok) api('DELETE', base).then(function () { location.hash = '#/apps/' + app.id + '/links'; });
        });
      });
    }).catch(function (e) { el.innerHTML = '<p class="error">' + h(e.message) + '</p>'; });
  }

  // ---- settings

  var SETTINGS = [
    ['General', [['name', 'App name'], ['desktopUrl', 'Desktop URL', 'url', 'Where desktop clicks go'], ['fallbackUrl', 'Fallback URL', 'url', 'Other platforms / no app'], ['matchWindowSec', 'Deferred match window (seconds)', 'number']]],
    ['iOS', [['ios.teamId', 'Apple Team ID'], ['ios.bundleIds', 'Bundle IDs', 'list', 'comma separated'], ['ios.appStoreId', 'App Store ID', 'text', 'numbers only'], ['ios.uriScheme', 'URI scheme', 'text', 'e.g. myapp'],
      ['ios.deepview', 'Interstitial', 'select:nativelink=Copy-link interstitial (deterministic deferred deep links),none=Go straight to the App Store'], ['ios.appStoreUrl', 'Custom App Store URL', 'url'], ['ios.redirectUrl', 'Web URL when not on the App Store', 'url']]],
    ['Android', [['android.packageName', 'Package name'], ['android.sha256Fingerprints', 'SHA-256 signing fingerprints', 'lines', 'one per line (Play App Signing + upload key)'], ['android.uriScheme', 'URI scheme'],
      ['android.playStoreUrl', 'Custom Play Store URL', 'url'], ['android.redirectUrl', 'Web URL when not on Google Play', 'url']]],
    ['Link previews', [['og.title', 'Default title'], ['og.description', 'Default description'], ['og.imageUrl', 'Default image URL', 'url']]],
    ['Smart banner (Web SDK)', [['banner.enabled', 'Show smart banner on mobile web', 'bool'], ['banner.title', 'Title'], ['banner.subtitle', 'Subtitle'], ['banner.iconUrl', 'Icon URL', 'url'],
      ['banner.buttonText', 'Button text'], ['banner.dismissDays', 'Hide after dismiss (days)', 'number'], ['banner.theme', 'Theme', 'select:light=Light,dark=Dark']]],
  ];

  function tabSettings(app, el) {
    var source = { name: app.name };
    Object.keys(app.config).forEach(function (k) { source[k] = app.config[k]; });
    var readOnly = state.user.role === 'member';
    var html = '<form id="settings">' + SETTINGS.map(function (section) {
      return '<div class="panel"><h2>' + section[0] + '</h2><div class="fields">' + section[1].map(function (f) {
        var path = f[0], type = f[2] || 'text', hint = f[3] ? ' <span class="muted">(' + h(f[3]) + ')</span>' : '';
        var value = getPath(source, path);
        if (type === 'bool') return '<div class="field"><label class="check"><input type="checkbox" class="switch" data-path="' + path + '" data-type="bool"' + (value ? ' checked' : '') + '> ' + h(f[1]) + '</label></div>';
        if (type.indexOf('select:') === 0) {
          var opts = type.slice(7).split(',').map(function (o) { var kv = o.split('='); return '<option value="' + h(kv[0]) + '"' + (kv[0] === value ? ' selected' : '') + '>' + h(kv[1]) + '</option>'; }).join('');
          return '<div class="field"><label>' + h(f[1]) + hint + '</label><select data-path="' + path + '">' + opts + '</select></div>';
        }
        if (type === 'lines') return '<div class="field"><label>' + h(f[1]) + hint + '</label><textarea data-path="' + path + '" data-type="lines">' + h((value || []).join('\n')) + '</textarea></div>';
        var shown = type === 'list' ? (value || []).join(', ') : (value == null ? '' : value);
        return '<div class="field"><label>' + h(f[1]) + hint + '</label><input data-path="' + path + '" data-type="' + type + '" type="' + (type === 'number' ? 'number' : type === 'url' ? 'url' : 'text') + '" value="' + h(shown) + '"></div>';
      }).join('') + '</div></div>';
    }).join('') + (readOnly ? '<p class="muted">Members can view settings; ask an admin to change them.</p>' : '<button>Save settings</button>') + '<p class="error"></p></form>';
    el.innerHTML = html;
    if (readOnly) { $all('#settings input, #settings select, #settings textarea').forEach(function (i) { i.disabled = true; }); return; }
    el.querySelector('#settings').addEventListener('submit', function (e) {
      e.preventDefault();
      var out = {};
      $all('[data-path]').forEach(function (input) {
        var type = input.getAttribute('data-type');
        var value = type === 'bool' ? input.checked
          : type === 'number' ? (input.value === '' ? undefined : Number(input.value))
          : type === 'list' ? input.value.split(',').map(function (s) { return s.trim(); }).filter(Boolean)
          : type === 'lines' ? input.value.split('\n').map(function (s) { return s.trim(); }).filter(Boolean)
          : (input.value.trim() || null);
        setPath(out, input.getAttribute('data-path'), value);
      });
      var name = out.name;
      delete out.name;
      api('PATCH', '/api/apps/' + encodeURIComponent(app.id), { name: name, config: out }).then(function () { toast('Settings saved'); })
        .catch(function (err) { formError(e.target, err); });
    });
  }

  // ---- domains

  function tabDomains(app, el) {
    var primary = app.domains.filter(function (d) { return d.kind === 'primary'; }).map(function (d) { return d.host; }).join('\n');
    var alternate = app.domains.filter(function (d) { return d.kind === 'alternate'; }).map(function (d) { return d.host; })[0] || '';
    el.innerHTML = '<form id="domains" class="panel"><h2>Link domains</h2><p class="muted">Use a pair of free Worker hostnames per app, e.g. twig.&lt;account&gt;.workers.dev as primary and twig-alt.&lt;account&gt;.workers.dev as alternate (or custom domains routed to the Worker). The alternate domain gives iOS Universal Links a second chance from the interstitial page.</p>' +
      '<div class="fields"><div class="field"><label>Primary domains <span class="muted">(one per line; the first is used in new links)</span></label><textarea name="primary">' + h(primary) + '</textarea></div>' +
      '<div class="field"><label>Alternate domain</label><input name="alternate" value="' + h(alternate) + '"></div></div><button>Save domains</button><p class="error"></p></form>' +
      '<div class="panel"><h2>Association files</h2><p class="muted">Served automatically at <code>/.well-known/apple-app-site-association</code> and <code>/.well-known/assetlinks.json</code> on every domain above. Fill in iOS and Android details in Settings first.</p><div id="assoc">Loading…</div></div>';
    el.querySelector('#domains').addEventListener('submit', function (e) {
      e.preventDefault();
      var f = e.target;
      var domains = f.primary.value.split('\n').map(function (s) { return s.trim(); }).filter(Boolean).map(function (host) { return { host: host, kind: 'primary' }; });
      if (f.alternate.value.trim()) domains.push({ host: f.alternate.value.trim(), kind: 'alternate' });
      api('POST', '/api/apps/' + encodeURIComponent(app.id) + '/domains', { domains: domains }).then(function () { toast('Domains saved'); route(); })
        .catch(function (err) { formError(f, err); });
    });
    api('GET', '/api/apps/' + encodeURIComponent(app.id) + '/association').then(function (res) {
      el.querySelector('#assoc').innerHTML = '<h3>apple-app-site-association</h3><pre>' + h(JSON.stringify(res.apple_app_site_association, null, 2)) + '</pre>' +
        '<h3>assetlinks.json</h3><pre>' + h(JSON.stringify(res.assetlinks, null, 2)) + '</pre>';
    });
  }

  // ---- webhooks

  var EVENTS = ['click', 'install', 'reinstall', 'open', 'web_open', 'event', 'link_created'];

  function tabWebhooks(app, el) {
    var base = '/api/apps/' + encodeURIComponent(app.id);
    el.innerHTML = '<form id="hook" class="panel"><h2>Add webhook</h2><div class="field"><label>Endpoint URL</label><input name="url" type="url" required placeholder="https://api.example.com/twig-webhook"></div>' +
      '<label>Events</label><div class="checks">' + EVENTS.map(function (ev) { return '<label class="check"><input type="checkbox" name="ev" value="' + ev + '" checked> <span class="mono">' + ev + '</span></label>'; }).join('') + '</div>' +
      '<p class="muted small">Each request carries <code>X-Twig-Signature: t=&lt;unix&gt;,v1=&lt;hex&gt;</code> = HMAC-SHA256(secret, "&lt;t&gt;.&lt;body&gt;"). Failed deliveries retry with backoff for ~24 hours.</p>' +
      '<button>Add webhook</button><p class="error"></p></form><div class="panel table-wrap"><h2>Webhooks</h2><div id="hooks">Loading…</div></div><div class="panel table-wrap"><h2>Recent deliveries</h2><div id="deliveries"></div></div>';
    function load() {
      api('GET', base + '/webhooks').then(function (res) {
        var rows = res.webhooks.map(function (w) {
          return '<tr><td class="mono small">' + h(w.url) + '</td><td class="small">' + h(w.events.join(', ')) + '</td><td>' + (w.active ? '<span class="badge">active</span>' : '<span class="badge gray">paused</span>') + '</td>' +
            '<td class="num"><div class="row" style="justify-content:flex-end;gap:4px;flex-wrap:nowrap">' + copyButton(w.secret, 'Secret', 'ghost') +
            '<button type="button" class="ghost sm" data-toggle="' + h(w.id) + '" data-active="' + (w.active ? 1 : 0) + '">' + (w.active ? 'Pause' : 'Resume') + '</button>' +
            '<button type="button" class="ghost sm" data-del="' + h(w.id) + '">Delete</button></div></td></tr>';
        }).join('');
        el.querySelector('#hooks').innerHTML = rows ? '<table><thead><tr><th>Endpoint</th><th>Events</th><th>Status</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>' : '<p class="muted">No webhooks.</p>';
        $all('[data-toggle]').forEach(function (b) {
          b.addEventListener('click', function () { api('PATCH', base + '/webhooks/' + b.getAttribute('data-toggle'), { active: b.getAttribute('data-active') !== '1' }).then(load); });
        });
        $all('[data-del]').forEach(function (b) {
          b.addEventListener('click', function () {
            confirmDialog('Delete this webhook?', 'Twig stops sending events to this endpoint immediately.', 'Delete webhook', true).then(function (ok) {
              if (ok) api('DELETE', base + '/webhooks/' + b.getAttribute('data-del')).then(load);
            });
          });
        });
      });
      api('GET', base + '/webhook-deliveries').then(function (res) {
        var rows = res.deliveries.map(function (d) {
          return '<tr><td class="small muted">' + h(fmtDate(d.created_at)) + '</td><td class="mono small">' + h(d.url) + '</td><td><span class="badge' + (d.status === 'delivered' ? '' : ' gray') + '">' + h(d.status) + '</span></td><td class="num">' + h(d.attempts) + '</td><td class="small">' + h(d.last_error || '') + '</td></tr>';
        }).join('');
        el.querySelector('#deliveries').innerHTML = rows ? '<table><thead><tr><th>Time</th><th>URL</th><th>Status</th><th class="num">Attempts</th><th>Last error</th></tr></thead><tbody>' + rows + '</tbody></table>' : '<p class="muted">No deliveries yet.</p>';
      });
    }
    load();
    el.querySelector('#hook').addEventListener('submit', function (e) {
      e.preventDefault();
      var f = e.target;
      var events = $all('#hook input[name=ev]:checked').map(function (c) { return c.value; });
      api('POST', base + '/webhooks', { url: f.url.value, events: events.length === EVENTS.length ? ['*'] : events }).then(function () { f.reset(); load(); })
        .catch(function (err) { formError(f, err); });
    });
  }

  // ---- integrate

  function tabIntegrate(app, el) {
    var origin = location.origin;
    var domains = app.domains.map(function (d) { return d.host; });
    var primary = primaryDomain(app) || 'links.example.com';
    var domainList = (domains.length ? domains : ['links.example.com']);
    var scheme = app.config.ios.uriScheme || app.config.android.uriScheme || 'myapp';
    var flutter = "import 'package:twig_links/twig_links.dart';\n\nawait TwigLinks.instance.init(TwigConfig(\n  publicKey: '" + app.public_key + "',\n  apiUrl: Uri.parse('" + origin + "'),\n  linkDomains: " + JSON.stringify(domainList).replace(/"/g, "'") + ",\n  checkPasteboardOnInstall: true, // iOS deterministic deferred deep links\n));\n\nTwigLinks.instance.sessions.listen((session) {\n  if (session.clickedLink && session.deeplinkPath != null) {\n    // navigate to session.deeplinkPath\n  }\n});\n\nfinal url = await TwigLinks.instance.createLink(const TwigLinkOptions(\n  data: {r'$deeplink_path': 'product/42', 'product_id': '42'},\n  channel: 'share',\n));";
    var ios = "import TwigLinks\n\n// AppDelegate.application(_:didFinishLaunchingWithOptions:)\nTwig.shared.start(TwigConfig(\n    publicKey: \"" + app.public_key + "\",\n    apiURL: URL(string: \"" + origin + "\")!,\n    linkDomains: " + JSON.stringify(domainList) + ",\n    checkPasteboardOnInstall: true\n), launchOptions: launchOptions)\nTwig.shared.onSession { session in\n    if session.clickedLink, let path = session.deeplinkPath { /* route */ }\n}\n\n// SceneDelegate / SwiftUI\n.onOpenURL { Twig.shared.handle(url: $0) }\n.onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { Twig.shared.handle(userActivity: $0) }";
    var android = "// Application.onCreate\nTwig.init(this, TwigConfig(\n    publicKey = \"" + app.public_key + "\",\n    apiUrl = \"" + origin + "\",\n    linkDomains = listOf(" + domainList.map(function (d) { return '"' + d + '"'; }).join(', ') + "),\n))\nTwig.addSessionListener { session ->\n    if (session.clickedLink) session.deeplinkPath?.let { /* route */ }\n}\n\n// Activity (singleTop / singleTask)\noverride fun onNewIntent(intent: Intent) {\n    super.onNewIntent(intent)\n    Twig.handleIntent(intent)\n}";
    var entitlements = domainList.map(function (d) { return '<string>applinks:' + d + '</string>'; }).join('\n');
    var manifest = '<intent-filter android:autoVerify="true">\n    <action android:name="android.intent.action.VIEW" />\n    <category android:name="android.intent.category.DEFAULT" />\n    <category android:name="android.intent.category.BROWSABLE" />\n' +
      domainList.map(function (d) { return '    <data android:scheme="https" android:host="' + d + '" />'; }).join('\n') + '\n</intent-filter>\n<intent-filter>\n    <action android:name="android.intent.action.VIEW" />\n    <category android:name="android.intent.category.DEFAULT" />\n    <category android:name="android.intent.category.BROWSABLE" />\n    <data android:scheme="' + scheme + '" />\n</intent-filter>';
    var web = '<script src="' + origin + '/sdk/twig.js" defer></script>\n<script>\n  addEventListener("DOMContentLoaded", function () {\n    Twig.init("' + app.public_key + '").then(function (session) {\n      if (session.data["+clicked_link"]) console.log("From link", session.data);\n    });\n    Twig.banner({ data: { $deeplink_path: location.pathname.slice(1) } });\n  });\n</script>';
    var curl = "curl -X POST " + origin + "/api/apps/" + app.id + "/links \\\n  -H 'Authorization: Bearer tw_secret_…' -H 'Content-Type: application/json' \\\n  -d '{\"data\": {\"$deeplink_path\": \"product/42\"}, \"channel\": \"email\", \"campaign\": \"launch\"}'";
    function block(title, code, note) {
      return '<div class="panel"><div class="row spread"><h2>' + title + '</h2>' + copyButton(code) + '</div>' + (note ? '<p class="muted">' + note + '</p>' : '') + '<pre>' + h(code) + '</pre></div>';
    }
    el.innerHTML = '<div class="panel"><h2>Keys</h2><div class="row" style="margin-bottom:12px"><span>Public SDK key:</span><code>' + h(app.public_key) + '</code>' + copyButton(app.public_key, 'Copy', 'ghost') + '</div>' +
      '<div class="row"><span>Secret key:</span><code>' + h(app.secret_hint) + '</code><span class="muted">(server-to-server only)</span>' + (state.user.role !== 'member' ? '<button type="button" class="outline sm" id="rotate">Rotate</button>' : '') + '</div><div id="rotated"></div></div>' +
      block('Flutter', flutter, 'Add <code>twig_links</code> from this repository (<code>sdk/flutter/twig_links</code>) as a path or git dependency.') +
      block('iOS (Swift)', ios, 'Swift Package Manager: add this repository URL. CocoaPods: <code>pod \'TwigLinks\', :git =&gt; …</code>.') +
      block('iOS entitlements — Associated Domains', entitlements, 'Xcode → Signing &amp; Capabilities → Associated Domains.') +
      block('Android (Kotlin)', android, 'Include the <code>twig-links</code> module from <code>sdk/android</code> or publish it to your Maven repository.') +
      block('Android manifest', manifest, 'Inside your launcher <code>&lt;activity&gt;</code>. Register the SHA-256 fingerprints in Settings so App Links verify.') +
      block('Website (Web SDK + smart banner)', web) +
      block('Server API (create links)', curl);
    var rotate = el.querySelector('#rotate');
    if (rotate) rotate.addEventListener('click', function () {
      confirmDialog('Rotate the secret key?', 'The old key stops working immediately. Update your servers with the new key.', 'Rotate key', true).then(function (ok) {
        if (!ok) return;
        api('POST', '/api/apps/' + encodeURIComponent(app.id) + '/rotate-secret').then(function (res) {
          el.querySelector('#rotated').innerHTML = '<p style="margin-top:16px">New secret (shown once):</p><div class="secret row spread"><span class="mono">' + h(res.secret_key) + '</span>' + copyButton(res.secret_key) + '</div>';
        });
      });
    });
  }

  // ------------------------------------------------------------ team

  function renderTeam() {
    view.innerHTML = '<p class="muted">Loading…</p>';
    api('GET', '/api/users').then(function (res) {
      var canManage = state.user.role !== 'member';
      var rows = res.users.map(function (u) {
        return '<tr><td>' + h(u.name) + '</td><td>' + h(u.email) + '</td><td><span class="badge' + (u.role === 'member' ? ' gray' : '') + '">' + h(u.role) + '</span></td>' +
          '<td class="num">' + (canManage && u.role !== 'owner' && u.id !== state.user.id ? '<button type="button" class="ghost sm" data-del="' + h(u.id) + '">Remove</button>' : '') + '</td></tr>';
      }).join('');
      view.innerHTML = '<div class="page-head"><h1>Team</h1><p class="muted">Admins manage apps, domains and members; members create links and view analytics.</p></div>' +
        '<div class="panel table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
        (canManage ? '<form id="add-user" class="panel"><h2>Add member</h2><div class="fields"><div class="field"><label>Name</label><input name="name" required></div>' +
          '<div class="field"><label>Email</label><input name="email" type="email" required></div><div class="field"><label>Temporary password <span class="muted">(10+)</span></label><input name="password" type="password" minlength="10" required autocomplete="new-password"></div>' +
          '<div class="field"><label>Role</label><select name="role"><option value="member">Member</option>' + (state.user.role === 'owner' ? '<option value="admin">Admin</option>' : '') + '</select></div></div><button>Add</button><p class="error"></p></form>' : '') +
        '<form id="password" class="panel"><h2>Change your password</h2><div class="fields"><div class="field"><label>Current password</label><input name="current" type="password" required autocomplete="current-password"></div>' +
        '<div class="field"><label>New password</label><input name="next" type="password" minlength="10" required autocomplete="new-password"></div></div><button>Change password</button><p class="error"></p></form>';
      $all('[data-del]').forEach(function (b) {
        b.addEventListener('click', function () {
          confirmDialog('Remove this member?', 'They lose access to the dashboard immediately.', 'Remove member', true).then(function (ok) {
            if (ok) api('DELETE', '/api/users/' + b.getAttribute('data-del')).then(renderTeam);
          });
        });
      });
      var add = $('#add-user');
      if (add) add.addEventListener('submit', function (e) {
        e.preventDefault();
        var f = e.target;
        api('POST', '/api/users', { name: f.name.value, email: f.email.value, password: f.password.value, role: f.role.value }).then(renderTeam).catch(function (err) { formError(f, err); });
      });
      $('#password').addEventListener('submit', function (e) {
        e.preventDefault();
        var f = e.target;
        api('POST', '/api/auth/password', { current_password: f.current.value, new_password: f.next.value }).then(function () { toast('Password changed — sign in again'); boot(); })
          .catch(function (err) { formError(f, err); });
      });
    }).catch(function (e) { view.innerHTML = '<p class="error">' + h(e.message) + '</p>'; });
  }

  boot();
})();
