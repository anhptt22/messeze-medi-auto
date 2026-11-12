// tistory-fixcat.js — 이미 발행된 티스토리 글에 '카테고리만' 지정해 다시 저장한다.
//   (카테고리 추출 전에 발행돼 '카테고리 없음'으로 남은 글 보정용 — 본문·이미지는 건드리지 않는다)
// 사용법:
//   node tistory-fixcat.js                       → queue_tistory.json 의 published 글 중 카테고리 미적용분 전부
//   node tistory-fixcat.js medi_tistory20260814_3.html [파일 ...]   → 지정 파일만
// 동작: 발행 URL에서 entryId 확인 → manage/newpost/{entryId} 열기 → 본문 길이 확인(안전장치) →
//       카테고리 선택 → 완료 → 공개 → 발행 → 발행된 페이지 재확인(본문 유지 여부).
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
const USER_DATA_DIR = path.join(T.sessionDir, 'chrome-profile');
const AUTH_FILE = path.join(T.sessionDir, 'auth.json');
const QUEUE_FILE = path.join(__dirname, 'queue_tistory.json');
const CATS = JSON.parse(fs.readFileSync(path.join(__dirname, 'categories_tistory.json'), 'utf8'));

const onlyFiles = process.argv.slice(2).filter(a => a.endsWith('.html')).map(a => path.basename(a));
const norm = (s) => String(s || '').replace(/\(\s*\d+\s*\)\s*$/, '').replace(/[\s·・‧]/g, '').toLowerCase();

function loadQueue() { return JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8')); }

// 발행 페이지에서 entryId 추출 (본문 검증도 겸함)
async function fetchEntryInfo(url) {
  const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(20000) });
  const html = await r.text();
  const m = html.match(/entryId\s*:\s*(\d+)/);
  const i = html.indexOf('tt_article_useless_p_margin');
  const seg = i !== -1 ? html.slice(i, i + 100000) : '';
  const text = seg.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, '').replace(/\s+/g, '');
  return { entryId: m ? m[1] : '', textLen: text.length };
}

async function fixOne(page, item) {
  const cat = (CATS[item.account] || []).find(c => norm(c.name) === norm(item.category))
    || (CATS[item.account] || []).find(c => norm(c.name).includes(norm(item.category)));
  if (!cat || !cat.id || cat.id === '0') throw new Error(`카테고리 매칭 실패: "${item.category}" (카테고리 추출 확인)`);

  const info = await fetchEntryInfo(item.published_url);
  if (!info.entryId) throw new Error('entryId 를 찾지 못함: ' + item.published_url);
  console.log(`  entryId=${info.entryId} · 현재 본문 ${info.textLen}자 · 지정할 카테고리="${cat.name}"(id ${cat.id})`);
  if (info.textLen < 800) throw new Error(`발행 글 본문이 비어 있음(${info.textLen}자) — 카테고리만 손대면 안 되고 본문 재주입 필요(tistory-poster.js --edit=${info.entryId})`);

  await page.goto(`https://${item.account}.tistory.com/manage/newpost/${info.entryId}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(6000);
  await page.getByRole('button', { name: /취소|아니오|닫기/ }).first().click({ timeout: 2000 }).catch(() => {});
  await page.waitForFunction(
    () => window.tinymce && window.tinymce.get('editor-tistory') && window.tinymce.get('editor-tistory').getBody(),
    null, { timeout: 25000 });
  await page.getByRole('button', { name: /취소|아니오|닫기/ }).first().click({ timeout: 2000 }).catch(() => {});

  // ★안전장치: 에디터에 기존 본문이 제대로 로드됐는지 확인 (빈 상태로 저장하면 본문이 날아간다)
  const bodyLen = await page.evaluate(() => window.tinymce.get('editor-tistory').getBody().innerText.trim().length);
  console.log(`  에디터 본문 로드: ${bodyLen}자`);
  if (bodyLen < 500) throw new Error(`에디터에 기존 본문이 로드되지 않음(${bodyLen}자) — 저장 중단(본문 유실 방지)`);

  // 카테고리 선택
  await page.locator('#category-btn').click({ timeout: 8000 });
  await page.locator(`#category-item-${cat.id}`).waitFor({ state: 'visible', timeout: 10000 });
  await page.locator(`#category-item-${cat.id}`).click();
  await page.waitForTimeout(800);
  const btnLabel = (await page.locator('#category-btn').textContent().catch(() => '') || '').replace(/\s+/g, ' ').trim();
  console.log(`  카테고리 버튼 표시: "${btnLabel}"`);

  // 완료 → 공개 → 발행(기존 슬러그·본문 유지)
  await page.locator('button:has-text("완료"), a:has-text("완료")').first().click().catch(() => {});
  await page.waitForTimeout(2500);
  await page.getByText('공개', { exact: true }).first().click().catch(() => {});
  await page.waitForTimeout(800);
  const slugNow = await page.locator('#urlPublish').inputValue().catch(() => '');
  console.log(`  발행 레이어 슬러그: "${slugNow}"`);
  await page.getByRole('button', { name: /발행|저장|수정 완료|수정/ }).last().click().catch(() => {});
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(2000);
    if (!/\/manage\/newpost\//.test(page.url())) break;
  }
  if (/\/manage\/newpost\//.test(page.url())) {
    await page.screenshot({ path: path.join(__dirname, `tistory_fixcat_fail_${item.account}.png`) }).catch(() => {});
    throw new Error('저장 실패 — 에디터를 벗어나지 못함. tistory_fixcat_fail_*.png 확인');
  }

  // 발행 후 재확인: 본문 유지 + URL 유지
  await page.waitForTimeout(4000);
  const after = await fetchEntryInfo(item.published_url);
  console.log(`  저장 후 확인: 본문 ${after.textLen}자 (이전 ${info.textLen}자)`);
  if (after.textLen < 800) throw new Error(`저장 후 본문 유실 감지(${after.textLen}자) — tistory-poster.js publish ${item.file} --edit=${info.entryId} 로 복구 필요`);
  return { entryId: info.entryId, cat: cat.name, before: info.textLen, after: after.textLen };
}

(async () => {
  const q = loadQueue();
  let items = (q.posts || []).filter(p => p.status === 'published' && p.published_url && p.category);
  if (onlyFiles.length) items = items.filter(p => onlyFiles.includes(p.file));
  else items = items.filter(p => !p.category_applied);   // 이미 보정한 글은 건너뜀
  if (!items.length) { console.log('보정할 글이 없습니다.'); process.exit(0); }
  console.log(`카테고리 보정 대상 ${items.length}건: ${items.map(p => p.file).join(', ')}`);

  const ctx = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false, channel: 'chrome', viewport: { width: 1440, height: 900 }, args: ['--start-maximized'],
  });
  try { await ctx.addCookies(JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')).cookies || []); } catch {}
  const page = ctx.pages()[0] || (await ctx.newPage());
  page.on('dialog', async (d) => { console.log('  [DIALOG]', d.type(), d.message().slice(0, 120)); await d.accept().catch(() => {}); });

  let ok = 0, fail = 0;
  for (const it of items) {
    console.log(`\n■ ${it.file} (${it.account}) — ${it.published_url}`);
    try {
      const r = await fixOne(page, it);
      // 큐에 보정 완료 표시
      const q2 = loadQueue();
      const hit = (q2.posts || []).find(p => p.file === it.file);
      if (hit) { hit.category_applied = r.cat; hit.entry_id = r.entryId; fs.writeFileSync(QUEUE_FILE, JSON.stringify(q2, null, 2), 'utf8'); }
      ok++;
      console.log(`OK ${it.account} | 카테고리 "${r.cat}" 적용 완료`);
    } catch (e) { fail++; console.log(`FAIL ${it.file} | ${e.message.slice(0, 140)}`); }
    await page.waitForTimeout(3000);
  }
  await ctx.storageState({ path: AUTH_FILE }).catch(() => {});
  await ctx.close();
  console.log(`\n완료: 성공 ${ok}건 · 실패 ${fail}건`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
