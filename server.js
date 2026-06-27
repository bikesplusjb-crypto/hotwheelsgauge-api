/* ===============================
   COMICGAUGE
   AI SCANNER + EBAY COMIC MARKET BACKEND
   server.js — v1.5 (scan + comps + hot comics auto-board)
   Mirrors the CardGauge stock-card-api pattern.
================================ */

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fetch = require("node-fetch");

const app = express();

app.use(cors());
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
});

/* ───────────────────────────────────────────────
   ENV / CONFIG
   Set these in the Render dashboard (NOT in GitHub):
     EBAY_CLIENT_ID        eBay app Client ID (Browse API)
     EBAY_CLIENT_SECRET    eBay app Client Secret
     VISION_API_KEY        vision provider key (same one CardGauge scanner uses)
     REFRESH_SECRET        guards the hot-board refresh endpoint
─────────────────────────────────────────────── */
const EPN_CAMPAIGN_ID = "5339149252";          // your eBay Partner Network campid
const EPN_MKRID       = "711-53200-19255-0";   // US rotation id

const EBAY_CLIENT_ID     = process.env.EBAY_CLIENT_ID || "";
const EBAY_CLIENT_SECRET = process.env.EBAY_CLIENT_SECRET || "";
const VISION_API_KEY     = process.env.VISION_API_KEY || "";
const REFRESH_SECRET     = process.env.REFRESH_SECRET || "";

// eBay Comics category (Collectibles > Comics). 63 = Comics root.
const EBAY_COMICS_CATEGORY = "63";

/* ───────────────────────────────────────────────
   AFFILIATE URL BUILDERS
   We never store eBay sold prices. We deep-link users to eBay's
   own sold-comps view with the EPN tag attached. Fully compliant.
─────────────────────────────────────────────── */
function ebaySearchUrl(query, sold) {
  const base = "https://www.ebay.com/sch/i.html";
  const q = encodeURIComponent(query);
  const soldParams = sold ? "&LH_Sold=1&LH_Complete=1" : "";
  return `${base}?_nkw=${q}${soldParams}&_sacat=${EBAY_COMICS_CATEGORY}` +
    `&mkcid=1&mkrid=${EPN_MKRID}&siteid=0&campid=${EPN_CAMPAIGN_ID}&toolid=10001&mkevt=1`;
}

function addAffiliate(url) {
  if (!url) return "";
  try {
    const u = new URL(url);
    u.searchParams.set("mkcid", "1");
    u.searchParams.set("mkrid", EPN_MKRID);
    u.searchParams.set("siteid", "0");
    u.searchParams.set("campid", EPN_CAMPAIGN_ID);
    u.searchParams.set("toolid", "10001");
    u.searchParams.set("mkevt", "1");
    return u.toString();
  } catch (e) {
    const sep = url.includes("?") ? "&" : "?";
    return `${url}${sep}campid=${EPN_CAMPAIGN_ID}&mkevt=1`;
  }
}

/* ───────────────────────────────────────────────
   COMIC QUERY NORMALIZER
   Comics key on: title + issue # + (optional) grade.
   e.g. "amazing spiderman 300" -> "Amazing Spider-Man #300"
   Keeps grade (CGC 9.8) if present so comps stay tight.
─────────────────────────────────────────────── */
function normalizeComicQuery(raw) {
  if (!raw) return "";
  let q = String(raw).trim().replace(/\s+/g, " ");

  // Pull a grade if present (CGC/CBCS 9.8 etc.) to re-append cleanly.
  let grade = "";
  const gradeMatch = q.match(/\b(cgc|cbcs|pgx)\s*\.?\s*(\d{1,2}(?:\.\d)?)\b/i);
  if (gradeMatch) {
    grade = `${gradeMatch[1].toUpperCase()} ${gradeMatch[2]}`;
    q = q.replace(gradeMatch[0], "").trim();
  }

  // Normalize common title spellings.
  q = q
    .replace(/\bspider\s*-?\s*man\b/gi, "Spider-Man")
    .replace(/\bx\s*-?\s*men\b/gi, "X-Men")
    .replace(/\bfantastic\s*4\b/gi, "Fantastic Four");

  // Ensure issue number has a # if a bare trailing number exists.
  q = q.replace(/\b(\d{1,4})\b(?!\s*(cgc|cbcs|pgx))/i, (m, n, _g, offset, full) => {
    // only prefix # if it looks like an issue number (not a year)
    if (/^(19|20)\d{2}$/.test(n)) return n;
    return `#${n}`;
  });

  const out = grade ? `${q} ${grade}` : q;
  return out.replace(/\s+/g, " ").trim();
}

/* ───────────────────────────────────────────────
   EBAY BROWSE API — live ACTIVE listings only
   (sold data is gated; we link out for sold comps)
─────────────────────────────────────────────── */
let cachedToken = null;
let tokenExpiry = 0;

async function getEbayToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  if (!EBAY_CLIENT_ID || !EBAY_CLIENT_SECRET) {
    throw new Error("Missing EBAY_CLIENT_ID / EBAY_CLIENT_SECRET env vars");
  }
  const creds = Buffer.from(`${EBAY_CLIENT_ID}:${EBAY_CLIENT_SECRET}`).toString("base64");
  const resp = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${creds}`,
    },
    body: "grant_type=client_credentials&scope=https://api.ebay.com/oauth/api_scope",
  });
  const data = await resp.json();
  if (!data.access_token) throw new Error("eBay token request failed");
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken;
}

async function fetchActiveMarket(query) {
  const cleanQuery = normalizeComicQuery(query);
  const token = await getEbayToken();

  const url =
    "https://api.ebay.com/buy/browse/v1/item_summary/search" +
    `?q=${encodeURIComponent(cleanQuery)}` +
    `&category_ids=${EBAY_COMICS_CATEGORY}` +
    "&filter=buyingOptions:{FIXED_PRICE}" +
    "&limit=20";

  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
    },
  });
  const data = await resp.json();

  const items = (data.itemSummaries || []).map((it) => ({
    title: it.title,
    price: it.price ? Number(it.price.value) : null,
    currency: it.price ? it.price.currency : "USD",
    condition: it.condition || "",
    image: it.image ? it.image.imageUrl : "",
    url: addAffiliate(it.itemWebUrl),
  })).filter((it) => it.price != null);

  const prices = items.map((i) => i.price).sort((a, b) => a - b);
  const avg = prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : null;

  return {
    cleanQuery,
    avgPrice: avg ? Math.round(avg * 100) / 100 : null,
    lowPrice: prices.length ? prices[0] : null,
    highPrice: prices.length ? prices[prices.length - 1] : null,
    listingCount: items.length,
    image: items[0] ? items[0].image : "",
    listings: items.slice(0, 8),
    priceSource: "ebay_active",
  };
}

/* ───────────────────────────────────────────────
   VISION SCAN — identify a comic from a cover photo.
   Returns a normalized search string the market endpoint can use.
   Provider call is left generic; reads VISION_API_KEY from env.
─────────────────────────────────────────────── */
async function identifyComicFromImage(base64Image) {
  if (!VISION_API_KEY) {
    throw new Error("Missing VISION_API_KEY env var");
  }
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${VISION_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                "Identify this comic book from its cover. Respond with ONLY a search " +
                "string in the format: Title #Issue (e.g. 'Amazing Spider-Man #300'). " +
                "If you can read a CGC/CBCS grade on a slab label, append it " +
                "(e.g. 'Amazing Spider-Man #300 CGC 9.8'). No other text.",
            },
            {
              type: "image_url",
              image_url: { url: `data:image/jpeg;base64,${base64Image}` },
            },
          ],
        },
      ],
      max_tokens: 60,
    }),
  });
  const data = await resp.json();
  const text = data.choices?.[0]?.message?.content?.trim() || "";
  return text;
}

/* ───────────────────────────────────────────────
   HOT COMICS auto-board watchlist
   Seed list of key issues. The board re-pulls LIVE active ranges
   on each load and re-ranks by live listing volume (a legal signal).
   v2: move this to Supabase + scheduled re-rank job.
─────────────────────────────────────────────── */
const HOT_COMICS_SEED = [
  "Amazing Spider-Man #300",
  "Incredible Hulk #181",
  "Giant-Size X-Men #1",
  "New Mutants #98",
  "House of M #1",
  "Ultimate Fallout #4",
  "Batman Adventures #12",
  "Edge of Spider-Verse #2",
  "Venom #1 Lethal Protector",
  "Saga #1",
  "Walking Dead #1",
  "Daredevil #1 2024",
];

let hotBoardCache = { ts: 0, items: [] };
const HOT_CACHE_MS = 15 * 60 * 1000; // 15 min soft cache

async function buildHotBoard() {
  const results = [];
  for (const title of HOT_COMICS_SEED) {
    try {
      const m = await fetchActiveMarket(title);
      results.push({
        title,
        avgPrice: m.avgPrice,
        lowPrice: m.lowPrice,
        highPrice: m.highPrice,
        listingCount: m.listingCount,
        image: m.image,
        soldCompsUrl: ebaySearchUrl(title, true),
        listingsUrl: ebaySearchUrl(title, false),
      });
    } catch (e) {
      // skip a book that errors; board still renders
    }
  }
  // Re-rank by live listing volume (legal Browse signal = market activity).
  results.sort((a, b) => (b.listingCount || 0) - (a.listingCount || 0));
  return results;
}

/* ───────────────────────────────────────────────
   ROUTES
─────────────────────────────────────────────── */

// Image scan -> identify -> market
app.post("/api/scan", upload.single("image"), async (req, res) => {
  try {
    let base64;
    if (req.file) {
      base64 = req.file.buffer.toString("base64");
    } else if (req.body.image) {
      base64 = req.body.image.replace(/^data:image\/\w+;base64,/, "");
    } else {
      return res.status(400).json({ success: false, error: "No image provided" });
    }

    const identified = await identifyComicFromImage(base64);
    if (!identified) {
      return res.json({ success: false, error: "Could not identify the comic. Try the search lookup instead." });
    }

    const market = await fetchActiveMarket(identified);
    return res.json({
      success: true,
      identified,
      query: market.cleanQuery,
      note: "Active eBay listings shown. Tap Sold Comps for completed-sale prices on eBay.",
      avgPrice: market.avgPrice,
      lowPrice: market.lowPrice,
      highPrice: market.highPrice,
      listingCount: market.listingCount,
      image: market.image,
      priceSource: market.priceSource,
      listings: market.listings,
      soldCompsUrl: ebaySearchUrl(market.cleanQuery, true),
      activeListingsUrl: ebaySearchUrl(market.cleanQuery, false),
      affiliate: { campid: EPN_CAMPAIGN_ID, active: true },
      timestamp: Date.now(),
    });
  } catch (error) {
    console.error("Scan error:", error);
    return res.status(500).json({ success: false, error: "Scan failed", details: error.message });
  }
});

// Text/search lookup -> market
app.get("/api/market", async (req, res) => {
  try {
    const query = req.query.q;
    if (!query) return res.status(400).json({ success: false, error: "Missing q param" });

    const market = await fetchActiveMarket(query);
    return res.json({
      success: true,
      query: market.cleanQuery,
      note: "Active eBay listings shown. Tap Sold Comps for completed-sale prices on eBay.",
      avgPrice: market.avgPrice,
      lowPrice: market.lowPrice,
      highPrice: market.highPrice,
      listingCount: market.listingCount,
      image: market.image,
      priceSource: market.priceSource,
      listings: market.listings,
      soldCompsUrl: ebaySearchUrl(market.cleanQuery, true),
      activeListingsUrl: ebaySearchUrl(market.cleanQuery, false),
      affiliate: { campid: EPN_CAMPAIGN_ID, active: true },
      timestamp: Date.now(),
    });
  } catch (error) {
    console.error("Market error:", error);
    return res.status(500).json({ success: false, error: "Market lookup failed", details: error.message });
  }
});

// Hot Comics auto-board (re-pulls live ranges, re-ranks by activity)
app.get("/api/hot-comics", async (req, res) => {
  try {
    if (Date.now() - hotBoardCache.ts < HOT_CACHE_MS && hotBoardCache.items.length) {
      return res.json({ success: true, cached: true, items: hotBoardCache.items, timestamp: hotBoardCache.ts });
    }
    const items = await buildHotBoard();
    hotBoardCache = { ts: Date.now(), items };
    return res.json({ success: true, cached: false, items, timestamp: hotBoardCache.ts });
  } catch (error) {
    console.error("Hot board error:", error);
    return res.status(500).json({ success: false, error: "Hot board failed", details: error.message });
  }
});

// Force-refresh the hot board (guarded). v1.5 stand-in for a scheduled re-rank.
app.post("/api/hot-comics/refresh", async (req, res) => {
  const secret = req.headers["x-refresh-secret"];
  if (!REFRESH_SECRET || secret !== REFRESH_SECRET) {
    return res.status(403).json({ success: false, error: "Forbidden" });
  }
  try {
    const items = await buildHotBoard();
    hotBoardCache = { ts: Date.now(), items };
    return res.json({ success: true, refreshed: true, count: items.length, timestamp: hotBoardCache.ts });
  } catch (error) {
    return res.status(500).json({ success: false, error: "Refresh failed", details: error.message });
  }
});

// Affiliate sanity check
app.get("/api/affiliate-test", (req, res) => {
  const testQuery = "Amazing Spider-Man #300 CGC 9.8";
  res.json({
    success: true,
    message: "ComicGauge eBay affiliate tracking is active",
    campid: EPN_CAMPAIGN_ID,
    sampleActiveUrl: ebaySearchUrl(testQuery, false),
    sampleSoldUrl: ebaySearchUrl(testQuery, true),
  });
});

app.get("/api/health", (req, res) => res.json({ ok: true, service: "comicgauge-api" }));

// Serve the static frontend
app.use(express.static("public"));

app.use((req, res) => {
  res.status(404).json({ success: false, error: "Endpoint not found" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ComicGauge backend running on port ${PORT}`);
  console.log(`eBay EPN campid: ${EPN_CAMPAIGN_ID}`);
});
