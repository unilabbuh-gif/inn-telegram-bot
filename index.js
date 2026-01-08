import express from "express";
import TelegramBot from "node-telegram-bot-api";
import { createClient } from "@supabase/supabase-js";

const PORT = process.env.PORT || 10000;

const BOT_TOKEN = process.env.BOT_TOKEN || "";
const PUBLIC_URL = process.env.PUBLIC_URL || "";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const CHECKO_API_KEY = process.env.CHECKO_API_KEY || "";

const TZ_OFFSET_MINUTES = Number(process.env.TZ_OFFSET_MINUTES || "300"); // +5 по умолчанию

function fatal(msg) {
  console.error("FATAL:", msg);
  process.exit(1);
}

if (!SUPABASE_URL) fatal("SUPABASE_URL is required");
if (!SUPABASE_SERVICE_ROLE_KEY) fatal("SUPABASE_SERVICE_ROLE_KEY is required");
// BOT_TOKEN может быть пустым — тогда сервис просто живёт как healthcheck

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/", (_req, res) => res.status(200).send("OK"));
app.get("/health", (_req, res) => res.status(200).json({ ok: true }));

function nowIso() {
  return new Date().toISOString();
}

function dayKeyLocal(d = new Date()) {
  // Сдвигаем время на TZ_OFFSET_MINUTES и берём дату (YYYY-MM-DD)
  const ms = d.getTime() + TZ_OFFSET_MINUTES * 60_000;
  return new Date(ms).toISOString().slice(0, 10);
}

function isValidInn(text) {
  return /^[0-9]{10}$/.test(text) || /^[0-9]{12}$/.test(text);
}

function escapeMd(s) {
  return String(s || "")
    .replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");
}

async function ensureUser(tgUser) {
  const tg_user_id = Number(tgUser.id);
  const tg_username = tgUser.username || null;
  const first_name = tgUser.first_name || null;
  const last_name = tgUser.last_name || null;

  const { data: existing, error: selErr } = await sb
    .from("bot_users")
    .select("tg_user_id, tg_username, first_name, last_name, plan, pro_until")
    .eq("tg_user_id", tg_user_id)
    .maybeSingle();

  if (selErr) {
    console.error("ensureUser select error:", selErr);
    return { tg_user_id, plan: "free", pro_until: null };
  }

  if (!existing) {
    const { error: insErr } = await sb.from("bot_users").insert({
      tg_user_id,
      tg_username,
      first_name,
      last_name,
      plan: "free",
      free_checks_left: 3,
      pro_until: null,
    });
    if (insErr) console.error("ensureUser insert error:", insErr);
    return { tg_user_id, plan: "free", pro_until: null };
  }

  // обновим профиль (без фанатизма)
  const { error: updErr } = await sb
    .from("bot_users")
    .update({ tg_username, first_name, last_name })
    .eq("tg_user_id", tg_user_id);

  if (updErr) console.warn("ensureUser update warn:", updErr);

  return existing;
}

function isProActive(userRow) {
  if (!userRow) return false;
  if (userRow.plan !== "pro") return false;
  if (!userRow.pro_until) return false;
  const until = new Date(userRow.pro_until).getTime();
  return Number.isFinite(until) && until > Date.now();
}

async function quotaCheckAndConsume(tg_user_id, isPro) {
  if (isPro) return { ok: true, remaining: Infinity, used: 0, limit: Infinity };

  const day = dayKeyLocal(); // YYYY-MM-DD
  const limit = 3;

  const { data: row, error: selErr } = await sb
    .from("bot_quota_daily")
    .select("used")
    .eq("tg_user_id", tg_user_id)
    .eq("day", day)
    .maybeSingle();

  if (selErr) {
    console.error("quota select error:", selErr);
    // если база глючит — лучше не блочить пользователя жестко
    return { ok: true, remaining: 1, used: 0, limit };
  }

  const used = row?.used ?? 0;
  if (used >= limit) return { ok: false, remaining: 0, used, limit };

  // атомарно: upsert used+1 (через update/insert)
  if (row) {
    const { error: updErr } = await sb
      .from("bot_quota_daily")
      .update({ used: used + 1 })
      .eq("tg_user_id", tg_user_id)
      .eq("day", day);
    if (updErr) console.error("quota update error:", updErr);
  } else {
    const { error: insErr } = await sb.from("bot_quota_daily").insert({
      tg_user_id,
      day,
      used: 1,
    });
    if (insErr) console.error("quota insert error:", insErr);
  }

  return { ok: true, remaining: limit - (used + 1), used: used + 1, limit };
}

async function getCachedInn(inn) {
  const { data, error } = await sb.from("inn_cache").select("result, updated_at").eq("inn", inn).maybeSingle();
  if (error) {
    console.warn("cache select warn:", error);
    return null;
  }
  if (!data) return null;

  // кэш живёт 24 часа
  const ageMs = Date.now() - new Date(data.updated_at).getTime();
  if (Number.isFinite(ageMs) && ageMs <= 24 * 60 * 60 * 1000) return data.result;

  return null;
}

async function setCachedInn(inn, result) {
  const { error } = await sb.from("inn_cache").upsert({
    inn,
    result,
    updated_at: nowIso(),
  });
  if (error) console.warn("cache upsert warn:", error);
}

async function logInnCheck({ tg_user_id, inn, provider, result }) {
  const { error } = await sb.from("inn_checks").insert({
    tg_user_id,
    inn,
    provider,
    result,
  });
  if (error) console.warn("inn_checks insert warn:", error);
}

function pickCompanyInfo(payload) {
  // Структуры у провайдеров разные — делаем “робастно”
  const data = payload?.data || payload; // иногда API заворачивает
  const company =
    data?.company ||
    data?.suggestions?.[0]?.data ||
    data?.items?.[0] ||
    data;

  const name =
    company?.name?.full_with_opf ||
    company?.name?.full ||
    company?.short_name ||
    company?.name ||
    company?.full_name;

  const ogrn = company?.ogrn || company?.OGRN;
  const inn = company?.inn || company?.INN;
  const kpp = company?.kpp || company?.KPP;
  const status = company?.status || company?.state?.status || company?.state;
  const address =
    company?.address?.value ||
    company?.address?.unrestricted_value ||
    company?.address ||
    company?.legal_address;

  const okved = company?.okved || company?.okveds?.[0]?.code;
  const ceo =
    company?.management?.name ||
    company?.director?.name ||
    company?.ceo ||
    company?.boss;

  return { name, inn, kpp, ogrn, status, address, okved, ceo, raw: payload };
}

async function fetchCheckoCompany(inn) {
  if (!CHECKO_API_KEY) {
    return { error: "CHECKO_API_KEY не задан. Провайдер отключен." };
  }
  const url =
    `https://api.checko.ru/v2/company?` +
    `key=${encodeURIComponent(CHECKO_API_KEY)}` +
    `&inn=${encodeURIComponent(inn)}`;

  const r = await fetch(url, { method: "GET" });
  const data = await r.json().catch(() => ({}));

  if (!r.ok) {
    return { error: "Checko вернул ошибку", http: r.status, data };
  }
  if (data?.error) return { error: "Checko error", data };

  return data;
}

function mainKeyboard() {
  return {
    reply_markup: {
      keyboard: [
        [{ text: "🔎 Проверить ИНН" }],
        [{ text: "💎 Тариф PRO" }, { text: "❓ Что я проверяю?" }],
        [{ text: "🆘 Поддержка" }],
      ],
      resize_keyboard: true,
    },
  };
}

function proKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: "💎 Купить PRO (позже подключим оплату)", callback_data: "pro_buy" }],
        [{ text: "⬅️ Назад", callback_data: "back" }],
      ],
    },
  };
}

function formatCompanyMessage(info, cached) {
  const lines = [];
  lines.push(`🏢 *${escapeMd(info.name || "Компания")}*`);
  if (info.inn) lines.push(`• ИНН: *${escapeMd(info.inn)}*`);
  if (info.kpp) lines.push(`• КПП: *${escapeMd(info.kpp)}*`);
  if (info.ogrn) lines.push(`• ОГРН: *${escapeMd(info.ogrn)}*`);
  if (info.status) lines.push(`• Статус: ${escapeMd(JSON.stringify(info.status))}`);
  if (info.okved) lines.push(`• ОКВЭД: ${escapeMd(info.okved)}`);
  if (info.ceo) lines.push(`• Руководитель: ${escapeMd(info.ceo)}`);
  if (info.address) lines.push(`• Адрес: ${escapeMd(typeof info.address === "string" ? info.address : JSON.stringify(info.address))}`);

  lines.push("");
  lines.push(cached ? "⚡️ Из кэша (до 24ч)" : "🆕 Свежая проверка");

  return lines.join("\n");
}

// --- Telegram bot part ---
let bot = null;

if (BOT_TOKEN) {
  bot = new TelegramBot(BOT_TOKEN, { webHook: true });

  app.post("/webhook", async (req, res) => {
    try {
      await bot.processUpdate(req.body);
      res.sendStatus(200);
    } catch (e) {
      console.error("processUpdate error:", e);
      res.sendStatus(200);
    }
  });

  (async () => {
    try {
      if (!PUBLIC_URL) {
        console.warn("PUBLIC_URL missing, webhook not set");
        return;
      }
      await bot.setWebHook(`${PUBLIC_URL.replace(/\/$/, "")}/webhook`);
      console.log(`[${nowIso()}] Webhook set: ${PUBLIC_URL}/webhook`);
    } catch (e) {
      console.error("setWebHook error:", e);
    }
  })();

  bot.onText(/\/start/, async (msg) => {
    const user = await ensureUser(msg.from);
    const isPro = isProActive(user);

    const text =
      "Привет! Я проверяю контрагентов по ИНН.\n\n" +
      "Пришли ИНН (10 или 12 цифр) одним сообщением.\n" +
      `Лимит free: 3 проверки в день.\n` +
      (isPro ? "💎 У тебя активен PRO ✅" : "💎 PRO: безлимит + история + отчёты (подключим оплату).");

    await bot.sendMessage(msg.chat.id, text, { parse_mode: "Markdown", ...mainKeyboard() });
  });

  bot.on("message", async (msg) => {
    try {
      if (!msg.text) return;

      const chatId = msg.chat.id;
      const text = msg.text.trim();

      // кнопки-слова
      if (text === "🔎 Проверить ИНН") {
        await bot.sendMessage(chatId, "Ок. Пришли ИНН (10 или 12 цифр) одним сообщением.", mainKeyboard());
        return;
      }
      if (text === "💎 Тариф PRO") {
        await bot.sendMessage(
          chatId,
          "💎 *PRO* — безлимитные проверки + история + риск-флаги + экспорт отчётов.\nПока подключение оплаты делаем. Напиши в поддержку — включу вручную.",
          { parse_mode: "Markdown", ...proKeyboard() }
        );
        return;
      }
      if (text === "❓ Что я проверяю?") {
        await bot.sendMessage(
          chatId,
          "Что сейчас выдаю по ИНН:\n" +
            "• наименование\n• статус\n• адрес\n• ОГРН/КПП\n• ОКВЭД\n\n" +
            "Дальше можно докрутить: риск-флаги, арбитраж, банкротства, лицензии, связи и т.д.",
          mainKeyboard()
        );
        return;
      }
      if (text === "🆘 Поддержка") {
        await bot.sendMessage(chatId, "Напиши сюда, что не работает — и приложи ИНН/скрин. Я разберу.", mainKeyboard());
        return;
      }

      // ИНН
      if (!isValidInn(text)) return; // молча игнорим мусор, чтобы не спамить

      const inn = text;
      const user = await ensureUser(msg.from);
      const pro = isProActive(user);

      const quota = await quotaCheckAndConsume(Number(user.tg_user_id), pro);
      if (!quota.ok) {
        await bot.sendMessage(
          chatId,
          "⛔️ Лимит на сегодня исчерпан: 3 проверки.\n💎 В PRO будет безлимит + история.\n\nНажми «Тариф PRO» или попробуй завтра.",
          mainKeyboard()
        );
        return;
      }

      await bot.sendMessage(chatId, `🔎 Проверяю ИНН ${inn}…`);

      // cache
      const cached = await getCachedInn(inn);
      if (cached) {
        const info = pickCompanyInfo(cached);
        await logInnCheck({ tg_user_id: Number(user.tg_user_id), inn, provider: "cache", result: cached });
        await bot.sendMessage(chatId, formatCompanyMessage(info, true), { parse_mode: "Markdown", ...mainKeyboard() });
        return;
      }

      // provider
      const raw = await fetchCheckoCompany(inn);
      if (raw?.error) {
        await logInnCheck({ tg_user_id: Number(user.tg_user_id), inn, provider: "checko", result: raw });
        await bot.sendMessage(chatId, `⚠️ Не получилось проверить: ${raw.error}`, mainKeyboard());
        return;
      }

      await setCachedInn(inn, raw);
      await logInnCheck({ tg_user_id: Number(user.tg_user_id), inn, provider: "checko", result: raw });

      const info = pickCompanyInfo(raw);
      await bot.sendMessage(chatId, formatCompanyMessage(info, false), { parse_mode: "Markdown", ...mainKeyboard() });
    } catch (e) {
      console.error("message handler error:", e);
      try {
        await bot.sendMessage(msg.chat.id, "⚠️ Внутренняя ошибка. Я записал лог и разберусь.", mainKeyboard());
      } catch {}
    }
  });

  bot.on("callback_query", async (q) => {
    try {
      const chatId = q.message?.chat?.id;
      if (!chatId) return;

      if (q.data === "back") {
        await bot.sendMessage(chatId, "Ок, вернулись в меню.", mainKeyboard());
      }
      if (q.data === "pro_buy") {
        await bot.sendMessage(
          chatId,
          "Оплату сейчас подключаем. Пока проще так: напиши в поддержку — включу PRO вручную для теста.",
          mainKeyboard()
        );
      }

      await bot.answerCallbackQuery(q.id).catch(() => {});
    } catch (e) {
      console.error("callback error:", e);
    }
  });

  console.log(`[${nowIso()}] Bot enabled`);
} else {
  console.log(`[${nowIso()}] BOT_TOKEN missing — running in healthcheck-only mode`);
}

app.listen(PORT, () => {
  console.log(`[${nowIso()}] Server started on port ${PORT}`);
});
