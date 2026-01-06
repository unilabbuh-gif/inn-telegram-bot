import express from "express";
import { createClient } from "@supabase/supabase-js";

const app = express();

// Telegram присылает JSON
app.use(express.json({ limit: "1mb" }));

// --- ENV ---
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Replit / Deploy обычно задаёт PORT сам
const PORT = process.env.PORT || 3000;

// --- Guards ---
if (!BOT_TOKEN) console.warn("⚠️ TELEGRAM_BOT_TOKEN is missing");
if (!SUPABASE_URL) console.warn("⚠️ SUPABASE_URL is missing");
if (!SUPABASE_KEY) console.warn("⚠️ SUPABASE_SERVICE_ROLE_KEY is missing");

// --- Supabase client (server-side) ---
const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
});

// --- Helpers ---
const tgApi = (method) => `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;

function isInn(text) {
  const t = (text || "").trim();
  return /^\d{10}$/.test(t) || /^\d{12}$/.test(t);
}

async function tgSendMessage(chatId, text, replyMarkup) {
  const body = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  };
  if (replyMarkup) body.reply_markup = replyMarkup;

  const r = await fetch(tgApi("sendMessage"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  // Не падаем, но логируем
  if (!r.ok) {
    const errText = await r.text().catch(() => "");
    console.error("Telegram sendMessage failed:", r.status, errText);
  }
}

function mainMenu() {
  return {
    inline_keyboard: [
      [{ text: "🔎 Проверить ИНН (1 бесплатно)", callback_data: "CHECK" }],
      [{ text: "⭐ Подписка (скоро)", callback_data: "SUB" }],
    ],
  };
}

async function upsertUser(telegramUserId) {
  const { data, error } = await sb
    .from("subscriptions")
    .upsert(
      {
        telegram_user_id: String(telegramUserId),
      },
      { onConflict: "telegram_user_id" }
    )
    .select()
    .single();

  if (error) {
    // Если upsert/select не вернул single (редко) — попробуем прочитать
    const { data: readData, error: readErr } = await sb
      .from("subscriptions")
      .select("*")
      .eq("telegram_user_id", String(telegramUserId))
      .maybeSingle();

    if (readErr) throw readErr;
    return readData;
  }

  return data;
}

function isPaidActive(row) {
  // paid_until: timestamptz или null
  if (!row?.paid_until) return false;
  const paidUntil = new Date(row.paid_until).getTime();
  return Number.isFinite(paidUntil) && paidUntil > Date.now();
}

async function canUseCheck(telegramUserId) {
  const row = await upsertUser(telegramUserId);

  const paid = isPaidActive(row);
  const used = Number(row?.free_checks_used || 0);

  // 1 бесплатная проверка
  if (paid) return { allowed: true, reason: "paid", row };
  if (used < 1) return { allowed: true, reason: "free", row };

  return { allowed: false, reason: "limit", row };
}

async function markFreeCheckUsed(telegramUserId) {
  // Инкремент free_checks_used на 1
  const { error } = await sb
    .from("subscriptions")
    .update({ free_checks_used: sb.rpc ? undefined : undefined }) // заглушка для совместимости
    .eq("telegram_user_id", String(telegramUserId));

  // В Supabase-js нет прямого "increment" без RPC — делаем через read+update
  if (error) {
    // если апдейт не прошёл — попробуем read+update
    const { data: row, error: readErr } = await sb
      .from("subscriptions")
      .select("free_checks_used")
      .eq("telegram_user_id", String(telegramUserId))
      .maybeSingle();

    if (readErr) throw readErr;

    const nextVal = Number(row?.free_checks_used || 0) + 1;
    const { error: updErr } = await sb
      .from("subscriptions")
      .update({ free_checks_used: nextVal, status: "inactive" })
      .eq("telegram_user_id", String(telegramUserId));

    if (updErr) throw updErr;
    return;
  }
}

// Заглушка “проверки ИНН”
async function fakeInnCheck(inn) {
  // Тут потом подключишь реальные источники
  return `✅ ИНН: <b>${inn}</b>\n\n(пока демо-ответ)\nДальше подключим реальные источники.`;
}

// --- HEALTH ENDPOINTS (важно для Replit Deploy) ---
app.get("/", (req, res) => res.status(200).send("OK"));
app.get("/health", (req, res) => res.status(200).json({ ok: true }));

// --- Telegram Webhook ---
app.post("/webhook", async (req, res) => {
  try {
    // Telegram может прислать message или callback_query
    const update = req.body;

    // Сразу отвечаем 200, чтобы не фейлились health-check/тайминги Telegram
    res.status(200).json({ ok: true });

    if (!update) return;

    // Callback кнопки
    if (update.callback_query) {
      const cq = update.callback_query;
      const chatId = cq.message?.chat?.id;
      const userId = cq.from?.id;
      const data = cq.data;

      if (!chatId || !userId) return;

      if (data === "CHECK") {
        await tgSendMessage(
          chatId,
          "Пришли ИНН (10 или 12 цифр).",
          mainMenu()
        );
        return;
      }

      if (data === "SUB") {
        await tgSendMessage(
          chatId,
          "Подписка скоро появится 🙂\nПока доступна 1 бесплатная проверка.",
          mainMenu()
        );
        return;
      }

      return;
    }

    // Обычное сообщение
    if (update.message) {
      const msg = update.message;
      const chatId = msg.chat?.id;
      const userId = msg.from?.id;
      const text = (msg.text || "").trim();

      if (!chatId || !userId) return;

      if (text === "/start") {
        await upsertUser(userId);
        await tgSendMessage(
          chatId,
          "Привет! Я бот для проверки ИНН.\n\nНажми кнопку или просто пришли ИНН.",
          mainMenu()
        );
        return;
      }

      if (!text) {
        await tgSendMessage(chatId, "Пришли ИНН текстом.", mainMenu());
        return;
      }

      // Если прислали ИНН
      if (isInn(text)) {
        const access = await canUseCheck(userId);

        if (!access.allowed) {
          await tgSendMessage(
            chatId,
            "Лимит бесплатных проверок исчерпан.\nПодписку подключим чуть позже 🙂",
            mainMenu()
          );
          return;
        }

        // Если это бесплатная попытка — списываем 1
        if (access.reason === "free") {
          await markFreeCheckUsed(userId);
        }

        const result = await fakeInnCheck(text);
        await tgSendMessage(chatId, result, mainMenu());
        return;
      }

      await tgSendMessage(
        chatId,
        "Не похоже на ИНН.\nНужно 10 или 12 цифр.",
        mainMenu()
      );
      return;
    }
  } catch (e) {
    console.error("Webhook error:", e);
    // Если мы уже ответили 200 выше — просто лог
  }
});

// --- Start server ---
app.listen(PORT, () => {
  console.log("Server started on port", PORT);
});
