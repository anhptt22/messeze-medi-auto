// tistory-categories.js — 로그인된 세션으로 메세지 3개 티스토리 블로그의 실제 카테고리 id·이름 추출.
// 결과: categories_tistory.json (tistory-poster.js 가 카테고리 선택에 사용, 프롬프트 주입에도 사용)
// 사용: node tistory-login.js 로 1회 로그인 후 → node tistory-categories.js
const fs = require('fs');
const path = require('path');

function requirePlaywright() {
  const tries = [
    'playwright-core',
  ];
  for (const t of tries) { try { return require(t); } catch {} }
  throw new Error('playwright-core 를 찾지 못했습니다');
}
const { chromium } = requirePlaywright();

const CFG = require('./config').load();
const T = CFG.tistory || {};
const SESSION_DIR = T.sessionDir || path.join(__dirname, 'tistory-session');
const USER_DATA_DIR = path.join(SESSION_DIR, 'chrome-profile');
const AUTH_FILE = path.join(SESSION_DIR, 'auth.json');
const ACCOUNTS = (T.blogs || []).map(b => b.account);
const OUT = path.join(__dirname, 'categories_tistory.json');

async function readCats(page, acc) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await page.goto(`https://${acc}.tistory.com/manage/newpost/`, { waitUntil: 'domcontentloaded' });
      if (/\/auth\/login/.test(page.url())) return { err: '미로그인(로그인 페이지로 이동) — 먼저 티스토리 로그인 실행', cats: [] };
      await page.waitForTimeout(1500);
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForSelector('#category-btn', { state: 'visible', timeout: 20000 });
      await page.locator('#category-btn').click({ timeout: 8000 }).catch(() => {});
      await page.waitForSelector('[id^="category-item-"]', { timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(500);
      const cats = await page.evaluate(() => {
        const res = [];
        document.querySelectorAll('[id^="category-item-"]').forEach(el => {
          const id = el.id.replace('category-item-', '');
          const name = (el.textContent || '').replace(/\s+/g, ' ').trim();
          if (id && name) res.push({ id, name });
        });
        return res;
      });
      if (cats.length) return { cats };
    } catch (e) {
      if (attempt === 3) return { err: e.message.slice(0, 80), cats: [] };
    }
    await page.waitForTimeout(1500);
  }
  return { cats: [] };
}

(async () => {
  if (!ACCOUNTS.length) { console.log('writer_config.json 의 tistory.blogs 가 비어 있습니다.'); process.exit(2); }
  const ctx = await chromium.launchPersistentContext(USER_DATA_DIR, { headless: false, channel: 'chrome', viewport: null });
  try { const cookies = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')).cookies || []; await ctx.addCookies(cookies); }
  catch (e) { console.log('auth.json 쿠키 주입 실패:', e.message.slice(0, 60)); }
  const page = ctx.pages()[0] || (await ctx.newPage());
  const out = {};
  let okN = 0;
  for (const acc of ACCOUNTS) {
    const r = await readCats(page, acc);
    out[acc] = r.cats;
    if (r.err) console.log(`[${acc}] 실패: ${r.err}`);
    else { okN++; console.log(`[${acc}] ${r.cats.length}개: ${r.cats.map(c => c.name).join(' / ')}`); }
  }
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');
  console.log('→ categories_tistory.json 저장.');
  await ctx.storageState({ path: AUTH_FILE }).catch(() => {});
  await ctx.close().catch(() => {});
  process.exit(okN ? 0 : 2);
})().catch(e => { console.error(e.message); process.exit(1); });
