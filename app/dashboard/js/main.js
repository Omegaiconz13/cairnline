import { boot } from './router.js';

boot().catch((err) => {
  document.getElementById('view').innerHTML =
    `<section class="card"><h2 class="card__title">Dashboard failed to start</h2>
     <p class="card__note" style="margin-top:8px">${String(err && err.message ? err.message : err)}</p></section>`;
});
