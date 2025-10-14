import express from "express";
import dotenv from "dotenv";
import Stripe from "stripe";
import cors from "cors";

dotenv.config({ path: "./.env" });
console.log(
  "Stripe key:",
  process.env.STRIPE_SECRET_KEY ? "Loaded ✅" : "Missing ❌"
);

const app = express();
app.use(cors());
app.use(express.json());

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2023-10-16",
});

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

    // Create a simulated reader (will persist in test mode)
    const reader = await stripe.terminal.readers.create({
      registration_code: "simulated-wpe",
      label: "Simulated POS",
      location: process.env.STRIPE_LOCATION_ID,
    });

    // Process the PaymentIntent on that simulated reader
    const processed = await stripe.terminal.readers.processPaymentIntent(
      reader.id,
      {
        payment_intent: payment_intent_id,
      }
    );

    res.json({
      reader: processed,
    });
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
  res.json({ ok: true, message: "Backend reachable" });
});

const PORT = process.env.PORT || 4242;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
