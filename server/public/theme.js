/* Applies the saved color theme before first paint. A separate file because the CSP blocks inline scripts. */
(function () {
  var theme = null;
  try { theme = localStorage.getItem('twig-theme'); } catch (e) { /* storage blocked: follow the system */ }
  if (theme === 'light' || theme === 'dark') document.documentElement.setAttribute('data-theme', theme);
})();
