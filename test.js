// Tes kesehatan bot. Jalankan: node test.js   (atau: npm test)
// Di panel hosting: ubah "Main file" jadi test.js, tekan Start, baca hasilnya, lalu kembalikan ke file bot.
// Atau, saat bot sudah jalan: ketik /tes di chat pribadi bot (khusus owner).
const fs = require('fs');
const path = require('path');
const net = require('net');
const { execFileSync } = require('child_process');

const COLOR = process.env.NO_COLOR ? {} : { r: '\x1b[0m', b: '\x1b[1m', d: '\x1b[2m', gr: '\x1b[32m', ye: '\x1b[33m', rd: '\x1b[31m', cy: '\x1b[36m' };
const c = (k, t) => `${COLOR[k] || ''}${t}${COLOR.r || ''}`;
const dir = __dirname;
let ok = 0;
let warn = 0;
let fail = 0;

const pass = (msg) => (ok++, console.log(`  ${c('gr', '✅')} ${msg}`));
const warning = (msg) => (warn++, console.log(`  ${c('ye', '⚠️')}  ${msg}`));
const bad = (msg, hint) => (fail++, console.log(`  ${c('rd', '❌')} ${msg}`), hint && console.log(`     ${c('d', '→ ' + hint)}`));
const section = (t) => console.log(`\n${c('b', t)}`);
const withTimeout = (ms) => ({ signal: AbortSignal.timeout(ms) });

async function main() {
  console.log(c('cy', '━'.repeat(44)));
  console.log(`  🧪 ${c('b', 'TES KESEHATAN BOT')}`);
  console.log(c('cy', '━'.repeat(44)));

  // 1. Node.js
  section('1. Lingkungan');
  const major = Number(process.versions.node.split('.')[0]);
  major >= 18 ? pass(`Node.js ${process.version} (minimal v18)`) : bad(`Node.js ${process.version} terlalu lama`, 'Pilih Node 18 atau lebih baru di pengaturan panel');

  // 2. File bot
  section('2. File bot');
  const entry = ['index.js', 'index1.js'].find((f) => fs.existsSync(path.join(dir, f)));
  if (!entry) bad('Tidak menemukan index.js / index1.js', 'Upload file bot ke folder yang sama dengan test.js');
  else {
    pass(`File bot: ${entry}`);
    try {
      execFileSync(process.execPath, ['--check', path.join(dir, entry)], { stdio: 'pipe' });
      pass(`Sintaks ${entry} valid`);
    } catch (e) {
      bad(`Sintaks ${entry} error`, String(e.stderr || e.message).split('\n').slice(0, 3).join(' | '));
    }
    const m = /const VERSION = '([^']+)'/.exec(fs.readFileSync(path.join(dir, entry), 'utf8'));
    if (m) pass(`Versi bot: v${m[1]}`);
  }
  fs.existsSync(path.join(dir, 'panel.html')) ? pass('panel.html ada') : warning('panel.html tidak ada (web panel tidak akan tampil)');

  // 3. package.json & dependensi
  section('3. Paket & dependensi');
  let pkg = null;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    pass('package.json valid');
  } catch (e) {
    bad('package.json tidak ada / rusak', e.message);
  }
  if (pkg) {
    const start = (pkg.scripts && pkg.scripts.start) || '';
    const target = (/node\s+(\S+)/.exec(start) || [])[1];
    if (target && !fs.existsSync(path.join(dir, target))) bad(`Skrip start menunjuk ke "${target}" tapi file itu tidak ada`, 'Samakan nama file di package.json dengan file bot kamu');
    else pass(`Skrip start: ${start || '(kosong)'}`);
    const missing = Object.keys(pkg.dependencies || {}).filter((d) => {
      try {
        require.resolve(d, { paths: [dir] });
        return false;
      } catch (_) {
        return true;
      }
    });
    missing.length ? bad(`Library belum terpasang: ${missing.join(', ')}`, 'Jalankan npm install (di panel: Restart, biasanya otomatis)') : pass('Semua library terpasang');
  }

  // 4. env.json
  section('4. Konfigurasi (env.json)');
  let env = null;
  const envPath = path.join(dir, 'env.json');
  if (!fs.existsSync(envPath) && process.env.BOT_TOKEN) {
    env = { OWNER_IDS: String(process.env.OWNER_IDS || '').split(',').map((x) => Number(x.trim())).filter(Boolean) };
    pass('Memakai environment variable (tanpa env.json) — cocok untuk Fly.io/Docker');
  } else if (!fs.existsSync(envPath)) bad('env.json tidak ditemukan', 'Buat env.json berisi BOT_TOKEN dan OWNER_IDS (atau set environment variable BOT_TOKEN dan OWNER_IDS)');
  else {
    try {
      env = JSON.parse(fs.readFileSync(envPath, 'utf8'));
      pass('env.json format JSON valid');
    } catch (e) {
      bad(`env.json salah format: ${e.message}`, 'Biasanya koma kurang/berlebih atau tanda kutip hilang, terutama di OWNER_IDS');
    }
  }
  const token = (env && env.BOT_TOKEN) || process.env.BOT_TOKEN || '';
  if (env) {
    if (!token || /^isi/i.test(token)) bad('BOT_TOKEN belum diisi', 'Ambil dari @BotFather lalu tempel di env.json');
    else if (!/^\d{6,}:[A-Za-z0-9_-]{30,}$/.test(token)) bad('BOT_TOKEN formatnya tidak wajar', 'Contoh benar: 123456789:AAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx (tanpa spasi)');
    else pass('BOT_TOKEN formatnya benar');
    const owners = env.OWNER_IDS;
    if (!Array.isArray(owners) || !owners.length) bad('OWNER_IDS kosong / bukan daftar', 'Isi seperti: "OWNER_IDS": [123456789]');
    else if (owners.some((o) => typeof o !== 'number')) bad('OWNER_IDS harus angka tanpa tanda kutip', 'Contoh: [123456789, 987654321]');
    else pass(`OWNER_IDS: ${owners.length} owner`);
  }

  // 5. Banner
  section('5. Banner animasi');
  const keys = ['dashboard', 'list', 'game', 'eco', 'fun', 'text', 'util', 'music', 'sec', 'fly', 'vps', 'prem', 'panelmenu', 'dl', 'ai', 'aiplus', 'tools', 'group', 'owner'];
  const found = keys.filter((k) => ['banners', '.'].some((d) => fs.existsSync(path.join(dir, d, `${k}.mp4`))));
  found.length === keys.length ? pass(`Banner lengkap ${found.length}/${keys.length}`) : warning(`Banner ${found.length}/${keys.length} (kurang: ${keys.filter((k) => !found.includes(k)).join(', ')}) — menu tetap jalan tanpa gambar`);

  // 6. Folder data bisa ditulis
  section('6. Penyimpanan');
  try {
    const dataDir = process.env.DATA_DIR || (env && env.DATA_DIR) || dir;
    fs.mkdirSync(dataDir, { recursive: true });
    const t = path.join(dataDir, '.tes-tulis');
    fs.writeFileSync(t, 'ok');
    fs.unlinkSync(t);
    pass(`Folder data bisa ditulis: ${dataDir}`);
  } catch (e) {
    bad('Folder data tidak bisa ditulis', e.message + ' (di Fly: pastikan Volume sudah dibuat dan di-mount ke /data)');
  }

  // 7. Port panel web
  section('7. Port web panel');
  const port = Number(process.env.PORT || (env && env.PANEL_PORT) || 8080);
  await new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', (e) => {
      e.code === 'EADDRINUSE' ? warning(`Port ${port} sedang dipakai (normal kalau bot sedang menyala)`) : bad(`Port ${port} bermasalah: ${e.code}`, 'Ganti PANEL_PORT di env.json sesuai port dari panel hosting');
      resolve();
    });
    srv.once('listening', () => {
      pass(`Port ${port} tersedia`);
      srv.close(resolve);
    });
    srv.listen(port, '0.0.0.0');
  });

  // 8. Jaringan
  section('8. Koneksi internet & layanan');
  if (token && /^\d{6,}:/.test(token) && !/^isi/i.test(token)) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${token}/getMe`, withTimeout(10000));
      const j = await r.json();
      if (j.ok) pass(`Token diterima Telegram → @${j.result.username}`);
      else bad(`Telegram menolak token (${j.description || r.status})`, 'Token salah / sudah dicabut. Buat ulang lewat @BotFather → /token');
    } catch (e) {
      bad('Tidak bisa menghubungi Telegram', 'Cek koneksi internet server/panel hosting');
    }
  } else warning('Cek token ke Telegram dilewati (token belum benar)');

  const services = [
    ['Layanan AI (Pollinations)', 'https://text.pollinations.ai/models'],
    ['Pencarian web (DuckDuckGo)', 'https://api.duckduckgo.com/?q=test&format=json'],
    ['Kurs mata uang', 'https://open.er-api.com/v6/latest/USD'],
  ];
  for (const [name, url] of services) {
    try {
      const r = await fetch(url, withTimeout(8000));
      r.ok ? pass(`${name} terjangkau`) : warning(`${name} membalas HTTP ${r.status}`);
    } catch (_) {
      warning(`${name} tidak terjangkau (fitur terkait bisa gagal)`);
    }
  }

  console.log(`\n${c('cy', '━'.repeat(44))}`);
  const hasil = fail ? c('rd', 'ADA MASALAH') : warn ? c('ye', 'SIAP (ada peringatan)') : c('gr', 'SEMUA BAIK');
  console.log(`  Hasil: ${hasil}  —  ${ok} lolos · ${warn} peringatan · ${fail} gagal`);
  console.log(c('cy', '━'.repeat(44)));
  if (fail) console.log(c('d', '  Perbaiki yang bertanda ❌ lalu jalankan tes lagi.'));
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('Tes berhenti karena error tak terduga:', e.message);
  process.exit(1);
});
