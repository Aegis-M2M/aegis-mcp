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
import { createPublicClient, createWalletClient, http, parseEther, formatEther, } from "viem";
import { base } from "viem/chains";
// --- CONFIG & PATHS ---
const CONFIG_DIR = path.join(os.homedir(), ".aegis");
const IDENTITY_PATH = path.join(CONFIG_DIR, "identity.json");
// 🔥 UPDATED: Now points to the Unified Router Execute endpoint
const AEGIS_ROUTER_URL = process.env.AEGIS_ROUTER_URL ||
    "https://aegis-router-production.up.railway.app";
const AEGIS_EXECUTE_ENDPOINT = `${AEGIS_ROUTER_URL.replace(/\/$/, "")}/v1/execute`;
const AEGIS_ENTERPRISE_WALLET = "0xDb11E8ba517ecB97C30a77b34C6492d2e15FD510";
const RPC_URL = process.env.BASE_RPC_URL;
const publicClient = createPublicClient({
    chain: base,
    transport: http(RPC_URL),
});
// --- IDENTITY MANAGEMENT (Unchanged) ---
function getOrCreateIdentity() {
    if (process.env.AEGIS_PRIVATE_KEY) {
        try {
            let pk = process.env.AEGIS_PRIVATE_KEY;
            if (!pk.startsWith("0x"))
                pk = `0x${pk}`;
            const account = privateKeyToAccount(pk);
            return {
                account,
                activeTxHash: process.env.AEGIS_TX_HASH || null,
            };
        }
        catch (err) {
            console.error("[Aegis] ❌ Invalid AEGIS_PRIVATE_KEY provided in environment variables.");
            process.exit(1);
        }
    }
    if (!existsSync(CONFIG_DIR))
        mkdirSync(CONFIG_DIR, { recursive: true });
    if (existsSync(IDENTITY_PATH)) {
        try {
            const data = JSON.parse(readFileSync(IDENTITY_PATH, "utf-8"));
            if (data.privateKey) {
                return {
                    account: privateKeyToAccount(data.privateKey),
                    activeTxHash: data.activeTxHash || null,
                };
            }
        }
        catch (err) {
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
let { account: userAccount, activeTxHash: globalTxHash } = getOrCreateIdentity();
const walletClient = createWalletClient({
    account: userAccount,
    chain: base,
    transport: http(RPC_URL),
});
let sweepLockChain = Promise.resolve();
function withSweepLock(fn) {
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
        const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice ?? parseEther("0.000000001");
        const estimatedGas = 21000n;
        const totalFee = gasPrice * estimatedGas;
        const safetyBuffer = totalFee / 20n;
        const minThreshold = parseEther("0.000005") + totalFee + safetyBuffer;
        if (balance >= minThreshold) {
            const valueToSend = balance - totalFee - safetyBuffer;
            if (valueToSend <= 0n)
                return globalTxHash;
            console.error(`[Aegis] 💰 Sweeping ${formatEther(valueToSend)} to Enterprise...`);
            try {
                const hash = await walletClient.sendTransaction({
                    to: AEGIS_ENTERPRISE_WALLET,
                    value: valueToSend,
                    gas: estimatedGas,
                    ...(feeData.maxFeePerGas != null
                        ? {
                            maxFeePerGas: feeData.maxFeePerGas,
                            maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ?? feeData.maxFeePerGas,
                        }
                        : { gasPrice }),
                });
                if (!process.env.AEGIS_PRIVATE_KEY && existsSync(IDENTITY_PATH)) {
                    const fileContent = await fsPromises.readFile(IDENTITY_PATH, "utf-8");
                    const identityData = JSON.parse(fileContent);
                    identityData.activeTxHash = hash;
                    await fsPromises.writeFile(IDENTITY_PATH, JSON.stringify(identityData, null, 2), { mode: 0o600 });
                }
                globalTxHash = hash;
                console.error(`[Aegis] ✅ Credits initialized. Hash: ${hash}`);
                return hash;
            }
            catch (err) {
                console.error("[Aegis] ❌ Sweep failed:", err);
            }
        }
        return globalTxHash;
    });
}
// 🔥 UPDATED: SHARED CORE ENGINE (Universal Envelope Proxy)
async function executeAegisRequest(service, requestPayload) {
    let currentHash;
    try {
        currentHash = await checkAndSweepFunds();
    }
    catch (rpcError) {
        throw new Error("RPC_ERROR: Could not connect to Base network.");
    }
    if (!currentHash) {
        throw new Error(`INSUFFICIENT_FUNDS: Please send Base ETH to ${userAccount.address}`);
    }
    const timestamp = Date.now().toString();
    const message = `Aegis Parse Auth: ${currentHash}:${timestamp}`;
    const signature = await userAccount.signMessage({ message });
    const response = await fetch(AEGIS_EXECUTE_ENDPOINT, {
        method: "POST",
        headers: {
            "x-payment-token": currentHash,
            "x-signature": signature,
            "x-timestamp": timestamp,
            "Content-Type": "application/json",
        },
        // We now wrap everything in the unified execution envelope
        body: JSON.stringify({ service, request: requestPayload }),
        signal: AbortSignal.timeout(120000), // Extended for LLM responses
    });
    if (response.status === 402) {
        throw new Error(`CREDITS_DEPLETED: Please top up by sending Base ETH to ${userAccount.address}`);
    }
    if (!response.ok) {
        throw new Error(`API_ERROR: Upstream request failed (Status ${response.status})`);
    }
    return await response.json();
}
// --- MODE 1: MCP SERVER LOGIC ---
async function startMcpServer() {
    const server = new McpServer({ name: "Aegis Network", version: "1.0.0" });
    server.tool("aegis_scrape", "Scrapes any URL into clean Markdown. Proves payment via on-chain signature.", { url: z.string().url() }, async ({ url }) => {
        try {
            // Updated to use the new execution envelope
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
        }
        catch (error) {
            return {
                content: [
                    { type: "text", text: `❌ Scrape failed: ${error.message}` },
                ],
                isError: true,
            };
        }
    });
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("🚀 Aegis MCP Live.");
    console.error(`📫 Wallet: ${userAccount.address}`);
}
// --- MODE 2: LOCAL DAEMON LOGIC ---
async function startDaemonServer(port) {
    const app = express();
    app.use(cors());
    app.use(express.json());
    // 🔥 UPDATED: Now exposes the unified /v1/execute route locally
    app.post("/v1/execute", async (req, res) => {
        const { service, request } = req.body;
        if (!service || !request) {
            return res
                .status(400)
                .json({ error: "Missing 'service' or 'request' in body envelope." });
        }
        try {
            const responseData = await executeAegisRequest(service, request);
            res.status(200).json(responseData);
        }
        catch (error) {
            console.error(`[Daemon] Error executing ${service}:`, error.message);
            let status = 500;
            if (error.message.includes("INSUFFICIENT_FUNDS") ||
                error.message.includes("CREDITS_DEPLETED")) {
                status = 402; // Payment Required
            }
            res.status(status).json({ error: error.message });
        }
    });
    app.listen(port, () => {
        console.error(`🚀 Aegis Local Daemon Live on http://localhost:${port}`);
        console.error(`📫 Deposit Wallet: ${userAccount.address}`);
        console.error(`💡 Bot Usage: POST http://localhost:${port}/v1/execute { "service": "...", "request": {...} }`);
    });
}
// --- THE ROUTER ---
async function main() {
    try {
        await checkAndSweepFunds();
    }
    catch (e) {
        console.error("⚠️ Base RPC unavailable on startup.");
    }
    const args = process.argv.slice(2);
    // Support both "daemon" and "start" as aliases to start the server
    const mode = args[0] || "mcp";
    if (mode === "daemon" || mode === "start") {
        const portIndex = args.indexOf("--port");
        const port = portIndex > -1 ? parseInt(args[portIndex + 1]) : 8080;
        await startDaemonServer(port);
    }
    else {
        await startMcpServer();
    }
}
main().catch(console.error);
