import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  memoryDir,
  buildIndex,
  assemble,
  renderPack,
  deriveLoc,
} from '../../apps/dispatcher/dist/memory/arachne.js';

const DATA = process.env.NYX_DATA_DIR || join(homedir(), 'Nyx', 'Data');
const BUDGET = Number(process.env.NYX_MEMORY_BUDGET || 1800);

export default {
  setup(ctx) {
    const dir = memoryDir(DATA);
    ctx.log(`arachne local connection @ ${dir}`);
    ctx.hooks.on('task.promptBuild', (c) => {
      const t = c && c.task;
      if (!t || (t.type !== 'code' && t.type !== 'analysis')) return c;
      try {
        const idx = buildIndex(dir);
        if (idx.length === 0) return c;
        const paths = t.expects || [];
        const pack = assemble(idx, {
          loc: deriveLoc(t.repo, paths),
          role: 'coder',
          paths,
          text: t.description || '',
          budget: BUDGET,
        });
        const block = renderPack(pack);
        if (!block) return c;
        ctx.log(`injected ${pack.ids.length} node(s) (~${pack.tokens}t) for ${t.id}`);
        return { ...c, prompt: `${c.prompt}\n${block}` };
      } catch (err) {
        ctx.log(`skip (no injection): ${err && err.message ? err.message : err}`);
        return c;
      }
    });
  },
};
