# Disclosure governance (Travel Rule gate, v10)

How a VASP running the DPO2U Travel Rule gate decides what party data can be disclosed, to whom and on what basis, and how the keys, logs and exceptions are kept. Every answer points to the code or artifact that enforces it. Scope today: preview/testnet with fictitious entities; legal references must be confirmed by counsel before production use.

## 1. What can be revealed, and what stays out

| Data | On chain | Can be disclosed | How |
|---|---|---|---|
| Verdict (PASS/FAIL), reason code (0-4), status (PASS/FAIL/RELEASED) | public | already public | `TravelRuleGate` ledger: `status`, `fail_reason` |
| Rule/policy version behind each verdict | public hash | already public | `verdict_policy[transfer_id]` |
| Counterparty VASP id | public (regulatory identity, not customer data) | already public | `attested_vasps`, PsavPassport id |
| Originator / beneficiary fields: name, account, document, VASP (as hashes) | only salted per-field commitments, combined into one root per party | yes, field by field, inside a grant scope | off-chain opening (value + salt), checked against the on-chain root with `field_commit` / `root_of` |
| Transfer amount | never | no (only "above / below threshold" is reflected in the reason code) | witness `transfer_amount` |
| Sanctions screening detail | never (only the boolean result, VASP-attested) | no; the screening record stays with the VASP | witness `sanctions_clear` |
| Compliance score | never; only a hiding commitment | the attested company or an auditor it chooses can open it | `ComplianceRegistry.attestation_score_commit`, salt re-derived from the owner secret (`scripts/owner.ts scoreSalt`) |
| Reviewer identity (LGPD attestations) | salted hash only | no | `bridge/reviewer-salt.mjs` |
| Data subject identifiers (consent, rights requests) | salted subject key only | no | `ConsentRegistry.subject_key`, `DataSubjectRights.subject_key` |

Opening one field does not open the others: each field has its own salted commitment (`TravelRuleGate.field_commit`, separate label per field).

## 2. Who requests, who approves, who receives

| Step | Who | Enforced by |
|---|---|---|
| Request | The VASP (owner key) records the grant on chain: transfer, supervisor, field scope, expiry, `purpose_hash` | `TravelRuleGate.grantDisclosure` (owner only); the grant starts **inactive** |
| Approve | A second key held by someone other than the owner (e.g. the DPO) | `TravelRuleGate.approveDisclosure` (approver key only; the owner secret is refused on chain and by `scripts/travel-rule-v10.ts`) |
| Issue the credential | The VASP's disclosure service, after approval | `DisclosureGovernance.issue` (legal basis required) |
| Receive | The supervisor named in the grant (regulator role) | `DisclosureGovernance.access`: valid credential, in scope, not expired, not revoked |
| Other internal readers | `compliance` (FAIL transfers only), `risk` (aggregates only), `auditor` (public record + evidence pack) | `src/disclosure/roles.ts`, each view logged as `ROLE_VIEW` |

## 3. Legal basis

Every grant carries a free-text legal basis (required by `DisclosureGovernance.issue`) and its hash is bound on chain through `purpose_hash` (`purposeHash()` covers the legal basis together with grant id, supervisor, transfers, parties, scope and expiry). The bases this design is built for:

- **LGPD (Lei 13.709/2018) art. 7**: processing to comply with a legal or regulatory obligation of the controller (art. 7, II), and for the regular exercise of rights in judicial, administrative or arbitration proceedings (art. 7, VI).
- **LGPD art. 11**: when the data are sensitive, processing without consent for compliance with a legal or regulatory obligation (art. 11, II, a).
- **BCB Resolutions 520 and 521**: the virtual asset service provider (PSAV) regime, which this gate implements for transfer information (FATF Recommendation 16 / Travel Rule) and the supervisor's access to it.
- **Lei 9.613/1998** (anti-money laundering): record keeping of client identification and transactions and their availability to the competent authorities.

A request that cites none of these, or a purpose the hash does not match, is not approved: the approver checks the off-chain terms against `grant_purpose` before calling `approveDisclosure`.

## 4. Scope: account, asset, transaction, period, purpose, case

| Dimension | Implemented | Where |
|---|---|---|
| Transaction | yes: each grant names one transfer on chain; a credential lists its transfers | `grant_transfer`, `Claims.transfer_ids` |
| Party | yes: originator and/or beneficiary | `Claims.parties` |
| Field | yes: bitmask 1 name, 2 account, 4 document, 8 VASP | `grant_scope`, `Claims.scope` |
| Period | yes: expiry enforced by block time on chain and by the clock off chain | `grant_expires`, `Claims.expires_at` |
| Purpose / case | yes: `purpose_hash` on chain; legal basis and case reference in the credential | `grant_purpose`, `Claims.legal_basis` |
| Account / asset (all transfers of an account or asset) | not as a single grant: requested as a list of transfers | gap; would need an account- or asset-level index |

## 5. Who controls the keys

| Key | Holder | Where it lives | If lost or leaked |
|---|---|---|---|
| Owner secret (`DPO2U_OWNER_SECRET`) | the VASP operator | outside the VPS on mainnet (required explicitly, never derived from the wallet seed) | lost: no new evaluations, releases or grants on the deployed contracts, so redeploy; leaked: an attacker can evaluate/release/request but **cannot approve** a disclosure |
| Approver key (`DPO2U_APPROVER_SECRET`, deployed as `approver_commit`) | a second person (e.g. the DPO) | outside the VPS; only its commitment is needed to deploy (`DPO2U_APPROVER_COMMIT`); on mainnet it is passed only through stdin when approving | lost: grants can be requested but not approved, so redeploy with a new commitment; leaked alone: no request can be created without the owner key |
| Disclosure issuer key | the disclosure service | mode-600 file (`DisclosureGovernance.loadKey` refuses wider permissions) | rotate: new key, old credentials stop verifying |
| Per-grant key | derived, never stored | HKDF of the issuer key, grant id, scope and expiry (`DisclosureGovernance.disclosureKey`) | one grant's key opens only that grant's package |
| Reviewer salt (`DPO2U_REVIEWER_SALT`) | the controller | outside the chain; required on mainnet | lost: new metadata cannot be linked to old reviewers; leaked: reviewer hashes become guessable |
| Score salts | derived from the owner secret and the attestation context | never stored | follow the owner secret |
| Wallet seed (`MIDNIGHT_SEED`) | the operator | mode-600 file | pays fees only; does not open data |

## 6. Logging, retention, revocation, continuity and exit

- **Log**: every issue, revocation, access decision (granted and denied), exception and role view is appended to a hash-chained JSONL log (`DisclosureGovernance`); `verifyLog` recomputes the chain and a tampered log is refused on load (fail closed). On chain, grants, approvals and revocations are public ledger entries.
- **Exceptions**: every FAIL and every refused attestation becomes an item with owner, due date, decision and justification in the same log (`src/disclosure/exceptions.ts`); sanctions hits are due in 24 hours and cannot be closed as false positives without citing the screening evidence.
- **Retention**: the log is append-only and kept for at least the record-keeping period of Lei 9.613/1998 (five years); party openings are never written to the log, only the request and the decision.
- **Revocation**: the owner revokes on chain (`revokeDisclosure`) and off chain (`DisclosureGovernance.revoke`); either makes the grant inactive; a revoked request cannot be approved.
- **Continuity**: the state needed to resume is the log file, the issuer key file and the deployment file; the contracts keep the public half. Losing the owner or approver key means redeploying the gate (section 5).
- **Exit**: the evidence pack (`src/evidence/pack.ts`) exports the public record, the disclosure log with its verification, the circuit specification and the key and change records with a manifest of hashes, readable without DPO2U software.
