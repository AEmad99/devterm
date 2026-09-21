'use strict'

const { existsSync } = require('fs')
const { join } = require('path')
const ptyPack = require('./pty-native-pack.cjs')
const agentPack = require('./agent-closure-pack.cjs')

async function afterPack(context) {
  await ptyPack.afterPack(context)
  await agentPack.afterPack(context)
  const appOut = context.appOutDir
  if (!appOut) return
  const { statSync } = require('fs')
  const isFile = (p) => {
    try {
      return existsSync(p) && statSync(p).isFile()
    } catch {
      return false
    }
  }
  const ico = join(appOut, 'resources', 'icon.ico')
  const png = join(appOut, 'resources', 'icon.png')
  const exeIco = join(appOut, 'icon.ico')
  if (!isFile(ico) && !isFile(png) && !isFile(exeIco)) {
    throw new Error(
      `Packaged logo missing: expected a file at ${ico} or ${png}. extraResources must ship icon.ico/icon.png as files, not directories.`
    )
  }
}

module.exports = afterPack
