"""从公母生成母版构建透明规格图，不裁切旧规格图集。"""

from collections import deque
from pathlib import Path

from PIL import Image, ImageFilter


ROOT = Path(__file__).resolve().parents[2]
SOURCE_DIR = ROOT / "output/imagegen/crab-specs"
OUTPUT_DIR = ROOT / "public/assets/jiangdu-v1/spec-icons"
CANVAS_SIZE = 512
# 规格行使用完整蟹体近景：保留全身，同时让双螯细节在小尺寸下可辨。
OCCUPANCY = {"3": 0.64, "3.5": 0.71, "4": 0.78, "4.5": 0.85, "5": 0.92}


def remove_connected_white(image: Image.Image) -> Image.Image:
    """只移除与画布边缘连通的近白背景，保留蟹身内部高光。"""
    rgba = image.convert("RGBA")
    width, height = rgba.size
    pixels = rgba.load()
    alpha = Image.new("L", rgba.size, 255)
    mask = alpha.load()
    visited = bytearray(width * height)
    queue = deque(
        [(x, 0) for x in range(width)]
        + [(x, height - 1) for x in range(width)]
        + [(0, y) for y in range(1, height - 1)]
        + [(width - 1, y) for y in range(1, height - 1)]
    )

    while queue:
        x, y = queue.popleft()
        index = y * width + x
        if visited[index]:
            continue
        visited[index] = 1
        red, green, blue, _ = pixels[x, y]
        if min(red, green, blue) < 238 or max(red, green, blue) - min(red, green, blue) > 20:
            continue
        mask[x, y] = 0
        if x > 0:
            queue.append((x - 1, y))
        if x + 1 < width:
            queue.append((x + 1, y))
        if y > 0:
            queue.append((x, y - 1))
        if y + 1 < height:
            queue.append((x, y + 1))

    rgba.putalpha(alpha.filter(ImageFilter.GaussianBlur(0.65)))
    return rgba


def subject_crop(image: Image.Image) -> Image.Image:
    alpha = image.getchannel("A")
    bbox = alpha.point(lambda value: 255 if value > 12 else 0).getbbox()
    if not bbox:
        raise ValueError("生成母版中未检测到蟹身")
    padding = 4
    left = max(0, bbox[0] - padding)
    top = max(0, bbox[1] - padding)
    right = min(image.width, bbox[2] + padding)
    bottom = min(image.height, bbox[3] + padding)
    return image.crop((left, top, right, bottom))


def place_on_canvas(subject: Image.Image, occupancy: float) -> Image.Image:
    target_width = round(CANVAS_SIZE * occupancy)
    target_height = round(subject.height * target_width / subject.width)
    crab = subject.resize((target_width, target_height), Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", (CANVAS_SIZE, CANVAS_SIZE), (0, 0, 0, 0))
    position = ((CANVAS_SIZE - crab.width) // 2, (CANVAS_SIZE - crab.height) // 2)
    canvas.alpha_composite(crab, position)
    return canvas


def export_variants(gender: str, source_name: str) -> None:
    source_path = SOURCE_DIR / source_name
    if not source_path.exists():
        raise FileNotFoundError(f"缺少生成母版：{source_path}")
    subject = subject_crop(remove_connected_white(Image.open(source_path)))

    main_destination = OUTPUT_DIR / f"{gender}-crab.webp"
    place_on_canvas(subject, 0.94).save(main_destination, "WEBP", lossless=True, method=6)
    print(f"wrote {main_destination.relative_to(ROOT)} (main / {CANVAS_SIZE}px)")

    for weight, occupancy in OCCUPANCY.items():
        target_width = round(CANVAS_SIZE * occupancy)
        canvas = place_on_canvas(subject, occupancy)
        destination = OUTPUT_DIR / f"{gender}-{weight}-illustration.webp"
        canvas.save(destination, "WEBP", lossless=True, method=6)
        print(f"wrote {destination.relative_to(ROOT)} ({target_width}px / {CANVAS_SIZE}px)")


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    export_variants("male", "male-4-opaque.png")
    export_variants("female", "female-4-opaque.png")


if __name__ == "__main__":
    main()
