# API do NotasMAX — PostgreSQL

## Sobre o projeto

Este repositório contém a fundação da nova API do NotasMAX. A aplicação usa Azure Functions v4 com Node.js e TypeScript. O acesso ao PostgreSQL é feito com Knex e `pg`.

Atualmente, a API oferece a rota de verificação de saúde `GET /api/v1/health`. Ela confirma que a Function está respondendo e que consegue executar `SELECT 1` no PostgreSQL. A base local começa vazia: ainda não há tabelas de domínio, migrações aplicadas, dados migrados do MongoDB ou rotas de negócio.

A estrutura principal é:

```text
src/
├── database/       # criação e reutilização da conexão Knex/PostgreSQL
├── functions/      # registro das rotas Azure Functions
└── health/         # verificação do banco e resposta de saúde da API
test/               # testes unitários e de integração
migrations/         # diretório reservado para migrações aprovadas
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

O teste de integração PostgreSQL é ignorado por padrão na execução unitária. Com o PostgreSQL local iniciado, execute:

```bash
npm run test:integration
```

Esse teste usa `local.settings.json` quando disponível e executa `SELECT 1`; não cria tabelas de domínio nem aplica migrações. Para auditar as dependências registradas no arquivo de lock:

```bash
npm audit
```

## Resposta da verificação de saúde

| Situação | HTTP | Conteúdo |
|---|---:|---|
| API e PostgreSQL respondem | `200` | `{"status":"ok"}` |
| Banco indisponível, erro de conexão ou tempo limite excedido | `503` | Problema RFC 9457 com `code: HEALTH_CHECK_UNAVAILABLE` |

Os registros da invocação contêm somente evento, `invocationId`, resultado e duração.

## Validação de entrada e erros HTTP

O módulo compartilhado `src/http/validation.ts` valida dados com schemas Zod antes que um handler use os valores recebidos. Não há rota demonstrativa registrada. Em handlers futuros, os parâmetros de rota e query podem ser validados com `validateInput`; query usa `request.query` diretamente, e chaves repetidas são representadas como arrays. O corpo JSON é analisado e validado com `validateJsonBody`:

```typescript
const route = validateInput(routeSchema, request.params, { in: "path" });
if (!route.success) return route.response;

const query = validateInput(querySchema, request.query, { in: "query" });
if (!query.success) return query.response;

const body = await validateJsonBody(request, bodySchema);
if (!body.success) return body.response;

// route.data, query.data e body.data têm os tipos inferidos dos schemas.
```

Falhas de JSON malformado e de formato/tipo nos parâmetros de rota ou query retornam `400 Bad Request`. JSON válido que não atende ao schema do corpo retorna `422 Unprocessable Content`. As respostas usam `Content-Type: application/problem+json`, `type: about:blank` e `code: VALIDATION_ERROR`; os itens `errors[]` usam somente `FIELD_REQUIRED`, `INVALID_TYPE`, `INVALID_FORMAT`, `VALUE_OUT_OF_RANGE` ou `INVALID_VALUE`.

Os campos legíveis são apresentados em português, sem incluir valores rejeitados ou mensagens internas do validador. Erros do corpo apontam para o campo por JSON Pointer, escapando `~` como `~0` e `/` como `~1`; erros de rota e query identificam o parâmetro pelo nome.

Exemplo de erro de campo:

```json
{
  "type": "about:blank",
  "title": "Conteúdo não processável",
  "status": 422,
  "code": "VALIDATION_ERROR",
  "detail": "O conteúdo enviado não atende aos critérios de validação.",
  "errors": [
    {
      "code": "FIELD_REQUIRED",
      "detail": "Este campo é obrigatório.",
      "source": { "in": "body", "pointer": "/nome" }
    }
  ]
}
```

Esse padrão fica disponível para endpoints aprovados em entregas futuras. Ele não altera `GET /api/v1/health`, cuja resposta de sucesso e falha permanece específica da verificação de saúde.

## GitHub Actions

O fluxo de integração contínua definido em `.github/workflows/ci.yml` executa `npm ci`, checagem de tipos, compilação, testes e `npm audit`, com um PostgreSQL temporário `postgres:18.6-bookworm`. A execução remota ainda está pendente e não há resultado remoto registrado. Os comandos equivalentes foram executados localmente.

## Migrações e funcionalidades disponíveis

O `knexfile.cjs` e o diretório `migrations/` preparam o projeto para futuras migrações aprovadas. Nenhuma migração foi criada ou executada, e ainda não há estrutura de tabelas de domínio.

Não execute os comandos de migração antes de a estrutura do banco ser definida e as migrações serem autorizadas. Mesmo sem migrações de domínio, o Knex pode criar tabelas internas de controle.

Atualmente, a API não implementa regras de negócio, autenticação, rotas para a aplicação web e o aplicativo móvel, publicação na Azure ou migração de dados do MongoDB.

## Problemas comuns

- **`func` não encontrado:** instale o Azure Functions Core Tools v4 e abra um terminal em que `func --version` funcione.
- **A verificação de saúde retorna 503:** confirme que o contêiner PostgreSQL está saudável com `docker compose ps` e que `local.settings.json` contém os mesmos valores do `.env`.
- **Aviso de AzureWebJobsStorage/Azurite:** o exemplo local usa `UseDevelopmentStorage=true`. Esta API HTTP não usa Azure Storage; sem Azurite, o host pode registrar um aviso de tempo limite de armazenamento mesmo quando a rota HTTP inicia. Se o host não registrar a Function, confira a saída do Core Tools e a disponibilidade do Azurite.
- **O código TypeScript mudou, mas a rota não atualizou:** rode `npm run build` novamente e reinicie `npm start`.
