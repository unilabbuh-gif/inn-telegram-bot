import http from "http";
import { URL } from "url";

const BOT_TOKEN = process.env.BOT_TOKEN;
const PORT = process.env.PORT || 10000;
const PUBLIC_URL = process.env.PUBLIC_URL; // например: https://inn-telegram-bot.onrender.com

const CHECKO_API_KEY = process.env.CHECKO_API_KEY || "";
const DADATA_TOKEN = process.env.DADATA_TOKEN || "";

// -------------------- helpers --------------------

function now() {
  return new Date().toISOString();
}

function isInn(text) {
  const s = (text || "").trim();
  return /^\d{10}$/.test(s) || /^\d{12}$/.test(s);
}

function json(res, status, obj) {
  const data = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
  });
  res.end(data);
}

function text(res, status, body) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(body);
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", (c) => (buf += c));
    req.on("end", () => resolve(buf));
    req.on("error", reject);
  });
}

// -------------------- Telegram API --------------------

const tgUrl = (method) => `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;

async function tgCall(method, payload) {
  if (!BOT_TOKEN) throw new Error("BOT_TOKEN is not set");

  const r = await fetch(tgUrl(method), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const data = await r.json().catch(() => ({}));
  if (!data.ok) {
    throw new Error(`Telegram ${method} failed: ${JSON.stringify(data)}`);
  }
  return data.result;
}

async function sendMessage(chatId, textMsg, opts = {}) {
  return tgCall("sendMessage", {
    chat_id: chatId,
    text: textMsg,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...opts,
  });
}

async function answerCallbackQuery(id, textMsg = "") {
  return tgCall("answerCallbackQuery", {
    callback_query_id: id,
    text: textMsg,
    show_alert: false,
  });
}

function mainMenu() {
  return {
    inline_keyboard: [
      [{ text: "🔎 Проверить ИНН (бесплатно)", callback_data: "CHECK_INN" }],
      [{ text: "💎 Тариф PRO (позже)", callback_data: "PRICING" }],
      [{ text: "ℹ️ Что я проверяю?", callback_data: "ABOUT" }],
      [{ text: "🆘 Поддержка", callback_data: "SUPPORT" }],
    ],
  };
}

// -------------------- Providers --------------------

async function checkoByInn(inn) {
  if (!CHECKO_API_KEY) {
    return { provider: "checko", ok: false, demo: true, message: "CHECKO_API_KEY не задан (демо)." };
  }

  const url = `https://api.checko.ru/v2/company?key=${encodeURIComponent(
    CHECKO_API_KEY
  )}&inn=${encodeURIComponent(inn)}`;

  const r = await fetch(url, { method: "GET" });
  const data = await r.json().catch(() => ({}));

  // У Checko бывают разные форматы; тут делаем “мягкое” чтение
  if (!r.ok) {
    return { provider: "checko", ok: false, error: `HTTP ${r.status}`, raw: data };
  }

  return { provider: "checko", ok: true, raw: data };
}

async function dadataByInn(inn) {
  if (!DADATA_TOKEN) {
    return { provider: "dadata", ok: false, demo: true, message: "DADATA_TOKEN не задан (демо)." };
  }

  // DaData Suggest Party
  const url = "https://suggestions.dadata.ru/suggestions/api/4_1/rs/findById/party";

  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Token ${DADATA_TOKEN}`, // <-- ВОТ ТУТ ВАЖНО!
      Accept: "application/json",
    },
    body: JSON.stringify({ query: inn }),
  });

  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    return { provider: "dadata", ok: false, error: `HTTP ${r.status}`, raw: data };
  }

  return { provider: "dadata", ok: true, raw: data };
}

function formatResult(inn, checko, dadata) {
  const lines = [];
  lines.push(`✅ <b>ИНН:</b> <code>${inn}</code>`);

  // DaData: часто удобно как “человеческое название”
  if (dadata?.ok && dadata?.raw?.suggestions?.length) {
    const s = dadata.raw.suggestions[0];
    const name = s?.value || "";
    const ogrn = s?.data?.ogrn || "";
    const status = s?.data?.state?.status || "";
    if (name) lines.push(`🏢 <b>Организация:</b> ${escapeHtml(name)}`);
    if (ogrn) lines.push(`🧾 <b>ОГРН:</b> <code>${ogrn}</code>`);
    if (status) lines.push(`📌 <b>Статус:</b> ${escapeHtml(status)}`);
  } else if (dadata?.demo) {
    lines.push(`ℹ️ DaData: демо (нет токена)`);
  } else if (dadata && !dadata.ok) {
    lines.push(`⚠️ DaData: ошибка (${escapeHtml(dadata.error || "неизвестно")})`);
  }

  // Checko: оставим пока “сыро” + признак успеха
  if (checko?.ok) {
    lines.push(`✅ Checko: данные получены`);
  } else if (checko?.demo) {
    lines.push(`ℹ️ Checko: демо (нет ключа)`);
  } else if (checko && !checko.ok) {
    lines.push(`⚠️ Checko: ошибка (${escapeHtml(checko.error || "неизвестно")})`);
  }

  lines.push("");
  lines.push("Хочешь — добавлю <b>PRO риск-баллы</b> (красные флаги, долги, банкротство, арбитраж) поверх этих источников.");

  return lines.join("\n");
}

function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

// -------------------- Bot logic --------------------

async function handleStart(chatId) {
  await sendMessage(
    chatId,
    "Привет! Пришли ИНН (10 или 12 цифр) — проверю по открытым источникам.\n\nИли жми кнопку ниже 👇",
    { reply_markup: mainMenu() }
  );
}

async function handleInn(chatId, inn) {
  await sendMessage(chatId, `⏳ Проверяю ИНН <code>${inn}</code>...`);

  const [checko, dadata] = await Promise.allSettled([checkoByInn(inn), dadataByInn(inn)]);

  const checkoVal = checko.status === "fulfilled" ? checko.value : { ok: false, error: checko.reason?.message || "checko fail" };
  const dadataVal = dadata.status === "fulfilled" ? dadata.value : { ok: false, error: dadata.reason?.message || "dadata fail" };

  const msg = formatResult(inn, checkoVal, dadataVal);
  await sendMessage(chatId, msg, { reply_markup: mainMenu() });
}

async function handleCallback(cb) {
  const chatId = cb.message?.chat?.id;
  const data = cb.data;
  await answerCallbackQuery(cb.id);

  if (!chatId) return;

  if (data === "CHECK_INN") {
    await sendMessage(chatId, "Ок. Пришли ИНН (10 или 12 цифр) одним сообщением.");
    return;
  }
  if (data === "PRICING") {
    await sendMessage(chatId, "💎 PRO сделаем позже. Сейчас задача — чтобы бесплатная проверка стабильно работала.");
    return;
  }
  if (data === "ABOUT") {
    await sendMessage(chatId, "Проверяю по открытым источникам (через API). Дальше добавим риск-баллы и красные флаги.");
    return;
  }
  if (data === "SUPPORT") {
    await sendMessage(chatId, "Поддержка: напиши сюда, что не так — я подскажу что починить 🙂");
    return;
  }
}

// -------------------- webhook setup --------------------

async function ensureWebhook() {
  if (!BOT_TOKEN) {
    console.log(`[${now()}] BOT_TOKEN missing, webhook setup skipped`);
    return;
  }
  if (!PUBLIC_URL) {
    console.log(`[${now()}] PUBLIC_URL missing, webhook setup skipped`);
    return;
  }

  const hook = `${PUBLIC_URL.replace(/\/+$/, "")}/webhook`;
  try {
    const r = await tgCall("setWebhook", { url: hook });
    console.log(`[${now()}] Webhook set: ${hook}`, r);
  } catch (e) {
    console.log(`[${now()}] Webhook set failed:`, e.message);
  }
}

// -------------------- server --------------------

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "GET" && u.pathname === "/health") {
      return json(res, 200, { ok: true });
    }

    if (req.method === "POST" && u.pathname === "/webhook") {
      const raw = await readBody(req);
      const update = raw ? JSON.parse(raw) : {};

      // message
      if (update.message?.chat?.id) {
        const chatId = update.message.chat.id;
        const textMsg = (update.message.text || "").trim();

        if (textMsg === "/start") {
          await handleStart(chatId);
        } else if (isInn(textMsg)) {
          await handleInn(chatId, textMsg);
        } else {
          await sendMessage(chatId, "Пришли ИНН (10 или 12 цифр) или нажми кнопку.", { reply_markup: mainMenu() });
        }
      }

      // callback_query
      if (update.callback_query) {
        await handleCallback(update.callback_query);
      }

      return json(res, 200, { ok: true });
    }

    return text(res, 404, "Not found");
  } catch (e) {
    console.log(`[${now()}] Server error:`, e);
    return json(res, 500, { ok: false, error: e.message });
  }
});

server.listen(PORT, async () => {
  console.log(`[${now()}] Server started on port ${PORT}`);
  await ensureWebhook();
});
