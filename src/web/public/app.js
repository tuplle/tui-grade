import Alpine from 'alpinejs';

const THEME_KEY = 'tui-grade-theme';
const EVENT_TYPES = [
  'run-start',
  'submissions',
  'submission-start',
  'build',
  'scenario-start',
  'scenario-end',
  'submission-score',
  'submission-end',
  'run-end',
];

function applyTheme(mode) {
  const dark = mode === 'dark' || (mode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
}

async function api(path, options = {}) {
  const method = options.method || 'GET';
  const headers = { ...(options.headers || {}) };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET') headers['X-TUI-Grade'] = '1';
  const response = await fetch(path, { ...options, method, headers });
  const text = await response.text();
  let data = null;
  if (text !== '') {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: { message: text } };
    }
  }
  if (!response.ok) throw new Error(data?.error?.message || response.statusText);
  return data;
}

document.addEventListener('alpine:init', () => {
  Alpine.data('dashboard', () => ({
    version: '',
    resultsRoot: '',
    runs: [],
    run: null,
    events: [],
    view: 'run',
    error: '',
    notice: '',
    busy: false,
    serverStopped: false,
    theme: localStorage.getItem(THEME_KEY) || 'system',
    form: { assignmentDir: '', inputPath: '', only: '', locale: '', keepWorkdirs: false },
    inspection: null,
    studentResult: null,
    manualGroups: [],
    manualValues: {},
    progress: { total: 0, done: 0, student: '', scenario: '' },
    browser: { open: false, mode: 'assignment', path: '', parent: null, entries: [] },
    overlay: null,
    source: null,
    sourceRunId: null,
    media: null,

    init() {
      applyTheme(this.theme);
      this.media = window.matchMedia('(prefers-color-scheme: dark)');
      this.media.addEventListener('change', () => {
        if (this.theme === 'system') applyTheme('system');
      });
      window.addEventListener('hashchange', () => this.handleHash());
      void this.loadState().then(() => this.handleHash());
    },

    setTheme(mode) {
      this.theme = mode;
      localStorage.setItem(THEME_KEY, mode);
      applyTheme(mode);
    },

    async loadState() {
      try {
        const data = await api('/api/state');
        this.version = data.version;
        this.resultsRoot = data.resultsRoot;
        this.runs = data.runs || [];
        if (data.active && !this.runs.some((run) => run.id === data.active.id)) this.runs = [data.active, ...this.runs];
        if (data.initial) {
          if (!this.form.assignmentDir && data.initial.assignmentDir) this.form.assignmentDir = data.initial.assignmentDir;
          if (!this.form.inputPath && data.initial.inputPath) this.form.inputPath = data.initial.inputPath;
        }
      } catch (error) {
        this.error = error.message;
      }
    },

    async handleHash() {
      const hash = location.hash.replace(/^#\/?/, '');
      const parts = hash.split('/').filter(Boolean);
      if (parts[0] === 'history') {
        this.view = 'history';
        this.run = null;
        this.closeSource();
        await this.loadState();
        return;
      }
      if (parts[0] === 'run' && parts[1]) {
        await this.loadRun(parts[1]);
        if (parts[2] === 'student' && parts[3]) {
          await this.loadStudent(parts[1], parts[3]);
        } else {
          this.view = 'run';
          this.studentResult = null;
        }
        return;
      }
      this.view = 'run';
      this.run = null;
      this.studentResult = null;
      this.events = [];
      this.closeSource();
    },

    async loadRun(id, attach = true) {
      try {
        const run = await api('/api/runs/' + encodeURIComponent(id));
        this.run = run;
        this.progress.total = Math.max(this.progress.total, run.students.length);
        this.progress.done = run.students.length;
        if (run.status === 'running' && attach) this.openSource(run.id);
      } catch (error) {
        this.error = error.message;
      }
    },

    async refreshRun(id) {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        await this.loadRun(id, false);
        if (this.run?.status !== 'running') break;
      }
      await this.loadState();
    },

    async validate() {
      this.error = '';
      this.notice = '';
      this.busy = true;
      try {
        this.inspection = await api('/api/inspect', {
          method: 'POST',
          body: JSON.stringify({ assignmentDir: this.form.assignmentDir }),
        });
        this.notice = this.inspection.ok ? 'Assignment is valid.' : 'The assignment has errors.';
      } catch (error) {
        this.error = error.message;
      } finally {
        this.busy = false;
      }
    },

    async startRun() {
      this.error = '';
      this.notice = '';
      this.busy = true;
      try {
        const only = this.form.only
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean);
        const data = await api('/api/runs', {
          method: 'POST',
          body: JSON.stringify({
            assignmentDir: this.form.assignmentDir,
            inputPath: this.form.inputPath,
            ...(only.length > 0 ? { only } : {}),
            ...(this.form.locale ? { locale: this.form.locale } : {}),
            ...(this.form.keepWorkdirs ? { keepWorkdirs: true } : {}),
          }),
        });
        this.run = data.run;
        this.events = [];
        this.progress = { total: 0, done: 0, student: '', scenario: '' };
        this.view = 'run';
        this.studentResult = null;
        this.openSource(data.runId);
        if (location.hash !== '#/run/' + data.runId) location.hash = '#/run/' + data.runId;
        this.notice = 'Run started.';
        await this.loadState();
      } catch (error) {
        this.error = error.message;
      } finally {
        this.busy = false;
      }
    },

    async stopRun() {
      if (!this.run) return;
      if (!confirm('Stop the active grading run?')) return;
      try {
        this.run = await api('/api/runs/' + encodeURIComponent(this.run.id) + '/stop', { method: 'POST' });
        this.notice = 'Stopping…';
      } catch (error) {
        this.error = error.message;
      }
    },

    async openRun(id) {
      if (location.hash === '#/run/' + id) await this.loadRun(id);
      else location.hash = '#/run/' + id;
    },

    async openStudent(studentId) {
      if (!this.run) return;
      const hash = '#/run/' + this.run.id + '/student/' + studentId;
      if (location.hash === hash) await this.loadStudent(this.run.id, studentId);
      else location.hash = hash;
    },

    backToRun() {
      if (this.run) location.hash = '#/run/' + this.run.id;
    },

    async loadStudent(runId, studentId) {
      this.busy = true;
      try {
        this.studentResult = await api('/api/runs/' + encodeURIComponent(runId) + '/students/' + encodeURIComponent(studentId));
        this.view = 'student';
        this.manualGroups = [];
        this.manualValues = {};
        if (this.run?.completed) await this.loadManual(runId, studentId);
      } catch (error) {
        this.error = error.message;
      } finally {
        this.busy = false;
      }
    },

    async loadManual(runId, studentId) {
      try {
        const manual = await api('/api/runs/' + encodeURIComponent(runId) + '/manual');
        this.manualGroups = manual.groups || [];
        this.manualValues = manual.values || {};
        this.manualValues[studentId] ??= {};
      } catch {
        this.manualGroups = [];
      }
    },

    async saveManual() {
      if (!this.run || !this.studentResult) return;
      this.busy = true;
      this.error = '';
      try {
        const data = await api('/api/runs/' + encodeURIComponent(this.run.id) + '/manual', {
          method: 'PUT',
          body: JSON.stringify({ points: this.manualValues }),
        });
        this.notice = 'Manual points saved and results re-scored.';
        await this.loadRun(this.run.id);
        await this.loadStudent(this.run.id, this.studentResult.student.id);
        if (data.issues?.length) this.notice += ' ' + data.issues.map((issue) => issue.message).join('; ');
      } catch (error) {
        this.error = error.message;
      } finally {
        this.busy = false;
      }
    },

    openSource(id) {
      if (this.source !== null && this.sourceRunId === id) return;
      this.closeSource();
      const source = new EventSource('/api/runs/' + encodeURIComponent(id) + '/events');
      this.source = source;
      this.sourceRunId = id;
      for (const type of EVENT_TYPES) {
        source.addEventListener(type, (event) => this.onEvent(event));
      }
      source.onerror = () => {
        if (this.run && this.run.status !== 'running') this.closeSource();
      };
    },

    closeSource() {
      if (this.source) {
        this.source.close();
        this.source = null;
        this.sourceRunId = null;
      }
    },

    onEvent(event) {
      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }
      const seq = Number(event.lastEventId) || this.events.length + 1;
      this.events.push({ seq, event: payload });
      if (this.events.length > 1000) this.events.splice(0, this.events.length - 1000);
      if (payload.type === 'run-start') {
        if (this.run) {
          this.run.assignment = payload.assignment;
          this.run.locale = payload.locale;
          const item = this.runs.find((run) => run.id === this.run.id);
          if (item) item.assignment = payload.assignment;
        }
      }
      if (payload.type === 'submissions') this.progress.total = payload.count;
      if (payload.type === 'submission-start') {
        this.progress.student = payload.displayName || payload.studentId;
        this.progress.scenario = '';
      }
      if (payload.type === 'scenario-start') this.progress.scenario = payload.title || payload.scenarioId;
      if (payload.type === 'scenario-end') this.progress.scenario = '';
      if (payload.type === 'submission-end') {
        this.progress.done += 1;
        if (this.run && payload.result?.student) {
          const student = payload.result.student;
          const row = {
            studentId: student.id,
            displayName: student.displayName,
            points: payload.result.score.points,
            max: payload.result.score.max,
          };
          const index = this.run.students.findIndex((item) => item.studentId === student.id);
          if (index === -1) this.run.students.push(row);
          else this.run.students[index] = row;
        }
      }
      if (payload.type === 'run-end') {
        this.progress.done = this.progress.total;
        this.closeSource();
        if (this.run) void this.refreshRun(this.run.id);
      }
    },

    async browse(mode) {
      this.browser.open = true;
      this.browser.mode = mode;
      const start = mode === 'assignment' ? this.form.assignmentDir : this.form.inputPath;
      await this.browseTo(start || '');
    },

    async browseTo(path) {
      try {
        const data = await api('/api/fs?mode=' + this.browser.mode + '&path=' + encodeURIComponent(path));
        this.browser.path = data.path;
        this.browser.parent = data.parent;
        this.browser.entries = data.entries;
      } catch (error) {
        this.error = error.message;
      }
    },

    chooseCurrent() {
      if (this.browser.mode === 'assignment') this.form.assignmentDir = this.browser.path;
      else this.form.inputPath = this.browser.path;
      this.browser.open = false;
    },

    chooseFile(path) {
      this.form.inputPath = path;
      this.browser.open = false;
    },

    async loadArtifact(path) {
      if (!this.run || !this.studentResult) return;
      try {
        const url =
          '/api/runs/' +
          encodeURIComponent(this.run.id) +
          '/students/' +
          encodeURIComponent(this.studentResult.student.id) +
          '/artifact?path=' +
          encodeURIComponent(path);
        const response = await fetch(url);
        if (!response.ok) throw new Error('Artifact not found');
        this.openText(path, await response.text());
      } catch (error) {
        this.error = error.message;
      }
    },

    openText(title, text) {
      this.overlay = { title, text: text || '(empty)' };
    },

    openCheck(check) {
      const parts = [];
      if (check.message) parts.push(check.message);
      if (check.expected) parts.push('Expected:\n' + check.expected);
      if (check.actual) parts.push('Actual:\n' + check.actual);
      this.openText(check.description, parts.join('\n\n'));
    },

    async quitServer() {
      if (this.run?.status === 'running' && !confirm('A run is in progress. Stop it and quit the server?')) return;
      if (this.run?.status !== 'running' && !confirm('Stop the tui-grade server?')) return;
      try {
        await api('/api/shutdown', { method: 'POST' });
      } catch {
        // The server may close before the response is read.
      }
      this.serverStopped = true;
    },

    progressPercent() {
      return this.progress.total > 0 ? Math.min(100, Math.round((this.progress.done / this.progress.total) * 100)) : 0;
    },

    formatNumber(value) {
      return Number(Number(value).toFixed(2));
    },

    formatDate(value) {
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
    },

    statusClass(status) {
      if (status === 'passed') return 'text-success';
      if (status === 'error') return 'text-danger';
      return 'text-warning';
    },

    eventText(event) {
      if (event.type === 'run-start') return event.assignment;
      if (event.type === 'submissions') return event.count + ' submissions';
      if (event.type === 'submission-start') return event.displayName || event.studentId;
      if (event.type === 'build') return (event.ok ? 'build ok' : 'build failed') + ' (' + event.durationMs + ' ms)';
      if (event.type === 'scenario-start') return event.title || event.scenarioId;
      if (event.type === 'scenario-end') return event.scenarioId + ' · ' + event.status;
      if (event.type === 'submission-score') return event.points + ' / ' + event.max;
      if (event.type === 'submission-end') return event.studentId;
      if (event.type === 'run-end') return event.interrupted ? 'stopped' : 'finished';
      return '';
    },
  }));
});

Alpine.start();
