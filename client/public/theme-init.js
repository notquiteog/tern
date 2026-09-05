// Runs before first paint so the saved theme applies without a flash.
// Kept as a file rather than an inline script so the page's Content
// Security Policy can stay at script-src 'self'.
(function () {
  try {
    var t = localStorage.getItem('tern.theme') || 'system';
    var dark = t === 'dark' || (t === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    var d = localStorage.getItem('tern.density');
    if (d) document.documentElement.dataset.density = d;
  } catch (e) {}
})();
