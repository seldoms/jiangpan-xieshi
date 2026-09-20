"""从用户提供的第一张拼图裁切图标；不修改源文件。"""
from collections import deque
from pathlib import Path
import json
import sys

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
SOURCE = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / 'docs/image-atlas/sources/1.png'
OUT = ROOT / 'public/assets/jiangdu-v1/icons'
DOCS = Path(__file__).resolve().parent
NAMES = ['arrow-right', 'arrow-left', 'plus', 'minus', 'bag', 'check', 'pin', 'close',
         'box', 'leaf', 'truck', 'clock', 'chevron-down', 'edit', 'trash', 'search']
CENTERS = [130, 339, 544, 745, 949, 1147, 1343, 1545]


def keep_components(mask):
    seen = np.zeros(mask.shape, dtype=bool)
    kept = np.zeros(mask.shape, dtype=bool)
    height, width = mask.shape
    for y, x in zip(*np.where(mask)):
        if seen[y, x]:
            continue
        pending = deque([(y, x)])
        seen[y, x] = True
        points = []
        while pending:
            py, px = pending.popleft()
            points.append((py, px))
            for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1)):
                ny, nx = py + dy, px + dx
                if 0 <= ny < height and 0 <= nx < width and mask[ny, nx] and not seen[ny, nx]:
                    seen[ny, nx] = True
                    pending.append((ny, nx))
        if len(points) >= 8:
            for py, px in points:
                kept[py, px] = True
    return kept


def extract(crop):
    rgb = np.asarray(crop, dtype=float)
    paper = rgb[(rgb[:, :, 0] > 220) & (rgb[:, :, 0] >= rgb[:, :, 1])]
    background = np.median(paper, axis=0)
    ink_pixels = rgb[(rgb[:, :, 1] - rgb[:, :, 0] > 30) & (rgb[:, :, 0] < 95)]
    # 用实图中的深色笔触估算纸面混色，保持原青绿而非另行上色。
    ink = np.percentile(ink_pixels, 25, axis=0)
    direction = background - ink
    alpha = np.clip(np.sum((background - rgb) * direction, axis=2) / np.sum(direction ** 2), 0, 1)
    mask = keep_components((alpha > 0.055) & (rgb[:, :, 1] - rgb[:, :, 0] > 4))
    alpha *= mask
    unmatte = np.clip((rgb - background * (1 - alpha[:, :, None])) / np.maximum(alpha[:, :, None], 0.001), 0, 255)
    rgba = np.dstack((unmatte, alpha * 255)).round().astype(np.uint8)
    rgba[~mask] = 0
    image = Image.fromarray(rgba)
    bbox = image.getbbox()
    if bbox is None:
        raise ValueError('未检出图标')
    tight = image.crop(bbox)
    scale = 96 / max(tight.size)
    size = tuple(max(1, round(value * scale)) for value in tight.size)
    tight = tight.resize(size, Image.Resampling.LANCZOS)
    canvas = Image.new('RGBA', (128, 128))
    canvas.alpha_composite(tight, ((128 - size[0]) // 2, (128 - size[1]) // 2))
    return canvas, bbox


source = Image.open(SOURCE).convert('RGB')
if source.size != (1672, 941):
    raise ValueError(f'源图尺寸与坐标不符: {source.size}')
OUT.mkdir(parents=True, exist_ok=True)
source_reference = str(SOURCE.resolve().relative_to(ROOT)) if SOURCE.resolve().is_relative_to(ROOT) else str(SOURCE.resolve())
manifest = {'source': source_reference, 'sourceSize': {'width': 1672, 'height': 941},
            'outputSize': {'width': 128, 'height': 128}, 'maxSubjectSize': 96,
            'assets': [], 'rejected': []}
previews = []
for index, name in enumerate(NAMES):
    x = CENTERS[index % 8] - 80
    y, h = (642, 112) if index < 8 else (760, 136)
    rect = {'x': x, 'y': y, 'width': 160, 'height': h}
    item = {'id': f'C{index + 4:02}', 'name': name, 'sourceRect': rect}
    if name == 'chevron-down':
        item['reason'] = '源图为向右下斜箭头，不是向下折角；拒绝用作展开/折叠图标。'
        manifest['rejected'].append(item)
        continue
    canvas, bbox = extract(source.crop((x, y, x + 160, y + h)))
    path = OUT / f'{name}.png'
    canvas.save(path, optimize=True)
    item.update({'path': str(path.relative_to(ROOT)), 'outputSize': {'width': 128, 'height': 128},
                 'subjectSourceRect': {'x': x + bbox[0], 'y': y + bbox[1],
                                       'width': bbox[2] - bbox[0], 'height': bbox[3] - bbox[1]}})
    manifest['assets'].append(item)
    previews.append((item['id'], name, canvas))
(DOCS / 'icon-crops-v1.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
sheet = Image.new('RGB', (960, 660), '#e0e5e1')
draw = ImageDraw.Draw(sheet)
for i, (identifier, name, icon) in enumerate(previews):
    left, top = (i % 5) * 192, (i // 5) * 220
    # 对照深浅背景，检查残余纸边及抗锯齿。
    for cy in range(8):
        for cx in range(8):
            color = '#f7f5ef' if (cx + cy) % 2 == 0 else '#becac4'
            draw.rectangle((left + 32 + cx * 16, top + 20 + cy * 16,
                            left + 47 + cx * 16, top + 35 + cy * 16), fill=color)
    sheet.paste(icon, (left + 32, top + 20), icon)
    draw.text((left + 16, top + 165), f'{identifier} {name}', fill='#243c38')
sheet.save(DOCS / 'icon-contact-sheet-v1.png')
print(f'已裁切 {len(manifest["assets"])} 个图标，拒绝 {len(manifest["rejected"])} 个。')
