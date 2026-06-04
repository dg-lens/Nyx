const BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const APP_TOKEN = process.env.SLACK_APP_TOKEN;
const CHANNEL = process.env.SLACK_CHANNEL ?? '';

async function postGateBrief(gate, runId, summary) {
  const text = `${gate === 'preview' ? '◧ Preview' : '◨ Review'} gate — run ${runId}\n${summary}`;
  if (!BOT_TOKEN || !CHANNEL) {
    console.log(`[slack] (mock post) ${text}`);
    return;
  }
  const buttons =
    gate === 'preview'
      ? [['Approve', 'go'], ['Revise', 'revise']]
      : [['Proceed', 'proceed'], ['Fix', 'fix']];
  try {
    await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { Authorization: `Bearer ${BOT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel: CHANNEL,
        text,
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text } },
          {
            type: 'actions',
            elements: buttons.map(([label, decision]) => ({
              type: 'button',
              text: { type: 'plain_text', text: label },
              action_id: `nyx_${decision}`,
              value: JSON.stringify({ runId, decision }),
            })),
          },
        ],
      }),
    });
  } catch (err) {
    console.error('[slack] post failed:', err.message);
  }
}

export default {
  setup(ctx) {
    if (ctx.runtime === 'tick') {
      ctx.hooks.on('pipeline.gateReached', async (e) => {
        await postGateBrief(e.gate, e.runId, e.summary);
      });
      ctx.log('outbound gate posts armed');
    }
    if (ctx.runtime === 'host') {
      ctx.io.source('slack', (emit) => {
        if (!APP_TOKEN) {
          ctx.log('Socket Mode idle (no SLACK_APP_TOKEN) — inbound is mocked');
          return;
        }
        ctx.log('Socket Mode would connect here — see README to wire @slack/socket-mode');
        void emit;
      });
    }
  },
};
