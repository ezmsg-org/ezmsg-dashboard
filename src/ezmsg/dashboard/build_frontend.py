from __future__ import annotations

import argparse
import filecmp
import shutil
from pathlib import Path

from .backend.app import PACKAGE_FRONTEND_DIR

REPO_ROOT = Path(__file__).resolve().parents[3]
FRONTEND_DIST_DIR = REPO_ROOT / "frontend" / "dist"


def _copy_tree(source: Path, target: Path) -> None:
    if target.exists():
        shutil.rmtree(target)
    shutil.copytree(source, target)


def _dirs_match(left: Path, right: Path) -> bool:
    comparison = filecmp.dircmp(left, right)
    if comparison.left_only or comparison.right_only or comparison.diff_files or comparison.funny_files:
        return False
    return all(_dirs_match(left / name, right / name) for name in comparison.common_dirs)


def sync_frontend_dist(*, check: bool = False) -> bool:
    if not FRONTEND_DIST_DIR.is_dir():
        raise FileNotFoundError(
            f"Frontend build output not found at {FRONTEND_DIST_DIR}. Run `npm run build` in frontend/ first."
        )

    if check:
        if not PACKAGE_FRONTEND_DIR.is_dir():
            return False
        return _dirs_match(FRONTEND_DIST_DIR, PACKAGE_FRONTEND_DIR)

    _copy_tree(FRONTEND_DIST_DIR, PACKAGE_FRONTEND_DIR)
    return True


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m ezmsg.dashboard.build_frontend",
        description="Copy frontend/dist into the packaged dashboard asset directory.",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Exit non-zero if packaged assets do not match frontend/dist.",
    )
    return parser


def cmdline(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.check:
        return 0 if sync_frontend_dist(check=True) else 1
    sync_frontend_dist()
    return 0


if __name__ == "__main__":
    raise SystemExit(cmdline())
