'use strict';

// ---------- utilitários de caminho (renderer não tem acesso ao módulo path) ----------

const SEP = navigator.userAgent.includes('Windows') ? '\\' : '/';

// Pasta virtual "Meu Computador": lista as unidades. Não é um caminho real do disco.
const PC = '::pc';
const PC_LABEL = 'Meu Computador';
const isDriveRoot = (p) => /^[A-Za-z]:[\\/]?$/.test(p);

function displayPath(p) {
  return p === PC ? PC_LABEL : p;
}

function joinPath(dir, name) {
  if (dir === PC) return name.endsWith(':') ? name + '\\' : name; // 'C:' → 'C:\'
  return dir.endsWith('\\') || dir.endsWith('/') ? dir + name : dir + SEP + name;
}

function parentPath(p) {
  if (p === PC) return PC;
  if (isDriveRoot(p)) return PC; // subir da raiz de uma unidade leva a "Meu Computador"
  const trimmed = p.replace(/[\\/]+$/, '');
  const i = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'));
  if (i < 0) return p;
  if (i === 2 && /^[A-Za-z]:/.test(trimmed)) return trimmed.slice(0, 3); // C:\
  if (i === 0) return '/';
  return trimmed.slice(0, i);
}

function baseName(p) {
  const trimmed = p.replace(/[\\/]+$/, '');
  return trimmed.slice(Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/')) + 1) || p;
}

function splitExt(name, isDir) {
  if (isDir) return [name, ''];
  const i = name.lastIndexOf('.');
  return i <= 0 ? [name, ''] : [name.slice(0, i), name.slice(i + 1)];
}

function formatSize(n) {
  if (n == null) return '<DIR>';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return (i === 0 ? String(v) : v.toFixed(v >= 100 ? 0 : 1)) + ' ' + units[i];
}

function formatDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// Máscara de nome: com * ou ? casa o nome inteiro; sem curingas, basta conter o texto. Ignora maiúsculas.
function nameMatcher(pattern) {
  const esc = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const wild = /[*?]/.test(pattern);
  return new RegExp(wild ? '^' + esc.replace(/\*/g, '.*').replace(/\?/g, '.') + '$' : esc, 'i');
}

// Lista uma pasta real, ou as unidades quando o alvo é "Meu Computador".
async function listPath(target) {
  if (target !== PC) return fm.list(target);
  const infos = await fm.driveInfo();
  return {
    ok: true,
    entries: infos.map((d) => ({
      name: d.path.replace(/[\\/]$/, ''), // 'C:'
      isDir: true,
      drive: true,
      size: d.total,
      free: d.free,
      mtime: 0,
      attr: '',
    })),
  };
}

// ---------- modos de visualização e miniaturas ----------

const VIEWS = ['details', 'medium', 'large'];
const VIEW_LABELS = {
  details: ['☰', 'Detalhes', 'Ctrl+Shift+1'],
  medium: ['▦', 'Ícones médios', 'Ctrl+Shift+2'],
  large: ['▣', 'Ícones grandes', 'Ctrl+Shift+3'],
};

const thumbCache = new Map(); // chave (caminho|data|tamanho) → data URL; descarta os mais antigos
const thumbInflight = new Map();
const thumbQueue = [];
let thumbActive = 0;
const THUMB_PARALLEL = 4;

function pumpThumbs() {
  while (thumbActive < THUMB_PARALLEL && thumbQueue.length) {
    const { t, resolve } = thumbQueue.pop(); // o que entrou na tela por último é o mais urgente
    thumbActive++;
    fm.thumbnail(t.fullPath, t.size)
      .then((url) => {
        if (url) {
          thumbCache.set(t.key, url);
          if (thumbCache.size > 1500) thumbCache.delete(thumbCache.keys().next().value);
        }
        resolve(url);
      })
      .catch(() => resolve(null))
      .finally(() => {
        thumbActive--;
        thumbInflight.delete(t.key);
        pumpThumbs();
      });
  }
}

function fetchThumb(t) {
  if (thumbCache.has(t.key)) return Promise.resolve(thumbCache.get(t.key));
  if (!thumbInflight.has(t.key)) {
    thumbInflight.set(t.key, new Promise((resolve) => {
      thumbQueue.push({ t, resolve });
      pumpThumbs();
    }));
  }
  return thumbInflight.get(t.key);
}

function loadThumb(img) {
  const t = img._thumb;
  if (!t) return;
  fetchThumb(t).then((url) => {
    if (!url || !img.isConnected) return; // sem miniatura, ou a lista já foi redesenhada (o cache serve no próximo render)
    img.src = url;
    img.classList.remove('pending');
    t.box.classList.add('loaded');
  });
}

function buildViewPicker() {
  const box = document.getElementById('views');
  for (const v of VIEWS) {
    const [glyph, name, key] = VIEW_LABELS[v];
    const b = document.createElement('button');
    b.className = 'view-btn';
    b.dataset.view = v;
    b.textContent = glyph;
    b.title = `${name} (${key}; Ctrl + roda do mouse muda o tamanho)`;
    b.setAttribute('aria-label', name);
    b.addEventListener('click', () => {
      if (modalOpen) return;
      active.setView(v);
      active.listEl.focus();
    });
    box.appendChild(b);
  }
}

function updateViewPicker() {
  document.querySelectorAll('.view-btn').forEach((b) => b.classList.toggle('on', b.dataset.view === active.view));
}

// ---------- configurações e sessão (localStorage; pode falhar, então tudo é opcional) ----------

function loadJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function storeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // sem armazenamento: o app segue funcionando, apenas não lembra o estado
  }
}

const settings = { singleClick: loadJson('fm.settings', {}).singleClick === true };
let sessionReady = false;

function saveSession() {
  if (!sessionReady) return;
  storeJson('fm.session', { panels: panels.map((p) => (p.inited ? p.snapshot() : null)) });
}

// ---------- diálogos ----------

const overlay = document.getElementById('overlay');
const dlgTitle = document.getElementById('dlg-title');
const dlgBody = document.getElementById('dlg-body');
const dlgButtons = document.getElementById('dlg-buttons');
let modalOpen = false;
let closeCurrentDialog = null;

/**
 * Exibe um diálogo modal.
 * build(bodyEl) monta o corpo e pode devolver { focus, getValue }.
 * buttons: [{ label, value, kind }]; Enter aciona o botão com kind 'primary'/'danger', Esc cancela (null).
 */
function showDialog({ title, build, buttons }) {
  return new Promise((resolve) => {
    modalOpen = true;
    dlgTitle.textContent = title;
    dlgBody.replaceChildren();
    dlgButtons.replaceChildren();
    const ctl = (build && build(dlgBody)) || {};
    const prevFocus = document.activeElement;

    let done = false;
    const finish = (value) => {
      if (done) return;
      // diálogos com validação (ctl.canSubmit) não confirmam enquanto houver erro; cancelar sempre vale
      if (value !== null && ctl.canSubmit && !ctl.canSubmit()) return;
      done = true;
      closeCurrentDialog = null;
      const extra = ctl.getValue ? ctl.getValue() : undefined;
      overlay.hidden = true;
      modalOpen = false;
      document.removeEventListener('keydown', onKey, true);
      if (prevFocus && prevFocus.focus) prevFocus.focus();
      resolve(value === null ? null : { value, extra });
    };

    let defaultBtn = null;
    for (const b of buttons) {
      const el = document.createElement('button');
      el.textContent = b.label;
      if (b.kind) el.className = b.kind;
      el.addEventListener('click', () => finish(b.value));
      dlgButtons.appendChild(el);
      if (b.kind === 'primary' || b.kind === 'danger') defaultBtn = b;
    }

    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finish(null);
      } else if (e.key === 'Enter' && defaultBtn && !(e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault();
        e.stopPropagation();
        finish(defaultBtn.value);
      }
    };
    document.addEventListener('keydown', onKey, true);
    closeCurrentDialog = () => finish(null);

    overlay.hidden = false;
    if (ctl.focus) ctl.focus();
    else dlgButtons.querySelector('button.primary, button.danger, button')?.focus();
  });
}

function textInput(label, value, selectBase) {
  return (body) => {
    const l = document.createElement('div');
    l.textContent = label;
    l.style.marginBottom = '6px';
    const input = document.createElement('input');
    input.type = 'text';
    input.value = value;
    body.append(l, input);
    return {
      focus() {
        input.focus();
        if (selectBase) {
          const i = value.lastIndexOf('.');
          input.setSelectionRange(0, i > 0 ? i : value.length);
        } else input.select();
      },
      getValue: () => input.value,
    };
  };
}

async function askText(title, label, value = '', selectBase = false) {
  const r = await showDialog({
    title,
    build: textInput(label, value, selectBase),
    buttons: [
      { label: 'Cancelar', value: null },
      { label: 'OK', value: true, kind: 'primary' },
    ],
  });
  return r && r.value ? r.extra.trim() : null;
}

async function confirmDialog(title, message, items, okLabel = 'OK', kind = 'primary') {
  const r = await showDialog({
    title,
    build(body) {
      const p = document.createElement('div');
      p.textContent = message;
      body.appendChild(p);
      if (items && items.length) {
        const ul = document.createElement('ul');
        for (const it of items.slice(0, 50)) {
          const li = document.createElement('li');
          li.textContent = it;
          ul.appendChild(li);
        }
        if (items.length > 50) {
          const li = document.createElement('li');
          li.textContent = `… e mais ${items.length - 50}`;
          ul.appendChild(li);
        }
        body.appendChild(ul);
      }
    },
    buttons: [
      { label: 'Cancelar', value: null },
      { label: okLabel, value: true, kind },
    ],
  });
  return !!r;
}

function infoDialog(title, message, items) {
  return showDialog({
    title,
    build(body) {
      const p = document.createElement('div');
      p.textContent = message;
      body.appendChild(p);
      if (items) {
        const ul = document.createElement('ul');
        for (const it of items) {
          const li = document.createElement('li');
          li.textContent = it;
          ul.appendChild(li);
        }
        body.appendChild(ul);
      }
    },
    buttons: [{ label: 'OK', value: true, kind: 'primary' }],
  });
}

// ---------- progresso de operações longas ----------

let jobSeq = 0;
const progressHandlers = new Map();
fm.onProgress((id, state) => progressHandlers.get(id)?.(state));

/**
 * Executa runner(jobId) mostrando um diálogo com barra de progresso.
 * Fechar o diálogo (Cancelar/Esc) pede o cancelamento ao processo principal.
 */
async function withProgress(title, runner) {
  const id = ++jobSeq;
  const started = Date.now();
  let finished = false;
  let bar;
  let cur;
  let det;

  const dlg = showDialog({
    title,
    build(body) {
      const box = document.createElement('div');
      box.className = 'progress-box';
      cur = document.createElement('div');
      cur.className = 'cur';
      cur.textContent = 'Preparando…';
      bar = document.createElement('progress');
      bar.max = 1;
      bar.value = 0;
      det = document.createElement('div');
      det.className = 'det';
      box.append(cur, bar, det);
      body.appendChild(box);
    },
    buttons: [{ label: 'Cancelar', value: null }],
  });
  dlg.then(() => {
    if (!finished) {
      fm.cancel(id);
      det.textContent = 'Cancelando…';
    }
  });

  progressHandlers.set(id, (s) => {
    cur.textContent = s.current || 'Preparando…';
    const byBytes = s.totalBytes > 0;
    const total = byBytes ? s.totalBytes : s.totalFiles;
    const doneN = byBytes ? s.bytes : s.files;
    bar.value = total ? Math.min(1, doneN / total) : 0;
    const parts = [`${Math.round(bar.value * 100)}%`, `${s.files} de ${s.totalFiles} item(ns)`];
    if (byBytes) {
      parts.push(`${formatSize(s.bytes)} de ${formatSize(s.totalBytes)}`);
      const secs = (Date.now() - started) / 1000;
      if (secs > 1 && s.bytes) parts.push(`${formatSize(s.bytes / secs)}/s`);
    }
    det.textContent = parts.join(' · ');
  });

  try {
    return await runner(id);
  } finally {
    finished = true;
    progressHandlers.delete(id);
    if (closeCurrentDialog) closeCurrentDialog();
  }
}

const msgEl = document.getElementById('message');
let msgTimer = null;
function flash(text, isError = false) {
  msgEl.textContent = text;
  msgEl.classList.toggle('error', isError);
  clearTimeout(msgTimer);
  msgTimer = setTimeout(() => (msgEl.textContent = ''), 6000);
}

// ---------- painel ----------

class Panel {
  constructor(el, index) {
    this.el = el;
    this.index = index;
    this.inited = false;
    el.dataset.idx = index;
    this.listEl = el.querySelector('.list');
    this.pathEl = el.querySelector('.pathbar');
    this.statusEl = el.querySelector('.status');
    this.drivesEl = el.querySelector('.drives');
    this.path = '';
    this.entries = [];
    this.selected = new Set();
    this.cursor = 0;
    this.sortKey = 'name';
    this.sortDir = 1;
    this.showHidden = false;
    this.history = [];
    this.rowHeight = 22;
    this.view = 'details'; // 'details' | 'medium' | 'large' (ícones/miniaturas)
    this.io = null; // IntersectionObserver das miniaturas

    // Ctrl + roda do mouse: aumenta/diminui os ícones, como no Explorer
    this.listEl.addEventListener(
      'wheel',
      (e) => {
        if (!e.ctrlKey) return;
        e.preventDefault();
        const i = VIEWS.indexOf(this.view) + (e.deltaY < 0 ? 1 : -1);
        this.setView(VIEWS[Math.min(Math.max(i, 0), VIEWS.length - 1)]);
      },
      { passive: false }
    );
    this.tabsEl = el.querySelector('.tabs');
    this.tabs = [{}];
    this.tabIdx = 0;

    this.pathEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.go(this.pathEl.value.trim());
        this.listEl.focus();
      } else if (e.key === 'Escape') {
        this.pathEl.value = displayPath(this.path);
        this.listEl.focus();
      }
      e.stopPropagation();
    });
    this.pathEl.addEventListener('focus', () => setActive(this));

    // filtro da pasta atual (Ctrl+F): atualiza a lista a cada tecla
    this.filterEl = el.querySelector('.filterbar');
    this.filter = '';
    this.filterRe = null;
    this.filterEl.addEventListener('input', () => this.setFilter(this.filterEl.value.trim()));
    this.filterEl.addEventListener('focus', () => setActive(this));
    this.filterEl.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.clearFilter();
      } else if (e.key === 'Enter' || e.key === 'ArrowDown') {
        e.preventDefault();
        this.listEl.focus();
      }
      e.stopPropagation();
    });

    el.querySelectorAll('.colheads [data-key]').forEach((h) =>
      h.addEventListener('click', () => this.setSort(h.dataset.key))
    );

    // Tudo é tratado no mousedown: render() recria as linhas, o que impede o navegador
    // de disparar 'dblclick' na linha original.
    this.listEl.addEventListener('mousedown', (e) => {
      setActive(this);
      const row = e.target.closest('.row');
      if (!row) {
        // área vazia da lista: clique desmarca tudo; arrastar desenha um retângulo de seleção
        if (e.button !== 0 || !this.isListBackground(e)) return;
        e.preventDefault(); // evita selecionar texto durante o arraste
        if (!e.ctrlKey && !e.shiftKey && this.selected.size) {
          this.selected.clear();
          this.render();
        }
        startMarquee(this, e);
        return;
      }
      const idx = Number(row.dataset.idx);
      const entry = this.entries[idx];
      if (!entry) return;

      if (e.button === 1) {
        // clique do meio numa pasta: abre em nova aba
        e.preventDefault();
        if (entry.isDir) this.newTab(joinPath(this.path, entry.name)).catch((err) => flash(String(err), true));
        return;
      }
      if (e.button !== 0) return;

      const anchor = this.cursor;
      this.cursor = idx;
      const plain = !e.ctrlKey && !e.shiftKey;
      // clique simples num item não marcado substitui a seleção (como no Explorer); num item já
      // marcado a seleção é mantida, pois pode ser o início de um arraste do grupo
      const collapse = plain && this.selected.has(entry.name) && this.selected.size > 1;
      if (plain && !this.selected.has(entry.name)) this.selected.clear();
      if (e.ctrlKey) this.toggleSelect(idx, false);
      else if (e.shiftKey) {
        const [a, b] = anchor < idx ? [anchor, idx] : [idx, anchor];
        for (let i = a; i <= b; i++) this.selected.add(this.entries[i].name);
      }
      this.render();

      // duplo clique abre qualquer item; clique único (se ativado) abre apenas pastas
      if (plain && (e.detail >= 2 || (settings.singleClick && entry.isDir))) {
        this.enter().catch((err) => flash(String(err), true));
      } else if (plain && !entry.drive && this.path !== PC) {
        // pode virar um arrastar (ver "arrastar entre painéis e abas")
        const items = this.selected.has(entry.name) ? this.targets() : [entry];
        dragState = {
          srcDir: this.path,
          items,
          x: e.clientX,
          y: e.clientY,
          started: false,
          target: null,
          // soltar sem arrastar sobre um item já marcado deixa só ele marcado
          collapse: collapse ? { panel: this, name: entry.name } : null,
        };
      }
    });
    this.listEl.addEventListener('contextmenu', (e) => {
      const row = e.target.closest('.row');
      if (row) {
        setActive(this);
        this.cursor = Number(row.dataset.idx);
        this.toggleSelect(this.cursor, false);
        this.render();
      }
      e.preventDefault();
    });
  }

  // snap: estado salvo da sessão anterior (opcional); fallback: pasta inicial
  async init(snap, fallback) {
    this.inited = true;
    await this.renderDrives();
    const saved = (snap?.tabs || []).filter((t) => t && typeof t.path === 'string' && t.path);
    if (saved.length) {
      this.tabs = saved.map((t) => ({
        path: t.path,
        history: [],
        sortKey: t.sortKey || 'name',
        sortDir: t.sortDir === -1 ? -1 : 1,
        showHidden: !!t.showHidden,
        view: VIEWS.includes(t.view) ? t.view : 'details',
      }));
      await this.loadTab(Math.min(Math.max(0, snap.idx | 0), this.tabs.length - 1));
    }
    if (!this.path) await this.go(fallback, false);
  }

  snapshot() {
    this.saveTab();
    return {
      idx: this.tabIdx,
      tabs: this.tabs
        .filter((t) => t.path)
        .map((t) => ({ path: t.path, sortKey: t.sortKey, sortDir: t.sortDir, showHidden: t.showHidden, view: t.view })),
    };
  }

  async renderDrives() {
    const drives = await fm.drives();
    this.places ||= await fm.places();
    this.drivesEl.replaceChildren();
    const shortcuts = [
      ['🖥 Área de Trabalho', this.places.desktop],
      ['💻 ' + PC_LABEL, PC],
    ];
    for (const [label, target] of shortcuts) {
      const b = document.createElement('button');
      b.className = 'place';
      b.textContent = label;
      b.title = target === PC ? 'Lista de unidades' : target;
      b.dataset.place = target;
      b.addEventListener('click', () => {
        setActive(this);
        this.go(target);
      });
      this.drivesEl.appendChild(b);
    }
    for (const d of drives) {
      const b = document.createElement('button');
      b.textContent = d.replace(/[\\/]$/, '') || d;
      b.dataset.drive = d;
      b.addEventListener('click', () => {
        setActive(this);
        this.go(d);
      });
      this.drivesEl.appendChild(b);
    }
  }

  markDrive() {
    this.drivesEl.querySelectorAll('button').forEach((b) => {
      const cur = b.dataset.drive
        ? this.path !== PC && this.path.toUpperCase().startsWith(b.dataset.drive.toUpperCase())
        : this.path.toLowerCase() === b.dataset.place.toLowerCase();
      b.classList.toggle('current', cur);
    });
  }

  async go(target, pushHistory = true, focusName = null) {
    if (!target) return;
    if (target.toLowerCase() === PC_LABEL.toLowerCase()) target = PC;
    const res = await listPath(target);
    if (!res.ok) {
      flash(`Não foi possível abrir "${displayPath(target)}": ${res.error}`, true);
      this.pathEl.value = displayPath(this.path);
      return false;
    }
    if (pushHistory && this.path) this.history.push(this.path);
    this.path = target;
    this.raw = res.entries;
    this.filterEl.value = ''; // o filtro vale só para a pasta em que foi aberto
    this.filterEl.hidden = true;
    this.filter = '';
    this.filterRe = null;
    this.selected.clear();
    this.applySort();
    this.cursor = 0;
    if (focusName) {
      const i = this.entries.findIndex((e) => e.name === focusName);
      if (i >= 0) this.cursor = i;
    }
    this.pathEl.value = displayPath(this.path);
    this.markDrive();
    this.renderTabs();
    this.render();
    return true;
  }

  // ----- abas: o estado da aba ativa vive nos campos do painel; as demais ficam em this.tabs -----

  saveTab() {
    this.tabs[this.tabIdx] = {
      path: this.path,
      history: this.history,
      sortKey: this.sortKey,
      sortDir: this.sortDir,
      showHidden: this.showHidden,
      view: this.view,
      cursorName: this.current()?.name,
    };
  }

  tabTitle(path) {
    return path === PC ? PC_LABEL : baseName(path) || path;
  }

  renderTabs() {
    this.tabsEl.replaceChildren();
    this.tabs.forEach((t, i) => {
      const isCur = i === this.tabIdx;
      const path = isCur ? this.path : t.path;
      const el = document.createElement('div');
      el.className = 'tab' + (isCur ? ' current' : '');
      el.title = path || '';
      const label = document.createElement('span');
      label.className = 't';
      label.textContent = this.tabTitle(path || '');
      el.appendChild(label);
      if (this.tabs.length > 1) {
        const x = document.createElement('span');
        x.className = 'x';
        x.textContent = '×';
        x.title = 'Fechar aba (Ctrl+W)';
        x.addEventListener('mousedown', (ev) => {
          ev.stopPropagation();
          this.closeTab(i);
        });
        el.appendChild(x);
      }
      el.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        setActive(this);
        if (ev.button === 1) this.closeTab(i);
        else if (ev.button === 0) this.switchTab(i);
      });
      this.tabsEl.appendChild(el);
    });
    const add = document.createElement('button');
    add.className = 'add';
    add.textContent = '+';
    add.title = 'Nova aba (Ctrl+T)';
    add.addEventListener('click', () => {
      setActive(this);
      this.newTab();
    });
    this.tabsEl.appendChild(add);
    this.tabsEl.querySelector('.tab.current')?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    saveSession();
  }

  // Nova aba: começa idêntica à atual (mesma pasta e ordenação), com histórico próprio,
  // ou já em `path` quando informado. Não há limite de abas.
  async newTab(path) {
    this.saveTab();
    this.tabs.splice(this.tabIdx + 1, 0, { ...this.tabs[this.tabIdx], history: [] });
    this.tabIdx++;
    this.history = [];
    if (path && path !== this.path) await this.go(path, false);
    this.renderTabs();
    this.listEl.focus();
    saveSession();
  }

  async switchTab(i) {
    if (i === this.tabIdx || i < 0 || i >= this.tabs.length) return;
    this.saveTab();
    await this.loadTab(i);
  }

  async loadTab(i) {
    const t = this.tabs[i];
    this.tabIdx = i;
    this.sortKey = t.sortKey;
    this.sortDir = t.sortDir;
    this.showHidden = t.showHidden;
    this.view = t.view || 'details';
    this.applyViewClass();
    if (active === this) updateViewPicker();
    this.history = t.history;
    this.path = '';
    // se a pasta da aba não existir mais, sobe até uma que exista
    let target = t.path;
    while (target && !(await this.go(target, false, t.cursorName))) {
      const parent = parentPath(target);
      if (parent === target) break;
      target = parent;
    }
    this.renderTabs();
    this.listEl.focus();
  }

  async closeTab(i) {
    if (this.tabs.length === 1) return;
    this.saveTab();
    this.tabs.splice(i, 1);
    if (i < this.tabIdx) {
      this.tabIdx--;
      this.renderTabs();
    } else if (i === this.tabIdx) {
      await this.loadTab(Math.min(i, this.tabs.length - 1));
    } else this.renderTabs();
  }

  cycleTab(delta) {
    return this.switchTab((this.tabIdx + delta + this.tabs.length) % this.tabs.length);
  }

  async reload(keepName) {
    const name = keepName ?? this.current()?.name;
    const prevCursor = this.cursor;
    const res = await listPath(this.path);
    if (!res.ok) {
      flash(`Pasta indisponível: ${res.error}`, true);
      return;
    }
    this.raw = res.entries;
    const names = new Set(res.entries.map((e) => e.name));
    for (const n of [...this.selected]) if (!names.has(n)) this.selected.delete(n);
    this.applySort();
    const i = this.entries.findIndex((e) => e.name === name);
    this.cursor = i >= 0 ? i : Math.min(prevCursor, Math.max(0, this.entries.length - 1));
    this.render();
  }

  applySort() {
    const k = this.sortKey;
    const dir = this.sortDir;
    const list = (this.raw || []).filter(
      (e) => (this.showHidden || !e.name.startsWith('.')) && (!this.filterRe || this.filterRe.test(e.name))
    );
    const cmpName = (a, b) => a.name.localeCompare(b.name, 'pt-BR', { numeric: true, sensitivity: 'base' });
    list.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1; // pastas sempre primeiro
      let r = 0;
      if (k === 'name') r = cmpName(a, b);
      else if (k === 'ext') r = splitExt(a.name, a.isDir)[1].localeCompare(splitExt(b.name, b.isDir)[1]) || cmpName(a, b);
      else if (k === 'size') r = (a.size ?? 0) - (b.size ?? 0) || cmpName(a, b);
      else if (k === 'mtime') r = a.mtime - b.mtime || cmpName(a, b);
      return r * dir;
    });
    this.entries = list;
  }

  // true se o clique caiu no fundo da lista e não na barra de rolagem
  isListBackground(e) {
    const r = this.listEl.getBoundingClientRect();
    return e.clientX < r.left + this.listEl.clientWidth && e.clientY < r.top + this.listEl.clientHeight;
  }

  openFilter() {
    this.filterEl.hidden = false;
    this.filterEl.focus();
    this.filterEl.select();
  }

  setFilter(text) {
    this.filter = text;
    this.filterRe = text ? nameMatcher(text) : null;
    this.applySort();
    this.cursor = 0;
    this.render();
  }

  // limpa o filtro e esconde a barra (também chamado ao navegar para outra pasta)
  clearFilter() {
    const had = !!this.filter;
    this.filterEl.value = '';
    this.filterEl.hidden = true;
    this.filter = '';
    this.filterRe = null;
    if (had) {
      this.applySort();
      this.cursor = 0;
      this.render();
    }
    this.listEl.focus();
  }

  setSort(key) {
    if (this.sortKey === key) this.sortDir = -this.sortDir;
    else {
      this.sortKey = key;
      this.sortDir = 1;
    }
    const name = this.current()?.name;
    this.applySort();
    const i = this.entries.findIndex((e) => e.name === name);
    if (i >= 0) this.cursor = i;
    this.render();
  }

  current() {
    return this.entries[this.cursor] || null;
  }

  // itens alvo de uma operação: seleção, ou o item sob o cursor
  targets() {
    if (this.selected.size) return this.entries.filter((e) => this.selected.has(e.name));
    const c = this.current();
    return c ? [c] : [];
  }

  toggleSelect(idx, advance = true) {
    const e = this.entries[idx];
    if (!e) return;
    if (this.selected.has(e.name)) this.selected.delete(e.name);
    else this.selected.add(e.name);
    if (advance) this.moveCursor(1);
  }

  moveCursor(delta, absolute = false) {
    if (!this.entries.length) return;
    const n = absolute ? delta : this.cursor + delta;
    this.cursor = Math.max(0, Math.min(this.entries.length - 1, n));
    this.render();
    this.scrollToCursor();
  }

  scrollToCursor() {
    this.listEl.children[this.cursor]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  // colunas da grade (1 na visualização em detalhes)
  cols() {
    if (this.view === 'details') return 1;
    return Math.max(1, getComputedStyle(this.listEl).gridTemplateColumns.split(' ').filter(Boolean).length);
  }

  pageSize() {
    if (this.view === 'details') return Math.max(1, Math.floor(this.listEl.clientHeight / this.rowHeight) - 1);
    const first = this.listEl.children[0];
    const cellH = first ? first.offsetHeight + 4 : 100;
    return Math.max(1, Math.floor(this.listEl.clientHeight / cellH) - 1) * this.cols();
  }

  applyViewClass() {
    const l = this.listEl;
    l.classList.toggle('icons', this.view !== 'details');
    l.classList.toggle('view-medium', this.view === 'medium');
    l.classList.toggle('view-large', this.view === 'large');
  }

  setView(mode) {
    if (!VIEWS.includes(mode) || mode === this.view) return;
    this.view = mode;
    this.applyViewClass();
    this.render();
    this.scrollToCursor();
    saveSession();
    if (active === this) updateViewPicker();
  }

  async enter() {
    const e = this.current();
    if (!e) return;
    if (e.isDir) await this.go(joinPath(this.path, e.name));
    else {
      const r = await fm.open(joinPath(this.path, e.name));
      if (!r.ok) flash(`Não foi possível abrir: ${r.error}`, true);
    }
  }

  async up() {
    const parent = parentPath(this.path);
    if (parent === this.path) return;
    await this.go(parent, true, baseName(this.path));
  }

  async back() {
    const prev = this.history.pop();
    if (prev) await this.go(prev, false);
  }

  quickJump(prefix) {
    const p = prefix.toLowerCase();
    const i = this.entries.findIndex((e) => e.name.toLowerCase().startsWith(p));
    if (i >= 0) this.moveCursor(i, true);
    return i >= 0;
  }

  render() {
    const frag = document.createDocumentFragment();
    const icons = this.view !== 'details';
    const thumbSize = this.view === 'large' ? 160 : 96; // em px reais; exibido menor para ficar nítido
    this.io?.disconnect();
    this.entries.forEach((e, idx) => {
      const row = document.createElement('div');
      row.className = icons ? 'row cell' : 'row';
      if (e.isDir) row.classList.add('dir');
      if (e.name.startsWith('.')) row.classList.add('hidden-file');
      if (clip?.cut && clip.paths.has(joinPath(this.path, e.name).toLowerCase())) row.classList.add('cut');
      if (this.selected.has(e.name)) row.classList.add('selected');
      if (idx === this.cursor) row.classList.add('cursor');
      row.dataset.idx = idx;
      if (icons) {
        row.title = e.name;
        row.append(this.buildThumb(e, thumbSize));
        const label = document.createElement('div');
        label.className = 'label';
        label.textContent = e.name;
        row.appendChild(label);
        frag.appendChild(row);
        return;
      }
      const [base, ext] = splitExt(e.name, e.isDir);
      const cells = [
        ['c-name', e.isDir ? '[' + e.name + ']' : base],
        ['c-ext', ext],
        ['c-size', formatSize(e.size)],
        ['c-date', e.drive ? (e.free == null ? '' : formatSize(e.free) + ' livres') : formatDate(e.mtime)],
        ['c-attr', e.attr],
      ];
      for (const [cls, text] of cells) {
        const c = document.createElement('div');
        c.className = cls;
        c.textContent = text;
        row.appendChild(c);
      }
      frag.appendChild(row);
    });
    this.listEl.replaceChildren(frag);
    this.updateStatus();
  }

  // Miniatura de um item: usa o cache se já houver; senão mostra um glifo e pede ao processo
  // principal (miniatura/ícone do shell do Windows) só quando a célula aparece na tela.
  buildThumb(e, size) {
    const box = document.createElement('div');
    box.className = 'thumb';
    const img = document.createElement('img');
    img.draggable = false;
    img.alt = '';
    const fullPath = joinPath(this.path, e.name);
    const key = `${fullPath}|${e.mtime}|${size}`;
    const cached = thumbCache.get(key);
    if (cached) {
      img.src = cached;
      box.classList.add('loaded');
    } else {
      img.className = 'pending'; // invisível, mas com tamanho: o IntersectionObserver precisa de uma caixa
      img._thumb = { fullPath, key, size, box };
      this.io ||= new IntersectionObserver(
        (entries) => {
          for (const it of entries) {
            if (!it.isIntersecting) continue;
            this.io.unobserve(it.target);
            loadThumb(it.target);
          }
        },
        { root: this.listEl, rootMargin: '200px' }
      );
      this.io.observe(img);
    }
    box.appendChild(img);
    return box;
  }

  updateStatus() {
    const sel = this.entries.filter((e) => this.selected.has(e.name));
    const bytes = sel.reduce((s, e) => s + (e.size || 0), 0);
    const files = this.entries.filter((e) => !e.isDir).length;
    const dirs = this.entries.length - files;
    const filtered = this.filter ? ` · filtro "${this.filter}"` : '';
    this.statusEl.textContent = sel.length
      ? `${sel.length} selecionado(s) · ${formatSize(bytes)} — de ${files} arquivo(s) e ${dirs} pasta(s)${filtered}`
      : `${files} arquivo(s) · ${dirs} pasta(s)${filtered}`;
    this.el.classList.toggle('active', active === this);
  }
}

// ---------- estado global ----------

const MAX_PANELS = 4;
const panels = []; // sempre MAX_PANELS painéis; só os primeiros `layout.count` ficam visíveis
let active = null;
let quickBuf = '';
let quickTimer = null;

function visiblePanels() {
  return panels.slice(0, layout.count);
}

// "painel oposto": o próximo painel visível, em ciclo
function other() {
  const vis = visiblePanels();
  return vis[(vis.indexOf(active) + 1) % vis.length];
}

function setActive(p) {
  active = p;
  visiblePanels().forEach((x) => x.updateStatus());
  updateViewPicker();
  if (document.activeElement !== p.pathEl && document.activeElement !== p.filterEl) p.listEl.focus();
}

// ---------- layouts de painéis (padrões de encaixe do Windows 11) ----------
// areas: grid-template-areas já com as trilhas das divisórias (v* = vertical, h* = horizontal, 5px);
// cols/rows: proporções (fr) dos painéis; splitters: nome → [eixo, índice da trilha que ele ajusta];
// mini: miniatura exibida no seletor.

const LAYOUTS = [
  { id: 'cols2', name: 'Duas colunas', count: 2, areas: ['p1 v1 p2'], cols: [1, 1], rows: [1], splitters: { v1: ['col', 0] }, mini: ['p1 p2'] },
  { id: 'wide', name: 'Principal 2/3 + lateral 1/3', count: 2, areas: ['p1 v1 p2'], cols: [2, 1], rows: [1], splitters: { v1: ['col', 0] }, mini: ['p1 p1 p2'] },
  { id: 'cols3', name: 'Três colunas', count: 3, areas: ['p1 v1 p2 v2 p3'], cols: [1, 1, 1], rows: [1], splitters: { v1: ['col', 0], v2: ['col', 1] }, mini: ['p1 p2 p3'] },
  { id: 'stack', name: 'Um painel + dois empilhados', count: 3, areas: ['p1 v1 p2', 'p1 v1 h1', 'p1 v1 p3'], cols: [1, 1], rows: [1, 1], splitters: { v1: ['col', 0], h1: ['row', 0] }, mini: ['p1 p2', 'p1 p3'] },
  { id: 'grid', name: 'Grade 2×2', count: 4, areas: ['p1 v1 p2', 'h1 h1 h1', 'p3 v2 p4'], cols: [1, 1], rows: [1, 1], splitters: { v1: ['col', 0], v2: ['col', 0], h1: ['row', 0] }, mini: ['p1 p2', 'p3 p4'] },
];

const panelsEl = document.getElementById('panels');
const SPLIT_PX = 5;
let layout = LAYOUTS[0];
const ratios = {}; // id do layout → { cols, rows } ajustados pelo usuário

function saveLayout() {
  storeJson('fm.layout', { id: layout.id, ratios });
}

function applyTemplates() {
  const r = ratios[layout.id];
  const track = (arr) => arr.map((f) => `minmax(0, ${f}fr)`).join(` ${SPLIT_PX}px `);
  panelsEl.style.gridTemplateColumns = track(r.cols);
  panelsEl.style.gridTemplateRows = track(r.rows);
  panelsEl.style.gridTemplateAreas = layout.areas.map((a) => `"${a}"`).join(' ');
}

function startSplitDrag(e, axis, idx) {
  e.preventDefault();
  const arr = ratios[layout.id][axis === 'col' ? 'cols' : 'rows'];
  const rect = panelsEl.getBoundingClientRect();
  const pad = 8; // padding de #panels (4px de cada lado)
  const total = (axis === 'col' ? rect.width : rect.height) - pad - SPLIT_PX * (arr.length - 1);
  const pxPerFr = total / arr.reduce((s, f) => s + f, 0);
  const start = axis === 'col' ? e.clientX : e.clientY;
  const [a0, b0] = [arr[idx], arr[idx + 1]];
  const min = (a0 + b0) * 0.1; // nenhum painel some por completo
  document.body.classList.add('resizing', axis);
  const move = (ev) => {
    const d = ((axis === 'col' ? ev.clientX : ev.clientY) - start) / pxPerFr;
    const a = Math.min(Math.max(a0 + d, min), a0 + b0 - min);
    arr[idx] = a;
    arr[idx + 1] = a0 + b0 - a;
    applyTemplates();
  };
  const up = () => {
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', up);
    document.body.classList.remove('resizing', axis);
    saveLayout();
  };
  document.addEventListener('mousemove', move);
  document.addEventListener('mouseup', up);
}

async function applyLayout(id) {
  layout = LAYOUTS.find((l) => l.id === id) || LAYOUTS[0];
  ratios[layout.id] ||= { cols: [...layout.cols], rows: [...layout.rows] };

  panelsEl.querySelectorAll('.splitter').forEach((s) => s.remove());
  for (const [name, [axis, idx]] of Object.entries(layout.splitters)) {
    const s = document.createElement('div');
    s.className = `splitter ${axis}`;
    s.style.gridArea = name;
    s.title = 'Arraste para redimensionar · duplo clique restaura';
    s.addEventListener('mousedown', (e) => startSplitDrag(e, axis, idx));
    s.addEventListener('dblclick', () => {
      ratios[layout.id] = { cols: [...layout.cols], rows: [...layout.rows] };
      applyTemplates();
      saveLayout();
    });
    panelsEl.appendChild(s);
  }
  applyTemplates();

  panels.forEach((p, i) => {
    p.el.style.display = i < layout.count ? '' : 'none';
    p.el.style.gridArea = `p${i + 1}`;
  });
  // painéis exibidos pela primeira vez começam na pasta do primeiro painel
  const stored = loadJson('fm.session', {});
  const session = stored.panels || [stored.left, stored.right];
  for (const p of visiblePanels()) {
    if (!p.inited) await p.init(session[p.index], panels[0].path || (await fm.home()));
  }
  if (!visiblePanels().includes(active)) setActive(panels[0]);
  document.querySelectorAll('.layout-btn').forEach((b) => b.classList.toggle('on', b.dataset.layout === layout.id));
  saveLayout();
  saveSession();
}

function buildLayoutPicker() {
  const box = document.getElementById('layouts');
  LAYOUTS.forEach((l, i) => {
    const b = document.createElement('button');
    b.className = 'layout-btn';
    b.dataset.layout = l.id;
    b.title = `${l.name} (Ctrl+Alt+${i + 1})`;
    b.setAttribute('aria-label', l.name);
    b.style.gridTemplateAreas = l.mini.map((r) => `"${r}"`).join(' ');
    for (let n = 1; n <= l.count; n++) {
      const cell = document.createElement('i');
      cell.style.gridArea = `p${n}`;
      b.appendChild(cell);
    }
    b.addEventListener('click', () => {
      if (modalOpen) return;
      applyLayout(l.id).then(() => active.listEl.focus());
    });
    box.appendChild(b);
  });
}

// ---------- operações ----------

// "Meu Computador" só lista unidades: operações que alteram arquivos ficam bloqueadas ali.
function blockedInPC(...panelsToCheck) {
  if (!panelsToCheck.some((p) => p.path === PC)) return false;
  flash(`Esta operação não está disponível em "${PC_LABEL}". Abra uma unidade primeiro.`, true);
  return true;
}

function reportErrors(title, res) {
  if (!res.ok) return infoDialog(title, 'Algumas operações falharam:', res.errors);
}

// Fluxo comum de copiar/mover: confirmação, conflitos, progresso e atualização dos painéis.
// payload: [{ src: caminho completo, name }]
// opts.confirm = false pula a pergunta inicial (colar e arrastar entre painéis já são gestos explícitos);
// conflitos de nome e o progresso continuam aparecendo.
async function transfer(payload, destPath, isMove, opts = {}) {
  const { confirm = true } = opts;
  if (destPath === PC) return blockedInPC({ path: PC });
  const norm = (p) => p.replace(/[\\/]+$/, '').toLowerCase();
  // ignora itens que já estão na pasta de destino (origem == destino)
  const items = payload.filter((it) => norm(joinPath(destPath, it.name)) !== norm(it.src));
  if (!items.length) return flash('Os itens já estão nesta pasta.', true);
  const verb = isMove ? 'Mover' : 'Copiar';
  if (confirm) {
    const ok = await confirmDialog(
      `${verb} para "${destPath}"?`,
      `${verb} ${items.length} item(ns) para:
${destPath}`,
      items.map((i) => i.name),
      verb
    );
    if (!ok) return;
  }

  // detecta conflitos antes, para pedir confirmação de sobrescrita
  const conflicts = [];
  for (const it of items) if (await fm.exists(joinPath(destPath, it.name))) conflicts.push(it.name);
  let overwrite = false;
  if (conflicts.length) {
    overwrite = await confirmDialog(
      'Itens já existentes no destino',
      'Sobrescrever os itens abaixo? (Cancelar = ignorá-los)',
      conflicts,
      'Sobrescrever',
      'danger'
    );
  }
  const res = await withProgress(isMove ? 'Movendo…' : 'Copiando…', (id) =>
    isMove ? fm.move(items, destPath, overwrite, id) : fm.copy(items, destPath, overwrite, id)
  );
  visiblePanels().forEach((p) => p.selected.clear());
  await Promise.all(visiblePanels().map((p) => p.reload()));
  if (res.ok) flash(`${items.length} item(ns) ${isMove ? 'movido(s)' : 'copiado(s)'}.`);
  else if (res.cancelled) flash('Operação cancelada.', true);
  else await reportErrors(`${verb}: ocorreram erros`, res);
}

async function opCopyMove(isMove) {
  const src = active;
  const dst = other();
  const items = src.targets();
  if (!items.length || blockedInPC(src, dst)) return;
  if (src.path === dst.path) return flash('Os dois painéis estão na mesma pasta.', true);
  await transfer(
    items.map((i) => ({ src: joinPath(src.path, i.name), name: i.name })),
    dst.path,
    isMove
  );
}

async function opMkdir() {
  if (blockedInPC(active)) return;
  const name = await askText('Nova pasta', 'Nome da pasta:');
  if (!name) return;
  if (/[\\/:*?"<>|]/.test(name)) return flash('Nome inválido (caracteres \\ / : * ? " < > |).', true);
  const r = await fm.mkdir(joinPath(active.path, name));
  if (!r.ok) return flash(`Erro ao criar pasta: ${r.error}`, true);
  await active.reload(name);
}

async function opDelete(permanent) {
  const items = active.targets();
  if (!items.length || blockedInPC(active)) return;
  const ok = await confirmDialog(
    permanent ? 'Excluir PERMANENTEMENTE' : 'Enviar para a Lixeira',
    permanent
      ? `Excluir ${items.length} item(ns) de forma permanente? Não é possível desfazer.`
      : `Enviar ${items.length} item(ns) para a Lixeira?`,
    items.map((i) => i.name),
    permanent ? 'Excluir' : 'Lixeira',
    'danger'
  );
  if (!ok) return;
  const paths = items.map((i) => joinPath(active.path, i.name));
  const res = await withProgress('Excluindo…', (id) => fm.remove(paths, permanent, id));
  active.selected.clear();
  await active.reload();
  if (res.ok) flash(`${items.length} item(ns) excluído(s).`);
  else if (res.cancelled) flash('Operação cancelada.', true);
  else await reportErrors('Exclusão: ocorreram erros', res);
}

async function opRename() {
  const e = active.current();
  if (!e || blockedInPC(active)) return;
  const name = await askText('Renomear', 'Novo nome:', e.name, !e.isDir);
  if (!name || name === e.name) return;
  if (/[\\/:*?"<>|]/.test(name)) return flash('Nome inválido (caracteres \\ / : * ? " < > |).', true);
  const r = await fm.rename(joinPath(active.path, e.name), joinPath(active.path, name));
  if (!r.ok) return flash(`Erro ao renomear: ${r.error}`, true);
  await active.reload(name);
}

// ---------- renomeação em massa ----------

const INVALID_NAME = /[\\/:*?"<>|]/;

// Novo nome de um item: texto no início, ou no final (opcionalmente antes da extensão).
function massRenamed(entry, mode, text, beforeExt) {
  if (mode === 'start') return text + entry.name;
  if (beforeExt && !entry.isDir) {
    const [base, ext] = splitExt(entry.name, false);
    return ext ? `${base}${text}.${ext}` : entry.name + text;
  }
  return entry.name + text;
}

// Monta o plano [{ entry, to, error }] e aponta nomes inválidos, repetidos ou já existentes na pasta.
function massPlan(items, taken, mode, text, beforeExt) {
  const plan = items.map((entry) => ({ entry, to: massRenamed(entry, mode, text, beforeExt), error: '' }));
  const seen = new Map();
  for (const p of plan) {
    const key = p.to.toLowerCase();
    seen.set(key, (seen.get(key) || 0) + 1);
  }
  for (const p of plan) {
    if (!text) p.error = 'Informe o texto';
    else if (INVALID_NAME.test(text)) p.error = 'Caracteres inválidos';
    else if (p.to.length > 255) p.error = 'Nome longo demais';
    else if (taken.has(p.to.toLowerCase())) p.error = 'Já existe na pasta';
    else if (seen.get(p.to.toLowerCase()) > 1) p.error = 'Nome repetido';
  }
  return plan;
}

async function opMassRename() {
  const panel = active;
  if (blockedInPC(panel)) return;
  const items = panel.targets();
  if (!items.length) return flash('Nenhum item para renomear.', true);
  const taken = new Set((panel.raw || []).map((e) => e.name.toLowerCase()));

  const res = await showDialog({
    title: `Renomeação em massa — ${items.length} item(ns)`,
    build(body) {
      let mode = settings.massMode === 'end' ? 'end' : 'start';
      let beforeExt = settings.massBeforeExt !== false;
      let plan = [];

      const radios = document.createElement('div');
      const mk = (value, label) => {
        const l = document.createElement('label');
        const r = document.createElement('input');
        r.type = 'radio';
        r.name = 'mass-mode';
        r.checked = mode === value;
        r.addEventListener('change', () => {
          mode = value;
          refresh();
        });
        l.append(r, ' ' + label);
        return l;
      };
      radios.append(mk('start', 'Adicionar no início do nome'), mk('end', 'Adicionar no final do nome'));

      const extLabel = document.createElement('label');
      const extBox = document.createElement('input');
      extBox.type = 'checkbox';
      extBox.checked = beforeExt;
      extBox.addEventListener('change', () => {
        beforeExt = extBox.checked;
        refresh();
      });
      extLabel.append(extBox, ' No final: inserir antes da extensão (ex.: relatorio_2024.pdf)');

      const text = document.createElement('input');
      text.type = 'text';
      text.placeholder = 'Texto a adicionar';
      text.style.marginTop = '10px';
      text.addEventListener('input', refresh);

      const list = document.createElement('div');
      list.className = 'mr-preview';
      const summary = document.createElement('div');
      summary.className = 'mr-summary';
      body.append(radios, extLabel, text, summary, list);

      function refresh() {
        extLabel.style.display = mode === 'end' ? '' : 'none';
        plan = massPlan(items, taken, mode, text.value, beforeExt);
        const bad = plan.filter((p) => p.error).length;
        summary.textContent = !text.value
          ? 'Digite o texto para ver a prévia.'
          : bad
            ? `${bad} item(ns) com problema — corrija para continuar.`
            : `${plan.length} item(ns) serão renomeados.`;
        summary.classList.toggle('bad', !!text.value && bad > 0);
        list.replaceChildren();
        for (const p of plan) {
          const row = document.createElement('div');
          row.className = 'mr-row' + (text.value && p.error ? ' bad' : '');
          row.textContent = text.value ? `${p.entry.name}  →  ${p.to}${p.error ? `   (${p.error})` : ''}` : p.entry.name;
          list.appendChild(row);
        }
      }
      refresh();

      return {
        focus: () => text.focus(),
        canSubmit: () => plan.length > 0 && plan.every((p) => !p.error),
        getValue: () => ({ plan, mode, beforeExt }),
      };
    },
    buttons: [
      { label: 'Cancelar', value: null },
      { label: 'Renomear', value: true, kind: 'primary' },
    ],
  });
  if (!res || !res.value) return;

  const { plan, mode, beforeExt } = res.extra;
  settings.massMode = mode;
  settings.massBeforeExt = beforeExt;
  storeJson('fm.settings', settings);

  const errors = [];
  const renamed = [];
  for (const p of plan) {
    const r = await fm.rename(joinPath(panel.path, p.entry.name), joinPath(panel.path, p.to));
    if (r.ok) renamed.push(p.to);
    else errors.push(`${p.entry.name}: ${r.error}`);
  }
  panel.selected = new Set(renamed);
  await Promise.all(visiblePanels().filter((x) => x.path === panel.path && x !== panel).map((x) => x.reload()));
  await panel.reload(renamed[0]);
  if (!errors.length) flash(`${renamed.length} item(ns) renomeado(s).`);
  else await infoDialog('Renomeação: ocorreram erros', `${renamed.length} renomeado(s), ${errors.length} com erro:`, errors);
}

async function opView(editable) {
  const e = active.current();
  if (!e || e.isDir) return;
  const full = joinPath(active.path, e.name);
  const r = await fm.readText(full);
  if (!r.ok) return flash(r.error, true);
  if (editable && r.truncated) return flash('Arquivo maior que 1 MB: edição interna indisponível.', true);
  const res = await showDialog({
    title: (editable ? 'Editar: ' : 'Visualizar: ') + e.name + (r.truncated ? ' (primeiro 1 MB)' : ''),
    build(body) {
      const ta = document.createElement('textarea');
      ta.value = r.text;
      ta.readOnly = !editable;
      ta.spellcheck = false;
      body.appendChild(ta);
      return { focus: () => ta.focus(), getValue: () => ta.value };
    },
    buttons: editable
      ? [
          { label: 'Cancelar', value: null },
          { label: 'Salvar', value: true, kind: 'primary' },
        ]
      : [{ label: 'Fechar', value: null }],
  });
  if (editable && res && res.value) {
    const w = await fm.writeText(full, res.extra);
    if (!w.ok) return flash(`Erro ao salvar: ${w.error}`, true);
    flash('Arquivo salvo.');
    await active.reload(e.name);
  }
}

const searchResultHandlers = new Map();
fm.onSearchResults((id, batch) => searchResultHandlers.get(id)?.(batch));

// Busca por nome (aceita * e ?) com resultados em tempo real e botão para parar.
// scope: 'all' = todas as unidades (Ctrl+Shift+F); 'folder' = pasta atual e subpastas (Alt+F7).
async function opSearch(scope = 'folder') {
  const panel = active;
  if (panel.path === PC) scope = 'all'; // "Meu Computador" não é uma pasta real
  let running = false;
  let jobId = 0;
  let hits = 0;
  let goTo = null;

  await showDialog({
    title: 'Buscar arquivos e pastas',
    build(body) {
      const row = document.createElement('div');
      row.className = 'search-row';
      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = 'Nome ou máscara (ex.: relatorio, *.pdf, nota_??.xml)';
      const go = document.createElement('button');
      go.className = 'primary';
      go.textContent = 'Buscar';
      row.append(input, go);

      const scopes = document.createElement('div');
      const mkScope = (value, label) => {
        const l = document.createElement('label');
        const r = document.createElement('input');
        r.type = 'radio';
        r.name = 'search-scope';
        r.value = value;
        r.checked = scope === value;
        r.addEventListener('change', () => (scope = value));
        l.append(r, ' ' + label);
        return l;
      };
      scopes.append(
        mkScope('all', 'Todas as unidades'),
        mkScope('folder', 'Pasta atual e subpastas: ' + displayPath(panel.path))
      );
      if (panel.path === PC) scopes.lastChild.hidden = true;

      const status = document.createElement('div');
      status.className = 'search-status';
      const results = document.createElement('div');
      results.className = 'results';
      body.append(row, scopes, status, results);

      const append = (batch) => {
        for (const it of batch) {
          hits++;
          const d = document.createElement('div');
          d.textContent = (it.isDir ? '📁 ' : '📄 ') + it.path;
          d.title = it.path;
          d.addEventListener('click', () => {
            goTo = it;
            if (closeCurrentDialog) closeCurrentDialog();
          });
          results.appendChild(d);
        }
      };

      async function start() {
        if (running) {
          fm.cancel(jobId); // o botão vira "Parar" durante a busca
          return;
        }
        const q = input.value.trim();
        if (!q) return;
        results.replaceChildren();
        hits = 0;
        running = true;
        go.textContent = 'Parar';
        go.className = 'danger';
        const roots = scope === 'all' ? await fm.drives() : [panel.path];
        jobId = ++jobSeq;
        const id = jobId;
        searchResultHandlers.set(id, append);
        progressHandlers.set(id, (s) => {
          status.textContent = `Buscando… ${hits} encontrado(s) — ${s.current || ''}`;
        });
        const r = await fm.search(roots, q, id);
        searchResultHandlers.delete(id);
        progressHandlers.delete(id);
        running = false;
        go.textContent = 'Buscar';
        go.className = 'primary';
        status.textContent =
          `${hits} resultado(s)` +
          (r.truncated ? ' (limite de 2000 atingido)' : '') +
          (r.cancelled ? ' — busca interrompida' : '') +
          (hits ? '. Clique em um item para ir até ele.' : '.');
      }

      go.addEventListener('click', start);
      input.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.stopPropagation(); // não deixa o Enter fechar o diálogo
        start();
      });
      return { focus: () => input.focus() };
    },
    buttons: [{ label: 'Fechar', value: null }],
  });

  if (running) fm.cancel(jobId); // fechou o diálogo com a busca em andamento
  if (goTo) {
    const name = baseName(goTo.path);
    if (name.startsWith('.')) panel.showHidden = true; // senão o item achado ficaria invisível
    await panel.go(parentPath(goTo.path), true, name);
  }
}

async function showHelp() {
  const rows = [
    ['Tab', 'Alternar painel'],
    ['↑ ↓ PgUp PgDn Home End', 'Mover cursor'],
    ['Enter', 'Abrir pasta / arquivo'],
    ['Backspace', 'Subir um nível'],
    ['Alt+←', 'Voltar no histórico'],
    ['Insert / Espaço', 'Marcar item'],
    ['Ctrl+A / Ctrl+D', 'Marcar tudo / desmarcar'],
    ['Numpad * / Ctrl+I', 'Inverter seleção'],
    ['F2 / Shift+F6', 'Renomear (com 2+ itens marcados: renomeação em massa)'],
    ['Ctrl+M', 'Renomeação em massa: texto no início ou no final dos nomes marcados, com prévia'],
    ['Ctrl+Alt+1 … 5', 'Layout dos painéis (2 colunas, 2/3+1/3, 3 colunas, 1+2 empilhados, grade 2×2)'],
    ['Alt+F1 … F4', 'Editar o caminho do painel 1 … 4'],
    ['Arrastar a divisória', 'Redimensiona os painéis (duplo clique restaura)'],
    ['F3 / F4', 'Visualizar / Editar texto'],
    ['F5 / F6', 'Copiar / Mover para o painel oposto'],
    ['F7', 'Nova pasta'],
    ['F8 / Delete', 'Enviar para a Lixeira'],
    ['Shift+Delete', 'Excluir permanentemente'],
    ['Ctrl+C / Ctrl+X / Ctrl+V', 'Copiar / recortar / colar arquivos (funciona também com o Explorer)'],
    ['Arrastar para fora da janela', 'Leva os arquivos para o Explorer, e-mail, chat… (copia; segure Shift para mover)'],
    ['Ctrl+Shift+1 / 2 / 3', 'Visualização: detalhes / ícones médios / ícones grandes (com miniaturas). Ctrl + roda do mouse também muda'],
    ['← → ↑ ↓', 'Nos ícones, move o cursor pela grade'],
    ['Arrastar com o mouse', 'Entre painéis, para uma pasta da lista ou para o título de uma aba (mesma unidade move; Ctrl copia; Shift move)'],
    ['Ctrl+N / Ctrl+Shift+N', 'Nova pasta (igual ao Explorer)'],
    ['Ctrl+F', 'Filtrar a pasta atual enquanto digita (aceita * e ?; Esc limpa)'],
    ['Ctrl+Shift+F', 'Buscar em todas as unidades (resultados em tempo real; clique para ir até o item)'],
    ['Alt+F7', 'Buscar na pasta atual e subpastas'],
    ['Alt+F1 / Alt+F2', 'Foco nas unidades (esquerda/direita) — use as teclas A–Z na barra de caminho'],
    ['Ctrl+L', 'Editar caminho'],
    ['Ctrl+R', 'Atualizar'],
    ['Ctrl+H', 'Mostrar/ocultar arquivos ocultos'],
    ['Ctrl+U', 'Trocar painéis'],
    ['Ctrl+T / Ctrl+W', 'Nova aba / fechar aba (sem limite de abas)'],
    ['Ctrl+Enter / clique do meio', 'Abrir a pasta sob o cursor em nova aba'],
    ['Duplo clique', 'Abrir pasta ou arquivo (botão "Clique único" na barra: pastas abrem com 1 clique)'],
    ['Arrastar do Explorer', 'Soltar no painel copia (Shift = move); soltar sobre uma pasta copia para dentro dela'],
    ['Ctrl+Tab / Ctrl+Shift+Tab', 'Próxima / anterior aba (ou Ctrl+PgDn / Ctrl+PgUp)'],
    ['Alt+O', 'Painel oposto abre esta pasta'],
    ['Digitar letras', 'Busca rápida por nome'],
  ];
  await showDialog({
    title: 'Atalhos de teclado',
    build(body) {
      const t = document.createElement('table');
      for (const [k, d] of rows) {
        const tr = document.createElement('tr');
        const a = document.createElement('td');
        a.textContent = k;
        const b = document.createElement('td');
        b.textContent = d;
        tr.append(a, b);
        t.appendChild(tr);
      }
      body.appendChild(t);
    },
    buttons: [{ label: 'Fechar', value: null, kind: 'primary' }],
  });
}

function updateToolbar() {
  const b = document.querySelector('[data-act="singleclick"]');
  b.classList.toggle('on', settings.singleClick);
  b.textContent = settings.singleClick ? '☑ Clique único' : '☐ Clique único';
}

const actions = {
  newtab: () => active.newTab(),
  singleclick() {
    settings.singleClick = !settings.singleClick;
    storeJson('fm.settings', settings);
    updateToolbar();
    flash(settings.singleClick ? 'Clique único abre pastas.' : 'Duplo clique abre pastas.');
  },
  refresh: () => Promise.all(visiblePanels().map((p) => p.reload())),
  hidden() {
    active.showHidden = !active.showHidden;
    const name = active.current()?.name;
    active.applySort();
    const i = active.entries.findIndex((e) => e.name === name);
    active.cursor = i >= 0 ? i : 0;
    active.render();
    flash(active.showHidden ? 'Mostrando arquivos ocultos.' : 'Ocultando arquivos ocultos.');
  },
  async swap() {
    const a = active;
    const b = other();
    const [ap, bp] = [a.path, b.path];
    await a.go(bp, false);
    await b.go(ap, false);
  },
  mirror: () => other().go(active.path),
  search: () => opSearch('folder'),
  searchall: () => opSearch('all'),
  filter: () => active.openFilter(),
  newfolder: opMkdir,
  clipcopy: () => opClipboard(false),
  clipcut: () => opClipboard(true),
  clippaste: opPaste,
  help: showHelp,
  view: () => opView(false),
  edit: () => opView(true),
  copy: () => opCopyMove(false),
  move: () => opCopyMove(true),
  mkdir: opMkdir,
  delete: () => opDelete(false),
  // F2: renomeia o item sob o cursor; com 2+ itens marcados abre a renomeação em massa
  rename: () => (active.selected.size > 1 ? opMassRename() : opRename()),
  multirename: opMassRename,
};

document.querySelectorAll('[data-act]').forEach((b) =>
  b.addEventListener('click', () => {
    if (modalOpen) return;
    Promise.resolve(actions[b.dataset.act]()).catch((err) => flash(String(err), true));
    active.listEl.focus();
  })
);

// ---------- teclado ----------

document.addEventListener('keydown', (e) => {
  if (modalOpen || document.activeElement === active.pathEl || document.activeElement === active.filterEl) return;
  const p = active;
  const k = e.key;
  let handled = true;

  const run = (fn) => Promise.resolve(fn()).catch((err) => flash(String(err), true));

  if (e.altKey && k === 'F7') run(actions.search);
  else if (e.ctrlKey && e.shiftKey && !e.altKey && /^Digit[1-3]$/.test(e.code)) p.setView(VIEWS[Number(e.code.slice(5)) - 1]);
  else if (e.ctrlKey && e.shiftKey && k.toLowerCase() === 'f') run(actions.searchall);
  else if (e.ctrlKey && k.toLowerCase() === 'f') p.openFilter();
  else if (e.ctrlKey && k.toLowerCase() === 'n') run(opMkdir); // inclui Ctrl+Shift+N, como no Explorer
  else if (e.ctrlKey && k.toLowerCase() === 'c') run(() => opClipboard(false));
  else if (e.ctrlKey && k.toLowerCase() === 'x') run(() => opClipboard(true));
  else if (e.ctrlKey && k.toLowerCase() === 'v') run(opPaste);
  else if (e.altKey && k === 'ArrowLeft') run(() => p.back());
  else if (e.ctrlKey && e.altKey && /^Digit[1-9]$/.test(e.code)) {
    const l = LAYOUTS[Number(e.code.slice(5)) - 1];
    if (l) run(() => applyLayout(l.id));
  } else if (e.altKey && /^F[1-4]$/.test(k)) {
    const target = visiblePanels()[Number(k[1]) - 1];
    if (target) {
      setActive(target);
      target.pathEl.focus();
      target.pathEl.select();
    }
  } else if (e.altKey && k.toLowerCase() === 'o') run(actions.mirror);
  else if (e.ctrlKey && k.toLowerCase() === 't') run(() => p.newTab());
  else if (e.ctrlKey && k === 'Enter') {
    const c = p.current();
    if (c?.isDir) run(() => p.newTab(joinPath(p.path, c.name)));
  }
  else if (e.ctrlKey && k.toLowerCase() === 'w') run(() => p.closeTab(p.tabIdx));
  else if (e.ctrlKey && (k === 'Tab' || k === 'PageDown')) run(() => p.cycleTab(e.shiftKey ? -1 : 1));
  else if (e.ctrlKey && (k === 'PageUp' || (k === 'Tab' && e.shiftKey))) run(() => p.cycleTab(-1));
  else if (e.ctrlKey && k.toLowerCase() === 'r') run(actions.refresh);
  else if (e.ctrlKey && k.toLowerCase() === 'm') run(opMassRename);
  else if (e.ctrlKey && k.toLowerCase() === 'h') actions.hidden();
  else if (e.ctrlKey && k.toLowerCase() === 'u') run(actions.swap);
  else if (e.ctrlKey && k.toLowerCase() === 'l') {
    p.pathEl.focus();
    p.pathEl.select();
  } else if (e.ctrlKey && k.toLowerCase() === 'a') {
    p.entries.forEach((en) => p.selected.add(en.name));
    p.render();
  } else if (e.ctrlKey && k.toLowerCase() === 'd') {
    p.selected.clear();
    p.render();
  } else if ((e.ctrlKey && k.toLowerCase() === 'i') || k === '*') {
    p.entries.forEach((en) => (p.selected.has(en.name) ? p.selected.delete(en.name) : p.selected.add(en.name)));
    p.render();
  } else if (e.shiftKey && k === 'F6') run(actions.rename);
  else if (e.shiftKey && k === 'Delete') run(() => opDelete(true));
  else if (e.ctrlKey || e.altKey || e.metaKey) handled = false;
  else {
    switch (k) {
      case 'Tab':
        setActive(other());
        break;
      case 'Escape':
        if (p.filter) p.clearFilter();
        break;
      case 'ArrowDown':
        p.moveCursor(p.cols());
        break;
      case 'ArrowUp':
        p.moveCursor(-p.cols());
        break;
      case 'ArrowRight':
        if (p.view !== 'details') p.moveCursor(1);
        break;
      case 'ArrowLeft':
        if (p.view !== 'details') p.moveCursor(-1);
        break;
      case 'PageDown':
        p.moveCursor(p.pageSize());
        break;
      case 'PageUp':
        p.moveCursor(-p.pageSize());
        break;
      case 'Home':
        p.moveCursor(0, true);
        break;
      case 'End':
        p.moveCursor(p.entries.length - 1, true);
        break;
      case 'Enter':
        run(() => p.enter());
        break;
      case 'Backspace':
        run(() => p.up());
        break;
      case 'Insert':
        p.toggleSelect(p.cursor);
        break;
      case ' ':
        p.toggleSelect(p.cursor);
        break;
      case 'F1':
        run(actions.help);
        break;
      case 'F2':
        run(actions.rename);
        break;
      case 'F3':
        run(actions.view);
        break;
      case 'F4':
        run(actions.edit);
        break;
      case 'F5':
        run(actions.copy);
        break;
      case 'F6':
        run(actions.move);
        break;
      case 'F7':
        run(actions.mkdir);
        break;
      case 'F8':
      case 'Delete':
        run(actions.delete);
        break;
      default:
        if (k.length === 1) {
          quickBuf += k;
          clearTimeout(quickTimer);
          quickTimer = setTimeout(() => (quickBuf = ''), 900);
          if (!p.quickJump(quickBuf) && quickBuf.length > 1) {
            quickBuf = k;
            p.quickJump(quickBuf);
          }
        } else handled = false;
    }
  }
  if (handled) e.preventDefault();
});

// ---------- copiar / recortar / colar (Ctrl+C, Ctrl+X, Ctrl+V) ----------
// A área de transferência do Windows é a fonte da verdade (permite colar de/para o Explorer).
// `clip` guarda uma cópia local: serve para o efeito visual de "recortado" e como reserva se o
// Windows não responder.

let clip = null; // { cut, raw: [caminhos], paths: Set (minúsculos) }
let clipPending = null;

const normPath = (p) => p.replace(/[\\/]+$/, '').toLowerCase();

async function opClipboard(cut) {
  const items = active.targets();
  if (!items.length || blockedInPC(active)) return;
  const raw = items.map((i) => joinPath(active.path, i.name));
  clip = { cut, raw, paths: new Set(raw.map((p) => p.toLowerCase())) };
  visiblePanels().forEach((p) => p.render());
  flash(`${items.length} item(ns) ${cut ? 'recortado(s)' : 'copiado(s)'}. Use Ctrl+V na pasta de destino.`);
  clipPending = fm.clipWrite(raw, cut).then((r) => {
    if (!r.ok) flash('Não foi possível usar a área de transferência do Windows; colar só funciona dentro do app.', true);
  });
}

// "arquivo.txt" → "arquivo - Cópia.txt", "arquivo - Cópia (2).txt"…
async function uniqueCopyName(dir, name, isDir) {
  const [base, ext] = splitExt(name, isDir);
  const dot = ext ? '.' + ext : '';
  for (let n = 1; ; n++) {
    const candidate = `${base} - Cópia${n > 1 ? ` (${n})` : ''}${dot}`;
    if (!(await fm.exists(joinPath(dir, candidate)))) return candidate;
  }
}

async function opPaste() {
  const dest = active;
  if (blockedInPC(dest)) return;
  if (clipPending) await clipPending;
  const sys = await fm.clipRead();
  let paths;
  let cut;
  if (sys.ok && sys.paths.length) ({ paths, cut } = sys);
  else if (clip) ({ raw: paths, cut } = clip);
  else return flash('Não há arquivos copiados ou recortados.', true);

  const payload = [];
  let missing = 0;
  let skipped = 0;
  for (const src of paths) {
    if (!(await fm.exists(src))) {
      missing++;
      continue;
    }
    let name = baseName(src);
    if (normPath(parentPath(src)) === normPath(dest.path)) {
      if (cut) {
        skipped++; // recortar e colar na mesma pasta não faz nada
        continue;
      }
      name = await uniqueCopyName(dest.path, name, await fm.isDir(src));
    }
    payload.push({ src, name });
  }
  if (!payload.length) {
    return flash(missing ? 'Os itens copiados não existem mais.' : 'Os itens já estão nesta pasta.', true);
  }
  await transfer(payload, dest.path, cut, { confirm: false });
  if (cut) {
    clip = null;
    fm.clipClear(); // como no Explorer, o recorte vale uma vez só
    visiblePanels().forEach((p) => p.render());
  }
  if (missing || skipped) flash(`${missing ? missing + ' item(ns) não existe(m) mais. ' : ''}${skipped ? skipped + ' já estava(m) nesta pasta.' : ''}`, true);
}

// ---------- seleção por área (retângulo) ----------
// Começa num espaço vazio da lista. As linhas ocupam toda a largura, então basta a faixa vertical
// do retângulo para saber quais linhas ele toca. Ctrl inverte as linhas tocadas em relação à seleção
// anterior. Perto da borda superior/inferior a lista rola sozinha.

let marquee = null; // { panel, ctrl, base, sx, sy, x, y, started, el, timer, key }
const MARQUEE_THRESHOLD = 4;
const MARQUEE_EDGE = 24;

function startMarquee(panel, e) {
  const r = panel.listEl.getBoundingClientRect();
  marquee = {
    panel,
    ctrl: e.ctrlKey || e.shiftKey,
    base: e.ctrlKey || e.shiftKey ? new Set(panel.selected) : new Set(),
    sx: e.clientX - r.left + panel.listEl.scrollLeft, // início, em coordenadas do conteúdo da lista
    sy: e.clientY - r.top + panel.listEl.scrollTop,
    x: e.clientX,
    y: e.clientY,
    started: false,
    el: null,
    timer: null,
    key: '',
  };
}

function updateMarquee() {
  const m = marquee;
  const p = m.panel;
  const list = p.listEl;
  const r = list.getBoundingClientRect();
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
  const curX = clamp(m.x, r.left, r.right) - r.left + list.scrollLeft;
  const curY = clamp(m.y, r.top, r.bottom) - r.top + list.scrollTop;

  // retângulo desenhado em coordenadas da tela, recortado à área visível da lista
  const left = Math.max(r.left, r.left - list.scrollLeft + Math.min(m.sx, curX));
  const top = Math.max(r.top, r.top - list.scrollTop + Math.min(m.sy, curY));
  const right = Math.min(r.right, r.left - list.scrollLeft + Math.max(m.sx, curX));
  const bottom = Math.min(r.bottom, r.top - list.scrollTop + Math.max(m.sy, curY));
  Object.assign(m.el.style, {
    left: left + 'px',
    top: top + 'px',
    width: Math.max(0, right - left) + 'px',
    height: Math.max(0, bottom - top) + 'px',
  });

  // índices dos itens tocados pelo retângulo
  const idxs = [];
  if (p.view === 'details') {
    // linhas de altura fixa e largura total: basta a faixa vertical
    const n = p.entries.length;
    const i0 = Math.max(0, Math.floor(Math.min(m.sy, curY) / p.rowHeight));
    const i1 = Math.min(n - 1, Math.floor(Math.max(m.sy, curY) / p.rowHeight));
    for (let i = i0; i <= i1; i++) idxs.push(i);
  } else {
    // grade de ícones: testa a interseção do retângulo com cada célula
    const x0 = Math.min(m.sx, curX);
    const x1 = Math.max(m.sx, curX);
    const y0 = Math.min(m.sy, curY);
    const y1 = Math.max(m.sy, curY);
    [...list.children].forEach((c, i) => {
      if (c.offsetLeft < x1 && c.offsetLeft + c.offsetWidth > x0 && c.offsetTop < y1 && c.offsetTop + c.offsetHeight > y0) idxs.push(i);
    });
  }
  const key = idxs.length ? `${idxs[0]}:${idxs[idxs.length - 1]}:${idxs.length}` : '';
  if (key === m.key) return; // mesmo conjunto de itens: nada a refazer
  m.key = key;

  const touched = new Set(idxs.map((i) => p.entries[i].name));
  if (m.ctrl) {
    p.selected = new Set(m.base);
    for (const name of touched) (p.selected.has(name) ? p.selected.delete(name) : p.selected.add(name));
  } else p.selected = touched;
  if (idxs.length) p.cursor = curY >= m.sy ? idxs[idxs.length - 1] : idxs[0];
  p.render();
}

function endMarquee() {
  if (!marquee) return;
  clearInterval(marquee.timer);
  marquee.el?.remove();
  marquee = null;
}

document.addEventListener('mousemove', (e) => {
  const m = marquee;
  if (!m) return;
  if (!(e.buttons & 1)) return endMarquee(); // soltou fora da janela
  m.x = e.clientX;
  m.y = e.clientY;
  if (!m.started) {
    const r = m.panel.listEl.getBoundingClientRect();
    const dx = m.x - (r.left + m.sx - m.panel.listEl.scrollLeft);
    const dy = m.y - (r.top + m.sy - m.panel.listEl.scrollTop);
    if (Math.hypot(dx, dy) < MARQUEE_THRESHOLD) return;
    m.started = true;
    m.el = document.createElement('div');
    m.el.className = 'marquee';
    document.body.append(m.el);
    // rolagem automática enquanto o ponteiro fica perto da borda (ou fora) da lista
    m.timer = setInterval(() => {
      const list = m.panel.listEl;
      const lr = list.getBoundingClientRect();
      const speed = (d) => Math.min(30, 4 + Math.abs(d) / 3);
      if (m.y < lr.top + MARQUEE_EDGE) list.scrollTop -= speed(lr.top + MARQUEE_EDGE - m.y);
      else if (m.y > lr.bottom - MARQUEE_EDGE) list.scrollTop += speed(m.y - (lr.bottom - MARQUEE_EDGE));
      else return;
      m.key = ''; // a rolagem muda as linhas tocadas mesmo com o mouse parado
      updateMarquee();
    }, 40);
  }
  updateMarquee();
});

document.addEventListener('mouseup', endMarquee);

document.addEventListener(
  'keydown',
  (e) => {
    if (e.key === 'Escape' && marquee?.started) {
      e.preventDefault();
      e.stopPropagation();
      endMarquee();
    }
  },
  true
);

// ---------- arrastar entre painéis e abas ----------
// Implementado com eventos de mouse (e não HTML5 drag) porque a lista é redesenhada a cada clique.
// Soltar: na lista de um painel (pasta aberta), sobre uma pasta da lista, ou no título de uma aba.
// Sem tecla: mesma unidade move, unidades diferentes copiam. Ctrl força copiar, Shift força mover.

let dragState = null; // { srcDir, items, x, y, started, target, ghost, hover }
const DRAG_THRESHOLD = 6;
let springTimer = null;

const driveOf = (p) => p.slice(0, 2).toLowerCase();

function dragTargetAt(x, y) {
  const el = document.elementFromPoint(x, y);
  const panelEl = el?.closest('.panel');
  if (!panelEl) return null;
  const panel = panels[Number(panelEl.dataset.idx)];
  const tabEl = el.closest('.tab');
  if (tabEl) {
    const i = [...panel.tabsEl.querySelectorAll('.tab')].indexOf(tabEl);
    const dest = i === panel.tabIdx ? panel.path : panel.tabs[i]?.path;
    return dest ? { panel, panelEl, tabEl, tabIdx: i, dest } : null;
  }
  const row = el.closest('.row.dir');
  const entry = row ? panel.entries[Number(row.dataset.idx)] : null;
  if (entry) return { panel, panelEl, row, dest: joinPath(panel.path, entry.name) };
  return { panel, panelEl, dest: panel.path };
}

// destino inválido: "Meu Computador", a própria pasta de origem, ou dentro de um dos itens arrastados
function dragDropAllowed(t) {
  if (!t || t.dest === PC) return false;
  if (!t.row && normPath(t.dest) === normPath(dragState.srcDir)) return false;
  return !dragState.items.some((it) => {
    const full = normPath(joinPath(dragState.srcDir, it.name));
    const d = normPath(t.dest);
    return d === full || d.startsWith(full + '\\') || d.startsWith(full + '/');
  });
}

function dragOperation(e, dest) {
  if (e.ctrlKey) return 'copy';
  if (e.shiftKey) return 'move';
  return driveOf(dest) === driveOf(dragState.srcDir) ? 'move' : 'copy';
}

function endDrag() {
  clearTimeout(springTimer);
  springTimer = null;
  clearDropMarks();
  dragState?.ghost?.remove();
  document.body.classList.remove('dragging-files', 'no-drop');
  dragState = null;
}

// Arrastar para fora da janela: o Electron inicia um arraste nativo com os arquivos reais, que o
// Explorer, e-mail, chat etc. aceitam como qualquer arquivo arrastado do Windows (copia; Shift move).
function startNativeDrag() {
  const st = dragState;
  if (!st) return;
  endDrag();
  fm.startDrag(st.items.map((it) => joinPath(st.srcDir, it.name))).then((ok) => {
    if (!ok) flash('Não foi possível arrastar estes itens para fora do aplicativo.', true);
  });
}

document.documentElement.addEventListener('mouseleave', (e) => {
  if (dragState && e.buttons & 1) startNativeDrag();
});

// Ao voltar para a janela (ex.: depois de arrastar arquivos para o Explorer), atualiza as listas
let focusReloadAt = 0;
window.addEventListener('focus', () => {
  const now = Date.now();
  if (modalOpen || dragState || marquee || now - focusReloadAt < 1000 || !sessionReady) return;
  focusReloadAt = now;
  visiblePanels().forEach((p) => p.reload());
});

document.addEventListener('mousemove', (e) => {
  if (!dragState) return;
  if (!(e.buttons & 1)) return endDrag(); // soltou fora da janela
  // o ponteiro saiu da janela com o botão pressionado: passa para o arraste nativo do Windows
  if (e.clientX < 0 || e.clientY < 0 || e.clientX >= window.innerWidth || e.clientY >= window.innerHeight) {
    return startNativeDrag();
  }
  if (!dragState.started) {
    if (Math.hypot(e.clientX - dragState.x, e.clientY - dragState.y) < DRAG_THRESHOLD) return;
    dragState.started = true;
    dragState.ghost = document.createElement('div');
    dragState.ghost.className = 'drag-ghost';
    document.body.append(dragState.ghost);
    document.body.classList.add('dragging-files');
  }
  const g = dragState.ghost;
  g.style.left = e.clientX + 14 + 'px';
  g.style.top = e.clientY + 14 + 'px';

  clearDropMarks();
  const t = dragTargetAt(e.clientX, e.clientY);
  const ok = dragDropAllowed(t);
  dragState.target = ok ? t : null;
  document.body.classList.toggle('no-drop', !ok);
  const n = dragState.items.length;
  if (ok) {
    const op = dragOperation(e, t.dest);
    g.textContent = `${op === 'move' ? 'Mover' : 'Copiar'} ${n} item(ns) → ${baseName(t.dest) || t.dest}`;
    if (t.tabEl) t.tabEl.classList.add('drop-tab');
    else if (t.row) {
      t.row.classList.add('drop-row');
      t.panelEl.classList.add('drop-target');
    } else t.panelEl.classList.add('drop-target');
  } else g.textContent = `${n} item(ns)`;

  // parar sobre outra aba por um instante a abre, para soltar dentro dela
  const hoverKey = ok && t.tabEl && t.tabIdx !== t.panel.tabIdx ? `${t.panel.index}:${t.tabIdx}` : null;
  if (hoverKey !== dragState.hover) {
    clearTimeout(springTimer);
    dragState.hover = hoverKey;
    if (hoverKey) springTimer = setTimeout(() => t.panel.switchTab(t.tabIdx), 700);
  }
});

document.addEventListener('mouseup', (e) => {
  if (!dragState) return;
  const st = dragState;
  if (!st.started && st.collapse) {
    st.collapse.panel.selected = new Set([st.collapse.name]);
    st.collapse.panel.render();
  }
  const t = st.started ? st.target : null;
  const op = t ? dragOperation(e, t.dest) : null;
  endDrag();
  if (!t || modalOpen) return;
  const payload = st.items.map((it) => ({ src: joinPath(st.srcDir, it.name), name: it.name }));
  setActive(t.panel);
  transfer(payload, t.dest, op === 'move', { confirm: false }).catch((err) => flash(String(err), true));
});

document.addEventListener(
  'keydown',
  (e) => {
    if (e.key === 'Escape' && dragState?.started) {
      e.preventDefault();
      e.stopPropagation();
      endDrag();
    }
  },
  true
);

// ---------- arrastar e soltar (Explorer → aplicação) ----------

function isFileDrag(e) {
  return !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
}

function clearDropMarks() {
  document
    .querySelectorAll('.drop-target, .drop-row, .drop-tab')
    .forEach((el) => el.classList.remove('drop-target', 'drop-row', 'drop-tab'));
}

// Descobre o painel e a pasta de destino sob o cursor: uma pasta da lista, ou a pasta aberta do painel.
function dropTargetAt(e) {
  const panelEl = e.target.closest?.('.panel');
  if (!panelEl) return null;
  const panel = panels[Number(panelEl.dataset.idx)];
  const row = e.target.closest('.row.dir');
  const entry = row ? panel.entries[Number(row.dataset.idx)] : null;
  return {
    panel,
    panelEl,
    row,
    dest: entry ? joinPath(panel.path, entry.name) : panel.path,
  };
}

// Sem isto o Electron navegaria para o arquivo solto, substituindo a interface.
document.addEventListener('dragover', (e) => {
  e.preventDefault();
  if (!isFileDrag(e)) return;
  clearDropMarks();
  const t = !modalOpen && dropTargetAt(e);
  if (!t) {
    e.dataTransfer.dropEffect = 'none';
    return;
  }
  e.dataTransfer.dropEffect = e.shiftKey ? 'move' : 'copy';
  (t.row || t.panelEl).classList.add(t.row ? 'drop-row' : 'drop-target');
  if (t.row) t.panelEl.classList.add('drop-target');
});

document.addEventListener('dragleave', (e) => {
  if (!e.relatedTarget) clearDropMarks();
});

document.addEventListener('drop', async (e) => {
  e.preventDefault();
  clearDropMarks();
  if (!isFileDrag(e) || modalOpen) return;
  const t = dropTargetAt(e);
  if (!t) return;
  const paths = [...e.dataTransfer.files].map((f) => fm.pathForFile(f)).filter(Boolean);
  if (!paths.length) return flash('Não foi possível obter o caminho dos itens soltos.', true);
  const move = e.shiftKey;
  setActive(t.panel);
  try {
    await transfer(
      paths.map((p) => ({ src: p, name: baseName(p) })),
      t.dest,
      move
    );
  } catch (err) {
    flash(String(err), true);
  }
});

// ---------- início ----------

(async function main() {
  const tpl = document.getElementById('panel-template');
  for (let i = 0; i < MAX_PANELS; i++) {
    const el = tpl.content.firstElementChild.cloneNode(true);
    panelsEl.appendChild(el);
    panels.push(new Panel(el, i));
  }
  active = panels[0];
  buildLayoutPicker();
  buildViewPicker();
  const saved = loadJson('fm.layout', {});
  Object.assign(ratios, saved.ratios || {});
  // a restauração da sessão (abas) acontece em applyLayout → Panel.init
  await applyLayout(saved.id);
  sessionReady = true;
  saveSession();
  updateToolbar();
  setActive(panels[0]);
})();
