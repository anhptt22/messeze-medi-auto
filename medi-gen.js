// medi-gen.js — 메세지AI 메디(medi.messeze.com) 칼럼 생성기 (queue_medi.json 적재까지, 발행은 medi-poster.js)
// 실행: node medi-gen.js                       → 질문표(구글 시트)에서 1편 생성
//       node medi-gen.js --regen=<slug> --mode=same|new   → 큐의 글 다시 쓰기(같은 질문 / 다른 질문으로 새로)
// 질문은 프로그램이 고른다(분류 순환·중복 회피) → 프롬프트는 지정된 질문으로 쓰기만 한다.
const fs = require('fs');
const path = require('path');
const E = require('./engine');
const SAFE = require('./safe-json');
const L = require('./medi-lib');
const V = require('./medi-validate');

const REGEN = (process.argv.find(a => a.startsWith('--regen=')) || '').replace('--regen=', '');
const REGEN_MODE = (process.argv.find(a => a.startsWith('--mode=')) || '').replace('--mode=', '') === 'same' ? 'same' : 'new';
const log = (m) => console.log(`[${new Date().toTimeString().slice(0, 8)}] ${m}`);
const today = () => E.today();

function usedPhotoIds() {
  const set = new Set();
  try { for (const l of fs.readFileSync(path.join(__dirname, '_img_check', '_used.txt'), 'utf8').split(/\r?\n/)) { const m = l.match(/photos\/(\d+)/); if (m) set.add(m[1]); } } catch {}
  return set;
}
const photoId = (u) => (String(u || '').match(/photos\/(\d+)/) || [])[1] || '';

function guideFor(row, cats) {
  return [
    `- ★이번 글의 질문(지정): **${row.no}** — ${row.q}`,
    `- 질문표 항목: 지역 "${row.region}" · 진료과 "${row.dept}" · 진료항목 "${row.item}" · 고민 유형 "${row.concern}"`,
    `- 제목: 위 질문을 **거의 그대로** 쓴다(지역명·진료과·진료항목을 앞쪽에 둔 채, 어미만 규격에 맞게 다듬는 정도 — 의미·키워드를 바꾸지 말 것). 제목은 글이 정면으로 답하는 질문이어야 한다.`,
    `- 분류(cat 에 그대로): ${row.cat}`,
    `- q_no 에 "${row.no}" 를 넣는다. topics_log 에 "[${row.no}]" 로 기록한다.`,
    `- 사용 가능한 분류: ${cats.join(' / ')}`,
  ].join('\n');
}

(async () => {
  const cfg = E.loadCfg();
  const conf = L.loadConfig();
  let q = L.loadQueue();
  let old = null, restoreOld = () => {};

  // ── 다시 쓰기: 이전 글 백업 후 큐에서 뺀다(실패하면 되돌림) ──
  if (REGEN) {
    const idx = q.posts.findIndex(x => x.post && x.post.slug === REGEN);
    if (idx < 0) { log('! 다시 쓸 글을 큐에서 찾지 못했습니다: ' + REGEN); process.exit(1); }
    old = JSON.parse(JSON.stringify(q.posts[idx]));
    if (old.status === 'published') { log('! 이미 발행된 글은 다시 쓸 수 없습니다'); process.exit(1); }
    const bdir = path.join(__dirname, '_재생성_백업_메디'); fs.mkdirSync(bdir, { recursive: true });
    fs.writeFileSync(path.join(bdir, `${REGEN}.${Date.now()}.json`), JSON.stringify(old, null, 2), 'utf8');
    q.posts.splice(idx, 1); L.saveQueue(q);
    restoreOld = () => {
      try { const qq = L.loadQueue(); if (!qq.posts.find(x => x.post && x.post.slug === REGEN)) { qq.posts.splice(Math.min(idx, qq.posts.length), 0, old); L.saveQueue(qq); log('! 새 글이 만들어지지 않아 이전 글을 되돌렸습니다: ' + old.post.title); } }
      catch (e) { log('! 이전 글 되돌리기 실패 — 백업: _재생성_백업_메디 (' + e.message + ')'); }
    };
    log(`[다시 쓰기] ${old.post.title} · ${REGEN_MODE === 'same' ? '같은 질문' : '다른 질문'}`);
  }

  // ── 질문 정하기 ──
  { const sy = await L.syncQuestions(log); if (!sy.ok) log('  (로컬 질문표 사용)'); }
  const bank = L.loadBank();
  if (!bank.length) { log('! 질문표를 읽지 못했습니다: ' + L.BANK_FILE()); restoreOld(); process.exit(1); }
  let row;
  if (REGEN && REGEN_MODE === 'same' && old.q_no) row = bank.find(r => r.no === old.q_no);
  if (!row) row = L.pickQuestion({ excludeNos: old && old.q_no ? [old.q_no] : [] });
  if (!row) { log(`! 사용 가능한 질문이 없습니다 — 분류 [${conf.availableCats.join(', ')}] 의 질문이 모두 소진됨. 분류를 늘리거나 질문표에 문항을 추가하세요.`); restoreOld(); process.exit(1); }
  log(`질문 선택: ${row.no} [${row.cat}] ${row.q}`);

  // ── 컨텍스트: 기존 글·본 사이트 제목 ──
  const live = await L.liveMediPosts();
  const mainTitles = await L.mainSiteTitles();
  const refs = q.posts.filter(x => x.post && x.post.photo && x.status !== 'rejected').slice(-4).map(x => x.post.photo);
  const ctx = [
    '', '━━━ 이번 실행 컨텍스트 ━━━',
    `- 오늘 날짜: ${today()}`,
    `- 큐 파일: ${L.QUEUE} (posts 배열에 append — 기존 항목 수정 금지)`,
    `- topics_log: ${L.TOPICS}`,
    `- 작업 폴더(사진 임시 저장 등): ${__dirname}`,
    `- 사용 사진 기록 파일: ${path.join(__dirname, '_img_check', '_used.txt')}`,
    `- 질문표: ${L.BANK_FILE()}`,
    guideFor(row, conf.availableCats),
    live.length ? `- 메디에 이미 발행된 글 ${live.length}편 (같은 주제·slug·제목 어미 회피):\n${live.map(x => `  · ${x.slug} — ${x.title}`).join('\n')}` : '- 메디 기존 글 목록을 가져오지 못했다(중복은 큐 파일로만 확인).',
    q.posts.length ? `- 큐에 이미 있는 글(발행 전 포함):\n${q.posts.slice(-12).map(x => `  · ${x.post && x.post.slug} — ${x.post && x.post.title}`).join('\n')}` : '',
    mainTitles.length ? `- 본 사이트(messeze.com) 칼럼 제목 ${mainTitles.length}편 (주제·각도 겹침 회피용 — 문장·사실·요금은 가져오지 말 것):\n${mainTitles.slice(0, 80).map(t => '  · ' + t).join('\n')}` : '',
    refs.length ? `- 최근 글 커버 사진: ${refs.join(' , ')} (같은 소재·구도 반복 금지)` : '',
    (REGEN && REGEN_MODE === 'same') ? `- ★이번 실행은 같은 질문으로 처음부터 다시 쓴다. 이전 원고 문장·예시를 재사용하지 말고 slug 도 "${old.post.slug}" 외 새로 짓는다.` : '',
    '- ★이번 실행은 새 글 1편만 쓴다. 작성 후 큐 적재 + topics_log 기록 + `_img_check\\_used.txt` 기록 + 텍스트 요약.',
  ].filter(Boolean).join('\n');

  const promptBody = fs.readFileSync(L.PROMPT_FILE(), 'utf8');
  const medCfg = { ...cfg, claudeTimeoutSec: (cfg.medi && cfg.medi.claudeTimeoutSec) || (cfg.homepage && cfg.homepage.claudeTimeoutSec) || cfg.claudeTimeoutSec };
  const before = q.posts.length;
  log(`메디 칼럼 생성 시작 — 모델 ${cfg.model}`);
  const t0 = Date.now();
  const out = await E.runClaude(promptBody + ctx, medCfg, log);
  log(`claude 종료 (${Math.round((Date.now() - t0) / 60000)}분) — ` + out.split(/\r?\n/).filter(Boolean).slice(-2).join(' / ').slice(0, 240));

  let q2 = L.loadQueue();
  let it = q2.posts.slice(before).find(x => x.post);
  if (!it) { restoreOld(); log('! 신규 큐 항목이 없습니다 — 로그 확인 필요'); process.exit(1); }
  const save = () => { L.saveQueue(q2); };
  // 수정 단계에서 AI 가 slug 를 바꾸거나 항목을 새로 쓸 수 있으므로 slug 가 아니라 질문 번호로 다시 찾는다(같은 질문의 중복 항목은 마지막 것만 남긴다)
  const reload = () => {
    q2 = L.loadQueue();
    const mine = q2.posts.filter(x => x.q_no === row.no && x.status !== 'rejected' && x.post);
    if (mine.length > 1) { const keep = mine[mine.length - 1]; q2.posts = q2.posts.filter(x => !mine.includes(x) || x === keep); }
    it = q2.posts.find(x => x.q_no === row.no && x.status !== 'rejected' && x.post) || it;
    return it;
  };

  // 프로그램이 정하는 필드 고정
  it.q_no = row.no; it.question = row.q; it.region = row.region; it.dept = row.dept; it.item = row.item; it.concern = row.concern;
  it.status = it.status || 'pending'; it.created = it.created || today();
  it.post.cat = row.cat;
  if (!it.post.date) it.post.date = today();
  it.post.title = E.questionTitle(it.post.title);
  it.post.seoTitle = it.post.title; it.post.seoDesc = it.post.summary || it.post.desc || '';
  if (!it.post.summary && it.post.desc) it.post.summary = it.post.desc;
  save();

  // ── 형식 검증 → 위반이면 한 번 고쳐 쓰게 한다 ──
  let r = V.validate(it.post);
  if (r.errors.length) {
    log(`✗ 형식 위반 ${r.errors.length}건 — 한 번 고쳐 쓰게 합니다:`);
    r.errors.forEach(e => log('   · ' + e));
    const fix = [
      promptBody, ctx, '',
      '━━━ ★수정 지시(형식 위반) ━━━',
      `큐 파일에서 q_no "${row.no}" 인 항목 하나만(새 항목을 추가하지 말고 그 항목을 고쳐서 저장), 아래 위반을 고치도록 post.body(필요하면 title·summary)를 수정해 저장한다. 다른 항목·필드는 건드리지 않는다. [본문 형식 명세]의 블록 순서·개수·길이를 정확히 지킬 것.`,
      ...r.errors.map(e => '- ' + e),
      ...(r.warns.length ? ['(참고 경고)', ...r.warns.map(w => '- ' + w)] : []),
      '수정 후 "수정 완료" 한 줄만 출력.',
    ].join('\n');
    await E.runClaude(fix, medCfg, log);
    reload(); it.q_no = row.no; it.question = row.q; it.region = row.region; it.dept = row.dept; it.item = row.item; it.concern = row.concern; it.post.cat = row.cat;
    it.post.title = E.questionTitle(it.post.title); it.post.seoTitle = it.post.title; it.post.seoDesc = it.post.summary || '';
    save();
    r = V.validate(it.post);
  }
  it.warnings = r.errors.map(e => '✗ ' + e).concat(r.warns.map(w => '! ' + w));
  if (r.errors.length) log(`✗ 수정 후에도 규격 위반 ${r.errors.length}건 — 미리보기에서 확인하고 [다시 쓰기]를 누르세요.`);
  else log(`✓ 형식 검증 통과 (본문 ${r.stats.total}자${r.warns.length ? ', 경고 ' + r.warns.length + '건' : ''})`);
  r.warns.forEach(w => log('   ! ' + w));

  // ── 커버 사진 검수(병원 전용 기준) ──
  try {
    const PICK = require('./image-pick');
    const p = it.post;
    const purpose = `메디(병원 전용 사이트) 칼럼 "${p.title}" 의 커버 — 병원 로비·접수 데스크·복도·진료실 책상·대기 공간·외관 같은 병원 공간 사진. 환자 시술·주사·수술·혈액·의료기기 클로즈업은 탈락(의료광고 오해 방지)`;
    const hint = '병원 로비 접수 데스크 복도 진료실 책상 외관 (환자 시술 장면 제외)';
    if (p.photo && PICK.coverUrl(p.photo) !== p.photo) p.photo = PICK.coverUrl(p.photo);
    // 같은 사진 ID 가 이미 다른 메디 글에 쓰였으면 중복(방금 쓴 글 자신은 제외)
    const dupQueue = p.photo && q2.posts.some(x => x !== it && x.status !== 'rejected' && photoId(x.post && x.post.photo) === photoId(p.photo));
    if (dupQueue) log('  ! 같은 사진이 이미 다른 글에 쓰였습니다');
    const rv = p.photo && !dupQueue ? await PICK.review({ E, cfg, log, url: p.photo, purpose, refs }) : { ok: false };
    if (rv.ok) {
      log(`  커버 사진 확인 통과: ${rv.reason}`);
      if (rv.focus) { const nu = PICK.coverUrl(p.photo, 1290, rv.focus); if (nu !== p.photo) { p.photo = nu; log(`  커버 자르기 위치 적용: fx ${rv.focus.x} · fy ${rv.focus.y}`); } }
    } else {
      log('  커버 사진 기준 미달·중복 → 새로 고릅니다');
      const used = new Set([...q2.posts.map(x => x.post && x.post.photo)].filter(Boolean));
      const pick = await PICK.pickCover({ E, cfg, log, post: { title: p.title, cat: p.cat, desc: p.summary }, used, refs, hint });
      if (pick) { p.photo = pick.url; log(`  새 커버: ${pick.url} — ${pick.reason}`); }
      else log('  ! 기준을 통과한 커버를 찾지 못했습니다 — 대시보드 [이미지 교체]로 다시 시도하세요');
    }
    save();
  } catch (e) { log('  ! 커버 검수 오류: ' + e.message); }

  // ── 기록 ──
  const id = photoId(it.post.photo);
  if (id && !usedPhotoIds().has(id)) { try { fs.appendFileSync(path.join(__dirname, '_img_check', '_used.txt'), `images.pexels.com/photos/${id}\n`); } catch {} }
  try {
    const tl = fs.readFileSync(L.TOPICS, 'utf8');
    if (!tl.includes(`[${row.no}]`)) L.appendTopics(`메디·${today()}|${row.cat}|${it.post.title}|[${row.no}]|${it.score || ''}`);
  } catch { L.appendTopics(`메디·${today()}|${row.cat}|${it.post.title}|[${row.no}]|${it.score || ''}`); }
  const dir = require('./medi-export').exportPost(it);
  if (dir) log(`  파일 저장: ${dir}\\${it.post.slug}.html / .txt`);
  log(`생성 완료: ${it.post.cat} · ${it.post.title} (${it.post.slug})`);
})().catch(e => { try { console.error('오류:', e.message); } catch {} process.exit(1); });
