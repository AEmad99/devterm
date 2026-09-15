'use strict'

const ptyPack = require('./pty-native-pack.cjs')
const agentPack = require('./agent-closure-pack.cjs')

async function afterPack(context) {
  await ptyPack.afterPack(context)
  await agentPack.afterPack(context)
}

module.exports = afterPack
