# Shared ZK Trust Stacks as Evolutionarily Stable Compliance Mechanisms: DPO2U Protocol and the Seven-Layer Security Concentration Problem

**Fred Santana**
DPO2U, Niterói, Rio de Janeiro, Brazil

*April 2026*

---

## Abstract

Hoskinson [1] demonstrates that zero-knowledge proof systems decompose trust into seven independently auditable layers, reducing monolithic trust assumptions into manageable pieces. We extend this analysis to the ecosystem level and identify a previously unformalized scaling failure: when each decentralized application constructs its own ZK compliance stack independently, the probability of at least one security failure across the ecosystem grows as `1-(1-p)^n`, where `p` is the per-layer failure probability and `n` is the number of independent implementations. We call this the **Seven-Layer Multiplication Problem**: security degrades as the ecosystem scales.

We propose the **Shared ZK Trust Stack** as the structural solution — a single, audited ZK compliance infrastructure used by all ecosystem participants, where the stack itself is registered on-chain as a hash commitment. Under this architecture, ecosystem-wide failure probability converges to `p`, independent of `n`: security scales with adoption rather than degrading.

We describeDPO2U (Privacy Attestation and Compliance Toolkit), a concrete implementation of the Shared ZK Trust Stack on the Midnight Network, comprising: (1) a compliance kit that generates jurisdiction-specific predicate witnesses, (2) a DPO2U-MCP orchestration layer that standardizes attestation generation and propagation, and (3) a `PACTRegistry` smart contract whose own hash is registered on-chain — making everyDPO2U-attested dApp a verifiable participant in a single audited base. We formalizeDPO2U's equilibrium properties using evolutionary game theory, demonstrating thatDPO2U-certified ecosystems constitute an Evolutionarily Stable Strategy (ESS) with security resilience independent of ecosystem size. We further show that existing compliance frameworks (PIPEDA, FINTRAC, AIDA, LGPD, GDPR) can be expressed as predicate conjunctions over private witnesses, satisfying Privacy by Design requirements at the protocol level without surveillance.

**Keywords:** zero-knowledge proofs, compliance as protocol, evolutionarily stable strategies, privacy by design, Midnight Network, Compact language, shared trust infrastructure

---

## 1. Introduction

### 1.1 The Seven-Layer Trust Decomposition

Hoskinson's framework [1] provides a comprehensive taxonomy of ZK system trust layers:

- **L1: Trusted Setup** — the ceremony that generates public parameters
- **L2: Programming Language** — the circuit specification language and its compiler
- **L3: Witness Generation** — the prover's private input construction
- **L4: Arithmetization** — the translation from circuit to polynomial constraints
- **L5: Proof System** — the SNARK/STARK backend
- **L6: Cryptographic Primitives** — the underlying hash functions and elliptic curves
- **L7: On-Chain Verification** — the ledger that records the final verdict

Each layer introduces an independent trust assumption. Each is independently auditable, replaceable, and — critically — independently breakable. Hoskinson notes that the under-constrained circuit problem at L2 accounts for 67% of real-world ZK vulnerabilities [1], underscoring that layer independence is not merely theoretical: failures are layer-specific and empirically distributed.

The framework is a significant advance: it replaces "do you trust this ZK system?" — a monolithic question — with "do you trust each of these seven independently verifiable components?" — a decomposed, tractable question.

### 1.2 The Gap: Ecosystem-Level Analysis

Hoskinson's analysis focuses on individual ZK systems. The framework does not address what happens when an ecosystem of `n` independent ZK compliance implementations coexists. We identify a structural consequence of this gap that we call the **Seven-Layer Multiplication Problem**.

Consider an ecosystem of `n` dApps, each constructing its own ZK compliance stack independently. Each dApp makes independent choices at every layer: its own setup ceremony, its own circuit language, its own witness generation logic, its own proof system configuration. Each choice is a potential point of failure.

Let `p` be the probability that any given layer in any given dApp's implementation contains a security failure. The probability that at least one layer in at least one dApp fails is:

```
P(at least one failure | n dApps) = 1 - (1-p)^(7n)
```

For any fixed `p > 0`, this probability approaches 1 as `n → ∞`. An ecosystem of independent ZK compliance implementations becomes *more fragile* as it scales. This is the opposite of the resilience that decentralized systems promise.

### 1.3 The Shared ZK Trust Stack

We propose the **Shared ZK Trust Stack** as the structural solution: a single, audited ZK compliance infrastructure registered on-chain as a hash commitment, used by all ecosystem participants.

Under this architecture, ecosystem-wide failure probability becomes:

```
P(at least one failure | Shared Stack) = P(stack failure) = p_stack
```

This probability is independent of `n`. Adding more dApps to the ecosystem does not increase the probability of failure — it increases the number of auditors who can detect and report failures in the shared base. Security scales with adoption rather than degrading.

We describeDPO2U as a concrete implementation of this architecture on the Midnight Network.

---

## 2. TheDPO2U Stack: Operational Architecture

### 2.1 Three-Layer Stack

TheDPO2U operational stack comprises three components that map cleanly to Hoskinson's L1-L3 (the layers most vulnerable to per-implementation failure [1]):

```
┌─────────────────────────────────────────────────────────────┐
│  COMPLIANCE KIT (lgpd-kit /DPO2U CLI)                        │
│  → Generates jurisdiction-specific predicate witnesses        │
│  → Maps regulatory requirements to circuit inputs             │
│  → L3: Witness Generation — standardized, audited once       │
├─────────────────────────────────────────────────────────────┤
│  DPO2U-MCP ORCHESTRATION LAYER (17-tool MCP server)          │
│  → Standardizes attestation generation and propagation        │
│  → Connects compliance kit to Midnight Protocol               │
│  → L2: Circuit invocation — consistent across all dApps      │
├─────────────────────────────────────────────────────────────┤
│ DPO2U REGISTRY (PACTRegistry.compact on Midnight)            │
│  → Hash of stack registered on-chain                         │
│  → Every attestation references the same verified base        │
│  → L1: Setup — one ceremony, one audit, one hash             │
└─────────────────────────────────────────────────────────────┘
```

**The on-chain hash is the proof of shared base.** When a dApp calls `verifyAttestation`, it is not claiming "my circuits work." It is claiming "I used the same base as every otherDPO2U-certified dApp, and here is the hash that proves it." The auditor verifies one hash, not `n` independent implementations.

### 2.2 The Hash Commitment as Trust Anchor

The `PACTRegistry.compact` contract is itself registered in theDPO2U Registry under `pact/oss/v1`. The artifact hash — `SHA-256(PACTRegistry.compact)` — is stored on-chain at a specific block height.

When dApp A and dApp B both hold validDPO2U Attestations, the verifier can confirm:
1. Both Attestations reference the same `predicateSetId`
2. The `PACTRegistry.compact` artifact hash is identical for both
3. Both are therefore using the same audited circuit base

This is a verifiable statement about infrastructure sharing, not a legal assertion. The auditor needs one ZK circuit audit, not `n`.

### 2.3 Layer Concentration Table

| Hoskinson Layer | WithoutDPO2U | WithDPO2U |
|----------------|--------------|-----------|
| L1: Setup | n independent ceremonies | 1 ceremony, hash on-chain |
| L2: Language | n independent circuit implementations | 1 Compact implementation, audited |
| L3: Witness | n independent witness generators | 1 compliance kit (lgpd-kit /DPO2U CLI) |
| L4: Arithmetization | n independent compilations | 1 Compact compiler pass |
| L5: Proof System | n independent SNARK configs | Midnight's SNARK backend (shared) |
| L6: Primitives | n independent hash/curve selections | SHA-256 + Ed25519 (specified inDPO2U) |
| L7: Verification | n independent verifier contracts |DPO2URegistry (one contract, shared) |

WithoutDPO2U: `7n` independent trust assumptions.
WithDPO2U: `7` trust assumptions, each covered once.

---

## 3. Formal Security Analysis

### 3.1 The Seven-Layer Multiplication Problem: Formal Statement

**Definition 1 (Layer Failure Probability).** Let `p ∈ (0,1)` be the probability that any independently implemented ZK layer contains at least one security failure. We assume identical and independent failure probabilities across layers and implementations, as a conservative bound.

**Definition 2 (Ecosystem Failure).** An ecosystem failure occurs when at least one layer in at least one dApp's implementation contains a security failure.

**Theorem 1 (Seven-Layer Multiplication).** In an ecosystem of `n` independently implemented ZK compliance stacks, each with `k` layers and per-layer failure probability `p`:

```
P(ecosystem failure) = 1 - (1-p)^(kn)
```

*Proof.* The probability that a single layer in a single dApp does not fail is `(1-p)`. For `k` independent layers in a single dApp, the probability that no layer fails is `(1-p)^k`. For `n` independent dApps, the probability that no layer in any dApp fails is `(1-p)^(kn)`. The complement is the ecosystem failure probability. □

**Corollary 1.** For any fixed `p > 0` and `k ≥ 1`:

```
lim_{n→∞} P(ecosystem failure) = 1
```

Ecosystem security degrades monotonically as the number of independent implementations grows.

**Corollary 2.** For `k = 7` (Hoskinson's seven layers) and `p = 0.01` (1% per-layer failure probability):

| n (dApps) | P(ecosystem failure) |
|-----------|---------------------|
| 1 | 0.068 (6.8%) |
| 10 | 0.503 (50.3%) |
| 50 | 0.970 (97.0%) |
| 100 | 0.999 (99.9%) |

At 50 independent dApps with a 1% per-layer failure probability, ecosystem failure is near-certain.

### 3.2 The Shared Stack Solution

**Definition 3 (Shared ZK Trust Stack).** A Shared ZK Trust Stack is a single ZK implementation `S` used by all `n` ecosystem participants, with the stack itself registered on-chain as `H = SHA-256(S)`.

**Theorem 2 (Stack Independence).** In an ecosystem using a Shared ZK Trust Stack with failure probability `p_stack`:

```
P(ecosystem failure) = p_stack
```

This probability is independent of `n`.

*Proof.* All `n` dApps use identical layers L1-L7 from `S`. A failure occurs if and only if `S` itself contains a failure. The number of dApps using `S` does not affect the probability that `S` fails. □

**Corollary 3 (Security Scaling).** In the Shared Stack model, adding dApps to the ecosystem:
- Does not increase P(ecosystem failure)
- Increases the number of auditors examining the shared base
- Creates network effects that improve security with scale

This is the inversion of the Seven-Layer Multiplication Problem: security scales with adoption rather than degrading.

### 3.3 Concentration Risk and Mitigation

A shared stack introduces concentration risk: a single vulnerability in the stack affects all `n` dApps simultaneously. We analyze this formally.

**Definition 4 (Concentration Risk).** Let `L` be the expected loss from a single dApp failure. In the independent model, a single dApp failure produces loss `L`. In the shared stack model, a single stack failure produces loss `nL`.

**Theorem 3 (Risk-Adjusted Security).** The shared stack is risk-adjusted superior to the independent model when:

```
p_stack × nL < (1 - (1-p)^(kn)) × L
```

Simplifying:

```
p_stack < (1 - (1-p)^(kn)) / n
```

For `p = 0.01`, `k = 7`, `n = 50`: the right-hand side evaluates to `0.019`. Thus the shared stack is risk-adjusted superior as long as `p_stack < 0.019` — achievable through professional audit of a single, well-defined codebase, a far easier target than auditing 50 independent implementations.

**Mitigation through auditability.** The key asymmetry: `p_stack` is reducible through investment in a single audit, while `(1-p)^(kn)` requires n simultaneous audits. The shared stack concentrates risk in a form that is tractable to manage.

---

## 4. Game-Theoretic Analysis

### 4.1 Compliance as an Evolutionary Game

We model ecosystem participants as players in an evolutionary game where each participant chooses a compliance strategy. We identify two pure strategies:

- **I (Independent):** Build and maintain a proprietary ZK compliance stack
- **P (PACT):** Use the sharedDPO2U stack

### 4.2 Payoff Structure

Let the payoff matrix be defined by the following parameters:

- `B`: benefit of operating in the ecosystem (transactions, reputation, access)
- `C_I`: cost of building and auditing an independent ZK stack
- `C_P`: cost of usingDPO2U (attestation fees, integration)
- `F`: penalty for a compliance failure (regulatory, reputational)
- `p_I`: failure probability of an independent implementation
- `p_P`: failure probability of the sharedDPO2U stack (= `p_stack`)

**Assumption:** `C_I >> C_P` (building a ZK compliance stack is substantially more expensive than using a shared one) and `p_I >> p_P` (independent implementations have higher failure rates than a professionally audited shared stack).

Payoff for strategy I:
```
π(I) = B - C_I - p_I × F
```

Payoff for strategy P:
```
π(P) = B - C_P - p_P × F
```

### 4.3DPO2U as Evolutionarily Stable Strategy

**Definition 5 (ESS).** A strategy S* is an Evolutionarily Stable Strategy if, for any alternative strategy S:
```
π(S*, S*) ≥ π(S, S*)
```
with strict inequality when π(S*, S*) = π(S, S*).

**Theorem 4 (PACT-ESS).** Under the assumptions `C_I >> C_P` and `p_I >> p_P`, theDPO2U strategy (P) is an ESS.

*Proof sketch.* Consider a population where fraction `x` plays P and `(1-x)` plays I.

The expected payoff of P in a mixed population:
```
π(P, x) = B - C_P - p_P × F
```
Note: `p_P` is constant — it does not depend on `x` (Theorem 2).

The expected payoff of I in a mixed population:
```
π(I, x) = B - C_I - p_I(x) × F
```
where `p_I(x)` is the effective failure probability for an independent implementer in an ecosystem with `x` fraction usingDPO2U.

As `x → 1` (most of the ecosystem usesDPO2U), the auditing pressure onDPO2U increases, driving `p_P` down. Meanwhile `p_I(x)` remains at least `p_I` for independent implementers, who receive no benefit fromDPO2U's auditing.

Since `C_I >> C_P` and `p_I >> p_P`, we have `π(P) > π(I)` for all `x`.DPO2U is a dominant strategy, which implies it is an ESS. □

**Corollary 4 (Network Effect).**DPO2U adoption creates a positive network effect: each additional dApp usingDPO2U increases auditing pressure on the shared base, reducing `p_P` for all participants. This creates a supermodular game where the marginal benefit ofDPO2U adoption increases with the number of adopters — the opposite of the fragility dynamic in the independent model.

### 4.4 The Muralha vs. Cem Castelos Theorem

We formalize the intuition from Section 1.3 as a theorem:

**Theorem 5 (Muralha vs. Cem Castelos).** Let `A_k` be the audit effort required to achieve failure probability `ε` at layer `k`. In the independent model with `n` dApps, total audit effort is:

```
A_total(independent) = n × Σ_k A_k = 7n × A
```

In the shared stack model, total audit effort is:

```
A_total(PACT) = Σ_k A_k = 7A
```

The ratio `A_total(independent) / A_total(PACT) = n`. At 100 dApps,DPO2U requires 1% of the audit effort of the independent model to achieve identical security guarantees.

This is the economic core of theDPO2U value proposition: one audit covers the ecosystem.

---

## 5.DPO2U Layer Mapping: Seven Circuits, Seven Layers

Following Hoskinson's framework [1],DPO2U's seven circuits address the seven trust layers:

| Circuit | Hoskinson Layer | Trust Assumption Addressed |
|---------|----------------|---------------------------|
| `registerPredicateSet` | L1: Setup | Predicate spec committed to IPFS; transparent, auditable |
| `registerContributor` | L2: Language | Attester identity established with unforgeable Ed25519 pubkey |
| `attestCompliance` | L3: Witness | Predicate witnesses evaluated against private evidence |
| `attestCanadianCompliance` | L4: Arithmetization | Full Canadian stack evaluated in one constraint pass |
| `proveAttestation` | L5: Proof System | Selective disclosure without revealing evidence preimage |
| `revokeAttestation` | L6: Primitives | Lifecycle management enforced by SHA-256 + Ed25519 |
| `verifyAttestation` | L7: Verification | Final public verdict — the ecosystem compliance gate |

The one-to-one correspondence is not incidental.DPO2U was designed so that each circuit addresses exactly one independently auditable trust assumption — instantiating Hoskinson's decomposition principle as a compliance enforcement mechanism.

---

## 6. Compliance Predicate Model

### 6.1 Formal Definition

A compliance predicate `P` is a boolean function over a private witness `W`:
```
P : W → {true, false}
```

A Predicate Set `PS = {P₁, ..., Pₙ}` is satisfied when:
```
PS(W) = ⋀ᵢ Pᵢ(W) = true
```

A system isDPO2U-compliant for `PS` iff it produces a ZK proof that `PS(W) = true` for some witness `W`, without revealing `W`.

### 6.2 Under-Constrained Predicates

Applying Hoskinson's under-constrained circuit analysis [1] to the compliance domain: an under-constrained predicate admits witnesses that satisfy the circuit without satisfying the underlying regulatory requirement.DPO2U mitigates this through:

1. Explicit statute-referenced assertions (no implicit constraint)
2. Jurisdiction-specific error messages identifying the unsatisfied predicate
3. Centralized predicate set auditing — one review covers all dApps

### 6.3 Canadian Predicate Sets

The full Canadian stack (`pact/combined/ca/v1`) evaluates 18 predicates across three regulatory frameworks (PIPEDA, FINTRAC, AIDA) in a single `attestCanadianCompliance` circuit call. SeeDPO2U Protocol technical documentation for full predicate specifications.

---

## 7. Privacy by Design as Protocol Property

Applying Cavoukian's seven PbD principles [Cavoukian, 2009]:

| PbD Principle | Protocol Implementation |
|---------------|------------------------|
| Proactive, not reactive | Predicates evaluated before processing |
| Privacy as default | No valid Attestation → circuit blocks execution |
| Privacy embedded into design | Private evidence commitment is core structure |
| Full functionality | Compliance proven without surveillance |
| End-to-end security | Private witnesses never leave prover's machine |
| Visibility and transparency | Attestation on-chain; predicate spec on IPFS |
| Respect for user privacy | Evidence is about the system, not the user |

The shared stack strengthens each principle: because allDPO2U-attested dApps share the same privacy-preserving infrastructure, PbD is not a per-dApp design choice — it is an ecosystem invariant.

---

## 8. Related Work

**Hoskinson [1]** provides the seven-layer framework that motivates our ecosystem-level extension. We cite this work as the primary theoretical foundation.

**Ostrom [Ostrom, 1990]** provides the commons governance framework forDPO2U's predicate set registry: one audited base shared across participants, governed by clearly defined boundaries and collective choice arrangements.

**Spence [Spence, 1973]** provides the signaling game framework:DPO2U Attestations are costly, unforgeable signals that create a separating equilibrium between compliant and non-compliant dApps.

**De Filippi and Wright [2018]** establish the legal-cryptographic bridge: code as law, enforced by the network rather than courts.DPO2U instantiates this for the compliance domain: regulatory obligations as circuit constraints, enforced by Midnight's ZK execution layer.

**Santana [Santana, 2026]** establishes the foundational compliance-as-protocol thesis thatDPO2U implements, including the Nash equilibrium analysis of ZK compliance mechanisms.

---

## 9. Discussion: The Open Questions

Hoskinson's book [1] concludes with seven open research questions about ZK systems. We briefly address three that are directly implicated byDPO2U:

**Q1 (implied): Can ZK trust decomposition be applied to the compliance layer itself?**
PACT answers yes. The seven-circuit architecture is a direct application of the seven-layer decomposition to compliance enforcement.

**Q2 (from [1]): How should ecosystems handle shared setup ceremonies?**
PACT proposes the on-chain hash commitment as the answer: the setup is transparent, its hash is on-chain, and any divergence from the committed hash is detectable by any participant.

**Q3 (from [1]): What is the right unit of audit in a ZK ecosystem?**
Theorem 5 provides a formal answer: in a shared stack ecosystem, the unit of audit is the stack itself, not individual dApps. The audit effort scales as `O(1)` in `n` rather than `O(n)`.

---

## 10. Conclusion

We have identified the Seven-Layer Multiplication Problem: in ecosystems of independent ZK compliance implementations, security degrades as `1-(1-p)^(kn)`, approaching near-certain failure as the ecosystem scales. We have proposed the Shared ZK Trust Stack as the structural solution, proven that ecosystem failure probability under the shared stack is independent of `n`, and demonstrated thatDPO2U adoption constitutes an Evolutionarily Stable Strategy under natural payoff assumptions.

PACT is not the only possible instantiation of the Shared ZK Trust Stack. But it is the first operational implementation on the Midnight Network, and the first to register its own hash on-chain as the verifiable anchor of ecosystem-wide compliance.

Hoskinson's book [1] argues that ZK proofs perform a structured reduction of risk: not elimination, but decomposition into manageable pieces.DPO2U extends this argument from the individual system to the ecosystem. The decomposition compounds: seven layers, shared across `n` dApps, audited once. The muralha, not cem castelos.

---

## References

[1] Hoskinson, C. *The Seven-Layer Magic Trick: A Complete Guide to Zero-Knowledge Proof Systems.* v1.01. GitHub: CharlesHoskinson/sevenlayer. CC BY 4.0. March 2026.

[2] Spence, M. "Job Market Signaling." *Quarterly Journal of Economics*, 87(3), 355–374. 1973.

[3] Ostrom, E. *Governing the Commons: The Evolution of Institutions for Collective Action.* Cambridge University Press. 1990.

[4] De Filippi, P. & Wright, A. *Blockchain and the Law: The Rule of Code.* Harvard University Press. 2018.

[5] Cavoukian, A. *Privacy by Design: The 7 Foundational Principles.* Ontario Information and Privacy Commissioner. 2009.

[6] Maynard Smith, J. *Evolution and the Theory of Games.* Cambridge University Press. 1982.

[7] Santana, F. "Compliance como Protocolo: Provas de Conhecimento Zero, Teoria dos Jogos e Smart Contracts na Regulação de Plataformas Digitais." PUC-Rio, III Seminário Internacional de IA e Direito, GT 4. 2026.

[8] PIPEDA — Personal Information Protection and Electronic Documents Act. S.C. 2000, c. 5. Canada.

[9] PCMLTFA — Proceeds of Crime (Money Laundering) and Terrorist Financing Act. S.C. 2000, c. 17. Canada.

[10] AIDA — Artificial Intelligence and Data Act. Bill C-27, Part III. Canada.

[11] LGPD — Lei Geral de Proteção de Dados. Law 13,709/2018. Brazil.

[12] GDPR — General Data Protection Regulation. Regulation 2016/679. EU.

[13] Midnight Network. *Developer Documentation.* IOG. 2024. https://docs.midnight.network

[14] Compact Language Reference. IOG. 2024. https://docs.midnight.network/develop/reference/compact

---
*License: CC BY 4.0 (this paper) | LicenseRef-PACT-1.0 (the protocol)*
