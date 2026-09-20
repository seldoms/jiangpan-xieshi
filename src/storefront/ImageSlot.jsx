import { useState } from 'react'
import atlas from '../../docs/image-atlas/atlas.json'
import generatedAssets from './generated-assets.json'

export const imageAssets = Object.values(atlas.sheets).flatMap(sheet => sheet.assets)
const assetsById = Object.fromEntries(imageAssets.map(asset => [asset.id, asset]))

export default function ImageSlot({ id, compact = false, className = '', eager = false }) {
  const asset = assetsById[id]
  const [failed, setFailed] = useState(false)
  const generated = generatedAssets[id]
  const src = typeof generated === 'string' ? generated : generated?.src
  if (!asset) return null
  const width = generated?.width || asset.width
  const height = generated?.height || asset.height

  return <span className={`jd-image-slot ${compact ? 'jd-image-compact' : ''} ${src && !failed ? 'has-image' : ''} ${className}`} style={{ '--image-ratio': `${width} / ${height}` }} role="img" aria-label={src && !failed ? asset.name : `${asset.name}图片占位，素材 ${id}`}>
    {src && !failed ? <img src={src} alt="" width={width} height={height} loading={eager ? 'eager' : 'lazy'} onError={() => setFailed(true)} /> : compact ? <span className="jd-slot-compact-id">{id}</span> : <>
      <span className="jd-slot-cross jd-slot-cross-top" aria-hidden="true" />
      <span className="jd-slot-cross jd-slot-cross-bottom" aria-hidden="true" />
      <span className="jd-slot-table" aria-hidden="true"><span className="jd-slot-id">{id}</span><span className="jd-slot-name">{asset.name}<small>图片留白</small></span><span className="jd-slot-size">{asset.width} × {asset.height}<small>px</small></span></span>
    </>}
  </span>
}

const iconPaths = {
  qr: <><path d="M3 3h6v6H3zM15 3h6v6h-6zM3 15h6v6H3zM15 15h3v3h3v3h-6zM21 12v3M12 3v3M12 12h3M3 12h3M12 18v3" /></>,
  'arrow-right': <path d="M4 12h16m-6-6 6 6-6 6" />,
  'arrow-left': <path d="M20 12H4m6-6-6 6 6 6" />,
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  bag: <><path d="M5 7h14l1 14H4L5 7Z" /><path d="M9 8V6a3 3 0 0 1 6 0v2" /></>,
  users: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></>,
  check: <path d="m5 12 4 4L19 6" />,
  pin: <><path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 0 1 14 0Z" /><circle cx="12" cy="10" r="2" /></>,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  box: <><path d="m4 8 8-4 8 4-8 4-8-4ZM4 8v10l8 4 8-4V8M12 12v10" /><path d="m8 6 8 4" /></>,
  leaf: <><path d="M5 19C-1 7 12 4 21 3c-1 10-4 20-16 16ZM5 19 16 8" /></>,
  truck: <><path d="M3 6h11v11H3V6Zm11 5h4l3 4v2h-7" /><circle cx="7" cy="18" r="2" /><circle cx="17" cy="18" r="2" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 6v6l4 2" /></>,
  'chevron-down': <path d="m5 9 7 7 7-7" />,
  edit: <><path d="m4 16 12-12 4 4L8 20H4v-4ZM13 7l4 4" /></>,
  trash: <><path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7h.01" /></>,
  search: <><circle cx="10" cy="10" r="6" /><path d="m15 15 6 6" /></>,
  sliders: <><path d="M4 6h7M15 6h5M4 12h3M11 12h9M4 18h9M17 18h3" /><circle cx="13" cy="6" r="2" /><circle cx="9" cy="12" r="2" /><circle cx="15" cy="18" r="2" /></>,
}

export function AssetIcon({ name, size = 20 }) {
  const asset = imageAssets.find(item => item.key === name)
  const [failed, setFailed] = useState(false)
  const generated = asset && generatedAssets[asset.id]
  const src = typeof generated === 'string' ? generated : generated?.src
  return src && !failed
    ? <span className="jd-asset-icon jd-asset-icon-mask" aria-hidden="true" style={{ width: size, height: size, maskImage: `url("${src}")`, WebkitMaskImage: `url("${src}")` }}><img src={src} width={size} height={size} alt="" onError={() => setFailed(true)} /></span>
    : <svg className="jd-asset-icon" aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">{iconPaths[name]}</svg>
}
