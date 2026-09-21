import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, it } from 'node:test'
import { AnnotationStore, annotationFileName, normalizeAnnotation } from './annotations'

describe('preview annotations', () => {
  it('sanitizes session ids used as filenames', () => {
    assert.equal(annotationFileName('../evil/id'), '__evil_id')
    assert.equal(annotationFileName('preview-abc'), 'preview-abc')
  })

  it('drops malformed rows and clamps coordinates', () => {
    const a = normalizeAnnotation({
      id: 'p1',
      kind: 'rect',
      x: 1.5,
      y: -0.2,
      w: 0.4,
      h: 0.2,
      body: 'n',
      createdAt: 1
    })
    assert.equal(a?.x, 1)
    assert.equal(a?.y, 0)
    assert.equal(normalizeAnnotation({ kind: 'pin' }), null)
  })

  it('round-trips JSON under userData/annotations', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dt-ann-'))
    const store = new AnnotationStore(dir)
    await store.save('s1', [
      { id: 'a', kind: 'pin', x: 0.2, y: 0.3, w: 0, h: 0, body: 'here', createdAt: 9 }
    ])
    const loaded = await store.load('s1')
    assert.equal(loaded.length, 1)
    assert.equal(loaded[0]?.body, 'here')
    const raw = await readFile(join(dir, 'annotations', 's1.json'), 'utf8')
    assert.match(raw, /"pin"/)
  })
})
