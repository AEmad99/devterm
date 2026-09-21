'use strict'

const { existsSync } = require('fs')
const { join } = require('path')
const ptyPack = require('./pty-native-pack.cjs')
const agentPack = require('./agent-closure-pack.cjs')

async function afterPack(context) {
  await ptyPack.afterPack(context)
  await agentPack.afterPack(context)
  const resources = context.appOutDir
    ? join(context.appOutDir, 'resources')
    : null
  if (resources) {
    const ico = join(resources, 'icon.ico')
    const png = join(resources, 'icon.png')
    if (!existsSync(ico) && !existsSync(png)) {
      throw new Error(
        `Packaged logo missing: expected ${ico} or ${png}. extraResources must ship icon.ico/icon.png.`
      )
    }
  }
}

module.exports = afterPack
