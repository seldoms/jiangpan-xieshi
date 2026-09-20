/**
 * 批量地址解析（地址粘贴导入）
 *
 * 输入：用户整段粘贴的多行文本，一行一条收货信息
 * 输出：[{ raw, name, phone, address, maleQty, femaleQty, packageCount, error }]
 *
 * 设计要点
 *  1. 归一化先行：全角数字/字母/标点 → 半角，全角空格/制表符 → 普通空格，
 *     电话内部的空格与短横保留（定位号码时按可选分隔符匹配），中文输入法友好。
 *  2. 解析顺序：定位手机号 → 剥离数量段 → 剩余文本按分隔符切片段，
 *     再用「地址特征词 / 2-4 个纯中文」区分地址与姓名。姓名、电话、地址
 *     的顺序任意（6 种排列都能解析），绝不按固定位置硬切。
 *  3. 手机号必须严格匹配 /^1[3-9]\d{9}$/：10 位、12 位、129… 开头、座机号
 *     等一律不落地（phone 留空 + error 提示），避免脏号码被静默收下。
 *  4. 地址里不残留姓名或手机号。
 */

/** 地址特征词：出现任一即视为地址片段 */
const ADDRESS_KEY_RE = /[省市区县镇乡村路街巷号栋幢单元室楼层座道弄组队园苑厦场门牌]/
/** 门牌号后缀：用于区分「电话后面跟着的地址门牌数字」与「号码多打了一位」 */
const ADDRESS_UNIT_RE = /[号栋幢单元室楼层座门牌弄巷]/
/** 姓名：2-4 个纯中文（兼容少数民族姓名的间隔号） */
const NAME_RE = /^[\u4e00-\u9fa5]{2,4}(?:[·•][\u4e00-\u9fa5]{1,10})?$/
/** 合法手机号：1[3-9] 开头共 11 位，允许内部混入单个空格/短横 */
const PHONE_VALID_RE = /(?<!\d)1[3-9](?:[ \t-]?\d){9}(?!\d)/
/** 疑似号码簇：连续数字（允许内部空格/短横），用于识别非法号码 */
const PHONE_CLUSTER_RE = /(?<![\dA-Za-z])\d[\d \t-]*\d/g
/** 行首编号：1. / 2、 / (3) / A1 等 */
const LINE_PREFIX_RE = /^\s*(?:[(]\s*\d+\s*[)]|\d+\s*[、.．)]|[A-Za-z]\d+)\s*/
/** 数量段：4公4母（2份）/ 5公5母 / 3公7母(1份) */
const COMBO_RE = /[-–—]*\s*(\d+)\s*公\s*(\d+)\s*母\s*(?:[(]\s*(\d+)\s*份\s*[)])?/
/** 全公 / 全母（可带「10只」） */
const ALL_MALE_RE = /[-–—]*\s*全\s*公\s*(?:(\d+)\s*只)?/
const ALL_FEMALE_RE = /[-–—]*\s*全\s*母\s*(?:(\d+)\s*只)?/
/** 独立的「N份」「N只」兜底 */
const COPIES_RE = /[-–—]*\s*(\d+)\s*份/
const UNIT_ONLY_RE = /[-–—]*\s*(\d+)\s*只/
/** 片段切分符 */
const SEGMENT_SPLIT_RE = /[\s,、;:：|/，；]+/

const clampNum = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : ''
}

/** 全角 → 半角、全角空格与制表符归一 */
function normalizeText(input) {
  return String(input)
    .replace(/[\uFF10-\uFF19\uFF21-\uFF3A\uFF41-\uFF5A]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[\u3000\u00A0]/g, ' ')
    .replace(/[（]/g, '(')
    .replace(/[）]/g, ')')
    .replace(/[，]/g, ',')
    .replace(/[：]/g, ':')
    .replace(/[；]/g, ';')
    .replace(/[\u2010-\u2015\u2212\uFF0D\uFE63]/g, '-')
    .replace(/\t/g, ' ')
}

/** 找「疑似号码簇」（非法号码用），返回 null 表示没有像号码的东西 */
function findPhoneCluster(text) {
  PHONE_CLUSTER_RE.lastIndex = 0
  let m
  while ((m = PHONE_CLUSTER_RE.exec(text)) !== null) {
    if (!m[0]) break
    const digits = m[0].replace(/\D/g, '')
    if (digits.length >= 7 && digits.length <= 13 && /^[01]/.test(digits)) return m[0]
  }
  return null
}

/** 解析手机号：返回 { phone, rest, error }，rest 是剥掉号码后的剩余文本 */
function extractPhone(text) {
  const direct = PHONE_VALID_RE.exec(text)
  if (!direct) {
    const cluster = findPhoneCluster(text)
    if (cluster) {
      const digits = cluster.replace(/\D/g, '')
      const error = digits.length === 11 ? '手机号格式不正确，请核对' : `手机号应为 11 位（识别到 ${digits.length} 位）`
      return { phone: '', rest: text.replace(cluster, ' '), error }
    }
    return { phone: '', rest: text, error: '未识别到手机号' }
  }

  const matched = direct[0]
  const after = text.slice(direct.index + matched.length)
  const cont = /^([ \t-]*)(\d+)/.exec(after)
  if (cont) {
    const digits = (matched + cont[2]).replace(/\D/g, '')
    const unitAfter = after.slice(cont[0].length, cont[0].length + 1)
    // 只有「总位数 ≥ 12 且后续数字不像门牌号（后面没有号/栋/单元…）」时才判定为多打了一位；
    // 否则就是合法的 11 位号码 + 紧跟的地址门牌号（如 13900001234 18号3栋）
    const looksLonger = cont[1].includes('-') || !ADDRESS_UNIT_RE.test(unitAfter)
    if (digits.length >= 12 && looksLonger) {
      return {
        phone: '',
        rest: text.slice(0, direct.index) + ' ' + after.slice(cont[0].length),
        error: `手机号应为 11 位（识别到 ${digits.length} 位）`,
      }
    }
  }

  return { phone: matched.replace(/\D/g, ''), rest: text.slice(0, direct.index) + ' ' + after, error: '' }
}

/** 解析数量段：就地剥离并回填公/母/份数 */
function extractQuantity(text) {
  let maleQty = ''
  let femaleQty = ''
  let packageCount = 1
  let touched = false

  let work = text
    .replace(COMBO_RE, (m, a, b, c) => {
      maleQty = clampNum(a)
      femaleQty = clampNum(b)
      if (c) packageCount = clampNum(c)
      touched = true
      return ' '
    })
    .replace(ALL_MALE_RE, (m, n) => {
      maleQty = n ? clampNum(n) : ''
      femaleQty = 0
      touched = true
      return ' '
    })
    .replace(ALL_FEMALE_RE, (m, n) => {
      femaleQty = n ? clampNum(n) : ''
      maleQty = 0
      touched = true
      return ' '
    })
    .replace(COPIES_RE, (m, n) => {
      if (packageCount === 1 || String(n) !== '1') packageCount = clampNum(n)
      return ' '
    })
    .replace(UNIT_ONLY_RE, (m, n) => {
      if (maleQty === '') maleQty = clampNum(n)
      return ' '
    })

  return { work, maleQty, femaleQty, packageCount, touched }
}

/** 从剩余文本里切分并归类姓名 / 地址 */
function splitNameAndAddress(text) {
  const segments = text
    .split(SEGMENT_SPLIT_RE)
    .map((s) => s.replace(/^[-–—,、]+|[-–—,、]+$/g, '').trim())
    .filter((s) => s && /[\u4e00-\u9fa5A-Za-z0-9]/.test(s))

  let name = ''
  const addrParts = []
  for (const seg of segments) {
    if (!name && NAME_RE.test(seg) && !ADDRESS_KEY_RE.test(seg)) {
      name = seg
      continue
    }
    addrParts.push(seg)
  }
  return { name, address: addrParts.join('') }
}

function parseLine(rawLine) {
  const raw = rawLine
  let work = normalizeText(rawLine).replace(LINE_PREFIX_RE, '').trim()

  const qty = extractQuantity(work)
  work = qty.work

  const tel = extractPhone(work)
  work = tel.rest

  const { name, address } = splitNameAndAddress(work)

  let error = tel.error
  if (!error && (!name || !address)) error = '姓名或地址不完整'

  return {
    raw,
    name,
    phone: tel.phone,
    address,
    maleQty: qty.maleQty,
    femaleQty: qty.femaleQty,
    packageCount: qty.packageCount,
    error,
  }
}

export function parseBulkAddresses(text) {
  if (text == null) return []
  return String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseLine)
}

export default parseBulkAddresses
