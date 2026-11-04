#!/usr/bin/env python3
"""部署漂移校验（B2 升级：键级双向对账＋差异定位＋修复指令）。

用法：python3 check-drift.py --overlay deploy/instances/<实例>.overlay.yml \
        --deployed <DSH_HOME>/profiles/web/cordis.patch.yml

退出码：0=对账归零；1=runsRoot 硬约束违规；2=漂移（输出差异键清单＋修复指令）。
归一化：YAML1.1 布尔陷阱（裸 off/on 键解析为 False/True）统一映射回 "off"/"on"——
模板带引号 off 与产物裸 off 键级等价，不构成漂移（2026-11-05 实锚）。
事故来源：2026-11-04 overlay 漂移（产物被改源未同步，重新生成差点回退 D170v2
免审面＋断默认模型）——本门禁为该事故三元组的拦截点。
"""
import argparse
import json
import subprocess
import sys
import tempfile
import os

here = __file__.rsplit("/", 1)[0]


def norm(obj):
    """键级归一化：YAML1.1 布尔陷阱归一＋dict/list 递归。"""
    if isinstance(obj, dict):
        return {norm(k): norm(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [norm(x) for x in obj]
    if obj is False:
        return "off"
    if obj is True:
        return "on"
    return obj


def row_key(r):
    if isinstance(r, dict):
        if "insert" in r and isinstance(r["insert"], list):
            return "insert[" + ",".join(str(i.get("id")) for i in r["insert"] if isinstance(i, dict)) + "]"
        return str(r.get("id"))
    return None


def key_diff(a, b, path=""):
    out = []
    a, b = norm(a), norm(b)  # 布尔键/值先归一(YAML1.1 裸 off/on 键 -> "off"/"on")
    # 标量列表＝集合语义（排序后比较——yaml 序列里顺序无业务含义的枚举集合）
    if isinstance(a, list) and isinstance(b, list) and all(
        not isinstance(x, (dict, list)) for x in a + b
    ):
        if sorted(map(lambda x: json.dumps(norm(x), ensure_ascii=False, default=str), a)) == sorted(
            map(lambda x: json.dumps(norm(x), ensure_ascii=False, default=str), b)
        ):
            return []
        return [f"{path}: 枚举集不等 再生成={a} 产物={b}"]
    # 行列表按 id/insert-id 配对（行序差异不算漂移；同 id 行内再做键级 diff）
    if isinstance(a, list) and isinstance(b, list):
        bd = {}
        for i, r in enumerate(b):
            k = row_key(r)
            if k is not None:
                bd.setdefault(k, []).append(i)
        used = set()
        for ai, ra in enumerate(a):
            k = row_key(ra)
            cands = [i for i in bd.get(k, []) if i not in used] if k is not None else []
            if cands:
                bi = cands[0]
                used.add(bi)
                out += key_diff(ra, b[bi], f"{path}[{k}]")
            else:
                out.append(f"{path}[{ai}]: 再生成有行 {k or ai}/产物无")
        for bi, rb in enumerate(b):
            if bi not in used:
                out.append(f"{path}[{row_key(rb) or bi}]: 产物有行/再生成无")
        return out
    if isinstance(a, dict) and isinstance(b, dict):
        for k in sorted(set(a) | set(b), key=str):
            if k not in a:
                out.append(f"{path}.{k}: 产物有/再生成无")
            elif k not in b:
                out.append(f"{path}.{k}: 再生成有/产物无")
            else:
                out += key_diff(a[k], b[k], f"{path}.{k}")
    elif norm(a) != norm(b):
        out.append(f"{path}: 再生成={json.dumps(norm(a), ensure_ascii=False, default=str)[:70]} ≠ 产物={json.dumps(norm(b), ensure_ascii=False, default=str)[:70]}")
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--overlay", default=None)
    parser.add_argument("--deployed", required=True)
    args = parser.parse_args()

    generated = tempfile.NamedTemporaryFile(suffix=".yml", delete=False).name
    cmd = [sys.executable, f"{here}/generate.py", "--out", generated]
    if args.overlay:
        cmd.extend(["--overlay", args.overlay])
    subprocess.run(cmd, check=True)
    with open(generated, encoding="utf8") as handle:
        expected = handle.read()
    with open(args.deployed, encoding="utf8") as handle:
        actual = handle.read()
    os.unlink(generated)

    # runsRoot 单树收敛硬约束（批㊶-M2 增补一，保留）。
    for line in actual.splitlines():
        if "ATF_DSH_RUNS_ROOT" in line and "/tmp/" in line:
            print("drift check: FAIL（runsRoot 指向独立 tmp 轴——违反单树收敛硬约束）")
            sys.exit(1)

    import yaml
    try:
        expected_rows, actual_rows = yaml.safe_load(expected), yaml.safe_load(actual)
    except Exception:
        expected_rows, actual_rows = None, None

    if expected_rows is not None and actual_rows is not None:
        diffs = key_diff(expected_rows, actual_rows)
        if not diffs:
            print("drift check: OK（部署文件＝模板+overlay 生成物[键级归一化对账]）")
            return
        print("drift check: FAIL（键级漂移 %d 处——禁止带漂移重启）：" % len(diffs))
        for d in diffs[:20]:
            print("  " + d)
        print("修复指令（二选一后重跑本检查）：")
        print("  1. 差异属实例演化 → 回写 %s 对应段（实例差异只落 overlay）" % (args.overlay or "<overlay>"))
        print("  2. 差异属误改/实验残留 → 从模板+overlay 重新生成并部署（generate.py --out 部署路径）")
        sys.exit(2)

    if expected == actual:
        print("drift check: OK（字节级一致）")
        return
    print("drift check: FAIL（部署文件与模板生成物不一致且不可解析——人工核验）")
    sys.exit(2)


if __name__ == "__main__":
    main()
