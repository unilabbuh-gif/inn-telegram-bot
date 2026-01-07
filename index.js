import path from "path";
import express from "express";
import { createClient } from "@supabase/supabase-js";

/**
 * ENV
 */
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const APP_URL = process.env.APP_URL;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const DADATA_TOKEN = process.env.DADATA_TOKEN;
const ADMIN_IDS = (process.env.ADMIN_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const PORT = process.env.PORT || 3000;

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const app = express();
const __dirname = path.resolve();

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (_, res) => res.status(200).send("OK"));
app.get("/health", (_, res) => res.status(200).json({ ok: true }));

app.get("/app", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/**
 * Telegram helpers
 */
const tg = (method) => `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;

async function tgCall(method, payload) {
  const r = await fetch(tg(method), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await r.json();
  if (!data.ok) throw new Error(`${method} failed`);
  return data.result;
}

async function sendMessage(chatId, text, opts = {}) {
  return tgCall("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...opts,
  });
}

function mainMenu() {
  return {
    inline_keyboard: [
      [{ text: "🔎 Проверить ИНН (1 бесплатно)", callback_data: "CHECK_INN" }],
      [{ text: "💎 Тариф PRO", callback_data: "PRICING" }],
      [{ text: "🧾 Что я проверяю?", callback_data: "ABOUT" }],
      [{ text: "🆘 Поддержка", callback_data: "SUPPORT" }],
    ],
  };
}

function isInn(text) {
  return /^\d{10}$/.test(text) || /^\d{12}$/.test(text);
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * Webhook
 */
app.post("/webhook", async (req, res) => {
  const secret = req.header("X-Telegram-Bot-Api-Secret-Token");
  if (WEBHOOK_SECRET && secret !== WEBHOOK_SECRET) {
    return res.status(401).json({ ok: false });
  }

  res.status(200).json({ ok: true });

  try {
    const update = req.body;

    if (update?.message) {
      const msg = update.message;
      const chatId = msg.chat?.id;
      const from = msg.from;

      if (!chatId || !from) return;

      let text = "";

      if (msg.text) {
        text = msg.text.trim();
      } else if (msg.web_app_data?.data) {
        try {
          const payload = JSON.parse(msg.web_app_data.data);
          text = payload?.inn ? String(payload.inn) : String(msg.web_app_data.data);
        } catch {
          text = String(msg.web_app_data.data);
        }
      }

      if (text === "/start") {
        await sendMessage(
          chatId,
          "👋 Привет! Пришли ИНН (10 или 12 цифр)",
          { reply_markup: mainMenu() }
        );
        return;
      }

      if (isInn(text)) {
        await sendMessage(chatId, `ИНН получен: <code>${text}</code>`, {
          reply_markup: mainMenu(),
        });
        return;
      }

      await sendMessage(chatId, "Пришли ИНН (10 или 12 цифр)", {
        reply_markup: mainMenu(),
      });
    }
  } catch (e) {
    console.error("Webhook error:", e);
  }
});

/**
 * Auto webhook setup
 */
async function ensureWebhook() {
  if (!APP_URL || !BOT_TOKEN || !WEBHOOK_SECRET) return;

  const url = `${APP_URL.replace(/\/$/, "")}/webhook`;
  await tgCall("setWebhook", {
    url,
    secret_token: WEBHOOK_SECRET,
  });
}

app.listen(PORT, async () => {
  console.log("🚀 Server started on port", PORT);
  await ensureWebhook();
});
