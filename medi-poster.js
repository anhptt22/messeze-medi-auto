// medi-poster.js — 큐(queue_medi.json)의 메디 칼럼을 medi.messeze.com/admin 글쓰기 화면에 입력·저장한다.
// 사용:  node medi-poster.js list
//        node medi-poster.js publish --slug=<slug> --mode=private   (관리자에 비공개로 저장 — 사이트에는 안 보임)
//        node medi-poster.js publish --slug=<slug> --mode=public    (공개 발행 — 저장 즉시 사이트 노출)
//        (saved_private 상태의 글에 --mode=public → 저장된 글을 열어 상태만 '공개'로 바꾼다)
//        옵션 --dry : 입력만 하고 저장하지 않는다(스크린샷 저장)
// ★로그인 정보는 다루지 않는다 — 세션(chrome-profile)이 없으면 열린 창에서 사용자가 직접 로그인할 때까지 기다린다(최대 10분).
const fs = require('fs');
const path = require('path');
const https = require('https');
const L = require('./medi-lib');

function requirePlaywright() {
  const tries = ['playwright-core'];
  for (const t of tries) { try { return require(t); } catch {} }
  throw new Error('playwright-core 를 찾지 못했습니다');
}

const args = process.argv.slice(2);
const cmd = args[0] || 'list';
const SLUG = (args.find(a => a.startsWith('--slug=')) || '').replace('--slug=', '');
const MODE = (args.find(a => a.startsWith('--mode=')) || '').replace('--mode=', '') === 'public' ? 'public' : 'private';
const DRY = args.includes('--dry');
const log = (m) => console.log(`[${new Date().toTimeString().slice(0, 8)}] ${m}`);

const SESSION_DIR = L.SESSION_DIR();
const USER_DATA_DIR = path.join(SESSION_DIR, 'chrome-profile');
const MAP_FILE = path.join(SESSION_DIR, 'medi-admin-map.json');
const ADMIN_URL = L.SITE + '/admin';
const IMG_DIR = path.join(__dirname, 'posts', '_img');

function readMap() { try { return JSON.parse(fs.readFileSync(MAP_FILE, 'utf8')); } catch { return {}; } }

function download(url, file) {
  return new Promise((resolve) => {
    const get = (u, n) => https.get(u, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if ([301, 302, 307].includes(res.statusCode) && res.headers.location && n < 4) { res.resume(); return get(res.headers.location, n + 1); }
      if (res.statusCode !== 200) { res.resume(); return resolve(false); }
      const ws = fs.createWriteStream(file); res.pipe(ws); ws.on('finish', () => ws.close(() => resolve(fs.statSync(file).size > 5000)));
    }).on('error', () => resolve(false));
    get(url, 0);
  });
}

async function failShot(page, tag) {
  try {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
    const base = path.join(SESSION_DIR, `_fail_${tag}_${Date.now()}`);
    await page.screenshot({ path: base + '.png', fullPage: true }).catch(() => {});
    fs.writeFileSync(base + '.html', await page.content().catch(() => ''), 'utf8');
    log('  (실패 화면 저장: ' + base + '.png / .html)');
  } catch {}
}

async function isAdminIn(page) {
  const t = await page.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');
  const hasPw = await page.locator('input[type=password]').count().catch(() => 0);
  return !hasPw && /페이지 문구/.test(t) && /블로그/.test(t);
}

// 라벨 글자로 입력칸 찾기 — getByLabel 이 안 되면 라벨 바로 뒤의 입력칸
function ctl(page, label, kind) {
  const tag = kind === 'select' ? 'select' : kind === 'file' ? 'input[@type="file"]' : (kind === 'textarea' ? 'textarea' : '*[self::input or self::textarea]');
  return page.locator(`xpath=(//label[starts-with(normalize-space(.), "${label}")]/following::${tag})[1]`);
}

async function openForm(page, map) {
  if (map.newUrl) { await page.goto(map.newUrl, { waitUntil: 'domcontentloaded' }).catch(() => {}); }
  else {
    await page.goto(ADMIN_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  }
  // 로그인 대기
  if (!(await isAdminIn(page)) && !(await ctl(page, '제목').count().catch(() => 0))) {
    log('관리자 로그인이 필요합니다 — 열린 Chrome 창에서 직접 로그인하세요(최대 10분).');
    const dl = Date.now() + 10 * 60 * 1000; let ok = false;
    while (Date.now() < dl) { await page.waitForTimeout(3000).catch(() => {}); if (await isAdminIn(page)) { ok = true; break; } }
    if (!ok) throw new Error('로그인 시간 초과');
    if (map.newUrl) await page.goto(map.newUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
  }
  if (!map.newUrl || !(await ctl(page, '슬러그').count().catch(() => 0))) {
    // 지도 정보가 없거나 틀리면 메뉴로 찾아 들어간다
    await page.getByRole('link', { name: '블로그', exact: true }).first().click({ timeout: 8000 });
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(1200);
    const nb = page.locator('main a, main button, .content a, .content button, a.btn, button.btn').filter({ hasText: /새 글|글쓰기|글 작성|새로|추가|등록|작성|\+/ }).first();
    if (!(await nb.count())) throw new Error('블로그 새 글 버튼을 찾지 못했습니다 — [메디 관리자 로그인]을 다시 눌러 구조를 기록하세요');
    await nb.click({ timeout: 8000 });
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(1800);
  }
  if (!(await ctl(page, '슬러그').count().catch(() => 0))) throw new Error('글쓰기 화면(슬러그 칸)을 찾지 못했습니다');
}

// 표를 예전 방식처럼 <div class="tbl"> 로 감싼다 — 사이트 CSS(.tbl table) 가 적용되어 테두리가 나온다. 이미 감싼 표는 건너뜀.
function wrapTables(html) {
  return String(html).replace(/(<div class="tbl">\s*)?<table\b[\s\S]*?<\/table>(\s*<\/div>)?/gi, (m, pre) =>
    pre ? m : '<div class="tbl">' + m + '</div>');
}

async function setBody(page, html) {
  html = wrapTables(html);
  const ok = await page.evaluate((h) => {
    const el = document.querySelector('.ck-editor__editable');
    const ed = el && el.ckeditorInstance;
    if (!ed) return false;
    ed.setData(h);
    try { if (ed.updateSourceElement) ed.updateSourceElement(); } catch {}
    return true;
  }, html).catch(() => false);
  if (!ok) throw new Error('본문 편집기(CKEditor)에 접근하지 못했습니다');
  const n = await page.evaluate(() => (document.querySelector('.ck-editor__editable') || {}).innerText || '').catch(() => '');
  if (String(n).replace(/\s+/g, '').length < 200) throw new Error('본문이 편집기에 들어가지 않았습니다');
  await keepTableWrap(page);
}

// ★표 테두리 유지 (2026-11-14)
// 사이트는 <div class="tbl"><table> 안의 표에만 테두리·머리줄 색을 입힌다(.tbl table / .tbl th, .tbl td).
// 그런데 관리자 편집기(CKEditor 5)는 저장할 때 표를 <figure class="table"><table> 로 바꿔 내보내서
// 감싸 둔 div.tbl 이 사라지고, 발행된 글의 표가 테두리 없이 나온다.
// → 편집기가 내보내는 HTML 에서 figure.table 을 div.tbl 로 되돌린 값을 저장 값으로 고정한다.
//   (편집기에 지금 들어 있는 내용을 기준으로 하므로, 관리자에서 사람이 고친 글도 그대로 살린다)
// 반환: 표 개수(없으면 0), 편집기를 못 찾으면 -1
async function keepTableWrap(page) {
  return page.evaluate(() => {
    const el = document.querySelector('.ck-editor__editable');
    const ed = el && el.ckeditorInstance;
    if (!ed) return -1;
    const cur = String(ed.getData());
    let n = 0;
    const raw = cur
      .replace(/<figure class="table"[^>]*>(\s*<table\b[\s\S]*?<\/table>\s*)<\/figure>/gi, (m, t) => { n++; return '<div class="tbl">' + t + '</div>'; })
      .replace(/(<div class="tbl">\s*)?(<table\b[\s\S]*?<\/table>)(\s*<\/div>)?/gi, (m, pre, t) => (pre ? m : (n++, '<div class="tbl">' + t + '</div>')));
    if (!n) return 0;
    try { ed.data.get = () => raw; } catch {}
    try { ed.getData = () => raw; } catch {}
    try { if (ed.updateSourceElement) ed.updateSourceElement(); } catch {}
    try { if (ed.sourceElement && 'value' in ed.sourceElement) ed.sourceElement.value = raw; } catch {}
    return (raw.match(/<div class="tbl">/g) || []).length;
  }).catch(() => -1);
}

// 발행 뒤 실제 페이지에서 표가 div.tbl 로 감싸져 있는지 확인(감싸져 있지 않으면 테두리가 안 나온다)
async function tableLiveCheck(slug, bodyHtml) {
  if (!/<table\b/i.test(String(bodyHtml))) return;
  const r = await L.getText(`${L.SITE}/blog/${encodeURIComponent(slug)}?t=${Date.now()}`, 20000);
  if (r.status !== 200) return;
  const tables = (r.text.match(/<table\b/gi) || []).length;
  const wrapped = (r.text.match(/<div class="tbl">\s*<table\b/gi) || []).length;
  if (tables && wrapped >= tables) log(`  표 확인: ${tables}개 모두 테두리 서식(div.tbl) 적용됨`);
  else log(`  ! 표 확인: 발행된 글의 표 ${tables}개 중 ${wrapped}개만 테두리 서식(div.tbl)이 적용됐습니다 — 글을 열어 표가 제대로 보이는지 확인하세요`);
}

async function fillAndSave(page, it, imgFile, mode) {
  const p = it.post;
  await ctl(page, '제목').fill(p.title);
  await ctl(page, '슬러그').fill(p.slug);
  const sel = ctl(page, '분류', 'select');
  const opts = await sel.locator('option').allInnerTexts().catch(() => []);
  const want = opts.map(s => s.trim()).find(s => s.replace(/\s+/g, '') === String(p.cat).replace(/\s+/g, ''));
  if (!want) throw new Error(`관리자 [분류]에 "${p.cat}" 가 없습니다 (있는 분류: ${opts.join(', ')}) — 관리자 [분류] 메뉴에서 먼저 만들어 주세요`);
  await sel.selectOption({ label: want });
  await ctl(page, '요약', 'textarea').fill(p.summary || '');
  if (imgFile) await ctl(page, '대표 이미지', 'file').setInputFiles(imgFile);
  await setBody(page, p.body);
  const stSel = ctl(page, '상태', 'select');
  const stOpts = (await stSel.locator('option').allInnerTexts().catch(() => [])).map(s => s.trim());
  const stWant = stOpts.find(s => s === (mode === 'public' ? '공개' : '비공개'));
  if (!stWant) throw new Error(`상태 선택지를 찾지 못했습니다 (${stOpts.join(', ')})`);
  await stSel.selectOption({ label: stWant });
  await ctl(page, 'SEO 제목').fill(p.seoTitle || p.title);
  await ctl(page, 'SEO 설명', 'textarea').fill(p.seoDesc || p.summary || '');
  if (DRY) { await page.screenshot({ path: path.join(SESSION_DIR, `_dry_${p.slug}.png`), fullPage: true }).catch(() => {}); log('--dry: 입력만 했고 저장하지 않았습니다 · 스크린샷 ' + path.join(SESSION_DIR, `_dry_${p.slug}.png`)); return 'dry'; }
  const before = page.url();
  await page.getByRole('button', { name: '저장' }).first().click({ timeout: 10000 });
  await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2500);
  const bad = await page.locator('.alert-danger, .invalid-feedback:visible, .error:visible').allInnerTexts().catch(() => []);
  if (bad.filter(Boolean).length) throw new Error('저장 오류 메시지: ' + bad.join(' / ').slice(0, 200));
  if (page.url() === before) {
    const stillForm = await ctl(page, '슬러그').count().catch(() => 0);
    if (stillForm) {
      const msg = await page.evaluate(() => { const m = document.querySelector('.alert, .toast, .message'); return m ? m.innerText : ''; }).catch(() => '');
      if (!/저장|완료|성공/.test(msg)) throw new Error('저장 후에도 글쓰기 화면에 머물러 있습니다 ' + (msg ? '(' + msg.slice(0, 80) + ')' : ''));
    }
  }
  return 'saved';
}

async function flipToPublic(page, it, map) {
  const listUrl = map.listUrl || (ADMIN_URL + '/blog');
  await page.goto(listUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
  if (!(await isAdminIn(page))) throw new Error('관리자 로그인 필요 — [메디 관리자 로그인] 후 다시 시도하세요');
  const row = page.locator('tr', { hasText: it.post.title }).first();
  if (!(await row.count())) throw new Error('관리자 글 목록에서 이 글을 찾지 못했습니다: ' + it.post.title);
  const edit = row.locator('a', { hasText: /수정|편집|보기/ }).first();
  if (await edit.count()) await edit.click(); else await row.locator('a').first().click();
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(2000);
  const stSel = ctl(page, '상태', 'select');
  await stSel.selectOption({ label: '공개' });
  // 저장된 글을 다시 열면 편집기가 표를 figure.table 로 바꿔 놓는다 → 저장 전에 div.tbl 로 되돌린다
  { const n = await keepTableWrap(page); if (n > 0) log(`  표 ${n}개: 테두리 서식(div.tbl) 유지`); else if (n < 0) log('  ! 편집기를 찾지 못해 표 서식을 확인하지 못했습니다'); }
  if (DRY) { log('--dry: 상태를 공개로 바꿔 보기만 하고 저장하지 않았습니다'); return 'dry'; }
  await page.getByRole('button', { name: '저장' }).first().click({ timeout: 10000 });
  await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2500);
  return 'saved';
}

(async () => {
  const q = L.loadQueue();
  if (cmd === 'list') {
    for (const it of q.posts) console.log(`${it.status}\t${it.post && it.post.slug}\t${it.post && it.post.title}`);
    return;
  }
  if (cmd !== 'publish') { log('사용법: list | publish --slug=<slug> --mode=private|public [--dry]'); process.exit(1); }
  const it = q.posts.find(x => x.post && x.post.slug === SLUG);
  if (!it) { log('! 큐에서 글을 찾지 못했습니다: ' + SLUG); process.exit(1); }
  if (it.status === 'published') { log('이미 발행된 글입니다: ' + (it.url || SLUG)); return; }
  const isFlip = it.status === 'saved_private';
  if (isFlip && MODE !== 'public') { log('이미 비공개로 저장된 글입니다. 공개하려면 [공개 전환]을 누르세요.'); return; }
  const V = require('./medi-validate').validate(it.post);
  if (V.errors.length && !isFlip) { log('! 형식 규격 위반이 남아 있습니다 — 발행하지 않습니다:\n  ' + V.errors.join('\n  ')); process.exit(1); }
  if (!isFlip && await L.slugIsLive(SLUG)) { log('! 같은 주소(slug)의 글이 이미 사이트에 있습니다: ' + SLUG); process.exit(1); }

  let imgFile = '';
  if (!isFlip) {
    fs.mkdirSync(IMG_DIR, { recursive: true });
    imgFile = path.join(IMG_DIR, `medi_${SLUG}.jpg`);
    log('커버 사진 내려받기…');
    if (!(await download(String(it.post.photo).replace(/&amp;/g, '&'), imgFile))) { log('! 커버 사진을 내려받지 못했습니다'); process.exit(1); }
  }

  const { chromium } = requirePlaywright();
  fs.mkdirSync(USER_DATA_DIR, { recursive: true });
  const ctx = await chromium.launchPersistentContext(USER_DATA_DIR, { headless: false, channel: 'chrome', viewport: { width: 1400, height: 1000 } });
  const page = ctx.pages()[0] || (await ctx.newPage());
  const map = readMap();
  let res = '';
  const setStatus = (st, extra) => { const qq = L.loadQueue(); const x = qq.posts.find(y => y.post && y.post.slug === SLUG); if (x) { x.status = st; Object.assign(x, extra || {}); L.saveQueue(qq); } };
  try {
    if (isFlip) res = await flipToPublic(page, it, map);
    else { await openForm(page, map); log(`입력 중: ${it.post.title}`); res = await fillAndSave(page, it, imgFile, MODE); }
    if (res === 'dry') { await ctx.close().catch(() => {}); return; }
    if (MODE === 'public') {
      log('저장 완료 — 사이트 반영 확인 중(최대 90초)…');
      let live = false;
      for (let i = 0; i < 18 && !live; i++) { live = await L.slugIsLive(SLUG); if (!live) await page.waitForTimeout(5000).catch(() => {}); }
      if (live) { setStatus('published', { url: `${L.SITE}/blog/${SLUG}`, publishedAt: new Date().toISOString(), errors: undefined }); log(`✓ 발행 완료: ${L.SITE}/blog/${SLUG}`); await tableLiveCheck(SLUG, it.post.body).catch(() => {}); }
      else { setStatus('error', { errors: ['저장은 됐으나 90초 안에 사이트에서 글이 확인되지 않음 — 관리자 [블로그] 목록과 상태를 확인하세요'] }); log('! 저장은 했지만 사이트에서 글이 아직 보이지 않습니다 — 관리자 목록·상태를 확인하세요'); process.exitCode = 1; }
    } else {
      setStatus('saved_private', { savedAt: new Date().toISOString(), errors: undefined });
      log('✓ 관리자에 비공개로 저장했습니다 — 관리자 화면에서 확인한 뒤 [공개 전환]을 누르세요 (사이트에는 아직 안 보입니다)');
    }
  } catch (e) {
    log('✗ 실패: ' + e.message);
    await failShot(page, SLUG);
    setStatus('error', { errors: [e.message] });
    process.exitCode = 1;
  }
  await ctx.close().catch(() => {});
})().catch((e) => { console.error('오류:', e.message); process.exit(1); });
