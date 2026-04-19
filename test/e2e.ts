// ════════════════════════════════════════════════════════════════════════
//  Aegis CLI — Fully Automated End-to-End Test
// ════════════════════════════════════════════════════════════════════════
//
// What this does (top-to-bottom):
//
//   1. Master Funder — a persistent cold wallet stored in ./test-funder.json.
//      First run generates it and exits, asking the operator to seed it with
//      ~1 USDC on Base + a whisker of ETH for gas. Subsequent runs reuse it.
//
//   2. Ephemeral Daemon — spawns `npx tsx src/cli.ts daemon` inside a
//      throwaway AEGIS_HOME directory so the test never touches ~/.aegis.
//      The daemon generates its own Transit Wallet on first start.
//
//   3. Auto-Drip — once the daemon is live, the funder sends exactly 0.05
//      USDC to the Transit Wallet on-chain. The daemon's background sweep
//      loop picks the funds up, signs an EIP-2612 permit, and converts them
//      into router credits automatically.
//
//   4. Protocol Tests — HTTP assertions against the daemon covering
//      pre-flight validation, paid registration, execution, limits, updates,
//      refunds, earnings, and claim workflow.
//
//   5. Teardown — `try/finally` ensures the daemon child process is killed
//      and TEST_DIR is nuked even if any assertion throws.
//
// Cost of a single successful run: 0.05 USDC (swept into credits) + gas.
// The residual credits live on an ephemeral wallet you'll never use again —
// that's the price of E2E. A $1 funder top-up is enough for ~20 runs.
// ════════════════════════════════════════════════════════════════════════

import { spawn, type ChildProcess } from "child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import path from "path";
import process from "process";

import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Hex,
} from "viem";
import { base } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

// ────────────────────────────────────────────────────────────────────────
// Constants & paths
// ────────────────────────────────────────────────────────────────────────

const BASE_USDC: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

// Minimal ERC20 surface we actually call: transfer + balanceOf.
const ERC20_ABI = [
  {
    name: "transfer",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const CWD = process.cwd();
const FUNDER_PATH = path.join(CWD, "test-funder.json");
const TEST_DIR = path.join(CWD, ".test-aegis");
const DAEMON_PORT = 23448;
const DAEMON_URL = `http://localhost:${DAEMON_PORT}`;

// 0.05 USDC in micro-units (USDC has 6 decimals). Sized so that a single
// 1 USDC top-up of the master funder pays for ~20 runs of this test.
const DRIP_AMOUNT = 50_000n;
// Pre-flight guard: refuse to run if the funder can't afford at least one
// more drip. Matches DRIP_AMOUNT so we only bail when the well is truly dry.
const MIN_FUNDER_USDC = DRIP_AMOUNT;

// Router-side economy constants
const DEPOSIT_FEE_BPS = 100; // 1%
const CREDITS_PER_USDC = 10_000;
const EXPECTED_SWEEP_CREDITS = Math.floor(
  (Number(DRIP_AMOUNT) * (10_000 - DEPOSIT_FEE_BPS) * CREDITS_PER_USDC) /
    10_000 /
    1_000_000,
);

// Per-execution fee charged by the service we register under test.
const SERVICE_FIXED_COST_CREDITS = 100;
const EXECUTE_MAX_CREDITS_BELOW_COST = Math.floor(
  SERVICE_FIXED_COST_CREDITS / 2,
);

const BASE_RPC_URL = process.env.BASE_RPC_URL || "https://mainnet.base.org";
const AEGIS_ROUTER_URL =
  process.env.AEGIS_ROUTER_URL ||
  "https://aegis-router-production.up.railway.app";

// Public echo service used as the registered provider endpoint.
const MOCK_ENDPOINT_URL = "https://httpbin.org/post";

// ────────────────────────────────────────────────────────────────────────
// Tiny logging helpers
// ────────────────────────────────────────────────────────────────────────

function log(step: string, msg: string): void {
  console.log(`\x1b[36m[${step}]\x1b[0m ${msg}`);
}
function ok(msg: string): void {
  console.log(`\x1b[32m  ✓\x1b[0m ${msg}`);
}
function fail(msg: string): never {
  console.error(`\x1b[31m  ✗\x1b[0m ${msg}`);
  throw new Error(msg);
}
function warn(msg: string): void {
  console.warn(`\x1b[33m  !\x1b[0m ${msg}`);
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ────────────────────────────────────────────────────────────────────────
// Objective 1 — Master Funder setup
// ────────────────────────────────────────────────────────────────────────

interface FunderFile {
  address: Address;
  privateKey: Hex;
  created: string;
}

function loadOrCreateFunder(): FunderFile {
  if (!existsSync(FUNDER_PATH)) {
    log("FUNDER", "test-funder.json not found — generating new cold wallet…");
    const pk = generatePrivateKey();
    const acc = privateKeyToAccount(pk);
    const file: FunderFile = {
      address: acc.address,
      privateKey: pk,
      created: new Date().toISOString(),
    };
    writeFileSync(FUNDER_PATH, JSON.stringify(file, null, 2), { mode: 0o600 });

    console.log("\n" + "═".repeat(72));
    console.log("  MASTER FUNDER CREATED");
    console.log("═".repeat(72));
    console.log(`  Address: ${acc.address}`);
    console.log(`  Stored : ${FUNDER_PATH}`);
    console.log("");
    console.log("  👉 Send AT LEAST 1 USDC (Base) + a small amount of ETH");
    console.log("     for gas to the address above, then re-run this script.");
    console.log("     1 USDC covers ~20 test runs at 0.05 USDC per drip.");
    console.log("═".repeat(72) + "\n");
    process.exit(1);
  }

  const parsed = JSON.parse(readFileSync(FUNDER_PATH, "utf-8")) as FunderFile;
  if (!parsed.privateKey || !parsed.address) {
    fail("test-funder.json is malformed — delete it to regenerate.");
  }
  return parsed;
}

// ────────────────────────────────────────────────────────────────────────
// Objective 2 — Orchestration & Auto-Funding
// ────────────────────────────────────────────────────────────────────────

function spawnDaemon(): ChildProcess {
  log("DAEMON", `Spawning: npx tsx src/cli.ts daemon --port ${DAEMON_PORT}`);
  log("DAEMON", `AEGIS_HOME = ${TEST_DIR}`);

  const child = spawn(
    "npx",
    ["tsx", "src/cli.ts", "daemon", "--port", String(DAEMON_PORT)],
    {
      cwd: CWD,
      env: {
        ...process.env,
        AEGIS_HOME: TEST_DIR,
        AEGIS_ROUTER_URL,
        BASE_RPC_URL,
        AEGIS_SWEEP_INTERVAL_MS: "3000",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  child.stdout?.on("data", (buf) => process.stdout.write(`  ⎿ ${buf}`));
  child.stderr?.on("data", (buf) => process.stderr.write(`  ⎿ ${buf}`));

  child.on("exit", (code, sig) => {
    log("DAEMON", `exited (code=${code}, signal=${sig})`);
  });

  return child;
}

async function waitForIdentity(timeoutMs = 30_000): Promise<Address> {
  const identityPath = path.join(TEST_DIR, "identity.json");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(identityPath)) {
      try {
        const data = JSON.parse(readFileSync(identityPath, "utf-8"));
        if (data?.address) return data.address as Address;
      } catch {
        // Partial write — keep polling.
      }
    }
    await sleep(250);
  }
  fail(`Timed out waiting for ${identityPath}`);
}

async function waitForStatus(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${DAEMON_URL}/api/status`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (r.ok) return;
    } catch {
      // Daemon still booting.
    }
    await sleep(500);
  }
  fail(`Daemon /api/status did not come online within ${timeoutMs}ms.`);
}

// ────────────────────────────────────────────────────────────────────────
// Objective 3 — Protocol Tests
// ────────────────────────────────────────────────────────────────────────

async function waitForCredits(
  minCredits: number,
  timeoutMs = 60_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let last = 0;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${DAEMON_URL}/api/status`);
      if (r.ok) {
        const body: any = await r.json();
        const credits = typeof body.credits === "number" ? body.credits : 0;
        last = credits;
        if (credits >= minCredits) return credits;
      }
    } catch {
      // keep polling
    }
    await sleep(1_500);
  }
  fail(
    `Daemon never reached ${minCredits} credits within ${timeoutMs}ms (last=${last}). The background sweep likely failed.`,
  );
}

async function runTests(serviceId: string): Promise<void> {
  // ── Test 1: Pre-flight Rejection ──────────────────────────────
  log("TEST 1", "Pre-flight rejection (unreachable endpoint_url)…");
  {
    const r = await fetch(`${DAEMON_URL}/api/provider/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: serviceId,
        endpoint_url: "http://127.0.0.1:1/definitely-not-bound",
        pricing_type: "FIXED",
        fixed_cost: SERVICE_FIXED_COST_CREDITS,
        secret: "test-secret",
        sample_request: { ping: "pong" },
      }),
    });
    const body = await r.json().catch(() => ({}));
    if (r.ok || body?.ok === true) {
      fail(`Expected rejection; got ${r.status} ${JSON.stringify(body)}`);
    }
    ok(
      `Rejected with ${r.status} ${body?.error ?? "ERR"}: ${body?.message ?? ""}`,
    );
  }

  // ── Test 2: Paid Registration ─────────────────────────────────
  log(
    "TEST 2",
    `Paid registration with id="${serviceId}" → ${MOCK_ENDPOINT_URL}`,
  );
  {
    const r = await fetch(`${DAEMON_URL}/api/provider/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: serviceId,
        endpoint_url: MOCK_ENDPOINT_URL,
        pricing_type: "FIXED",
        fixed_cost: SERVICE_FIXED_COST_CREDITS,
        secret: "test-provider-secret",
        sample_request: { hello: "world" },
      }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok || body?.ok !== true) {
      fail(`Registration failed: ${r.status} ${JSON.stringify(body)}`);
    }
    ok(
      `Registered (method=${body.method}, owner=${body?.service?.provider_wallet})`,
    );
  }

  // ── Test 3: Execution ─────────────────────────────────────────
  log(
    "TEST 3",
    `Execute service (should charge fixed_cost=${SERVICE_FIXED_COST_CREDITS} credits)…`,
  );
  {
    const r = await fetch(`${DAEMON_URL}/v1/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        service: serviceId,
        request: { hello: "world", nonce: Date.now() },
      }),
    });
    const body: any = await r.json().catch(() => ({}));
    if (!r.ok) {
      fail(`Execute failed: ${r.status} ${JSON.stringify(body).slice(0, 500)}`);
    }
    const billing = body?.aegis_billing ?? {};
    ok(
      `200 OK — charged=${billing.credits_charged}, balance=${billing.credit_balance}`,
    );
    if (!billing.credits_charged || billing.credits_charged <= 0) {
      warn(
        "aegis_billing.credits_charged was not positive — router may have refunded.",
      );
    }
  }

  await sleep(2_000);

  // ── Test 3.1: Consumer Over-Limit Rejection ───────────────────
  log(
    "TEST 3.1",
    `Consumer over-limit rejection (maxCredits=${EXECUTE_MAX_CREDITS_BELOW_COST} vs cost=${SERVICE_FIXED_COST_CREDITS})…`,
  );
  {
    const r = await fetch(`${DAEMON_URL}/v1/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        service: serviceId,
        request: { hello: "world", nonce: Date.now() },
        maxCredits: EXECUTE_MAX_CREDITS_BELOW_COST,
      }),
    });
    const body: any = await r.json().catch(() => ({}));
    if (r.ok) {
      fail(
        `Expected rejection; got 200 OK ${JSON.stringify(body).slice(0, 300)}`,
      );
    }
    if (r.status !== 400 && r.status !== 402) {
      fail(
        `Expected 400 or 402; got ${r.status} ${JSON.stringify(body).slice(0, 300)}`,
      );
    }
    ok(
      `Rejected with ${r.status} ${body?.error ?? "ERR"}: required=${body?.required}, cap=${body?.maxCredits}`,
    );
  }

  // ── Test 3.2: Provider Update (endpoint → /status/500) ────────
  log(
    "TEST 3.2",
    "Provider update → https://httpbin.org/status/500 (expect PUT)…",
  );
  {
    const r = await fetch(`${DAEMON_URL}/api/provider/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: serviceId,
        endpoint_url: "https://httpbin.org/status/500",
        pricing_type: "FIXED",
        fixed_cost: SERVICE_FIXED_COST_CREDITS,
        secret: "test-provider-secret",
        sample_request: { hello: "world" },
      }),
    });
    const body: any = await r.json().catch(() => ({}));
    if (!r.ok || body?.ok !== true || body?.updated !== true) {
      fail(
        `Expected ok:true & updated:true on PUT; got ${r.status} ${JSON.stringify(body).slice(0, 400)}`,
      );
    }
    ok(
      `Updated (method=${body.method}, endpoint=${body?.service?.endpoint_url})`,
    );
  }

  await sleep(1_500);

  // ── Test 3.3: Execution Refund (provider error → 0 credits) ───
  log(
    "TEST 3.3",
    "Execution refund (provider returns 500; expect 0 net debit)…",
  );
  {
    const statusBefore: any = await (
      await fetch(`${DAEMON_URL}/api/status`)
    ).json();
    const balanceBefore = Number(statusBefore?.credits ?? NaN);
    if (!Number.isFinite(balanceBefore)) {
      fail(
        `Could not read credits before execute: ${JSON.stringify(statusBefore).slice(0, 300)}`,
      );
    }

    const r = await fetch(`${DAEMON_URL}/v1/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        service: serviceId,
        request: { hello: "world", nonce: Date.now() },
      }),
    });
    if (r.ok) {
      fail(`Expected execution failure; got 200 OK`);
    }
    const errBody: any = await r.json().catch(() => ({}));

    await sleep(3_500);

    const statusAfter: any = await (
      await fetch(`${DAEMON_URL}/api/status`)
    ).json();
    const balanceAfter = Number(statusAfter?.credits ?? NaN);
    if (!Number.isFinite(balanceAfter)) {
      fail(
        `Could not read credits after execute: ${JSON.stringify(statusAfter).slice(0, 300)}`,
      );
    }

    if (balanceBefore !== balanceAfter) {
      fail(
        `Refund assertion failed: before=${balanceBefore}, after=${balanceAfter} (delta=${balanceAfter - balanceBefore})`,
      );
    }
    ok(
      `Execute failed with ${r.status} (${errBody?.error ?? "ERR"}); balance held at ${balanceAfter} credits`,
    );
  }

  // ── Test 3.4: Provider Update (restore healthy endpoint) ──────
  log("TEST 3.4", `Provider update → ${MOCK_ENDPOINT_URL} (restore)…`);
  {
    const r = await fetch(`${DAEMON_URL}/api/provider/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: serviceId,
        endpoint_url: MOCK_ENDPOINT_URL,
        pricing_type: "FIXED",
        fixed_cost: SERVICE_FIXED_COST_CREDITS,
        secret: "test-provider-secret",
        sample_request: { hello: "world" },
      }),
    });
    const body: any = await r.json().catch(() => ({}));
    if (!r.ok || body?.ok !== true || body?.updated !== true) {
      fail(
        `Expected ok:true & updated:true; got ${r.status} ${JSON.stringify(body).slice(0, 400)}`,
      );
    }
    ok(`Restored (endpoint=${body?.service?.endpoint_url})`);
  }

  await sleep(1_500);

  // ── Test 4: Earnings Sync ─────────────────────────────────────
  log("TEST 4", `Earnings sync (GET /api/provider/stats/${serviceId})…`);
  {
    const r = await fetch(`${DAEMON_URL}/api/provider/stats/${serviceId}`);
    const body: any = await r.json().catch(() => ({}));
    if (!r.ok) {
      fail(`Stats fetch failed: ${r.status} ${JSON.stringify(body)}`);
    }
    const pending = Number(body?.earnings?.pending_balance ?? 0);
    if (!(pending > 0)) {
      fail(
        `Expected pending_balance > 0, got ${pending}. Body: ${JSON.stringify(body).slice(0, 500)}`,
      );
    }
    ok(
      `pending_balance=${pending}, total_earned=${body?.earnings?.total_earned}, is_owner=${body.is_owner}`,
    );
  }

  // ── Test 5: Claim Workflow ────────────────────────────────────
  log("TEST 5", "Claim workflow (expect success OR BELOW_MINIMUM 402)…");
  {
    const r = await fetch(`${DAEMON_URL}/api/provider/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: serviceId }),
    });
    const body: any = await r.json().catch(() => ({}));

    if (r.ok && body?.ok === true) {
      ok(`Claim succeeded: tx=${body.tx_hash}, usdc=${body.usdc_paid}`);
    } else if (r.status === 402 && body?.error === "BELOW_MINIMUM") {
      ok(
        `Router correctly rejected with BELOW_MINIMUM (pending=${body.pending_balance}, min=${body.minimum})`,
      );
    } else {
      fail(
        `Unexpected claim response: ${r.status} ${JSON.stringify(body).slice(0, 500)}`,
      );
    }
  }
}

// ────────────────────────────────────────────────────────────────────────
// Objective 4 — Teardown
// ────────────────────────────────────────────────────────────────────────

function teardown(daemon: ChildProcess | null): void {
  log("TEARDOWN", "Cleaning up…");
  if (daemon && !daemon.killed) {
    try {
      daemon.kill("SIGTERM");
    } catch (err) {
      warn(`SIGTERM failed: ${String(err)}`);
    }
    setTimeout(() => {
      if (daemon && !daemon.killed) {
        try {
          daemon.kill("SIGKILL");
        } catch {
          /* ignored */
        }
      }
    }, 2_000).unref?.();
  }

  if (existsSync(TEST_DIR)) {
    try {
      rmSync(TEST_DIR, { recursive: true, force: true });
      ok(`Removed ${TEST_DIR}`);
    } catch (err) {
      warn(`Could not delete ${TEST_DIR}: ${String(err)}`);
    }
  }
}

// ────────────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("═".repeat(72));
  console.log("  AEGIS CLI — AUTOMATED E2E");
  console.log("═".repeat(72));
  console.log(`  Router : ${AEGIS_ROUTER_URL}`);
  console.log(`  RPC    : ${BASE_RPC_URL}`);
  console.log(`  TestDir: ${TEST_DIR}`);
  console.log("═".repeat(72) + "\n");

  const funder = loadOrCreateFunder();
  const funderAcc = privateKeyToAccount(funder.privateKey);
  const publicClient = createPublicClient({
    chain: base,
    transport: http(BASE_RPC_URL),
  });
  const walletClient = createWalletClient({
    account: funderAcc,
    chain: base,
    transport: http(BASE_RPC_URL),
  });

  const verifyFunderBalance = async (): Promise<void> => {
    const usdcBal = (await publicClient.readContract({
      address: BASE_USDC,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [funder.address],
    })) as bigint;

    const ethBal = await publicClient.getBalance({ address: funder.address });

    const humanUsdc = (Number(usdcBal) / 1e6).toFixed(6);
    const humanEth = (Number(ethBal) / 1e18).toFixed(6);

    log("FUNDER", `Address:      ${funder.address}`);
    log("FUNDER", `USDC balance: ${humanUsdc} USDC`);
    log("FUNDER", `ETH balance:  ${humanEth} ETH`);

    if (usdcBal < MIN_FUNDER_USDC) {
      console.log("\n" + "═".repeat(72));
      console.log("  FUNDER UNDERFUNDED");
      console.log("═".repeat(72));
      console.log(`  Address : ${funder.address}`);
      console.log(
        `  Balance : ${humanUsdc} USDC (need ≥ ${(Number(MIN_FUNDER_USDC) / 1e6).toFixed(6)})`,
      );
      console.log("  👉 Top up USDC on Base and re-run.");
      console.log("═".repeat(72) + "\n");
      process.exit(1);
    }

    if (ethBal === 0n) {
      warn("Funder has 0 ETH — the USDC transfer will fail without gas.");
    }
  };

  const dripUSDC = async (transitWallet: Address): Promise<void> => {
    log(
      "DRIP",
      `Sending ${(Number(DRIP_AMOUNT) / 1e6).toFixed(6)} USDC → ${transitWallet}`,
    );

    const hash = await walletClient.writeContract({
      chain: base,
      account: funderAcc,
      address: BASE_USDC,
      abi: ERC20_ABI,
      functionName: "transfer",
      args: [transitWallet, DRIP_AMOUNT],
    });
    log("DRIP", `Tx submitted: ${hash}`);

    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      fail(`USDC transfer reverted on-chain (tx=${hash}).`);
    }
    ok(`Confirmed in block ${receipt.blockNumber} (status=${receipt.status})`);
  };

  await verifyFunderBalance();

  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
  mkdirSync(TEST_DIR, { recursive: true });

  let daemon: ChildProcess | null = null;

  try {
    daemon = spawnDaemon();

    log("ORCH", "Waiting for identity.json…");
    const transitWallet = await waitForIdentity();
    ok(`Transit wallet: ${transitWallet}`);

    log("ORCH", "Waiting for /api/status to return 200…");
    await waitForStatus();
    ok("Daemon is live.");

    await dripUSDC(transitWallet);

    log(
      "ORCH",
      `Waiting for daemon to sweep funds into router credits (≥${EXPECTED_SWEEP_CREDITS})…`,
    );
    const credits = await waitForCredits(EXPECTED_SWEEP_CREDITS);
    ok(`Router credits available: ${credits}`);

    await sleep(3_000);

    const serviceId = `e2e-test-${Date.now()}`;
    await runTests(serviceId);

    console.log("\n" + "═".repeat(72));
    console.log("  ✅  ALL E2E TESTS PASSED");
    console.log("═".repeat(72) + "\n");
  } catch (err: any) {
    console.error("\n" + "═".repeat(72));
    console.error("  ❌  E2E FAILED");
    console.error("═".repeat(72));
    console.error(err?.stack ?? err?.message ?? err);
    console.error("═".repeat(72) + "\n");
    process.exitCode = 1;
  } finally {
    teardown(daemon);
  }
}

process.on("SIGINT", () => {
  console.error("\n[e2e] SIGINT received — letting finally handler clean up.");
  process.exit(130);
});

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
