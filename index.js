import path from "path";
import express from "express";
import { createClient } from "@supabase/supabase-js";

/**
 * ENV
 */
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const APP_URL = process.env.APP_URL; // https://xxxx.onrender.com
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const DADATA_TOKEN = process.env.DADATA_TOKEN; // optional
const CHECKO_API_KEY = process.env.CHECKO_API_KEY; // optional

const ADMIN_IDS = (process.env.ADMIN_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN) console.warn("⚠️ TELEGRAM_BOT_TOKEN is missing");
if (!APP_URL) console.warn("⚠️ APP_URL is missing");
if (!WEBHOOK_SECRET) console.warn("⚠️ WEBHOOK_SECRET is missing");
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.warn("⚠️ SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing");
}

const sb =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false },
      })
    : null;

const app = express();
const __dirname = path.resolve();

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json({ limit: "1mb" }));

app.get("/app", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/**
 * Health checks for Render
 */
app.get("/", (_, res) => res.status(200).send("OK"));
app.get("/healthz", (_, res) => res.status(200).json({ ok: true }));

/**
 * Telegram API helper
 */
const tg = (method) => https://api.telegram.org/bot${BOT_TOKEN}/${method};

async function tgCall(method, payload) {
  const r = await fetch(tg(method), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await r.json();
  if (!data.ok) throw new Error(${method} failed: ${JSON.stringify(data)});
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

// минимальный escape для HTML режима Телеграма
function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/**
 * User management (Supabase)
 */
async function upsertUser(from) {
  if (!sb) return { tg_user_id: from.id, plan: "free", pro_until: null, free_checks_left: 1 };

  const tg_user_id = from.id;
  const payload = {
    tg_user_id,
    tg_username: from.username || null,
    first_name: from.first_name || null,
    last_name: from.last_name || null,
    last_seen_at: nowIso(),
  };

  const { data, error } = await sb
    .from("bot_users")
    .upsert(payload, { onConflict: "tg_user_id" })
    .select("*")
    .single();

  if (error) throw error;
  // если у тебя free_checks_left может быть null при первом апсерте — подстрахуемся:
  if (data.free_checks_left == null) data.free_checks_left = 1;
  if (!data.plan) data.plan = "free";
  return data;
}

function isPro(user) {
  if (user.plan !== "pro") return false;
  if (!user.pro_until) return false;
  return new Date(user.pro_until).getTime() > Date.now();
}

async function consumeFreeCheckIfNeeded(user) {
  if (isPro(user)) return { allowed: true, reason: "pro", user };

Николай Брюханов, [07.01.2026 22:19]
const left = Number(user.free_checks_left || 0);
  if (left > 0) {
    if (!sb) return { allowed: true, reason: "free_used", user: { ...user, free_checks_left: left - 1 } };

    const { data, error } = await sb
      .from("bot_users")
      .update({ free_checks_left: left - 1 })
      .eq("tg_user_id", user.tg_user_id)
      .select("*")
      .single();

    if (error) throw error;
    return { allowed: true, reason: "free_used", user: data };
  }

  return { allowed: false, reason: "limit", user };
}

/**
 * Cache
 */
async function getInnFromCache(inn) {
  if (!sb) return null;
  const { data, error } = await sb.from("inn_cache").select("*").eq("inn", inn).single();
  if (error) return null;
  return data?.result || null;
}

async function saveInnToCache(inn, result) {
  if (!sb) return;
  await sb.from("inn_cache").upsert(
    { inn, result, updated_at: nowIso() },
    { onConflict: "inn" }
  );
}

/**
 * Providers
 */

// Checko provider
async function checkoCompanyByInn(inn) {
  if (!CHECKO_API_KEY) {
    return { warning: "CHECKO_API_KEY не задан. Checko отключён.", inn };
  }

  // GET: https://api.checko.ru/v2/company?key={API-ключ}&inn={ИНН}
  const url = https://api.checko.ru/v2/company?key=${encodeURIComponent(
    CHECKO_API_KEY
  )}&inn=${encodeURIComponent(inn)};

  const r = await fetch(url, { method: "GET" });
  const data = await r.json();

  // Checko обычно отдаёт { data: {...} } или { error: {...} }
  if (!r.ok || data?.error) {
    return {
      not_found: true,
      inn,
      source_error: data?.error || data,
    };
  }

  if (!data?.data) {
    return { not_found: true, inn };
  }

  return { provider: "checko", raw: data };
}

// DaData provider (fallback)
async function dadataFindByInn(inn) {
  if (!DADATA_TOKEN) {
    return { warning: "DADATA_TOKEN не задан. Сейчас демо-режим.", inn };
  }

  const r = await fetch(
    "https://suggestions.dadata.ru/suggestions/api/4_1/rs/findById/party",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: Token ${DADATA_TOKEN},
      },
      body: JSON.stringify({ query: inn }),
    }
  );

  const data = await r.json();
  const first = data?.suggestions?.[0];
  if (!first) return { not_found: true, inn };
  return { provider: "dadata", raw: first };
}

/**
 * Risk scoring (PRO)
 * Мы не “выдумываем” риск-балл из воздуха: показываем флаги, которые реально пришли.
 * Если Checko отдал список факторов риска — выводим их.
 */
function extractRiskFlags(providerResult) {
  // ожидаем checko: { provider:"checko", raw:{data:{...}} }
  if (providerResult?.provider !== "checko") return [];

  const d = providerResult.raw?.data || {};
  // В API Checko есть "проверка факторов риска" (внутри /company). 3
  // Конкретные поля могут быть разными, поэтому делаем “поиском” по типовым ключам:
  const candidates = [];

  // Популярные варианты именования (не гарантируется):
  // - d.ФакторыРиска (массив/объект)
  // - d.Риски / d.Risks
  // - d.Флаги / d.Flags
  for (const key of ["ФакторыРиска", "Риски", "Флаги", "Risks", "Flags", "risk", "risks"]) {
    if (d[key]) candidates.push({ key, value: d[key] });
  }

  const flags = [];
  for (const c of candidates) {
    if (Array.isArray(c.value)) {
      for (const item of c.value) flags.push(String(item));
    } else if (typeof c.value === "object") {
      // если объект, попробуем вытянуть “истинные” флаги
      for (const [k, v] of Object.entries(c.value)) {
        if (v === true) flags.push(k);
        if (typeof v === "string" && v.length < 120) flags.push(${k}: ${v});
      }
    } else {
      flags.push(${c.key}: ${String(c.value)});
    }
  }

  // Дедуп
  return [...new Set(flags)].filter(Boolean).slice(0, 12);
}

function formatResult(inn, providerResult, proMode) {
  if (providerResult?.not_found) {
    return ❌ <b>ИНН ${inn}</b>\nНичего не найдено. Проверь цифры и попробуй снова.;
  }

Николай Брюханов, [07.01.2026 22:19]
if (providerResult?.warning) {
    return ⚠️ <b>ИНН ${inn}</b>\n${escapeHtml(providerResult.warning)}\n\nСейчас могу только принимать ИНН и считать лимиты.\nДальше подключим реальные источники.;
  }

  // CHECKO
  if (providerResult?.provider === "checko") {
    const d = providerResult.raw?.data || {};
    const name = d["НаимСокр"]  d["НаимПолн"]  "—";
    const status = d?.["Статус"]?.["Наим"] || "—";
    const okved = d?.["ОКВЭД"]?.["Код"]
      ? ${d["ОКВЭД"]["Код"]} — ${d["ОКВЭД"]["Наим"] || ""}.trim()
      : "—";
    const address = d?.["ЮрАдрес"]?.["АдресРФ"] || "—";

    const lines = [
      ✅ <b>Проверка по ИНН:</b> <code>${inn}</code>,
      ``,
      🏢 <b>Организация:</b> ${escapeHtml(name)},
      📌 <b>Статус:</b> ${escapeHtml(status)},
      🧩 <b>ОКВЭД:</b> ${escapeHtml(okved)},
      📍 <b>Адрес:</b> ${escapeHtml(address)},
    ];

    if (proMode) {
      const flags = extractRiskFlags(providerResult);
      lines.push(``, 💎 <b>PRO: риск-флаги</b>);
      if (flags.length === 0) {
        lines.push(— нет явных флагов в ответе источника (или поле не пришло).);
      } else {
        for (const f of flags) lines.push(• ${escapeHtml(f)});
      }
    } else {
      lines.push(
        ``,
        💡 <i>Хочешь “риск-скоринг” (флаги, реестры, связи)? Это будет в PRO.</i>
      );
    }

    return lines.join("\n");
  }

  // DADATA
  if (providerResult?.provider === "dadata") {
    const raw = providerResult.raw || {};
    const d = raw.data || {};
    const name = d.name?.short_with_opf  d.name?.full_with_opf  raw.value || "—";
    const status = d.state?.status || "—";
    const okved = d.okved || "—";
    const address = d.address?.value || "—";

    return [
      ✅ <b>Проверка по ИНН:</b> <code>${inn}</code>,
      ``,
      🏢 <b>Организация:</b> ${escapeHtml(name)},
      📌 <b>Статус:</b> ${escapeHtml(status)},
      🧩 <b>ОКВЭД:</b> ${escapeHtml(okved)},
      📍 <b>Адрес:</b> ${escapeHtml(address)},
      ``,
      💡 <i>Для риск-флагов лучше подключить Checko API.</i>,
    ].join("\n");
  }

  // неизвестно что пришло
  return ✅ <b>ИНН:</b> <code>${inn}</code>\nПолучены данные, но формат пока не распознан.;
}

/**
 * Paywall texts
 */
function paywallText() {
  return [
    💎 <b>PRO доступ</b>,
    ``,
    Ты уже использовал бесплатную проверку.,
    В PRO будет:,
    • безлимит проверок,
    • “красные флаги” по контрагенту,
    • сохранение истории,
    • выгрузка отчёта (PDF),
    ``,
    Пока подключение оплаты делаем. Напиши в поддержку — включу PRO вручную после оплаты.,
  ].join("\n");
}

/**
 * Admin: grant pro
 * /grant <tg_user_id> <days>
 */
async function handleAdminCommand(text, chatId) {
  if (!sb) return false;

  const parts = text.trim().split(/\s+/);
  if (parts[0] !== "/grant") return false;

  const tgUserId = Number(parts[1]);
  const days = Number(parts[2] || 30);

  if (!tgUserId || !days) {
    await sendMessage(chatId, "Формат: <code>/grant 123456789 30</code>");
    return true;
  }

  const proUntil = new Date(Date.now() + days * 24 * 3600 * 1000).toISOString();

  const { error } = await sb
    .from("bot_users")
    .update({ plan: "pro", pro_until: proUntil })
    .eq("tg_user_id", tgUserId);

  if (error) {
    await sendMessage(chatId, Ошибка: ${escapeHtml(error.message)});
    return true;
  }

  await sendMessage(chatId, ✅ Выдал PRO пользователю <code>${tgUserId}</code> на ${days} дней.);
  return true;
}

/**
 * Webhook endpoint
 */
app.post("/webhook", async (req, res) => {
  const secret = req.header("X-Telegram-Bot-Api-Secret-Token");
  if (WEBHOOK_SECRET && secret !== WEBHOOK_SECRET) {
    return res.status(401).json({ ok: false });
  }

  res.status(200).json({ ok: true });

  try {
    const update = req.body;
    if (!update) return;

    // callback кнопки
    if (update.callback_query) {
      const cq = update.callback_query;
      const chatId = cq.message?.chat?.id;
      const from = cq.from;
      const data = cq.data;

Николай Брюханов, [07.01.2026 22:19]
if (!chatId || !from) return;
      await upsertUser(from);

      if (data === "CHECK_INN") {
        await sendMessage(chatId, Пришли ИНН (10 или 12 цифр)., {
          reply_markup: mainMenu(),
        });
        return;
      }

      if (data === "PRICING") {
        await sendMessage(chatId, paywallText(), { reply_markup: mainMenu() });
        return;
      }

      if (data === "ABOUT") {
        await sendMessage(
          chatId,
          [
            🧾 <b>Что я проверяю по ИНН</b>,
            ``,
            • название и статус,
            • адрес,
            • ОКВЭД,
            • (в PRO) риск-флаги/проверки/связи (через источники),
            ``,
            Отправь ИНН — покажу.,
          ].join("\n"),
          { reply_markup: mainMenu() }
        );
        return;
      }

      if (data === "SUPPORT") {
        await sendMessage(
          chatId,
          🆘 Поддержка: напиши сюда и приложи ИНН/скрин, если что-то не так.,
          { reply_markup: mainMenu() }
        );
        return;
      }
    }

    // обычные сообщения
    if (update.message) {
      const msg = update.message;
      const chatId = msg.chat?.id;
      const from = msg.from;

      if (!chatId || !from) return;

      const user = await upsertUser(from);

      // вытаскиваем текст/данные
      let text = (msg.text || "").trim();

      // если прилетело из Telegram WebApp
      if (!text && msg.web_app_data?.data) {
        try {
          const payload = JSON.parse(msg.web_app_data.data);
          if (payload?.type === "inn_check" && payload?.inn) {
            text = String(payload.inn).trim();
          } else {
            text = String(msg.web_app_data.data).trim();
          }
        } catch {
          text = String(msg.web_app_data.data).trim();
        }
      }

      // admin команды
      if (ADMIN_IDS.includes(String(from.id)) && text.startsWith("/grant")) {
        const handled = await handleAdminCommand(text, chatId);
        if (handled) return;
      }

      if (text === "/start") {
        await sendMessage(
          chatId,
          [
            👋 Привет! Я бот для проверки контрагентов по ИНН.,
            ``,
            ✅ 1 проверка бесплатно.,
            💎 В PRO — риск-флаги и расширенная проверка.,
            ``,
            Нажми кнопку или просто пришли ИНН.,
          ].join("\n"),
          { reply_markup: mainMenu() }
        );
        return;
      }

      if (!text) return;

      if (isInn(text)) {
        const gate = await consumeFreeCheckIfNeeded(user);
        if (!gate.allowed) {
          await sendMessage(chatId, paywallText(), { reply_markup: mainMenu() });
          return;
        }

        const inn = text;
        const proMode = isPro(gate.user);

        // cache -> provider
        let providerResult = await getInnFromCache(inn);
        let source = "cache";

        if (!providerResult) {
          // 1) Checko если есть ключ
          if (CHECKO_API_KEY) {
            providerResult = await checkoCompanyByInn(inn);
            source = "checko";
          } else {
            // 2) DaData fallback
            providerResult = await dadataFindByInn(inn);
            source = "dadata";
          }

          // кэшируем только если это не warning
          if (!providerResult?.warning) {
            await saveInnToCache(inn, providerResult);
          }
        }

        // лог запроса
        if (sb) {
          await sb.from("inn_checks").insert({
            tg_user_id: gate.user.tg_user_id,
            inn,
            source,
            ok: true,
            result: providerResult,
          });
        }

        await sendMessage(chatId, formatResult(inn, providerResult, proMode), {
          reply_markup: mainMenu(),
        });
        return;
      }

      await sendMessage(
        chatId,
        Не понял сообщение.\nПришли ИНН (10 или 12 цифр) или нажми кнопку.,
        { reply_markup: mainMenu() }
      );
    }
  } catch (e) {
    console.error("Webhook error:", e);
  }
});

Николай Брюханов, [07.01.2026 22:19]
/**
 * Auto set webhook on startup (Render)
 */
async function ensureWebhook() {
  if (!APP_URL  !WEBHOOK_SECRET  !BOT_TOKEN) return;
  const url = ${APP_URL.replace(/\/$/, "")}/webhook;

  try {
    await tgCall("setWebhook", {
      url,
      secret_token: WEBHOOK_SECRET,
      drop_pending_updates: false,
    });
    console.log("✅ Webhook set:", url);
  } catch (e) {
    console.error("❌ setWebhook failed:", e?.message || e);
  }
}

app.listen(PORT, async () => {
  console.log("Server started on port", PORT);
  await ensureWebhook();
});
