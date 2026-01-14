/**
 * ProverkaBiz — Telegram bot + Checko + OpenAI interpretation + PDF reports + Supabase + limits + PRO
 * Node 18+ (Render ok). ESM.
 */

import path from "path";
import express from "express";
import PDFDocument from "pdfkit";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";

// ================= ENV =================
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN || "";
const APP_URL = (process.env.APP_URL || process.env.PUBLIC_URL || "").replace(/\/+$/, "");
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || ""; // optional, but recommended

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const CHECKO_API_KEY = process.env.CHECKO_API_KEY || ""; // основной источник данных
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || ""; // для интерпретации
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

const FREE_DAILY_LIMIT = Number(process.env.FREE_DAILY_LIMIT || 3);
const PORT = Number(process.env.PORT || 10000);

// ================= Guards =================
if (!BOT_TOKEN) {
  console.error("FATAL: TELEGRAM_BOT_TOKEN (or BOT_TOKEN) is required");
  process.exit(1);
}
const HAS_SB = Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);

const sb = HAS_SB
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
  : null;

const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

// ================= App =================
const app = express();
const __dirname = path.resolve();

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public"))); // для Telegram WebApp

app.get("/", (_, res) => res.status(200).send("OK"));
app.get("/healthz", (_, res) => res.status(200).json({ ok: true, has_supabase: HAS_SB }));

// WebApp entry (если у тебя есть public/index.html)
app.get("/app", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ================= Telegram helpers =================
const tg = (method) => `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;

async function tgCall(method, payload) {
  const r = await fetch(tg(method), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await r.json().catch(() => ({}));
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

async function answerCallbackQuery(id) {
  return tgCall("answerCallbackQuery", { callback_query_id: id });
}

async function sendDocumentByUrl(chatId, fileUrl, caption) {
  return tgCall("sendDocument", {
    chat_id: chatId,
    document: fileUrl,
    caption,
    parse_mode: "HTML",
  });
}

function mainMenu(isPro) {
  return {
    inline_keyboard: [
      [{ text: "🔎 Проверить ИНН", callback_data: "CHECK_INN" }],
      [{ text: isPro ? "💎 PRO: активен" : "💎 Тариф PRO", callback_data: "PRICING" }],
      [{ text: "📄 Скачать отчёт PDF", callback_data: "LAST_PDF" }],
      [{ text: "ℹ️ Что проверяю?", callback_data: "ABOUT" }],
      [{ text: "🆘 Поддержка", callback_data: "SUPPORT" }]
    ],
  };
}

// ================= Utils =================
function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function isInn(text) {
  const s = String(text || "").trim();
  return /^\d{10}$/.test(s) || /^\d{12}$/.test(s);
}

function nowIso() {
  return new Date().toISOString();
}

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) out[k] = obj?.[k];
  return out;
}

// ================= Supabase data layer =================
async function ensureUser(from) {
  if (!sb) return { tg_user_id: from.id, plan: "free", pro_until: null };

  const payload = {
    tg_user_id: from.id,
    tg_username: from.username || null,
    first_name: from.first_name || null,
    last_name: from.last_name || null,
    plan: "free",
    pro_until: null,
    updated_at: nowIso(),
  };

  const { data, error } = await sb
    .from("bot_users")
    .upsert(payload, { onConflict: "tg_user_id" })
    .select("*")
    .single();

  if (error) throw error;
  return data;
}

function isPro(user) {
  if (!user) return false;
  if (user.plan !== "pro") return false;
  if (!user.pro_until) return true;
  return new Date(user.pro_until).getTime() > Date.now();
}

async function getDailyUsed(tg_user_id) {
  if (!sb) return 0;
  const day = todayIsoDate();
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
  const day = todayIsoDate();

  const used = (await getDailyUsed(tg_user_id)) + 1;
  const { error } = await sb
    .from("bot_quota_daily")
    .upsert({ tg_user_id, day, used, updated_at: nowIso() }, { onConflict: "tg_user_id,day" });

  if (error) throw error;
}

async function saveLastReportId(tg_user_id, report_id) {
  if (!sb) return;
  await sb.from("bot_users").update({ last_report_id: report_id, updated_at: nowIso() }).eq("tg_user_id", tg_user_id);
}

async function getLastReportId(tg_user_id) {
  if (!sb) return null;
  const { data, error } = await sb
    .from("bot_users")
    .select("last_report_id")
    .eq("tg_user_id", tg_user_id)
    .maybeSingle();

  if (error) throw error;
  return data?.last_report_id || null;
}

async function insertReport(row) {
  if (!sb) return null;
  const { data, error } = await sb.from("reports").insert(row).select("*").single();
  if (error) throw error;
  return data;
}

async function getReport(reportId) {
  if (!sb) return null;
  const { data, error } = await sb.from("reports").select("*").eq("id", reportId).maybeSingle();
  if (error) throw error;
  return data || null;
}

// ================= Checko provider =================
async function fetchCheckoByInn(inn) {
  if (!CHECKO_API_KEY) {
    return { ok: false, warning: "CHECKO_API_KEY не задан. Сейчас демо-режим." };
  }

  const url =
    `https://api.checko.ru/v2/company?key=${encodeURIComponent(CHECKO_API_KEY)}` +
    `&inn=${encodeURIComponent(inn)}`;

  const r = await fetch(url, { method: "GET" });
  const data = await r.json().catch(() => ({}));

  if (!r.ok) return { ok: false, error: `HTTP ${r.status}`, raw: data };

  // У Checko структуры могут отличаться по тарифу.
  // Мы ничего “не выдумываем”, просто сохраняем raw и вытаскиваем популярные поля если есть.
  return { ok: true, raw: data };
}

function normalizeChecko(raw) {
  // максимально мягкий парсинг: достаём “что получится”
  // часто полезные куски находятся в raw.data или raw.data[0] — зависит от формата
  const root = raw?.data ?? raw;
  const first = Array.isArray(root) ? root[0] : root;

  const name = first?.name || first?.fullName || first?.shortName;
  const ogrn = first?.ogrn;
  const kpp = first?.kpp;
  const status = first?.status || first?.state;
  const address = first?.address || first?.legalAddress;
  const ceo = first?.ceo || first?.director || first?.head;
  const regDate = first?.regDate || first?.registrationDate;

  return {
    name,
    ogrn,
    kpp,
    status,
    address,
    ceo,
    regDate,
    raw_min: pick(first, ["inn", "name", "ogrn", "kpp", "status"]),
  };
}

// ================= OpenAI interpretation =================
async function interpretWithAI({ inn, normalized, raw }) {
  if (!openai) {
    return {
      summary: "AI-интерпретация отключена (нет OPENAI_API_KEY).",
      risk_score: null,
      red_flags: [],
    };
  }

  // Важно: мы не просим “галлюцинировать”, только интерпретировать то, что есть.
  const prompt = {
    inn,
    company: normalized,
    note: "Интерпретируй только предоставленные поля. Если данных не хватает — так и скажи.",
    raw_hint_keys: Object.keys(raw || {}).slice(0, 40),
  };

  const resp = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    temperature: 0.2,
    messages: [
      {
        role: "system",
        content:
          "Ты аналитик по проверке контрагентов. Дай краткое заключение на русском: 1) что за организация, 2) ключевые наблюдения, 3) осторожные красные флаги только из данных, 4) оценка риска 0..100 если возможно. Никаких выдумок.",
      },
      { role: "user", content: JSON.stringify(prompt) },
    ],
  });

  const text = resp.choices?.[0]?.message?.content?.trim() || "";
  // Мы не парсим строго — в Telegram выводим текст как есть.
  return {
    summary: text,
    risk_score: null,
    red_flags: [],
  };
}

// ================= Render Telegram text =================
function renderPremiumTelegram({ inn, normalized, aiText, isProUser }) {
  const lines = [];
  lines.push(`✅ <b>Проверка контрагента</b>`);
  lines.push(`ИНН: <code>${inn}</code>`);
  lines.push("");

  if (normalized?.name) lines.push(`🏢 <b>${escapeHtml(normalized.name)}</b>`);
  if (normalized?.ogrn) lines.push(`🧾 ОГРН: <code>${escapeHtml(normalized.ogrn)}</code>`);
  if (normalized?.kpp) lines.push(`🏷 КПП: <code>${escapeHtml(normalized.kpp)}</code>`);
  if (normalized?.status) lines.push(`📌 Статус: ${escapeHtml(normalized.status)}`);
  if (normalized?.regDate) lines.push(`🗓 Дата регистрации: ${escapeHtml(normalized.regDate)}`);
  if (normalized?.ceo) lines.push(`👤 Руководитель: ${escapeHtml(typeof normalized.ceo === "string" ? normalized.ceo : JSON.stringify(normalized.ceo))}`);
  if (normalized?.address) lines.push(`📍 Адрес: ${escapeHtml(typeof normalized.address === "string" ? normalized.address : JSON.stringify(normalized.address))}`);

  lines.push("");
  if (aiText) {
    lines.push(`🧠 <b>Интерпретация</b>`);
    lines.push(escapeHtml(aiText).slice(0, 3500)); // Telegram limit safety
  } else {
    lines.push(`🧠 <i>Интерпретация недоступна.</i>`);
  }

  lines.push("");
  lines.push(`📄 <i>Можно сформировать PDF-отчёт (кнопка ниже).</i>`);
  if (!isProUser) {
    lines.push(`💎 <i>PRO: безлимит + расширенные флаги/история/экспорт.</i>`);
  }

  return lines.join("\n");
}

// ================= PDF generator =================
function generatePdfBuffer({ reportId, inn, normalized, aiText }) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "A4", margin: 50 });
      const chunks = [];
      doc.on("data", (c) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));

      // Header
      doc.fontSize(18).text("Отчёт проверки контрагента", { align: "left" });
      doc.moveDown(0.5);
      doc.fontSize(10).fillColor("gray").text(`Сервис: ProverkaBiz`, { align: "left" });
      doc.text(`ID отчёта: ${reportId}`, { align: "left" });
      doc.text(`Дата/время: ${new Date().toLocaleString("ru-RU")}`, { align: "left" });
      doc.moveDown(1);
      doc.fillColor("black");

      // Stamp-like note (не “официальный”, а “отметка сервиса”)
      doc
        .fontSize(12)
        .text("Отметка сервиса: ПРОВЕРЕНО (информационный отчёт, не является документом ФНС)", {
          align: "left",
        });

      doc.moveDown(1);

      doc.fontSize(14).text(`ИНН: ${inn}`);
      if (normalized?.name) doc.fontSize(14).text(normalized.name);
      doc.moveDown(0.5);

      doc.fontSize(11);
      const rows = [
        ["ОГРН", normalized?.ogrn],
        ["КПП", normalized?.kpp],
        ["Статус", normalized?.status],
        ["Дата регистрации", normalized?.regDate],
        ["Руководитель", typeof normalized?.ceo === "string" ? normalized.ceo : normalized?.ceo ? JSON.stringify(normalized.ceo) : ""],
        ["Адрес", typeof normalized?.address === "string" ? normalized.address : normalized?.address ? JSON.stringify(normalized.address) : ""],
      ].filter((x) => x[1]);

      rows.forEach(([k, v]) => {
        doc.fillColor("gray").text(`${k}:`, { continued: true });
        doc.fillColor("black").text(` ${String(v)}`);
      });

      doc.moveDown(1);

      doc.fontSize(12).text("Интерпретация (AI):", { underline: true });
      doc.moveDown(0.5);
      doc.fontSize(10).fillColor("black").text(aiText || "Интерпретация недоступна (нет ключа OpenAI).", {
        align: "left",
      });

      doc.moveDown(1);
      doc.fillColor("gray").fontSize(9).text(
        "Источник данных: Checko (по ключу API). Отчёт предназначен для внутренней оценки добросовестности контрагента.",
        { align: "left" }
      );

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

// ================= Paywall / PRO =================
function pricingText() {
  return [
    `💎 <b>PRO подписка</b>`,
    ``,
    `Что будет в PRO:`,
    `• безлимит проверок`,
    `• расширенные “красные флаги”`,
    `• история проверок`,
    `• PDF-отчёты по шаблону`,
    ``,
    `Оплату подключим следующим шагом (ЮKassa/CloudPayments).`,
    `Пока можно включать PRO вручную админ-командой.`,
  ].join("\n");
}

// /grant <tg_user_id> <days>
async function handleAdminGrant(text, chatId, fromId) {
  const ADMIN_IDS = (process.env.ADMIN_IDS || "").split(",").map(s => s.trim()).filter(Boolean);
  if (!ADMIN_IDS.includes(String(fromId))) return false;

  const parts = text.trim().split(/\s+/);
  if (parts[0] !== "/grant") return false;

  const tgUserId = Number(parts[1]);
  const days = Number(parts[2] || 30);
  if (!tgUserId || !days) {
    await sendMessage(chatId, "Формат: <code>/grant 123456789 30</code>");
    return true;
  }
  if (!sb) {
    await sendMessage(chatId, "Supabase не подключен — выдача PRO невозможна.");
    return true;
  }

  const proUntil = new Date(Date.now() + days * 24 * 3600 * 1000).toISOString();
  const { error } = await sb.from("bot_users").update({ plan: "pro", pro_until: proUntil, updated_at: nowIso() }).eq("tg_user_id", tgUserId);
  if (error) {
    await sendMessage(chatId, `Ошибка: ${escapeHtml(error.message)}`);
    return true;
  }
  await sendMessage(chatId, `✅ Выдал PRO пользователю <code>${tgUserId}</code> на ${days} дней.`);
  return true;
}

// ================= Webhook =================
app.post("/webhook", async (req, res) => {
  // быстро отвечаем телеге
  res.status(200).json({ ok: true });

  try {
    // секретный заголовок телеги (если используешь)
    if (WEBHOOK_SECRET) {
      const secret = req.header("X-Telegram-Bot-Api-Secret-Token");
      if (secret !== WEBHOOK_SECRET) return;
    }

    const update = req.body;

    // callbacks
    if (update.callback_query) {
      const cq = update.callback_query;
      const chatId = cq.message?.chat?.id;
      const from = cq.from;
      const data = cq.data;

      if (!chatId || !from) return;

      const user = await ensureUser(from);
      const pro = isPro(user);

      await answerCallbackQuery(cq.id);

      if (data === "CHECK_INN") {
        await sendMessage(chatId, "Пришли ИНН (10 или 12 цифр) одним сообщением.", { reply_markup: mainMenu(pro) });
        return;
      }

      if (data === "PRICING") {
        await sendMessage(chatId, pricingText(), { reply_markup: mainMenu(pro) });
        return;
      }

      if (data === "ABOUT") {
        await sendMessage(
          chatId,
          [
            `ℹ️ <b>Что я проверяю</b>`,
            ``,
            `• реквизиты и статус (по данным Checko)`,
            `• адрес, руководитель (если есть в источнике)`,
            `• AI-интерпретация результата`,
            `• PDF-отчёт по кнопке`,
          ].join("\n"),
          { reply_markup: mainMenu(pro) }
        );
        return;
      }

      if (data === "SUPPORT") {
        await sendMessage(chatId, `🆘 Поддержка:\nНапиши сюда, что нужно улучшить.`, { reply_markup: mainMenu(pro) });
        return;
      }

      if (data === "LAST_PDF") {
        if (!sb) {
          await sendMessage(chatId, "PDF-отчёты доступны после подключения Supabase.", { reply_markup: mainMenu(pro) });
          return;
        }
        const lastId = await getLastReportId(from.id);
        if (!lastId) {
          await sendMessage(chatId, "Пока нет последнего отчёта. Сначала проверь ИНН.", { reply_markup: mainMenu(pro) });
          return;
        }
        const fileUrl = `${APP_URL}/reports/${lastId}.pdf`;
        await sendDocumentByUrl(chatId, fileUrl, `📄 Отчёт PDF (ID: ${lastId})`);
        return;
      }

      return;
    }

    // messages
    if (update.message) {
      const msg = update.message;
      const chatId = msg.chat?.id;
      const from = msg.from;
      const text = (msg.text || "").trim();

      if (!chatId || !from) return;

      // admin /grant
      if (text.startsWith("/grant")) {
        const handled = await handleAdminGrant(text, chatId, from.id);
        if (handled) return;
      }

      const user = await ensureUser(from);
      const pro = isPro(user);

      if (text === "/start") {
        await sendMessage(
          chatId,
          [
            `👋 Привет!`,
            `Я делаю <b>проверку контрагентов по ИНН</b> и формирую отчёт.`,
            ``,
            `✅ Free: ${FREE_DAILY_LIMIT} проверки в день`,
            `💎 PRO: безлимит + расширенные флаги + история + PDF`,
            ``,
            `Нажми кнопку или пришли ИНН.`,
          ].join("\n"),
          { reply_markup: mainMenu(pro) }
        );
        return;
      }

      if (!text) return;

      if (!isInn(text)) {
        await sendMessage(chatId, "Пришли ИНН (10 или 12 цифр).", { reply_markup: mainMenu(pro) });
        return;
      }

      // limits
      if (!pro && HAS_SB) {
        const used = await getDailyUsed(from.id);
        if (used >= FREE_DAILY_LIMIT) {
          await sendMessage(chatId, `⛔ Лимит исчерпан: ${FREE_DAILY_LIMIT}/день.\n\n💎 В PRO будет безлимит.`, { reply_markup: mainMenu(pro) });
          return;
        }
      }

      const inn = text;

      await sendMessage(chatId, `⏳ Проверяю ИНН <code>${inn}</code>...`, { reply_markup: mainMenu(pro) });

      const checko = await fetchCheckoByInn(inn);
      if (!checko.ok && checko.warning) {
        await sendMessage(chatId, `⚠️ ${escapeHtml(checko.warning)}`, { reply_markup: mainMenu(pro) });
        if (HAS_SB && !pro) await incDailyUsed(from.id);
        return;
      }
      if (!checko.ok) {
        await sendMessage(chatId, `⚠️ Ошибка Checko: ${escapeHtml(checko.error || "неизвестно")}`, { reply_markup: mainMenu(pro) });
        if (HAS_SB && !pro) await incDailyUsed(from.id);
        return;
      }

      const normalized = normalizeChecko(checko.raw);

      // AI interpretation
      const ai = await interpretWithAI({ inn, normalized, raw: checko.raw });
      const aiText = ai?.summary || "";

      const telegramText = renderPremiumTelegram({
        inn,
        normalized,
        aiText,
        isProUser: pro,
      });

      await sendMessage(chatId, telegramText, { reply_markup: mainMenu(pro) });

      // save report
      if (HAS_SB) {
        const report = await insertReport({
          tg_user_id: from.id,
          inn,
          checko_raw: checko.raw,
          normalized,
          ai_text: aiText,
          created_at: nowIso(),
        });
        await saveLastReportId(from.id, report.id);

        if (!pro) await incDailyUsed(from.id);
      }

      return;
    }
  } catch (e) {
    console.error("Webhook error:", e);
  }
});

// ================= PDF endpoint =================
app.get("/reports/:id.pdf", async (req, res) => {
  try {
    if (!sb) return res.status(400).send("Supabase is not configured");

    const reportId = req.params.id;
    const report = await getReport(reportId);
    if (!report) return res.status(404).send("Report not found");

    const buf = await generatePdfBuffer({
      reportId,
      inn: report.inn,
      normalized: report.normalized,
      aiText: report.ai_text,
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="report-${reportId}.pdf"`);
    res.status(200).send(buf);
  } catch (e) {
    console.error("PDF error:", e);
    res.status(500).send("PDF error");
  }
});

// ================= Auto webhook on startup =================
async function ensureWebhook() {
  if (!APP_URL) {
    console.log("APP_URL/PUBLIC_URL missing, webhook setup skipped");
    return;
  }
  const url = `${APP_URL}/webhook`;
  try {
    await tgCall("setWebhook", {
      url,
      secret_token: WEBHOOK_SECRET || undefined,
      drop_pending_updates: false,
    });
    console.log("✅ Webhook set:", url);
  } catch (e) {
    console.error("❌ setWebhook failed:", e?.message || e);
  }
}

app.listen(PORT, async () => {
  console.log("Server started on port", PORT);
  console.log("Supabase:", HAS_SB ? "enabled" : "disabled");
  await ensureWebhook();
});
