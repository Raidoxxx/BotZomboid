# BotZomboid

Publica no Discord os eventos do mod Living Herds quando a hospedagem do jogo não permite rodar Node.js.

O mod grava os eventos em um arquivo no servidor do jogo. Este bot roda em outro lugar (no Discloud), lê esse arquivo pela API de cliente do Pterodactyl e envia as mensagens por webhook. Não usa pacotes npm nem abre portas.

```
Servidor PZ (mod) --grava--> arquivo de eventos <--API do Pterodactyl-- BotZomboid --webhook--> Discord
```

Os alertas chegam com um atraso de até `POLL_SECONDS` (20 segundos por padrão).

## Mapa nos alertas

Alertas de jogador próximo e de horda se aproximando trazem o mapa real do jogo com o norte para cima, centrado nos jogadores:

- **Azul:** jogadores.
- **Vermelho cheio:** horda com zumbis observados, com a quantidade dentro.
- **Amarelo tracejado:** posição só estimada; pode não haver zumbis ali.
- **Seta `RUMO`:** para onde a horda está indo.

Vários alertas sobre os mesmos jogadores viram uma mensagem só, com todas as hordas no mesmo mapa e uma linha para cada uma. O bot espera até 25 segundos para juntá-los; um alerta crítico sai na hora e leva junto o que já estiver na fila. Jogadores a mais de 1.000 tiles uns dos outros recebem mensagens separadas.

O mapa não fica neste repositório, porque é um arquivo do jogo. Ao iniciar, o bot baixa `WORLD_MAP_FILE` (cerca de 53 MB) do seu servidor pelo painel e guarda em `data/pyramid.zip`. Nada disso atrasa os alertas: enquanto o download não termina, ou se falhar, a imagem sai como um radar sem o fundo. O bot tenta de novo sozinho. Áreas de mods de mapa ficam sem imagem de fundo, mas os marcadores continuam aparecendo.

As imagens exigem o mod Living Herds 0.3.1 ou superior no servidor, com `DiscordMapCoordinates = true`. Com o mod antigo ou essa opção desligada, o alerta chega só com texto.

**Quem vê o canal consegue achar o local exato dos jogadores, e até a base deles.** Em servidor com PvP, use um canal restrito ou desligue as coordenadas.

## Antes de começar

No **Sandbox do servidor**, ative `DiscordWebhookEnabled = true` na seção `LivingHerds`. Sem isso o mod não cria o arquivo.

Você vai precisar de:

| Variável | O que é |
|---|---|
| `PANEL_URL` | Endereço do painel, só o domínio: `https://painel.suahospedagem.com` |
| `PANEL_API_KEY` | Chave de cliente do painel, em Conta → API Credentials. Começa com `ptlc_` |
| `DISCORD_WEBHOOK_URL` | Webhook do canal, em Editar canal → Integrações → Webhooks |

Opcionais, veja [.env.example](.env.example): `SERVER_ID`, `EVENTS_FILE`, `WORLD_MAP_FILE`, `SERVER_NAME`, `POLL_SECONDS`, `MAX_PER_MINUTE`.

- `SERVER_ID`: se a conta tiver um único servidor, o bot o encontra sozinho.
- `EVENTS_FILE`: o padrão é `/.cache/Lua/LivingHerds-discord-events.txt`. Confira no SFTP se o arquivo está nesse caminho.
- `WORLD_MAP_FILE`: o padrão é `/media/maps/Muldraugh, KY/pyramid.zip`. Deixe vazio para usar só o radar.

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
| `mapa real indisponivel` | O motivo vem na própria linha. Os alertas seguem com o radar. Se o arquivo não for encontrado, procure `pyramid.zip` no SFTP e ajuste `WORLD_MAP_FILE` |

A cada 30 minutos o bot escreve uma linha `ativo` com o total de leituras e eventos. Depois de uma falha de autenticação ou bloqueio, ele espera 15 minutos antes de tentar de novo, para não forçar o painel. Reinicie o bot depois de corrigir.

## Limitações

- Não foi testado contra um painel real nem no Discloud: os testes usam um painel e um Discord simulados.
- Se o Discloud apagar `data/` ao reiniciar, eventos dos últimos 30 minutos podem ser reenviados uma vez, e o mapa é baixado de novo.
- O mapa baixado não é atualizado sozinho quando o jogo muda. Para atualizar, apague `data/pyramid.zip` ou publique o bot de novo.
- O plano precisa manter o bot ligado. `AUTORESTART` exige plano Platinum no Discloud, então não está ativado. Erros de rede não derrubam o bot.

## Desenvolvimento

```
npm test
```
