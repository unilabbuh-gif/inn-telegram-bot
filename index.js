/**
 * ProverkaBizBot — premium Telegram bot (INN checks)
 * Providers: Checko (api.checko.ru)
 * Storage: Supabase (tables + Storage bucket for PDF reports)
 * AI: OpenAI (short interpretation for “legal-style report”)
 *
 * ✅ Features:
 * - Free daily quota (default: 3/day), PRO unlimited (can be tied to subscriptions later)
 * - Cache by INN (inn_cache) with TTL
 * - Save checks log (inn_checks)
 * - Generate “legal style” PDF report, upload to Supabase Storage
 * - Telegram UI: menu buttons, clean output formatting
 *
 * ⚠️ Important:
 * - Put all secrets in Render Environment Variables (not in code)
 * - Use Supabase service role key on server-side only (Render), never in client JS
 */

import express from "express";
import fetch from "node-fetch";
import PDFDocument from "pdfkit";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";

/* =========================
   ENV
========================= */
const PORT = process.env.PORT || 10000;

const BOT_TOKEN = process.env.BOT_TOKEN || "";
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || ""; // e.g. https://inn-telegram-bot.onrender.com
const CHECKO_API_KEY = process.env.CHECKO_API_KEY || "";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const SUPABASE_STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || "ProverkaINN";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

/**
 * Limits / cache
 */
const FREE_DAILY_LIMIT = Number(process.env.FREE_DAILY_LIMIT || 3);
const CACHE_TTL_HOURS = Number(process.env.CACHE_TTL_HOURS || 24);

/* =========================
   Basic validation
========================= */
function assertEnv() {
  const missing = [];
  if (!BOT_TOKEN) missing.push("BOT_TOKEN");
  if (!SUPABASE_URL) missing.push("SUPABASE_URL");
  if (!SUPABASE_SERVICE_ROLE_KEY) missing.push("SUPABASE_SERVICE_ROLE_KEY");
  if (!PUBLIC_BASE_URL) missing.push("PUBLIC_BASE_URL");
  // CHECKO_API_KEY optional (bot will still respond, but data will be limited)
  // OPENAI_API_KEY optional (AI summary disabled without it)

  if (missing.length) {
    console.error(`[FATAL] Missing env: ${missing.join(", ")}`);
    process.exit(1);
  }
}

assertEnv();

/* =========================
   Clients
========================= */
const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const openai = OPENAI_API_KEY
  ? new OpenAI({ apiKey: OPENAI_API_KEY })
  : null;

/* =========================
   Express
========================= */
const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/", (req, res) => res.status(200).send("OK"));
app.get("/health", (req, res) => res.status(200).json({ ok: true }));

/* =========================
   Telegram API helper
========================= */
const tg = (method) => `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;

async function tgCall(method, payload) {
  const r = await fetch(tg(method), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await r.json();
  if (!data.ok) {
    throw new Error(`${method} failed: ${JSON.stringify(data)}`);
  }
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

async function editMessage(chatId, messageId, text, opts = {}) {
  return tgCall("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...opts,
  });
}

async function answerCallbackQuery(callbackQueryId, text = "", showAlert = false) {
  return tgCall("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text,
    show_alert: showAlert,
  });
}

/* =========================
   Telegram UI
========================= */
function mainMenu() {
  return {
    inline_keyboard: [
      [{ text: "🔎 Проверить ИНН (1 бесплатно)", callback_data: "CHECK_INN" }],
      [{ text: "💎 Тариф PRO", callback_data: "PRICING" }],
      [{ text: "❓ Что я проверяю?", callback_data: "ABOUT" }],
      [{ text: "🆘 Поддержка", callback_data: "SUPPORT" }],
    ],
  };
}

function afterCheckMenu() {
  return {
    inline_keyboard: [
      [{ text: "🔁 Проверить ещё ИНН", callback_data: "CHECK_INN" }],
      [{ text: "💎 Тариф PRO", callback_data: "PRICING" }],
      [{ text: "🆘 Поддержка", callback_data: "SUPPORT" }],
    ],
  };
}

function escapeHtml(s = "") {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function nowIso() {
  return new Date().toISOString();
}

/* =========================
   Validation
========================= */
function isInn(text) {
  return /^[0-9]{10}$/.test(text) || /^[0-9]{12}$/.test(text);
}

/* =========================
   DB helpers
========================= */

/**
 * Tables expected:
 * - bot_users: tg_user_id (bigint), tg_username (text), first_name (text), last_name (text), plan (text), free_checks_left (int), pro_until (timestamptz), created_at, updated_at
 * - inn_cache: inn (text pk), payload (jsonb), fetched_at (timestamptz)
 * - inn_checks: id, tg_user_id, inn, created_at, result_summary (text), risk_level (text), pdf_url (text)
 *
 * NOTE: If your schema differs — fix columns or update code mapping below.
 */

async function ensureUser(tgUser) {
  const tg_user_id = BigInt(tgUser.id);
  const tg_username = tgUser.username || null;
  const first_name = tgUser.first_name || null;
  const last_name = tgUser.last_name || null;

  // get user
  const { data: existing, error: e1 } = await sb
    .from("bot_users")
    .select("*")
    .eq("tg_user_id", tg_user_id.toString())
    .maybeSingle();

  if (e1) throw e1;

  if (existing) {
    // patch username/name if changed
    const patch = {};
    if (existing.tg_username !== tg_username) patch.tg_username = tg_username;
    if (existing.first_name !== first_name) patch.first_name = first_name;
    if (existing.last_name !== last_name) patch.last_name = last_name;
    if (Object.keys(patch).length) {
      patch.updated_at = nowIso();
      const { error: e2 } = await sb
        .from("bot_users")
        .update(patch)
        .eq("tg_user_id", tg_user_id.toString());
      if (e2) throw e2;
    }
    return existing;
  }

  // create new user
  const insert = {
    tg_user_id: tg_user_id.toString(),
    tg_username,
    first_name,
    last_name,
    plan: "free",
    free_checks_left: FREE_DAILY_LIMIT,
    pro_until: null,
    created_at: nowIso(),
    updated_at: nowIso(),
  };

  const { data: created, error: e3 } = await sb
    .from("bot_users")
    .insert(insert)
    .select("*")
    .single();

  if (e3) throw e3;
  return created;
}

function isPro(userRow) {
  if (!userRow) return false;
  if (userRow.plan === "pro") return true;
  if (userRow.pro_until) {
    const until = new Date(userRow.pro_until);
    if (!isNaN(until) && until > new Date()) return true;
  }
  return false;
}

async function resetDailyQuotaIfNeeded(userRow) {
  // minimalist daily reset: if updated_at is not today -> reset
  // For production, лучше cron/Edge Function. Но это работает “на коленке”.
  if (!userRow?.updated_at) return userRow;

  const last = new Date(userRow.updated_at);
  const now = new Date();

  const sameDay =
    last.getFullYear() === now.getFullYear() &&
    last.getMonth() === now.getMonth() &&
    last.getDate() === now.getDate();

  if (sameDay) return userRow;

  // reset free limit only for free users
  if (isPro(userRow)) return userRow;

  const { data, error } = await sb
    .from("bot_users")
    .update({ free_checks_left: FREE_DAILY_LIMIT, updated_at: nowIso() })
    .eq("tg_user_id", userRow.tg_user_id)
    .select("*")
    .single();

  if (error) throw error;
  return data;
}

async function decrementFreeCheck(userRow) {
  const left = Number(userRow.free_checks_left ?? 0);
  const next = Math.max(0, left - 1);

  const { data, error } = await sb
    .from("bot_users")
    .update({ free_checks_left: next, updated_at: nowIso() })
    .eq("tg_user_id", userRow.tg_user_id)
    .select("*")
    .single();

  if (error) throw error;
  return data;
}

function cacheIsFresh(fetchedAt) {
  if (!fetchedAt) return false;
  const dt = new Date(fetchedAt);
  if (isNaN(dt)) return false;
  const diffMs = Date.now() - dt.getTime();
  const ttlMs = CACHE_TTL_HOURS * 60 * 60 * 1000;
  return diffMs < ttlMs;
}

async function getCachedInn(inn) {
  const { data, error } = await sb
    .from("inn_cache")
    .select("*")
    .eq("inn", inn)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;
  if (!cacheIsFresh(data.fetched_at)) return null;
  return data;
}

async function saveInnCache(inn, payload) {
  const row = {
    inn,
    payload,
    fetched_at: nowIso(),
  };

  // upsert by primary key (inn)
  const { error } = await sb
    .from("inn_cache")
    .upsert(row, { onConflict: "inn" });

  if (error) throw error;
}

async function saveCheckLog({ tg_user_id, inn, result_summary, risk_level, pdf_url }) {
  const row = {
    tg_user_id: tg_user_id.toString(),
    inn,
    created_at: nowIso(),
    result_summary: result_summary || null,
    risk_level: risk_level || null,
    pdf_url: pdf_url || null,
  };

  const { error } = await sb.from("inn_checks").insert(row);
  if (error) throw error;
}

/* =========================
   Checko provider
========================= */

async function fetchCheckoCompany(inn) {
  if (!CHECKO_API_KEY) {
    return {
      provider: "checko",
      error: "CHECKO_API_KEY не задан. Данные провайдера недоступны.",
      raw: null,
    };
  }

  // Checko endpoint (basic):
  // GET https://api.checko.ru/v2/company?key=API_KEY&inn=INN
  const url = `https://api.checko.ru/v2/company?key=${encodeURIComponent(
    CHECKO_API_KEY
  )}&inn=${encodeURIComponent(inn)}`;

  const r = await fetch(url, { method: "GET" });
  const raw = await r.json().catch(() => null);

  if (!r.ok) {
    return {
      provider: "checko",
      error: `Checko HTTP ${r.status}`,
      raw,
    };
  }

  // checko returns { data: {...} } or { error: {...} }
  if (!raw || raw.error) {
    return { provider: "checko", error: raw?.error || "Unknown error", raw };
  }

  return { provider: "checko", error: null, raw };
}

/* =========================
   Normalization
========================= */

function normalizeCompany(checkoRaw) {
  // Try to map common fields
  const data = checkoRaw?.data || checkoRaw?.Data || checkoRaw?.result || null;
  if (!data) return null;

  // Some Checko variants:
  // data = { НаимОрг, ОГРН, КПП, Статус, Адрес, ... } or latin fields
  const name =
    data.short_name ||
    data.full_name ||
    data.name ||
    data.НаимОрг ||
    data.Наименование ||
    data.НаимСокр ||
    null;

  const ogrn = data.ogrn || data.ОГРН || null;
  const kpp = data.kpp || data.КПП || null;
  const status = data.status || data.Статус || null;

  const address =
    data.address ||
    data.Адрес ||
    data.АдресПолн ||
    data.address_full ||
    null;

  const inn = data.inn || data.ИНН || null;

  // Risk / flags can be expanded later (red flags, bankrupt, etc.)
  // We'll keep simple for now:
  const risk_level = data.risk_level || data.Риск || null;

  return {
    inn,
    name,
    ogrn,
    kpp,
    status,
    address,
    risk_level,
    raw: data,
  };
}

function riskLabel(risk) {
  if (!risk) return "—";
  const s = String(risk).toLowerCase();
  if (s.includes("выс") || s.includes("high")) return "Высокий";
  if (s.includes("сред") || s.includes("medium")) return "Средний";
  if (s.includes("низ") || s.includes("low")) return "Низкий";
  return String(risk);
}

/* =========================
   OpenAI interpretation
========================= */

async function aiInterpretation(company) {
  if (!openai) return null;

  // We make a compact “legal style” note (NOT an official document).
  const payload = {
    inn: company.inn,
    name: company.name,
    ogrn: company.ogrn,
    kpp: company.kpp,
    status: company.status,
    address: company.address,
    risk_level: company.risk_level,
  };

  const prompt = `
Ты — эксперт по проверке контрагентов в РФ.
Составь краткое заключение (5–8 пунктов) в стиле "юридической справки" по данным компании.
Тон: деловой, нейтральный. Без фантазий. Если данных мало — прямо скажи "данных недостаточно".
Обязательно добавь дисклеймер: "Справка информационная, не является официальным документом ФНС".
Данные (JSON): ${JSON.stringify(payload)}
`;

  const resp = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    messages: [
      { role: "system", content: "Пиши по-русски, строго по фактам из JSON." },
      { role: "user", content: prompt },
    ],
    temperature: 0.2,
  });

  const text = resp.choices?.[0]?.message?.content?.trim() || null;
  return text;
}

/* =========================
   PDF report
========================= */

function buildPdfBuffer({ inn, company, aiText }) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "A4", margin: 48 });

      const chunks = [];
      doc.on("data", (c) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));

      const title = "Справка по контрагенту (информационная)";
      doc.fontSize(16).text(title, { align: "center" });
      doc.moveDown(0.5);
      doc.fontSize(10).fillColor("gray").text(`Дата формирования: ${new Date().toLocaleString("ru-RU")}`, {
        align: "center",
      });
      doc.moveDown(1);
      doc.fillColor("black");

      doc.fontSize(12).text(`ИНН: ${inn}`);
      doc.moveDown(0.2);

      if (company?.name) doc.text(`Наименование: ${company.name}`);
      if (company?.ogrn) doc.text(`ОГРН: ${company.ogrn}`);
      if (company?.kpp) doc.text(`КПП: ${company.kpp}`);
      if (company?.status) doc.text(`Статус: ${company.status}`);
      if (company?.address) doc.text(`Адрес: ${company.address}`);
      doc.text(`Уровень риска: ${riskLabel(company?.risk_level)}`);

      doc.moveDown(1);
      doc.fontSize(12).text("Заключение:", { underline: true });
      doc.moveDown(0.4);

      if (aiText) {
        doc.fontSize(11).text(aiText, { align: "left" });
      } else {
        doc.fontSize(11).text(
          "Заключение не сформировано (не подключен OpenAI или недостаточно данных).",
          { align: "left" }
        );
      }

      doc.moveDown(1.2);
      doc
        .fontSize(9)
        .fillColor("gray")
        .text(
          "Дисклеймер: справка информационная, предназначена для внутренней проверки. Не является официальным документом ФНС/судебным доказательством. Источник данных: Checko (api.checko.ru).",
          { align: "left" }
        );

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

async function uploadPdfToSupabase({ inn, pdfBuffer }) {
  const fileName = `reports/${inn}/${Date.now()}_report.pdf`;

  const { error: uploadErr } = await sb.storage
    .from(SUPABASE_STORAGE_BUCKET)
    .upload(fileName, pdfBuffer, {
      contentType: "application/pdf",
      upsert: true,
    });

  if (uploadErr) throw uploadErr;

  // If bucket is public, getPublicUrl works
  const { data } = sb.storage.from(SUPABASE_STORAGE_BUCKET).getPublicUrl(fileName);
  const publicUrl = data?.publicUrl || null;

  return publicUrl;
}

/* =========================
   Telegram flow
========================= */

const state = new Map(); // chatId -> { mode: "await_inn" }

async function onStart(chatId) {
  const text =
    "Привет! Я проверяю контрагентов по ИНН.\n\n" +
    `Пришли ИНН (10 или 12 цифр) одним сообщением.\n` +
    `Лимит free: ${FREE_DAILY_LIMIT} проверок в день.\n\n` +
    "Ниже кнопки меню 👇";

  await sendMessage(chatId, escapeHtml(text), { reply_markup: mainMenu() });
}

async function onPricing(chatId) {
  const text =
    "💎 <b>Тариф PRO</b>\n\n" +
    "В PRO будет:\n" +
    "— безлимит проверок\n" +
    "— история проверок\n" +
    "— PDF-отчёты с отметкой «проверено»\n" +
    "— риск-баллы/красные флаги\n\n" +
    "Оплату подключим следующим шагом (Stripe/ЮKassa/Telegram Payments).\n" +
    "Пока можешь написать в поддержку — включим вручную.";

  await sendMessage(chatId, text, { reply_markup: afterCheckMenu() });
}

async function onAbout(chatId) {
  const text =
    "❓ <b>Что я проверяю?</b>\n\n" +
    "— основные реквизиты организации (наименование, ОГРН, КПП, статус, адрес)\n" +
    "— уровень риска (если провайдер даёт)\n" +
    "— формирую информационную справку (PDF)\n\n" +
    "⚠️ Это не официальный документ ФНС. Это инструмент для внутренней проверки.";

  await sendMessage(chatId, text, { reply_markup: afterCheckMenu() });
}

async function onSupport(chatId) {
  const text =
    "🆘 <b>Поддержка</b>\n\n" +
    "Напиши сюда: @YOUR_SUPPORT_USERNAME\n" +
    "Или ответь на это сообщение — мы увидим в логах и поможем.";

  await sendMessage(chatId, text, { reply_markup: afterCheckMenu() });
}

async function askInn(chatId) {
  state.set(chatId, { mode: "await_inn" });
  await sendMessage(
    chatId,
    "Ок. Пришли ИНН (10 или 12 цифр) одним сообщением.",
    { reply_markup: afterCheckMenu() }
  );
}

function formatResultMessage({ inn, company, aiText, pdfUrl, userRow }) {
  const lines = [];
  lines.push(`🔎 <b>Сводка по ИНН ${escapeHtml(inn)}</b>`);
  lines.push("");

  const risk = riskLabel(company?.risk_level);
  lines.push(`<b>Уровень риска:</b> ${escapeHtml(risk)}`);
  lines.push("");

  lines.push("<b>Сводка:</b>");
  lines.push(`• Наименование: ${escapeHtml(company?.name || "—")}`);
  lines.push(`• ОГРН: ${escapeHtml(company?.ogrn || "—")}`);
  lines.push(`• КПП: ${escapeHtml(company?.kpp || "—")}`);
  lines.push(`• Статус: ${escapeHtml(company?.status || "—")}`);
  lines.push(`• Адрес: ${escapeHtml(company?.address || "—")}`);
  lines.push("");

  if (pdfUrl) {
    lines.push(`📄 <b>PDF-отчёт:</b> ${escapeHtml(pdfUrl)}`);
    lines.push("");
  } else {
    lines.push("📄 <b>PDF не загружен</b> (проверь Supabase Storage / ключи / bucket).");
    lines.push("");
  }

  if (aiText) {
    lines.push("🧠 <b>Краткое заключение:</b>");
    lines.push(escapeHtml(aiText));
    lines.push("");
  }

  const isProNow = isPro(userRow);
  if (!isProNow) {
    lines.push(`🧾 <i>Лимит free на сегодня: осталось ${escapeHtml(String(userRow.free_checks_left ?? 0))} проверок.</i>`);
    lines.push("💎 В PRO будет безлимит + история + риск-баллы + PDF.");
  } else {
    lines.push("💎 <b>PRO активен:</b> безлимит проверок.");
  }

  lines.push("");
  lines.push("⚠️ <i>Справка информационная, для внутренней проверки. Не официальный документ ФНС.</i>");

  return lines.join("\n");
}

/* =========================
   Main INN handler
========================= */

async function handleInnCheck(chatId, tgUser, inn) {
  // ensure user
  let userRow = await ensureUser(tgUser);
  userRow = await resetDailyQuotaIfNeeded(userRow);

  const pro = isPro(userRow);

  if (!pro) {
    const left = Number(userRow.free_checks_left ?? 0);
    if (left <= 0) {
      const text =
        "⛔ Лимит на сегодня исчерпан.\n\n" +
        "💎 В PRO будет безлимит + риск-баллы + история.\n" +
        "Нажми «Тариф PRO» или напиши в поддержку.";
      await sendMessage(chatId, text, { reply_markup: afterCheckMenu() });
      return;
    }
    userRow = await decrementFreeCheck(userRow);
  }

  // send "processing"
  const msg = await sendMessage(chatId, `⏳ Проверяю ИНН ${inn}...`);

  try {
    // cache first
    const cached = await getCachedInn(inn);
    let providerResp;

    if (cached?.payload) {
      providerResp = cached.payload;
    } else {
      providerResp = await fetchCheckoCompany(inn);
      await saveInnCache(inn, providerResp);
    }

    if (providerResp?.error) {
      await editMessage(
        chatId,
        msg.message_id,
        `❌ Не удалось получить данные провайдера.\n\nПричина: ${escapeHtml(
          String(providerResp.error)
        )}\n\nПроверь CHECKO_API_KEY.`,
        { reply_markup: afterCheckMenu() }
      );
      return;
    }

    const company = normalizeCompany(providerResp?.raw);
    if (!company) {
      await editMessage(
        chatId,
        msg.message_id,
        `⚠️ Данные по ИНН ${inn} не найдены или формат ответа неожиданен.\n\nПопробуй позже или проверь ключ Checko.`,
        { reply_markup: afterCheckMenu() }
      );
      return;
    }

    // AI text
    const aiText = await aiInterpretation(company);

    // PDF
    const pdfBuffer = await buildPdfBuffer({ inn, company, aiText });
    let pdfUrl = null;
    try {
      pdfUrl = await uploadPdfToSupabase({ inn, pdfBuffer });
    } catch (e) {
      console.error("PDF upload failed:", e);
      pdfUrl = null;
    }

    // log to DB
    try {
      await saveCheckLog({
        tg_user_id: BigInt(tgUser.id),
        inn,
        result_summary: company?.name || null,
        risk_level: company?.risk_level ? String(company.risk_level) : null,
        pdf_url: pdfUrl,
      });
    } catch (e) {
      console.error("saveCheckLog failed:", e);
    }

    const text = formatResultMessage({ inn, company, aiText, pdfUrl, userRow });
    await editMessage(chatId, msg.message_id, text, { reply_markup: afterCheckMenu() });
  } catch (e) {
    console.error("handleInnCheck error:", e);
    await editMessage(
      chatId,
      msg.message_id,
      `❌ Ошибка на сервере: ${escapeHtml(String(e.message || e))}`,
      { reply_markup: afterCheckMenu() }
    );
  }
}

/* =========================
   Telegram webhook
========================= */

app.post("/webhook", async (req, res) => {
  try {
    const update = req.body;

    // callback_query
    if (update.callback_query) {
      const cq = update.callback_query;
      const chatId = cq.message?.chat?.id;
      const data = cq.data;

      if (!chatId) {
        await answerCallbackQuery(cq.id, "Ошибка: chatId не найден", true);
        return res.json({ ok: true });
      }

      if (data === "CHECK_INN") {
        await answerCallbackQuery(cq.id, "Ок, пришли ИНН сообщением.");
        await askInn(chatId);
      } else if (data === "PRICING") {
        await answerCallbackQuery(cq.id, "Тарифы");
        await onPricing(chatId);
      } else if (data === "ABOUT") {
        await answerCallbackQuery(cq.id, "Что проверяем");
        await onAbout(chatId);
      } else if (data === "SUPPORT") {
        await answerCallbackQuery(cq.id, "Поддержка");
        await onSupport(chatId);
      } else {
        await answerCallbackQuery(cq.id, "Ок");
      }

      return res.json({ ok: true });
    }

    // message
    if (update.message) {
      const msg = update.message;
      const chatId = msg.chat.id;
      const text = (msg.text || "").trim();
      const tgUser = msg.from;

      if (text === "/start") {
        await ensureUser(tgUser).catch((e) => console.error("ensureUser error:", e));
        await onStart(chatId);
        return res.json({ ok: true });
      }

      // if waiting for INN
      const st = state.get(chatId);
      if (st?.mode === "await_inn") {
        if (!isInn(text)) {
          await sendMessage(
            chatId,
            "❗ ИНН должен быть 10 или 12 цифр. Пришли корректный ИНН одним сообщением.",
            { reply_markup: afterCheckMenu() }
          );
          return res.json({ ok: true });
        }

        // do check
        await handleInnCheck(chatId, tgUser, text);
        return res.json({ ok: true });
      }

      // If user types an INN without pressing button – accept
      if (isInn(text)) {
        await handleInnCheck(chatId, tgUser, text);
        return res.json({ ok: true });
      }

      // default
      await sendMessage(chatId, "Нажми кнопку «Проверить ИНН» или пришли ИНН цифрами.", {
        reply_markup: mainMenu(),
      });
      return res.json({ ok: true });
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error("webhook error:", e);
    return res.json({ ok: true });
  }
});

/* =========================
   Webhook setup
========================= */

async function setWebhook() {
  if (!PUBLIC_BASE_URL) {
    console.warn("PUBLIC_BASE_URL missing, webhook setup skipped");
    return;
  }

  const url = `${PUBLIC_BASE_URL.replace(/\/$/, "")}/webhook`;
  try {
    const r = await tgCall("setWebhook", { url });
    console.log("[INFO] Webhook set:", url, r ? "true" : "false");
  } catch (e) {
    console.error("setWebhook failed:", e);
  }
}

/* =========================
   Start server
========================= */
app.listen(PORT, async () => {
  console.log(`[INFO] Server started on port ${PORT}`);
  console.log(`[INFO] Supabase: enabled`);
  await setWebhook();
  console.log("✅ Your service is live 🚀");
});
