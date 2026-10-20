/**
 * dsh-multi-agent dashboard — no build step, no framework.
 *
 * State lives in one object; views render from it. During a run the timeline is
 * patched in place (never re-rendered) so streaming text and scroll position
 * survive the flood of events.
 */
import {
  direction,
  formatDuration,
  formatNumber,
  formatTime,
  getLang,
  setLang,
  t,
} from './i18n.js';
import { api, openEventStream } from './api.js';

/* ------------------------------------------------------------------- state */

const state = {
  settings: null,
  providers: [],
  engines: [],
  engineDrafts: new Map(),
  engineTests: new Map(),
  hiddenEngines: [],
  info: null,
  stateDir: null,
  providersMeta: { sources: [], warnings: [] },
  runOptions: {
    task: '',
    cwd: '',
    mode: 'pipeline',
    planning: 'auto',
    concurrency: 4,
    timeoutMin: 30,
    includeDependencyOutput: true,
    synthesisInstructions: '',
  },
  runs: [],
  activeRunId: null,
  activeRun: null,
  events: [],
  connection: 'connecting',
  autoScroll: true,
  view: 'run',
  notice: null,
  validation: new Map(),
};

const refs = new Map();
let settingsSaveTimer = null;

/* --------------------------------------------------------------- DOM helper */

function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style') Object.assign(node.style, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'value') node.value = value;
    else if (key === 'checked' || key === 'disabled' || key === 'selected' || key === 'hidden') {
      node[key] = Boolean(value);
    } else node.setAttribute(key, String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function $(selector, root = document) {
  return root.querySelector(selector);
}

function providerOf(name) {
  return state.providers.find((provider) => provider.name === name) ?? null;
}

function modelOf(providerName, modelId) {
  const provider = providerOf(providerName);
  if (!provider) return null;
  return provider.models.find((model) => model.id === modelId) ?? null;
}

function effortOptions(choice) {
  const model = modelOf(choice.provider, choice.model);
  const efforts = model && model.reasoningEfforts ? Object.keys(model.reasoningEfforts) : [];
  return ['', ...efforts];
}

/* ------------------------------------------------------------------ notices */

function notify(message, tone = 'info') {
  state.notice = { message, tone, at: Date.now() };
  renderNotice();
  if (tone !== 'error') {
    setTimeout(() => {
      if (state.notice && Date.now() - state.notice.at >= 4000) {
        state.notice = null;
        renderNotice();
      }
    }, 4200);
  }
}

function renderNotice() {
  const host = $('#notice');
  if (!host) return;
  clear(host);
  if (!state.notice) return;
  host.append(h('div', { class: `notice notice-${state.notice.tone}` }, state.notice.message,
    h('button', { class: 'notice-close', onclick: () => { state.notice = null; renderNotice(); } }, '×')));
}

/* --------------------------------------------------------------- data load */

async function bootstrap() {
  const stored = localStorage.getItem('dsh-ma-lang');
  setLang(stored || 'fa');
  buildShell();
  try {
    const [settingsResponse, infoResponse, runsResponse] = await Promise.all([
      api.getSettings(),
      api.info(),
      api.listRuns(),
    ]);
    state.settings = settingsResponse.settings;
    state.info = infoResponse.info;
    state.stateDir = infoResponse.stateDir;
    state.runs = runsResponse.runs;
    if (!stored && state.settings?.ui?.language) setLang(state.settings.ui.language);
    hydrateFromSettings();
    await Promise.all([refreshProviders(), refreshEngines()]);
    render();
  } catch (error) {
    notify(String(error.message ?? error), 'error');
  }
  connectStream();
}

function hydrateFromSettings() {
  const settings = state.settings;
  if (!settings) return;
  state.runOptions.cwd = settings.dsh.runCwd ?? '';
  state.runOptions.concurrency = settings.runs?.maxConcurrency ?? 4;
  state.runOptions.timeoutMin = Math.round((settings.runs?.timeoutMs ?? 1800000) / 60000);
}

async function refreshProviders() {
  try {
    const response = await api.getProviders();
    state.providers = response.providers ?? [];
  } catch (error) {
    notify(String(error.message ?? error), 'error');
  }
}

async function refreshEngines(force = false) {
  try {
    const response = await api.listEngines();
    state.engines = response.engines ?? [];
    state.hiddenEngines = response.hidden ?? [];
    if (force) invalidateDrafts();
  } catch (error) {
    notify(String(error.message ?? error), 'error');
  }
}

function invalidateDrafts() {
  state.engineDrafts.clear();
}

function engineById(id) {
  const key = id && id !== '' ? id : 'dsh';
  return state.engines.find((engine) => engine.id === key) ?? null;
}

function runnableEngines() {
  return state.engines.filter((engine) => engine.canRun);
}

/** How an agent's engine + model should be summarised in the UI. */
function agentEngineLabel(agent) {
  const engine = engineById(agent.engine);
  if (!engine) return agent.engine ?? 'dsh';
  if (engine.kind === 'dsh') {
    return `${engine.label} · ${agent.model?.provider ?? '—'} / ${agent.model?.model ?? '—'}`;
  }
  return `${engine.label}${agent.cliModel ? ` · ${agent.cliModel}` : ''}`;
}

function defaultEngineChoice() {
  const dsh = engineById('dsh');
  if (dsh && dsh.availability !== 'missing') return 'dsh';
  const ready = runnableEngines().find((engine) => engine.availability === 'ready');
  if (ready) return ready.id;
  const installed = runnableEngines().find((engine) => engine.availability === 'installed');
  return installed ? installed.id : 'dsh';
}

/* ------------------------------------------------------------------- stream */

function connectStream() {
  openEventStream({
    onOpen: () => {
      state.connection = 'live';
      paintConnection();
    },
    onError: () => {
      state.connection = 'offline';
      paintConnection();
    },
    onEvent: (event) => {
      state.connection = 'live';
      paintConnection();
      applyEvent(event);
    },
  });
}

function paintConnection() {
  const dot = $('#connection-dot');
  const label = $('#connection-label');
  if (!dot || !label) return;
  dot.dataset.state = state.connection;
  label.textContent =
    state.connection === 'live' ? t('status.connected') : t('status.reconnecting');
}

function applyEvent(event) {
  state.events.push(event);
  if (state.events.length > 400) state.events.splice(0, state.events.length - 400);
  renderEventsTail();

  if (event.runId !== state.activeRunId) return;
  const record = state.activeRun;
  if (!record) return;

  const agent = findAgent(record, event);
  switch (event.type) {
    case 'plan_ready':
      record.plan = { source: event.data.source, tasks: event.data.tasks, warnings: event.data.warnings };
      paintPlan(record);
      break;
    case 'agent_started':
      if (agent) {
        agent.status = 'running';
        agent.model = event.data.model ?? agent.model;
        agent.patchPath = event.data.patchPath ?? agent.patchPath;
        paintAgentHeader(agent);
      }
      break;
    case 'agent_event':
      if (agent) paintAgentEvent(agent, event.data.event);
      break;
    case 'agent_stderr':
      if (agent) appendStderr(agent, event.data.chunk);
      break;
    case 'agent_finished':
      if (agent) {
        agent.status = event.data.status ?? agent.status;
        agent.error = event.data.error ?? undefined;
        agent.durationMs = event.data.durationMs ?? agent.durationMs;
        agent.sessionId = event.data.sessionId ?? agent.sessionId;
        if (event.data.usage) agent.usage = event.data.usage;
        paintAgentHeader(agent);
        if (agent.error) paintAgentError(agent);
      }
      break;
    case 'run_finished':
      record.status = event.data.status;
      record.result = event.data.result;
      record.error = event.data.error;
      paintRunStatus();
      paintFinal(record);
      void refreshRunList();
      break;
    default:
      break;
  }
}

function findAgent(record, event) {
  const agentId = event.data?.agentId;
  const stage = event.data?.stage;
  if (!agentId) return null;
  const candidates = record.agents.filter((agent) => agent.id === agentId);
  if (stage) {
    const exact = candidates.find((agent) => agent.stage === stage);
    if (exact) return exact;
  }
  // Events without a stage belong to the agent's first stage.
  return candidates[0] ?? null;
}

/* ------------------------------------------------------------------- shell */

function buildShell() {
  const root = $('#app');
  clear(root);

  const header = h('header', { class: 'topbar' },
    h('div', { class: 'brand' },
      h('span', { class: 'brand-mark', text: 'DSH' }),
      h('div', {},
        h('h1', { text: t('app.title') }),
        h('p', { class: 'muted', text: t('app.subtitle') })),
    ),
    h('div', { class: 'topbar-right' },
      h('div', { class: 'conn' },
        h('span', { id: 'connection-dot', class: 'dot', dataset: { state: state.connection } }),
        h('span', { id: 'connection-label', class: 'muted', text: t('status.connected') })),
      h('button', {
        class: 'ghost',
        onclick: () => {
          const next = getLang() === 'fa' ? 'en' : 'fa';
          setLang(next);
          localStorage.setItem('dsh-ma-lang', next);
          if (state.settings) {
            state.settings.ui = { language: next, direction: direction(next) };
            scheduleSettingsSave();
          }
          render();
        },
      }, t('app.langSwitch')),
      h('button', {
        class: 'ghost',
        onclick: () => {
          const current = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
          document.documentElement.dataset.theme = current;
          localStorage.setItem('dsh-ma-theme', current);
        },
      }, '◐'),
    ),
  );

  const nav = h('nav', { class: 'tabs' },
    tab('run', t('nav.newRun')),
    tab('history', t('nav.history')),
    tab('settings', t('nav.settings')),
    tab('events', t('nav.events')),
  );

  root.append(header, nav, h('div', { id: 'notice', class: 'notice-host' }), h('main', { id: 'view' }));
}

function tab(name, label) {
  return h('button', {
    class: `tab${state.view === name ? ' active' : ''}`,
    dataset: { tab: name },
    onclick: () => {
      state.view = name;
      render();
    },
  }, label);
}

function render() {
  const theme = localStorage.getItem('dsh-ma-theme');
  if (theme) document.documentElement.dataset.theme = theme;
  document.documentElement.lang = getLang();
  document.documentElement.dir = direction(getLang());
  buildShell();
  renderNotice();

  const view = $('#view');
  if (state.view === 'run') renderRunView(view);
  else if (state.view === 'history') renderHistory(view);
  else if (state.view === 'settings') renderSettings(view);
  else renderEventsView(view);
}

/* -------------------------------------------------------------- run (form) */

function renderRunView(view) {
  clear(view);
  const launcherOk = Boolean(state.info?.launcherFound);
  view.append(h('div', { class: 'launcher-bar' }, launcherCard()));

  const form = h('section', { class: 'card' },
    h('h2', { text: t('run.title') }),
    field(t('run.task'),
      h('textarea', {
        rows: 4,
        placeholder: t('run.taskPlaceholder'),
        value: state.runOptions.task,
        oninput: (event) => {
          state.runOptions.task = event.target.value;
        },
      })),
    h('div', { class: 'grid grid-2' },
      field(t('run.cwd'), h('input', {
        type: 'text',
        value: state.runOptions.cwd,
        placeholder: state.settings?.dsh?.runCwd ?? '',
        oninput: (event) => {
          state.runOptions.cwd = event.target.value;
        },
      }), t('run.cwdHint')),
      field(t('run.mode'), h('select', {
        onchange: (event) => {
          state.runOptions.mode = event.target.value;
          render();
        },
      },
      option('pipeline', t('run.mode.pipeline'), state.runOptions.mode === 'pipeline'),
      option('native', t('run.mode.native'), state.runOptions.mode === 'native')),
      t(state.runOptions.mode === 'pipeline' ? 'run.mode.pipelineHint' : 'run.mode.nativeHint')),
    ),
    state.runOptions.mode === 'pipeline'
      ? h('div', { class: 'grid grid-3' },
          field(t('run.planning'), h('select', {
            onchange: (event) => {
              state.runOptions.planning = event.target.value;
            },
          },
          option('auto', t('run.planning.auto'), state.runOptions.planning === 'auto'),
          option('manual', t('run.planning.manual'), state.runOptions.planning === 'manual'))),
          field(t('run.concurrency'), h('input', {
            type: 'number',
            min: 1,
            max: 32,
            value: state.runOptions.concurrency,
            oninput: (event) => {
              state.runOptions.concurrency = Number(event.target.value) || 1;
            },
          })),
          field(t('run.timeout'), h('input', {
            type: 'number',
            min: 0,
            max: 1440,
            value: state.runOptions.timeoutMin,
            oninput: (event) => {
              state.runOptions.timeoutMin = Number(event.target.value) || 0;
            },
          }), t('run.timeoutNone') + ' = 0'),
        )
      : null,
    h('label', { class: 'check' },
      h('input', {
        type: 'checkbox',
        checked: state.runOptions.includeDependencyOutput,
        onchange: (event) => {
          state.runOptions.includeDependencyOutput = event.target.checked;
        },
      }),
      t('run.depOutputs')),
    field(t('run.synthesis'), h('textarea', {
      rows: 2,
      placeholder: t('run.synthesisPlaceholder'),
      value: state.runOptions.synthesisInstructions,
      oninput: (event) => {
        state.runOptions.synthesisInstructions = event.target.value;
      },
    })),
  );

  const roster = renderRoster();

  const actions = h('div', { class: 'actions' },
    h('button', {
      class: 'primary',
      disabled: !launcherOk,
      onclick: startRun,
    }, t('run.start')),
    state.activeRun && ['queued', 'running'].includes(state.activeRun.status)
      ? h('button', { class: 'danger', onclick: abortRun }, t('run.abort'))
      : null,
    !launcherOk ? h('span', { class: 'muted', text: t('launcher.hint') }) : null,
  );

  view.append(form, roster, actions);

  if (state.activeRun) {
    view.append(renderTimeline(state.activeRun));
  }
}

function launcherCard() {
  const info = state.info;
  if (!info) return h('span', { class: 'muted', text: t('common.loading') });
  const ok = info.launcherFound;
  return h('div', { class: 'launcher-inner' },
    h('span', { class: `pill ${ok ? 'pill-ok' : 'pill-bad'}` },
      `${t('launcher.title')}: ${ok ? t('launcher.found') : t('launcher.notFound')}`),
    ok ? h('code', { text: info.launcherPath }) : h('span', { class: 'muted', text: info.error ?? '' }),
    ok ? h('span', { class: 'muted', text: `${t('launcher.mode')}: ${info.launchKind} · ${t('launcher.version')}: ${info.version}` }) : null,
    h('button', {
      class: 'ghost small',
      onclick: async () => {
        const response = await api.info();
        state.info = response.info;
        render();
      },
    }, t('launcher.recheck')),
  );
}

function field(label, control, hint) {
  return h('label', { class: 'field' },
    h('span', { class: 'field-label', text: label }),
    control,
    hint ? h('span', { class: 'field-hint', text: hint }) : null);
}

function option(value, label, selected) {
  const node = h('option', { value }, label);
  if (selected) node.selected = true;
  return node;
}

/* ----------------------------------------------------------------- roster */

function renderRoster() {
  const settings = state.settings;
  if (!settings) return h('section', { class: 'card' });
  const roster = settings.roster;
  const section = h('section', { class: 'card' },
    h('div', { class: 'card-head' },
      h('h2', { text: t('agents.main') }),
      h('span', { class: 'muted', text: t('agents.noProviders') , hidden: state.providers.length > 0 })),
    agentEditor(roster.main, { role: 'main' }),
    h('div', { class: 'card-head' },
      h('h2', { text: t('agents.subs') }),
      h('button', { class: 'ghost small', onclick: addSubAgent }, '＋ ' + t('agents.add'))),
    h('p', { class: 'muted small', text: t('agents.dragHint') }),
    roster.subs.map((agent, index) => agentEditor(agent, {
      role: 'sub',
      index,
      siblings: roster.subs,
    })),
  );
  return section;
}

function agentEditor(agent, options) {
  const provider = providerOf(agent.model.provider);
  const engineId = agent.engine ?? 'dsh';
  const engine = engineById(engineId);
  const isDsh = !engine || engine.kind === 'dsh';
  const engineChoices = state.engines.filter((entry) => entry.kind !== 'ide' || entry.id === engineId);

  const engineField = field(
    t('agents.engine'),
    h('select', {
      onchange: (event) => {
        agent.engine = event.target.value;
        const next = engineById(event.target.value);
        if (next && next.kind !== 'dsh') {
          const current = agent.cliModel;
          agent.cliModel = typeof current === 'string' ? current : '';
        }
        scheduleSettingsSave();
        render();
      },
    },
    engineChoices.length === 0
      ? option(engineId, engineId, true)
      : engineChoices.map((entry) =>
          option(
            entry.id,
            `${entry.label} — ${t(`engines.availability.${entry.availability}`)}`,
            entry.id === engineId,
          ),
        ),
    ),
    t('agents.engineHint'),
  );

  const modelRow = isDsh
    ? h('div', { class: 'grid grid-3' },
        field(t('agents.provider'), h('select', {
          onchange: (event) => {
            agent.model.provider = event.target.value;
            const next = providerOf(event.target.value);
            agent.model.model = next?.models[0]?.id ?? '';
            agent.model.reasoningEffort = undefined;
            scheduleSettingsSave();
            render();
          },
        },
        option('', '—', !agent.model.provider),
        state.providers.map((entry) => option(entry.name, entry.displayName ?? entry.name, entry.name === agent.model.provider)),
        )),
        field(t('agents.model'), h('select', {
          onchange: (event) => {
            agent.model.model = event.target.value;
            agent.model.reasoningEffort = undefined;
            scheduleSettingsSave();
            render();
          },
        },
        option('', '—', !agent.model.model),
        (provider?.models ?? []).map((model) => option(model.id, model.name ?? model.id, model.id === agent.model.model)),
        )),
        field(t('agents.effort'), h('select', {
          onchange: (event) => {
            agent.model.reasoningEffort = event.target.value || undefined;
            scheduleSettingsSave();
            render();
          },
        },
        effortOptions(agent.model).map((effort) =>
          option(effort, effort === '' ? t('agents.effortDefault') : effort, (agent.model.reasoningEffort ?? '') === effort)),
        )),
      )
    : h('div', { class: 'grid grid-2' },
        field(
          t('agents.cliModel'),
          h('input', {
            type: 'text',
            list: `engine-models-${agent.id}`,
            value: agent.cliModel ?? '',
            oninput: (event) => {
              agent.cliModel = event.target.value;
              scheduleSettingsSave();
            },
          }),
          t('agents.cliModelHint'),
        ),
        h('datalist', { id: `engine-models-${agent.id}` },
          (engine?.models ?? []).map((model) => h('option', { value: model.id }, model.name ?? model.id))),
        engine && engine.executablePath
          ? h('div', { class: 'engine-note' },
              h('span', { class: `pill pill-avail-${engine.availability}` }, t(`engines.availability.${engine.availability}`)),
              h('code', { class: 'small', text: engine.executablePath }),
              engine.version ? h('span', { class: 'muted small', text: `v${engine.version}` }) : null)
          : h('div', { class: 'engine-note' },
              h('span', { class: 'muted small', text: engine ? engine.message : '' })),
      );

  const card = h('article', { class: 'agent-editor' },
    h('div', { class: 'agent-editor-head' },
      h('input', {
        class: 'agent-name',
        type: 'text',
        value: agent.name,
        oninput: (event) => {
          agent.name = event.target.value;
          scheduleSettingsSave();
        },
      }),
      h('span', { class: `pill pill-${options.role}` }, options.role === 'main' ? t('agents.main') : t('stage.work')),
      h('span', { class: 'muted small', text: agentEngineLabel(agent) }),
      options.role === 'sub'
        ? h('label', { class: 'check small' },
            h('input', {
              type: 'checkbox',
              checked: agent.enabled !== false,
              onchange: (event) => {
                agent.enabled = event.target.checked;
                scheduleSettingsSave();
              },
            }), t('agents.enabled'))
        : null,
      options.role === 'sub'
        ? h('button', {
            class: 'ghost small danger-text',
            onclick: () => {
              state.settings.roster.subs.splice(options.index, 1);
              scheduleSettingsSave();
              render();
            },
          }, t('agents.remove'))
        : null,
    ),
    h('div', { class: 'grid grid-2' }, engineField),
    modelRow,
    options.role === 'sub'
      ? field(t('agents.dependsOn'), h('select', {
          multiple: 'multiple',
          size: Math.min(4, Math.max(2, options.siblings.length)),
          onchange: (event) => {
            agent.dependsOn = [...event.target.selectedOptions]
              .map((node) => node.value)
              .filter((value) => value !== agent.id);
            scheduleSettingsSave();
          },
        },
        options.siblings
          .filter((sibling) => sibling.id !== agent.id)
          .map((sibling) => {
            const node = option(sibling.id, sibling.name, (agent.dependsOn ?? []).includes(sibling.id));
            return node;
          })))
      : null,
    field(t('agents.brief'), h('textarea', {
      rows: 2,
      placeholder: t('agents.briefPlaceholder'),
      value: agent.instructions ?? '',
      oninput: (event) => {
        agent.instructions = event.target.value;
        scheduleSettingsSave();
      },
    })),
    field(t('agents.persona'), h('input', {
      type: 'text',
      value: agent.personaPrefix ?? '',
      oninput: (event) => {
        agent.personaPrefix = event.target.value || undefined;
        scheduleSettingsSave();
      },
    })),
    validationRow(agent, options),
  );
  return card;
}

function validationRow(agent, options) {
  const key = agent.id ?? `anon-${options.index ?? 'main'}`;
  const engine = engineById(agent.engine ?? 'dsh');
  const isDsh = !engine || engine.kind === 'dsh';

  if (!isDsh) {
    // A CLI engine is verified by running it once, which is a real check of
    // "installed" and "signed in" rather than a static configuration test.
    const test = state.engineTests.get(engine.id);
    return h('div', { class: 'validate-row' },
      h('button', {
        class: 'ghost small',
        onclick: async (event) => {
          const button = event.currentTarget;
          button.disabled = true;
          button.textContent = t('engines.testing');
          try {
            const response = await api.testEngine(engine.id);
            state.engineTests.set(engine.id, response.result);
            await refreshEngines();
          } catch (error) {
            state.engineTests.set(engine.id, { ok: false, message: String(error.message ?? error) });
          }
          render();
        },
      }, `${t('engines.test')} — ${engine.label}`),
      test
        ? h('span', { class: `pill ${test.ok ? 'pill-ok' : 'pill-bad'}` },
            test.ok
              ? t('engines.testOk', { message: test.message })
              : t('engines.testFailed', { message: test.message }))
        : h('span', { class: `pill pill-avail-${engine.availability}` },
            t(`engines.availability.${engine.availability}`)),
      engine.kind === 'ide'
        ? h('span', { class: 'warnings', text: t('engines.ideNote') })
        : null,
    );
  }

  const result = state.validation.get(key);
  return h('div', { class: 'validate-row' },
    h('button', {
      class: 'ghost small',
      onclick: async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        button.textContent = t('agents.validating');
        try {
          const response = await api.validate({
            provider: agent.model.provider,
            model: agent.model.model,
            reasoningEffort: agent.model.reasoningEffort,
            personaPrefix: agent.personaPrefix,
          });
          state.validation.set(key, response);
        } catch (error) {
          state.validation.set(key, { ok: false, problems: [String(error.message ?? error)] });
        }
        render();
      },
    }, t('agents.validate')),
    result
      ? h('span', { class: `pill ${result.ok ? 'pill-ok' : 'pill-bad'}` },
          `${result.ok ? t('agents.valid') : t('agents.invalid')} (${result.stage})`)
      : null,
    result && !result.ok && result.problems?.length
      ? h('ul', { class: 'problems' }, result.problems.map((problem) => h('li', { text: problem })))
      : null,
    result?.warnings?.length
      ? h('ul', { class: 'warnings' }, result.warnings.map((warning) => h('li', { text: warning })))
      : null,
  );
}

function addSubAgent() {
  const subs = state.settings.roster.subs;
  const index = subs.length + 1;
  const fallbackProvider = subs[0]?.model.provider ?? state.providers[0]?.name ?? '';
  const fallbackModel =
    subs[0]?.model.model ?? providerOf(fallbackProvider)?.models?.[0]?.id ?? '';
  subs.push({
    id: `agent-${Date.now().toString(36)}`,
    name: `Agent ${index}`,
    role: 'sub',
    model: { provider: fallbackProvider, model: fallbackModel },
    instructions: '',
    enabled: true,
  });
  scheduleSettingsSave();
  render();
}

function scheduleSettingsSave() {
  if (settingsSaveTimer) clearTimeout(settingsSaveTimer);
  settingsSaveTimer = setTimeout(async () => {
    if (!state.settings) return;
    try {
      const response = await api.saveSettings(state.settings);
      state.settings = response.settings;
    } catch (error) {
      notify(String(error.message ?? error), 'error');
    }
  }, 700);
}

/* ---------------------------------------------------------------- starting */

async function startRun() {
  if (!state.runOptions.task.trim()) {
    notify(t('run.needsTask'), 'error');
    return;
  }
  const missing = [state.settings.roster.main, ...state.settings.roster.subs]
    .filter((agent) => (agent.enabled !== false))
    .find((agent) => {
      const engine = engineById(agent.engine ?? 'dsh');
      if (engine && engine.kind !== 'dsh') return false;
      return !agent.model.provider || !agent.model.model;
    });
  if (missing) {
    notify(`${t('run.needsModel')} (${missing.name})`, 'error');
    return;
  }
  const timeoutMs = Math.max(0, Math.round(state.runOptions.timeoutMin * 60000));
  const payload = {
    mode: state.runOptions.mode,
    task: state.runOptions.task,
    cwd: state.runOptions.cwd,
    planning: state.runOptions.planning,
    concurrency: state.runOptions.concurrency,
    timeoutMs,
    includeDependencyOutput: state.runOptions.includeDependencyOutput,
    synthesisInstructions: state.runOptions.synthesisInstructions,
    main: { ...state.settings.roster.main, role: 'main', enabled: true },
    subs: state.settings.roster.subs.map((agent) => ({ ...agent, role: 'sub' })),
  };
  try {
    await api.saveSettings(state.settings);
    state.validation.clear();
    refs.clear();
    const response = await api.startRun(payload);
    state.activeRun = response.run;
    state.activeRunId = response.run.id;
    state.view = 'run';
    render();
  } catch (error) {
    notify(String(error.message ?? error), 'error');
  }
}

async function abortRun() {
  if (!state.activeRunId) return;
  try {
    await api.abortRun(state.activeRunId);
    notify(t('run.aborting'));
  } catch (error) {
    notify(String(error.message ?? error), 'error');
  }
}

async function refreshRunList() {
  try {
    const response = await api.listRuns();
    state.runs = response.runs;
    if (state.view === 'history') render();
  } catch {
    /* history is best-effort */
  }
}

/* -------------------------------------------------------------- timeline UI */

function renderTimeline(record) {
  refs.clear();
  const section = h('section', { class: 'card timeline', id: 'timeline' },
    h('div', { class: 'card-head' },
      h('h2', { text: record.task.length > 80 ? `${record.task.slice(0, 80)}…` : record.task }),
      h('span', { id: 'run-status', class: `pill pill-run-${record.status}` }, t(`run.status.${record.status}`)),
      h('span', { class: 'muted small', text: `${record.mode} · ${record.cwd}` }),
      ['queued', 'running'].includes(record.status)
        ? h('button', { class: 'danger small', onclick: abortRun }, t('run.abort'))
        : null,
    ),
    h('div', { id: 'plan-host' }),
    h('div', { class: 'agents' }, record.agents.map((agent) => agentCard(agent))),
    h('div', { id: 'final-host' }),
  );
  // Paint from the record so a reloaded run shows its history.
  for (const agent of record.agents) {
    paintAgentHeader(agent);
    paintAgentBody(agent);
  }
  paintPlan(record);
  paintFinal(record, section);
  return section;
}

function agentCard(agent) {
  const key = `${agent.id}:${agent.stage}`;
  const output = h('div', { class: 'agent-output' });
  const thinking = h('pre', { class: 'agent-thinking' });
  const tools = h('ul', { class: 'agent-tools' });
  const stderr = h('pre', { class: 'agent-stderr' });
  const stderrBlock = h('details', { class: 'block stderr-block', hidden: !agent.stderr },
    h('summary', { text: t('panel.stderr') }),
    stderr);
  const error = h('div', { class: 'agent-error' });
  const meta = h('span', { class: 'agent-meta' });
  const badge = h('span', { class: `pill pill-agent-${agent.status}` });

  const card = h('article', { class: 'agent-card', dataset: { key } },
    h('header', { class: 'agent-card-head' },
      badge,
      h('h3', {},
        h('span', { class: 'agent-title', text: agent.name }),
        h('small', { class: 'muted', text: ` · ${t(`stage.${agent.stage}`) || agent.stage}` })),
      h('span', { class: 'model-chip', text: agent.engine && agent.engine !== 'dsh'
        ? `${engineById(agent.engine)?.label ?? agent.engine}${agent.cliModel ? ` · ${agent.cliModel}` : ''}`
        : `${agent.model.provider} / ${agent.model.model}${agent.model.reasoningEffort ? ` @ ${agent.model.reasoningEffort}` : ''}` }),
      meta,
    ),
    h('div', { class: 'agent-card-body' },
      h('details', { class: 'block', open: false },
        h('summary', { text: t('panel.thinking') }),
        thinking),
      h('div', { class: 'block' },
        h('div', { class: 'block-title', text: t('panel.output') }),
        output),
      h('details', { class: 'block' },
        h('summary', { text: `${t('panel.tools')} (0)` }),
        tools),
      stderrBlock,
      error,
      agent.patchPath
        ? h('div', { class: 'agent-foot' },
            h('span', { class: 'muted small', text: `${t('panel.patch')}: ` }),
            h('code', { class: 'small', text: agent.patchPath }),
            agent.sessionId
              ? h('span', { class: 'muted small', text: ` · ${t('panel.session')}: ${agent.sessionId}` })
              : null)
        : null,
    ),
  );
  refs.set(key, {
    key,
    agent,
    card,
    badge,
    meta,
    output,
    thinking,
    tools,
    stderr,
    stderrBlock,
    error,
    toolNodes: new Map(),
    rendered: { messages: 0, thinking: 0 },
  });
  return card;
}

function paintAgentHeader(agent) {
  const ref = refs.get(`${agent.id}:${agent.stage}`);
  if (!ref) return;
  ref.badge.className = `pill pill-agent-${agent.status}`;
  ref.badge.textContent = t(`agent.status.${agent.status}`);
  const parts = [];
  if (agent.durationMs) parts.push(formatDuration(agent.durationMs));
  if (agent.usage?.totalTokens) parts.push(`${formatNumber(agent.usage.totalTokens)} ${t('panel.tokens')}`);
  if (agent.status === 'running') parts.push('●');
  ref.meta.textContent = parts.join(' · ');
}

/** Render whatever the record already contains (used for reloaded runs). */
function paintAgentBody(agent) {
  const ref = refs.get(`${agent.id}:${agent.stage}`);
  if (!ref) return;
  clear(ref.output);
  clear(ref.thinking);
  clear(ref.tools);
  ref.toolNodes.clear();
  ref.rendered = { messages: 0, thinking: 0 };
  for (const message of agent.messages ?? []) appendMessage(ref, message);
  if (agent.thinking?.length) ref.thinking.textContent = agent.thinking.join('\n\n');
  for (const call of agent.toolCalls ?? []) appendToolCall(ref, call);
  updateToolSummary(ref);
  if (agent.stderr) ref.stderr.textContent = agent.stderr;
  if (agent.error) paintAgentError(agent);
}

function paintAgentEvent(agent, event) {
  const ref = refs.get(`${agent.id}:${agent.stage}`);
  if (!ref || !event) return;
  switch (event.type) {
    case 'text':
      if (event.text && String(event.text).trim() !== '') appendMessage(ref, event.text);
      break;
    case 'thinking':
      if (event.text && String(event.text).trim() !== '') {
        ref.thinking.textContent = ref.thinking.textContent
          ? `${ref.thinking.textContent}\n\n${event.text}`
          : String(event.text);
      }
      break;
    case 'tool_call':
      appendToolCall(ref, {
        callId: String(event.callId ?? ''),
        tool: String(event.tool ?? 'tool'),
        input: event.input,
        status: 'running',
      });
      break;
    case 'tool_result': {
      const node = ref.toolNodes.get(String(event.callId ?? ''));
      if (node) {
        node.dataset.status = event.status === 'error' ? 'error' : 'completed';
        const result = node.querySelector('.tool-result');
        if (result) result.textContent = String(event.result ?? '');
      }
      break;
    }
    case 'session':
      paintAgentHeader(agent);
      break;
    default:
      break;
  }
}

function appendMessage(ref, text) {
  ref.output.append(h('div', { class: 'msg' }, String(text)));
  ref.output.scrollTop = ref.output.scrollHeight;
}

function appendToolCall(ref, call) {
  if (call.callId && ref.toolNodes.has(call.callId)) return;
  const node = h('li', { class: 'tool', dataset: { status: call.status ?? 'running' } },
    h('div', { class: 'tool-head' },
      h('span', { class: 'tool-name', text: call.tool }),
      h('span', { class: 'tool-status', text: call.status ?? 'running' })),
    call.input !== undefined
      ? h('pre', { class: 'tool-args', text: typeof call.input === 'string' ? call.input : JSON.stringify(call.input, null, 2) })
      : null,
    h('pre', { class: 'tool-result', text: call.result ?? '' }),
  );
  ref.tools.append(node);
  if (call.callId) ref.toolNodes.set(call.callId, node);
  updateToolSummary(ref);
}

function updateToolSummary(ref) {
  const details = ref.tools.closest('details');
  if (!details) return;
  const summary = details.querySelector('summary');
  if (summary) summary.textContent = `${t('panel.tools')} (${ref.tools.childElementCount})`;
}

function appendStderr(agent, chunk) {
  const ref = refs.get(`${agent.id}:${agent.stage}`);
  if (!ref || !chunk) return;
  ref.stderrBlock.hidden = false;
  ref.stderr.textContent += chunk;
  if (ref.stderr.textContent.length > 6000) {
    ref.stderr.textContent = ref.stderr.textContent.slice(-6000);
  }
}

function paintAgentError(agent) {
  const ref = refs.get(`${agent.id}:${agent.stage}`);
  if (!ref) return;
  clear(ref.error);
  if (!agent.error) return;
  ref.error.append(h('div', { class: 'error-box', text: agent.error }));
}

function paintRunStatus() {
  const badge = $('#run-status');
  if (!badge || !state.activeRun) return;
  badge.className = `pill pill-run-${state.activeRun.status}`;
  badge.textContent = t(`run.status.${state.activeRun.status}`);
}

function paintPlan(record) {
  const host = $('#plan-host');
  if (!host) return;
  clear(host);
  if (!record.plan) return;
  host.append(h('details', { class: 'block plan' },
    h('summary', { text: `${t('result.plan')} (${t(`result.planSource.${record.plan.source}`)})` }),
    h('ul', { class: 'plan-list' }, (record.plan.tasks ?? []).map((task) =>
      h('li', {},
        h('strong', { text: task.title }),
        task.agentId ? h('code', { class: 'small', text: task.agentId }) : null,
        h('p', { class: 'muted small', text: task.instructions })))),
    record.plan.warnings?.length
      ? h('ul', { class: 'warnings' }, record.plan.warnings.map((warning) => h('li', { text: warning })))
      : null,
  ));
}

function paintFinal(record, scope = document) {
  const host = scope.querySelector ? scope.querySelector('#final-host') : $('#final-host');
  if (!host) return;
  clear(host);
  const result = record.result ?? '';
  if (record.status === 'queued' || record.status === 'running') return;
  host.append(h('section', { class: 'final' },
    h('div', { class: 'card-head' },
      h('h2', { text: t('result.title') }),
      h('span', { class: `pill pill-run-${record.status}` }, t(`run.status.${record.status}`)),
      result ? h('button', {
        class: 'ghost small',
        onclick: async (event) => {
          await navigator.clipboard.writeText(result);
          event.currentTarget.textContent = t('common.copied');
        },
      }, t('common.copy')) : null),
    result ? h('pre', { class: 'final-text', text: result }) : h('p', { class: 'muted', text: record.error ?? t('result.empty') }),
  ));
}

/* ----------------------------------------------------------------- history */

function renderHistory(view) {
  clear(view);

  const head = h('div', { class: 'card-head' },
    h('h2', { text: t('history.title') }),
    h('button', { class: 'ghost small', onclick: refreshRunList }, t('history.refresh')),
  );

  let body;
  if (state.runs.length === 0) {
    body = h('p', { class: 'muted', text: t('history.empty') });
  } else {
    const headerRow = h('tr', {},
      h('th', { text: t('run.task') }),
      h('th', { text: t('run.mode') }),
      h('th', { text: 'agents' }),
      h('th', { text: t('panel.duration') }),
      h('th', { text: 'status' }),
      h('th', {}),
    );

    const rows = state.runs.map((run) => {
      const openButton = h('button', {
        class: 'ghost small',
        onclick: () => openRun(run.id),
      }, t('history.open'));
      return h('tr', { class: run.id === state.activeRunId ? 'active' : '' },
        h('td', { class: 'task-cell', text: run.task }),
        h('td', { text: run.mode }),
        h('td', { text: formatNumber(run.agents) }),
        h('td', { text: run.finishedAt && run.startedAt ? formatDuration(run.finishedAt - run.startedAt) : '—' }),
        h('td', {}, h('span', { class: `pill pill-run-${run.status}` }, t(`run.status.${run.status}`))),
        h('td', {}, openButton),
      );
    });

    body = h('table', { class: 'runs' },
      h('thead', {}, headerRow),
      h('tbody', {}, rows),
    );
  }

  view.append(h('section', { class: 'card' }, head, body));
}

async function openRun(id) {
  try {
    const response = await api.getRun(id, 0);
    state.activeRun = response.run;
    state.activeRunId = id;
    state.view = 'run';
    render();
  } catch (error) {
    notify(String(error.message ?? error), 'error');
  }
}

/* ---------------------------------------------------------------- settings */

function renderSettings(view) {
  clear(view);
  const settings = state.settings;
  if (!settings) {
    view.append(h('p', { class: 'muted', text: t('common.loading') }));
    return;
  }

  view.append(h('section', { class: 'card' },
    h('h2', { text: t('settings.dshSection') }),
    h('div', { class: 'grid grid-2' },
      field(t('settings.bin'), h('input', {
        type: 'text',
        value: settings.dsh.bin ?? '',
        placeholder: t('settings.binHint'),
        oninput: (event) => {
          settings.dsh.bin = event.target.value;
          scheduleSettingsSave();
        },
      })),
      field(t('settings.home'), h('input', {
        type: 'text',
        value: settings.dsh.home ?? '',
        oninput: (event) => {
          settings.dsh.home = event.target.value;
          scheduleSettingsSave();
        },
      })),
      field(t('settings.profile'), h('input', {
        type: 'text',
        value: settings.dsh.profile ?? 'headless',
        oninput: (event) => {
          settings.dsh.profile = event.target.value;
          scheduleSettingsSave();
        },
      }), t('settings.profileHint')),
      field(t('settings.runCwd'), h('input', {
        type: 'text',
        value: settings.dsh.runCwd ?? '',
        oninput: (event) => {
          settings.dsh.runCwd = event.target.value;
          state.runOptions.cwd = event.target.value;
          scheduleSettingsSave();
        },
      })),
    ),
    h('label', { class: 'check' },
      h('input', {
        type: 'checkbox',
        checked: settings.dsh.trustStoredCredentials,
        onchange: (event) => {
          settings.dsh.trustStoredCredentials = event.target.checked;
          scheduleSettingsSave();
        },
      }),
      t('settings.trust')),
    h('p', { class: 'muted small', text: t('settings.trustHint') }),
  ));

  view.append(h('section', { class: 'card' },
    h('h2', { text: t('settings.runtime') }),
    h('div', { class: 'grid grid-3' },
      field(t('settings.maxConcurrency'), h('input', {
        type: 'number',
        min: 1,
        max: 32,
        value: settings.runs.maxConcurrency,
        oninput: (event) => {
          settings.runs.maxConcurrency = Number(event.target.value) || 1;
          state.runOptions.concurrency = settings.runs.maxConcurrency;
          scheduleSettingsSave();
        },
      })),
      field(t('settings.timeout'), h('input', {
        type: 'number',
        min: 0,
        max: 1440,
        value: Math.round(settings.runs.timeoutMs / 60000),
        oninput: (event) => {
          settings.runs.timeoutMs = (Number(event.target.value) || 0) * 60000;
          scheduleSettingsSave();
        },
      })),
    ),
  ));

  view.append(h('section', { class: 'card' },
    h('h2', { text: t('settings.server') }),
    h('div', { class: 'grid grid-3' },
      field(t('settings.host'), h('input', {
        type: 'text',
        value: settings.server.host,
        oninput: (event) => {
          settings.server.host = event.target.value;
          scheduleSettingsSave();
        },
      })),
      field(t('settings.port'), h('input', {
        type: 'number',
        min: 1,
        max: 65535,
        value: settings.server.port,
        oninput: (event) => {
          settings.server.port = Number(event.target.value) || 7317;
          scheduleSettingsSave();
        },
      }), t('settings.portHint')),
      field(t('settings.language'), h('select', {
        onchange: (event) => {
          settings.ui = { language: event.target.value, direction: direction(event.target.value) };
          setLang(event.target.value);
          localStorage.setItem('dsh-ma-lang', event.target.value);
          scheduleSettingsSave();
          render();
        },
      },
      option('fa', 'فارسی', getLang() === 'fa'),
      option('en', 'English', getLang() === 'en'))),
    ),
  ));

  view.append(renderEngines());

  view.append(renderProviders());

  const info = state.info;
  view.append(h('section', { class: 'card' },
    h('div', { class: 'card-head' },
      h('h2', { text: t('settings.save') }),
      h('button', {
        class: 'primary',
        onclick: async (event) => {
          event.currentTarget.disabled = true;
          try {
            const response = await api.saveSettings(state.settings);
            state.settings = response.settings;
            notify(t('settings.saved'), 'ok');
            const refreshed = await api.info();
            state.info = refreshed.info;
            render();
          } catch (error) {
            notify(String(error.message ?? error), 'error');
          }
        },
      }, t('settings.save'))),
    info
      ? h('dl', { class: 'kv' },
          h('dt', { text: t('launcher.title') }),
          h('dd', { text: info.launcherPath ?? t('launcher.notFound') }),
          h('dt', { text: t('launcher.mode') }),
          h('dd', { text: info.launchKind ?? '—' }),
          h('dt', { text: t('launcher.version') }),
          h('dd', { text: info.version ?? '—' }),
          h('dt', { text: t('launcher.profiles') }),
          h('dd', { text: (info.profiles ?? []).join(', ') || '—' }),
          h('dt', { text: 'DSH_HOME' }),
          h('dd', { text: info.dshHome }),
          h('dt', { text: 'state' }),
          h('dd', { text: state.stateDir ?? info.stateDir ?? '—' }))
      : null,
  ));
}

/* ----------------------------------------------------------------- engines */

/** One engine row: status, path, version, and the actions that matter. */
function engineRow(engine) {
  const test = state.engineTests.get(engine.id);
  const draft = state.engineDrafts.get(engine.id);
  const row = h('details', { class: 'engine', open: Boolean(draft) },
    h('summary', {},
      h('strong', { text: engine.label }),
      h('span', { class: `pill pill-avail-${engine.availability}` }, t(`engines.availability.${engine.availability}`)),
      h('span', { class: `pill pill-kind-${engine.kind}` }, t(`engines.kind.${engine.kind}`)),
      engine.version ? h('span', { class: 'muted small', text: `v${engine.version}` }) : null,
      h('span', { class: 'muted small', text: engine.outputFormat }),
      h('span', { class: 'muted small', text: usedByLabel(engine.id) }),
    ),
    engine.description ? h('p', { class: 'muted small', text: engine.description }) : null,
    h('dl', { class: 'kv' },
      h('dt', { text: t('engines.path') }),
      h('dd', { text: engine.executablePath ?? '—' }),
      h('dt', { text: t('engines.version') }),
      h('dd', { text: engine.version ?? '—' }),
    ),
    h('p', { class: 'muted small', text: engine.message }),
    engine.kind === 'ide' ? h('p', { class: 'warnings', text: t('engines.ideNote') }) : null,
    test
      ? h('div', { class: `test-result ${test.ok ? 'ok' : 'bad'}` },
          test.ok
            ? t('engines.testOk', { message: test.message })
            : t('engines.testFailed', { message: test.message }))
      : null,
    h('div', { class: 'engine-actions' },
      h('button', {
        class: 'ghost small',
        onclick: async (event) => {
          event.currentTarget.disabled = true;
          event.currentTarget.textContent = t('engines.testing');
          try {
            const response = await api.testEngine(engine.id);
            state.engineTests.set(engine.id, response.result);
            await refreshEngines();
          } catch (error) {
            state.engineTests.set(engine.id, { ok: false, message: String(error.message ?? error) });
          }
          render();
        },
      }, t('engines.test')),
      h('button', {
        class: 'ghost small',
        onclick: async () => {
          const response = await api.detectEngine(engine.id);
          state.engineTests.set(engine.id, { ok: response.detection.availability === 'ready', message: response.detection.message });
          await refreshEngines();
          render();
        },
      }, t('engines.scan')),
      engine.canHandoff
        ? h('button', {
            class: 'ghost small',
            onclick: async () => {
              try {
                const response = await api.handoffEngine(engine.id, state.runOptions.cwd || state.settings?.dsh?.runCwd || '');
                notify(response.message, response.ok ? 'ok' : 'error');
              } catch (error) {
                notify(String(error.message ?? error), 'error');
              }
            },
          }, t('engines.handoff'))
        : null,
      h('button', {
        class: 'ghost small',
        onclick: () => {
          if (draft) state.engineDrafts.delete(engine.id);
          else state.engineDrafts.set(engine.id, draftFromEngine(engine));
          render();
        },
      }, t('engines.edit')),
      h('button', {
        class: 'ghost small danger-text',
        onclick: async () => {
          const response = await api.removeEngine(engine.id);
          state.settings = response.settings;
          state.engineDrafts.delete(engine.id);
          await refreshEngines(true);
          render();
        },
      }, engine.builtin ? t('engines.remove') : t('engines.remove')),
    ),
    draft ? engineForm(draft) : null,
  );
  return row;
}

function usedByLabel(engineId) {
  const agents = [state.settings?.roster?.main, ...(state.settings?.roster?.subs ?? [])].filter(Boolean);
  const users = agents.filter((agent) => (agent.engine ?? 'dsh') === engineId).map((agent) => agent.name);
  return users.length === 0 ? '' : `${t('engines.usedBy')}: ${users.join(', ')}`;
}

function draftFromEngine(engine) {
  return {
    id: engine.id,
    label: engine.label,
    kind: engine.kind,
    description: engine.description ?? '',
    enabled: engine.enabled,
    commands: (engine.commands ?? []).join('\n'),
    searchGlobs: (engine.searchGlobs ?? []).join('\n'),
    versionArgs: (engine.versionArgs ?? ['--version']).join('\n'),
    executablePath: engine.configuredExecutablePath ?? '',
    argsTemplate: (engine.argsTemplate ?? []).join('\n'),
    extraArgs: (engine.extraArgs ?? []).join('\n'),
    outputFormat: engine.outputFormat,
    promptViaStdin: engine.promptViaStdin,
    models: (engine.models ?? []).map((model) => (model.name ? `${model.id}=${model.name}` : model.id)).join('\n'),
    healthArgsTemplate: (engine.healthArgsTemplate ?? []).join('\n'),
    healthPrompt: engine.healthPrompt ?? '',
    handoffArgs: (engine.handoffArgs ?? []).join('\n'),
  };
}

function emptyDraft() {
  return {
    id: '',
    label: '',
    kind: 'cli',
    description: '',
    enabled: true,
    commands: '',
    searchGlobs: '',
    versionArgs: '--version',
    executablePath: '',
    argsTemplate: '-p\n{prompt}\n--output-format\njson',
    extraArgs: '',
    outputFormat: 'json-lines',
    promptViaStdin: false,
    models: '',
    healthArgsTemplate: '',
    healthPrompt: 'Reply with exactly: OK',
    handoffArgs: '',
  };
}

/** Parse `id` or `id=name` lines into the engine's model list. */
function parseModelLines(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => {
      const eq = line.indexOf('=');
      if (eq === -1) return { id: line };
      return { id: line.slice(0, eq).trim(), name: line.slice(eq + 1).trim() };
    });
}

function engineForm(draft) {
  const text = (key, label, hint, rows = 2) =>
    field(label, h('textarea', {
      rows,
      value: draft[key],
      oninput: (event) => {
        draft[key] = event.target.value;
      },
    }), hint);

  return h('div', { class: 'engine-form' },
    h('div', { class: 'grid grid-3' },
      field(t('engines.form.id'), h('input', {
        type: 'text',
        value: draft.id,
        disabled: draft.builtin,
        oninput: (event) => {
          draft.id = event.target.value;
        },
      })),
      field(t('engines.form.label'), h('input', {
        type: 'text',
        value: draft.label,
        oninput: (event) => {
          draft.label = event.target.value;
        },
      })),
      field(t('engines.kind'), h('select', {
        onchange: (event) => {
          draft.kind = event.target.value;
        },
      },
      option('cli', t('engines.kind.cli'), draft.kind === 'cli'),
      option('dsh', t('engines.kind.dsh'), draft.kind === 'dsh'),
      option('ide', t('engines.kind.ide'), draft.kind === 'ide'))),
    ),
    field(t('engines.form.description'), h('input', {
      type: 'text',
      value: draft.description,
      oninput: (event) => {
        draft.description = event.target.value;
      },
    })),
    h('label', { class: 'check small' },
      h('input', {
        type: 'checkbox',
        checked: draft.enabled,
        onchange: (event) => {
          draft.enabled = event.target.checked;
        },
      }), t('engines.form.enabled')),
    h('div', { class: 'grid grid-2' },
      text('commands', t('engines.form.commands'), '', 2),
      text('searchGlobs', t('engines.form.searchGlobs'), '', 2),
      text('versionArgs', t('engines.form.versionArgs'), '', 1),
      text('executablePath', t('engines.form.executablePath'), t('engines.form.executablePathHint'), 1),
      field(t('engines.form.outputFormat'), h('select', {
        onchange: (event) => {
          draft.outputFormat = event.target.value;
        },
      }, ['dsh-json', 'claude-stream-json', 'gemini-stream-json', 'json-lines', 'text']
        .map((format) => option(format, format, draft.outputFormat === format)))),
    ),
    text('argsTemplate', t('engines.form.argsTemplate'), t('engines.form.argsHint'), 4),
    h('div', { class: 'grid grid-2' },
      text('extraArgs', t('engines.form.extraArgs'), '', 3),
      text('models', t('engines.form.models'), '', 3),
    ),
    h('label', { class: 'check small' },
      h('input', {
        type: 'checkbox',
        checked: draft.promptViaStdin,
        onchange: (event) => {
          draft.promptViaStdin = event.target.checked;
        },
      }), t('engines.form.promptViaStdin')),
    h('div', { class: 'grid grid-2' },
      text('healthArgsTemplate', t('engines.form.healthArgs'), '', 2),
      field(t('engines.form.healthPrompt'), h('input', {
        type: 'text',
        value: draft.healthPrompt,
        oninput: (event) => {
          draft.healthPrompt = event.target.value;
        },
      })),
    ),
    text('handoffArgs', t('engines.form.handoffArgs'), '', 1),
    h('div', { class: 'engine-actions' },
      h('button', {
        class: 'primary small',
        onclick: async () => {
          const payload = {
            id: draft.id,
            label: draft.label || draft.id,
            kind: draft.kind,
            enabled: draft.enabled,
            description: draft.description,
            detect: {
              commands: draft.commands,
              searchGlobs: draft.searchGlobs,
              versionArgs: draft.versionArgs,
              executablePath: draft.executablePath,
            },
            run: {
              argsTemplate: draft.argsTemplate,
              extraArgs: draft.extraArgs,
              outputFormat: draft.outputFormat,
              promptViaStdin: draft.promptViaStdin,
              models: parseModelLines(draft.models),
              healthArgsTemplate: draft.healthArgsTemplate,
              healthPrompt: draft.healthPrompt,
            },
            // A handoff is only meaningful when the user actually gave it
            // arguments; sending '{cwd}' for every engine would offer
            // "open folder" on plain command-line engines too.
            ...(draft.handoffArgs.trim() !== ''
              ? { handoff: { argsTemplate: draft.handoffArgs } }
              : {}),
          };
          try {
            const response = await api.saveEngine(payload);
            state.settings = response.settings;
            state.engineDrafts.delete(draft.id);
            await refreshEngines(true);
            notify(
              response.problems?.length
                ? `${t('engines.saved')} — ${t('engines.problems')}: ${response.problems.map((p) => p.message).join(' ')}`
                : t('engines.saved'),
              response.problems?.length ? 'error' : 'ok',
            );
          } catch (error) {
            notify(String(error.message ?? error), 'error');
          }
          render();
        },
      }, t('engines.save')),
      h('button', {
        class: 'ghost small',
        onclick: () => {
          state.engineDrafts.delete(draft.id);
          render();
        },
      }, t('common.cancel')),
    ),
  );
}

function renderEngines() {
  const section = h('section', { class: 'card' },
    h('div', { class: 'card-head' },
      h('h2', { text: t('engines.title') }),
      h('button', {
        class: 'ghost small',
        onclick: async (event) => {
          event.currentTarget.disabled = true;
          event.currentTarget.textContent = t('engines.scanning');
          await refreshEngines(true);
          render();
        },
      }, t('engines.scan')),
      h('button', {
        class: 'ghost small',
        onclick: () => {
          const draft = emptyDraft();
          state.engineDrafts.set('__new__', draft);
          render();
        },
      }, '＋ ' + t('engines.add')),
    ),
    h('p', { class: 'muted small', text: t('engines.subtitle') }),
  );

  for (const engine of state.engines) section.append(engineRow(engine));

  // A hidden built-in preset must be recoverable, otherwise "Remove" is a
  // one-way door that only settings.json could undo.
  if (state.hiddenEngines.length > 0) {
    section.append(h('details', { class: 'engine' },
      h('summary', {}, h('strong', { text: `${t('engines.hidden')} (${state.hiddenEngines.length})` })),
      h('ul', { class: 'model-list' }, state.hiddenEngines.map((entry) =>
        h('li', {},
          h('strong', { text: entry.label }),
          h('code', { class: 'small', text: entry.id }),
          h('button', {
            class: 'ghost small',
            onclick: async () => {
              const response = await api.restoreEngine(entry.id);
              state.settings = response.settings;
              state.hiddenEngines = response.hidden ?? [];
              await refreshEngines(true);
              render();
            },
          }, t('engines.restore'))))),
    ));
  }

  const newDraft = state.engineDrafts.get('__new__');
  if (newDraft) {
    section.append(h('details', { class: 'engine', open: true },
      h('summary', {}, h('strong', { text: t('engines.new') })),
      engineForm(newDraft),
    ));
  }
  return section;
}

function renderProviders() {
  const section = h('section', { class: 'card' },
    h('div', { class: 'card-head' },
      h('h2', { text: t('providers.title') }),
      h('button', {
        class: 'ghost small',
        onclick: async (event) => {
          event.currentTarget.disabled = true;
          event.currentTarget.textContent = t('providers.importing');
          try {
            const response = await api.importProviders();
            state.settings = response.settings;
            state.providers = response.providers;
            state.providersMeta = { sources: response.sources ?? [], warnings: response.warnings ?? [] };
            notify(t('providers.imported', { count: (response.providers ?? []).length }), 'ok');
          } catch (error) {
            notify(String(error.message ?? error), 'error');
          }
          render();
        },
      }, t('providers.import'))),
  );

  if (state.providers.length === 0) {
    section.append(h('p', { class: 'muted', text: t('providers.none') }));
  }

  for (const provider of state.providers) {
    section.append(h('details', { class: 'provider', open: state.providers.length <= 3 },
      h('summary', {},
        h('strong', { text: provider.displayName ?? provider.name }),
        h('span', { class: `pill pill-key-${provider.keyStatus}` },
          `${t('providers.keyStatus')}: ${t(`providers.key.${provider.keyStatus}`)}`),
        h('span', { class: 'muted small', text: `${provider.models.length} ${t('providers.models')}` })),
      h('dl', { class: 'kv' },
        h('dt', { text: t('providers.baseURL') }), h('dd', { text: provider.baseURL ?? '—' }),
        h('dt', { text: t('providers.apiKeyEnv') }), h('dd', { text: provider.apiKeyEnv ?? '—' }),
      ),
      h('ul', { class: 'model-list' }, provider.models.map((model) =>
        h('li', {},
          h('code', { text: model.id }),
          model.contextWindow ? h('span', { class: 'muted small', text: ` · ${formatNumber(model.contextWindow)} ctx` }) : null,
          model.reasoningEfforts
            ? h('span', { class: 'muted small', text: ` · ${Object.keys(model.reasoningEfforts).join(', ')}` })
            : null))),
      h('button', {
        class: 'ghost small danger-text',
        onclick: async () => {
          const response = await api.removeProvider(provider.name);
          state.settings = response.settings;
          state.providers = response.providers;
          render();
        },
      }, t('providers.remove')),
    ));
  }

  const nameInput = h('input', { type: 'text', placeholder: t('providers.name') });
  const jsonInput = h('textarea', {
    rows: 4,
    placeholder: '{\n  "api": "openai-completions",\n  "baseURL": "https://…/v1",\n  "apiKeyEnv": "MY_KEY",\n  "models": [{ "id": "model-id" }]\n}',
  });
  section.append(h('details', { class: 'provider' },
    h('summary', { text: t('providers.addTitle') }),
    h('div', { class: 'grid grid-2' }, nameInput, jsonInput),
    h('button', {
      class: 'ghost small',
      onclick: async () => {
        try {
          const spec = JSON.parse(jsonInput.value);
          const response = await api.putProvider(nameInput.value.trim(), spec);
          state.settings = response.settings;
          state.providers = response.providers;
          render();
        } catch (error) {
          notify(String(error.message ?? error), 'error');
        }
      },
    }, t('providers.add')),
  ));

  if (state.providersMeta.sources?.length) {
    section.append(h('details', { class: 'provider' },
      h('summary', { text: t('providers.sources') }),
      h('ul', { class: 'model-list' }, state.providersMeta.sources.map((source) =>
        h('li', {}, h('code', { class: 'small', text: source.file })))),
      state.providersMeta.warnings?.length
        ? h('ul', { class: 'warnings' }, state.providersMeta.warnings.map((warning) => h('li', { text: warning })))
        : null));
  }
  return section;
}

/* ------------------------------------------------------------------ events */

function renderEventsView(view) {
  clear(view);
  view.append(h('section', { class: 'card' },
    h('div', { class: 'card-head' },
      h('h2', { text: t('events.title') }),
      h('label', { class: 'check small' },
        h('input', {
          type: 'checkbox',
          checked: state.autoScroll,
          onchange: (event) => {
            state.autoScroll = event.target.checked;
          },
        }), t('events.autoscroll')),
      h('button', {
        class: 'ghost small',
        onclick: () => {
          state.events = [];
          render();
        },
      }, t('events.clear'))),
    h('pre', { id: 'event-log', class: 'event-log' }),
  ));
  renderEventsTail();
}

function renderEventsTail() {
  const log = $('#event-log');
  if (!log) return;
  const lines = state.events.slice(-200).map((event) => {
    const agent = event.data?.agentId ? ` ${event.data.agentId}` : '';
    const detail =
      event.type === 'agent_event'
        ? String(event.data?.event?.type ?? '')
        : event.type === 'agent_finished'
          ? String(event.data?.status ?? '')
          : event.type === 'log'
            ? String(event.data?.message ?? '')
            : event.type === 'run_finished'
              ? String(event.data?.status ?? '')
              : '';
    return `${formatTime(event.ts)} #${event.seq} ${event.runId}${agent} ${event.type} ${detail}`;
  });
  log.textContent = lines.join('\n') || t('events.empty');
  if (state.autoScroll) log.scrollTop = log.scrollHeight;
}

/* -------------------------------------------------------------------- boot */

bootstrap();
