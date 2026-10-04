#!/usr/bin/env python3
"""Git merge driver for official.txt and schedule.txt.

A results run and a ratings run can both write those files. This keeps every
finished match from both sides instead of dropping one side in a rebase.
"""
import sys

from fast_update import blend_text


def main():
    path_a, path_b = sys.argv[1], sys.argv[2]
    with open(path_a, encoding="utf-8") as f:
        current = f.read()
    with open(path_b, encoding="utf-8") as f:
        other = f.read()
    with open(path_a, "w", encoding="utf-8") as f:
        f.write(blend_text(current, other))
    return 0


if __name__ == "__main__":
    sys.exit(main())
