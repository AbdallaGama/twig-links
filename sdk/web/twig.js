/*!
 * Twig Web SDK — sessions after link redirects, link creation, events and smart banners.
 * Load from your Twig server:  <script src="https://links.example.com/sdk/twig.js" defer></script>
 *
 *   Twig.init('tw_live_…', { apiUrl: 'https://links.example.com' }).then(function (session) {
 *     if (session.data['+clicked_link']) console.log('Arrived from a link', session.data);
 *   });
 *   Twig.banner({ data: { $deeplink_path: 'product/42' } });
 */
(function (global) {
  'use strict';

  var VERSION = '0.1.0';
  var STORE_PREFIX = 'twig_';
  var MATCH_PARAM = '_twig_match_id';
  var state = { key: null, apiUrl: null, session: null, initPromise: null, config: null };

  function storage(key, value) {
    try {
      if (value === undefined) return global.localStorage.getItem(STORE_PREFIX + key);
      if (value === null) global.localStorage.removeItem(STORE_PREFIX + key);
      else global.localStorage.setItem(STORE_PREFIX + key, value);
    } catch (e) { /* private mode */ }
    return null;
  }

  function scriptOrigin() {
    var current = document.currentScript;
    if (current && current.src) return new URL(current.src).origin;
    var scripts = document.querySelectorAll('script[src*="/sdk/twig.js"]');
    return scripts.length ? new URL(scripts[scripts.length - 1].src).origin : global.location.origin;
  }

  function request(method, path, body) {
    var url = state.apiUrl + path;
    var options = { method: method, headers: {}, credentials: 'omit' };
    if (body) {
      options.headers['content-type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    var attempt = function (n) {
      return fetch(url, options).then(function (response) {
        return response.json().catch(function () { return {}; }).then(function (json) {
          if (!response.ok) {
            var error = new Error(json.message || json.error || ('HTTP ' + response.status));
            error.code = json.error;
            error.status = response.status;
            throw error;
          }
          return json;
        });
      }).catch(function (error) {
        var transient = !error.status || error.status >= 500 || error.status === 429;
        if (!transient || n >= 2) throw error;
        return new Promise(function (resolve) { setTimeout(resolve, 300 * Math.pow(2, n)); }).then(function () { return attempt(n + 1); });
      });
    };
    return attempt(0);
  }

  function requireInit() {
    if (!state.key) throw new Error('Call Twig.init(key) first');
  }

  function stripMatchParam() {
    try {
      var url = new URL(global.location.href);
      if (!url.searchParams.has(MATCH_PARAM)) return;
      url.searchParams.delete(MATCH_PARAM);
      global.history.replaceState(global.history.state, '', url.toString());
    } catch (e) { /* ignore */ }
  }

  /** Starts a web session. Claims the link click that redirected here (?_twig_match_id=…). */
  function init(key, options) {
    if (state.initPromise) return state.initPromise;
    options = options || {};
    state.key = key;
    state.apiUrl = (options.apiUrl || scriptOrigin()).replace(/\/+$/, '');
    var matchId = null;
    try { matchId = new URL(global.location.href).searchParams.get(MATCH_PARAM); } catch (e) { /* ignore */ }
    state.initPromise = request('POST', '/v1/web/open', {
      key: key,
      match_id: matchId,
      browser_token: storage('browser_token'),
      identity: storage('identity'),
      url: global.location.href,
      referrer: document.referrer || null,
      sdk: 'web/' + VERSION,
    }).then(function (json) {
      storage('browser_token', json.device_token);
      if (json.data && json.data['+clicked_link']) storage('last_link_data', JSON.stringify(json.data));
      if (options.stripMatchParam !== false) stripMatchParam();
      state.session = { sessionId: json.session_id, data: json.data || {} };
      return state.session;
    });
    return state.initPromise;
  }

  /** Link data that brought this browser here (persisted across page loads). */
  function data() {
    if (state.session && state.session.data['+clicked_link']) return state.session.data;
    var stored = storage('last_link_data');
    try { return stored ? JSON.parse(stored) : {}; } catch (e) { return {}; }
  }

  /** Creates a short link; falls back to a long link on failure. */
  function link(options) {
    requireInit();
    options = options || {};
    var body = { key: state.key, data: options.data || {} };
    ['alias', 'channel', 'feature', 'campaign', 'stage', 'tags'].forEach(function (k) { if (options[k] != null) body[k] = options[k]; });
    return request('POST', '/v1/url', body).then(function (json) { return json.url; }).catch(function () {
      return loadConfig().then(function (config) { return longLink(config.link_domain, options); });
    });
  }

  function longLink(domain, options) {
    var url = new URL('https://' + (domain || new URL(state.apiUrl).host) + '/');
    var dataObj = options.data || {};
    Object.keys(dataObj).forEach(function (k) {
      var v = dataObj[k];
      if (v != null) url.searchParams.set(k, typeof v === 'string' ? v : JSON.stringify(v));
    });
    ['channel', 'feature', 'campaign', 'stage'].forEach(function (k) { if (options[k]) url.searchParams.set('~' + k, options[k]); });
    if (options.tags && options.tags.length) url.searchParams.set('~tags', options.tags.join(','));
    return url.toString();
  }

  function logEvent(name, details) {
    requireInit();
    details = details || {};
    return state.initPromise.then(function () {
      return request('POST', '/v1/event', {
        key: state.key,
        device_token: storage('browser_token'),
        name: name,
        os: 'web',
        revenue: details.revenue,
        currency: details.currency,
        data: details.data,
        content_items: details.contentItems,
      });
    });
  }

  function setIdentity(identity) {
    requireInit();
    storage('identity', identity);
    return state.initPromise.then(function () {
      return request('POST', '/v1/identity', { key: state.key, device_token: storage('browser_token'), identity: identity });
    });
  }

  function logout() {
    return setIdentity(null);
  }

  function qrCodeUrl(linkUrl, format) {
    requireInit();
    return state.apiUrl + '/v1/qr?url=' + encodeURIComponent(linkUrl) + '&format=' + (format || 'svg');
  }

  function loadConfig() {
    if (!state.config) {
      state.config = fetch(state.apiUrl + '/v1/config?key=' + encodeURIComponent(state.key), { credentials: 'omit' })
        .then(function (r) { return r.ok ? r.json() : {}; })
        .catch(function () { return {}; });
    }
    return state.config;
  }

  function platform() {
    var ua = global.navigator.userAgent || '';
    if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && global.navigator.maxTouchPoints > 1)) return 'ios';
    if (/Android/.test(ua)) return 'android';
    return 'desktop';
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /**
   * Smart app banner for mobile web (a light "Journeys"). Uses the dashboard banner settings,
   * overridable per call. The button opens a link carrying `options.data`, so the app opens
   * on the same content — or installs and then opens it (deferred deep link).
   */
  function banner(options) {
    requireInit();
    options = options || {};
    var os = platform();
    if (os === 'desktop' && !options.showOnDesktop) return Promise.resolve(false);
    var dismissedAt = Number(storage('banner_dismissed') || 0);
    return loadConfig().then(function (config) {
      var settings = Object.assign({}, config.banner || {}, options);
      if (!options.force && config.banner && config.banner.enabled === false && !options.title) return false;
      var days = settings.dismissDays == null ? 7 : settings.dismissDays;
      if (dismissedAt && Date.now() - dismissedAt < days * 86400000) return false;
      if (document.getElementById('twig-banner')) return false;
      var data = Object.assign({ $og_title: document.title }, options.data || {});
      return link({ data: data, channel: options.channel || 'web', feature: options.feature || 'smart_banner', campaign: options.campaign })
        .then(function (url) {
          render(settings, url, config);
          return true;
        });
    });
  }

  function render(settings, url, config) {
    var dark = settings.theme === 'dark';
    var root = document.createElement('div');
    root.id = 'twig-banner';
    root.setAttribute('role', 'region');
    root.setAttribute('aria-label', 'Get the app');
    root.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:2147483646;display:flex;align-items:center;gap:12px;padding:10px 12px;' +
      'font:14px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;box-shadow:0 2px 12px rgba(0,0,0,.15);' +
      (dark ? 'background:#181b24;color:#eef0f6;' : 'background:#ffffff;color:#14161f;');
    root.innerHTML =
      '<button type="button" aria-label="Close" data-twig-close style="border:0;background:none;font-size:20px;line-height:1;color:inherit;opacity:.6;cursor:pointer;padding:4px">×</button>' +
      (settings.iconUrl ? '<img src="' + escapeHtml(settings.iconUrl) + '" alt="" style="width:44px;height:44px;border-radius:10px;object-fit:cover">' : '') +
      '<div style="flex:1;min-width:0"><div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + escapeHtml(settings.title || config.name || 'Get the app') + '</div>' +
      (settings.subtitle ? '<div style="opacity:.7;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + escapeHtml(settings.subtitle) + '</div>' : '') + '</div>' +
      '<a href="' + escapeHtml(url) + '" data-twig-open style="background:#1f6feb;color:#fff;text-decoration:none;font-weight:600;padding:8px 14px;border-radius:999px;white-space:nowrap">' + escapeHtml(settings.buttonText || 'Open') + '</a>';
    root.querySelector('[data-twig-close]').addEventListener('click', function () {
      storage('banner_dismissed', String(Date.now()));
      root.remove();
      document.documentElement.style.removeProperty('margin-top');
    });
    document.body.appendChild(root);
    document.documentElement.style.marginTop = root.offsetHeight + 'px';
  }

  global.Twig = {
    version: VERSION,
    init: init,
    data: data,
    link: link,
    logEvent: logEvent,
    setIdentity: setIdentity,
    logout: logout,
    qrCodeUrl: qrCodeUrl,
    banner: banner,
  };
})(typeof window !== 'undefined' ? window : this);
