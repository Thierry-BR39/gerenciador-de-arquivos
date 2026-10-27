# Gerenciador de Arquivos

Gerenciador de arquivos de dois painéis, inspirado no Double Commander (Electron + JavaScript).

## Executar

Pelo atalho **Gerenciador de Arquivos** (Área de Trabalho ou esta pasta), ou em modo de desenvolvimento:

```bash
npm install
npm start
```

## Gerar o executável e o atalho

```bash
npm run package
```

Gera o `.exe` em `%LOCALAPPDATA%\Programs\Gerenciador de Arquivos\Gerenciador de Arquivos-win32-x64\`
(fora do OneDrive, pois ocupa ~350 MB) e cria o atalho `.lnk` na Área de Trabalho e nesta pasta.
Opções: `APP_OUT_DIR` muda a pasta de saída; `SKIP_DESKTOP_SHORTCUT=1` não cria o atalho na Área de Trabalho.
Rode novamente após qualquer alteração no código para atualizar o executável.

## Mouse

| Ação | Resultado |
|---|---|
| Duplo clique | Abre pasta ou arquivo |
| Botão **Clique único** (barra superior) | Pastas abrem com um clique |
| Clique do meio numa pasta | Abre em nova aba |
| Clique simples | Seleciona só o item clicado |
| Ctrl+clique / Shift+clique | Marca item / intervalo |
| Arrastar a partir de um espaço vazio da lista | Seleção por retângulo (a lista rola sozinha perto das bordas; **Ctrl** inverte os itens tocados; Esc cancela) |
| Clicar em um espaço vazio da lista | Desmarca tudo |
| Arrastar do Explorer para um painel | Copia para a pasta aberta do painel (confirma antes) |
| Arrastar sobre uma pasta da lista | Copia para dentro dessa pasta |
| Arrastar segurando Shift | Move em vez de copiar |
| Arrastar arquivos **entre painéis e abas** | Solte na lista de outro painel, sobre uma pasta da lista ou no **título de uma aba** (parar ~0,7 s sobre uma aba a abre). Sem tecla: mesma unidade move, unidades diferentes copiam; **Ctrl** força copiar, **Shift** força mover; Esc cancela |

## Arrastar para fora do aplicativo

Arraste arquivos ou pastas (um ou vários marcados) para fora da janela: o aplicativo passa a usar o arraste nativo do
Windows, então o Explorer, e-mail, chats e outros programas recebem os arquivos reais (copia; segure **Shift** para mover).
Ao voltar para a janela, as listas são atualizadas automaticamente.

## Visualização em ícones e miniaturas

Cada painel/aba lembra o seu modo: **Detalhes** (lista), **Ícones médios** e **Ícones grandes**. Imagens, vídeos, PDFs e
demais tipos mostram a miniatura ou o ícone do Windows, carregados só quando aparecem na tela.

| Ação | Resultado |
|---|---|
| Botões ☰ ▦ ▣ na barra superior | Detalhes / ícones médios / ícones grandes |
| Ctrl+Shift+1 / 2 / 3 | O mesmo, pelo teclado |
| Ctrl + roda do mouse sobre a lista | Aumenta ou diminui os ícones |
| Setas (← → ↑ ↓) | Movem o cursor pela grade |

Nos ícones valem o duplo clique, a seleção por retângulo, arrastar e soltar, Ctrl+C/X/V e os demais atalhos.

## Copiar, recortar e colar

**Ctrl+C**, **Ctrl+X** e **Ctrl+V** (também nos botões da barra) usam a área de transferência do Windows, então funciona
com o Explorer nos dois sentidos: copie aqui e cole no Explorer, ou copie/recorte no Explorer e cole aqui.
Itens recortados ficam esmaecidos até serem colados. Colar na mesma pasta de uma cópia cria "nome - Cópia.ext".
Colar e arrastar entre painéis não pedem confirmação, mas conflitos de nome e o progresso continuam aparecendo.

## Painéis e layouts (padrões de encaixe do Windows 11)

Os cinco botões no canto superior direito (ou **Ctrl+Alt+1 … 5**) mudam a disposição:

| Atalho | Layout | Painéis |
|---|---|---|
| Ctrl+Alt+1 | Duas colunas | 2 |
| Ctrl+Alt+2 | Principal 2/3 + lateral 1/3 | 2 |
| Ctrl+Alt+3 | Três colunas | 3 |
| Ctrl+Alt+4 | Um painel + dois empilhados | 3 |
| Ctrl+Alt+5 | Grade 2×2 | 4 |

Arraste a divisória entre painéis para redimensionar; duplo clique na divisória restaura as proporções.
O layout e as proporções são lembrados. F5/F6 usam o próximo painel como destino, Tab percorre os painéis e Alt+F1…F4 edita o caminho de cada um.

## Atalhos de lugar

Cada painel tem os botões **Área de Trabalho**, **Downloads** e **Meu Computador** (lista as unidades com capacidade e espaço livre;
Backspace na raiz de uma unidade também leva até lá). Em "Meu Computador" copiar, excluir, criar e renomear ficam bloqueados.

## Renomeação em massa (Ctrl+M, botão na barra ou F2 com 2+ itens marcados)

Escolha **adicionar no início** ou **no final** do nome dos itens marcados; no final, pode inserir antes da extensão
(`relatorio.pdf` → `relatorio_v2.pdf`) ou depois dela. A prévia mostra cada nome antigo → novo, e a operação só é liberada
se nenhum nome ficar repetido, inválido ou colidir com um item existente.

## Abas (por painel, sem limite)

Ctrl+T nova aba · Ctrl+W fecha · Ctrl+Tab / Ctrl+Shift+Tab alterna · Ctrl+Enter abre a pasta atual em nova aba ·
botões `+` e `×` nas abas. As abas e a ordenação são lembradas ao reabrir o aplicativo.

## Busca

- **Ctrl+F** abre uma barra de filtro no painel ativo: a lista mostra só os itens da pasta atual que casam com o texto
  (`rel`, `*.pdf`, `nota_??`). Enter devolve o foco à lista, Esc limpa. Navegar para outra pasta também limpa o filtro.
- **Ctrl+Shift+F** abre a busca recursiva, por padrão em todas as unidades; dá para trocar para "pasta atual e subpastas".
  Os resultados aparecem conforme são encontrados (até 2000), e um clique leva ao item. Varrer um disco inteiro pode levar
  alguns minutos: use **Parar** quando já tiver achado o que queria.

## Atalhos de teclado (F1 no app mostra todos)

| Tecla | Ação |
|---|---|
| Tab | Alternar painel |
| Enter / Backspace | Abrir / subir um nível |
| Alt+← / Alt+→ | Voltar / avançar no histórico de pastas (cada aba tem o seu) |
| Insert, Espaço | Marcar item |
| Ctrl+A / Ctrl+D / `*` | Marcar tudo / desmarcar / inverter |
| F2 | Renomear |
| F3 / F4 | Visualizar / editar texto (até 1 MB) |
| F5 / F6 | Copiar / mover para o painel oposto |
| Ctrl+C / Ctrl+X / Ctrl+V | Copiar / recortar / colar arquivos |
| F7, Ctrl+N, Ctrl+Shift+N | Nova pasta |
| F8, Delete | Enviar para a Lixeira |
| Shift+Delete | Excluir permanentemente |
| Ctrl+F | Filtrar a pasta atual enquanto digita (aceita `*` e `?`; Esc limpa) |
| Ctrl+Shift+F | Buscar em **todas as unidades** (resultados em tempo real, botão Parar) |
| Alt+F7 | Buscar na pasta atual e subpastas |
| Ctrl+R / Ctrl+H / Ctrl+U | Atualizar / ocultos / trocar painéis |

Cópia, movimentação e exclusão mostram barra de progresso e podem ser canceladas (cópia parcial é removida).
Exclusão padrão vai para a Lixeira; sobrescrita em cópia/movimentação sempre pede confirmação.

## Estrutura

- `src/main.js` — processo principal: operações de arquivo via IPC
- `src/preload.js` — ponte segura (`window.fm`)
- `src/renderer/` — interface (HTML/CSS/JS)
- `scripts/` — gerador de ícone e empacotamento (`npm run package`)

## Próximos passos sugeridos

Favoritos, comparação de pastas, renomeação por substituição/numeração, terminal integrado, arrastar arquivos para fora do app (para o Explorer).

## Paleta de cores

Interface em quatro cores (variáveis `--c-*` no topo de `src/renderer/styles.css`; o resto é derivado delas):
`#111111` (fundo e listas, ~50%) · `#242424` (barras, cabeçalhos, diálogos, ~30%) · `#F5F5F5` (texto, ~15%) ·
`#FF6A00` (destaques: painel ativo, cursor, seleção, botão principal, ~5%). Alertas e ações destrutivas também usam o laranja.
