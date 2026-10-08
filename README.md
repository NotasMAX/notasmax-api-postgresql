# API do NotasMAX — PostgreSQL

## Sobre o projeto

Este repositório contém a fundação da nova API do NotasMAX. A aplicação usa Azure Functions v4 com Node.js e TypeScript. O acesso ao PostgreSQL é feito com Knex e `pg`.

Atualmente, a API oferece a rota de verificação de saúde `GET /api/v1/health`. Ela confirma que a Function está respondendo e que consegue executar `SELECT 1` no PostgreSQL. As migrations criam o schema relacional inicial da V1 em uma base vazia; a base local ainda não recebe dados migrados do MongoDB nem rotas de negócio. O primeiro administrador é criado somente quando o seed manual é executado.

A estrutura principal é:

```text
src/
├── database/       # conexão Knex/PostgreSQL e proteção de comandos locais
├── functions/      # registro das rotas Azure Functions
└── health/         # verificação do banco e resposta de saúde da API
test/               # testes unitários e de integração
migrations/         # migrations forward-only do schema inicial V1
seed/               # seed manual e interativo do primeiro administrador
.github/workflows/  # validações automatizadas da CI
```

## Como a API funciona hoje

```text
Cliente HTTP
    │ GET /api/v1/health
    ▼
Azure Function → manipulador de saúde → Knex/pg → PostgreSQL (SELECT 1)
    │                                      │
    ├── 200 { "status": "ok" } ◀──────────┘ consulta respondida
    └── 503 HEALTH_CHECK_UNAVAILABLE        falha ou tempo limite excedido
```

A rota não exige autenticação e deve permanecer limitada ao desenvolvimento e à integração contínua (CI) até que sua publicação seja autorizada. A verificação tem limite total de três segundos. Respostas e registros não expõem erros crus do banco, SQL, credenciais, corpos de requisição ou dados pessoais.

## Requisitos para executar localmente

- Node.js `24.21.0` e o npm incluído com ele.
- Docker Desktop com contêineres Linux (ou Docker Engine compatível) para iniciar o PostgreSQL.
- Azure Functions Core Tools v4; o comando `func` deve estar disponível no `PATH`.
- PowerShell no Windows, ou shell Bash no WSL/Linux.

Confira as versões instaladas:

```powershell
node --version
npm --version
docker --version
func --version
```

## Iniciar a API no Windows (PowerShell)

Execute os comandos na pasta deste repositório:

```powershell
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
if (-not (Test-Path local.settings.json)) { Copy-Item local.settings.json.example local.settings.json }
npm ci
docker compose up -d postgres
npm run build
npm start
```

A compilação com `npm run build` gera os arquivos JavaScript em `dist/`, de onde o ambiente do Azure Functions carrega a Function. Deixe `npm start` em execução no terminal. Em outro terminal, consulte a rota:

```powershell
Invoke-RestMethod -Method Get -Uri 'http://localhost:7071/api/v1/health'
```

Com o PostgreSQL disponível, a resposta será:

```json
{"status":"ok"}
```

Para ver o código HTTP e o corpo bruto:

```powershell
Invoke-WebRequest -Method Get -Uri 'http://localhost:7071/api/v1/health'
```

## Iniciar pelo WSL/Linux

Na raiz do repositório:

```bash
test -f .env || cp .env.example .env
test -f local.settings.json || cp local.settings.json.example local.settings.json
npm ci
docker compose up -d postgres
npm run build
npm start
```

Em outro terminal, consulte a rota:

```bash
curl -i http://localhost:7071/api/v1/health
```

## Configuração local

Os arquivos `.env` e `local.settings.json` são locais e ignorados pelo Git. Não coloque credenciais reais neles nem os versione.

| Variável | Uso | Valor de exemplo |
|---|---|---|
| `PGHOST` | Host do PostgreSQL | `127.0.0.1` |
| `PGPORT` | Porta do PostgreSQL | `5432` |
| `PGDATABASE` | Banco de desenvolvimento | `notasmax` |
| `PGUSER` | Usuário de desenvolvimento | `notasmax` |
| `PGPASSWORD` | Senha local de desenvolvimento | `local_dev_only` |

O Docker Compose lê `.env` para configurar o contêiner PostgreSQL. O Azure Functions Core Tools e o carregador de testes leem `local.settings.json`. Variáveis já definidas no ambiente do processo prevalecem sobre os exemplos locais.

O PostgreSQL local escuta somente em `127.0.0.1:5432` e usa um volume Docker nomeado. Para parar o contêiner e preservar os dados locais:

```bash
docker compose down
```

Para remover também o volume e todos os dados locais do banco:

```bash
docker compose down -v
```

## Testes e verificações

Execute a verificação de tipos e a compilação:

```bash
npm run typecheck
npm run build
```

Execute os testes unitários e de tratamento de erros:

```bash
npm test
```

Os testes de integração PostgreSQL são ignorados por padrão em `npm test`. Execute:

```bash
npm run test:integration
```

O comando exige PostgreSQL local em loopback e uma conta com permissão para criar bancos. Ele cria um banco descartável com nome gerado para a execução, aplica toda a sequência de migrations e remove somente esse banco ao terminar. O banco configurado para desenvolvimento não é usado como alvo de testes nem é removido. Para auditar as dependências registradas no arquivo de lock:

```bash
npm audit
```

## Resposta da verificação de saúde

| Situação | HTTP | Conteúdo |
|---|---:|---|
| API e PostgreSQL respondem | `200` | `{"status":"ok"}` |
| Banco indisponível, erro de conexão ou tempo limite excedido | `503` | Problema RFC 9457 com `code: HEALTH_CHECK_UNAVAILABLE` |

Os registros da invocação contêm somente evento, `invocationId`, resultado e duração.

## GitHub Actions

O fluxo de integração contínua definido em `.github/workflows/ci.yml` executa `npm ci`, checagem de tipos, compilação, testes e `npm audit`, com um PostgreSQL `postgres:18.6-bookworm`. Os resultados de cada execução local ou remota são registrados no relatório DGF correspondente.

## Migrations e primeiro administrador

As migrations criam as 16 tabelas de domínio da matriz física V1, agrupadas por assunto. Consulte o estado e aplique-as à base local com:

```bash
npm run db:migrate:status
npm run db:migrate:latest
```

Os comandos de migration e seed aceitam somente hosts de loopback (`127.0.0.0/8`, `::1` ou `localhost`) e falham para hosts remotos. Use `PGHOST=127.0.0.1` na configuração local. Esta fase é forward-only: não há comando de rollback e todo `down` de migration falha antes de alterar o schema.

O seed do primeiro administrador é manual e interativo:

```bash
npm run db:seed:admin
```

O seed solicita nome completo e e-mail; a senha é digitada sem eco no terminal, não há senha padrão e uma execução é recusada quando já existe administrador ativo. A senha é armazenada como hash Argon2id com os parâmetros aprovados. O seed deve ser executado em uma base local depois das migrations.

Atualmente, a API não implementa regras de negócio, autenticação, rotas para a aplicação web e o aplicativo móvel, publicação na Azure ou migração de dados do MongoDB.

## Problemas comuns

- **`func` não encontrado:** instale o Azure Functions Core Tools v4 e abra um terminal em que `func --version` funcione.
- **A verificação de saúde retorna 503:** confirme que o contêiner PostgreSQL está saudável com `docker compose ps` e que `local.settings.json` contém os mesmos valores do `.env`.
- **Aviso de AzureWebJobsStorage/Azurite:** o exemplo local usa `UseDevelopmentStorage=true`. Esta API HTTP não usa Azure Storage; sem Azurite, o host pode registrar um aviso de tempo limite de armazenamento mesmo quando a rota HTTP inicia. Se o host não registrar a Function, confira a saída do Core Tools e a disponibilidade do Azurite.
- **O código TypeScript mudou, mas a rota não atualizou:** rode `npm run build` novamente e reinicie `npm start`.
