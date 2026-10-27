# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Gerenciador de arquivos de dois (até quatro) painéis, inspirado no Double Commander. Electron + JavaScript puro (sem bundler, TypeScript, lint ou testes automatizados). Interface e comentários em português; mantenha esse idioma. O README.md lista atalhos e comportamentos de UI em detalhe.

## Comandos

- `npm install` e `npm start` — executa em modo de desenvolvimento.
- `npm run package` — gera o `.exe` (via `@electron/packager`) em `%LOCALAPPDATA%\Programs\Gerenciador de Arquivos\` (fora do OneDrive de propósito) e recria o atalho `.lnk` na pasta do projeto e na Área de Trabalho. Variáveis: `APP_OUT_DIR`, `SKIP_DESKTOP_SHORTCUT=1`. Regenera o ícone antes (`npm run icon` → `scripts/make-icon.js`). Precisa ser rodado de novo após qualquer mudança para atualizar o executável.
- Não há testes nem linter; valide rodando o app.

## Arquitetura

Três camadas, todas em `src/`:

- `main.js` (processo principal) — todas as operações de sistema de arquivos, expostas como `ipcMain.handle('fs:*' | 'clip:*' | 'drag:*' | 'thumb:*')`.
- `preload.js` — única ponte: expõe `window.fm` via `contextBridge` (`contextIsolation: true`, `nodeIntegration: false`). Um novo recurso exige o handler em `main.js` **e** a entrada correspondente em `preload.js`.
- `renderer/renderer.js` (~2300 linhas, um único arquivo) + `index.html` + `styles.css` — toda a UI: painéis, abas, layouts, seleção, atalhos, diálogos.

Pontos que exigem ler mais de um lugar:

- **Trabalhos longos** (copiar, mover, excluir, buscar): o renderer gera um `jobId`, passa-o ao handler, recebe progresso por `fs:progress` / `fs:searchResults` (`onProgress`/`onSearchResults`) e cancela com `fm.cancel(jobId)` (`fs:cancel`). Cópia cancelada remove o que foi copiado parcialmente.
- **Área de transferência do Windows**: `main.js` mantém um PowerShell `-STA` residente (script `CLIP_SERVER`, protocolo JSON de uma linha por comando via stdin/stdout, fila `clipWaiting`) para ler/escrever lista de arquivos + `Preferred DropEffect` (5 = copiar, 2 = recortar). É isso que dá interoperabilidade com o Explorer; não substituir por spawn por comando (~2 s cada).
- **Arrastar**: do Explorer para dentro usa `fm.pathForFile`; para fora usa `drag:start` (arraste nativo, ícone em `src/assets/drag-icon.png`); entre painéis/abas é tratado no renderer.
- **Estado persistente** (layout, proporções, abas, ordenação, modo de visualização): `localStorage` no renderer, com acesso protegido por try/catch (`renderer.js` ~l.168); tudo deve funcionar sem ele.
- **Plataforma**: pensado para Windows (unidades, "Meu Computador", Lixeira via `shell.trashItem`, PowerShell). Menu padrão do Electron é removido (`Menu.setApplicationMenu(null)`) porque seus aceleradores conflitariam com os atalhos do app.
- **Paleta**: apenas quatro cores, variáveis `--c-*` no topo de `styles.css`; o resto é derivado delas. Não introduza cores novas.
