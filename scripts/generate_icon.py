"""
生成 Murasaki 应用图标

设计：产品字母风
- 紫色渐变背景（圆角矩形）
- 白色字母 M（几何粗壮造型）
- 顶部金色墨滴（呼应"书写创作"主题）

输出：1024x1024 PNG（作为 Tauri CLI 的源图标）
"""
from PIL import Image, ImageDraw, ImageFilter
from pathlib import Path
import sys

# === 配置 ===
SIZE = 1024
CORNER_RADIUS = 225  # iOS/macOS 风格圆角（约 22%）

# 紫色渐变（左上 → 右下）
GRADIENT_TOP_LEFT = (76, 29, 149)     # #4C1D95 indigo-900
GRADIENT_MIDDLE = (124, 58, 237)      # #7C3AED violet-600
GRADIENT_BOTTOM_RIGHT = (168, 85, 247)  # #A855F7 purple-500

# M 字母颜色（白色微渐变）
M_TOP = (255, 255, 255)
M_BOTTOM = (243, 232, 255)  # #F3E8FF

# 墨滴颜色
INK_DROP = (252, 211, 77)  # #FCD34D amber-300


def lerp_color(c1, c2, t):
    """线性插值两个颜色"""
    return tuple(int(c1[i] + (c2[i] - c1[i]) * t) for i in range(3))


def draw_diagonal_gradient(img, c1, c2, c3):
    """绘制对角线渐变（左上 → 右下，三段）"""
    pixels = img.load()
    for y in range(SIZE):
        for x in range(SIZE):
            # 对角线进度（0 到 1）
            t = (x + y) / (2 * (SIZE - 1))
            if t < 0.5:
                # 上半段：c1 → c2
                color = lerp_color(c1, c2, t * 2)
            else:
                # 下半段：c2 → c3
                color = lerp_color(c2, c3, (t - 0.5) * 2)
            pixels[x, y] = color + (255,)


def apply_rounded_corners(img, radius):
    """应用圆角遮罩"""
    mask = Image.new("L", img.size, 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle(
        [(0, 0), (SIZE - 1, SIZE - 1)],
        radius=radius,
        fill=255,
    )
    result = Image.new("RGBA", img.size, (0, 0, 0, 0))
    result.paste(img, (0, 0), mask)
    return result


def draw_m_letter(img):
    """绘制 M 字母（带垂直渐变）"""
    # M 的路径顶点（顺时针外轮廓）
    outer = [
        (256, 720),  # 左下外
        (256, 304),  # 左上外
        (384, 304),  # 左竖右上
        (512, 528),  # V 外尖
        (640, 304),  # 右竖左上
        (768, 304),  # 右上外
        (768, 720),  # 右下外
        (656, 720),  # 右下内
        (656, 480),  # 右竖内底
        (512, 656),  # V 内尖
        (368, 480),  # 左竖内底
        (368, 720),  # 左下内
    ]

    # 先画一个渐变图层，再用 M 形状作为遮罩
    grad = Image.new("RGBA", img.size, (0, 0, 0, 0))
    grad_pixels = grad.load()
    for y in range(304, 721):
        t = (y - 304) / (720 - 304)
        color = lerp_color(M_TOP, M_BOTTOM, t)
        for x in range(256, 769):
            grad_pixels[x, y] = color + (255,)

    mask = Image.new("L", img.size, 0)
    draw = ImageDraw.Draw(mask)
    draw.polygon(outer, fill=255)

    img.paste(grad, (0, 0), mask)


def draw_ink_drop(img):
    """绘制顶部墨滴装饰"""
    draw = ImageDraw.Draw(img)
    cx, cy, r = 512, 172, 32
    # 主墨滴
    draw.ellipse(
        [(cx - r, cy - r), (cx + r, cy + r)],
        fill=INK_DROP + (242,),  # opacity 0.95
    )
    # 边缘高光
    draw.ellipse(
        [(cx - r, cy - r), (cx + r, cy + r)],
        outline=(255, 255, 255, 102),  # opacity 0.4
        width=2,
    )


def main():
    output_path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("src-tauri/icons/icon.png")
    output_path.parent.mkdir(parents=True, exist_ok=True)

    # 1. 创建渐变背景
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw_diagonal_gradient(img, GRADIENT_TOP_LEFT, GRADIENT_MIDDLE, GRADIENT_BOTTOM_RIGHT)

    # 2. 应用圆角
    img = apply_rounded_corners(img, CORNER_RADIUS)

    # 3. 绘制 M 字母
    draw_m_letter(img)

    # 4. 绘制墨滴
    draw_ink_drop(img)

    # 5. 保存
    img.save(output_path, "PNG")
    print(f"✅ 图标已生成: {output_path} ({SIZE}x{SIZE})")
    print(f"   文件大小: {output_path.stat().st_size} bytes")


if __name__ == "__main__":
    main()
