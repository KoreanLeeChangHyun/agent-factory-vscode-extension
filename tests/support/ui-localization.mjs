import { runInNewContext } from 'node:vm';
import { createRequire } from 'node:module';
import { withChatFeatures } from './chat-source.mjs';
const i18n = createRequire(import.meta.url)('../../static/js/localization.js');

/** Supply real English resources to existing isolated webview-function harnesses. */
export function runUiInNewContext(source, context = {}, options) {
  const defaults = {
    localize: (key, ...values) => i18n.format(key, 'en', ...values),
    t: (key, ...values) => i18n.format(key, 'en', ...values),
    uiLocale: () => 'en',
    localizedText: (text, descriptor) => i18n.resolve(descriptor, 'en', text),
    reasoningDisplayLabel: value => value || 'Default',
    goalErrorLocalization: undefined,
    AgentFactoryI18n: i18n,
    formatElapsed: value => Math.floor(value / 1000) + 's'
  };
  for (const [key, value] of Object.entries(defaults)) if (!(key in context)) context[key] = value;
  for (const key of ['taskModeNames', 'businessModeNames']) {
    if (context[key] && typeof context[key] !== 'function') {
      const labels = context[key];
      context[key] = () => labels;
    }
  }
  return runInNewContext(source, withChatFeatures(context), options);
}
