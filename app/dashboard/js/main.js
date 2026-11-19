import { boot } from './router.js';

boot().catch((err) => {
  document.getElementById('view').innerHTML =
    `<section class="card"><h2 class="card__title">Dashboard failed to start</h2>
     <p class="card__note" style="margin-top:8px">${String(err && err.message ? err.message : err)}</p></section>`;
});

/* PWA: cache the shell so the desk opens offline. Needs a secure origin
   (https or localhost); elsewhere the browser simply skips registration. */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}
