import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { placeAgentBrowser, revealBrowserPane } from './browser-control'
import { useSessions } from '../store/sessions'
import { allLeaves, DEFAULT_GROUP, useLayout } from '../store/layout'

function reset(): void {
  useSessions.setState({ sessions: [], activeId: null, lastActiveId: null })
  useLayout.setState({
    groups: [{ id: DEFAULT_GROUP, name: 'Group 1', root: null, activeLeaf: null }],
    activeGroupId: DEFAULT_GROUP,
    focusedId: null,
    groupFlags: {}
  })
}

describe('placeAgentBrowser', () => {
  afterEach(() => reset())

  it('keeps the operator on their terminal when an agent opens a browser beside a multi-tab pane', () => {
    useLayout.setState({
      groups: [
        {
          id: DEFAULT_GROUP,
          name: 'Group 1',
          root: {
            type: 'leaf',
            id: 'leaf-1',
            tabs: ['term-a', 'term-b', 'term-c'],
            active: 'term-b'
          },
          activeLeaf: 'leaf-1'
        }
      ],
      activeGroupId: DEFAULT_GROUP,
      focusedId: 'term-b',
      groupFlags: {}
    })
    useSessions.setState({
      sessions: [{ id: 'term-b', kind: 'local', title: 'Local', groupId: DEFAULT_GROUP }],
      activeId: 'term-b',
      lastActiveId: null
    })

    placeAgentBrowser({
      tabKey: 'agt-1',
      url: 'https://app.test/',
      ownerAgentSessionId: 'term-b',
      groupId: DEFAULT_GROUP
    })

    const root = useLayout.getState().groups[0].root
    assert.equal(root?.type, 'split')
    if (root?.type !== 'split') return
    const terminal = root.children.find(
      (child) => child.type === 'leaf' && child.tabs.includes('term-b')
    )
    const browser = root.children.find(
      (child) => child.type === 'leaf' && child.tabs.some((id) => id.startsWith('browser-'))
    )
    assert.equal(terminal?.type, 'leaf')
    assert.equal(browser?.type, 'leaf')
    if (terminal?.type !== 'leaf' || browser?.type !== 'leaf') return
    assert.deepEqual(terminal.tabs, ['term-a', 'term-b', 'term-c'])
    assert.equal(terminal.active, 'term-b')
    assert.equal(browser.tabs.length, 1)
    assert.equal(useSessions.getState().activeId, 'term-b')
    assert.equal(useLayout.getState().activeGroupId, DEFAULT_GROUP)
    assert.equal(useLayout.getState().focusedId, 'term-b')
    assert.equal(useLayout.getState().groups[0].activeLeaf, 'leaf-1')
    const created = useSessions.getState().sessions.find((session) => session.kind === 'browser')
    assert.equal(created?.agentOwnedBy, 'term-b')
    assert.equal(created?.firstTabKey, 'agt-1')
  })

  it('does not switch groups when the agent lives in a group the operator is not viewing', () => {
    useLayout.setState({
      groups: [
        {
          id: DEFAULT_GROUP,
          name: 'Group 1',
          root: { type: 'leaf', id: 'leaf-user', tabs: ['user-term'], active: 'user-term' },
          activeLeaf: 'leaf-user'
        },
        {
          id: 'grp-2',
          name: 'Group 2',
          root: { type: 'leaf', id: 'leaf-agent', tabs: ['agent-term'], active: 'agent-term' },
          activeLeaf: 'leaf-agent'
        }
      ],
      activeGroupId: DEFAULT_GROUP,
      focusedId: null,
      groupFlags: {}
    })
    useSessions.setState({
      sessions: [
        { id: 'user-term', kind: 'local', title: 'Mine', groupId: DEFAULT_GROUP },
        { id: 'agent-term', kind: 'remote', title: 'Agent', groupId: 'grp-2' }
      ],
      activeId: 'user-term',
      lastActiveId: null
    })

    placeAgentBrowser({
      tabKey: 'agt-2',
      url: 'https://app.test/admin',
      ownerAgentSessionId: 'agent-term',
      groupId: 'grp-2'
    })

    assert.equal(useLayout.getState().activeGroupId, DEFAULT_GROUP)
    assert.equal(useSessions.getState().activeId, 'user-term')
    const user = useLayout.getState().groups.find((group) => group.id === DEFAULT_GROUP)
    assert.equal(user?.root?.type, 'leaf')
    if (user?.root?.type === 'leaf') assert.deepEqual(user.root.tabs, ['user-term'])
    const agentGroup = useLayout.getState().groups.find((group) => group.id === 'grp-2')
    const leaves = allLeaves(agentGroup?.root ?? null)
    assert.equal(leaves.length, 2)
    assert.equal(
      leaves.some((leaf) => leaf.tabs.includes('agent-term') && leaf.active === 'agent-term'),
      true
    )
    assert.equal(
      leaves.some((leaf) => leaf.tabs.some((id) => id.startsWith('browser-'))),
      true
    )
    assert.equal(agentGroup?.activeLeaf, 'leaf-agent')
  })

  it('does not retarget the operator when the agent drives a browser in another group', () => {
    useLayout.setState({
      groups: [
        {
          id: DEFAULT_GROUP,
          name: 'Group 1',
          root: {
            type: 'leaf',
            id: 'leaf-user',
            tabs: ['user-term', 'other-term'],
            active: 'user-term'
          },
          activeLeaf: 'leaf-user'
        },
        {
          id: 'grp-2',
          name: 'Group 2',
          root: { type: 'leaf', id: 'leaf-browser', tabs: ['browser-1'], active: 'browser-1' },
          activeLeaf: 'leaf-browser'
        }
      ],
      activeGroupId: DEFAULT_GROUP,
      focusedId: 'user-term',
      groupFlags: {}
    })
    useSessions.setState({
      sessions: [
        { id: 'user-term', kind: 'local', title: 'Mine', groupId: DEFAULT_GROUP },
        { id: 'other-term', kind: 'local', title: 'Other', groupId: DEFAULT_GROUP },
        { id: 'browser-1', kind: 'browser', title: 'Browser', groupId: 'grp-2' }
      ],
      activeId: 'user-term',
      lastActiveId: null
    })

    revealBrowserPane('browser-1')

    assert.equal(useLayout.getState().activeGroupId, DEFAULT_GROUP)
    assert.equal(useSessions.getState().activeId, 'user-term')
    assert.equal(useLayout.getState().focusedId, 'user-term')
    const user = useLayout.getState().groups.find((group) => group.id === DEFAULT_GROUP)
    assert.equal(user?.activeLeaf, 'leaf-user')
    assert.equal(user?.root?.type, 'leaf')
    if (user?.root?.type === 'leaf') assert.equal(user.root.active, 'user-term')
  })
})
