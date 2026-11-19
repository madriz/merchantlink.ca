// Bank of Canada USD/CAD, latest observation, from the Valet API. Display only.
import { fetchJson, runStep, writeOk, writeNotOk } from "./lib.mjs";

const NAME = "fx";
const SOURCE = "Bank of Canada Valet API, FXUSDCAD";

await runStep(NAME, SOURCE, async () => {
  const r = await fetchJson("https://www.bankofcanada.ca/valet/observations/FXUSDCAD/json?recent=1", {
    headers: { "user-agent": "MerchantLink-demo/0.1", accept: "application/json" },
  });
  const obs = r.json?.observations?.[0];
  const value = obs ? Number(obs.FXUSDCAD?.v) : NaN;
  if (!r.ok || !obs || !Number.isFinite(value)) {
    writeNotOk(NAME, SOURCE, "error", `Valet API returned HTTP ${r.status} without a usable observation`);
    return;
  }
  writeOk(NAME, SOURCE, {
    series: "FXUSDCAD",
    date: obs.d,
    usd_cad: value,
    note: "1 USD in CAD. Display only. Prices are not converted for ranking.",
  });
});
