/* Rotulus shared behavior: theme + nav/gear dropdowns.
   Loaded with <script defer> on every page.
   Uses event delegation so it keeps working even when pages re-render
   their DOM. The theme storage key stays 'scrollswap_theme' with values
   'light'/'dark' — renaming it would lose everyone's saved preference. */
(function () {
  var THEME_KEY = 'scrollswap_theme';

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

  document.addEventListener('click', function (e) {
    var themeBtn = e.target.closest('.theme-btn');
    if (themeBtn && themeBtn.dataset.theme) {
      applyTheme(themeBtn.dataset.theme, true);
      return;
    }

    var nav = document.getElementById('navDropdown');
    var gear = document.getElementById('gearDropdown');

    if (e.target.closest('#navToggle')) {
      if (gear) gear.classList.remove('open');
      if (nav) nav.classList.toggle('open');
      return;
    }
    if (e.target.closest('#gearToggle')) {
      if (nav) nav.classList.remove('open');
      if (gear) gear.classList.toggle('open');
      return;
    }
    // Clicks inside an open gear dropdown (e.g. logout button) shouldn't close it.
    if (e.target.closest('#gearDropdown')) return;

    if (nav) nav.classList.remove('open');
    if (gear) gear.classList.remove('open');
  });

  document.addEventListener('DOMContentLoaded', function () {
    applyTheme(getTheme(), false);
  });
})();
