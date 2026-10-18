/**
 * Bilingual strings (Persian / English).
 *
 * Flat keys keep lookups trivial; `t()` supports `{name}` interpolation so
 * counts and model names can be embedded without string concatenation.
 */

export const STRINGS = {
  fa: {
    'app.title': 'داشبورد چندعاملی DSH',
    'app.subtitle': 'ارکستراسیون چندعاملی روی DeepSeek Harness',
    'app.langSwitch': 'English',
    'app.theme': 'پوسته',
    'nav.newRun': 'اجرای جدید',
    'nav.history': 'تاریخچه',
    'nav.settings': 'تنظیمات',
    'nav.events': 'رویدادها',

    'status.connected': 'متصل',
    'status.disconnected': 'قطع',
    'status.reconnecting': 'در حال اتصال مجدد…',
    'launcher.title': 'DeepSeek Harness',
    'launcher.found': 'پیدا شد',
    'launcher.notFound': 'پیدا نشد',
    'launcher.mode': 'حالت اجرا',
    'launcher.version': 'نسخه dsh',
    'launcher.profiles': 'پروفایل‌ها',
    'launcher.hint':
      'مسیر launcher را در تنظیمات (DSH_MA_DSH_BIN) یا متغیر محیطی وارد کنید تا داشبورد بتواند اجراها را شروع کند.',
    'launcher.recheck': 'بررسی مجدد',

    'run.title': 'اجرای جدید',
    'run.task': 'وظیفه',
    'run.taskPlaceholder': 'مثلاً: مخزن را بررسی کن، مشکلات امنیتی را پیدا کن و یک گزارش بنویس.',
    'run.cwd': 'پوشهٔ کاری',
    'run.cwdHint': 'هر agent در همین پوشه اجرا می‌شود.',
    'run.mode': 'حالت اجرا',
    'run.mode.pipeline': 'خط لولهٔ داشبورد',
    'run.mode.pipelineHint': 'main نقشه می‌دهد، هر sub-agent با مدل خودش اجرا می‌شود، سپس main جمع‌بندی می‌کند.',
    'run.mode.native': 'بومی DSH',
    'run.mode.nativeHint': 'یک اجرا که خود agent با ابزار subagent خودش delegate می‌کند (همه با مدل main).',
    'run.planning': 'برنامه‌ریزی',
    'run.planning.auto': 'خودکار (main نقشه می‌دهد)',
    'run.planning.manual': 'دستی (از شرح هر agent)',
    'run.concurrency': 'اجرای همزمان',
    'run.timeout': 'مهلت هر agent (دقیقه)',
    'run.timeoutNone': 'بدون مهلت',
    'run.depOutputs': 'خروجی agentهای وابسته به agent بعدی داده شود',
    'run.synthesis': 'دستور اضافه برای جمع‌بندی',
    'run.synthesisPlaceholder': 'مثلاً: خروجی را به فارسی و در قالب گزارش بنویس.',
    'run.start': 'شروع اجرا',
    'run.starting': 'در حال شروع…',
    'run.abort': 'توقف',
    'run.aborting': 'در حال توقف…',
    'run.needsLauncher': 'برای شروع اجرا، ابتدا launcher را در تنظیمات تعیین کنید.',
    'run.needsTask': 'متن وظیفه را وارد کنید.',
    'run.needsModel': 'برای هر agent یک provider و مدل انتخاب کنید.',

    'agents.main': 'agent اصلی',
    'agents.subs': 'sub-agentها',
    'agents.add': 'افزودن sub-agent',
    'agents.remove': 'حذف',
    'agents.name': 'نام',
    'agents.brief': 'شرح نقش / دستور',
    'agents.briefPlaceholder': 'این agent چه کاری انجام می‌دهد؟',
    'agents.persona': 'شخصیت (personaPrefix) — اختیاری',
    'agents.provider': 'Provider',
    'agents.model': 'مدل',
    'agents.effort': 'میزان تفکر',
    'agents.effortDefault': 'پیش‌فرض مدل',
    'agents.dependsOn': 'وابسته به',
    'agents.enabled': 'فعال',
    'agents.noProviders': 'هیچ providerی ثبت نشده است. در تنظیمات، providerها را از پروفایل DSH وارد کنید.',
    'agents.validate': 'اعتبارسنجی',
    'agents.validating': 'در حال بررسی…',
    'agents.valid': 'این مسیر مدل معتبر است.',
    'agents.invalid': 'این مسیر مدل معتبر نیست.',
    'agents.dragHint': 'ترتیب اجرا در حالت «دستی» همین ترتیب است.',

    'stage.plan': 'برنامه‌ریزی',
    'stage.work': 'کار',
    'stage.synthesis': 'جمع‌بندی',
    'stage.native': 'اجرای بومی',
    'stage.nativeHelper': 'کمک‌کننده (بومی)',

    'agent.status.pending': 'در انتظار',
    'agent.status.waiting': 'منتظر وابستگی',
    'agent.status.running': 'در حال اجرا',
    'agent.status.succeeded': 'موفق',
    'agent.status.failed': 'ناموفق',
    'agent.status.skipped': 'رد شد',
    'agent.status.aborted': 'متوقف',

    'run.status.queued': 'در صف',
    'run.status.running': 'در حال اجرا',
    'run.status.succeeded': 'موفق',
    'run.status.failed': 'ناموفق',
    'run.status.aborted': 'متوقف',

    'panel.thinking': 'تفکر مدل',
    'panel.output': 'خروجی',
    'panel.tools': 'ابزارها',
    'panel.messages': 'پیام‌ها',
    'panel.patch': 'فایل patch',
    'panel.session': 'نشست',
    'panel.empty': 'هنوز خروجی‌ای نیست.',
    'panel.noThinking': 'تفکری ثبت نشد.',
    'panel.noTools': 'ابزاری فراخوانی نشد.',
    'panel.tokens': 'توکن',
    'panel.duration': 'مدت',
    'panel.stderr': 'stderr',
    'panel.expand': 'نمایش',
    'panel.collapse': 'بستن',

    'result.title': 'نتیجهٔ نهایی',
    'result.empty': 'نتیجه‌ای ثبت نشد.',
    'result.runLog': 'گزارش اجرا',
    'result.plan': 'نقشه',
    'result.planSource.main-agent': 'توسط agent اصلی',
    'result.planSource.manual': 'دستی',
    'result.warnings': 'هشدارها',

    'history.title': 'تاریخچهٔ اجراها',
    'history.empty': 'هنوز اجرایی ثبت نشده است.',
    'history.open': 'بازکردن',
    'history.refresh': 'به‌روزرسانی',
    'history.live': 'زنده',

    'settings.title': 'تنظیمات',
    'settings.dshSection': 'DeepSeek Harness',
    'settings.bin': 'مسیر launcher (dsh)',
    'settings.binHint': 'خالی بگذارید تا خودکار پیدا شود.',
    'settings.home': 'پوشهٔ DSH_HOME',
    'settings.profile': 'پروفایل',
    'settings.profileHint': 'پیش‌فرض headless است؛ همان پروفایلی که اجرای یک‌بارهٔ dsh را می‌سازد.',
    'settings.runCwd': 'پوشهٔ کاری پیش‌فرض',
    'settings.trust': 'استفاده از اعتبارنامه‌های ذخیره‌شدهٔ DSH',
    'settings.trustHint':
      'پروفایل headless به‌طور پیش‌فرض مخزن اعتبارنامه را خاموش می‌کند؛ با فعال‌بودن این گزینه، همان کلیدها و ورودهایی که در برنامهٔ DSH ذخیره کرده‌اید در اجراها هم قابل استفاده‌اند. هیچ کلیدی به مرورگر فرستاده نمی‌شود.',
    'settings.server': 'سرور',
    'settings.host': 'میزبان',
    'settings.port': 'درگاه',
    'settings.runtime': 'محدودیت‌های اجرا',
    'settings.maxConcurrency': 'حداکثر اجرای همزمان',
    'settings.timeout': 'مهلت پیش‌فرض هر agent (دقیقه)',
    'settings.uiSection': 'رابط کاربری',
    'settings.language': 'زبان',
    'settings.save': 'ذخیرهٔ تنظیمات',
    'settings.saved': 'ذخیره شد.',
    'settings.saving': 'در حال ذخیره…',
    'settings.portHint': 'تغییر درگاه پس از راه‌اندازی مجدد سرور اعمال می‌شود.',

    'providers.title': 'Providerها و مدل‌ها',
    'providers.import': 'وارد کردن از پروفایل DSH',
    'providers.importing': 'در حال خواندن…',
    'providers.imported': '{count} provider وارد شد.',
    'providers.none': 'هیچ providerی وارد نشده است.',
    'providers.keyStatus': 'وضعیت کلید',
    'providers.key.environment': 'در متغیرهای محیطی',
    'providers.key.env-file': 'در فایل .env',
    'providers.key.credential-store': 'از مخزن اعتبارنامهٔ DSH',
    'providers.key.missing': 'پیدا نشد',
    'providers.key.unknown': 'نامشخص',
    'providers.models': 'مدل‌ها',
    'providers.baseURL': 'baseURL',
    'providers.apiKeyEnv': 'متغیر کلید',
    'providers.remove': 'حذف provider',
    'providers.addTitle': 'افزودن provider دستی',
    'providers.add': 'افزودن',
    'providers.name': 'نام provider',
    'providers.sources': 'منابع خوانده‌شده',

    'events.title': 'جریان رویدادها',
    'events.empty': 'رویدادی نیست.',
    'events.clear': 'پاک‌کردن',
    'events.autoscroll': 'اسکرول خودکار',

    'common.close': 'بستن',
    'common.cancel': 'انصراف',
    'common.error': 'خطا',
    'common.ok': 'باشه',
    'common.yes': 'بله',
    'common.no': 'خیر',
    'common.copy': 'کپی',
    'common.copied': 'کپی شد',
    'common.seconds': 'ثانیه',
    'common.loading': 'در حال بارگذاری…',
  },

  en: {
    'app.title': 'DSH Multi-Agent Dashboard',
    'app.subtitle': 'Multi-agent orchestration on DeepSeek Harness',
    'app.langSwitch': 'فارسی',
    'app.theme': 'Theme',
    'nav.newRun': 'New run',
    'nav.history': 'History',
    'nav.settings': 'Settings',
    'nav.events': 'Events',

    'status.connected': 'Live',
    'status.disconnected': 'Offline',
    'status.reconnecting': 'Reconnecting…',
    'launcher.title': 'DeepSeek Harness',
    'launcher.found': 'found',
    'launcher.notFound': 'not found',
    'launcher.mode': 'launch mode',
    'launcher.version': 'dsh version',
    'launcher.profiles': 'profiles',
    'launcher.hint':
      'Set the launcher path in Settings (DSH_MA_DSH_BIN) or as an environment variable so the dashboard can start runs.',
    'launcher.recheck': 'Re-check',

    'run.title': 'New run',
    'run.task': 'Task',
    'run.taskPlaceholder': 'e.g. Audit the repository, find security problems, and write a report.',
    'run.cwd': 'Working directory',
    'run.cwdHint': 'Every agent runs in this directory.',
    'run.mode': 'Mode',
    'run.mode.pipeline': 'Dashboard pipeline',
    'run.mode.pipelineHint': 'The lead plans, each sub-agent runs on its own model, then the lead synthesises.',
    'run.mode.native': 'Native DSH',
    'run.mode.nativeHint': 'One run where the lead delegates with DSH sub-agent tools (all on the lead model).',
    'run.planning': 'Planning',
    'run.planning.auto': 'Automatic (the lead plans)',
    'run.planning.manual': 'Manual (use each agent brief)',
    'run.concurrency': 'Concurrent agents',
    'run.timeout': 'Per-agent timeout (minutes)',
    'run.timeoutNone': 'No timeout',
    'run.depOutputs': 'Pass dependency outputs to the next agent',
    'run.synthesis': 'Extra synthesis instructions',
    'run.synthesisPlaceholder': 'e.g. Write the final answer as a short report with bullet points.',
    'run.start': 'Start run',
    'run.starting': 'Starting…',
    'run.abort': 'Abort',
    'run.aborting': 'Aborting…',
    'run.needsLauncher': 'Set a launcher in Settings before starting a run.',
    'run.needsTask': 'Enter the task text.',
    'run.needsModel': 'Choose a provider and model for every agent.',

    'agents.main': 'Main agent',
    'agents.subs': 'Sub-agents',
    'agents.add': 'Add sub-agent',
    'agents.remove': 'Remove',
    'agents.name': 'Name',
    'agents.brief': 'Role brief / instructions',
    'agents.briefPlaceholder': 'What should this agent do?',
    'agents.persona': 'Persona (personaPrefix) — optional',
    'agents.provider': 'Provider',
    'agents.model': 'Model',
    'agents.effort': 'Reasoning effort',
    'agents.effortDefault': 'Model default',
    'agents.dependsOn': 'Depends on',
    'agents.enabled': 'Enabled',
    'agents.noProviders': 'No providers yet. Import them from your DSH profile in Settings.',
    'agents.validate': 'Validate',
    'agents.validating': 'Checking…',
    'agents.valid': 'This model route is valid.',
    'agents.invalid': 'This model route is not valid.',
    'agents.dragHint': 'In manual planning this order is the execution order.',

    'stage.plan': 'Planning',
    'stage.work': 'Work',
    'stage.synthesis': 'Synthesis',
    'stage.native': 'Native run',
    'stage.nativeHelper': 'Helper (native)',

    'agent.status.pending': 'Pending',
    'agent.status.waiting': 'Waiting on dependency',
    'agent.status.running': 'Running',
    'agent.status.succeeded': 'Succeeded',
    'agent.status.failed': 'Failed',
    'agent.status.skipped': 'Skipped',
    'agent.status.aborted': 'Aborted',

    'run.status.queued': 'Queued',
    'run.status.running': 'Running',
    'run.status.succeeded': 'Succeeded',
    'run.status.failed': 'Failed',
    'run.status.aborted': 'Aborted',

    'panel.thinking': 'Model reasoning',
    'panel.output': 'Output',
    'panel.tools': 'Tools',
    'panel.messages': 'Messages',
    'panel.patch': 'Patch file',
    'panel.session': 'Session',
    'panel.empty': 'No output yet.',
    'panel.noThinking': 'No reasoning recorded.',
    'panel.noTools': 'No tool calls.',
    'panel.tokens': 'tokens',
    'panel.duration': 'duration',
    'panel.stderr': 'stderr',
    'panel.expand': 'Show',
    'panel.collapse': 'Hide',

    'result.title': 'Final answer',
    'result.empty': 'No answer was recorded.',
    'result.runLog': 'Run log',
    'result.plan': 'Plan',
    'result.planSource.main-agent': 'by the lead agent',
    'result.planSource.manual': 'manual',
    'result.warnings': 'Warnings',

    'history.title': 'Run history',
    'history.empty': 'No runs yet.',
    'history.open': 'Open',
    'history.refresh': 'Refresh',
    'history.live': 'live',

    'settings.title': 'Settings',
    'settings.dshSection': 'DeepSeek Harness',
    'settings.bin': 'Launcher path (dsh)',
    'settings.binHint': 'Leave empty to auto-detect.',
    'settings.home': 'DSH_HOME directory',
    'settings.profile': 'Profile',
    'settings.profileHint': 'Defaults to headless — the profile built for one-shot dsh runs.',
    'settings.runCwd': 'Default working directory',
    'settings.trust': 'Use credentials stored by DSH',
    'settings.trustHint':
      'The headless profile disables the managed credential store. With this on, the keys and sign-ins already saved by the Harness app resolve inside runs too. No credential is ever sent to the browser.',
    'settings.server': 'Server',
    'settings.host': 'Host',
    'settings.port': 'Port',
    'settings.runtime': 'Run limits',
    'settings.maxConcurrency': 'Max concurrent agents',
    'settings.timeout': 'Default per-agent timeout (minutes)',
    'settings.uiSection': 'Interface',
    'settings.language': 'Language',
    'settings.save': 'Save settings',
    'settings.saved': 'Saved.',
    'settings.saving': 'Saving…',
    'settings.portHint': 'A port change applies after the server restarts.',

    'providers.title': 'Providers and models',
    'providers.import': 'Import from DSH profile',
    'providers.importing': 'Reading…',
    'providers.imported': 'Imported {count} provider(s).',
    'providers.none': 'No providers imported yet.',
    'providers.keyStatus': 'Key status',
    'providers.key.environment': 'in the environment',
    'providers.key.env-file': 'in a .env file',
    'providers.key.credential-store': 'from the DSH credential store',
    'providers.key.missing': 'not found',
    'providers.key.unknown': 'unknown',
    'providers.models': 'Models',
    'providers.baseURL': 'baseURL',
    'providers.apiKeyEnv': 'API key env',
    'providers.remove': 'Remove provider',
    'providers.addTitle': 'Add a provider manually',
    'providers.add': 'Add',
    'providers.name': 'Provider name',
    'providers.sources': 'Sources read',

    'events.title': 'Event stream',
    'events.empty': 'No events.',
    'events.clear': 'Clear',
    'events.autoscroll': 'Auto-scroll',

    'common.close': 'Close',
    'common.cancel': 'Cancel',
    'common.error': 'Error',
    'common.ok': 'OK',
    'common.yes': 'Yes',
    'common.no': 'No',
    'common.copy': 'Copy',
    'common.copied': 'Copied',
    'common.seconds': 's',
    'common.loading': 'Loading…',
  },
};

export const LANGUAGES = ['fa', 'en'];

let current = 'fa';

export function getLang() {
  return current;
}

export function setLang(lang) {
  current = LANGUAGES.includes(lang) ? lang : 'fa';
  return current;
}

export function direction(lang = current) {
  return lang === 'fa' ? 'rtl' : 'ltr';
}

/** Translate a key, interpolating `{name}` placeholders. */
export function t(key, vars) {
  const table = STRINGS[current] ?? STRINGS.en;
  const fallback = STRINGS.en;
  let text = table[key] ?? fallback[key] ?? key;
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      text = text.replaceAll(`{${name}}`, String(value));
    }
  }
  return text;
}

/** Localised number formatting. */
export function formatNumber(value) {
  const num = Number(value) || 0;
  return new Intl.NumberFormat(current === 'fa' ? 'fa-IR' : 'en-US').format(num);
}

export function formatDuration(ms) {
  if (!ms || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} ${t('common.seconds')}`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

export function formatTime(ts) {
  if (!ts) return '—';
  return new Intl.DateTimeFormat(current === 'fa' ? 'fa-IR' : 'en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(ts));
}