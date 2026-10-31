#!/bin/sh
# Type-checks the addon scripts against @minecraft/server 2.0.0 / server-ui 2.0.0 typings.
cd "$(dirname "$0")" && ./node_modules/.bin/tsc -p tsconfig.json --pretty false
