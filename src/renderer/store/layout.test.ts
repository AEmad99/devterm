import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DEFAULT_GROUP, HOME_GROUP_NAME, useLayout } from './layout'

describe('home group', () => {
  it('keeps a fresh terminal inside the single home group', () => {
    useLayout.setState({
      groups: [{ id: DEFAULT_GROUP, name: HOME_GROUP_NAME, root: null, activeLeaf: null }],
      activeGroupId: DEFAULT_GROUP,
      focusedId: null,
      groupFlags: {}
    })
    useLayout.getState().sync([{ id: 'local-1' }])
    const { groups, activeGroupId } = useLayout.getState()
    assert.equal(groups.length, 1)
    assert.equal(activeGroupId, DEFAULT_GROUP)
    assert.equal(groups[0]?.name, HOME_GROUP_NAME)
    assert.equal(groups[0]?.root?.type, 'leaf')
    if (groups[0]?.root?.type !== 'leaf') return
    assert.deepEqual(groups[0].root.tabs, ['local-1'])
  })

  it('names the next group after the home group', () => {
    useLayout.setState({
      groups: [{ id: DEFAULT_GROUP, name: HOME_GROUP_NAME, root: null, activeLeaf: null }],
      activeGroupId: DEFAULT_GROUP,
      focusedId: null,
      groupFlags: {}
    })
    const id = useLayout.getState().createGroup()
    const created = useLayout.getState().groups.find((g) => g.id === id)
    assert.equal(created?.name, 'Group 2')
    assert.equal(useLayout.getState().activeGroupId, id)
    assert.equal(useLayout.getState().groups[0]?.id, DEFAULT_GROUP)
  })
})

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

  it('places a prescribed new id on the source session leaf', () => {
    useLayout.setState({
      groups: [
        {
          id: DEFAULT_GROUP,
          name: 'Terminals',
          root: {
            type: 'split',
            id: 'split-1',
            dir: 'row',
            sizes: [0.5, 0.5],
            children: [
              { type: 'leaf', id: 'leaf-source', tabs: ['source'], active: 'source' },
              { type: 'leaf', id: 'leaf-other', tabs: ['other'], active: 'other' }
            ]
          },
          activeLeaf: 'leaf-other'
        }
      ],
      activeGroupId: DEFAULT_GROUP,
      focusedId: null,
      groupFlags: {}
    })
    useLayout.getState().sync([
      { id: 'source', groupId: DEFAULT_GROUP },
      { id: 'other', groupId: DEFAULT_GROUP },
      { id: 'delegated', groupId: DEFAULT_GROUP }
    ])
    assert.equal(useLayout.getState().addTabToSessionLeaf('source', 'delegated'), true)
    const root = useLayout.getState().groups[0].root
    assert.equal(root?.type, 'split')
    if (root?.type !== 'split') return
    assert.deepEqual(root.children[0].type === 'leaf' ? root.children[0].tabs : [], [
      'source',
      'delegated'
    ])
    assert.deepEqual(root.children[1].type === 'leaf' ? root.children[1].tabs : [], ['other'])
  })

  it('renames several pending SSH tabs in place when handshakes settle together', () => {
    useLayout.setState({
      groups: [
        {
          id: DEFAULT_GROUP,
          name: 'Terminals',
          root: {
            type: 'leaf',
            id: 'leaf-pending',
            tabs: ['pending-a', 'pending-b'],
            active: 'pending-b'
          },
          activeLeaf: 'leaf-pending'
        }
      ],
      activeGroupId: DEFAULT_GROUP,
      focusedId: null,
      groupFlags: {}
    })
    useLayout.getState().sync([
      { id: 'pending-a', groupId: DEFAULT_GROUP },
      { id: 'pending-b', groupId: DEFAULT_GROUP }
    ])
    useLayout.getState().sync([
      { id: 'ssh-a', groupId: DEFAULT_GROUP },
      { id: 'ssh-b', groupId: DEFAULT_GROUP }
    ])
    const root = useLayout.getState().groups[0].root
    assert.equal(root?.type, 'leaf')
    if (root?.type !== 'leaf') return
    assert.deepEqual(root.tabs, ['ssh-a', 'ssh-b'])
    assert.equal(root.active, 'ssh-b')
  })
})
