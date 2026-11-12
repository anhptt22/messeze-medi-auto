// safe-json.js — 큐·설정 파일을 안전하게 읽고 쓰는 공용 모듈 (2026-08-25)
//
// 왜 필요한가
//  · 메모장·파워셸로 큐 파일을 한 번 저장하면 눈에 안 보이는 BOM 문자가 붙는다.
//    그러면 JSON.parse 가 실패 → 프로그램은 "큐가 비었다"고 판단 → 다음 저장 때
//    쌓아둔 원고가 통째로 사라진다. (2026-08-25 queue.json 에서 실제 발견)
//  · 저장 도중 프로그램이 죽으면 파일이 반쯤 잘린 채 남아 다음 실행이 전부 실패한다.
//
// 대책
//  · 읽기: BOM 제거 후 파싱, 실패하면 자동으로 .bak(직전 정상본)을 읽는다.
//  · 쓰기: .tmp 에 먼저 쓰고 이름만 바꾼다(원자적) + 직전 내용을 .bak 으로 남긴다.
//  · 보호: 원래 N건 있던 목록을 0건으로 덮어쓰려 하면 거부한다.
const fs = require('fs');
const path = require('path');

function readJsonSafe(file, fallback) {
  const parse = (p) => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''));
  try { return parse(file); }
  catch (e) {
    try {
      const bak = file + '.bak';
      if (fs.existsSync(bak)) {
        const v = parse(bak);
        console.error(`[복구] ${path.basename(file)} 읽기 실패(${e.message.slice(0, 60)}) → 백업(.bak)으로 대체했습니다.`);
        return v;
      }
    } catch {}
    if (fallback === undefined) throw e;
    if (e.code === 'ENOENT') return fallback;   // 아직 만들어지지 않은 파일(첫 실행) — 조용히 기본값
    console.error(`[주의] ${path.basename(file)} 읽기 실패 — 기본값 사용: ${e.message.slice(0, 80)}`);
    return fallback;
  }
}

function writeJsonSafe(file, obj, opts = {}) {
  const { guardKey } = opts; // 예: 'posts' — 있던 항목이 0건으로 줄면 거부
  if (guardKey) {
    try {
      const prev = readJsonSafe(file, null);
      const before = prev && Array.isArray(prev[guardKey]) ? prev[guardKey].length : 0;
      const after = obj && Array.isArray(obj[guardKey]) ? obj[guardKey].length : 0;
      if (before > 0 && after === 0) {
        console.error(`[차단] ${path.basename(file)} 를 ${before}건 → 0건으로 덮어쓰려 해서 중단했습니다(데이터 보호).`);
        return false;
      }
    } catch {}
  }
  const tmp = file + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
    try { if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak'); } catch {}
    fs.renameSync(tmp, file);
    return true;
  } catch (e) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
    console.error(`[오류] ${path.basename(file)} 저장 실패: ${e.message.slice(0, 120)}`);
    return false;
  }
}

// ── 대시보드가 예기치 못한 오류로 통째로 꺼지는 것 방지 ──
// 처리 못 한 오류가 나도 로그만 남기고 서버는 계속 살아 있게 한다.
// (2026-08-25: 통합 대시보드가 예고 없이 내려간 사고 대책)
function installCrashGuard(name, logFile) {
  const note = (tag, err) => {
    const msg = `[${new Date().toISOString()}] [${name}] ${tag}: ${(err && err.stack) || err}`;
    console.error(msg);
    try { if (logFile) fs.appendFileSync(logFile, msg + '\n'); } catch {}
  };
  process.on('uncaughtException', (e) => note('처리되지 않은 오류(서버는 계속 실행됩니다)', e));
  process.on('unhandledRejection', (e) => note('처리되지 않은 비동기 오류(서버는 계속 실행됩니다)', e));
}

// ── 포트가 이미 쓰이는 등 서버 시작 실패를 사람이 읽을 수 있게 ──
function installServerErrorHandler(server, port, name) {
  server.on('error', (e) => {
    if (e && e.code === 'EADDRINUSE') {
      console.error(`\n★${name} 를 시작하지 못했습니다 — 포트 ${port} 를 이미 다른 창이 쓰고 있습니다.`);
      console.error(`  이미 켜져 있을 가능성이 큽니다. 브라우저에서 http://localhost:${port} 로 접속해 보세요.`);
      console.error(`  그래도 안 되면 열려 있는 검은 창(node)을 모두 닫고 다시 실행하세요.\n`);
      process.exit(1);
    }
    console.error(`★${name} 서버 오류: ${e && e.message}`);
  });
}

module.exports = { readJsonSafe, writeJsonSafe, installCrashGuard, installServerErrorHandler };
