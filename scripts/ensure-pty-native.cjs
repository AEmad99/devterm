'use strict'
/**
 * Run before electron-builder so node-pty's package.json `files` includes
 * `build/` *before* the dependency collector walks the tree. beforePack is a
 * second line of defense; this is the one that cannot be too late.
 */
require('./pty-native-pack.cjs').prepareNodePtyForPack(process.cwd())
