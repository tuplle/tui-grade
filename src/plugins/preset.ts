import { fp } from '../core/plugin.ts';
import { builderCmake } from './builder-cmake/index.ts';
import { builderCustom } from './builder-custom/index.ts';
import { builderGcc } from './builder-gcc/index.ts';
import { checksBasic } from './checks-basic/index.ts';
import { checksSource } from './checks-source/index.ts';
import { reporterCsv } from './reporter-csv/index.ts';
import { reporterJson } from './reporter-json/index.ts';
import { reporterMarkdown } from './reporter-markdown/index.ts';
import { reporterZip } from './reporter-zip/index.ts';
import { scoringProportional } from './scoring-proportional/index.ts';
import { stepsBasic } from './steps-basic/index.ts';
import { stepsSession } from './steps-session/index.ts';

/** The default preset: everything a typical assignment needs. Later tasks register their parts here. */
export const defaultPreset = fp(
  async (app) => {
    await app.register(builderGcc);
    await app.register(builderCmake);
    await app.register(builderCustom);
    await app.register(stepsBasic);
    await app.register(checksBasic);
    await app.register(stepsSession);
    await app.register(checksSource);
    await app.register(scoringProportional);
    // Order matters: the zip packs the student's output directory, so json and markdown must be written first.
    await app.register(reporterJson);
    await app.register(reporterMarkdown);
    await app.register(reporterZip);
    await app.register(reporterCsv);
  },
  { name: 'preset-default' },
);
