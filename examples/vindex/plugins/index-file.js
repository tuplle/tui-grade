// Step `index_file { file }`: indexes a text file through the student program (`index FILE`) and keeps
// vindex_index.txt in the scenario workdir. It replaces `indexFile` of the old hand-written test project
// (copy the text into the workdir first, e.g. with the built-in `copy` step).
import { definePlugin, runSetup, z } from './support.js';

const params = z.strictObject({ file: z.string().min(1) });

export default definePlugin(
  (app) => {
    app.step('index_file', {
      description: 'Setup: indexes a file of the scenario workdir by running `index FILE` of the student program.',
      example: '- index_file: { file: one-word.txt }',
      params,
      async run(ctx, p) {
        const { file } = ctx.interpolate(p);
        await runSetup(ctx, 'index_file', ['index', file], 'vindex_index.txt');
      },
    });
  },
  { name: 'vindex-index-file' },
);
