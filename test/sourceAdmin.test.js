import assert from 'node:assert/strict';
import test from 'node:test';

import { findSourcesForSelection, selectSource } from '../src/services/sourceAdmin.js';
import { MemoryTelegramStore } from '../src/storage/memoryStore.js';

function createStore() {
  return new MemoryTelegramStore({
    sources: [
      {
        sourceId: '1001',
        title: 'Project Alpha',
        username: 'project_alpha',
        type: 'Channel',
        enabled: false,
        tags: []
      },
      {
        sourceId: '1002',
        title: 'Project Beta',
        username: 'project_beta',
        type: 'Channel',
        enabled: false,
        tags: []
      },
      {
        sourceId: '2001',
        title: 'Design',
        username: 'design_room',
        type: 'Chat',
        enabled: true,
        tags: ['team']
      }
    ]
  });
}

test('findSourcesForSelection searches disabled sources by default', async () => {
  const store = createStore();
  const result = await findSourcesForSelection(store, { query: 'alpha' });

  assert.equal(result.count, 1);
  assert.equal(result.sources[0].sourceId, '1001');
  assert.equal(result.sources[0].enabled, false);
});

test('selectSource enables a single matched source and applies tags', async () => {
  const store = createStore();
  const result = await selectSource(store, {
    query: 'alpha',
    tags: ['work', 'client']
  });

  assert.equal(result.status, 'selected');
  assert.equal(result.source.sourceId, '1001');
  assert.equal(result.source.enabled, true);
  assert.deepEqual(result.source.tags, ['work', 'client']);

  const [source] = await store.listSources({ includeDisabled: true, sourceIds: ['1001'] });
  assert.equal(source.enabled, true);
});

test('selectSource uses exact source id when query is otherwise ambiguous', async () => {
  const store = createStore();
  const result = await selectSource(store, {
    query: '1002'
  });

  assert.equal(result.status, 'selected');
  assert.equal(result.source.sourceId, '1002');
});

test('selectSource reports ambiguity without enabling sources', async () => {
  const store = createStore();
  const result = await selectSource(store, {
    query: 'project'
  });

  assert.equal(result.status, 'ambiguous');
  assert.equal(result.candidates.length, 2);

  const sources = await store.listSources({ includeDisabled: true, sourceQuery: 'project' });
  assert.deepEqual(sources.map((source) => source.enabled), [false, false]);
});

test('selectSource reports not_found for unknown queries', async () => {
  const store = createStore();
  const result = await selectSource(store, {
    query: 'missing'
  });

  assert.equal(result.status, 'not_found');
  assert.deepEqual(result.candidates, []);
});
