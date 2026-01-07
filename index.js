/**
 * ProverkaBiz Bot (Telegram) — production-ish single-file version
 * - Webhook server for Render
 * - Supabase storage (users, quotas, checks, cache)
 * - Providers: DaData, Checko
 * - Free limits + PRO gating
 * - Stable error handling, logging, retries, timeouts
 *
 * Node 18+ (Render ok). ESM module.
 */

import http from "http";
import { URL } from "url";
import crypto from "crypto";

/* =========================
   CONFIG
========================= */

const CFG = {
  BOT_TOKEN: process.env.BOT_TOKEN || "",
  PUBLIC_URL: (process.env.PUBLIC_URL || "").replace(/\/+$/, ""),
  PORT: Number(process.env.PORT || 10000),

  // Providers
  DADATA_TOKEN: process.env.DADATA_TOKEN || "",
  CHECKO_API_KEY: process.env.CHECKO_API_KEY || "",

  // Supabase (optional but recommended)
  SUPABASE_URL: process.env.SUPABASE_URL || "",
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY || "",

  // Limits
  FREE_DAILY_LIMIT: Number(process.env.FREE_DAILY_LIMIT || 3), // free checks per day per user
  CACHE_TTL_HOURS: Number(process.env.CACHE_TTL_HOURS || 24), // cache by INN

  // App
  APP_NAME: process.env.APP_NAME || "ProverkaBiz",
  SUPPORT_TEXT: process.env.SUPPORT_TEXT || "Напиши сюда, что сломалось / что нужно добавить — помогу.",
  TIMEOUT_MS: Number(process.env.TIMEOUT_MS || 12000),
  RETRIES: Number(process.env.RETRIES || 1),
  LOG_LEVEL: process.env.LOG_LEVEL || "info", // info|debug|warn|error
};

// Basic config sanity
if (!CFG.BOT_TOKEN) {
  console.error("FATAL: BOT_TOKEN is required");
  process.exit(1);
}
if (!CFG.PUBLIC_URL) {
  console.warn("WARN: PUBLIC_URL is not set. Webhook setup will be skipped.");
}

const HAS_SB = Boolean(CFG.SUPABASE_URL && CFG.SUPABASE_SERVICE_ROLE_KEY);

/* =========================
   LOGGING
========================= */

const levels = { debug: 10, info: 20, warn: 30, error: 40 };
const curLevel = levels[CFG.LOG_LEVEL] ?? 20;

function log(level, ...args) {
  if ((levels[level] ?? 20) < curLevel) return;
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${level.toUpperCase()}]`, ...args);
}

/* =========================
   UTILS
========================= */

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function isInn(text) {
  const s = (text || "").trim();
  return /^\d{10}$/.test(s) || /^\d{12}$/.test(s);
}

function todayISO() {
  // YYYY-MM-DD in UTC
  return new Date().toISOString().slice(0, 10);
}

function sha1(s) {
  return crypto.createHash("sha1").update(String(s)).digest("hex");
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

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...options, signal: controller.signal });
    return resp;
  } finally {
    clearTimeout(id);
  }
}

async function withRetries(fn, retries = 0) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn(i);
    } catch (e) {
      lastErr = e;
      if (i < retries) await sleep(250 * (i + 1));
    }
  }
  throw lastErr;
}

/* =========================
   TELEGRAM API
========================= */

const tgUrl = (method) => `https://api.telegram.org/bot${CFG.BOT_TOKEN}/${method}`;

async function tgCall(method, payload) {
  return withRetries(async () => {
    const r = await fetchWithTimeout(
      tgUrl(method),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
      CFG.TIMEOUT_MS
    );

    const data = await r.json().catch(() => ({}));
    if (!data.ok) {
      throw new Error(`Telegram ${method} failed: ${JSON.stringify(data)}`);
    }
    return data.result;
  }, CFG.RETRIES);
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

async function setWebhook() {
  if (!CFG.PUBLIC_URL) return;
  const hook = `${CFG.PUBLIC_URL}/webhook`;

  try {
    const r = await tgCall("setWebhook", { url: hook });
    log("info", "Webhook set:", hook, r);
  } catch (e) {
    log("warn", "Webhook set failed:", e.message);
  }
}

/* =========================
   SUPABASE REST (no deps)
   Uses service_role key, so keep it secret!
========================= */

const SB = {
  base: CFG.SUPABASE_URL.replace(/\/+$/, ""),
  key: CFG.SUPABASE_SERVICE_ROLE_KEY,
};

async function sbFetch(path, { method = "GET", headers = {}, body } = {}) {
  if (!HAS_SB) throw new Error("Supabase not configured");
  const url = `${SB.base}${path}`;

  const r = await fetchWithTimeout(
    url,
    {
      method,
      headers: {
        apikey: SB.key,
        Authorization: `Bearer ${SB.key}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    },
    CFG.TIMEOUT_MS
  );

  const txt = await r.text();
  let data;
  try {
    data = txt ? JSON.parse(txt) : null;
  } catch {
    data = txt;
  }
  if (!r.ok) {
    throw new Error(`Supabase error ${r.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
  }
  return data;
}

async function sbUpsert(table, row, onConflict) {
  const q = `?on_conflict=${encodeURIComponent(onConflict)}`;
  return sbFetch(`/rest/v1/${table}${q}`, {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: row,
  });
}

async function sbSelect(table, queryString) {
  return sbFetch(`/rest/v1/${table}${queryString}`, { method: "GET" });
}

async function sbInsert(table, row) {
  return sbFetch(`/rest/v1/${table}`, { method: "POST", body: row });
}

/* =========================
   DB HELPERS
========================= */

async function ensureUser(tgUser) {
  // tgUser: { id, username, first_name, last_name }
  if (!HAS_SB) return { plan: "free", pro_until: null };

  const row = {
    tg_user_id: String(tgUser.id),
    username: tgUser.username || null,
    first_name: tgUser.first_name || null,
    last_name: tgUser.last_name || null,
    plan: "free",
    pro_until: null,
    updated_at: new Date().toISOString(),
  };

  const res = await sbUpsert("bot_users", row, "tg_user_id");
  return res?.[0] || row;
}

async function isProUser(user) {
  if (!user) return false;
  if (user.plan === "pro") {
    if (!user.pro_until) return true;
    return new Date(user.pro_until).getTime() > Date.now();
  }
  return false;
}

async function getDailyCount(tgUserId) {
  if (!HAS_SB) return 0;
  const day = todayISO();
  const q = `?select=cnt&tg_user_id=eq.${encodeURIComponent(String(tgUserId))}&day=eq.${day}`;
  const r = await sbSelect("bot_quota_daily", q);
  return r?.[0]?.cnt ?? 0;
}

async function incDailyCount(tgUserId) {
  if (!HAS_SB) return;
  const day = todayISO();
  const row = {
    tg_user_id: String(tgUserId),
    day,
    cnt: 1,
    updated_at: new Date().toISOString(),
  };

  // Upsert with merge: if exists, we still need increment. REST upsert cannot atomic increment.
  // We'll do: read -> write. Acceptable for small scale; later можно на SQL function.
  const current = await sbSelect("bot_quota_daily", `?select=cnt&tg_user_id=eq.${encodeURIComponent(String(tgUserId))}&day=eq.${day}`);
  const cnt = (current?.[0]?.cnt ?? 0) + 1;

  await sbUpsert("bot_quota_daily", { ...row, cnt }, "tg_user_id,day");
}

async function getCachedInn(inn) {
  if (!HAS_SB) return null;
  const q = `?select=inn,result,updated_at&inn=eq.${encodeURIComponent(inn)}&order=updated_at.desc&limit=1`;
  const r = await sbSelect("inn_cache", q);
  if (!r?.length) return null;

  const item = r[0];
  const updatedAt = new Date(item.updated_at).getTime();
  const ttlMs = CFG.CACHE_TTL_HOURS * 3600 * 1000;
  if (Date.now() - updatedAt > ttlMs) return null;

  return item.result;
}

async function saveCachedInn(inn, resultObj) {
  if (!HAS_SB) return;
  await sbUpsert(
    "inn_cache",
    {
      inn,
      result: resultObj,
      updated_at: new Date().toISOString(),
    },
    "inn"
  );
}

async function saveCheckLog({ tg_user_id, inn, kind, ok, provider, meta }) {
  if (!HAS_SB) return;
  await sbInsert("inn_checks", {
    tg_user_id: String(tg_user_id),
    inn,
    kind,
    ok: Boolean(ok),
    provider,
    meta: meta ?? null,
    created_at: new Date().toISOString(),
  });
}

/* =========================
   PROVIDERS
========================= */

async function dadataByInn(inn) {
  if (!CFG.DADATA_TOKEN) {
    return { provider: "dadata", ok: false, demo: true, message: "DADATA_TOKEN не задан (демо)." };
  }

  const url = "https://suggestions.dadata.ru/suggestions/api/4_1/rs/findById/party";
  const resp = await withRetries(
    () =>
      fetchWithTimeout(
        url,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Token ${CFG.DADATA_TOKEN}`,
            Accept: "application/json",
          },
          body: JSON.stringify({ query: inn }),
        },
        CFG.TIMEOUT_MS
      ),
    CFG.RETRIES
  );

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    return { provider: "dadata", ok: false, error: `HTTP ${resp.status}`, raw: data };
  }
  return { provider: "dadata", ok: true, raw: data };
}

async function checkoByInn(inn) {
  if (!CFG.CHECKO_API_KEY) {
    return { provider: "checko", ok: false, demo: true, message: "CHECKO_API_KEY не задан (демо)." };
  }

  const url = `https://api.checko.ru/v2/company?key=${encodeURIComponent(CFG.CHECKO_API_KEY)}&inn=${encodeURIComponent(inn)}`;

  const resp = await withRetries(
    () => fetchWithTimeout(url, { method: "GET" }, CFG.TIMEOUT_MS),
    CFG.RETRIES
  );

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    return { provider: "checko", ok: false, error: `HTTP ${resp.status}`, raw: data };
  }
  return { provider: "checko", ok: true, raw: data };
}

/**
 * PRO Risk Score — заглушка (место под “риск-баллы”).
 * Смысл: считать score + flags на основе полученных данных (или доп. источников).
 */
function computeRiskScore({ dadata, checko }) {
  // Здесь можно сделать хоть 0..100, хоть “красные флаги”.
  // Пока: демо — если нет данных, риск неизвестен.
  const flags = [];

  // Примеры эвристик (очень осторожные):
  // - у DaData state.status = "LIQUIDATED" / "BANKRUPT" -> flag
  const s = dadata?.ok && dadata?.raw?.suggestions?.[0]?.data?.state?.status;
  if (s && String(s).toUpperCase().includes("LIQ")) flags.push("Ликвидация/ликвидируется (по DaData)");
  if (s && String(s).toUpperCase().includes("BANKR")) flags.push("Признаки банкротства (по DaData)");

  // Score грубо: база 10, +40 если ликвидация, +30 если банкротство
  let score = 10;
  if (flags.some((f) => f.toLowerCase().includes("ликв"))) score += 40;
  if (flags.some((f) => f.toLowerCase().includes("банкрот"))) score += 30;
  if (score > 100) score = 100;

  return { score, flags };
}

/* =========================
   UI / MENUS
========================= */

function mainMenu(isPro) {
  const proLabel = isPro ? "💎 PRO: активен" : "💎 Тариф PRO (позже)";
  return {
    inline_keyboard: [
      [{ text: "🔎 Проверить ИНН", callback_data: "CHECK_INN" }],
      [{ text: proLabel, callback_data: "PRICING" }],
      [{ text: "📌 Что я проверяю?", callback_data: "ABOUT" }],
      [{ text: "🆘 Поддержка", callback_data: "SUPPORT" }],
    ],
  };
}

function formatResult(inn, dadata, checko, proEnabled) {
  const lines = [];
  lines.push(`✅ <b>ИНН:</b> <code>${inn}</code>`);

  // DaData (human-friendly)
  if (dadata?.ok && dadata?.raw?.suggestions?.length) {
    const s = dadata.raw.suggestions[0];
    const name = s?.value || "";
    const ogrn = s?.data?.ogrn || "";
    const kpp = s?.data?.kpp || "";
    const address = s?.data?.address?.value || "";
    const status = s?.data?.state?.status || "";
    if (name) lines.push(`🏢 <b>Организация:</b> ${escapeHtml(name)}`);
    if (ogrn) lines.push(`🧾 <b>ОГРН:</b> <code>${ogrn}</code>`);
    if (kpp) lines.push(`🏷 <b>КПП:</b> <code>${kpp}</code>`);
    if (status) lines.push(`📌 <b>Статус:</b> ${escapeHtml(status)}`);
    if (address) lines.push(`📍 <b>Адрес:</b> ${escapeHtml(address)}`);
  } else if (dadata?.demo) {
    lines.push(`ℹ️ DaData: демо (нет токена)`);
  } else if (dadata && !dadata.ok) {
    lines.push(`⚠️ DaData: ошибка (${escapeHtml(dadata.error || "неизвестно")})`);
  }

  // Checko (сырой ответ — пока просто подтверждение)
  if (checko?.ok) {
    lines.push(`✅ Checko: данные получены`);
  } else if (checko?.demo) {
    lines.push(`ℹ️ Checko: демо (нет ключа)`);
  } else if (checko && !checko.ok) {
    lines.push(`⚠️ Checko: ошибка (${escapeHtml(checko.error || "неизвестно")})`);
  }

  // PRO Risk
  if (proEnabled) {
    const { score, flags } = computeRiskScore({ dadata, checko });
    lines.push("");
    lines.push(`🧠 <b>PRO риск-балл:</b> <b>${score}/100</b>`);
    if (flags.length) {
      lines.push(`<b>Красные флаги:</b>`);
      for (const f of flags.slice(0, 8)) lines.push(`• ${escapeHtml(f)}`);
    } else {
      lines.push(`Красные флаги: не выявлены по текущим источникам.`);
    }
  } else {
    lines.push("");
    lines.push("💎 <b>PRO риск-баллы</b> включим позже (красные флаги, история, отчёт PDF).");
  }

  return lines.join("\n");
}

/* =========================
   CORE FLOW
========================= */

async function handleStart(chatId, tgUser, userRow) {
  const pro = await isProUser(userRow);
  const msg =
    `Привет! Я проверяю контрагентов по ИНН.\n\n` +
    `Пришли ИНН (10 или 12 цифр) одним сообщением.\n` +
    (HAS_SB ? `Лимит free: <b>${CFG.FREE_DAILY_LIMIT}</b> проверок в день.\n` : `Сейчас работаю без БД (лимиты/история отключены).\n`);

  await sendMessage(chatId, msg, { reply_markup: mainMenu(pro) });
}

async function handleInn(chatId, tgUser, userRow, inn) {
  const pro = await isProUser(userRow);

  // quotas
  if (HAS_SB && !pro) {
    const cnt = await getDailyCount(tgUser.id);
    if (cnt >= CFG.FREE_DAILY_LIMIT) {
      await sendMessage(
        chatId,
        `⛔️ Лимит на сегодня исчерпан: <b>${CFG.FREE_DAILY_LIMIT}</b> проверок.\n\n` +
          `💎 В PRO будет безлимит + риск-баллы + история.`,
        { reply_markup: mainMenu(pro) }
      );
      return;
    }
  }

  // Cache
  if (HAS_SB) {
    const cached = await getCachedInn(inn);
    if (cached) {
      log("info", "CACHE HIT", inn);
      // still count usage (иначе будут бесконечно через кэш)
      if (!pro) await incDailyCount(tgUser.id);

      await saveCheckLog({
        tg_user_id: tgUser.id,
        inn,
        kind: pro ? "pro" : "free",
        ok: true,
        provider: "cache",
        meta: { cache: true },
      });

      const msg = formatResult(inn, cached.dadata, cached.checko, pro);
      await sendMessage(chatId, msg, { reply_markup: mainMenu(pro) });
      return;
    }
  }

  await sendMessage(chatId, `⏳ Проверяю ИНН <code>${inn}</code>...`);

  const [dadata, checko] = await Promise.all([
    dadataByInn(inn).catch((e) => ({ provider: "dadata", ok: false, error: e.message })),
    checkoByInn(inn).catch((e) => ({ provider: "checko", ok: false, error: e.message })),
  ]);

  // Save cache
  const combined = { dadata, checko, fetched_at: new Date().toISOString() };
  if (HAS_SB) await saveCachedInn(inn, combined);

  // usage
  if (HAS_SB && !pro) await incDailyCount(tgUser.id);

  // logs
  await saveCheckLog({
    tg_user_id: tgUser.id,
    inn,
    kind: pro ? "pro" : "free",
    ok: Boolean(dadata?.ok || checko?.ok),
    provider: "mix",
    meta: { dadata_ok: dadata?.ok, checko_ok: checko?.ok },
  });

  const msg = formatResult(inn, dadata, checko, pro);
  await sendMessage(chatId, msg, { reply_markup: mainMenu(pro) });
}

async function handleCallback(cb) {
  const chatId = cb.message?.chat?.id;
  const tgUser = cb.from;
  if (!chatId || !tgUser) return;

  let userRow = { plan: "free", pro_until: null };
  try {
    userRow = await ensureUser(tgUser);
  } catch (e) {
    log("warn", "ensureUser failed:", e.message);
  }
  const pro = await isProUser(userRow);

  await answerCallbackQuery(cb.id);

  switch (cb.data) {
    case "CHECK_INN":
      await sendMessage(chatId, "Ок. Пришли ИНН (10 или 12 цифр) одним сообщением.");
      break;

    case "PRICING":
      await sendMessage(
        chatId,
        pro
          ? "💎 PRO активен."
          : "💎 PRO подключим позже. Сейчас задача — стабильно работающая бесплатная проверка + источники."
      );
      break;

    case "ABOUT":
      await sendMessage(
        chatId,
        "Что сейчас:\n" +
          "• DaData (поиск юрлица/ИП по ИНН)\n" +
          "• Checko (данные по компании)\n\n" +
          "Дальше:\n" +
          "• PRO риск-баллы и красные флаги\n" +
          "• история проверок\n" +
          "• отчёт PDF"
      );
      break;

    case "SUPPORT":
      await sendMessage(chatId, escapeHtml(CFG.SUPPORT_TEXT));
      break;

    default:
      await sendMessage(chatId, "Команда не распознана.", { reply_markup: mainMenu(pro) });
  }
}

/* =========================
   WEBHOOK HANDLER
========================= */

async function handleUpdate(update) {
  // callback
  if (update.callback_query) {
    await handleCallback(update.callback_query);
    return;
  }

  // message
  const msg = update.message;
  if (!msg?.chat?.id) return;

  const chatId = msg.chat.id;
  const tgUser = msg.from;
  const txt = (msg.text || "").trim();

  let userRow = { plan: "free", pro_until: null };
  if (tgUser) {
    try {
      userRow = await ensureUser(tgUser);
    } catch (e) {
      log("warn", "ensureUser failed:", e.message);
    }
  }

  if (txt === "/start") {
    await handleStart(chatId, tgUser, userRow);
    return;
  }

  if (isInn(txt)) {
    await handleInn(chatId, tgUser, userRow, txt);
    return;
  }

  // Fallback
  const pro = await isProUser(userRow);
  await sendMessage(chatId, "Пришли ИНН (10 или 12 цифр) или нажми кнопку.", {
    reply_markup: mainMenu(pro),
  });
}

/* =========================
   HTTP SERVER
========================= */

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && u.pathname === "/health") {
      return json(res, 200, { ok: true, has_supabase: HAS_SB });
    }

    if (req.method === "POST" && u.pathname === "/webhook") {
      const raw = await readBody(req);
      const update = raw ? JSON.parse(raw) : {};
      await handleUpdate(update);
      return json(res, 200, { ok: true });
    }

    return text(res, 404, "Not found");
  } catch (e) {
    log("error", "Server error:", e);
    return json(res, 500, { ok: false, error: e.message });
  }
});

server.listen(CFG.PORT, async () => {
  log("info", `Server started on port ${CFG.PORT}`);
  log("info", `Supabase: ${HAS_SB ? "enabled" : "disabled"}`);
  await setWebhook();
});
