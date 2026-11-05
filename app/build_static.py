# -*- coding: utf-8 -*-
"""导出静态版数据包：schema + 全部数据，供纯前端版直接加载。

生成 web/data/bundle.js，格式：
    window.__EHS_BUNDLE__ = { schema: {...}, data: {...}, meta: {...} }

用法：
    python app/build_static.py                # 导出当前数据
    python app/build_static.py --demo         # 导出演示数据
    python app/build_static.py --from-backup <目录>  # 从备份目录导出
"""
from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import schema  # noqa: E402
import store  # noqa: E402

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(BASE_DIR, "web", "data")
OUT_FILE = os.path.join(OUT_DIR, "bundle.js")


def build(use_backup_dir: str = "") -> str:
    """组装 bundle 内容。"""
    sch = schema.serialize_schema()

    data = {}
    for key in schema.COLLECTION_ORDER:
        if use_backup_dir:
            path = os.path.join(use_backup_dir, f"{key}.json")
            if os.path.exists(path):
                with open(path, "r", encoding="utf-8") as fp:
                    raw = json.load(fp)
                data[key] = raw.get("items", [])
            else:
                data[key] = []
        else:
            data[key] = store.all_items(key)

    total = sum(len(v) for v in data.values())
    meta = {
        "generatedAt": _dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "total": total,
        "version": "2.0.0-static",
        "counts": {k: len(v) for k, v in data.items()},
    }

    bundle = {"schema": sch, "data": data, "meta": meta}
    payload = json.dumps(bundle, ensure_ascii=False, separators=(",", ":"))
    return (
        "/* 安全管理数据工作台 — 静态数据包\n"
        f" * 生成时间：{meta['generatedAt']}\n"
        f" * 记录总数：{total}\n"
        " * 本文件由 app/build_static.py 自动生成，请勿手动修改\n"
        " */\n"
        f"window.__EHS_BUNDLE__ = {payload};\n"
    )


def main():
    ap = argparse.ArgumentParser(description="导出静态版数据包")
    ap.add_argument("--demo", action="store_true",
                    help="先重置为演示数据再导出")
    ap.add_argument("--from-backup", default="",
                    help="从备份目录读取数据")
    ap.add_argument("--out", default="", help="输出路径")
    args = ap.parse_args()

    print("=" * 66)
    print("导出静态版数据包")
    print("=" * 66)

    if args.demo:
        print("\n重置为演示数据…")
        import seed
        for key in schema.COLLECTION_ORDER:
            raw = store.load_raw(key)
            raw["items"] = []
            raw["seq"] = 0
            store.save_raw(key, raw)
        seed.seed_hazards()
        seed.seed_risks()
        seed.seed_concerns()
        seed.seed_incidents()
        seed.seed_trainings()
        seed.seed_certificates()
        seed.seed_fire()
        seed.seed_drills()
        seed.seed_contractors()
        seed.seed_equipments()
        seed.seed_permits()
        print("  完成")

    content = build(args.from_backup)

    out = args.out or OUT_FILE
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as fp:
        fp.write(content)

    size_kb = os.path.getsize(out) / 1024
    # 统计
    import re
    m = re.search(r"记录总数：(\d+)", content)
    total = m.group(1) if m else "?"
    print(f"\n已生成：{out}")
    print(f"文件大小：{size_kb:.0f} KB　｜　记录总数：{total}")
    print("\n下一步：提交 web/data/bundle.js 到仓库，GitHub Pages 会自动加载")
    return 0


if __name__ == "__main__":
    sys.exit(main())
