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
    if expected == actual:
        print("drift check: OK（部署文件＝模板生成物）")
        return
    print("drift check: FAIL（部署文件与模板生成物不一致——实例 profile 漂移，禁止带漂移重启）")
    sys.exit(1)


if __name__ == "__main__":
    main()
