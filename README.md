# ConectaNOS — Monitoramento de Ruído (app)

PWA mobile-first (390 px) do produto de monitoramento sonoro ConectaNOS,
sobre a API do ThingsBoard (login de cliente, cards de locais, máscara de
limites NBR 10151/10152 e níveis ao longo do dia). Design conforme o
handoff `design_handoff_monitoramento_conectanos` (tema escuro azul,
fonte Manrope).

- **Backend**: ThingsBoard self-hosted (`thingsboard.nosconectados.com.br`)
  — o app é 100% estático e fala direto com a API REST (CORS aberto).
- **Login**: usuários de customer do próprio ThingsBoard (sem cadastro
  próprio; o token JWT fica em `localStorage`).
- **Hospedagem**: GitHub Pages (site estático, sem build).

## Estrutura

| Arquivo | Papel |
|---|---|
| `index.html` | shell + tab bar |
| `app.js` | telas (login/Início/Dashboard/Perfil), API, gráficos SVG |
| `style.css` | tokens do tema ConectaNOS |
| `manifest.webmanifest` + `sw.js` | PWA (ícone na tela inicial, cache do shell) |

Sem dependências além do Leaflet (CDN, carregado só se o device tiver
`latitude`/`longitude` nos atributos).

Fonte de trabalho: `Z:\claude\dnms\app-conectanos\` (projeto DNMS).
