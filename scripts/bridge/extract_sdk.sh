#!/usr/bin/env bash
# Extract the pinned Muse Gadget SDK Python sources (linux/src) into a directory.
# Usage: scripts/bridge/extract_sdk.sh <sdk-git-checkout> <out-dir> [commit]
set -euo pipefail
sdk=${1:?sdk checkout}
out=${2:?output dir}
commit=${3:-e17081a}
mkdir -p "$out"
git -C "$sdk" archive "$commit" linux/src | tar -x -C "$out"
echo "$out/linux/src"
