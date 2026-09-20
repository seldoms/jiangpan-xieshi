import { readOrderCode } from '../storefront/orderCodeRepository';

// 拼团页面的本地凭据：成员编辑凭据 editKey 和团长下单码。
// 这些是规格书允许的本地凭据，只用于请求头，不承载订单、价格等业务数据。

const EDIT_KEYS_PREFIX = 'group.editKeys.';
const ORDER_CODE_KEY = 'group.orderCode';

export function loadEditKeys(token) {
  try {
    const raw = window.localStorage.getItem(EDIT_KEYS_PREFIX + token);
    const map = raw ? JSON.parse(raw) : {};
    return map && typeof map === 'object' ? map : {};
  } catch {
    return {};
  }
}

export function saveEditKey(token, memberId, editKey) {
  const map = loadEditKeys(token);
  map[String(memberId)] = editKey;
  window.localStorage.setItem(EDIT_KEYS_PREFIX + token, JSON.stringify(map));
  return map;
}

export function removeEditKey(token, memberId) {
  const map = loadEditKeys(token);
  delete map[String(memberId)];
  window.localStorage.setItem(EDIT_KEYS_PREFIX + token, JSON.stringify(map));
  return map;
}

export function loadOrderCode() {
  const currentCode = readOrderCode();
  if (currentCode) return currentCode;
  try {
    return window.localStorage.getItem(ORDER_CODE_KEY) || '';
  } catch {
    return '';
  }
}

export function saveOrderCode(orderCode) {
  if (orderCode) {
    window.localStorage.setItem(ORDER_CODE_KEY, orderCode);
  } else {
    window.localStorage.removeItem(ORDER_CODE_KEY);
  }
}
