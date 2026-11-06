/**
 * MyKiraNiaga — on-demand dropshipping search engine
 * ---------------------------------------------------
 * Stack : Hono + Cloudflare Workers (TypeScript)
 * Brain : Gemini Flash-Lite (latest) — extracts { keyword, max_price_myr } from ?q=
 * Sources: CJ Dropshipping + AliExpress (parallel, placeholder-safe)
 *
 * Routes
 *   GET /                    landing page (HTML)  | info JSON with ?format=json
 *   GET /search?q=...        results (HTML or JSON by ?format= / Accept header)
 *   GET /api/search?q=...    always JSON (bots)
 *   GET /api                 endpoint index (JSON)
 *   GET /health              health probe
 *   GET /robots.txt
 *
 * Design notes
 *   - HTML is the default for browsers; JSON is returned when ?format=json is
 *     present or the Accept header prefers application/json / a bot UA calls it.
 *   - Source adapters never throw: each returns { report, items } so one failing
 *     upstream cannot blank the page. Missing credentials => deterministic demo
 *     catalogue tagged status "placeholder" (UI keeps working, data is labelled).
 *   - Budget filter runs on unit price by default; ?strict=1 filters on landed
 *     total (price + default shipping).
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Context } from "hono";

/* ------------------------------------------------------------------ */
/* Environment                                                         */
/* ------------------------------------------------------------------ */

export interface Env {
  /** Google AI Studio key — required for Gemini intent extraction. */
  GEMINI_API_KEY?: string;
  /** Override the default model alias. */
  GEMINI_MODEL?: string;
  /** CJ Dropshipping MCP credentials — stateless token URL (preferred, live). */
  CJ_MCP_USER?: string;
  CJ_MCP_ACCESS_TOKEN?: string;
  /** Legacy CJ Open API token (unused by the MCP path, kept for compatibility). */
  CJ_ACCESS_TOKEN?: string;
  /** AliExpress Open Platform (affiliate) credentials. Optional. */
  ALIEXPRESS_APP_KEY?: string;
  ALIEXPRESS_APP_SECRET?: string;
  ALIEXPRESS_TRACKING_ID?: string;
  ALIEXPRESS_BASE_URL?: string;
  /** CJ MCP token alias — accepted when CJ_MCP_ACCESS_TOKEN is absent. */
  CJ_API_KEY?: string;
  /** USD -> MYR rate used to normalise USD-priced sources. */
  DEFAULT_USD_MYR?: string;
  /** Profit markup percentage applied to supplier price + shipping (default 20). */
  PRICE_MARKUP_PCT?: string;
  /** Flat profit margin in MYR added after the percentage (default 0). */
  PRICE_MARKUP_FLAT_MYR?: string;
  /** WhatsApp order number, digits only (default 60173735431). */
  WHATSAPP_ORDER_NUMBER?: string;
  ENVIRONMENT?: string;
}

const SERVICE = "mykiraniaga";
const VERSION = "1.0.0";
const DEFAULT_GEMINI_MODEL = "gemini-flash-lite-latest";
// Note: gemini-2.5-flash-lite / gemini-2.0-flash-lite now return 404 for new
// keys (verified Nov 2026), so there is no version fallback — only a retry.
const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_FX = 4.72;
const MAX_RESULTS = 40;

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

type SourceId = "cj" | "aliexpress";

type SourceStatus =
  | "ok"
  | "empty"
  | "placeholder"
  | "missing_credentials"
  | "error";

interface Shipping {
  method: string;
  cost_myr: number;
  days_min: number;
  days_max: number;
}

interface Product {
  id: string;
  source: SourceId;
  source_label: string;
  title: string;
  price_myr: number;
  total_myr: number;
  shipping: Shipping;
  image: string | null;
  url: string;
  moq: number;
  rating: number | null;
  orders: number | null;
  demo: boolean;
}

/**
 * Product after margin + checkout decoration. `price_myr` / `total_myr` are the
 * customer-facing (marked-up) numbers; supplier_* keep the raw cost.
 */
interface PricedProduct extends Product {
  supplier_price_myr: number;
  supplier_total_myr: number;
  margin_myr: number;
  checkout_url: string;
  whatsapp_url: string;
}

interface Pricing {
  markup_pct: number;
  flat_myr: number;
}

interface KeyStatus {
  key: string;
  configured: boolean;
  detail: string;
}

interface ConfigStatus {
  gemini: KeyStatus;
  cj: KeyStatus;
  aliexpress: KeyStatus;
  whatsapp: KeyStatus;
  pricing: Pricing;
}

interface Intent {
  keyword: string;
  max_price_myr: number | null;
  engine: "gemini" | "heuristic";
  model?: string;
  note?: string;
}

interface SourceReport {
  source: SourceId;
  label: string;
  status: SourceStatus;
  latency_ms: number;
  count: number;
  note?: string;
}

interface SourceOutcome {
  report: SourceReport;
  items: Product[];
}

interface SearchPayload {
  ok: true;
  query: string;
  intent: Intent;
  budget: {
    max_price_myr: number | null;
    applied: boolean;
    basis: "price" | "total";
    removed: number;
  };
  results: PricedProduct[];
  pricing: Pricing;
  config: ConfigStatus;
  meta: {
    service: string;
    version: string;
    generated_at: string;
    timing_ms: number;
    count: number;
    partial: boolean;
    sources: SourceReport[];
  };
}

const SOURCE_META: Record<SourceId, { label: string; short: string }> = {
  cj: { label: "CJ Dropshipping", short: "CJ" },
  aliexpress: { label: "AliExpress", short: "AE" },
};

const DEFAULT_SHIPPING: Record<SourceId, Shipping> = {
  cj: { method: "CJPacket Ordinary", cost_myr: 6.5, days_min: 7, days_max: 12 },
  aliexpress: {
    method: "AliExpress Standard Shipping",
    cost_myr: 4.9,
    days_min: 10,
    days_max: 18,
  },
};

/* ------------------------------------------------------------------ */
/* Small utilities                                                     */
/* ------------------------------------------------------------------ */

const round2 = (n: number): number => Math.round(n * 100) / 100;

const clamp = (n: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, n));

function str(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const cleaned = value.replace(/[^0-9.\-]/g, "");
    if (!cleaned) return null;
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function pick(obj: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null && obj[key] !== "") {
      return obj[key];
    }
  }
  return undefined;
}

function timeoutSignal(ms: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function money(n: number): string {
  return "RM " + n.toFixed(2);
}

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fxRate(env: Env): number {
  const parsed = Number(env.DEFAULT_USD_MYR);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 20) return DEFAULT_FX;
  return parsed;
}

/* ------------------------------------------------------------------ */
/* Pricing, checkout links and runtime key status                      */
/* ------------------------------------------------------------------ */

const DEFAULT_WHATSAPP = "60173735431";

function pricingFromEnv(env: Env): Pricing {
  const pct = num(env.PRICE_MARKUP_PCT);
  const flat = num(env.PRICE_MARKUP_FLAT_MYR);
  return {
    markup_pct: pct === null ? 20 : clamp(round2(pct), 0, 300),
    flat_myr: flat === null ? 0 : clamp(round2(flat), 0, 1000),
  };
}

function whatsappNumber(env: Env): string {
  const digits = (env.WHATSAPP_ORDER_NUMBER ?? DEFAULT_WHATSAPP).replace(/[^0-9]/g, "");
  return digits.length >= 8 ? digits : DEFAULT_WHATSAPP;
}

function configStatus(env: Env): ConfigStatus {
  const cjUser = (env.CJ_MCP_USER ?? "").trim();
  const cjToken = (env.CJ_MCP_ACCESS_TOKEN ?? env.CJ_API_KEY ?? "").trim();
  const aeKey = (env.ALIEXPRESS_APP_KEY ?? "").trim();
  const aeSecret = (env.ALIEXPRESS_APP_SECRET ?? "").trim();
  const model = env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;

  return {
    gemini: {
      key: "GEMINI_API_KEY",
      configured: Boolean(env.GEMINI_API_KEY),
      detail: env.GEMINI_API_KEY ? `model ${model}` : "tiada — intent guna heuristik",
    },
    cj: {
      key: "CJ_API_KEY",
      configured: Boolean(cjUser && cjToken),
      detail:
        cjUser && cjToken
          ? `akaun ${cjUser}`
          : "tiada — CJ guna katalog demo",
    },
    aliexpress: {
      key: "ALIEXPRESS_APP_KEY",
      configured: Boolean(aeKey && aeSecret),
      detail:
        aeKey && aeSecret
          ? "kredensial ada · perlu kebenaran Affiliate API"
          : "tiada — AE guna katalog demo",
    },
    whatsapp: {
      key: "WHATSAPP_ORDER_NUMBER",
      configured: true,
      detail: `+${whatsappNumber(env)}`,
    },
    pricing: pricingFromEnv(env),
  };
}

/**
 * Margin = (supplier price + supplier shipping) * pct + flat.
 * Shipping is passed through at cost; the unit price carries the margin so the
 * landed total always equals supplier total + margin.
 */
function applyMargin(
  supplierPrice: number,
  supplierShipping: number,
  pricing: Pricing,
): { supplier_price: number; supplier_total: number; price: number; total: number; margin: number } {
  const supplierTotal = round2(supplierPrice + supplierShipping);
  const margin = round2(supplierTotal * (pricing.markup_pct / 100) + pricing.flat_myr);
  const price = round2(supplierPrice + margin);
  return {
    supplier_price: round2(supplierPrice),
    supplier_total: supplierTotal,
    price,
    total: round2(price + supplierShipping),
    margin: round2(price - supplierPrice),
  };
}

function whatsappOrderUrl(env: Env, product: Product, total: number): string {
  const text = [
    "Saya nak order:",
    `1) ${product.title}`,
    `ID: ${product.id}`,
    `Sumber: ${product.source_label}`,
    `Harga: ${money(total)} (termasuk pos)`,
  ].join("\n");
  return `https://wa.me/${whatsappNumber(env)}?text=${encodeURIComponent(text)}`;
}

function priceProduct(
  product: Product,
  env: Env,
  pricing: Pricing,
  query: string,
): PricedProduct {
  const margin = applyMargin(
    product.price_myr,
    product.shipping.cost_myr,
    pricing,
  );
  const params = new URLSearchParams({
    source: product.source,
    id: product.id,
    title: product.title.slice(0, 120),
    base: margin.supplier_total.toFixed(2),
    q: query,
  });

  return {
    ...product,
    price_myr: margin.price,
    total_myr: margin.total,
    supplier_price_myr: margin.supplier_price,
    supplier_total_myr: margin.supplier_total,
    margin_myr: margin.margin,
    checkout_url: `/checkout?${params.toString()}`,
    whatsapp_url: whatsappOrderUrl(env, product, margin.total),
  };
}

/* ------------------------------------------------------------------ */
/* Content negotiation                                                 */
/* ------------------------------------------------------------------ */

function wantsJson(c: Context): boolean {
  const format = (c.req.query("format") ?? "").toLowerCase();
  if (format === "json") return true;
  if (format === "html") return false;

  const accept = (c.req.header("accept") ?? "").toLowerCase();
  if (accept.includes("application/json") && !accept.includes("text/html")) {
    return true;
  }
  if (accept.includes("text/html") || accept.includes("application/xhtml")) {
    return false;
  }

  // No useful Accept header (curl, fetch, bots) -> JSON.
  const ua = (c.req.header("user-agent") ?? "").toLowerCase();
  if (ua === "") return true;
  return /curl|wget|python|httpx|axios|node-fetch|okhttp|go-http-client|java|bot|spider|crawler|postman/.test(
    ua,
  );
}

/* ------------------------------------------------------------------ */
/* Intent extraction                                                   */
/* ------------------------------------------------------------------ */

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  error?: { message?: string };
}

const INTENT_SCHEMA = {
  type: "OBJECT",
  properties: {
    keyword: {
      type: "STRING",
      description:
        "Product search keyword in English, 1-6 words. Keep brand/model names. Drop filler words.",
    },
    max_price_myr: {
      type: "NUMBER",
      nullable: true,
      description:
        "Maximum budget in Malaysian Ringgit (MYR). Convert USD values (x4.72). Null when no budget is stated.",
    },
  },
  required: ["keyword", "max_price_myr"],
  propertyOrdering: ["keyword", "max_price_myr"],
};

function intentPrompt(query: string): string {
  return [
    "You are the query parser for MyKiraNiaga, a Malaysian dropshipping search engine.",
    "Extract the shopping intent from the user's raw search query.",
    "",
    "Rules:",
    "- keyword: short product keyword in English (2-6 words). Translate Malay/Chinese product words to English.",
    "- max_price_myr: numeric budget ceiling in MYR. If the user writes USD or $, multiply by 4.72.",
    "- Accept Malay money phrases: bawah RM50, bajet 30, maksimum 80, kurang dari 100.",
    "- If no budget is mentioned, max_price_myr must be null. Never invent a budget.",
    "- Remove filler: cari, tolong, saya nak, for, under, below, murah.",
    "",
    'Examples:',
    '- "cari mini projector bawah RM80" -> {"keyword":"mini projector","max_price_myr":80}',
    '- "wireless earbuds under $20" -> {"keyword":"wireless earbuds","max_price_myr":94.4}',
    '- "beg kanvas" -> {"keyword":"canvas bag","max_price_myr":null}',
    "",
    "Reply with JSON only. Query:",
    JSON.stringify(query),
  ].join("\n");
}

function parseIntentJson(text: string): {
  keyword: string;
  max_price_myr: number | null;
} | null {
  if (!text) return null;
  const cleaned = text
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;

  const row = parsed as Record<string, unknown>;
  const keyword = str(row.keyword).replace(/\s+/g, " ").slice(0, 120);
  if (!keyword) return null;

  const rawPrice = num(row.max_price_myr);
  const maxPrice =
    rawPrice !== null && rawPrice > 0 && rawPrice < 1_000_000
      ? round2(rawPrice)
      : null;

  return { keyword, max_price_myr: maxPrice };
}

function heuristicIntent(query: string): Intent {
  const q = query.trim();
  let maxPrice: number | null = null;

  const patterns: Array<{ re: RegExp; currency: "MYR" | "USD" }> = [
    { re: /(?:rm|myr)\s*([0-9]+(?:[.,][0-9]{1,2})?)/i, currency: "MYR" },
    { re: /(?:usd|us\$)\s*([0-9]+(?:[.,][0-9]{1,2})?)/i, currency: "USD" },
    { re: /\$\s*([0-9]+(?:[.,][0-9]{1,2})?)/i, currency: "USD" },
    {
      re: /(?:under|below|bawah|bajet|budget|max|maks|maksimum|kurang\s+dari|<\s*)\s*([0-9]+(?:[.,][0-9]{1,2})?)/i,
      currency: "MYR",
    },
  ];

  for (const { re, currency } of patterns) {
    const match = q.match(re);
    if (!match || !match[1]) continue;
    const value = Number(match[1].replace(",", "."));
    if (!Number.isFinite(value) || value <= 0) continue;
    maxPrice = round2(currency === "USD" ? value * DEFAULT_FX : value);
    break;
  }

  const keyword = q
    .replace(/(?:rm|myr|usd|us\$|\$)\s*[0-9]+(?:[.,][0-9]{1,2})?/gi, " ")
    .replace(
      /\b(?:under|below|bawah|bajet|budget|max|maks|maksimum|kurang\s+dari)\b/gi,
      " ",
    )
    .replace(
      /\b(?:cari|search|find|tolong|please|saya|nak|want|dropship|untuk|for|murah|cheap)\b/gi,
      " ",
    )
    .replace(/\s+/g, " ")
    .replace(/^[\s,.;:\-–—]+|[\s,.;:\-–—]+$/g, "")
    .trim();

  return {
    keyword: (keyword || q).slice(0, 120),
    max_price_myr: maxPrice,
    engine: "heuristic",
  };
}

async function extractIntent(env: Env, query: string): Promise<Intent> {
  const fallback = heuristicIntent(query);
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) {
    return {
      ...fallback,
      note: "GEMINI_API_KEY not configured — heuristic parser used",
    };
  }

  const model = env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
  const errors: string[] = [];

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await fetch(
        `${GEMINI_ENDPOINT}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: intentPrompt(query) }] }],
            generationConfig: {
              temperature: 0,
              maxOutputTokens: 200,
              responseMimeType: "application/json",
              responseSchema: INTENT_SCHEMA,
            },
          }),
          signal: timeoutSignal(7000),
        },
      );

      if (!res.ok) {
        let detail = "";
        try {
          const err = (await res.json()) as {
            error?: { status?: string; message?: string };
          };
          detail = err.error?.status || err.error?.message?.slice(0, 90) || "";
        } catch {
          detail = "";
        }
        errors.push(
          `${model}: HTTP ${res.status}${detail ? ` ${detail}` : ""}`.slice(0, 120),
        );
        // 400 also proves transient here: the identical body succeeds on retry.
        const retryable =
          res.status === 400 || res.status === 429 || res.status >= 500;
        if (retryable && attempt < 3) {
          await sleep(350 * attempt);
          continue;
        }
        break;
      }

      const data = (await res.json()) as GeminiResponse;
      const text = (data.candidates?.[0]?.content?.parts ?? [])
        .map((part) => part.text ?? "")
        .join("")
        .trim();

      const parsed = parseIntentJson(text);
      if (parsed) {
        return { ...parsed, engine: "gemini", model };
      }
      errors.push(`${model}: unparseable response`);
      break;
    } catch (error) {
      errors.push(
        `${model}: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (attempt < 3) {
        await sleep(400);
        continue;
      }
      break;
    }
  }

  return {
    ...fallback,
    note:
      errors.join(" | ").slice(0, 180) || "Gemini unavailable — heuristic parser used",
  };
}

/* ------------------------------------------------------------------ */
/* Source adapters                                                     */
/* ------------------------------------------------------------------ */

function emptyReport(
  source: SourceId,
  status: SourceStatus,
  latency: number,
  note?: string,
): SourceReport {
  return {
    source,
    label: SOURCE_META[source].label,
    status,
    latency_ms: latency,
    count: 0,
    ...(note ? { note } : {}),
  };
}

/** Deterministic hash so demo rows stay stable between requests. */
function hash(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

function titleCase(value: string): string {
  return value
    .split(" ")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Placeholder catalogue: no network, deterministic, clearly marked demo:true.
 * Used whenever a source has no credentials so the product page still renders.
 */
function demoProducts(source: SourceId, keyword: string, fx: number): Product[] {
  const baseKeyword = keyword || "product";
  const suffixes =
    source === "cj"
      ? ["Portable Mini", "Pro Set", "Rechargeable", "Compact Edition"]
      : ["Premium", "2-in-1 Combo", "Travel Size", "Value Bundle"];

  const seed = hash(`${source}:${baseKeyword.toLowerCase()}`);
  const shipping = DEFAULT_SHIPPING[source];
  const searchUrl =
    source === "cj"
      ? `https://www.cjdropshipping.com/search.html?productNameEn=${encodeURIComponent(baseKeyword)}`
      : `https://www.aliexpress.com/wholesale?SearchText=${encodeURIComponent(baseKeyword)}`;

  return suffixes.map((suffix, index) => {
    const priceUsd = 3.8 + ((seed >> (index * 3)) % 26) + index * 2.15;
    const price = round2(priceUsd * fx);
    return {
      id: `${source}-demo-${hash(`${source}${baseKeyword}${index}`) % 1000000}`,
      source,
      source_label: SOURCE_META[source].label,
      title: `${titleCase(baseKeyword)} ${suffix}`,
      price_myr: price,
      total_myr: round2(price + shipping.cost_myr),
      shipping,
      image: null,
      url: searchUrl,
      moq: 1,
      rating: round2(4.3 + ((seed >> index) % 60) / 100),
      orders: 40 + ((seed >> (index + 2)) % 900),
      demo: true,
    };
  });
}

/** CJ prices arrive as "28.62" or a range "7.35 -- 16.40" (USD). Take the low end. */
function parseCjPrice(raw: string): number | null {
  const match = raw.match(/([0-9]+(?:\.[0-9]+)?)/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function cjImage(raw: string): string | null {
  if (!raw) return null;
  if (raw.startsWith("//")) return `https:${raw}`;
  if (raw.startsWith("http")) return raw;
  return null;
}

/**
 * CJ ships an MCP server (cj-dropshipping-mcp 1.1.0). The legacy API-key URL is
 * retired; the supported stateless form is /mcp/API@<userId>@CJ:<accessToken>.
 * No session header is issued, so each tools/call is a single POST.
 */
function cjMcpEndpoint(env: Env): string | null {
  const user = (env.CJ_MCP_USER ?? "").trim();
  const token = (env.CJ_MCP_ACCESS_TOKEN ?? env.CJ_API_KEY ?? "").trim();
  if (!user || !token) return null;
  return `https://developers.cjdropshipping.com/mcp/API@${user}@CJ:${token}`;
}

async function searchCj(env: Env, keyword: string, fx: number): Promise<SourceOutcome> {
  const started = Date.now();
  const endpoint = cjMcpEndpoint(env);

  if (!endpoint) {
    const items = demoProducts("cj", keyword, fx);
    return {
      report: {
        ...emptyReport(
          "cj",
          "placeholder",
          Date.now() - started,
          "CJ_MCP_USER / CJ_MCP_ACCESS_TOKEN not set — demo catalogue",
        ),
        count: items.length,
      },
      items,
    };
  }

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2024-11-05",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "search_products",
          arguments: { keyword },
        },
      }),
      signal: timeoutSignal(12000),
    });

    if (!res.ok) {
      return {
        report: emptyReport(
          "cj",
          "error",
          Date.now() - started,
          `CJ MCP HTTP ${res.status}`,
        ),
        items: [],
      };
    }

    const data = (await res.json()) as {
      result?: { content?: Array<{ text?: string }>; isError?: boolean };
      error?: { message?: string };
    };

    if (data.error) {
      return {
        report: emptyReport(
          "cj",
          "error",
          Date.now() - started,
          `CJ MCP: ${data.error.message ?? "rpc error"}`.slice(0, 160),
        ),
        items: [],
      };
    }

    // Tool output is prose + JSON ("📋 Found N products total. {...}").
    const text = (data.result?.content ?? [])
      .map((part) => part.text ?? "")
      .join("\n");
    const start = text.indexOf("{");
    if (start === -1) {
      return {
        report: emptyReport(
          "cj",
          "error",
          Date.now() - started,
          `CJ MCP: ${(text || "empty tool output").slice(0, 140)}`,
        ),
        items: [],
      };
    }

    const payload = JSON.parse(text.slice(start)) as Record<string, unknown>;
    const content = Array.isArray(payload.content)
      ? (payload.content as Array<Record<string, unknown>>)
      : [];
    const first = content[0] ?? {};
    const rows = Array.isArray(first.productList)
      ? (first.productList as Array<Record<string, unknown>>)
      : [];

    const items: Product[] = [];
    for (const row of rows) {
      const title = str(pick(row, ["nameEn", "productNameEn", "name"]));
      const id = str(pick(row, ["id", "pid"]));
      const priceUsd = parseCjPrice(str(pick(row, ["sellPrice", "nowPrice"])));
      if (!title || priceUsd === null) continue;

      const shipping = DEFAULT_SHIPPING.cj;
      const price = round2(priceUsd * fx);
      const moq = num(pick(row, ["directMinOrderNum", "moq"]));

      items.push({
        id: id || `cj-${hash(title)}`,
        source: "cj",
        source_label: SOURCE_META.cj.label,
        title,
        price_myr: price,
        total_myr: round2(price + shipping.cost_myr),
        shipping,
        image: cjImage(str(pick(row, ["bigImage", "productImage", "image"]))),
        url: id
          ? `https://www.cjdropshipping.com/product/-p-${id}.html`
          : `https://www.cjdropshipping.com/search.html?productNameEn=${encodeURIComponent(keyword)}`,
        moq: moq && moq > 0 ? moq : 1,
        rating: null,
        orders: null,
        demo: false,
      });
    }

    return {
      report: {
        ...emptyReport("cj", items.length ? "ok" : "empty", Date.now() - started),
        count: items.length,
      },
      items,
    };
  } catch (error) {
    return {
      report: emptyReport(
        "cj",
        "error",
        Date.now() - started,
        (error instanceof Error ? error.message : "CJ fetch failed").slice(0, 160),
      ),
      items: [],
    };
  }
}

/** AliExpress Open Platform signature: HMAC-SHA256 over sorted key+value, UPPERCASE hex. */
async function aliexpressSign(
  params: Record<string, string>,
  secret: string,
): Promise<string> {
  const base = Object.keys(params)
    .sort()
    .map((key) => `${key}${params[key]}`)
    .join("");

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(base));
  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

/** AliExpress expects GMT+8 timestamps: yyyy-MM-dd HH:mm:ss */
function aliexpressTimestamp(): string {
  const shifted = new Date(Date.now() + 8 * 60 * 60 * 1000);
  return shifted.toISOString().replace("T", " ").slice(0, 19);
}

async function searchAliExpress(
  env: Env,
  keyword: string,
  fx: number,
): Promise<SourceOutcome> {
  const started = Date.now();

  if (!env.ALIEXPRESS_APP_KEY || !env.ALIEXPRESS_APP_SECRET) {
    const items = demoProducts("aliexpress", keyword, fx);
    return {
      report: {
        ...emptyReport(
          "aliexpress",
          "placeholder",
          Date.now() - started,
          "AliExpress credentials not set — demo catalogue",
        ),
        count: items.length,
      },
      items,
    };
  }

  // TODO(aliexpress): validate method + params against the affiliate API docs.
  // Placeholder for aliexpress.affiliate.product.query via the sync gateway.
  try {
    const base = env.ALIEXPRESS_BASE_URL || "https://api-sg.aliexpress.com/sync";
    const params: Record<string, string> = {
      app_key: env.ALIEXPRESS_APP_KEY,
      method: "aliexpress.affiliate.product.query",
      format: "json",
      v: "2.0",
      sign_method: "sha256",
      timestamp: aliexpressTimestamp(),
      keywords: keyword,
      target_currency: "MYR",
      target_language: "EN",
      page_size: "20",
      page_no: "1",
      ...(env.ALIEXPRESS_TRACKING_ID
        ? { tracking_id: env.ALIEXPRESS_TRACKING_ID }
        : {}),
    };
    params.sign = await aliexpressSign(params, env.ALIEXPRESS_APP_SECRET);

    const res = await fetch(base, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
      signal: timeoutSignal(8000),
    });

    if (!res.ok) {
      return {
        report: emptyReport(
          "aliexpress",
          "error",
          Date.now() - started,
          `AliExpress API HTTP ${res.status}`,
        ),
        items: [],
      };
    }

    const data = (await res.json()) as Record<string, unknown>;

    // The gateway answers HTTP 200 even for permission/parameter errors.
    const apiError = (data.error_response ?? {}) as Record<string, unknown>;
    if (apiError && Object.keys(apiError).length > 0) {
      const code = str(pick(apiError, ["code", "type"])) || "error";
      const message =
        str(pick(apiError, ["msg", "message"])) || "AliExpress rejected the call";
      return {
        report: emptyReport(
          "aliexpress",
          "error",
          Date.now() - started,
          `AliExpress ${code}: ${message}${code === "InsufficientPermission" ? " (enable Affiliate API in Open Platform)" : ""}`.slice(0, 200),
        ),
        items: [],
      };
    }

    const response = (data.aliexpress_affiliate_product_query_response ??
      {}) as Record<string, unknown>;
    const result = (response.resp_result ?? {}) as Record<string, unknown>;
    const nested = (result.result ?? {}) as Record<string, unknown>;
    const productNode = nested.products as unknown;
    const productList = (productNode ?? {}) as Record<string, unknown>;
    const rows = (
      Array.isArray(productNode)
        ? productNode
        : Array.isArray(productList.product)
          ? (productList.product as unknown[])
          : []
    ) as Array<Record<string, unknown>>;

    const items: Product[] = [];
    for (const row of rows) {
      const title = str(pick(row, ["product_title", "title"]));
      const id = str(pick(row, ["product_id", "productId"]));
      if (!title) continue;

      const price = num(pick(row, ["target_sale_price", "sale_price"]));
      if (price === null) continue;

      const shipping = DEFAULT_SHIPPING.aliexpress;
      const itemPrice = round2(price);
      items.push({
        id: id || `ae-${hash(title)}`,
        source: "aliexpress",
        source_label: SOURCE_META.aliexpress.label,
        title,
        price_myr: itemPrice,
        total_myr: round2(itemPrice + shipping.cost_myr),
        shipping,
        image:
          str(pick(row, ["product_main_image_url", "image_url"])) || null,
        url:
          str(pick(row, ["promotion_link", "product_detail_url"])) ||
          `https://www.aliexpress.com/item/${encodeURIComponent(id)}.html`,
        moq: 1,
        rating: num(pick(row, ["evaluate_rate"])),
        orders: num(pick(row, ["lastest_volume", "orders"])),
        demo: false,
      });
    }

    return {
      report: {
        ...emptyReport(
          "aliexpress",
          items.length ? "ok" : "empty",
          Date.now() - started,
        ),
        count: items.length,
      },
      items,
    };
  } catch (error) {
    return {
      report: emptyReport(
        "aliexpress",
        "error",
        Date.now() - started,
        error instanceof Error ? error.message : "AliExpress fetch failed",
      ),
      items: [],
    };
  }
}

/* ------------------------------------------------------------------ */
/* Search pipeline                                                     */
/* ------------------------------------------------------------------ */

function applyBudget(
  items: PricedProduct[],
  cap: number | null,
  basis: "price" | "total",
): { items: PricedProduct[]; removed: number } {
  if (cap === null) return { items, removed: 0 };
  const kept = items.filter((item) =>
    basis === "total" ? item.total_myr <= cap : item.price_myr <= cap,
  );
  return { items: kept, removed: items.length - kept.length };
}

async function runSearch(env: Env, rawQuery: string, limit: number): Promise<SearchPayload> {
  const started = Date.now();
  const fx = fxRate(env);
  const pricing = pricingFromEnv(env);
  const config = configStatus(env);

  const intent = await extractIntent(env, rawQuery);
  const keyword = intent.keyword || rawQuery;

  // Parallel, non-throwing adapters (supplier-level prices).
  const [cj, aliexpress] = await Promise.all([
    searchCj(env, keyword, fx),
    searchAliExpress(env, keyword, fx),
  ]);

  // Single margin + checkout pass so every source obeys the same rules.
  const priced = [...cj.items, ...aliexpress.items]
    .map((item) => priceProduct(item, env, pricing, rawQuery))
    .sort((a, b) => a.total_myr - b.total_myr);

  const budget = applyBudget(priced, intent.max_price_myr, "total");
  const results = budget.items.slice(0, clamp(limit, 1, MAX_RESULTS));

  const sources = [cj.report, aliexpress.report];
  const partial = sources.some(
    (source) => source.status === "error" || source.status === "empty",
  );

  return {
    ok: true,
    query: rawQuery,
    intent,
    pricing,
    config,
    budget: {
      max_price_myr: intent.max_price_myr,
      applied: intent.max_price_myr !== null,
      basis: "total",
      removed: budget.removed,
    },
    results,
    meta: {
      service: SERVICE,
      version: VERSION,
      generated_at: new Date().toISOString(),
      timing_ms: Date.now() - started,
      count: results.length,
      partial,
      sources,
    },
  };
}

/* ------------------------------------------------------------------ */
/* HTML renderer                                                       */
/* ------------------------------------------------------------------ */

const CSS = `
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  background:radial-gradient(1100px 520px at 15% -10%,#123049 0%,transparent 60%),
             radial-gradient(900px 500px at 90% 0%,#2a1a45 0%,transparent 55%),#070d18;
  color:#e6eefc;line-height:1.55;min-height:100vh;-webkit-font-smoothing:antialiased;
}
a{color:#5eead4;text-decoration:none}
a:hover{text-decoration:underline}
.wrap{max-width:1080px;margin:0 auto;padding:22px 18px 70px}
.top{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:6px 0 26px}
.brand{display:flex;align-items:center;gap:11px;font-weight:700;color:#e6eefc;font-size:17px}
.logo{width:36px;height:36px;border-radius:11px;background:linear-gradient(135deg,#22d3ee,#a78bfa);
  display:grid;place-items:center;color:#061018;font-weight:800;font-size:15px;letter-spacing:.5px}
.brand small{display:block;font-weight:500;color:#8fa3c4;font-size:11.5px;letter-spacing:.3px}
.top nav{display:flex;gap:16px;font-size:13.5px}
.top nav a{color:#9db2d3}
h1{font-size:clamp(26px,4.4vw,40px);line-height:1.15;margin:18px 0 10px;letter-spacing:-.5px}
h1 span{background:linear-gradient(100deg,#22d3ee,#a78bfa 70%);-webkit-background-clip:text;background-clip:text;color:transparent}
.lede{color:#9db2d3;font-size:15.5px;max-width:620px;margin:0 0 22px}
form.search{display:flex;gap:8px;background:#0f1b2e;border:1px solid #1e2f4a;border-radius:15px;padding:7px}
form.search:focus-within{border-color:#2c6d8a;box-shadow:0 0 0 3px rgba(34,211,238,.09)}
form.search input{flex:1;min-width:0;background:transparent;border:0;outline:none;color:#e6eefc;
  font-size:16px;padding:11px 13px;font-family:inherit}
form.search input::placeholder{color:#63799b}
form.search button{border:0;border-radius:10px;padding:0 20px;font-size:14.5px;font-weight:700;
  background:linear-gradient(135deg,#22d3ee,#7dd3fc);color:#04121c;cursor:pointer;font-family:inherit}
form.search button:hover{filter:brightness(1.07)}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin:14px 0 0}
.chip{font-size:12.5px;color:#b9cbe6;background:#101d31;border:1px solid #1e2f4a;
  border-radius:999px;padding:6px 12px}
.chip b{color:#e6eefc;font-weight:600}
.chip.demo{color:#fcd34d;border-color:#4a3a12;background:#1d1707}
.chip.err{color:#fca5a5;border-color:#4a1d1d;background:#1d0b0b}
.chip.ok{color:#86efac;border-color:#14432a;background:#08190f}
.summary{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin:20px 0 16px;color:#9db2d3;font-size:13.5px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(238px,1fr));gap:15px}
.card{background:#0e1a2d;border:1px solid #1c2b45;border-radius:15px;overflow:hidden;
  display:flex;flex-direction:column;transition:transform .15s ease,border-color .15s ease}
.card:hover{transform:translateY(-2px);border-color:#2b4a6f}
.thumb{aspect-ratio:4/3;background:linear-gradient(140deg,#13294a,#2a1c46);display:grid;place-items:center;overflow:hidden}
.thumb img{width:100%;height:100%;object-fit:cover;display:block}
.thumb .tile{font-size:26px;font-weight:800;letter-spacing:1px;color:#7c93b8;opacity:.85}
.card .body{padding:13px 14px 12px;display:flex;flex-direction:column;gap:7px;flex:1}
.src{font-size:10.5px;letter-spacing:.7px;text-transform:uppercase;color:#7c93b8;font-weight:700}
.src.cj{color:#67e8f9}
.src.aliexpress{color:#fca5a5}
.title{font-size:14.5px;font-weight:600;line-height:1.35;margin:0;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;min-height:39px}
.price{font-size:19px;font-weight:800;color:#fff;letter-spacing:-.3px}
.ship{font-size:11.8px;color:#8fa3c4}
.foot{margin-top:auto;display:flex;align-items:center;justify-content:space-between;gap:8px;padding-top:4px}
.total{font-size:11.8px;color:#9db2d3}
.total b{color:#5eead4}
.cta{font-size:12.5px;font-weight:700;padding:7px 12px;border-radius:9px;
  background:#12283f;color:#7dd3fc;border:1px solid #1e3d5c}
.cta:hover{background:#173451;text-decoration:none}
.empty{background:#0e1a2d;border:1px dashed #24374f;border-radius:15px;padding:34px 22px;text-align:center}
.empty h2{margin:0 0 8px;font-size:18px}
.empty p{margin:0 0 14px;color:#9db2d3;font-size:14px}
details.api{margin-top:36px;background:#0b1526;border:1px solid #1a2a42;border-radius:13px;padding:14px 16px}
details.api summary{cursor:pointer;font-size:13.5px;color:#9db2d3;font-weight:600}
details.api pre{overflow:auto;background:#060d18;border:1px solid #16233a;border-radius:9px;
  padding:12px;font-size:12px;color:#a7c2e6;margin:12px 0 0}
.steps{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px;margin:34px 0 0}
.step{background:#0d1829;border:1px solid #1a2a42;border-radius:13px;padding:16px}
.step b{display:block;color:#22d3ee;font-size:12px;letter-spacing:.8px;margin-bottom:6px}
.step h3{margin:0 0 5px;font-size:15px}
.step p{margin:0;color:#93a8c8;font-size:13px}
footer{margin-top:44px;padding-top:18px;border-top:1px solid #16233a;color:#63799b;font-size:12px;
  display:flex;flex-wrap:wrap;gap:10px;justify-content:space-between}
.err-box{background:#1a0d0d;border:1px solid #4a1d1d;border-radius:13px;padding:22px}
.err-box h1{font-size:22px;margin:0 0 8px}
.margin{font-size:11px;color:#8fa3c4;border-top:1px dashed #1c2b45;padding-top:7px;margin-top:2px}
.margin b{color:#fbbf24}
.foot .cta-buy{background:linear-gradient(135deg,#22d3ee,#7dd3fc);color:#04121c;border:0}
.foot .cta-buy:hover{filter:brightness(1.07)}
.src-link{font-size:11px;color:#7c93b8;margin-top:2px}
.status-card{background:#0d1829;border:1px solid #1a2a42;border-radius:13px;padding:16px 18px;margin-top:26px}
.status-card h3{margin:0 0 10px;font-size:12px;letter-spacing:.8px;text-transform:uppercase;color:#8fa3c4}
.status-row{display:flex;gap:10px;align-items:baseline;font-size:13px;padding:4px 0;flex-wrap:wrap}
.status-dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto;display:inline-block}
.ok-dot{background:#34d399}.warn-dot{background:#fbbf24}
.status-row code{color:#c7d7ee;font-size:12px}
.status-row .det{color:#8fa3c4;font-size:12px}
.status-foot{margin-top:10px;font-size:12px;color:#8fa3c4}
.checkout{max-width:560px;margin:8px auto 0}
.checkout .box{background:#0e1a2d;border:1px solid #1c2b45;border-radius:16px;padding:22px}
.checkout h1{font-size:22px;margin:0 0 4px;line-height:1.25}
.checkout .oid{color:#8fa3c4;font-size:12.5px;margin-bottom:16px;word-break:break-all}
.crow{display:flex;justify-content:space-between;gap:12px;padding:7px 0;font-size:14px;border-bottom:1px solid #14243a}
.crow span:first-child{color:#9db2d3}
.crow.total{border:0;padding-top:14px;font-size:19px;font-weight:800}
.wa-btn{display:flex;align-items:center;justify-content:center;gap:9px;margin-top:18px;background:#25d366;color:#04120a;font-weight:800;border-radius:12px;padding:14px;text-decoration:none}
.wa-btn:hover{filter:brightness(1.05);text-decoration:none}
.back{display:inline-block;margin-top:14px;font-size:13px;color:#7dd3fc}
.note{font-size:12px;color:#8fa3c4;margin-top:12px;line-height:1.5}
.langmenu{position:relative}
.langmenu summary{list-style:none;cursor:pointer;font-size:12.5px;color:#b9cbe6;background:#101d31;border:1px solid #1e2f4a;border-radius:10px;padding:7px 11px;white-space:nowrap}
.langmenu summary::-webkit-details-marker{display:none}
.langmenu[open] summary{border-color:#2c6d8a}
.langlist{position:absolute;right:0;top:calc(100% + 6px);background:#0e1a2d;border:1px solid #1e2f4a;border-radius:11px;padding:5px;min-width:160px;z-index:20;box-shadow:0 12px 30px rgba(0,0,0,.45)}
.langlist a{display:block;padding:7px 10px;border-radius:8px;font-size:13px;color:#c7d7ee}
.langlist a:hover{background:#132441;text-decoration:none}
.langlist a.active{color:#22d3ee;font-weight:700}
.top nav{align-items:center}
`;

/* ------------------------------------------------------------------ */
/* i18n (Bahasa Melayu default, English via top-right dropdown)        */
/* ------------------------------------------------------------------ */

type Lang = "ms" | "en";

const STRINGS: Record<Lang, Record<string, string>> = {
  ms: {
    tagline: "enjin carian dropship on-demand",
    nav_api: "API",
    nav_status: "Status",
    lang_name: "Bahasa Melayu",
    land_h1_a: "Cari produk dropship,",
    land_h1_b: "terus ikut bajet.",
    land_lede:
      "Taip apa yang awak nak dalam bahasa Melayu atau Inggeris. Enjin faham hasrat, cari di CJ Dropshipping & AliExpress serentak, dan susun ikut kos penghantaran sebenar.",
    search_placeholder: "cth: mini projector bawah RM80",
    search_aria: "Cari produk",
    search_btn: "Cari",
    chip_keyword: "Kata kunci",
    chip_budget: "Bajet",
    chip_no_limit: "tiada had",
    chip_intent: "Intent",
    engine_heuristic: "heuristik",
    step1_t: "Faham hasrat",
    step1_d: "Gemini Flash-Lite tukar ayat biasa jadi kata kunci + had bajet MYR.",
    step2_t: "Cari serentak",
    step2_d: "CJ dan AliExpress dipanggil selari, bukan satu-satu.",
    step3_t: "Margin + order",
    step3_d: "Kos supplier ditambah margin, setiap produk dapat butang Order.",
    status_title: "Status sistem",
    status_live: "aktif",
    status_missing: "tiada",
    status_margin_foot:
      "harga jual = kos supplier + margin, pos di-pass-through.",
    api_details: "Guna sebagai API (bot / curl)",
    api_json_details: "JSON untuk bot",
    results_products: "produk",
    results_filtered: "ditapis keluar (bajet)",
    results_margin: "margin",
    empty_title: "Tiada produk dalam bajet itu",
    empty_text: "Naikkan bajet, atau cuba kata kunci yang lebih umum.",
    card_margin: "Margin",
    card_supplier_cost: "kos supplier",
    card_total: "Total",
    card_order: "Order",
    card_view_on: "Lihat di",
    card_days: "hari",
    card_demo: "demo",
    checkout_supplier: "Harga supplier",
    checkout_shipping: "Penghantaran",
    checkout_margin: "Margin",
    checkout_total: "Jumlah",
    checkout_wa: "WhatsApp untuk sahkan",
    checkout_note:
      "Harga akhir disahkan di WhatsApp sebelum bayar. Kalau produk bertanda demo, harga supplier datang dari katalog demo sehingga kredensial sumber dipasang.",
    checkout_back: "Kembali ke carian",
    checkout_product: "Produk",
    error_title: "Ralat",
    error_back: "Kembali ke carian",
    footer_note: "Harga indikatif — sahkan stok & harga di platform sumber.",
    empty_q: "Taip kata kunci dulu — contoh: mini projector bawah RM80",
    invalid_query: "Pertanyaan mesti antara 2 hingga 200 aksara.",
    invalid_checkout: "Parameter checkout tidak sah (source, id, base).",
    missing_query: "Parameter q diperlukan.",
    meta_home_title: "MyKiraNiaga — enjin carian dropship on-demand",
    meta_home_desc:
      "Cari produk dropship ikut bajet. Gemini faham hasrat, CJ + AliExpress dicari serentak, harga dinormalisasi ke MYR.",
    meta_search_title: "MyKiraNiaga — carian",
    meta_search_desc: "Taip kata kunci untuk mula cari produk dropship.",
    meta_invalid_title: "Pertanyaan tidak sah — MyKiraNiaga",
    meta_checkout_title: "Checkout tidak sah — MyKiraNiaga",
    meta_order_desc: "Semak pesanan",
  },
  en: {
    tagline: "on-demand dropshipping search",
    nav_api: "API",
    nav_status: "Status",
    lang_name: "English",
    land_h1_a: "Find dropship products,",
    land_h1_b: "straight to your budget.",
    land_lede:
      "Type what you want in Malay or English. The engine extracts intent, searches CJ Dropshipping & AliExpress in parallel, and ranks by real shipping cost.",
    search_placeholder: "e.g. mini projector under RM80",
    search_aria: "Search products",
    search_btn: "Search",
    chip_keyword: "Keyword",
    chip_budget: "Budget",
    chip_no_limit: "no limit",
    chip_intent: "Intent",
    engine_heuristic: "heuristic",
    step1_t: "Read intent",
    step1_d: "Gemini Flash-Lite turns plain language into a keyword + MYR budget.",
    step2_t: "Search in parallel",
    step2_d: "CJ and AliExpress are called simultaneously, not one by one.",
    step3_t: "Margin + order",
    step3_d: "Supplier cost plus margin, every product gets an Order button.",
    status_title: "System status",
    status_live: "live",
    status_missing: "missing",
    status_margin_foot:
      "sell price = supplier cost + margin, shipping passed through.",
    api_details: "Use as API (bot / curl)",
    api_json_details: "JSON for bots",
    results_products: "products",
    results_filtered: "filtered out (budget)",
    results_margin: "margin",
    empty_title: "No products inside that budget",
    empty_text: "Raise the budget, or try a broader keyword.",
    card_margin: "Margin",
    card_supplier_cost: "supplier cost",
    card_total: "Total",
    card_order: "Order",
    card_view_on: "View on",
    card_days: "days",
    card_demo: "demo",
    checkout_supplier: "Supplier price",
    checkout_shipping: "Shipping",
    checkout_margin: "Margin",
    checkout_total: "Total",
    checkout_wa: "Confirm on WhatsApp",
    checkout_note:
      "Final price is confirmed on WhatsApp before payment. Demo rows use the sample catalogue until supplier credentials are set.",
    checkout_back: "Back to search",
    checkout_product: "Product",
    error_title: "Error",
    error_back: "Back to search",
    footer_note: "Indicative pricing — confirm stock & price on the source platform.",
    empty_q: "Type a keyword first — e.g. mini projector under RM80",
    invalid_query: "Query must be between 2 and 200 characters.",
    invalid_checkout: "Invalid checkout parameters (source, id, base).",
    missing_query: "The q parameter is required.",
    meta_home_title: "MyKiraNiaga — on-demand dropshipping search",
    meta_home_desc:
      "Search dropship products by budget. Gemini reads intent, CJ + AliExpress searched in parallel, prices normalised to MYR.",
    meta_search_title: "MyKiraNiaga — search",
    meta_search_desc: "Type a keyword to start searching dropship products.",
    meta_invalid_title: "Invalid query — MyKiraNiaga",
    meta_checkout_title: "Invalid checkout — MyKiraNiaga",
    meta_order_desc: "Review order",
  },
};

function t(lang: Lang, key: string): string {
  return STRINGS[lang][key] ?? STRINGS.ms[key] ?? key;
}

function langUrl(fullUrl: string, lang: Lang): string {
  const url = new URL(fullUrl, "https://mykiraniaga.local");
  url.searchParams.set("lang", lang);
  return `${url.pathname}${url.search}`;
}

function layout(opts: {
  title: string;
  description: string;
  body: string;
  lang: Lang;
  currentUrl: string;
}): string {
  const { lang } = opts;
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(opts.title)}</title>
<meta name="description" content="${esc(opts.description)}">
<meta name="robots" content="index,follow">
<style>${CSS}</style>
</head>
<body>
<div class="wrap">
  <header class="top">
    <a class="brand" href="/">
      <span class="logo">MK</span>
      <span>MyKiraNiaga<small>${esc(t(lang, "tagline"))}</small></span>
    </a>
    <nav>
      <a href="/api">${esc(t(lang, "nav_api"))}</a>
      <a href="/health">${esc(t(lang, "nav_status"))}</a>
      <details class="langmenu">
        <summary>${lang === "ms" ? "BM" : "EN"} ▾</summary>
        <div class="langlist">
          <a href="${esc(langUrl(opts.currentUrl, "ms"))}" class="${
            lang === "ms" ? "active" : ""
          }">Bahasa Melayu</a>
          <a href="${esc(langUrl(opts.currentUrl, "en"))}" class="${
            lang === "en" ? "active" : ""
          }">English</a>
        </div>
      </details>
    </nav>
  </header>
  ${opts.body}
  <footer>
    <span>MyKiraNiaga v${VERSION} · Hono + Cloudflare Workers</span>
    <span>${esc(t(lang, "footer_note"))}</span>
  </footer>
</div>
</body>
</html>`;
}

function searchForm(q: string, autofocus: boolean, lang: Lang): string {
  return `<form class="search" action="/search" method="get" role="search">
  <input type="hidden" name="lang" value="${lang}">
  <input type="search" name="q" value="${esc(q)}" placeholder="${esc(
    t(lang, "search_placeholder"),
  )}"
    aria-label="${esc(t(lang, "search_aria"))}" ${
      autofocus ? "autofocus" : ""
    } required minlength="2" maxlength="200">
  <button type="submit">${esc(t(lang, "search_btn"))}</button>
</form>`;
}

function intentChips(payload: SearchPayload, lang: Lang): string {
  const chips: string[] = [];
  chips.push(
    `<span class="chip">${esc(t(lang, "chip_keyword"))}: <b>${esc(
      payload.intent.keyword,
    )}</b></span>`,
  );
  chips.push(
    payload.intent.max_price_myr === null
      ? `<span class="chip">${esc(t(lang, "chip_budget"))}: <b>${esc(
          t(lang, "chip_no_limit"),
        )}</b></span>`
      : `<span class="chip">${esc(t(lang, "chip_budget"))}: <b>≤ ${money(
          payload.intent.max_price_myr,
        )}</b></span>`,
  );
  chips.push(
    `<span class="chip">${esc(t(lang, "chip_intent"))}: <b>${
      payload.intent.engine === "gemini"
        ? "Gemini Flash-Lite"
        : esc(t(lang, "engine_heuristic"))
    }</b></span>`,
  );
  for (const source of payload.meta.sources) {
    const cls =
      source.status === "ok"
        ? "ok"
        : source.status === "placeholder"
          ? "demo"
          : source.status === "error" || source.status === "missing_credentials"
            ? "err"
            : "";
    chips.push(
      `<span class="chip ${cls}" title="${esc(source.note ?? "")}">${esc(
        source.label,
      )}: <b>${esc(source.status)}</b> · ${source.count}</span>`,
    );
  }
  return `<div class="chips">${chips.join("")}</div>`;
}

function productCard(product: PricedProduct, lang: Lang): string {
  const thumb = product.image
    ? `<img src="${esc(product.image)}" alt="${esc(product.title)}" loading="lazy" referrerpolicy="no-referrer">`
    : `<span class="tile">${esc(SOURCE_META[product.source].short)}</span>`;

  const rating =
    product.rating === null ? "" : ` · ★ ${product.rating.toFixed(1)}`;

  return `<article class="card">
  <div class="thumb">${thumb}</div>
  <div class="body">
    <span class="src ${product.source}">${esc(product.source_label)}${
      product.demo ? ` · ${esc(t(lang, "card_demo"))}` : ""
    }</span>
    <h3 class="title">${esc(product.title)}</h3>
    <div class="price">${money(product.price_myr)}</div>
    <div class="ship">${esc(product.shipping.method)} · ${product.shipping.days_min}–${
      product.shipping.days_max
    } ${esc(t(lang, "card_days"))} · ${money(product.shipping.cost_myr)}${rating}</div>
    <div class="margin">${esc(t(lang, "card_margin"))} <b>${money(
      product.margin_myr,
    )}</b> · ${esc(t(lang, "card_supplier_cost"))} ${money(
      product.supplier_total_myr,
    )}</div>
    <div class="foot">
      <span class="total">${esc(t(lang, "card_total"))} <b>${money(
        product.total_myr,
      )}</b></span>
      <a class="cta cta-buy" href="${esc(product.checkout_url)}">${esc(
        t(lang, "card_order"),
      )} →</a>
    </div>
    <a class="src-link" href="${esc(
      product.url,
    )}" target="_blank" rel="noopener nofollow">${esc(
      t(lang, "card_view_on"),
    )} ${esc(product.source_label)}</a>
  </div>
</article>`;
}

const EXAMPLES = [
  "mini projector bawah RM80",
  "wireless earbuds under RM50",
  "beg kanvas murah",
  "car vacuum below $15",
];

function statusPanel(env: Env, lang: Lang): string {
  const config = configStatus(env);
  const rows = [config.gemini, config.cj, config.aliexpress, config.whatsapp]
    .map((item) => {
      const dot = item.configured ? "ok-dot" : "warn-dot";
      const mark = item.configured
        ? t(lang, "status_live")
        : t(lang, "status_missing");
      return `<div class="status-row"><span class="status-dot ${dot}"></span><code>${esc(
        item.key,
      )}</code><span class="det">${esc(mark)} · ${esc(item.detail)}</span></div>`;
    })
    .join("");
  const p = config.pricing;

  return `<div class="status-card">
  <h3>${esc(t(lang, "status_title"))}</h3>
  ${rows}
  <div class="status-foot">Margin <b>${p.markup_pct}%</b>${
    p.flat_myr ? ` + ${money(p.flat_myr)}` : ""
  } · ${esc(t(lang, "status_margin_foot"))}</div>
</div>`;
}

function landingBody(env: Env, lang: Lang, errorNote?: string): string {
  return `<h1>${esc(t(lang, "land_h1_a"))} <span>${esc(
    t(lang, "land_h1_b"),
  )}</span></h1>
<p class="lede">${esc(t(lang, "land_lede"))}</p>
${searchForm("", true, lang)}
${errorNote ? `<div class="chips"><span class="chip err">${esc(errorNote)}</span></div>` : ""}
<div class="chips">
${EXAMPLES.map(
  (example) =>
    `<a class="chip" href="/search?q=${encodeURIComponent(example)}&amp;lang=${lang}">${esc(
      example,
    )}</a>`,
).join("")}
</div>
<div class="steps">
  <div class="step"><b>01</b><h3>${esc(t(lang, "step1_t"))}</h3><p>${esc(
    t(lang, "step1_d"),
  )}</p></div>
  <div class="step"><b>02</b><h3>${esc(t(lang, "step2_t"))}</h3><p>${esc(
    t(lang, "step2_d"),
  )}</p></div>
  <div class="step"><b>03</b><h3>${esc(t(lang, "step3_t"))}</h3><p>${esc(
    t(lang, "step3_d"),
  )}</p></div>
</div>
${statusPanel(env, lang)}
<details class="api">
  <summary>${esc(t(lang, "api_details"))}</summary>
  <pre>curl "https://mykiraniaga.mykira.workers.dev/api/search?q=mini+projector+bawah+RM80"
curl -H "Accept: application/json" "https://mykiraniaga.mykira.workers.dev/search?q=earbuds"</pre>
</details>`;
}

function resultsBody(payload: SearchPayload, lang: Lang): string {
  const cards = payload.results.map((product) => productCard(product, lang)).join("\n");
  const jsonHref = `/search?q=${encodeURIComponent(payload.query)}&amp;format=json&amp;lang=${lang}`;

  const body = payload.results.length
    ? `<div class="grid">${cards}</div>`
    : `<div class="empty">
        <h2>${esc(t(lang, "empty_title"))}</h2>
        <p>${esc(t(lang, "empty_text"))}</p>
        <div class="chips" style="justify-content:center">
          ${EXAMPLES.map(
            (example) =>
              `<a class="chip" href="/search?q=${encodeURIComponent(
                example,
              )}&amp;lang=${lang}">${esc(example)}</a>`,
          ).join("")}
        </div>
      </div>`;

  return `${searchForm(payload.query, false, lang)}
${intentChips(payload, lang)}
<div class="summary">
  <span><b>${payload.meta.count}</b> ${esc(t(lang, "results_products"))}</span>
  ${
    payload.budget.applied
      ? `<span>· ${payload.budget.removed} ${esc(t(lang, "results_filtered"))}</span>`
      : ""
  }
  <span>· ${esc(t(lang, "results_margin"))} ${payload.pricing.markup_pct}%${
    payload.pricing.flat_myr ? ` + ${money(payload.pricing.flat_myr)}` : ""
  }</span>
  <span>· ${payload.meta.timing_ms} ms</span>
  <span>· <a href="${jsonHref}">JSON</a></span>
</div>
${body}
<details class="api">
  <summary>${esc(t(lang, "api_json_details"))}</summary>
  <pre>GET /api/search?q=${esc(encodeURIComponent(payload.query))}
Accept: application/json</pre>
</details>`;
}

function errorBody(message: string, lang: Lang): string {
  return `<div class="err-box">
  <h1>${esc(t(lang, "error_title"))}</h1>
  <p style="color:#fca5a5;margin:0 0 14px">${esc(message)}</p>
  <a class="chip" href="/">${esc(t(lang, "error_back"))}</a>
</div>`;
}

interface CheckoutOrder {
  id: string;
  source: SourceId;
  source_label: string;
  title: string;
  supplier_price_myr: number;
  supplier_total_myr: number;
  shipping_myr: number;
  shipping_method: string;
  margin_myr: number;
  total_myr: number;
  markup_pct: number;
  flat_myr: number;
  whatsapp_url: string;
}

function checkoutBody(order: CheckoutOrder, query: string, lang: Lang): string {
  const back = query ? `/search?q=${encodeURIComponent(query)}&lang=${lang}` : "/";
  const marginLabel = `${order.markup_pct}%${
    order.flat_myr ? ` + ${money(order.flat_myr)}` : ""
  }`;

  return `<div class="checkout"><div class="box">
  <h1>${esc(order.title)}</h1>
  <div class="oid">ID ${esc(order.id)} · ${esc(order.source_label)}</div>
  <div class="crow"><span>${esc(t(lang, "checkout_supplier"))}</span><span>${money(
    order.supplier_price_myr,
  )}</span></div>
  <div class="crow"><span>${esc(t(lang, "checkout_shipping"))} (${esc(
    order.shipping_method,
  )})</span><span>${money(order.shipping_myr)}</span></div>
  <div class="crow"><span>${esc(t(lang, "checkout_margin"))} ${esc(
    marginLabel,
  )}</span><span>${money(order.margin_myr)}</span></div>
  <div class="crow total"><span>${esc(t(lang, "checkout_total"))}</span><span>${money(
    order.total_myr,
  )}</span></div>
  <a class="wa-btn" href="${esc(
    order.whatsapp_url,
  )}" target="_blank" rel="noopener">${esc(t(lang, "checkout_wa"))}</a>
  <p class="note">${esc(t(lang, "checkout_note"))}</p>
  <a class="back" href="${esc(back)}">← ${esc(t(lang, "checkout_back"))}</a>
</div></div>`;
}

/* ------------------------------------------------------------------ */
/* App                                                                 */
/* ------------------------------------------------------------------ */

function cookieValue(c: Context, name: string): string {
  const header = c.req.header("cookie") ?? "";
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    if (trimmed.slice(0, eq) === name) {
      return decodeURIComponent(trimmed.slice(eq + 1));
    }
  }
  return "";
}

function langFrom(c: Context): Lang {
  const requested = (c.req.query("lang") ?? "").toLowerCase();
  if (requested === "ms" || requested === "en") return requested;
  return cookieValue(c, "mkn_lang").toLowerCase() === "en" ? "en" : "ms";
}

const app = new Hono<{ Bindings: Env }>();

app.use("*", async (c, next) => {
  const requested = (c.req.query("lang") ?? "").toLowerCase();
  await next();
  if (requested === "ms" || requested === "en") {
    c.header(
      "Set-Cookie",
      `mkn_lang=${requested}; Path=/; Max-Age=2592000; SameSite=Lax`,
    );
  }
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  c.header("Vary", "Accept, Cookie");
});

app.use("/api/*", cors({ origin: "*", allowMethods: ["GET", "OPTIONS"], maxAge: 86400 }));

app.get("/", (c) => {
  if (wantsJson(c)) {
    return c.json({
      service: SERVICE,
      version: VERSION,
      description:
        "On-demand dropshipping search engine. Gemini Flash-Lite intent extraction, parallel CJ + AliExpress lookup, MYR normalisation, profit margin and WhatsApp checkout handoff.",
      endpoints: {
        "GET /search?q=": "HTML for humans, JSON when ?format=json or Accept: application/json",
        "GET /api/search?q=": "JSON only",
        "GET /checkout?source=&id=&base=": "order summary + WhatsApp handoff",
        "GET /health": "health probe + key status",
      },
      config: configStatus(c.env),
      examples: [
        "/search?q=mini%20projector%20bawah%20RM80",
        "/api/search?q=wireless%20earbuds%20under%20RM50",
      ],
    });
  }

  const lang = langFrom(c);
  return c.html(
    layout({
      title: t(lang, "meta_home_title"),
      description: t(lang, "meta_home_desc"),
      body: landingBody(c.env, lang),
      lang,
      currentUrl: c.req.url,
    }),
  );
});

app.get("/search", async (c) => {
  const lang = langFrom(c);
  const rawQuery = (c.req.query("q") ?? "").trim();

  if (!rawQuery) {
    if (wantsJson(c)) {
      return c.json(
        { ok: false, error: "missing_query", message: t(lang, "missing_query") },
        400,
      );
    }
    return c.html(
      layout({
        title: t(lang, "meta_search_title"),
        description: t(lang, "meta_search_desc"),
        body: landingBody(c.env, lang, t(lang, "empty_q")),
        lang,
        currentUrl: c.req.url,
      }),
    );
  }

  if (rawQuery.length < 2 || rawQuery.length > 200) {
    const message = t(lang, "invalid_query");
    if (wantsJson(c)) {
      return c.json({ ok: false, error: "invalid_query", message }, 400);
    }
    return c.html(
      layout({
        title: t(lang, "meta_invalid_title"),
        description: message,
        body: errorBody(message, lang),
        lang,
        currentUrl: c.req.url,
      }),
      400,
    );
  }

  const limit = Number(c.req.query("limit") ?? "24");
  const payload = await runSearch(c.env, rawQuery, Number.isFinite(limit) ? limit : 24);

  c.header("Cache-Control", "public, max-age=60");

  if (wantsJson(c)) return c.json(payload);

  const budgetSuffix =
    payload.intent.max_price_myr === null
      ? ""
      : lang === "en"
        ? ` under ${money(payload.intent.max_price_myr)}`
        : ` bawah ${money(payload.intent.max_price_myr)}`;
  const description =
    lang === "en"
      ? `Dropship results for "${payload.intent.keyword}"${budgetSuffix}.`
      : `Hasil carian dropship untuk "${payload.intent.keyword}"${budgetSuffix}.`;

  return c.html(
    layout({
      title: `${payload.intent.keyword} — MyKiraNiaga`,
      description,
      body: resultsBody(payload, lang),
      lang,
      currentUrl: c.req.url,
    }),
  );
});

app.get("/checkout", (c) => {
  const lang = langFrom(c);
  const source = (c.req.query("source") ?? "").toLowerCase();
  const id = (c.req.query("id") ?? "").trim().slice(0, 140);
  const query = (c.req.query("q") ?? "").trim().slice(0, 200);
  const base = Number(c.req.query("base"));
  const validSource = source === "cj" || source === "aliexpress";

  if (!validSource || !id || !Number.isFinite(base) || base <= 0 || base > 100000) {
    const message = t(lang, "invalid_checkout");
    if (wantsJson(c)) {
      return c.json({ ok: false, error: "invalid_checkout", message }, 400);
    }
    return c.html(
      layout({
        title: t(lang, "meta_checkout_title"),
        description: message,
        body: errorBody(message, lang),
        lang,
        currentUrl: c.req.url,
      }),
      400,
    );
  }

  const sourceId = source as SourceId;
  const shipping = DEFAULT_SHIPPING[sourceId];
  const pricing = pricingFromEnv(c.env);
  // `base` is the supplier landed total carried by the result card.
  const supplierPrice = round2(Math.max(base - shipping.cost_myr, 0.01));
  const margin = applyMargin(supplierPrice, shipping.cost_myr, pricing);
  const title =
    (c.req.query("title") ?? "").trim().slice(0, 140) ||
    `${t(lang, "checkout_product")} ${id}`;
  const label = SOURCE_META[sourceId].label;

  const waText =
    lang === "en"
      ? [
          "I want to order:",
          `1) ${title}`,
          `ID: ${id}`,
          `Source: ${label}`,
          `Total: ${money(margin.total)} (incl. shipping)`,
        ].join("\n")
      : [
          "Saya nak order:",
          `1) ${title}`,
          `ID: ${id}`,
          `Sumber: ${label}`,
          `Jumlah: ${money(margin.total)} (termasuk pos)`,
        ].join("\n");

  const order: CheckoutOrder = {
    id,
    source: sourceId,
    source_label: label,
    title,
    supplier_price_myr: margin.supplier_price,
    supplier_total_myr: margin.supplier_total,
    shipping_myr: shipping.cost_myr,
    shipping_method: shipping.method,
    margin_myr: margin.margin,
    total_myr: margin.total,
    markup_pct: pricing.markup_pct,
    flat_myr: pricing.flat_myr,
    whatsapp_url: `https://wa.me/${whatsappNumber(c.env)}?text=${encodeURIComponent(
      waText,
    )}`,
  };

  c.header("Cache-Control", "no-store");

  if (wantsJson(c)) return c.json({ ok: true, order, pricing });

  return c.html(
    layout({
      title: `${id} — MyKiraNiaga`,
      description: `${t(lang, "meta_order_desc")}: ${title} (${money(
        order.total_myr,
      )}).`,
      body: checkoutBody(order, query, lang),
      lang,
      currentUrl: c.req.url,
    }),
  );
});

app.get("/api/search", async (c) => {
  const rawQuery = (c.req.query("q") ?? "").trim();
  if (rawQuery.length < 2 || rawQuery.length > 200) {
    return c.json(
      {
        ok: false,
        error: "invalid_query",
        message: "Parameter q diperlukan (2-200 aksara) / q is required (2-200 chars).",
      },
      400,
    );
  }

  const limit = Number(c.req.query("limit") ?? "24");
  const payload = await runSearch(c.env, rawQuery, Number.isFinite(limit) ? limit : 24);
  c.header("Cache-Control", "public, max-age=60");
  return c.json(payload);
});

app.get("/api", (c) =>
  c.json({
    service: SERVICE,
    version: VERSION,
    endpoints: {
      "GET /search?q=&format=json": "search (content negotiated)",
      "GET /api/search?q=": "search (JSON)",
      "GET /checkout?source=&id=&base=": "checkout summary (HTML or JSON)",
      "GET /health": "health",
    },
    params: {
      q: "query string, 2-200 chars",
      format: "json | html (optional)",
      lang: "ms | en (optional, default ms)",
      limit: `1-${MAX_RESULTS} (default 24)`,
    },
    response_fields: {
      intent: ["keyword", "max_price_myr", "engine", "model", "note"],
      pricing: ["markup_pct", "flat_myr"],
      config: ["gemini", "cj", "aliexpress", "whatsapp", "pricing"],
      budget: ["max_price_myr", "applied", "basis", "removed"],
      results: [
        "id",
        "source",
        "title",
        "price_myr",
        "total_myr",
        "shipping",
        "image",
        "url",
        "demo",
        "supplier_price_myr",
        "supplier_total_myr",
        "margin_myr",
        "checkout_url",
        "whatsapp_url",
      ],
      meta: ["timing_ms", "count", "partial", "sources"],
    },
  }),
);

app.get("/health", (c) =>
  c.json({
    ok: true,
    service: SERVICE,
    version: VERSION,
    time: new Date().toISOString(),
    keys: configStatus(c.env),
    margin: pricingFromEnv(c.env),
    whatsapp: `+${whatsappNumber(c.env)}`,
  }),
);

app.get("/robots.txt", (c) => c.text("User-agent: *\nAllow: /\n"));

app.notFound((c) => {
  const lang = langFrom(c);
  if (wantsJson(c)) {
    return c.json({ ok: false, error: "not_found" }, 404);
  }
  return c.html(
    layout({
      title: lang === "en" ? "Not found — MyKiraNiaga" : "Tidak dijumpai — MyKiraNiaga",
      description: lang === "en" ? "Page not found." : "Halaman tidak dijumpai.",
      body: errorBody(
        lang === "en" ? "Page not found." : "Halaman tidak dijumpai.",
        lang,
      ),
      lang,
      currentUrl: c.req.url,
    }),
    404,
  );
});

app.onError((error, c) => {
  const lang = langFrom(c);
  const message =
    error instanceof Error
      ? error.message
      : lang === "en"
        ? "Unknown error"
        : "Ralat tidak diketahui";
  if (wantsJson(c)) {
    return c.json({ ok: false, error: "internal_error", message }, 500);
  }
  return c.html(
    layout({
      title: lang === "en" ? "Error — MyKiraNiaga" : "Ralat — MyKiraNiaga",
      description: message,
      body: errorBody(message, lang),
      lang,
      currentUrl: c.req.url,
    }),
    500,
  );
});

export default app;