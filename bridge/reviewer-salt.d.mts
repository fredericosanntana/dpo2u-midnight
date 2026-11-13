export declare const TESTNET_PUBLIC_SALT: string;
export declare function reviewerSalt(network: string, env?: Record<string, string | undefined>): string;
export declare function saltedReviewerHash(reviewerHashHex: string, saltHex: string): string;
export declare function lgpdMetadata(
  payload: { attestedAt: string; packId: string; reportId: string; reviewerHash: string; verdict: string },
  saltHex: string,
): { attestedAt: string; packId: string; reportId: string; reviewerHash: string; verdict: string };
