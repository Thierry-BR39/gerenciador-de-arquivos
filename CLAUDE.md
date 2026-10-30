# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Gerenciador de arquivos de dois (até quatro) painéis, inspirado no Double Commander. Electron + JavaScript puro (sem bundler, TypeScript, lint ou testes automatizados). Interface e comentários em português; mantenha esse idioma. O README.md lista atalhos e comportamentos de UI em detalhe.

## Comandos

- `npm install` e `npm start` — executa em modo de desenvolvimento. O Electron 45 não tem `postinstall`: o binário (~250 MB) é baixado no **primeiro `npm start`**. Mantenha o projeto em caminho curto: acima de ~260 caracteres o Electron falha com "Error loading V8 startup snapshot file" (vale também para pastas de teste temporárias).
- `npm run package` — gera o `.exe` (via `@electron/packager`) em `%LOCALAPPDATA%\Programs\Gerenciador de Arquivos\` (fora do OneDrive de propósito) e recria o atalho `.lnk` na pasta do projeto e na Área de Trabalho. Variáveis: `APP_OUT_DIR`, `SKIP_DESKTOP_SHORTCUT=1`. Regenera o ícone antes (`npm run icon` → `scripts/make-icon.js`). Precisa ser rodado de novo após qualquer mudança para atualizar o executável.
- Não há testes nem linter. Valide abrindo o app com um script que carrega `src/main.js` e usa `webContents.executeJavaScript` (as variáveis de topo do renderer, como `panels`, `layout`, `active`, são acessíveis por nome) e `webContents.sendInputEvent` para teclado/mouse reais. Detalhes que enganam: `mouseMove` sintético só marca `e.buttons` com `modifiers: ['leftButtonDown']`; o primeiro `mouseDown` precisa de uma pausa antes dos movimentos; `capturePage` falha de forma intermitente (repita); chame `app.disableHardwareAcceleration()`. A pasta de dados do app (`userData`, onde vive o `localStorage`) é a mesma do executável instalado: em scripts de teste use `app.setPath('userData', <pasta temporária>)` antes de `localStorage.clear()`, para não apagar a sessão salva de quem usa o app.
- **Publicar versão**: `npm run package`, compacte a pasta `Gerenciador de Arquivos-win32-x64` (por exemplo `tar.exe -a -cf Gerenciador-de-Arquivos-vX.Y.Z-win-x64.zip`, junto com uma cópia de `LICENSE`) e crie a Release no GitHub com a tag `vX.Y.Z` (no site, o campo da tag só vale depois de clicar em "Create new tag"). O `.exe` não é assinado (aviso do SmartScreen). Repositório público, licença MIT.
- **Arquivo local de versões**: a cada versão nova (depois de subir o número em `package.json` e `package-lock.json`), guarde o zip e as notas em `versoes/vX.Y.Z/` (`Gerenciador-de-Arquivos-vX.Y.Z-win-x64.zip` + `NOTAS-DA-RELEASE.md`), uma pasta por versão. A pasta `versoes/` está no `.gitignore` (centenas de MB de zips não vão para o GitHub) e já fica fora do pacote porque o `ignore` de `scripts/package.js` é uma lista de permissão (não adicione `versoes` a ela).

## Arquitetura

Três camadas, todas em `src/`:

- `main.js` (processo principal) — todas as operações de sistema de arquivos, expostas como `ipcMain.handle('fs:*' | 'clip:*' | 'drag:*' | 'thumb:*')`.
- `preload.js` — única ponte: expõe `window.fm` via `contextBridge` (`contextIsolation: true`, `nodeIntegration: false`). Um novo recurso exige o handler em `main.js` **e** a entrada correspondente em `preload.js`.
- `renderer/renderer.js` (~2300 linhas, um único arquivo) + `index.html` + `styles.css` — toda a UI: painéis, abas, layouts, seleção, atalhos, diálogos.

Pontos que exigem ler mais de um lugar:

- **Trabalhos longos** (copiar, mover, excluir, buscar): o renderer gera um `jobId`, passa-o ao handler, recebe progresso por `fs:progress` / `fs:searchResults` (`onProgress`/`onSearchResults`) e cancela com `fm.cancel(jobId)` (`fs:cancel`). Cópia cancelada remove o que foi copiado parcialmente.
- **Área de transferência do Windows**: `main.js` mantém um PowerShell `-STA` residente (script `CLIP_SERVER`, protocolo JSON de uma linha por comando via stdin/stdout, fila `clipWaiting`) para ler/escrever lista de arquivos + `Preferred DropEffect` (5 = copiar, 2 = recortar). É isso que dá interoperabilidade com o Explorer; não substituir por spawn por comando (~2 s cada).
- **Arrastar**: do Explorer para dentro usa `fm.pathForFile`; para fora usa `drag:start` (arraste nativo, ícone em `src/assets/drag-icon.png`); entre painéis/abas é tratado no renderer.
- **Estado persistente** (layout, proporções, abas, ordenação, modo de visualização): `localStorage` no renderer, acessado só por `loadJson`/`storeJson` (protegidos por try/catch); tudo deve funcionar sem ele.
- **Estado por aba**: os campos da aba ativa vivem no próprio `Panel`; as demais ficam em `panel.tabs`. Um novo campo por aba (como `history`, `forward`, `focusMem`, `view`) precisa ser tratado em `saveTab`, `loadTab`, na cópia de `newTab`, em `init` (restauração) e em `snapshot` (sessão). A ordenação **não** é por aba: é por pasta (`folderSorts`, `localStorage` `fm.sorts`, aplicada em `Panel.go`), e `focusMem` (item em foco por pasta) só é usado por voltar/avançar.
- **A lista é redesenhada por inteiro** (`Panel.render`) a cada mudança de cursor/seleção. Por isso cliques e duplo clique são tratados no `mousedown` (o `dblclick` nunca chega à linha original), arrastar entre painéis usa eventos de mouse e não HTML5 drag, e a seleção por retângulo, a rolagem até o cursor e o arraste dependem de `listEl.children[i]` ser a entrada `entries[i]`. Na visualização em ícones as células mantêm a classe `row` (e `.cell`) para reaproveitar tudo isso.
- **Miniaturas**: `thumb:get` (`nativeImage.createThumbnailFromPath`, com `app.getFileIcon` como reserva) devolve data URL; o renderer carrega sob demanda (`IntersectionObserver`), com fila de 4 em paralelo e cache. A CSP em `index.html` precisa continuar com `img-src 'self' data:`; ela também proíbe `style` inline em HTML (use `el.style.x = …` por JS, que é permitido) e scripts inline.
- **Plataforma**: pensado para Windows (unidades, "Meu Computador", Lixeira via `shell.trashItem`, PowerShell). Menu padrão do Electron é removido (`Menu.setApplicationMenu(null)`) porque seus aceleradores conflitariam com os atalhos do app.
- **Paleta**: apenas quatro cores, variáveis `--c-*` no topo de `styles.css`; o resto é derivado delas. Não introduza cores novas.

## Convenções do repositório

- O git do Windows converte para CRLF (`core.autocrlf`): ao editar por script, normalize para LF para casar texto e grave de volta com CRLF, para o diff mostrar só as linhas alteradas. Mensagens de commit em português.
- As capturas em `docs/` foram geradas com uma pasta de exemplo em unidade virtual (`subst`) e unidades reais ocultas; ao refazê-las, não deixe aparecer usuário, caminhos ou unidades de rede reais.
