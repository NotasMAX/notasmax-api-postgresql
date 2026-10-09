# API do NotasMAX — PostgreSQL

## Sobre o projeto

Este repositório contém a fundação da nova API do NotasMAX. A aplicação usa Azure Functions v4 com Node.js e TypeScript. O acesso ao PostgreSQL é feito com Knex e `pg`.

Atualmente, a API oferece a rota de verificação de saúde `GET /api/v1/health` e as rotas de sessão administrativa aprovadas nesta fase. A verificação de saúde confirma que a Function está respondendo e que consegue executar `SELECT 1` no PostgreSQL. As migrations criam o schema relacional inicial da V1 em uma base vazia; a base local ainda não recebe dados migrados do MongoDB nem rotas de negócio. O primeiro administrador é criado somente quando o seed manual é executado.

A estrutura principal é:

```text
src/
├── database/       # conexão Knex/PostgreSQL e proteção de comandos locais
├── functions/      # registro das rotas Azure Functions
├── auth/           # autenticação administrativa, sessões e autorização server-side
└── health/         # verificação do banco e resposta de saúde da API
test/               # testes unitários e de integração
migrations/         # migrations forward-only do schema inicial V1
seed/               # seed manual e interativo do primeiro administrador
.github/workflows/  # validações automatizadas da CI
```

## Fluxo da verificação de saúde

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
npm start -- --cors http://localhost:5173 --cors-credentials
```

A compilação com `npm run build` gera os arquivos JavaScript em `dist/`, de onde o ambiente do Azure Functions carrega a Function. Deixe o comando Core Tools acima em execução no terminal. Em outro terminal, consulte a rota:

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
npm start -- --cors http://localhost:5173 --cors-credentials
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
| `NOTASMAX_WEB_ORIGINS` | Origens exatas autorizadas para mutações com sessão | `http://localhost:5173` |

O Docker Compose lê `.env` para configurar o contêiner PostgreSQL. O Azure Functions Core Tools e o carregador de testes leem `local.settings.json`. Variáveis já definidas no ambiente do processo prevalecem sobre os exemplos locais.

O PostgreSQL local escuta somente em `127.0.0.1:5432` e usa um volume Docker nomeado. Para parar o contêiner e preservar os dados locais:

```bash
docker compose down
```

Para remover também o volume e todos os dados locais do banco:

```bash
docker compose down -v
```

## CORS e sessão administrativa local

O website usa Vite, cuja porta local padrão é `5173`. Mantenha essa origem exata em `NOTASMAX_WEB_ORIGINS` no `local.settings.json` e na opção `--cors` do Core Tools, junto com `--cors-credentials`; não use `*`. Se o Vite iniciar em outra porta, atualize ambos os valores para a origem impressa pelo servidor. As origens devem coincidir exatamente, incluindo protocolo, host e porta.

As operações que iniciam e encerram sessões também validam `Origin` e exigem `X-Requested-With: XMLHttpRequest` no servidor. O cookie de sessão é `HttpOnly; Secure; SameSite=None`; o desenvolvimento local usa HTTP em `localhost`, mantendo `Secure`. A validação do cookie no Safari fica para um ambiente HTTPS, conforme o escopo aprovado. As origens HTTPS da Azure devem ser configuradas quando os endereços existirem; nenhuma configuração ou publicação Azure faz parte desta fase.

## Testes e verificações

Execute o lint, a verificação de tipos e a compilação:

```bash
npm run lint
npm run typecheck
npm run build
```

O lint usa ESLint com as regras recomendadas para JavaScript e TypeScript e cobre os arquivos mantidos de aplicação, testes, migrations, seed e tooling. Dependências instaladas e saídas geradas em `node_modules/`, `dist/` e `coverage/` são excluídas. A CI executa `npm run lint` como etapa obrigatória.

O lint é um controle complementar para consistência e problemas detectáveis pelas regras configuradas. O NIST SP 800-218 SSDF v1.1 cita linters como um exemplo para consistência de estilo e formatação (PW.5, Exemplo 7) e aborda análise e revisão de código separadamente em PW.7. Isso não significa que ESLint, sozinho, estabeleça conformidade de segurança ou substitua revisão humana, testes, análise de segurança ou auditoria de dependências. Consulte a [publicação do NIST](https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.800-218.pdf) e a [documentação oficial do ESLint](https://eslint.org/docs/latest/about/).

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

O fluxo de integração contínua definido em `.github/workflows/ci.yml` executa `npm ci`, `npm run lint` como etapa obrigatória, checagem de tipos, compilação, testes e `npm audit`, com um PostgreSQL `postgres:18.6-bookworm`. Os resultados de cada execução local ou remota são registrados no relatório DGF correspondente.

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

Atualmente, a API não implementa regras de negócio nem rotas para a aplicação web e o aplicativo móvel. A autenticação administrativa está disponível somente por sessão na API; a integração web/mobile, a publicação na Azure e a migração de dados do MongoDB continuam fora desta fase.

## Problemas comuns

- **`func` não encontrado:** instale o Azure Functions Core Tools v4 e abra um terminal em que `func --version` funcione.
- **A verificação de saúde retorna 503:** confirme que o contêiner PostgreSQL está saudável com `docker compose ps` e que `local.settings.json` contém os mesmos valores do `.env`.
- **Aviso de AzureWebJobsStorage/Azurite:** o exemplo local usa `UseDevelopmentStorage=true`. Esta API HTTP não usa Azure Storage; sem Azurite, o host pode registrar um aviso de tempo limite de armazenamento mesmo quando a rota HTTP inicia. Se o host não registrar a Function, confira a saída do Core Tools e a disponibilidade do Azurite.
- **O código TypeScript mudou, mas a rota não atualizou:** rode `npm run build` novamente e reinicie `npm start`.
