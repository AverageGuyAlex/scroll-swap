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

  window.rotulus = {
    getTheme: getTheme,
    applyTheme: function (theme) { applyTheme(theme, true); },
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

  function currentFile() {
    var path = location.pathname;
    var file = path.substring(path.lastIndexOf('/') + 1).toLowerCase();
    return file || 'index.html';
  }

  function currentTabIndex() {
    var file = currentFile();
    for (var i = 0; i < TABS.length; i++) {
      if (TABS[i].file === file) return i;
    }
    return -1; // settings.html and anything else: bar shows, nothing active
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

  /* Rotulus is a multi-page app, so a swipe is a real navigation rather than a
     slide inside one shell. The directional animation is handed to the
     browser's cross-document View Transitions: we stash which way we are going
     in sessionStorage, and the next page's pre-paint <head> snippet reads it
     into data-vt-dir before first paint. Tapping a tab deliberately leaves the
     key unset, which gives a plain cross-fade instead of a slide. */
  var EDGE_GUARD = 24;     // px: leave the OS back-swipe zone alone
  var MIN_DISTANCE = 60;   // px of horizontal travel before it counts
  var MAX_DURATION = 600;  // ms: a slow drag is not a swipe
  var NO_SWIPE_SEL = 'input, textarea, select, [contenteditable], [data-no-swipe]';

  var swipe = null;

  function navigateTo(index, dir) {
    var tab = TABS[index];
    if (!tab) return;
    try { sessionStorage.setItem(VT_DIR_KEY, dir); } catch (e) {}
    location.href = tab.file;
  }

  function swipeBlocked() {
    if (document.querySelector('.gear-dropdown.open')) return true;
    var el = document.activeElement;
    return !!(el && el.closest && el.closest(NO_SWIPE_SEL));
  }

  document.addEventListener('touchstart', function (e) {
    if (e.touches.length !== 1) { swipe = null; return; }
    var t = e.touches[0];
    var width = window.innerWidth || document.documentElement.clientWidth;
    if (t.clientX < EDGE_GUARD || t.clientX > width - EDGE_GUARD) { swipe = null; return; }
    if (e.target && e.target.closest && e.target.closest(NO_SWIPE_SEL)) { swipe = null; return; }
    swipe = { x: t.clientX, y: t.clientY, at: Date.now(), multi: false };
  }, { passive: true });

  document.addEventListener('touchmove', function (e) {
    if (swipe && e.touches.length > 1) swipe.multi = true;
  }, { passive: true });

  document.addEventListener('touchcancel', function () { swipe = null; }, { passive: true });

  document.addEventListener('touchend', function (e) {
    var start = swipe;
    swipe = null;
    if (!start || start.multi) return;
    if (Date.now() - start.at > MAX_DURATION) return;

    var t = e.changedTouches && e.changedTouches[0];
    if (!t) return;
    var dx = t.clientX - start.x;
    var dy = t.clientY - start.y;
    // Mostly-horizontal only, so scrolling a long list never navigates.
    if (Math.abs(dx) < MIN_DISTANCE || Math.abs(dx) <= Math.abs(dy) * 2) return;
    if (swipeBlocked()) return;

    var index = currentTabIndex();
    if (index === -1) return; // settings.html is not in the swipe order

    // No wrap-around: the ends are dead stops, like a native tab bar.
    if (dx < 0 && index < TABS.length - 1) navigateTo(index + 1, 'forward');
    else if (dx > 0 && index > 0) navigateTo(index - 1, 'back');
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

  document.addEventListener('DOMContentLoaded', function () {
    applyTheme(getTheme(), false);
    buildTabBar();
  });

  window.addEventListener('load', prefetchNeighbours);
})();
