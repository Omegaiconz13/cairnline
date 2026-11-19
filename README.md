# Cairnline

A faithful, editable reconstruction of the Cairnline AI web product: a public
marketing site plus a signed-in trading dashboard (chart analysis, pulse
signals, bot management, wallet, subscription, EA marketplace). Vanilla HTML/CSS/JS,
no build step.

## Structure

- `app/` — static site served as-is (`index.html`, `styles.css`, `app.js`, plus
  `app/dashboard/`).
- `server/` — `market_service.py`, a plain-HTTP (Flask-free) service on `:8788`
  that supplies real bars and indicator values (yfinance + PineTS) so the browser
  avoids CORS. See `server/README.md`.
- `tools/` — helper scripts (skill index, porting).
- `PRODUCT.md` — product spec and route map.

## Running

Serve `app/` with any static server, e.g.:

```bash
python3 -m http.server 8080 --directory app
```

Start the market data service (optional but recommended for live quotes):

```bash
pip install yfinance
cd server && python3 market_service.py   # http://127.0.0.1:8788
```

The dashboard discovers the service at `http://<app host>:8788`; override with
`?market=http://127.0.0.1:9999` or `localStorage.cairnline_market_api`.

Secrets live in `server/.env` (gitignored). Copy `server/.env.example` and set
`LSE_API_KEY` if using LSE Data 3.0.

## Principles

- No build step, no framework, no bundler.
- No demo/mock/simulated data: pages show honest empty states (`NO_ACCOUNT`)
  when a real source is absent.
- Read-only live mode: no writes, payments, or broker execution.

## License

See repository for details. PineTS (AGPL-3.0) is used for indicators; publishing
this app requires publishing source or a commercial licence.
