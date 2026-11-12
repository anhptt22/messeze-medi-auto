// medi-login.js — medi.messeze.com/admin 1회 로그인. 성공 확인 후 세션을 auth_medi.json 에 저장하고,
// 글쓰기 화면의 구조(주소·입력칸·분류/상태 선택지)를 medi-admin-map.json 에 기록한다(자동 발행기가 사용).
// ★비밀번호는 열린 Chrome 창에서 사용자가 직접 입력한다(스크립트는 자격증명을 다루지 않는다).
// ★구조 파악은 읽기만 한다 — 글을 저장·발행하거나 설정을 바꾸지 않는다.
const fs = require('fs');
const path = require('path');

function requirePlaywright() {
  const tries = ['playwright-core'];
  for (const t of tries) { try { return require(t); } catch {} }
  throw new Error('playwright-core 를 찾지 못했습니다');
}
const { chromium } = requirePlaywright();
const L = require('./medi-lib');

const SESSION_DIR = L.SESSION_DIR();
const USER_DATA_DIR = path.join(SESSION_DIR, 'chrome-profile');
const AUTH_FILE = path.join(SESSION_DIR, 'auth_medi.json');
const MAP_FILE = path.join(SESSION_DIR, 'medi-admin-map.json');
const ADMIN_URL = L.SITE + '/admin';
const safeUrl = (page) => { try { return page.url(); } catch { return ''; } };

async function isAdminIn(page) {
  const t = await page.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');
  const hasPw = await page.locator('input[type=password]').count().catch(() => 0);
  return !hasPw && /페이지 문구/.test(t) && /블로그/.test(t) && /용어사전/.test(t);
}

// 현재 화면의 입력칸 목록(라벨·name·type·선택지)
async function readForm(page) {
  return page.evaluate(() => {
    const out = [];
    const lab = (el) => {
      if (el.id) { const l = document.querySelector(`label[for="${el.id}"]`); if (l) return l.innerText.trim(); }
      const p = el.closest('label'); if (p) return p.innerText.trim();
      const prev = el.parentElement && el.parentElement.querySelector('label'); return prev ? prev.innerText.trim() : '';
    };
    document.querySelectorAll('input,select,textarea,[contenteditable=true]').forEach(el => {
      const o = { tag: el.tagName.toLowerCase(), type: el.type || '', name: el.name || '', id: el.id || '', label: lab(el).replace(/\s+/g, ' ').slice(0, 40), cls: (el.className || '').toString().slice(0, 60) };
      if (el.tagName === 'SELECT') o.options = [...el.options].map(x => x.text.trim());
      out.push(o);
    });
    const btns = [...document.querySelectorAll('button,a.btn,input[type=submit]')].map(b => (b.innerText || b.value || '').trim()).filter(Boolean).slice(0, 20);
    return { fields: out, buttons: btns, ckeditor: !!document.querySelector('.ck-editor__editable'), title: document.title };
  }).catch(() => ({ fields: [], buttons: [], ckeditor: false, title: '' }));
}

(async () => {
  fs.mkdirSync(USER_DATA_DIR, { recursive: true });
  const ctx = await chromium.launchPersistentContext(USER_DATA_DIR, { headless: false, channel: 'chrome', viewport: null, args: ['--start-maximized'] });
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto(ADMIN_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  console.log('Chrome 창이 열렸습니다. 메디 관리자에 직접 로그인하세요(아이디·비밀번호 직접 입력). 최대 8분 대기.');

  const deadline = Date.now() + 8 * 60 * 1000;
  let ok = false;
  while (Date.now() < deadline) {
    await page.waitForTimeout(3000).catch(() => {});
    if (await isAdminIn(page)) { ok = true; break; }
  }
  if (!ok) { console.log('시간 초과 — 로그인이 감지되지 않았습니다. 다시 시도해주세요.'); await ctx.close().catch(() => {}); process.exit(2); }

  await ctx.storageState({ path: AUTH_FILE });
  console.log('로그인 성공 — 세션 저장: ' + AUTH_FILE);

  // ── 글쓰기 화면 구조 파악(읽기 전용) ──
  const map = { at: new Date().toISOString(), dashboard: safeUrl(page) };
  try {
    await page.getByRole('link', { name: '블로그', exact: true }).first().click({ timeout: 8000 });
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(1500);
    map.listUrl = safeUrl(page);
    fs.writeFileSync(path.join(SESSION_DIR, '_medi_blog_list.html'), await page.content(), 'utf8');
    map.listButtons = (await readForm(page)).buttons;
    // 새 글 버튼/링크
    const cand = page.locator('main a, main button, .content a, .content button, a.btn, button.btn').filter({ hasText: /새 글|글쓰기|글 작성|새로|추가|등록|작성|\+/ }).first();
    if (await cand.count()) {
      await cand.click({ timeout: 8000 });
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await page.waitForTimeout(2500);
      map.newUrl = safeUrl(page);
      Object.assign(map, await readForm(page));
      fs.writeFileSync(path.join(SESSION_DIR, '_medi_blog_form.html'), await page.content(), 'utf8');
      try { await page.screenshot({ path: path.join(SESSION_DIR, '_medi_blog_form.png'), fullPage: true }); } catch {}
      console.log('글쓰기 화면 구조 기록: ' + map.newUrl);
    } else console.log('! 새 글 버튼을 찾지 못했습니다 — 블로그 목록 화면만 기록했습니다.');
  } catch (e) { console.log('! 구조 파악 중 오류(로그인은 성공): ' + e.message); }
  fs.writeFileSync(MAP_FILE, JSON.stringify(map, null, 2), 'utf8');
  console.log('구조 기록 저장: ' + MAP_FILE);
  await ctx.close().catch(() => {});
  process.exit(0);
})().catch((e) => { console.error('오류:', e); process.exit(1); });
