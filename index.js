import "dotenv/config";
import express from "express";
import PDFDocument from "pdfkit";
import { createClient } from "@supabase/supabase-js";

/**
 * =========================
 * CONFIG
 * =========================
 */
const PORT = Number(process.env.PORT || 10000);

const BOT_TOKEN = process.env.BOT_TOKEN; // REQUIRED
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || ""; // e.g. https://inn-telegram-bot.onrender.com

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const SUPABASE_STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || "reports";

const CHECKO_API_KEY = process.env.CHECKO_API_KEY || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

const FREE_DAILY_LIMIT = Number(process.env.FREE_DAILY_LIMIT || 3);

// “Премиальная” шапка в PDF
const REPORT_BRAND = process.env.REPORT_BRAND || "ProverkaBiz";
const REPORT_WATERMARK = process.env.REPORT_WATERMARK || "ПРОВЕРЕНО";

/**
 * =========================
 * SUPABASE
 * =========================
 */
const sb =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false },
      })
    : null;

function nowIso() {
  return new Date().toISOString();
}

function todayKey() {
  // YYYY-MM-DD in UTC
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * =========================
 * TELEGRAM API (no extra libs)
 * =========================
 */
const tg = (method) => `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;

async function tgCall(method, payload) {
  const r = await fetch(tg(method), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await r.json();
  if (!data.ok) {
    throw new Error(`Telegram ${method} failed: ${JSON.stringify(data)}`);
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

function mainMenu() {
  return {
    inline_keyboard: [
      [{ text: "🔎 Проверить ИНН", callback_data: "CHECK_INN" }],
      [{ text: "💎 Тариф PRO", callback_data: "PRICING" }],
      [{ text: "ℹ️ Что я проверяю?", callback_data: "ABOUT" }],
      [{ text: "🆘 Поддержка", callback_data: "SUPPORT" }],
    ],
  };
}

function isInn(text) {
  const t = String(text || "").trim();
  return /^\d{10}$/.test(t) || /^\d{12}$/.test(t);
}

function normalizeInn(text) {
  return String(text || "").trim();
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/**
 * =========================
 * CHECKO PROVIDER
 * =========================
 * NOTE: using the endpoint you already used:
 * GET https://api.checko.ru/v2/company?key=API_KEY&inn=INN
 */
async function fetchCheckoCompany(inn) {
  if (!CHECKO_API_KEY) {
    return {
      provider: "checko",
      warning: "CHECKO_API_KEY не задан — Checko отключен (демо-режим).",
      inn,
      raw: null,
    };
  }

  const url =
    "https://api.checko.ru/v2/company" +
    `?key=${encodeURIComponent(CHECKO_API_KEY)}` +
    `&inn=${encodeURIComponent(inn)}`;

  const r = await fetch(url, { method: "GET" });
  const text = await r.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return {
      provider: "checko",
      inn,
      not_found: true,
      source_error: "Checko вернул не-JSON",
      raw_text: text?.slice(0, 2000),
    };
  }

  // Checko can return {data:{...}} or {error:{...}} depending on тариф/ошибку
  if (data?.error) {
    return {
      provider: "checko",
      inn,
      not_found: true,
      source_error: data.error,
      raw: data,
    };
  }

  return {
    provider: "checko",
    inn,
    raw: data,
  };
}

/**
 * =========================
 * OPENAI SUMMARY (optional)
 * =========================
 * If no OPENAI_API_KEY -> fallback summarizer.
 */
function fallbackSummary(inn, checkoRaw) {
  const d = checkoRaw?.data || checkoRaw; // depending on shape
  const name =
    d?.name?.short || d?.name?.full || d?.company_name || d?.name || "—";
  const ogrn = d?.ogrn || d?.OGRN || "—";
  const kpp = d?.kpp || d?.KPP || "—";
  const status = d?.status || d?.state || "—";
  const addr =
    d?.address?.value ||
    d?.address ||
    d?.addresses?.legal ||
    d?.legal_address ||
    "—";

  return {
    title: `Сводка по ИНН ${inn}`,
    bullets: [
      `Наименование: ${name}`,
      `ОГРН: ${ogrn}`,
      `КПП: ${kpp}`,
      `Статус: ${status}`,
      `Адрес: ${addr}`,
    ],
    red_flags: [],
    note:
      "AI отключен — это базовая сводка. Для “умной” интерпретации подключи OPENAI_API_KEY.",
  };
}

async function openaiSummarize(inn, checkoRaw) {
  if (!OPENAI_API_KEY) return fallbackSummary(inn, checkoRaw);

  const payload = {
    model: "gpt-5-mini",
    input: [
      {
        role: "system",
        content:
          "Ты — риск-аналитик по контрагентам РФ. Из сырых данных API сформируй краткую и практичную сводку для бухгалтера/юриста. Без выдумок. Если поля нет — ставь null. Ответ строго в JSON по схеме.",
      },
      {
        role: "user",
        content:
          "ИНН: " +
          inn +
          "\nСырые данные Checko (JSON):\n" +
          JSON.stringify(checkoRaw ?? {}, null, 2),
      },
    ],
    // “структурный” ответ
    text: {
      format: {
        type: "json_schema",
        name: "counterparty_report",
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            title: { type: "string" },
            company: {
              type: "object",
              additionalProperties: false,
              properties: {
                name: { type: ["string", "null"] },
                inn: { type: ["string", "null"] },
                kpp: { type: ["string", "null"] },
                ogrn: { type: ["string", "null"] },
                status: { type: ["string", "null"] },
                okved: { type: ["string", "null"] },
                address: { type: ["string", "null"] },
                ceo: { type: ["string", "null"] }
              },
              required: ["name", "inn", "kpp", "ogrn", "status", "okved", "address", "ceo"]
            },
            bullets: { type: "array", items: { type: "string" } },
            red_flags: { type: "array", items: { type: "string" } },
            risk_level: {
              type: "string",
              enum: ["низкий", "средний", "высокий", "неопределён"]
            },
            note: { type: "string" }
          },
          required: ["title", "company", "bullets", "red_flags", "risk_level", "note"]
        }
      }
    }
  };

  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await r.json();
  if (!r.ok) {
    // fallback on any API error
    return {
      ...fallbackSummary(inn, checkoRaw),
      note:
        "AI не смог обработать ответ (ошибка OpenAI). Показана базовая сводка.",
      ai_error: data,
    };
  }

  // The structured json is typically in output_text for schema responses.
  // We defensively parse any text fields.
  const outText =
    data?.output_text ||
    data?.output?.[0]?.content?.find((c) => c?.type === "output_text")?.text ||
    null;

  if (!outText) {
    return {
      ...fallbackSummary(inn, checkoRaw),
      note: "AI ответил пусто. Показана базовая сводка.",
    };
  }

  try {
    return JSON.parse(outText);
  } catch {
    return {
      ...fallbackSummary(inn, checkoRaw),
      note: "AI вернул не-JSON. Показана базовая сводка.",
      ai_raw: outText?.slice(0, 2000),
    };
  }
}

/**
 * =========================
 * PDF GENERATION
 * =========================
 */
function buildPdfBuffer({ inn, checkoRaw, ai }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 48 });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    // Header
    doc.fontSize(18).text(REPORT_BRAND, { align: "left" });
    doc.moveDown(0.2);
    doc.fontSize(12).fillColor("#444").text(`Отчет проверки контрагента по ИНН`, {
      align: "left",
    });
    doc.fillColor("black");
    doc.moveDown(0.6);

    // Watermark-ish stamp (simple)
    doc
      .save()
      .fontSize(34)
      .fillColor("#CCCCCC")
      .rotate(-18, { origin: [160, 300] })
      .text(REPORT_WATERMARK, 120, 260, { opacity: 0.15 })
      .restore();

    // Meta
    doc.fontSize(11).fillColor("#000");
    doc.text(`ИНН: ${inn}`);
    doc.text(`Дата/время: ${new Date().toLocaleString("ru-RU")}`);
    doc.text(`Источник данных: Checko (open data / агрегатор)`);
    doc.moveDown(0.8);

    // AI block
    doc.fontSize(14).text("Краткая сводка", { underline: true });
    doc.moveDown(0.4);

    const bullets = ai?.bullets?.length ? ai.bullets : [];
    if (bullets.length) {
      doc.fontSize(11);
      bullets.forEach((b) => doc.text(`• ${String(b)}`));
      doc.moveDown(0.6);
    }

    doc.fontSize(12).text(`Уровень риска: ${ai?.risk_level || "—"}`);
    doc.moveDown(0.4);

    if (ai?.red_flags?.length) {
      doc.fontSize(12).text("Красные флаги:", { underline: true });
      doc.moveDown(0.2);
      doc.fontSize(11);
      ai.red_flags.forEach((f) => doc.text(`• ${String(f)}`));
      doc.moveDown(0.6);
    }

    doc.fontSize(10).fillColor("#444").text(
      "Важно: данный отчет носит информационный характер и предназначен для внутренней проверки. " +
        "Он не является официальным документом ФНС/госорганов и не гарантирует отсутствие рисков.",
      { align: "left" }
    );
    doc.fillColor("black");
    doc.moveDown(0.8);

    // Raw (short) section
    doc.fontSize(12).text("Технические данные (фрагмент)", { underline: true });
    doc.moveDown(0.3);

    const rawPreview = JSON.stringify(checkoRaw ?? {}, null, 2).slice(0, 3500);
    doc.fontSize(8).fillColor("#333").text(rawPreview);
    doc.fillColor("black");

    doc.end();
  });
}

async function uploadPdfToSupabase(path, buffer) {
  if (!sb) return { uploaded: false, reason: "Supabase не настроен" };

  const up = await sb.storage
    .from(SUPABASE_STORAGE_BUCKET)
    .upload(path, buffer, {
      contentType: "application/pdf",
      upsert: true,
    });

  if (up.error) {
    return { uploaded: false, reason: up.error.message, error: up.error };
  }

  // If bucket is public -> public URL works.
  // If private -> you can generate signed URLs later.
  const pub = sb.storage.from(SUPABASE_STORAGE_BUCKET).getPublicUrl(path);
  return { uploaded: true, url: pub?.data?.publicUrl || null };
}

/**
 * =========================
 * DB helpers
 * =========================
 */
async function ensureUser(tgUser) {
  if (!sb) return null;

  const tg_user_id = String(tgUser.id);
  const payload = {
    tg_user_id,
    tg_username: tgUser.username || null,
    first_name: tgUser.first_name || null,
    last_name: tgUser.last_name || null,
    updated_at: nowIso(),
  };

  // Upsert by tg_user_id
  const { data, error } = await sb
    .from("bot_users")
    .upsert(payload, { onConflict: "tg_user_id" })
    .select("*")
    .single();

  if (error) throw new Error(`Supabase ensureUser error: ${error.message}`);
  return data;
}

async function isProUser(tg_user_id) {
  if (!sb) return false;

  const { data, error } = await sb
    .from("subscriptions")
    .select("pro_until")
    .eq("tg_user_id", String(tg_user_id))
    .maybeSingle();

  if (error) throw new Error(`Supabase subscriptions read error: ${error.message}`);

  const proUntil = data?.pro_until ? new Date(data.pro_until) : null;
  return proUntil && proUntil.getTime() > Date.now();
}

async function checkAndConsumeFreeQuota(tg_user_id) {
  if (!sb) {
    // no DB -> allow but limited functionality
    return { allowed: true, left: null, reason: "Supabase не настроен" };
  }

  const day = todayKey();
  const key = { tg_user_id: String(tg_user_id), day };

  // upsert row if missing
  const { data: row, error: upErr } = await sb
    .from("bot_quota_daily")
    .upsert({ ...key, used: 0, updated_at: nowIso() }, { onConflict: "tg_user_id,day" })
    .select("*")
    .single();

  if (upErr) throw new Error(`Supabase quota upsert error: ${upErr.message}`);

  const used = Number(row?.used || 0);
  const left = Math.max(0, FREE_DAILY_LIMIT - used);

  if (left <= 0) {
    return { allowed: false, left: 0, reason: "Лимит на сегодня исчерпан" };
  }

  // consume one
  const { error: updErr } = await sb
    .from("bot_quota_daily")
    .update({ used: used + 1, updated_at: nowIso() })
    .eq("tg_user_id", String(tg_user_id))
    .eq("day", day);

  if (updErr) throw new Error(`Supabase quota update error: ${updErr.message}`);

  return { allowed: true, left: left - 1, reason: null };
}

async function cacheGet(inn) {
  if (!sb) return null;
  const { data, error } = await sb
    .from("inn_cache")
    .select("*")
    .eq("inn", String(inn))
    .maybeSingle();

  if (error) throw new Error(`Supabase cache read error: ${error.message}`);
  return data || null;
}

async function cacheSet(inn, provider, raw, ai_summary) {
  if (!sb) return null;
  const payload = {
    inn: String(inn),
    provider,
    raw,
    ai_summary,
    updated_at: nowIso(),
  };
  const { data, error } = await sb
    .from("inn_cache")
    .upsert(payload, { onConflict: "inn" })
    .select("*")
    .single();

  if (error) throw new Error(`Supabase cache upsert error: ${error.message}`);
  return data;
}

async function saveCheckLog({ tg_user_id, inn, provider, raw, ai_summary, pdf_url }) {
  if (!sb) return null;
  const payload = {
    tg_user_id: String(tg_user_id),
    inn: String(inn),
    kind: "company",
    provider,
    raw,
    ai_summary,
    pdf_url: pdf_url || null,
    created_at: nowIso(),
  };
  const { data, error } = await sb.from("inn_checks").insert(payload).select("*").single();
  if (error) throw new Error(`Supabase inn_checks insert error: ${error.message}`);
  return data;
}

/**
 * =========================
 * Telegram flows
 * =========================
 */
function pricingText() {
  return [
    "<b>💎 Тариф PRO</b>",
    "",
    "В PRO будет:",
    "• безлимит проверок",
    "• риск-оценка + “красные флаги”",
    "• история проверок",
    "• выгрузка отчета (PDF)",
    "",
    "Оплату подключим следующим шагом (ЮKassa/CloudPayments/Telegram Stars).",
    "Пока — включение PRO вручную через поддержку.",
  ].join("\n");
}

function aboutText() {
  return [
    "<b>ℹ️ Что я проверяю</b>",
    "",
    "По ИНН подтягиваю данные организации из Checko и формирую сводку:",
    "• наименование, статус, адрес",
    "• базовые реквизиты (ОГРН/КПП, если есть в источнике)",
    "• AI-интерпретация рисков (если подключен OpenAI)",
    "• PDF-отчет для внутренней проверки",
    "",
    "<i>Это информационная проверка. Не официальный документ ФНС.</i>",
  ].join("\n");
}

function supportText() {
  return [
    "<b>🆘 Поддержка</b>",
    "",
    "Напиши сюда, что именно нужно:",
    "• включить PRO",
    "• добавить источник/поля",
    "• исправить конкретную ошибку",
  ].join("\n");
}

async function handleStart(chatId) {
  const text = [
    "Привет! Я проверяю контрагентов по ИНН.",
    "",
    `Пришли ИНН (10 или 12 цифр) одним сообщением.`,
    `Лимит FREE: ${FREE_DAILY_LIMIT} проверки в день.`,
  ].join("\n");

  await sendMessage(chatId, text, { reply_markup: mainMenu() });
}

async function handleInn(chatId, fromUser, inn) {
  await ensureUser(fromUser);

  const pro = await isProUser(fromUser.id);

  if (!pro) {
    const q = await checkAndConsumeFreeQuota(fromUser.id);
    if (!q.allowed) {
      await sendMessage(
        chatId,
        [
          "⛔️ Лимит на сегодня исчерпан.",
          "",
          "💎 В PRO будет безлимит + риск-баллы + история + PDF.",
        ].join("\n"),
        { reply_markup: mainMenu() }
      );
      return;
    }
  }

  await sendMessage(chatId, `🔎 Проверяю ИНН <b>${escapeHtml(inn)}</b>…`);

  // Cache first (24h soft logic: we'll just use what’s in cache if exists)
  let cached = await cacheGet(inn);
  let checko;
  let ai;

  if (cached?.raw && cached?.ai_summary) {
    checko = cached.raw;
    ai = cached.ai_summary;
  } else {
    const resp = await fetchCheckoCompany(inn);
    checko = resp.raw;

    // AI summary (or fallback)
    ai = await openaiSummarize(inn, resp.raw);

    // cache
    await cacheSet(inn, "checko", resp.raw, ai);
  }

  // Build PDF
  const pdfBuffer = await buildPdfBuffer({ inn, checkoRaw: checko, ai });

  // Save check log first to get id
  const log = await saveCheckLog({
    tg_user_id: fromUser.id,
    inn,
    provider: "checko",
    raw: checko,
    ai_summary: ai,
    pdf_url: null,
  });

  // Upload PDF
  let pdfUrl = null;
  if (sb && log?.id) {
    const path = `inn/${inn}/check_${log.id}.pdf`;
    const uploaded = await uploadPdfToSupabase(path, pdfBuffer);
    if (uploaded.uploaded && uploaded.url) {
      pdfUrl = uploaded.url;

      // update record with pdf url
      await sb
        .from("inn_checks")
        .update({ pdf_url: pdfUrl })
        .eq("id", log.id);
    }
  }

  // Compose premium message
  const title = escapeHtml(ai?.title || `Результат по ИНН ${inn}`);
  const risk = escapeHtml(ai?.risk_level || "—");

  const bullets = Array.isArray(ai?.bullets) ? ai.bullets : [];
  const redFlags = Array.isArray(ai?.red_flags) ? ai.red_flags : [];

  let msg = `<b>${title}</b>\n\n`;
  msg += `<b>Уровень риска:</b> ${risk}\n\n`;

  if (bullets.length) {
    msg += "<b>Сводка:</b>\n";
    for (const b of bullets.slice(0, 12)) msg += `• ${escapeHtml(b)}\n`;
    msg += "\n";
  }

  if (redFlags.length) {
    msg += "<b>Красные флаги:</b>\n";
    for (const f of redFlags.slice(0, 10)) msg += `• ${escapeHtml(f)}\n`;
    msg += "\n";
  }

  if (pdfUrl) {
    msg += `<b>PDF-отчет:</b> ${escapeHtml(pdfUrl)}\n\n`;
  } else {
    msg += "<i>PDF не загружен (проверь Supabase Storage / ключи).</i>\n\n";
  }

  msg += "<i>Отчет информационный, для внутренней проверки. Не документ ФНС.</i>";

  await sendMessage(chatId, msg, { reply_markup: mainMenu() });
}

/**
 * =========================
 * EXPRESS APP
 * =========================
 */
const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static("public"));

app.get("/health", (_, res) => res.json({ ok: true, ts: nowIso() }));

app.post("/webhook", async (req, res) => {
  try {
    const update = req.body;

    // Acknowledge ASAP (Telegram expects fast response)
    res.status(200).json({ ok: true });

    // Callback buttons
    if (update?.callback_query) {
      const cq = update.callback_query;
      const chatId = cq?.message?.chat?.id;
      const data = cq?.data;

      if (chatId && data === "CHECK_INN") {
        await sendMessage(chatId, "Пришли ИНН (10 или 12 цифр) одним сообщением.", {
          reply_markup: mainMenu(),
        });
      } else if (chatId && data === "PRICING") {
        await sendMessage(chatId, pricingText(), { reply_markup: mainMenu() });
      } else if (chatId && data === "ABOUT") {
        await sendMessage(chatId, aboutText(), { reply_markup: mainMenu() });
      } else if (chatId && data === "SUPPORT") {
        await sendMessage(chatId, supportText(), { reply_markup: mainMenu() });
      }

      // answer callback (remove “loading”)
      if (cq.id) {
        await tgCall("answerCallbackQuery", { callback_query_id: cq.id });
      }
      return;
    }

    // Messages
    const msg = update?.message;
    if (!msg) return;

    const chatId = msg.chat?.id;
    const fromUser = msg.from;
    const text = (msg.text || "").trim();

    if (!chatId || !fromUser) return;

    if (text === "/start") {
      await handleStart(chatId);
      return;
    }

    if (isInn(text)) {
      await handleInn(chatId, fromUser, normalizeInn(text));
      return;
    }

    // Default
    await sendMessage(
      chatId,
      "Пришли ИНН (10 или 12 цифр). Или нажми кнопку меню 👇",
      { reply_markup: mainMenu() }
    );
  } catch (e) {
    // We already responded to Telegram with 200, just log
    console.error("Webhook handler error:", e);
  }
});

/**
 * =========================
 * STARTUP
 * =========================
 */
async function setWebhook() {
  if (!BOT_TOKEN) {
    console.error("FATAL: BOT_TOKEN is required");
    process.exit(1);
  }
  if (!PUBLIC_BASE_URL) {
    console.warn("PUBLIC_BASE_URL missing, webhook setup skipped");
    return;
  }

  const url = `${PUBLIC_BASE_URL.replace(/\/$/, "")}/webhook`;
  await tgCall("setWebhook", { url });
  console.log("Webhook set:", url);
}

app.listen(PORT, async () => {
  console.log(`Server started on port ${PORT}`);
  console.log(`Supabase: ${sb ? "enabled" : "disabled"}`);
  await setWebhook();
});
