"""按已验收的原图边界裁切；原始图片保持不变。"""
import json
from pathlib import Path

from PIL import Image, ImageChops

ROOT = Path(__file__).resolve().parents[2]
SOURCE = Path(__file__).resolve().parent / 'sources'
OUTPUT = ROOT / 'public/assets/jiangdu-v1'
PAPER = (247, 245, 239)

# 坐标为实际原图像素，右下角不包含在裁切范围内。
REGIONS = [
    ('A01', '首页横幅', 'banner', '1.png', (12, 16, 1072, 622), None),
    ('A02', '苏北蟹塘风光', 'pond', '1.png', (1092, 352, 1646, 616), None),
    ('B01', '活公蟹', 'male', '2.png', (16, 48, 544, 416), (576, 576)),
    ('B02', '活母蟹', 'female', '2.png', (572, 58, 1090, 416), (576, 576)),
    ('B03', '公母双蟹套装', 'pair', '2.png', (1110, 44, 1656, 420), (576, 576)),
    ('B04', '开启礼盒', 'gift-open', '2.png', (12, 432, 548, 918), (576, 576)),
    ('C03', '闭合礼盒', 'gift-closed', '2.png', (564, 478, 1096, 882), (576, 576)),
    ('C02', '普通运输包装', 'package-plain', '2.png', (1110, 444, 1654, 910), (576, 576)),
]


def soften_paper_edge(image, inset=14):
    width, height = image.size
    horizontal = Image.new('L', (width, 1))
    horizontal.putdata([round(255 * min(1, x / inset, (width - 1 - x) / inset)) for x in range(width)])
    vertical = Image.new('L', (1, height))
    vertical.putdata([round(255 * min(1, y / inset, (height - 1 - y) / inset)) for y in range(height)])
    mask = ImageChops.darker(horizontal.resize(image.size), vertical.resize(image.size))
    return Image.composite(image, Image.new('RGB', image.size, PAPER), mask)


def main():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    assets = []
    for asset_id, name, key, source, rect, canvas_size in REGIONS:
        image = Image.open(SOURCE / source).convert('RGB').crop(rect)
        image = soften_paper_edge(image)
        if canvas_size:
            canvas = Image.new('RGB', canvas_size, PAPER)
            canvas.paste(image, ((canvas.width - image.width) // 2, (canvas.height - image.height) // 2))
            image = canvas
        filename = key + '.webp'
        image.save(OUTPUT / filename, quality=92, method=6)
        assets.append(dict(id=asset_id, name=name, key=key, source=source,
                           sourceRect=dict(x=rect[0], y=rect[1], width=rect[2]-rect[0], height=rect[3]-rect[1]),
                           src='/assets/jiangdu-v1/' + filename, width=image.width, height=image.height))

    # 单色 Logo 去掉纸底，按色差恢复抗锯齿透明边缘。
    logo_rect = (1208, 64, 1504, 330)
    logo = Image.open(SOURCE / '1.png').convert('RGB').crop(logo_rect)
    rgba = Image.new('RGBA', logo.size)
    pixels = []
    for r, g, b in logo.get_flattened_data():
        alpha = round(255 * max(0, min(1, ((r - g) - 10) / 90)))
        pixels.append((182, 75, 45, alpha))
    rgba.putdata(pixels)
    bounds = rgba.getbbox()
    if not bounds:
        raise ValueError('Logo 未识别到有效内容')
    rgba = rgba.crop(bounds)
    rgba.thumbnail((224, 224), Image.Resampling.LANCZOS)
    canvas = Image.new('RGBA', (256, 256))
    canvas.paste(rgba, ((256-rgba.width)//2, (256-rgba.height)//2))
    canvas.save(OUTPUT / 'logo.png')
    assets.append(dict(id='C01', name='蟹形品牌标志', key='logo', source='1.png',
                       sourceRect=dict(x=logo_rect[0], y=logo_rect[1], width=logo_rect[2]-logo_rect[0], height=logo_rect[3]-logo_rect[1]),
                       src='/assets/jiangdu-v1/logo.png', width=256, height=256))
    (SOURCE.parent / 'art-crops-v1.json').write_text(json.dumps(assets, ensure_ascii=False, indent=2) + '\n')
    print('已裁切 8 张画面与 1 个透明 Logo；未放大源图主体。')


if __name__ == '__main__':
    main()
