import { useState } from 'react'
import './spec-badge.css'

const weights = { '3两': '3', '三两': '3', '3.5两': '3.5', '三两半': '3.5', '4两': '4', '四两': '4', '4.5两': '4.5', '四两半': '4.5', '5两': '5', '五两': '5' }
const base = '/assets/jiangdu-v1/spec-icons/'
export const specAssetVersion = '20260920-generated-v2'

function Piece({ name, label, className = '', showFallback }) {
  const [failed, setFailed] = useState(false)
  return failed
    ? showFallback ? <span className="crab-spec-fallback">{label}</span> : null
    : <img className={className} src={`${base}${name}.webp?v=${specAssetVersion}`} alt={label} onError={() => setFailed(true)} />
}

// 规格的纯文字写法：公 3.5 / 母 5.0。后台配置页用这个，不用插画，列表更好扫。
export function specText(gender, weightLabel) {
  const num = String(weightLabel ?? '').replace(/[^0-9.]/g, '')
  const value = num ? Number(num).toFixed(1) : String(weightLabel ?? '').trim()
  return `${gender === 'male' ? '公' : '母'} ${value}`
}

// 图示只映射明确规格；规格文字由 HTML 渲染，不再烙在图片里。
// 管理员配置的新规格和图片加载失败均保留准确文字。
// textOnly：跳过插画，直接输出「公 3.5」这样的文字规格。
export default function SpecBadge({ gender, weightLabel, compact = false, textOnly = false, showLabel = true }) {
  const genderLabel = gender === 'male' ? '公蟹' : gender === 'female' ? '母蟹' : ''
  const weight = weights[String(weightLabel ?? '').trim()]
  const illustration = weight && genderLabel ? `${gender}-${weight}-illustration` : null
  const displayLabel = gender ? specText(gender, weightLabel) : String(weightLabel ?? '')
  const plain = <span className={`crab-spec${compact ? ' crab-spec-compact' : ''}${textOnly ? ' crab-spec-text' : ''}`}><span className="crab-spec-fallback">{gender ? specText(gender, weightLabel) : String(weightLabel ?? '')}</span></span>
  if (textOnly) return plain
  return <span className={`crab-spec${compact ? ' crab-spec-compact' : ''}`}>
    {illustration
      ? <Piece key={illustration} name={illustration} label={`${genderLabel}${weightLabel}`} className="crab-spec-illustration" showFallback={!showLabel} />
      : !showLabel && <span className="crab-spec-fallback">{genderLabel}{weightLabel}</span>}
    {showLabel && <span className="crab-spec-label">{displayLabel}</span>}
  </span>
}
