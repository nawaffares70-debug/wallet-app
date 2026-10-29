#!/bin/bash
set -e

# This workspace uses package-lock.json and does not commit a pnpm lockfile.
# Do not read or create a local pnpm lock that may contain stale overrides.
pnpm install --lockfile=false --reporter=append-only
pnpm run build:transfers
