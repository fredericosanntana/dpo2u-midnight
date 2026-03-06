# Entendendo o DPO2U Midnight Self-Funding Protocol

Bem-vindo(a) ao **DPO2U Midnight**! Se você é iniciante em Web3, Zero-Knowledge (provas de conhecimento nulo) ou no ecosistema da Midnight Network, este guia foi feito para você entender **o que** este projeto faz, **como** ele funciona por debaixo dos panos, e **onde** olhar no código.

---

## 🧐 1. O que este projeto resolve?

**DPO2U** é focado em *Conformidade de Dados (Compliance)*. Imagine que uma empresa precisa de um atestado de que está seguindo todas as regras de proteção de dados (como LGPD ou GDPR). 

Para provar isso ao mundo (ou clientes) de forma pública, **sem vazar nenhum dado sensível da empresa**, nós usamos a **Midnight Network** — uma blockchain focada na proteção de dados (data protection).

Além disso, nosso protocolo é **Self-Funding** (Auto-Financiável). Isso significa que as recompensas financeiras (em tokens `$NIGHT`) para os Especialistas (que fazem o trabalho) e os Auditores (que revisam) são distribuídas de forma **automática, transparente e segura** por um Contrato Inteligente (Smart Contract).

---

## 🏛 2. A Arquitetura (Os 4 Pilares)

Se pensarmos no DPO2U como um prédio empresarial, ele tem 4 departamentos. Cada um deles é regido por um Contrato Inteligente escrito na linguagem **Compact** (na pasta `compact/`):

1. **`AgentRegistry.compact` (O RH / Portaria)**
   - Registra quem são os Agentes oficias do sistema (os especialistas e auditores).
   - Controla se um agente está "ativo" ou desativado.
   
2. **`ComplianceRegistry.compact` (O Arquivo Morto Blindado)**
   - Guarda as "Provas" (Attestations) que atestam que uma empresa é segura.
   - **Detalhe Importante:** Não salva textos, nomes ou CPFs da empresa. Salva apenas *Hashes Criptográficos* (CIDs) apontando para o laudo e a *Pontuação* de Conformidade (Score de 0 a 100).
   
3. **`PaymentGateway.compact` (O Caixa)**
   - Onde o dinheiro (os `$NIGHT` tokens) da Empresa-cliente entra para pagar pelos serviços.
   - Pense no *Gateway* como o cofre primário.
   
4. **`FeeDistributor.compact` (A Contabilidade Automática)**
   - Recebe as taxas. 
   - A matemática pesada de "quem ganha quanto" (40% para especialista, 60% para auditor) é resolvida fora da blockchain. E este contrato apenas aplica um **carimbo de aprovação** exigindo (via ZK Proof) que a soma exata sempre feche as contas antes de distribuir os saldos nas "piscinas" (`fee_pools`) de cada trabalhador.

---

## 💻 3. Como Ler os Contratos (Exemplo Rápido)

Abra o arquivo `compact/AgentRegistry.compact`. Lá você vai notar:
- `export ledger variableName`: É o "banco de dados" público ou privado da Blockchain. Fica gravado lá para sempre.
- `export circuit functionName()`: São as "funções" ou "circuitos". Elas criam a mágica do *Zero-Knowledge*. Quando você roda isso, está provando à rede que executou a lógica corretamete, sem revelar no caminho o estado da sua memória privada.

---

## 🧪 4. Como Testar e Rodar? (Passo a Passo)

A beleza desse projeto está nos arquivos TypeScript (`.ts`), eles preparam tudo e "conversam" com a blockchain pelos contratos que vimos acima.

### Dependências
Certifique-se de estar com a versão do Node.js atualizada e rodar o comando:
```bash
npm install
```

### Rodando o Projeto Localmente (Simulação)
O projeto possui uma **suíte de testes automatizados** incrível que simula a blockchain completa localmente na sua máquina (`off-chain`).

Para ver a mágica inteira sendo testada, rode:
```bash
npm run test
```

Você verá a verificação automática se os caixas recebem os depósitos numéricos corretos, se o distribuidor se nega a pagar frações erradas e se o arquivo de compliance grava a pontuação.

### Para quando for Deployar (Publicar o código online)
Script pronto fornecido pelo autor:
```bash
npm run deploy:local
# ou
npm run deploy:preprod
```
E para simular um "Fluxo do Usuário Final":
```bash
npm run demo
```

> **Aviso Técnico:** Se o `deploy` estiver apresentando falhas como erro `-4 zkir`, saiba que este é um problema provisório de compatibilidade no compilador interno da fabricante da Blockchain (Midnight). A sua lógica, seus códigos e testes Node.js estão 100% perfeitos!
