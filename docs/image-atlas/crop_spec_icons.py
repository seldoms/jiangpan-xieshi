"""从原规格图生成紧凑展示图；坐标均对应完整原图。"""
from pathlib import Path
from collections import deque
from PIL import Image, ImageFilter
root = Path(__file__).resolve().parents[2]
source = Image.open(root / 'public/assets/jiangdu-v1/guides/crab-specs.webp')
out = root / 'public/assets/jiangdu-v1/spec-icons'
out.mkdir(exist_ok=True)
labels = {'male': (205, 85, 387, 165), 'female': (720, 85, 902, 165),
          '3': (303, 719, 468, 791), '3.5': (534, 719, 704, 791),
          '4': (786, 719, 962, 791), '4.5': (1064, 719, 1244, 791), '5': (1378, 719, 1559, 791)}
for name, box in labels.items():
    source.crop(box).save(out / f'{name}.webp', quality=90)
for name, box in {'male': (155, 181, 501, 409), 'female': (692, 189, 1002, 409)}.items():
    source.crop(box).resize((180, 120), Image.Resampling.LANCZOS).save(out / f'{name}-crab.webp', quality=88)

def illustration_crop(box):
    """只去掉与边缘连通的浅纸色，保留笔刷内部白字和蟹身细节。"""
    image = source.crop(box).convert('RGBA')
    width, height = image.size
    pixels = image.load()
    visited = set()
    queue = deque([(x, y) for x in range(width) for y in [0, height - 1]]
                  + [(x, y) for y in range(height) for x in [0, width - 1]])
    alpha = Image.new('L', image.size, 255)
    mask = alpha.load()
    while queue:
        x, y = queue.popleft()
        if (x, y) in visited or not (0 <= x < width and 0 <= y < height):
            continue
        visited.add((x, y))
        color = pixels[x, y][:3]
        if min(color) < 190 or max(color) - min(color) > 45:
            continue
        mask[x, y] = 0
        queue.extend([(x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)])
    image.putalpha(alpha.filter(ImageFilter.GaussianBlur(0.7)))
    return image

# 每个规格保留完整蟹身，公母与重量合在图下方，避免文字图块横向拼贴。
crabs = {'3': (278, 566, 478, 705), '3.5': (498, 550, 737, 705),
         '4': (748, 536, 1001, 708), '4.5': (1025, 528, 1295, 710),
         '5': (1305, 510, 1630, 713)}
for weight, box in crabs.items():
    for gender in [None, 'male', 'female']:
        canvas = Image.new('RGBA', (360, 270), (0, 0, 0, 0))
        crab = illustration_crop(box)
        # 同比例缩小，保留不同规格在图示中的相对大小。
        crab.thumbnail((310, 185), Image.Resampling.LANCZOS)
        canvas.alpha_composite(crab, ((360 - crab.width) // 2, 198 - crab.height))
        weight_image = illustration_crop(labels[weight]).resize((154, 64), Image.Resampling.LANCZOS)
        if gender:
            gender_image = illustration_crop(labels[gender]).resize((142, 64), Image.Resampling.LANCZOS)
            canvas.alpha_composite(gender_image, (29, 196))
            canvas.alpha_composite(weight_image, (177, 196))
        else:
            canvas.alpha_composite(weight_image, (103, 196))
        canvas.save(out / f'{gender or "size"}-{weight}-illustration.webp', quality=92)
