#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import express from "express";
import cors from "cors";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import fsPromises from "fs/promises";
import path from "path";
import os from "os";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseEther,
  formatEther,
} from "viem";
import { base } from "viem/chains";

// --- CONFIG & PATHS (Unchanged) ---
const CONFIG_DIR = path.join(os.homedir(), ".aegis");
const IDENTITY_PATH = path.join(CONFIG_DIR, "identity.json");

const AEGIS_API_URL =
  process.env.AEGIS_LOCAL_DEV === "true"
    ? "http://localhost:3000/api/parse"
    : "https://aegis-parse-production.up.railway.app/api/parse";
const AEGIS_ENTERPRISE_WALLET = "0xDb11E8ba517ecB97C30a77b34C6492d2e15FD510";

const RPC_URL = process.env.BASE_RPC_URL;
const publicClient = createPublicClient({
  chain: base,
  transport: http(RPC_URL),
});

// --- IDENTITY MANAGEMENT ---
function getOrCreateIdentity() {
  // 🔥 1. Check for Env Var Override first (For Production / Docker)
  if (process.env.AEGIS_PRIVATE_KEY) {
    try {
      let pk = process.env.AEGIS_PRIVATE_KEY;
      if (!pk.startsWith("0x")) pk = `0x${pk}`;

      const account = privateKeyToAccount(pk as `0x${string}`);
      return {
        account,
        activeTxHash: process.env.AEGIS_TX_HASH || null,
      };
    } catch (err) {
      console.error(
        "[Aegis] ❌ Invalid AEGIS_PRIVATE_KEY provided in environment variables.",
      );
      process.exit(1);
    }
  }

  // 2. Fallback to physical file logic for local development
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });

  if (existsSync(IDENTITY_PATH)) {
    try {
      const data = JSON.parse(readFileSync(IDENTITY_PATH, "utf-8"));
      if (data.privateKey) {
        return {
          account: privateKeyToAccount(data.privateKey),
          activeTxHash: data.activeTxHash || null,
        };
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
    activeTxHash: null,
    created: new Date().toISOString(),
  };

  writeFileSync(IDENTITY_PATH, JSON.stringify(identity, null, 2), {
    mode: 0o600,
  });
  return { account, activeTxHash: null };
}

let { account: userAccount, activeTxHash: globalTxHash } =
  getOrCreateIdentity();
const walletClient = createWalletClient({
  account: userAccount,
  chain: base,
  transport: http(RPC_URL),
});

let sweepLockChain: Promise<unknown> = Promise.resolve();

function withSweepLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = sweepLockChain.then(() => fn());
  sweepLockChain = run.catch(() => undefined);
  return run;
}

async function checkAndSweepFunds() {
  return withSweepLock(async () => {
    const balance = await publicClient.getBalance({
      address: userAccount.address,
    });
    const feeData = await publicClient.estimateFeesPerGas();
    const gasPrice =
      feeData.maxFeePerGas ?? feeData.gasPrice ?? parseEther("0.000000001");
    const estimatedGas = 21000n;
    const totalFee = gasPrice * estimatedGas;

    const safetyBuffer = totalFee / 20n;
    const minThreshold = parseEther("0.000005") + totalFee + safetyBuffer;

    if (balance >= minThreshold) {
      const valueToSend = balance - totalFee - safetyBuffer;

      if (valueToSend <= 0n) return globalTxHash;

      console.error(
        `[Aegis] 💰 Sweeping ${formatEther(valueToSend)} to Enterprise...`,
      );

      try {
        const hash = await walletClient.sendTransaction({
          to: AEGIS_ENTERPRISE_WALLET as `0x${string}`,
          value: valueToSend,
          gas: estimatedGas,
          ...(feeData.maxFeePerGas != null
            ? {
                maxFeePerGas: feeData.maxFeePerGas,
                maxPriorityFeePerGas:
                  feeData.maxPriorityFeePerGas ?? feeData.maxFeePerGas,
              }
            : { gasPrice }),
        });

        // Only try to save the hash to disk if we are NOT using the env var override
        if (!process.env.AEGIS_PRIVATE_KEY && existsSync(IDENTITY_PATH)) {
          const fileContent = await fsPromises.readFile(IDENTITY_PATH, "utf-8");
          const identityData = JSON.parse(fileContent);
          identityData.activeTxHash = hash;
          await fsPromises.writeFile(
            IDENTITY_PATH,
            JSON.stringify(identityData, null, 2),
            { mode: 0o600 },
          );
        }

        globalTxHash = hash;
        console.error(`[Aegis] ✅ Credits initialized. Hash: ${hash}`);
        return hash;
      } catch (err) {
        console.error("[Aegis] ❌ Sweep failed:", err);
      }
    }
    return globalTxHash;
  });
}

// 🔥 SHARED CORE ENGINE
async function executeScrapeRequest(url: string) {
  let currentHash;
  try {
    currentHash = await checkAndSweepFunds();
  } catch (rpcError: any) {
    throw new Error("RPC_ERROR: Could not connect to Base network.");
  }

  if (!currentHash) {
    throw new Error(
      `INSUFFICIENT_FUNDS: Please send Base ETH to ${userAccount.address}`,
    );
  }

  const timestamp = Date.now().toString();
  const message = `Aegis Parse Auth: ${currentHash}:${timestamp}`;
  const signature = await userAccount.signMessage({ message });

  const response = await fetch(AEGIS_API_URL, {
    method: "POST",
    headers: {
      "x-payment-token": currentHash,
      "x-signature": signature,
      "x-timestamp": timestamp,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ url }),
    signal: AbortSignal.timeout(45000),
  });

  if (response.status === 402) {
    throw new Error(
      `CREDITS_DEPLETED: Please top up by sending Base ETH to ${userAccount.address}`,
    );
  }

  if (!response.ok) {
    throw new Error(
      `API_ERROR: Target site timed out or WAF blocked (Status ${response.status})`,
    );
  }

  return await response.json();
}

// --- MODE 1: MCP SERVER LOGIC ---
async function startMcpServer() {
  const server = new McpServer({ name: "Aegis Parse", version: "1.0.0" });

  server.tool(
    "aegis_scrape",
    "Scrapes any URL into clean Markdown. Proves payment via on-chain signature.",
    { url: z.string().url() },
    async ({ url }) => {
      try {
        const responseData = await executeScrapeRequest(url);
        const { data, metadata } = responseData;
        const title = data?.title || "Untitled Page";
        const markdown = data?.content || "No content extracted.";
        const balance = metadata?.credit_balance ?? "Unknown";

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

// --- MODE 2: LOCAL DAEMON LOGIC ---
async function startDaemonServer(port: number) {
  const app = express();
  app.use(cors());
  app.use(express.json());

  app.post("/v1/extract", async (req, res) => {
    const { url } = req.body;

    if (!url) {
      return res.status(400).json({ error: "Missing 'url' in request body." });
    }

    try {
      const responseData = await executeScrapeRequest(url);
      res.status(200).json(responseData);
    } catch (error: any) {
      console.error(`[Daemon] Error scraping ${url}:`, error.message);

      let status = 500;
      if (
        error.message.includes("INSUFFICIENT_FUNDS") ||
        error.message.includes("CREDITS_DEPLETED")
      ) {
        status = 402; // Payment Required
      }

      res.status(status).json({ error: error.message });
    }
  });

  app.listen(port, () => {
    console.error(`🚀 Aegis Local Daemon Live on http://localhost:${port}`);
    console.error(`📫 Deposit Wallet: ${userAccount.address}`);
    console.error(
      `💡 Bot Usage: POST http://localhost:${port}/v1/extract { "url": "..." }`,
    );
  });
}

// --- THE ROUTER ---
async function main() {
  // Try to sweep on startup just in case funds arrived while offline
  try {
    await checkAndSweepFunds();
  } catch (e) {
    console.error("⚠️ Base RPC unavailable on startup.");
  }

  const args = process.argv.slice(2);
  const mode = args[0] || "mcp"; // Defaults to MCP if no arg is passed

  if (mode === "daemon") {
    // Find --port flag, default to 8080
    const portIndex = args.indexOf("--port");
    const port = portIndex > -1 ? parseInt(args[portIndex + 1]) : 8080;
    await startDaemonServer(port);
  } else {
    await startMcpServer();
  }
}

main().catch(console.error);
