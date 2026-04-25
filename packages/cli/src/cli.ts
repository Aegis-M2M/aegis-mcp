#!/usr/bin/env node
import express from "express";
import cors from "cors";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import os from "os";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createPublicClient, createWalletClient, http } from "viem";
import { base } from "viem/chains";
import { randomUUID } from "crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { DASHBOARD_HTML } from "./dashboard.js";
import { z } from "zod";
import { Composio } from "@composio/core";

// --- CONFIG & PATHS ---
const CONFIG_DIR = process.env.AEGIS_HOME
  ? path.resolve(process.env.AEGIS_HOME)
  : path.join(os.homedir(), ".aegis");
const IDENTITY_PATH = path.join(CONFIG_DIR, "identity.json");
const SERVICES_PATH = path.join(CONFIG_DIR, "services.json");
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const AEGIS_ENTERPRISE_WALLET = "0xDb11E8ba517ecB97C30a77b34C6492d2e15FD510";
const AEGIS_USER_ID = process.env.AEGIS_USER_ID || "default";

const AEGIS_ROUTER_URL =
  process.env.AEGIS_ROUTER_URL ||
  "https://aegis-router-production.up.railway.app";
const AEGIS_ROUTER_BASE = AEGIS_ROUTER_URL.replace(/\/$/, "");
const AEGIS_EXECUTE_ENDPOINT = `${AEGIS_ROUTER_BASE}/v1/execute`;
const AEGIS_FUND_ENDPOINT = `${AEGIS_ROUTER_BASE}/v1/fund`;
const AEGIS_REGISTER_ENDPOINT = `${AEGIS_ROUTER_BASE}/v1/register`;
const AEGIS_REGISTRY_STATS_ENDPOINT = (id: string) =>
  `${AEGIS_ROUTER_BASE}/v1/register/stats/${encodeURIComponent(id)}`;
const AEGIS_BALANCE_ENDPOINT = (wallet: string) =>
  `${AEGIS_ROUTER_BASE}/v1/balance/${wallet}`;

const SERVICE_ID_RE = /^[a-z0-9][a-z0-9_-]{1,63}$/i;

// --- COMPOSIO DIRECT INTEGRATION ---
const composio = new Composio({
  apiKey: process.env.COMPOSIO_API_KEY,
});

/**
 * Transforms Composio tool metadata into MCP-compatible Tool objects.
 */
function transformComposioToMcp(toolMeta: any) {
  // Account for different SDK metadata shapes
  const params =
    toolMeta.parameters || toolMeta.schema || toolMeta.expected_schema || {};
  return {
    name: (toolMeta.slug || toolMeta.name).toLowerCase(),
    description:
      toolMeta.description || `Execute ${toolMeta.name} via Composio`,
    inputSchema: {
      type: "object",
      properties: params.properties || {},
      required: params.required || [],
      additionalProperties: false,
    },
  };
}

const AegisActionsInputSchema = z.object({
  action: z.string().min(1),
  params: z.record(z.string(), z.unknown()).default({}),
  user_id: z.string().min(1),
});

function inferToolkitSlug(action: string): string | null {
  const prefix = action.split("_")[0]?.trim();
  if (!prefix) return null;
  const slug = prefix.toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(slug)) return null;
  return slug;
}

async function composioHasActiveConnection(
  userId: string,
  toolkitSlug: string,
): Promise<boolean> {
  const resp: any = await composio.connectedAccounts.list({
    userIds: [userId],
    toolkitSlugs: [toolkitSlug],
    statuses: ["ACTIVE"],
  });
  const items = Array.isArray(resp?.items) ? resp.items : [];
  return items.length > 0;
}

async function composioCreateConnectionRequestLink(
  userId: string,
  toolkitSlug: string,
): Promise<string> {
  const request: any = await composio.toolkits.authorize(userId, toolkitSlug);
  const redirectUrl = request?.redirectUrl;
  if (typeof redirectUrl !== "string" || redirectUrl.length === 0) {
    throw new Error("Composio did not return a redirectUrl for authorization.");
  }
  return redirectUrl;
}

/**
 * DIRECT SDK EXECUTION
 * Replaces the unreliable forwardToComposioProxy.
 */
async function executeComposioActionDirect(
  userId: string,
  action: string,
  params: any,
) {
  if (!process.env.COMPOSIO_API_KEY) {
    throw new Error("COMPOSIO_API_KEY is not set.");
  }

  console.error(`\n[COMPOSIO EXECUTE] 🚀 Action: ${action} | User: ${userId}`);
  console.error(`Params: ${JSON.stringify(params)}`);

  try {
    const result = await composio.tools.execute(action, {
      userId,
      arguments: params ?? {},
      dangerouslySkipVersionCheck: true,
    });

    console.error(`[COMPOSIO SUCCESS] ✅ Result received.`);
    return result;
  } catch (err: any) {
    console.error(`[COMPOSIO ERROR] ❌ SDK Crash:`, err.message);
    if (err.cause) console.error(`[CAUSE]:`, err.cause);
    throw err;
  }
}

// --- VIEM & WEB3 ---
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

const publicClient = createPublicClient({
  chain: base,
  transport: http(process.env.BASE_RPC_URL),
});

// --- IDENTITY & DATA PERSISTENCE ---
function loadServices() {
  if (!existsSync(SERVICES_PATH)) return {};
  try {
    return JSON.parse(readFileSync(SERVICES_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function saveServices(data: any) {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(SERVICES_PATH, JSON.stringify(data, null, 2), { mode: 0o600 });
}

function ensureBuiltinServices(): void {
  // Intentionally no longer injects any static Composio/Aegis "actions" tool.
  // The MCP server dynamically discovers Composio actions at runtime.
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  if (!existsSync(SERVICES_PATH)) saveServices({});
}

function getOrCreateIdentity() {
  if (process.env.AEGIS_PRIVATE_KEY) {
    let pk = process.env.AEGIS_PRIVATE_KEY;
    if (!pk.startsWith("0x")) pk = `0x${pk}`;
    return { account: privateKeyToAccount(pk as `0x${string}`) };
  }
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  if (existsSync(IDENTITY_PATH)) {
    try {
      const data = JSON.parse(readFileSync(IDENTITY_PATH, "utf-8"));
      if (data.privateKey)
        return { account: privateKeyToAccount(data.privateKey) };
    } catch {
      /* gen new */
    }
  }
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  writeFileSync(
    IDENTITY_PATH,
    JSON.stringify(
      {
        address: account.address,
        privateKey,
        created: new Date().toISOString(),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  return { account };
}

const { account: userAccount } = getOrCreateIdentity();
const walletClient = createWalletClient({
  account: userAccount,
  chain: base,
  transport: http(process.env.BASE_RPC_URL),
});

async function signAegisRequestHeaders() {
  const timestamp = Date.now().toString();
  const message = `Aegis Auth: ${userAccount.address}:${timestamp}`;
  const signature = await userAccount.signMessage({ message });
  return {
    "x-wallet-address": userAccount.address,
    "x-signature": signature,
    "x-timestamp": timestamp,
  };
}

// --- ECONOMY & EXECUTION ---
async function checkAndSweepFunds() {
  const balance = await publicClient.readContract({
    address: BASE_USDC,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [userAccount.address],
  });
  if (balance <= 0n) return false;
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
  const res = await fetch(AEGIS_FUND_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      walletAddress: userAccount.address,
      amount: balance.toString(),
      deadline: deadline.toString(),
      signature,
    }),
  });
  return res.ok;
}

const callFeed: any[] = [];
async function executeAegisRequest(
  service: string,
  request: any,
  maxCredits?: number,
) {
  const callId = randomUUID();
  const started = Date.now();
  callFeed.unshift({
    id: callId,
    service,
    status: "pending",
    started_at: started,
  });
  if (callFeed.length > 50) callFeed.length = 50;

  await checkAndSweepFunds().catch(() => {});
  const headers: Record<string, string> = {
    ...(await signAegisRequestHeaders()),
    "Content-Type": "application/json",
  };
  if (maxCredits) headers["x-max-credits"] = String(maxCredits);

  const response = await fetch(AEGIS_EXECUTE_ENDPOINT, {
    method: "POST",
    headers,
    body: JSON.stringify({ service, request }),
  });
  if (response.status === 402) throw new Error("CREDITS_DEPLETED");
  if (!response.ok) {
    const errorText = await response.text();
    console.error(`🚨 Router Error [${response.status}]:`, errorText);
    throw new Error(`Router returned ${response.status}: ${errorText}`);
  }

  const data: any = await response.json();
  const idx = callFeed.findIndex((c) => c.id === callId);
  if (idx !== -1)
    callFeed[idx] = {
      ...callFeed[idx],
      status: "ok",
      duration_ms: Date.now() - started,
      credits_charged: data?.aegis_billing?.credits_charged,
    };
  return data;
}

async function executeAegisStream(
  service: string,
  request: any,
  res: express.Response,
) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const headers: Record<string, string> = {
    ...(await signAegisRequestHeaders()),
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  };

  try {
    const response = await fetch(`${AEGIS_ROUTER_BASE}/v1/stream`, {
      method: "POST",
      headers,
      body: JSON.stringify({ service, request }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      res.write(
        `data: ${JSON.stringify({ type: "error", error: { message: errorText } })}\n\n`,
      );
      res.end();
      return;
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error("Response body is null");

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  } catch (err: any) {
    console.error("Stream pipe failed:", err.message);
    res.write(
      `data: ${JSON.stringify({ type: "error", error: { message: err.message } })}\n\n`,
    );
  } finally {
    res.end();
  }
}

// --- MCP (SSE) SERVER: "Aegis Hub" ---

type McpToolDescriptor = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
};

const sseSessions = new Map<string, SSEServerTransport>();
let mcpServerInstance: Server;

function extractToolResult(serviceId: string, data: unknown): string {
  if (typeof data === "string") return data;
  if (data == null) return "";
  if (serviceId === "aegis-parse") {
    const parsed = data as any;
    const inner = parsed.data ?? {};
    const markdown = inner.content ?? parsed.markdown ?? parsed.content;
    if (markdown)
      return inner.title ? `# ${inner.title}\n\n${markdown}` : markdown;
  }
  if (serviceId === "aegis-search") {
    const parsed = data as any;
    const lines: string[] = [];
    if (parsed.answer) lines.push(`ANSWER: ${parsed.answer}`);
    if (parsed.results?.length) {
      lines.push("RESULTS:");
      for (const [i, r] of parsed.results.entries()) {
        lines.push(
          `${i + 1}. ${r.title ?? "(untitled)"} — ${r.url ?? ""}\n   ${r.snippet ?? ""}`,
        );
      }
    }
    if (lines.length > 0) return lines.join("\n");
  }
  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}

function buildToolsFromServicesCatalog(): McpToolDescriptor[] {
  const services = loadServices();
  const tools: McpToolDescriptor[] = [];
  const IGNORED_SERVICES = ["aegis-claude", "aegis-openai", "aegis-perplexity"];

  for (const [id, meta] of Object.entries(services) as [string, any][]) {
    if (!SERVICE_ID_RE.test(id)) continue;
    if (IGNORED_SERVICES.includes(id)) continue;

    let inputSchema: Record<string, unknown> = { type: "object" };
    if (meta?.expected_schema) {
      try {
        const parsed =
          typeof meta.expected_schema === "string"
            ? JSON.parse(meta.expected_schema)
            : meta.expected_schema;
        if (parsed && typeof parsed === "object") {
          inputSchema = { type: "object", ...parsed };
          if (!("type" in parsed)) inputSchema.type = "object";
        }
      } catch {
        /* fallback */
      }
    }

    tools.push({
      name: id,
      description:
        typeof meta?.description === "string"
          ? meta.description
          : "Aegis Hub tool.",
      inputSchema,
    });
  }
  return tools;
}

function createSessionMcpServer() {
  const server = new Server(
    { name: "Aegis Hub", version: "1.0.0" },
    { capabilities: { tools: { listChanged: true } } },
  );
  mcpServerInstance = server;

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: "aegis_composio",
          description:
            "Primary gateway for 200+ 3rd-party apps including GitHub, Slack, Salesforce, Jira, Asana, HubSpot, Shopify, etc. Use this by default whenever the user asks to fetch or modify data in an external service, even if they don't explicitly ask for it. Workflow: use 'login' to authorize, 'explore' to discover available tools for an app, and 'execute' to run a specific tool.",
          inputSchema: {
            type: "object",
            properties: {
              action: {
                type: "string",
                enum: ["login", "explore", "execute"],
                description: "The operation to perform.",
              },
              app: {
                type: "string",
                description: "The app name (e.g., 'github').",
              },
              tool_name: {
                type: "string",
                description:
                  "The specific Composio tool slug (Required for 'execute').",
              },
              tool_params: {
                type: "object",
                description:
                  "Parameters for the tool (Required for 'execute').",
              },
            },
            required: ["action", "app"],
          },
        },
        {
          name: "aegis_hub",
          description: "Executes native Aegis microservices.",
          inputSchema: {
            type: "object",
            properties: {
              service: {
                type: "string",
                description:
                  "The Aegis service ID (e.g., 'aegis-search', 'aegis-parse').",
              },
              params: {
                type: "object",
                description: "Parameters for the service.",
              },
            },
            required: ["service", "params"],
          },
        },
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params as any;
    const AEGIS_USER_ID = process.env.AEGIS_USER_ID || "default";

    try {
      // --- 1. COMPOSIO META-TOOL ---
      if (name === "aegis_composio") {
        const { action, app, tool_name, tool_params } = (args ?? {}) as any;

        if (action === "login") {
          const request: any = await composio.toolkits.authorize(
            AEGIS_USER_ID,
            app,
          );
          return {
            content: [
              {
                type: "text",
                text: `Please login here: ${request.redirectUrl}`,
              },
            ],
          };
        }

        if (action === "explore") {
          console.error(`🔍 Exploring tools for app: ${app}`);
          const rawTools = await (composio.tools as any).getRawComposioTools({
            toolkits: [app],
          });

          // Return a lightweight summary to the LLM to save context
          const toolSummary = rawTools.map((t: any) => ({
            name: t.name || t.slug,
            description: t.description,
            schema: t.parameters || t.schema || t.expected_schema,
          }));

          return {
            content: [
              { type: "text", text: JSON.stringify(toolSummary, null, 2) },
            ],
          };
        }

        if (action === "execute") {
          if (!tool_name)
            throw new Error("tool_name is required for execute action.");
          const result = await executeComposioActionDirect(
            AEGIS_USER_ID,
            tool_name,
            tool_params ?? {},
          );
          const text =
            typeof result === "string"
              ? result
              : JSON.stringify(result, null, 2);
          return { content: [{ type: "text", text }] };
        }
      }

      // --- 2. AEGIS NATIVE META-TOOL ---
      if (name === "aegis_hub") {
        const { service, params } = (args ?? {}) as any;

        const catalog = loadServices();
        if (!catalog[service]) {
          return {
            content: [
              { type: "text", text: `Unknown Aegis service: ${service}` },
            ],
            isError: true,
          };
        }

        const raw = await executeAegisRequest(service, params ?? {});
        const payload = (raw as any)?.data ?? raw;
        const text = extractToolResult(service, payload);
        return { content: [{ type: "text", text }] };
      }

      return {
        content: [{ type: "text", text: `Unknown meta-tool: ${name}` }],
        isError: true,
      };
    } catch (err: any) {
      return {
        content: [{ type: "text", text: `Error: ${err?.message}` }],
        isError: true,
      };
    }
  });

  return server;
}

// --- EXPRESS SERVER ---
async function startDaemonServer(port: number) {
  ensureBuiltinServices();
  const app = express();
  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json());

  app.get("/", (_req, res) => res.send(DASHBOARD_HTML));
  app.get("/api/status", async (_req, res) => {
    try {
      const r = await fetch(AEGIS_BALANCE_ENDPOINT(userAccount.address));
      const b = await r.json();
      res.json({
        wallet: userAccount.address,
        credits: b.credits,
        usd_value: b.usd_value,
        router_online: true,
        calls: callFeed,
      });
    } catch {
      res.json({
        wallet: userAccount.address,
        credits: 0,
        router_online: false,
        calls: callFeed,
      });
    }
  });

  app.get("/api/catalog", (_req, res) => {
    const services = loadServices();
    res.json({
      services: Object.entries(services).map(([id, meta]: [string, any]) => ({
        id,
        ...meta,
      })),
    });
  });

  app.post("/api/provider/register", async (req, res) => {
    const { id, endpoint_url, secret, sample_request } = req.body;
    if (!SERVICE_ID_RE.test(id))
      return res.status(400).json({ error: "INVALID_ID" });

    let method: "POST" | "PUT" = "POST";
    try {
      const probe = await fetch(AEGIS_REGISTRY_STATS_ENDPOINT(id));
      if (probe.ok) {
        const stats: any = await probe.json();
        if (
          stats?.service?.provider_wallet.toLowerCase() !==
          userAccount.address.toLowerCase()
        ) {
          return res.status(403).json({
            error: "NOT_OWNER",
            message: "This ID belongs to another wallet.",
          });
        }
        method = "PUT";
      }
    } catch (e) {}

    if (method === "POST") {
      try {
        const test = await fetch(endpoint_url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${secret}`,
          },
          body: JSON.stringify(sample_request),
        });
        if (!test.ok)
          return res.status(400).json({
            error: "LOCAL_TEST_FAILED",
            message: `Endpoint returned ${test.status}`,
          });
      } catch (e: any) {
        return res
          .status(400)
          .json({ error: "LOCAL_UNREACHABLE", message: e.message });
      }
    }

    try {
      const payload =
        method === "POST"
          ? { ...req.body, provider_wallet: userAccount.address }
          : { ...req.body, new_secret: secret };
      const sync = await fetch(AEGIS_REGISTER_ENDPOINT, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(await signAegisRequestHeaders()),
        },
        body: JSON.stringify(payload),
      });
      const syncBodyText = await sync.text();
      let data: any;
      try {
        data = syncBodyText ? JSON.parse(syncBodyText) : {};
      } catch {
        data = { error: "INVALID_ROUTER_JSON", raw: syncBodyText };
      }
      if (sync.ok) {
        const services = loadServices();
        services[id] = { ...req.body, registered_at: new Date().toISOString() };
        saveServices(services);
      }
      res.status(sync.status).json(data);
    } catch (err: any) {
      res.status(502).json({ error: "ROUTER_ERROR", message: err.message });
    }
  });

  app.post("/v1/chat/completions", async (req, res) => {
    try {
      const requestedModel = req.body.model || "error_model_must_be_specified";
      let serviceId = "aegis-claude";
      const m = String(requestedModel).toLowerCase();
      if (m.includes("gpt")) serviceId = "aegis-openai";
      else if (m.includes("claude")) serviceId = "aegis-claude";

      const rawResponse = await executeAegisRequest(serviceId, req.body);
      const llmPayload = rawResponse?.data ?? rawResponse;
      res.json(llmPayload);
    } catch (err: any) {
      res
        .status(err.message === "CREDITS_DEPLETED" ? 402 : 500)
        .json({ error: err.message });
    }
  });

  app.get("/mcp/sse", async (_req, res) => {
    let transport: SSEServerTransport | undefined;
    let sessionServer: Server | undefined;
    try {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");

      sessionServer = createSessionMcpServer();
      transport = new SSEServerTransport("/mcp/messages", res);
      sseSessions.set(transport.sessionId, transport);

      res.on("close", () => {
        sseSessions.delete(transport!.sessionId);
        void sessionServer!.close().catch(() => {});
        console.error(`🔌 MCP Session ${transport!.sessionId} closed cleanly`);
      });

      await sessionServer.connect(transport);
      res.flushHeaders?.();
      console.error(`🔌 Aegis MCP Handshake: Session ${transport.sessionId}`);
    } catch (err: any) {
      if (transport) sseSessions.delete(transport.sessionId);
      void sessionServer?.close().catch(() => {});
      console.error("MCP SSE connect failed:", err);
      if (!res.headersSent) res.status(500).end();
    }
  });

  app.post("/v1/messages", async (req, res) => {
    const serviceId = "aegis-claude";
    try {
      const legacyModel = "claude-3-5-sonnet-20241022";
      let systemPrompt = req.body.system;
      if (Array.isArray(systemPrompt)) {
        systemPrompt = systemPrompt.map((b: any) => b.text || "").join("\n");
      }

      const cleanPayload: any = {
        messages: req.body.messages,
        system: systemPrompt,
        model: req.body.model,
        max_tokens: req.body.max_tokens
          ? Math.min(req.body.max_tokens, 8192)
          : 8192,
        temperature: req.body.temperature ?? 0.7,
        tools: req.body.tools,
        tool_choice: req.body.tool_choice,
        stream: req.body.stream ?? false,
      };

      res.setHeader("anthropic-version", "2023-06-01");
      if (cleanPayload.stream) {
        await executeAegisStream(serviceId, cleanPayload, res);
      } else {
        const rawResponse = await executeAegisRequest(serviceId, cleanPayload);
        const data = rawResponse?.data ?? rawResponse;
        const anthropicFinal = {
          id: data.id || `msg_${randomUUID()}`,
          type: "message",
          role: "assistant",
          model: legacyModel,
          content: data.content || [],
          stop_reason: data.stop_reason || "end_turn",
          usage: {
            input_tokens: data.usage?.input_tokens || 0,
            output_tokens: data.usage?.output_tokens || 0,
          },
        };
        res.json(anthropicFinal);
      }
    } catch (err: any) {
      if (!res.headersSent)
        res.status(500).json({ error: { message: err.message } });
    }
  });

  app.post("/mcp/messages", async (req, res) => {
    const sessionId =
      typeof req.query.sessionId === "string" ? req.query.sessionId : "";
    const transport = sseSessions.get(sessionId);
    if (!transport) {
      res.status(400).json({ error: "INVALID_SESSION" });
      return;
    }
    try {
      await transport.handlePostMessage(req, res, req.body);
    } catch (err: any) {
      if (!res.headersSent) res.status(500).end();
    }
  });

  app.listen(port, () =>
    console.error(
      `🚀 Aegis Hub Engine Live on port ${port} (MCP SSE at /mcp/sse)`,
    ),
  );
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--stdio")) {
    const server = createSessionMcpServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    return;
  }
  const portIndex = args.indexOf("--port");
  const port = portIndex > -1 ? parseInt(args[portIndex + 1]) : 23447;
  await startDaemonServer(port);
}

main().catch(console.error);
