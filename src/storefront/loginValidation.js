const MAX_ORDER_CODE_LENGTH = 64
const ORDER_CODE_PATTERN = /^[\u3400-\u4dbf\u4e00-\u9fffA-Za-z0-9]+$/u

// 下单码规范化：先剔除所有空白（半角空格 U+0020、全角空格 U+3000、制表符、换行等
// Unicode 空白，含仅属于 White_Space 的 NEL U+0085），再把全角数字/字母折成半角，
// 最后转小写。中文输入法产生的空格因此不会进入校验。
// 该实现必须与 server/src/orderCode.js 中的同名函数保持完全一致。
const WHITESPACE_PATTERN = /[\s\p{White_Space}]+/gu
const FULLWIDTH_DIGIT_PATTERN = /[\uff10-\uff19]/gu
const FULLWIDTH_LETTER_PATTERN = /[\uff21-\uff3a\uff41-\uff5a]/gu

const toHalfWidthDigit = (char) => String.fromCharCode(char.charCodeAt(0) - 0xff10 + 0x30)
const toHalfWidthLetter = (char) => String.fromCharCode(char.charCodeAt(0) - 0xff21 + 0x41)

export function normalizeOrderCode(value) {
  if (typeof value !== 'string') return ''
  return value
    .replace(WHITESPACE_PATTERN, '')
    .replace(FULLWIDTH_DIGIT_PATTERN, toHalfWidthDigit)
    .replace(FULLWIDTH_LETTER_PATTERN, toHalfWidthLetter)
    .toLowerCase()
}

export function validateOrderCode(value) {
  // 校验规范化之后的结果：空白被自动剔除，而不是直接报“不能包含空格”。
  const code = normalizeOrderCode(value)
  if (!code) return '请输入下单码。'
  if (Array.from(code).length > MAX_ORDER_CODE_LENGTH) return '下单码最多 64 个字符。'
  if (!ORDER_CODE_PATTERN.test(code)) return '下单码只能使用中文、英文字母和数字，不能包含空格或其他符号。'
  return ''
}
