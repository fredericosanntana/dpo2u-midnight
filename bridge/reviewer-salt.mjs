// reviewer-salt.mjs — reviewerHash salgado antes de entrar no metadata público.
//
// O reviewerHash que chega no payload é o hash da identidade de quem revisou (baixa entropia:
// um nome ou e-mail se acha por tentativa). No metadata que vai à rede entra só
//   sha256(salt || reviewerHash)   (bytes: 32 do salt seguidos dos 32 do reviewerHash; hex)
// com salt = DPO2U_REVIEWER_SALT (32 bytes em hex), guardado fora da cadeia pelo controlador.
// Mainnet: o salt é obrigatório (erro claro se faltar). Testnets sem salt usam um salt PÚBLICO
// fixo, só para manter o mesmo formato; ali não há proteção e o aviso diz isso.
// Usado pela ponte (Avalanche) e pelo executor scripts/attest-lgpd-v9.ts (Midnight).
import { createHash } from 'node:crypto';

export const TESTNET_PUBLIC_SALT = createHash('sha256').update('dpo2u/reviewer-salt/testnet-public/v1').digest('hex');

/** Salt em hex (64 caracteres) para a rede; lança em mainnet sem DPO2U_REVIEWER_SALT. */
export function reviewerSalt(network, env = process.env) {
  const s = String(env.DPO2U_REVIEWER_SALT ?? '').trim().toLowerCase();
  if (s) {
    if (!/^[0-9a-f]{64}$/.test(s)) throw new Error('DPO2U_REVIEWER_SALT deve ter 32 bytes em hex (64 caracteres)');
    return s;
  }
  if (network === 'mainnet') throw new Error('DPO2U_REVIEWER_SALT é obrigatório em mainnet (32 bytes hex, fora da cadeia): sem ele o reviewerHash iria público sem sal');
  return TESTNET_PUBLIC_SALT;
}

/** sha256(salt || reviewerHash) em hex. reviewerHash e salt: 32 bytes em hex. */
export function saltedReviewerHash(reviewerHashHex, saltHex) {
  if (!/^[0-9a-f]{64}$/.test(reviewerHashHex)) throw new Error('reviewerHash malformado');
  if (!/^[0-9a-f]{64}$/.test(saltHex)) throw new Error('salt malformado');
  return createHash('sha256').update(Buffer.from(saltHex, 'hex')).update(Buffer.from(reviewerHashHex, 'hex')).digest('hex');
}

/** Metadata canônico (antes do hash) com o reviewerHash já salgado. */
export function lgpdMetadata(payload, saltHex) {
  return { attestedAt: payload.attestedAt, packId: payload.packId, reportId: payload.reportId, reviewerHash: saltedReviewerHash(payload.reviewerHash, saltHex), verdict: payload.verdict };
}
