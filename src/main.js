const { app, BrowserWindow, Menu, ipcMain, shell, nativeImage } = require('electron');
const fs = require('fs');
const fsp = fs.promises;
const { pipeline } = require('stream/promises');
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 780,
    minWidth: 800,
    minHeight: 500,
    backgroundColor: '#111111',
    title: 'Gerenciador de Arquivos',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

// Sem menu padrão: seus aceleradores (Ctrl+R, Ctrl+W…) conflitariam com os atalhos do app.
Menu.setApplicationMenu(null);

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());

// ---------- helpers ----------

function attrString(st) {
  return (st.isDirectory() ? 'd' : '-') + ((st.mode & 0o200) ? '-' : 'r');
}

async function listDir(dir) {
  const names = await fsp.readdir(dir);
  const out = [];
  await Promise.all(
    names.map(async (name) => {
      const full = path.join(dir, name);
      try {
        const st = await fsp.stat(full);
        out.push({
          name,
          isDir: st.isDirectory(),
          size: st.isDirectory() ? null : st.size,
          mtime: st.mtimeMs,
          attr: attrString(st),
        });
      } catch {
        // arquivo inacessível (ex.: link quebrado ou sem permissão): exibe como desconhecido
        out.push({ name, isDir: false, size: null, mtime: 0, attr: '??', broken: true });
      }
    })
  );
  return out;
}

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

// ---------- jobs com progresso e cancelamento ----------

const jobs = new Map();

function runJob(event, id, fn) {
  const job = {
    id,
    ac: new AbortController(),
    sender: event.sender,
    bytes: 0,
    totalBytes: 0,
    files: 0,
    totalFiles: 0,
    current: '',
    last: 0,
  };
  jobs.set(id, job);
  return fn(job).finally(() => {
    emit(job, true);
    jobs.delete(id);
  });
}

function emit(job, force) {
  const now = Date.now();
  if (!force && now - job.last < 100) return;
  job.last = now;
  if (job.sender.isDestroyed()) return;
  const { bytes, totalBytes, files, totalFiles, current } = job;
  job.sender.send('fs:progress', job.id, { bytes, totalBytes, files, totalFiles, current });
}

function cancelledError() {
  const err = new Error('Operação cancelada.');
  err.cancelled = true;
  return err;
}

function checkCancel(job) {
  if (job.ac.signal.aborted) throw cancelledError();
}

async function scan(p, acc) {
  const st = await fsp.stat(p);
  if (st.isDirectory()) {
    for (const name of await fsp.readdir(p)) {
      try {
        await scan(path.join(p, name), acc);
      } catch {
        // item inacessível: será reportado na operação em si
      }
    }
  } else {
    acc.files++;
    acc.bytes += st.size;
  }
  return acc;
}

async function copyFileProgress(src, dest, job) {
  checkCancel(job);
  job.current = path.basename(src);
  emit(job, true);
  const rs = fs.createReadStream(src);
  rs.on('data', (chunk) => {
    job.bytes += chunk.length;
    emit(job);
  });
  try {
    await pipeline(rs, fs.createWriteStream(dest), { signal: job.ac.signal });
  } catch (err) {
    await fsp.rm(dest, { force: true }).catch(() => {});
    throw job.ac.signal.aborted ? cancelledError() : err;
  }
  job.files++;
}

async function copyRecursive(src, dest, job) {
  checkCancel(job);
  const st = await fsp.stat(src);
  if (st.isDirectory()) {
    await fsp.mkdir(dest, { recursive: true });
    for (const name of await fsp.readdir(src)) {
      await copyRecursive(path.join(src, name), path.join(dest, name), job);
    }
  } else {
    await copyFileProgress(src, dest, job);
  }
}

async function prepareTotals(job, srcs) {
  for (const src of srcs) {
    try {
      const t = await scan(src, { files: 0, bytes: 0 });
      job.totalFiles += t.files;
      job.totalBytes += t.bytes;
    } catch {
      // ignorado: o erro aparece ao processar o item
    }
  }
  emit(job, true);
}

// remove cópia parcial deixada por um cancelamento, se o destino não existia antes
async function dropPartial(dest, existedBefore) {
  if (!existedBefore) await fsp.rm(dest, { recursive: true, force: true }).catch(() => {});
}

function isInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// ---------- IPC ----------

ipcMain.handle('fs:home', () => os.homedir());

async function drivesList() {
  const drives = [];
  for (let c = 65; c <= 90; c++) {
    const d = String.fromCharCode(c) + ':\\';
    if (await exists(d)) drives.push(d);
  }
  return drives;
}

ipcMain.handle('fs:drives', async () => (process.platform === 'win32' ? drivesList() : ['/']));

ipcMain.handle('fs:places', () => ({
  home: os.homedir(),
  desktop: app.getPath('desktop'), // respeita a Área de Trabalho redirecionada para o OneDrive
}));

// Capacidade e espaço livre de cada unidade (null quando a unidade não está pronta, ex.: leitor vazio).
ipcMain.handle('fs:driveInfo', async () => {
  const roots = process.platform === 'win32' ? await drivesList() : ['/'];
  return Promise.all(
    roots.map(async (p) => {
      try {
        const s = await fsp.statfs(p);
        return { path: p, total: s.blocks * s.bsize, free: s.bavail * s.bsize };
      } catch {
        return { path: p, total: null, free: null };
      }
    })
  );
});

ipcMain.handle('fs:list', async (_e, dir) => {
  try {
    return { ok: true, entries: await listDir(dir) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('fs:exists', (_e, p) => exists(p));

ipcMain.handle('fs:mkdir', async (_e, p) => {
  try {
    await fsp.mkdir(p);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('fs:rename', async (_e, from, to) => {
  try {
    if (await exists(to)) return { ok: false, error: 'Já existe um item com esse nome.' };
    await fsp.rename(from, to);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('fs:cancel', (_e, id) => {
  jobs.get(id)?.ac.abort();
});

// items: [{ src, name }]; destDir: pasta destino; overwrite: boolean; jobId: id para progresso/cancelamento
ipcMain.handle('fs:copy', (e, items, destDir, overwrite, jobId) =>
  runJob(e, jobId, async (job) => {
    const errors = [];
    await prepareTotals(job, items.map((i) => i.src));
    for (const { src, name } of items) {
      const dest = path.join(destDir, name);
      let existedBefore = true;
      try {
        checkCancel(job);
        if (isInside(src, dest) && path.resolve(src) !== path.resolve(dest)) {
          throw new Error('Não é possível copiar uma pasta para dentro dela mesma.');
        }
        if (path.resolve(src) === path.resolve(dest)) throw new Error('Origem e destino são iguais.');
        existedBefore = await exists(dest);
        if (!overwrite && existedBefore) throw new Error('Já existe no destino (ignorado).');
        await copyRecursive(src, dest, job);
      } catch (err) {
        if (err.cancelled) {
          await dropPartial(dest, existedBefore);
          return { ok: false, cancelled: true, errors: [err.message] };
        }
        errors.push(`${name}: ${err.message}`);
      }
    }
    return { ok: errors.length === 0, errors };
  })
);

ipcMain.handle('fs:move', (e, items, destDir, overwrite, jobId) =>
  runJob(e, jobId, async (job) => {
    const errors = [];
    await prepareTotals(job, items.map((i) => i.src));
    for (const { src, name } of items) {
      const dest = path.join(destDir, name);
      let existedBefore = true;
      try {
        checkCancel(job);
        if (path.resolve(src) === path.resolve(dest)) throw new Error('Origem e destino são iguais.');
        if (isInside(src, dest)) throw new Error('Não é possível mover uma pasta para dentro dela mesma.');
        existedBefore = await exists(dest);
        if (!overwrite && existedBefore) throw new Error('Já existe no destino (ignorado).');
        const size = await scan(src, { files: 0, bytes: 0 }).catch(() => ({ files: 0, bytes: 0 }));
        job.current = name;
        try {
          await fsp.rename(src, dest);
          job.bytes += size.bytes;
          job.files += size.files;
          emit(job);
        } catch (err) {
          if (err.code !== 'EXDEV') throw err;
          // entre volumes diferentes: copia e remove a origem somente após copiar com sucesso
          await copyRecursive(src, dest, job);
          await fsp.rm(src, { recursive: true, force: true });
        }
      } catch (err) {
        if (err.cancelled) {
          await dropPartial(dest, existedBefore);
          return { ok: false, cancelled: true, errors: [err.message] };
        }
        errors.push(`${name}: ${err.message}`);
      }
    }
    return { ok: errors.length === 0, errors };
  })
);

// Exclusão segura: envia para a Lixeira (recuperável) por padrão.
ipcMain.handle('fs:delete', (e, paths, permanent, jobId) =>
  runJob(e, jobId, async (job) => {
    const errors = [];
    job.totalFiles = paths.length;
    for (const p of paths) {
      if (job.ac.signal.aborted) return { ok: false, cancelled: true, errors: ['Operação cancelada.'] };
      job.current = path.basename(p);
      emit(job, true);
      try {
        if (permanent) await fsp.rm(p, { recursive: true, force: false });
        else await shell.trashItem(p);
      } catch (err) {
        errors.push(`${path.basename(p)}: ${err.message}`);
      }
      job.files++;
    }
    return { ok: errors.length === 0, errors };
  })
);

// ---------- área de transferência de arquivos (interoperável com o Explorer) ----------
// Usa o formato nativo do Windows (lista de arquivos + "Preferred DropEffect": 5 = copiar, 2 = recortar),
// então Ctrl+C/X aqui cola no Explorer e vice-versa. O Windows exige uma thread STA, por isso um
// PowerShell -STA fica residente (iniciado com o app) e atende comandos JSON, uma linha por vez.
// Iniciar um PowerShell a cada Ctrl+V custaria ~2 s.

const CLIP_SERVER = [
  "$ProgressPreference='SilentlyContinue'",
  '[Console]::InputEncoding=[Text.Encoding]::UTF8',
  '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
  'Add-Type -AssemblyName System.Windows.Forms',
  'while(($line=[Console]::In.ReadLine()) -ne $null){',
  '  $res=@{ok=$false}',
  '  try{',
  '    $cmd=$line|ConvertFrom-Json',
  '    switch($cmd.op){',
  "      'write'{",
  '        $c=New-Object System.Collections.Specialized.StringCollection',
  '        foreach($p in @($cmd.paths)){[void]$c.Add([string]$p)}',
  '        $d=New-Object System.Windows.Forms.DataObject',
  '        $d.SetFileDropList($c)',
  '        $eff=5; if($cmd.cut){$eff=2}',
  '        $b=[byte[]]@($eff,0,0,0)',
  "        $d.SetData('Preferred DropEffect',(New-Object System.IO.MemoryStream(,$b)))",
  '        [System.Windows.Forms.Clipboard]::SetDataObject($d,$true)',
  '        $res=@{ok=$true}',
  '      }',
  "      'read'{",
  '        $res=@{ok=$true;paths=@();cut=$false}',
  '        if([System.Windows.Forms.Clipboard]::ContainsFileDropList()){',
  '          $res.paths=@([System.Windows.Forms.Clipboard]::GetFileDropList()|ForEach-Object{[string]$_})',
  '          $d=[System.Windows.Forms.Clipboard]::GetDataObject()',
  "          if($d.GetDataPresent('Preferred DropEffect')){",
  "            $s=$d.GetData('Preferred DropEffect');$b=New-Object byte[] 4;[void]$s.Read($b,0,4)",
  '            if(($b[0] -band 2) -eq 2){$res.cut=$true}',
  '          }',
  '        }',
  '      }',
  "      'clear'{[System.Windows.Forms.Clipboard]::Clear();$res=@{ok=$true}}",
  '    }',
  '  }catch{}',
  '  [Console]::Out.WriteLine(($res|ConvertTo-Json -Compress))',
  '}',
].join('\n');

let clipProc = null;
let clipWaiting = []; // resolvers, na ordem dos comandos enviados
let clipBuf = '';

function stopClipServer(result) {
  clipProc = null;
  clipBuf = '';
  const waiting = clipWaiting;
  clipWaiting = [];
  waiting.forEach((resolve) => resolve(result));
}

function startClipServer() {
  if (clipProc || process.platform !== 'win32') return;
  const encoded = Buffer.from(CLIP_SERVER, 'utf16le').toString('base64');
  const proc = spawn('powershell', ['-NoProfile', '-STA', '-EncodedCommand', encoded], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => {
    clipBuf += chunk;
    let i;
    while ((i = clipBuf.indexOf('\n')) >= 0) {
      const line = clipBuf.slice(0, i).trim();
      clipBuf = clipBuf.slice(i + 1);
      const resolve = clipWaiting.shift();
      if (!resolve) continue;
      try {
        resolve(JSON.parse(line));
      } catch {
        resolve({ ok: false });
      }
    }
  });
  proc.on('error', () => stopClipServer({ ok: false }));
  proc.on('exit', () => stopClipServer({ ok: false }));
  proc.stdin.on('error', () => {}); // EPIPE se o PowerShell morrer: tratado no evento 'exit'
  clipProc = proc;
}

function clipCommand(cmd) {
  startClipServer();
  if (!clipProc) return Promise.resolve({ ok: false });
  return new Promise((resolve) => {
    clipWaiting.push(resolve);
    clipProc.stdin.write(JSON.stringify(cmd) + '\n');
  });
}

app.whenReady().then(startClipServer); // aquece: o primeiro Ctrl+V já sai rápido
app.on('will-quit', () => clipProc?.kill());

ipcMain.handle('clip:write', (_e, paths, cut) => clipCommand({ op: 'write', paths, cut: !!cut }));

ipcMain.handle('clip:read', async () => {
  const r = await clipCommand({ op: 'read' });
  return { ok: !!r.ok, paths: [].concat(r.paths || []), cut: !!r.cut };
});

ipcMain.handle('clip:clear', () => clipCommand({ op: 'clear' }).then(() => {}));

// ---------- arrastar para fora e miniaturas ----------

// 1×1 transparente: reserva caso o ícone de arraste não carregue (o Electron exige um ícone)
const BLANK_ICON =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

ipcMain.handle('drag:start', (e, files) => {
  const valid = (Array.isArray(files) ? files : []).filter((f) => typeof f === 'string' && fs.existsSync(f));
  if (!valid.length) return false;
  let icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'drag-icon.png'));
  if (icon.isEmpty()) icon = nativeImage.createFromDataURL(BLANK_ICON);
  try {
    e.sender.startDrag({ file: valid[0], files: valid, icon });
    return true;
  } catch {
    return false;
  }
});

// Miniatura (imagens, vídeos, PDFs…) ou ícone do tipo de arquivo, no tamanho pedido, como data URL.
ipcMain.handle('thumb:get', async (_e, p, size) => {
  const px = Math.min(Math.max(Number(size) || 96, 32), 256);
  try {
    const img = await nativeImage.createThumbnailFromPath(p, { width: px, height: px });
    if (!img.isEmpty()) return img.toDataURL();
  } catch {
    // sem miniatura para este tipo: cai para o ícone do sistema
  }
  try {
    const img = await app.getFileIcon(p, { size: 'large' });
    if (!img.isEmpty()) return img.toDataURL();
  } catch {
    // arquivo inacessível
  }
  return null;
});

ipcMain.handle('fs:isDir', async (_e, p) => {
  try {
    return (await fsp.stat(p)).isDirectory();
  } catch {
    return false;
  }
});

ipcMain.handle('fs:open', async (_e, p) => {
  const err = await shell.openPath(p);
  return err ? { ok: false, error: err } : { ok: true };
});

ipcMain.handle('fs:reveal', (_e, p) => shell.showItemInFolder(p));

// Visualizador (F3): lê até 1 MB como texto.
ipcMain.handle('fs:readText', async (_e, p) => {
  try {
    const LIMIT = 1024 * 1024;
    const fh = await fsp.open(p, 'r');
    try {
      const { size } = await fh.stat();
      const buf = Buffer.alloc(Math.min(size, LIMIT));
      await fh.read(buf, 0, buf.length, 0);
      if (buf.includes(0)) return { ok: false, error: 'Arquivo binário: visualização de texto indisponível.' };
      return { ok: true, text: buf.toString('utf8'), truncated: size > LIMIT };
    } finally {
      await fh.close();
    }
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('fs:writeText', async (_e, p, text) => {
  try {
    await fsp.writeFile(p, text, 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Busca (Alt+F7 / Ctrl+Shift+F): nome com curinga * e ?, recursiva em uma ou mais raízes.
// Os resultados chegam aos poucos pelo canal 'fs:searchResults' e a busca pode ser cancelada
// (fs:cancel). O progresso (pasta sendo varrida) segue pelo canal 'fs:progress' em job.current.
const SEARCH_MAX = 2000;

ipcMain.handle('fs:search', (e, roots, pattern, jobId) =>
  runJob(e, jobId, async (job) => {
    const esc = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    const re = new RegExp(pattern.includes('*') || pattern.includes('?') ? `^${esc}$` : esc, 'i');
    let found = 0;
    let batch = [];
    let lastFlush = 0;

    const flush = (force) => {
      const now = Date.now();
      if (!batch.length || (!force && now - lastFlush < 150)) return;
      lastFlush = now;
      if (!job.sender.isDestroyed()) job.sender.send('fs:searchResults', job.id, batch);
      batch = [];
    };

    const stop = () => job.ac.signal.aborted || found >= SEARCH_MAX;

    async function walk(dir) {
      if (stop()) return;
      job.current = dir;
      emit(job);
      let ents;
      try {
        ents = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return; // sem permissão ou pasta removida durante a busca
      }
      for (const ent of ents) {
        if (stop()) return;
        const full = path.join(dir, ent.name);
        if (re.test(ent.name)) {
          found++;
          batch.push({ path: full, isDir: ent.isDirectory() });
          flush(false);
        }
        if (ent.isDirectory() && !ent.isSymbolicLink()) await walk(full);
      }
    }

    for (const root of roots) await walk(root);
    flush(true);
    return { found, truncated: found >= SEARCH_MAX, cancelled: job.ac.signal.aborted };
  })
);
