import express from "express";
import dotenv from "dotenv";
import Stripe from "stripe";
import cors from "cors";

dotenv.config({ path: "./.env" });

// ---- Environment-driven config ----
const ENV = process.env.STRIPE_ENV || "test"; // "test" or "prod"

const STRIPE_SECRET_KEY =
  ENV === "prod"
    ? process.env.STRIPE_SECRET_KEY_PROD
    : process.env.STRIPE_SECRET_KEY_TEST;

if (!STRIPE_SECRET_KEY) {
  console.error(
    `❌ Missing Stripe secret key for ${ENV} mode. Expected ${
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

console.log(`🧾 Stripe mode: ${ENV.toUpperCase()}`);
console.log(`🔑 Key: ${STRIPE_SECRET_KEY?.startsWith("sk_live") ? "LIVE" : "TEST"}`);
console.log(`📍 Location: ${STRIPE_LOCATION_ID || "<none>"}`);
if (STRIPE_TERMINAL_ID) console.log(`📡 Reader: ${STRIPE_TERMINAL_ID}`);

const app = express();
app.use(cors());
app.use(express.json());

app.post("/api/payments", async (req, res) => {
  console.log("💳 Creating PaymentIntent:", req.body);
  try {
    const { amount, currency, category } = req.body;

    if (!amount || !currency) {
      return res
        .status(400)
        .json({ error: "Amount and currency are required." });
    }

    // Build a short, bank-safe statement descriptor suffix
    const rawSuffix = (category || "POS").toString().toLowerCase();
    let suffix;
    if (rawSuffix.includes("concession")) suffix = "OHP CONCESSIONS";
    else if (rawSuffix.includes("merch")) suffix = "OHP MERCH";
    else suffix = "OHP POS";
    // Stripe requires ≤22 chars
    suffix = suffix.slice(0, 22);

    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency,
      description: `OHP POS - ${category ?? "Unspecified"}`,
      statement_descriptor_suffix: suffix,
      payment_method_types: ["card_present"],
      capture_method: "automatic",
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
    const token = await stripe.terminal.connectionTokens.create();
    res.json({ secret: token.secret });
  } catch (err) {
    console.error("Error creating connection token:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/terminal/charge", async (req, res) => {
  console.log("🧾 Processing on reader:", req.body);
  try {
    const { payment_intent_id } = req.body;

    let readerId;
    if (ENV === "prod") {
      // Use configured physical reader in production
      if (!STRIPE_TERMINAL_ID) {
        return res.status(400).json({ error: "Missing STRIPE_TERMINAL_ID_PROD for production mode" });
      }
      readerId = STRIPE_TERMINAL_ID;
      console.log(`📡 Using physical reader ${readerId}`);
    } else {
      // Create a simulated reader in test mode
      const reader = await stripe.terminal.readers.create({
        registration_code: "simulated-wpe",
        label: "Simulated POS",
        location: STRIPE_LOCATION_ID,
      });
      readerId = reader.id;
      console.log(`🧪 Created simulated reader ${readerId}`);
    }

    const processed = await stripe.terminal.readers.processPaymentIntent(readerId, {
      payment_intent: payment_intent_id,
    });

    // In test mode, optionally auto-present a card
    if (ENV !== "prod" && process.env.STRIPE_SIMULATE_CARD === "true") {
      const testCard = process.env.STRIPE_SIMULATE_CARD_NUMBER || "4242424242424242";
      try {
        await stripe.testHelpers.terminal.readers.presentPaymentMethod(readerId, {
          type: "card_present",
          card_present: { number: testCard },
        });
        console.log(`💳 Simulated card ${testCard} on reader ${readerId}`);
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
    const intent = await stripe.paymentIntents.retrieve(req.params.id);
    res.json({ id: intent.id, status: intent.status });
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
