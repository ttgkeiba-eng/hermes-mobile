#!/usr/bin/env python3
"""PWA アイコンを生成する。

    python3 tools/generate_icons.py

依存ゼロ（zlib と struct だけ）で PNG を書く。Pillow も ImageMagick も要らない。
アイコンをいじりたくなったら定数を変えて再実行すれば icons/ が作り直される。

生成物:
    icons/icon-192.png           ふつうのアイコン
    icons/icon-512.png           同上（スプラッシュ・インストール時に使われる）
    icons/icon-maskable-512.png  maskable。OS が好きな形に切り抜くのでロゴを小さめに
    icons/badge-72.png           Android の通知バッジ。単色シルエット扱いなので白抜き
"""

from __future__ import annotations

import struct
import zlib
from pathlib import Path

ICON_DIR = Path(__file__).resolve().parent.parent / "icons"

BG = (11, 18, 32, 255)        # #0b1220 — manifest の theme_color / background_color と揃える
FG = (122, 214, 255, 255)     # #7ad6ff — アクセント（H の色）
TRANSPARENT = (0, 0, 0, 0)
WHITE = (255, 255, 255, 255)

Pixel = tuple[int, int, int, int]


def write_png(path: Path, width: int, height: int, rows: list[list[Pixel]]) -> None:
    """RGBA の 2 次元配列を PNG にして書き出す。"""
    raw = b"".join(
        b"\x00" + bytes(channel for pixel in row for channel in pixel) for row in rows
    )

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    # ビット深度 8 / カラータイプ 6 (RGBA)
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    path.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def rounded_background(size: int, radius_ratio: float, colour: Pixel) -> list[list[Pixel]]:
    """角丸の背景。radius_ratio=0 で角丸なし（maskable 用の全面塗り）。"""
    radius = int(size * radius_ratio)
    rows: list[list[Pixel]] = []
    for y in range(size):
        row: list[Pixel] = []
        for x in range(size):
            inside = True
            if radius > 0:
                # 4 隅だけ円の内側かどうかを見る
                cx = radius if x < radius else (size - 1 - radius if x > size - 1 - radius else x)
                cy = radius if y < radius else (size - 1 - radius if y > size - 1 - radius else y)
                if (x < radius or x > size - 1 - radius) and (y < radius or y > size - 1 - radius):
                    inside = (x - cx) ** 2 + (y - cy) ** 2 <= radius**2
            row.append(colour if inside else TRANSPARENT)
        rows.append(row)
    return rows


def draw_h(rows: list[list[Pixel]], size: int, scale: float, colour: Pixel) -> None:
    """中央に "H" を描く。scale はアイコン一辺に対する H の高さの比。"""
    height = int(size * scale)
    width = int(height * 0.78)
    stroke = max(2, int(height * 0.20))

    left = (size - width) // 2
    top = (size - height) // 2
    right = left + width
    bottom = top + height

    # 縦棒 2 本
    for y in range(top, bottom):
        for x in range(left, left + stroke):
            rows[y][x] = colour
        for x in range(right - stroke, right):
            rows[y][x] = colour

    # 横棒（中央）
    bar_top = top + (height - stroke) // 2
    for y in range(bar_top, bar_top + stroke):
        for x in range(left, right):
            rows[y][x] = colour


def build_icon(size: int, *, maskable: bool = False) -> list[list[Pixel]]:
    if maskable:
        # maskable は OS が円や角丸に切り抜く。安全領域は中央 80% なので
        # 背景は全面塗り、ロゴは小さめにする。
        rows = rounded_background(size, 0.0, BG)
        draw_h(rows, size, 0.40, FG)
    else:
        rows = rounded_background(size, 0.18, BG)
        draw_h(rows, size, 0.52, FG)
    return rows


def build_badge(size: int) -> list[list[Pixel]]:
    """通知バッジ。Android はアルファだけ見て単色シルエットにするので白抜きで作る。"""
    rows = [[TRANSPARENT for _ in range(size)] for _ in range(size)]
    draw_h(rows, size, 0.70, WHITE)
    return rows


def main() -> None:
    ICON_DIR.mkdir(parents=True, exist_ok=True)
    targets = [
        ("icon-192.png", 192, build_icon(192)),
        ("icon-512.png", 512, build_icon(512)),
        ("icon-maskable-512.png", 512, build_icon(512, maskable=True)),
        ("badge-72.png", 72, build_badge(72)),
    ]
    for name, size, rows in targets:
        path = ICON_DIR / name
        write_png(path, size, size, rows)
        print(f"  {name:<24} {size}x{size}  {path.stat().st_size:,} バイト")


if __name__ == "__main__":
    print("アイコンを生成:")
    main()
