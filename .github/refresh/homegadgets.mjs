// HomeGadgets MCP snapshot. Public, no key (D-027). One session, one User-Agent.
// Budget: 25 lookups a day per caller, 5 products per answer. This step uses at most 12.
import { HERO, LOCATIONS, mcpClient, runStep, writeOk, writeNotOk } from "./lib.mjs";

const NAME = "homegadgets";
const SOURCE = "HomeGadgets MCP, https://mcp.homegadgets.ca/mcp";
// 4 searches + 8 get_price = 12 of the 25 daily lookups. The Shopify step uses the rest for MPN matching.
const PRICE_LOOKUPS_PER_LOCATION = 4;

function refusedCode(data) {
  return data && data.ok === false ? data.error?.code || "refused" : null;
}

await runStep(NAME, SOURCE, async () => {
  const mcp = mcpClient("https://mcp.homegadgets.ca/mcp", { userAgent: "MerchantLink-demo/0.1" });
  await mcp.init("MerchantLink-demo");
  let lookups = 0;
  const locations = [];

  for (const loc of LOCATIONS) {
    const products = [];
    for (const brand of HERO.brands) {
      lookups++;
      const { data } = await mcp.tool("search_products", {
        query: "65 inch oled tv",
        location: loc.query_location,
        filters: { category: "tv", brand, specs: { size_in: HERO.size_in, panel: HERO.panel } },
      });
      const code = refusedCode(data);
      if (code) {
        writeNotOk(NAME, SOURCE, "refused", `search_products refused: ${code}. ${data.error?.message || ""}`.trim());
        return;
      }
      for (const r of data.results || []) {
        products.push({
          product_id: r.product_id,
          name: r.name,
          brand: r.brand,
          model_number: r.model_number,
          size_in: HERO.size_in,
          panel: HERO.panel,
          best_new_price_cad: r.best_price_condition === "new" ? r.best_cad_price : null,
          retailer: r.retailer,
          buy_link: r.buy_link,
          in_stock: r.in_stock,
          retailer_count: r.retailer_count,
          homegadgets_links: r.homegadgets_links,
          price_split_summary: null,
          condition_status: null,
          observed_at: null,
        });
      }
    }

    // Cheapest first, then confirm the top few with get_price for the price split and observed date.
    products.sort((a, b) => (a.best_new_price_cad ?? 1e12) - (b.best_new_price_cad ?? 1e12));
    for (const p of products.slice(0, PRICE_LOOKUPS_PER_LOCATION)) {
      lookups++;
      const { data } = await mcp.tool("get_price", { identifier: { product_id: p.product_id }, location: loc.query_location });
      if (refusedCode(data)) break;
      const best = data.market?.price_split?.best_new || data.market?.best;
      if (best) {
        p.best_new_price_cad = best.price_cad;
        p.retailer = best.retailer;
        p.buy_link = best.buy_link;
        p.in_stock = best.in_stock;
        p.observed_at = best.observed_at;
      }
      p.retailer_count = data.market?.retailer_count ?? p.retailer_count;
      p.price_split_summary = data.market?.price_split?.summary ?? null;
      // "assumed_new" means HomeGadgets did not see a condition on the retailer page.
      const split = data.market?.price_split;
      p.condition_status = split?.differs === false ? split.cheapest_any_condition?.condition_status ?? null : null;
    }
    products.sort((a, b) => (a.best_new_price_cad ?? 1e12) - (b.best_new_price_cad ?? 1e12));
    locations.push({ id: loc.id, city: loc.city, province: loc.province, products });
  }

  writeOk(NAME, SOURCE, {
    query: HERO.text,
    lookups_used: lookups,
    note: "Prices are the best NEW in-stock price per product. Average and highest prices are not stored.",
    locations,
  });
});
