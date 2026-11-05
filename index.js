const fs = require('fs');
const os = require('os');
const path = require('path');
const { Telegraf, Markup } = require('telegraf');
const ytSearch = require('yt-search');
const ytdl = require('@distube/ytdl-core');

// ===========================================================================
// Config (env.json)
// ===========================================================================
let config = {};
const envFile = path.join(__dirname, 'env.json');
if (fs.existsSync(envFile)) {
  try {
    config = JSON.parse(fs.readFileSync(envFile, 'utf8'));
  } catch (e) {
    console.error('Gagal baca env.json:', e.message);
    process.exit(1);
  }
} else if (!process.env.BOT_TOKEN) {
  console.error('env.json tidak ditemukan dan BOT_TOKEN tidak ada di environment variable.');
  process.exit(1);
}
const cfg = (k, d) => process.env[k] || config[k] || d;

const BOT_TOKEN = cfg('BOT_TOKEN');
if (!BOT_TOKEN || BOT_TOKEN.startsWith('isi_')) {
  console.error('BOT_TOKEN belum diisi di env.json');
  process.exit(1);
}
const MAIN_OWNERS = new Set([].concat(config.OWNER_IDS || [], String(process.env.OWNER_IDS || '').split(',')).map(Number).filter(Boolean));
const CLAUDE_MODEL = cfg('CLAUDE_MODEL', 'claude');
const GEMINI_MODEL = cfg('GEMINI_MODEL', 'gemini');
const GPT_MODEL = cfg('GPT_MODEL', 'openai');
const DEEPSEEK_MODEL = cfg('DEEPSEEK_MODEL', 'deepseek');
const QWEN_MODEL = cfg('QWEN_MODEL', 'qwen-coder');
const FALLBACK_MODEL = 'openai';
const AI_URL = 'https://text.pollinations.ai/openai';
const MODELS_URL = 'https://text.pollinations.ai/models';

// ===========================================================================
// Penyimpanan sederhana (file JSON)
// ===========================================================================
const VERSION = '10.2';
const START_TIME = Date.now();
const DATA_DIR = cfg('DATA_DIR', __dirname);
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
} catch (_) {}
const file = (n) => path.join(DATA_DIR, n);
const readJSON = (n, d) => {
  try {
    return JSON.parse(fs.readFileSync(file(n), 'utf8'));
  } catch (_) {
    return d;
  }
};
const writeJSON = (n, v) => {
  try {
    const p = file(n);
    fs.writeFileSync(p + '.tmp', JSON.stringify(v));
    fs.renameSync(p + '.tmp', p); // atomik: file tidak rusak kalau proses mati di tengah jalan
  } catch (e) {
    console.error('Gagal menyimpan', n, e.message);
  }
};

const OWNERS = new Set(MAIN_OWNERS);
readJSON('owners.json', []).forEach((id) => OWNERS.add(Number(id)));
const saveOwners = () => writeJSON('owners.json', [...OWNERS].filter((o) => !MAIN_OWNERS.has(o)));
const isOwner = (id) => OWNERS.has(id);

const USERS = new Set(readJSON('users.json', []).map(Number));
const GROUPS = readJSON('groups.json', {}); // { chatId: { welcome, antilink } }
const gset = (chatId) => (GROUPS[chatId] = GROUPS[chatId] || { welcome: false, antilink: false });
const saveGroups = () => writeJSON('groups.json', GROUPS);
const STATE = readJSON('state.json', { active: true }); // mode on/off bot
const MAINT = Object.assign({ on: false, msg: 'Kami sedang melakukan perawatan. Silakan coba lagi nanti.' }, STATE.maint || {});
const saveMaint = () => { STATE.maint = { on: MAINT.on, msg: MAINT.msg }; saveState(); };
const saveState = () => writeJSON('state.json', STATE);
const RESTART_EXIT_CODE = Number(cfg('RESTART_EXIT_CODE', 1));

// ===========================================================================
// Helper
// ===========================================================================
const bot = new Telegraf(BOT_TOKEN);

const esc = (t) => String(t || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const rand = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getArgs = (ctx) => (ctx.message.text || '').split(/\s+/).slice(1).filter(Boolean);
const argText = (ctx) => (ctx.message.text || '').replace(/^\/\S+\s*/, '').trim();
const inGroup = (ctx) => ctx.chat && ['group', 'supergroup'].includes(ctx.chat.type);
const mention = (u) => `<a href="tg://user?id=${u.id}">${esc(u.first_name || u.id)}</a>`;

async function replyLong(ctx, text) {
  for (let i = 0; i < text.length; i += 4000) await ctx.reply(text.slice(i, i + 4000));
}

function getTarget(ctx) {
  const r = ctx.message.reply_to_message;
  if (r && r.from) return r.from.id;
  const a = getArgs(ctx)[0];
  return a && /^\d+$/.test(a) ? Number(a) : null;
}

function uptime() {
  let s = Math.floor((Date.now() - START_TIME) / 1000);
  const d = Math.floor(s / 86400); s %= 86400;
  const h = Math.floor(s / 3600); s %= 3600;
  const m = Math.floor(s / 60);
  return `${d}h ${h}j ${m}m`;
}

async function fetchBuffer(url, opts = {}, timeout = 120000) {
  const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeout) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

// ===========================================================================
// ⚙️ UPGRADE v4: anti-crash, anti-spam, antrian download, XP/level & statistik
// ===========================================================================
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e && e.message));
process.on('uncaughtException', (e) => console.error('uncaughtException:', e && e.message));
try {
  // bersihkan sisa file sementara dari sesi sebelumnya
  for (const f of fs.readdirSync(os.tmpdir())) if (/^(lagu|video|yt)_\d+/.test(f)) fs.unlink(path.join(os.tmpdir(), f), () => {});
} catch (_) {}

const BANNED = new Set(readJSON('banned.json', []).map(Number));
const saveBanned = () => writeJSON('banned.json', [...BANNED]);

const STATS = readJSON('stats.json', { total: 0, users: {} });
let statsDirty = false;
function saveStats() {
  if (!statsDirty) return;
  statsDirty = false;
  try {
    writeJSON('stats.json', STATS);
  } catch (_) {}
}
setInterval(saveStats, 15000).unref(); // unref: timer ini tidak boleh menahan proses saat dimatikan

const getP = (u) => {
  const p = (STATS.users[u.id] = STATS.users[u.id] || { xp: 0, coins: 0, cmds: 0, streak: 0, daily: '', name: '' });
  if (u.first_name) p.name = u.first_name;
  return p;
};
const levelOf = (xp) => Math.floor(Math.sqrt(xp / 25)) + 1;
const titleOf = (l) => (l < 3 ? 'Pemula' : l < 6 ? 'Petualang' : l < 10 ? 'Veteran' : l < 15 ? 'Master' : 'Legenda');
function reward(ctx, coins, xp = Math.ceil(coins / 2)) {
  const p = getP(ctx.from);
  p.coins += coins;
  p.xp += xp;
  statsDirty = true;
}

const HEAVY = new Set(['lagu', 'play', 'video', 'ytmp4', 'tiktok', 'tt', 'ssweb', 'screenshot', 'img', 'gambar', 'tts', 'suara']);
const MAX_HEAVY = Number(cfg('MAX_HEAVY', 3));
const COOLDOWN_MS = Number(cfg('COOLDOWN_MS', 1500));
let heavyActive = 0;
const lastCmd = new Map();
const lastWarn = new Map();

// 1) Jalankan handler tanpa menahan antrian update -> user lain tidak menunggu saat ada download panjang
bot.use((ctx, next) => {
  next().catch((e) => console.error('Handler error:', e && e.message));
});

// ===========================================================================
// 🛡️ FIREWALL (v6): anti-flood global, blokir otomatis bertingkat, filter payload
// ===========================================================================
const FW = Object.assign({ on: true, level: 'normal', blocked: {}, hits: 0 }, readJSON('firewall.json', {}));
const saveFW = () => writeJSON('firewall.json', FW);
const FW_LEVELS = { longgar: { n: 14, win: 10000 }, normal: { n: 8, win: 10000 }, ketat: { n: 5, win: 8000 } };
const FW_PENALTY = [60e3, 10 * 60e3, 60 * 60e3]; // pelanggaran ke-1, ke-2, ke-3 dst
const FW_MAX_PAYLOAD = 3000;
const fwHist = new Map();
const fwStrike = new Map();
const fwNotified = new Map();

// 1) Firewall pribadi: batasi laju aksi per pengguna (chat pribadi, perintah, tombol)
bot.use((ctx, next) => {
  const u = ctx.from;
  if (!u || u.is_bot || !FW.on || isOwner(u.id)) return next();
  const now = Date.now();
  const until = FW.blocked[u.id];
  if (until) {
    if (until > now) {
      if (ctx.callbackQuery) ctx.answerCbQuery('🛡️ Firewall: aksesmu dibatasi sementara.', { show_alert: true }).catch(() => {});
      else if (ctx.chat && ctx.chat.type === 'private' && now - (fwNotified.get(u.id) || 0) > 30000) {
        fwNotified.set(u.id, now);
        ctx.reply(`🛡️ Firewall: aksesmu dibatasi sementara (${fmtDur(until - now)} lagi).`).catch(() => {});
      }
      { react(ctx, '🛡️'); return; }
    }
    delete FW.blocked[u.id];
    saveFW();
  }
  const txt = (ctx.message && (ctx.message.text || ctx.message.caption)) || '';
  const isCmd = txt.startsWith('/');
  if (isCmd && txt.length > FW_MAX_PAYLOAD) { react(ctx, '🛡️'); return; } // payload perintah raksasa dibuang
  const priv = ctx.chat && ctx.chat.type === 'private';
  if (!(ctx.callbackQuery || isCmd || (priv && ctx.message))) return next(); // obrolan biasa di grup tidak dihitung
  const lv = FW_LEVELS[FW.level] || FW_LEVELS.normal;
  const h = (fwHist.get(u.id) || []).filter((t) => now - t < lv.win);
  h.push(now);
  fwHist.set(u.id, h);
  if (h.length <= lv.n) return next();

  // melanggar batas -> blokir bertingkat (1 menit, 10 menit, 1 jam)
  const st = fwStrike.get(u.id);
  const n = (st && now - st.t < 30 * 60e3 ? st.n : 0) + 1;
  fwStrike.set(u.id, { n, t: now });
  const dur = FW_PENALTY[Math.min(n - 1, FW_PENALTY.length - 1)];
  FW.blocked[u.id] = now + dur;
  FW.hits = (FW.hits || 0) + 1;
  fwHist.delete(u.id);
  saveFW();
  if (ctx.callbackQuery) ctx.answerCbQuery('🛡️ Terlalu cepat! Kamu diblokir sementara.', { show_alert: true }).catch(() => {});
  else if (priv) ctx.reply(`🛡️ Firewall: aktivitas terlalu cepat terdeteksi.\nAkses dibatasi ${fmtDur(dur)} (pelanggaran ke-${n}).`).catch(() => {});
  if (n >= 3) for (const o of MAIN_OWNERS) bot.telegram.sendMessage(o, `🚨 Firewall: user ${u.id} (${u.first_name}) berulang kali spam, diblokir ${fmtDur(dur)}.`).catch(() => {});
});

// 2) Anti-flood grup (opsional per grup, lewat /keamanan): mute otomatis 5 menit
const gFlood = new Map();
bot.use(async (ctx, next) => {
  if (!inGroup(ctx) || !ctx.message || !ctx.from || ctx.from.is_bot) return next();
  if (!gset(ctx.chat.id).antiflood) return next();
  const key = `${ctx.chat.id}:${ctx.from.id}`;
  const now = Date.now();
  const h = (gFlood.get(key) || []).filter((t) => now - t < 5000);
  h.push(now);
  gFlood.set(key, h);
  if (h.length <= 6) return next();
  gFlood.delete(key);
  if (await isGroupAdmin(ctx)) return next();
  try {
    await ctx.telegram.restrictChatMember(ctx.chat.id, ctx.from.id, { permissions: { can_send_messages: false }, until_date: Math.floor(now / 1000) + 300 });
    ctx.reply(`🌊 ${mention(ctx.from)} di-mute 5 menit karena flood.`, { parse_mode: 'HTML' }).catch(() => {});
  } catch (_) {
    /* bot bukan admin */
  }
});

// bersihkan memori riwayat secara berkala
setInterval(() => {
  const now = Date.now();
  for (const [k, h] of gFlood) if (!h.length || now - h[h.length - 1] > 10000) gFlood.delete(k);
  for (const [k, h] of fwHist) if (!h.length || now - h[h.length - 1] > 20000) fwHist.delete(k);
  for (const [k, t] of Object.entries(FW.blocked)) if (t < now) delete FW.blocked[k];
  for (const [k, t] of fwNotified) if (now - t > 3600e3) fwNotified.delete(k);
  for (const [k, v] of fwStrike) if (now - v.t > 3600e3) fwStrike.delete(k);
}, 5 * 60e3).unref();

// Filter alamat internal (SSRF) untuk fitur yang menerima link dari pengguna
function isSafeUrl(u) {
  try {
    const x = new URL(u);
    if (!/^https?:$/.test(x.protocol)) return false;
    const h = x.hostname.toLowerCase();
    if (h === 'localhost' || /\.(local|localhost|internal|lan)$/.test(h)) return false;
    if (/^(0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)) return false;
    if (h.startsWith('[') || /^\d+$/.test(h)) return false;
    return true;
  } catch (_) {
    return false;
  }
}

// 2) Penjaga: blokir bot, anti-spam, batas download bersamaan, hitung XP
bot.use(async (ctx, next) => {
  const u = ctx.from;
  if (!u || u.is_bot) return next();
  const owner = isOwner(u.id);
  if (!owner && DDOS.on && (ctx.message || ctx.callbackQuery) && ddosUserCheck(u.id)) {
    react(ctx, '🛡️');
    if (ctx.callbackQuery) return ctx.answerCbQuery('🛡️ Terlalu banyak permintaan, tunggu sebentar.', { show_alert: true }).catch(() => {});
    if (ctx.chat && ctx.chat.type === 'private') ctx.reply('🛡️ Terlalu banyak permintaan dalam waktu singkat. Tunggu sebentar.').catch(() => {});
    return;
  }
  if (ctx.message && typeof ctx.message.text === 'string' && ctx.message.text.startsWith('/')) react(ctx, '👀');
  if (MAINT.on && !owner) {
    if (ctx.callbackQuery) return ctx.answerCbQuery('🔧 Sedang maintenance', { show_alert: true }).catch(() => {});
    if (ctx.chat && ctx.chat.type === 'private' && ctx.message) ctx.reply(`🔧 <b>Sedang maintenance</b>\n${esc(MAINT.msg)}`, { parse_mode: 'HTML' }).catch(() => {});
    return;
  }
  if (BANNED.has(u.id) && !owner) {
    if (ctx.chat && ctx.chat.type === 'private' && ctx.message) ctx.reply('🚫 Kamu diblokir dari bot ini.').catch(() => {});
    return;
  }
  const text = (ctx.message && ctx.message.text) || '';
  const m = /^\/([a-zA-Z0-9_]+)/.exec(text);
  if (!m) return next();
  const cmd = m[1].toLowerCase();
  if (!owner) {
    const now = Date.now();
    if (now - (lastCmd.get(u.id) || 0) < COOLDOWN_MS) {
      if (now - (lastWarn.get(u.id) || 0) > 10000) {
        lastWarn.set(u.id, now);
        ctx.reply('⏳ Pelan-pelan ya, jangan terlalu cepat.').catch(() => {});
      }
      return;
    }
    lastCmd.set(u.id, now);
  }
  if (STATE.active || owner) {
    const p = getP(u);
    p.cmds++;
    p.xp += 5;
    STATS.total++;
    STATS.cmdCount = STATS.cmdCount || {};
    STATS.cmdCount[cmd] = (STATS.cmdCount[cmd] || 0) + 1;
    statsDirty = true;
  }
  if (HEAVY.has(cmd)) {
    if (heavyActive >= MAX_HEAVY) return ctx.reply('⏳ Server sedang sibuk (antrian penuh). Coba lagi sebentar ya.').catch(() => {});
    heavyActive++;
    try {
      await next();
    } finally {
      heavyActive--;
    }
    return;
  }
  return next();
});

// ===========================================================================
// 🛡️ ANTI-DDOS (v8.3): pembatasan laju berlapis di tingkat aplikasi
// ===========================================================================
// Catatan jujur: ini melindungi dari banjir permintaan yang sampai ke bot. Serangan volumetrik
// besar (ratusan Gbps) tetap harus dihadapi penyedia hosting/CDN. Yang bisa dilakukan di sini:
// membatasi laju per pengguna, per IP panel, dan mendeteksi lonjakan global.
const DDOS = { on: true, perIpWin: 10e3, perIpMax: 60, banMs: 15 * 60e3, globalWin: 10e3, globalMax: 400, alerts: 0 };
const ddosBanIp = new Map(); // ip -> sampai kapan
const ddosHitsIp = new Map();
let ddosGlobal = [];
let ddosLastAlert = 0;
function ddosNoteGlobal(now) {
  ddosGlobal = ddosGlobal.filter((t) => now - t < DDOS.globalWin);
  ddosGlobal.push(now);
  if (ddosGlobal.length > DDOS.globalMax && now - ddosLastAlert > 10 * 60e3) {
    ddosLastAlert = now;
    DDOS.alerts++;
    notifyOwners(`🚨 Anti-DDoS: lonjakan ${ddosGlobal.length} permintaan dalam ${DDOS.globalWin / 1000} detik ke panel/bot. Pembatasan laju aktif.`);
  }
  return ddosGlobal.length > DDOS.globalMax;
}
// Untuk panel web: dipanggil sebelum autentikasi, jadi penyerang tanpa kredensial pun dibatasi.
function ddosCheckHttp(ip, now = Date.now()) {
  if (!DDOS.on) return null;
  const ban = ddosBanIp.get(ip);
  if (ban && ban > now) return 'banned';
  if (ddosBanIp.has(ip) && ban <= now) ddosBanIp.delete(ip);
  const h = (ddosHitsIp.get(ip) || []).filter((t) => now - t < DDOS.perIpWin);
  h.push(now);
  ddosHitsIp.set(ip, h);
  if (h.length > DDOS.perIpMax) {
    ddosBanIp.set(ip, now + DDOS.banMs);
    ddosHitsIp.delete(ip);
    return 'banned';
  }
  if (ddosNoteGlobal(now)) return 'global';
  return null;
}
// Pembatasan untuk pengguna Telegram (dipakai firewall).
const ddosUserHits = new Map();
function ddosUserCheck(uid, now = Date.now()) {
  const h = (ddosUserHits.get(uid) || []).filter((t) => now - t < DDOS.perIpWin);
  h.push(now);
  ddosUserHits.set(uid, h);
  return h.length > DDOS.perIpMax;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, t] of ddosBanIp) if (t <= now) ddosBanIp.delete(ip);
  for (const [ip, h] of ddosHitsIp) if (!h.length || now - h[h.length - 1] > DDOS.perIpWin * 2) ddosHitsIp.delete(ip);
  for (const [uid, h] of ddosUserHits) if (!h.length || now - h[h.length - 1] > DDOS.perIpWin * 2) ddosUserHits.delete(uid);
}, 60e3).unref();


// Catat user + anti-link grup (harus paling awal)
bot.use(async (ctx, next) => {
  if (ctx.from && !ctx.from.is_bot && !USERS.has(ctx.from.id)) {
    USERS.add(ctx.from.id);
    writeJSON('users.json', [...USERS]);
  }
  if (!STATE.active && !(ctx.from && isOwner(ctx.from.id))) {
    if (ctx.callbackQuery) return ctx.answerCbQuery('🔴 Bot sedang nonaktif', { show_alert: true }).catch(() => {});
    if (ctx.chat && ctx.chat.type === 'private' && ctx.message) return ctx.reply('🔴 Bot sedang nonaktif. Coba lagi nanti ya.').catch(() => {});
    return;
  }
  if (inGroup(ctx) && ctx.message && gset(ctx.chat.id).antilink) {
    const txt = ctx.message.text || ctx.message.caption || '';
    if (/(https?:\/\/|www\.|t\.me\/|telegram\.me\/)/i.test(txt) && !(await isGroupAdmin(ctx))) {
      await ctx.deleteMessage().catch(() => {});
      const w = await ctx.reply(`🚫 ${ctx.from.first_name}, dilarang kirim link di grup ini.`).catch(() => null);
      if (w) setTimeout(() => ctx.telegram.deleteMessage(ctx.chat.id, w.message_id).catch(() => {}), 5000);
      return;
    }
  }
  return next();
});

// ---- Log chat masuk: tampil di konsol panel hosting + web panel ----------------
const COLOR = process.env.NO_COLOR ? {} : { r: '\x1b[0m', b: '\x1b[1m', d: '\x1b[2m', cy: '\x1b[36m', gr: '\x1b[32m', ye: '\x1b[33m' };
const c = (k, t) => `${COLOR[k] || ''}${t}${COLOR.r || ''}`;
const RECENT_CHATS = [];
const LOG_ALL = String(cfg('LOG_ALL', '')).toLowerCase() === 'true'; // true = catat juga obrolan biasa di grup
const jamWIB = () => new Date().toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour12: false }).replace(/\./g, ':');
function describeMessage(m) {
  const kinds = [['photo', 'foto'], ['video', 'video'], ['voice', 'pesan suara'], ['audio', 'audio'], ['sticker', 'stiker'], ['document', 'dokumen'],
    ['animation', 'GIF'], ['location', 'lokasi'], ['contact', 'kontak'], ['poll', 'polling'], ['new_chat_members', 'anggota baru'], ['left_chat_member', 'anggota keluar']];
  const kind = (kinds.find(([k]) => m[k]) || [])[1];
  if (m.text) return m.text;
  if (kind) return m.caption ? `[${kind}] ${m.caption}` : `[${kind}]`;
  return '[pesan lain]';
}
function logIncoming(ctx) {
  const u = ctx.from;
  if (!u || u.is_bot) return;
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || String(u.id);
  const who = `${c('b', name)} ${c('d', `(${u.id}${u.username ? ' @' + u.username : ''})`)}`;
  let text;
  let where;
  let icon = '💬';
  if (ctx.callbackQuery) {
    icon = '🔘';
    text = `tombol ${ctx.callbackQuery.data || ''}`;
    where = '';
  } else if (ctx.message) {
    text = describeMessage(ctx.message);
    const group = inGroup(ctx);
    if (group && !text.startsWith('/') && !LOG_ALL) return; // obrolan biasa di grup tidak dicatat (terlalu ramai)
    where = group ? ` di "${ctx.chat.title}"` : '';
    if (text.startsWith('/')) icon = '⌨️';
  } else {
    return;
  }
  text = String(text).replace(/^(\/(?:setpassword|passwordpanel|vpspanel)(?:@\w+)?)\s+[\s\S]+$/i, '$1 ••••••••').replace(SECRET_RE, '[TOKEN]').replace(/\s+/g, ' ').trim().slice(0, 120);
  console.log(`${c('d', jamWIB())} ${icon} ${who}${where}: ${c('cy', text)}`);
  RECENT_CHATS.push({ time: jamWIB(), name, id: u.id, where: where.trim(), text, type: icon });
  if (RECENT_CHATS.length > 30) RECENT_CHATS.shift();
}
bot.use((ctx, next) => {
  try {
    logIncoming(ctx);
  } catch (_) {}
  return next();
});

async function isGroupAdmin(ctx, userId = ctx.from.id) {
  if (isOwner(userId)) return true;
  if (!inGroup(ctx)) return false;
  try {
    const m = await ctx.telegram.getChatMember(ctx.chat.id, userId);
    return ['creator', 'administrator'].includes(m.status);
  } catch (_) {
    return false;
  }
}

const ownerCmd = (names, fn) =>
  bot.command(names, async (ctx) => {
    if (!isOwner(ctx.from.id)) return ctx.reply('⛔ Khusus owner.');
    try {
      await fn(ctx);
    } catch (e) {
      console.error(e);
      ctx.reply('❌ Terjadi error.');
    }
  });

const adminCmd = (names, fn) =>
  bot.command(names, async (ctx) => {
    if (!inGroup(ctx)) return ctx.reply('⚠️ Perintah ini hanya untuk grup.');
    if (!(await isGroupAdmin(ctx))) return ctx.reply('⛔ Khusus admin grup.');
    try {
      await fn(ctx);
    } catch (e) {
      ctx.reply(`❌ Gagal: ${e.description || e.message}\nPastikan bot sudah jadi admin dengan izin yang cukup.`);
    }
  });

// ===========================================================================
// 👑 Owner
// ===========================================================================
ownerCmd('addowner', (ctx) => {
  const t = getTarget(ctx);
  if (!t) return ctx.reply('Pakai: /addowner <user_id> atau reply pesan orangnya.');
  if (OWNERS.has(t)) return ctx.reply('Dia sudah jadi owner.');
  OWNERS.add(t);
  saveOwners();
  ctx.reply(`✅ ${t} sekarang owner.`);
});

ownerCmd('delowner', (ctx) => {
  const t = getTarget(ctx);
  if (!t) return ctx.reply('Pakai: /delowner <user_id> atau reply.');
  if (MAIN_OWNERS.has(t)) return ctx.reply('Owner utama tidak bisa dihapus.');
  if (!OWNERS.has(t)) return ctx.reply('Dia bukan owner.');
  OWNERS.delete(t);
  saveOwners();
  ctx.reply(`🗑️ ${t} dihapus dari owner.`);
});

ownerCmd('owners', (ctx) => {
  const list = [...OWNERS].map((o) => `• ${o}${MAIN_OWNERS.has(o) ? ' (utama)' : ''}`).join('\n');
  ctx.reply(`👑 Daftar owner:\n${list || '-'}`);
});

ownerCmd(['bc', 'broadcast'], async (ctx) => {
  const r = ctx.message.reply_to_message;
  const text = argText(ctx) || (r && (r.text || r.caption)) || '';
  if (!text) return ctx.reply('Pakai: /bc <pesan> atau reply pesan.');
  const status = await ctx.reply(`📢 Mengirim ke ${USERS.size} user...`);
  const { ok, fail } = await doBroadcast(text);
  ctx.telegram.editMessageText(ctx.chat.id, status.message_id, undefined, `✅ Broadcast selesai.\nBerhasil: ${ok}\nGagal: ${fail}`).catch(() => {});
});

// ---- Profil, XP, hadiah harian (upgrade v4) --------------------------------
const xpBar = (xp) => {
  const l = levelOf(xp);
  const lo = 25 * (l - 1) ** 2;
  const hi = 25 * l ** 2;
  const frac = Math.min(1, Math.max(0, (xp - lo) / (hi - lo)));
  const n = Math.round(frac * 10);
  return `${'▰'.repeat(n)}${'▱'.repeat(10 - n)} ${xp - lo}/${hi - lo}`;
};
const todayWIB = (offsetDays = 0) =>
  new Date(Date.now() + offsetDays * 864e5).toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' });
const nf = new Intl.NumberFormat('id-ID');

function sendProfile(ctx) {
  const p = getP(ctx.from);
  const l = levelOf(p.xp);
  const ranked = Object.entries(STATS.users).sort((a, b) => b[1].xp - a[1].xp);
  const rank = ranked.findIndex(([id]) => Number(id) === ctx.from.id) + 1;
  ctx.reply(
    `👤 <b>PROFIL ${esc(ctx.from.first_name)}</b> ${p.badge || ''}\n\n` +
      `🏅 Level ${l} — ${titleOf(l)}\n${xpBar(p.xp)} XP\n\n` +
      `💰 Koin: ${nf.format(p.coins)}\n⌨️ Perintah dipakai: ${nf.format(p.cmds)}\n🔥 Streak harian: ${p.streak} hari\n🏆 Peringkat: #${rank || '-'} dari ${ranked.length}\n\n` +
      `<i>Tiap perintah memberi XP. Menangkan game untuk dapat koin, dan klaim /daily setiap hari!</i>`,
    { parse_mode: 'HTML' }
  );
}
bot.command(['profil', 'profile', 'me'], sendProfile);

bot.command(['top', 'leaderboard'], (ctx) => {
  const ranked = Object.values(STATS.users).filter((p) => p.xp > 0).sort((a, b) => b.xp - a.xp).slice(0, 10);
  if (!ranked.length) return ctx.reply('Belum ada data peringkat.');
  const medal = ['🥇', '🥈', '🥉'];
  ctx.reply(
    '🏆 <b>TOP 10 PENGGUNA</b>\n\n' +
      ranked.map((p, i) => `${medal[i] || `${i + 1}.`} ${p.badge ? p.badge.split(' ')[0] + ' ' : ''}${esc(p.name || 'User')} — Lv ${levelOf(p.xp)} • ${nf.format(p.xp)} XP`).join('\n'),
    { parse_mode: 'HTML' }
  );
});

bot.command(['daily', 'harian'], (ctx) => {
  const p = getP(ctx.from);
  const today = todayWIB();
  if (p.daily === today) return ctx.reply('🎁 Hadiah hari ini sudah kamu ambil. Kembali lagi besok ya!');
  p.streak = p.daily === todayWIB(-1) ? p.streak + 1 : 1;
  p.daily = today;
  const coins = 100 + Math.min(p.streak, 7) * 25;
  reward(ctx, coins, 20);
  ctx.reply(`🎁 <b>Hadiah Harian!</b>\n💰 +${coins} koin\n✨ +20 XP\n🔥 Streak: ${p.streak} hari (maks bonus di 7 hari)`, { parse_mode: 'HTML' });
});

ownerCmd('botban', (ctx) => {
  const t = getTarget(ctx);
  if (!t) return ctx.reply('Pakai: /botban <user_id> atau reply pesannya.');
  if (isOwner(t)) return ctx.reply('❌ Tidak bisa memblokir owner.');
  BANNED.add(t);
  saveBanned();
  ctx.reply(`🚫 ${t} diblokir dari bot.`);
});
ownerCmd('botunban', (ctx) => {
  const t = getTarget(ctx);
  if (!t) return ctx.reply('Pakai: /botunban <user_id> atau reply pesannya.');
  BANNED.delete(t);
  saveBanned();
  ctx.reply(`✅ ${t} dibuka blokirnya.`);
});
ownerCmd('banlist', (ctx) => ctx.reply(BANNED.size ? '🚫 Daftar blokir:\n' + [...BANNED].map((b) => `• ${b}`).join('\n') : '✅ Tidak ada user yang diblokir.'));

function stopAndExit(code) {
  saveStats();
  try {
    bot.stop('POWER');
  } catch (_) {}
  setTimeout(() => process.exit(code), 800);
}

ownerCmd('off', (ctx) => {
  STATE.active = false;
  saveState();
  ctx.reply('🔴 Bot masuk mode STANDBY.\nHanya owner yang bisa memakai bot. Ketik /on untuk mengaktifkan lagi.');
});

ownerCmd('on', (ctx) => {
  STATE.active = true;
  saveState();
  ctx.reply('🟢 Bot AKTIF kembali untuk semua user.');
});

ownerCmd('restart', async (ctx) => {
  const m = await ctx.reply('🔄 Merestart bot... tunggu beberapa detik.');
  fs.writeFileSync(file('restart.json'), JSON.stringify({ chat: ctx.chat.id, msg: m.message_id, t: Date.now() }));
  stopAndExit(RESTART_EXIT_CODE);
});

ownerCmd('shutdown', (ctx) =>
  ctx.reply(
    '⚠️ Yakin mau mematikan bot?\nBot tidak bisa dinyalakan lewat Telegram, harus lewat tombol Start di panel.',
    Markup.inlineKeyboard([[Markup.button.callback('✅ Ya, matikan', 'pw:shutdown'), Markup.button.callback('❌ Batal', 'pw:cancel')]])
  )
);

bot.action(/^pw:(.+)$/, async (ctx) => {
  if (!isOwner(ctx.from.id)) return ctx.answerCbQuery('⛔ Khusus owner', { show_alert: true }).catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  if (ctx.match[1] === 'shutdown') {
    await ctx.editMessageText('🔴 Bot dimatikan. Sampai jumpa!').catch(() => {});
    return stopAndExit(0);
  }
  ctx.editMessageText('✅ Dibatalkan.').catch(() => {});
});

ownerCmd('status', (ctx) => {
  const load = os.loadavg()[0].toFixed(2);
  ctx.reply(
    `📊 <b>STATUS BOT</b>\n` +
      `• Versi: v${VERSION}\n• Mode: ${STATE.active ? '🟢 Aktif' : '🔴 Standby'}\n• Uptime: ${uptime()}\n` +
      `• RAM bot: ${ramMB()} MB\n• CPU load: ${load}\n• Node.js: ${process.version}\n` +
      `• Banner: ${bannerCount()}/${BANNER_KEYS.length}\n• User terdaftar: ${USERS.size}\n• Grup tercatat: ${Object.keys(GROUPS).length}\n• Owner: ${OWNERS.size}`,
    { parse_mode: 'HTML' }
  );
});

// ===========================================================================
// 🎮 Game
// ===========================================================================
bot.command('dadu', (ctx) => ctx.replyWithDice({ emoji: pick(['🎲', '🎯', '🏀', '⚽', '🎳']) }));

const tebakGame = new Map();
bot.command('tebak', (ctx) => {
  tebakGame.set(ctx.from.id, { target: rand(1, 100), tries: 0 });
  ctx.reply('🔢 Aku memilih angka 1-100. Tebak dengan /angka <angka>');
});
bot.command('angka', (ctx) => {
  const g = tebakGame.get(ctx.from.id);
  if (!g) return ctx.reply('Mulai dulu dengan /tebak');
  const a = getArgs(ctx)[0];
  if (!a || !/^\d+$/.test(a)) return ctx.reply('Pakai: /angka 42');
  const guess = Number(a);
  g.tries++;
  if (guess < g.target) return ctx.reply('⬆️ Terlalu kecil!');
  if (guess > g.target) return ctx.reply('⬇️ Terlalu besar!');
  tebakGame.delete(ctx.from.id);
  const koin = Math.max(10, 60 - g.tries * 5);
  reward(ctx, koin);
  ctx.reply(`🎉 Benar! Angkanya ${g.target} (${g.tries}x tebakan).\n💰 +${koin} koin`);
});

const SUIT = { batu: '🪨', gunting: '✂️', kertas: '📄' };
const MENANG = new Set(['batu-gunting', 'gunting-kertas', 'kertas-batu']);
bot.command('suit', (ctx) =>
  ctx.reply('Pilih senjatamu:', Markup.inlineKeyboard(Object.entries(SUIT).map(([n, e]) => Markup.button.callback(`${e} ${n}`, `suit:${n}`))))
);
bot.action(/^suit:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const kamu = ctx.match[1];
  if (!SUIT[kamu]) return;
  const lawan = pick(Object.keys(SUIT));
  let hasil = 'Kamu kalah 😜';
  if (kamu === lawan) hasil = 'Seri 🤝';
  else if (MENANG.has(`${kamu}-${lawan}`)) {
    hasil = 'Kamu menang 🎉 (+10 koin)';
    reward(ctx, 10);
  }
  ctx.editMessageText(`Kamu: ${SUIT[kamu]}  vs  Bot: ${SUIT[lawan]}\n${hasil}`).catch(() => {});
});

const kuisGame = new Map();
bot.command('kuis', (ctx) => {
  const a = rand(2, 30);
  const b = rand(2, 30);
  const op = pick(['+', '-', '×']);
  const ans = op === '+' ? a + b : op === '-' ? a - b : a * b;
  kuisGame.set(ctx.from.id, ans);
  ctx.reply(`🧮 Berapa ${a} ${op} ${b} ?\nJawab dengan /jawab <angka>`);
});
bot.command('jawab', (ctx) => {
  if (!kuisGame.has(ctx.from.id)) return ctx.reply('Mulai dulu dengan /kuis');
  const a = getArgs(ctx)[0];
  if (!a || !/^-?\d+$/.test(a)) return ctx.reply('Pakai: /jawab 42');
  const ans = kuisGame.get(ctx.from.id);
  if (Number(a) === ans) {
    kuisGame.delete(ctx.from.id);
    reward(ctx, 20);
    return ctx.reply('✅ Benar! 💰 +20 koin\nKetik /kuis untuk soal baru.');
  }
  ctx.reply('❌ Salah, coba lagi!');
});

bot.command('koin', (ctx) => ctx.reply(`🪙 Hasilnya: ${pick(['Gambar', 'Angka'])}!`));
bot.command('pilih', (ctx) => {
  const opts = argText(ctx).split(/[|,]/).map((x) => x.trim()).filter(Boolean);
  if (opts.length < 2) return ctx.reply('Pakai: /pilih nasi | mie | roti');
  ctx.reply(`🤔 Aku pilih: ${pick(opts)}`);
});

const TRUTH = [
  'Apa hal paling memalukan yang pernah kamu alami?',
  'Siapa orang yang diam-diam kamu kagumi?',
  'Apa kebohongan terbesar yang pernah kamu ucapkan?',
  'Apa kebiasaan anehmu yang jarang diketahui orang?',
  'Hal apa yang paling kamu takutkan?',
  'Pernahkah kamu menyesal membeli sesuatu? Apa itu?',
  'Siapa mantan yang paling susah dilupakan?',
  'Apa rahasia kecil yang belum pernah kamu ceritakan ke siapa pun?',
];
const DARE = [
  'Kirim voice note menyanyikan lagu favoritmu!',
  'Ganti foto profilmu dengan foto lucu selama 1 jam.',
  'Kirim stiker paling random ke grup ini 5 kali.',
  'Tulis pantun untuk anggota grup yang kamu pilih.',
  'Ceritakan lelucon dan buat 1 orang tertawa.',
  'Kirim selfie wajah konyol ke chat ini.',
  'Ketik pesan berikutnya hanya pakai huruf kapital selama 10 menit.',
];
bot.command('truth', (ctx) => ctx.reply(`🎭 TRUTH\n${pick(TRUTH)}`));
bot.command('dare', (ctx) => ctx.reply(`🔥 DARE\n${pick(DARE)}`));

// ===========================================================================
// 📥 Downloader
// ===========================================================================
async function findVideoCandidates(query, n = 5) {
  if (ytdl.validateURL(query)) return [{ url: query }];
  const r = await ytSearch(query);
  return (r.videos || []).slice(0, n).map((v) => ({ url: v.url, seconds: v.seconds }));
}

// YouTube sering mengubah sistemnya; header yang wajar + percobaan ulang + kandidat cadangan
// membuat unduhan jauh lebih jarang gagal dibanding hanya mencoba 1 video sekali.
const YTDL_OPTS = {
  requestOptions: {
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      'accept-language': 'en-US,en;q=0.9',
    },
  },
};
function isPermanentYtError(msg) {
  // error jenis ini tidak akan membaik walau dicoba ulang/ganti video lain (video memang dibatasi)
  return /sign in|age[- ]restrict|private video|unavailable|copyright|members[- ]only/i.test(msg || '');
}
async function getInfoRetry(url, tries = 2) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await ytdl.getInfo(url, YTDL_OPTS);
    } catch (e) {
      lastErr = e;
      if (isPermanentYtError(e.message)) break; // nggak usah diulang, videonya memang dibatasi
      await sleep(500);
    }
  }
  throw lastErr;
}
// Coba beberapa hasil pencarian satu per satu sampai salah satu berhasil diambil infonya,
// dengan batas waktu keseluruhan supaya tidak menggantung lama kalau semuanya lambat/gagal.
async function getWorkingInfo(query, maxSeconds = 600) {
  const candidates = await findVideoCandidates(query);
  if (!candidates.length) return { info: null, reason: 'notfound' };
  let lastErr;
  const deadline = Date.now() + 45000;
  for (const v of candidates) {
    if (Date.now() > deadline) break;
    if (v.seconds && v.seconds > maxSeconds) continue;
    try {
      const info = await getInfoRetry(v.url);
      if (Number(info.videoDetails.lengthSeconds) > maxSeconds) continue;
      return { info };
    } catch (e) {
      lastErr = e;
      console.error(`Unduh YouTube gagal untuk ${v.url}:`, e.message);
    }
  }
  return { info: null, reason: lastErr ? 'failed' : 'toolong', lastErr };
}
function YT_FAIL_MSG(what, lastErr) {
  if (lastErr && isPermanentYtError(lastErr.message)) {
    return `❌ ${what.charAt(0).toUpperCase() + what.slice(1)} ini dibatasi YouTube (perlu login/umur/khusus member), jadi tidak bisa diunduh bot.\nCoba cari judul lain.`;
  }
  return (
    `❌ Gagal mengunduh ${what} dari ${5} hasil pencarian teratas.\n` +
    `YouTube memang sering mengubah sistemnya untuk mempersulit bot pengunduh — ini bukan cuma di bot ini. ` +
    `Coba lagi beberapa saat lagi, pakai judul yang lebih spesifik, atau pakai link YouTube langsung (bukan judul).`
  );
}

function downloadStream(info, format, outFile) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(outFile);
    ytdl.downloadFromInfo(info, { format, ...YTDL_OPTS }).on('error', reject).pipe(out);
    out.on('finish', resolve).on('error', reject);
  });
}

const SPIN = ['⏳', '⌛', '⏳', '⌛'];
const DOTS = ['', '.', '..', '...'];
const progress = async (ctx, text) => {
  const m = await ctx.reply(text);
  let i = 0;
  let done = false;
  const timer = setInterval(() => {
    if (done) return;
    i++;
    ctx.telegram
      .editMessageText(ctx.chat.id, m.message_id, undefined, `${text.replace(/\.+$/, '')}${DOTS[i % 4]} ${SPIN[i % 4]}`)
      .catch(() => {});
  }, 1000);
  const stop = () => {
    done = true;
    clearInterval(timer);
  };
  return {
    edit: (t) => (stop(), ctx.telegram.editMessageText(ctx.chat.id, m.message_id, undefined, t).catch(() => {})),
    del: () => (stop(), ctx.telegram.deleteMessage(ctx.chat.id, m.message_id).catch(() => {})),
  };
};

bot.command(['lagu', 'play'], (ctx) => {
  const query = argText(ctx);
  if (!query) return ctx.reply('Pakai: /lagu <judul atau link YouTube>');
  return downloadSong(ctx, query);
});

async function downloadSong(ctx, query) {
  const st = await progress(ctx, '🔎 Mencari & mengunduh...');
  let tmp;
  try {
    const { info, reason, lastErr } = await getWorkingInfo(query);
    if (!info) {
      if (reason === 'notfound') return st.edit('❌ Lagu tidak ketemu.');
      if (reason === 'toolong') return st.edit('❌ Durasi lebih dari 10 menit.');
      return st.edit(YT_FAIL_MSG('lagu', lastErr));
    }
    const audio = ytdl.filterFormats(info.formats, 'audioonly');
    const format = audio.find((f) => f.container === 'mp4') || ytdl.chooseFormat(info.formats, { quality: 'highestaudio' });
    tmp = path.join(os.tmpdir(), `lagu_${Date.now()}.${format.container === 'mp4' ? 'm4a' : format.container}`);
    await downloadStream(info, format, tmp);
    if (fs.statSync(tmp).size > 49 * 1024 * 1024) return st.edit('❌ File lebih dari 50 MB (batas Telegram).');
    await st.edit('📤 Mengirim...');
    await ctx.replyWithAudio(
      { source: tmp, filename: `${info.videoDetails.title}.m4a` },
      { title: info.videoDetails.title, performer: info.videoDetails.author.name }
    );
    await st.del();
  } catch (e) {
    console.error('Lagu gagal:', e.message);
    st.edit(YT_FAIL_MSG('lagu', e));
  } finally {
    if (tmp) fs.unlink(tmp, () => {});
  }
}

bot.command(['video', 'ytmp4'], async (ctx) => {
  const query = argText(ctx);
  if (!query) return ctx.reply('Pakai: /video <judul atau link YouTube>');
  const st = await progress(ctx, '🔎 Mencari & mengunduh video...');
  let tmp;
  try {
    const { info, reason, lastErr } = await getWorkingInfo(query);
    if (!info) {
      if (reason === 'notfound') return st.edit('❌ Video tidak ketemu.');
      if (reason === 'toolong') return st.edit('❌ Durasi lebih dari 10 menit.');
      return st.edit(YT_FAIL_MSG('video', lastErr));
    }
    const cands = ytdl.filterFormats(info.formats, 'audioandvideo').filter((f) => f.container === 'mp4');
    if (!cands.length) return st.edit('❌ Format video tidak tersedia.');
    cands.sort((a, b) => (a.height || 0) - (b.height || 0));
    const format = [...cands].reverse().find((f) => (f.height || 0) <= 480) || cands[0];
    tmp = path.join(os.tmpdir(), `video_${Date.now()}.mp4`);
    await downloadStream(info, format, tmp);
    if (fs.statSync(tmp).size > 49 * 1024 * 1024) return st.edit('❌ File lebih dari 50 MB (batas Telegram).');
    await st.edit('📤 Mengirim...');
    await ctx.replyWithVideo({ source: tmp }, { caption: info.videoDetails.title.slice(0, 900) });
    await st.del();
  } catch (e) {
    console.error('Video gagal:', e.message);
    st.edit(YT_FAIL_MSG('video', e));
  } finally {
    if (tmp) fs.unlink(tmp, () => {});
  }
});

bot.command(['tiktok', 'tt'], async (ctx) => {
  const url = getArgs(ctx)[0];
  if (!url || !/tiktok\.com/i.test(url)) return ctx.reply('Pakai: /tiktok <link tiktok>');
  const st = await progress(ctx, '⏬ Mengunduh video TikTok...');
  try {
    const r = await fetch('https://www.tikwm.com/api/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ url, hd: '0' }),
      signal: AbortSignal.timeout(30000),
    });
    const j = await r.json();
    if (!j.data || !j.data.play) return st.edit('❌ Video tidak ditemukan / link tidak valid.');
    let link = j.data.play;
    if (link.startsWith('/')) link = 'https://www.tikwm.com' + link;
    const buf = await fetchBuffer(link);
    if (buf.length > 49 * 1024 * 1024) return st.edit('❌ File lebih dari 50 MB.');
    await ctx.replyWithVideo({ source: buf }, { caption: (j.data.title || '').slice(0, 900) });
    await st.del();
  } catch (e) {
    console.error('TikTok gagal:', e.message);
    st.edit('❌ Gagal mengunduh TikTok. Layanan pihak ketiga bisa sedang down, coba lagi nanti.');
  }
});

// ===========================================================================
// 🧠 AI (gratis, tanpa API key, via Pollinations)
// ===========================================================================
const AI_TIMEOUT = 22000; // dipangkas dari 90 detik -> maksimal ~22 detik per percobaan, supaya nggak kelamaan nunggu
async function askModel(prompt, model, history = []) {
  const r = await fetch(AI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [...history, { role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(AI_TIMEOUT),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  const text = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  if (!text) throw new Error('respons AI kosong');
  return text;
}
// Model utama & cadangan di-"lomba"kan sekaligus (bukan nunggu satu gagal dulu baru coba yang lain),
// supaya kalau salah satu model (Claude/Gemini) sedang lambat, jawaban dari yang lebih cepat tetap terpakai.
async function askAI(prompt, model, history = []) {
  if (model === FALLBACK_MODEL) return askModel(prompt, model, history);
  const race = [askModel(prompt, model, history), askModel(prompt, FALLBACK_MODEL, history)];
  try {
    return await Promise.any(race);
  } catch (e) {
    throw (e && e.errors && e.errors[0]) || e;
  }
}

// ingatan percakapan per user & per model (30 menit), supaya jawaban AI nyambung
const AI_MEM = new Map();
const MEM_TTL = 30 * 60 * 1000;
const memKey = (ctx, model) => `${ctx.from.id}:${model}`;
bot.command(['reset', 'lupa'], (ctx) => {
  let n = 0;
  for (const k of [...AI_MEM.keys()]) if (k.startsWith(`${ctx.from.id}:`)) (AI_MEM.delete(k), n++);
  ctx.reply(n ? '🧹 Ingatan percakapan AI kamu sudah dihapus.' : 'Belum ada percakapan AI yang tersimpan.');
});

function aiCommand(names, model) {
  bot.command(names, async (ctx) => {
    let prompt = argText(ctx);
    const r = ctx.message.reply_to_message;
    if (!prompt && r && (r.text || r.caption)) prompt = r.text || r.caption;
    if (!prompt) return ctx.reply(`Pakai: /${[].concat(names)[0]} <pertanyaan>`);
    ctx.sendChatAction('typing').catch(() => {});
    const st = await progress(ctx, '🤔 Sedang berpikir');
    let answer;
    const mem = AI_MEM.get(memKey(ctx, model));
    const hist = mem && Date.now() - mem.t < MEM_TTL ? mem.msgs : [];
    try {
      answer = await askAI(prompt, model, hist);
      AI_MEM.set(memKey(ctx, model), {
        t: Date.now(),
        msgs: [...hist, { role: 'user', content: prompt.slice(0, 800) }, { role: 'assistant', content: answer.slice(0, 800) }].slice(-6),
      });
    } catch (e) {
      console.error('AI gagal:', e.message);
      answer = '❌ AI gagal merespons, coba lagi nanti.';
    }
    if (answer.length <= 4000) return st.edit(answer);
    await st.del();
    await replyLong(ctx, answer);
  });
}
aiCommand('claude', CLAUDE_MODEL);
aiCommand('gemini', GEMINI_MODEL);
aiCommand(['gpt', 'chatgpt'], GPT_MODEL);
aiCommand('deepseek', DEEPSEEK_MODEL);
aiCommand('qwen', QWEN_MODEL);
aiCommand('ai', GPT_MODEL);

bot.command(['img', 'gambar'], async (ctx) => {
  const prompt = argText(ctx);
  if (!prompt) return ctx.reply('Pakai: /img <deskripsi gambar>\nContoh: /img kucing astronot di bulan');
  const st = await progress(ctx, '🎨 Membuat gambar...');
  try {
    ctx.sendChatAction('upload_photo').catch(() => {});
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&nologo=true&seed=${rand(1, 99999)}`;
    const buf = await fetchBuffer(url);
    await ctx.replyWithPhoto({ source: buf }, { caption: `🎨 ${prompt.slice(0, 900)}` });
    await st.del();
  } catch (e) {
    console.error('Gambar gagal:', e.message);
    st.edit('❌ Gagal membuat gambar, coba lagi nanti.');
  }
});

bot.command(['tr', 'translate'], async (ctx) => {
  const args = getArgs(ctx);
  const lang = args[0];
  const r = ctx.message.reply_to_message;
  const text = args.slice(1).join(' ') || (r && (r.text || r.caption)) || '';
  if (!lang || !text) return ctx.reply('Pakai: /tr <bahasa> <teks>\nContoh: /tr inggris selamat pagi\nAtau reply pesan: /tr jepang');
  try {
    const out = await askAI(`Terjemahkan teks berikut ke bahasa ${lang}. Balas HANYA hasil terjemahannya saja:\n\n${text}`, GPT_MODEL);
    await replyLong(ctx, out);
  } catch (_) {
    ctx.reply('❌ Gagal menerjemahkan, coba lagi nanti.');
  }
});

// Pencarian web gratis (DuckDuckGo, tanpa API key) + AI merangkum jawabannya.
// Catatan jujur: ini BUKAN Google beneran, cakupannya terbatas (sering cuma dapat
// info ringkas/infobox, bukan hasil pencarian lengkap). Dipakai sebagai bantuan
// tambahan, bukan pengganti pencarian manual untuk hal yang butuh info sangat baru/spesifik.
async function duckSearch(q) {
  const r = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&skip_disambig=1`, {
    signal: AbortSignal.timeout(15000),
    headers: { 'user-agent': 'Mozilla/5.0' },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
bot.command(['cari', 'search', 'browsing'], async (ctx) => {
  const q = argText(ctx);
  if (!q) return ctx.reply('Pakai: /cari <pertanyaan>\nContoh: /cari apa itu fotosintesis\n\n⚠️ Ini pencarian ringkas (DuckDuckGo), bukan Google penuh — kadang hasilnya kosong untuk topik yang sangat spesifik atau sangat baru.');
  const st = await progress(ctx, '🔎 Mencari di web');
  try {
    const d = await duckSearch(q);
    const abstract = d.AbstractText || d.Answer || (d.RelatedTopics && d.RelatedTopics[0] && d.RelatedTopics[0].Text) || '';
    const prompt = abstract
      ? `Berdasarkan cuplikan berikut, jawab pertanyaan secara singkat dan jelas dalam bahasa Indonesia.\n\nCuplikan: ${abstract}\n\nPertanyaan: ${q}`
      : `Jawab pertanyaan berikut sejelas mungkin dalam bahasa Indonesia. Tidak ada data pencarian web tambahan untuk ini, jadi jawab dari pengetahuan umum dan beri tahu kalau kamu tidak yakin atau infonya mungkin sudah usang: ${q}`;
    const answer = await askAI(prompt, GPT_MODEL);
    const note = abstract
      ? `\n\n<i>🔗 Sumber: DuckDuckGo${d.AbstractURL ? ' — ' + esc(d.AbstractURL) : ''}</i>`
      : '\n\n<i>⚠️ Tidak ada hasil pencarian web yang cocok untuk ini — jawaban di atas dari pengetahuan umum AI, bisa saja sudah usang.</i>';
    const full = answer + note;
    if (full.length <= 4000) return st.edit(full);
    await st.del();
    await replyLong(ctx, answer + note.replace(/<[^>]+>/g, ''));
  } catch (e) {
    console.error('Pencarian gagal:', e.message);
    st.edit('❌ Gagal mencari, coba lagi nanti.');
  }
});

bot.command('models', async (ctx) => {
  try {
    const r = await fetch(MODELS_URL, { signal: AbortSignal.timeout(30000) });
    const j = await r.json();
    const names = j.map((m) => (typeof m === 'string' ? m : m.name || JSON.stringify(m)));
    ctx.reply('🧠 Model tersedia:\n' + names.join(', '));
  } catch (_) {
    ctx.reply('❌ Gagal mengambil daftar model.');
  }
});

// ===========================================================================
// 🛠️ Tools
// ===========================================================================
bot.command('id', (ctx) => {
  const r = ctx.message.reply_to_message;
  let t = `🆔 <b>ID Kamu:</b> <code>${ctx.from.id}</code>\n💬 <b>ID Chat:</b> <code>${ctx.chat.id}</code>`;
  if (r && r.from) t += `\n👤 <b>ID Target:</b> <code>${r.from.id}</code>`;
  ctx.reply(t, { parse_mode: 'HTML' });
});

const ramMB = () => Math.round(process.memoryUsage().rss / 1024 / 1024);
bot.command('ping', async (ctx) => {
  const t = Date.now();
  const m = await ctx.reply('🏓 Mengukur...');
  const ms = Date.now() - t;
  const quality = ms < 300 ? '🟢 Cepat' : ms < 800 ? '🟡 Sedang' : '🔴 Lambat';
  ctx.telegram
    .editMessageText(
      ctx.chat.id, m.message_id, undefined,
      `🏓 Pong!\n⚡ Respon: ${ms} ms (${quality})\n⏱️ Uptime: ${uptime()}\n💾 RAM: ${ramMB()} MB\n🧩 Versi bot: v${VERSION}`
    )
    .catch(() => {});
});

bot.command(['calc', 'hitung'], (ctx) => {
  const expr = argText(ctx);
  if (!expr) return ctx.reply('Pakai: /calc 12*(3+4)/2\nOperator: + - * / % ^ ( )');
  if (!/^[0-9+\-*/().%^\s]+$/.test(expr)) return ctx.reply('❌ Hanya angka dan operator + - * / % ^ ( ) yang boleh.');
  try {
    const res = Function(`"use strict"; return (${expr.replace(/\^/g, '**')})`)();
    if (typeof res !== 'number' || !isFinite(res)) throw new Error('bad');
    ctx.reply(`🧮 ${expr} = ${res}`);
  } catch (_) {
    ctx.reply('❌ Ekspresi tidak valid.');
  }
});

bot.command('qr', async (ctx) => {
  const text = argText(ctx);
  if (!text) return ctx.reply('Pakai: /qr <teks atau link>');
  try {
    const buf = await fetchBuffer(`https://api.qrserver.com/v1/create-qr-code/?size=500x500&data=${encodeURIComponent(text)}`, {}, 30000);
    await ctx.replyWithPhoto({ source: buf }, { caption: '✅ QR Code siap!' });
  } catch (_) {
    ctx.reply('❌ Gagal membuat QR.');
  }
});

bot.command('cuaca', async (ctx) => {
  const kota = argText(ctx);
  if (!kota) return ctx.reply('Pakai: /cuaca <nama kota>\nContoh: /cuaca Jakarta');
  try {
    const r = await fetch(`https://wttr.in/${encodeURIComponent(kota)}?format=%l:+%c+%t+(terasa+%f),+lembap+%h,+angin+%w&lang=id`, {
      signal: AbortSignal.timeout(20000),
    });
    const t = (await r.text()).trim();
    if (!r.ok || t.length > 300) throw new Error('bad');
    ctx.reply(`🌤️ ${t}`);
  } catch (_) {
    ctx.reply('❌ Kota tidak ditemukan atau layanan cuaca sedang down.');
  }
});

bot.command(['pass', 'password'], (ctx) => {
  let n = Number(getArgs(ctx)[0]) || 16;
  n = Math.min(Math.max(n, 6), 64);
  const chars = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%^&*';
  const bytes = require('crypto').randomBytes(n);
  const pw = [...bytes].map((b) => chars[b % chars.length]).join('');
  ctx.reply(`🔐 Password (${n} karakter):\n<code>${esc(pw)}</code>`, { parse_mode: 'HTML' });
});

bot.command('b64', (ctx) => {
  const [mode, ...rest] = getArgs(ctx);
  const text = rest.join(' ');
  if (!['enc', 'dec'].includes(mode) || !text) return ctx.reply('Pakai:\n/b64 enc <teks>\n/b64 dec <kode base64>');
  try {
    const out = mode === 'enc' ? Buffer.from(text).toString('base64') : Buffer.from(text, 'base64').toString('utf8');
    ctx.reply(`<code>${esc(out)}</code>`, { parse_mode: 'HTML' });
  } catch (_) {
    ctx.reply('❌ Gagal memproses.');
  }
});

// ===========================================================================
// 👥 Group Admin
// ===========================================================================
const ALL_PERMS = {
  can_send_messages: true, can_send_audios: true, can_send_documents: true, can_send_photos: true,
  can_send_videos: true, can_send_video_notes: true, can_send_voice_notes: true, can_send_polls: true,
  can_send_other_messages: true, can_add_web_page_previews: true, can_invite_users: true,
};

const needTarget = (ctx) => {
  const r = ctx.message.reply_to_message;
  if (!r || !r.from) {
    ctx.reply('↩️ Reply pesan orang yang dituju.');
    return null;
  }
  return r.from;
};

adminCmd('kick', async (ctx) => {
  const u = needTarget(ctx);
  if (!u) return;
  if (await isGroupAdmin(ctx, u.id)) return ctx.reply('❌ Tidak bisa kick admin.');
  await ctx.telegram.banChatMember(ctx.chat.id, u.id);
  await ctx.telegram.unbanChatMember(ctx.chat.id, u.id, { only_if_banned: true });
  ctx.reply(`👢 ${u.first_name} dikeluarkan dari grup.`);
});

adminCmd('ban', async (ctx) => {
  const u = needTarget(ctx);
  if (!u) return;
  if (await isGroupAdmin(ctx, u.id)) return ctx.reply('❌ Tidak bisa ban admin.');
  await ctx.telegram.banChatMember(ctx.chat.id, u.id);
  ctx.reply(`🔨 ${u.first_name} di-ban dari grup.`);
});

adminCmd('unban', async (ctx) => {
  const t = getTarget(ctx);
  if (!t) return ctx.reply('Pakai: /unban <user_id> atau reply.');
  await ctx.telegram.unbanChatMember(ctx.chat.id, t, { only_if_banned: true });
  ctx.reply(`✅ ${t} di-unban.`);
});

adminCmd('mute', async (ctx) => {
  const u = needTarget(ctx);
  if (!u) return;
  if (await isGroupAdmin(ctx, u.id)) return ctx.reply('❌ Tidak bisa mute admin.');
  const menit = Math.max(1, Number(getArgs(ctx)[0]) || 10);
  await ctx.telegram.restrictChatMember(ctx.chat.id, u.id, {
    permissions: { can_send_messages: false },
    until_date: Math.floor(Date.now() / 1000) + menit * 60,
  });
  ctx.reply(`🔇 ${u.first_name} di-mute ${menit} menit.`);
});

adminCmd('unmute', async (ctx) => {
  const u = needTarget(ctx);
  if (!u) return;
  await ctx.telegram.restrictChatMember(ctx.chat.id, u.id, { permissions: ALL_PERMS });
  ctx.reply(`🔊 ${u.first_name} sudah bisa chat lagi.`);
});

adminCmd('pin', async (ctx) => {
  const r = ctx.message.reply_to_message;
  if (!r) return ctx.reply('↩️ Reply pesan yang mau di-pin.');
  await ctx.telegram.pinChatMessage(ctx.chat.id, r.message_id);
});

adminCmd('unpin', async (ctx) => {
  const r = ctx.message.reply_to_message;
  await ctx.telegram.unpinChatMessage(ctx.chat.id, r ? r.message_id : undefined);
  ctx.reply('📌 Pin dilepas.');
});

adminCmd(['del', 'delete'], async (ctx) => {
  const r = ctx.message.reply_to_message;
  if (!r) return ctx.reply('↩️ Reply pesan yang mau dihapus.');
  await ctx.telegram.deleteMessage(ctx.chat.id, r.message_id);
  await ctx.deleteMessage().catch(() => {});
});

adminCmd('welcome', (ctx) => {
  const v = (getArgs(ctx)[0] || '').toLowerCase();
  if (!['on', 'off'].includes(v)) return ctx.reply('Pakai: /welcome on  atau  /welcome off');
  gset(ctx.chat.id).welcome = v === 'on';
  saveGroups();
  ctx.reply(`👋 Sambutan member baru: ${v === 'on' ? 'AKTIF ✅' : 'MATI ❌'}`);
});

adminCmd('antilink', (ctx) => {
  const v = (getArgs(ctx)[0] || '').toLowerCase();
  if (!['on', 'off'].includes(v)) return ctx.reply('Pakai: /antilink on  atau  /antilink off');
  gset(ctx.chat.id).antilink = v === 'on';
  saveGroups();
  ctx.reply(`🚫 Anti-link: ${v === 'on' ? 'AKTIF ✅ (bot harus jadi admin)' : 'MATI ❌'}`);
});

adminCmd('tagadmin', async (ctx) => {
  const admins = await ctx.telegram.getChatAdministrators(ctx.chat.id);
  const list = admins.filter((a) => !a.user.is_bot).map((a) => mention(a.user)).join(' ');
  ctx.reply(`📣 Panggilan untuk admin:\n${list}${argText(ctx) ? '\n\n' + esc(argText(ctx)) : ''}`, { parse_mode: 'HTML' });
});

bot.command(['groupinfo', 'infogrup'], async (ctx) => {
  if (!inGroup(ctx)) return ctx.reply('⚠️ Perintah ini hanya untuk grup.');
  const [count, admins] = await Promise.all([
    ctx.telegram.getChatMembersCount(ctx.chat.id).catch(() => '?'),
    ctx.telegram.getChatAdministrators(ctx.chat.id).catch(() => []),
  ]);
  const s = gset(ctx.chat.id);
  ctx.reply(
    `👥 <b>${esc(ctx.chat.title)}</b>\n• ID: <code>${ctx.chat.id}</code>\n• Anggota: ${count}\n• Admin: ${admins.length}\n` +
      `• Welcome: ${s.welcome ? 'ON' : 'OFF'}\n• Anti-link: ${s.antilink ? 'ON' : 'OFF'}`,
    { parse_mode: 'HTML' }
  );
});

bot.on('new_chat_members', async (ctx) => {
  const g = gset(ctx.chat.id);
  const members = ctx.message.new_chat_members;
  if (g.antibot) {
    const myId = ctx.botInfo && ctx.botInfo.id;
    const bots = members.filter((m) => m.is_bot && m.id !== myId);
    if (bots.length && !(await isGroupAdmin(ctx))) {
      for (const b of bots) await ctx.telegram.banChatMember(ctx.chat.id, b.id).catch(() => {});
      ctx.reply(`🤖 Bot asing (${bots.map((b) => esc(b.first_name)).join(', ')}) dikeluarkan oleh Anti-bot.`).catch(() => {});
    }
  }
  const users = members.filter((u) => !u.is_bot);
  if (!users.length) return;
  if (g.captcha) return startCaptcha(ctx, users);
  return sendWelcome(ctx, users);
});

// ===========================================================================
// 🎭 Hiburan (10 fitur)
// ===========================================================================
const hashStr = (str) => {
  let h = 2166136261;
  for (const c of String(str).toLowerCase().trim()) {
    h ^= c.codePointAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};
const bar10 = (p) => '▰'.repeat(Math.round(p / 10)) + '▱'.repeat(10 - Math.round(p / 10));

async function aiReply(ctx, prompt, wait = '✨ Meracik jawaban') {
  const st = await progress(ctx, wait);
  let out;
  try {
    out = await askAI(prompt, GPT_MODEL);
  } catch (e) {
    console.error('AI gagal:', e.message);
    out = '❌ AI sedang sibuk, coba lagi nanti.';
  }
  if (out.length <= 4000) return st.edit(out);
  await st.del();
  await replyLong(ctx, out);
}

const GOMBAL = [
  'Kamu tahu bedanya kamu sama kopi? Kopi bikin aku melek, kalau kamu bikin aku susah tidur.',
  'Kalau kamu jadi WiFi, aku rela jadi sinyal yang selalu nyari kamu.',
  'Aku bukan matematikawan, tapi aku yakin kita adalah solusi dari semua soal hidupku.',
  'Kamu itu kayak baterai 1%, bikin aku panik kalau jauh.',
  'Cuaca hari ini cerah ya? Eh, ternyata itu senyummu.',
  'Kamu pasti capek ya? Soalnya dari tadi muter-muter terus di pikiranku.',
  'Aku suka hujan, tapi lebih suka kalau berteduhnya sama kamu.',
  'Kalau cinta itu kode, cuma kamu yang bikin aku rela debugging semalaman.',
  'Dunia punya tujuh keajaiban, tapi aku cuma butuh satu: kamu.',
  'Kamu itu kayak charger, tanpa kamu aku lemes.',
  'Kamu bukan Google, tapi kamu selalu jadi jawaban dari semua pencarianku.',
  'Kalau kamu bintang, aku rela jadi langit malam biar bisa selalu dekat kamu.',
];
const JOKES = [
  'Hewan apa yang paling hemat? Semut, karena rajin menabung makanan.',
  'Kenapa komputer nggak pernah kedinginan? Karena banyak "Windows"-nya.',
  'Kenapa buku matematika sedih? Karena banyak masalah.',
  'Jomblo itu kayak sinyal 1 bar: ada sih, tapi nggak bisa diandalkan.',
  'Kenapa programmer suka tempat gelap? Karena light attracts bugs.',
  'Mobil apa yang paling sabar? Mobil derek, karena rela menarik yang lain.',
  'Kenapa kulkas nggak ikut lomba lari? Karena dia sudah "cool" dari sananya.',
  'Apa yang punya kaki tapi nggak bisa jalan? Meja.',
  'Kenapa pohon nggak suka main HP? Takut kena "daun-load".',
  'Kenapa tukang parkir nggak pernah stres? Karena hidupnya selalu "maju mundur" dengan tenang.',
];
const QUOTES = [
  'Jangan menunggu siap. Mulailah dari yang kamu punya, sempurnakan sambil jalan.',
  'Hari yang berat akan lewat, tapi pelajaran darinya akan tinggal.',
  'Kamu tidak perlu cepat, yang penting terus bergerak.',
  'Gagal itu bukan akhir, tapi data untuk percobaan berikutnya.',
  'Konsistensi kecil setiap hari mengalahkan semangat besar yang cuma sebentar.',
  'Bandingkan dirimu hanya dengan dirimu yang kemarin.',
  'Tidak ada jalan pintas ke tempat yang layak dituju.',
  'Istirahat itu bagian dari perjalanan, bukan tanda menyerah.',
  'Mimpi besar dimulai dari langkah yang terlihat sepele.',
  'Percaya prosesmu, hasil baik butuh waktu untuk matang.',
  'Orang hebat bukan yang tak pernah jatuh, tapi yang selalu bangkit lagi.',
  'Fokus pada apa yang bisa kamu kendalikan, lepaskan sisanya.',
];
const FAKTA = [
  'Madu hampir tidak pernah basi. Madu berusia ribuan tahun masih ditemukan aman dimakan.',
  'Gurita punya tiga jantung dan darahnya berwarna biru.',
  'Secara botani, pisang termasuk buah beri, sedangkan stroberi bukan.',
  'Menara Eiffel bisa bertambah tinggi belasan sentimeter saat musim panas karena logamnya memuai.',
  'Lumba-lumba tidur dengan separuh otak, sementara separuh lainnya tetap terjaga.',
  'Cahaya Matahari butuh sekitar 8 menit untuk sampai ke Bumi.',
  'Semut tidak punya paru-paru, mereka bernapas lewat lubang-lubang kecil di tubuhnya.',
  'Satu hari di Venus lebih lama daripada satu tahunnya.',
  'Indonesia memiliki belasan ribu pulau, salah satu negara kepulauan terbesar di dunia.',
  'Sidik jari koala sangat mirip dengan sidik jari manusia.',
  'Jantung udang terletak di bagian kepalanya.',
  'Rata-rata manusia berkedip belasan kali setiap menit.',
];
const BOLA = [
  'Ya, pasti! ✅', 'Sepertinya iya 👍', 'Tanda-tandanya positif ✨', 'Bisa jadi... 🤔', 'Tanya lagi nanti ya 🔮',
  'Aku nggak bisa menjawab sekarang 🌫️', 'Jangan terlalu berharap 😬', 'Jawabanku: tidak ❌', 'Sepertinya tidak 👎',
  'Sangat meragukan 😕', 'Fokus dulu, nanti juga ketahuan 😉', 'Lakukan saja! 🚀',
];
const KHODAMS = [
  'Kulkas 2 Pintu', 'Macan Sirkuit', 'Naga WiFi', 'Burung Dara Wangi', 'Harimau Paddle Pop', 'Tuyul Cuci Piring',
  'Kucing Oren Sakti', 'Genderuwo Gamer', 'Tuyul Kuota Unlimited', 'Singa Mager', 'Ayam Geprek Level 5', 'Naga Rebahan',
  'Cicak Tukang Ghosting', 'Bebek Sultan', 'Kerbau Bersepatu', 'Elang Hemat Baterai', 'Ular Cleaning Service',
  'Kodok Pelukis', 'Panda Lembur', 'Burung Hantu Begadang',
];

bot.command('gombal', (ctx) => ctx.reply(`💘 ${pick(GOMBAL)}`));
bot.command('jokes', (ctx) => ctx.reply(`😂 ${pick(JOKES)}`));
bot.command('quote', (ctx) => ctx.reply(`💭 “${pick(QUOTES)}”`));
bot.command('fakta', (ctx) => ctx.reply(`🧠 Tahukah kamu?\n${pick(FAKTA)}`));

bot.command(['8ball', 'bola'], (ctx) => {
  const q = argText(ctx);
  if (!q) return ctx.reply('Pakai: /8ball <pertanyaan>\nContoh: /8ball apakah hari ini hari keberuntunganku?');
  ctx.reply(`🎱 ${esc(q)}\n\n${pick(BOLA)}`);
});

bot.command('jodoh', async (ctx) => {
  const names = argText(ctx).split(/\s*(?:\||&|\+|\bdan\b|\bx\b)\s*/i).map((x) => x.trim()).filter(Boolean);
  if (names.length < 2) return ctx.reply('Pakai: /jodoh nama1 | nama2\nContoh: /jodoh Budi | Siti');
  const [a, b] = names;
  const pct = hashStr([a, b].map((x) => x.toLowerCase()).sort().join('+')) % 101;
  const m = await ctx.reply('💘 Menghitung kecocokan...\n▱▱▱▱▱▱▱▱▱▱');
  for (const p of [30, 60, 90]) {
    await sleep(150);
    await ctx.telegram.editMessageText(ctx.chat.id, m.message_id, undefined, `💘 Menghitung kecocokan...\n${bar10(p)}`).catch(() => {});
  }
  const comment =
    pct >= 85 ? 'Jodoh banget! Tinggal tentukan tanggal 💍' :
    pct >= 65 ? 'Cocok nih, lanjutkan! 😍' :
    pct >= 40 ? 'Lumayan, perlu usaha lebih 😉' :
    pct >= 20 ? 'Hmm, butuh keajaiban 😅' : 'Mungkin teman saja dulu 🙏';
  ctx.telegram
    .editMessageText(ctx.chat.id, m.message_id, undefined, `💞 ${a}  ×  ${b}\n\n${bar10(pct)} ${pct}%\n${comment}\n\n(hanya hiburan ya)`)
    .catch(() => {});
});

bot.command('rate', (ctx) => {
  const t = argText(ctx);
  if (!t) return ctx.reply('Pakai: /rate <apa saja>\nContoh: /rate nasi goreng');
  const pct = hashStr(t) % 101;
  const star = '⭐'.repeat(Math.max(1, Math.round(pct / 20)));
  ctx.reply(`📊 Rating untuk "${t}"\n\n${bar10(pct)} ${pct}%\n${star}`);
});

bot.command('khodam', (ctx) => {
  const n = argText(ctx);
  if (!n) return ctx.reply('Pakai: /khodam <nama>\nContoh: /khodam Budi');
  const h = hashStr(n);
  ctx.reply(`🔮 Khodam dari ${n}:\n\n✨ ${KHODAMS[h % KHODAMS.length]}\n⚡ Kekuatan: ${(h >>> 8) % 101}%\n\n(hanya hiburan ya)`);
});

const ZODIAK = ['aries', 'taurus', 'gemini', 'cancer', 'leo', 'virgo', 'libra', 'scorpio', 'sagitarius', 'capricorn', 'aquarius', 'pisces'];
bot.command('ramal', (ctx) => {
  const z = (getArgs(ctx)[0] || '').toLowerCase();
  if (!ZODIAK.includes(z)) return ctx.reply(`Pakai: /ramal <zodiak>\nPilihan: ${ZODIAK.join(', ')}`);
  return aiReply(
    ctx,
    `Buat ramalan zodiak ${z} untuk hari ini (hiburan semata) dalam bahasa Indonesia yang santai. Bagi menjadi: Cinta, Karier, Keuangan, Kesehatan, dan Angka Keberuntungan. Singkat dan positif, tanpa pembuka panjang.`,
    '🔮 Membaca bintang'
  );
});

bot.command('pantun', (ctx) => {
  const t = argText(ctx) || 'persahabatan';
  return aiReply(ctx, `Buatkan 2 pantun lucu bahasa Indonesia bertema "${t}". Tiap pantun 4 baris (sampiran dan isi), tanpa penjelasan tambahan.`, '📜 Merangkai pantun');
});

// ===========================================================================
// ✍️ Kreator (10 fitur)
// ===========================================================================
function shift(text, up, low, dig) {
  return [...text]
    .map((ch) => {
      const c = ch.codePointAt(0);
      if (c >= 65 && c <= 90) return String.fromCodePoint(up + c - 65);
      if (c >= 97 && c <= 122) return String.fromCodePoint(low + c - 97);
      if (dig !== undefined && c >= 48 && c <= 57) return String.fromCodePoint(dig + c - 48);
      return ch;
    })
    .join('');
}
const SMALLCAPS = 'ᴀʙᴄᴅᴇꜰɢʜɪᴊᴋʟᴍɴᴏᴘǫʀsᴛᴜᴠᴡxʏᴢ';
const FANCY = [
  ['Bold', (t) => shift(t, 0x1d400, 0x1d41a, 0x1d7ce)],
  ['Bold Italic', (t) => shift(t, 0x1d468, 0x1d482)],
  ['Script', (t) => shift(t, 0x1d4d0, 0x1d4ea)],
  ['Gothic', (t) => shift(t, 0x1d56c, 0x1d586)],
  ['Monospace', (t) => shift(t, 0x1d670, 0x1d68a, 0x1d7f6)],
  ['Sans Bold', (t) => shift(t, 0x1d5d4, 0x1d5ee, 0x1d7ec)],
  ['Bulat', (t) => shift(t, 0x24b6, 0x24d0)],
  ['Fullwidth', (t) => shift(t, 0xff21, 0xff41, 0xff10)],
  ['Small Caps', (t) => [...t].map((ch) => (/[a-z]/i.test(ch) ? SMALLCAPS[ch.toLowerCase().charCodeAt(0) - 97] : ch)).join('')],
];

const textArg = (ctx) => {
  const r = ctx.message.reply_to_message;
  return argText(ctx) || (r && (r.text || r.caption)) || '';
};

bot.command(['fancy', 'font'], (ctx) => {
  const t = textArg(ctx);
  if (!t) return ctx.reply('Pakai: /fancy <teks>\nContoh: /fancy Halo Dunia');
  if (t.length > 60) return ctx.reply('❌ Maksimal 60 karakter.');
  const out = FANCY.map(([n, f]) => `<b>${n}</b>\n<code>${esc(f(t))}</code>`).join('\n\n');
  ctx.reply(`✍️ <b>Pilih gaya favoritmu</b> (ketuk teks untuk menyalin)\n\n${out}`, { parse_mode: 'HTML' });
});

bot.command(['reverse', 'balik'], (ctx) => {
  const t = textArg(ctx);
  if (!t) return ctx.reply('Pakai: /reverse <teks>');
  ctx.reply([...t].reverse().join(''));
});

bot.command('mock', (ctx) => {
  const t = textArg(ctx);
  if (!t) return ctx.reply('Pakai: /mock <teks>');
  let i = 0;
  ctx.reply([...t].map((c) => (/[a-z]/i.test(c) ? (i++ % 2 ? c.toUpperCase() : c.toLowerCase()) : c)).join(''));
});

const MORSE = {
  a: '.-', b: '-...', c: '-.-.', d: '-..', e: '.', f: '..-.', g: '--.', h: '....', i: '..', j: '.---', k: '-.-', l: '.-..',
  m: '--', n: '-.', o: '---', p: '.--.', q: '--.-', r: '.-.', s: '...', t: '-', u: '..-', v: '...-', w: '.--', x: '-..-',
  y: '-.--', z: '--..', 0: '-----', 1: '.----', 2: '..---', 3: '...--', 4: '....-', 5: '.....', 6: '-....', 7: '--...',
  8: '---..', 9: '----.', '.': '.-.-.-', ',': '--..--', '?': '..--..', '!': '-.-.--', '/': '-..-.',
};
const MORSE_REV = Object.fromEntries(Object.entries(MORSE).map(([k, v]) => [v, k]));

function modeCommand(name, usage, enc, dec) {
  bot.command(name, (ctx) => {
    const args = getArgs(ctx);
    let mode = 'enc';
    if (['enc', 'dec'].includes((args[0] || '').toLowerCase())) mode = args.shift().toLowerCase();
    const text = args.join(' ') || (ctx.message.reply_to_message && ctx.message.reply_to_message.text) || '';
    if (!text) return ctx.reply(usage);
    try {
      const out = mode === 'enc' ? enc(text) : dec(text);
      if (!out) throw new Error('kosong');
      ctx.reply(`<code>${esc(out)}</code>`, { parse_mode: 'HTML' });
    } catch (_) {
      ctx.reply('❌ Format tidak valid.');
    }
  });
}
modeCommand(
  'morse', 'Pakai:\n/morse <teks>\n/morse dec <kode morse>\nPisahkan huruf dengan spasi dan kata dengan /',
  (t) => [...t.toLowerCase()].map((c) => (c === ' ' ? '/' : MORSE[c] || '')).filter(Boolean).join(' '),
  (t) => t.trim().split(/\s+/).map((c) => (c === '/' ? ' ' : MORSE_REV[c] || '?')).join('')
);
modeCommand(
  'biner', 'Pakai:\n/biner <teks>\n/biner dec <kode biner 8-bit>',
  (t) => [...Buffer.from(t, 'utf8')].map((b) => b.toString(2).padStart(8, '0')).join(' '),
  (t) => {
    const bytes = t.replace(/[^01]/g, '').match(/.{8}/g);
    return Buffer.from(bytes.map((b) => parseInt(b, 2))).toString('utf8');
  }
);

const EMOJI = {
  cinta: '❤️', sayang: '😘', makan: '🍽️', minum: '🥤', kopi: '☕', tidur: '😴', senang: '😄', sedih: '😢', marah: '😡',
  lapar: '🤤', hujan: '🌧️', panas: '🔥', dingin: '🥶', uang: '💰', motor: '🏍️', mobil: '🚗', pesawat: '✈️', rumah: '🏠',
  sekolah: '🏫', kerja: '💼', game: '🎮', musik: '🎵', lagu: '🎶', film: '🎬', foto: '📸', hp: '📱', laptop: '💻',
  bola: '⚽', anjing: '🐶', kucing: '🐱', pagi: '🌅', malam: '🌙', bintang: '⭐', hati: '💖', selamat: '🎉', ulang: '🎂',
  terima: '🙏', kasih: '💞', maaf: '🥺', halo: '👋', hai: '👋', wow: '😲', lucu: '😂', ketawa: '🤣', capek: '😮‍💨', bahagia: '🥰',
};
bot.command('emojify', (ctx) => {
  const t = textArg(ctx);
  if (!t) return ctx.reply('Pakai: /emojify <teks>\nContoh: /emojify aku sayang kamu, mau makan kopi');
  ctx.reply(t.split(/(\s+)/).map((w) => { const k = w.toLowerCase().replace(/[^a-z]/g, ''); return EMOJI[k] ? `${w} ${EMOJI[k]}` : w; }).join(''));
});

bot.command(['hitungkata', 'wc'], (ctx) => {
  const t = textArg(ctx);
  if (!t) return ctx.reply('Pakai: /hitungkata <teks> atau reply pesan');
  const words = t.trim().split(/\s+/).filter(Boolean).length;
  const sentences = (t.match(/[.!?]+/g) || []).length || 1;
  const secs = Math.max(1, Math.round((words / 200) * 60));
  ctx.reply(
    `📝 <b>Statistik Teks</b>\n• Kata: ${words}\n• Karakter: ${t.length}\n• Tanpa spasi: ${t.replace(/\s/g, '').length}\n• Kalimat: ${sentences}\n• Waktu baca: ±${secs} detik`,
    { parse_mode: 'HTML' }
  );
});

const TTS_LANGS = ['id', 'en', 'ja', 'ko', 'ar', 'es', 'fr', 'de', 'zh-CN', 'hi', 'ms', 'nl', 'pt', 'ru', 'th', 'tr'];
bot.command(['tts', 'suara'], async (ctx) => {
  const args = getArgs(ctx);
  let lang = 'id';
  if (args.length > 1 && TTS_LANGS.includes(args[0])) lang = args.shift();
  const text = args.join(' ') || (ctx.message.reply_to_message && ctx.message.reply_to_message.text) || '';
  if (!text) return ctx.reply(`Pakai: /tts [bahasa] <teks>\nContoh: /tts halo apa kabar\n/tts en good morning\nBahasa: ${TTS_LANGS.join(', ')}`);
  if (text.length > 200) return ctx.reply('❌ Maksimal 200 karakter.');
  try {
    ctx.sendChatAction('record_voice').catch(() => {});
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=${lang}&q=${encodeURIComponent(text)}`;
    const buf = await fetchBuffer(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, 30000);
    if (buf.length < 500) throw new Error('kosong');
    await ctx.replyWithAudio({ source: buf, filename: 'suara.mp3' }, { title: text.slice(0, 40), performer: 'Text to Speech' });
  } catch (e) {
    console.error('TTS gagal:', e.message);
    ctx.reply('❌ Gagal membuat suara, coba lagi nanti.');
  }
});

bot.command('caption', (ctx) => {
  const t = argText(ctx);
  if (!t) return ctx.reply('Pakai: /caption <topik foto/video>\nContoh: /caption liburan di pantai');
  return aiReply(ctx, `Buat 3 pilihan caption Instagram/TikTok bahasa Indonesia yang kreatif untuk topik: "${t}". Beri 1 emoji tiap caption dan tambahkan 5 hashtag relevan di akhir. Format ringkas, tanpa penjelasan.`, '✍️ Menulis caption');
});

bot.command('ringkas', (ctx) => {
  const t = textArg(ctx);
  if (!t) return ctx.reply('Pakai: /ringkas <teks panjang> atau reply pesan yang mau diringkas');
  return aiReply(ctx, `Ringkas teks berikut dalam bahasa Indonesia menjadi poin-poin singkat (maksimal 5 poin):\n\n${t.slice(0, 6000)}`, '📄 Meringkas');
});

// ===========================================================================
// 🧰 Utilitas (10 fitur)
// ===========================================================================
const REMINDERS = readJSON('reminders.json', []);
const saveReminders = () => writeJSON('reminders.json', REMINDERS);
const fmtDur = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} detik`;
  if (s < 3600) return `${Math.round(s / 60)} menit`;
  if (s < 86400) return `${Math.floor(s / 3600)} jam ${Math.round((s % 3600) / 60)} menit`;
  return `${Math.floor(s / 86400)} hari ${Math.floor((s % 86400) / 3600)} jam`;
};
function scheduleReminder(r) {
  setTimeout(async () => {
    const i = REMINDERS.indexOf(r);
    if (i < 0) return; // sudah dihapus pengguna
    REMINDERS.splice(i, 1);
    saveReminders();
    try {
      await bot.telegram.sendMessage(r.chat, `⏰ <b>Pengingat</b> untuk <a href="tg://user?id=${r.user}">kamu</a>:\n${esc(r.text)}`, { parse_mode: 'HTML' });
    } catch (e) {
      console.error('Pengingat gagal terkirim:', e.message);
    }
  }, Math.min(Math.max(0, r.at - Date.now()), 2 ** 31 - 1));
}
REMINDERS.forEach(scheduleReminder);

bot.command(['remind', 'ingatkan'], (ctx) => {
  const args = getArgs(ctx);
  const mine = REMINDERS.filter((r) => r.user === ctx.from.id);
  if (args[0] === 'list' || args[0] === 'daftar') {
    if (!mine.length) return ctx.reply('📭 Belum ada pengingat aktif.');
    return ctx.reply('⏰ Pengingat aktif:\n' + mine.map((r, i) => `${i + 1}. ${r.text} — ${fmtDur(r.at - Date.now())} lagi`).join('\n'));
  }
  if (args[0] === 'hapus') {
    const r = mine[Number(args[1]) - 1];
    if (!r) return ctx.reply('Pakai: /remind hapus <nomor> (lihat nomor di /remind list)');
    REMINDERS.splice(REMINDERS.indexOf(r), 1);
    saveReminders();
    return ctx.reply('🗑️ Pengingat dihapus.');
  }
  const m = /^(\d+)\s*([smjh]?)$/i.exec(args[0] || '');
  const text = args.slice(1).join(' ');
  if (!m || !text)
    return ctx.reply('Pakai: /remind <waktu> <pesan>\nSatuan: s=detik, m=menit, j=jam, h=hari\nContoh: /remind 10m minum obat\n/remind 2j meeting\nLihat daftar: /remind list');
  const mult = { s: 1e3, m: 6e4, j: 36e5, h: 864e5 }[(m[2] || 'm').toLowerCase()];
  const ms = Number(m[1]) * mult;
  if (ms < 5000 || ms > 7 * 864e5) return ctx.reply('❌ Waktu minimal 5 detik dan maksimal 7 hari.');
  const r = { chat: ctx.chat.id, user: ctx.from.id, text, at: Date.now() + ms };
  REMINDERS.push(r);
  saveReminders();
  scheduleReminder(r);
  ctx.reply(`✅ Oke! Aku ingatkan ${fmtDur(ms)} lagi:\n"${text}"`);
});

const TODOS = readJSON('todos.json', {});
const saveTodos = () => writeJSON('todos.json', TODOS);
const todoList = (arr) => (arr.length ? arr.map((t, i) => `${i + 1}. ${t.d ? '✅' : '⬜'} ${t.d ? '<s>' + esc(t.t) + '</s>' : esc(t.t)}`).join('\n') : 'Kosong 🎉');
bot.command(['todo', 'tugas'], (ctx) => {
  const args = getArgs(ctx);
  const arr = (TODOS[ctx.from.id] = TODOS[ctx.from.id] || []);
  const sub = (args[0] || 'list').toLowerCase();
  const send = (extra = '') => ctx.reply(`${extra}📋 <b>Daftar Tugas</b>\n${todoList(arr)}`, { parse_mode: 'HTML' });
  if (sub === 'list') return send();
  if (sub === 'add' || sub === 'tambah') {
    const t = args.slice(1).join(' ');
    if (!t) return ctx.reply('Pakai: /todo add <tugas>');
    arr.push({ t, d: false });
    saveTodos();
    return send('➕ Ditambahkan!\n\n');
  }
  const n = Number(args[1]) - 1;
  if (['done', 'selesai'].includes(sub) && arr[n]) {
    arr[n].d = !arr[n].d;
    saveTodos();
    return send();
  }
  if (['del', 'hapus'].includes(sub) && arr[n]) {
    arr.splice(n, 1);
    saveTodos();
    return send('🗑️ Dihapus.\n\n');
  }
  if (sub === 'clear') {
    TODOS[ctx.from.id] = [];
    saveTodos();
    return ctx.reply('🧹 Semua tugas dihapus.');
  }
  ctx.reply('Pakai:\n/todo add <tugas>\n/todo list\n/todo done <nomor>\n/todo del <nomor>\n/todo clear');
});

const NOTES = readJSON('notes.json', {});
const saveNotes = () => writeJSON('notes.json', NOTES);
bot.command(['note', 'catat'], (ctx) => {
  const args = getArgs(ctx);
  const my = (NOTES[ctx.from.id] = NOTES[ctx.from.id] || {});
  const sub = (args[0] || 'list').toLowerCase();
  const title = (args[1] || '').toLowerCase();
  if (sub === 'list') {
    const keys = Object.keys(my);
    return ctx.reply(keys.length ? '🗒️ Catatanmu:\n' + keys.map((k) => `• ${k}`).join('\n') + '\n\nLihat isi: /note lihat <judul>' : '📭 Belum ada catatan.\nSimpan: /note simpan <judul> <isi>');
  }
  if (['simpan', 'save'].includes(sub)) {
    const body = args.slice(2).join(' ') || (ctx.message.reply_to_message && ctx.message.reply_to_message.text) || '';
    if (!title || !body) return ctx.reply('Pakai: /note simpan <judul> <isi>\n(judul satu kata, atau reply pesan)');
    my[title] = body;
    saveNotes();
    return ctx.reply(`💾 Catatan "${title}" disimpan.`);
  }
  if (['lihat', 'get'].includes(sub)) return ctx.reply(my[title] ? `🗒️ ${title}\n\n${my[title]}` : '❌ Catatan tidak ditemukan.');
  if (['hapus', 'del'].includes(sub)) {
    if (!my[title]) return ctx.reply('❌ Catatan tidak ditemukan.');
    delete my[title];
    saveNotes();
    return ctx.reply('🗑️ Catatan dihapus.');
  }
  ctx.reply('Pakai:\n/note simpan <judul> <isi>\n/note lihat <judul>\n/note list\n/note hapus <judul>');
});

bot.command(['kurs', 'currency'], async (ctx) => {
  let args = getArgs(ctx).filter((a) => !/^(ke|to|=)$/i.test(a));
  let amount = 1;
  if (args.length && !isNaN(Number(args[0].replace(',', '.')))) amount = Number(args.shift().replace(',', '.'));
  const from = (args[0] || 'usd').toUpperCase();
  const to = (args[1] || 'idr').toUpperCase();
  try {
    const r = await fetch(`https://open.er-api.com/v6/latest/${encodeURIComponent(from)}`, { signal: AbortSignal.timeout(20000) });
    const j = await r.json();
    if (j.result !== 'success' || !j.rates[to]) return ctx.reply('❌ Kode mata uang tidak dikenal.\nContoh: /kurs 100 usd idr');
    const nf = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 4 });
    ctx.reply(`💱 ${nf.format(amount)} ${from} = ${nf.format(amount * j.rates[to])} ${to}\n(1 ${from} = ${nf.format(j.rates[to])} ${to})`);
  } catch (_) {
    ctx.reply('❌ Gagal mengambil kurs, coba lagi nanti.');
  }
});

const TZ = {
  jakarta: 'Asia/Jakarta', wib: 'Asia/Jakarta', bandung: 'Asia/Jakarta', surabaya: 'Asia/Jakarta', medan: 'Asia/Jakarta',
  makassar: 'Asia/Makassar', wita: 'Asia/Makassar', bali: 'Asia/Makassar', jayapura: 'Asia/Jayapura', wit: 'Asia/Jayapura',
  tokyo: 'Asia/Tokyo', seoul: 'Asia/Seoul', beijing: 'Asia/Shanghai', shanghai: 'Asia/Shanghai', hongkong: 'Asia/Hong_Kong',
  singapore: 'Asia/Singapore', singapura: 'Asia/Singapore', kualalumpur: 'Asia/Kuala_Lumpur', bangkok: 'Asia/Bangkok',
  delhi: 'Asia/Kolkata', mumbai: 'Asia/Kolkata', dubai: 'Asia/Dubai', mekkah: 'Asia/Riyadh', makkah: 'Asia/Riyadh',
  istanbul: 'Europe/Istanbul', moscow: 'Europe/Moscow', london: 'Europe/London', paris: 'Europe/Paris', berlin: 'Europe/Berlin',
  amsterdam: 'Europe/Amsterdam', madrid: 'Europe/Madrid', roma: 'Europe/Rome', cairo: 'Africa/Cairo', newyork: 'America/New_York',
  chicago: 'America/Chicago', losangeles: 'America/Los_Angeles', sydney: 'Australia/Sydney', melbourne: 'Australia/Melbourne',
  auckland: 'Pacific/Auckland',
};
bot.command(['waktu', 'jam'], (ctx) => {
  const q = argText(ctx).toLowerCase().replace(/\s+/g, '');
  const show = (label, tz) => {
    const t = new Intl.DateTimeFormat('id-ID', { timeZone: tz, dateStyle: 'full', timeStyle: 'medium' }).format(new Date());
    return `🕒 ${label}\n${t}`;
  };
  try {
    if (!q) return ctx.reply(['WIB', 'WITA', 'WIT'].map((z) => show(z, TZ[z.toLowerCase()])).join('\n\n'));
    const tz = TZ[q] || (argText(ctx).includes('/') ? argText(ctx) : null);
    if (!tz) return ctx.reply('❌ Kota tidak dikenal.\nContoh: /waktu tokyo, /waktu london, /waktu newyork\nAtau nama zona: /waktu Asia/Tokyo');
    ctx.reply(show(argText(ctx), tz));
  } catch (_) {
    ctx.reply('❌ Zona waktu tidak valid.');
  }
});

bot.command(['sholat', 'jadwalsholat'], async (ctx) => {
  const kota = argText(ctx);
  if (!kota) return ctx.reply('Pakai: /sholat <kota>\nContoh: /sholat Jakarta');
  try {
    const r = await fetch(`https://api.aladhan.com/v1/timingsByCity?city=${encodeURIComponent(kota)}&country=Indonesia&method=20`, { signal: AbortSignal.timeout(20000) });
    const j = await r.json();
    if (j.code !== 200) return ctx.reply('❌ Kota tidak ditemukan.');
    const t = j.data.timings;
    const c = (k) => String(t[k]).split(' ')[0];
    ctx.reply(
      `🕌 <b>Jadwal Sholat ${esc(kota)}</b>\n${esc(j.data.date.readable)}\n\n` +
        `• Imsak: ${c('Imsak')}\n• Subuh: ${c('Fajr')}\n• Terbit: ${c('Sunrise')}\n• Zuhur: ${c('Dhuhr')}\n• Ashar: ${c('Asr')}\n• Maghrib: ${c('Maghrib')}\n• Isya: ${c('Isha')}\n\n<i>Waktu setempat, sumber: Aladhan (metode Kemenag RI)</i>`,
      { parse_mode: 'HTML' }
    );
  } catch (_) {
    ctx.reply('❌ Gagal mengambil jadwal sholat, coba lagi nanti.');
  }
});

const UNITS = {
  panjang: { mm: 0.001, cm: 0.01, m: 1, km: 1000, in: 0.0254, inch: 0.0254, ft: 0.3048, yd: 0.9144, mi: 1609.344 },
  berat: { mg: 1e-6, g: 1e-3, kg: 1, ton: 1000, oz: 0.028349523125, lb: 0.45359237 },
  volume: { ml: 1e-3, l: 1, gal: 3.785411784 },
  data: { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 },
  waktu: { detik: 1, menit: 60, jam: 3600, hari: 86400, minggu: 604800 },
};
const toC = { c: (v) => v, f: (v) => ((v - 32) * 5) / 9, k: (v) => v - 273.15 };
const fromC = { c: (v) => v, f: (v) => (v * 9) / 5 + 32, k: (v) => v + 273.15 };
bot.command(['convert', 'konversi'], (ctx) => {
  const args = getArgs(ctx).filter((a) => !/^(ke|to|=)$/i.test(a));
  const v = Number((args[0] || '').replace(',', '.'));
  const a = (args[1] || '').toLowerCase();
  const b = (args[2] || '').toLowerCase();
  if (isNaN(v) || !a || !b)
    return ctx.reply('Pakai: /convert <angka> <dari> <ke>\nContoh: /convert 10 km mi\n/convert 100 c f\n/convert 2 gb mb\n\nSatuan: mm cm m km in ft yd mi | mg g kg ton oz lb | ml l gal | b kb mb gb tb | detik menit jam hari minggu | c f k');
  let res = null;
  if (toC[a] && fromC[b]) res = fromC[b](toC[a](v));
  else for (const cat of Object.values(UNITS)) if (cat[a] && cat[b]) res = (v * cat[a]) / cat[b];
  if (res === null) return ctx.reply('❌ Satuan tidak dikenal atau beda jenis.');
  ctx.reply(`🔁 ${v} ${a} = ${new Intl.NumberFormat('id-ID', { maximumFractionDigits: 6 }).format(res)} ${b}`);
});

bot.command(['shortlink', 'short'], async (ctx) => {
  const url = getArgs(ctx)[0];
  if (url && !isSafeUrl(url)) return ctx.reply('🛡️ Link ditolak: alamat tidak valid atau mengarah ke jaringan internal.');
  if (!url) return ctx.reply('Pakai: /shortlink <link>\nContoh: /shortlink https://contoh.com/halaman-panjang');
  try {
    const r = await fetch(`https://is.gd/create.php?format=simple&url=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(20000) });
    const t = (await r.text()).trim();
    if (!r.ok || !/^https?:\/\//.test(t)) throw new Error(t);
    ctx.reply(`🔗 Link pendek:\n${t}`);
  } catch (_) {
    ctx.reply('❌ Gagal memendekkan link.');
  }
});

bot.command(['ssweb', 'screenshot'], async (ctx) => {
  const url = getArgs(ctx)[0];
  if (url && !isSafeUrl(url)) return ctx.reply('🛡️ Link ditolak: alamat tidak valid atau mengarah ke jaringan internal.');
  if (!url) return ctx.reply('Pakai: /ssweb <link>\nContoh: /ssweb https://example.com');
  const st = await progress(ctx, '📸 Mengambil screenshot');
  try {
    const buf = await fetchBuffer(`https://image.thum.io/get/width/1280/crop/800/${url}`, {}, 60000);
    if (buf.length < 2000) throw new Error('kosong');
    await ctx.replyWithPhoto({ source: buf }, { caption: `📸 ${url}`.slice(0, 900) });
    await st.del();
  } catch (e) {
    console.error('SS gagal:', e.message);
    st.edit('❌ Gagal mengambil screenshot, coba lagi nanti.');
  }
});

bot.command(['ip', 'cekip'], async (ctx) => {
  const q = getArgs(ctx)[0];
  if (!q) return ctx.reply('Pakai: /ip <alamat ip atau domain>\nContoh: /ip 8.8.8.8');
  try {
    const r = await fetch(`https://ipwho.is/${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(20000) });
    const j = await r.json();
    if (!j.success) return ctx.reply('❌ IP/domain tidak ditemukan.');
    ctx.reply(
      `🌐 <b>Info ${esc(q)}</b>\n• IP: <code>${esc(j.ip)}</code>\n• Negara: ${esc(j.country)} ${esc(j.flag && j.flag.emoji)}\n• Wilayah: ${esc(j.region)}, ${esc(j.city)}\n` +
        `• ISP: ${esc(j.connection && j.connection.isp)}\n• Zona waktu: ${esc(j.timezone && j.timezone.id)}`,
      { parse_mode: 'HTML' }
    );
  } catch (_) {
    ctx.reply('❌ Gagal mengambil info IP.');
  }
});

// ===========================================================================
// 🚀 UPGRADE v5: ekonomi lanjutan, sistem warn, mode ngobrol AI, alat owner
// ===========================================================================

// ---- Catatan error (untuk /log) --------------------------------------------
const ERRLOG = [];
const _origErr = console.error.bind(console);
const SECRET_RE = /\d{6,}:[A-Za-z0-9_-]{25,}/g; // pola token bot
const maskSecret = (x) => (x instanceof Error ? x.message : typeof x === 'string' ? x : x && x.message ? x.message : x);
console.error = (...a) => {
  _origErr(...a.map((x) => { const m = maskSecret(x); return typeof m === 'string' ? m.replace(SECRET_RE, '[TOKEN]') : m; }));
  const t = new Date().toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta' });
  ERRLOG.push(`${t} ${a.map((x) => (x && x.message) || String(x)).join(' ').replace(SECRET_RE, '[TOKEN]').slice(0, 200)}`);
  if (ERRLOG.length > 30) ERRLOG.shift();
};

// ---- 💰 Ekonomi lanjutan ---------------------------------------------------
const cdLeft = (p, key, ms) => {
  p.cd = p.cd || {};
  return Math.max(0, (p.cd[key] || 0) + ms - Date.now());
};
const cdSet = (p, key) => {
  p.cd = p.cd || {};
  p.cd[key] = Date.now();
  statsDirty = true;
};
const wpick = (arr) => {
  let r = Math.random() * arr.reduce((s, x) => s + x.w, 0);
  for (const x of arr) if ((r -= x.w) < 0) return x;
  return arr[arr.length - 1];
};

bot.command(['saldo', 'koinku'], (ctx) => ctx.reply(`💰 Saldo kamu: ${nf.format(getP(ctx.from).coins)} koin`));

const JOBS = [
  ['kurir paket', 'mengantar 40 paket ke seluruh kota'], ['barista', 'meracik kopi untuk antrean panjang'],
  ['ojek online', 'mengantar penumpang di jam sibuk'], ['programmer freelance', 'memperbaiki bug di tengah malam'],
  ['penjaga warnet', 'menjaga warnet sampai subuh'], ['tukang kebun', 'merapikan taman kompleks'],
  ['kasir minimarket', 'melayani pembeli saat promo'], ['editor video', 'mengedit video konten kreator'],
  ['penulis konten', 'menulis lima artikel sekaligus'], ['teknisi AC', 'membersihkan AC sebelum musim panas'],
];
bot.command(['kerja', 'work'], (ctx) => {
  const p = getP(ctx.from);
  const left = cdLeft(p, 'kerja', 30 * 60e3);
  if (left) return ctx.reply(`😮‍💨 Kamu masih capek. Istirahat ${fmtDur(left)} lagi ya.`);
  cdSet(p, 'kerja');
  const [job, desc] = pick(JOBS);
  const gaji = rand(40, 120);
  reward(ctx, gaji, 8);
  ctx.reply(`💼 Kamu bekerja sebagai <b>${job}</b>, ${desc}.\n💰 Gaji: +${gaji} koin\n✨ +8 XP`, { parse_mode: 'HTML' });
});

const FISH = [
  { n: 'Sepatu butut', e: '👢', v: 0, w: 10 }, { n: 'Ikan teri', e: '🐟', v: 15, w: 30 }, { n: 'Ikan lele', e: '🐟', v: 30, w: 25 },
  { n: 'Ikan nila', e: '🐠', v: 50, w: 15 }, { n: 'Ikan koi', e: '🎏', v: 120, w: 10 }, { n: 'Hiu kecil', e: '🦈', v: 250, w: 5 },
  { n: 'Paus mini', e: '🐳', v: 600, w: 2 }, { n: 'Peti harta karun', e: '💎', v: 1000, w: 1 },
];
bot.command(['mancing', 'fish'], async (ctx) => {
  const p = getP(ctx.from);
  const left = cdLeft(p, 'mancing', 5 * 60e3);
  if (left) return ctx.reply(`🎣 Kailmu masih basah. Coba lagi ${fmtDur(left)} lagi.`);
  cdSet(p, 'mancing');
  const m = await ctx.reply('🎣 Melempar kail...');
  const edit = (t) => ctx.telegram.editMessageText(ctx.chat.id, m.message_id, undefined, t, { parse_mode: 'HTML' }).catch(() => {});
  await sleep(300);
  await edit('🌊 Menunggu ikan menggigit...');
  await sleep(250);
  const f = wpick(FISH);
  reward(ctx, f.v, 5);
  edit(
    `${f.e} Kamu mendapat <b>${f.n}</b>!\n` +
      (f.v ? `💰 Dijual seharga +${nf.format(f.v)} koin` : '🗑️ Tidak laku dijual...') +
      `\n✨ +5 XP${f.v >= 600 ? '\n🎉 TANGKAPAN LANGKA!' : ''}`
  );
});

bot.command('slot', async (ctx) => {
  const args = getArgs(ctx);
  if (!args.length) return ctx.replyWithDice({ emoji: '🎰' });
  const bet = Math.floor(Number(args[0]));
  if (!bet || bet < 10 || bet > 5000) return ctx.reply('Pakai: /slot <taruhan>\nTaruhan 10 sampai 5.000 koin. Tanpa angka = slot gratis.');
  const p = getP(ctx.from);
  if (p.coins < bet) return ctx.reply(`❌ Koinmu kurang. Saldo: ${nf.format(p.coins)}`);
  p.coins -= bet;
  statsDirty = true;
  const m = await ctx.replyWithDice({ emoji: '🎰' });
  const v = m.dice && m.dice.value;
  if (!v) {
    p.coins += bet;
    return ctx.reply('❌ Slot gagal diputar, taruhanmu dikembalikan.');
  }
  await sleep(1500);
  const mult = v === 64 ? 20 : [1, 22, 43].includes(v) ? 8 : 0;
  if (!mult) return ctx.reply(`😢 Kalah! -${nf.format(bet)} koin\nSaldo: ${nf.format(p.coins)}`);
  reward(ctx, bet * mult, 10);
  ctx.reply(`${v === 64 ? '🎉 JACKPOT 777!' : '🎊 MENANG!'} x${mult}\n💰 +${nf.format(bet * mult)} koin\nSaldo: ${nf.format(p.coins)}`);
});

bot.command(['transfer', 'kirimkoin'], (ctx) => {
  const args = getArgs(ctx);
  const r = ctx.message.reply_to_message;
  let target = null;
  let amt;
  if (r && r.from && !r.from.is_bot) {
    target = r.from;
    amt = Math.floor(Number(args[0]));
  } else if (args[0] && /^\d+$/.test(args[0]) && STATS.users[args[0]]) {
    target = { id: Number(args[0]), first_name: STATS.users[args[0]].name || args[0] };
    amt = Math.floor(Number(args[1]));
  }
  if (!target || !amt || amt < 10) return ctx.reply('Pakai: reply pesan orangnya lalu /transfer <jumlah>\natau /transfer <id> <jumlah>\nMinimal 10 koin, pajak 5%.');
  if (target.id === ctx.from.id) return ctx.reply('❌ Tidak bisa transfer ke diri sendiri.');
  const me = getP(ctx.from);
  if (me.coins < amt) return ctx.reply(`❌ Koinmu kurang. Saldo: ${nf.format(me.coins)}`);
  const tax = Math.floor(amt * 0.05);
  me.coins -= amt;
  getP(target).coins += amt - tax;
  statsDirty = true;
  ctx.reply(`💸 Transfer berhasil!\nKe: ${esc(target.first_name)}\nJumlah: ${nf.format(amt)} (pajak ${nf.format(tax)})\nDiterima: ${nf.format(amt - tax)} koin\nSisa saldo: ${nf.format(me.coins)}`);
});

const SHOP = [
  { n: '🌟 Bintang', price: 200 }, { n: '🔥 Api', price: 400 }, { n: '💎 Berlian', price: 1000 },
  { n: '👑 Mahkota', price: 2500 }, { n: '🐉 Naga', price: 5000 },
];
bot.command(['toko', 'shop'], (ctx) => {
  const p = getP(ctx.from);
  ctx.reply(
    `🏪 <b>TOKO LENCANA</b>\nLencana tampil di profil dan peringkatmu.\n\n` +
      SHOP.map((s, i) => `${i + 1}. ${s.n} — ${nf.format(s.price)} koin`).join('\n') +
      `\n\n💰 Saldo: ${nf.format(p.coins)}\n🎖️ Lencana aktif: ${p.badge || '-'}\n\nBeli dengan /beli <nomor>`,
    { parse_mode: 'HTML' }
  );
});
bot.command(['beli', 'buy'], (ctx) => {
  const item = SHOP[Number(getArgs(ctx)[0]) - 1];
  if (!item) return ctx.reply('Pakai: /beli <nomor>\nLihat daftar di /toko');
  const p = getP(ctx.from);
  if (p.badge === item.n) return ctx.reply('Kamu sudah memakai lencana ini.');
  if (p.coins < item.price) return ctx.reply(`❌ Koinmu kurang. Butuh ${nf.format(item.price)}, saldo ${nf.format(p.coins)}`);
  p.coins -= item.price;
  p.badge = item.n;
  statsDirty = true;
  ctx.reply(`✅ Berhasil membeli ${item.n}!\nLencana sudah aktif di profilmu.`);
});

// ---- 👥 Peringatan (warn), sambutan custom, aturan grup --------------------
const WARNS = readJSON('warns.json', {});
const saveWarns = () => writeJSON('warns.json', WARNS);
const MAX_WARN = 3;

adminCmd('warn', async (ctx) => {
  const u = needTarget(ctx);
  if (!u) return;
  if (await isGroupAdmin(ctx, u.id)) return ctx.reply('❌ Tidak bisa memberi peringatan ke admin.');
  const g = (WARNS[ctx.chat.id] = WARNS[ctx.chat.id] || {});
  g[u.id] = (g[u.id] || 0) + 1;
  const reason = argText(ctx);
  if (g[u.id] >= MAX_WARN) {
    delete g[u.id];
    saveWarns();
    await ctx.telegram.banChatMember(ctx.chat.id, u.id);
    await ctx.telegram.unbanChatMember(ctx.chat.id, u.id, { only_if_banned: true });
    return ctx.reply(`🚫 ${mention(u)} mencapai ${MAX_WARN} peringatan dan dikeluarkan dari grup.`, { parse_mode: 'HTML' });
  }
  saveWarns();
  ctx.reply(`⚠️ ${mention(u)} mendapat peringatan <b>${g[u.id]}/${MAX_WARN}</b>${reason ? `\nAlasan: ${esc(reason)}` : ''}`, { parse_mode: 'HTML' });
});

bot.command('warns', (ctx) => {
  if (!inGroup(ctx)) return ctx.reply('⚠️ Perintah ini hanya untuk grup.');
  const r = ctx.message.reply_to_message;
  const u = r && r.from ? r.from : ctx.from;
  const n = (WARNS[ctx.chat.id] && WARNS[ctx.chat.id][u.id]) || 0;
  ctx.reply(`📋 Peringatan ${mention(u)}: <b>${n}/${MAX_WARN}</b>`, { parse_mode: 'HTML' });
});

adminCmd('resetwarn', (ctx) => {
  const u = needTarget(ctx);
  if (!u) return;
  if (WARNS[ctx.chat.id]) delete WARNS[ctx.chat.id][u.id];
  saveWarns();
  ctx.reply(`✅ Peringatan ${mention(u)} direset.`, { parse_mode: 'HTML' });
});

adminCmd('setwelcome', (ctx) => {
  const t = argText(ctx);
  if (!t) return ctx.reply('Pakai: /setwelcome <teks>\nGunakan {nama} dan {grup}.\nContoh: /setwelcome Halo {nama}, selamat datang di {grup}! 🎉');
  const s = gset(ctx.chat.id);
  s.welcomeText = t.slice(0, 600);
  s.welcome = true;
  saveGroups();
  ctx.reply('✅ Pesan sambutan disimpan dan sambutan diaktifkan.\nMatikan dengan /welcome off');
});

adminCmd('setrules', (ctx) => {
  const t = argText(ctx);
  if (!t) return ctx.reply('Pakai: /setrules <teks aturan grup>');
  gset(ctx.chat.id).rules = t.slice(0, 1500);
  saveGroups();
  ctx.reply('✅ Aturan grup disimpan. Member bisa melihatnya dengan /rules');
});

bot.command(['rules', 'aturan'], (ctx) => {
  if (!inGroup(ctx)) return ctx.reply('⚠️ Perintah ini hanya untuk grup.');
  const r = gset(ctx.chat.id).rules;
  ctx.reply(r ? `📜 <b>Aturan ${esc(ctx.chat.title)}</b>\n\n${esc(r)}` : 'Admin belum mengatur aturan grup. (/setrules)', { parse_mode: 'HTML' });
});

// ---- 🧠 Mode ngobrol AI (chat pribadi) ------------------------------------
const CHATMODE = new Set(readJSON('chatmode.json', []).map(Number));
bot.command(['chat', 'ngobrol'], (ctx) => {
  if (ctx.chat.type !== 'private') return ctx.reply('💬 Mode ngobrol hanya bisa dipakai di chat pribadi dengan bot.');
  const v = (getArgs(ctx)[0] || '').toLowerCase();
  if (!['on', 'off'].includes(v)) return ctx.reply(`💬 Mode ngobrol: ${CHATMODE.has(ctx.from.id) ? 'AKTIF ✅' : 'MATI ❌'}\n\nPakai /chat on agar semua pesanmu langsung dibalas AI (ingat percakapan). Matikan dengan /chat off, hapus ingatan dengan /reset.`);
  if (v === 'on') CHATMODE.add(ctx.from.id);
  else CHATMODE.delete(ctx.from.id);
  writeJSON('chatmode.json', [...CHATMODE]);
  ctx.reply(v === 'on' ? '💬 Mode ngobrol AKTIF! Kirim pesan apa saja, aku akan membalas.' : '💬 Mode ngobrol dimatikan.');
});

const chatBusy = new Set();
const SYS = { role: 'system', content: 'Kamu asisten yang ramah, santai, dan membantu. Jawab dalam bahasa Indonesia kecuali pengguna memakai bahasa lain. Buat jawaban jelas dan tidak bertele-tele.' };
function registerChatMode() {
  bot.on('text', async (ctx, next) => {
    const t = ctx.message.text;
    if (!ctx.chat || ctx.chat.type !== 'private' || t.startsWith('/') || !CHATMODE.has(ctx.from.id)) return next();
    if (chatBusy.has(ctx.from.id)) return;
    chatBusy.add(ctx.from.id);
    try {
      ctx.sendChatAction('typing').catch(() => {});
      const key = memKey(ctx, GPT_MODEL);
      const mem = AI_MEM.get(key);
      const hist = mem && Date.now() - mem.t < MEM_TTL ? mem.msgs : [];
      const answer = await askAI(t.slice(0, 3000), GPT_MODEL, [SYS, ...hist]);
      AI_MEM.set(key, { t: Date.now(), msgs: [...hist, { role: 'user', content: t.slice(0, 1500) }, { role: 'assistant', content: answer.slice(0, 1500) }].slice(-12) });
      getP(ctx.from).xp += 1;
      statsDirty = true;
      await replyLong(ctx, answer);
    } catch (e) {
      console.error('Mode ngobrol gagal:', e.message);
      ctx.reply('❌ AI sedang sibuk, coba lagi sebentar.').catch(() => {});
    } finally {
      chatBusy.delete(ctx.from.id);
    }
  });
}

// ---- 👑 Alat owner: /log /statistik /backup -------------------------------
ownerCmd('log', (ctx) =>
  ctx.reply(ERRLOG.length ? '🧾 <b>Error terakhir</b>\n<code>' + esc(ERRLOG.slice(-15).join('\n')) + '</code>' : '✅ Tidak ada error tercatat.', { parse_mode: 'HTML' })
);

ownerCmd(['statistik', 'stats'], (ctx) => {
  const cmds = Object.entries(STATS.cmdCount || {}).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const tops = Object.values(STATS.users).sort((a, b) => b.cmds - a.cmds).slice(0, 3);
  ctx.reply(
    `📈 <b>STATISTIK BOT</b>\n• Total perintah dijalankan: ${nf.format(STATS.total)}\n• Pengguna terdata: ${nf.format(Object.keys(STATS.users).length)}\n\n` +
      `🔥 <b>Perintah terpopuler</b>\n${cmds.length ? cmds.map(([c, n], i) => `${i + 1}. /${c} — ${nf.format(n)}x`).join('\n') : 'Belum ada data.'}\n\n` +
      `👥 <b>Pengguna teraktif</b>\n${tops.length ? tops.map((p, i) => `${i + 1}. ${esc(p.name || 'User')} — ${nf.format(p.cmds)} perintah`).join('\n') : '-'}`,
    { parse_mode: 'HTML' }
  );
});

ownerCmd('backup', async (ctx) => {
  if (ctx.chat.type !== 'private') return ctx.reply('🔒 Backup hanya bisa diminta di chat pribadi.');
  saveStats();
  const names = ['stats.json', 'owners.json', 'users.json', 'groups.json', 'banned.json', 'todos.json', 'notes.json', 'reminders.json', 'warns.json', 'chatmode.json', 'state.json', 'vps.json'];
  const have = names.filter((n) => fs.existsSync(file(n)));
  if (!have.length) return ctx.reply('Belum ada data untuk dibackup.');
  await ctx.reply(`💾 Mengirim ${have.length} file data (env.json tidak ikut demi keamanan token)...`);
  for (const n of have) await ctx.replyWithDocument({ source: file(n), filename: n });
});

// ===========================================================================
// 🚀 v6: Musik Indonesia, game baru, utilitas baru, keamanan grup & firewall
// ===========================================================================
const chunk = (a, n) => a.reduce((r, x, i) => (i % n ? r[r.length - 1].push(x) : r.push([x]), r), []);
function shuffle(a) {
  const b = [...a];
  for (let i = b.length - 1; i > 0; i--) {
    const j = rand(0, i);
    [b[i], b[j]] = [b[j], b[i]];
  }
  return b;
}

// ---- 🎧 Musik: rekomendasi lagu Indonesia ---------------------------------
const MOODS = { santai: '😌 Santai', galau: '🌧️ Galau', semangat: '🔥 Semangat', romantis: '💕 Romantis', nostalgia: '📼 Nostalgia' };
const SONGS = [
  ['Hati-Hati di Jalan', 'Tulus', 'galau,santai'], ['Monokrom', 'Tulus', 'santai,romantis'], ['Sewindu', 'Tulus', 'romantis'],
  ['Pamit', 'Tulus', 'galau'], ['Akad', 'Payung Teduh', 'romantis,santai'], ['Resah', 'Payung Teduh', 'galau,santai'],
  ['Berdua Saja', 'Payung Teduh', 'romantis,santai'], ['Bertaut', 'Nadin Amizah', 'galau,santai'], ['Sorai', 'Nadin Amizah', 'santai,romantis'],
  ['Mangu', 'Fourtwnty', 'santai'], ['Zona Nyaman', 'Fourtwnty', 'santai,semangat'], ['Secukupnya', 'Hindia', 'santai'],
  ['Evaluasi', 'Hindia', 'galau'], ['Rumah ke Rumah', 'Hindia', 'santai,galau'], ['Rehat', 'Kunto Aji', 'santai'],
  ['Pilu Membiru', 'Kunto Aji', 'galau'], ['Celengan Rindu', 'Fiersa Besari', 'romantis,galau'], ['Waktu yang Salah', 'Fiersa Besari', 'galau'],
  ['Garis Terdepan', 'Fiersa Besari', 'semangat'], ['Tak Ingin Usai', 'Keisya Levronka', 'romantis'], ['Cinta Luar Biasa', 'Andmesh', 'romantis'],
  ['Cinta Sejati', 'Bunga Citra Lestari', 'romantis'], ['Cinta dan Rahasia', 'Yura Yunita & Glenn Fredly', 'romantis'],
  ['Janji Suci', 'Yovie & Nuno', 'romantis,nostalgia'], ['Dealova', 'Once', 'romantis,nostalgia'], ['Kangen', 'Dewa 19', 'nostalgia,romantis'],
  ['Separuh Aku', 'NOAH', 'galau'], ['Mungkin Nanti', 'Peterpan', 'galau,nostalgia'], ['Penjaga Hati', 'NOAH', 'romantis'],
  ['Ruang Rindu', 'Letto', 'galau,nostalgia'], ['Sebuah Kisah Klasik', 'Sheila On 7', 'nostalgia,romantis'], ['Dan', 'Sheila On 7', 'nostalgia,romantis'],
  ['Anugerah Terindah yang Pernah Kumiliki', 'Sheila On 7', 'romantis,nostalgia'], ['Pejantan Tangguh', 'Sheila On 7', 'semangat,nostalgia'],
  ['Melompat Lebih Tinggi', 'Sheila On 7', 'semangat'], ['Hari Bersamanya', 'Sheila On 7', 'santai,nostalgia'], ['Jangan Menyerah', "D'Masiv", 'semangat'],
  ['Laskar Pelangi', 'Nidji', 'semangat,nostalgia'], ['Bento', 'Iwan Fals', 'nostalgia,semangat'], ['Lathi', 'Weird Genius ft. Sara Fajira', 'semangat'],
  ['Dia', 'Anji', 'romantis'], ['Sadis', 'Afgan', 'galau,romantis'],
];
const CUSTOM_SONG = { url: cfg('SONG_URL', ''), title: cfg('SONG_TITLE', 'Lagu Favorit'), artist: cfg('SONG_ARTIST', '') };
const hasCustomSong = !!CUSTOM_SONG.url && isSafeUrl(CUSTOM_SONG.url);
const songIdxToday = () => Math.floor(Date.parse(todayWIB()) / 864e5) % SONGS.length;
const songLine = (s) => `<b>${esc(s[0])}</b>\n${esc(s[1])}`;
const songsOf = (mood) => SONGS.map((s, i) => [s, i]).filter(([s]) => mood === 'all' || s[2].split(',').includes(mood));
const pickSong = (mood) => pick(songsOf(mood))[1];
const songCard = (i, label) => `🎧 <i>${label}</i>\n\n${songLine(SONGS[i])}`;
const songKb = (i, mood = 'all') =>
  Markup.inlineKeyboard([[Markup.button.callback('⬇️ Unduh', `song:dl:${i}`), Markup.button.callback('🔄 Lagu lain', `song:rnd:${mood}`)]]);
const moodKb = () =>
  Markup.inlineKeyboard(chunk(Object.entries(MOODS).map(([k, l]) => Markup.button.callback(l, `song:mood:${k}`)), 3));

function customSongCard() {
  return `🎵 <i>Pilihan owner bot</i>\n\n<b>${esc(CUSTOM_SONG.title)}</b>${CUSTOM_SONG.artist ? `\n${esc(CUSTOM_SONG.artist)}` : ''}`;
}
async function sendCustomSong(ctx) {
  try {
    await ctx.replyWithAudio({ url: CUSTOM_SONG.url }, { title: CUSTOM_SONG.title, performer: CUSTOM_SONG.artist || undefined });
  } catch (e) {
    console.error('Lagu custom gagal:', e.message);
    ctx.reply('❌ Gagal memutar lagu dari URL yang diatur owner. Cek kembali "SONG_URL" di env.json.');
  }
}
function sendSongOfDay(ctx) {
  const i = songIdxToday();
  return ctx.reply(songCard(i, 'Lagu hari ini'), { parse_mode: 'HTML', ...songKb(i) });
}

bot.command(['laguhariini', 'lagutoday'], sendSongOfDay);

bot.command(['rekomendasi', 'rekomendasilagu'], (ctx) => {
  const m = (getArgs(ctx)[0] || '').toLowerCase();
  if (MOODS[m]) {
    const i = pickSong(m);
    return ctx.reply(songCard(i, `Rekomendasi · ${MOODS[m]}`), { parse_mode: 'HTML', ...songKb(i, m) });
  }
  ctx.reply('🎧 <b>Lagu apa yang kamu cari?</b>\n<i>Pilih suasana hatimu</i>', { parse_mode: 'HTML', ...moodKb() });
});

bot.command('playlist', (ctx) => {
  const m = (getArgs(ctx)[0] || '').toLowerCase();
  const mood = MOODS[m] ? m : 'all';
  const idx = shuffle(songsOf(mood).map(([, i]) => i)).slice(0, 5);
  const text = `🎶 <b>Playlist ${mood === 'all' ? 'Pilihan' : MOODS[mood]}</b>\n<i>Ketuk nomor untuk mengunduh</i>\n\n` + idx.map((i, n) => `${n + 1}. <b>${esc(SONGS[i][0])}</b> — ${esc(SONGS[i][1])}`).join('\n');
  ctx.reply(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard([idx.map((i, n) => Markup.button.callback(String(n + 1), `song:dl:${i}`))]) });
});

bot.action(/^song:(dl|rnd|mood|today|custom)(?::(.*))?$/, async (ctx) => {
  const act = ctx.match[1];
  const arg = ctx.match[2] || '';
  if (act === 'custom') {
    await ctx.answerCbQuery('🎵 Memutar...').catch(() => {});
    return sendCustomSong(ctx);
  }
  if (act === 'today') {
    await ctx.answerCbQuery().catch(() => {});
    return sendSongOfDay(ctx);
  }
  if (act === 'mood' || act === 'rnd') {
    const mood = MOODS[arg] ? arg : 'all';
    const i = pickSong(mood);
    await ctx.answerCbQuery().catch(() => {});
    return ctx.editMessageText(songCard(i, mood === 'all' ? 'Rekomendasi' : `Rekomendasi · ${MOODS[mood]}`), { parse_mode: 'HTML', ...songKb(i, mood) }).catch(() => {});
  }
  const s = SONGS[Number(arg)];
  if (!s) return ctx.answerCbQuery('Lagu tidak ditemukan').catch(() => {});
  if (heavyActive >= MAX_HEAVY) return ctx.answerCbQuery('⏳ Server sedang sibuk, coba lagi sebentar', { show_alert: true }).catch(() => {});
  await ctx.answerCbQuery('⬇️ Mengunduh...').catch(() => {});
  heavyActive++;
  try {
    await downloadSong(ctx, `${s[0]} ${s[1]} official audio`);
  } finally {
    heavyActive--;
  }
});

// ---- 🎮 Kuis (tebak lagu & bendera) ---------------------------------------
const QUIZ = new Map();
let qzSeq = 0;
function startQuiz(ctx, { q, options, answer, coins }) {
  const id = (++qzSeq).toString(36);
  QUIZ.set(id, { u: ctx.from.id, q, answer, options, coins, t: Date.now() });
  const kb = Markup.inlineKeyboard(chunk(options.map((o, i) => Markup.button.callback(o, `qz:${id}:${i}`)), 2));
  return ctx.reply(q, { parse_mode: 'HTML', ...kb });
}
bot.action(/^qz:([a-z0-9]+):(\d)$/, async (ctx) => {
  const z = QUIZ.get(ctx.match[1]);
  if (!z) return ctx.answerCbQuery('Soal sudah kedaluwarsa. Mulai lagi ya.', { show_alert: true }).catch(() => {});
  if (z.u !== ctx.from.id) return ctx.answerCbQuery('Ini soal milik orang lain. Mulai soalmu sendiri 🙂', { show_alert: true }).catch(() => {});
  QUIZ.delete(ctx.match[1]);
  const ok = z.options[Number(ctx.match[2])] === z.answer;
  if (ok) reward(ctx, z.coins, 10);
  await ctx.answerCbQuery(ok ? '✅ Benar!' : '❌ Salah').catch(() => {});
  ctx.editMessageText(`${z.q}\n\n${ok ? `✅ <b>Benar!</b> +${z.coins} koin` : `❌ <b>Salah.</b> Jawabannya: <b>${esc(z.answer)}</b>`}`, { parse_mode: 'HTML' }).catch(() => {});
});

bot.command(['tebaklagu', 'tebaklagu1'], (ctx) => {
  const s = pick(SONGS);
  const others = shuffle([...new Set(SONGS.map((x) => x[1]).filter((a) => a !== s[1]))]).slice(0, 3);
  return startQuiz(ctx, {
    q: `🎵 <b>Tebak penyanyi</b>\nLagu <b>“${esc(s[0])}”</b> dibawakan oleh siapa?`,
    options: shuffle([s[1], ...others]),
    answer: s[1],
    coins: 30,
  });
});

const FLAGS = [
  ['🇮🇩', 'Indonesia'], ['🇯🇵', 'Jepang'], ['🇰🇷', 'Korea Selatan'], ['🇲🇾', 'Malaysia'], ['🇸🇬', 'Singapura'], ['🇹🇭', 'Thailand'],
  ['🇻🇳', 'Vietnam'], ['🇵🇭', 'Filipina'], ['🇮🇳', 'India'], ['🇨🇳', 'Tiongkok'], ['🇦🇺', 'Australia'], ['🇳🇿', 'Selandia Baru'],
  ['🇬🇧', 'Inggris'], ['🇫🇷', 'Prancis'], ['🇩🇪', 'Jerman'], ['🇮🇹', 'Italia'], ['🇪🇸', 'Spanyol'], ['🇵🇹', 'Portugal'],
  ['🇳🇱', 'Belanda'], ['🇧🇷', 'Brasil'], ['🇦🇷', 'Argentina'], ['🇲🇽', 'Meksiko'], ['🇨🇦', 'Kanada'], ['🇺🇸', 'Amerika Serikat'],
  ['🇪🇬', 'Mesir'], ['🇿🇦', 'Afrika Selatan'], ['🇹🇷', 'Turki'], ['🇸🇦', 'Arab Saudi'], ['🇷🇺', 'Rusia'], ['🇨🇭', 'Swiss'],
];
bot.command(['tebakbendera', 'bendera'], (ctx) => {
  const f = pick(FLAGS);
  const others = shuffle(FLAGS.filter((x) => x[1] !== f[1])).slice(0, 3).map((x) => x[1]);
  return startQuiz(ctx, { q: `🏳️ <b>Bendera negara apa ini?</b>\n\n${f[0]}`, options: shuffle([f[1], ...others]), answer: f[1], coins: 25 });
});

// ---- 🎮 Tic-Tac-Toe (XO) lawan bot ---------------------------------------
const XO = new Map();
let xoSeq = 0;
const XO_LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];
const xoWin = (b, s) => XO_LINES.some((l) => l.every((i) => b[i] === s));
function xoBot(b) {
  const empty = b.map((v, i) => (v ? -1 : i)).filter((i) => i >= 0);
  const find = (s) => empty.find((i) => xoWin(b.map((v, j) => (j === i ? s : v)), s));
  const w = find('O');
  if (w !== undefined) return w;
  const bl = find('X');
  if (bl !== undefined) return bl;
  if (empty.includes(4)) return 4;
  const corners = [0, 2, 6, 8].filter((i) => empty.includes(i));
  return corners.length ? pick(corners) : pick(empty);
}
const xoView = (id, g, note) => {
  const cell = (v) => (v === 'X' ? '❌' : v === 'O' ? '⭕' : '▫️');
  const rows = chunk(g.b.map((v, i) => Markup.button.callback(cell(v), g.over ? 'xo:end' : `xo:${id}:${i}`)), 3);
  return { text: `⭕ <b>Tic-Tac-Toe</b>\nKamu ❌  ·  Bot ⭕\n\n${note}`, kb: Markup.inlineKeyboard(rows) };
};
bot.command(['xo', 'tictactoe'], (ctx) => {
  const id = (++xoSeq).toString(36);
  const g = { b: Array(9).fill(''), u: ctx.from.id, t: Date.now(), over: false };
  XO.set(id, g);
  const v = xoView(id, g, 'Giliranmu, pilih kotak!');
  ctx.reply(v.text, { parse_mode: 'HTML', ...v.kb });
});
bot.action('xo:end', (ctx) => ctx.answerCbQuery('Permainan sudah selesai. Main lagi: /xo').catch(() => {}));
bot.action(/^xo:([a-z0-9]+):(\d)$/, async (ctx) => {
  const id = ctx.match[1];
  const g = XO.get(id);
  if (!g) return ctx.answerCbQuery('Permainan kedaluwarsa. Mulai lagi dengan /xo', { show_alert: true }).catch(() => {});
  if (g.u !== ctx.from.id) return ctx.answerCbQuery('Ini permainan orang lain. Mulai sendiri dengan /xo 🙂', { show_alert: true }).catch(() => {});
  const pos = Number(ctx.match[2]);
  if (g.b[pos]) return ctx.answerCbQuery('Kotak sudah terisi').catch(() => {});
  g.b[pos] = 'X';
  let note = 'Giliranmu!';
  if (xoWin(g.b, 'X')) {
    g.over = true;
    reward(ctx, 50, 15);
    note = '🎉 <b>Kamu menang!</b> +50 koin';
  } else if (g.b.every(Boolean)) {
    g.over = true;
    reward(ctx, 10, 5);
    note = '🤝 <b>Seri.</b> +10 koin';
  } else {
    g.b[xoBot(g.b)] = 'O';
    if (xoWin(g.b, 'O')) {
      g.over = true;
      note = '😜 <b>Bot menang.</b> Coba lagi dengan /xo';
    } else if (g.b.every(Boolean)) {
      g.over = true;
      reward(ctx, 10, 5);
      note = '🤝 <b>Seri.</b> +10 koin';
    }
  }
  if (g.over) XO.delete(id);
  await ctx.answerCbQuery().catch(() => {});
  const v = xoView(id, g, note);
  ctx.editMessageText(v.text, { parse_mode: 'HTML', ...v.kb }).catch(() => {});
});

setInterval(() => {
  const old = Date.now() - 30 * 60e3;
  for (const [k, v] of QUIZ) if (v.t < old) QUIZ.delete(k);
  for (const [k, v] of XO) if (v.t < old) XO.delete(k);
}, 10 * 60e3).unref();

// ---- 🧰 Utilitas baru: fokus, umur, bmi, patungan -------------------------
bot.command(['fokus', 'pomodoro'], (ctx) => {
  const mnt = Math.floor(Number(getArgs(ctx)[0] || 25));
  if (!mnt || mnt < 5 || mnt > 120) return ctx.reply('Pakai: /fokus [menit]\nMenit 5 sampai 120, standarnya 25.\nContoh: /fokus 45');
  const r = { chat: ctx.chat.id, user: ctx.from.id, text: `🍅 Sesi fokus ${mnt} menit selesai! Ambil istirahat 5 menit, kamu hebat.`, at: Date.now() + mnt * 60e3 };
  REMINDERS.push(r);
  saveReminders();
  scheduleReminder(r);
  ctx.reply(`🍅 Fokus ${mnt} menit dimulai.\nSimpan HP-mu, aku kabari kalau sudah selesai.`);
});

bot.command(['umur', 'age'], (ctx) => {
  const t = argText(ctx);
  let d, mo, y;
  let m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(t);
  if (m) [d, mo, y] = [+m[1], +m[2], +m[3]];
  else if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t))) [y, mo, d] = [+m[1], +m[2], +m[3]];
  if (!m) return ctx.reply('Pakai: /umur <tanggal lahir>\nContoh: /umur 17-08-2000');
  const birth = new Date(Date.UTC(y, mo - 1, d));
  const now = new Date(`${todayWIB()}T00:00:00Z`);
  if (birth.getUTCFullYear() !== y || birth.getUTCMonth() !== mo - 1 || birth.getUTCDate() !== d || birth > now) return ctx.reply('❌ Tanggal tidak valid.');
  let yy = now.getUTCFullYear() - y;
  let mm = now.getUTCMonth() - (mo - 1);
  let dd = now.getUTCDate() - d;
  if (dd < 0) {
    mm--;
    dd += new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0)).getUTCDate();
  }
  if (mm < 0) {
    yy--;
    mm += 12;
  }
  let nb = Date.UTC(now.getUTCFullYear(), mo - 1, d);
  if (nb < now.getTime()) nb = Date.UTC(now.getUTCFullYear() + 1, mo - 1, d);
  const days = Math.round((nb - now.getTime()) / 864e5);
  const hari = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'][birth.getUTCDay()];
  ctx.reply(
    `🎂 <b>Umurmu</b>\n${yy} tahun ${mm} bulan ${dd} hari\n\n📅 Lahir hari ${hari}\n⏳ Sudah hidup ${nf.format(Math.floor((now - birth) / 864e5))} hari\n🎉 Ulang tahun berikutnya: ${days === 0 ? 'HARI INI! 🥳' : `${days} hari lagi`}`,
    { parse_mode: 'HTML' }
  );
});

bot.command('bmi', (ctx) => {
  const [kg, cm] = getArgs(ctx).map((x) => Number(x.replace(',', '.')));
  if (!kg || !cm || kg < 20 || kg > 300 || cm < 100 || cm > 250) return ctx.reply('Pakai: /bmi <berat kg> <tinggi cm>\nContoh: /bmi 60 165');
  const v = kg / (cm / 100) ** 2;
  const cat = v < 18.5 ? 'Kurus' : v < 25 ? 'Normal' : v < 30 ? 'Berat badan berlebih' : 'Obesitas';
  ctx.reply(`⚖️ <b>BMI: ${v.toFixed(1)}</b>\nKategori: ${cat}\n\n<i>Hanya perkiraan umum, bukan diagnosis medis.</i>`, { parse_mode: 'HTML' });
});

bot.command(['patungan', 'split'], (ctx) => {
  const [total, orang, pajak = 0, tip = 0] = getArgs(ctx).map((x) => Number(x.replace(',', '.')));
  if (!total || !orang || total <= 0 || orang < 1 || orang > 200) return ctx.reply('Pakai: /patungan <total> <jumlah orang> [pajak%] [tip%]\nContoh: /patungan 250000 4 10');
  const grand = total * (1 + (pajak || 0) / 100 + (tip || 0) / 100);
  const rp = (n) => 'Rp' + nf.format(Math.ceil(n));
  ctx.reply(`🧾 <b>Patungan</b>\nTotal tagihan: ${rp(total)}${pajak || tip ? `\nPajak ${pajak || 0}% + tip ${tip || 0}%: ${rp(grand)}` : ''}\nJumlah orang: ${orang}\n\n👉 <b>${rp(grand / orang)}</b> per orang`, { parse_mode: 'HTML' });
});

// ---- 🛡️ Keamanan grup: panel, captcha, anti-bot, sambutan ----------------
const SEC_ITEMS = [['antilink', '🔗 Anti-link'], ['antiflood', '🌊 Anti-flood'], ['antibot', '🤖 Anti-bot'], ['captcha', '🧩 Captcha'], ['welcome', '👋 Sambutan']];
const secView = (chatId) => {
  const g = gset(chatId);
  return {
    text:
      `🛡️ <b>Keamanan Grup</b>\n<i>Ketuk untuk menyalakan atau mematikan</i>\n\n` +
      SEC_ITEMS.map(([k, l]) => `${g[k] ? '🟢' : '⚪'} ${l}`).join('\n') +
      `\n\n<i>Bot harus jadi admin agar perlindungan bekerja.</i>`,
    kb: Markup.inlineKeyboard(SEC_ITEMS.map(([k, l]) => [Markup.button.callback(`${g[k] ? '🟢' : '⚪'} ${l}`, `sec:${k}`)])),
  };
};
adminCmd(['keamanan', 'security'], (ctx) => {
  const v = secView(ctx.chat.id);
  ctx.reply(v.text, { parse_mode: 'HTML', ...v.kb });
});
bot.action(/^sec:(.+)$/, async (ctx) => {
  if (!inGroup(ctx) || !(await isGroupAdmin(ctx))) return ctx.answerCbQuery('⛔ Khusus admin grup', { show_alert: true }).catch(() => {});
  const k = ctx.match[1];
  if (!SEC_ITEMS.some(([x]) => x === k)) return ctx.answerCbQuery().catch(() => {});
  const g = gset(ctx.chat.id);
  g[k] = !g[k];
  saveGroups();
  await ctx.answerCbQuery(g[k] ? 'Aktif' : 'Mati').catch(() => {});
  const v = secView(ctx.chat.id);
  ctx.editMessageText(v.text, { parse_mode: 'HTML', ...v.kb }).catch(() => {});
});

function sendWelcome(ctx, users) {
  const g = gset(ctx.chat.id);
  if (!g.welcome || !users.length) return;
  const names = users.map(mention).join(', ');
  let msg = g.welcomeText
    ? esc(g.welcomeText).replace(/\{nama\}/gi, names).replace(/\{grup\}/gi, esc(ctx.chat.title))
    : `👋 Selamat datang ${names} di <b>${esc(ctx.chat.title)}</b>!\nSemoga betah ya 😊`;
  if (g.rules) msg += '\n\n📜 Baca aturan grup: /rules';
  return ctx.reply(msg, { parse_mode: 'HTML' });
}

const CAPTCHA = readJSON('captcha.json', {});
const capTimers = new Map();
const saveCaptcha = () => writeJSON('captcha.json', CAPTCHA);
async function capFail(key) {
  const c = CAPTCHA[key];
  if (!c) return;
  delete CAPTCHA[key];
  capTimers.delete(key);
  saveCaptcha();
  try {
    await bot.telegram.banChatMember(c.chat, c.user);
    await bot.telegram.unbanChatMember(c.chat, c.user, { only_if_banned: true });
  } catch (_) {}
  bot.telegram.deleteMessage(c.chat, c.msg).catch(() => {});
}
function capSchedule(key) {
  const c = CAPTCHA[key];
  if (c) capTimers.set(key, setTimeout(() => capFail(key), Math.max(1000, c.at - Date.now())));
}
Object.keys(CAPTCHA).forEach(capSchedule);

async function startCaptcha(ctx, users) {
  for (const u of users) {
    try {
      await ctx.telegram.restrictChatMember(ctx.chat.id, u.id, { permissions: { can_send_messages: false } });
    } catch (_) {
      continue; // bot bukan admin: lewati captcha
    }
    const m = await ctx.reply(`🧩 <b>Verifikasi</b>\n${mention(u)}, ketuk tombol di bawah dalam 2 menit untuk membuktikan kamu manusia.`, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('✅ Saya manusia', `cap:${u.id}`)]]),
    });
    const key = `${ctx.chat.id}:${u.id}`;
    CAPTCHA[key] = { chat: ctx.chat.id, user: u.id, msg: m.message_id, at: Date.now() + 120000 };
    saveCaptcha();
    capSchedule(key);
  }
}
bot.action(/^cap:(\d+)$/, async (ctx) => {
  const uid = Number(ctx.match[1]);
  if (ctx.from.id !== uid) return ctx.answerCbQuery('Tombol ini bukan untukmu 🙂', { show_alert: true }).catch(() => {});
  const key = `${ctx.chat.id}:${uid}`;
  if (!CAPTCHA[key]) return ctx.answerCbQuery('Verifikasi sudah selesai.').catch(() => {});
  clearTimeout(capTimers.get(key));
  capTimers.delete(key);
  delete CAPTCHA[key];
  saveCaptcha();
  await ctx.telegram.restrictChatMember(ctx.chat.id, uid, { permissions: ALL_PERMS }).catch(() => {});
  await ctx.answerCbQuery('✅ Terverifikasi!').catch(() => {});
  ctx.deleteMessage().catch(() => {});
  sendWelcome(ctx, [ctx.from]);
});

// ---- 🛡️ Perintah owner: firewall -----------------------------------------
ownerCmd(['firewall', 'fw'], (ctx) => {
  const a = getArgs(ctx);
  const sub = (a[0] || '').toLowerCase();
  const now = Date.now();
  const active = Object.entries(FW.blocked).filter(([, t]) => t > now);
  const id = Number(a[1]);
  if (sub === 'on' || sub === 'off') {
    FW.on = sub === 'on';
    saveFW();
    return ctx.reply(`🛡️ Firewall ${FW.on ? 'DIAKTIFKAN ✅' : 'DIMATIKAN ❌'}`);
  }
  if (sub === 'level') {
    const v = (a[1] || '').toLowerCase();
    if (!FW_LEVELS[v]) return ctx.reply('Pakai: /fw level longgar | normal | ketat');
    FW.level = v;
    saveFW();
    return ctx.reply(`🛡️ Level firewall: ${v} (${FW_LEVELS[v].n} aksi per ${FW_LEVELS[v].win / 1000} detik)`);
  }
  if (sub === 'block') {
    if (!id || isOwner(id)) return ctx.reply('Pakai: /fw block <user_id> [menit]\n(owner tidak bisa diblokir)');
    const mnt = Math.max(1, Number(a[2]) || 60);
    FW.blocked[id] = now + mnt * 60e3;
    saveFW();
    return ctx.reply(`🔒 ${id} diblokir firewall ${mnt} menit.`);
  }
  if (sub === 'unblock') {
    if (!id) return ctx.reply('Pakai: /fw unblock <user_id>');
    delete FW.blocked[id];
    fwStrike.delete(id);
    fwHist.delete(id);
    saveFW();
    return ctx.reply(`🔓 ${id} dibuka blokirnya.`);
  }
  if (sub === 'list') return ctx.reply(active.length ? '🔒 Diblokir firewall:\n' + active.map(([u, t]) => `• ${u} — ${fmtDur(t - now)} lagi`).join('\n') : '✅ Tidak ada yang diblokir saat ini.');
  const lv = FW_LEVELS[FW.level] || FW_LEVELS.normal;
  ctx.reply(
    `🛡️ <b>FIREWALL</b>\n• Status: ${FW.on ? '🟢 Aktif' : '🔴 Mati'}\n• Level: ${FW.level} (${lv.n} aksi / ${lv.win / 1000} detik)\n• Sedang diblokir: ${active.length}\n• Total pelanggaran: ${FW.hits || 0}\n• Batas payload perintah: ${FW_MAX_PAYLOAD} karakter\n\n` +
      `<code>/fw on|off\n/fw level longgar|normal|ketat\n/fw block &lt;id&gt; [menit]\n/fw unblock &lt;id&gt;\n/fw list</code>`,
    { parse_mode: 'HTML' }
  );
});

// ---- 🎧 Kirim rekomendasi lagu saat pengguna mengirim chat biasa ----------
const songCool = new Map();
function registerSongOnChat() {
  bot.on('text', async (ctx, next) => {
    const t = ctx.message.text;
    if (!ctx.chat || ctx.chat.type !== 'private' || t.startsWith('/')) return next();
    const now = Date.now();
    if (now - (songCool.get(ctx.from.id) || 0) < 3 * 60e3) return next(); // maksimal 1x per 3 menit
    songCool.set(ctx.from.id, now);
    const i = rand(0, SONGS.length - 1);
    ctx.reply(`🎧 <i>Sambil santai, dengerin ini yuk</i>\n\n${songLine(SONGS[i])}`, { parse_mode: 'HTML', ...songKb(i) }).catch(() => {});
  });
  setInterval(() => {
    const old = Date.now() - 10 * 60e3;
    for (const [k, v] of songCool) if (v < old) songCool.delete(k);
  }, 10 * 60e3).unref();
}

// ===========================================================================
// ⭐ PREMIUM (v8.3): langganan berbayar lewat QRIS, aktivasi manual oleh owner
// ===========================================================================
// Pembayaran QRIS dikonfirmasi MANUAL oleh owner (bukan otomatis). Tidak ada API pembayaran
// yang dipanggil bot, jadi tidak ada risiko saldo bocor dari kode. Bukti bayar dicek owner sendiri.
const PREM_FILE = 'premium.json';
const PREM = readJSON(PREM_FILE, { plans: [], users: {}, qris: null, pending: {}, sales: [] });
PREM.plans = Array.isArray(PREM.plans) ? PREM.plans : [];
PREM.users = PREM.users || {};
PREM.pending = PREM.pending || {};
PREM.donPending = PREM.donPending || {};
PREM.perHari = Number(PREM.perHari) || 500; // harga per hari untuk pilihan hari sendiri (Rp)
const PREM_MIN_HARI = 7, PREM_MAX_HARI = 365;
PREM.donations = Array.isArray(PREM.donations) ? PREM.donations : [];
PREM.donMsg = PREM.donMsg || 'Sedekah ini untuk pengembangan bot. Dikelola langsung oleh owner, bot tidak menyalurkan dana sendiri.';
PREM.sales = Array.isArray(PREM.sales) ? PREM.sales : [];
if (!PREM.plans.length) PREM.plans = [{ id: 'bulan', name: 'Premium 1 Bulan', days: 30, price: 15000 }, { id: 'tahun', name: 'Premium 1 Tahun', days: 365, price: 120000 }];
const savePrem = () => writeJSON(PREM_FILE, PREM);
const isPremium = (id) => isOwner(id) || (PREM.users[id] && PREM.users[id].until > Date.now());
const premLeft = (id) => (isOwner(id) ? Infinity : Math.max(0, ((PREM.users[id] && PREM.users[id].until) || 0) - Date.now()));
// Fitur premium: batas pemakaian lebih longgar & akses ke fitur berat tanpa antrean.
const PREM_PERKS = { cooldownMs: 300, dailyLimit: 200 };
const premUsed = new Map(); // id -> { day, n }
function premSpend(id) {
  const day = todayWIB();
  const r = premUsed.get(id) || { day, n: 0 };
  if (r.day !== day) { r.day = day; r.n = 0; }
  r.n++;
  premUsed.set(id, r);
  return r.n;
}
const PRICE = (n) => 'Rp' + nf.format(Math.round(n));
// Nominal unik per pesanan: harga + 1..499 rupiah, supaya pembayaran bisa dicocokkan otomatis.
const PAY_WINDOW = 2 * 36e5;
function premUniqueAmount(price) {
  const used = new Set([...Object.values(PREM.pending), ...Object.values(PREM.donPending)].filter((o) => Date.now() - o.t < PAY_WINDOW).map((o) => o.amount));
  for (let i = 0; i < 40; i++) {
    const n = Math.floor(Math.random() * 499) + 1;
    if (!used.has(price + n)) return price + n;
  }
  return null; // terlalu banyak pesanan bersamaan
}
// Secret webhook: teks contoh (ISI_...) atau yang kurang dari 16 karakter DITOLAK, webhook tetap nonaktif
const QRIS_SECRET_RAW = String(cfg('QRIS_WEBHOOK_SECRET', '')).trim();
const QRIS_SECRET = /^isi/i.test(QRIS_SECRET_RAW) ? '' : QRIS_SECRET_RAW.length >= 16 ? QRIS_SECRET_RAW : '';
if (QRIS_SECRET_RAW && !QRIS_SECRET) console.warn('⚠️ QRIS_WEBHOOK_SECRET ditolak (masih contoh atau kurang dari 16 karakter). Webhook nonaktif.');
// Gambar QRIS dari env.json: "QRIS_IMAGE": "qris.jpg" (file di folder bot) atau URL https://...
const QRIS_IMAGE = String(cfg('QRIS_IMAGE', '')).trim();
if (QRIS_IMAGE && !PREM.qris) {
  if (/^https:\/\//i.test(QRIS_IMAGE)) PREM.qris = { file_id: null, url: QRIS_IMAGE, path: null, t: Date.now() };
  else {
    const p = path.isAbsolute(QRIS_IMAGE) ? QRIS_IMAGE : path.join(__dirname, QRIS_IMAGE);
    if (fs.existsSync(p)) PREM.qris = { file_id: null, path: p, t: Date.now() };
    else console.warn(`⚠️ QRIS_IMAGE tidak ditemukan: ${QRIS_IMAGE}`);
  }
  if (PREM.qris) savePrem();
}
// sumber gambar QRIS untuk dikirim ke pembeli: file_id (dari /setqris), URL, atau file lokal
const qrisSource = () => (PREM.qris.file_id ? PREM.qris.file_id : PREM.qris.url ? { url: PREM.qris.url } : { source: PREM.qris.path });
const premRemain = (id) => {
  const ms = premLeft(id);
  if (ms === Infinity) return 'selamanya (owner)';
  if (!ms) return 'tidak aktif';
  const d = Math.floor(ms / 864e5);
  return d >= 1 ? `${d} hari lagi` : `${Math.ceil(ms / 36e5)} jam lagi`;
};

function premHome(ctx) {
  const u = ctx.from;
  const p = PREM.users[u.id];
  const aktif = isPremium(u.id);
  const paket = PREM.plans.map((x) => `• <b>${esc(x.name)}</b> — ${PRICE(x.price)} (${x.days} hari)`).join('\n') || 'Belum ada paket.';
  const text =
    `⭐ <b>PREMIUM</b>\n\n` +
    `Status: ${aktif ? '🟢 <b>Aktif</b>' : '⚪ Belum aktif'}\n` +
    (aktif ? `Sisa waktu: ${premRemain(u.id)}\n` : '') +
    `\n<b>Keuntungan premium</b>\n• Jeda antar perintah jauh lebih singkat\n• Batas pemakaian harian lebih besar\n• Prioritas saat server sedang sibuk\n\n` +
    `<b>Paket</b>\n${paket}\n\n` +
    `Mau jumlah hari sendiri? Ketik <code>/premium 45</code> (${PREM_MIN_HARI}–${PREM_MAX_HARI} hari, ${PRICE(PREM.perHari)} per hari).\n\n` +
    (PREM.qris
      ? `Bayar dengan QRIS (ketuk <b>Bayar QRIS</b>), lalu kirim bukti pembayaran ke owner. Owner akan mengaktifkannya secara manual.`
      : `Pembayaran QRIS belum diatur oleh owner. Hubungi owner untuk aktivasi manual.`);
  const rows = [];
  if (PREM.qris) PREM.plans.forEach((x) => rows.push([Markup.button.callback(`💳 Bayar ${x.name}`, `prem:buy:${x.id}`)]));
  rows.push([Markup.button.callback('📜 Riwayat saya', 'prem:me'), Markup.button.callback('‹ Menu', 'menu:list')]);
  return { text, kb: Markup.inlineKeyboard(rows) };
}

// Pengguna memilih paket: bot tampilkan QRIS + kode pesanan unik
async function premOrder(ctx, { planId, name, days, price }) {
  if (!PREM.qris) return ctx.reply('⭐ Pembayaran belum dibuka oleh owner.');
  const amount = premUniqueAmount(price);
  if (!amount) return ctx.reply('Sedang ramai, coba lagi sebentar.');
  const kode = 'INV' + crypto.randomBytes(3).toString('hex').toUpperCase();
  PREM.pending[kode] = { user: ctx.from.id, plan: planId, name, days, price, amount, t: Date.now() };
  savePrem();
  const keterangan = `Kode pesanan: ${kode}\nPaket: ${name}\nNominal: ${PRICE(amount)}`;
  const cap = QRIS_SECRET
    ? `💳 <b>Pembayaran QRIS</b>\n\n${esc(keterangan)}\n\nBayar <b>tepat ${PRICE(amount)}</b> (nominal ini unik untuk pesananmu). Premium aktif otomatis begitu pembayaran diterima. Berlaku 2 jam.`
    : `💳 <b>Pembayaran QRIS</b>\n\n${esc(keterangan)}\n\nBayar <b>tepat ${PRICE(amount)}</b>, lalu kirim bukti ke owner dengan menulis kode <code>${kode}</code>. Kode berlaku 2 jam.`;
  try {
    await ctx.replyWithPhoto(qrisSource(), { caption: cap, parse_mode: 'HTML' });
  } catch (e) {
    await ctx.reply(cap, { parse_mode: 'HTML' });
  }
  for (const o of MAIN_OWNERS) bot.telegram.sendMessage(o, `🧾 Pesanan baru ${kode}\n${ctx.from.first_name} (${ctx.from.id}) memilih ${name} ${PRICE(price)}`).catch(() => {});
}

bot.action(/^prem:buy:([a-z0-9-]+)$/i, async (ctx) => {
  const plan = PREM.plans.find((x) => x.id === ctx.match[1]);
  if (!plan || !PREM.qris) return ctx.answerCbQuery('Paket atau QRIS tidak tersedia', { show_alert: true }).catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  return premOrder(ctx, { planId: plan.id, name: plan.name, days: plan.days, price: plan.price });
});

// Hari sendiri: /premium 45  (harga = hari × harga per hari)
const premCustomCmd = (ctx) => {
  const hari = Math.floor(Number(getArgs(ctx)[0]));
  if (!hari) return false;
  if (hari < PREM_MIN_HARI || hari > PREM_MAX_HARI) {
    ctx.reply(`❌ Pilih ${PREM_MIN_HARI} sampai ${PREM_MAX_HARI} hari.`);
    return true;
  }
  premOrder(ctx, { planId: 'custom', name: `Premium ${hari} hari`, days: hari, price: hari * PREM.perHari });
  return true;
};

bot.action('prem:me', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const mine = PREM.sales.filter((s) => s.user === ctx.from.id).slice(-5).reverse();
  const txt = mine.length ? mine.map((s) => `• ${new Date(s.t).toLocaleDateString('id-ID')} · ${esc(s.plan)} · ${PRICE(s.price)} · ${s.kode}`).join('\n') : 'Belum ada riwayat pembelian.';
  ctx.reply(`🧾 <b>Riwayat saya</b>\n\n${txt}`, { parse_mode: 'HTML' });
});

bot.command(['premium', 'vip'], (ctx) => {
  if (premCustomCmd(ctx)) return;
  if (/^riwayat$/i.test(argText(ctx))) {
    const mine = PREM.sales.filter((x) => x.user === ctx.from.id).slice(-5).reverse();
    return ctx.reply(`🧾 <b>Riwayat saya</b>\n\n${mine.length ? mine.map((x) => `• ${new Date(x.t).toLocaleDateString('id-ID')} · ${esc(x.plan)} · ${PRICE(x.price)} · ${x.kode}`).join('\n') : 'Belum ada riwayat pembelian.'}`, { parse_mode: 'HTML' });
  }
  const v = premHome(ctx);
  ctx.reply(v.text, { parse_mode: 'HTML', ...v.kb });
});

// Owner: atur QRIS (kirim foto QRIS dengan caption /setqris)
bot.on('photo', async (ctx, next) => {
  const cap = ctx.message.caption || '';
  if (!/^\/setqris/i.test(cap)) return next();
  if (!isOwner(ctx.from.id) || ctx.chat.type !== 'private') return next();
  const best = ctx.message.photo[ctx.message.photo.length - 1];
  PREM.qris = { file_id: best.file_id, path: null, t: Date.now() };
  savePrem();
  ctx.reply('✅ QRIS disimpan. Pengguna sekarang bisa membayar lewat menu ⭐ Premium.');
});

// ---- Owner: kelola paket & aktivasi manual ----------------------------------
ownerCmd(['setqris'], (ctx) => ctx.reply('Kirim FOTO QRIS dengan caption /setqris (chat pribadi). Foto itu yang ditampilkan ke pembeli.'));

ownerCmd(['premiumlist', 'premlist'], (ctx) => {
  const users = Object.entries(PREM.users).filter(([, u]) => u.until > Date.now());
  const paket = PREM.plans.map((x) => `• ${x.id}: ${x.name} · ${x.days} hari · ${PRICE(x.price)}`).join('\n');
  ctx.reply(`⭐ <b>Premium</b>\nAktif: ${users.length} pengguna\nQRIS: ${PREM.qris ? '✅' : '❌ belum'}\n\n<b>Paket</b>\n${esc(paket)}\n\nPerintah: /addpremium ID hari | /delpremium ID | /setpaket id nama hari harga | /hapuspaket id`, { parse_mode: 'HTML' });
});

ownerCmd(['addpremium', 'tambahpremium'], (ctx) => {
  const [idS, hariS] = getArgs(ctx);
  const id = Number(idS);
  const hari = Math.floor(Number(hariS) || 30);
  if (!id || hari < 1 || hari > 3650) return ctx.reply('Pakai: /addpremium <user_id> <hari>\nContoh: /addpremium 123456789 30 (maksimal 3650 hari)');
  const base = Math.max(Date.now(), (PREM.users[id] && PREM.users[id].until) || 0);
  PREM.users[id] = { until: base + hari * 864e5, by: 'owner-manual', t: Date.now() };
  PREM.sales.push({ user: id, plan: `manual ${hari} hari`, price: 0, kode: 'MANUAL', t: Date.now() });
  savePrem();
  bot.telegram.sendMessage(id, `⭐ Premium kamu sudah aktif ${hari} hari. Terima kasih!`).catch(() => {});
  ctx.reply(`✅ Premium ${id} ditambah ${hari} hari (berlaku sampai ${new Date(PREM.users[id].until).toLocaleDateString('id-ID')}).`);
});

// Aktivasi dari pesanan QRIS: owner ketik /konfirmasi KODE
ownerCmd(['konfirmasi', 'bayarok'], (ctx) => {
  const kode = (getArgs(ctx)[0] || '').toUpperCase();
  const order = PREM.pending[kode];
  if (!order || Date.now() - order.t > 2 * 36e5) return ctx.reply('❌ Kode pesanan tidak ditemukan atau sudah kedaluwarsa.');
  const plan = PREM.plans.find((x) => x.id === order.plan);
  if (!plan) return ctx.reply('❌ Paket pesanan ini sudah dihapus.');
  const base = Math.max(Date.now(), (PREM.users[order.user] && PREM.users[order.user].until) || 0);
  PREM.users[order.user] = { until: base + plan.days * 864e5, by: kode, t: Date.now() };
  PREM.sales.push({ user: order.user, plan: plan.name, price: order.price, kode, t: Date.now() });
  delete PREM.pending[kode];
  savePrem();
  bot.telegram.sendMessage(order.user, `✅ Pembayaran ${kode} dikonfirmasi. ${plan.name} aktif!`).catch(() => {});
  ctx.reply(`✅ Pesanan ${kode} dikonfirmasi. ${plan.name} aktif untuk user ${order.user}.`);
});

ownerCmd('delpremium', (ctx) => {
  const id = Number(getArgs(ctx)[0]);
  if (!PREM.users[id]) return ctx.reply('Pengguna itu tidak punya premium.');
  delete PREM.users[id];
  savePrem();
  ctx.reply(`🗑️ Premium ${id} dicabut.`);
});

ownerCmd('setpaket', (ctx) => {
  // urutan: <id> <nama paket...> <hari> <harga>  (harga dibaca dari ujung, nama dari tengah)
  const [id, ...rest] = getArgs(ctx);
  const harga = Number(rest.pop());
  const hari = Number(rest.pop());
  const nama = rest.join(' ');
  if (!id || !nama || !(hari >= 1 && hari <= 3650) || !(harga >= 0)) return ctx.reply('Pakai: /setpaket <id> <nama paket> <hari> <harga>\nContoh: /setpaket bulan Premium 1 Bulan 30 15000');
  const i = PREM.plans.findIndex((x) => x.id === id);
  const p = { id, name: nama, days: hari, price: harga };
  if (i >= 0) PREM.plans[i] = p; else PREM.plans.push(p);
  savePrem();
  ctx.reply(`✅ Paket "${esc(nama)}" disimpan: ${hari} hari, ${PRICE(harga)}.`);
});

ownerCmd('hapuspaket', (ctx) => {
  const id = getArgs(ctx)[0];
  PREM.plans = PREM.plans.filter((x) => x.id !== id);
  savePrem();
  ctx.reply(`🗑️ Paket ${esc(id)} dihapus.`);
});

// ---- 💝 SEDEKAH (QRIS, nominal unik, konfirmasi otomatis via webhook yang sama) ----
const DON_PRESET = [5000, 10000, 20000, 50000];
const donKb = () => Markup.inlineKeyboard([
  DON_PRESET.map((n) => Markup.button.callback(PRICE(n), `don:${n}`)),
  [Markup.button.callback('✏️ Nominal sendiri', 'don:custom')],
  [Markup.button.callback('‹ Menu', 'menu:list')],
]);
function donHome() {
  const total = PREM.donations.reduce((x, y) => x + y.amount, 0);
  return `💝 <b>SEDEKAH</b>\n<i>${esc(PREM.donMsg)}</i>\n${DIV}\n` +
    `Terkumpul: <b>${PRICE(total)}</b> dari ${PREM.donations.length} sedekah\n\n` +
    (PREM.qris ? 'Pilih nominal, atau ketik <code>/sedekah 25000</code>.' : 'Sedekah belum dibuka oleh owner (QRIS belum diatur).');
}
async function donCreate(ctx, nominal) {
  if (!PREM.qris) return ctx.reply('💝 Sedekah belum dibuka. Hubungi owner.');
  if (!(nominal >= 1000 && nominal <= 5000000)) return ctx.reply('❌ Nominal sedekah minimal Rp1.000 dan maksimal Rp5.000.000.');
  const amount = premUniqueAmount(nominal);
  if (!amount) return ctx.reply('Sedang ramai, coba lagi sebentar.');
  const kode = 'SED' + crypto.randomBytes(3).toString('hex').toUpperCase();
  PREM.donPending[kode] = { user: ctx.from.id, amount, nominal, t: Date.now() };
  savePrem();
  const cap = `💝 <b>Sedekah ${PRICE(nominal)}</b>\nKode: <code>${kode}</code>\n\nBayar <b>tepat ${PRICE(amount)}</b> (nominal unik untuk sedekahmu). Begitu pembayaran diterima, sedekahmu tercatat otomatis. Berlaku 2 jam.\n\n<i>${esc(PREM.donMsg)}</i>`;
  try {
    await ctx.replyWithPhoto(qrisSource(), { caption: cap, parse_mode: 'HTML' });
  } catch (_) {
    await ctx.reply(cap, { parse_mode: 'HTML' });
  }
}
bot.command('sedekah', (ctx) => {
  const n = Math.round(Number(getArgs(ctx)[0]));
  if (getArgs(ctx)[0] && n) return donCreate(ctx, n);
  ctx.reply(donHome(), { parse_mode: 'HTML', ...donKb() });
});
bot.action('don:custom', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  return ctx.reply('✏️ Ketik nominal sedekahmu, misalnya:\n<code>/sedekah 25000</code>\nMinimal Rp1.000.', { parse_mode: 'HTML' });
});
bot.action(/^don:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  return donCreate(ctx, Number(ctx.match[1]));
});
bot.command(['sedekahlist', 'donatur'], (ctx) => {
  const list = PREM.donations.slice(-10).reverse();
  const total = PREM.donations.reduce((x, y) => x + y.amount, 0);
  ctx.reply(`💝 <b>Terima kasih, para donatur</b>\nTotal: ${PRICE(total)} dari ${PREM.donations.length} sedekah\n${DIV}\n` +
    (list.length ? list.map((d) => `• ${esc(d.nama)} · ${new Date(d.t).toLocaleDateString('id-ID')}`).join('\n') : 'Belum ada sedekah. Jadilah yang pertama!'), { parse_mode: 'HTML' });
});
ownerCmd('sedekahstat', (ctx) => {
  const total = PREM.donations.reduce((x, y) => x + y.amount, 0);
  const menunggu = Object.keys(PREM.donPending).length;
  ctx.reply(`💝 <b>Sedekah</b>\nTotal masuk: ${PRICE(total)} (${PREM.donations.length} transaksi)\nMenunggu pembayaran: ${menunggu}\n\nKonfirmasi manual: /sedekahok KODE\nUbah pesan: /setsedekahmsg TEKS`, { parse_mode: 'HTML' });
});
ownerCmd('sedekahok', (ctx) => {
  const kode = (getArgs(ctx)[0] || '').toUpperCase();
  const don = PREM.donPending[kode];
  if (!don || Date.now() - don.t > PAY_WINDOW) return ctx.reply('❌ Kode sedekah tidak ditemukan atau sudah kedaluwarsa.');
  delete PREM.donPending[kode];
  PREM.donations.push({ kode, amount: don.amount, nama: 'Hamba Allah', t: Date.now() });
  savePrem();
  ctx.reply(`✅ Sedekah ${kode} (${PRICE(don.amount)}) dicatat.`);
});
ownerCmd('setsedekahmsg', (ctx) => {
  const t = argText(ctx);
  if (!t) return ctx.reply('Pakai: /setsedekahmsg <teks tujuan sedekah>');
  PREM.donMsg = t.slice(0, 300);
  savePrem();
  ctx.reply('✅ Teks sedekah diperbarui.');
});

ownerCmd(['setdomain', 'domainpanel'], (ctx) => {
  if (ctx.chat.type !== 'private') return ctx.reply('🔒 Perintah ini hanya di chat pribadi.');
  const d = cleanDomain(getArgs(ctx)[0]);
  if (!DOMAIN_RE.test(d)) return ctx.reply('❌ Domain tidak valid.\nContoh: /setdomain namaku.netlify.app\natau /setdomain panel.namamu.com');
  writeJSON(DOMAIN_FILE, { domain: d, t: Date.now() });
  ctx.reply(`✅ Domain panel disimpan: <code>${esc(d)}</code>\n\nAlamat panel: <code>https://${esc(d)}</code>\nAsal ini sekarang diizinkan memanggil API bot (tetap wajib password).\n\n<i>Restart bot agar perubahan berlaku penuh.</i>`, { parse_mode: 'HTML' });
});
ownerCmd('domain', (ctx) => {
  const tersimpan = cleanDomain((readJSON(DOMAIN_FILE, {}) || {}).domain || '');
  const aktif = tersimpan || PANEL_DOMAIN;
  ctx.reply(DOMAIN_RE.test(aktif) ? `🌐 Domain panel: <code>${esc(aktif)}</code>\nSumber: ${tersimpan ? '/setdomain' : 'PANEL_DOMAIN (env)'}` : 'Belum ada domain. Kirim: /setdomain namaku.netlify.app', { parse_mode: 'HTML' });
});
ownerCmd('hapusdomain', (ctx) => {
  if (ctx.chat.type !== 'private') return ctx.reply('🔒 Perintah ini hanya di chat pribadi.');
  try { if (fs.existsSync(file(DOMAIN_FILE))) fs.unlinkSync(file(DOMAIN_FILE)); } catch (_) {}
  ctx.reply('🗑️ Domain panel dihapus. Restart bot agar berlaku.');
});

// IP publik server tempat bot berjalan (dipakai untuk alamat panel http://IP:port)
const IP_SOURCES = ['https://api.ipify.org', 'https://ifconfig.me/ip', 'https://icanhazip.com'];
async function serverPublicIp() {
  for (const url of IP_SOURCES) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(6000), headers: { 'user-agent': 'curl/8' } });
      if (!r.ok) continue;
      const ip = (await r.text()).trim();
      if (/^(\d{1,3}\.){3}\d{1,3}$/.test(ip) && ip.split('.').every((n) => +n <= 255)) return ip;
    } catch (_) {}
  }
  return null;
}
ownerCmd(['ipserver', 'ipsaya'], async (ctx) => {
  if (ctx.chat.type !== 'private') return ctx.reply('🔒 Perintah ini hanya di chat pribadi.');
  const st = await progress(ctx, '🌐 Mengecek IP server');
  const ip = await serverPublicIp();
  if (!ip) return st.edit('❌ Tidak bisa mengecek IP server sekarang. Cek koneksi server, lalu coba lagi.');
  const port = PANEL_PORT;
  const isi = `🌐 <b>IP publik server bot</b>\n${DIV}\nIP: <code>${esc(ip)}</code>\nPort panel: <code>${port}</code>\n\nAlamat panel: <code>http://${esc(ip)}:${port}</code>\n\n<i>Pastikan port ${port} sudah dibuka oleh penyedia hosting. Bot tidak bisa mengaturnya.</i>`;
  st.edit(isi);
});

ownerCmd('qrisauto', (ctx) => {
  const aktif = !!QRIS_SECRET;
  ctx.reply(`💳 <b>Pembayaran QRIS otomatis</b>\nStatus: ${aktif ? '🟢 aktif' : '⚪ belum diatur'}\nPesanan menunggu: ${Object.keys(PREM.pending).length}\n\n${aktif ? 'Endpoint: <code>/api/qris-webhook</code> (POST, header X-Signature)' : 'Atur secret <code>QRIS_WEBHOOK_SECRET</code> di env/secret, lalu restart. Pembayaran tetap bisa dikonfirmasi manual dengan /konfirmasi.'}`, { parse_mode: 'HTML' });
});

ownerCmd('setharga', (ctx) => {
  const n = Math.floor(Number(getArgs(ctx)[0]));
  if (!(n >= 1 && n <= 1000000)) return ctx.reply(`Pakai: /setharga <rupiah per hari>\nSekarang: ${PRICE(PREM.perHari)} per hari.`);
  PREM.perHari = n;
  savePrem();
  ctx.reply(`✅ Harga premium hari sendiri: ${PRICE(n)} per hari.`);
});

ownerCmd('riwayatjual', (ctx) => {
  const total = PREM.sales.reduce((s, x) => s + (x.price || 0), 0);
  const list = PREM.sales.slice(-10).reverse().map((s) => `• ${new Date(s.t).toLocaleDateString('id-ID')} · ${s.user} · ${esc(s.plan)} · ${PRICE(s.price)} · ${s.kode}`).join('\n');
  ctx.reply(`🧾 <b>Penjualan</b>\nTotal: ${PRICE(total)} dari ${PREM.sales.length} transaksi\n\n${list || 'Belum ada.'}`, { parse_mode: 'HTML' });
});

// Pesanan kedaluwarsa dibersihkan otomatis
setInterval(() => {
  let changed = false;
  for (const [k, o] of Object.entries(PREM.pending)) if (Date.now() - o.t > 2 * 36e5) { delete PREM.pending[k]; changed = true; }
  if (changed) savePrem();
}, 15 * 60e3).unref();

// ===========================================================================
// 🧠 AI+ (v8.4): 20 fitur AI berbasis prompt, memakai model gratis yang sudah ada
// ===========================================================================
// Setiap fitur hanya menyusun prompt lalu memanggil askAI (model utama + cadangan).
// Batas: teks input 1500 karakter, jawaban dipotong agar muat di Telegram.
const AIP_MAX_IN = 1500;
const AIP_TOOL_COOLDOWN = 1500; // jeda antar permintaan per pengguna supaya tidak dibanjiri
const aipLast = new Map();

const aipInput = (ctx) => {
  const r = ctx.message.reply_to_message;
  const txt = argText(ctx) || (r && (r.text || r.caption)) || '';
  return txt.slice(0, AIP_MAX_IN);
};

// Fitur: { cmd, judul, pakai, buat(input, arg) }
const AIP = [
  // --- Teks ---
  { cmd: 'ringkas2', judul: 'Ringkas', pakai: '/ringkas2 ‹teks›', buat: (t) => `Ringkas teks berikut menjadi 3 poin singkat dalam bahasa Indonesia:\n\n${t}` },
  { cmd: 'parafrase', judul: 'Parafrase', pakai: '/parafrase ‹teks›', buat: (t) => `Tulis ulang teks berikut dengan kata-kata lain dalam bahasa yang sama, arti tetap sama. Beri satu versi saja:\n\n${t}` },
  { cmd: 'koreksi', judul: 'Koreksi tata bahasa', pakai: '/koreksi ‹teks›', buat: (t) => `Perbaiki ejaan dan tata bahasa teks berikut. Tampilkan hasil perbaikan lalu daftar singkat apa yang diubah:\n\n${t}` },
  { cmd: 'nada', judul: 'Ubah nada', pakai: '/nada formal|santai|lucu ‹teks›', buat: (t, arg) => `Ubah nada teks berikut menjadi ${arg || 'santai'} tapi tetap mempertahankan maksudnya. Hanya tampilkan hasilnya:\n\n${t}` },
  { cmd: 'email', judul: 'Buat email', pakai: '/email ‹tujuan email›', buat: (t) => `Buat draf email profesional dalam bahasa Indonesia untuk tujuan berikut, lengkap dengan subjek:\n\n${t}` },
  { cmd: 'slogan', judul: 'Slogan & nama usaha', pakai: '/slogan ‹deskripsi usaha›', buat: (t) => `Berikan 5 nama usaha dan 5 slogan singkat yang kreatif untuk usaha berikut, dalam bahasa Indonesia:\n\n${t}` },
  { cmd: 'deskripsiproduk', judul: 'Deskripsi produk', pakai: '/deskripsiproduk ‹nama & keunggulan›', buat: (t) => `Tulis deskripsi produk yang menarik dan jujur, sekitar 60 kata, dalam bahasa Indonesia, untuk produk berikut:\n\n${t}` },
  { cmd: 'judulvideo', judul: 'Ide judul video', pakai: '/judulvideo ‹topik›', buat: (t) => `Berikan 7 ide judul video yang menarik (tanpa clickbait menyesatkan) dalam bahasa Indonesia untuk topik:\n\n${t}` },
  { cmd: 'cerita', judul: 'Cerita pendek', pakai: '/cerita ‹tema›', buat: (t) => `Tulis cerita pendek sekitar 150 kata dalam bahasa Indonesia dengan tema: ${t}` },
  { cmd: 'puisi', judul: 'Puisi', pakai: '/puisi ‹tema›', buat: (t) => `Tulis satu puisi pendek dalam bahasa Indonesia (8 sampai 12 baris) tentang: ${t}` },
  // --- Belajar ---
  { cmd: 'sdkan', judul: 'Jelaskan sederhana', pakai: '/sdkan ‹topik›', buat: (t) => `Jelaskan topik berikut seperti kepada anak SD, dengan kalimat sederhana dan satu contoh sehari-hari, dalam bahasa Indonesia:\n\n${t}` },
  { cmd: 'kuisbelajar', judul: 'Kuis dari topik', pakai: '/kuisbelajar ‹topik›', buat: (t) => `Buat 5 soal pilihan ganda tentang topik berikut dalam bahasa Indonesia. Tiap soal punya 4 pilihan A-D. Setelah soal, tulis kunci jawabannya di bagian paling bawah:\n\n${t}` },
  { cmd: 'flashcard', judul: 'Flashcard', pakai: '/flashcard ‹topik›', buat: (t) => `Buat 6 flashcard tentang topik berikut. Format tiap kartu: "Depan: ..." lalu "Belakang: ...", dalam bahasa Indonesia:\n\n${t}` },
  { cmd: 'rangkum', judul: 'Rangkum materi', pakai: '/rangkum ‹materi›', buat: (t) => `Rangkum materi belajar berikut menjadi catatan terstruktur dengan judul dan poin-poin, dalam bahasa Indonesia:\n\n${t}` },
  { cmd: 'soalmat', judul: 'Latihan matematika', pakai: '/soalmat ‹tingkat/topik›', buat: (t) => `Buat 3 soal latihan matematika beserta pembahasan langkah demi langkah, dalam bahasa Indonesia, untuk: ${t}` },
  { cmd: 'tatabahasa', judul: 'Jelaskan tata bahasa', pakai: '/tatabahasa ‹kalimat›', buat: (t) => `Terjemahkan kalimat berikut ke bahasa Inggris, lalu jelaskan struktur tata bahasanya dalam 3 poin singkat, dalam bahasa Indonesia:\n\n${t}` },
  // --- Kreatif & gaya hidup ---
  { cmd: 'resep', judul: 'Resep dari bahan', pakai: '/resep ‹bahan yang kamu punya›', buat: (t) => `Buat satu resep sederhana dalam bahasa Indonesia dengan bahan utama berikut (boleh tambah bumbu dasar). Sertakan daftar bahan dan langkah singkat:\n\n${t}` },
  { cmd: 'rencanatrip', judul: 'Rencana perjalanan', pakai: '/rencanatrip ‹kota & lama hari›', buat: (t) => `Buat rencana perjalanan singkat dalam bahasa Indonesia untuk: ${t}. Format per hari, dengan perkiraan biaya kasar. Sebutkan bahwa harga hanya perkiraan.` },
  { cmd: 'rencanabelajar', judul: 'Rencana belajar', pakai: '/rencanabelajar ‹target & waktu›', buat: (t) => `Buat rencana belajar mingguan dalam bahasa Indonesia untuk target berikut, realistis dan dibagi per hari: ${t}` },
  { cmd: 'rekomendasibuku', judul: 'Rekomendasi buku/film', pakai: '/rekomendasibuku ‹selera kamu›', buat: (t) => `Berikan 5 rekomendasi buku atau film (sebutkan jenisnya) yang cocok untuk selera berikut, dengan satu kalimat alasan masing-masing, dalam bahasa Indonesia:\n\n${t}` },
  { cmd: 'debat', judul: 'Dua sisi argumen', pakai: '/debat ‹topik›', buat: (t) => `Untuk topik berikut, tulis argumen terkuat dari dua sisi (pro dan kontra), masing-masing 3 poin, dalam bahasa Indonesia. Bersikap netral:\n\n${t}` },
  // --- Coding (hanya teks, tidak menjalankan kode) ---
  { cmd: 'jelaskankode', judul: 'Jelaskan kode', pakai: '/jelaskankode ‹potongan kode›', buat: (t) => `Jelaskan apa yang dilakukan kode berikut dalam bahasa Indonesia, baris demi baris secara ringkas:\n\n${t}` },
  { cmd: 'cari_bug', judul: 'Cari bug', pakai: '/cari_bug ‹potongan kode›', buat: (t) => `Periksa kode berikut untuk bug atau kesalahan logika. Untuk tiap temuan, jelaskan masalah dan perbaikannya dalam bahasa Indonesia:\n\n${t}` },
];

const AIP_BY_CMD = Object.fromEntries(AIP.map((f) => [f.cmd, f]));

async function aipRun(ctx, f) {
  const id = ctx.from.id;
  const now = Date.now();
  if (!isOwner(id) && now - (aipLast.get(id) || 0) < AIP_TOOL_COOLDOWN) return ctx.reply('⏳ Sabar sebentar, tunggu beberapa detik sebelum meminta lagi.');
  aipLast.set(id, now);
  const arg = (ctx.message.text.split(/\s+/)[1] || '').toLowerCase();
  const isiArg = ['formal', 'santai', 'lucu'].includes(arg) && f.cmd === 'nada' ? arg : '';
  // /nada: kata pertama dibuang HANYA kalau itu gaya yang valid; selain itu seluruh isi dipakai sebagai teks
  const teks = f.cmd === 'nada' && isiArg ? aipInput(ctx).replace(/^(formal|santai|lucu)\s*/i, '') : aipInput(ctx);
  if (!teks) return ctx.reply(`Pakai: ${f.pakai}`);
  const st = await progress(ctx, `🧠 ${f.judul}`);
  let out;
  try {
    out = await askAI(f.buat(teks, isiArg), GPT_MODEL);
  } catch (e) {
    console.error('AI+ gagal:', e.message);
    out = '❌ AI sedang sibuk, coba lagi sebentar.';
  }
  if (out.length <= 4000) return st.edit(out);
  await st.del();
  await replyLong(ctx, out);
}

for (const f of AIP) bot.command(f.cmd, (ctx) => aipRun(ctx, f));

function aipMenuLines() {
  const grup = [
    ['✍️ Teks', ['ringkas2', 'parafrase', 'koreksi', 'nada', 'email', 'slogan', 'deskripsiproduk', 'judulvideo', 'cerita', 'puisi']],
    ['📚 Belajar', ['sdkan', 'kuisbelajar', 'flashcard', 'rangkum', 'soalmat', 'tatabahasa']],
    ['🌴 Kreatif & gaya hidup', ['resep', 'rencanatrip', 'rencanabelajar', 'rekomendasibuku', 'debat']],
    ['💻 Coding (teks saja)', ['jelaskankode', 'cari_bug']],
  ];
  return grup.map(([nama, cmds]) => `${nama}\n` + cmds.map((c) => `/${c} · ${AIP_BY_CMD[c].judul}`).join('\n')).join('\n\n');
}
bot.command(['aiplus', 'ai+'], (ctx) => ctx.reply(`🧠 <b>AI+ — 23 fitur AI</b>\n<i>Gratis lewat model AI yang sama dengan /ai. Ketik perintah di bawah, atau reply pesan lalu ketik perintahnya.</i>\n\n${esc(aipMenuLines())}`, { parse_mode: 'HTML' }));

// ===========================================================================
// 🕌 ISLAMI OFFLINE (v9.0): tanpa API, semua data ada di dalam bot
// ===========================================================================
// Tidak ada panggilan internet di blok ini. Teks Arab Al-Qur'an TIDAK disertakan
// karena harus diambil dari sumber resmi; doa di bawah hanya terjemahan Indonesia.
const TASBIH_FILE = 'tasbih.json';
const TASBIH = readJSON(TASBIH_FILE, {});
const saveTasbih = () => writeJSON(TASBIH_FILE, TASBIH);
const ZIKIR = ['Subhanallah', 'Alhamdulillah', 'Allahu Akbar', 'Lailahaillallah', 'Astaghfirullah'];

function tasbihView(uid) {
  const t = (TASBIH[uid] = TASBIH[uid] || { zikir: 0, count: 0, total: 0 });
  const target = [33, 99, 100, 1000].includes(t.target) ? t.target : 33;
  const selesai = t.count >= target;
  const bar = '▰'.repeat(Math.min(10, Math.floor((t.count / target) * 10))) + '▱'.repeat(10 - Math.min(10, Math.floor((t.count / target) * 10)));
  const text =
    `📿 <b>TASBIH</b>\n<i>Ketuk + setiap kali berzikir</i>\n${DIV}\n` +
    `<b>${ZIKIR[t.zikir % ZIKIR.length]}</b>\n${bar}  <b>${t.count}</b> / ${target}\n` +
    `Total seluruhnya: ${t.total}\n` +
    (selesai ? '\n✅ <b>Target tercapai!</b> Ganti zikir atau reset untuk mulai lagi.' : '');
  const kb = Markup.inlineKeyboard([
    [Markup.button.callback('➕ Tambah', 'tb:inc'), Markup.button.callback('↺ Reset', 'tb:reset')],
    [Markup.button.callback('🔁 Ganti zikir', 'tb:zikir'), Markup.button.callback(`🎯 Target ${target}`, 'tb:target')],
    [Markup.button.callback('‹ Menu', 'menu:list')],
  ]);
  return { text, kb };
}
bot.command(['tasbih', 'zikir'], (ctx) => {
  const v = tasbihView(ctx.from.id);
  ctx.reply(v.text, { parse_mode: 'HTML', ...v.kb });
});
bot.action(/^tb:(inc|reset|zikir|target)$/, async (ctx) => {
  const uid = ctx.from.id;
  const t = (TASBIH[uid] = TASBIH[uid] || { zikir: 0, count: 0, total: 0 });
  const act = ctx.match[1];
  if (act === 'inc') {
    t.count++;
    t.total++;
  } else if (act === 'reset') {
    t.count = 0;
  } else if (act === 'zikir') {
    t.zikir = (t.zikir + 1) % ZIKIR.length;
    t.count = 0;
  } else if (act === 'target') {
    const urut = [33, 99, 100, 1000];
    t.target = urut[(urut.indexOf(t.target || 33) + 1) % urut.length];
    t.count = 0;
  }
  saveTasbih();
  await ctx.answerCbQuery(act === 'inc' && t.count % 33 === 0 ? '🎉 Kelipatan 33!' : undefined).catch(() => {});
  const v = tasbihView(uid);
  ctx.editMessageText(v.text, { parse_mode: 'HTML', ...v.kb }).catch(() => {});
});

bot.command(['hijriah', 'hijriyah'], (ctx) => {
  const hijri = new Intl.DateTimeFormat('id-ID-u-ca-islamic-umalqura', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Jakarta' }).format(new Date());
  const masehi = new Intl.DateTimeFormat('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Jakarta' }).format(new Date());
  ctx.reply(`🌙 <b>Tanggal hari ini</b>\n${DIV}\nHijriah : <b>${esc(hijri)}</b>\nMasehi  : ${esc(masehi)}\n\n<i>Penanggalan Hijriah bisa berbeda satu hari tergantung pengumuman resmi di daerahmu.</i>`, { parse_mode: 'HTML' });
});

// Koordinat kota (lintang, bujur) untuk arah kiblat
const KOTA = {
  jakarta: [-6.2088, 106.8456], bandung: [-6.9175, 107.6191], surabaya: [-7.2575, 112.7521], medan: [3.5952, 98.6722],
  makassar: [-5.1477, 119.4327], yogyakarta: [-7.7956, 110.3695], semarang: [-6.9667, 110.4167], palembang: [-2.9761, 104.7754],
  denpasar: [-8.6705, 115.2126], balikpapan: [-1.2379, 116.8529], manado: [1.4748, 124.8421], jayapura: [-2.5337, 140.7181],
  pontianak: [-0.0263, 109.3425], banjarmasin: [-3.3186, 114.5944],
};
const KIBLAT = [21.4225, 39.8262]; // Ka'bah, Makkah
function arahKiblat(lat, lon) {
  const r = Math.PI / 180;
  const dl = (KIBLAT[1] - lon) * r;
  const y = Math.sin(dl);
  const x = Math.cos(lat * r) * Math.tan(KIBLAT[0] * r) - Math.sin(lat * r) * Math.cos(dl);
  return (Math.atan2(y, x) / r + 360) % 360;
}
const ARAH = ['Utara', 'Timur Laut', 'Timur', 'Tenggara', 'Selatan', 'Barat Daya', 'Barat', 'Barat Laut'];
bot.command(['kiblat', 'qibla'], (ctx) => {
  const nama = argText(ctx).toLowerCase().replace(/\s+/g, '');
  if (!nama) return ctx.reply(`🧭 <b>Arah kiblat</b>\nPakai: <code>/kiblat jakarta</code>\nKota: ${Object.keys(KOTA).join(', ')}`, { parse_mode: 'HTML' });
  const k = KOTA[nama];
  if (!k) return ctx.reply(`❌ Kota belum tersedia. Pilihan: ${Object.keys(KOTA).join(', ')}`);
  const deg = arahKiblat(k[0], k[1]);
  const arah = ARAH[Math.round(deg / 45) % 8];
  ctx.reply(`🧭 <b>Kiblat dari ${esc(nama.charAt(0).toUpperCase() + nama.slice(1))}</b>\n${DIV}\nArah: <b>${deg.toFixed(1)}°</b> dari utara (${arah})\n\n<i>Perhitungan dari koordinat kota, sudah cukup untuk perkiraan. Untuk akurasi, gunakan kompas.</i>`, { parse_mode: 'HTML' });
});

const DOA = {
  makan: ['Sebelum makan', 'Ya Allah, berkahilah rezeki yang telah Engkau berikan kepada kami, dan lindungilah kami dari siksa neraka.'],
  selesai: ['Sesudah makan', 'Segala puji bagi Allah yang telah memberi kami makan dan minum, serta menjadikan kami orang-orang Islam.'],
  kamarmandi: ['Masuk kamar mandi', 'Dengan nama Allah. Ya Allah, aku berlindung kepada-Mu dari setan laki-laki dan setan perempuan.'],
  keluarrumah: ['Keluar rumah', 'Dengan nama Allah, aku bertawakal kepada Allah. Tidak ada daya dan kekuatan kecuali dengan pertolongan Allah.'],
  bepergian: ['Bepergian', 'Maha Suci Engkau yang telah menundukkan semua ini untuk kami, padahal kami sebelumnya tidak mampu menguasainya. Dan sesungguhnya kami akan kembali kepada Tuhan kami.'],
};
bot.command(['doa', 'doaharian'], (ctx) => {
  const k = argText(ctx).toLowerCase().replace(/\s+/g, '');
  if (!k || !DOA[k]) {
    return ctx.reply(`🤲 <b>Doa harian</b> <i>(terjemahan Indonesia)</i>\n${DIV}\n${Object.entries(DOA).map(([id, [j]]) => `<b>/doa ${id}</b>  <i>${j}</i>`).join('\n')}\n\n<i>Teks Arab tidak disertakan. Untuk lafal lengkap rujuk buku doa atau ustaz.</i>`, { parse_mode: 'HTML' });
  }
  const [judul, arti] = DOA[k];
  ctx.reply(`🤲 <b>${esc(judul)}</b>\n${DIV}\n<i>${esc(arti)}</i>\n\n<i>Terjemahan bebas. Untuk lafal Arab, rujuk sumber yang terpercaya.</i>`, { parse_mode: 'HTML' });
});

// ===========================================================================
// 🌐 DNS via 1.1.1.1 (Cloudflare, DNS-over-HTTPS): cek alamat sebuah domain
// ===========================================================================
const DNS_SERVER = 'https://1.1.1.1/dns-query';
const DNS_TYPES = { A: 1, AAAA: 28, MX: 15, NS: 2, TXT: 16 };
const DNS_NAMA = { 1: 'A', 28: 'AAAA', 15: 'MX', 2: 'NS', 16: 'TXT' };
async function dnsQuery(domain, type) {
  const r = await fetch(`${DNS_SERVER}?name=${encodeURIComponent(domain)}&type=${type}`, {
    headers: { accept: 'application/dns-json' },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  return (j.Answer || []).filter((a) => a.type === DNS_TYPES[type]).map((a) => String(a.data).replace(/"/g, ''));
}
bot.command(['dns', 'cekdns'], async (ctx) => {
  const domain = argText(ctx).toLowerCase().replace(/^https?:\/\//, '').split('/')[0];
  if (!domain) return ctx.reply('🌐 <b>Cek DNS (1.1.1.1)</b>\nPakai: <code>/dns google.com</code>', { parse_mode: 'HTML' });
  if (!/^(?=.{1,253}$)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/.test(domain)) return ctx.reply('❌ Nama domain tidak valid. Contoh: /dns google.com');
  const st = await progress(ctx, '🌐 Bertanya ke 1.1.1.1');
  try {
    const [a, aaaa, mx, ns] = await Promise.all(['A', 'AAAA', 'MX', 'NS'].map((t) => dnsQuery(domain, t)));
    const baris = (judul, list) => `<b>${judul}</b>\n${list.length ? list.map((x) => `  ${esc(x)}`).join('\n') : '  <i>tidak ada</i>'}`;
    const text = `🌐 <b>${esc(domain)}</b> <i>(via 1.1.1.1)</i>\n${DIV}\n${baris('IPv4 (A)', a)}\n\n${baris('IPv6 (AAAA)', aaaa)}\n\n${baris('Mail (MX)', mx)}\n\n${baris('Nameserver (NS)', ns)}`;
    await st.edit(text);
  } catch (e) {
    console.error('DNS gagal:', e.message);
    await st.edit('❌ Tidak bisa menghubungi 1.1.1.1 sekarang. Cek koneksi server, lalu coba lagi.');
  }
});

// ===========================================================================
// 🌿 SANTAI & TENANG (v9.6): tips menenangkan diri, offline, tanpa API
// ===========================================================================
const SANTAI_TIPS = [
  'Lepas bahu, turunkan rahang, lalu hembuskan napas pelan. Ulangi tiga kali.',
  'Minum segelas air putih dan berjalan sebentar ke luar ruangan.',
  'Pejamkan mata satu menit. Tidak perlu memikirkan apa-apa.',
  'Tulis tiga hal kecil yang berjalan baik hari ini, walau sekecil apa pun.',
  'Regangkan leher dan punggung perlahan selama 30 detik.',
  'Dengarkan satu lagu favoritmu tanpa melakukan hal lain.',
  'Istirahat dari layar 10 menit. Lihat ke jendela yang jauh.',
];
const SANTAI_KALIMAT = [
  'Tidak apa-apa beristirahat. Kamu tidak harus selalu produktif.',
  'Pelan-pelan juga tetap sampai.',
  'Hari ini cukup dijalani satu per satu.',
  'Kamu sudah melakukan lebih dari yang kamu kira.',
];
const MARAH_LANGKAH = [
  '1. <b>Berhenti sejenak.</b> Kalau bisa, menjauh dulu dari orang atau situasi yang memicu.',
  '2. <b>Atur napas.</b> Tarik napas lewat hidung 4 hitungan, tahan 4, buang lewat mulut 6. Ulangi 5 kali.',
  '3. <b>Turunkan tensi.</b> Minum air, dan kalau memungkinkan jalan kaki sebentar.',
  '4. <b>Tuliskan</b> apa yang membuatmu marah, tanpa perlu dikirim ke siapa pun.',
  '5. <b>Tunda keputusan.</b> Kalau masih kesal, jangan kirim pesan atau ambil tindakan dulu. Tanyakan lagi besok.',
];
const MARAH_KALIMAT = [
  'Marah itu wajar. Yang penting, cara kamu menanggapinya.',
  'Perasaanmu valid, tapi tidak harus langsung diluapkan.',
];
const MARAH_BANTUAN = 'Kalau kemarahan terasa sangat berat, sering terjadi, atau kamu khawatir akan menyakiti diri sendiri atau orang lain, hubungi orang yang kamu percaya sekarang juga, atau minta bantuan tenaga profesional.';

const pickIdx = (a) => Math.floor(Math.random() * a.length);
function santaiView() {
  const tip = SANTAI_TIPS[pickIdx(SANTAI_TIPS)];
  const kalimat = SANTAI_KALIMAT[pickIdx(SANTAI_KALIMAT)];
  return {
    text: `🌿 <b>SANTAI</b>\n<i>${esc(kalimat)}</i>\n${DIV}\n<b>Coba ini sebentar:</b>\n${esc(tip)}\n\n<b>Latihan napas 4-4-6</b>\nTarik 4 hitungan, tahan 4, buang 6. Ulangi beberapa kali.`,
    kb: Markup.inlineKeyboard([[Markup.button.callback('🔄 Tips lain', 'mood:santai')], [Markup.button.callback('🎧 Lagu santai', 'song:mood:santai')], [Markup.button.callback('‹ Menu', 'menu:list')]]),
  };
}
function marahView() {
  return {
    text: `🔥 <b>TENANGKAN DIRI</b>\n<i>${esc(MARAH_KALIMAT[pickIdx(MARAH_KALIMAT)])}</i>\n${DIV}\n${MARAH_LANGKAH.join('\n')}\n\n<i>${esc(MARAH_BANTUAN)}</i>`,
    kb: Markup.inlineKeyboard([[Markup.button.callback('🌿 Tips santai', 'mood:santai')], [Markup.button.callback('‹ Menu', 'menu:list')]]),
  };
}
bot.command(['santai', 'relax'], (ctx) => { const v = santaiView(); ctx.reply(v.text, { parse_mode: 'HTML', ...v.kb }); });
bot.command(['marah', 'tenang'], (ctx) => { const v = marahView(); ctx.reply(v.text, { parse_mode: 'HTML', ...v.kb }); });
bot.action('mood:santai', async (ctx) => { await ctx.answerCbQuery().catch(() => {}); const v = santaiView(); ctx.editMessageText(v.text, { parse_mode: 'HTML', ...v.kb }).catch(() => {}); });

// ===========================================================================
// 🏠 Dashboard & Menu (tombol inline + keyboard bawah)
// ===========================================================================
function dashboard(ctx) {
  const u = ctx.from;
  const p = getP(u);
  const l = levelOf(p.xp);
  const now = new Date();
  const tgl = now.toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta', weekday: 'long', day: 'numeric', month: 'long' });
  const jam = now.toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit' }).replace(':', '.');
  const hr = Number(now.toLocaleString('en-US', { timeZone: 'Asia/Jakarta', hour: 'numeric', hour12: false })) % 24;
  const sapa = hr < 11 ? 'Pagi' : hr < 15 ? 'Siang' : hr < 18 ? 'Sore' : 'Malam';
  const musik = hasCustomSong ? customSongCard() : `🎵 <i>Lagu hari ini</i>\n${songLine(SONGS[songIdxToday()])}`;
  const text =
    `◆ <b>${sapa}, ${esc(u.first_name)}</b>\n${tgl} · ${jam} WIB\n` +
    `┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈\n` +
    `Lv ${l} ${titleOf(l)}   ${xpBar(p.xp).split(' ')[0]}\n` +
    `💰 ${nf.format(p.coins)} koin\n` +
    `┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈\n\n` +
    `${musik}\n\n` +
    `<code>${STATE.active ? '● aktif' : '○ standby'} · ${uptime()} · ${nf.format(USERS.size)} pengguna</code>`;
  return {
    text,
    kb: Markup.inlineKeyboard([
      [Markup.button.callback('☰ Menu', 'menu:list'), Markup.button.callback('👤 Profil', 'menu:profil')],
      [Markup.button.callback(hasCustomSong ? '🎵 Putar lagu' : '🎵 Lagu hari ini', hasCustomSong ? 'song:custom' : 'song:today'), Markup.button.callback('❓ Bantuan', 'menu:help')],
    ]),
  };
}

const LIST_KB = Markup.inlineKeyboard([
  [Markup.button.callback('🎮 Game', 'menu:game'), Markup.button.callback('💰 Ekonomi', 'menu:eco'), Markup.button.callback('🎭 Hiburan', 'menu:fun')],
  [Markup.button.callback('✍️ Kreator', 'menu:text'), Markup.button.callback('🧰 Utilitas', 'menu:util'), Markup.button.callback('🎧 Musik', 'menu:music')],
  [Markup.button.callback('📥 Unduh', 'menu:dl'), Markup.button.callback('🧠 AI', 'menu:ai'), Markup.button.callback('🧠+ AI+', 'menu:aiplus')],
  [Markup.button.callback('🛠️ Tools', 'menu:tools'), Markup.button.callback('👥 Grup', 'menu:group'), Markup.button.callback('🛡️ Keamanan', 'menu:sec')],
  [Markup.button.callback('☁️ Fly', 'menu:fly'), Markup.button.callback('🖧 VPS', 'menu:vps'), Markup.button.callback('👑 Owner', 'menu:owner')],
  [Markup.button.callback('📡 Online', 'menu:online'), Markup.button.callback('🔌 Offline', 'menu:offline')],
  [Markup.button.callback('💝 Sedekah', 'menu:sedekah'), Markup.button.callback('⭐ Premium', 'menu:prem')],
  [Markup.button.callback('🔧 Panel', 'menu:panelmenu'), Markup.button.callback('❓ Bantuan', 'menu:help')],
  [Markup.button.callback('‹ Beranda', 'menu:dashboard')],
]);
const BACK_KB = Markup.inlineKeyboard([[Markup.button.callback('‹ Menu', 'menu:list'), Markup.button.callback('Beranda', 'menu:dashboard')]]);

const DIV = '┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄';
// Setiap baris "/perintah · keterangan" dibuat tebal di bagian perintahnya (rapi di HP)
const fmtLine = (l) => {
  if (!l) return '';
  const m = /^(\/[\w+\u2039\u203a‹›|-]+(?: [\w‹›\[\]|-]+)*?)\s*·\s*(.*)$/.exec(l);
  return m ? `<b>${m[1]}</b>  <i>${m[2]}</i>` : l;
};
const pg = (title, sub, lines) =>
  `✦ <b>${title.toUpperCase()}</b>\n<i>${sub}</i>\n${DIV}\n` +
  lines.map((l) => (l === '' ? '' : l.startsWith('<') ? l : fmtLine(l))).join('\n');
const SECTIONS = {
  sedekah: {
    text: pg('Sedekah', 'Dukung pengembangan bot (QRIS, otomatis tercatat)', [
      '/sedekah · pilih nominal', '/sedekah 25000 · nominal sendiri', '/sedekahlist · daftar donatur', '',
      '<i>Sedekah masuk ke rekening owner bot. Bot tidak menyalurkan dana ke pihak lain.</i>',
    ]),
    kb: BACK_KB,
  },
  online: {
    text: pg('Online', 'Butuh internet. Hasilnya bergantung layanan pihak ketiga', [
      '<b>AI</b>', '/claude · /gemini · /gpt · /ai · /deepseek · /qwen', '/aiplus · 23 fitur AI', '/cari ‹pertanyaan› · pencarian web ringkas', '/dns ‹domain› · cek DNS via 1.1.1.1',
      '/img ‹deskripsi› · gambar AI', '/tr ‹bahasa› ‹teks› · terjemahan', '/pantun · /ramal · /caption · /ringkas', '/models · daftar model AI', '',
      '<b>Unduh</b>', '/lagu ‹judul› · audio YouTube', '/video ‹judul› · video YouTube', '/tiktok ‹link› · video TikTok', '',
      '<b>Info & layanan</b>', '/kurs ‹100 usd idr› · kurs mata uang', '/sholat ‹kota› · jadwal sholat', '/cuaca ‹kota› · cuaca', '/tts ‹teks› · teks jadi suara',
      '/qr ‹teks› · QR code', '/shortlink ‹url› · pendekkan link', '/ssweb ‹url› · screenshot web', '/ip ‹ip/domain› · info IP', '',
      '<b>Server</b>', '/fly · /vps · /panel', '',
      '<i>Kalau layanannya sedang gangguan, fitur ini bisa gagal sementara. Cek dengan /tes.</i>',
    ]),
    kb: BACK_KB,
  },
  offline: {
    text: pg('Offline', 'Jalan tanpa internet, semua data ada di dalam bot', [
      '<b>Game</b>', '/dadu · /slot · /tebak · /angka · /suit · /xo · /kuis · /jawab', '/koin · /pilih · /truth · /dare · /tebakbendera', '',
      '<b>Ekonomi</b>', '/profil · /saldo · /daily · /kerja · /mancing · /transfer · /toko · /beli · /top', '',
      '<b>Hiburan</b>', '/gombal · /jokes · /quote · /fakta · /8ball · /jodoh · /rate · /khodam', '',
      '<b>Teks & kreator</b>', '/fancy · /reverse · /mock · /morse · /biner · /emojify · /hitungkata', '',
      '<b>Utilitas</b>', '/remind · /fokus · /todo · /note · /umur · /bmi · /patungan · /convert · /waktu', '/calc · /pass · /b64 · /id · /ping', '',
      '<b>Islami</b>', '/tasbih · /hijriah · /kiblat · /doa', '',
      '<b>Musik</b>', '/rekomendasi · /playlist · /laguhariini · /tebaklagu', '',
      '<i>Data tersimpan di bot, jadi tetap ada setelah restart.</i>',
    ]),
    kb: BACK_KB,
  },
  list: { text: `✦ <b>MENU</b>\n<i>Pilih kategori di bawah ini</i>\n${DIV}\n<i>Ketuk kategori untuk melihat perintahnya.</i>`, kb: LIST_KB },
  help: {
    text:
      '❓ <b>Bantuan</b>\n<i>Penjelasan singkat tiap kategori, biar nggak bingung mulai dari mana</i>\n\n' +
      '🎮 <b>Game</b> — main-main ringan buat isi waktu luang: dadu, slot, tebak angka, suit, XO lawan bot, sampai kuis. Menang dapat koin.\n\n' +
      '💰 <b>Ekonomi</b> — kumpulkan koin lewat kerja, mancing, atau menang game. Koinnya bisa dipakai beli lencana keren di toko atau ditransfer ke teman.\n\n' +
      '🎭 <b>Hiburan</b> — hal-hal iseng buat seru-seruan: gombalan, lelucon, ramalan zodiak, sampai cek jodoh.\n\n' +
      '✍️ <b>Kreator</b> — olah teks jadi lebih menarik: font unik, kode morse, teks jadi suara, atau minta AI bikinkan caption dan ringkasan.\n\n' +
      '🧰 <b>Utilitas</b> — alat bantu harian: pengingat, catatan, kurs mata uang, jadwal sholat, sampai konversi satuan.\n\n' +
      '🎧 <b>Musik</b> — rekomendasi lagu Indonesia sesuai suasana hatimu, lengkap dengan kuis tebak penyanyi.\n\n' +
      '📥 <b>Unduh</b> — ambil lagu atau video dari YouTube, dan video dari TikTok tanpa watermark.\n\n' +
      '🧠 <b>AI</b> — ngobrol atau tanya apa saja ke Claude, Gemini, ChatGPT, DeepSeek, atau Qwen (semua gratis), lengkap dengan bikin gambar, terjemahan, dan pencarian web ringkas lewat /cari.\n\n' +
      '🛠️ <b>Tools</b> — perkakas kecil yang sering kepakai: kalkulator, QR code, cek cuaca, sampai bikin password.\n\n' +
      '👥 <b>Grup</b> — khusus admin, buat mengelola member: kick, ban, mute, sampai sistem peringatan.\n\n' +
      '🛡️ <b>Keamanan</b> — firewall otomatis anti-spam, plus perlindungan grup seperti anti-link, anti-flood, dan verifikasi captcha untuk member baru.\n\n' +
      '👑 <b>Owner</b> — kendali penuh bot: broadcast, nyalakan/matikan, restart, backup data, sampai panel web untuk pantau kondisi server.\n\n' +
      'Ketuk ☰ Menu buat lihat daftar perintah lengkap tiap kategori.\n\n© Copyright by Zan',
    kb: BACK_KB,
  },
  game: {
    text: pg('Game', 'Santai dan seru', [
      '/dadu · lempar dadu', '/slot ‹taruhan› · mesin slot', '/tebak · tebak angka 1–100', '/suit · batu gunting kertas',
      '/xo · tic-tac-toe lawan bot', '/kuis · soal hitungan', '/tebakbendera · kuis bendera', '/koin · lempar koin',
      '/pilih ‹a | b | c› · dipilihkan bot', '/truth · /dare · jujur atau tantangan',
    ]),
    kb: BACK_KB,
  },
  eco: {
    text: pg('Ekonomi', 'Kumpulkan koin, naik level', [
      '/profil · level, XP, koin', '/saldo · cek koin', '/daily · hadiah harian', '/kerja · cari koin (30 mnt)',
      '/mancing · mancing ikan (5 mnt)', '/transfer ‹jumlah› · kirim koin (reply)', '/toko · /beli ‹no› · lencana', '/top · peringkat',
    ]),
    kb: BACK_KB,
  },
  fun: {
    text: pg('Hiburan', 'Ringan dan lucu', [
      '/gombal', '/jokes', '/quote', '/fakta', '/8ball ‹tanya›', '/jodoh ‹a | b›', '/rate ‹apa saja›', '/khodam ‹nama›', '/ramal ‹zodiak›', '/pantun ‹tema›',
      '/santai · tips santai & musik tenang', '/marah · tenangkan diri saat kesal',
    ]),
    kb: BACK_KB,
  },
  text: {
    text: pg('Kreator', 'Olah teks, suara, dan AI', [
      '/fancy ‹teks› · 9 gaya font', '/reverse · /mock · /emojify', '/morse · /biner ‹teks›', '/hitungkata ‹teks›', '/tts ‹teks› · jadi suara', '/caption ‹topik› · caption AI', '/ringkas ‹teks› · ringkas AI',
    ]),
    kb: BACK_KB,
  },
  util: {
    text: pg('Utilitas', 'Alat sehari-hari', [
      '/remind ‹10m pesan›', '/fokus [menit] · timer fokus', '/todo · /note', '/kurs ‹100 usd idr›', '/waktu ‹kota›', '/sholat ‹kota›', '/convert ‹10 km mi›',
      '/umur ‹tgl-lahir›', '/bmi ‹kg cm›', '/patungan ‹total orang›', '/shortlink · /ssweb ‹url›', '/ip ‹ip/domain›', '/tasbih · penghitung zikir', '/hijriah · tanggal Hijriah', '/kiblat ‹kota› · arah kiblat', '/doa · doa harian',
    ]),
    kb: BACK_KB,
  },
  music: {
    text: pg('Musik', 'Lagu Indonesia pilihan', [
      '/rekomendasi [mood] · saran lagu', '/playlist [mood] · 5 lagu', '/laguhariini · lagu hari ini', '/tebaklagu · kuis penyanyi', '/lagu ‹judul› · unduh lagu', '',
      '<i>Mood: santai · galau · semangat · romantis · nostalgia</i>',
    ]),
    kb: BACK_KB,
  },
  dl: {
    text: pg('Unduh', 'Maksimal 50 MB', ['/lagu ‹judul/link› · audio YouTube', '/video ‹judul/link› · video YouTube', '/tiktok ‹link› · tanpa watermark']),
    kb: BACK_KB,
  },
  aiplus: {
    text: pg('AI+', '23 fitur AI gratis (ketik perintahnya)', [
      '<b>Teks:</b> /ringkas2 /parafrase /koreksi /nada /email /slogan /deskripsiproduk /judulvideo /cerita /puisi',
      '<b>Belajar:</b> /sdkan /kuisbelajar /flashcard /rangkum /soalmat /tatabahasa',
      '<b>Kreatif:</b> /resep /rencanatrip /rencanabelajar /rekomendasibuku /debat',
      '<b>Coding:</b> /jelaskankode /cari_bug',
      '', '<i>Lihat penjelasan lengkap: /aiplus</i>',
    ]),
    kb: BACK_KB,
  },
  ai: {
    text: pg('AI', 'Tanya apa saja', [
      '/claude · /gemini · /gpt ‹tanya›', '/ai ‹tanya› · AI bawaan', '/img ‹deskripsi› · gambar AI', '/tr ‹bahasa› ‹teks› · terjemah', '/chat on|off · mode ngobrol', '/reset · hapus ingatan', '/models · daftar model', '/aiplus · 23 fitur AI+',
    ]),
    kb: BACK_KB,
  },
  tools: {
    text: pg('Tools', 'Kecil tapi berguna', ['/id · /ping', '/calc ‹rumus›', '/qr ‹teks›', '/cuaca ‹kota›', '/pass [panjang]', '/b64 enc|dec ‹teks›']),
    kb: BACK_KB,
  },
  group: {
    text: pg('Grup', 'Khusus admin, bot harus jadi admin', [
      '/kick · /ban · /unban', '/mute [menit] · /unmute', '/pin · /unpin · /del', '/warn · /warns · /resetwarn', '/setwelcome ‹teks› · /setrules ‹teks›', '/rules · /tagadmin · /groupinfo',
    ]),
    kb: BACK_KB,
  },
  sec: {
    text: pg('Keamanan', 'Firewall dan perlindungan grup', [
      '<b>Grup (admin)</b>', '/keamanan · panel anti-link, flood, bot, captcha', '/warn · 3 peringatan = dikeluarkan', '',
      '<b>Firewall (owner)</b>', '/firewall · status', '/fw on|off', '/fw level ‹longgar|normal|ketat›', '/fw block ‹id› [menit]', '/fw unblock ‹id› · /fw list', '',
      '<i>Anti-spam otomatis aktif untuk semua pengguna.</i>',
    ]),
    kb: BACK_KB,
  },
  prem: {
    text: pg('Premium', 'Akses lebih longgar, bayar via QRIS', [
      '/premium · lihat paket dan bayar', '/premium riwayat · riwayat pembelian', '', '<i>Pembayaran dikonfirmasi owner secara manual.</i>',
    ]),
    kb: BACK_KB,
  },
  panelmenu: {
    text: pg('Panel', 'Status panel & mode perawatan (owner)', [
      '/maintenance on|off [pesan] · mode perawatan', '/maintenance · cek status', '/status · status lengkap', '/fw · firewall & anti-DDoS',
    ]),
    kb: BACK_KB,
  },
  vps: {
    text: pg('VPS', 'Pantau dan kendalikan server (khusus owner)', [
      '/vps · daftar server dan statusnya', '/tambahvps ‹nama› ‹alamat:port› · pantau port/situs', '/vpspanel ‹nama› ‹password› · hubungkan panel bot lain',
      '/hapusvps ‹nama›', '',
      '<i>Dikabari otomatis kalau VPS mati atau pulih. Bot tidak login SSH.</i>',
    ]),
    kb: BACK_KB,
  },
  fly: {
    text: pg('Fly', 'Kelola panel di Fly.io (khusus owner)', [
      '/fly · status mesin dan tombol kontrol', '/flycek · cek kesiapan (volume, token, mesin ganda)', '/flypanduan · cara bikin panel di Fly', '',
      '<i>Restart/stop mesin dari bot butuh FLY_API_TOKEN (opsional).</i>',
    ]),
    kb: BACK_KB,
  },
  owner: {
    text: pg('Owner', 'Khusus owner bot', [
      '/addowner · /delowner · /owners', '/bc ‹pesan› · broadcast', '/on · /off · /restart · /shutdown', '/status · /statistik · /log', '/backup · /cekbanner', '/botban · /botunban · /banlist', '/tes · tes kesehatan bot', '/maintenance · mode perawatan', '/premium · paket premium', '/addpremium · aktifkan premium manual', '/setdomain · domain panel (Netlify/sendiri)', '/ipserver · IP publik server & alamat panel', '/qrisauto · status pembayaran otomatis', '/konfirmasi KODE · aktifkan dari pesanan QRIS', '/setqris · atur QRIS', '/riwayatjual · penjualan', '/panel · /setpassword · panel web (login pakai password)', '/fly · kelola panel di Fly.io', '/vps · pantau server lain', '/vps · pantau dan tambah VPS',
    ]),
    kb: BACK_KB,
  },
};

// ---- Banner animasi (MP4 halus, atau GIF) ---------------------------------
// Cari banner di beberapa lokasi (folder banners, atau file yang diupload langsung di folder bot)
const BANNER_DIRS = [
  path.join(__dirname, 'banners'),
  __dirname,
  path.join(process.cwd(), 'banners'),
  process.cwd(),
  path.join(__dirname, 'telegram-bot-node', 'banners'),
];
const BANNER_KEYS = ['dashboard', 'list', 'game', 'eco', 'fun', 'text', 'util', 'music', 'sec', 'fly', 'vps', 'prem', 'panelmenu', 'dl', 'ai', 'aiplus', 'tools', 'group', 'owner'];
const BANNER_EXT = ['mp4', 'gif']; // mp4 diutamakan (lebih halus & ringan)
const FILE_IDS = readJSON('file_ids.json', {});
const bannerPath = (k) => {
  for (const d of BANNER_DIRS) {
    for (const ext of BANNER_EXT) {
      const p = path.join(d, `${k}.${ext}`);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
};
const hasBanner = (k) => !!bannerPath(k);
const bannerSrc = (k) => ({ source: bannerPath(k) });
const bannerCount = () => BANNER_KEYS.filter(hasBanner).length;
// kunci cache file_id ikut nama & ukuran file, jadi ganti banner otomatis dikirim ulang
const ck = (k) => {
  const p = bannerPath(k);
  return p ? `${k}:${path.basename(p)}:${fs.statSync(p).size}` : k;
};

ownerCmd('cekbanner', (ctx) => {
  const lines = BANNER_KEYS.map((k) => {
    const p = bannerPath(k);
    return `${p ? '✅' : '❌'} ${k}${p ? path.extname(p) : ' (tidak ada)'}`;
  }).join('\n');
  ctx.reply(
    `🖼️ Banner ditemukan: ${bannerCount()}/${BANNER_KEYS.length}\n${lines}\n\n` +
      `Folder bot:\n${__dirname}\n\nTaruh folder "banners" (isi 8 file .mp4) di folder di atas, lalu Restart.`
  );
});

const mediaOf = (k) => FILE_IDS[ck(k)] || bannerSrc(k);

function cacheId(k, m) {
  const f = m && typeof m === 'object' && (m.animation || m.video || m.document);
  const key = ck(k);
  if (f && f.file_id && FILE_IDS[key] !== f.file_id) {
    FILE_IDS[key] = f.file_id;
    writeJSON('file_ids.json', FILE_IDS);
  }
}

const pageOf = (ctx, key) => (key === 'dashboard' ? dashboard(ctx) : SECTIONS[key]);

// Reaksi emoji pada pesan pengguna (Bot API setMessageReaction). Gagal diam-diam jika tidak didukung.
function react(ctx, emoji) {
  const m = ctx.message;
  if (!m || !m.message_id || !ctx.chat) return;
  bot.telegram.callApi('setMessageReaction', { chat_id: ctx.chat.id, message_id: m.message_id, reaction: [{ type: 'emoji', emoji }] }).catch(() => {});
}
// Pesan menu terakhir per chat: saat pengguna pindah menu, pesan lama dihapus supaya chat tetap rapi
const LAST_MENU = new Map();
async function clearLastMenu(chatId) {
  const id = LAST_MENU.get(chatId);
  if (!id) return;
  LAST_MENU.delete(chatId);
  await bot.telegram.deleteMessage(chatId, id).catch(() => {});
}
async function sendPage(ctx, key) {
  const page = pageOf(ctx, key);
  if (!page) return;
  const chatId = ctx.chat && ctx.chat.id;
  await clearLastMenu(chatId);
  const keep = (m) => { if (m && m.message_id && chatId) LAST_MENU.set(chatId, m.message_id); return m; };
  if (!hasBanner(key)) return keep(await ctx.reply(page.text, { parse_mode: 'HTML', ...page.kb }));
  const extra = { caption: page.text, parse_mode: 'HTML', ...page.kb };
  let m;
  try {
    m = await ctx.replyWithAnimation(mediaOf(key), extra);
  } catch (e) {
    if (!FILE_IDS[ck(key)]) throw e;
    delete FILE_IDS[ck(key)]; // file_id basi, kirim ulang dari file
    m = await ctx.replyWithAnimation(bannerSrc(key), extra);
  }
  cacheId(key, m);
  keep(m);
}

async function editPage(ctx, key) {
  const page = pageOf(ctx, key);
  if (!page) return;
  if (!hasBanner(key)) return ctx.editMessageText(page.text, { parse_mode: 'HTML', ...page.kb }).catch(() => {});
  const media = (m) => ({ type: 'animation', media: m, caption: page.text, parse_mode: 'HTML' });
  try {
    cacheId(key, await ctx.editMessageMedia(media(mediaOf(key)), page.kb));
  } catch (e) {
    if (/not modified/i.test(e.description || e.message)) return;
    try {
      delete FILE_IDS[ck(key)];
      cacheId(key, await ctx.editMessageMedia(media(bannerSrc(key)), page.kb));
    } catch (e2) {
      if (/not modified/i.test(e2.description || e2.message)) return;
      await sendPage(ctx, key).catch(() => {}); // pesan lama (teks biasa) -> kirim baru
    }
  }
}

const REPLY_KB = Markup.keyboard([['☰ Menu', '🎵 Lagu', '👤 Profil'], ['❓ Bantuan']]).resize();

bot.command(['start', 'dashboard'], async (ctx) => {
  const m = await ctx.reply('◐ memuat', REPLY_KB);
  for (const f of ['◓ memuat', '◑ memuat', '✓ siap']) {
    await sleep(80);
    await ctx.telegram.editMessageText(ctx.chat.id, m.message_id, undefined, f).catch(() => {});
  }
  await sendPage(ctx, 'dashboard');
});
bot.command('menu', (ctx) => sendPage(ctx, 'list'));
bot.command(['help', 'bantuan'], (ctx) => sendPage(ctx, 'help'));
bot.command(['daftaronline', 'online'], (ctx) => sendPage(ctx, 'online'));
bot.command(['sedekahmenu'], (ctx) => sendPage(ctx, 'sedekah'));
bot.command(['daftaroffline', 'offline'], (ctx) => sendPage(ctx, 'offline'));

bot.hears('☰ Menu', (ctx) => sendPage(ctx, 'list'));
bot.hears('👤 Profil', (ctx) => sendProfile(ctx));
bot.hears('🎵 Lagu', (ctx) => (hasCustomSong ? sendCustomSong(ctx) : sendSongOfDay(ctx)));
bot.hears('❓ Bantuan', (ctx) => sendPage(ctx, 'help'));
// tombol keyboard lama (kompatibel untuk pengguna yang belum menekan /start lagi)
bot.hears('🏠 Start', (ctx) => sendPage(ctx, 'dashboard'));
const KEY_MAP = {
  '📜 List Menu': 'list', '🎮 Game': 'game', '💰 Ekonomi': 'eco', '🎭 Hiburan': 'fun', '✍️ Kreator': 'text', '🧰 Utilitas': 'util',
  '📥 Downloader': 'dl', '🧠 AI Chat': 'ai', '🛠️ Tools': 'tools', '👥 Group Admin': 'group', '👑 Owner': 'owner',
};
// Halaman khusus owner: pengguna biasa tidak melihat isinya, hanya diberi tahu dengan ramah
const OWNER_ONLY_PAGES = new Set(['owner', 'fly', 'vps', 'panelmenu']);
const OWNER_MSG = '👑 Menu ini khusus owner bot.';
for (const [label, key] of Object.entries(KEY_MAP)) {
  bot.hears(label, (ctx) => {
    if (typeof ctx.deleteMessage === 'function') ctx.deleteMessage().catch(() => {});
    if (OWNER_ONLY_PAGES.has(key) && !isOwner(ctx.from.id)) return ctx.reply(OWNER_MSG);
    return sendPage(ctx, key);
  });
}

bot.action(/^menu:(.+)$/, async (ctx) => {
  const key = ctx.match[1];
  if (OWNER_ONLY_PAGES.has(key) && !isOwner(ctx.from.id)) return ctx.answerCbQuery(OWNER_MSG, { show_alert: true }).catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  if (key === 'profil') return sendProfile(ctx);
  await editPage(ctx, key);
});


// ===========================================================================
// 🖥️ WEB PANEL: kendalikan bot & lihat kondisi server dari browser
// ===========================================================================
const http = require('http');
const https = require('https');
const { execFileSync } = require('child_process');
const crypto = require('crypto');
// Token panel dibuat otomatis oleh sistem, tidak perlu diisi manual.
// Bisa dipaksa pakai token sendiri lewat env.json (field "PANEL_TOKEN"), opsional.
function getPanelToken() {
  const manual = cfg('PANEL_TOKEN', '');
  if (manual && manual.length >= 20) return manual;
  if (manual) console.warn('⚠️ PANEL_TOKEN terlalu pendek (minimal 20 karakter) dan diabaikan. Token kuat dibuat otomatis.');
  const saved = readJSON('panel-secret.json', null);
  if (saved && saved.token) return saved.token;
  const token = crypto.randomBytes(24).toString('hex');
  writeJSON('panel-secret.json', { token, createdAt: new Date().toISOString() });
  return token;
}
const PANEL_TOKEN = getPanelToken();
// Port dipilih otomatis: isi manual di env.json (PANEL_PORT) > PORT > SERVER_PORT (diisi panel hosting
// seperti Pterodactyl sesuai port server kamu) > 8080. Jadi umumnya tidak perlu diatur apa-apa.
const PANEL_PORT = Number(cfg('PANEL_PORT', '') || process.env.PORT || process.env.SERVER_PORT || 8080);
// Domain sendiri untuk panel (mis. panel.namamu.com). Kosongkan jika belum punya.
const DOMAIN_RE = /^(?=.{4,253}$)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/;
const cleanDomain = (d) => String(d || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
// Prioritas: domain yang dikirim owner lewat /setdomain, lalu PANEL_DOMAIN dari env/secret
const DOMAIN_FILE = 'panel-domain.json';
const SAVED_DOMAIN = (readJSON(DOMAIN_FILE, {}) || {}).domain || '';
const PANEL_DOMAIN = cleanDomain(SAVED_DOMAIN || cfg('PANEL_DOMAIN', ''));
const PANEL_DOMAIN_OK = DOMAIN_RE.test(PANEL_DOMAIN);
const PANEL_FILE = path.join(__dirname, 'panel.html');

async function doBroadcast(text) {
  let ok = 0;
  let fail = 0;
  for (const id of USERS) {
    try {
      await bot.telegram.sendMessage(id, `📢 <b>Pengumuman</b>\n\n${esc(text)}`, { parse_mode: 'HTML' });
      ok++;
    } catch (_) {
      fail++;
    }
    await sleep(60);
  }
  return { ok, fail };
}

function safeTokenEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

let PUBLIC_IP = null, PUBLIC_IP_AT = 0, PUBLIC_IP_BUSY = false;
function refreshPublicIpBg() {
  if (PUBLIC_IP_BUSY || Date.now() - PUBLIC_IP_AT < 60 * 60e3) return;
  PUBLIC_IP_BUSY = true;
  serverPublicIp().then((ip) => { if (ip) PUBLIC_IP = ip; PUBLIC_IP_AT = Date.now(); }).catch(() => {}).finally(() => { PUBLIC_IP_BUSY = false; });
}
function panelStatus() {
  refreshPublicIpBg();
  const now = Date.now();
  const active = Object.entries(FW.blocked).filter(([, t]) => t > now).length;
  const lv = FW_LEVELS[FW.level] || FW_LEVELS.normal;
  return {
    version: VERSION,
    botName: (bot.botInfo && bot.botInfo.username) || null,
    active: STATE.active,
    uptimeMs: Date.now() - START_TIME,
    nodeVersion: process.version,
    ramBytes: process.memoryUsage().rss,
    sysMemTotal: os.totalmem(),
    sysMemUsed: os.totalmem() - os.freemem(),
    cpuLoad: os.loadavg()[0],
    cpuCount: os.cpus().length,
    users: USERS.size,
    groups: Object.keys(GROUPS).length,
    owners: OWNERS.size,
    totalCmds: STATS.total || 0,
    firewall: { on: FW.on, level: FW.level, blocked: active, hits: FW.hits || 0, maxPerWindow: lv.n, windowMs: lv.win },
    banners: { found: bannerCount(), total: BANNER_KEYS.length },
    errors: ERRLOG.slice(-15),
    chats: RECENT_CHATS.slice(-15).reverse(),
    fly: FLY_APP ? { app: FLY_APP, region: FLY_REGION, machine: FLY_MACHINE, url: flyUrl() } : null,
    finance: (() => {
      const pendapatan = PREM.sales.reduce((x, y) => x + (y.price || 0), 0);
      const sedekah = PREM.donations.reduce((x, y) => x + (y.amount || 0), 0);
      const aktif = Object.values(PREM.users).filter((u) => u.until > Date.now()).length;
      return { pendapatan, penjualan: PREM.sales.length, sedekah, donatur: PREM.donations.length, menunggu: Object.keys(PREM.pending).length + Object.keys(PREM.donPending).length, premiumAktif: aktif };
    })(),
    recentSales: PREM.sales.slice(-6).reverse().map((x) => ({ t: x.t, user: x.user, plan: x.plan, price: x.price, kode: x.kode })),
    maint: { on: MAINT.on, msg: MAINT.msg },
    server: { publicIp: PUBLIC_IP, port: PANEL_PORT, host: os.hostname() },
  };
}

// HTTPS mandiri (self-signed) dibuat otomatis oleh sistem sekali saja, lalu dipakai terus.
// Browser akan menampilkan peringatan "Tidak aman" sekali di awal (wajar untuk sertifikat
// mandiri tanpa domain resmi) - tinggal pilih "Lanjutkan/Advanced > Proceed anyway".
const PANEL_HTTPS = String(cfg('PANEL_HTTPS', '')).toLowerCase() === 'true';
function getPanelCert() {
  const certFile = file('panel-cert.pem');
  const keyFile = file('panel-key.pem');
  if (fs.existsSync(certFile) && fs.existsSync(keyFile)) {
    return { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) };
  }
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyFile, '-out', certFile,
    '-days', '825', '-subj', '/CN=panel-bot',
  ], { stdio: 'pipe' });
  return { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) };
}

// ---- Keamanan panel web -----------------------------------------------------------------
// - Login menukar token master dengan SESI 12 jam (token master tidak disimpan di browser).
// - 5x salah token dari satu IP dalam 10 menit => IP itu dikunci 15 menit + owner dikabari lewat Telegram.
// - Header keamanan di semua respons, CSP ketat di halaman panel, token tidak lagi diterima lewat alamat (?t=).
// - Opsional (env.json / environment variable):
//     PANEL_ORIGINS   = daftar asal yang boleh memanggil API, pisahkan koma (contoh: https://panelku.netlify.app)
//     PANEL_ALLOW_IPS = daftar IP yang boleh membuka panel, pisahkan koma (kosong = semua)
//     TRUST_PROXY     = true bila bot berada di belakang proxy (otomatis aktif di Fly.io)
const PANEL_ORIGINS = String(cfg('PANEL_ORIGINS', '')).split(',').map((x) => x.trim().replace(/\/$/, '')).filter(Boolean);
const PANEL_ALLOW_IPS = String(cfg('PANEL_ALLOW_IPS', '')).split(',').map((x) => x.trim()).filter(Boolean);
const BEHIND_PROXY = !!process.env.FLY_APP_NAME || String(cfg('TRUST_PROXY', '')).toLowerCase() === 'true';
const SESSION_TTL = 12 * 3600e3;
const AUTH_MAX_FAILS = 5;
const AUTH_WINDOW = 10 * 60e3;
const AUTH_LOCK = 15 * 60e3;
const sessions = new Map();
const authFails = new Map();
let lastBroadcast = 0;

// Batas laju per IP: maksimal 40 permintaan per 10 detik (panel sendiri hanya ~2 per 5 detik).
const RATE_WINDOW = 10e3;
const RATE_MAX = 40;
const rateHits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const h = (rateHits.get(ip) || []).filter((t) => now - t < RATE_WINDOW);
  h.push(now);
  rateHits.set(ip, h);
  return h.length > RATE_MAX;
}
// Notifikasi penguncian ke owner dibatasi 1x per 10 menit, supaya scanner internet tidak membanjiri Telegram-mu.
const lockAlert = { last: 0, pending: 0 };
function notifyLockout(ip) {
  lockAlert.pending++;
  if (Date.now() - lockAlert.last < 10 * 60e3) return;
  const n = lockAlert.pending;
  lockAlert.pending = 0;
  lockAlert.last = Date.now();
  notifyOwners(`🚨 Panel web: percobaan login gagal berulang (${n} penguncian IP sejak laporan terakhir), terbaru dari ${ip}. IP dikunci ${fmtDur(AUTH_LOCK)}.`);
}
// CSP ketat: skrip & gaya inline hanya boleh yang hash-nya cocok dengan isi panel.html (tanpa 'unsafe-inline').
function panelPage() {
  const html = fs.readFileSync(PANEL_FILE, 'utf8').replace(/\r\n/g, '\n'); // CRLF dinormalkan agar hash selalu cocok
  const hashes = (tag) =>
    [...html.matchAll(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>', 'g'))]
      .map((m) => `'sha256-${crypto.createHash('sha256').update(m[1]).digest('base64')}'`)
      .join(' ') || "'none'";
  const csp = `default-src 'none'; script-src ${hashes('script')}; style-src ${hashes('style')}; style-src-attr 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
  return { html, csp };
}

function clientIp(req) {
  if (BEHIND_PROXY) {
    const h = req.headers['fly-client-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (h) return h;
  }
  return String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}
// ---- Password panel: menggantikan login memakai token -----------------------------------------
// Password TIDAK pernah disimpan polos: hanya hash scrypt (+ salt acak) di panel-password.json (folder data).
// Sumber password: (1) PANEL_PASSWORD di env/secret (tidak bisa diubah dari bot), atau (2) perintah /setpassword.
const PW_MIN = 10;
const PW_FILE = 'panel-password.json';
const SCRYPT = { N: 16384, r: 8, p: 1 };
const scryptAsync = (pw, salt) => new Promise((resolve, reject) => crypto.scrypt(pw, salt, 64, SCRYPT, (e, k) => (e ? reject(e) : resolve(k))));
function passwordProblem(pw) {
  if (pw.length < PW_MIN) return `terlalu pendek (minimal ${PW_MIN} karakter)`;
  if (pw.length > 128) return 'terlalu panjang (maksimal 128 karakter)';
  if (/^\d+$/.test(pw)) return 'jangan hanya angka';
  if (new Set(pw.toLowerCase()).size < 5) return 'terlalu monoton (pakai lebih banyak karakter berbeda)';
  if (/password|kata\s?sandi|qwerty|123456|abcdef|admin|letmein|telegram|botku/i.test(pw)) return 'terlalu mudah ditebak';
  return '';
}
async function makePwRecord(pw) {
  const salt = crypto.randomBytes(16);
  return { v: 1, salt: salt.toString('hex'), hash: (await scryptAsync(pw, salt)).toString('hex') };
}
async function pwMatches(pw, rec) {
  const got = await scryptAsync(pw, Buffer.from(rec.salt, 'hex'));
  const want = Buffer.from(rec.hash, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
let PW_ENV = null; // dari PANEL_PASSWORD
let PW_STORED = readJSON(PW_FILE, null); // dari /setpassword
if (!(PW_STORED && PW_STORED.salt && PW_STORED.hash)) PW_STORED = null;
{
  const envPw = String(cfg('PANEL_PASSWORD', '') || '');
  if (envPw) {
    const problem = passwordProblem(envPw);
    if (problem) console.warn(`⚠️ PANEL_PASSWORD ditolak: ${problem}. Diabaikan.`);
    else {
      const salt = crypto.randomBytes(16);
      PW_ENV = { v: 1, salt: salt.toString('hex'), hash: crypto.scryptSync(envPw, salt, 64, SCRYPT).toString('hex') };
    }
  }
}
const pwRecord = () => PW_ENV || PW_STORED;

// Serangan tebak password dari banyak IP sekaligus: kalau ada >=30 gagal dalam 10 menit (di semua IP),
// setiap jawaban gagal ditahan 1,5 detik dan owner dikabari (maksimal 1x per 10 menit).
const pwFailTimes = [];
let lastPwAlert = 0;
function notePwFail() {
  const now = Date.now();
  pwFailTimes.push(now);
  while (pwFailTimes.length && now - pwFailTimes[0] > 10 * 60e3) pwFailTimes.shift();
  if (pwFailTimes.length < 30) return false;
  if (now - lastPwAlert > 10 * 60e3) {
    lastPwAlert = now;
    notifyOwners('🚨 Panel web: lonjakan percobaan password gagal dari banyak sumber. Respons login diperlambat otomatis. Pastikan password-mu kuat dan unik.');
  }
  return true;
}

function notifyOwners(text) {
  for (const o of MAIN_OWNERS) bot.telegram.sendMessage(o, text).catch(() => {});
}
function lockedLeft(ip) {
  const f = authFails.get(ip);
  return f && f.lockedUntil > Date.now() ? f.lockedUntil - Date.now() : 0;
}
function noteAuthFail(ip) {
  const now = Date.now();
  let f = authFails.get(ip);
  if (!f || now - f.first > AUTH_WINDOW) f = { n: 0, first: now, lockedUntil: 0 };
  f.n++;
  if (f.n >= AUTH_MAX_FAILS) {
    f.lockedUntil = now + AUTH_LOCK;
    f.n = 0;
    f.first = now;
    console.log(`🛡️ Panel: IP ${ip} dikunci ${fmtDur(AUTH_LOCK)} (terlalu banyak kredensial salah)`);
    notifyLockout(ip);
  }
  authFails.set(ip, f);
}
function newSession(ip) {
  const id = crypto.randomBytes(32).toString('hex');
  sessions.set(id, { exp: Date.now() + SESSION_TTL, ip });
  return id;
}
function validSession(id) {
  const s = sessions.get(String(id));
  if (!s) return false;
  if (s.exp < Date.now()) {
    sessions.delete(String(id));
    return false;
  }
  return true;
}
// Webhook pembayaran: layanan mutasi/payment gateway mengirim POST berisi { "amount": 15123 }
// dengan header X-Signature = HMAC-SHA256(QRIS_WEBHOOK_SECRET, body mentah) dalam hex.
async function premWebhook(req, res, send) {
  if (!QRIS_SECRET) return send(404, { error: 'tidak tersedia' });
  let raw;
  try {
    raw = await readBody(req);
  } catch (_) {
    return send(413, { error: 'terlalu besar' });
  }
  const sig = String(req.headers['x-signature'] || '').toLowerCase();
  const want = crypto.createHmac('sha256', QRIS_SECRET).update(raw).digest('hex');
  const okSig = sig.length === want.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want));
  if (!okSig) {
    console.log('💳 Webhook QRIS: tanda tangan tidak cocok, permintaan ditolak');
    return send(401, { error: 'tanda tangan salah' });
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (_) {
    return send(400, { error: 'json tidak valid' });
  }
  const amount = Math.round(Number(data.amount));
  if (!amount || amount <= 0) return send(400, { error: 'nominal tidak valid' });
  const cocok = (db) => Object.entries(db).find(([, o]) => o.amount === amount && Date.now() - o.t < PAY_WINDOW);
  const sedekahEntry = cocok(PREM.donPending);
  if (!cocok(PREM.pending) && sedekahEntry) {
    const [kd, don] = sedekahEntry;
    delete PREM.donPending[kd];
    PREM.donations.push({ kode: kd, amount: don.amount, nama: don.nama || 'Hamba Allah', t: Date.now() });
    savePrem();
    notifyOwners(`💝 Sedekah masuk otomatis: ${PRICE(don.amount)} (${kd}). Total sedekah: ${PRICE(PREM.donations.reduce((x, y) => x + y.amount, 0))}.`);
    console.log(`💝 Sedekah otomatis diterima: ${PRICE(don.amount)}`);
    return send(200, { ok: true, type: 'sedekah' });
  }
  const entry = cocok(PREM.pending);
  if (!entry) {
    console.log(`💳 Webhook QRIS: pembayaran ${PRICE(amount)} tidak cocok dengan pesanan aktif`);
    return send(404, { error: 'pesanan tidak ditemukan' });
  }
  const [kode, order] = entry;
  const plan = order.days ? { name: order.name || `Premium ${order.days} hari`, days: order.days, price: order.price } : PREM.plans.find((x) => x.id === order.plan);
  delete PREM.pending[kode]; // sekali pakai: webhook yang diulang tidak mengaktifkan dua kali
  if (!plan) {
    savePrem();
    return send(409, { error: 'paket sudah dihapus' });
  }
  const base = Math.max(Date.now(), (PREM.users[order.user] && PREM.users[order.user].until) || 0);
  PREM.users[order.user] = { until: base + plan.days * 864e5, by: kode, t: Date.now() };
  PREM.sales.push({ user: order.user, plan: plan.name, price: order.price, kode, auto: true, t: Date.now() });
  savePrem();
  bot.telegram.sendMessage(order.user, `✅ Pembayaran ${kode} diterima otomatis. ${plan.name} aktif!`).catch(() => {});
  notifyOwners(`💰 Pembayaran QRIS otomatis ${PRICE(amount)} diterima. Pesanan ${kode} (${plan.name}) untuk user ${order.user} sudah aktif.`);
  console.log(`💳 Premium aktif otomatis: pesanan ${kode}, ${PRICE(amount)}`);
  return send(200, { ok: true });
}

async function readBody(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 20000) {
      req.destroy();
      throw new Error('body terlalu besar');
    }
  }
  return body;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of sessions) if (v.exp < now) sessions.delete(k);
  for (const [k, v] of authFails) if (v.lockedUntil < now && now - v.first > AUTH_WINDOW) authFails.delete(k);
}, 10 * 60e3).unref();

function startPanel() {
  const handler = async (req, res) => {
    const ip = clientIp(req);
    const send = (code, obj, extra = {}) => {
      res.writeHead(code, { 'Content-Type': 'application/json', ...extra });
      res.end(JSON.stringify(obj));
    };
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    if (proto === 'https' || BEHIND_PROXY) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
    try {
      const u = new URL(req.url, 'http://x');
      if (u.pathname === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end('ok'); // untuk health check hosting (Fly.io dll), tanpa informasi apa pun
      }
      if (BEHIND_PROXY && String(req.headers['x-forwarded-proto'] || '').toLowerCase() === 'http') {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        return res.end('HTTPS diperlukan'); // di belakang proxy, tolak akses HTTP polos
      }
      if (PANEL_ALLOW_IPS.length && !PANEL_ALLOW_IPS.includes(ip)) {
        res.writeHead(403);
        return res.end('Forbidden');
      }
      const dd = ddosCheckHttp(ip);
      if (dd) return send(429, { error: dd === 'banned' ? 'IP sementara diblokir' : 'server sibuk, coba lagi' }, { 'Retry-After': '30' });
      if (rateLimited(ip)) return send(429, { error: 'terlalu banyak permintaan' }, { 'Retry-After': '10' });
      if (req.method === 'POST' && u.pathname === '/api/qris-webhook') return premWebhook(req, res, send);
      // CORS: default hanya same-origin. Asal lain HARUS didaftarkan di PANEL_ORIGINS (mis. panelmu di Netlify).
      const origin = req.headers.origin;
      const corsOk = !!origin && (PANEL_ORIGINS.includes(origin) || (PANEL_DOMAIN_OK && origin === `https://${PANEL_DOMAIN}`));
      if (corsOk) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Panel-Token, X-Panel-Session');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      } else if (origin && u.pathname.startsWith('/api/')) {
        let sameHost = false;
        try {
          sameHost = new URL(origin).host === req.headers.host;
        } catch (_) {}
        if (!sameHost) return send(403, { error: 'asal tidak diizinkan' });
      }
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
      }
      if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/panel.html')) {
        const { html, csp } = panelPage();
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': csp });
        return res.end(html);
      }
      if (!u.pathname.startsWith('/api/')) {
        res.writeHead(404);
        return res.end('Not found');
      }
      const left = lockedLeft(ip);
      if (left) return send(429, { error: 'terlalu banyak percobaan gagal, coba lagi nanti' }, { 'Retry-After': String(Math.ceil(left / 1000)) });
      if (req.method === 'POST' && u.pathname === '/api/login') {
        let data = {};
        try {
          data = JSON.parse((await readBody(req)) || '{}');
        } catch (_) {}
        let ok = false;
        if (typeof data.password === 'string') {
          const rec = pwRecord();
          if (!rec) return send(409, { error: 'password_belum_diatur' });
          try {
            ok = await pwMatches(data.password.slice(0, 200), rec);
          } catch (_) {
            ok = false;
          }
          if (!ok && notePwFail()) await sleep(1500);
        } else if (data.token) {
          ok = safeTokenEqual(String(data.token), PANEL_TOKEN); // jalur lama, hanya untuk skrip
        } else {
          return send(400, { error: 'password diperlukan' });
        }
        if (!ok) {
          noteAuthFail(ip);
          console.log(`🛡️ Panel: login GAGAL dari ${ip}`);
          return send(401, { error: 'unauthorized' });
        }
        console.log(`🖥️ Panel: login berhasil dari ${ip}`);
        notifyOwners(`🖥️ Panel web: login berhasil dari IP ${ip}.\nBukan kamu? Kirim /setpassword KATA-SANDI-BARU (semua sesi login lama otomatis dicabut).`);
        return send(200, { session: newSession(ip), expiresInMs: SESSION_TTL });
      }
      const sess = req.headers['x-panel-session'];
      const tok = req.headers['x-panel-token'];
      const authed = (sess && validSession(sess)) || (tok && safeTokenEqual(tok, PANEL_TOKEN));
      if (!authed) {
        if (sess || tok) noteAuthFail(ip); // hanya kredensial yang SALAH yang dihitung (probe tanpa kredensial cukup ditolak)
        return send(401, { error: 'unauthorized' });
      }
      if (req.method === 'POST' && u.pathname === '/api/logout') {
        if (sess) sessions.delete(String(sess));
        return send(200, { ok: true });
      }
      if (req.method === 'GET' && u.pathname === '/api/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(panelStatus()));
      }
      if (req.method === 'POST' && u.pathname === '/api/action') {
        let data = {};
        try {
          data = JSON.parse((await readBody(req)) || '{}');
        } catch (_) {
          return send(400, { error: 'permintaan tidak valid' });
        }
        const action = data.action;
        console.log(`🖥️ Panel: aksi "${action}" dari ${ip}`);
        if (['off', 'restart', 'shutdown', 'broadcast'].includes(action)) notifyOwners(`🖥️ Panel web: aksi "${action}" dijalankan dari IP ${ip}.`);
        if (action === 'on') {
          STATE.active = true;
          saveState();
        } else if (action === 'off') {
          STATE.active = false;
          saveState();
        } else if (action === 'maint') {
          MAINT.on = !!data.on;
          if (typeof data.msg === 'string' && data.msg.trim()) MAINT.msg = data.msg.trim().slice(0, 300);
          saveMaint();
        } else if (action === 'broadcast') {
          const text = String(data.text || '').slice(0, 3500);
          if (!text) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'teks kosong' }));
          }
          if (Date.now() - lastBroadcast < 60000) return send(429, { error: 'tunggu 1 menit antar broadcast' });
          lastBroadcast = Date.now();
          const r = await doBroadcast(text);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: r.ok, fail: r.fail }));
        } else if (action === 'restart') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return setTimeout(() => stopAndExit(RESTART_EXIT_CODE), 300);
        } else if (action === 'shutdown') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return setTimeout(() => stopAndExit(0), 300);
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'aksi tidak dikenal' }));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true }));
      }
      res.writeHead(404);
      res.end('Not found');
    } catch (e) {
      console.error('Panel error:', e.message);
      try {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'server error' }));
      } catch (_) {}
    }
  };

  let server;
  let proto = 'http';
  if (PANEL_HTTPS) {
    try {
      const { cert, key } = getPanelCert();
      server = https.createServer({ cert, key }, handler);
      proto = 'https';
    } catch (e) {
      console.error('Gagal membuat sertifikat HTTPS (openssl tidak tersedia?):', e.message);
      console.log('🖥️ Web panel tetap jalan pakai HTTP biasa.');
      server = http.createServer(handler);
    }
  } else {
    server = http.createServer(handler);
  }
  server.connectionsCheckingInterval = 5e3; // cek koneksi lambat tiap 5 detik (default Node 30 detik)
  server.headersTimeout = 10e3;
  server.requestTimeout = 15e3;
  server.keepAliveTimeout = 5e3;
  server.maxHeadersCount = 50;
  server.maxConnections = 200;
  server.on('error', (e) => console.error('Web panel gagal start:', e.message));
  server.listen(PANEL_PORT, () => console.log(`🖥️ Web panel aktif (${proto}) di port ${PANEL_PORT} (butuh token) · domain: ${PANEL_DOMAIN_OK ? PANEL_DOMAIN : 'belum diatur (PANEL_DOMAIN)'} · asal lain: ${PANEL_ORIGINS.length ? PANEL_ORIGINS.join(', ') : 'hanya same-origin'}`));
}

ownerCmd(['tes', 'test', 'cek'], async (ctx) => {
  const testFile = path.join(__dirname, 'test.js');
  if (!fs.existsSync(testFile)) return ctx.reply('❌ File test.js tidak ditemukan di folder bot. Upload test.js dari paket terbaru.');
  const st = await progress(ctx, '🧪 Menjalankan tes kesehatan');
  require('child_process').execFile(process.execPath, [testFile], { timeout: 40000, env: { ...process.env, NO_COLOR: '1' } }, (err, stdout, stderr) => {
    const out = String(stdout || stderr || (err && err.message) || 'Tidak ada output').replace(SECRET_RE, '[TOKEN]').slice(0, 3500);
    st.del().then(() => ctx.reply(`<pre>${esc(out)}</pre>`, { parse_mode: 'HTML' }).catch(() => ctx.reply(out)));
  });
});

// ===========================================================================
// ☁️ FLY.IO: menu /fly (status mesin, kontrol, panduan bikin panel, cek kesiapan)
// ===========================================================================
// Variabel ini diisi otomatis oleh Fly di dalam mesin: FLY_APP_NAME, FLY_MACHINE_ID, FLY_REGION.
// Kontrol mesin (restart/stop) butuh FLY_API_TOKEN, opsional: fly secrets set FLY_API_TOKEN="$(fly tokens create deploy -a NAMA-APP)"
const FLY_APP = process.env.FLY_APP_NAME || '';
const FLY_MACHINE = process.env.FLY_MACHINE_ID || '';
const FLY_REGION = process.env.FLY_REGION || '';
const FLY_TOKEN = cfg('FLY_API_TOKEN', '');
const FLY_API = String(cfg('FLY_API_BASE', 'https://api.machines.dev/v1')).replace(/\/$/, '');
const flyUrl = () => (FLY_APP ? `https://${FLY_APP}.fly.dev` : '');

async function flyApi(method, p, body) {
  const auth = /^(FlyV1|Bearer)\s/i.test(FLY_TOKEN) ? FLY_TOKEN : `Bearer ${FLY_TOKEN}`;
  const r = await fetch(`${FLY_API}/apps/${encodeURIComponent(FLY_APP)}${p}`, {
    method,
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const text = await r.text();
  let j = {};
  try {
    j = text ? JSON.parse(text) : {};
  } catch (_) {
    j = { raw: text };
  }
  if (!r.ok) throw new Error(`Fly API ${r.status}: ${String((j && (j.error || j.message)) || text || r.status).slice(0, 140)}`);
  return j;
}

const FLY_EMOJI = { started: '🟢', stopped: '⚫', starting: '🟡', stopping: '🟡', created: '🟡', replacing: '🟡', failed: '🔴', destroyed: '⚫', suspended: '⚪' };

function flyKb({ control, others, url } = {}) {
  const rows = [];
  if (url) rows.push([Markup.button.url('🌐 Buka panel', url)]);
  if (control) rows.push([Markup.button.callback('🔄 Restart', 'fly:restart'), Markup.button.callback('⏹️ Stop', 'fly:stopask')]);
  if (others) rows.push([Markup.button.callback('🧹 Hentikan mesin lain', 'fly:stopothers')]);
  rows.push([Markup.button.callback('🔃 Segarkan', 'fly:refresh'), Markup.button.callback('🩺 Cek kesiapan', 'fly:check')]);
  rows.push([Markup.button.callback('📋 Cara bikin panel', 'fly:guide')]);
  rows.push([Markup.button.callback('‹ Menu', 'menu:list')]);
  return Markup.inlineKeyboard(rows);
}

async function flyView() {
  if (!FLY_APP) {
    return {
      text: '☁️ <b>Fly.io</b>\n\nBot ini <b>belum berjalan di Fly.io</b> (tidak ada FLY_APP_NAME).\nKetuk <b>📋 Cara bikin panel</b> untuk panduan memasangnya.',
      kb: flyKb(),
    };
  }
  let text = `☁️ <b>Fly.io</b>\n\n• App: <code>${esc(FLY_APP)}</code>${FLY_REGION ? ` (${esc(FLY_REGION)})` : ''}\n• Alamat panel: ${esc(flyUrl())}\n• Uptime bot: ${uptime()}\n`;
  if (!FLY_TOKEN) {
    text += '\n⚠️ <b>Kontrol mesin belum aktif.</b> Pasang token (opsional) di terminalmu:\n<pre>fly secrets set FLY_API_TOKEN="$(fly tokens create deploy -a ' + esc(FLY_APP) + ')"</pre>';
    return { text, kb: flyKb({ url: flyUrl() }) };
  }
  try {
    const machines = await flyApi('GET', '/machines');
    const list = Array.isArray(machines) ? machines : [];
    text += `\n<b>Mesin (${list.length})</b>\n`;
    for (const m of list) {
      const g = (m.config && m.config.guest) || {};
      const spec = g.memory_mb ? ` · ${g.cpu_kind || 'cpu'} ${g.cpus || 1}x · ${g.memory_mb} MB` : '';
      text += `${FLY_EMOJI[m.state] || '⚪'} <code>${esc(String(m.id).slice(0, 10))}</code> ${esc(m.state)} · ${esc(m.region || '-')}${spec}${m.id === FLY_MACHINE ? ' ← bot ini' : ''}\n`;
    }
    const others = list.some((m) => m.id !== FLY_MACHINE && m.state === 'started');
    if (list.length > 1) text += '\n⚠️ Ada lebih dari 1 mesin. Bot memakai long-polling, jadi mesin ganda menyebabkan error 409 Conflict. Ketuk <b>🧹 Hentikan mesin lain</b>.';
    return { text, kb: flyKb({ control: !!FLY_MACHINE, others, url: flyUrl() }) };
  } catch (e) {
    console.error('Fly API gagal:', e.message);
    text += `\n❌ ${esc(e.message)}\nPeriksa FLY_API_TOKEN (harus token untuk app ini).`;
    return { text, kb: flyKb({ url: flyUrl() }) };
  }
}

const FLY_GUIDE =
  '📋 <b>Cara bikin panel di Fly.io</b>\n<i>Dijalankan di terminal, bukan di chat ini.</i>\n' +
  '📱 <b>Tanpa laptop:</b> buka github.com/codespaces di browser HP (aktifkan Situs Desktop), buat Codespace, lalu jalankan perintah di bawah di terminal-nya. Alternatif tanpa terminal: GitHub Actions (lihat FLY-DEPLOY.md, Jalur B).\n\n' +
  '<b>1.</b> Pasang dan login\n<pre>curl -L https://fly.io/install.sh | sh\nfly auth login</pre>' +
  '<b>2.</b> Siapkan app (belum deploy)\n<pre>fly launch --no-deploy --ha=false</pre>' +
  '<b>3.</b> Buat volume data\n<pre>fly volumes create bot_data --size 1 --region sin</pre>' +
  '<b>4.</b> Pasang rahasia\n<pre>fly secrets set BOT_TOKEN="..." OWNER_IDS="..."</pre>' +
  '<b>5.</b> Deploy\n<pre>fly deploy --ha=false</pre>' +
  '<b>6.</b> Aktifkan kontrol dari bot (opsional)\n<pre>fly secrets set FLY_API_TOKEN="$(fly tokens create deploy -a NAMA-APP)"</pre>' +
  'Lalu kirim /setpassword KATA-SANDI-KAMU (chat pribadi) untuk membuat password panel, dan /flycek untuk memeriksa kesiapan. Panduan lengkap ada di file FLY-DEPLOY.md.';

async function flyCheck() {
  const L = [];
  const ok = (t) => L.push(`✅ ${t}`);
  const no = (t) => L.push(`❌ ${t}`);
  const warn = (t) => L.push(`⚠️ ${t}`);
  FLY_APP ? ok(`Berjalan di Fly.io (app ${esc(FLY_APP)}${FLY_REGION ? ', region ' + esc(FLY_REGION) : ''})`) : no('Tidak berjalan di Fly.io (FLY_APP_NAME kosong)');
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const t = path.join(DATA_DIR, '.cek-fly');
    fs.writeFileSync(t, '1');
    fs.unlinkSync(t);
    if (!FLY_APP) ok(`Folder data bisa ditulis: ${esc(DATA_DIR)}`);
    else if (DATA_DIR === __dirname) warn('DATA_DIR belum diatur: data tersimpan di folder kode dan HILANG setiap deploy ulang');
    else if (fs.statSync(DATA_DIR).dev === fs.statSync('/').dev) warn(`${esc(DATA_DIR)} bukan Volume terpisah: data bisa HILANG saat deploy ulang (buat volume bot_data)`);
    else ok(`Data tersimpan di Volume terpisah: ${esc(DATA_DIR)}`);
  } catch (e) {
    no(`Folder data tidak bisa ditulis: ${esc(e.message)}`);
  }
  FLY_TOKEN ? ok('FLY_API_TOKEN terpasang (kontrol mesin aktif)') : warn('FLY_API_TOKEN belum dipasang (kontrol mesin dari bot nonaktif, opsional)');
  BEHIND_PROXY ? ok('Mode proxy aktif: IP asli dari header Fly, HTTP polos ditolak') : warn('Mode proxy tidak aktif (normal di luar Fly)');
  ok(`Panel web di port ${PANEL_PORT}, CORS: ${PANEL_ORIGINS.length ? esc(PANEL_ORIGINS.join(', ')) : 'hanya same-origin'}`);
  FW.on ? ok(`Firewall aktif (level ${FW.level})`) : warn('Firewall dimatikan');
  if (FLY_APP && FLY_TOKEN) {
    try {
      const n = (await flyApi('GET', '/machines')).length;
      n === 1 ? ok('Tepat 1 mesin (aman untuk long-polling)') : warn(`${n} mesin terdeteksi: bot polling ganda menyebabkan error 409. Jalankan: fly scale count 1`);
    } catch (e) {
      no(`Fly API: ${esc(e.message)}`);
    }
  }
  return `🩺 <b>Cek kesiapan Fly</b>\n\n${L.join('\n')}`;
}

ownerCmd('fly', async (ctx) => {
  const v = await flyView();
  ctx.reply(v.text, { parse_mode: 'HTML', ...v.kb });
});
ownerCmd(['flycek', 'flytes'], async (ctx) => ctx.reply(await flyCheck(), { parse_mode: 'HTML' }));
ownerCmd(['flypanduan', 'flyguide'], (ctx) => ctx.reply(FLY_GUIDE, { parse_mode: 'HTML' }));

bot.action(/^fly:(\w+)$/, async (ctx) => {
  if (!isOwner(ctx.from.id)) return ctx.answerCbQuery('⛔ Khusus owner', { show_alert: true }).catch(() => {});
  const act = ctx.match[1];
  const refresh = async (note) => {
    const v = await flyView();
    return ctx.editMessageText((note ? `${note}\n\n` : '') + v.text, { parse_mode: 'HTML', ...v.kb }).catch(() => {});
  };
  try {
    if (act === 'refresh') {
      await ctx.answerCbQuery('🔃 Menyegarkan...').catch(() => {});
      return refresh();
    }
    if (act === 'guide') {
      await ctx.answerCbQuery().catch(() => {});
      return ctx.reply(FLY_GUIDE, { parse_mode: 'HTML' });
    }
    if (act === 'check') {
      await ctx.answerCbQuery('🩺 Memeriksa...').catch(() => {});
      return ctx.reply(await flyCheck(), { parse_mode: 'HTML' });
    }
    if (!FLY_APP || !FLY_TOKEN || !FLY_MACHINE) return ctx.answerCbQuery('Kontrol belum aktif: butuh FLY_API_TOKEN di Fly.io', { show_alert: true }).catch(() => {});
    if (act === 'stopask') {
      await ctx.answerCbQuery().catch(() => {});
      return ctx.editMessageText('⚠️ <b>Hentikan mesin ini?</b>\nBot akan offline sampai kamu menyalakannya lagi lewat terminal:\n<pre>fly machine start</pre>', {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[Markup.button.callback('✅ Ya, hentikan', 'fly:stop'), Markup.button.callback('❌ Batal', 'fly:refresh')]]),
      }).catch(() => {});
    }
    if (act === 'restart') {
      await ctx.answerCbQuery('🔄 Merestart mesin...').catch(() => {});
      await ctx.editMessageText('🔄 Mesin sedang direstart. Bot kembali online dalam beberapa detik. Kirim /fly lagi untuk melihat status.').catch(() => {});
      return flyApi('POST', `/machines/${encodeURIComponent(FLY_MACHINE)}/restart`);
    }
    if (act === 'stop') {
      await ctx.answerCbQuery('⏹️ Menghentikan...').catch(() => {});
      await ctx.editMessageText('⏹️ Mesin dihentikan. Nyalakan lagi lewat terminal:\n<pre>fly machine start</pre>', { parse_mode: 'HTML' }).catch(() => {});
      return flyApi('POST', `/machines/${encodeURIComponent(FLY_MACHINE)}/stop`);
    }
    if (act === 'stopothers') {
      const list = await flyApi('GET', '/machines');
      const targets = list.filter((m) => m.id !== FLY_MACHINE && m.state === 'started'); // mesin ini tidak pernah ikut dihentikan
      for (const m of targets) await flyApi('POST', `/machines/${encodeURIComponent(m.id)}/stop`);
      await ctx.answerCbQuery(`🧹 ${targets.length} mesin dihentikan`).catch(() => {});
      return refresh(`🧹 ${targets.length} mesin lain dihentikan.`);
    }
    return ctx.answerCbQuery().catch(() => {});
  } catch (e) {
    console.error('Aksi Fly gagal:', e.message);
    await ctx.answerCbQuery('❌ ' + e.message.slice(0, 150), { show_alert: true }).catch(() => {});
  }
});

// ===========================================================================
// 🖧 VPS: pantau dan kendalikan server lain (khusus owner)
// ===========================================================================
// Tiga jenis server:
//  - tcp   : cek apakah sebuah port terbuka (mis. SSH 22)            /tambahvps oracle 1.2.3.4:22
//  - http  : cek apakah situs/API menjawab                           /tambahvps web https://contoh.com
//  - panel : server lain yang menjalankan bot ini -> status lengkap + tombol kontrol   /vpspanel NAMA PASSWORD
// Bot TIDAK login SSH dan TIDAK menjalankan perintah di VPS-mu. Hanya cek koneksi dan memanggil API panel.
const VPS_FILE = 'vps.json';
const VPS_MAX = Number(cfg('VPS_MAX', 10)) || 10;
const VPS_CHECK_MS = Math.max(500, Number(cfg('VPS_CHECK_MS', 120000)) || 120000);
const VPS_ALLOW_PRIVATE = String(cfg('VPS_ALLOW_PRIVATE', '')).toLowerCase() === 'true'; // izinkan alamat lokal/internal (default: ditolak)
let VPS = readJSON(VPS_FILE, []);
if (!Array.isArray(VPS)) VPS = [];
const saveVps = () => writeJSON(VPS_FILE, VPS);
const vpsSessions = new Map();
const vpsFind = (q) => VPS.find((v) => v.id === q || v.name.toLowerCase() === String(q || '').toLowerCase());

// Password panel server lain disimpan terenkripsi (AES-256-GCM), kunci diturunkan dari BOT_TOKEN.
let _vpsKey = null;
const vpsKey = () => (_vpsKey = _vpsKey || crypto.scryptSync(BOT_TOKEN, 'vps-secret-v1', 32));
function vpsEncrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', vpsKey(), iv);
  const data = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return { iv: iv.toString('hex'), tag: c.getAuthTag().toString('hex'), data: data.toString('hex') };
}
function vpsDecrypt(enc) {
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', vpsKey(), Buffer.from(enc.iv, 'hex'));
    d.setAuthTag(Buffer.from(enc.tag, 'hex'));
    return Buffer.concat([d.update(Buffer.from(enc.data, 'hex')), d.final()]).toString('utf8');
  } catch (_) {
    return null;
  }
}

// Penjaga alamat internal (SSRF): tolak IP privat/loopback/link-local, termasuk nama domain yang mengarah ke sana.
function isPrivateIp(ip) {
  if (/^::ffff:/i.test(ip)) ip = ip.replace(/^::ffff:/i, '');
  if (ip.includes(':')) return /^(::1?$|f[cd]|fe[89ab])/i.test(ip) || ip === '::';
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}
async function vpsGuard(host) {
  if (VPS_ALLOW_PRIVATE) return;
  if (/^(localhost|.*\.(local|internal|localhost|lan))$/i.test(host)) throw new Error('alamat internal ditolak');
  const addrs = require('net').isIP(host) ? [{ address: host }] : await require('dns').promises.lookup(host, { all: true });
  if (addrs.some((a) => isPrivateIp(a.address))) throw new Error('alamat internal ditolak');
}

function vpsHttp(urlStr, { method = 'GET', headers = {}, body, insecure = false, timeout = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'https:' ? https : http;
    const data = body ? JSON.stringify(body) : null;
    const r = lib.request(u, { method, timeout, rejectUnauthorized: !insecure, headers: { ...headers, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) } }, (res) => {
      let d = '';
      res.on('data', (c) => {
        d += c;
        if (d.length > 1e6) r.destroy(new Error('respons terlalu besar'));
      });
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
function tcpPing(host, port, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const s = require('net').connect({ host, port });
    s.setTimeout(timeout);
    s.once('connect', () => (s.destroy(), resolve(Date.now() - t0)));
    s.once('timeout', () => (s.destroy(), reject(new Error('timeout'))));
    s.once('error', (e) => reject(new Error(e.code || e.message)));
  });
}

async function vpsPanelLogin(v) {
  const pw = v.enc && vpsDecrypt(v.enc);
  if (!pw) throw new Error('password panel tidak terbaca (BOT_TOKEN berubah?), atur ulang dengan /vpspanel');
  const r = await vpsHttp(new URL('/api/login', v.url).href, { method: 'POST', body: { password: pw }, insecure: v.insecure });
  if (r.status === 429) throw new Error('login diblokir sementara (terlalu banyak gagal)');
  if (r.status === 409) throw new Error('password panel belum diatur di server itu');
  if (r.status !== 200) throw new Error('login panel ditolak (password salah)');
  const session = JSON.parse(r.body).session;
  vpsSessions.set(v.id, { session, exp: Date.now() + 11 * 3600e3 });
  return session;
}
async function vpsPanelCall(v, method, p, body, retry = true) {
  let ses = vpsSessions.get(v.id);
  if (!ses || ses.exp < Date.now()) ses = { session: await vpsPanelLogin(v) };
  const r = await vpsHttp(new URL(p, v.url).href, { method, body, headers: { 'X-Panel-Session': ses.session }, insecure: v.insecure });
  if (r.status === 401 && retry) {
    vpsSessions.delete(v.id);
    return vpsPanelCall(v, method, p, body, false);
  }
  if (r.status < 200 || r.status >= 300) throw new Error(`panel membalas HTTP ${r.status}`);
  return r.body ? JSON.parse(r.body) : {};
}

async function vpsCheck(v) {
  const t0 = Date.now();
  try {
    await vpsGuard(v.host);
    let info = null;
    if (v.kind === 'tcp') await tcpPing(v.host, v.port);
    else if (v.kind === 'http') {
      const r = await vpsHttp(v.url, { insecure: v.insecure });
      if (r.status >= 500) throw new Error(`HTTP ${r.status}`);
    } else info = await vpsPanelCall(v, 'GET', '/api/status');
    return { ok: true, ms: Date.now() - t0, info };
  } catch (e) {
    return { ok: false, err: String(e.message || e).slice(0, 120) };
  }
}
// Memperbarui status; mengembalikan 'down' / 'up' hanya saat terjadi PERUBAHAN (untuk notifikasi).
function vpsApply(v, r) {
  const now = Date.now();
  v.lastCheck = now;
  if (r.ok) {
    const wasDown = v.up === false;
    v.up = true;
    v.fails = 0;
    v.err = '';
    v.lastMs = r.ms;
    if (r.info) v.info = { version: r.info.version, active: r.info.active, uptimeMs: r.info.uptimeMs, ramBytes: r.info.ramBytes, users: r.info.users };
    if (wasDown || !v.since) v.since = now;
    return wasDown ? 'up' : null;
  }
  v.fails = (v.fails || 0) + 1;
  v.err = r.err;
  if (v.up === null || v.up === undefined) {
    v.up = false; // pengecekan pertama langsung jujur, tanpa notifikasi
    v.since = now;
    return null;
  }
  if (v.up !== false && v.fails >= 2) {
    v.up = false;
    v.since = now;
    return 'down';
  }
  return null;
}
let vpsBusy = false;
async function vpsTick() {
  if (vpsBusy || !VPS.length) return;
  vpsBusy = true;
  try {
    const results = await Promise.all(VPS.map(async (v) => [v, await vpsCheck(v)]));
    for (const [v, r] of results) {
      const tr = vpsApply(v, r);
      if (tr === 'down') notifyOwners(`🔴 VPS "${v.name}" tidak merespons (${v.err}).`);
      if (tr === 'up') notifyOwners(`🟢 VPS "${v.name}" pulih (${r.ms} ms).`);
    }
    saveVps();
  } finally {
    vpsBusy = false;
  }
}
setTimeout(vpsTick, 10000).unref();
setInterval(vpsTick, VPS_CHECK_MS).unref();

const vpsIcon = (v) => (v.up === true ? '🟢' : v.up === false ? '🔴' : '⚪');
const vpsJam = (t) => new Date(t).toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour12: false }).replace(/\./g, ':');
function vpsLine(v) {
  const jenis = v.kind === 'tcp' ? `tcp ${esc(v.host)}:${v.port}` : v.kind === 'panel' ? 'panel bot' : 'http';
  let s = `${vpsIcon(v)} <b>${esc(v.name)}</b> · ${jenis}`;
  if (v.up === true) {
    s += ` · ${v.lastMs} ms`;
    if (v.info) s += ` · v${esc(v.info.version)} · ${v.info.active ? 'aktif' : 'standby'} · up ${fmtDur(v.info.uptimeMs)} · RAM ${Math.round(v.info.ramBytes / 1048576)} MB`;
  } else if (v.up === false) s += ` · mati sejak ${vpsJam(v.since)} (${esc(v.err || '')})`;
  else s += ' · belum dicek';
  return s;
}
function vpsListView() {
  const lines = [`🖧 <b>VPS</b> (${VPS.length}/${VPS_MAX})`, '', `🟢 <b>Server ini</b> · bot · v${VERSION} · up ${uptime()} · RAM ${ramMB()} MB`];
  VPS.forEach((v) => lines.push(vpsLine(v)));
  if (!VPS.length) lines.push('', 'Belum ada VPS lain. Tambahkan dengan:\n<code>/tambahvps oracle 1.2.3.4:22</code>');
  const rows = VPS.map((v) => [Markup.button.callback(`${vpsIcon(v)} ${v.name}`, `vps:open:${v.id}`)]);
  rows.push([Markup.button.callback('🔃 Segarkan', 'vps:refresh'), Markup.button.callback('➕ Cara menambah', 'vps:help')]);
  rows.push([Markup.button.callback('‹ Menu', 'menu:list')]);
  return { text: lines.join('\n'), kb: Markup.inlineKeyboard(rows) };
}
function vpsDetailView(v) {
  const rows = [[Markup.button.callback('🔃 Cek sekarang', `vps:chk:${v.id}`)]];
  if (v.kind === 'panel') {
    rows.push([Markup.button.callback('🟢 Aktifkan', `vps:act:${v.id}:on`), Markup.button.callback('🔴 Standby', `vps:act:${v.id}:off`)]);
    rows.push([Markup.button.callback('🔄 Restart bot di sana', `vps:ask:${v.id}:restart`)]);
  }
  rows.push([Markup.button.callback('🗑️ Hapus', `vps:askdel:${v.id}`), Markup.button.callback('‹ Daftar', 'vps:refresh')]);
  return { text: `${vpsLine(v)}\n\n• Ditambahkan: ${new Date(v.added).toLocaleDateString('id-ID')}\n• Pengecekan terakhir: ${v.lastCheck ? vpsJam(v.lastCheck) : '-'}${v.kind !== 'panel' && v.url ? '\n\n<i>Untuk status lengkap dan tombol kontrol, hubungkan panel bot di sana: /vpspanel ' + esc(v.name) + ' PASSWORD</i>' : ''}`, kb: Markup.inlineKeyboard(rows) };
}
const VPS_HELP =
  '🖧 <b>Menambah VPS</b>\n\n' +
  '• <b>Pantau port</b> (mis. SSH):\n<code>/tambahvps oracle 1.2.3.4:22</code>\n' +
  '• <b>Pantau situs/API</b>:\n<code>/tambahvps web https://contoh.com</code>\n' +
  '• <b>Kendalikan bot lain</b> (server itu menjalankan bot ini, lengkap dengan status RAM dan tombol aktif/standby/restart):\n<code>/tambahvps bot2 https://alamat-panel:8080</code>\nlalu <code>/vpspanel bot2 PASSWORD-PANEL-DI-SANA</code>\n\n' +
  'Alamat HTTPS dengan sertifikat mandiri: tambahkan <code>--insecure</code> di akhir perintah.\n' +
  'Bot memberi kabar kalau VPS mati atau pulih. Pengecekan tiap 2 menit.\n\n' +
  '<i>Bot TIDAK login SSH dan TIDAK menjalankan perintah di VPS-mu. Alamat lokal/internal ditolak demi keamanan. Perintah tambah hanya di chat pribadi.</i>';

ownerCmd('maintenance', (ctx) => {
  const [aksi, ...rest] = getArgs(ctx);
  const a = (aksi || '').toLowerCase();
  if (a === 'on') {
    MAINT.on = true;
    const pesan = argText(ctx).replace(/^on\s*/i, '').trim();
    if (pesan) MAINT.msg = pesan.slice(0, 300);
    saveMaint();
    return ctx.reply(`🔧 Mode perawatan AKTIF. Pengguna lain melihat: "${esc(MAINT.msg)}"\nOwner tetap bisa memakai bot. Matikan dengan /maintenance off`);
  }
  if (a === 'off') {
    MAINT.on = false;
    saveMaint();
    return ctx.reply('✅ Mode perawatan dimatikan. Bot kembali normal.');
  }
  ctx.reply(`🔧 Perawatan: ${MAINT.on ? 'AKTIF' : 'mati'}\nPesan: ${esc(MAINT.msg)}\n\nPakai: /maintenance on [pesan] atau /maintenance off`);
});

ownerCmd('vps', (ctx) => {
  const v = vpsListView();
  ctx.reply(v.text, { parse_mode: 'HTML', ...v.kb });
});

ownerCmd(['tambahvps', 'addvps'], async (ctx) => {
  if (ctx.chat.type !== 'private') return ctx.reply('🔒 Perintah ini hanya bisa dipakai di chat pribadi.');
  const parts = argText(ctx).split(/\s+/).filter(Boolean);
  const insecure = parts.includes('--insecure');
  const args = parts.filter((p) => p !== '--insecure');
  if (args.length < 2) return ctx.reply(VPS_HELP, { parse_mode: 'HTML' });
  const name = args[0];
  if (!/^[A-Za-z0-9_-]{1,24}$/.test(name)) return ctx.reply('❌ Nama hanya boleh huruf, angka, strip, dan garis bawah (maksimal 24 karakter).');
  if (vpsFind(name)) return ctx.reply(`❌ Nama "${esc(name)}" sudah dipakai.`);
  if (VPS.length >= VPS_MAX) return ctx.reply(`❌ Batas ${VPS_MAX} VPS tercapai. Hapus dulu dengan /hapusvps.`);
  const v = { id: crypto.randomBytes(3).toString('hex'), name, insecure, enc: null, up: null, fails: 0, added: Date.now() };
  if (/^https?:\/\//i.test(args[1])) {
    let u;
    try {
      u = new URL(args[1]);
    } catch (_) {
      return ctx.reply('❌ Alamat web tidak valid.');
    }
    Object.assign(v, { kind: 'http', url: u.href.replace(/\/$/, ''), host: u.hostname, port: Number(u.port) || (u.protocol === 'https:' ? 443 : 80) });
  } else {
    const m = /^([A-Za-z0-9.-]{1,253}?)(?::(\d{1,5}))?$/.exec(args[1]);
    const port = Number((m && m[2]) || args[2] || 22);
    if (!m || m[1].startsWith('-') || !(port >= 1 && port <= 65535)) return ctx.reply('❌ Alamat tidak valid. Contoh: <code>/tambahvps oracle 1.2.3.4:22</code>', { parse_mode: 'HTML' });
    Object.assign(v, { kind: 'tcp', host: m[1], port });
  }
  try {
    await vpsGuard(v.host);
  } catch (e) {
    return ctx.reply(`❌ ${esc(e.message)}. Hanya alamat publik yang boleh ditambahkan.`);
  }
  const r = await vpsCheck(v);
  vpsApply(v, r);
  VPS.push(v);
  saveVps();
  ctx.reply(`✅ VPS ditambahkan.\n\n${vpsLine(v)}\n\nBot akan memberi kabar kalau status berubah.${v.kind === 'http' ? `\nPunya bot ini di sana? Hubungkan: <code>/vpspanel ${esc(name)} PASSWORD</code>` : ''}`, { parse_mode: 'HTML' });
});

ownerCmd('vpspanel', async (ctx) => {
  const [name, ...pwParts] = argText(ctx).split(/\s+/).filter(Boolean);
  const pw = pwParts.join(' ');
  if (pw) await ctx.deleteMessage().catch(() => {}); // hapus pesan berisi password
  if (ctx.chat.type !== 'private') return ctx.reply('🔒 Perintah ini hanya bisa dipakai di chat pribadi. Password yang tadi kamu tulis sudah terlihat orang lain, ganti password-nya di server itu.');
  if (!name || !pw) return ctx.reply('Pakai: /vpspanel <nama> <password panel di server itu>\nPesan berisi password otomatis dihapus.');
  const v = vpsFind(name);
  if (!v) return ctx.reply('❌ VPS tidak ditemukan. Lihat daftar: /vps');
  if (v.kind === 'tcp' || !v.url) return ctx.reply('❌ VPS ini ditambahkan sebagai port (tcp). Hapus lalu tambah ulang dengan alamat web panelnya, mis. https://alamat:8080');
  const probe = { ...v, url: new URL(v.url).origin, enc: vpsEncrypt(pw) };
  try {
    await vpsGuard(probe.host);
    await vpsPanelLogin(probe);
  } catch (e) {
    return ctx.reply(`❌ Gagal terhubung ke panel: ${esc(e.message)}\nPassword tidak disimpan. Pesan tadi sudah saya hapus.`);
  }
  Object.assign(v, { kind: 'panel', url: probe.url, enc: probe.enc });
  vpsApply(v, await vpsCheck(v));
  saveVps();
  ctx.reply(`✅ Panel terhubung. Password disimpan terenkripsi.\n\n${vpsLine(v)}\n\nBuka /vps lalu ketuk namanya untuk tombol kontrol.`, { parse_mode: 'HTML' });
});

ownerCmd(['hapusvps', 'delvps'], (ctx) => {
  const v = vpsFind(argText(ctx));
  if (!v) return ctx.reply('Pakai: /hapusvps <nama>\nLihat daftar: /vps');
  VPS = VPS.filter((x) => x !== v);
  vpsSessions.delete(v.id);
  saveVps();
  ctx.reply(`🗑️ VPS "${esc(v.name)}" dihapus (beserta password panel yang tersimpan).`);
});

bot.action(/^vps:(\w+)(?::([\w-]+))?(?::(\w+))?$/, async (ctx) => {
  if (!isOwner(ctx.from.id)) return ctx.answerCbQuery('⛔ Khusus owner', { show_alert: true }).catch(() => {});
  const [, act, id, sub] = ctx.match;
  const edit = (view) => ctx.editMessageText(view.text, { parse_mode: 'HTML', ...view.kb }).catch(() => {});
  const v = id ? vpsFind(id) : null;
  try {
    if (act === 'refresh') {
      await ctx.answerCbQuery('🔃 Memeriksa...').catch(() => {});
      await vpsTick();
      return edit(vpsListView());
    }
    if (act === 'help') {
      await ctx.answerCbQuery().catch(() => {});
      return ctx.reply(VPS_HELP, { parse_mode: 'HTML' });
    }
    if (!v) return ctx.answerCbQuery('VPS tidak ditemukan (mungkin sudah dihapus)', { show_alert: true }).catch(() => {});
    if (act === 'open') {
      await ctx.answerCbQuery().catch(() => {});
      return edit(vpsDetailView(v));
    }
    if (act === 'chk') {
      await ctx.answerCbQuery('🔃 Memeriksa...').catch(() => {});
      vpsApply(v, await vpsCheck(v));
      saveVps();
      return edit(vpsDetailView(v));
    }
    if (act === 'askdel') {
      await ctx.answerCbQuery().catch(() => {});
      return edit({ text: `⚠️ Hapus VPS <b>${esc(v.name)}</b>? Password panel yang tersimpan ikut terhapus.`, kb: Markup.inlineKeyboard([[Markup.button.callback('✅ Ya, hapus', `vps:del:${v.id}`), Markup.button.callback('❌ Batal', `vps:open:${v.id}`)]]) });
    }
    if (act === 'del') {
      VPS = VPS.filter((x) => x !== v);
      vpsSessions.delete(v.id);
      saveVps();
      await ctx.answerCbQuery('🗑️ Dihapus').catch(() => {});
      return edit(vpsListView());
    }
    if (v.kind !== 'panel') return ctx.answerCbQuery('Kontrol hanya untuk VPS yang panelnya terhubung (/vpspanel)', { show_alert: true }).catch(() => {});
    if (act === 'ask' && sub === 'restart') {
      await ctx.answerCbQuery().catch(() => {});
      return edit({ text: `⚠️ Restart bot di <b>${esc(v.name)}</b>?\nBot di sana offline beberapa detik (menyala lagi otomatis jika dijalankan lewat panel/Fly).`, kb: Markup.inlineKeyboard([[Markup.button.callback('✅ Ya, restart', `vps:act:${v.id}:restart`), Markup.button.callback('❌ Batal', `vps:open:${v.id}`)]]) });
    }
    if (act === 'act' && ['on', 'off', 'restart'].includes(sub)) {
      await vpsPanelCall(v, 'POST', '/api/action', { action: sub });
      await ctx.answerCbQuery(sub === 'restart' ? '🔄 Perintah restart dikirim' : '✅ Terkirim').catch(() => {});
      if (sub === 'restart') return edit({ text: `🔄 Restart dikirim ke <b>${esc(v.name)}</b>. Cek lagi beberapa detik lagi lewat /vps.`, kb: Markup.inlineKeyboard([[Markup.button.callback('‹ Daftar', 'vps:refresh')]]) });
      await sleep(600);
      vpsApply(v, await vpsCheck(v));
      saveVps();
      return edit(vpsDetailView(v));
    }
    return ctx.answerCbQuery().catch(() => {});
  } catch (e) {
    console.error('Aksi VPS gagal:', e.message);
    ctx.answerCbQuery('❌ ' + String(e.message).slice(0, 150), { show_alert: true }).catch(() => {});
  }
});

ownerCmd(['panel', 'webpanel'], (ctx) => {
  if (ctx.chat.type !== 'private') return ctx.reply('🔒 Perintah ini hanya bisa dipakai di chat pribadi.');
  const proto = PANEL_HTTPS ? 'https' : 'http';
  const alamat = PANEL_DOMAIN_OK
    ? `https://${PANEL_DOMAIN}`
    : process.env.FLY_APP_NAME ? `https://${process.env.FLY_APP_NAME}.fly.dev` : `${proto}://ALAMAT-SERVERMU:${PANEL_PORT}`;
  if (/^token$/i.test(getArgs(ctx)[0] || '')) {
    return ctx.reply(`🔑 <b>Token API</b> (hanya untuk skrip, dikirim lewat header <code>X-Panel-Token</code>; bukan untuk login di browser)\n<code>${esc(PANEL_TOKEN)}</code>\n\n⚠️ Jangan bagikan. /resetpanel untuk membuat yang baru.`, { parse_mode: 'HTML' });
  }
  if (PANEL_DOMAIN && !PANEL_DOMAIN_OK) ctx.reply(`⚠️ PANEL_DOMAIN "${esc(PANEL_DOMAIN)}" tidak valid. Contoh yang benar: panel.namamu.com`, { parse_mode: 'HTML' });
  const sudah = !!pwRecord();
  ctx.reply(
    `🖥️ <b>Web Panel</b>\n\nAlamat: <code>${esc(alamat)}</code>${PANEL_HTTPS ? ' (sertifikat mandiri)' : ''}\n\n` +
      (sudah
        ? `🔐 Password: <b>sudah diatur</b>${PW_ENV ? ' (dari PANEL_PASSWORD)' : ''}. Buka alamat di browser lalu masukkan password-mu. Browser hanya menyimpan sesi 12 jam, bukan password.\nLupa atau mau ganti? Kirim <code>/setpassword KATA-SANDI-BARU</code>.\n\n`
        : `⚠️ Password <b>belum diatur</b>. Buat dulu dengan mengirim:\n<code>/setpassword kata-sandi-kamu</code>\nMinimal ${PW_MIN} karakter, jangan hanya angka. Pesan itu otomatis saya hapus dari chat.\n\n`) +
      `🛡️ Perlindungan aktif: password disimpan sebagai hash (tidak bisa dibaca balik), IP dikunci 15 menit setelah 5x salah, serangan dari banyak IP diperlambat otomatis, dan kamu dikabari tiap ada login atau aksi dari panel.\n\n` +
      (PANEL_HTTPS
        ? `⚠️ Karena sertifikatnya mandiri (bukan dari domain resmi), browser akan menampilkan peringatan "Tidak aman" sekali di awal. Pilih <b>Advanced/Lanjutan</b> lalu <b>Proceed/Lanjutkan ke situs ini</b>.\n\n`
        : '') +
      `Token untuk skrip/API: <code>/panel token</code>`,
    { parse_mode: 'HTML' }
  );
});

ownerCmd(['setpassword', 'passwordpanel'], async (ctx) => {
  const pw = argText(ctx);
  if (pw) await ctx.deleteMessage().catch(() => {}); // hapus pesan berisi password secepat mungkin
  if (ctx.chat.type !== 'private') return ctx.reply('🔒 Perintah ini hanya bisa dipakai di chat pribadi dengan bot. Password yang tadi kamu tulis di sini sudah terlihat orang lain, jadi buat yang baru di chat pribadi.');
  if (!pw) return ctx.reply(`Pakai: /setpassword <kata sandi>\nAturan: minimal ${PW_MIN} karakter, jangan hanya angka, jangan kata umum (password, 123456, qwerty, admin).\nTips: pakai kalimat panjang yang mudah kamu ingat.`);
  if (PW_ENV) return ctx.reply('🔒 Password sedang diatur lewat PANEL_PASSWORD (env/secret) dan tidak bisa diubah dari bot. Ubah di secret atau env.json, lalu restart.');
  const problem = passwordProblem(pw);
  if (problem) return ctx.reply(`❌ Password ditolak: ${problem}.\nPesan tadi sudah saya hapus; coba kirim lagi dengan password lain.`);
  PW_STORED = await makePwRecord(pw);
  writeJSON(PW_FILE, PW_STORED);
  sessions.clear(); // semua sesi login panel lama dicabut
  ctx.reply('✅ Password panel disimpan (sebagai hash). Semua sesi login lama dicabut.\nPesan berisi password tadi sudah saya hapus dari chat; kalau masih terlihat, hapus manual.\nBuka alamat panel dari /panel dan masuk dengan password ini.');
});

ownerCmd('hapuspassword', (ctx) => {
  if (ctx.chat.type !== 'private') return ctx.reply('🔒 Perintah ini hanya bisa dipakai di chat pribadi.');
  if (PW_ENV) return ctx.reply('🔒 Password diatur lewat PANEL_PASSWORD (env/secret). Hapus di sana, lalu restart.');
  try {
    if (fs.existsSync(file(PW_FILE))) fs.unlinkSync(file(PW_FILE));
  } catch (_) {}
  PW_STORED = null;
  sessions.clear();
  ctx.reply('🗑️ Password panel dihapus. Login web nonaktif sampai kamu mengatur yang baru dengan /setpassword.');
});

ownerCmd('resetpanel', (ctx) => {
  if (ctx.chat.type !== 'private') return ctx.reply('🔒 Perintah ini hanya bisa dipakai di chat pribadi.');
  try {
    if (fs.existsSync(file('panel-secret.json'))) fs.unlinkSync(file('panel-secret.json'));
  } catch (_) {}
  ctx.reply('🔄 Token API (untuk skrip) akan diganti otomatis. Restart bot dengan /restart lalu ketik /panel token untuk melihatnya. Login web memakai password dari /setpassword.');
});

// ===========================================================================
// Start
// ===========================================================================
registerChatMode();
registerSongOnChat();
bot.catch((err) => console.error('Error bot:', err.message));
startPanel();

bot.telegram
  .setMyCommands([
    { command: 'start', description: 'Dashboard & menu' },
    { command: 'menu', description: 'List menu fitur' },
    { command: 'lagu', description: 'Download lagu' },
    { command: 'video', description: 'Download video YouTube' },
    { command: 'tiktok', description: 'Download video TikTok' },
    { command: 'claude', description: 'Tanya Claude' },
    { command: 'gemini', description: 'Tanya Gemini' },
    { command: 'gpt', description: 'Tanya ChatGPT' },
    { command: 'img', description: 'Buat gambar AI' },
    { command: 'tr', description: 'Terjemahkan teks' },
    { command: 'tebak', description: 'Game tebak angka' },
    { command: 'suit', description: 'Batu gunting kertas' },
    { command: 'kuis', description: 'Kuis hitungan' },
    { command: 'calc', description: 'Kalkulator' },
    { command: 'cuaca', description: 'Info cuaca' },
    { command: 'qr', description: 'Buat QR code' },
    { command: 'ping', description: 'Cek ping bot' },
    { command: 'bantuan', description: 'Penjelasan tiap fitur' },
    { command: 'fly', description: 'Kelola panel di Fly.io' },
    { command: 'vps', description: 'Pantau dan tambah VPS' },
    { command: 'aiplus', description: 'Fitur AI+ (23 fitur)' },
    { command: 'tasbih', description: 'Penghitung zikir' },
    { command: 'hijriah', description: 'Tanggal Hijriah' },
    { command: 'kiblat', description: 'Arah kiblat' },
    { command: 'doa', description: 'Doa harian' },
    { command: 'santai', description: 'Tips santai' },
    { command: 'marah', description: 'Tenangkan diri saat kesal' },
    { command: 'ipserver', description: 'IP server & alamat panel (owner)' },
    { command: 'online', description: 'Daftar fitur online (butuh internet)' },
    { command: 'sedekah', description: 'Sedekah lewat QRIS' },
    { command: 'dns', description: 'Cek DNS via 1.1.1.1' },
    { command: 'premium', description: 'Premium (pilih hari sendiri)' },
    { command: 'offline', description: 'Daftar fitur offline (tanpa internet)' },
    { command: 'rekomendasi', description: 'Rekomendasi lagu Indonesia' },
    { command: 'tebaklagu', description: 'Kuis tebak penyanyi' },
    { command: 'xo', description: 'Tic-tac-toe lawan bot' },
    { command: 'fokus', description: 'Timer fokus pomodoro' },
    { command: 'keamanan', description: 'Panel keamanan grup' },
    { command: 'kerja', description: 'Cari koin dengan bekerja' },
    { command: 'mancing', description: 'Mancing ikan' },
    { command: 'toko', description: 'Toko lencana' },
    { command: 'chat', description: 'Mode ngobrol dengan AI' },
    { command: 'rules', description: 'Aturan grup' },
    { command: 'profil', description: 'Level, XP & koinmu' },
    { command: 'daily', description: 'Klaim hadiah harian' },
    { command: 'top', description: 'Peringkat pengguna' },
    { command: 'reset', description: 'Hapus ingatan AI' },
    { command: 'gombal', description: 'Rayuan gombal acak' },
    { command: 'jodoh', description: 'Cek kecocokan jodoh' },
    { command: 'khodam', description: 'Cek khodam kamu' },
    { command: 'ramal', description: 'Ramalan zodiak (AI)' },
    { command: 'fancy', description: 'Ubah teks jadi font keren' },
    { command: 'tts', description: 'Teks jadi suara' },
    { command: 'remind', description: 'Pasang pengingat' },
    { command: 'todo', description: 'Daftar tugas' },
    { command: 'kurs', description: 'Kurs mata uang' },
    { command: 'sholat', description: 'Jadwal sholat' },
    { command: 'ssweb', description: 'Screenshot website' },
  ])
  .catch(() => {});

bot.launch().catch((e) => {
  console.error('Gagal start:', e.message);
  process.exit(1);
});
try {
  const r = JSON.parse(fs.readFileSync(file('restart.json'), 'utf8'));
  fs.unlinkSync(file('restart.json'));
  bot.telegram
    .editMessageText(r.chat, r.msg, undefined, `✅ Bot sudah online kembali (${((Date.now() - r.t) / 1000).toFixed(1)} detik).`)
    .catch(() => {});
} catch (_) {}
const garis = '━'.repeat(44);
const tgl = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', dateStyle: 'medium', timeStyle: 'short' }).replace(/\./g, ':');
console.log(c('cy', garis));
console.log(`  🤖 ${c('b', 'BOT TELEGRAM')}  ${c('d', 'v' + VERSION)}`);
console.log(c('cy', garis));
console.log(`  ${c('gr', '✅')} Bot jalan... (v${VERSION})`);
console.log(`  • Node.js    : ${process.version}`);
console.log(`  • Mode       : ${STATE.active ? 'Aktif' : 'Standby (/on untuk mengaktifkan)'}`);
console.log(`  • Owner      : ${OWNERS.size} · Pengguna: ${USERS.size} · Grup: ${Object.keys(GROUPS).length}`);
console.log(`  • Firewall   : ${FW.on ? 'aktif (' + FW.level + ')' : 'mati'}`);
console.log(`  • Log chat   : aktif${LOG_ALL ? ' (termasuk obrolan grup)' : ' (grup: hanya perintah)'}`);
console.log(`  • Web panel  : port ${PANEL_PORT}${PANEL_HTTPS ? ' (https)' : ' (http)'}`);
console.log(`Banner animasi: ${bannerCount()}/${BANNER_KEYS.length} ditemukan (folder bot: ${__dirname})`);
console.log(`  • Waktu      : ${tgl} WIB`);
bot.telegram
  .getMe()
  .then((me) => {
    console.log(`  • Akun bot   : ${c('gr', '@' + me.username)} ${c('d', '(token valid)')}`);
    console.log(c('cy', garis));
    console.log(c('d', '  Menunggu pesan masuk... (chat pengguna akan tampil di bawah)'));
  })
  .catch((e) => {
    console.log(`  • Akun bot   : ${c('ye', '⚠️ gagal cek token ke Telegram')} (${String(e.message).replace(SECRET_RE, '[TOKEN]').slice(0, 80)})`);
    console.log(c('cy', garis));
  });
const shutdown = (sig) => {
  saveStats();
  try {
    bot.stop(sig);
  } catch (_) {}
  setTimeout(() => process.exit(0), 1500).unref();
};
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
