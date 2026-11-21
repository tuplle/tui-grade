import { stripTypeScriptTypes } from 'node:module';

export default {
  process(src, filename) {
    return { code: stripTypeScriptTypes(src, { mode: 'strip', sourceUrl: filename }) };
  },
};
