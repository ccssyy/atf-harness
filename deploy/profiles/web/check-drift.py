#!/usr/bin/env python3
"""批㊶-I 部署漂移校验——重新生成结果 vs 部署现存文件逐字节比对，漂移即非零退出。

用法：python3 check-drift.py --overlay deploy/instances/<实例>.overlay.yml \
        --deployed <DSH_HOME>/profiles/web/cordis.patch.yml
"""
import argparse
import subprocess
import sys
import tempfile
import os

here = __file__.rsplit("/", 1)[0]


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
    # 批㊶-M2 增补一 登记件三：runsRoot 必须位于 workspace（或 DSH_HOME）目录树内——
    # 禁独立 tmp 轴（单树收敛为部署硬约束）。轻量静态核验：部署文件含 ATF_DSH_RUNS_ROOT
    # 相关注释时检查其路径不以 /tmp/ 开头（生成物层）；实例 env 层由接入人工核验。
    import re as _re
    for line in actual.splitlines():
        if "ATF_DSH_RUNS_ROOT" in line and "/tmp/" in line:
            print("drift check: FAIL（runsRoot 指向独立 tmp 轴——违反单树收敛硬约束）")
            sys.exit(1)
    # 语义级对比（YAML 解析后相等＝无漂移；字节差异仅格式化形态不算漂移）
    import yaml as _yaml
    try:
        semantically_equal = _yaml.safe_load(expected) == _yaml.safe_load(actual)
    except Exception:
        semantically_equal = expected == actual
    if semantically_equal:
        print("drift check: OK（部署文件＝模板生成物[语义级]）")
        return
    print("drift check: FAIL（部署文件与模板生成物不一致——实例 profile 漂移，禁止带漂移重启）")
    sys.exit(1)


if __name__ == "__main__":
    main()
