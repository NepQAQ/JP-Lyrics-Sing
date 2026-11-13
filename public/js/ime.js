// 简易「罗马音 → 假名」输入：没有安装日语输入法时，直接打罗马音即可得到假名（边打边转）。
//   kaze → かぜ、sawatta → さわった、nn / n' → ん、- → ー（跟在假名后）
//   大写字母打出片假名（MONSUTA- → モンスター），也可以让输入框固定输出片假名
// 正在使用系统输入法（composition）时不做任何处理，两者互不干扰。
import { romajiToKana } from './kana.js';

/**
 * @param {HTMLInputElement|HTMLTextAreaElement} input
 * @param {{enabled?: () => boolean, katakana?: () => boolean}} opts
 * 注意：要在其它 input 监听器之前调用，这样它们拿到的已经是转换后的值。
 */
export function attachRomajiIME(input, { enabled = () => true, katakana = () => false } = {}) {
  let composing = false;
  input.addEventListener('compositionstart', () => { composing = true; });
  input.addEventListener('compositionend', () => { composing = false; });
  input.addEventListener('input', (e) => {
    if (composing || e.isComposing || !enabled()) return;
    const v = input.value;
    if (!/[A-Za-z]|[\u3041-\u30ff]-/.test(v)) return;
    const pos = input.selectionStart ?? v.length;
    const head = v.slice(0, pos);
    const conv = romajiToKana(head, { katakana: katakana(), final: false, caseKatakana: true });
    if (conv === head) return;
    input.value = conv + v.slice(pos);
    input.setSelectionRange(conv.length, conv.length);
  });
  input.addEventListener('blur', () => {
    if (!enabled() || !/[A-Za-z]/.test(input.value)) return;
    // 失焦时把末尾的单个 n 收尾成 ん
    const conv = romajiToKana(input.value, { katakana: katakana(), final: true, caseKatakana: true });
    if (conv !== input.value) {
      input.value = conv;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
}
