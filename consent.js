// Cookie banner and Consent Mode v2 update for merchantlink.ca (D-035).
// The consent default (all denied) and the GTM loader are inline in each page's <head>.
// GTM itself loads only after consent, so nothing reaches Google before Accept.
// This file shows the banner when no choice is stored, records Accept or Decline,
// and reopens the banner from any element with data-cookie-settings.
// Accept grants analytics_storage only. Ads stay denied.
(function () {
  var KEY = "ml_cookie_consent";
  var root = document.documentElement;
  var privacyHref = root.getAttribute("data-privacy-href") || "/privacy.html";

  function stored() {
    try {
      return localStorage.getItem(KEY);
    } catch (e) {
      return null;
    }
  }

  function gtag() {
    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push(arguments);
  }

  function choose(choice) {
    try {
      localStorage.setItem(KEY, choice);
    } catch (e) {
      // Storage blocked: the choice still applies to this page view.
    }
    root.setAttribute("data-ml-consent", choice);
    gtag("consent", "update", { analytics_storage: choice === "accepted" ? "granted" : "denied" });
    window.dataLayer.push({ event: "cookie_consent_update", cookie_consent: choice });
    if (choice === "accepted" && window.mlLoadGTM) window.mlLoadGTM();
    if (choice === "declined") clearAnalyticsCookies();
    hide();
  }

  // A visitor who accepted earlier and now declines: remove the GA4 cookies already set.
  function clearAnalyticsCookies() {
    var host = location.hostname;
    var domains = ["", host, "." + host, "." + host.replace(/^www\./, "")];
    document.cookie.split(";").forEach(function (c) {
      var name = c.split("=")[0].trim();
      if (!/^_ga/.test(name)) return;
      domains.forEach(function (d) {
        document.cookie = name + "=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/" + (d ? "; domain=" + d : "");
      });
    });
  }

  var banner = null;

  // EN/FR text for the banner. French follows the browser language unless the visitor picks one.
  var TEXT = {
    en: { msg: "We use cookies to see how visitors use this site. No ads, no selling of data.", privacy: "Privacy", decline: "Decline", accept: "Accept", label: "Cookie choice", other: "FR", otherLabel: "Afficher en fran\u00e7ais" },
    fr: { msg: "Nous utilisons des t\u00e9moins pour comprendre comment les visiteurs utilisent ce site. Aucune publicit\u00e9, aucune vente de donn\u00e9es.", privacy: "Confidentialit\u00e9", decline: "Refuser", accept: "Accepter", label: "Choix des t\u00e9moins", other: "EN", otherLabel: "Show in English" }
  };
  function lang() {
    try {
      var l = localStorage.getItem("ml_lang");
      if (l === "en" || l === "fr") return l;
    } catch (e) {}
    return /^fr/i.test(navigator.language || "") ? "fr" : "en";
  }
  function render() {
    var t = TEXT[lang()];
    banner.setAttribute("aria-label", t.label);
    banner.querySelector(".mlc-msg").textContent = t.msg + " ";
    banner.querySelector(".mlc-privacy").textContent = t.privacy;
    banner.querySelector(".mlc-decline").textContent = t.decline;
    banner.querySelector(".mlc-accept").textContent = t.accept;
    var b = banner.querySelector(".mlc-lang");
    b.textContent = t.other;
    b.setAttribute("aria-label", t.otherLabel);
    banner.setAttribute("lang", lang());
  }

  function build() {
    banner = document.createElement("div");
    banner.id = "ml-cookie-banner";
    banner.setAttribute("role", "region");
    banner.innerHTML =
      '<p class="mlc-text"><span class="mlc-msg"></span><a class="mlc-privacy" href="' + privacyHref + '"></a></p>' +
      '<div class="mlc-actions">' +
      '<button type="button" class="mlc-lang"></button>' +
      '<button type="button" class="mlc-decline"></button>' +
      '<button type="button" class="mlc-accept"></button>' +
      "</div>";
    var css = document.createElement("style");
    css.textContent =
      "#ml-cookie-banner[hidden]{display:none!important}" +
      "#ml-cookie-banner{position:fixed;left:16px;right:16px;bottom:16px;z-index:1000;max-width:880px;margin:0 auto;" +
      "display:flex;flex-wrap:wrap;align-items:center;gap:12px 20px;padding:14px 18px;background:#121826;color:#b8c0cf;" +
      "border:1px solid #2d3a52;border-radius:6px;box-shadow:0 8px 24px rgba(0,0,0,.4);" +
      "font:14px/1.5 'IBM Plex Sans',system-ui,sans-serif}" +
      "#ml-cookie-banner .mlc-text{flex:1 1 320px;margin:0}" +
      "#ml-cookie-banner a{color:#f97316}" +
      "#ml-cookie-banner .mlc-actions{display:flex;gap:10px;flex:0 0 auto}" +
      "#ml-cookie-banner button{font:inherit;font-weight:600;padding:8px 18px;border-radius:4px;cursor:pointer}" +
      "#ml-cookie-banner .mlc-decline{background:transparent;color:#e6e9ef;border:1px solid #8592a8}" +
      "#ml-cookie-banner .mlc-accept{background:#f97316;color:#0a0d12;border:1px solid #f97316}" +
      "#ml-cookie-banner .mlc-lang{background:transparent;color:#8592a8;border:1px solid #2d3a52;padding:8px 12px}" +
      "#ml-cookie-banner button:focus-visible,#ml-cookie-banner a:focus-visible{outline:2px solid #fdba74;outline-offset:2px}" +
      "@media (max-width:480px){#ml-cookie-banner{left:8px;right:8px;bottom:8px}#ml-cookie-banner .mlc-actions{width:100%}" +
      "#ml-cookie-banner .mlc-decline,#ml-cookie-banner .mlc-accept{flex:1}}";
    document.head.appendChild(css);
    banner.querySelector(".mlc-lang").addEventListener("click", function () {
      try { localStorage.setItem("ml_lang", lang() === "fr" ? "en" : "fr"); } catch (e) {}
      render();
    });
    banner.querySelector(".mlc-accept").addEventListener("click", function () {
      choose("accepted");
    });
    banner.querySelector(".mlc-decline").addEventListener("click", function () {
      choose("declined");
    });
    banner.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && stored()) hide();
    });
    document.body.appendChild(banner);
    render();
  }

  function show(focus) {
    if (!banner) build();
    banner.hidden = false;
    if (focus) banner.querySelector(".mlc-accept").focus();
  }

  function hide() {
    if (banner) banner.hidden = true;
  }

  // "Cookie settings" links and buttons, including ones added later by the demo.
  document.addEventListener("click", function (e) {
    var t = e.target.closest && e.target.closest("[data-cookie-settings]");
    if (!t) return;
    e.preventDefault();
    show(true);
  });

  // Demo screens use hash routes. Tell GTM about each one, after consent only.
  if (root.hasAttribute("data-hash-page-views")) {
    window.addEventListener("hashchange", function () {
      if (stored() !== "accepted") return;
      window.dataLayer.push({
        event: "demo_page_view",
        page_location: location.href,
        page_path: location.pathname + location.hash,
        page_title: document.title,
      });
    });
  }

  if (!stored()) {
    if (document.body) show(false);
    else document.addEventListener("DOMContentLoaded", function () { show(false); });
  }
})();
