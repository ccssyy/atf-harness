#!/usr/bin/env python3
"""批㊶-I 部署资产单源化——模板＋overlay → 实例 cordis.patch.yml。

产品层（模板）零实例值；实例差异只落 overlay（行覆写/追加，后写覆盖）。
用法：python3 generate.py --overlay deploy/instances/<实例>.overlay.yml \
        --out <DSH_HOME>/profiles/web/cordis.patch.yml
overlay 可省略（--overlay 缺省＝纯模板直出）。
"""
import argparse
import yaml


class _JsTag(str):
    """YAML `!!js` 标量：**原样透传**，不在生成期求值。

    为什么不在 generate.py 求值：`!!js` 是 vendor 应用加载期的表达式标签
    （见 vendor `packages/boot/plugin-manager/src/patch.ts` 的 customTags——
    那里 resolve 成原文，由 boot 侧 `dshHomePath(...)` 执行）。生成器只做
    「模板＋overlay → 实例文件」的搬运，求值越界会与 vendor 形成双源。
    """


def _js_constructor(loader: yaml.SafeLoader, node: yaml.Node) -> _JsTag:
    return _JsTag(loader.construct_scalar(node))


def _js_representer(dumper: yaml.SafeDumper, value: _JsTag) -> yaml.Node:
    return dumper.represent_scalar("tag:yaml.org,2002:js", str(value))


yaml.SafeLoader.add_constructor("tag:yaml.org,2002:js", _js_constructor)
yaml.SafeDumper.add_representer(_JsTag, _js_representer)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    here = __file__.rsplit("/", 1)[0]
    parser.add_argument("--template", default=f"{here}/cordis.patch.template.yml")
    parser.add_argument("--overlay", default=None, help="实例 overlay yml（行覆写/追加；可省略）")
    parser.add_argument("--out", required=True, help="实例 cordis.patch.yml 输出路径")
    args = parser.parse_args()

    with open(args.template, encoding="utf8") as handle:
        rows = yaml.safe_load(handle)
    if not isinstance(rows, list):
        raise SystemExit(f"模板须为 YAML 行列表：{args.template}")
    if args.overlay:
        with open(args.overlay, encoding="utf8") as handle:
            overlay_rows = yaml.safe_load(handle)
        if not isinstance(overlay_rows, list):
            raise SystemExit(f"overlay 须为 YAML 行列表：{args.overlay}")
        rows.extend(overlay_rows)

    # 行覆写语义：同 id 后写覆盖（insert 行与无 id 行原样保留在前）。
    merged: list = []
    index_by_id: dict = {}
    for row in rows:
        row_id = row.get("id") if isinstance(row, dict) else None
        if row_id is not None and row_id in index_by_id:
            merged[index_by_id[row_id]] = row
        else:
            index_by_id[row_id] = len(merged)
            merged.append(row)

    text = yaml.safe_dump(merged, allow_unicode=True, sort_keys=False, width=120)
    with open(args.out, "w", encoding="utf8") as handle:
        handle.write("# 本文件由 deploy/profiles/web/generate.py 生成（模板＋overlay）——勿手改；"
                     "改动走模板/overlay 后重新生成。\n")
        handle.write(text)
    print(f"generated: {args.out}（rows={len(merged)}）")


if __name__ == "__main__":
    main()
