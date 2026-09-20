/**
 * 管理端展示与单位换算：金额整数分 ↔ 元字符串，实际重量两 ↔ 整数克（1 两 = 50 克）。
 * 时间统一按 Asia/Shanghai 展示（服务端存 UTC ISO）。
 */

export function formatCents(cents) {
  if (cents === null || cents === undefined) return '—';
  const yuan = cents / 100;
  return `¥ ${Number.isInteger(yuan) ? String(yuan) : yuan.toFixed(2)}`;
}

/** 元输入 → 分。空串返回 null，由表单校验必填；非法返回 undefined。 */
export function yuanToCents(text) {
  const trimmed = String(text ?? '').trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.round(n * 100);
}

export function centsToYuanInput(cents) {
  if (cents === null || cents === undefined) return '';
  const yuan = cents / 100;
  return Number.isInteger(yuan) ? String(yuan) : yuan.toFixed(2);
}

/** 两输入（允许一位小数）→ 整数克；非法返回 undefined。 */
export function liangToGrams(text) {
  const trimmed = String(text ?? '').trim();
  if (trimmed === '') return undefined;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.round(n * 50);
}

export function gramsToLiangInput(grams) {
  if (grams === null || grams === undefined) return '';
  return String(grams / 50);
}

export function formatWeight(grams) {
  if (grams === null || grams === undefined) return null;
  return `${(grams / 1000).toFixed(2)} kg`;
}

export function formatDateTime(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}

/** datetime-local 北京时间输入值 → UTC ISO（服务端按 UTC 存储）。 */
export function localInputToIso(value) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const date = new Date(`${value}:00+08:00`);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}
