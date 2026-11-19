// Fail if any demo/data/*.json file holds something that looks like a secret.
// Prints only file names and the name of the rule that matched, never the matched text.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./lib.mjs";

const rules = [
  ["Stripe key prefix", /\b[sr]k_(test|live)_/],
  ["Shopify secret prefix", /shpss_/],
  ["PEM BEGIN line", /BEGIN/],
  ["JWT", /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/],
];

// Exact secret values and their parts, when the job has them.
const values = [];
const add = (label, v) => v && v.length >= 6 && values.push([label, v]);
const visa = process.env.VISA_SANDBOX_CREDENTIALS || "";
add("Visa username", visa.split(":")[0]);
add("Visa password", visa.split(":")[1]);
const shop = process.env.SHOPIFY_CATALOG_KEY || "";
add("Shopify client ID", shop.split(":")[0]);
add("Shopify client secret", shop.split(":").slice(1).join(":"));
add("Stripe key", process.env.STRIPE_TEST_SECRET_KEY);

let files = [];
try {
  files = readdirSync(DATA_DIR).filter((f) => f.endsWith(".json"));
} catch {
  files = [];
}
let bad = 0;
for (const f of files) {
  const text = readFileSync(join(DATA_DIR, f), "utf8");
  for (const [label, re] of rules) if (re.test(text)) (bad++, console.log(`FOUND ${label} in ${f}`));
  for (const [label, v] of values) if (text.includes(v)) (bad++, console.log(`FOUND ${label} in ${f}`));
}
console.log(`Scanned ${files.length} files, ${values.length} secret values and ${rules.length} patterns. ${bad ? "FAIL" : "Clean."}`);
process.exit(bad ? 1 : 0);
