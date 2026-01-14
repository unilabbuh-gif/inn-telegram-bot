/* ================================================
   ProverkaBizBot — Premium server
   - Telegram bot (Telegraf)
   - Webhook (Render)
   - Checko provider (org data by INN)
   - Supabase DB + Storage (PDF reports)
   - OpenAI interpretation (optional)
   - Quotas + PRO plan skeleton

   Required env:
   BOT_TOKEN
   PUBLIC_BASE_URL
   SUPABASE_URL
   SUPABASE_SERVICE_ROLE_KEY
   SUPABASE_STORAGE_BUCKET
   CHECKO_API_KEY (or other provider key if you replace)
   OPENAI_API_KEY (optional)
   SUPPORT_USERNAME (optional, without @)
=================================================== */

import 'dotenv/config';
import express from 'express';
import fetch from 'node-fetch';
import PDFDocument from 'pdfkit';
import { createClient } from '@supabase/supabase-js';
import { Telegraf, Markup } from 'telegraf';

/* =======================
   Env + constants
======================= */
const {
  BOT_TOKEN,
  PUBLIC_BASE_URL,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_STORAGE_BUCKET,
  CHECKO_API_KEY,
  OPENAI_API_KEY,
  SUPPORT_USERNAME,
  PORT
} = process.env;

const APP_PORT = Number(PORT || 10000);

const DAILY_FREE_LIMIT = 3;        // free checks per day
const PRO_DAYS = 30;               // stub for PRO duration
const PDF_TTL_DAYS = 30;           // optional: you can delete old PDFs later

function mustEnv(name, val) {
  if (!val) throw new Error(`[FATAL] Missing env: ${name}`);
}
mustEnv('BOT_TOKEN', BOT_TOKEN);
mustEnv('SUPABASE_URL', SUPABASE_URL);
mustEnv('SUPABASE_SERVICE_ROLE_KEY', SUPABASE_SERVICE_ROLE_KEY);
// PUBLIC_BASE_URL can be temporarily omitted (polling), but for webhook on Render — required
if (!PUBLIC_BASE_URL) {
  console.log('[WARN] PUBLIC_BASE_URL missing, webhook setup skipped (bot may still run in polling locally).');
}

/* =======================
   Supabase
======================= */
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

/* =======================
   Helpers
======================= */
function nowISO() {
  return new Date().toISOString();
}
function todayKey() {
  const d = new Date();
  // YYYY-MM-DD in local server TZ; if you want Moscow/UTC fix — store in UTC and compute there
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function normalizeInn(text) {
  const inn = String(text || '').trim();
  if (!/^\d{10}$/.test(inn) && !/^\d{12}$/.test(inn)) return null;
  return inn;
}

function moneyFmt(n) {
  if (n === null || n === undefined) return '—';
  try {
    return new Intl.NumberFormat('ru-RU').format(Number(n));
  } catch {
    return String(n);
  }
}

function safeText(s) {
  if (s === null || s === undefined) return '—';
  const t = String(s).trim();
  return t.length ? t : '—';
}

/* =======================
   Telegram UI
======================= */
const BTN_CHECK = '🔎 Проверить ИНН';
const BTN_CHECK_AGAIN = '🔁 Проверить ещё ИНН';
const BTN_PRO = '💎 Тариф PRO';
const BTN_WHAT = 'ℹ️ Что я проверяю?';
const BTN_SUPPORT = '🆘 Поддержка';

function mainKeyboard() {
  return Markup.keyboard([
    [BTN_CHECK],
    [BTN_PRO],
    [BTN_WHAT, BTN_SUPPORT]
  ]).resize();
}

/* =======================
   Database layer
   Tables expected:

   bot_users:
     id bigserial PK
     tg_user_id bigint unique
     tg_username text
     first_name text
     last_name text
     plan text ('free'|'pro')
     free_checks_left int
     pro_until timestamptz null
     created_at timestamptz default now()
     updated_at timestamptz default now()

   bot_quota_daily:
     id bigserial PK
     tg_user_id bigint
     day text (YYYY-MM-DD)
     used int
     created_at timestamptz default now()

   inn_checks:
     id bigserial PK
     tg_user_id bigint
     inn text
     kind text (e.g. 'inn')
     provider text
     result_summary text
     risk_level text
     pdf_url text
     raw jsonb
     created_at timestamptz default now()
     updated_at timestamptz default now()

   subscriptions:
     id bigserial PK
     tg_user_id bigint
     provider text
     status text
     started_at timestamptz
     expires_at timestamptz
     meta jsonb
==================================================== */

async function ensureUser(ctx) {
  const u = ctx.from;
  const tg_user_id = u.id;

  // try fetch
  const { data: existing, error: e1 } = await supabase
    .from('bot_users')
    .select('*')
    .eq('tg_user_id', tg_user_id)
    .maybeSingle();

  if (e1) {
    console.log('[WARN] ensureUser read failed:', e1?.message || e1);
  }

  if (existing) {
    // update minimal fields
    const patch = {
      tg_username: u.username || null,
      first_name: u.first_name || null,
      last_name: u.last_name || null,
      updated_at: nowISO()
    };
    const { error: e2 } = await supabase
      .from('bot_users')
      .update(patch)
      .eq('tg_user_id', tg_user_id);

    if (e2) console.log('[WARN] ensureUser update failed:', e2?.message || e2);
    return existing;
  }

  // create
  const insert = {
    tg_user_id,
    tg_username: u.username || null,
    first_name: u.first_name || null,
    last_name: u.last_name || null,
    plan: 'free',
    free_checks_left: DAILY_FREE_LIMIT,
    pro_until: null,
    created_at: nowISO(),
    updated_at: nowISO()
  };

  const { data: created, error: e3 } = await supabase
    .from('bot_users')
    .insert(insert)
    .select('*')
    .single();

  if (e3) {
    console.log('[ERROR] ensureUser insert failed:', e3?.message || e3);
    // fallback object
    return insert;
  }
  return created;
}

async function getDailyQuota(tg_user_id) {
  const day = todayKey();
  const { data, error } = await supabase
    .from('bot_quota_daily')
    .select('*')
    .eq('tg_user_id', tg_user_id)
    .eq('day', day)
    .maybeSingle();

  if (error) {
    console.log('[WARN] getDailyQuota failed:', error?.message || error);
    return { day, used: 0 };
  }

  if (!data) return { day, used: 0 };
  return { day, used: Number(data.used || 0) };
}

async function incDailyQuota(tg_user_id) {
  const day = todayKey();
  const quota = await getDailyQuota(tg_user_id);

  if (quota.used === 0) {
    const { error } = await supabase.from('bot_quota_daily').insert({
      tg_user_id,
      day,
      used: 1,
      created_at: nowISO()
    });
    if (error) console.log('[WARN] incDailyQuota insert failed:', error?.message || error);
    return 1;
  } else {
    const { error } = await supabase
      .from('bot_quota_daily')
      .update({ used: quota.used + 1 })
      .eq('tg_user_id', tg_user_id)
      .eq('day', day);

    if (error) console.log('[WARN] incDailyQuota update failed:', error?.message || error);
    return quota.used + 1;
  }
}

async function saveCheckLog({ tg_user_id, inn, provider, result_summary, risk_level, pdf_url, raw }) {
  const payload = {
    tg_user_id,
    inn,
    kind: 'inn',
    provider: provider || 'unknown',
    result_summary: result_summary || null,
    risk_level: risk_level || null,
    pdf_url: pdf_url || null,
    raw: raw || null,
    created_at: nowISO(),
    updated_at: nowISO()
  };

  const { error } = await supabase.from('inn_checks').insert(payload);
  if (error) console.log('[WARN] saveCheckLog failed:', error?.message || error);
}

/* =======================
   Checko provider
   NOTE: If your Checko plan/endpoint differs, adapt mapping below.
======================= */
async function fetchCheckoCompany(inn) {
  if (!CHECKO_API_KEY) {
    return { provider: 'checko', error: 'CHECKO_API_KEY не задан. Данные провайдера недоступны.', raw: null };
  }

  const url = `https://api.checko.ru/v2/company?key=${encodeURIComponent(CHECKO_API_KEY)}&inn=${encodeURIComponent(inn)}`;

  try {
    const r = await fetch(url, { method: 'GET' });
    const raw = await r.json().catch(() => null);

    if (!r.ok) {
      return { provider: 'checko', error: `Checko HTTP ${r.status}`, raw };
    }
    if (!raw || raw.error) {
      return { provider: 'checko', error: raw?.error || 'Unknown error', raw };
    }
    return { provider: 'checko', error: null, raw };
  } catch (e) {
    return { provider: 'checko', error: `Network error: ${e?.message || e}`, raw: null };
  }
}

function normalizeCompany(checkoRaw) {
  // Checko often returns { data: { ... } }
  const data = checkoRaw?.data || checkoRaw?.result || checkoRaw || null;
  if (!data) return null;

  // heuristics for common fields
  const name = data.short_name || data.name || data.full_name || data?.ul?.name || data?.ip?.fio || null;
  const ogrn = data.ogrn || data?.ul?.ogrn || data?.ip?.ogrnip || null;
  const kpp = data.kpp || data?.ul?.kpp || null;
  const status = data.status || data?.state || data?.ul?.status || null;
  const address =
    data.address ||
    data?.ul?.address ||
    data?.address?.value ||
    data?.fns?.address ||
    null;

  // a very rough risk placeholder (you will replace with real scoring rules later)
  const risk_level = '—';

  return {
    name: name || null,
    ogrn: ogrn || null,
    kpp: kpp || null,
    status: status || null,
    address: address || null,
    risk_level
  };
}

/* =======================
   OpenAI interpretation (optional)
   We do NOT claim any "legal validity" — we generate an internal analytical note.
======================= */
async function openaiInterpret(company) {
  if (!OPENAI_API_KEY) return null;

  const prompt = `
Ты — аналитик комплаенса. Сформируй краткое заключение по контрагенту на русском.
Дай:
1) краткую сводку (1-2 предложения)
2) потенциальные риски (списком)
3) что проверить дополнительно (списком)
Важно: не называй это юридическим заключением для суда/ФНС. Это внутренняя проверка.

Данные:
Наименование: ${company?.name || '—'}
ОГРН/ОГРНИП: ${company?.ogrn || '—'}
КПП: ${company?.kpp || '—'}
Статус: ${company?.status || '—'}
Адрес: ${company?.address || '—'}
`;

  try {
    const r = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4.1-mini',
        input: prompt,
        max_output_tokens: 500
      })
    });

    const j = await r.json().catch(() => null);
    if (!r.ok) {
      console.log('[WARN] OpenAI error:', r.status, j);
      return null;
    }

    // Responses API output
    const text =
      j?.output?.[0]?.content?.[0]?.text ||
      j?.output_text ||
      null;

    if (!text) return null;
    return String(text).trim();
  } catch (e) {
    console.log('[WARN] OpenAI network error:', e?.message || e);
    return null;
  }
}

/* =======================
   PDF generation
======================= */
function buildPdfBuffer({ inn, company, aiText }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Header
    doc.fontSize(16).text('ОТЧЁТ О ПРОВЕРКЕ КОНТРАГЕНТА (ИНН)', { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(10).fillColor('#555').text(`Дата формирования: ${new Date().toLocaleString('ru-RU')}`, { align: 'center' });
    doc.moveDown(1);
    doc.fillColor('#000');

    // Block
    doc.fontSize(12).text(`ИНН: ${inn}`);
    doc.moveDown(0.5);

    doc.fontSize(12).text('Сведения об организации (по данным провайдера):', { underline: true });
    doc.moveDown(0.5);

    const rows = [
      ['Наименование', safeText(company?.name)],
      ['ОГРН / ОГРНИП', safeText(company?.ogrn)],
      ['КПП', safeText(company?.kpp)],
      ['Статус', safeText(company?.status)],
      ['Адрес', safeText(company?.address)]
    ];

    rows.forEach(([k, v]) => {
      doc.fontSize(11).text(`${k}: `, { continued: true }).font('Helvetica-Bold').text(v);
      doc.font('Helvetica');
      doc.moveDown(0.2);
    });

    doc.moveDown(0.7);

    doc.fontSize(12).text('Примечание:', { underline: true });
    doc.moveDown(0.3);
    doc.fontSize(10).fillColor('#333').text(
      'Данный отчёт носит информационный характер и предназначен для внутренней проверки. ' +
      'Не является документом ФНС и не гарантирует отсутствие рисков. ' +
      'Рекомендуется проводить комплексную проверку контрагента.'
    );
    doc.fillColor('#000');

    if (aiText) {
      doc.moveDown(1);
      doc.fontSize(12).text('Аналитическое резюме (ИИ):', { underline: true });
      doc.moveDown(0.4);
      doc.fontSize(10).fillColor('#111').text(aiText);
      doc.fillColor('#000');
    }

    // Footer stamp-like
    doc.moveDown(1.5);
    doc.fontSize(10).fillColor('#444').text('Отметка: проверено автоматически системой ProverkaBiz.', { align: 'right' });
    doc.fillColor('#000');

    doc.end();
  });
}

async function uploadPdfToSupabase({ tg_user_id, inn, pdfBuffer }) {
  const bucket = SUPABASE_STORAGE_BUCKET || 'ProverkaINN';
  const path = `reports/${tg_user_id}/${inn}_${Date.now()}.pdf`;

  const { error: upErr } = await supabase.storage
    .from(bucket)
    .upload(path, pdfBuffer, {
      contentType: 'application/pdf',
      upsert: false
    });

  if (upErr) {
    return { error: `PDF не загружен (проверь Supabase Storage / ключи): ${upErr.message}`, publicUrl: null };
  }

  // public URL
  const { data } = supabase.storage.from(bucket).getPublicUrl(path);
  return { error: null, publicUrl: data?.publicUrl || null };
}

/* =======================
   Text formatting for Telegram
======================= */
function buildTelegramReport({ inn, company, aiText, pdfUrl, quotaNote }) {
  const lines = [];

  lines.push(`🔎 *Сводка по ИНН ${inn}*`);
  lines.push('');

  lines.push('*Сведения:*');
  lines.push(`• *Наименование:* ${safeText(company?.name)}`);
  lines.push(`• *ОГРН/ОГРНИП:* ${safeText(company?.ogrn)}`);
  lines.push(`• *КПП:* ${safeText(company?.kpp)}`);
  lines.push(`• *Статус:* ${safeText(company?.status)}`);
  lines.push(`• *Адрес:* ${safeText(company?.address)}`);

  lines.push('');
  lines.push(`⚠️ *Уровень риска:* ${safeText(company?.risk_level)}`);

  if (aiText) {
    lines.push('');
    lines.push('🧠 *Аналитика (ИИ):*');
    // avoid too long message
    const trimmed = aiText.length > 1200 ? aiText.slice(0, 1200) + '…' : aiText;
    lines.push(trimmed);
  }

  lines.push('');
  if (pdfUrl) {
    lines.push(`📄 *PDF-отчёт:* ${pdfUrl}`);
  } else {
    lines.push('📄 *PDF не загружен* (проверь Supabase Storage / ключи).');
  }

  if (quotaNote) {
    lines.push('');
    lines.push(quotaNote);
  }

  lines.push('');
  lines.push('_Отчёт информационный, для внутренней проверки. Не документ ФНС._');

  return lines.join('\n');
}

/* =======================
   Business logic: can check?
======================= */
function isPro(userRow) {
  if (!userRow) return false;
  if (userRow.plan === 'pro') return true;
  if (userRow.pro_until) {
    const t = new Date(userRow.pro_until).getTime();
    return Number.isFinite(t) && t > Date.now();
  }
  return false;
}

async function canDoCheck(userRow) {
  const tg_user_id = userRow.tg_user_id;

  if (isPro(userRow)) return { ok: true, note: null };

  // daily quota + free_checks_left
  const left = Number(userRow.free_checks_left ?? 0);
  if (left <= 0) {
    return {
      ok: false,
      note: '⛔️ Лимит на сегодня исчерпан. В PRO будет безлимит + история + PDF.'
    };
  }

  const q = await getDailyQuota(tg_user_id);
  if (q.used >= DAILY_FREE_LIMIT) {
    return {
      ok: false,
      note: '⛔️ Дневной лимит free исчерпан. В PRO будет безлимит + история + PDF.'
    };
  }

  return { ok: true, note: `✅ Free-лимит: осталось ${left} проверок.` };
}

async function consumeFree(userRow) {
  const tg_user_id = userRow.tg_user_id;
  const left = Math.max(0, Number(userRow.free_checks_left ?? 0) - 1);

  const { error } = await supabase
    .from('bot_users')
    .update({ free_checks_left: left, updated_at: nowISO() })
    .eq('tg_user_id', tg_user_id);

  if (error) console.log('[WARN] consumeFree update failed:', error?.message || error);
  await incDailyQuota(tg_user_id);

  return left;
}

/* =======================
   Telegram bot
======================= */
const bot = new Telegraf(BOT_TOKEN);

bot.start(async (ctx) => {
  await ensureUser(ctx);

  const hello =
    `Привет! Я проверяю контрагентов по ИНН.\n\n` +
    `Пришли ИНН (10 или 12 цифр) одним сообщением.\n` +
    `Лимит free: ${DAILY_FREE_LIMIT} проверки в день.\n\n` +
    `Жми кнопку ниже 👇`;

  await ctx.reply(hello, mainKeyboard());
});

bot.hears([BTN_CHECK, BTN_CHECK_AGAIN], async (ctx) => {
  await ensureUser(ctx);
  await ctx.reply('Ок. Пришли ИНН (10 или 12 цифр) одним сообщением.', mainKeyboard());
});

bot.hears(BTN_WHAT, async (ctx) => {
  const text =
    `Я подтягиваю базовые сведения по ИНН:\n` +
    `• наименование\n• ОГРН/ОГРНИП\n• КПП\n• статус\n• адрес\n\n` +
    `В PRO:\n• безлимит проверок\n• история\n• PDF-отчёты с отметкой "проверено"\n• риск-флаги (постепенно расширим)\n`;
  await ctx.reply(text, mainKeyboard());
});

bot.hears(BTN_PRO, async (ctx) => {
  await ensureUser(ctx);

  const text =
    `💎 *Тариф PRO*\n\n` +
    `В PRO будет:\n` +
    `— безлимит проверок\n` +
    `— история проверок\n` +
    `— PDF-отчёты с отметкой «проверено»\n` +
    `— риск-баллы / «красные флаги»\n\n` +
    `Оплата подключим следующим шагом (Stripe/ЮKassa/Telegram Payments).\n` +
    `Пока можешь написать в поддержку — включу PRO вручную.`;

  await ctx.reply(text, { parse_mode: 'Markdown', ...mainKeyboard() });
});

bot.hears(BTN_SUPPORT, async (ctx) => {
  const uname = SUPPORT_USERNAME ? `@${SUPPORT_USERNAME.replace(/^@/, '')}` : '@YOUR_SUPPORT_USERNAME';
  await ctx.reply(`Напиши сюда: ${uname}\nИли ответь на это сообщение — мы увидим в логах и поможем.`, mainKeyboard());
});

/* =======================
   Main handler: INN message
======================= */
bot.on('text', async (ctx) => {
  const user = await ensureUser(ctx);
  const tg_user_id = user.tg_user_id;

  const inn = normalizeInn(ctx.message.text);
  if (!inn) {
    await ctx.reply('❗️ИНН должен быть 10 или 12 цифр. Пришли корректный ИНН одним сообщением.', mainKeyboard());
    return;
  }

  const allowed = await canDoCheck(user);
  if (!allowed.ok) {
    await ctx.reply(`⛔️ ${allowed.note}`, mainKeyboard());
    return;
  }

  await ctx.reply(`🔎 Проверяю ИНН ${inn}...`, mainKeyboard());

  // Provider fetch
  const providerRes = await fetchCheckoCompany(inn);
  if (providerRes.error) {
    await ctx.reply(
      `⚠️ Провайдер недоступен: ${providerRes.error}\n` +
      `Проверь ключ CHECKO_API_KEY и доступ к API.`,
      mainKeyboard()
    );
    return;
  }

  const company = normalizeCompany(providerRes.raw);
  if (!company) {
    await ctx.reply('⚠️ Не удалось нормализовать ответ провайдера (формат данных изменился).', mainKeyboard());
    return;
  }

  // consume free (after successful provider response)
  let quotaNote = null;
  if (!isPro(user)) {
    const left = await consumeFree(user);
    quotaNote = `🔻 Осталось бесплатных проверок: ${left}`;
  }

  // OpenAI interpretation (optional)
  const aiText = await openaiInterpret(company);

  // PDF
  let pdfUrl = null;
  let pdfUploadError = null;
  try {
    const pdfBuffer = await buildPdfBuffer({ inn, company, aiText });
    const up = await uploadPdfToSupabase({ tg_user_id, inn, pdfBuffer });
    if (up.error) pdfUploadError = up.error;
    pdfUrl = up.publicUrl;
  } catch (e) {
    pdfUploadError = `PDF error: ${e?.message || e}`;
  }

  // Save log
  const summary = `${company?.name || '—'}; ОГРН: ${company?.ogrn || '—'}; КПП: ${company?.kpp || '—'}`;
  await saveCheckLog({
    tg_user_id,
    inn,
    provider: providerRes.provider,
    result_summary: summary,
    risk_level: company.risk_level || '—',
    pdf_url: pdfUrl,
    raw: providerRes.raw
  });

  const report = buildTelegramReport({ inn, company, aiText, pdfUrl, quotaNote });

  if (pdfUploadError) {
    console.log('[WARN] PDF upload:', pdfUploadError);
  }

  await ctx.reply(report, { parse_mode: 'Markdown', disable_web_page_preview: true, ...mainKeyboard() });
});

/* =======================
   Express (Render webhook)
======================= */
const app = express();
app.use(express.json());

app.get('/', (req, res) => res.status(200).send('OK'));

if (PUBLIC_BASE_URL) {
  app.post('/webhook', (req, res) => {
    bot.handleUpdate(req.body, res).catch((e) => {
      console.log('[ERROR] handleUpdate:', e?.message || e);
      res.status(200).send('OK');
    });
  });
}

async function start() {
  // start express
  app.listen(APP_PORT, () => {
    console.log(`[INFO] Server started on port ${APP_PORT}`);
    console.log('[INFO] Supabase: enabled');
  });

  // webhook
  if (PUBLIC_BASE_URL) {
    const hook = `${PUBLIC_BASE_URL.replace(/\/$/, '')}/webhook`;
    await bot.telegram.setWebhook(hook);
    console.log('[INFO] Webhook set:', hook);
  } else {
    console.log('[WARN] PUBLIC_BASE_URL missing, webhook setup skipped');
  }

  console.log('[INFO] Your service is live 🚀');
}

start().catch((e) => {
  console.error(e);
  process.exit(1);
});
