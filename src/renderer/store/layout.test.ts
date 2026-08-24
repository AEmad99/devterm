import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DEFAULT_GROUP, useLayout } from './layout'

describe('splitBeside', () => {
  it('pulls a sibling tab into a right-hand split so both panes stay on screen', () => {
    useLayout.setState({
      groups: [
        {
          id: DEFAULT_GROUP,
          name: 'Terminals',
          root: { type: 'leaf', id: 'leaf-1', tabs: ['local-1'], active: 'local-1' },
          activeLeaf: 'leaf-1'
        }
      ],
      activeGroupId: DEFAULT_GROUP,
      focusedId: 'local-1',
      groupFlags: {}
    })
    useLayout.getState().sync([
      { id: 'local-1', groupId: DEFAULT_GROUP },
      { id: 'browser-1', groupId: DEFAULT_GROUP }
    ])
    useLayout.getState().splitBeside('local-1', 'browser-1', 'right')
    const g = useLayout.getState().groups[0]
    assert.equal(g.root?.type, 'split')
    if (g.root?.type !== 'split') return
    assert.equal(g.root.dir, 'row')
    assert.equal(g.root.children.length, 2)
    const left = g.root.children[0]
    const right = g.root.children[1]
    assert.equal(left.type, 'leaf')
    assert.equal(right.type, 'leaf')
    if (left.type !== 'leaf' || right.type !== 'leaf') return
    assert.deepEqual(left.tabs, ['local-1'])
    assert.deepEqual(right.tabs, ['browser-1'])
    assert.equal(useLayout.getState().focusedId, null)
  })
})
