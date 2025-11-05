import express from "express";
import dotenv from "dotenv";
import Stripe from "stripe";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { isIP } from "node:net";

dotenv.config({ path: "./.env" });

// ---- Environment-driven config ----
const ENV = process.env.STRIPE_ENV || "test"; // "test" or "prod"

const STRIPE_SECRET_KEY =
  ENV === "prod"
    ? process.env.STRIPE_SECRET_KEY_PROD
    : process.env.STRIPE_SECRET_KEY_TEST;

if (!STRIPE_SECRET_KEY) {
  console.error(
    `Missing Stripe secret key for ${ENV} mode. Expected ${
      ENV === "prod" ? "STRIPE_SECRET_KEY_PROD" : "STRIPE_SECRET_KEY_TEST"
    } in environment settings (Azure App Service → Configuration).`
  );
  // Fail fast so Azure restarts after you set the key
  process.exit(1);
}

const STRIPE_LOCATION_ID =
  ENV === "prod"
    ? process.env.STRIPE_LOCATION_ID_PROD
    : process.env.STRIPE_LOCATION_ID_TEST;

const STRIPE_TERMINAL_ID = ENV === "prod" ? process.env.STRIPE_TERMINAL_ID_PROD : null;

const stripe = new Stripe(STRIPE_SECRET_KEY, {
  apiVersion: "2023-10-16",
});

console.log(`Stripe mode: ${ENV.toUpperCase()}`);
console.log(`Key: ${STRIPE_SECRET_KEY?.startsWith("sk_live") ? "LIVE" : "TEST"}`);
console.log(`Location: ${STRIPE_LOCATION_ID || "<none>"}`);
if (STRIPE_TERMINAL_ID) console.log(`📡 Reader: ${STRIPE_TERMINAL_ID}`);

const app = express();
app.set("trust proxy", 1);
app.use(cors());
app.use(express.json());
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// --- Debug request logger (logs method, path, headers, body) ---
app.use((req, res, next) => {
  console.log("📥 Incoming Request:");
  console.log("Method:", req.method);
  console.log("Path:", req.originalUrl);
  console.log("Headers:", req.headers);
  console.log("Body:", req.body);
  next();
});

// --- Client IP extractor (IPv4/IPv6, strips port, honors X-Forwarded-For) ---
function getClientIp(req) {
  const header = (req.headers["x-forwarded-for"] || req.ip || "").toString();
  let token = header.split(",")[0].trim();
  if (!token) token = "";

  // Strip IPv6 brackets if present
  if (token.startsWith("[") && token.includes("]")) {
    token = token.slice(1, token.indexOf("]"));
  }
  // If looks like host:port, strip the trailing :port (handle IPv6 without brackets by stripping the last :digits)
  const lastColon = token.lastIndexOf(":");
  if (lastColon !== -1 && /^\d+$/.test(token.slice(lastColon + 1))) {
    token = token.slice(0, lastColon);
  }
  // Normalize IPv4-mapped IPv6
  if (token.startsWith("::ffff:")) token = token.slice(7);

  // Validate; if invalid, fall back to remoteAddress with the same cleaning
  if (!isIP(token)) {
    let ra = (req.socket && req.socket.remoteAddress) || "";
    if (ra.startsWith("[")) {
      const end = ra.indexOf("]");
      if (end !== -1) ra = ra.slice(1, end);
    }
    const lc = ra.lastIndexOf(":");
    if (lc !== -1 && /^\d+$/.test(ra.slice(lc + 1))) ra = ra.slice(0, lc);
    if (ra.startsWith("::ffff:")) ra = ra.slice(7);
    if (isIP(ra)) return ra;
  }
  return token || "unknown";
}

// --- API key verification (supports POS_BACKEND_KEY or POS_BACKEND_KEYS) ---
const SINGLE_API_KEY = (process.env.POS_BACKEND_KEY || "").trim();
const MULTI_KEYS_RAW = (process.env.POS_BACKEND_KEYS || "");
const MULTI_KEYS = new Set(
  MULTI_KEYS_RAW
    .split(/[\n,\s,]+/)
    .map(s => s.trim())
    .filter(Boolean)
);

function hasValidKey(value) {
  if (!value) return false;
  if (SINGLE_API_KEY && value === SINGLE_API_KEY) return true;
  if (MULTI_KEYS.size > 0 && MULTI_KEYS.has(value)) return true;
  return false;
}

function authMiddleware(req, res, next) {
  if (!SINGLE_API_KEY && MULTI_KEYS.size === 0) {
    return res.status(500).json({ error: "Server not configured: missing POS_BACKEND_KEY or POS_BACKEND_KEYS" });
  }
  const presented = req.header("x-api-key") || req.header("x-device-key");
  if (!hasValidKey(presented)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  return next();
}

// Apply auth to all /api routes (health remains open)
app.use("/api", authMiddleware);

// --- Basic rate limiting for /api ---
const limiter = rateLimit({
  windowMs: 60 * 1000,
  limit: Number(process.env.RATE_LIMIT_PER_MINUTE || 60),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => getClientIp(req),
});
app.use("/api", limiter);

// --- Require Idempotency-Key for POSTs to /api ---
app.use("/api", (req, res, next) => {
  if (req.method.toUpperCase() === "POST") {
    const idem = req.header("Idempotency-Key");
    if (!idem) return res.status(400).json({ error: "Missing Idempotency-Key header" });
  }
  next();
});

app.use((req, res, next) => {
  const key = req.header("x-api-key") || req.header("x-device-key") || null;
  req.deviceKey = key;
  next();
});

app.post("/api/payments", async (req, res) => {
  console.log("💳 Creating PaymentIntent:", req.body);
  try {
    const { amount, currency, category, description, art_number } = req.body;

    if (!amount || !currency) {
      return res
        .status(400)
        .json({ error: "Amount and currency are required." });
    }

    const computedDescription = description || `OHP POS - ${category ?? "Unspecified"}`;

    const rawSuffix = (category || "POS").toString().toLowerCase();
    let suffix;
    if (rawSuffix.includes("concession")) suffix = "OHP CONCESSIONS";
    else if (rawSuffix.includes("merch")) suffix = "OHP MERCH";
    else if (rawSuffix.includes("art")) suffix = "OHP ART";
    else suffix = "OHP POS";
    // Stripe requires ≤22 chars
    suffix = suffix.slice(0, 22);

    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency,
      description: computedDescription,
      statement_descriptor_suffix: suffix,
      payment_method_types: ["card_present"],
      capture_method: "automatic",
      metadata: {
        ...(art_number != null ? { art_number: String(art_number) } : {}),
        device_key: req.deviceKey || "unknown"
      },
    });

    res.json({
      id: paymentIntent.id,
      status: paymentIntent.status,
    });
  } catch (err) {
    console.error("Error creating payment intent:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/terminal/connection_token", async (req, res) => {
  try {
    console.log("🔐 Terminal token requested by:", req.deviceKey || "unknown");
    const token = await stripe.terminal.connectionTokens.create();
    res.json({ secret: token.secret });
  } catch (err) {
    console.error("Error creating connection token:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/terminal/charge", async (req, res) => {
  console.log("Processing on reader:", req.body);
  try {
    const { payment_intent_id } = req.body;

    let readerId;
    if (ENV === "prod") {
      // Use configured physical reader in production
      if (!STRIPE_TERMINAL_ID) {
        return res.status(400).json({ error: "Missing STRIPE_TERMINAL_ID_PROD for production mode" });
      }
      readerId = STRIPE_TERMINAL_ID;
      console.log(`Using physical reader ${readerId}`);
    } else {
      // Create a simulated reader in test mode
      const reader = await stripe.terminal.readers.create({
        registration_code: "simulated-wpe",
        label: "Simulated POS",
        location: STRIPE_LOCATION_ID,
      });
      readerId = reader.id;
      console.log(`Created simulated reader ${readerId}`);
    }

    const processed = await stripe.terminal.readers.processPaymentIntent(
      readerId,
      { payment_intent: payment_intent_id },
      { idempotencyKey: `pi-process-${payment_intent_id}` }
    );

    // In test mode, optionally auto-present a card
    if (ENV !== "prod" && process.env.STRIPE_SIMULATE_CARD === "true") {
      const testCard = process.env.STRIPE_SIMULATE_CARD_NUMBER || "4242424242424242";
      try {
        await stripe.testHelpers.terminal.readers.presentPaymentMethod(readerId, {
          type: "card_present",
          card_present: { number: testCard },
        });
        console.log(`Simulated card ${testCard} on reader ${readerId}`);
      } catch (simErr) {
        console.error("Failed to simulate card:", simErr.message);
      }
    }

    res.json({ reader: processed });
  } catch (err) {
    console.error("Error processing payment:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/payment_intents/:id", async (req, res) => {
  try {
    const intent = await stripe.paymentIntents.retrieve(req.params.id, {
      expand: ["latest_charge"],
    });

    const lastErr = intent.last_payment_error
      ? {
          code: intent.last_payment_error.code || null,
          decline_code: intent.last_payment_error.decline_code || null,
          message: intent.last_payment_error.message || null,
          type: intent.last_payment_error.type || null,
        }
      : null;

    const lc = intent.latest_charge || null;
    const chargeFailureMessage = lc?.failure_message || null;
    const chargeFailureCode = lc?.failure_code || null;
    const outcome = lc?.outcome || null;
    const outcomeType = outcome?.type || null;
    const outcomeSellerMessage = outcome?.seller_message || null;

    const effectiveStatus = (intent.status === 'succeeded' || lc?.status === 'succeeded') ? 'succeeded' : intent.status;

    res.json({
      id: intent.id,
      status: intent.status,
      effective_status: effectiveStatus,
      last_payment_error: lastErr,
      latest_charge_status: lc?.status ?? null,
      latest_charge_failure_message: chargeFailureMessage,
      latest_charge_failure_code: chargeFailureCode,
      latest_charge_outcome_type: outcomeType,
      latest_charge_outcome_seller_message: outcomeSellerMessage,
    });
  } catch (err) {
    console.error("Error fetching PaymentIntent:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/health", (req, res) => {
  res.json({ ok: true, message: `Backend reachable (${ENV})` });
});

const PORT = process.env.PORT || 4242;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
