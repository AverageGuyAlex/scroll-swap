/* Rotulus shared behavior: theme, gear dropdown, bottom tab bar, swipe nav.
   Loaded with <script defer> on every page except lock-in.html, which is a
   deliberately bare focus screen and pulls in no shared CSS or JS.
   Uses event delegation so it keeps working even when pages re-render
   their DOM. The theme storage key stays 'scrollswap_theme' with values
   'light'/'dark' — renaming it would lose everyone's saved preference. */
(function () {
  var THEME_KEY = 'scrollswap_theme';
  var VT_DIR_KEY = 'rotulus_vt_dir';

  /* ---------------------------------------------------------------- theme */

  function savedTheme() {
    try { return localStorage.getItem(THEME_KEY); } catch (e) { return null; }
  }

  function getTheme() {
    var saved = savedTheme();
    if (saved === 'light' || saved === 'dark') return saved;
    try {
      return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    } catch (e) { return 'light'; }
  }

  function deviceTheme() {
    try {
      return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    } catch (e) { return 'light'; }
  }

  function applyTheme(theme, persist) {
    // 'auto' clears the saved choice and follows the device setting.
    var effective = theme === 'auto' ? deviceTheme() : theme;
    document.documentElement.classList.toggle('theme-dark', effective === 'dark');
    if (persist) {
      try {
        if (theme === 'auto') localStorage.removeItem(THEME_KEY);
        else localStorage.setItem(THEME_KEY, theme);
      } catch (e) {}
    }
    var choice = savedTheme() ? (savedTheme() === 'dark' ? 'dark' : 'light') : 'auto';
    document.querySelectorAll('.theme-btn').forEach(function (b) {
      b.classList.toggle('selected', b.dataset.theme === choice);
    });
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', effective === 'dark' ? '#151020' : '#EDEBF7');
  }

  /* ---- Undo snackbar ---------------------------------------------------
     One at a time: opening a second commits the first, so a rapid series of
     deletes can never leave two pending undos racing each other. */
  var snackEl = null;
  var snackTimer = null;
  var snackCommit = null;

  function closeSnackbar(commit) {
    if (snackTimer) { clearTimeout(snackTimer); snackTimer = null; }
    var commitFn = snackCommit;
    snackCommit = null;
    if (snackEl) snackEl.classList.remove('is-open');
    if (commit && typeof commitFn === 'function') { try { commitFn(); } catch (e) {} }
  }

  function showSnackbar(text, onUndo, onCommit, ms) {
    closeSnackbar(true);   // whatever was pending is now settled
    if (!snackEl) {
      snackEl = document.createElement('div');
      snackEl.className = 'rotulus-snackbar';
      snackEl.setAttribute('role', 'status');
      snackEl.innerHTML = '<span class="rotulus-snackbar-text"></span>' +
        '<button type="button" class="rotulus-snackbar-undo">Undo</button>';
      document.body.appendChild(snackEl);
      snackEl.querySelector('.rotulus-snackbar-undo').addEventListener('click', function () {
        if (snackTimer) { clearTimeout(snackTimer); snackTimer = null; }
        snackCommit = null;                       // undoing means never committing
        snackEl.classList.remove('is-open');
        if (typeof snackEl._undo === 'function') { try { snackEl._undo(); } catch (e) {} }
      });
    }
    snackEl.querySelector('.rotulus-snackbar-text').textContent = text;
    snackEl._undo = onUndo;
    snackCommit = onCommit;
    snackEl.classList.add('is-open');
    snackTimer = setTimeout(function () { closeSnackbar(true); }, ms || 5000);
  }

  /* ---- Offline awareness ------------------------------------------------
     A page opts in by putting <span class="offline-pill">…</span> next to its
     sync note; this only toggles the class and re-runs whatever the page gave
     us to flush when the connection comes back. */
  var onReconnect = null;

  function renderOfflineState() {
    var offline = navigator.onLine === false;
    var pills = document.querySelectorAll('.offline-pill');
    for (var i = 0; i < pills.length; i++) pills[i].classList.toggle('is-offline', offline);
    if (!offline && typeof onReconnect === 'function') {
      try { onReconnect(); } catch (e) {}
    }
  }

  window.addEventListener('online', renderOfflineState);
  window.addEventListener('offline', renderOfflineState);
  document.addEventListener('DOMContentLoaded', renderOfflineState);

  window.rotulus = {
    getTheme: getTheme,
    applyTheme: function (theme) { applyTheme(theme, true); },
    snackbar: showSnackbar,
    onReconnect: function (fn) { onReconnect = fn; renderOfflineState(); },
  };

  // Follow the device setting live, but only while the user hasn't
  // explicitly chosen a theme in Settings.
  try {
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function (e) {
      if (!savedTheme()) applyTheme(e.matches ? 'dark' : 'light', false);
    });
  } catch (e) {}

  /* -------------------------------------------------------------- tab bar */

  /* Single source of truth for the bottom bar: tab order, swipe order,
     prefetch targets and the active highlight all read this one array.
     Lock In and Settings deliberately aren't tabs — Lock In is a mode, not a
     place, and both live in the gear menu (top right) instead.

     Icons are inline SVG rather than emoji so they inherit the active colour
     through currentColor and render identically on iOS/Android/Windows.
     Future swap point: if per-tab artwork ever lands in
     /assets/icons/tab-<name>.png, replace `icon` with an <img> here — same
     convention as the .stat-icon tiles on the dashboard. */
  var SVG = '<svg class="tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';

  var TABS = [
    { file: 'index.html', label: 'Home',
      icon: SVG + '<path d="M3.2 11 12 3.5 20.8 11"/><path d="M5.6 9.6V20a.8.8 0 0 0 .8.8h11.2a.8.8 0 0 0 .8-.8V9.6"/></svg>' },
    { file: 'todo.html', label: 'To-Do',
      icon: SVG + '<path d="M9.5 6.8h10.5M9.5 12h10.5M9.5 17.2h10.5"/><path d="M3.6 6.6 5 8l2.6-2.8M3.6 17 5 18.4l2.6-2.8"/></svg>' },
    { file: 'pomodoro.html', label: 'Pomo',
      icon: SVG + '<circle cx="12" cy="13.2" r="7.8"/><path d="M12 8.8v4.4l3 1.8"/><path d="M9.6 2.6h4.8"/></svg>' },
    { file: 'goals.html', label: 'Goals',
      icon: SVG + '<path d="M6 21V3.4"/><path d="M6 4.4h11.4l-2.6 4 2.6 4H6"/></svg>' },
    { file: 'diary.html', label: 'Diary',
      icon: SVG + '<path d="M12 7.4S10 5.4 4.6 5.4V18c5.4 0 7.4 2 7.4 2s2-2 7.4-2V5.4C14 5.4 12 7.4 12 7.4Z"/><path d="M12 7.4V20"/></svg>' },
    { file: 'dashboard.html', label: 'Stats',
      icon: SVG + '<path d="M5 20v-6.4M12 20V4.6M19 20v-9.2"/></svg>' },
  ];

  /* Netlify's pretty URLs serve the same page at /goals and /goals.html, and
     the home page at /. Match on the bare name so the bar highlights and the
     swipe works whichever form the URL took — landing on /goals used to leave
     the bar with nothing active and the swipe completely dead. */
  function currentPageName() {
    var path = location.pathname;
    var file = path.substring(path.lastIndexOf('/') + 1).toLowerCase();
    return file.replace(/\.html$/, '') || 'index';
  }

  function currentTabIndex() {
    var name = currentPageName();
    for (var i = 0; i < TABS.length; i++) {
      if (TABS[i].file.replace(/\.html$/, '') === name) return i;
    }
    return -1; // settings and anything else: bar shows, nothing active
  }

  function buildTabBar() {
    if (!document.body || document.querySelector('.tabbar')) return;
    var active = currentTabIndex();
    var nav = document.createElement('nav');
    nav.className = 'tabbar';
    nav.setAttribute('aria-label', 'Main');
    nav.innerHTML = TABS.map(function (tab, i) {
      var isActive = i === active;
      return '<a class="tab' + (isActive ? ' active' : '') + '" href="' + tab.file + '"' +
        (isActive ? ' aria-current="page"' : '') + '>' +
        '<span class="tab-icon-wrap">' + tab.icon + '</span>' +
        '<span class="tab-label">' + tab.label + '</span>' +
        '</a>';
    }).join('');
    document.body.appendChild(nav);
  }

  /* Warm the two neighbours so a swipe does not wait on the network. Only the
     neighbours — prefetching all six would cost six requests per page view to
     save one. This needs the html Cache-Control in netlify.toml to be
     'no-cache' (revalidate) rather than 'no-store' (never keep a copy). */
  function prefetchNeighbours() {
    var i = currentTabIndex();
    if (i === -1) return;
    [TABS[i - 1], TABS[i + 1]].forEach(function (tab) {
      if (!tab) return;
      var link = document.createElement('link');
      link.rel = 'prefetch';
      link.href = tab.file;
      document.head.appendChild(link);
    });
  }

  /* ------------------------------------------------------------ swipe nav */

  /* A drag, not a flick-and-guess. #app tracks the finger 1:1, resists at the
     ends of the tab list, and on release either springs back or flings the
     rest of the way and navigates.

     Rotulus is a multi-page app, so committing a drag is a real navigation.
     By the time we navigate #app is already off-screen, so the outgoing
     snapshot is nothing but the shared blob background — rotulus.css holds it
     still and slides the incoming page in over it, which reads as one
     continuous motion. Direction rides in sessionStorage and is read into
     data-vt-dir by the next page's pre-paint <head> snippet. Tapping a tab
     deliberately leaves the key unset, giving a plain cross-fade.

     The gesture never calls preventDefault(): #app carries
     touch-action: pan-y, so the browser keeps vertical scrolling and hands us
     horizontal movement without a fight. That keeps every listener passive. */
  var EDGE_GUARD = 24;        // px: leave the OS back-swipe zone alone
  var LOCK_SLOP = 10;         // px of travel before we decide the axis
  var COMMIT_FRACTION = 0.30; // of viewport width
  var FLICK_VELOCITY = 0.5;   // px/ms — a fast throw commits from further back
  var FLICK_FRACTION = 0.15;  // ...but it still has to have gone somewhere
  var END_RESISTANCE = 0.3;   // rubber band past the first/last tab
  var NO_SWIPE_SEL = 'input, textarea, select, [contenteditable], [data-no-swipe]';

  var drag = null;
  var appEl = null;

  function app() {
    if (!appEl) appEl = document.getElementById('app');
    return appEl;
  }

  function navigateTo(index, dir) {
    var tab = TABS[index];
    if (!tab) return;
    try { sessionStorage.setItem(VT_DIR_KEY, dir); } catch (e) {}
    location.href = tab.file;
  }

  function setOffset(px) {
    var el = app();
    if (el) el.style.transform = 'translate3d(' + px + 'px, 0, 0)';
  }

  function clearDragStyles(el) {
    el.style.transition = '';
    el.style.transform = '';
    el.style.willChange = '';
  }

  /* Ease back to rest. Kept off the compositor hints once it lands so the page
     isn't left permanently promoted to its own layer. */
  function springBack() {
    var el = app();
    if (!el) return;
    el.style.transition = 'transform 0.24s cubic-bezier(0.2, 0.9, 0.3, 1)';
    setOffset(0);
    setTimeout(function () { clearDragStyles(el); }, 260);
  }

  function commit(index, dir, velocity) {
    var el = app();
    var width = window.innerWidth || document.documentElement.clientWidth;
    if (!el) { navigateTo(index, dir); return; }
    // Match the fling to how hard it was thrown, within sane bounds.
    var ms = Math.max(120, Math.min(220, 180 / Math.max(0.5, velocity)));
    el.style.transition = 'transform ' + ms + 'ms cubic-bezier(0.3, 0, 0.2, 1)';
    setOffset(dir === 'forward' ? -width : width);
    setTimeout(function () { navigateTo(index, dir); }, ms);
  }

  function gestureBlocked() {
    if (document.querySelector('.gear-dropdown.open')) return true;
    var el = document.activeElement;
    return !!(el && el.closest && el.closest(NO_SWIPE_SEL));
  }

  document.addEventListener('touchstart', function (e) {
    if (e.touches.length !== 1) { drag = null; return; }
    if (currentTabIndex() === -1) return; // settings isn't in the swipe order
    var t = e.touches[0];
    var width = window.innerWidth || document.documentElement.clientWidth;
    if (t.clientX < EDGE_GUARD || t.clientX > width - EDGE_GUARD) { drag = null; return; }
    if (e.target && e.target.closest && e.target.closest(NO_SWIPE_SEL)) { drag = null; return; }
    if (gestureBlocked()) { drag = null; return; }
    drag = {
      x: t.clientX, y: t.clientY, at: Date.now(),
      lastX: t.clientX, lastAt: Date.now(), velocity: 0,
      axis: 'undecided', offset: 0,
    };
  }, { passive: true });

  document.addEventListener('touchmove', function (e) {
    if (!drag) return;
    if (e.touches.length > 1) { // a second finger means zoom, not a swipe
      if (drag.axis === 'horizontal') springBack();
      drag = null;
      return;
    }

    var t = e.touches[0];
    var dx = t.clientX - drag.x;
    var dy = t.clientY - drag.y;

    if (drag.axis === 'undecided') {
      if (Math.abs(dy) > LOCK_SLOP && Math.abs(dy) > Math.abs(dx)) {
        drag = null; // vertical: hand the gesture back to the browser for good
        return;
      }
      if (Math.abs(dx) > LOCK_SLOP && Math.abs(dx) > Math.abs(dy)) {
        drag.axis = 'horizontal';
        var el = app();
        if (el) { el.style.transition = 'none'; el.style.willChange = 'transform'; }
      } else {
        return; // not enough travel to call it yet
      }
    }

    // Rolling velocity from the most recent movement, for the flick test.
    var now = Date.now();
    var dt = now - drag.lastAt;
    if (dt > 0) drag.velocity = (t.clientX - drag.lastX) / dt;
    drag.lastX = t.clientX;
    drag.lastAt = now;

    // Resist past the first and last tab so the end of the list is felt.
    var index = currentTabIndex();
    var atStart = index === 0 && dx > 0;
    var atEnd = index === TABS.length - 1 && dx < 0;
    drag.offset = (atStart || atEnd) ? dx * END_RESISTANCE : dx;
    setOffset(drag.offset);
  }, { passive: true });

  function abortDrag() {
    if (drag && drag.axis === 'horizontal') springBack();
    drag = null;
  }

  document.addEventListener('touchcancel', abortDrag, { passive: true });
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) abortDrag();
  });

  document.addEventListener('touchend', function () {
    var d = drag;
    drag = null;
    if (!d || d.axis !== 'horizontal') return;

    var index = currentTabIndex();
    if (index === -1) { springBack(); return; }

    var width = window.innerWidth || document.documentElement.clientWidth;
    var travelled = Math.abs(d.offset) / width;
    var speed = Math.abs(d.velocity);
    var forward = d.offset < 0;
    var target = forward ? index + 1 : index - 1;

    // No wrap-around: the ends are dead stops, like a native tab bar.
    if (target < 0 || target >= TABS.length) { springBack(); return; }

    var farEnough = travelled > COMMIT_FRACTION;
    var thrown = speed > FLICK_VELOCITY && travelled > FLICK_FRACTION &&
                 (forward ? d.velocity < 0 : d.velocity > 0);

    if (farEnough || thrown) commit(target, forward ? 'forward' : 'back', speed);
    else springBack();
  }, { passive: true });

  /* ------------------------------------------------------------- dropdown */

  document.addEventListener('click', function (e) {
    var themeBtn = e.target.closest('.theme-btn');
    if (themeBtn && themeBtn.dataset.theme) {
      applyTheme(themeBtn.dataset.theme, true);
      return;
    }

    var gear = document.getElementById('gearDropdown');

    if (e.target.closest('#gearToggle')) {
      if (gear) gear.classList.toggle('open');
      return;
    }
    // Clicks inside an open gear dropdown (e.g. logout button) shouldn't close it.
    if (e.target.closest('#gearDropdown')) return;

    if (gear) gear.classList.remove('open');
  });

  /* ------------------------------------------------------- header artwork */

  /* This used to be an inline onerror="" attribute on every page's
     <img class="header-art">. It moved here so script-src in the CSP can be a
     plain hash list: an inline event handler needs 'unsafe-hashes', which would
     hand an injected onerror the same permission and defeat the whole point.

     Order matters. This file is deferred, so a missing image may ALREADY have
     failed by the time we run, and 'error' does not fire again for it — hence
     the complete/naturalWidth check first. assets/header-illustration.png is
     genuinely absent today, so this path runs on every page load. */
  function hideMissingArt() {
    var arts = document.querySelectorAll('.header-art');
    for (var i = 0; i < arts.length; i++) {
      (function (img) {
        if (img.complete && img.naturalWidth === 0) { img.style.display = 'none'; return; }
        img.addEventListener('error', function () { img.style.display = 'none'; });
      })(arts[i]);
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    applyTheme(getTheme(), false);
    buildTabBar();
    hideMissingArt();
  });

  /* Registered from here so every page installs it, though only the pomodoro
     page uses it — for the completion banner. See sw.js: no push, no fetch
     handler, no caching. */
  function registerServiceWorker() {
    if (!navigator.serviceWorker) return;
    navigator.serviceWorker.register('/sw.js').catch(function () {});
  }

  window.addEventListener('load', prefetchNeighbours);
  window.addEventListener('load', registerServiceWorker);
})();
