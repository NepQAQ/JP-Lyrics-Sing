// 罗马音 → 假名转换（上游 jp-lyrics-studio 移植）单元测试
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { romajiToKana, wordRomajiToKana, expandChoon, hasLatin, isKatakanaWord, isLatinWord } from '../public/js/kana.js';

test('romajiToKana 基本平假名转换', () => {
  assert.equal(romajiToKana('kaze'), 'かぜ');
  assert.equal(romajiToKana('sawatta'), 'さわった');
  assert.equal(romajiToKana('konnichiha'), 'こんにちは');
  assert.equal(romajiToKana('nihon'), 'にほん');
  assert.equal(romajiToKana('konnichiwa'), 'こんにちわ'); // wa → わ（は 的还原只在 wordRomajiToKana 里做）
});

test('romajiToKana ん 的双写与撇号', () => {
  assert.equal(romajiToKana('nn'), 'ん');
  assert.equal(romajiToKana("n'"), 'ん');
  assert.equal(romajiToKana('konnnichiwa'), 'こんにちわ'); // nn+辅音n → ん，剩 n+i → に
  assert.equal(romajiToKana('konnichiwa'), 'こんにちわ'); // wa → わ（机械转换）
});

test('romajiToKana 长音符 -（跟在假名后）', () => {
  assert.equal(romajiToKana('su-'), 'すー');
  assert.equal(romajiToKana('a-'), 'あー');
});

test('romajiToKana 大写 → 片假名（caseKatakana，按音节）', () => {
  assert.equal(romajiToKana('MONSUTA-', { caseKatakana: true }), 'モンスター');
  // 大写只影响该音节：K 大写 → カ，ze 小写 → ぜ
  assert.equal(romajiToKana('Kaze', { caseKatakana: true }), 'カぜ');
});

test('romajiToKana katakana 选项固定输出片假名', () => {
  assert.equal(romajiToKana('kaze', { katakana: true }), 'カゼ');
});

test('romajiToKana final 收尾单个 n', () => {
  // 非 final：末尾孤立 n 保留拉丁字母（还在输入中）
  assert.equal(romajiToKana('kaze', { final: false }), 'かぜ');
  assert.match(romajiToKana('kazen', { final: false }), /n$/);
  // final：收尾成 ん
  assert.equal(romajiToKana('kazen', { final: true }), 'かぜん');
});

test('romajiToKana 非拉丁文本原样保留', () => {
  assert.equal(romajiToKana('こんにちは'), 'こんにちは');
  assert.equal(romajiToKana(''), '');
});

test('wordRomajiToKana 按词面回填假名', () => {
  assert.equal(wordRomajiToKana('モンスター', 'monsutaa'), 'モンスター');
  assert.equal(wordRomajiToKana('風', 'kaze'), 'かぜ');
});

test('expandChoon 展开长音符', () => {
  assert.equal(expandChoon('もんすたー'), 'もんすたあ');
  assert.equal(expandChoon('すー'), 'すう');
});

test('hasLatin / isKatakanaWord / isLatinWord 判定', () => {
  assert.equal(hasLatin('kaze'), true);
  assert.equal(hasLatin('かぜ'), false);
  assert.equal(hasLatin(''), false);
  assert.equal(isKatakanaWord('モンスター'), true);
  assert.equal(isKatakanaWord('かぜ'), false);
  assert.equal(isKatakanaWord('漢字'), false);
  assert.equal(isLatinWord('MONSTER'), true);
  assert.equal(isLatinWord('風'), false);
  assert.equal(isLatinWord('123'), false); // 纯数字不算（需含字母）
});
