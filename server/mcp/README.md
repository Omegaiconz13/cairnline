# Cairnline MCP server

`server/trish_mcp.py` exposes the whole desk to any MCP host over JSON-RPC on
stdio. It is the same server the dashboard's assistant uses, so there is one
data path and one set of risk limits — the MCP server never invents a number the
dashboard would not show.

**20 tools.** Verified with `python3 server/trish_mcp.py --selftest`, which also
reports whether the market service is up.

| Tool | What it answers |
|---|---|
| `get_quote` | Live price and session change for one symbol |
| `get_indicators` | Pine indicators (EMA 9/21/50, RSI, ATR, MACD, Bollinger) plus bias, entry, stop, target, confidence |
| `get_signals` | Ranked bias across the symbol basket |
| `get_cot` | CFTC net non-commercial positioning and its 3-year percentile |
| `get_calendar` | Upcoming macro events with impact, consensus, previous |
| `position_size` | Size from equity, risk %, entry and stop |
| `risk_gate` | PASS/BLOCK against the desk limits, with the reason |
| `edge_stats` | One question from the 42-preset catalog: base rate, Wilson interval, baseline, lift, stability, sessions |
| `edge_stats_presets` | The preset catalog |
| `backtest` | Full backtest, parameter sweep (`mode=optimize`) or hold-up validation (`mode=validate`) |
| `options_flow` | Prints, gamma exposure by strike, max pain, whale score, with the weight basis and the missing fields named |
| `paper_account` | Equity, open positions marked live, journal, deployments, kill switch |
| `paper_order` | Submit a paper order through every rail |
| `paper_close` | Close a paper position at the live quote |
| `paper_kill` | Engage or clear the kill switch |
| `paper_cycle` | One decision for a deployed strategy, from the newest closed bar |
| `propfirm_firms` | The prop-firm challenges the simulator knows |
| `propfirm_simulate` | Monte Carlo through one firm's exact rules |
| `read_skill` | Load a desk skill by name |
| `skills_list` | The skill catalogue |

## Run it

```bash
python3 server/market_service.py          # the data service the tools call (:8788)
python3 server/trish_mcp.py               # MCP over stdio
python3 server/trish_mcp.py --selftest    # tool count + is the desk reachable
```

`CAIRNLINE_API` overrides the market-service base URL (default
`http://127.0.0.1:8788`). Nothing else is required: no token, no account, no
hosted dependency.

## Register it

**Claude Code**

```bash
claude mcp add cairnline -- python3 /path/to/Project/server/trish_mcp.py
```

**Codex** (`~/.codex/config.toml`)

```toml
[mcp_servers.cairnline]
command = "python3"
args = ["/path/to/Project/server/trish_mcp.py"]
```

**Cursor / Claude Desktop** (`mcp.json` / `claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "cairnline": {
      "command": "python3",
      "args": ["/path/to/Project/server/trish_mcp.py"]
    }
  }
}
```

`server/mcp/cairnline-mcp` is a launcher that resolves its own path, so it can be
the `command` instead of spelling out the interpreter and the file.

## What it will not do

- **It never places a live order.** `paper_*` writes to a local paper ledger;
  `broker` in every payload reads `none — no order leaves this machine`.
- **It never fabricates data.** With no LSE key, `options_flow` returns
  `available: false` and the reason. With no bars, the backtest tool returns an
  error. Empty is reported as empty.
- **The rails are server-side.** `paper_order` goes through the same
  `server/paper_trader.py` checks the page uses; a caller cannot skip them, and a
  rejection lists every failed rail.
- **No licence-restricted code is shipped here.** PineTS is used locally
  (AGPL-3.0, client-side/local is the low-risk case); LuxAlgo Library studies
  (CC BY-NC-SA) are not used at all; LSE data stays on the machine that holds the
  key and is not redistributed.
