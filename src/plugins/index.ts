import type { PluginDef } from '../core/plugin.ts';
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

/** Built-in plugins by name, as referenced from `assignment.yaml` (`plugins: [name]`). */
export const builtinPlugins: Record<string, PluginDef> = {
  'builder-gcc': builderGcc,
  'builder-cmake': builderCmake,
  'builder-custom': builderCustom,
  'steps-basic': stepsBasic,
  'checks-basic': checksBasic,
  'steps-session': stepsSession,
  'checks-source': checksSource,
  'scoring-proportional': scoringProportional,
  'reporter-json': reporterJson,
  'reporter-markdown': reporterMarkdown,
  'reporter-zip': reporterZip,
  'reporter-csv': reporterCsv,
};
