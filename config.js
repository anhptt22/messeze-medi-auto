// config.js — 설정 읽기 (모든 스크립트 공용)
//   writer_config.json        : 저장소에 들어 있는 기본 설정(블로그 목록·프롬프트 위치). 원격 업데이트로 바뀔 수 있다.
//   writer_config.local.json  : 이 PC 에서만 쓰는 덮어쓰기(포트·모델·자동 실행 등). 저장소에 올라가지 않는다.
// 경로는 전부 프로그램 폴더 기준 상대경로 → 어느 PC·어느 폴더에 설치해도 그대로 동작한다.
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const BASE_FILE = path.join(ROOT, 'writer_config.json');
const LOCAL_FILE = path.join(ROOT, 'writer_config.local.json');

function readJson(f, fallback) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')); }
  catch (e) { if (fallback !== undefined) return fallback; throw new Error(`${path.basename(f)} 을(를) 읽지 못했습니다: ${e.message}`); }
}
const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
// 객체는 깊게 합치고, 배열·값은 local 쪽으로 통째로 바꾼다
function merge(a, b) {
  const out = { ...a };
  for (const k of Object.keys(b || {})) out[k] = isObj(a[k]) && isObj(b[k]) ? merge(a[k], b[k]) : b[k];
  return out;
}
const abs = (p) => (p ? path.resolve(ROOT, p) : p);

function load() {
  const cfg = merge(readJson(BASE_FILE), fs.existsSync(LOCAL_FILE) ? readJson(LOCAL_FILE, {}) : {});
  cfg.baseDir = ROOT;
  cfg.promptsDir = abs(cfg.promptsDir || 'prompts');
  cfg.outputDir = abs(cfg.outputDir || 'output/블로거');
  cfg.enginePrompt = abs(cfg.enginePrompt);
  cfg.blogs = cfg.blogs || [];
  cfg.tistory = cfg.tistory || {};
  cfg.tistory.blogs = cfg.tistory.blogs || [];
  if (cfg.tistory.enginePrompt) cfg.tistory.enginePrompt = abs(cfg.tistory.enginePrompt);
  cfg.tistory.outputDir = abs(cfg.tistory.outputDir || 'output/티스토리');
  cfg.tistory.sessionDir = abs(cfg.tistory.sessionDir || 'tistory-session');
  cfg.medi = cfg.medi || {};
  if (cfg.medi.enginePrompt) cfg.medi.enginePrompt = abs(cfg.medi.enginePrompt);
  cfg.medi.outputDir = abs(cfg.medi.outputDir || 'output/메디칼럼');
  cfg.medi.sessionDir = abs(cfg.medi.sessionDir || 'medi-session');
  return cfg;
}

module.exports = { load, ROOT, BASE_FILE, LOCAL_FILE };
