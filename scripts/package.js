// Gera o executável do Windows e cria o atalho (.lnk).
//   npm run package
//
// O aplicativo empacotado vai para %LOCALAPPDATA%\Programs\Gerenciador de Arquivos
// (fora do OneDrive, para não sincronizar ~300 MB de binários do Electron).
// Variáveis opcionais: APP_OUT_DIR (pasta de saída), SKIP_DESKTOP_SHORTCUT=1 (não cria atalho na Área de Trabalho).
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const APP_NAME = 'Gerenciador de Arquivos';
const OUT =
  process.env.APP_OUT_DIR ||
  path.join(process.env.LOCALAPPDATA || path.join(require('os').homedir(), 'AppData', 'Local'), 'Programs', APP_NAME);

// -EncodedCommand (UTF-16LE em base64) evita problemas de codificação com acentos nos caminhos
function powershell(script, encoding) {
  const encoded = Buffer.from("$ProgressPreference='SilentlyContinue';" + script, 'utf16le').toString('base64');
  return execFileSync('powershell', ['-NoProfile', '-EncodedCommand', encoded], { encoding });
}

async function main() {
  execFileSync(process.execPath, [path.join(__dirname, 'make-icon.js')], { stdio: 'inherit' });
  const icon = path.join(ROOT, 'build', 'icon.ico');

  const { packager } = await import('@electron/packager');
  const [appDir] = await packager({
    dir: ROOT,
    name: APP_NAME,
    out: OUT,
    platform: 'win32',
    arch: 'x64',
    icon,
    overwrite: true,
    asar: true,
    prune: true,
    // Lista de permissão: só o que o app precisa em tempo de execução entra no pacote. (Uma lista de
    // exclusão deixava passar pastas novas, como versoes/ com os zips das Releases: +300 MB no app.asar.)
    ignore: (p) =>
      p !== '' &&
      (!/^\/(package\.json|LICENSE|src|node_modules)($|\/)/.test(p) || // fora da lista
        /^\/node_modules\/(\.bin|\.package-lock\.json)($|\/)/.test(p)), // restos de ferramentas de build
    appCopyright: 'Calçados Beira Rio',
  });

  const exe = path.join(appDir, `${APP_NAME}.exe`);
  if (!fs.existsSync(exe)) throw new Error(`Executável não encontrado: ${exe}`);
  console.log('Executável:', exe);

  // atalhos: na pasta do projeto e (a menos que desativado) na Área de Trabalho
  const targets = [path.join(ROOT, `${APP_NAME}.lnk`)];
  if (!process.env.SKIP_DESKTOP_SHORTCUT) {
    const desktop = powershell(
      '[Console]::OutputEncoding=[Text.Encoding]::UTF8;[Environment]::GetFolderPath("Desktop")',
      'utf8'
    ).trim();
    if (desktop) targets.push(path.join(desktop, `${APP_NAME}.lnk`));
  }
  const ps = (lnk) =>
    `$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${lnk.replace(/'/g, "''")}');` +
    `$s.TargetPath='${exe.replace(/'/g, "''")}';` +
    `$s.WorkingDirectory='${appDir.replace(/'/g, "''")}';` +
    `$s.IconLocation='${exe.replace(/'/g, "''")},0';` +
    `$s.Description='${APP_NAME}';$s.Save()`;
  for (const lnk of targets) {
    powershell(ps(lnk));
    console.log('Atalho criado:', lnk);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
