// Served verbatim at GET / on the local daemon.
// Keep this self-contained — no external scripts, no build step.
export const DASHBOARD_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Aegis · Local Dashboard</title>
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ctext y='26' font-size='26'%3E⚡%3C/text%3E%3C/svg%3E" />
  <style>
    :root {
      --bg: #07080b;
      --bg-elev: #0e1116;
      --bg-elev-2: #141821;
      --border: #1f242e;
      --border-strong: #2a3140;
      --text: #e6e8ee;
      --text-dim: #8b93a7;
      --text-faint: #5a6275;
      --accent: #7cf9d0;
      --accent-dim: #2b7a63;
      --danger: #ff6b6b;
      --warn: #ffb86b;
      --ok: #7cf9d0;
      --mono: ui-monospace, "JetBrains Mono", "SF Mono", Menlo, monospace;
    }
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", sans-serif;
      font-size: 14px;
      line-height: 1.5;
      -webkit-font-smoothing: antialiased;
    }
    body {
      min-height: 100vh;
      background:
        radial-gradient(1200px 600px at 15% -10%, rgba(124,249,208,0.06), transparent 60%),
        radial-gradient(900px 500px at 90% 10%, rgba(124,180,249,0.05), transparent 60%),
        var(--bg);
    }
    .wrap {
      max-width: 1180px;
      margin: 0 auto;
      padding: 32px 28px 80px;
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 20px;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .brand-mark {
      width: 34px; height: 34px;
      border-radius: 9px;
      background: linear-gradient(135deg, #7cf9d0, #4a9eff);
      display: grid; place-items: center;
      color: #061014;
      font-weight: 800;
      font-size: 17px;
      box-shadow: 0 0 0 1px rgba(255,255,255,0.06), 0 8px 24px rgba(124,249,208,0.15);
    }
    .brand-name { font-weight: 700; letter-spacing: 0.2px; }
    .brand-sub { color: var(--text-dim); font-size: 12px; }
    .status-pill {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 6px 12px;
      border-radius: 999px;
      background: rgba(124,249,208,0.08);
      color: var(--accent);
      border: 1px solid rgba(124,249,208,0.18);
      font-size: 12px;
      font-family: var(--mono);
    }
    .status-pill .dot {
      width: 8px; height: 8px; border-radius: 50%;
      background: var(--accent);
      box-shadow: 0 0 0 4px rgba(124,249,208,0.15);
      animation: pulse 1.8s ease-in-out infinite;
    }
    .status-pill.offline {
      background: rgba(255,107,107,0.08);
      color: var(--danger);
      border-color: rgba(255,107,107,0.2);
    }
    .status-pill.offline .dot {
      background: var(--danger);
      box-shadow: 0 0 0 4px rgba(255,107,107,0.15);
      animation: none;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.55; }
    }

    /* Tabs */
    .tabs {
      display: inline-flex;
      gap: 4px;
      padding: 4px;
      background: var(--bg-elev);
      border: 1px solid var(--border);
      border-radius: 10px;
      margin-bottom: 22px;
    }
    .tab {
      appearance: none;
      background: transparent;
      color: var(--text-dim);
      border: 0;
      padding: 8px 18px;
      font: inherit;
      font-size: 13px;
      font-weight: 500;
      border-radius: 7px;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .tab:hover { color: var(--text); }
    .tab.active {
      background: var(--bg-elev-2);
      color: var(--text);
      box-shadow: inset 0 0 0 1px var(--border-strong);
    }
    .panel[hidden] { display: none !important; }

    .grid {
      display: grid;
      grid-template-columns: 1.15fr 1fr;
      gap: 18px;
    }
    @media (max-width: 860px) {
      .grid { grid-template-columns: 1fr; }
    }

    .card {
      background: linear-gradient(180deg, var(--bg-elev) 0%, #0a0d12 100%);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 20px 22px;
      box-shadow: 0 1px 0 rgba(255,255,255,0.02) inset;
    }
    .card h2 {
      margin: 0 0 14px;
      font-size: 12px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: var(--text-dim);
      font-weight: 600;
    }
    .row { display: flex; align-items: center; gap: 10px; }
    .row + .row { margin-top: 10px; }

    .wallet-addr {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 12px 14px;
      background: var(--bg-elev-2);
      border: 1px solid var(--border);
      border-radius: 10px;
      font-family: var(--mono);
      font-size: 13px;
      word-break: break-all;
    }
    .wallet-addr .addr { flex: 1; color: var(--text); }
    .btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 10px;
      background: transparent;
      color: var(--text-dim);
      border: 1px solid var(--border-strong);
      border-radius: 7px;
      font: inherit;
      font-size: 12px;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .btn:hover:not(:disabled) {
      color: var(--text);
      border-color: var(--accent-dim);
      background: rgba(124,249,208,0.04);
    }
    .btn.copied { color: var(--accent); border-color: var(--accent-dim); }
    .btn.primary {
      background: linear-gradient(135deg, #7cf9d0, #4a9eff);
      color: #061014;
      border-color: transparent;
      font-weight: 600;
      padding: 10px 16px;
      font-size: 13px;
    }
    .btn.primary:hover:not(:disabled) {
      color: #061014;
      filter: brightness(1.08);
    }
    .btn:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }

    .hint {
      margin-top: 12px;
      color: var(--text-faint);
      font-size: 12px;
      line-height: 1.6;
    }
    .hint code {
      font-family: var(--mono);
      font-size: 11.5px;
      color: var(--text-dim);
      background: var(--bg-elev-2);
      padding: 1px 6px;
      border-radius: 4px;
      border: 1px solid var(--border);
    }
    .chain-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 3px 9px;
      border-radius: 5px;
      background: rgba(74,158,255,0.1);
      color: #7fb4ff;
      border: 1px solid rgba(74,158,255,0.2);
      font-size: 11px;
      font-family: var(--mono);
      margin-right: 6px;
    }

    .balance-main {
      display: flex;
      align-items: baseline;
      gap: 10px;
      margin: 4px 0 2px;
    }
    .balance-num {
      font-family: var(--mono);
      font-size: 40px;
      font-weight: 600;
      color: var(--text);
      letter-spacing: -0.01em;
      font-variant-numeric: tabular-nums;
    }
    .balance-unit { color: var(--text-dim); font-size: 13px; letter-spacing: 0.05em; text-transform: uppercase; }
    .balance-sub {
      color: var(--text-dim);
      font-size: 12.5px;
      font-family: var(--mono);
    }
    .balance-sub .sep { color: var(--text-faint); margin: 0 8px; }
    .empty-balance { color: var(--warn); }

    .feed-wrap { grid-column: 1 / -1; }
    .feed-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 14px;
    }
    .feed-header h2 { margin: 0; }
    .feed-meta { color: var(--text-faint); font-size: 12px; font-family: var(--mono); }
    .feed {
      display: flex;
      flex-direction: column;
      gap: 6px;
      max-height: 420px;
      overflow-y: auto;
      margin: 0 -8px;
      padding: 0 8px;
    }
    .feed::-webkit-scrollbar { width: 8px; }
    .feed::-webkit-scrollbar-thumb {
      background: var(--border-strong);
      border-radius: 4px;
    }
    .call {
      display: grid;
      grid-template-columns: auto 1fr auto auto auto;
      align-items: center;
      gap: 14px;
      padding: 11px 12px;
      background: var(--bg-elev-2);
      border: 1px solid var(--border);
      border-radius: 9px;
      font-size: 13px;
      animation: slideIn 0.25s ease;
    }
    @keyframes slideIn {
      from { opacity: 0; transform: translateY(-4px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .call .status-dot {
      width: 7px; height: 7px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .call.ok .status-dot { background: var(--ok); box-shadow: 0 0 8px rgba(124,249,208,0.5); }
    .call.err .status-dot { background: var(--danger); box-shadow: 0 0 8px rgba(255,107,107,0.5); }
    .call.pending .status-dot {
      background: var(--warn);
      box-shadow: 0 0 8px rgba(255,184,107,0.5);
      animation: pulse 1s ease-in-out infinite;
    }
    .call .service {
      font-family: var(--mono);
      font-size: 11.5px;
      padding: 2px 7px;
      border-radius: 4px;
      background: rgba(255,255,255,0.04);
      color: var(--text-dim);
      border: 1px solid var(--border);
      white-space: nowrap;
    }
    .call .detail {
      color: var(--text-dim);
      font-family: var(--mono);
      font-size: 12px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      min-width: 0;
    }
    .call .credits {
      font-family: var(--mono);
      font-size: 12px;
      color: var(--accent);
      white-space: nowrap;
    }
    .call.err .credits { color: var(--text-faint); }
    .call .duration {
      font-family: var(--mono);
      font-size: 11.5px;
      color: var(--text-faint);
      white-space: nowrap;
    }
    .call .time {
      font-family: var(--mono);
      font-size: 11.5px;
      color: var(--text-faint);
      white-space: nowrap;
    }
    .feed-empty {
      padding: 36px 14px;
      text-align: center;
      color: var(--text-faint);
      font-size: 13px;
      background: var(--bg-elev-2);
      border: 1px dashed var(--border-strong);
      border-radius: 10px;
    }
    .feed-empty code {
      display: inline-block;
      margin-top: 8px;
      padding: 6px 10px;
      font-family: var(--mono);
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      color: var(--text-dim);
      font-size: 12px;
    }

    .stats {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 14px;
      margin: 22px 0;
    }
    @media (max-width: 700px) {
      .stats { grid-template-columns: repeat(2, 1fr); }
    }
    .stat {
      background: var(--bg-elev);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 14px 16px;
    }
    .stat-label {
      color: var(--text-faint);
      font-size: 11px;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      margin-bottom: 6px;
    }
    .stat-value {
      font-family: var(--mono);
      font-size: 20px;
      color: var(--text);
      font-variant-numeric: tabular-nums;
    }

    /* Provider form */
    .form-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 14px;
    }
    @media (max-width: 700px) {
      .form-grid { grid-template-columns: 1fr; }
    }
    .field { display: flex; flex-direction: column; gap: 6px; }
    .field.full { grid-column: 1 / -1; }
    .field label {
      font-size: 11px;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--text-faint);
      font-weight: 600;
    }
    .field input,
    .field select,
    .field textarea {
      background: var(--bg-elev-2);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 10px 12px;
      color: var(--text);
      font: inherit;
      font-size: 13px;
      font-family: var(--mono);
      outline: none;
      transition: border-color 0.15s ease, box-shadow 0.15s ease;
    }
    .field input:focus,
    .field select:focus,
    .field textarea:focus {
      border-color: var(--accent-dim);
      box-shadow: 0 0 0 3px rgba(124,249,208,0.08);
    }
    .field textarea {
      min-height: 120px;
      resize: vertical;
    }
    .field .help {
      color: var(--text-faint);
      font-size: 11.5px;
    }
    .form-actions {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-top: 16px;
    }
    .form-status {
      flex: 1;
      min-height: 20px;
      font-size: 12.5px;
      font-family: var(--mono);
      color: var(--text-dim);
      word-break: break-word;
    }
    .form-status.ok { color: var(--accent); }
    .form-status.err { color: var(--danger); }
    .form-status.busy { color: var(--warn); }

    .earnings-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 14px;
      margin-bottom: 16px;
    }
    @media (max-width: 700px) {
      .earnings-grid { grid-template-columns: 1fr; }
    }
    .earnings-block {
      background: var(--bg-elev-2);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 14px 16px;
    }
    .earnings-label {
      color: var(--text-faint);
      font-size: 11px;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      margin-bottom: 6px;
    }
    .earnings-value {
      font-family: var(--mono);
      font-size: 22px;
      color: var(--text);
      font-variant-numeric: tabular-nums;
    }
    .earnings-value .unit {
      color: var(--text-dim);
      font-size: 12px;
      margin-left: 6px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    footer {
      margin-top: 32px;
      color: var(--text-faint);
      font-size: 11.5px;
      font-family: var(--mono);
      text-align: center;
    }
    footer a { color: var(--text-dim); text-decoration: none; }
    footer a:hover { color: var(--accent); }
  </style>
</head>
<body>
  <div class="wrap">
    <header>
      <div class="brand">
        <div class="brand-mark">⚡</div>
        <div>
          <div class="brand-name">Aegis Network</div>
          <div class="brand-sub">Local Daemon Dashboard</div>
        </div>
      </div>
      <div class="status-pill" id="status">
        <span class="dot"></span>
        <span id="status-text">connecting…</span>
      </div>
    </header>

    <div class="tabs" role="tablist">
      <button class="tab active" data-tab="consumer" role="tab">Consumer</button>
      <button class="tab" data-tab="provider" role="tab">Provider</button>
    </div>

    <!-- ════════════════════════════════════════════════════════════ -->
    <!--  CONSUMER PANEL                                              -->
    <!-- ════════════════════════════════════════════════════════════ -->
    <section class="panel" id="panel-consumer" role="tabpanel">
      <div class="grid">
        <div class="card">
          <h2>Web3 Transit Wallet</h2>
          <div class="wallet-addr">
            <span class="addr" id="wallet-addr">—</span>
            <button class="btn" id="copy-btn" type="button">Copy</button>
          </div>
          <div class="hint">
            <span class="chain-badge">● Base</span>
            Send USDC to this address to auto-deposit. A 1% gas fee is applied before credits are issued.
          </div>
        </div>

        <div class="card">
          <h2>Credit Balance</h2>
          <div class="balance-main">
            <span class="balance-num" id="balance-num">—</span>
            <span class="balance-unit">credits</span>
          </div>
          <div class="balance-sub" id="balance-sub">
            fetching balance…
          </div>
        </div>
      </div>

      <div class="stats">
        <div class="stat">
          <div class="stat-label">Total Calls</div>
          <div class="stat-value" id="stat-total">0</div>
        </div>
        <div class="stat">
          <div class="stat-label">Success</div>
          <div class="stat-value" id="stat-ok">0</div>
        </div>
        <div class="stat">
          <div class="stat-label">Errors</div>
          <div class="stat-value" id="stat-err">0</div>
        </div>
        <div class="stat">
          <div class="stat-label">Credits Spent</div>
          <div class="stat-value" id="stat-spent">0</div>
        </div>
      </div>

      <div class="card feed-wrap">
        <div class="feed-header">
          <h2>Recent API Calls</h2>
          <div class="feed-meta" id="feed-meta">—</div>
        </div>
        <div id="feed" class="feed">
          <div class="feed-empty" id="feed-empty">
            No API calls yet. Fire one with:
            <br/>
            <code>curl -X POST http://localhost:23447/v1/execute -H "Content-Type: application/json" -d '{"service":"aegis-parse","request":{"url":"https://example.com"}}'</code>
          </div>
        </div>
      </div>
    </section>

    <!-- ════════════════════════════════════════════════════════════ -->
    <!--  PROVIDER PANEL                                              -->
    <!-- ════════════════════════════════════════════════════════════ -->
    <section class="panel" id="panel-provider" role="tabpanel" hidden>
      <div class="card" style="margin-bottom: 18px;">
        <h2>Register a Service</h2>
        <div class="hint" style="margin-bottom: 14px;">
          <span class="chain-badge">● Owner</span>
          Your local Aegis Wallet (<code>~/.aegis/identity.json</code>) is the
          master key for every service you register from this daemon. The
          router verifies ownership by recovering this address from a
          request signature — there is no password to remember or rotate.
          Back up <code>identity.json</code> to keep control of payouts.
        </div>
        <form id="provider-form" autocomplete="off">
          <div class="form-grid">
            <div class="field">
              <label for="f-id">Service ID</label>
              <input id="f-id" name="id" type="text" placeholder="my-api" spellcheck="false" required />
              <span class="help">Unique, 2-64 chars. Letters, digits, dashes, underscores.</span>
            </div>
            <div class="field">
              <label for="f-endpoint">Endpoint URL</label>
              <input id="f-endpoint" name="endpoint_url" type="text" placeholder="https://api.example.com/run" spellcheck="false" required />
              <span class="help">We POST the sample request here with your secret.</span>
            </div>
            <div class="field full">
              <label for="f-owner">Owner &amp; Payout Wallet</label>
              <input id="f-owner" type="text" readonly tabindex="-1" placeholder="—" spellcheck="false" />
              <span class="help">Auto-filled from <code>identity.json</code>. Signs every registry call and receives USDC on claim.</span>
            </div>
            <div class="field">
              <label for="f-pricing">Pricing</label>
              <select id="f-pricing" name="pricing_type" required>
                <option value="FIXED">FIXED</option>
                <option value="DYNAMIC">DYNAMIC</option>
              </select>
              <span class="help">FIXED charges a flat credit cost per call.</span>
            </div>
            <div class="field" id="field-cost">
              <label for="f-cost">Fixed Cost (credits)</label>
              <input id="f-cost" name="fixed_cost" type="number" min="1" step="1" placeholder="e.g. 250" />
              <span class="help">100 credits = $0.01 USD.</span>
            </div>
            <div class="field full">
              <label for="f-secret">Provider Secret (Bearer token)</label>
              <input id="f-secret" name="secret" type="password" placeholder="Bearer token your endpoint expects" spellcheck="false" required />
              <span class="help">Sent as <code>Authorization: Bearer</code> to your endpoint. Stored encrypted on the router. Not used to authenticate you to Aegis — your wallet does that.</span>
            </div>
            <div class="field full">
              <label for="f-sample">Sample Request (JSON)</label>
              <textarea id="f-sample" name="sample_request" spellcheck="false" required>{ "hello": "world" }</textarea>
              <span class="help">We fire this against your endpoint to verify connectivity before registering.</span>
            </div>
          </div>
          <div class="form-actions">
            <button id="register-btn" class="btn primary" type="submit">Test &amp; Register</button>
            <span id="register-status" class="form-status">Fill out the form, then press Register. We test your endpoint before touching the on-chain registry.</span>
          </div>
        </form>
      </div>

      <div class="card">
        <h2>Earnings · <span id="earnings-id" style="color: var(--text); text-transform: none; letter-spacing: 0;">—</span></h2>
        <div class="earnings-grid">
          <div class="earnings-block">
            <div class="earnings-label">Pending</div>
            <div class="earnings-value"><span id="earn-pending">—</span><span class="unit" id="earn-pending-usd"></span></div>
          </div>
          <div class="earnings-block">
            <div class="earnings-label">Total Earned</div>
            <div class="earnings-value"><span id="earn-total">—</span><span class="unit" id="earn-total-usd"></span></div>
          </div>
        </div>
        <div class="form-actions">
          <button id="claim-btn" class="btn primary" type="button" disabled>Claim</button>
          <span id="claim-status" class="form-status">Claim requires a pending balance of at least 100,000 credits ($10).</span>
        </div>
      </div>
    </section>

    <footer>
      aegis-cli · refresh to update · <a href="https://github.com/" target="_blank" rel="noreferrer">docs</a>
    </footer>
  </div>

  <script>
    // ════════════════════════════════════════════════════════════════
    //  Module-level state (initialized up-top, never re-created)
    // ════════════════════════════════════════════════════════════════
    //
    // keystoreCache  — last-seen stats payload per service id. Keeps the
    //                  earnings card stable while a new request is in flight.
    // busyState      — one-shot latches for user actions so a spammed
    //                  button can't fire overlapping requests.
    // activeTab      — current visible tab. Polling short-circuits any
    //                  provider calls when we're on the consumer tab.
    // lastStatsId    — id we last queried stats for. Used to debounce.
    const keystoreCache = Object.create(null);
    const busyState = { register: false, claim: false };
    let activeTab = "consumer";
    let lastStatsId = "";

    const MIN_CLAIM_CREDITS = 100000;
    const CREDITS_PER_USD = 10000;

    // ── helpers ────────────────────────────────────────────────────
    const $ = (id) => document.getElementById(id);

    function safeStringify(obj) {
      try {
        return JSON.stringify(obj);
      } catch (err) {
        try {
          return "[unstringifiable: " + (err && err.message) + "]";
        } catch (_) {
          return "[unstringifiable]";
        }
      }
    }

    // Never overwrite a field the user is actively editing or has
    // edited but not blurred. This prevents the polling loop from
    // stomping keystrokes.
    function safeSetValue(el, val) {
      if (!el) return;
      if (document.activeElement === el) return;
      if (typeof val !== "string") val = val == null ? "" : String(val);
      if (el.value !== val) el.value = val;
    }

    const fmtNum = (n) =>
      (n == null || Number.isNaN(n)) ? "—" : Number(n).toLocaleString("en-US");
    const fmtUsd = (n) =>
      (n == null || Number.isNaN(n)) ? "—" : "$" + Number(n).toFixed(4);
    const creditsToUsd = (c) =>
      typeof c === "number" && Number.isFinite(c) ? c / CREDITS_PER_USD : null;
    const fmtTime = (ms) => {
      const d = new Date(ms);
      const pad = (x) => String(x).padStart(2, "0");
      return pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
    };
    const fmtDur = (ms) => {
      if (ms == null) return "";
      if (ms < 1000) return ms + "ms";
      return (ms / 1000).toFixed(2) + "s";
    };
    const shortenDetail = (d) => {
      if (!d) return "";
      if (d.length <= 80) return d;
      return d.slice(0, 77) + "…";
    };

    // ── tabs ───────────────────────────────────────────────────────
    const tabs = document.querySelectorAll(".tab");
    tabs.forEach((t) => {
      t.addEventListener("click", () => {
        const id = t.dataset.tab;
        if (!id || id === activeTab) return;
        activeTab = id;
        tabs.forEach((x) => x.classList.toggle("active", x === t));
        $("panel-consumer").hidden = id !== "consumer";
        $("panel-provider").hidden = id !== "provider";
        if (id === "provider") {
          pollProviderStats(true);
        }
      });
    });

    // ── copy wallet ────────────────────────────────────────────────
    const copyBtn = $("copy-btn");
    copyBtn.addEventListener("click", async () => {
      const addr = $("wallet-addr").textContent && $("wallet-addr").textContent.trim();
      if (!addr || addr === "—") return;
      try {
        await navigator.clipboard.writeText(addr);
        copyBtn.textContent = "Copied";
        copyBtn.classList.add("copied");
        setTimeout(() => {
          copyBtn.textContent = "Copy";
          copyBtn.classList.remove("copied");
        }, 1400);
      } catch (_) {
        /* noop */
      }
    });

    function setOnline(online, msg) {
      const pill = $("status");
      const txt = $("status-text");
      if (online) {
        pill.classList.remove("offline");
        txt.textContent = msg || "connected";
      } else {
        pill.classList.add("offline");
        txt.textContent = msg || "offline";
      }
    }

    // ── consumer: call feed ────────────────────────────────────────
    function renderFeed(calls) {
      const feed = $("feed");
      const empty = $("feed-empty");
      if (!calls || calls.length === 0) {
        if (empty) empty.style.display = "";
        Array.from(feed.querySelectorAll(".call")).forEach((el) => el.remove());
        return;
      }
      if (empty) empty.style.display = "none";

      const sorted = calls.slice().sort((a, b) => b.started_at - a.started_at);

      const existing = new Map(
        Array.from(feed.querySelectorAll(".call")).map((el) => [el.dataset.id, el])
      );
      const frag = document.createDocumentFragment();

      for (const c of sorted) {
        let el = existing.get(c.id);
        if (!el) {
          el = document.createElement("div");
          el.className = "call";
          el.dataset.id = c.id;
          el.innerHTML =
            '<span class="status-dot"></span>' +
            '<span class="detail"></span>' +
            '<span class="service"></span>' +
            '<span class="credits"></span>' +
            '<span class="duration"></span>' +
            '<span class="time"></span>';
        } else {
          existing.delete(c.id);
        }

        const statusClass = c.status === "ok" ? "ok" : c.status === "err" ? "err" : "pending";
        el.classList.remove("ok", "err", "pending");
        el.classList.add(statusClass);

        el.querySelector(".service").textContent = c.service || "?";
        el.querySelector(".detail").textContent = shortenDetail(c.detail || "");
        el.querySelector(".detail").title = c.detail || "";

        const creditsEl = el.querySelector(".credits");
        if (c.status === "ok" && c.credits_charged != null) {
          creditsEl.textContent = "−" + fmtNum(c.credits_charged) + " cr";
        } else if (c.status === "err") {
          creditsEl.textContent = "refunded";
        } else {
          creditsEl.textContent = "…";
        }

        el.querySelector(".duration").textContent = fmtDur(c.duration_ms);
        el.querySelector(".time").textContent = fmtTime(c.started_at);

        frag.appendChild(el);
      }

      existing.forEach((el) => el.remove());
      feed.appendChild(frag);
    }

    // ── provider: form wiring ──────────────────────────────────────
    const pricingEl = $("f-pricing");
    const costFieldEl = $("field-cost");
    const costInputEl = $("f-cost");

    function syncCostVisibility() {
      const isFixed = pricingEl.value === "FIXED";
      costFieldEl.style.display = isFixed ? "" : "none";
      if (!isFixed) costInputEl.value = "";
    }
    pricingEl.addEventListener("change", syncCostVisibility);
    syncCostVisibility();

    function setStatus(el, cls, msg) {
      el.className = "form-status" + (cls ? " " + cls : "");
      el.textContent = msg;
    }

    const form = $("provider-form");
    const registerBtn = $("register-btn");
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      if (busyState.register) return;

      const id = $("f-id").value.trim();
      const endpoint_url = $("f-endpoint").value.trim();
      const pricing_type = pricingEl.value;
      const secret = $("f-secret").value;
      const rawSample = $("f-sample").value;

      if (!id || !endpoint_url || !secret) {
        setStatus($("register-status"), "err", "Fill in every field.");
        return;
      }

      let fixed_cost = null;
      if (pricing_type === "FIXED") {
        const n = Number(costInputEl.value);
        if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
          setStatus($("register-status"), "err", "Fixed Cost must be a positive integer.");
          return;
        }
        fixed_cost = n;
      }

      let sample_request;
      try {
        sample_request = JSON.parse(rawSample);
      } catch (err) {
        setStatus($("register-status"), "err", "Sample Request is not valid JSON.");
        return;
      }
      if (!sample_request || typeof sample_request !== "object" || Array.isArray(sample_request)) {
        setStatus($("register-status"), "err", "Sample Request must be a JSON object.");
        return;
      }

      busyState.register = true;
      registerBtn.disabled = true;
      setStatus($("register-status"), "busy", "Testing your endpoint…");

      try {
        const r = await fetch("/api/provider/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: safeStringify({
            id,
            endpoint_url,
            pricing_type,
            fixed_cost,
            secret,
            sample_request,
          }),
        });
        const body = await r.json().catch(() => ({}));

        if (!r.ok) {
          const detail = body && (body.message || body.error) || ("HTTP " + r.status);
          const stage = body && body.stage ? " (" + body.stage + ")" : "";
          setStatus($("register-status"), "err", "✗ " + detail + stage);
          return;
        }

        const verb = body.method === "PUT" || body.updated ? "Updated" : "Registered";
        setStatus(
          $("register-status"),
          "ok",
          "✓ " + verb + " " + id + " as owner. Earnings card is now live."
        );
        lastStatsId = id;
        pollProviderStats(true);
      } catch (err) {
        setStatus($("register-status"), "err", "Network error: " + (err && err.message || err));
      } finally {
        busyState.register = false;
        registerBtn.disabled = false;
      }
    });

    // ── provider: earnings + claim ────────────────────────────────
    const claimBtn = $("claim-btn");
    const idInput = $("f-id");

    idInput.addEventListener("input", () => {
      const v = idInput.value.trim();
      $("earnings-id").textContent = v || "—";
      if (v) pollProviderStats(true);
      else resetEarnings();
    });

    function resetEarnings() {
      $("earn-pending").textContent = "—";
      $("earn-pending-usd").textContent = "";
      $("earn-total").textContent = "—";
      $("earn-total-usd").textContent = "";
      claimBtn.disabled = true;
    }
    resetEarnings();

    async function pollProviderStats(force) {
      if (activeTab !== "provider" && !force) return;
      const id = idInput.value.trim();
      if (!id) return;

      try {
        const r = await fetch("/api/provider/stats/" + encodeURIComponent(id), {
          cache: "no-store",
        });
        if (r.status === 404) {
          keystoreCache[id] = null;
          if (idInput.value.trim() === id) {
            $("earnings-id").textContent = id;
            $("earn-pending").textContent = "0";
            $("earn-pending-usd").textContent = "$0.00";
            $("earn-total").textContent = "0";
            $("earn-total-usd").textContent = "$0.00";
            claimBtn.disabled = true;
            setStatus($("claim-status"), "", "Service not registered yet.");
          }
          return;
        }
        const body = await r.json().catch(() => ({}));
        if (!r.ok) {
          if (idInput.value.trim() === id) {
            setStatus($("claim-status"), "err", "Stats unavailable: " + (body && (body.message || body.error) || r.status));
          }
          return;
        }

        keystoreCache[id] = body;
        if (idInput.value.trim() !== id) return;

        const earnings = (body && body.earnings) || {};
        const pending = typeof earnings.pending_balance === "number" ? earnings.pending_balance : 0;
        const total = typeof earnings.total_earned === "number" ? earnings.total_earned : 0;

        $("earnings-id").textContent = id;
        $("earn-pending").textContent = fmtNum(pending);
        $("earn-pending-usd").textContent = fmtUsd(creditsToUsd(pending));
        $("earn-total").textContent = fmtNum(total);
        $("earn-total-usd").textContent = fmtUsd(creditsToUsd(total));

        // Authority to claim is purely cryptographic now: this daemon can
        // sweep funds if and only if its Transit Wallet matches the
        // service's provider_wallet on the router. local_registered is
        // just a UX breadcrumb; is_owner is the source of truth.
        const isOwner = !!body.is_owner;
        const canClaim = isOwner && pending > MIN_CLAIM_CREDITS;
        claimBtn.disabled = busyState.claim || !canClaim;

        if (!isOwner) {
          const actual = (body && body.service && body.service.provider_wallet) || "another wallet";
          setStatus(
            $("claim-status"),
            "",
            "This service is owned by " + actual + ". Run the daemon with that identity.json to claim."
          );
        } else if (pending <= MIN_CLAIM_CREDITS) {
          const need = MIN_CLAIM_CREDITS - pending;
          setStatus($("claim-status"), "", "Need " + fmtNum(need + 1) + " more credits to claim (" + fmtUsd(creditsToUsd(need + 1)) + ").");
        } else if (!busyState.claim) {
          setStatus($("claim-status"), "ok", "Ready to claim " + fmtNum(pending) + " credits (" + fmtUsd(creditsToUsd(pending)) + ").");
        }
      } catch (err) {
        /* swallow — tick will retry */
      }
    }

    claimBtn.addEventListener("click", async () => {
      if (busyState.claim) return;
      const id = idInput.value.trim();
      if (!id) return;
      busyState.claim = true;
      claimBtn.disabled = true;
      setStatus($("claim-status"), "busy", "Sweeping on-chain…");
      try {
        const r = await fetch("/api/provider/claim", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: safeStringify({ id }),
        });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) {
          setStatus(
            $("claim-status"),
            "err",
            "✗ " + (body && (body.message || body.error) || ("HTTP " + r.status))
          );
          return;
        }
        const credits = body && body.credits_claimed;
        const tx = body && body.tx_hash;
        setStatus(
          $("claim-status"),
          "ok",
          "✓ Claimed " + fmtNum(credits) + " credits" + (tx ? " (tx " + String(tx).slice(0, 10) + "…)" : "")
        );
        pollProviderStats(true);
      } catch (err) {
        setStatus($("claim-status"), "err", "Network error: " + (err && err.message || err));
      } finally {
        busyState.claim = false;
        // re-evaluate button state via next poll
        pollProviderStats(true);
      }
    });

    // ════════════════════════════════════════════════════════════════
    //  Main polling loop
    // ════════════════════════════════════════════════════════════════
    //
    // Wrapped in a single try/catch so network blips and transient
    // errors never crash the script — the next tick will retry.
    async function tick() {
      try {
        const r = await fetch("/api/status", { cache: "no-store" });
        if (!r.ok) throw new Error("status " + r.status);
        const s = await r.json();

        setOnline(
          true,
          s.router_online ? "connected · router live" : "connected · router offline"
        );

        $("wallet-addr").textContent = s.wallet || "—";
        // Provider form: owner field is readonly and always mirrors the
        // Transit Wallet — whoever signs is who owns.
        safeSetValue($("f-owner"), s.wallet || "");

        if (s.credits == null) {
          $("balance-num").textContent = "—";
          $("balance-sub").textContent = s.balance_error || "router unreachable";
        } else {
          $("balance-num").textContent = fmtNum(s.credits);
          const sub = $("balance-sub");
          sub.classList.toggle("empty-balance", s.credits === 0);
          const pieces = [];
          if (s.usd_value != null) pieces.push(fmtUsd(s.usd_value));
          if (s.scrapes_remaining != null)
            pieces.push(fmtNum(s.scrapes_remaining) + " scrapes left");
          sub.textContent = pieces.join(" · ") || "—";
        }

        const calls = s.calls || [];
        $("stat-total").textContent = fmtNum(calls.length);
        $("stat-ok").textContent = fmtNum(calls.filter((c) => c.status === "ok").length);
        $("stat-err").textContent = fmtNum(calls.filter((c) => c.status === "err").length);
        $("stat-spent").textContent = fmtNum(
          calls.reduce((sum, c) => sum + (c.credits_charged || 0), 0)
        );

        $("feed-meta").textContent =
          calls.length > 0
            ? "showing last " + calls.length + " call" + (calls.length === 1 ? "" : "s")
            : "—";

        renderFeed(calls);
      } catch (err) {
        setOnline(false, "daemon unreachable");
      }

      try {
        if (activeTab === "provider") {
          await pollProviderStats(false);
        }
      } catch (err) {
        /* provider stats are best-effort — never crash tick */
      }
    }

    function loop() {
      tick().finally(() => setTimeout(loop, 2000));
    }
    loop();
  </script>
</body>
</html>
`;
