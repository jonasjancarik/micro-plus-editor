#!/bin/bash
# Starts the Micro Plus editor on port 8080. Options are passed to server/mmp_web.py.
cd "$(dirname "$0")" || exit 1
python=${MICRO_PLUS_PYTHON:-.venv/bin/python}
if [ ! -x "$python" ]; then
    echo 'Set MICRO_PLUS_PYTHON to a Python 3.11+ interpreter with Bleak installed.' >&2
    echo 'See docs/MUSTANG_MICRO_PLUS_MACOS.md for setup.' >&2
    exit 1
fi
exec "$python" server/mmp_web.py "$@"
