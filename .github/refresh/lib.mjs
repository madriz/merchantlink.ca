// Shared helpers for the snapshot steps. Node 20, no dependencies.
// Each step writes demo/data/<name>.json with captured_at, source, status and, when not ok, a plain error.
// A failed step keeps the last good data and records the failed attempt next to it (D-027).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DATA_DIR = join(ROOT, "demo", "data");

export const HERO = {
  text: "Cheapest 65-inch OLED TV, Samsung or LG, in Toronto.",
  size_in: 65,
  panel: "OLED",
  brands: ["Samsung", "LG"],
};

export const LOCATIONS = [
  { id: "toronto", city: "Toronto", province: "ON", query_location: "Toronto, ON" },
  { id: "montreal", city: "Montreal", province: "QC", query_location: "Montreal, QC" },
];

// Provincial sales tax used for ranking. Same numbers as the browser ranking.
export const TAX = {
  ON: { label: "HST 13%", rate: 0.13 },
  QC: { label: "GST 5% + QST 9.975%", rate: 0.14975 },
};

export function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function readData(name) {
  const p = join(DATA_DIR, `${name}.json`);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function write(name, obj) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(join(DATA_DIR, `${name}.json`), JSON.stringify(obj, null, 2) + "\n");
}

// Write a successful result. Replaces the file.
export function writeOk(name, source, data) {
  write(name, { captured_at: nowIso(), source, status: "ok", ...data });
}

// Write a partial result: the step reached part of the way and its data is current. Replaces the file.
export function writePartial(name, source, error, data) {
  write(name, { captured_at: nowIso(), source, status: "partial", error: plain(error), ...data });
}

// Write a not-ok result. Keeps the last good data if there is one.
// status is "refused", "error" or "partial". data may carry non-secret detail.
export function writeNotOk(name, source, status, error, data = {}) {
  const prev = readData(name);
  const attempt = { at: nowIso(), status, error: plain(error) };
  if (prev && prev.status === "ok") {
    write(name, { ...prev, last_attempt: attempt });
    return;
  }
  write(name, { captured_at: attempt.at, source, status, error: attempt.error, ...data });
}

// Keep error text short and free of anything that looks like a credential.
export function plain(err) {
  const s = String(err && err.message ? err.message : err || "unknown error");
  return s
    .replace(/(sk|rk|pk)_(test|live)_[A-Za-z0-9]+/g, "[redacted]")
    .replace(/shp[a-z]{2}_[A-Za-z0-9]+/g, "[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .replace(/eyJ[A-Za-z0-9._-]{20,}/g, "[redacted]")
    .slice(0, 400);
}

// Run a step so that any throw becomes an "error" file instead of a crash.
export async function runStep(name, source, fn) {
  try {
    await fn();
  } catch (e) {
    writeNotOk(name, source, "error", e);
    console.log(`${name}: error, ${plain(e)}`);
    return;
  }
  const d = readData(name);
  console.log(`${name}: ${d?.last_attempt ? d.last_attempt.status + " (kept last good file)" : d?.status}`);
}

export async function fetchJson(url, opts = {}, timeoutMs = 20000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: ctl.signal });
    const text = await r.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // Some MCP servers answer as an event stream.
      const line = text.split("\n").filter((l) => l.startsWith("data:")).pop();
      if (line) {
        try {
          json = JSON.parse(line.slice(5));
        } catch {
          json = null;
        }
      }
    }
    return { status: r.status, ok: r.ok, headers: r.headers, json, text };
  } finally {
    clearTimeout(t);
  }
}

// Minimal MCP client over streamable HTTP. One session, one User-Agent.
export function mcpClient(url, { userAgent, headers = {} } = {}) {
  let id = 0;
  let sessionId = null;
  async function call(method, params, notify = false) {
    const h = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "user-agent": userAgent,
      ...headers,
    };
    if (sessionId) h["mcp-session-id"] = sessionId;
    const body = notify ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id: ++id, method, params };
    const r = await fetchJson(url, { method: "POST", headers: h, body: JSON.stringify(body) });
    sessionId = r.headers.get("mcp-session-id") || sessionId;
    if (notify) return null;
    if (!r.ok) throw new Error(`${method} returned HTTP ${r.status}`);
    if (!r.json) throw new Error(`${method} returned a body that is not JSON`);
    if (r.json.error) throw new Error(`${method} error ${r.json.error.code}: ${r.json.error.message}`);
    return r.json.result;
  }
  return {
    async init(clientName) {
      const res = await call("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: clientName, version: "0.1" },
      });
      await call("notifications/initialized", {}, true);
      return res;
    },
    async tool(name, args, meta) {
      const params = { name, arguments: args };
      if (meta) params._meta = meta;
      const res = await call("tools/call", params);
      if (res.structuredContent) return { raw: res, data: res.structuredContent };
      const text = res.content?.find((c) => c.type === "text")?.text;
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = { text };
      }
      if (res.isError) throw new Error(`${name} failed: ${plain(text || "tool error")}`);
      return { raw: res, data };
    },
  };
}

// Lowest-landed-cost offer for a location, using the same rules as the browser.
export function chooseOffer(hg, shopify, province) {
  const rate = TAX[province].rate;
  const offers = [];
  const loc = hg?.locations?.find((l) => l.province === province);
  for (const p of loc?.products || []) {
    if (p.in_stock && p.best_new_price_cad) offers.push({ source: "homegadgets", id: p.product_id, title: p.name, merchant: p.retailer, price_cad: p.best_new_price_cad });
  }
  // Shopify offers count only when new, matched to a HomeGadgets reference by MPN and past every rule (S-004).
  for (const o of shopify?.offers || []) {
    if (o.status === "eligible") offers.push({ source: "shopify", id: o.product_id, title: o.title, merchant: o.merchant, price_cad: o.price });
  }
  offers.forEach((o) => (o.landed_cad = Math.round(o.price_cad * (1 + rate) * 100) / 100));
  offers.sort((a, b) => a.landed_cad - b.landed_cad);
  return offers[0] || null;
}
