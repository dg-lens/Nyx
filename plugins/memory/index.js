const BACKEND = process.env.NYX_MEMORY_BACKEND ?? 'local-obsidian';

export default {
  setup(ctx) {
    ctx.log(`backend=${BACKEND}`);
    ctx.hooks.on('task.promptBuild', (c) => {
      const type = c?.task?.type;
      if (type !== 'code' && type !== 'analysis') return c;
      const note = [
        '',
        '## MEMORY',
        '',
        `A \`memory\` graph is configured (backend: ${BACKEND}). Consult prior invariants, lessons, decisions, and conventions before reinventing or repeating a known mistake; record durable lessons as you go.`,
      ].join('\n');
      return { ...c, prompt: `${c.prompt}${note}` };
    });
  },
};
