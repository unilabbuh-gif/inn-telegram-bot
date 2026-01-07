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

const DADATA_TOKEN = process.env.DADATA_TOKEN; // optional (реальные данные)
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

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const app = express();
const __dirname = path.resolve();

app.use(express.json({ limit: "1mb" }));

// Static webapp
app.use(express.static(path.join(__dirname, "public")));
app.get("/app", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/**
 * Health checks for Render
 * Render иногда стучится в /health
 */
app.get("/", (_, res) => res.status(200).send("OK"));
app.get("/health", (_, res) => res.status(200).json({ ok: true }));
app.get("/healthz", (_, res) => res.status(200).json({ ok: true }));

/**
 * Telegram API helper
 */
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
 * User management
 */
async function upsertUser(from) {
  const tg_user_id = from.id;
  const payload = {
    tg_user_id,
    tg_username: from.username || null,
    first_name: from.first_name || null,
    last_name: from.last_name || null,
    last_seen_at: nowIso(),
  };

  // upsert by unique tg_user_id
  const { data, error } = await sb
    .from("bot_users")
    .upsert(payload, { onConflict: "tg_user_id" })
    .select("*")
    .single();

  if (error) throw error;
  return data;
}

function isPro(user) {
  if (user.plan !== "pro") return false;
  if (!user.pro_until) return false;
  return new Date(user.pro_until).getTime() > Date.now();
}

async function consumeFreeCheckIfNeeded(user) {
  if (isPro(user)) return { allowed: true, reason: "pro" };

  if (user.free_checks_left > 0) {
    const { data, error } = await sb
      .from("bot_users")
      .update({ free_checks_left: user.free_checks_left - 1 })
      .eq("tg_user_id", user.tg_user_id)
      .select("*")
      .single();
    if (error) throw error;
    return { allowed: true, reason: "free_used", user: data };
  }

  return { allowed: false, reason: "limit" };
}

/**
 * INN lookup (cache -> DaData)
 */
async function getInnFromCache(inn) {
  const { data, error } = await sb
    .from("inn_cache")
    .select("*")
    .eq("inn", inn)
    .single();

  if (error) return null;
  return data?.result || null;
}

async function saveInnToCache(inn, result) {
  await sb.from("inn_cache").upsert(
    { inn, result, updated_at: nowIso() },
    { onConflict: "inn" }
  );
}

async function dadataFindByInn(inn) {
  if (!DADATA_TOKEN) {
    // мягкий режим: без источника, чтобы бот не падал
    return {
      warning: "DADATA_TOKEN не задан. Сейчас демо-режим.",
      inn,
    };
  }

  // DaData "findById/party"
  const r = await fetch(
    "https://suggestions.dadata.ru/suggestions/api/4_1/rs/findById/party",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Token ${DADATA_TOKEN}`,
      },
      body: JSON.stringify({ query: inn }),
    }
  );

  const data = await r.json();
  const first = data?.suggestions?.[0];
  if (!first) return { not_found: true, inn };

  return first; // богатый объект: value, data, etc
}

// минимальный escape для HTML режима Телеграма
function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/**
 * ===== PRO RISK SCORING (0..100) =====
 * 0 = хорошо, 100 = плохо
 */
function monthsBetween(dateIso) {
  const d = new Date(dateIso);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  return (now.getFullYear() - d.getFullYear()) * 12 + (now.getMonth() - d.getMonth());
}

function addFlag(flags, points, title, details = "") {
  flags.push({ points, title, details });
  return points;
}

function scoreRiskFromDaData(result) {
  const flags = [];
  let score = 0;

  const d = result?.data || {};
  const status = d.state?.status || ""; // ACTIVE / LIQUIDATING / LIQUIDATED etc
  const type = d.type || ""; // LEGAL / INDIVIDUAL (обычно)
  const capital = d.capital?.value ?? null;

  // 1) Статус
  if (status && status !== "ACTIVE") {
    score += addFlag(flags, 45, "Статус не ACTIVE", `Текущий статус: ${status}`);
  }

  // 2) Возраст (подстрахуемся: дата бывает числом/строкой)
  let regDateIso = null;
  const regRaw = d.state?.registration_date || d.state?.reg_date || null;
  if (regRaw) {
    regDateIso = typeof regRaw === "number" ? new Date(regRaw).toISOString() : String(regRaw);
  }

  const ageMonths = regDateIso ? monthsBetween(regDateIso) : null;
  if (ageMonths !== null) {
    if (ageMonths < 3) score += addFlag(flags, 20, "Компания младше 3 месяцев", `Возраст: ~${ageMonths} мес.`);
    else if (ageMonths < 6) score += addFlag(flags, 12, "Компания младше 6 месяцев", `Возраст: ~${ageMonths} мес.`);
    else if (ageMonths < 12) score += addFlag(flags, 6, "Компания младше 12 месяцев", `Возраст: ~${ageMonths} мес.`);
  } else {
    score += addFlag(flags, 5, "Не удалось определить дату регистрации");
  }

  // 3) Руководитель (для ЮЛ)
  const mgrName = d.management?.name || "";
  if (type === "LEGAL" && !mgrName) {
    score += addFlag(flags, 10, "Нет данных о руководителе");
  }

  // 4) Адрес
  const address = d.address?.value || "";
  if (!address) {
    score += addFlag(flags, 12, "Нет юридического адреса");
  }

  // 5) Уставный капитал (мягко)
  if (capital !== null && typeof capital === "number") {
    if (capital <= 10000) score += addFlag(flags, 3, "Минимальный уставный капитал", `Капитал: ${capital} ₽`);
  }

  // 6) ИП/физлицо — инфо, без штрафа
  if (type === "INDIVIDUAL") {
    flags.push({
      points: 0,
      title: "Это ИП/физлицо",
      details: "Скоринг рисков для ИП ограничен без доп. источников",
    });
  }

  // Clamp
  score = Math.max(0, Math.min(100, score));

  let level = "низкий";
  if (score >= 60) level = "высокий";
  else if (score >= 30) level = "средний";

  return {
    score,
    level,
    flags: flags.sort((a, b) => b.points - a.points),
  };
}

function formatRiskBlock(risk) {
  const header = `📊 <b>Риск-скоринг:</b> <b>${risk.score}/100</b> (${escapeHtml(risk.level)} риск)`;
  const topFlags = risk.flags
    .filter((f) => f.points > 0)
    .slice(0, 6)
    .map((f) => `• +${f.points} — ${escapeHtml(f.title)}${f.details ? ` <i>(${escapeHtml(f.details)})</i>` : ""}`)
    .join("\n");

  if (!topFlags) return `${header}\n• Существенных красных флагов по этим данным не найдено.`;

  return `${header}\n${topFlags}`;
}

/**
 * Result formatting (FREE vs PRO)
 */
function formatResult(inn, result, showRisk = false) {
  if (result?.not_found) {
    return `❌ <b>ИНН ${inn}</b>\nНичего не найдено. Проверь цифры и попробуй снова.`;
  }

  if (result?.warning) {
    return `⚠️ <b>ИНН ${inn}</b>\n${result.warning}\n\nСейчас могу только принимать ИНН и считать лимиты.\nДальше подключим реальные источники.`;
  }

  const d = result.data || {};
  const name = d.name?.short_with_opf || d.name?.full_with_opf || result.value || "—";
  const status = d.state?.status || "—";
  const okved = d.okved || "—";
  const address = d.address?.value || "—";
  const ogrn = d.ogrn || "—";
  const kpp = d.kpp || "—";
  const mgr = d.management?.name || "—";

  let riskText = "";
  if (showRisk) {
    const risk = scoreRiskFromDaData(result);
    riskText = `\n\n${formatRiskBlock(risk)}\n\n💡 <i>Суды/ФССП/банкротства добавим следующим источником.</i>`;
  } else {
    riskText = `\n\n💎 <i>В PRO появится риск-скоринг 0–100 и “красные флаги”.</i>`;
  }

  return [
    `✅ <b>Проверка по ИНН:</b> <code>${inn}</code>`,
    ``,
    `🏢 <b>Организация:</b> ${escapeHtml(name)}`,
    `📌 <b>Статус:</b> ${escapeHtml(status)}`,
    `🧾 <b>ОГРН:</b> ${escapeHtml(ogrn)}`,
    `🏷 <b>КПП:</b> ${escapeHtml(kpp)}`,
    `👤 <b>Руководитель:</b> ${escapeHtml(mgr)}`,
    `🧩 <b>ОКВЭД:</b> ${escapeHtml(okved)}`,
    `📍 <b>Адрес:</b> ${escapeHtml(address)}`,
    riskText,
  ].join("\n");
}

/**
 * Paywall texts
 */
function paywallText() {
  return [
    `💎 <b>PRO доступ</b>`,
    ``,
    `Ты уже использовал бесплатную проверку.`,
    `В PRO будет:`,
    `• безлимит проверок`,
    `• “красные флаги” по контрагенту`,
    `• сохранение истории`,
    `• выгрузка отчёта (PDF)`,
    ``,
    `Пока подключение оплаты делаем. Напиши в поддержку — включу PRO вручную после оплаты.`,
  ].join("\n");
}

/**
 * Admin: grant pro
 * /grant <tg_user_id> <days>
 */
async function handleAdminCommand(text, chatId) {
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
    await sendMessage(chatId, `Ошибка: ${escapeHtml(error.message)}`);
    return true;
  }

  await sendMessage(chatId, `✅ Выдал PRO пользователю <code>${tgUserId}</code> на ${days} дней.`);
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

      if (!chatId || !from) return;
      await upsertUser(from);

      if (data === "CHECK_INN") {
        await sendMessage(chatId, `Пришли ИНН (10 или 12 цифр).`, {
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
            `🧾 <b>Что я проверяю по ИНН</b>`,
            ``,
            `• название и статус`,
            `• адрес`,
            `• ОКВЭД`,
            `• (дальше) риски и флаги`,
            ``,
            `Отправь ИНН — покажу.`,
          ].join("\n"),
          { reply_markup: mainMenu() }
        );
        return;
      }

      if (data === "SUPPORT") {
        await sendMessage(
          chatId,
          `🆘 Поддержка: напиши сюда и приложи ИНН/скрин, если что-то не так.\n\n(Позже подключим авто-тикеты)`,
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

      // ЕДИНЫЙ текст: из msg.text или из web_app_data
      let text = "";
      if (typeof msg.text === "string") {
        text = msg.text.trim();
      } else if (msg.web_app_data?.data) {
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
            `👋 Привет! Я бот для проверки контрагентов по ИНН.`,
            ``,
            `✅ 1 проверка бесплатно.`,
            `💎 В PRO — риск-скоринг и “красные флаги”.`,
            ``,
            `Нажми кнопку или просто пришли ИНН.`,
          ].join("\n"),
          { reply_markup: mainMenu() }
        );
        return;
      }

      if (!text) return;

      // если человек прислал ИНН
      if (isInn(text)) {
        const gate = await consumeFreeCheckIfNeeded(user);
        if (!gate.allowed) {
          await sendMessage(chatId, paywallText(), { reply_markup: mainMenu() });
          return;
        }

        const inn = text;

        // cache -> source
        let result = await getInnFromCache(inn);
        let source = "cache";

        if (!result) {
          result = await dadataFindByInn(inn);
          source = "dadata";
          if (!result?.warning) await saveInnToCache(inn, result);
        }

        // лог
        await sb.from("inn_checks").insert({
          tg_user_id: user.tg_user_id,
          inn,
          source,
          ok: true,
          result,
        });

        // ВОТ ТУТ: показываем риск-баллы только PRO
        await sendMessage(chatId, formatResult(inn, result, isPro(user)), {
          reply_markup: mainMenu(),
        });
        return;
      }

      // всё остальное
      await sendMessage(chatId, `Не понял сообщение.\nПришли ИНН (10 или 12 цифр) или нажми кнопку.`, {
        reply_markup: mainMenu(),
      });
    }
  } catch (e) {
    console.error("Webhook error:", e);
  }
});

/**
 * Auto set webhook on startup (удобно для Render)
 */
async function ensureWebhook() {
  if (!APP_URL || !WEBHOOK_SECRET || !BOT_TOKEN) return;
  const url = `${APP_URL.replace(/\/$/, "")}/webhook`;

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
