#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import axios from "axios";
import fs from "fs";
import path from "path";
import os from "os";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createPublicClient, createWalletClient, http, parseEther, formatEther, } from "viem";
import { base } from "viem/chains";
// --- CONFIG & PATHS ---
const CONFIG_DIR = path.join(os.homedir(), ".aegis");
const IDENTITY_PATH = path.join(CONFIG_DIR, "identity.json");
// Adjust this URL based on whether you are testing locally or on Railway
// const AEGIS_API_URL = "http://localhost:3000/api/parse";
const AEGIS_API_URL = "https://aegis-parse-production.up.railway.app/api/parse";
const AEGIS_ENTERPRISE_WALLET = "0xDb11E8ba517ecB97C30a77b34C6492d2e15FD510"; // Your payout wallet
// Setup Viem Clients for Base
const publicClient = createPublicClient({ chain: base, transport: http() });
// --- IDENTITY MANAGEMENT ---
function getOrCreateIdentity() {
    if (!fs.existsSync(CONFIG_DIR))
        fs.mkdirSync(CONFIG_DIR, { recursive: true });
    if (fs.existsSync(IDENTITY_PATH)) {
        const data = JSON.parse(fs.readFileSync(IDENTITY_PATH, "utf-8"));
        return {
            account: privateKeyToAccount(data.privateKey),
            activeTxHash: data.activeTxHash || null,
        };
    }
    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);
    const identity = {
        address: account.address,
        privateKey: privateKey,
        activeTxHash: null,
        created: new Date().toISOString(),
    };
    fs.writeFileSync(IDENTITY_PATH, JSON.stringify(identity, null, 2), {
        mode: 0o600,
    });
    return { account, activeTxHash: null };
}
// Keep state mutable so we can update it in memory without restarting
let { account: userAccount, activeTxHash: globalTxHash } = getOrCreateIdentity();
const walletClient = createWalletClient({
    account: userAccount,
    chain: base,
    transport: http(),
});
// --- CORE LOGIC: SWEEP & SYNC ---
async function checkAndSweepFunds(forceSweep = false) {
    // FAST PATH: If we have a hash and aren't forced to check, skip the RPC call
    if (globalTxHash && !forceSweep)
        return globalTxHash;
    const balance = await publicClient.getBalance({
        address: userAccount.address,
    });
    // If balance is enough to cover the transfer + gas
    if (balance > parseEther("0.000005")) {
        console.error(`[Aegis] 💰 Deposit detected! Sweeping ${formatEther(balance)} to Aegis...`);
        try {
            const hash = await walletClient.sendTransaction({
                to: AEGIS_ENTERPRISE_WALLET,
                value: balance - parseEther("0.000004"), // Leave a tiny bit for gas
            });
            // Update File
            const identityData = JSON.parse(fs.readFileSync(IDENTITY_PATH, "utf-8"));
            identityData.activeTxHash = hash;
            fs.writeFileSync(IDENTITY_PATH, JSON.stringify(identityData, null, 2));
            // Update Memory
            globalTxHash = hash;
            console.error(`[Aegis] ✅ Credits initialized. Hash: ${hash}`);
            return hash;
        }
        catch (err) {
            console.error("[Aegis] ❌ Sweep failed:", err);
        }
    }
    return globalTxHash;
}
// --- MCP SERVER SETUP ---
const server = new McpServer({
    name: "Aegis Parse",
    version: "1.0.0",
});
server.tool("aegis_scrape", "Scrapes any URL into clean Markdown. Proves payment via on-chain signature.", { url: z.string().url() }, async ({ url }) => {
    // 1. Get the current hash (fast path)
    const currentHash = await checkAndSweepFunds(false);
    if (!currentHash) {
        return {
            content: [
                {
                    type: "text",
                    text: `⚠️ Aegis Wallet Empty. Please send Base ETH to: ${userAccount.address}`,
                },
            ],
            isError: true,
        };
    }
    try {
        // 2. Generate Cryptographic Challenge-Response
        const timestamp = Date.now().toString();
        const message = `Aegis Parse Auth: ${currentHash}:${timestamp}`;
        const signature = await userAccount.signMessage({ message });
        // 3. Call Railway API (The Source of Truth for Balance)
        const response = await axios.post(AEGIS_API_URL, { url }, {
            headers: {
                "x-payment-token": currentHash,
                "x-signature": signature,
                "x-timestamp": timestamp,
                "Content-Type": "application/json",
            },
            timeout: 45000,
        });
        // --- MAPPING UPDATE ---
        // We now map directly to your backend's specific JSON return structure
        const { data, metadata } = response.data;
        return {
            content: [
                {
                    type: "text",
                    text: `[Aegis Wallet Balance: ${metadata.credit_balance} Credits]\n\n# ${data.title}\n\n${data.content}`,
                },
            ],
        };
    }
    catch (error) {
        // If the server says we're broke, force a sweep check right now.
        if (error.response?.status === 402) {
            console.error("[Aegis] 402 Payment Required. Checking for new deposits...");
            const newHash = await checkAndSweepFunds(true);
            if (newHash && newHash !== currentHash) {
                return {
                    content: [
                        {
                            type: "text",
                            text: "🔄 Funds swept successfully! Please click retry on your prompt.",
                        },
                    ],
                    isError: true,
                };
            }
            return {
                content: [
                    {
                        type: "text",
                        text: "❌ Credits depleted. Please top up your Aegis wallet with Base ETH.",
                    },
                ],
                isError: true,
            };
        }
        return {
            content: [{ type: "text", text: `Error: ${error.message}` }],
            isError: true,
        };
    }
});
// --- STARTUP ---
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("🚀 Aegis MCP Live.");
    console.error(`📫 Wallet: ${userAccount.address}`);
    // Proactive check on startup
    const hash = await checkAndSweepFunds(true);
    if (hash) {
        console.error(`✅ Ready to scrape with hash: ${hash}`);
    }
    else {
        console.error("ℹ️ No pending deposits found. Waiting for funds...");
    }
}
main().catch(console.error);
