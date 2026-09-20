# 公母规格蟹图生成规范

## 目标

为前台规格组件生成 10 张独立 WebP：公蟹、母蟹各 3 两、3.5 两、4 两、4.5 两、5 两。图片只承担蟹身图示，公母、重量和价格由前端文字显示。

## 统一生成策略

1. 先生成 `male-4` 母版。
2. 以 `male-4` 高保真编辑生成 `female-4`，只改变性别特征。
3. 当前 API 的 `gpt-image-2.5-sunburst` 不接受透明背景参数，因此母版使用纯白背景生成，再通过 `build_generated_spec_icons.py` 仅移除与画布边缘连通的近白背景。
4. 脚本分别以公、母母版派生完整大蟹主图和重量近景，只改变 512×512 透明画布中的占比；所有图片保留整只蟹，正面双螯是近景视觉重点，不生成孤立肢体图。

## 母版提示词

```text
Use case: product-mockup
Asset type: e-commerce product specification icon
Primary request: Create one anatomically accurate live male Chinese mitten crab (Eriocheir sinensis), shown from the same slightly elevated frontal three-quarter view used in premium food catalog illustrations.
Subject: a healthy unboiled male crab with a deep olive blue-green carapace, robust angular body, two large powerful claws, and clearly visible dense dark velvety mitten-like hair covering the outer surfaces of both claws. The claw hair must be the clearest male identifier. Exactly two claws and eight walking legs, with no missing, duplicated, fused, or malformed limbs.
Style/medium: refined Chinese watercolor and gouache product illustration with realistic anatomy, crisp shell texture, fine brush detail, restrained natural pigments, and clean edges suitable for a small UI icon.
Composition/framing: square canvas, crab centered and facing forward, whole body and every leg fully visible, symmetrical resting pose, generous pure-white padding on every side.
Lighting/mood: soft neutral daylight from upper left, subtle form shading, no cast shadow outside the crab.
Color palette: olive green, lake blue-green, muted ivory joints, small natural ochre-orange accents only at joints and tips.
Constraints: uniform pure-white background with clean subject edges; no text, numbers, Chinese characters, labels, badges, brush plaques, border, platform, plate, rope, grass, water, scenery, logo, or watermark. One crab only. Alive and unboiled, never bright cooked red. Keep the silhouette readable at 48px.
Avoid: cartoon style, mascot proportions, photographic cutout, glossy 3D render, red cooked crab, extra limbs, cropped legs, fuzzy whole body, decorative background.
```

## 母蟹性别编辑提示词

```text
Edit target: the approved male 4-liang master image.
Change only the crab's sex-specific anatomy to an adult female Chinese mitten crab while preserving the exact watercolor-and-gouache style, viewpoint, lighting, pose, palette, canvas placement, and limb count.
Female identifiers: rounder and slightly broader carapace/body, smaller and slimmer claws, smooth claw surfaces with only sparse fine hair; remove the male's dense dark mitten-like claw fur. The contrast between smooth female claws and furry male claws must remain obvious at small UI size.
Keep exactly two claws and eight walking legs, fully visible and anatomically correct.
Maintain the uniform pure-white background. No text, labels, badges, brush plaques, borders, platform, scenery, shadow, logo, or watermark. Do not make the female crab red and do not expose roe or internal anatomy.
```

## 规格派生

```bash
python3 docs/image-atlas/build_generated_spec_icons.py
```

脚本读取 `output/imagegen/crab-specs/male-4-opaque.png` 与 `female-4-opaque.png`。公母各规格共享自己的母版，因此螯毛、体态、视角和笔触不会在不同重量之间漂移；规格差异通过统一画布中的连续占比表达。

## 规格矩阵

| 文件 | 画布占宽 | 体型要求 |
| --- | ---: | --- |
| `male-3` / `female-3` | 64% | 最小近景，完整蟹体与双螯均可辨 |
| `male-3.5` / `female-3.5` | 71% | 略大于 3 两，仍偏轻巧 |
| `male-4` / `female-4` | 78% | 标准近景比例 |
| `male-4.5` / `female-4.5` | 85% | 壳体与双螯更饱满 |
| `male-5` / `female-5` | 92% | 最大近景但仍保留完整蟹体，不触碰画布边缘 |

公蟹 `SEX_TRAIT`：`both claws retain clearly visible dense dark velvety mitten-like hair; never smooth or hairless`。

母蟹 `SEX_TRAIT`：`both claws remain smaller, slimmer, smooth, and nearly hairless, with at most sparse fine hair; never dense mitten-like fur`。

## 验收

- 十张图的视角、笔触、壳色和光线一致。
- 公蟹两只螯的绒毛在 48px 展示下仍可辨；母蟹螯面明显更光滑。
- 从 3 两到 5 两连续增大，不能出现小规格反而更大的倒序。
- 每张只有一只完整活蟹，严格两螯八足，无断肢、增肢或融合。
- 透明底无白边、无文字、无标签、无场景和水印。
