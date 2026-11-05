// Applies a saved light/dark choice before the first paint (no flash). A blocked storage just means "automatic".
try {
  const t = localStorage.getItem('pcs-theme');
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
} catch {
  /* storage blocked: follow the system */
}
