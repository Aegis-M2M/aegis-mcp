#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import express from "express";
import cors from "cors";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import os from "os";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createPublicClient, createWalletClient, http } from "viem";
import { base } from "viem/chains";
import { randomUUID } from "crypto";
import { DASHBOARD_HTML } from "./dashboard.js";

// --- USDC on Base ---
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;

const ERC20_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "nonces",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

// --- CONFIG & PATHS ---
// AEGIS_HOME overrides the default ~/.aegis location. Used by the E2E test
// harness to sandbox each daemon into a throwaway directory, but also handy
// for multi-tenant setups where a single machine runs several daemons under
// different identities.
const CONFIG_DIR = process.env.AEGIS_HOME
  ? path.resolve(process.env.AEGIS_HOME)
  : path.join(os.homedir(), ".aegis");
const IDENTITY_PATH = path.join(CONFIG_DIR, "identity.json");
const SERVICES_PATH = path.join(CONFIG_DIR, "services.json");

const AEGIS_ROUTER_URL =
  process.env.AEGIS_ROUTER_URL ||
  "https://aegis-router-production.up.railway.app";
const AEGIS_ROUTER_BASE = AEGIS_ROUTER_URL.replace(/\/$/, "");
const AEGIS_EXECUTE_ENDPOINT = `${AEGIS_ROUTER_BASE}/v1/execute`;
const AEGIS_FUND_ENDPOINT = `${AEGIS_ROUTER_BASE}/v1/fund`;
const AEGIS_REGISTER_ENDPOINT = `${AEGIS_ROUTER_BASE}/v1/register`;
const AEGIS_PAYOUT_CLAIM_ENDPOINT = `${AEGIS_ROUTER_BASE}/v1/payout/claim`;
const AEGIS_REGISTRY_STATS_ENDPOINT = (id: string) =>
  `${AEGIS_ROUTER_BASE}/v1/register/stats/${encodeURIComponent(id)}`;
const AEGIS_BALANCE_ENDPOINT = (wallet: string) =>
  `${AEGIS_ROUTER_BASE}/v1/balance/${wallet}`;

// ════════════════════════════════════════════════════════════════════
//  Provider secret keystore  (~/.aegis/services.json)
// ════════════════════════════════════════════════════════════════════
//
// Secrets never live in process env and are never logged. We keep the
// file at 0600 so only the daemon user can read it. The router stores
// an encrypted copy of the same secret; this file is purely so the
// local daemon can sign future privileged requests (claim, rotate).

const SERVICE_ID_RE = /^[a-z0-9][a-z0-9_-]{1,63}$/i;

interface StoredService {
  secret: string;
  endpoint_url: string;
  pricing_type: "FIXED" | "DYNAMIC";
  fixed_cost: number | null;
  payout_wallet: string;
  registered_at: string;
}

type ServicesFile = Record<string, StoredService>;

function loadServices(): ServicesFile {
  if (!existsSync(SERVICES_PATH)) return {};
  try {
    const raw = readFileSync(SERVICES_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as ServicesFile;
    }
  } catch (err) {
    console.error("[Aegis] ⚠️ services.json corrupted; starting fresh.");
  }
  return {};
}

function saveServices(data: ServicesFile): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(SERVICES_PATH, JSON.stringify(data, null, 2), { mode: 0o600 });
}

const AEGIS_ENTERPRISE_WALLET = "0xDb11E8ba517ecB97C30a77b34C6492d2e15FD510";

const RPC_URL = process.env.BASE_RPC_URL;
const publicClient = createPublicClient({
  chain: base,
  transport: http(RPC_URL),
});

// --- IDENTITY MANAGEMENT ---
function getOrCreateIdentity() {
  if (process.env.AEGIS_PRIVATE_KEY) {
    try {
      let pk = process.env.AEGIS_PRIVATE_KEY;
      if (!pk.startsWith("0x")) pk = `0x${pk}`;

      const account = privateKeyToAccount(pk as `0x${string}`);
      return { account };
    } catch (err) {
      console.error(
        "[Aegis] ❌ Invalid AEGIS_PRIVATE_KEY provided in environment variables.",
      );
      process.exit(1);
    }
  }

  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });

  if (existsSync(IDENTITY_PATH)) {
    try {
      const data = JSON.parse(readFileSync(IDENTITY_PATH, "utf-8"));
      if (data.privateKey) {
        return { account: privateKeyToAccount(data.privateKey) };
      }
    } catch (err) {
      console.error("[Aegis] ⚠️ identity.json corrupted. Generating new...");
    }
  }

  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  const identity = {
    address: account.address,
    privateKey: privateKey,
    created: new Date().toISOString(),
  };

  writeFileSync(IDENTITY_PATH, JSON.stringify(identity, null, 2), {
    mode: 0o600,
  });
  return { account };
}

const { account: userAccount } = getOrCreateIdentity();
const walletClient = createWalletClient({
  account: userAccount,
  chain: base,
  transport: http(RPC_URL),
});

// --- Aegis signed-request helper ---
//
// The Router authenticates every privileged call (register, update, claim)
// by recovering the signer from `x-signature` and comparing it to the
// service's `provider_wallet`. We sign every such outbound request with
// the Transit Wallet so the router can perform that check without any
// shared secret crossing the wire.
async function signAegisRequestHeaders(): Promise<Record<string, string>> {
  const timestamp = Date.now().toString();
  const message = `Aegis Auth: ${userAccount.address}:${timestamp}`;
  const signature = await userAccount.signMessage({ message });
  return {
    "x-wallet-address": userAccount.address,
    "x-signature": signature,
    "x-timestamp": timestamp,
  };
}

// --- USDC PERMIT (EIP-2612 Gasless Deposit) ---

let sweepLockChain: Promise<unknown> = Promise.resolve();

function withSweepLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = sweepLockChain.then(() => fn());
  sweepLockChain = run.catch(() => undefined);
  return run;
}

async function checkAndSweepFunds(): Promise<boolean> {
  return withSweepLock(async () => {
    const balance = await publicClient.readContract({
      address: BASE_USDC,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [userAccount.address],
    });

    if (balance <= 0n) return false;

    console.error(
      `[Aegis] 💰 USDC detected: ${Number(balance) / 1e6} USDC. Signing permit...`,
    );

    const nonce = await publicClient.readContract({
      address: BASE_USDC,
      abi: ERC20_ABI,
      functionName: "nonces",
      args: [userAccount.address],
    });

    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);

    const signature = await walletClient.signTypedData({
      domain: {
        name: "USD Coin",
        version: "2",
        chainId: base.id,
        verifyingContract: BASE_USDC,
      },
      types: {
        Permit: [
          { name: "owner", type: "address" },
          { name: "spender", type: "address" },
          { name: "value", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      primaryType: "Permit",
      message: {
        owner: userAccount.address,
        spender: AEGIS_ENTERPRISE_WALLET as `0x${string}`,
        value: balance,
        nonce,
        deadline,
      },
    });

    try {
      const res = await fetch(AEGIS_FUND_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          walletAddress: userAccount.address,
          amount: balance.toString(),
          deadline: deadline.toString(),
          signature,
        }),
        signal: AbortSignal.timeout(60_000),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        console.error(
          `[Aegis] ❌ Fund request failed (${res.status}):`,
          body.error ?? body,
        );
        return false;
      }

      const result = await res.json();
      console.error(
        `[Aegis] ✅ Deposit credited. Balance: ${result.credit_balance} credits`,
      );
      return true;
    } catch (err) {
      console.error("[Aegis] ❌ Fund request error:", err);
      return false;
    }
  });
}

// --- CALL FEED (in-memory ring buffer powering the dashboard) ---
type CallStatus = "pending" | "ok" | "err";
interface CallRecord {
  id: string;
  service: string;
  detail: string;
  status: CallStatus;
  credits_charged: number | null;
  credits_refunded: number | null;
  balance_after: number | null;
  started_at: number;
  duration_ms: number | null;
  error?: string | null;
}

const MAX_CALLS = 50;
const callFeed: CallRecord[] = [];

function summarizeRequest(service: string, req: any): string {
  if (!req || typeof req !== "object") return "";
  if (service === "aegis-parse" && typeof req.url === "string") return req.url;
  if (typeof req.url === "string") return req.url;
  if (typeof req.prompt === "string") return req.prompt;
  if (Array.isArray(req.messages) && req.messages.length > 0) {
    const last = req.messages[req.messages.length - 1];
    if (last && typeof last.content === "string") return last.content;
  }
  if (typeof req.model === "string") return `model: ${req.model}`;
  try {
    return JSON.stringify(req).slice(0, 120);
  } catch {
    return "";
  }
}

function pushCall(rec: CallRecord) {
  callFeed.unshift(rec);
  if (callFeed.length > MAX_CALLS) callFeed.length = MAX_CALLS;
}

function updateCall(id: string, patch: Partial<CallRecord>) {
  const idx = callFeed.findIndex((c) => c.id === id);
  if (idx === -1) return;
  callFeed[idx] = { ...callFeed[idx], ...patch };
}

// --- SHARED CORE ENGINE (Execution Envelope) ---
async function executeAegisRequest(
  service: string,
  requestPayload: any,
  maxCredits?: number,
) {
  const callId = randomUUID();
  const started = Date.now();

  pushCall({
    id: callId,
    service,
    detail: summarizeRequest(service, requestPayload),
    status: "pending",
    credits_charged: null,
    credits_refunded: null,
    balance_after: null,
    started_at: started,
    duration_ms: null,
  });

  try {
    await checkAndSweepFunds();
  } catch (rpcError: any) {
    console.error("[Aegis] ⚠️ RPC sweep check failed:", rpcError.message);
  }

  const timestamp = Date.now().toString();
  const message = `Aegis Auth: ${userAccount.address}:${timestamp}`;
  const signature = await userAccount.signMessage({ message });

  try {
    // `x-max-credits` is only meaningful for DYNAMIC services; the router
    // ignores it on FIXED pricing (contract price wins). We still forward
    // it when set so operators can enforce a cap on mixed-pricing agents
    // without branching on pricing_type at the call site.
    const response = await fetch(AEGIS_EXECUTE_ENDPOINT, {
      method: "POST",
      headers: {
        "x-wallet-address": userAccount.address,
        "x-signature": signature,
        "x-timestamp": timestamp,
        "Content-Type": "application/json",
        ...(typeof maxCredits === "number"
          ? { "x-max-credits": String(maxCredits) }
          : {}),
      },
      body: JSON.stringify({ service, request: requestPayload }),
      signal: AbortSignal.timeout(120_000),
    });

    if (response.status === 402) {
      updateCall(callId, {
        status: "err",
        duration_ms: Date.now() - started,
        error: "CREDITS_DEPLETED",
      });
      throw new Error(
        `CREDITS_DEPLETED: Please deposit USDC (Base) to ${userAccount.address}`,
      );
    }

    if (!response.ok) {
      updateCall(callId, {
        status: "err",
        duration_ms: Date.now() - started,
        error: `HTTP ${response.status}`,
      });
      throw new Error(
        `API_ERROR: Upstream request failed (Status ${response.status})`,
      );
    }

    const responseData: any = await response.json();
    const billing = responseData?.aegis_billing ?? {};
    updateCall(callId, {
      status: "ok",
      duration_ms: Date.now() - started,
      credits_charged: typeof billing.credits_charged === "number" ? billing.credits_charged : null,
      credits_refunded: typeof billing.credits_refunded === "number" ? billing.credits_refunded : null,
      balance_after: typeof billing.credit_balance === "number" ? billing.credit_balance : null,
    });

    return responseData;
  } catch (err: any) {
    const existing = callFeed.find((c) => c.id === callId);
    if (existing && existing.status === "pending") {
      updateCall(callId, {
        status: "err",
        duration_ms: Date.now() - started,
        error: err?.message ?? "unknown",
      });
    }
    throw err;
  }
}

// --- MODE 1: MCP SERVER LOGIC ---
async function startMcpServer() {
  const server = new McpServer({ name: "Aegis Network", version: "1.0.0" });

  server.tool(
    "aegis_scrape",
    "Scrapes any URL into clean Markdown. Proves payment via on-chain signature.",
    { url: z.string().url() },
    async ({ url }) => {
      try {
        const responseData = await executeAegisRequest("aegis-parse", { url });
        const { data, aegis_billing } = responseData;
        const title = data?.title || "Untitled Page";
        const markdown = data?.content || "No content extracted.";
        const balance = aegis_billing?.credit_balance ?? "Unknown";

        return {
          content: [
            {
              type: "text",
              text: `[Aegis Wallet Balance: ${balance} Credits]\n\n# ${title}\n\n${markdown}`,
            },
          ],
        };
      } catch (error: any) {
        return {
          content: [
            { type: "text", text: `❌ Scrape failed: ${error.message}` },
          ],
          isError: true,
        };
      }
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("🚀 Aegis MCP Live.");
  console.error(`📫 Wallet: ${userAccount.address}`);
}

// --- Router balance proxy (fed into the dashboard) ---
interface BalanceSnapshot {
  credits: number | null;
  usd_value: number | null;
  scrapes_remaining: number | null;
  fetched_at: number;
  error: string | null;
}

let lastBalance: BalanceSnapshot = {
  credits: null,
  usd_value: null,
  scrapes_remaining: null,
  fetched_at: 0,
  error: null,
};

const BALANCE_STALE_MS = 3_000;
let inflightBalance: Promise<BalanceSnapshot> | null = null;

async function fetchBalance(force = false): Promise<BalanceSnapshot> {
  const fresh = Date.now() - lastBalance.fetched_at < BALANCE_STALE_MS;
  if (!force && fresh && lastBalance.error === null) return lastBalance;
  if (inflightBalance) return inflightBalance;

  inflightBalance = (async () => {
    try {
      const res = await fetch(AEGIS_BALANCE_ENDPOINT(userAccount.address), {
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) {
        lastBalance = {
          credits: null,
          usd_value: null,
          scrapes_remaining: null,
          fetched_at: Date.now(),
          error: `router ${res.status}`,
        };
      } else {
        const data: any = await res.json();
        lastBalance = {
          credits: typeof data.credits === "number" ? data.credits : null,
          usd_value: typeof data.usd_value === "number" ? data.usd_value : null,
          scrapes_remaining:
            typeof data.scrapes_remaining === "number"
              ? data.scrapes_remaining
              : null,
          fetched_at: Date.now(),
          error: null,
        };
      }
    } catch (err: any) {
      lastBalance = {
        credits: null,
        usd_value: null,
        scrapes_remaining: null,
        fetched_at: Date.now(),
        error: err?.message ?? "unreachable",
      };
    } finally {
      inflightBalance = null;
    }
    return lastBalance;
  })();

  return inflightBalance;
}

// --- MODE 2: LOCAL DAEMON LOGIC ---
async function startDaemonServer(port: number) {
  const app = express();

  // SECURITY: The daemon controls a live Web3 wallet and can spend USDC.
  // A permissive CORS policy would let any website the user visits issue
  // fetch('http://localhost:<port>/v1/execute', ...) in the background and
  // drain credits. We restrict origins to the local dashboard only.
  // Extra allowed origins can be injected via AEGIS_ALLOWED_ORIGINS (comma-separated).
  const extraOrigins = (process.env.AEGIS_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);

  const allowedOrigins = new Set<string>([
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
    ...extraOrigins,
  ]);

  app.use(
    cors({
      origin: (origin, cb) => {
        // Allow same-origin / non-browser clients (curl, local scripts) which
        // send no Origin header. Reject any cross-origin browser request that
        // isn't explicitly whitelisted.
        if (!origin) return cb(null, true);
        if (allowedOrigins.has(origin)) return cb(null, true);
        return cb(new Error(`Origin not allowed: ${origin}`));
      },
    }),
  );
  app.use(express.json());

  app.get("/", (_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.send(DASHBOARD_HTML);
  });

  app.get("/api/status", async (_req, res) => {
    const bal = await fetchBalance();
    res.json({
      wallet: userAccount.address,
      credits: bal.credits,
      usd_value: bal.usd_value,
      scrapes_remaining: bal.scrapes_remaining,
      router_online: bal.error === null,
      balance_error: bal.error,
      balance_fetched_at: bal.fetched_at,
      calls: callFeed,
    });
  });

  // ══════════════════════════════════════════════════════════════════
  //  Provider Portal endpoints
  // ══════════════════════════════════════════════════════════════════

  // Atomic Test & Register:
  //   1. POST sample_request to the provider's own endpoint_url using
  //      their secret as a Bearer token. If that fails, STOP — we never
  //      touch the global registry with a broken configuration.
  //   2. Probe the Router for an existing registration under this id so
  //      we know whether to POST (create) or PUT (update). This also lets
  //      us surface an early 403 before asking the router to do anything.
  //   3. Send the signed request. Every call to the registry is signed by
  //      the Transit Wallet (identity.json), which the router treats as
  //      the sole owner of this service.
  //   4. On success, persist a local record so the dashboard can show
  //      "this daemon controls this service".
  app.post("/api/provider/register", async (req, res) => {
    const { id, endpoint_url, pricing_type, fixed_cost, secret, sample_request } =
      req.body ?? {};

    if (typeof id !== "string" || !SERVICE_ID_RE.test(id)) {
      return res.status(400).json({
        error: "INVALID_ID",
        message:
          "id must be 2-64 chars of letters, digits, dashes or underscores.",
      });
    }

    if (typeof endpoint_url !== "string" || !/^https?:\/\//i.test(endpoint_url)) {
      return res.status(400).json({
        error: "INVALID_ENDPOINT_URL",
        message: "endpoint_url must be an absolute http(s) URL.",
      });
    }

    if (pricing_type !== "FIXED" && pricing_type !== "DYNAMIC") {
      return res.status(400).json({
        error: "INVALID_PRICING_TYPE",
        message: "pricing_type must be 'FIXED' or 'DYNAMIC'.",
      });
    }

    let normalizedFixedCost: number | null = null;
    if (pricing_type === "FIXED") {
      if (
        typeof fixed_cost !== "number" ||
        !Number.isInteger(fixed_cost) ||
        fixed_cost <= 0
      ) {
        return res.status(400).json({
          error: "INVALID_FIXED_COST",
          message:
            "fixed_cost must be a positive integer when pricing_type is 'FIXED'.",
        });
      }
      normalizedFixedCost = fixed_cost;
    }

    if (typeof secret !== "string" || secret.length === 0) {
      return res.status(400).json({
        error: "MISSING_SECRET",
        message: "secret is required.",
      });
    }

    if (
      sample_request === undefined ||
      sample_request === null ||
      typeof sample_request !== "object" ||
      Array.isArray(sample_request)
    ) {
      return res.status(400).json({
        error: "INVALID_SAMPLE_REQUEST",
        message: "sample_request must be a JSON object.",
      });
    }

    // Ownership is tied to the Transit Wallet. The dashboard no longer lets
    // the user pick a separate payout wallet — whoever signs with this
    // identity.json *is* the provider wallet.
    const providerWallet = userAccount.address;

    // ── Step 1: Probe for an existing registration ───────────────
    // Determines POST (create) vs PUT (update) up front so we can apply
    // the right policy to the local test below: creation must prove the
    // endpoint actually works, but updates are authorised by ownership
    // alone — the operator may legitimately be rotating a secret,
    // pointing at a stub, or parking the service on a 5xx while
    // maintenance is ongoing. Running the local test on updates would
    // turn that into a rug pull for the owner.
    let method: "POST" | "PUT" = "POST";
    try {
      const probe = await fetch(AEGIS_REGISTRY_STATS_ENDPOINT(id), {
        signal: AbortSignal.timeout(8_000),
      });
      if (probe.ok) {
        const stats: any = await probe.json().catch(() => ({}));
        const existingOwner: string | undefined = stats?.service?.provider_wallet;
        if (
          typeof existingOwner === "string" &&
          existingOwner.toLowerCase() !== providerWallet.toLowerCase()
        ) {
          return res.status(403).json({
            error: "NOT_OWNER",
            stage: "ownership_check",
            message:
              "This service id is owned by another wallet. Pick a new id, or run the daemon with the identity that owns it.",
            owner: existingOwner,
            signer: providerWallet,
          });
        }
        method = "PUT";
      } else if (probe.status !== 404) {
        // Any non-404 non-200 is a router problem — surface it rather
        // than silently attempting a POST.
        const body: any = await probe.json().catch(() => ({}));
        return res.status(502).json({
          error: "ROUTER_PROBE_FAILED",
          stage: "ownership_check",
          message: body?.message ?? `Router returned ${probe.status} during probe.`,
        });
      }
    } catch (err: any) {
      return res.status(502).json({
        error: "ROUTER_UNREACHABLE",
        stage: "ownership_check",
        message: `Could not reach Aegis Router: ${err?.message ?? err}`,
      });
    }

    // ── Step 2: The Local Test (creation only) ───────────────────
    // Skipped for PUT — see rationale on Step 1.
    if (method === "POST") {
      let localResponse: Response;
      try {
        localResponse = await fetch(endpoint_url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${secret}`,
          },
          body: JSON.stringify(sample_request),
          signal: AbortSignal.timeout(15_000),
        });
      } catch (err: any) {
        return res.status(400).json({
          error: "LOCAL_UNREACHABLE",
          stage: "local_test",
          message: `Could not reach ${endpoint_url}: ${err?.message ?? err}`,
        });
      }

      if (!localResponse.ok) {
        const bodyText = await localResponse.text().catch(() => "");
        return res.status(400).json({
          error: "LOCAL_TEST_FAILED",
          stage: "local_test",
          upstream_status: localResponse.status,
          message: `Your endpoint returned ${localResponse.status}. Fix it before registering.`,
          upstream_body: bodyText.slice(0, 2_000),
        });
      }
    }

    // ── Step 3: Send the signed request ──────────────────────────
    // The POST body carries the new-creation fields; the PUT body uses
    // `new_secret` for the rotation field name the router expects on
    // updates. We never send a `current_secret` — the signature is the
    // proof of ownership.
    const payload: Record<string, unknown> =
      method === "POST"
        ? {
            id,
            provider_wallet: providerWallet,
            endpoint_url,
            pricing_type,
            fixed_cost: normalizedFixedCost,
            provider_secret: secret,
          }
        : {
            id,
            endpoint_url,
            new_secret: secret,
          };

    let routerResponse: Response;
    try {
      routerResponse = await fetch(AEGIS_REGISTER_ENDPOINT, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(await signAegisRequestHeaders()),
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err: any) {
      return res.status(502).json({
        error: "ROUTER_UNREACHABLE",
        stage: "router_sync",
        message: `Could not reach Aegis Router: ${err?.message ?? err}`,
      });
    }

    const routerBody: any = await routerResponse.json().catch(() => ({}));

    if (!routerResponse.ok) {
      return res.status(routerResponse.status).json({
        error: routerBody?.error ?? "ROUTER_ERROR",
        stage: "router_sync",
        message: routerBody?.message ?? "Router rejected the registration.",
        router_body: routerBody,
      });
    }

    // ── Step 4: Persist locally ──────────────────────────────────
    // We still keep the provider secret on disk so the operator can
    // re-run sample tests or rotate the bearer token later. Router
    // auth no longer depends on it.
    try {
      const services = loadServices();
      services[id] = {
        secret,
        endpoint_url,
        pricing_type,
        fixed_cost: normalizedFixedCost,
        payout_wallet: providerWallet,
        registered_at: new Date().toISOString(),
      };
      saveServices(services);
    } catch (err: any) {
      console.error("[Provider] Failed to persist services.json:", err);
      return res.status(500).json({
        error: "PERSIST_FAILED",
        stage: "persist",
        message:
          "Registered on the router, but failed to save the service locally.",
      });
    }

    return res.status(200).json({
      ok: true,
      stage: "complete",
      method,
      service: routerBody?.service ?? {
        id,
        provider_wallet: providerWallet,
        endpoint_url,
        pricing_type,
        fixed_cost: normalizedFixedCost,
      },
      updated: method === "PUT" || !!routerBody?.updated,
    });
  });

  // Claims are authorised by the Transit Wallet signature. The daemon no
  // longer needs the plaintext provider secret to prove it owns the
  // service — the router recovers `x-wallet-address` from `x-signature`
  // and compares it to the service's `provider_wallet`.
  app.post("/api/provider/claim", async (req, res) => {
    const { id } = req.body ?? {};

    if (typeof id !== "string" || !SERVICE_ID_RE.test(id)) {
      return res.status(400).json({
        error: "INVALID_ID",
        message: "id must match the service id format.",
      });
    }

    let routerResponse: Response;
    try {
      routerResponse = await fetch(AEGIS_PAYOUT_CLAIM_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(await signAegisRequestHeaders()),
        },
        body: JSON.stringify({ id }),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (err: any) {
      return res.status(502).json({
        error: "ROUTER_UNREACHABLE",
        message: `Could not reach Aegis Router: ${err?.message ?? err}`,
      });
    }

    const body: any = await routerResponse.json().catch(() => ({}));
    return res.status(routerResponse.status).json(body);
  });

  // Proxy provider stats so the dashboard can stay same-origin. We
  // augment the payload with two local-only signals so the UI can make
  // decisions without a second round-trip:
  //   • local_registered — id appears in services.json on this daemon.
  //   • is_owner         — the service's provider_wallet matches this
  //                        daemon's Transit Wallet, i.e. we can sign a
  //                        claim on its behalf.
  app.get("/api/provider/stats/:id", async (req, res) => {
    const { id } = req.params;
    if (!SERVICE_ID_RE.test(id)) {
      return res.status(400).json({ error: "INVALID_ID" });
    }

    try {
      const r = await fetch(AEGIS_REGISTRY_STATS_ENDPOINT(id), {
        signal: AbortSignal.timeout(8_000),
      });
      const body: any = await r.json().catch(() => ({}));
      const services = loadServices();
      const ownerOnRouter: string | undefined = body?.service?.provider_wallet;
      const isOwner =
        typeof ownerOnRouter === "string" &&
        ownerOnRouter.toLowerCase() === userAccount.address.toLowerCase();
      return res.status(r.status).json({
        ...body,
        local_registered: !!services[id],
        is_owner: isOwner,
        signer_wallet: userAccount.address,
      });
    } catch (err: any) {
      return res.status(502).json({
        error: "ROUTER_UNREACHABLE",
        message: err?.message ?? "unreachable",
      });
    }
  });

  app.post("/v1/execute", async (req, res) => {
    const { service, request, maxCredits } = req.body ?? {};

    if (!service || !request) {
      return res
        .status(400)
        .json({ error: "Missing 'service' or 'request' in body envelope." });
    }

    // Optional consumer-side spend cap. The router honours this as
    // `x-max-credits` only for DYNAMIC pricing; for FIXED services we
    // must enforce it locally because the router will happily charge the
    // contract price regardless. Enforcing on the daemon catches the
    // mismatch *before* the provider is even contacted — which is what
    // the user expects when they set a cap.
    let maxCreditsNum: number | undefined;
    if (maxCredits !== undefined && maxCredits !== null) {
      const parsed = Number(maxCredits);
      if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
        return res.status(400).json({
          error: "INVALID_MAX_CREDITS",
          message: "`maxCredits` must be a positive integer when provided.",
        });
      }
      maxCreditsNum = parsed;

      // Pre-flight: probe the service's contract. A probe failure is not
      // fatal — we fall through and let the router/pricing-layer decide.
      try {
        const probe = await fetch(AEGIS_REGISTRY_STATS_ENDPOINT(service), {
          signal: AbortSignal.timeout(5_000),
        });
        if (probe.ok) {
          const stats: any = await probe.json().catch(() => ({}));
          const pt = stats?.service?.pricing_type;
          const fc = stats?.service?.fixed_cost;
          if (
            pt === "FIXED" &&
            typeof fc === "number" &&
            fc > maxCreditsNum
          ) {
            return res.status(402).json({
              error: "MAX_CREDITS_TOO_LOW",
              message: `Service "${service}" requires ${fc} credits; caller's maxCredits cap is ${maxCreditsNum}.`,
              required: fc,
              maxCredits: maxCreditsNum,
            });
          }
        }
      } catch {
        // Probe failed; skip the pre-check and fall through.
      }
    }

    try {
      const responseData = await executeAegisRequest(
        service,
        request,
        maxCreditsNum,
      );
      res.status(200).json(responseData);
    } catch (error: any) {
      console.error(`[Daemon] Error executing ${service}:`, error.message);

      let status = 500;
      if (
        error.message.includes("INSUFFICIENT_FUNDS") ||
        error.message.includes("CREDITS_DEPLETED")
      ) {
        status = 402;
      }

      res.status(status).json({ error: error.message });
    }
  });

  app.listen(port, () => {
    console.error(`🚀 Aegis Local Daemon Live on http://localhost:${port}`);
    console.error(`📊 Dashboard: http://localhost:${port}`);
    console.error(`📫 Deposit USDC (Base) to: ${userAccount.address}`);
    console.error(
      `💡 Bot Usage: POST http://localhost:${port}/v1/execute { "service": "...", "request": {...} }`,
    );
  });

  // Warm the balance cache so the first dashboard load is instant.
  fetchBalance(true).catch(() => undefined);

  // Background sweep poll. Without this, USDC deposited *after* startup
  // would sit idle until the user made an execute call. A cheap chain
  // read every few seconds keeps the transit wallet drained into credits
  // the moment funds land — which is what the dashboard/e2e flow expects.
  // Tunable via AEGIS_SWEEP_INTERVAL_MS; set to 0 to disable.
  const sweepIntervalMs = Number(process.env.AEGIS_SWEEP_INTERVAL_MS ?? 8_000);
  if (Number.isFinite(sweepIntervalMs) && sweepIntervalMs > 0) {
    const sweepTimer = setInterval(() => {
      checkAndSweepFunds().catch((err) => {
        console.error("[Aegis] ⚠️ Background sweep failed:", err?.message ?? err);
      });
    }, sweepIntervalMs);
    // Unref so the timer never blocks process exit (e.g. SIGTERM teardown).
    sweepTimer.unref?.();
  }
}

// --- THE ROUTER ---
async function main() {
  try {
    await checkAndSweepFunds();
  } catch (e) {
    console.error("⚠️ Base RPC unavailable on startup.");
  }

  const args = process.argv.slice(2);
  const mode = args[0] || "mcp";

  if (mode === "daemon" || mode === "start") {
    const portIndex = args.indexOf("--port");
    const port = portIndex > -1 ? parseInt(args[portIndex + 1]) : 23447;
    await startDaemonServer(port);
  } else {
    await startMcpServer();
  }
}

main().catch(console.error);
