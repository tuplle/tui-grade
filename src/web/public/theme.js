// Runs before first paint. Keep the same key/logic in app.js.
(() => {
  const mode = localStorage.getItem('tui-grade-theme') || 'system';
  const dark = mode === 'dark' || (mode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
})();
