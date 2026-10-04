/**
 * Pre-commit lint tasks.
 *
 * `HDdaraAi` is a separate uni-app project with its own Vue/uni-app ESLint
 * config, TypeScript settings and Prettier style. The Next.js rules in this
 * repository cannot parse its sources, so its files are filtered out here rather
 * than being handed to the gateway's toolchain. Run `npm run lint` inside
 * `HDdaraAi` to check the app.
 */
const APP_DIR_PREFIX = 'HDdaraAi/';

const withoutApp = (files) =>
  files.filter((file) => !file.startsWith(APP_DIR_PREFIX));

export default {
  '*.{ts,tsx}': (files) => {
    const targets = withoutApp(files);

    if (!targets.length) {
      return [];
    }

    const quoted = targets.map((file) => JSON.stringify(file)).join(' ');

    return [
      `eslint --max-warnings=0 --no-warn-ignored --fix ${quoted}`,
      `prettier --check ${quoted}`,
    ];
  },
  '*.{json,md,yml,yaml,css}': (files) => {
    const targets = withoutApp(files);

    return targets.length
      ? `prettier --check ${targets.map((file) => JSON.stringify(file)).join(' ')}`
      : [];
  },
};
