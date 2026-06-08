import { strict as assert } from 'node:assert';
import { describe, test, before, after } from 'node:test';

import { makePool, applyMigration, loadActiveNodes, getNode, writeNode, recordUsage, type Pool } from '../src/db.js';
import { hashToken, verifyToken } from '../src/auth.js';

// Integration coverage against a real Postgres. Skips unless TEST_DATABASE_URL is
// set (e.g. a docker postgres locally / in CI), so the default suite stays green
// on a box without a database.
const URL = process.env['TEST_DATABASE_URL'];

describe('arachne-server Postgres integration', { skip: !URL }, () => {
  let pool: Pool;

  before(async () => {
    pool = makePool(URL!);
    await applyMigration(pool);
    await pool.query('DELETE FROM edges; DELETE FROM node_usage; DELETE FROM write_log; DELETE FROM nodes; DELETE FROM platforms;');
    await pool.query('INSERT INTO platforms (id, name, token_hash, scopes) VALUES ($1,$2,$3,$4)', ['testp', 'Test', hashToken('secret-token'), ['read', 'write']]);
  });

  after(async () => { await pool.end(); });

  test('verifyToken resolves a platform by token hash', async () => {
    assert.equal((await verifyToken(pool, 'secret-token'))?.id, 'testp');
    assert.equal(await verifyToken(pool, 'wrong'), null);
  });

  test('writeNode upserts + edges + write_log; loadActiveNodes/getNode read it back', async () => {
    await writeNode(pool, {
      id: 'Test Lesson!', kind: 'lesson', title: 'T', summary: 's', body: 'SYMPTOM: x\nFIX: y',
      loc: ['stack.nyx'], triggers: ['xyz'], edges: { relates: ['other-node'] },
    }, 'testp');
    const got = await getNode(pool, 'test-lesson-');
    assert.equal(got?.kind, 'lesson');
    assert.deepEqual(got?.loc, ['stack.nyx']);
    const idx = await loadActiveNodes(pool);
    assert.ok(idx.some((n) => n.id === 'test-lesson-'));
    const edges = await pool.query('SELECT rel, dst_id FROM edges WHERE src_id=$1', ['test-lesson-']);
    assert.deepEqual(edges.rows, [{ rel: 'relates', dst_id: 'other-node' }]);
    const wl = await pool.query('SELECT op FROM write_log WHERE node_id=$1', ['test-lesson-']);
    assert.equal(wl.rows[0]?.op, 'create');
  });

  test('recordUsage inserts feedback rows', async () => {
    await recordUsage(pool, ['test-lesson-'], 'testp', true, 'success');
    const u = await pool.query('SELECT cited, task_outcome FROM node_usage WHERE node_id=$1', ['test-lesson-']);
    assert.equal(u.rows[0]?.cited, true);
  });
});
