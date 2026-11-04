# BotZomboid

Publica no Discord os eventos do mod Living Herds quando a hospedagem do jogo não permite rodar Node.js.

O mod grava os eventos em um arquivo no servidor do jogo. Este bot roda em outro lugar (no Discloud), lê esse arquivo pela API de cliente do Pterodactyl e envia as mensagens por webhook. Não usa pacotes npm nem abre portas.

```
Servidor PZ (mod) --grava--> arquivo de eventos <--API do Pterodactyl-- BotZomboid --webhook--> Discord
```

Os alertas chegam com um atraso de até `POLL_SECONDS` (20 segundos por padrão).

## Mapa nos alertas

Alertas de jogador próximo e de horda se aproximando trazem uma imagem com o norte para cima, centrada nos jogadores:

- **Azul:** jogadores.
- **Vermelho cheio:** horda com zumbis observados, com a quantidade dentro.
- **Amarelo tracejado:** posição só estimada; pode não haver zumbis ali.
- **Seta `RUMO`:** para onde a horda está indo.

É um radar, sem o desenho das ruas. Para ver o lugar, use o campo `Coordenadas da horda` em um mapa de Project Zomboid.

O mapa exige o mod Living Herds 0.3.1 ou superior no servidor, com `DiscordMapCoordinates = true`. **Quem vê o canal vê a posição dos jogadores envolvidos.** Com o mod antigo ou essa opção desligada, o alerta chega só com texto.

## Antes de começar

No **Sandbox do servidor**, ative `DiscordWebhookEnabled = true` na seção `LivingHerds`. Sem isso o mod não cria o arquivo.

Você vai precisar de:

| Variável | O que é |
|---|---|
| `PANEL_URL` | Endereço do painel, só o domínio: `https://painel.suahospedagem.com` |
| `PANEL_API_KEY` | Chave de cliente do painel, em Conta → API Credentials. Começa com `ptlc_` |
| `DISCORD_WEBHOOK_URL` | Webhook do canal, em Editar canal → Integrações → Webhooks |

Opcionais, veja [.env.example](.env.example): `SERVER_ID`, `EVENTS_FILE`, `SERVER_NAME`, `POLL_SECONDS`, `MAX_PER_MINUTE`.

- `SERVER_ID`: se a conta tiver um único servidor, o bot o encontra sozinho.
- `EVENTS_FILE`: o padrão é `/.cache/Lua/LivingHerds-discord-events.txt`. Confira no SFTP se o arquivo está nesse caminho.

**A chave do painel controla o servidor e este repositório é público.** Nunca coloque chave ou webhook em arquivos versionados. O `.env` é ignorado pelo git.

## Publicar no Discloud

**Pelo GitHub:** importe este repositório no Discloud e preencha as três variáveis no campo de variáveis de ambiente. O Discloud gera o `.env` ao iniciar e publica de novo a cada push.

**Por upload:** copie `.env.example` para `.env`, preencha, compacte a pasta em um ZIP (o `.env` precisa estar junto do `discloud.config`) e envie. Não publique esse ZIP.

O `discloud.config` usa `VERSION=latest` e 100 MB de RAM. O bot exige Node 20 ou superior e avisa no log se a versão for menor.

## Como saber se funcionou

O log deve mostrar `iniciado`, o `IP publico` do bot e depois `lendo o arquivo de eventos`. Esse é o IP para colocar na lista de IPs da chave do painel; ele pode mudar quando o bot for reiniciado ou publicado de novo. Para descobri-lo, o bot faz uma consulta anônima a `api.ipify.org` ou `icanhazip.com`, sem enviar chave ou webhook. Se aparecer outra mensagem:

| Mensagem no log | O que fazer |
|---|---|
| `o painel recusou a chave (HTTP 401)` | Crie uma nova chave e atualize `PANEL_API_KEY` |
| `a chave nao tem acesso a este servidor (HTTP 403)` | Confira `SERVER_ID` e, se a chave tiver lista de IPs, inclua o `IP publico` do log ou deixe a lista vazia |
| `HTTP 403 sem resposta da API` | Um firewall do painel está bloqueando o bot. Peça à hospedagem para liberar `/api/client` |
| `servidor ou arquivo nao encontrado` | Ative `DiscordWebhookEnabled`, reinicie o jogo e confira `EVENTS_FILE` |
| `PANEL_URL respondeu, mas nao parece um Pterodactyl` | Confira o endereço do painel |

A cada 30 minutos o bot escreve uma linha `ativo` com o total de leituras e eventos. Depois de uma falha de autenticação ou bloqueio, ele espera 15 minutos antes de tentar de novo, para não forçar o painel. Reinicie o bot depois de corrigir.

## Limitações

- Não foi testado contra um painel real nem no Discloud: os testes usam um painel e um Discord simulados.
- Se o Discloud apagar `data/` ao reiniciar, eventos dos últimos 30 minutos podem ser reenviados uma vez.
- O plano precisa manter o bot ligado. `AUTORESTART` exige plano Platinum no Discloud, então não está ativado. Erros de rede não derrubam o bot.

## Desenvolvimento

```
npm test
```
