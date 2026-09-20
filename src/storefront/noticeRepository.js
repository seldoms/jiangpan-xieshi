// 购买须知横幅的展示记录：每个浏览器每天（中国时区）只出现一次，
// 展示后由 Storefront 计时自动消除。集中在这里，页面不散写 localStorage。
const NOTICE_SEEN_KEY = 'jd-notice-seen-date'
const NOTICE_DURATION_MS = 12000

function shanghaiToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date())
}

export function shouldShowNotice() {
  try {
    return localStorage.getItem(NOTICE_SEEN_KEY) !== shanghaiToday()
  } catch {
    return true
  }
}

export function markNoticeSeen() {
  try {
    localStorage.setItem(NOTICE_SEEN_KEY, shanghaiToday())
  } catch {
    // 隐私模式写入失败时退化为每次访问都展示
  }
}

export { NOTICE_DURATION_MS }
