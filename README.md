# API do NotasMAX — PostgreSQL

## Sobre o projeto

Este repositório contém a API do NotasMAX, construída com Azure Functions v4, Node.js 24 e TypeScript. O acesso ao PostgreSQL é feito com Knex e `pg`.

Atualmente, a API oferece `GET /api/v1/health`, as rotas de sessão administrativa, os fluxos compartilhados de ativação e recuperação de senha e os endpoints administrativos de contas de alunos, professores e administradores. A verificação de saúde confirma que a Function está respondendo e que consegue executar `SELECT 1` no PostgreSQL. As migrations criam o schema relacional inicial da V1 em uma base vazia; não há migração de dados do MongoDB. O primeiro administrador é criado somente quando o seed manual é executado.

A estrutura principal é:

```text
src/
├── database/       # conexão Knex/PostgreSQL e proteção de comandos locais
├── functions/      # registro das rotas Azure Functions
├── auth/           # sessões, autorização e ciclo/gestão administrativa de contas
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
| `NODE_ENV` | Ambiente local/teste para habilitar o fake | `development` |
| `NOTASMAX_EMAIL_TRANSPORT` | Adaptador fake habilitado somente em desenvolvimento/teste local | `fake` |
| `NOTASMAX_WEB_BASE_URL` | Origem HTTPS usada nos links de ativação e redefinição | `https://localhost:5173` |

O Docker Compose lê `.env` para configurar o contêiner PostgreSQL. O Azure Functions Core Tools e o carregador de testes leem `local.settings.json`. Variáveis já definidas no ambiente do processo prevalecem sobre os exemplos locais.

O transporte `fake` apenas aceita a solicitação em memória: não entrega mensagens e não imprime nem retorna links ou tokens. Ele exige uma origem HTTPS e falha fechado quando detecta execução no Azure. Não configure credenciais de provedor de e-mail nesta fase.

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

As operações que iniciam e encerram sessões também validam `Origin` e exigem `X-Requested-With: XMLHttpRequest` no servidor. O cookie de sessão é `HttpOnly; Secure; SameSite=None`; o desenvolvimento local usa HTTP em `localhost`, mantendo `Secure`. A validação do cookie no Safari depende de um ambiente HTTPS. As origens HTTPS da Azure devem ser configuradas quando os endereços existirem; publicação e configuração Azure não fazem parte da execução local documentada.

## Ciclo de vida de conta

| Método e rota | Finalidade |
|---|---|
| `POST /api/v1/auth/password-reset-requests` | Solicita redefinição; a resposta `200` é genérica. Há no máximo três solicitações por conta em uma janela fixa de 24 horas. |
| `POST /api/v1/auth/password-resets` | Consome token de redefinição de uso único, válido por uma hora, define a senha e revoga sessões existentes. |
| `POST /api/v1/auth/activations` | Consome token de ativação de uso único, válido por 72 horas, define a senha escolhida e ativa a conta. |
| `POST /api/v1/admin/users/{userId}/activation-resends` | Reenvia a ativação para conta pendente, exige sessão administrativa, origem permitida e `X-Requested-With`; responde `activationEmailStatus: sent|failed`. |

Os tokens são aleatórios; somente hashes SHA-256 e expirações ficam no PostgreSQL. Cada nova emissão substitui o token anterior do mesmo fluxo. O contador e o início da janela de redefinição são campos aditivos em `usuario`, zerados após login bem-sucedido ou redefinição concluída. Um timer diário da própria Function App remove registros de token expirados. O transporte desta fase é exclusivamente `fake`; `sent` indica aceite pelo adaptador, não entrega. Links tokenizados não aparecem em logs ou respostas.

## Administração de contas

Todas as rotas `/api/v1/admin/*` abaixo exigem sessão ativa de administrador verificada no servidor. Toda mutação também exige `Origin` presente e permitido pela allowlist exata e `X-Requested-With: XMLHttpRequest`; as rejeições ocorrem antes de qualquer acesso ao banco. As respostas seguem RFC 9457 e não incluem erros crus do PostgreSQL.

| Método e rota | Finalidade |
|---|---|
| `GET /api/v1/admin/students` | Lista alunos; aceita `search`, `activationStatus`, `enrollmentStatus`, `classId`, `page` e `pageSize`. |
| `POST /api/v1/admin/students` | Cria aluno pendente e solicita uma tentativa de ativação. Campos: `name`, `email`, `guardianPhone` e `contactPhone` opcional. |
| `GET`, `PATCH`, `DELETE /api/v1/admin/students/{studentId}` | Consulta dados e matrículas, edita campos cadastrais ou faz exclusão lógica. |
| `GET /api/v1/admin/teachers` | Lista professores; aceita `search`, `classId`, `subjectId`, `page` e `pageSize`. Quando turma e matéria são informadas juntas, devem corresponder à mesma associação existente. |
| `POST /api/v1/admin/teachers` | Cria professor pendente. Campos: `name`, `email` e `contactPhone` opcional. |
| `GET`, `PATCH`, `DELETE /api/v1/admin/teachers/{teacherId}` | Consulta, edita ou faz exclusão lógica do professor. |
| `GET /api/v1/admin/administrators` | Lista administradores; aceita `search`, `page` e `pageSize`. |
| `POST /api/v1/admin/administrators` | Cria administrador pendente. Campos: `name`, `email` e `contactPhone` opcional. |
| `GET`, `PATCH`, `DELETE /api/v1/admin/administrators/{administratorId}` | Consulta, edita ou faz exclusão lógica do administrador. |

As três listas usam busca parcial sem diferenciar maiúsculas/minúsculas em nome ou e-mail, ordenação por nome crescente, `page` padrão `1`, `pageSize` padrão `20` (máximo `100`) e resposta `{ items, pagination: { page, pageSize, totalItems, totalPages } }`. A lista de alunos separa `activationStatus` (`pending`/`activated`) e `enrollmentStatus` (`active`/`no_active_enrollment`); inclui a turma vigente e `enrollmentId` quando houver. Detalhes retornam os telefones disponíveis; o detalhe do aluno inclui o histórico de matrículas.

Criações retornam `201` com `activationEmailStatus: sent|failed`; falha síncrona do transporte fake/local não desfaz o cadastro. E-mail duplicado retorna `409 EMAIL_ALREADY_IN_USE`. `PATCH` aceita campos parciais. Ao mudar o e-mail de outra conta, exige `currentPassword` da pessoa administradora que executa a operação; essa reautenticação usa o mesmo bloqueio de cinco falhas por conta em 15 minutos. O administrador não pode alterar o próprio e-mail por essa rota; a API retorna `422 VALIDATION_ERROR` com `errors[].code: INVALID_VALUE`. O e-mail institucional atual permanece até a pessoa confirmar o novo endereço pelo fluxo de ativação; enquanto isso, a conta fica pendente e não pode iniciar ou usar uma sessão. A alteração de `email_pendente` e a invalidação do token de ativação anterior ocorrem na mesma transação; o novo token e a mensagem são emitidos depois do commit. A API envia uma notificação sem token ao endereço anterior e um link de ativação ao endereço pendente. A confirmação promove o novo endereço e revoga as sessões existentes. Sem mudança de e-mail, a senha atual não é exigida.

As mutações administrativas e os resultados de reautenticação emitem eventos mínimos pelo logger do contexto da Azure Function: `event`, `invocationId`, `result` e `durationMs`. Senhas, tokens, corpo da requisição, dados pessoais desnecessários e erros crus do PostgreSQL não são registrados. Esses eventos não são persistidos no banco de dados.

As exclusões são lógicas e revogam sessões sem apagar vínculos. O aluno só é bloqueado quando tem matrícula ativa e vínculo com simulado realizado (`409 STUDENT_CANNOT_BE_DELETED`); o professor é bloqueado enquanto houver associação a matéria/turma (`409 TEACHER_HAS_LINKED_DATA`). Administradores não podem excluir a própria conta (`409 ADMINISTRATOR_CANNOT_DELETE_SELF`) nem remover o último administrador ativo (`409 LAST_ACTIVE_ADMIN_CANNOT_BE_DELETED`). As associações professor-matéria-turma continuam sendo gerenciadas por endpoints separados e não são criadas ou removidas por estas rotas.

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

Esse padrão fica disponível para endpoints de negócio. Ele não altera `GET /api/v1/health`, cuja resposta de sucesso e falha permanece específica da verificação de saúde.

## GitHub Actions

O fluxo de integração contínua definido em `.github/workflows/ci.yml` executa `npm ci`, `npm run lint` como etapa obrigatória, checagem de tipos, compilação, testes e `npm audit`, com um PostgreSQL `postgres:18.6-bookworm`.

## Migrations e primeiro administrador

As migrations criam as 16 tabelas de domínio da matriz física V1, agrupadas por assunto. Consulte o estado e aplique-as à base local com:

```bash
npm run db:migrate:status
npm run db:migrate:latest
```

Os comandos de migration e seed aceitam somente hosts de loopback (`127.0.0.0/8`, `::1` ou `localhost`) e falham para hosts remotos. Use `PGHOST=127.0.0.1` na configuração local. As migrations são forward-only: não há comando de rollback e todo `down` de migration falha antes de alterar o schema.

O seed do primeiro administrador é manual e interativo:

```bash
npm run db:seed:admin
```

O seed solicita nome completo e e-mail; a senha é digitada sem eco no terminal, não há senha padrão e uma execução é recusada quando já existe administrador ativo. A senha é armazenada como hash Argon2id com os parâmetros configurados. O seed deve ser executado em uma base local depois das migrations.

Esta API inclui autenticação, ciclo de vida e operações administrativas de contas de alunos, professores e administradores. As telas web/mobile ainda não estão integradas; o transporte de e-mail permanece fake/local; a publicação na Azure e a migração de dados do MongoDB não fazem parte do funcionamento local.

## Problemas comuns

- **`func` não encontrado:** instale o Azure Functions Core Tools v4 e abra um terminal em que `func --version` funcione.
- **A verificação de saúde retorna 503:** confirme que o contêiner PostgreSQL está saudável com `docker compose ps` e que `local.settings.json` contém os mesmos valores do `.env`.
- **Aviso de AzureWebJobsStorage/Azurite:** o exemplo local usa `UseDevelopmentStorage=true`. Esta API HTTP não usa Azure Storage; sem Azurite, o host pode registrar um aviso de tempo limite de armazenamento mesmo quando a rota HTTP inicia. Se o host não registrar a Function, confira a saída do Core Tools e a disponibilidade do Azurite.
- **O código TypeScript mudou, mas a rota não atualizou:** rode `npm run build` novamente e reinicie `npm start`.
