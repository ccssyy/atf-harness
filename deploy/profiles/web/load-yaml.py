#!/usr/bin/env python3
"""模板/overlay YAML 加载器（支持 `!!js` 标签透传）。

测试与工具共用：`!!js` 是 vendor 应用加载期的表达式标签（见 vendor
`packages/boot/plugin-manager/src/patch.ts` 的 customTags），生成与断言
阶段只需原样保留，不求值。
"""
import json
import sys

import yaml


class JsTag(str):
    """`!!js` 标量：原样透传。"""


def _js_constructor(loader: yaml.SafeLoader, node: yaml.Node) -> JsTag:
    return JsTag(loader.construct_scalar(node))


yaml.SafeLoader.add_constructor("tag:yaml.org,2002:js", _js_constructor)


def load(path: str):
    with open(path, encoding="utf8") as handle:
        return yaml.safe_load(handle)


if __name__ == "__main__":
    print(json.dumps(load(sys.argv[1])))
