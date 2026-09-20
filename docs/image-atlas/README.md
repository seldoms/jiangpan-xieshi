# 彩墨素材裁切记录

用户提供的原图保存在 `sources/1.png`（1672×941）和 `sources/2.png`（1672×940）。实际尺寸、构图与早期生成规格不同，不能沿用旧的 1024 方图坐标。

- `art-crops-v1.json`：Banner、蟹塘、Logo、商品和包装的实际源图裁切矩形与输出尺寸。
- `icon-crops-v1.json`：15 个图标的实际裁切矩形、去底后的主体范围、输出路径，以及拒绝项 C16。
- `crop_art.py`、`crop_icons.py`：可重复运行的裁切脚本；依赖 Python、Pillow、NumPy。图标脚本默认读取项目内 `sources/1.png`。
- `icon-contact-sheet-v1.png`：透明棋盘上的图标验收预览。

坐标从原图左上角 `(0, 0)` 起，`sourceRect` 为 `{x, y, width, height}`，范围采用左闭右开。商品裁切后置于 576×576 画布；图标去纸底后置于 128×128 透明画布，主体最大 96×96。源图保持不变。

正式素材位于 `public/assets/jiangdu-v1/`。前端素材板 `src/storefront/ImageAtlasBoard.jsx` 直接读取上述实际元数据，显示原图、裁切框、坐标表和输出预览。C16 源图误画为右下斜箭头，未输出位图，页面继续使用向下折角 SVG。

`atlas.json`、`layout-*.svg`、`prompts.md` 为早期素材规划，不代表本次回图的真实裁切坐标。
