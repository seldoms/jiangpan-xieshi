import QRCode from 'qrcode'

const layouts = {
  shop: { src: '/assets/jiangdu-v1/posters/shop.webp?v=20260920-tied-crab-v2', heading: '江都大闸蟹', subtitle: '苏北水乡鲜味 · 活蟹产地直发', action: '扫码进入店铺' },
  group: { src: '/assets/jiangdu-v1/posters/group.webp?v=20260920-redrawn-v1', heading: '一起拼一盒', subtitle: '邀好友一起选蟹 · 活蟹产地直发', action: '扫码进入本团' },
}

const textFont = '"PingFang SC", "Microsoft YaHei", sans-serif'

function fitText(context, value, maxWidth) {
  const text = String(value).replace(/\s+/g, ' ').trim()
  if (context.measureText(text).width <= maxWidth) return text
  // 按字素截断，家庭 emoji、肤色和组合字符都不能从中间切开。
  // 老浏览器缺少 Segmenter 时整段省略，保留完整字符。
  const segments = typeof Intl.Segmenter === 'function'
    ? [...new Intl.Segmenter('zh-CN', { granularity: 'grapheme' }).segment(text)].map(item => item.segment)
    : [text]
  while (segments.length) {
    segments.pop()
    const shortened = `${segments.join('')}…`
    if (context.measureText(shortened).width <= maxWidth) return shortened
  }
  return ''
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('海报底图加载失败，请重试'))
    image.src = src
  })
}

// 二维码编码器改为静态引入（原来用 import('qrcode') 懒加载）：
// 懒加载会生成独立 chunk 且 chunk 名在构建时写死进 bundle，部署换 hash 之后，
// 还开着旧页面的用户点分享会去请求已被删掉的旧 chunk → 404
// 「Failed to fetch dynamically imported module」→ 海报永远生成不出来，只有刷新能救。
// qrcode 只有几十 KB，并进主包换掉这个部署期故障，划算。
// 整个过程仍然在浏览器本地完成，不上传任何数据。
export async function renderPoster({ kind, url, title }) {
  const layout = layouts[kind]
  if (!layout) throw new Error('海报类型不支持')
  const image = await loadImage(layout.src)
  const qr = QRCode.create(url, { errorCorrectionLevel: 'M' })
  const canvas = document.createElement('canvas')
  canvas.width = 1024
  canvas.height = 1536
  const context = canvas.getContext('2d')
  if (!context) throw new Error('当前浏览器无法生成海报，请换个浏览器打开')
  context.drawImage(image, 0, 0, canvas.width, canvas.height)
  // 底图只提供中段插画；文字和二维码由代码绘制，避免生成错字或伪码。
  context.fillStyle = '#477C78'
  context.font = `500 30px ${textFont}`
  context.fillText('江畔蟹事', 64, 106)
  context.fillStyle = '#173F3D'
  context.font = `600 76px ${textFont}`
  context.fillText(layout.heading, 64, 212)
  context.fillStyle = '#55716E'
  context.font = `30px ${textFont}`
  context.fillText(layout.subtitle, 68, 282)
  if (kind === 'group' && title) {
    context.fillStyle = '#B64B2D'
    context.font = `500 32px ${textFont}`
    context.fillText(fitText(context, title, 888), 68, 351)
  }

  context.fillStyle = '#477C78'
  context.font = `500 30px ${textFont}`
  context.fillText('江畔蟹事', 64, 1240)
  context.fillStyle = '#173F3D'
  context.font = `600 40px ${textFont}`
  context.fillText(layout.action, 64, 1310)
  context.fillStyle = '#55716E'
  context.font = `28px ${textFont}`
  context.fillText('活蟹直发 · 冷链配送', 64, 1370)

  // size 包含至少四个模块的白色静区，所有模块落在整数像素上。
  const x = 704, y = 1192, size = 256
  context.fillStyle = '#fff'
  context.fillRect(x, y, size, size)
  const QUIET_MODULES = 4
  const scale = Math.floor(size / (qr.modules.size + QUIET_MODULES * 2))
  if (scale < 2) throw new Error('分享地址过长，请在后台配置较短的访问域名')
  const offset = Math.floor((size - qr.modules.size * scale) / 2)
  context.fillStyle = '#143e3f'
  for (let row = 0; row < qr.modules.size; row += 1) {
    for (let col = 0; col < qr.modules.size; col += 1) {
      if (qr.modules.get(row, col)) context.fillRect(x + offset + col * scale, y + offset + row * scale, scale, scale)
    }
  }
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('海报生成失败，请重试')), 'image/png'))
}
