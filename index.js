/**
 * ProverkaBiz — Telegram bot (webhook) + Supabase + providers (DaData/Checko)
 * Node 18+ (fetch is global)
 */

import express from "express";
import { createClient } from "@supabase/supabase-js";

const {
  BOT_TOKEN,
  PUBLIC_URL, // например: https://inn-telegram-bot.onrender.com
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  DADATA_TOKEN,
  CHECKO_API_KEY,
  PORT,
} = process.env;

const APP_PORT = Number(PORT || 10000);
const WEBHOOK_PATH = "/webhook";
const FREE_DAILY_LIMIT = 3;

// --- Basic validation (чтобы не было "тихо умерло") ---
if (!BOT_TOKEN) {
  console.error("FATAL: BOT_TOKEN is required");
  process.exit(1);
}

const sb =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false },
      })
    : null;

const app = express();
app.use(express.json({ limit: "1mb" }));

// ---------------- Telegram API helpers ----------------
const tg = (method) => `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;

async function tgCall(method, payload) {
  const r = await fetch(tg(method), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await r.json();
  if (!data.ok) throw new Error(`${method} failed: ${JSON.stringify(data)}`);
  return data.result;
}

function mainMenu() {
  return {
    inline_keyboard: [
      [{ text: "🔎 Проверить ИНН", callback_data: "CHECK_INN" }],
      [{ text: "💎 Тариф PRO", callback_data: "PRICING" }],
      [{ text: "ℹ️ Что я проверяю?", callback_data: "ABOUT" }],
      [{ text: "🧰 Поддержка", callback_data: "SUPPORT" }],
    ],
  };
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

async function answerCb(callbackQueryId, text) {
  return tgCall("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text,
    show_alert: false,
  });
}

// ---------------- Utils ----------------
function isInn(text) {
  const s = String(text || "").trim();
  return /^\d{10}$/.test(s) || /^\d{12}$/.test(s);
}
function todayISO() {
  // Дневной лимит считаем по UTC-дате (стабильно на сервере)
  return new Date().toISOString().slice(0, 10);
}
function nowISO() {
  return new Date().toISOString();
}

// ---------------- Supabase layer ----------------
async function ensureUser(tgUser) {
  if (!sb) return null;

  const tg_user_id = tgUser.id;
  const tg_username = tgUser.username || null;
  const first_name = tgUser.first_name || null;
  const last_name = tgUser.last_name || null;

  const { data: existing, error: e1 } = await sb
    .from("bot_users")
    .select("*")
    .eq("tg_user_id", tg_user_id)
    .maybeSingle();

  if (e1) throw e1;

  if (existing) {
    // обновим имя/ник (без updated_at требований — оно есть в схеме, но нам не критично)
    const { error: e2 } = await sb
      .from("bot_users")
      .update({ tg_username, first_name, last_name, updated_at: nowISO() })
      .eq("tg_user_id", tg_user_id);
    if (e2) throw e2;
    return existing;
  }

  // Новый пользователь: план free, лимит 3/день
  const { data: created, error: e3 } = await sb
    .from("bot_users")
    .insert([
      {
        tg_user_id,
        tg_username,
        first_name,
        last_name,
        plan: "free",
        free_checks_left: FREE_DAILY_LIMIT,
        pro_until: null,
        updated_at: nowISO(),
      },
    ])
    .select("*")
    .single();

  if (e3) throw e3;
  return created;
}

async function getDailyUsed(tg_user_id) {
  if (!sb) return 0;
  const day = todayISO();

  const { data, error } = await sb
    .from("bot_quota_daily")
    .select("used")
    .eq("tg_user_id", tg_user_id)
    .eq("day", day)
    .maybeSingle();

  if (error) throw error;
  return data?.used || 0;
}

async function incDailyUsed(tg_user_id) {
  if (!sb) return;

  const day = todayISO();
  const used = (await getDailyUsed(tg_user_id)) + 1;

  const { error } = await sb
    .from("bot_quota_daily")
    .upsert([{ tg_user_id, day, used }], { onConflict: "tg_user_id,day" });

  if (error) throw error;
}

async function cacheGet(inn) {
  if (!sb) return null;
  const { data, error } = await sb.from("inn_cache").select("*").eq("inn", inn).maybeSingle();
  if (error) throw error;
  return data?.data || null;
}

async function cacheSet(inn, data) {
  if (!sb) return;
  const { error } = await sb.from("inn_cache").upsert(
    [{ inn, data, updated_at: nowISO() }],
    { onConflict: "inn" }
  );
  if (error) throw error;
}

async function logCheck({ tg_user_id, inn, provider, kind = "inn", result }) {
  if (!sb) return;
  const { error } = await sb.from("inn_checks").insert([
    { tg_user_id, inn, provider, kind, result: result || null },
  ]);
  if (error) throw error;
}

// ---------------- Providers ----------------
async function dadataFindPartyByInn(inn) {
  if (!DADATA_TOKEN) return { provider: "dadata", warning: "DADATA_TOKEN не задан" };

  const url = "https://suggestions.dadata.ru/suggestions/api/4_1/rs/findById/party";
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Token ${DADATA_TOKEN}`,
    },
    body: JSON.stringify({ query: inn }),
  });

  const data = await r.json().catch(() => ({}));
  if (!r.ok) return { provider: "dadata", error: true, status: r.status, data };

  const item = data?.suggestions?.[0] || null;
  return { provider: "dadata", item, raw: data };
}

async function checkoCompanyByInn(inn) {
  if (!CHECKO_API_KEY) return { provider: "checko", warning: "CHECKO_API_KEY не задан" };

  // API-форма встречается такая:
  // https://api.checko.ru/v2/company?key=API_KEY&inn=INN
  // Источник формата URL: :contentReference[oaicite:2]{index=2}
  const url =
    `https://api.checko.ru/v2/company?key=${encodeURIComponent(CHECKO_API_KEY)}` +
    `&inn=${encodeURIComponent(inn)}`;

  const r = await fetch(url, { method: "GET" });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) return { provider: "checko", error: true, status: r.status, data };

  return { provider: "checko", raw: data };
}

// ---------------- Formatters ----------------
function formatCompanyResult(inn, dadata, checko) {
  // Базу берём из DaData (обычно самая структурная по ЕГРЮЛ/ЕГРИП)
  const dd = dadata?.item?.data || null;

  const lines = [];
  lines.push(`🔎 <b>ИНН:</b> <code>${inn}</code>`);

  if (dd) {
    const name =
      dd.name?.full_with_opf || dd.name?.short_with_opf || dd.name?.full || dd.name?.short;
    const ogrn = dd.ogrn || dd.ogrnip;
    const kpp = dd.kpp;
    const status = dd.state?.status;
    const stateDate = dd.state?.actuality_date;

    if (name) lines.push(`🏢 <b>Организация:</b> ${escapeHtml(name)}`);
    if (ogrn) lines.push(`🆔 <b>ОГРН/ОГРНИП:</b> <code>${ogrn}</code>`);
    if (kpp) lines.push(`📎 <b>КПП:</b> <code>${kpp}</code>`);
    if (status) lines.push(`✅ <b>Статус:</b> ${escapeHtml(String(status))}`);
    if (stateDate) lines.push(`🗓 <b>Актуальность:</b> ${escapeHtml(String(stateDate))}`);

    const addr = dd.address?.value;
    if (addr) lines.push(`📍 <b>Адрес:</b> ${escapeHtml(addr)}`);

    const mgmt = dd.management?.name;
    if (mgmt) lines.push(`👤 <b>Руководитель:</b> ${escapeHtml(mgmt)}`);
  } else {
    lines.push(`⚠️ DaData: нет данных (или токен не задан).`);
  }

  // “PRO риск-баллы”: зависит от того, что реально отдаёт Checko по твоему ключу.
  // Пока просто покажем “есть/нет” и сохраняем сырой JSON в логах.
  if (checko?.error) {
    lines.push(`⚠️ Checko: ошибка ответа (status ${checko.status})`);
  } else if (checko?.warning) {
    lines.push(`ℹ️ Checko: ${escapeHtml(checko.warning)}`);
  } else if (checko?.raw) {
    lines.push(`💎 <b>PRO (Checko):</b> данные получены ✅`);
    lines.push(`(Риск-баллы покажем, когда подтвердим поле в ответе API)`);
  }

  return lines.join("\n");
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

// ---------------- Core flow ----------------
async function handleStart(chatId, from) {
  await ensureUser(from);
  await sendMessage(
    chatId,
    `Привет! Я проверяю контрагентов по ИНН.\n\nПришли ИНН (10 или 12 цифр) одним сообщением.\nЛимит free: ${FREE_DAILY_LIMIT} проверки в день.`,
    { reply_markup: mainMenu() }
  );
}

async function handleInn(chatId, from, inn) {
  const user = await ensureUser(from);

  // лимит: 3/день на free
  const used = await getDailyUsed(from.id);
  if (used >= FREE_DAILY_LIMIT) {
    await sendMessage(
      chatId,
      `⛔ Лимит на сегодня исчерпан: ${FREE_DAILY_LIMIT} проверок.\n\n💎 В PRO будет безлимит + риск-баллы + история.`,
      { reply_markup: mainMenu() }
    );
    return;
  }

  await sendMessage(chatId, `⏳ Проверяю ИНН <code>${inn}</code>...`);

  // 1) cache
  const cached = await cacheGet(inn);
  if (cached) {
    await incDailyUsed(from.id);
    await logCheck({ tg_user_id: from.id, inn, provider: "cache", result: cached });
    await sendMessage(chatId, `⚡️ Из кэша:\n\n${escapeHtml(JSON.stringify(cached)).slice(0, 3500)}`, {
      reply_markup: mainMenu(),
    });
    return;
  }

  // 2) providers
  const dadata = await dadataFindPartyByInn(inn);
  const checko = await checkoCompanyByInn(inn);

  const merged = { inn, dadata, checko, ts: nowISO() };
  await cacheSet(inn, merged);

  await incDailyUsed(from.id);
  await logCheck({ tg_user_id: from.id, inn, provider: "merged", result: merged });

  const text = formatCompanyResult(inn, dadata, checko);
  await sendMessage(chatId, text, { reply_markup: mainMenu() });
}

// ---------------- Webhook ----------------
app.get("/", (_req, res) => res.status(200).send("ok"));

app.post(WEBHOOK_PATH, async (req, res) => {
  try {
    const update = req.body;

    // callback buttons
    if (update.callback_query) {
      const cq = update.callback_query;
      const chatId = cq.message.chat.id;
      const data = cq.data;

      if (data === "CHECK_INN") {
        await answerCb(cq.id, "Пришли ИНН сообщением");
        await sendMessage(chatId, "Ок. Пришли ИНН (10 или 12 цифр) одним сообщением.", {
          reply_markup: mainMenu(),
        });
      } else if (data === "PRICING") {
        await answerCb(cq.id, "PRO — в разработке оплаты");
        await sendMessage(
          chatId,
          `💎 <b>PRO доступ</b>\n\nВ PRO будет:\n• безлимит проверок\n• риск-баллы по контрагенту\n• сохранение истории\n• выгрузка отчёта (PDF)\n\nПока подключение оплаты делаем. Напиши в поддержку — включу PRO вручную после оплаты.`,
          { reply_markup: mainMenu() }
        );
      } else if (data === "ABOUT") {
        await answerCb(cq.id, "Что проверяем");
        await sendMessage(
          chatId,
          `ℹ️ <b>Что проверяю</b>\n\n• карточка организации/ИП по ИНН\n• статус (действует/ликвидация — если есть в источнике)\n• адрес, руководитель\n• (в PRO) риск-индикаторы/флаги и история`,
          { reply_markup: mainMenu() }
        );
      } else if (data === "SUPPORT") {
        await answerCb(cq.id, "Поддержка");
        await sendMessage(
          chatId,
          `🧰 Поддержка\n\nНапиши сюда в чат, что нужно — я отвечу.\n(Позже подключим отдельный саппорт-канал)`,
          { reply_markup: mainMenu() }
        );
      } else {
        await answerCb(cq.id, "Ок");
      }

      return res.sendStatus(200);
    }

    // messages
    if (update.message) {
      const msg = update.message;
      const chatId = msg.chat.id;
      const from = msg.from;
      const text = (msg.text || "").trim();

      if (text === "/start") {
        await handleStart(chatId, from);
        return res.sendStatus(200);
      }

      if (isInn(text)) {
        await handleInn(chatId, from, text);
        return res.sendStatus(200);
      }

      // fallback
      await sendMessage(chatId, "Пришли ИНН (10 или 12 цифр) одним сообщением.", {
        reply_markup: mainMenu(),
      });
      return res.sendStatus(200);
    }

    res.sendStatus(200);
  } catch (e) {
    console.error("WEBHOOK_ERROR:", e);
    res.sendStatus(200);
  }
});

// ---------------- Boot ----------------
app.listen(APP_PORT, async () => {
  console.log(`Server started on port ${APP_PORT}`);
  if (PUBLIC_URL) {
    try {
      const webhookUrl = `${PUBLIC_URL}${WEBHOOK_PATH}`;
      await tgCall("setWebhook", { url: webhookUrl });
      console.log("Webhook set:", webhookUrl);
    } catch (e) {
      console.error("Webhook setup failed:", e);
    }
  } else {
    console.log("PUBLIC_URL missing, webhook setup skipped");
  }

  console.log("Supabase:", sb ? "enabled" : "disabled");
});
