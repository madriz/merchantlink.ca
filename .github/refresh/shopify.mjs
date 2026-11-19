// Shopify Global Catalog snapshot through the UCP MCP endpoint.
// Auth per https://shopify.dev/docs/agents/get-started/authentication: client credentials to a 60-minute JWT.
// Anonymous mode when SHOPIFY_CATALOG_KEY is absent (the public repo, D-032): no token, lower rate limits.
// Anonymous calls still honour the saved catalog_id (tested 2026-11-19: saved_catalog_boundary_applied).
// If the saved catalog is refused, the same filters are sent inline. One search plus throttled product reads.
// Stores no images. Keeps only CAD offers. Each run replaces the file.
// Each offer is matched to HomeGadgets by model number (MPN), never by brand (S-004).
import { HERO, fetchJson, mcpClient, nowIso, plain, readData, runStep, writeOk, writeNotOk } from "./lib.mjs";

const NAME = "shopify";
const SOURCE = "Shopify Global Catalog, https://catalog.shopify.com/api/ucp/mcp";
const MCP_URL = "https://catalog.shopify.com/api/ucp/mcp";
const CATALOG_ID = "01m7rkz1dmf3b2hj0aqkgbrx4y";
const QUERY = "65 inch OLED TV Samsung LG";
// Shopify's published example agent profile. To be replaced by a MerchantLink profile.
const PROFILE_URL = "https://shopify.dev/ucp/agent-profiles/examples/2026-08-25/valid-with-capabilities.json";
// The saved catalog caps a search at 10 results.
const LIMIT = 10;
const HG_DAILY_LOOKUPS = 25;
const MAX_PRICE = 50000;
// The saved catalog's filters, for the inline fallback: ships to CA, ships from CA, in stock.
const INLINE_FILTERS = { ships_to: { country: "CA" }, ships_from: [{ country: "CA" }], available: true };

const SIZE_RE = /\b65\s*(?:"|''|”|″|-?\s*(?:in|inch|inches|pouces|po)\b)|OLED65|QN65|\b65[A-Z]{1,3}\d|\b65\b/i;
const MPN_RES = [/\bOLED\d{2}[A-Z]\d[A-Z0-9]{1,4}\b/i, /\bQ[NE]\d{2}[A-Z]{1,2}\d{2}[A-Z0-9]{0,7}\b/i];
const NOT_NEW_WORDS = /\b(refurb(?:ished)?|renewed|open[- ]box|bo[iî]te[- ]ouverte|used|pre-owned|demo|d[eé]mo|reconditionn\w*|remis [aà] neuf)\b/i;
const SHORT_WARRANTY = /\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven)[\s-]*(months?|mois)\b[^|]{0,25}\b(warranty|garantie)\b|\b\d{1,3}[\s-]*(days?|jours?)\b[^|]{0,25}\b(warranty|garantie)\b/i;

const money = (n) => `$${Number(n).toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Shopify prices are integers in minor units (cents): 99700 is $997.00.
const cents = (amount) => Math.round(Number(amount)) / 100;

function brandOf(title) {
  if (/\bsamsung\b/i.test(title)) return "Samsung";
  if (/\blg\b/i.test(title)) return "LG";
  return null;
}

function mpnOf(title) {
  for (const re of MPN_RES) {
    const m = title.match(re);
    if (m) return m[0].toUpperCase();
  }
  return null;
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function textOf(result) {
  return result?.content?.find((c) => c.type === "text")?.text || "";
}

// Models HomeGadgets already returned in today's snapshot, keyed by model number.
function snapshotModels(hg) {
  const map = new Map();
  for (const loc of hg?.locations || []) {
    if (loc.province !== "ON") continue;
    for (const p of loc.products || []) {
      if (!p.model_number || !p.best_new_price_cad) continue;
      map.set(p.model_number.toUpperCase(), {
        mpn: p.model_number.toUpperCase(),
        source: "HomeGadgets snapshot (search_products, Toronto)",
        hg_product_id: p.product_id,
        hg_name: p.name,
        best_new_price_cad: p.best_new_price_cad,
        retailer: p.retailer,
        retailer_count: p.retailer_count,
        observed_at: p.observed_at,
        condition_status: p.condition_status || null,
      });
    }
  }
  return map;
}

await runStep(NAME, SOURCE, async () => {
  const key = process.env.SHOPIFY_CATALOG_KEY || "";
  const anonymous = key === "";
  let token = null;
  if (!anonymous) {
    const i = key.indexOf(":");
    if (i < 1 || i === key.length - 1) {
      writeNotOk(NAME, SOURCE, "error", "SHOPIFY_CATALOG_KEY is not client_id:client_secret");
      return;
    }
    const tok = await fetchJson("https://api.shopify.com/auth/access_token", {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "MerchantLink-demo/0.1" },
      body: JSON.stringify({ client_id: key.slice(0, i), client_secret: key.slice(i + 1), grant_type: "client_credentials" }),
    });
    token = tok.json?.access_token;
    if (!tok.ok || !token) {
      const why = tok.json?.error_description || tok.json?.error || `HTTP ${tok.status}`;
      writeNotOk(NAME, SOURCE, tok.status === 401 || tok.status === 403 ? "refused" : "error", `Token request failed: ${plain(why)}`);
      return;
    }
  }

  let rpcId = 0;
  async function tool(name, catalog) {
    const r = await fetchJson(MCP_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        "user-agent": "MerchantLink-demo/0.1",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++rpcId,
        method: "tools/call",
        params: { name, arguments: { meta: { "ucp-agent": { profile: PROFILE_URL } }, catalog } },
      }),
    });
    return r;
  }

  const saved = { query: QUERY, catalog_id: CATALOG_ID, context: { address_country: "CA" }, filters: { ships_to: { country: "CA" } }, pagination: { limit: LIMIT } };
  let catalogMode = "saved catalog_id";
  let r = await tool("search_catalog", saved);
  const refusedSaved = !r.ok || !r.json || r.json.error || r.json.result?.isError;
  if (anonymous && refusedSaved && r.status !== 429) {
    // The saved catalog did not answer without a token. Same filters, sent inline. Still one search for the data.
    await sleep(1500);
    catalogMode = "inline filters (saved catalog refused without a token)";
    r = await tool("search_catalog", { query: QUERY, context: { address_country: "CA" }, filters: INLINE_FILTERS, pagination: { limit: LIMIT } });
  }
  if (!r.ok || !r.json) {
    writeNotOk(NAME, SOURCE, r.status === 401 || r.status === 403 ? "refused" : "error", `search_catalog returned HTTP ${r.status}`);
    return;
  }
  if (r.json.error) {
    writeNotOk(NAME, SOURCE, "error", `search_catalog error ${r.json.error.code}: ${r.json.error.message}`);
    return;
  }
  const result = r.json.result || {};
  const sc = result.structuredContent;
  if (result.isError || !sc || !Array.isArray(sc.products)) {
    writeNotOk(NAME, SOURCE, "error", `search_catalog: ${plain(textOf(result) || "no products in the answer")}`);
    return;
  }

  // Full product records. A Shopify product groups the same item across sellers; each variant is one offer.
  // Used for the condition field and to find variant pricing anomalies. Throttled under 5 requests a second.
  const full = new Map();
  for (const p of sc.products) {
    await sleep(anonymous ? 1200 : 600);
    const g = await tool("get_product", { id: p.id, context: { address_country: "CA" } });
    const gp = g.json?.result?.structuredContent?.product;
    if (gp) full.set(p.id, gp);
  }

  // HomeGadgets references by model number. Snapshot first, then get_price {mpn} within the daily budget.
  const hg = readData("homegadgets");
  const refs = snapshotModels(hg);
  const missing = new Set();
  const usedBefore = hg?.lookups_used || 0;
  let lookups = 0;
  let hgClient = null;
  let budgetHit = false;
  async function reference(mpn) {
    if (!mpn) return null;
    if (refs.has(mpn)) return refs.get(mpn);
    if (missing.has(mpn)) return null;
    if (usedBefore + lookups >= HG_DAILY_LOOKUPS - 1) {
      budgetHit = true;
      return null;
    }
    if (!hgClient) {
      hgClient = mcpClient("https://mcp.homegadgets.ca/mcp", { userAgent: "MerchantLink-demo/0.1" });
      await hgClient.init("MerchantLink-demo");
    }
    lookups++;
    const { data } = await hgClient.tool("get_price", { identifier: { mpn }, location: "Toronto, ON" });
    if (data?.ok === false) {
      budgetHit = true;
      return null;
    }
    const best = data?.market?.price_split?.best_new || data?.market?.best;
    if (!data?.found || !best) {
      missing.add(mpn);
      return null;
    }
    const split = data.market.price_split || {};
    const ref = {
      mpn,
      source: "HomeGadgets get_price by MPN (Toronto)",
      hg_product_id: data.product?.product_id,
      hg_name: data.product?.name,
      hg_model: data.product?.model_number,
      best_new_price_cad: best.price_cad,
      retailer: best.retailer,
      retailer_count: data.market.retailer_count,
      observed_at: best.observed_at,
      condition_status: split.differs === false ? split.cheapest_any_condition?.condition_status || null : null,
    };
    refs.set(mpn, ref);
    return ref;
  }

  const captured = nowIso();
  let nonCad = 0;
  const offers = [];
  const anomalies = [];

  for (const p of sc.products) {
    const cad = (p.variants || []).filter((v) => v.price?.currency === "CAD" && Number.isFinite(Number(v.price?.amount)));
    if (!cad.length) {
      nonCad++;
      continue;
    }
    cad.sort((a, b) => Number(a.price.amount) - Number(b.price.amount));
    const v = cad[0];
    const title = String(v.title || p.title || "");
    const fullVariant = full.get(p.id)?.variants?.find((x) => x.id === v.id);
    const condition = fullVariant?.condition || v.condition || null;
    const brand = brandOf(title);
    const mpn = mpnOf(title);
    const offer = {
      product_id: p.id,
      variant_id: v.id,
      title,
      mpn,
      brand,
      merchant: v.seller?.name || null,
      seller_domain: v.seller?.domain || null,
      seller_url: v.seller?.url || null,
      price: cents(v.price.amount),
      currency: "CAD",
      product_url: v.url || fullVariant?.url || null,
      condition,
      captured_at: captured,
      reference: null,
      verified_reference: false,
      percent_of_reference: null,
      status: "eligible",
      excluded: false,
      reasons: [],
      reason: null,
    };
    const why = offer.reasons;

    if (!brand || !SIZE_RE.test(title) || !/oled/i.test(title)) why.push("Not a 65-inch Samsung or LG OLED TV by its title.");
    if (Array.isArray(condition) && condition.length && !condition.includes("new")) {
      why.push(`Not new: Shopify lists the condition as ${condition.join(", ")}.`);
    }
    const word = title.match(NOT_NEW_WORDS) || title.match(SHORT_WARRANTY);
    if (word) why.push(`Not new by its title ("${word[0].trim()}").`);
    const urlPath = decodeURIComponent(String(offer.product_url || "").split("?")[0]).replace(/[-_]/g, " ");
    const urlWord = urlPath.match(NOT_NEW_WORDS);
    if (!word && urlWord) why.push(`Not new: the seller's product link says "${urlWord[0]}".`);
    if (offer.price > MAX_PRICE) why.push(`Outlier: ${money(offer.price)} is above $50,000.`);

    const ref = await reference(mpn);
    if (ref) {
      offer.reference = ref;
      offer.verified_reference = true;
      const pct = Math.round((offer.price / ref.best_new_price_cad) * 100);
      offer.percent_of_reference = pct;
      if ((pct < 40 || pct > 250) && offer.price <= MAX_PRICE) {
        why.push(`Outlier: ${pct}% of the HomeGadgets best NEW price for ${mpn} (${money(ref.best_new_price_cad)}), outside 40% to 250%.`);
      } else if (offer.price < ref.best_new_price_cad * 0.95 && pct >= 40) {
        why.push("Below every verified new price for this model. Condition or seller not verified.");
      }
    }

    if (why.length) {
      offer.excluded = true;
      offer.status = "excluded";
      offer.reason = why[0];
    } else if (!ref) {
      offer.status = "no_reference";
      offer.reason = mpn
        ? `No verified reference: HomeGadgets does not carry ${mpn}${budgetHit && !missing.has(mpn) ? " or the daily lookup limit was reached" : ""}.`
        : "No verified reference: no model number in the title.";
    }
    offers.push(offer);

    // Variant pricing anomalies inside one product record.
    const fp = full.get(p.id);
    const fv = (fp?.variants || []).filter((x) => x.price?.currency === "CAD");
    if (fv.length >= 3) {
      const med = median(fv.map((x) => cents(x.price.amount)));
      const odd = fv.filter((x) => {
        const c = cents(x.price.amount);
        return c > med * 2.5 || c < med * 0.4;
      });
      if (odd.length) {
        const bySeller = new Map();
        for (const x of odd) {
          const s = x.seller?.name || "unnamed seller";
          if (!bySeller.has(s)) bySeller.set(s, []);
          bySeller.get(s).push({ variant_id: x.id, title: x.title, price: cents(x.price.amount) });
        }
        for (const [seller, variants] of bySeller) {
          const same = fv.filter((x) => (x.seller?.name || "unnamed seller") === seller);
          anomalies.push({
            product_id: p.id,
            title: fp.title,
            seller,
            variants_returned: fv.length,
            variants_from_seller: same.length,
            median_price: med,
            usual_price_from_seller: same.length > variants.length ? median(same.filter((x) => !odd.includes(x)).map((x) => cents(x.price.amount))) : null,
            odd_variants: variants,
            note: "Shopify returns at most 10 variants per product, so the seller may list more.",
          });
        }
      }
    }
  }

  offers.sort((a, b) => a.price - b.price);
  writeOk(NAME, SOURCE, {
    query: QUERY,
    hero: HERO.text,
    catalog_id: CATALOG_ID,
    auth_mode: anonymous ? "anonymous (no token, lower limits)" : "client credentials token",
    catalog_mode: catalogMode,
    agent_profile: PROFILE_URL,
    agent_profile_note: "Shopify's published example profile, used until MerchantLink publishes its own.",
    price_units: "Shopify returns integer cents. Prices here are dollars (amount / 100).",
    products_returned: sc.products.length,
    product_records_read: full.size,
    non_cad_dropped: nonCad,
    homegadgets_mpn_lookups: lookups,
    homegadgets_mpn_not_carried: [...missing],
    references: [...refs.values()].filter((x) => offers.some((o) => o.mpn === x.mpn)),
    offers,
    anomalies,
  });
});
